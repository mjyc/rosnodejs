'use strict';

var timeUtils = require('../utils/time_utils.js');

var simTimeSub = null;
var simTime = timeUtils.dateToRosTime(0);

function handleSimTimeMessage(msg) {
  simTime = msg.clock;
}

var Time = {
  useSimTime: false,

  _initializeRosTime: function _initializeRosTime(rosnodejs, notime) {
    var _this = this;

    //Only for testing purposes!
    if (notime) {
      return Promise.resolve();
    }
    var nh = rosnodejs.nh;
    return nh.getParam('/use_sim_time').then(function (val) {
      _this.useSimTime = val;

      if (val) {
        simTimeSub = nh.subscribe('/clock', 'rosgraph_msgs/Clock', handleSimTimeMessage, { throttleMs: -1 });
      }
    }).catch(function (err) {
      if (err.statusCode === undefined) {
        throw err;
      }
    });
  },
  now: function now() {
    if (this.useSimTime) {
      return simTime;
    }
    // else
    return timeUtils.now();
  },


  rosTimeToDate: timeUtils.rosTimeToDate,
  dateToRosTime: timeUtils.dateToRosTime,
  epoch: timeUtils.epoch,
  isZeroTime: timeUtils.isZeroTime,
  toNumber: timeUtils.toNumber,
  toSeconds: timeUtils.toSeconds,
  timeComp: timeUtils.timeComp
};

module.exports = Time;