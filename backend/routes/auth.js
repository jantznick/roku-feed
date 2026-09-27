"use strict";

const express = require("express");
const bcrypt = require("bcryptjs");
const { getPrisma } = require("../lib/prisma");
const { APP_URL } = require("../config");
const { normalizeEmail } = require("../utils/email-normalize");
const {
  createAuthToken,
  createSessionAccessToken,
  findValidAuthToken,
  generateMagicCode,
  hashMagicCode,
  markAuthTokenUsed,
  revokeSessionAccessToken
} = require("../utils/auth-tokens");
const {
  sendMagicLinkEmail,
  sendVerificationEmail,
  sendPasswordResetEmail
} = require("../utils/email");
const {
  publicUser,
  requireAuthOnly,
  saveSession,
  getBearerToken
} = require("../middleware/auth");
const { logInfo } = require("../utils/logger");

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PASSWORD_MIN = 6;
const PASSWORD_MAX = 128;
const MAGIC_CODE_MAX_ATTEMPTS = 5;
const MAGIC_CODE_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const magicCodeAttempts = new Map();

async function issueAccessToken(userId) {
  const row = await createSessionAccessToken(userId);
  return row.token;
}

async function respondWithAuth(res, user, status = 200) {
  const accessToken = await issueAccessToken(user.id);
  return res.status(status).json({
    ok: true,
    user: publicUser(user),
    accessToken
  });
}

function magicCodeAttemptKey(req, email) {
  return `${req.ip || "unknown"}:${email}`;
}

function recordMagicCodeAttempt(req, email) {
  const key = magicCodeAttemptKey(req, email);
  const now = Date.now();
  const current = magicCodeAttempts.get(key);
  const state =
    !current || current.resetAt <= now
      ? { count: 0, resetAt: now + MAGIC_CODE_ATTEMPT_WINDOW_MS }
      : current;
  state.count += 1;
  magicCodeAttempts.set(key, state);
  return state.count <= MAGIC_CODE_MAX_ATTEMPTS;
}

function isValidEmail(email) {
  return EMAIL_RE.test(email);
}

function isValidPassword(password) {
  const len = String(password || "").length;
  return len >= PASSWORD_MIN && len <= PASSWORD_MAX;
}

function appBaseUrl() {
  return String(APP_URL || "").replace(/\/$/, "");
}

router.post("/register", async (req, res) => {
  try {
    const prisma = getPrisma();
    if (!prisma) {
      return res.status(503).json({
        ok: false,
        error: "Database is not configured",
        code: "database_unavailable"
      });
    }

    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || "");

    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ ok: false, error: "Valid email is required" });
    }
    if (!isValidPassword(password)) {
      return res.status(400).json({
        ok: false,
        error: `Password must be ${PASSWORD_MIN}–${PASSWORD_MAX} characters`
      });
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(400).json({
        ok: false,
        error: existing.passwordHash
          ? "An account with this email already exists. Sign in instead."
          : "An account with this email already exists. Sign in with a code or magic link, or use “Forgot password?” to set a password.",
        code: "email_taken"
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        emailVerified: false
      }
    });

    const tokenRow = await createAuthToken(user.id, "email_verification");
    const verificationLink = `${appBaseUrl()}/verify-email?token=${tokenRow.token}`;
    await sendVerificationEmail(email, verificationLink);

    req.session.userId = user.id;
    await saveSession(req);

    return respondWithAuth(res, user, 201);
  } catch (error) {
    logInfo("Register failed", { error: error.message });
    return res.status(500).json({ ok: false, error: "Registration failed" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const prisma = getPrisma();
    if (!prisma) {
      return res.status(503).json({
        ok: false,
        error: "Database is not configured",
        code: "database_unavailable"
      });
    }

    const email = normalizeEmail(req.body?.email);
    const password = String(req.body?.password || "");

    if (!email || !password) {
      return res.status(400).json({ ok: false, error: "Email and password are required" });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user?.passwordHash) {
      return res.status(401).json({ ok: false, error: "Invalid email or password" });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ ok: false, error: "Invalid email or password" });
    }

    req.session.userId = user.id;
    await saveSession(req);

    return respondWithAuth(res, user);
  } catch (error) {
    logInfo("Login failed", { error: error.message });
    return res.status(500).json({ ok: false, error: "Login failed" });
  }
});

router.post("/logout", async (req, res) => {
  try {
    const bearer = getBearerToken(req);
    if (bearer) {
      await revokeSessionAccessToken(bearer);
    }
  } catch {
    // ignore revoke errors
  }

  if (!req.session) {
    return res.json({ ok: true });
  }

  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ ok: false, error: "Failed to logout" });
    }
    res.clearCookie("feed.sid");
    return res.json({ ok: true });
  });
});

router.get("/me", requireAuthOnly, (req, res) => {
  return res.json({ ok: true, user: publicUser(req.user) });
});

router.post("/magic-link/request", async (req, res) => {
  try {
    const prisma = getPrisma();
    if (!prisma) {
      return res.status(503).json({
        ok: false,
        error: "Database is not configured",
        code: "database_unavailable"
      });
    }

    const email = normalizeEmail(req.body?.email);
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ ok: false, error: "Valid email is required" });
    }

    const intent = String(req.body?.intent || "");

    let user = await prisma.user.findUnique({ where: { email } });
    if (user && intent === "register") {
      return res.status(400).json({
        ok: false,
        error: "An account with this email already exists. Sign in instead.",
        code: "email_taken"
      });
    }
    if (!user) {
      user = await prisma.user.create({
        data: {
          email,
          passwordHash: null,
          emailVerified: false
        }
      });
    }

    await prisma.authToken.updateMany({
      where: {
        userId: user.id,
        tokenType: { in: ["magic_link", "magic_code"] },
        usedAt: null
      },
      data: { usedAt: new Date() }
    });

    const tokenRow = await createAuthToken(user.id, "magic_link");
    const magicCode = generateMagicCode();
    await createAuthToken(
      user.id,
      "magic_code",
      hashMagicCode(email, magicCode)
    );
    const magicLink = `${appBaseUrl()}/auth/verify?token=${tokenRow.token}`;
    await sendMagicLinkEmail(email, magicLink, magicCode);

    return res.json({
      ok: true,
      message: "If that email can receive mail, a magic link and code were sent."
    });
  } catch (error) {
    logInfo("Magic link request failed", { error: error.message });
    return res.status(500).json({ ok: false, error: "Failed to send magic link" });
  }
});

router.get("/magic-link/verify", async (req, res) => {
  try {
    const token = String(req.query?.token || "");
    if (!token) {
      return res.status(400).json({ ok: false, error: "Invalid token" });
    }

    const authToken = await findValidAuthToken(token, "magic_link");
    if (!authToken) {
      return res.status(401).json({
        ok: false,
        error: "Invalid or expired magic link"
      });
    }

    const prisma = getPrisma();
    await markAuthTokenUsed(authToken.id);
    await prisma.authToken.updateMany({
      where: {
        userId: authToken.userId,
        tokenType: "magic_code",
        usedAt: null
      },
      data: { usedAt: new Date() }
    });
    const user = await prisma.user.update({
      where: { id: authToken.userId },
      data: { emailVerified: true }
    });

    req.session.userId = user.id;
    await saveSession(req);

    return respondWithAuth(res, user);
  } catch (error) {
    logInfo("Magic link verify failed", { error: error.message });
    return res.status(500).json({ ok: false, error: "Verification failed" });
  }
});

router.post("/magic-code/verify", async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    const code = String(req.body?.code || "").replace(/\D/g, "");

    if (!email || !isValidEmail(email) || !/^\d{6}$/.test(code)) {
      return res.status(400).json({
        ok: false,
        error: "Enter a valid email and six-digit code"
      });
    }

    if (!recordMagicCodeAttempt(req, email)) {
      return res.status(429).json({
        ok: false,
        error: "Too many incorrect codes. Request a new code and try again.",
        code: "magic_code_rate_limited"
      });
    }

    const authToken = await findValidAuthToken(
      hashMagicCode(email, code),
      "magic_code"
    );
    if (!authToken || normalizeEmail(authToken.user.email) !== email) {
      return res.status(401).json({
        ok: false,
        error: "Invalid or expired code"
      });
    }

    const prisma = getPrisma();
    await markAuthTokenUsed(authToken.id);
    await prisma.authToken.updateMany({
      where: {
        userId: authToken.userId,
        tokenType: "magic_link",
        usedAt: null
      },
      data: { usedAt: new Date() }
    });
    const user = await prisma.user.update({
      where: { id: authToken.userId },
      data: { emailVerified: true }
    });

    magicCodeAttempts.delete(magicCodeAttemptKey(req, email));
    req.session.userId = user.id;
    await saveSession(req);

    return respondWithAuth(res, user);
  } catch (error) {
    logInfo("Magic code verify failed", { error: error.message });
    return res.status(500).json({ ok: false, error: "Verification failed" });
  }
});

router.post("/verify-email/resend", requireAuthOnly, async (req, res) => {
  try {
    if (req.user.emailVerified) {
      return res.status(400).json({ ok: false, error: "Email is already verified" });
    }
    const tokenRow = await createAuthToken(req.user.id, "email_verification");
    const verificationLink = `${appBaseUrl()}/verify-email?token=${tokenRow.token}`;
    await sendVerificationEmail(req.user.email, verificationLink);
    return res.json({ ok: true, message: "Verification email sent" });
  } catch (error) {
    logInfo("Resend verification failed", { error: error.message });
    return res.status(500).json({ ok: false, error: "Failed to resend verification" });
  }
});

router.get("/verify-email", async (req, res) => {
  try {
    const token = String(req.query?.token || "");
    if (!token) {
      return res.status(400).json({ ok: false, error: "Invalid token" });
    }

    const authToken = await findValidAuthToken(token, "email_verification");
    if (!authToken) {
      return res.status(401).json({
        ok: false,
        error: "Invalid or expired verification link"
      });
    }

    const prisma = getPrisma();
    await markAuthTokenUsed(authToken.id);
    const user = await prisma.user.update({
      where: { id: authToken.userId },
      data: { emailVerified: true }
    });

    req.session.userId = user.id;
    await saveSession(req);

    return respondWithAuth(res, user);
  } catch (error) {
    logInfo("Verify email failed", { error: error.message });
    return res.status(500).json({ ok: false, error: "Verification failed" });
  }
});

router.post("/forgot-password", async (req, res) => {
  try {
    const prisma = getPrisma();
    const email = normalizeEmail(req.body?.email);
    const generic = {
      ok: true,
      message: "If an account exists for that email, a reset link was sent."
    };

    if (!prisma || !email || !isValidEmail(email)) {
      return res.json(generic);
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      const tokenRow = await createAuthToken(user.id, "password_reset");
      const resetLink = `${appBaseUrl()}/reset-password?token=${tokenRow.token}`;
      await sendPasswordResetEmail(email, resetLink);
    }

    return res.json(generic);
  } catch (error) {
    logInfo("Forgot password failed", { error: error.message });
    return res.json({
      ok: true,
      message: "If an account exists for that email, a reset link was sent."
    });
  }
});

router.post("/reset-password", async (req, res) => {
  try {
    const prisma = getPrisma();
    if (!prisma) {
      return res.status(503).json({
        ok: false,
        error: "Database is not configured",
        code: "database_unavailable"
      });
    }

    const token = String(req.body?.token || "");
    const password = String(req.body?.password || "");
    if (!token) {
      return res.status(400).json({ ok: false, error: "Token is required" });
    }
    if (!isValidPassword(password)) {
      return res.status(400).json({
        ok: false,
        error: `Password must be ${PASSWORD_MIN}–${PASSWORD_MAX} characters`
      });
    }

    const authToken = await findValidAuthToken(token, "password_reset");
    if (!authToken) {
      return res.status(401).json({
        ok: false,
        error: "Invalid or expired reset link"
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    await markAuthTokenUsed(authToken.id);
    await prisma.user.update({
      where: { id: authToken.userId },
      data: {
        passwordHash,
        emailVerified: true
      }
    });

    await prisma.$executeRaw`DELETE FROM "session" WHERE "sess"->>'userId' = ${authToken.userId}`;

    return res.json({ ok: true, message: "Password updated. You can sign in now." });
  } catch (error) {
    logInfo("Reset password failed", { error: error.message });
    return res.status(500).json({ ok: false, error: "Password reset failed" });
  }
});

module.exports = router;
