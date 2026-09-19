"use strict";

/**
 * Must run before any `require("@prisma/client")`. Generates the client into
 * ./node_modules/.prisma — fixes "did not initialize yet" when postinstall was
 * skipped or node_modules was copied without running generate.
 */
const path = require("path");
const { execSync } = require("child_process");

const root = __dirname;

require("dotenv").config({ path: path.join(root, ".env") });

if (process.env.SKIP_PRISMA_GENERATE !== "1") {
  try {
    console.log(
      "[roku-feed-api] running npx prisma generate (set SKIP_PRISMA_GENERATE=1 to skip)…"
    );
    execSync("npx prisma generate", {
      cwd: root,
      stdio: "inherit",
      env: process.env,
      shell: true
    });
    console.log("[roku-feed-api] prisma generate finished");
  } catch {
    console.error(
      "\n[prisma] Generate failed. From the backend directory run:\n  npm install\n  npx prisma generate\n"
    );
    process.exit(1);
  }
}
