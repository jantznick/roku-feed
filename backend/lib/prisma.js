"use strict";

let prismaSingleton;

function getPrisma() {
  if (!process.env.DATABASE_URL) {
    return null;
  }
  if (!prismaSingleton) {
    const { PrismaClient } = require("@prisma/client");
    prismaSingleton = new PrismaClient();
  }
  return prismaSingleton;
}

module.exports = { getPrisma };
