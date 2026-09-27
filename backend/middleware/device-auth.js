"use strict";

const { getPrisma } = require("../lib/prisma");
const { DEFAULT_FEED_URL } = require("../config");
const { effectiveFeedUrl } = require("../utils/feed-url");
const { hashDeviceAccessToken } = require("../utils/device-tokens");
const { logInfo } = require("../utils/logger");

function getBearerToken(req) {
  const header = String(req.headers.authorization || "");
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

/**
 * Device bearer auth. Attaches req.device and req.user (linked owner).
 * No Origin/CSRF check — Roku has no browser origin.
 */
async function requireDeviceAuth(req, res, next) {
  try {
    const token = getBearerToken(req);
    if (!token) {
      return res.status(401).json({
        ok: false,
        error: "Device authentication required",
        code: "device_auth_required"
      });
    }

    const prisma = getPrisma();
    if (!prisma) {
      return res.status(503).json({
        ok: false,
        error: "Database is not configured",
        code: "database_unavailable"
      });
    }

    const tokenHash = hashDeviceAccessToken(token);
    const device = await prisma.device.findUnique({
      where: { accessTokenHash: tokenHash },
      include: { user: true }
    });

    if (!device || !device.userId || !device.user) {
      return res.status(401).json({
        ok: false,
        error: "Invalid or unlinked device token",
        code: "device_auth_invalid"
      });
    }

    await prisma.device.update({
      where: { id: device.id },
      data: { lastSeenAt: new Date() }
    });

    req.device = device;
    req.user = device.user;
    return next();
  } catch (error) {
    logInfo("Device auth failed", { error: error.message });
    return next(error);
  }
}

function deviceSettingsPayload(user) {
  return {
    feedUrl: user.feedUrl || null,
    effectiveFeedUrl: effectiveFeedUrl(user),
    defaultFeedUrl: DEFAULT_FEED_URL,
    email: user.email
  };
}

module.exports = {
  getBearerToken,
  requireDeviceAuth,
  deviceSettingsPayload
};
