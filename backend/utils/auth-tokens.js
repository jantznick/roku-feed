"use strict";

const { createHash, randomBytes, randomInt } = require("crypto");
const { getPrisma } = require("../lib/prisma");

const TTL = {
  magic_link: 15 * 60 * 1000,
  magic_code: 15 * 60 * 1000,
  password_reset: 60 * 60 * 1000,
  email_verification: 24 * 60 * 60 * 1000
};

function generateToken() {
  return randomBytes(32).toString("hex");
}

function generateMagicCode() {
  return String(randomInt(0, 1000000)).padStart(6, "0");
}

function hashMagicCode(email, code) {
  return createHash("sha256")
    .update(`${String(email || "").trim().toLowerCase()}:${String(code || "")}`)
    .digest("hex");
}

async function createAuthToken(userId, tokenType, tokenOverride) {
  const prisma = getPrisma();
  if (!prisma) {
    throw new Error("Database unavailable");
  }
  const ttl = TTL[tokenType];
  if (!ttl) {
    throw new Error(`Unknown token type: ${tokenType}`);
  }
  const token = tokenOverride || generateToken();
  const expiresAt = new Date(Date.now() + ttl);
  const row = await prisma.authToken.create({
    data: {
      userId,
      token,
      tokenType,
      expiresAt
    }
  });
  return row;
}

/**
 * Find a valid unused token. Does not mark used.
 */
async function findValidAuthToken(token, tokenType) {
  const prisma = getPrisma();
  if (!prisma) {
    return null;
  }
  const row = await prisma.authToken.findUnique({
    where: { token },
    include: { user: true }
  });
  if (!row) {
    return null;
  }
  if (tokenType && row.tokenType !== tokenType) {
    return null;
  }
  if (row.usedAt) {
    return null;
  }
  if (row.expiresAt < new Date()) {
    return null;
  }
  return row;
}

async function markAuthTokenUsed(id) {
  const prisma = getPrisma();
  if (!prisma) {
    return;
  }
  await prisma.authToken.update({
    where: { id },
    data: { usedAt: new Date() }
  });
}

module.exports = {
  TTL,
  generateToken,
  generateMagicCode,
  hashMagicCode,
  createAuthToken,
  findValidAuthToken,
  markAuthTokenUsed
};
