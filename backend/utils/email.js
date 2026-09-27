"use strict";

const { RESEND_API_KEY, RESEND_FROM_EMAIL, NODE_ENV } = require("../config");
const { logInfo } = require("./logger");

function useDevEmail() {
  return (
    NODE_ENV === "development" ||
    !RESEND_API_KEY ||
    RESEND_API_KEY === "re_your_api_key_here"
  );
}

function logDevEmail({ to, subject, link, code, note }) {
  console.log("\n");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`EMAIL (Development Mode): ${subject}`);
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`To:      ${to}`);
  console.log(`Subject: ${subject}`);
  if (note) {
    console.log(`Note:    ${note}`);
  }
  if (link) {
    console.log("");
    console.log(`  ${link}`);
  }
  if (code) {
    console.log("");
    console.log(`  Code: ${code}`);
  }
  console.log("═══════════════════════════════════════════════════════════");
  console.log("\n");
}

async function sendViaResend({ to, subject, html, text }) {
  if (useDevEmail()) {
    return { ok: true, mode: "dev" };
  }
  try {
    const { Resend } = require("resend");
    const resend = new Resend(RESEND_API_KEY);
    await resend.emails.send({
      from: RESEND_FROM_EMAIL,
      to,
      subject,
      html,
      text
    });
    logInfo("Email sent via Resend", { to, subject });
    return { ok: true, mode: "resend" };
  } catch (error) {
    logInfo("Resend send failed; falling back to console", {
      to,
      subject,
      error: error.message
    });
    return { ok: false, mode: "fallback", error: error.message };
  }
}

function wrapHtml(title, bodyHtml) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <div style="background: #0f172a; padding: 24px; text-align: center; border-radius: 8px 8px 0 0;">
    <h1 style="color: white; margin: 0; font-size: 24px;">Roku Feed</h1>
  </div>
  <div style="background: #f9fafb; padding: 28px; border-radius: 0 0 8px 8px; border: 1px solid #e5e7eb; border-top: none;">
    <h2 style="color: #111827; margin-top: 0;">${title}</h2>
    ${bodyHtml}
  </div>
</body>
</html>`;
}

async function sendMagicLinkEmail(email, magicLink, magicCode) {
  const subject = "Login to Roku Feed";
  if (useDevEmail()) {
    logDevEmail({
      to: email,
      subject,
      link: magicLink,
      code: magicCode,
      note: "Link and code expire in 15 minutes"
    });
    return;
  }
  const html = wrapHtml(
    "Login to your account",
    `<p style="color:#4b5563;">Click the button below or enter this code in the app:</p>
    <div style="margin:24px 0;text-align:center;font-size:32px;font-weight:700;letter-spacing:8px;color:#111827;">${magicCode}</div>
    <div style="text-align:center;margin:28px 0;">
      <a href="${magicLink}" style="display:inline-block;background:#0f172a;color:white;padding:12px 24px;text-decoration:none;border-radius:8px;font-weight:600;">Log in</a>
    </div>
    <p style="color:#6b7280;font-size:14px;">This link and code expire in 15 minutes.</p>
    <p style="color:#9ca3af;font-size:12px;">If you did not request this, you can ignore this email.</p>`
  );
  const result = await sendViaResend({
    to: email,
    subject,
    html,
    text: `Login to Roku Feed\n\nYour code: ${magicCode}\n\nOr use this link:\n${magicLink}\n\nBoth expire in 15 minutes.`
  });
  if (!result.ok) {
    logDevEmail({ to: email, subject, link: magicLink, code: magicCode });
  }
}

async function sendVerificationEmail(email, verificationLink) {
  const subject = "Verify your Roku Feed email";
  if (useDevEmail()) {
    logDevEmail({
      to: email,
      subject,
      link: verificationLink,
      note: "Expires in 24 hours"
    });
    return;
  }
  const html = wrapHtml(
    "Verify your email",
    `<p style="color:#4b5563;">Confirm your email address to finish setting up your account:</p>
    <div style="text-align:center;margin:28px 0;">
      <a href="${verificationLink}" style="display:inline-block;background:#0f172a;color:white;padding:12px 24px;text-decoration:none;border-radius:8px;font-weight:600;">Verify email</a>
    </div>
    <p style="color:#6b7280;font-size:14px;">This link expires in 24 hours.</p>`
  );
  const result = await sendViaResend({
    to: email,
    subject,
    html,
    text: `Verify your Roku Feed email\n\n${verificationLink}\n\nExpires in 24 hours.`
  });
  if (!result.ok) {
    logDevEmail({ to: email, subject, link: verificationLink });
  }
}

async function sendPasswordResetEmail(email, resetLink) {
  const subject = "Reset your Roku Feed password";
  if (useDevEmail()) {
    logDevEmail({
      to: email,
      subject,
      link: resetLink,
      note: "Expires in 1 hour"
    });
    return;
  }
  const html = wrapHtml(
    "Reset your password",
    `<p style="color:#4b5563;">Click below to choose a new password:</p>
    <div style="text-align:center;margin:28px 0;">
      <a href="${resetLink}" style="display:inline-block;background:#0f172a;color:white;padding:12px 24px;text-decoration:none;border-radius:8px;font-weight:600;">Reset password</a>
    </div>
    <p style="color:#6b7280;font-size:14px;">This link expires in 1 hour.</p>
    <p style="color:#9ca3af;font-size:12px;">If you did not request this, you can ignore this email.</p>`
  );
  const result = await sendViaResend({
    to: email,
    subject,
    html,
    text: `Reset your Roku Feed password\n\n${resetLink}\n\nExpires in 1 hour.`
  });
  if (!result.ok) {
    logDevEmail({ to: email, subject, link: resetLink });
  }
}

module.exports = {
  sendMagicLinkEmail,
  sendVerificationEmail,
  sendPasswordResetEmail
};
