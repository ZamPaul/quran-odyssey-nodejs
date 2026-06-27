// src/middleware/adminAuth.js
//
// Admin authentication for the panel. Mirrors requireTeacher:
// verify the Clerk JWT → load the DB user → assert role === 'ADMIN'
// and status === 'ACTIVE'. Attaches req.user.
//
// This REPLACES the old x-admin-secret approach. Every /api/admin/*
// route uses this. Person-attributed from day one (req.user is the
// specific admin), so the audit log and future multi-admin "just work".

import "dotenv/config";
import { verifyToken } from "@clerk/backend";
import { prisma } from "../lib/prisma.js";

export const requireAdmin = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No authorization token provided" });
  }

  const token = authHeader.split(" ")[1];

  try {
    // Step 1: Verify JWT
    const payload = await verifyToken(token, {
      secretKey: process.env.CLERK_SECRET_KEY,
    });

    // Step 2: Load the DB user
    const dbUser = await prisma.user.findUnique({
      where: { clerkId: payload.sub },
    });

    if (!dbUser) {
      return res.status(401).json({ error: "User not found in database" });
    }

    // Step 3: Must be an ADMIN
    if (dbUser.role !== "ADMIN") {
      return res.status(403).json({
        error: "Access denied. Administrator role required.",
      });
    }

    // Step 4: Admin's own account must be active
    if (dbUser.status === "SUSPENDED") {
      return res.status(403).json({
        error: "This administrator account is suspended.",
      });
    }

    // Step 5: Attach to request
    req.user = dbUser;
    req.adminId = dbUser.id;
    req.clientIp =
      req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
      req.socket?.remoteAddress ||
      null;

    next();
  } catch (err) {
    console.error("Admin auth error:", err.message);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
};
