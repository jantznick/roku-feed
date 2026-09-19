"use strict";

const { getPrisma } = require("../lib/prisma");
const { FRONTEND_URL, DEFAULT_FEED_URL } = require("../config");
const { effectiveFeedUrl } = require("../utils/feed-url");
const { logInfo } = require("../utils/logger");

const allowedOrigins = String(FRONTEND_URL || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

function checkOriginCsrf(req, res) {
  const origin = req.headers.origin;
  if (!origin) {
    return true;
  }
  if (!allowedOrigins.includes(origin)) {
    logInfo("Authenticated request blocked: unauthorized origin", {
      method: req.method,
      path: req.path,
      origin,
      allowedOrigins
    });
    res.status(403).json({
      ok: false,
      error: "Forbidden: Origin not allowed",
      code: "FORBIDDEN_ORIGIN"
    });
    return false;
  }
  return true;
}

function publicUser(user) {
  if (!user) {
    return null;
  }
  return {
    id: user.id,
    email: user.email,
    emailVerified: Boolean(user.emailVerified),
    feedUrl: user.feedUrl || null,
    effectiveFeedUrl: effectiveFeedUrl(user),
    defaultFeedUrl: DEFAULT_FEED_URL
  };
}

async function loadSessionUser(req, res) {
  if (!req.session?.userId) {
    res.status(401).json({
      ok: false,
      error: "Authentication required",
      code: "auth_required"
    });
    return null;
  }
  if (!checkOriginCsrf(req, res)) {
    return null;
  }
  const prisma = getPrisma();
  if (!prisma) {
    res.status(503).json({
      ok: false,
      error: "Database is not configured",
      code: "database_unavailable"
    });
    return null;
  }
  const user = await prisma.user.findUnique({
    where: { id: req.session.userId }
  });
  if (!user) {
    res.status(401).json({
      ok: false,
      error: "Authentication required",
      code: "auth_required"
    });
    return null;
  }
  return user;
}

/**
 * Session required. Attaches req.user. Does not require emailVerified.
 */
async function requireAuthOnly(req, res, next) {
  try {
    const user = await loadSessionUser(req, res);
    if (!user) {
      return undefined;
    }
    req.user = user;
    return next();
  } catch (error) {
    return next(error);
  }
}

/**
 * Session + verified email. Attaches req.user.
 */
async function requireAuth(req, res, next) {
  try {
    const user = await loadSessionUser(req, res);
    if (!user) {
      return undefined;
    }
    if (!user.emailVerified) {
      return res.status(403).json({
        ok: false,
        error: "Email verification required",
        code: "EMAIL_NOT_VERIFIED"
      });
    }
    req.user = user;
    return next();
  } catch (error) {
    return next(error);
  }
}

function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save((err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

module.exports = {
  publicUser,
  requireAuthOnly,
  requireAuth,
  saveSession
};
