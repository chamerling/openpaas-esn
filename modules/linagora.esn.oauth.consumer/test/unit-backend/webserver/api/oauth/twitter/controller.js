'use strict';

var chai = require('chai');
var expect = chai.expect;

describe('The Twitter OAuth Consumer contoller', function() {

  var deps;
  var req;
  var logger = {
    debug: function() {},
    info: function() {}
  };
  var dependencies = function(name) {
    return deps[name];
  };

  beforeEach(function() {
    deps = {
      logger: logger
    };
    req = {
      query: {},
      user: {
        _id: 1
      }
    };
  });

  function getController() {
    return require('../../../../../../backend/webserver/api/oauth/twitter/controller')(dependencies);
  }

  describe('The callback controller', function() {

    it('should redirect to /#/accounts?provider=twitter when ok', function(done) {
      var res = {
        redirect: function(path) {
          expect(path).to.equal('/#/accounts?provider=twitter');
          done();
        }
      };
      getController().callback(req, res);
    });

    it('should redirect to /#/accounts?provider=twitter&status=:status when status is defined in req.oauth', function(done) {
      var status = 'created';
      req.oauth = {
        status: status
      };
      var res = {
        redirect: function(path) {
          expect(path).to.equal('/#/accounts?provider=twitter&status=' + status);
          done();
        }
      };
      getController().callback(req, res);
    });

    it('should redirect to /#/accounts?status=denied&provider=twitter&token=:token when req.query.denied', function(done) {
      var token = '12345';
      req.query.denied = token;
      var res = {
        redirect: function(path) {
          expect(path).to.equal('/#/accounts?status=denied&provider=twitter&token=' + token);
          done();
        }
      };
      getController().callback(req, res);
    });
  });
});
