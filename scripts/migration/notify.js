#!/usr/bin/env node
/**
 * mig_07_notify_logged.js  — PHASE C (replaces mig_05)
 *
 * Same job — email every migrated user a one-time sign-in link — but routed
 * through the app's own `sendAndLog`, so every send lands in the
 * Communications log: searchable, previewable, and retryable from the admin
 * panel using the machinery already built in Phase 9.
 *
 * ⚠️  RUN THIS FROM INSIDE THE BACKEND REPO so it can import the real
 *     sendAndLog. Do NOT copy sendAndLog's logic into this file — a second
 *     implementation is how the two drift apart.
 *
 *     backend-repo/
 *       scripts/migration/notify.js   ← put this file here
 *
 *     cd backend-repo
 *     node scripts/migration/notify.js --dry-run
 *     node scripts/migration/notify.js --apply --role=TEACHER --limit=2
 *     node scripts/migration/notify.js --apply
 *
 * Env: the backend's own .env is enough (DATABASE_URL/DIRECT_URL,
 * RESEND_API_KEY, CLERK_SECRET_KEY — which must now be the sk_live key).
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import { createClerkClient } from "@clerk/backend";
import { prisma } from "../../src/lib/prisma.js";
import { sendAndLog } from "../../src/services/email.js";

const APPLY = process.argv.includes("--apply");
const roleArg = process.argv.find((a) => a.startsWith("--role="));
const ONLY_ROLE = roleArg ? roleArg.split("=")[1] : null;
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const LIMIT = limitArg ? parseInt(limitArg.split("=")[1], 10) : Infinity;

// Single-use, and long enough that nobody is stranded over a weekend.
const TTL_SECONDS = 7 * 24 * 60 * 60;
const THROTTLE_MS = 600;
const PROGRESS = path.join(process.cwd(), "notify-progress.json");

// Set to 'MIGRATION_NOTICE' after running the enum SQL in mig_09.
// 'OTHER' works today with no migration.
const COMM_TYPE = "MIGRATION_NOTICE";

const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildHtml({ name, url }) {
  const greeting = name ? `Assalamu alaikum ${name},` : "Assalamu alaikum,";
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/><title>Set a new password</title></head>
<body style="margin:0;padding:0;background:#f7f9fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<div style="max-width:560px;margin:0 auto;padding:32px 16px;">
  <div style="background:#0d2840;border-radius:16px 16px 0 0;padding:28px 32px;">
    <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:#28b7d9;margin-bottom:6px;">Quran Odyssey</div>
    <div style="font-size:22px;font-weight:800;color:#ffffff;">Please set a new password</div>
  </div>
  <div style="background:#ffffff;border-radius:0 0 16px 16px;padding:32px;border:1px solid #e2e8f0;border-top:none;">
    <p style="font-size:15px;color:#0f172a;margin:0 0 16px;">${greeting}</p>
    <p style="font-size:14px;color:#334155;line-height:1.7;margin:0 0 24px;">
      We've upgraded the security of the Quran Odyssey platform. Everything about your
      account is unchanged — your classes, your teacher and your children's progress are
      exactly as they were. The one thing we need you to do is set a new password.
    </p>
    <div style="text-align:center;margin-bottom:24px;">
      <a href="${url}" style="display:inline-block;background:#28b7d9;color:#ffffff;text-decoration:none;font-size:15px;font-weight:800;padding:14px 32px;border-radius:10px;">Set my new password</a>
    </div>
    <p style="font-size:14px;color:#334155;line-height:1.7;margin:0 0 16px;">
      The button signs you straight in — you won't need your old password. Once inside, you can sign out whenever you would like and reset your password using "Forgot password?".
    </p>
    <div style="background:#fff8e7;border-radius:10px;padding:16px 18px;border-left:4px solid #faa71a;">
      <div style="font-size:13px;color:#92400e;line-height:1.6;">
        This link works once and expires in 7 days. Please don't forward it — it signs in whoever clicks it.
      </div>
    </div>
    <p style="font-size:12px;color:#94a3b8;margin-top:20px;border-top:1px solid #e2e8f0;padding-top:16px;">
      Any trouble? Contact us and we'll help you straight away.
    </p>
  </div>
</div></body></html>`;
}

const loadProgress = () =>
  fs.existsSync(PROGRESS) ? JSON.parse(fs.readFileSync(PROGRESS, "utf8")) : { sent: {} };
const saveProgress = (p) => fs.writeFileSync(PROGRESS, JSON.stringify(p, null, 2));

(async () => {
  console.log(`\n=== PHASE C — notify (logged) ===  ${APPLY ? "APPLY" : "DRY RUN"}\n`);

  const progress = loadProgress();
  const users = await prisma.user.findMany({
    where: ONLY_ROLE ? { role: ONLY_ROLE } : {},
    select: { id: true, email: true, name: true, clerkId: true, role: true },
    orderBy: { createdAt: "asc" },
  });
  console.log(`Targets: ${users.length}${ONLY_ROLE ? ` (role=${ONLY_ROLE})` : ""}\n`);

  let sent = 0, failed = 0, skipped = 0;

  for (const u of users) {
    if (sent >= LIMIT) break;
    if (progress.sent[u.email]) { skipped++; continue; }

    if (!APPLY) {
      console.log(`  would email  ${u.email.padEnd(38)} ${u.role}`);
      sent++;
      continue;
    }

    try {
      const token = await clerk.signInTokens.createSignInToken({
        userId: u.clerkId,
        expiresInSeconds: TTL_SECONDS,
      });
      if (!token?.url) throw new Error("Clerk returned no sign-in URL");

      // THE choke point — same function every other email in the app uses.
      // Writes exactly one CommunicationLog row, success or failure.
      const result = await sendAndLog({
        type: COMM_TYPE,
        to: u.email,
        subject: "MIGRATION NOTICE! Action needed: set a new password for Quran Odyssey",
        html: buildHtml({ name: u.name, url: token.url }),
        from: "Quran Odyssey <info@quranodyssey.com>",
        relatedType: "User",
        relatedId: u.id,
      });

      if (result.success) {
        progress.sent[u.email] = { at: new Date().toISOString(), logId: result.logId };
        saveProgress(progress);
        sent++;
        console.log(`  ✓ emailed    ${u.email.padEnd(38)} log=${result.logId}`);
      } else {
        // Deliberately NOT recorded as sent — a failure must stay retryable,
        // both here and via the Communications tab.
        failed++;
        console.error(`  ✗ FAILED     ${u.email.padEnd(38)} ${result.failureReason}`);
      }
    } catch (err) {
      failed++;
      console.error(`  ✗ FAILED     ${u.email.padEnd(38)} ${err.message}`);
    }
    await sleep(THROTTLE_MS);
  }

  console.log(`\n--- summary ---`);
  console.log(`  emailed : ${sent}`);
  console.log(`  skipped : ${skipped} (already sent on a previous run)`);
  console.log(`  failed  : ${failed}`);
  console.log(`\nEvery attempt is in Admin → Communications (failures listed first).`);
  console.log(`Re-running retries only the failures.\n`);
  await prisma.$disconnect();
})();