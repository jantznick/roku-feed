"use strict";

const { createHash, randomBytes, randomInt } = require("crypto");

function hashDeviceAccessToken(token) {
  return createHash("sha256").update(String(token || "")).digest("hex");
}

function generateDeviceAccessToken() {
  return randomBytes(32).toString("hex");
}

function generatePairCode() {
  // 6-digit numeric code, easy to type on phone/web
  return String(randomInt(0, 1000000)).padStart(6, "0");
}

function generateDeviceId() {
  return randomBytes(16).toString("hex");
}

module.exports = {
  hashDeviceAccessToken,
  generateDeviceAccessToken,
  generatePairCode,
  generateDeviceId
};
