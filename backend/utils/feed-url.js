"use strict";

const { DEFAULT_FEED_URL } = require("../config");

function isValidHttpUrl(value) {
  try {
    const parsed = new URL(String(value || "").trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Accept empty (clear custom URL) or an absolute http(s) URL.
 * Prefer .json feeds but allow any http(s) path for flexibility.
 */
function normalizeFeedUrlInput(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    return { ok: true, feedUrl: null };
  }
  if (!isValidHttpUrl(trimmed)) {
    return {
      ok: false,
      error: "Feed URL must be an absolute http:// or https:// URL"
    };
  }
  return { ok: true, feedUrl: trimmed };
}

function effectiveFeedUrl(user) {
  const custom = user?.feedUrl ? String(user.feedUrl).trim() : "";
  return custom || DEFAULT_FEED_URL;
}

module.exports = {
  isValidHttpUrl,
  normalizeFeedUrlInput,
  effectiveFeedUrl
};
