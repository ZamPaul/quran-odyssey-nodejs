// src/routes/webhooks.js
//
// REWORKED for the multi-learner model.
//
// KEY CHANGES:
//   • user.created now defaults role to PARENT (the account holder).
//     A self-registered user is an account holder who will create one
//     or more Student records during onboarding. We do NOT auto-create
//     a Student here — that happens in the onboarding step where we
//     collect the learner's name/age.
//   • user.updated no longer creates a ParentProfile stub (that model
//     is being retired). It only syncs email + role.
//   • user.deleted cascades to the account's Student rows (via
//     onDelete: Cascade on Student.accountId) and all their data.

import express from "express";
import { Webhook } from "svix";
import { prisma } from "../lib/prisma.js";

const router = express.Router();

const VALID_ROLES = ['STUDENT', 'TEACHER', 'ADMIN', 'PARENT'];

router.post("/clerk", async (req, res) => {
  const WEBHOOK_SECRET = process.env.CLERK_WEBHOOK_SECRET;

  if (!WEBHOOK_SECRET) {
    console.error("CLERK_WEBHOOK_SECRET is not set");
    return res.status(500).json({ error: "Webhook secret not configured" });
  }

  const svixHeaders = {
    "svix-id":        req.headers["svix-id"],
    "svix-timestamp": req.headers["svix-timestamp"],
    "svix-signature": req.headers["svix-signature"],
  };

  const wh = new Webhook(WEBHOOK_SECRET);
  let event;
  try {
    event = wh.verify(req.body, svixHeaders);
  } catch (err) {
    console.error("❌ Webhook signature verification failed:", err.message);
    return res.status(400).json({ error: "Invalid webhook signature" });
  }

  const { type, data } = event;
  console.log(`📨 Clerk webhook received: ${type}`);

  // ─── user.created ──────────────────────────────────────
  if (type === "user.created") {
    const email = data?.email_addresses?.[0]?.email_address;
    if (!email) {
      console.error("No email found on user.created event");
      return res.status(400).json({ error: "No email on user" });
    }

    // Default role is now PARENT (account holder).
    // Admin still sets TEACHER explicitly via Clerk publicMetadata.
    const rawRole = data.public_metadata?.role || 'PARENT';
    const role    = VALID_ROLES.includes(rawRole) ? rawRole : 'PARENT';

    try {
      const user = await prisma.user.create({
        data: {
          clerkId: data.id,
          email,
          role,
          // name/phone are filled during onboarding (POST /api/students)
        },
      });
      console.log(`✅ User created in DB: ${user.email} (${user.id}) as ${role}`);
      // NOTE: intentionally NO Student auto-created here.
    } catch (err) {
      if (err.code === "P2002") {
        console.log(`⚠️  User already exists in DB, skipping: ${data.id}`);
      } else {
        console.error("❌ Failed to create user in DB:", err);
        return res.status(500).json({ error: "Database error" });
      }
    }
  }

  // ─── user.updated ──────────────────────────────────────
  if (type === "user.updated") {
    const email   = data?.email_addresses?.[0]?.email_address;
    const rawRole = data.public_metadata?.role;

    try {
      const updateData = {};
      if (email) updateData.email = email;
      if (rawRole && VALID_ROLES.includes(rawRole)) updateData.role = rawRole;

      if (Object.keys(updateData).length > 0) {
        await prisma.user.update({
          where: { clerkId: data.id },
          data:  updateData,
        });
        console.log(`✅ User updated: ${data.id}`);
      }
      // NOTE: no ParentProfile stub creation — that model is retired.
    } catch (err) {
      console.error('❌ Failed to update user:', err);
    }
  }

  // ─── user.deleted ──────────────────────────────────────
  if (type === "user.deleted") {
    try {
      await prisma.user.delete({ where: { clerkId: data.id } });
      console.log(`✅ User deleted from DB: ${data.id}`);
      // Student rows + their learning data cascade-delete via
      // onDelete: Cascade on Student.accountId.
    } catch (err) {
      if (err.code === "P2025") {
        console.log(`⚠️  User not found in DB for deletion: ${data.id}`);
      } else {
        console.error("❌ Failed to delete user:", err);
      }
    }
  }

  return res.status(200).json({ received: true });
});

export default router;