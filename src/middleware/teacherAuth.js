// src/middleware/teacherAuth.js
import "dotenv/config";
import { createClerkClient } from "@clerk/backend";
import { verifyToken } from "@clerk/backend";
import { prisma } from "../lib/prisma.js";

const clerk = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
});

export const requireTeacher = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No authorization token provided" });
  }

  const token = authHeader.split(" ")[1];

  try {
    // Step 1: Verify JWT
    const payload = await verifyToken(token, {
        secretKey: process.env.CLERK_SECRET_KEY
    });

    // Step 2: Fetch user from DB
    const dbUser = await prisma.user.findUnique({
      where: { clerkId: payload.sub },
    });

    if (!dbUser) {
      return res.status(401).json({ error: "User not found in database" });
    }

    // Step 3: Confirm role is TEACHER
    if (dbUser.role !== "TEACHER") {
      return res.status(403).json({
        error: "Access denied. Teacher role required.",
        yourRole: dbUser.role,
      });
    }

    // Step 4: Fetch linked Teacher record
    const teacher = await prisma.teacher.findUnique({
      where: { userId: dbUser.id },
    });

    if (!teacher) {
      return res.status(403).json({
        error: "Teacher profile not linked. Ask admin to link your account.",
      });
    }

    if (!teacher.isActive) {
      return res.status(403).json({
        error: "Teacher account is inactive. Contact admin.",
      });
    }

    // Step 5: Attach to request
    req.user = dbUser;
    req.teacher = teacher;

    next();
  } catch (err) {
    console.error("Teacher auth error:", err.message);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
};
