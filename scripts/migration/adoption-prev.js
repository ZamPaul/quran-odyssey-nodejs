#!/usr/bin/env node
/**
 * mig_08_adoption_report.js  — the metric that actually matters
 *
 * "Email sent" is not success. Success is a family back inside their account.
 * This cross-references three sources and tells you exactly who is still
 * locked out, so you can chase them individually instead of guessing.
 *
 *   node scripts/migration/adoption.js
 *   node scripts/migration/adoption.js --csv > adoption.csv
 *
 * Run it daily for a week after phase C. Send the summary to your PM.
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import { createClerkClient } from "@clerk/backend";
import { prisma } from "../../src/lib/prisma.js";

const CSV = process.argv.includes("--csv");
const PROGRESS = path.join(process.cwd(), "notify-progress.json");
const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
const rows = (r) => (Array.isArray(r) ? r : r?.data || []);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (d) => (d ? new Date(d).toLocaleString("en-GB") : "—");

(async () => {
  // 1. Everyone who should be back in
  const users = await prisma.user.findMany({
    select: { id: true, email: true, name: true, clerkId: true, role: true },
    orderBy: { createdAt: "asc" },
  });

  // 2. Who we emailed (local progress file)
  const progress = fs.existsSync(PROGRESS)
    ? JSON.parse(fs.readFileSync(PROGRESS, "utf8")).sent || {}
    : {};

  // 3. What the comms log says — the durable record
  let logByEmail = new Map();
  try {
    const logs = await prisma.communicationLog.findMany({
      where: { subject: { contains: "set a new password", mode: "insensitive" } },
      orderBy: { createdAt: "desc" },
      select: { toAddress: true, status: true, failureReason: true, createdAt: true, resolvedAt: true },
    });
    for (const l of logs) {
      const key = l.toAddress.toLowerCase();
      if (!logByEmail.has(key)) logByEmail.set(key, l); // most recent wins
    }
  } catch { /* comms log not deployed — fall back to the progress file */ }

  // 4. Who has actually signed in (Clerk is the source of truth)
  const clerkUsers = [];
  let offset = 0;
  for (;;) {
    const batch = rows(await clerk.users.getUserList({ limit: 100, offset }));
    clerkUsers.push(...batch);
    if (batch.length < 100) break;
    offset += 100;
    await sleep(200);
  }
  const clerkById = new Map(clerkUsers.map((u) => [u.id, u]));

  const report = users.map((u) => {
    const cu = clerkById.get(u.clerkId);
    const log = logByEmail.get(u.email.toLowerCase());
    const emailed = !!progress[u.email] || !!log;
    const emailStatus = log ? log.status : (progress[u.email] ? "SENT" : "NOT SENT");
    const lastSignIn = cu?.lastSignInAt || null;
    // Signed in since the notice went out = they're genuinely back.
    const noticeAt = log?.createdAt || (progress[u.email]?.at ? new Date(progress[u.email].at) : null);
    const backIn = !!(lastSignIn && noticeAt && new Date(lastSignIn) >= new Date(noticeAt));

    return {
      email: u.email,
      name: u.name || "",
      role: u.role,
      emailed,
      emailStatus,
      failureReason: log?.failureReason || "",
      lastSignIn,
      backIn,
      state: !emailed ? "NOT EMAILED"
        : emailStatus === "FAILED" ? "EMAIL FAILED"
        : backIn ? "BACK IN"
        : "AWAITING",
    };
  });

  if (CSV) {
    console.log("email,name,role,state,emailStatus,failureReason,lastSignIn");
    for (const r of report) {
      console.log([r.email, r.name, r.role, r.state, r.emailStatus, r.failureReason, fmt(r.lastSignIn)]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","));
    }
    await prisma.$disconnect();
    return;
  }

  const by = (s) => report.filter((r) => r.state === s);
  const backIn = by("BACK IN"), awaiting = by("AWAITING"),
        failedEmail = by("EMAIL FAILED"), notEmailed = by("NOT EMAILED");

  console.log(`\n═══ MIGRATION ADOPTION ═══\n`);
  console.log(`  Total accounts   : ${report.length}`);
  console.log(`  ✅ Back in       : ${backIn.length}  (${Math.round(100 * backIn.length / report.length)}%)`);
  console.log(`  ⏳ Awaiting      : ${awaiting.length}  — emailed, not yet signed in`);
  console.log(`  ❌ Email failed  : ${failedEmail.length}  — never reached them`);
  console.log(`  ⚠️  Not emailed   : ${notEmailed.length}`);

  if (failedEmail.length) {
    console.log(`\n── EMAIL FAILED — these people cannot get back in ──`);
    failedEmail.forEach((r) => console.log(`   ${r.email.padEnd(38)} ${r.failureReason}`));
    console.log(`   → Retry from Admin → Communications, or fix the address first.`);
  }
  if (notEmailed.length) {
    console.log(`\n── NEVER EMAILED ──`);
    notEmailed.forEach((r) => console.log(`   ${r.email.padEnd(38)} ${r.role}`));
  }
  if (awaiting.length) {
    console.log(`\n── AWAITING (${awaiting.length}) ──`);
    awaiting.slice(0, 25).forEach((r) => console.log(`   ${r.email.padEnd(38)} last seen ${fmt(r.lastSignIn)}`));
    if (awaiting.length > 25) console.log(`   …and ${awaiting.length - 25} more (use --csv)`);
  }

  console.log(`\nLinks expire 7 days after sending — anyone still AWAITING by then`);
  console.log(`needs a fresh one (Admin → their page → Sign-in help).\n`);
  await prisma.$disconnect();
})();