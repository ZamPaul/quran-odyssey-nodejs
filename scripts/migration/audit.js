#!/usr/bin/env node
/**
 * mig_13_clerk_audit.js  — diagnose "I can't log in" after the migration
 *
 * READ-ONLY. Touches nothing. Compares every Clerk user against every
 * database row, matched on EMAIL, and reports exactly what is wrong per
 * person plus the SQL to fix it.
 *
 * Checks, in order of how badly they break login:
 *   1. clerkId mismatch          → 401 on every request
 *   2. DB row with no Clerk user → cannot authenticate at all
 *   3. Clerk user with no DB row → signs in, then 401 "user not found"
 *   4. Duplicate clerkId in DB   → identity crossover (two families, one login)
 *   5. Missing publicMetadata.role → authenticates, then misrouted
 *   6. Role disagreement          → lands on the wrong dashboard
 *
 * Run from the server root so .env is picked up:
 *   node scripts/migration/audit.js
 *   node scripts/migration/audit.js --email=someone@example.com   # one person
 */

import "dotenv/config";
import { createClerkClient } from "@clerk/backend";
import { prisma } from "../../src/lib/prisma.js";

const KEY = process.env.CLERK_SECRET_KEY;
if (!KEY) {
  console.error("❌ CLERK_SECRET_KEY is not set. Run from the server root.");
  process.exit(1);
}
if (!KEY.startsWith("sk_live")) {
  console.warn("⚠️  Key is not sk_live — you may be auditing the DEV instance.\n");
}

const emailArg = process.argv.find((a) => a.startsWith("--email="));
const ONLY = emailArg ? emailArg.split("=")[1].toLowerCase() : null;

const clerk = createClerkClient({ secretKey: KEY });
const rows = (r) => (Array.isArray(r) ? r : r?.data || []);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, label, attempts = 4) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try { return await fn(); }
    catch (err) {
      last = err;
      const networkish = err?.errors?.[0]?.message === "fetch failed" || !err?.status;
      if (!networkish || i === attempts) throw err;
      const wait = 1000 * 2 ** (i - 1);
      console.warn(`  ⚠️  ${label} failed (${i}/${attempts}) — retrying in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
  throw last;
}

function primaryEmail(u) {
  const p = u.emailAddresses?.find((e) => e.id === u.primaryEmailAddressId);
  return (p || u.emailAddresses?.[0])?.emailAddress || null;
}

const pad = (s, n) => String(s ?? "").padEnd(n);
const short = (id) => (id ? `${id.slice(0, 12)}…${id.slice(-4)}` : "(none)");
const line = (ch = "─", n = 78) => ch.repeat(n);

(async () => {
  console.log("\nFetching Clerk users…");
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

  const dbUsers = await prisma.user.findMany({
    select: { id: true, email: true, name: true, clerkId: true, role: true, status: true },
    orderBy: { createdAt: "asc" },
  });

  console.log(`  Clerk : ${clerkUsers.length} users`);
  console.log(`  DB    : ${dbUsers.length} users\n`);

  // Index both sides by lowercase email
  const clerkByEmail = new Map();
  const clerkDupeEmails = [];
  for (const u of clerkUsers) {
    const e = primaryEmail(u);
    if (!e) continue;
    const k = e.toLowerCase();
    if (clerkByEmail.has(k)) clerkDupeEmails.push(e);
    else clerkByEmail.set(k, u);
  }
  const clerkById = new Map(clerkUsers.map((u) => [u.id, u]));

  // Buckets
  const ok = [], mismatch = [], noClerkUser = [], noDbRow = [], roleMissing = [], roleDiff = [];

  for (const d of dbUsers) {
    const k = d.email.toLowerCase();
    if (ONLY && k !== ONLY) continue;

    const byEmail = clerkByEmail.get(k);
    const byId = clerkById.get(d.clerkId);

    if (!byEmail) {
      // No Clerk account with this email at all.
      noClerkUser.push({ ...d, alsoOrphanId: !byId });
      continue;
    }

    if (byEmail.id !== d.clerkId) {
      mismatch.push({
        ...d,
        correctClerkId: byEmail.id,
        currentPointsToRealUser: !!byId,
        currentPointsToEmail: byId ? primaryEmail(byId) : null,
      });
      continue;
    }

    // IDs agree — now check the role claim the frontend routes on.
    const claim = byEmail.publicMetadata?.role;
    if (!claim) roleMissing.push({ ...d });
    else if (claim !== d.role) roleDiff.push({ ...d, clerkRole: claim });
    else ok.push(d);
  }

  // Clerk users with no DB row
  const dbEmails = new Set(dbUsers.map((u) => u.email.toLowerCase()));
  for (const u of clerkUsers) {
    const e = primaryEmail(u);
    if (!e) { noDbRow.push({ email: "(no email)", clerkId: u.id }); continue; }
    if (ONLY && e.toLowerCase() !== ONLY) continue;
    if (!dbEmails.has(e.toLowerCase())) noDbRow.push({ email: e, clerkId: u.id, role: u.publicMetadata?.role || null });
  }

  // Duplicate clerkIds across DB rows — the dangerous one
  const idCount = new Map();
  for (const d of dbUsers) {
    if (!d.clerkId) continue;
    idCount.set(d.clerkId, (idCount.get(d.clerkId) || 0) + 1);
  }
  const dupeIds = [...idCount.entries()].filter(([, n]) => n > 1);

  // ── Report ──────────────────────────────────────────────
  console.log(line("═"));
  console.log("  CLERK ↔ DATABASE AUDIT");
  console.log(line("═"));
  console.log(`  ✅ Correct              : ${ok.length}`);
  console.log(`  ❌ clerkId mismatch     : ${mismatch.length}`);
  console.log(`  ❌ No Clerk account     : ${noClerkUser.length}`);
  console.log(`  ⚠️  No database row      : ${noDbRow.length}`);
  console.log(`  🚨 Duplicate clerkId    : ${dupeIds.length}`);
  console.log(`  ⚠️  Missing role claim   : ${roleMissing.length}`);
  console.log(`  ⚠️  Role disagreement    : ${roleDiff.length}`);
  if (clerkDupeEmails.length) {
    console.log(`  ⚠️  Duplicate emails in Clerk: ${clerkDupeEmails.length}`);
  }

  // 1. MISMATCH — the thing you suspected
  if (mismatch.length) {
    console.log(`\n${line()}`);
    console.log("  ❌ CLERKID MISMATCH — these people cannot log in");
    console.log(line());
    for (const m of mismatch) {
      console.log(`\n  ${m.email}   (${m.role}${m.name ? ` · ${m.name}` : ""})`);
      console.log(`     DB has     : ${m.clerkId}`);
      console.log(`     Should be  : ${m.correctClerkId}`);
      if (m.currentPointsToRealUser) {
        console.log(`     🚨 The stored ID belongs to a REAL Clerk user: ${m.currentPointsToEmail}`);
        console.log(`        That is an identity crossover — fix this one first.`);
      } else {
        console.log(`     (stored ID does not exist in Clerk — a stale dev-instance ID)`);
      }
    }
    console.log(`\n  ── SQL to fix all ${mismatch.length} ──\n`);
    for (const m of mismatch) {
      console.log(`  UPDATE users SET "clerkId" = '${m.correctClerkId}' WHERE email = '${m.email}';`);
    }
    console.log(`\n  Run them together, then re-run this audit to confirm.`);
  }

  // 2. NO CLERK ACCOUNT
  if (noClerkUser.length) {
    console.log(`\n${line()}`);
    console.log("  ❌ NO CLERK ACCOUNT — no login exists for this email");
    console.log(line());
    for (const n of noClerkUser) {
      console.log(`  ${pad(n.email, 40)} ${pad(n.role, 9)} DB clerkId: ${short(n.clerkId)}`);
    }
    console.log(`\n  Fix: create the account in the Clerk dashboard (set publicMetadata.role),`);
    console.log(`  or re-run the migration script for these emails. Then re-run this audit.`);
  }

  // 3. NO DB ROW
  if (noDbRow.length) {
    console.log(`\n${line()}`);
    console.log("  ⚠️  NO DATABASE ROW — can sign in, then gets 401");
    console.log(line());
    for (const n of noDbRow) {
      console.log(`  ${pad(n.email, 40)} ${pad(n.role || "(no role)", 12)} ${short(n.clerkId)}`);
    }
    console.log(`\n  Usually harmless leftovers (test accounts). Only a problem if a real`);
    console.log(`  family is listed — they would authenticate and then be rejected.`);
  }

  // 4. DUPLICATE CLERKID
  if (dupeIds.length) {
    console.log(`\n${line()}`);
    console.log("  🚨 DUPLICATE CLERKID — two database rows share one login");
    console.log(line());
    for (const [id, n] of dupeIds) {
      const owners = dbUsers.filter((d) => d.clerkId === id);
      const cu = clerkById.get(id);
      console.log(`\n  ${id}  (${n} rows)  → Clerk: ${cu ? primaryEmail(cu) : "does not exist"}`);
      for (const o of owners) console.log(`     - ${pad(o.email, 40)} ${o.role}`);
    }
    console.log(`\n  🚨 FIX THIS FIRST. Whoever logs in with this ID resolves to whichever`);
    console.log(`     row the query returns — potentially seeing another family's children.`);
  }

  // 5. MISSING ROLE CLAIM
  if (roleMissing.length) {
    console.log(`\n${line()}`);
    console.log("  ⚠️  MISSING publicMetadata.role — signs in, then lands on the wrong page");
    console.log(line());
    for (const m of roleMissing) {
      console.log(`  ${pad(m.email, 40)} DB role: ${m.role}`);
    }
    console.log(`\n  Fix: in Clerk, set public metadata for each to:  { "role": "<DB role>" }`);
    console.log(`  Or via the backend SDK:`);
    for (const m of roleMissing) {
      const cu = clerkByEmail.get(m.email.toLowerCase());
      console.log(`    await clerk.users.updateUser('${cu?.id}', { publicMetadata: { role: '${m.role}' } });`);
    }
  }

  // 6. ROLE DISAGREEMENT
  if (roleDiff.length) {
    console.log(`\n${line()}`);
    console.log("  ⚠️  ROLE DISAGREEMENT — Clerk and the database say different things");
    console.log(line());
    for (const m of roleDiff) {
      console.log(`  ${pad(m.email, 40)} Clerk: ${pad(m.clerkRole, 9)} DB: ${m.role}`);
    }
    console.log(`\n  The database is the source of truth for permissions; Clerk's claim drives`);
    console.log(`  which dashboard they land on. Update Clerk to match the DB.`);
  }

  if (clerkDupeEmails.length) {
    console.log(`\n${line()}`);
    console.log("  ⚠️  DUPLICATE EMAILS IN CLERK");
    console.log(line());
    clerkDupeEmails.forEach((e) => console.log(`  ${e}`));
    console.log(`\n  Two Clerk accounts share an email. Delete the unused one, then re-audit.`);
  }

  // ── Verdict ─────────────────────────────────────────────
  const broken = mismatch.length + noClerkUser.length + dupeIds.length;
  const degraded = roleMissing.length + roleDiff.length;
  console.log(`\n${line("═")}`);
  if (!broken && !degraded) {
    console.log("  ✅ No problems found. Every account maps correctly.");
    console.log("\n  If someone still cannot log in, the cause is elsewhere:");
    console.log("   • their sign-in link expired (7 days) — send a fresh one from Sign-in help");
    console.log("   • they never received the email — check Admin → Communications for a bounce");
    console.log("   • wrong password — Sign-in help → set a new one");
    console.log("   • account suspended — check status in the admin panel");
  } else {
    if (broken)  console.log(`  ❌ ${broken} account(s) CANNOT log in — fix these.`);
    if (degraded) console.log(`  ⚠️  ${degraded} account(s) can log in but may be misrouted.`);
    console.log("\n  Order: duplicates first, then mismatches, then missing accounts, then roles.");
  }
  console.log(line("═") + "\n");

  await prisma.$disconnect();
})();