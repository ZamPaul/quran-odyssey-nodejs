// src/middleware/auth.js
import "dotenv/config";
import { createClerkClient } from "@clerk/backend";
import { verifyToken } from "@clerk/backend";
import { prisma } from "../lib/prisma.js";
import { hasContactDetails } from "../lib/accountCompleteness.js";

const clerk = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
});

export const requireAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No authorization token provided" });
  }

  const token = authHeader.split(" ")[1];

  try {
    // Verify the JWT Clerk issued to this user
    const payload = await verifyToken(token, {
      secretKey: process.env.CLERK_SECRET_KEY,
    });

    // payload.sub is the Clerk user ID (e.g. "user_2abc...")
    req.auth = { clerkId: payload.sub };

    // Attach our DB user + the learners this account manages.
    // managedStudents replaces the old single studentProfile include.
    const dbUser = await prisma.user.findUnique({
      where:   { clerkId: payload.sub },
      include: {
        managedStudents: {
          orderBy: { createdAt: "asc" },
        },
      }
    });

    if (!dbUser) {
      return res.status(401).json({ error: "User not found in database" });
    }

    req.user = dbUser;

    // The isolation boundary for ALL student-data routes.
    // Every per-learner query MUST validate the target studentId
    // against this array — never trust req.body / req.params alone.
    req.studentIds = dbUser.managedStudents.map((s) => s.id);

    next();
  } catch (err) {
    console.error("Auth middleware error:", err.message);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
};

// ─────────────────────────────────────────────────────────
// Helper: assert the logged-in account owns a given studentId.
// Use inside routes that take a :studentId param.
// Returns true if owned, false otherwise.
// ─────────────────────────────────────────────────────────
export function ownsStudent(req, studentId) {
  return Array.isArray(req.studentIds) && req.studentIds.includes(studentId);
}
 
export function requireContactDetails(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  if (!hasContactDetails(req.user)) {
    return res.status(428).json({
      // 428 Precondition Required — semantically perfect here.
      error: "PROFILE_INCOMPLETE",
      message: "Please complete your profile (name and contact number) before booking or enrolling.",
      missing: [
        ...(!req.user.name?.trim()  ? ["name"]  : []),
        ...(!req.user.phone?.trim() ? ["phone"] : []),
      ],
      redirectTo: "/register-profile",
    });
  }
  next();
}