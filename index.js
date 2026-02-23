'use strict';

const { RelianceXRPlatform } = require('./platform');

module.exports = (api) => {
  api.registerPlatform('homebridge-reliance-xr', 'RelianceXR', RelianceXRPlatform);
};