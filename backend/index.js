"use strict";

require("./ensure-prisma");

const express = require("express");
const cors = require("cors");
const { PORT, FRONTEND_URL, NODE_ENV, DEFAULT_FEED_URL } = require("./config");
const { createSessionMiddleware } = require("./config/session");
const { logInfo } = require("./utils/logger");
const authRoutes = require("./routes/auth");
const userSettingsRoutes = require("./routes/user-settings");

const app = express();

if (NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

const corsOrigins = String(FRONTEND_URL || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || corsOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS blocked for origin: ${origin}`));
      }
    },
    credentials: true
  })
);
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(createSessionMiddleware());

app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on("finish", () => {
    const durationMs = Date.now() - startedAt;
    logInfo(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${durationMs}ms)`);
  });
  next();
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, defaultFeedUrl: DEFAULT_FEED_URL });
});

app.use("/auth", authRoutes);
app.use("/user", userSettingsRoutes);

app.listen(PORT, () => {
  logInfo(`API listening on http://localhost:${PORT}`, {
    frontendUrl: FRONTEND_URL,
    defaultFeedUrl: DEFAULT_FEED_URL
  });
});
