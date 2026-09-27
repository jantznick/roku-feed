"use strict";

const express = require("express");
const { getPrisma } = require("../lib/prisma");
const { requireAuth } = require("../middleware/auth");
const {
  requireDeviceAuth,
  deviceSettingsPayload
} = require("../middleware/device-auth");
const {
  generateDeviceAccessToken,
  generateDeviceId,
  generatePairCode,
  hashDeviceAccessToken
} = require("../utils/device-tokens");
const { logInfo } = require("../utils/logger");

const router = express.Router();

const PAIR_TTL_MS = 15 * 60 * 1000;
const PAIR_POLL_MS = 2000;

async function allocateUniquePairCode(prisma) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const pairCode = generatePairCode();
    const existing = await prisma.device.findUnique({ where: { pairCode } });
    if (!existing) {
      return pairCode;
    }
  }
  throw new Error("Could not allocate pair code");
}

/**
 * Roku: start or refresh a pairing session.
 * Body: { deviceId? }
 */
router.post("/pair/start", async (req, res) => {
  try {
    const prisma = getPrisma();
    if (!prisma) {
      return res.status(503).json({
        ok: false,
        error: "Database is not configured",
        code: "database_unavailable"
      });
    }

    let deviceId = String(req.body?.deviceId || "").trim();
    if (!deviceId) {
      deviceId = generateDeviceId();
    }

    const pairCode = await allocateUniquePairCode(prisma);
    const pairCodeExpiresAt = new Date(Date.now() + PAIR_TTL_MS);

    const device = await prisma.device.upsert({
      where: { deviceId },
      create: {
        deviceId,
        pairCode,
        pairCodeExpiresAt,
        userId: null,
        accessTokenHash: null,
        pendingDeliveryToken: null,
        linkedAt: null,
        lastSeenAt: new Date()
      },
      update: {
        pairCode,
        pairCodeExpiresAt,
        userId: null,
        accessTokenHash: null,
        pendingDeliveryToken: null,
        linkedAt: null,
        lastSeenAt: new Date()
      }
    });

    return res.json({
      ok: true,
      deviceId: device.deviceId,
      code: pairCode,
      expiresAt: pairCodeExpiresAt.toISOString(),
      pollAfterMs: PAIR_POLL_MS,
      claimHint: "Enter this code on the web settings page while signed in."
    });
  } catch (error) {
    logInfo("Device pair start failed", { error: error.message });
    return res.status(500).json({ ok: false, error: "Failed to start pairing" });
  }
});

/**
 * Roku: poll until the web UI claims the code.
 * Query: deviceId
 *
 * When linked, returns accessToken once (from pendingDeliveryToken), then clears it.
 */
router.get("/pair/status", async (req, res) => {
  try {
    const prisma = getPrisma();
    if (!prisma) {
      return res.status(503).json({
        ok: false,
        error: "Database is not configured",
        code: "database_unavailable"
      });
    }

    const deviceId = String(req.query?.deviceId || "").trim();
    if (!deviceId) {
      return res.status(400).json({ ok: false, error: "deviceId is required" });
    }

    const device = await prisma.device.findUnique({
      where: { deviceId },
      include: { user: true }
    });

    if (!device) {
      return res.status(404).json({
        ok: false,
        status: "unknown",
        error: "Unknown device"
      });
    }

    if (device.userId && device.user && device.accessTokenHash) {
      const accessToken = device.pendingDeliveryToken || undefined;
      if (device.pendingDeliveryToken) {
        await prisma.device.update({
          where: { id: device.id },
          data: {
            pendingDeliveryToken: null,
            lastSeenAt: new Date()
          }
        });
      } else {
        await prisma.device.update({
          where: { id: device.id },
          data: { lastSeenAt: new Date() }
        });
      }

      return res.json({
        ok: true,
        status: "linked",
        linked: true,
        email: device.user.email,
        ...deviceSettingsPayload(device.user),
        ...(accessToken ? { accessToken } : {})
      });
    }

    if (
      device.pairCodeExpiresAt &&
      device.pairCodeExpiresAt.getTime() < Date.now()
    ) {
      return res.json({
        ok: true,
        status: "expired",
        linked: false,
        error: "Pairing code expired. Start pairing again."
      });
    }

    return res.json({
      ok: true,
      status: "pending",
      linked: false,
      code: device.pairCode,
      expiresAt: device.pairCodeExpiresAt
        ? device.pairCodeExpiresAt.toISOString()
        : null,
      pollAfterMs: PAIR_POLL_MS
    });
  } catch (error) {
    logInfo("Device pair status failed", { error: error.message });
    return res.status(500).json({ ok: false, error: "Failed to check pairing status" });
  }
});

/**
 * Web (logged in): claim a TV pairing code.
 * Body: { code }
 */
router.post("/pair/claim", requireAuth, async (req, res) => {
  try {
    const prisma = getPrisma();
    if (!prisma) {
      return res.status(503).json({
        ok: false,
        error: "Database is not configured",
        code: "database_unavailable"
      });
    }

    const code = String(req.body?.code || "").replace(/\D/g, "");
    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({
        ok: false,
        error: "Enter the six-digit code shown on your TV"
      });
    }

    const device = await prisma.device.findUnique({ where: { pairCode: code } });
    if (!device) {
      return res.status(404).json({
        ok: false,
        error: "Invalid pairing code"
      });
    }
    if (
      !device.pairCodeExpiresAt ||
      device.pairCodeExpiresAt.getTime() < Date.now()
    ) {
      return res.status(410).json({
        ok: false,
        error: "Pairing code expired. Start pairing again on the TV.",
        code: "pair_code_expired"
      });
    }

    const accessToken = generateDeviceAccessToken();
    const accessTokenHash = hashDeviceAccessToken(accessToken);

    await prisma.device.update({
      where: { id: device.id },
      data: {
        userId: req.user.id,
        accessTokenHash,
        pendingDeliveryToken: accessToken,
        linkedAt: new Date(),
        pairCode: null,
        pairCodeExpiresAt: null,
        lastSeenAt: new Date()
      }
    });

    return res.json({
      ok: true,
      message: "TV linked. The Roku app will finish connecting shortly.",
      deviceId: device.deviceId
    });
  } catch (error) {
    logInfo("Device pair claim failed", { error: error.message });
    return res.status(500).json({ ok: false, error: "Failed to claim pairing code" });
  }
});

/**
 * Linked device: read feed settings for the owning user.
 */
router.get("/settings", requireDeviceAuth, (req, res) => {
  return res.json({
    ok: true,
    settings: deviceSettingsPayload(req.user),
    deviceId: req.device.deviceId
  });
});

/**
 * Unlink this device token.
 */
router.delete("/link", requireDeviceAuth, async (req, res) => {
  try {
    const prisma = getPrisma();
    await prisma.device.update({
      where: { id: req.device.id },
      data: {
        userId: null,
        accessTokenHash: null,
        pendingDeliveryToken: null,
        linkedAt: null,
        pairCode: null,
        pairCodeExpiresAt: null
      }
    });
    return res.json({ ok: true });
  } catch (error) {
    logInfo("Device unlink failed", { error: error.message });
    return res.status(500).json({ ok: false, error: "Failed to unlink device" });
  }
});

module.exports = router;
