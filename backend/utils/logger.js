"use strict";

const { LOG_PREFIX } = require("../config");

function logInfo(message, details) {
  const timestamp = new Date().toISOString();
  if (details) {
    console.log(`${LOG_PREFIX} ${timestamp} ${message}`, details);
  } else {
    console.log(`${LOG_PREFIX} ${timestamp} ${message}`);
  }
}

module.exports = {
  logInfo
};
