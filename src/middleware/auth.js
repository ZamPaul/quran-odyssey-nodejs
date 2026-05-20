// src/middleware/auth.js
import { createClerkClient } from "@clerk/backend";
import { prisma } from "../lib/prisma.js";

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
    const payload = await clerk.verifyToken(token);

    // payload.sub is the Clerk user ID (e.g. "user_2abc...")
    req.auth = { clerkId: payload.sub };

    // Attach our DB user to the request so routes don't re-query
    const dbUser = await prisma.user.findUnique({
      where: { clerkId: payload.sub },
      include: { studentProfile: true },
    });

    if (!dbUser) {
      return res.status(401).json({ error: "User not found in database" });
    }

    req.user = dbUser;
    next();
  } catch (err) {
    console.error("Auth middleware error:", err.message);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
};
