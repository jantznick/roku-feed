"use strict";

const express = require("express");
const { getPrisma } = require("../lib/prisma");
const { DEFAULT_FEED_URL } = require("../config");
const { requireAuthOnly, publicUser } = require("../middleware/auth");
const { normalizeFeedUrlInput, effectiveFeedUrl } = require("../utils/feed-url");
const { logInfo } = require("../utils/logger");

const router = express.Router();

router.get("/settings", requireAuthOnly, (req, res) => {
  return res.json({
    ok: true,
    settings: {
      feedUrl: req.user.feedUrl || null,
      effectiveFeedUrl: effectiveFeedUrl(req.user),
      defaultFeedUrl: DEFAULT_FEED_URL
    },
    user: publicUser(req.user)
  });
});

router.put("/settings", requireAuthOnly, async (req, res) => {
  try {
    const prisma = getPrisma();
    if (!prisma) {
      return res.status(503).json({
        ok: false,
        error: "Database is not configured",
        code: "database_unavailable"
      });
    }

    if (!Object.prototype.hasOwnProperty.call(req.body || {}, "feedUrl")) {
      return res.status(400).json({
        ok: false,
        error: "feedUrl is required (use empty string to clear)"
      });
    }

    const parsed = normalizeFeedUrlInput(req.body.feedUrl);
    if (!parsed.ok) {
      return res.status(400).json({ ok: false, error: parsed.error });
    }

    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: { feedUrl: parsed.feedUrl }
    });

    return res.json({
      ok: true,
      settings: {
        feedUrl: user.feedUrl || null,
        effectiveFeedUrl: effectiveFeedUrl(user),
        defaultFeedUrl: DEFAULT_FEED_URL
      },
      user: publicUser(user)
    });
  } catch (error) {
    logInfo("Update settings failed", { error: error.message });
    return res.status(500).json({ ok: false, error: "Failed to update settings" });
  }
});

module.exports = router;
