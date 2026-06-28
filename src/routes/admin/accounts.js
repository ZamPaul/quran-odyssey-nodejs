// src/routes/admin/accounts.js  (NEW)
//
// Account management — the account holders (PARENT / STUDENT roles)
// who own learners. List, detail (with all linked students), create
// (manual), update, soft-suspend/reactivate, hard-delete.
//
// Every mutation is audit-logged via logAudit().
//
// Mount in src/routes/admin/index.js:
//   import accountsRouter from './accounts.js';
//   router.use('/accounts', accountsRouter);

import express from "express";
import { createClerkClient } from "@clerk/backend";
import { prisma } from "../../lib/prisma.js";
import { logAudit } from "../../lib/audit.js";

const router = express.Router();
const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

// Account holders are PARENT or STUDENT (not TEACHER/ADMIN).
const ACCOUNT_ROLES = ["PARENT", "STUDENT"];

// ═════════════════════════════════════════════════════════
// GET /api/admin/accounts
// List + search + filter + paginate.
// Query: ?q= &status=ACTIVE|SUSPENDED &role=PARENT|STUDENT
//        &page=1 &pageSize=25 &sort=createdAt|name|email &dir=asc|desc
// ═════════════════════════════════════════════════════════
router.get("/", async (req, res) => {
  const {
    q,
    status,
    role,
    page = "1",
    pageSize = "25",
    sort = "createdAt",
    dir = "desc",
  } = req.query;

  const where = { role: { in: ACCOUNT_ROLES } };
  if (status && ["ACTIVE", "SUSPENDED"].includes(status)) where.status = status;
  if (role && ACCOUNT_ROLES.includes(role)) where.role = role;
  if (q && q.trim()) {
    const term = q.trim();
    where.OR = [
      { email: { contains: term, mode: "insensitive" } },
      { name: { contains: term, mode: "insensitive" } },
      { phone: { contains: term, mode: "insensitive" } },
    ];
  }

  const sortField = ["createdAt", "name", "email"].includes(sort)
    ? sort
    : "createdAt";
  const sortDir = dir === "asc" ? "asc" : "desc";
  const take = Math.min(parseInt(pageSize, 10) || 25, 100);
  const skip = ((parseInt(page, 10) || 1) - 1) * take;

  try {
    const [rows, total] = await Promise.all([
      prisma.user.findMany({
        where,
        orderBy: { [sortField]: sortDir },
        skip,
        take,
        select: {
          id: true,
          email: true,
          name: true,
          phone: true,
          role: true,
          status: true,
          createdAt: true,
          _count: { select: { managedStudents: true } },
        },
      }),
      prisma.user.count({ where }),
    ]);

    const accounts = rows.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      phone: u.phone,
      role: u.role,
      status: u.status,
      createdAt: u.createdAt,
      studentCount: u._count.managedStudents,
    }));

    return res.json({
      accounts,
      total,
      page: parseInt(page, 10) || 1,
      pageSize: take,
    });
  } catch (err) {
    console.error("Accounts list failed:", err);
    return res.status(500).json({ error: "Failed to load accounts" });
  }
});

// ═════════════════════════════════════════════════════════
// GET /api/admin/accounts/:id
// One account + all linked students + a roll-up across them.
// ═════════════════════════════════════════════════════════
router.get("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const account = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        name: true,
        phone: true,
        role: true,
        status: true,
        createdAt: true,
        clerkId: true,
        managedStudents: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            name: true,
            age: true,
            dateOfBirth: true,
            country: true,
            timezone: true,
            gender: true,
            courseInterest: true,
            isSelf: true,
            createdAt: true,
            _count: {
              select: {
                enrollments: true,
                classSessions: true,
                assignments: true,
                trialBookings: true,
                enrollmentRequests: true,
              },
            },
          },
        },
      },
    });

    if (!account || !ACCOUNT_ROLES.includes(account.role)) {
      return res.status(404).json({ error: "Account not found" });
    }

    // Roll-up across the account's students
    const rollup = account.managedStudents.reduce(
      (acc, s) => {
        acc.enrollments += s._count.enrollments;
        acc.sessions += s._count.classSessions;
        acc.assignments += s._count.assignments;
        acc.trials += s._count.trialBookings;
        acc.enrollmentRequests += s._count.enrollmentRequests;
        return acc;
      },
      {
        enrollments: 0,
        sessions: 0,
        assignments: 0,
        trials: 0,
        enrollmentRequests: 0,
      },
    );

    return res.json({ account, rollup });
  } catch (err) {
    console.error("Account detail failed:", err);
    return res.status(500).json({ error: "Failed to load account" });
  }
});

// ═════════════════════════════════════════════════════════
// POST /api/admin/accounts
// Manually create an account holder.
//
// IMPORTANT (webhook interaction): creating the Clerk user fires the
// user.created webhook, which creates the DB User row with role=PARENT.
// So here we:
//   1. create the Clerk user (role in publicMetadata)
//   2. upsert the DB row (covers the race: whether or not the webhook
//      has landed yet) and set name/phone
// This is idempotent and avoids P2002 collisions with the webhook.
//
// Body: { email, name?, phone?, role? (PARENT|STUDENT), password? }
// If no password given, a random one is generated and returned ONCE so
// the admin can share it (or tell the parent to use "forgot password").
// ═════════════════════════════════════════════════════════
router.post("/", async (req, res) => {
  const { email, name, phone, role = "PARENT", password } = req.body;

  if (!email || !email.trim()) {
    return res.status(400).json({ error: "Email is required" });
  }
  if (!ACCOUNT_ROLES.includes(role)) {
    return res.status(400).json({ error: "Role must be PARENT or STUDENT" });
  }

  // Generate a random password if none provided
  const genPassword =
    password ||
    Math.random().toString(36).slice(2, 10) +
      "A1!" +
      Math.random().toString(36).slice(2, 6);

  try {
    // 1) Create the Clerk user
    let clerkUser;
    try {
      clerkUser = await clerk.users.createUser({
        emailAddress: [email.trim()],
        password: genPassword,
        publicMetadata: { role },
        ...(name
          ? {
              firstName: name.trim().split(" ")[0],
              lastName: name.trim().split(" ").slice(1).join(" ") || undefined,
            }
          : {}),
      });
    } catch (clerkErr) {
      const msg =
        clerkErr?.errors?.[0]?.message ||
        clerkErr.message ||
        "Clerk user creation failed";
      // Common: email already exists
      return res
        .status(409)
        .json({ error: `Could not create account: ${msg}` });
    }

    // 2) Upsert the DB row (handles webhook race) + set name/phone
    const dbUser = await prisma.user.upsert({
      where: { clerkId: clerkUser.id },
      update: {
        ...(name ? { name: name.trim() } : {}),
        ...(phone ? { phone: phone.trim() } : {}),
        role,
      },
      create: {
        clerkId: clerkUser.id,
        email: email.trim(),
        role,
        name: name?.trim() || null,
        phone: phone?.trim() || null,
      },
    });

    await logAudit(req, {
      action: "account.create",
      targetType: "User",
      targetId: dbUser.id,
      targetLabel: dbUser.email,
      metadata: { role, viaPanel: true },
    });

    return res.status(201).json({
      account: {
        id: dbUser.id,
        email: dbUser.email,
        name: dbUser.name,
        phone: dbUser.phone,
        role: dbUser.role,
        status: dbUser.status,
      },
      // Returned ONCE so the admin can share it. Not stored anywhere.
      temporaryPassword: password ? undefined : genPassword,
    });
  } catch (err) {
    console.error("Account create failed:", err);
    return res.status(500).json({ error: "Failed to create account" });
  }
});

// ═════════════════════════════════════════════════════════
// PATCH /api/admin/accounts/:id
// Update name / phone / role.
// ═════════════════════════════════════════════════════════
router.patch("/:id", async (req, res) => {
  const { id } = req.params;
  const { name, phone, role } = req.body;

  try {
    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing || !ACCOUNT_ROLES.includes(existing.role)) {
      return res.status(404).json({ error: "Account not found" });
    }

    const data = {};
    if (name !== undefined) data.name = name?.trim() || null;
    if (phone !== undefined) data.phone = phone?.trim() || null;
    if (role !== undefined) {
      if (!ACCOUNT_ROLES.includes(role)) {
        return res
          .status(400)
          .json({ error: "Role must be PARENT or STUDENT" });
      }
      data.role = role;
    }
    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    const updated = await prisma.user.update({ where: { id }, data });

    // If role changed, also sync Clerk publicMetadata
    if (data.role && existing.clerkId) {
      try {
        await clerk.users.updateUserMetadata(existing.clerkId, {
          publicMetadata: { role: data.role },
        });
      } catch (e) {
        console.error("⚠️  Clerk role sync failed:", e.message);
      }
    }

    await logAudit(req, {
      action: "account.update",
      targetType: "User",
      targetId: id,
      targetLabel: updated.email,
      metadata: { changed: Object.keys(data) },
    });

    return res.json({
      account: {
        id: updated.id,
        email: updated.email,
        name: updated.name,
        phone: updated.phone,
        role: updated.role,
        status: updated.status,
      },
    });
  } catch (err) {
    console.error("Account update failed:", err);
    return res.status(500).json({ error: "Failed to update account" });
  }
});

// ═════════════════════════════════════════════════════════
// PATCH /api/admin/accounts/:id/status
// Soft-suspend / reactivate. Body: { status: 'SUSPENDED'|'ACTIVE' }
// Also locks/unlocks the Clerk user so they actually can't sign in.
// ═════════════════════════════════════════════════════════
router.patch("/:id/status", async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!["ACTIVE", "SUSPENDED"].includes(status)) {
    return res
      .status(400)
      .json({ error: "Status must be ACTIVE or SUSPENDED" });
  }

  try {
    const existing = await prisma.user.findUnique({ where: { id } });
    if (!existing || !ACCOUNT_ROLES.includes(existing.role)) {
      return res.status(404).json({ error: "Account not found" });
    }

    const updated = await prisma.user.update({
      where: { id },
      data: { status },
    });

    // Lock/unlock in Clerk so sign-in is actually blocked while suspended
    if (existing.clerkId) {
      try {
        if (status === "SUSPENDED")
          await clerk.users.lockUser(existing.clerkId);
        else await clerk.users.unlockUser(existing.clerkId);
      } catch (e) {
        console.error("⚠️  Clerk lock/unlock failed:", e.message);
      }
    }

    await logAudit(req, {
      action: status === "SUSPENDED" ? "account.suspend" : "account.reactivate",
      targetType: "User",
      targetId: id,
      targetLabel: updated.email,
      metadata: { from: existing.status, to: status },
    });

    return res.json({
      account: { id: updated.id, email: updated.email, status: updated.status },
    });
  } catch (err) {
    console.error("Account status change failed:", err);
    return res.status(500).json({ error: "Failed to change account status" });
  }
});

// ═════════════════════════════════════════════════════════
// DELETE /api/admin/accounts/:id
// Hard delete. Removes the Clerk user (which fires user.deleted →
// deletes the DB row, cascading to students + all their data). We also
// delete the DB row directly as a fallback in case the webhook is slow.
//
// Requires ?confirm=true to avoid accidents.
// ═════════════════════════════════════════════════════════
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  if (req.query.confirm !== "true") {
    return res
      .status(400)
      .json({ error: "Deletion must be confirmed (?confirm=true)" });
  }

  try {
    const existing = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        clerkId: true,
        role: true,
        _count: { select: { managedStudents: true } },
      },
    });
    if (!existing || !ACCOUNT_ROLES.includes(existing.role)) {
      return res.status(404).json({ error: "Account not found" });
    }

    // Audit BEFORE deletion (so we capture the label/metadata)
    await logAudit(req, {
      action: "account.delete",
      targetType: "User",
      targetId: id,
      targetLabel: existing.email,
      metadata: { studentsDeleted: existing._count.managedStudents },
    });

    // 1) Delete from Clerk (fires user.deleted webhook → DB cascade)
    if (existing.clerkId) {
      try {
        await clerk.users.deleteUser(existing.clerkId);
      } catch (e) {
        console.error("⚠️  Clerk delete failed (continuing):", e.message);
      }
    }

    // 2) Fallback: ensure the DB row is gone (idempotent if webhook beat us)
    try {
      await prisma.user.delete({ where: { id } });
    } catch (e) {
      if (e.code !== "P2025") throw e; /* already gone via webhook */
    }

    return res.json({ message: "Account and all associated data deleted" });
  } catch (err) {
    console.error("Account delete failed:", err);
    return res.status(500).json({ error: "Failed to delete account" });
  }
});

export default router;
