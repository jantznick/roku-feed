"use strict";

const session = require("express-session");
const connectPgSimple = require("connect-pg-simple");
const { Pool } = require("pg");
const {
  SESSION_SECRET,
  COOKIE_DOMAIN,
  NODE_ENV,
  DATABASE_URL
} = require("../config");

const PgSession = connectPgSimple(session);

function createSessionMiddleware() {
  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL is required for session store");
  }

  const pgPool = new Pool({ connectionString: DATABASE_URL });
  const isProd = NODE_ENV === "production";

  return session({
    store: new PgSession({
      pool: pgPool,
      tableName: "session",
      createTableIfMissing: false
    }),
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    name: "feed.sid",
    cookie: {
      secure: isProd,
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      sameSite: isProd ? "none" : "lax",
      ...(COOKIE_DOMAIN ? { domain: COOKIE_DOMAIN } : {}),
      path: "/"
    },
    proxy: isProd
  });
}

module.exports = { createSessionMiddleware };
