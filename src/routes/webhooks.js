// src/routes/webhooks.js
import express from "express";
import { Webhook } from "svix";
import { prisma } from "../lib/prisma.js";

const router = express.Router();

router.post("/clerk", async (req, res) => {
  const WEBHOOK_SECRET = process.env.CLERK_WEBHOOK_SECRET;

  if (!WEBHOOK_SECRET) {
    console.error("CLERK_WEBHOOK_SECRET is not set");
    return res.status(500).json({ error: "Webhook secret not configured" });
  }

  // svix sends these three headers with every webhook
  const svixHeaders = {
    "svix-id": req.headers["svix-id"],
    "svix-timestamp": req.headers["svix-timestamp"],
    "svix-signature": req.headers["svix-signature"],
  };

  // Verify the webhook signature
  // req.body is a Buffer here because of express.raw() in index.js
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

  // ─── user.created ──────────────────────────────────
  if (type === "user.created") {
    const email = data?.email_addresses?.[0]?.email_address;

    if (!email) {
      console.error("No email found on user.created event");
      return res.status(400).json({ error: "No email on user" });
    }

    try {
      const user = await prisma.user.create({
        data: {
          clerkId: data.id,
          email: email,      
          role: "STUDENT",
        },
      });  
      console.log(`✅ User created in DB: ${user.email} (${user.id})`);
    } catch (err) {
      // P2002 = unique constraint violation — user already exists
      // This can happen if the webhook fires twice (Clerk retries on timeout)
      if (err.code === "P2002") {
        console.log(`⚠️  User already exists in DB, skipping: ${data.id}`);
      } else {
        console.error("❌ Failed to create user in DB:", err);
        return res.status(500).json({ error: "Database error" });
      }
    }
  }

  // ─── user.updated ──────────────────────────────────
  if (type === "user.updated") {
    const email = data?.email_addresses?.[0]?.email_address;

    if (email) {
      try {
        await prisma.user.update({
          where: { clerkId: data.id },
          data: { email },
        });
        console.log(`✅ User email updated in DB: ${data.id}`);
      } catch (err) {
        console.error("❌ Failed to update user:", err);
      }
    }
  }

  // ─── user.deleted ──────────────────────────────────
  if (type === "user.deleted") {
    try {
      await prisma.user.delete({
        where: { clerkId: data.id },
      });
      console.log(`✅ User deleted from DB: ${data.id}`);
    } catch (err) {
      // User might not exist if creation failed earlier
      if (err.code === "P2025") {
        console.log(`⚠️  User not found in DB for deletion: ${data.id}`);
      } else {
        console.error("❌ Failed to delete user:", err);
      }
    }
  }

  // Always return 200 — Clerk retries any non-2xx response
  return res.status(200).json({ received: true });
});

export default router;
