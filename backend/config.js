"use strict";

const path = require("path");

require("dotenv").config({ path: path.join(__dirname, ".env") });

const PORT = process.env.PORT || 3001;
const LOG_PREFIX = "[roku-feed-api]";
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";
const APP_URL = process.env.APP_URL || FRONTEND_URL;
const SESSION_SECRET =
  process.env.SESSION_SECRET || "dev-session-secret-change-me";
const COOKIE_DOMAIN = process.env.COOKIE_DOMAIN || "";
const NODE_ENV = process.env.NODE_ENV || "development";
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const RESEND_FROM_EMAIL =
  process.env.RESEND_FROM_EMAIL || "Roku Feed <onboarding@resend.dev>";
const DATABASE_URL = process.env.DATABASE_URL || "";
const DEFAULT_FEED_URL =
  process.env.DEFAULT_FEED_URL ||
  "https://f004.backblazeb2.com/file/roku-hockey/secretfeedfilename.json";

module.exports = {
  PORT,
  LOG_PREFIX,
  FRONTEND_URL,
  APP_URL,
  SESSION_SECRET,
  COOKIE_DOMAIN,
  NODE_ENV,
  RESEND_API_KEY,
  RESEND_FROM_EMAIL,
  DATABASE_URL,
  DEFAULT_FEED_URL
};
