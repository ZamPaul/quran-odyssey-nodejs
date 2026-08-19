#!/usr/bin/env node
/**
 * mig_08b_adoption_report.js  — REPLACES mig_08
 *
 * Cross-references the database, the Communications log, the notify progress
 * file and Clerk's lastSignInAt to answer the only question that matters:
 * how many families are actually back inside their accounts?
 *
 * Read-only. Writes nothing to the database or to Clerk.
 *
 *   node scripts/migration/adoption.js                 # terminal summary only
 *   node scripts/migration/adoption.js --report        # + HTML, CSV, JSON files
 *   node scripts/migration/adoption.js --report --out=./reports
 *
 * With --report it writes into ./migration-reports/ (or --out):
 *   adoption-YYYY-MM-DD.html   ← the one you send your PM
 *   adoption-YYYY-MM-DD.csv    ← for filtering in Excel
 *   adoption-YYYY-MM-DD.json   ← machine-readable snapshot, for day-over-day
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import { createClerkClient } from "@clerk/backend";
import { prisma } from "../../src/lib/prisma.js";

// ── Guards: fail with a sentence, not a stack trace ───────
if (!process.env.CLERK_SECRET_KEY) {
  console.error("❌ CLERK_SECRET_KEY is not set. Run from the server root so .env is picked up.");
  process.exit(1);
}
if (!process.env.CLERK_SECRET_KEY.startsWith("sk_live")) {
  console.warn("⚠️  Key is not sk_live — you may be querying the DEV instance.\n");
}

const WRITE = process.argv.includes("--report") || process.argv.includes("--csv");
const outArg = process.argv.find((a) => a.startsWith("--out="));
const OUT_DIR = outArg ? outArg.split("=")[1] : path.join(process.cwd(), "migration-reports");
const PROGRESS = path.join(process.cwd(), "notify-progress.json");

const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
const rows = (r) => (Array.isArray(r) ? r : r?.data || []);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Retry: one dropped request must not kill the whole report ──
async function withRetry(fn, label, attempts = 4) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try { return await fn(); }
    catch (err) {
      lastErr = err;
      const networkish = err?.errors?.[0]?.message === "fetch failed" || !err?.status;
      if (!networkish || i === attempts) throw err;
      const wait = 1000 * 2 ** (i - 1);
      console.warn(`  ⚠️  ${label} failed (${i}/${attempts}) — retrying in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtDate = (d) => (d ? new Date(d).toLocaleString("en-GB", {
  day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
}) : "—");
const daysAgo = (d) => (d ? Math.floor((Date.now() - new Date(d)) / 86400000) : null);

const STATE_META = {
  "BACK IN":     { label: "Back in",      color: "#15803d", bg: "rgba(34,197,94,0.10)" },
  "AWAITING":    { label: "Awaiting",     color: "#b45309", bg: "rgba(250,167,26,0.14)" },
  "EMAIL FAILED":{ label: "Email failed", color: "#dc2626", bg: "rgba(239,68,68,0.10)" },
  "NOT EMAILED": { label: "Not emailed",  color: "#64748b", bg: "#f1f5f9" },
};

(async () => {
  // 1. Everyone who should be back
  const users = await prisma.user.findMany({
    select: {
      id: true, email: true, name: true, clerkId: true, role: true,
      _count: { select: { managedStudents: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  // 2. Who we emailed (local progress file)
  const progress = fs.existsSync(PROGRESS)
    ? JSON.parse(fs.readFileSync(PROGRESS, "utf8")).sent || {}
    : {};

  // 3. What the comms log says (durable record)
  const logByEmail = new Map();
  let commsAvailable = true;
  try {
    const logs = await prisma.communicationLog.findMany({
      where: { subject: { contains: "password", mode: "insensitive" } },
      orderBy: { createdAt: "desc" },
      select: { toAddress: true, status: true, failureReason: true, createdAt: true },
    });
    for (const l of logs) {
      const k = l.toAddress.toLowerCase();
      if (!logByEmail.has(k)) logByEmail.set(k, l);   // most recent wins
    }
  } catch { commsAvailable = false; }

  // 4. Who has actually signed in (Clerk = source of truth)
  const clerkUsers = [];
  let offset = 0;
  for (;;) {
    const batch = rows(await withRetry(
      () => clerk.users.getUserList({ limit: 100, offset }),
      `getUserList offset=${offset}`,
    ));
    clerkUsers.push(...batch);
    if (batch.length < 100) break;
    offset += 100;
    await sleep(200);
  }
  const clerkById = new Map(clerkUsers.map((u) => [u.id, u]));

  // ── Classify ────────────────────────────────────────────
  const report = users.map((u) => {
    const cu = clerkById.get(u.clerkId);
    const log = logByEmail.get(u.email.toLowerCase());
    const prog = progress[u.email];
    const emailed = !!prog || !!log;
    const emailStatus = log ? log.status : (prog ? "SENT" : "NOT SENT");
    const lastSignIn = cu?.lastSignInAt || null;
    const noticeAt = log?.createdAt || (prog?.at ? new Date(prog.at) : null);
    const backIn = !!(lastSignIn && noticeAt && new Date(lastSignIn) >= new Date(noticeAt));

    return {
      email: u.email,
      name: u.name || "",
      role: u.role,
      learners: u._count.managedStudents,
      emailed,
      emailStatus,
      failureReason: log?.failureReason || "",
      noticeAt: noticeAt ? new Date(noticeAt).toISOString() : null,
      lastSignIn: lastSignIn ? new Date(lastSignIn).toISOString() : null,
      daysSinceNotice: daysAgo(noticeAt),
      backIn,
      state: !emailed ? "NOT EMAILED"
        : emailStatus === "FAILED" ? "EMAIL FAILED"
        : backIn ? "BACK IN" : "AWAITING",
    };
  });

  const by = (s) => report.filter((r) => r.state === s);
  const backIn = by("BACK IN"), awaiting = by("AWAITING"),
        failed = by("EMAIL FAILED"), notEmailed = by("NOT EMAILED");
  const pct = (n) => (report.length ? Math.round((n / report.length) * 100) : 0);

  // Links expire after 7 days — anyone past that needs a fresh one.
  const expired = awaiting.filter((r) => r.daysSinceNotice != null && r.daysSinceNotice >= 7);

  const summary = {
    generatedAt: new Date().toISOString(),
    total: report.length,
    backIn: backIn.length,
    awaiting: awaiting.length,
    emailFailed: failed.length,
    notEmailed: notEmailed.length,
    backInPct: pct(backIn.length),
    needsAction: failed.length + notEmailed.length + expired.length,
    expiredLinks: expired.length,
    commsAvailable,
  };

  // ── Terminal ────────────────────────────────────────────
  console.log(`\n═══ MIGRATION ADOPTION ═══\n`);
  console.log(`  Total accounts   : ${summary.total}`);
  console.log(`  ✅ Back in       : ${summary.backIn}  (${summary.backInPct}%)`);
  console.log(`  ⏳ Awaiting      : ${summary.awaiting}`);
  console.log(`  ❌ Email failed  : ${summary.emailFailed}`);
  console.log(`  ⚠️  Not emailed   : ${summary.notEmailed}`);
  if (expired.length) console.log(`  ⏰ Expired links : ${expired.length}  (7+ days — need a fresh link)`);
  if (!commsAvailable) console.log(`\n  (Communications log unavailable — using the progress file only)`);

  if (failed.length) {
    console.log(`\n── EMAIL FAILED — cannot get back in ──`);
    failed.forEach((r) => console.log(`   ${r.email.padEnd(38)} ${r.failureReason}`));
  }
  if (notEmailed.length) {
    console.log(`\n── NEVER EMAILED ──`);
    notEmailed.forEach((r) => console.log(`   ${r.email.padEnd(38)} ${r.role}`));
  }

  if (!WRITE) {
    console.log(`\nRun with --report to write HTML / CSV / JSON files.\n`);
    await prisma.$disconnect();
    return;
  }

  // ── Write the files ─────────────────────────────────────
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 10);
  const base = path.join(OUT_DIR, `adoption-${stamp}`);

  // JSON snapshot — day-over-day tracking
  fs.writeFileSync(`${base}.json`, JSON.stringify({ summary, users: report }, null, 2));

  // CSV — for Excel filtering
  const csvRow = (a) => a.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",");
  const csv = [
    csvRow(["Email","Name","Role","Learners","Status","Email status","Failure reason","Notice sent","Last sign-in","Days since notice"]),
    ...report.map((r) => csvRow([
      r.email, r.name, r.role, r.learners, STATE_META[r.state].label,
      r.emailStatus, r.failureReason, fmtDate(r.noticeAt), fmtDate(r.lastSignIn),
      r.daysSinceNotice ?? "",
    ])),
  ].join("\n");
  fs.writeFileSync(`${base}.csv`, "\uFEFF" + csv);   // BOM so Excel reads UTF-8

  // HTML — the presentable one
  const card = (n, label, color, sub) => `
    <div style="flex:1;min-width:150px;background:#fff;border:1px solid #e2e8f0;border-radius:14px;border-left:4px solid ${color};padding:18px 20px;">
      <div style="font-size:34px;font-weight:800;color:${color};line-height:1;">${n}</div>
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#94a3b8;margin-top:8px;">${label}</div>
      ${sub ? `<div style="font-size:12px;color:#64748b;margin-top:4px;">${sub}</div>` : ""}
    </div>`;

  const section = (title, list, note) => {
    if (!list.length) return "";
    return `
    <h2 style="font-size:16px;font-weight:800;color:#0d2840;margin:32px 0 4px;">${esc(title)} <span style="color:#94a3b8;font-weight:600;">(${list.length})</span></h2>
    ${note ? `<p style="font-size:13px;color:#64748b;margin:0 0 12px;">${esc(note)}</p>` : ""}
    <table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #e2e8f0;border-radius:12px;overflow:hidden;font-size:13px;">
      <thead><tr style="background:#f7f9fb;">
        <th style="text-align:left;padding:10px 14px;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:#94a3b8;">Account</th>
        <th style="text-align:left;padding:10px 14px;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:#94a3b8;">Role</th>
        <th style="text-align:left;padding:10px 14px;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:#94a3b8;">Notice sent</th>
        <th style="text-align:left;padding:10px 14px;font-size:11px;text-transform:uppercase;letter-spacing:0.04em;color:#94a3b8;">Detail</th>
      </tr></thead>
      <tbody>${list.map((r) => `
        <tr style="border-top:1px solid #f1f5f9;">
          <td style="padding:10px 14px;"><strong style="color:#0f172a;">${esc(r.name || r.email.split("@")[0])}</strong><br/><span style="color:#94a3b8;font-size:12px;">${esc(r.email)}</span></td>
          <td style="padding:10px 14px;color:#64748b;">${esc(r.role)}${r.learners ? ` · ${r.learners} learner${r.learners === 1 ? "" : "s"}` : ""}</td>
          <td style="padding:10px 14px;color:#64748b;">${esc(fmtDate(r.noticeAt))}</td>
          <td style="padding:10px 14px;color:#64748b;">${esc(r.failureReason || (r.lastSignIn ? `last seen ${fmtDate(r.lastSignIn)}` : "not signed in yet"))}</td>
        </tr>`).join("")}</tbody>
    </table>`;
  };

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Migration adoption report — ${stamp}</title></head>
<body style="margin:0;padding:0;background:#f7f9fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#0f172a;">
<div style="max-width:900px;margin:0 auto;padding:32px 20px 60px;">

  <div style="background:#0d2840;border-radius:16px;padding:26px 30px;margin-bottom:24px;">
    <div style="font-size:12px;font-weight:700;letter-spacing:0.8px;color:#28b7d9;margin-bottom:6px;">QURAN ODYSSEY</div>
    <div style="font-size:24px;font-weight:800;color:#fff;">Migration adoption report</div>
    <div style="font-size:13px;color:rgba(255,255,255,0.6);margin-top:6px;">Generated ${esc(fmtDate(summary.generatedAt))}</div>
  </div>

  <div style="background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:20px 24px;margin-bottom:20px;">
    <div style="font-size:15px;line-height:1.7;color:#334155;">
      <strong>${summary.backIn} of ${summary.total} accounts (${summary.backInPct}%)</strong> have signed in since the
      migration notice was sent.
      ${summary.needsAction
        ? `<span style="color:#b45309;"><strong>${summary.needsAction}</strong> need attention</span> — listed below.`
        : `<span style="color:#15803d;">No outstanding actions.</span>`}
    </div>
  </div>

  <div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:8px;">
    ${card(summary.backIn, "Back in", "#15803d", `${summary.backInPct}% of accounts`)}
    ${card(summary.awaiting, "Awaiting", "#b45309", "emailed, not signed in")}
    ${card(summary.emailFailed, "Email failed", "#dc2626", "never reached them")}
    ${card(summary.notEmailed, "Not emailed", "#64748b", "no notice sent")}
  </div>

  <div style="background:#fff;border:1px solid #e2e8f0;border-radius:14px;padding:20px 24px;margin-top:20px;">
    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#94a3b8;margin-bottom:10px;">Progress</div>
    <div style="display:flex;height:26px;border-radius:8px;overflow:hidden;background:#f1f5f9;">
      ${[["backIn","#22c55e"],["awaiting","#faa71a"],["emailFailed","#ef4444"],["notEmailed","#cbd5e1"]]
        .map(([k, c]) => summary[k] ? `<div title="${k}: ${summary[k]}" style="width:${(summary[k]/summary.total)*100}%;background:${c};"></div>` : "").join("")}
    </div>
    <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:10px;font-size:12px;color:#64748b;">
      ${Object.entries(STATE_META).map(([k, m]) =>
        `<span><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${m.color};margin-right:5px;"></span>${m.label}</span>`).join("")}
    </div>
  </div>

  ${section("Email failed — action required", failed,
    "These people never received the notice and cannot get back in. Retry from Admin → Communications, or check the address is correct.")}
  ${section("Never emailed — action required", notEmailed,
    "No migration notice was sent to these accounts.")}
  ${section("Links expired — action required", expired,
    "Sign-in links expire after 7 days. Send a fresh one from the admin panel: their page → Sign-in help.")}
  ${section("Awaiting sign-in", awaiting.filter((r) => !expired.includes(r)),
    "Emailed successfully and the link is still valid. No action needed yet.")}
  ${section("Back in", backIn, "Signed in successfully since the notice was sent.")}

  <p style="font-size:12px;color:#94a3b8;margin-top:36px;border-top:1px solid #e2e8f0;padding-top:16px;line-height:1.7;">
    "Back in" means the account has signed in at some point after its migration notice was sent.
    Sign-in links are single-use and expire after 7 days.
    ${commsAvailable ? "" : "Communications log was unavailable; email status is based on the local progress file only. "}
    Note: an email recorded as sent may still have landed in a spam folder — delivery to a mail server is not the same as inbox placement.
  </p>
</div></body></html>`;

  fs.writeFileSync(`${base}.html`, html);

  console.log(`\n📄 Report written:`);
  console.log(`   ${base}.html   ← open this / send to your PM`);
  console.log(`   ${base}.csv`);
  console.log(`   ${base}.json\n`);

  await prisma.$disconnect();
})();