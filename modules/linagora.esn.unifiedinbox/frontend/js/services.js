'use strict';

angular.module('linagora.esn.unifiedinbox')

  .service('jmapClientProvider', function($q, $http, $log, jmap, dollarHttpTransport, dollarQPromiseProvider) {

    var deferred = $q.defer();

    $q.all([
      $http.get('/unifiedinbox/api/inbox/jmap-config'),
      $http.post('/api/jwt/generate')
    ]).then(function(responses) {
      deferred.resolve(new jmap.Client(dollarHttpTransport, dollarQPromiseProvider)
        .withAPIUrl(responses[0].data.api)
        .withAuthenticationToken('Bearer ' + responses[1].data));
    }, function(err) {
      deferred.reject(new Error(err));
    });

    deferred.promise.catch(function(err) {
      $log.error('Cannot build the jmap-client', err);
    });

    return {
      promise: deferred.promise
    };
  })

  .factory('withJmapClient', function(jmapClientProvider) {
    return function(callback) {
      return jmapClientProvider.promise.then(callback, callback.bind(null, null));
    };
  })

  .factory('asyncAction', function($q, $log, notificationFactory) {
    return function(message, action) {
      var notification = notificationFactory.strongInfo('', message + ' in progress...');

      return action()
        .then(function(value) {
          notificationFactory.weakSuccess('', message + ' succeeded');

          return value;
        }, function(err) {
          notificationFactory.weakError('Error', message + ' failed');
          $log.error(err);

          return $q.reject(err);
        })
        .finally(function() {
          notification.close();
        });
    };
  })

  .factory('asyncJmapAction', function(asyncAction, withJmapClient) {
    return function(message, action) {
      return asyncAction(message, function() {
        return withJmapClient(action);
      });
    };
  })

  .factory('ElementGroupingTool', function(moment) {

    function ElementGroupingTool(mailbox, elements) {
      this.mailbox = mailbox;

      this.todayElements = [];
      this.weeklyElements = [];
      this.monthlyElements = [];
      this.otherElements = [];
      this.allElements = [
        {name: 'Today', dateFormat: 'shortTime', elements: this.todayElements},
        {name: 'This Week', dateFormat: 'short', elements: this.weeklyElements},
        {name: 'This Month', dateFormat: 'short', elements: this.monthlyElements},
        {name: 'Older than a month', dateFormat: 'fullDate', elements: this.otherElements}
      ];

      if (elements) {
        this.addAll(elements);
      }

      return this;
    }

    ElementGroupingTool.prototype.addAll = function addElement(elements) {
      elements.forEach(this.addElement.bind(this));
    };

    ElementGroupingTool.prototype.addElement = function addElement(element) {
      var currentMoment = moment().utc();
      var elementMoment = moment(element.date).utc();

      if (this._isToday(currentMoment, elementMoment)) {
        this.todayElements.push(element);
      } else if (this._isThisWeek(currentMoment, elementMoment)) {
        this.weeklyElements.push(element);
      } else if (this._isThisMonth(currentMoment, elementMoment)) {
        this.monthlyElements.push(element);
      } else {
        this.otherElements.push(element);
      }
    };

    ElementGroupingTool.prototype._isToday = function _isSameDay(currentMoment, targetMoment) {
      return currentMoment.clone().startOf('day').isBefore(targetMoment);
    };

    ElementGroupingTool.prototype._isThisWeek = function _isSameDay(currentMoment, targetMoment) {
      return currentMoment.clone().subtract(7, 'days').startOf('day').isBefore(targetMoment);
    };

    ElementGroupingTool.prototype._isThisMonth = function _isSameDay(currentMoment, targetMoment) {
      return currentMoment.clone().startOf('month').isBefore(targetMoment);
    };

    ElementGroupingTool.prototype.getGroupedElements = function getGroupedElements() {
      return this.allElements;
    };

    ElementGroupingTool.prototype.reset = function reset() {
      return this.allElements.forEach(function(elementGroup) {
        elementGroup.elements.length = 0;
      });
    };

    return ElementGroupingTool;
  })

  .factory('createHtmlElement', function() {
    return function(tag, attributes) {
      return angular.extend(document.createElement(tag), attributes || {});
    };
  })

  .factory('emailSendingService', function($q, $http, emailService, deviceDetector, jmap, _, emailBodyService) {

    /**
     * Set the recipient.email and recipient.name fields to recipient.displayName if they are undefined.
     *
     * @param {Object} recipient
     */
    function ensureEmailAndNameFields(recipient) {
      if (!recipient.displayName) {
        return recipient;
      }

      if (!recipient.email) {
        recipient.email = recipient.displayName;
      }
      if (!recipient.name) {
        recipient.name = recipient.displayName;
      }

      return recipient;
    }

    /**
     * Add the following logic when sending an email: Check for an invalid email used as a recipient
     *
     * @param {Object} email
     */
    function emailsAreValid(email) {
      if (!email) {
        return false;
      }

      return [].concat(email.to || [], email.cc || [], email.bcc || []).every(function(recipient) {
        return emailService.isValidEmail(recipient.email);
      });
    }

    /**
     * Add the following logic when sending an email:
     *  Add the same recipient multiple times, in multiples fields (TO, CC...): allowed.
     *  This multi recipient must receive the email as a TO > CC > BCC recipient in this order.
     *  If the person is in TO and CC, s/he receives as TO. If s/he is in CC/BCC, receives as CC, etc).
     *
     * @param {Object} email
     */
    function removeDuplicateRecipients(email) {
      var notIn = function(array) {
        return function(item) {
          return !_.find(array, { email: item.email });
        };
      };

      if (!email) {
        return;
      }

      email.to = email.to || [];
      email.cc = (email.cc || []).filter(notIn(email.to));
      email.bcc = (email.bcc || []).filter(notIn(email.to)).filter(notIn(email.cc));
    }

    function _countRecipients(email) {
      if (!email) {
        return 0;
      }

      return _.size(email.to) + _.size(email.cc) + _.size(email.bcc);
    }

    /**
     * Add the following logic to email sending:
     *  Check whether the user is trying to send an email with no recipient at all
     *
     * @param {Object} email
     */
    function noRecipient(email) {
      return _countRecipients(email) === 0;
    }

    /**
     * This method MUST be modified in the future to leverage a send function provided by JMAPClient
     * The code here MUST not be clean so as to be changed in the future
     */
    function sendEmail(email) {
      var defer = $q.defer();
      $http.post('/unifiedinbox/api/inbox/sendemail', email)
        .success(function(data) {
          defer.resolve(data);
        })
        .error(function(reason) {
          defer.reject(reason);
        });
      return defer.promise;
    }

    function prefixSubject(subject, prefix) {
      if (!subject || !prefix) {
        return subject;
      }

      if (prefix.indexOf(' ', prefix.length - 1) === -1) {
        prefix = prefix + ' ';
      }

      if (subject.slice(0, prefix.length) === prefix) {
        return subject;
      }

      return prefix + subject;
    }

    function showReplyAllButton(email) {
      return _countRecipients(email) > 1;
    }

    function getEmailAddress(recipient) {
      if (recipient) {
        return recipient.email || recipient.preferredEmail;
      }
    }

    function getReplyToField(email) {
      if (email.replyTo && jmap.EMailer.unknown().email !== email.replyTo.email) {
        return email.replyTo;
      }

      return email.from;
    }

    function getReplyAllRecipients(email, sender) {
      function notMe(item) {
        return item.email !== getEmailAddress(sender);
      }

      if (!email || !sender) {
        return;
      }

      return {
        to: _(email.to || []).concat(getReplyToField(email)).uniq('email').value().filter(notMe),
        cc: (email.cc || []).filter(notMe),
        bcc: email.bcc || []
      };
    }

    function getReplyRecipients(email) {
      if (!email) {
        return;
      }

      return {
        to: [getReplyToField(email)],
        cc: [],
        bcc: []
      };
    }

    function _enrichWithQuote(email, body) {
      if (emailBodyService.supportsRichtext()) {
        email.htmlBody = body;
      } else {
        email.textBody = body;
      }

      email.isQuoting = true;

      return email;
    }

    function createQuotedEmail(subjectPrefix, recipients, templateName,  email, sender) {
      var newRecipients = recipients ? recipients(email, sender) : {},
          newEmail = {
            from: getEmailAddress(sender),
            to: newRecipients.to || [],
            cc: newRecipients.cc || [],
            bcc: newRecipients.bcc || [],
            subject: prefixSubject(email.subject, subjectPrefix),
            quoted: email,
            isQuoting: false,
            quoteTemplate: templateName
          };

      if (!emailBodyService.supportsRichtext()) {
        return $q.when(newEmail);
      }

      return emailBodyService.quote(email, templateName).then(function(body) {
        return _enrichWithQuote(newEmail, body);
      });
    }

    return {
      ensureEmailAndNameFields: ensureEmailAndNameFields,
      emailsAreValid: emailsAreValid,
      removeDuplicateRecipients: removeDuplicateRecipients,
      noRecipient: noRecipient,
      sendEmail: sendEmail,
      prefixSubject: prefixSubject,
      getReplyRecipients: getReplyRecipients,
      getReplyAllRecipients: getReplyAllRecipients,
      showReplyAllButton: showReplyAllButton,
      createReplyAllEmailObject: createQuotedEmail.bind(null, 'Re: ', getReplyAllRecipients, 'default'),
      createReplyEmailObject: createQuotedEmail.bind(null, 'Re: ', getReplyRecipients, 'default'),
      createForwardEmailObject: createQuotedEmail.bind(null, 'Fw: ', null, 'forward')
    };
  })

  .service('draftService', function($q, $log, jmap, session, notificationFactory, asyncJmapAction, emailBodyService, _) {

    function haveDifferentRecipients(left, right) {
      return _.xor(_.map(left, 'email'), _.map(right, 'email')).length > 0;
    }

    function haveDifferentBodies(original, newest) {
      return trim(original[emailBodyService.bodyProperty]) !== trim(newest[emailBodyService.bodyProperty]);
    }

    function mapToNameEmailTuple(recipients) {
      return (recipients || []).map(function(recipient) {
        return {
          name: recipient.name,
          email: recipient.email
        };
      });
    }

    function trim(value) {
      return (value || '').trim();
    }

    function Draft(originalEmailState) {
      this.originalEmailState = angular.copy(originalEmailState);
    }

    Draft.prototype.needToBeSaved = function(newEmailState) {
      var original = this.originalEmailState || {},
          newest = newEmailState || {};

      return (
        trim(original.subject) !== trim(newest.subject) ||
        haveDifferentBodies(original, newest) ||
        haveDifferentRecipients(original.to, newest.to) ||
        haveDifferentRecipients(original.cc, newest.cc) ||
        haveDifferentRecipients(original.bcc, newest.bcc)
      );
    };

    Draft.prototype.save = function(newEmailState) {
      if (!this.needToBeSaved(newEmailState)) {
        return $q.reject();
      }

      return asyncJmapAction('Saving your email as draft', function(client) {
        var draft = {
          from: new jmap.EMailer({
            email: session.user.preferredEmail,
            name: session.user.name
          }),
          subject: newEmailState.subject,
          to: mapToNameEmailTuple(newEmailState.to),
          cc: mapToNameEmailTuple(newEmailState.cc),
          bcc: mapToNameEmailTuple(newEmailState.bcc)
        };

        draft[emailBodyService.bodyProperty] = newEmailState[emailBodyService.bodyProperty];

        return client.saveAsDraft(new jmap.OutboundMessage(client, draft));
      });
    };

    return {
      startDraft: function(originalEmailState) {
        return new Draft(originalEmailState);
      }
    };
  })

  .service('newComposerService', function($state, boxOverlayOpener, deviceDetector) {
    var defaultTitle = 'Compose an email';

    function choseByPlatform(small, others) {
      deviceDetector.isMobile() ? small() : others();
    }

    function newMobileComposer(email) {
      $state.go('unifiedinbox.compose', {
        email: email,
        previousState: {
          name: $state.current.name,
          params: $state.params
        }});
    }

    function newBoxedComposer() {
      boxOverlayOpener.open({
        title: defaultTitle,
        templateUrl: '/unifiedinbox/views/composer/box-compose.html'
      });
    }

    function newBoxedDraftComposer(email) {
      newBoxedComposerCustomTitle('Continue your draft', email);
    }

    function newBoxedComposerCustomTitle(title, email) {
      boxOverlayOpener.open({
        title: title,
        templateUrl: '/unifiedinbox/views/composer/box-compose.html',
        email: email
      });
    }

    return {
      open: function() {
        choseByPlatform(newMobileComposer, newBoxedComposer);
      },
      openDraft: function(email) {
        choseByPlatform(
          newMobileComposer.bind(this, email),
          newBoxedDraftComposer.bind(this, email)
        );
      },
      openEmailCustomTitle: function(title, email) {
        choseByPlatform(
          newMobileComposer.bind(this, email),
          newBoxedComposerCustomTitle.bind(this, title || defaultTitle, email)
        );
      }
    };
  })

  .factory('Composition', function($q, session, draftService, emailSendingService, notificationFactory, Offline, asyncAction, jmap, emailBodyService) {

    function addDisplayNameToRecipients(recipients) {
      return (recipients || []).map(function(recipient) {
        return {
          name: recipient.name,
          email: recipient.email,
          displayName: recipient.name || recipient.email
        };
      });
    }

    function prepareEmail(email) {
      var preparingEmail = angular.copy(email || {});

      ['to', 'cc', 'bcc'].forEach(function(recipients) {
        preparingEmail[recipients] = addDisplayNameToRecipients(preparingEmail[recipients]);
      });

      return preparingEmail;
    }

    function Composition(message) {
      if (message instanceof jmap.Message) {
        this.originalJmapMessage = message;
      }
      this.email = prepareEmail(message);
      this.draft = draftService.startDraft(this.email);
    }

    Composition.prototype.saveDraft = function() {
      this.draft.save(this.email).then(this.destroyOriginalDraft.bind(this));
    };

    Composition.prototype.getEmail = function() {
      return this.email;
    };

    Composition.prototype.canBeSentOrNotify = function() {
      if (emailSendingService.noRecipient(this.email)) {
        notificationFactory.weakError('Note', 'Your email should have at least one recipient');
        return false;
      }

      if (!Offline.state || Offline.state === 'down') {
        notificationFactory.weakError('Note', 'Your device loses its Internet connection. Try later!');
        return false;
      }

      return true;
    };

    function quoteOriginalEmailIfNeeded(email) {
      // This will only be true if we're on a mobile device and the user did not press "Edit quoted email".
      // We need to quote the original email in this case, and set the quote as the HTML body so that
      // the sent email contains the original email, quoted as-is
      if (!email.isQuoting && email.quoted) {
        return emailBodyService.quoteOriginalEmail(email).then(function(body) {
          email.textBody = '';
          email.htmlBody = body;

          return email;
        });
      }

      return $q.when(email);
    }

    Composition.prototype.send = function() {
      if (!this.canBeSentOrNotify()) {
        return;
      }

      var self = this;

      this.email.from = session.user;
      emailSendingService.removeDuplicateRecipients(this.email);

      asyncAction('Sending of your message', function() {
        return quoteOriginalEmailIfNeeded(self.email).then(function(email) {
          return emailSendingService.sendEmail(email);
        });
      }).then(function() {
        self.destroyOriginalDraft();
      });
    };

    Composition.prototype.destroyOriginalDraft = function() {
      if (this.originalJmapMessage) {
        this.originalJmapMessage.destroy();
      }
    };

    return Composition;
  })

  .factory('localTimezone', function() {
    // Explicit '' here to tell angular to use the browser timezone for
    // Date formatting in the 'date' filter. This factory is here to be mocked in unit tests
    // so that the formatting is consistent accross various development machines.
    //
    // See: https://docs.angularjs.org/api/ng/filter/date
    return '';
  })

  .factory('emailBodyService', function($interpolate, $templateRequest, deviceDetector, localTimezone) {

    function quote(email, templateName) {
      if (!templateName) {
        templateName = 'default';
      }

      return _quote(email, '/unifiedinbox/views/partials/quotes/' + templateName + (supportsRichtext() ? '.html' : '.txt'));
    }

    function quoteOriginalEmail(email) {
      return _quote(email, '/unifiedinbox/views/partials/quotes/original-' + email.quoteTemplate + '.html');
    }

    function _quote(email, template) {
      return $templateRequest(template).then(function(template) {
        return $interpolate(template)({ email: email, dateFormat: 'medium', tz: localTimezone });
      });
    }

    function supportsRichtext() {
      return !deviceDetector.isMobile();
    }

    return {
      bodyProperty: supportsRichtext() ? 'htmlBody' : 'textBody',
      quote: quote,
      quoteOriginalEmail: quoteOriginalEmail,
      supportsRichtext: supportsRichtext
    };
  })

  .factory('mailboxesService', function(_, withJmapClient, MAILBOX_LEVEL_SEPARATOR) {
    var mailboxesCache;

    function filterSystemMailboxes(mailboxes) {
      return _.reject(mailboxes, function(mailbox) { return mailbox.role.value; });
    }

    function qualifyMailboxes(mailboxes) {
      return mailboxes.map(qualifyMailbox.bind(null, mailboxes));
    }

    function qualifyMailbox(mailboxes, mailbox) {
      function findParent(box) {
        return box.parentId && _.find(mailboxes, { id: box.parentId });
      }

      var parent = mailbox;

      mailbox.level = 1;
      mailbox.qualifiedName = mailbox.name;

      while ((parent = findParent(parent))) {
        mailbox.qualifiedName = parent.name + MAILBOX_LEVEL_SEPARATOR + mailbox.qualifiedName;
        mailbox.level++;
      }

      return mailbox;
    }

    function _modifyUnreadMessages(id, number) {
      var mailbox = _.find(mailboxesCache, { id: id });
      if (mailbox && angular.isDefined(mailbox.unreadMessages)) {
        mailbox.unreadMessages = Math.max(mailbox.unreadMessages + number, 0);
      }
    }

    function _setMailboxesCache(mailboxes) {
      if (mailboxes) {
        mailboxesCache = mailboxes;
      }

      return mailboxes;
    }

    function _updateMailboxCache(mailbox) {
      if (mailbox) {
        var index = _.findIndex(mailboxesCache, { id: mailbox.id });
        if (index > -1) {
          mailboxesCache[index] = mailbox;
        }
      }

      return mailbox;
    }

    function _assignToObject(object) {
      return function(attr, value) {
        if (object && !object[attr]) {
          object[attr] = value;
        }

        return value;
      };
    }

    function assignMailbox(id, dst) {
      return withJmapClient(function(client) {
        return client.getMailboxes({
          ids: [id]
        })
          .then(function(mailboxes) {
            return mailboxes[0]; // We expect a single mailbox here
          })
          .then(qualifyMailbox.bind(null, mailboxesCache))
          .then(_assignToObject(dst).bind(null, 'mailbox'))
          .then(_updateMailboxCache);
      });
    }

    function assignMailboxesList(dst, filter) {
      return withJmapClient(function(jmapClient) {
        return jmapClient.getMailboxes()
          .then(filter || _.identity)
          .then(qualifyMailboxes)
          .then(_assignToObject(dst).bind(null, 'mailboxes'))
          .then(_setMailboxesCache);
      });
    }

    function flagIsUnreadChanged(email, status) {
      if (email && angular.isDefined(status)) {
        email.mailboxIds.forEach(function(key) {
          _modifyUnreadMessages(key, (status ? 1 : -1));
        });

        return mailboxesCache;
      }
    }

    return {
      filterSystemMailboxes: filterSystemMailboxes,
      assignMailboxesList: assignMailboxesList,
      assignMailbox: assignMailbox,
      flagIsUnreadChanged: flagIsUnreadChanged
    };
  })

  .service('searchService', function(attendeeService, INBOX_AUTOCOMPLETE_LIMIT) {
    return {
      searchRecipients: function(query) {
        return attendeeService.getAttendeeCandidates(query, INBOX_AUTOCOMPLETE_LIMIT).then(function(recipients) {
          return recipients.filter(function(recipient) {
            return recipient.email;
          });
        });
      }
    };
  })

  .service('jmapEmailService', function($q, jmap) {
    function setFlag(element, flag, state) {
      if (!element || !flag || !angular.isDefined(state)) {
        throw new Error('Parameters "element", "flag" and "state" are required.');
      }

      if (element[flag] === state) {
        return $q.when();
      }

      return element['set' + jmap.Utils.capitalize(flag)](state).then(function() {
        element[flag] = state;

        return element;
      });
    }

    return {
      setFlag: setFlag
    };
  })

  .service('inboxEmailService', function($state, session, newComposerService, emailSendingService, asyncAction, jmap, jmapEmailService) {
    function moveToTrash(email) {
      asyncAction('Move of message "' + email.subject + '" to trash', function() {
        return email.moveToMailboxWithRole(jmap.MailboxRole.TRASH);
      }).then(function() {
        $state.go('^');
      });
    }

    function reply(email) {
      emailSendingService.createReplyEmailObject(email, session.user).then(newComposerService.openEmailCustomTitle.bind(null, 'Start writing your reply email'));
    }

    function replyAll(email) {
      emailSendingService.createReplyAllEmailObject(email, session.user).then(newComposerService.openEmailCustomTitle.bind(null, 'Start writing your reply all email'));
    }

    function forward(email) {
      emailSendingService.createForwardEmailObject(email, session.user).then(newComposerService.openEmailCustomTitle.bind(null, 'Start writing your forward email'));
    }

    function markAsUnread(email) {
      jmapEmailService.setFlag(email, 'isUnread', true);
    }

    function markAsRead(email) {
      jmapEmailService.setFlag(email, 'isUnread', false);
    }

    function markAsFlagged(email) {
      jmapEmailService.setFlag(email, 'isFlagged', true);
    }

    function unmarkAsFlagged(email) {
      jmapEmailService.setFlag(email, 'isFlagged', false);
    }

    return {
      reply: reply,
      replyAll: replyAll,
      forward: forward,
      markAsUnread: markAsUnread,
      markAsRead: markAsRead,
      markAsFlagged: markAsFlagged,
      unmarkAsFlagged: unmarkAsFlagged,
      moveToTrash: moveToTrash
    };
  })

  .service('inboxThreadService', function($state, session, newComposerService, emailSendingService, asyncAction, jmap, jmapEmailService) {
    function moveToTrash(thread) {
      asyncAction('Move of thread "' + thread.subject + '" to trash', function() {
        return thread.moveToMailboxWithRole(jmap.MailboxRole.TRASH);
      }).then(function() {
        $state.go('^');
      });
    }

    function markAsRead(thread) {
      jmapEmailService.setFlag(thread, 'isUnread', false);
    }

    function markAsUnread(thread) {
      jmapEmailService.setFlag(thread, 'isUnread', true);
    }

    function markAsFlagged(thread) {
      jmapEmailService.setFlag(thread, 'isFlagged', true);
    }

    function unmarkAsFlagged(thread) {
      jmapEmailService.setFlag(thread, 'isFlagged', false);
    }

    return {
      markAsUnread: markAsUnread,
      markAsRead: markAsRead,
      markAsFlagged: markAsFlagged,
      unmarkAsFlagged: unmarkAsFlagged,
      moveToTrash: moveToTrash
    };
  });
