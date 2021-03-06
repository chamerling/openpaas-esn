'use strict';

angular.module('linagora.esn.graceperiod')

  .factory('gracePeriodAPI', function(Restangular) {
    return Restangular.withConfig(function(RestangularConfigurer) {
      RestangularConfigurer.setBaseUrl('/graceperiod/api');
      RestangularConfigurer.setFullResponse(true);
    });
  })

  .factory('gracePeriodLiveNotification', function($log, $q, livenotification, GRACE_EVENTS) {

    var listening = false;
    var sio;
    var listeners = {};

    function onError(data) {
      $log.debug('graceperiod error handlers for task', data.id);
      var handlers = listeners[data.id];

      if (handlers) {
        var onErrorHandlers = handlers.filter(function(handler) {
          return handler.onError;
        });

        $q.all(onErrorHandlers.map(function(handler) {
          return handler.onError(data);
        })).then(function() {
          $log.debug('All error handlers called for graceperiod task', data.id);
        }, function(err) {
          $log.error('Error while calling grace period error handler', err);
        }).finally(function() {
          unregisterListeners(data.id);
        });
      }
    }

    function onDone(data) {
      $log.debug('graceperiod done handlers for task', data.id);
      var handlers = listeners[data.id];

      if (handlers) {
        var onDoneHandlers = handlers.filter(function(handler) {
          return handler.onDone;
        });

        $q.all(onDoneHandlers.map(function(handler) {
          return handler.onDone(data);
        })).then(function() {
          $log.debug('All done handlers called for graceperiod task', data.id);
        }, function(err) {
          $log.error('Error while calling grace period done handler', err);
        }).finally(function() {
          unregisterListeners(data.id);
        });
      }
    }

    function start() {
      if (listening) {
        return sio;
      }

      if (!sio) {
        sio = livenotification('/graceperiod');
      }

      sio.on(GRACE_EVENTS.error, onError);
      sio.on(GRACE_EVENTS.done, onDone);

      listening = true;
      $log.debug('Start listening graceperiod live events');
      return sio;
    }

    function stop() {
      if (!listening) {
        return;
      }

      if (sio) {
        sio.removeListener(GRACE_EVENTS.error, onError);
        sio.removeListener(GRACE_EVENTS.done, onDone);
      }

      listening = false;
      $log.debug('Stop listening graceperiod live events');
    }

    function registerListeners(task, onError, onDone) {
      if (!task) {
        return;
      }

      if (!listeners[task]) {
        listeners[task] = [];
      }
      listeners[task].push({onError: onError, onDone: onDone});
    }

    function unregisterListeners(task) {
      if (!task) {
        return;
      }
      delete listeners[task];
    }

    function getListeners() {
      var result = {};
      angular.copy(listeners, result);
      return result;
    }

    return {
      start: start,
      stop: stop,
      registerListeners: registerListeners,
      unregisterListeners: unregisterListeners,
      getListeners: getListeners
    };

  })

  .factory('gracePeriodService', function($timeout, $log, $q, notifyService, gracePeriodAPI, notifyOfGracedRequest, HTTP_LAG_UPPER_BOUND, GRACE_DELAY) {
    var tasks = {};

    function remove(id) {
      var task = tasks[id];
      if (task) {
        if (task.notification) {
          task.notification.close();
        }
        delete tasks[id];
        return $q.when();
      } else {
        return $q.reject();
      }
    }

    function retryBeforeEnd(task, previousError, promiseFactory) {
      return task.justBeforeEnd.then(function() {
        return promiseFactory();
      }, function() {
        throw previousError;
      });
    }

    function cancel(id) {
      var task = tasks[id];

      var notification = notifyService({
        message: 'Canceling...'
      }, {
        type: 'info',
        placement: {
          from: 'bottom',
          align: 'center'
        }
      });

      return remove(id).then(function() {
        return gracePeriodAPI
          .one('tasks')
          .one(id)
          .withHttpConfig({timeout:task.justBeforeEnd})
          .remove()
          .catch(function(error) {
            $log.error('Could not cancel graceperiod, we will try again at the end of the graceperiod', error);
            var cancelPromiseFactory = gracePeriodAPI
              .one('tasks')
              .one(id)
              .withHttpConfig({timeout:HTTP_LAG_UPPER_BOUND}).remove;

            return retryBeforeEnd(task, error, cancelPromiseFactory);
          });
      }, function() {
        return $q.reject('Canceling invalid task id: ' + id);
      }).finally(notification.close);
    }

    function flush(id) {
      return remove(id).then(function() {
        return gracePeriodAPI.one('tasks').one(id).put();
      }, function() {
        return $q.reject('Flushing invalid task id: ' + id);
      });
    }

    function flushAllTasks() {
      return $q.all(Object.keys(tasks).map(function(id) {
        return flush(id);
      }));
    }

    function flushTasksFor(contextQuery) {
      return $q.all((getTasksFor(contextQuery) || []).map(function(taskId) {
        return flush(taskId);
      }));
    }

    function timeoutPromise(duration) {
      return duration > 0 ? $timeout(angular.noop, duration) : $q.reject();
    }

    function grace(id, text, linkText, delay, context) {
      var notify = notifyOfGracedRequest(text, linkText, delay);
      addTask(id, context, notify.notification, delay);
      return notify.promise;
    }

    function clientGrace(text, linkText, delay) {
      return notifyOfGracedRequest(text, linkText, delay).promise;
    }

    function addTask(taskId, context, notification, delay) {
      if (taskId) {
        tasks[taskId] = {
          notification: notification,
          context: context,
          justBeforeEnd: timeoutPromise((delay || GRACE_DELAY) - HTTP_LAG_UPPER_BOUND)
        };
      }
    }

    function getTasksFor(contextQuery) {
      var result = [];
      if (!angular.isDefined(contextQuery)) {
        return result;
      }
      Object.keys(tasks).forEach(function(taskId) {
        var taskContext = tasks[taskId].context;
        if (taskContext) {
          var contextMatched = Object.keys(contextQuery).every(function(contextKey) {
            return taskContext[contextKey] === contextQuery[contextKey];
          });
          if (contextMatched) {
            result.push(taskId);
          }
        }
      });
      return result;
    }

    function hasTask(taskId) {
      return !!tasks[taskId];
    }

    return {
      grace: grace,
      clientGrace: clientGrace,
      cancel: cancel,
      flush: flush,
      flushAllTasks: flushAllTasks,
      flushTasksFor: flushTasksFor,
      remove: remove,
      addTaskId: addTask,
      getTasksFor: getTasksFor,
      hasTask: hasTask
    };
  })

  .factory('notifyOfGracedRequest', function(GRACE_DELAY, ERROR_DELAY, $q, $rootScope, notifyService, $log) {
    function appendCancelLink(text, linkText) {
      return text + ' <a class="cancel-task">' + linkText + '</a>';
    }

    return function(text, linkText, delay) {
      var deferred = $q.defer();

      var notification = notifyService({
        message: appendCancelLink(text, linkText)
      }, {
        type: 'success',
        text: appendCancelLink(text, linkText),
        placement: {
          from: 'bottom',
          align: 'center'
        },
        delay: delay || GRACE_DELAY,
        onClosed: function() {
          $rootScope.$applyAsync(function() {
            deferred.resolve({ cancelled: false });
          });
        }
      });

      notification.$ele.find('a.cancel-task').click(function() {
        $rootScope.$applyAsync(function() {
          deferred.resolve({
            cancelled: true,
            success: function() {
              notification.close();
            },
            error: function(errorMessage, consoleLogSupplement) {
              $log.error(errorMessage, consoleLogSupplement);
              notifyService({
                message: errorMessage
              }, {
                type: 'danger',
                delay: ERROR_DELAY,
                placement: {
                  from: 'bottom',
                  align: 'center'
                }
              });
            }
          });
        });
      });

      return {
        notification: notification,
        promise: deferred.promise
      };
    };
  });
