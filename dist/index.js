/*
 *    Copyright 2016 Rethink Robotics
 *
 *    Copyright 2016 Chris Smith
 *
 *    Licensed under the Apache License, Version 2.0 (the "License");
 *    you may not use this file except in compliance with the License.
 *    You may obtain a copy of the License at
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 *    Unless required by applicable law or agreed to in writing, software
 *    distributed under the License is distributed on an "AS IS" BASIS,
 *    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *    See the License for the specific language governing permissions and
 *    limitations under the License.
 */

"use strict";

//------------------------------------------------------------------

var netUtils = require('./utils/network_utils.js');
var msgUtils = require('./utils/message_utils.js');
var messages = require('./utils/messageGeneration/messages.js');
var util = require('util');
var RosLogStream = require('./utils/log/RosLogStream.js');
var ConsoleLogStream = require('./utils/log/ConsoleLogStream.js');
var LogFormatter = require('./utils/log/LogFormatter.js');
var RosNode = require('./lib/RosNode.js');
var NodeHandle = require('./lib/NodeHandle.js');
var Logging = require('./lib/Logging.js');
var ActionClientInterface = require('./lib/ActionClientInterface.js');
var Time = require('./lib/Time.js');
var packages = require('./utils/messageGeneration/packages.js');

var ActionServer = require('./actions/ActionServer.js');

var MsgLoader = require('./utils/messageGeneration/MessageLoader.js');

// will be initialized through call to initNode
var log = Logging.getLogger();
var rosNode = null;
var pingMasterTimeout = null;

//------------------------------------------------------------------
/**
 * @private
 * Helper function to see if the master is available and able to accept
 * connections.
 * @param {number} timeout time in ms between connection attempts
 * @param {number} maxTimeout maximum time in ms to retry before timing out.
 * A negative number will make it retry forever. 0 will only make one attempt
 * before timing out.
 */
function _checkMasterHelper() {
  var timeout = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : 100;
  var maxTimeout = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : -1;

  var startTime = Date.now();
  var localHelper = function localHelper(resolve, reject) {
    pingMasterTimeout = setTimeout(function () {
      // also check that the slave api server is set up
      if (!rosNode.slaveApiSetupComplete()) {
        if (Date.now() - startTime >= maxTimeout && !(maxTimeout < 0)) {
          log.error('Unable to register with master node [' + rosNode.getRosMasterUri() + ']: unable to set up slave API Server. Stopping...');
          reject(Error('Unable to setup slave API server.'));
          return;
        }
        localHelper(resolve, reject);
        return;
      }
      rosNode.getMasterUri({ maxAttempts: 1 }).then(function () {
        log.infoOnce('Connected to master at ' + rosNode.getRosMasterUri() + '!');
        pingMasterTimeout = null;
        resolve();
      }).catch(function (err, resp) {
        if (Date.now() - startTime >= maxTimeout && !(maxTimeout < 0)) {
          log.error('Timed out before registering with master node [' + rosNode.getRosMasterUri() + ']: master may not be running yet.');
          reject(Error('Registration with master timed out.'));
          return;
        } else {
          log.warnThrottle(60000, 'Unable to register with master node [' + rosNode.getRosMasterUri() + ']: master may not be running yet. Will keep trying.');
          localHelper(resolve, reject);
        }
      });
    }, timeout);
  };

  return new Promise(function (resolve, reject) {
    localHelper(resolve, reject);
  });
}

/**
 * Very basic validation of node name - needs to start with a '/'
 * TODO: more
 * @return {string} name of node after validation
 */
function _validateNodeName(nodeName) {
  if (!nodeName.startsWith('/')) {
    nodeName = '/' + nodeName;
  }
  return nodeName;
}

/**
 * Appends a random string of numeric characters to the end
 * of the node name. Follows rospy logic.
 * @param nodeName {string} string to anonymize
 * @return {string} anonymized nodeName
 */
function _anonymizeNodeName(nodeName) {
  return util.format('%s_%s_%s', nodeName, process.pid, Date.now());
}

var Rosnodejs = {
  /**
   * Initializes a ros node for this process. Only one ros node can exist per process.
   * If called a second time with the same nodeName, returns a handle to that node.
   * @param {string} nodeName name of the node to initialize
   * @param {object} options  overrides for this node
   * @param {boolean}   options.anonymous Set node to be anonymous
   * @param {object}    options.logging logger options for this node
   * @param {function}  options.logging.getLoggers  the function for setting which loggers
   *                                                to be used for this node
   * @param {function}  options.logging.setLoggerLevel  the function for setting the logger
   *                                                    level
   * @param {string}    options.rosMasterUri the Master URI to use for this node
   * @param {number}    options.timeout time in ms to wait for node to be initialized
   *                                    before timing out. A negative value will retry forever.
   *                                    A value of '0' will try once before stopping. @default -1
   * @return {Promise} resolved when connection to master is established
   */
  initNode: function initNode(nodeName, options) {
    var _this = this;

    options = options || {};
    if (options.anonymous) {
      nodeName = _anonymizeNodeName(nodeName);
    }

    nodeName = _validateNodeName(nodeName);

    if (rosNode !== null) {
      if (nodeName === rosNode.getNodeName()) {
        return Promise.resolve(this.getNodeHandle());
      }
      // else
      return Promise.reject(Error('Unable to initialize node [' + nodeName + '] - node [' + rosNode.getNodeName() + '] already exists'));
    }

    var rosMasterUri = process.env.ROS_MASTER_URI;
    if (options.rosMasterUri) {
      rosMasterUri = options.rosMasterUri;
    }

    Logging.initializeNodeLogger(nodeName, options.logging);

    // create the ros node. Return a promise that will
    // resolve when connection to master is established
    var nodeOpts = options.node || {};
    rosNode = new RosNode(nodeName, rosMasterUri, nodeOpts);

    return new Promise(function (resolve, reject) {
      _this._loadOnTheFlyMessages(options).then(function () {
        return _checkMasterHelper(100, options.timeout);
      }).then(Logging.initializeRosOptions.bind(Logging, _this, options.logging)).then(Time._initializeRosTime.bind(Time, _this, options.notime)).then(function () {
        resolve(_this.getNodeHandle());
      }).catch(function (err) {
        log.error('Error during initialization: ' + err);
        _this.shutdown();
        reject(err);
      });
    });
  },
  reset: function reset() {
    rosNode = null;
  },
  shutdown: function shutdown() {
    clearTimeout(pingMasterTimeout);
    if (this.ok()) {
      return rosNode.shutdown();
    }
    // else
    return Promise.resolve();
  },
  ok: function ok() {
    return rosNode && !rosNode.isShutdown();
  },
  on: function on(evt, handler) {
    if (rosNode) {
      rosNode.on(evt, handler);
    }
  },
  once: function once(evt, handler) {
    if (rosNode) {
      rosNode.once(evt, handler);
    }
  },
  removeListener: function removeListener(evt, handler) {
    if (rosNode) {
      rosNode.removeListener(evt, handler);
    }
  },
  _loadOnTheFlyMessages: function _loadOnTheFlyMessages(_ref) {
    var onTheFly = _ref.onTheFly;

    if (onTheFly) {
      return messages.getAll();
    }
    // else
    return Promise.resolve();
  },
  loadPackage: function loadPackage(packageName) {
    var outputDir = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : null;
    var verbose = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : false;

    var msgLoader = new MsgLoader(verbose);
    if (!outputDir) {
      outputDir = msgUtils.getTopLevelMessageDirectory();
    }
    return msgLoader.buildPackage(packageName, outputDir).then(function () {
      console.log('Finished building messages!');
    }).catch(function (err) {
      console.error(err);
    });
  },
  loadAllPackages: function loadAllPackages() {
    var outputDir = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : null;
    var verbose = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : false;

    var msgLoader = new MsgLoader(verbose);
    if (!outputDir) {
      outputDir = msgUtils.getTopLevelMessageDirectory();
    }
    return msgLoader.buildPackageTree(outputDir).then(function () {
      console.log('Finished building messages!');
    });
  },
  findPackage: function findPackage(packageName) {
    return new Promise(function (resolve, reject) {
      packages.findPackage(packageName, function (err, dir) {
        if (err) {
          reject(err);
        }
        // else
        resolve(dir);
      });
    });
  },
  require: function require(msgPackage) {
    return msgUtils.requireMsgPackage(msgPackage);
  },
  getAvailableMessagePackages: function getAvailableMessagePackages() {
    return msgUtils.getAvailableMessagePackages();
  },


  /** check that a message definition is loaded for a ros message
      type, e.g., geometry_msgs/Twist */
  checkMessage: function checkMessage(type) {
    var parts = type.split('/');
    var rtv = void 0;
    try {
      rtv = this.require(parts[0]).msg[parts[1]];
    } catch (e) {}
    return rtv;
  },


  /** check that a service definition is loaded for a ros service
      type, e.g., turtlesim/TeleportRelative */
  checkService: function checkService(type) {
    var parts = type.split('/');
    var rtv = void 0;
    try {
      rtv = this.require(parts[0]).srv[parts[1]];
    } catch (e) {}
    return rtv;
  },


  /**
   * @return {NodeHandle} for initialized node
   */
  getNodeHandle: function getNodeHandle(namespace) {
    return new NodeHandle(rosNode, namespace);
  },


  get nodeHandle() {
    return new NodeHandle(rosNode);
  },

  get nh() {
    return new NodeHandle(rosNode);
  },

  get log() {
    return Logging;
  },

  get logStreams() {
    return {
      console: ConsoleLogStream,
      ros: RosLogStream
    };
  },

  get Time() {
    return Time;
  },

  //------------------------------------------------------------------
  // ActionLib
  //------------------------------------------------------------------

  /**
    Get an action client for a given type and action server.
     **Deprecated**: Use rosNode.nh.actionClientInterface instead.
     Example:
      let ac = rosNode.nh.getActionClient(
        "/turtle_shape", "turtle_actionlib/ShapeAction");
      let shapeActionGoal =
        rosnodejs.require('turtle_actionlib').msg.ShapeActionGoal;
      ac.sendGoal(new shapeActionGoal({ goal: { edges: 3,  radius: 1 } }));
   */
  getActionClient: function getActionClient(options) {
    return this.nh.actionClientInterface(options.actionServer, options.type, options);
  }
};

Rosnodejs.ActionServer = ActionServer;

module.exports = Rosnodejs;
