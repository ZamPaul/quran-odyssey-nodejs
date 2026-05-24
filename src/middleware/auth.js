// src/middleware/auth.js
import "dotenv/config";
import { createClerkClient } from "@clerk/backend";
import { verifyToken } from "@clerk/backend";
import { prisma } from "../lib/prisma.js";

const clerk = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY,
});

export const requireAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  // console.log("CLERK SECRET KEY EXISTS:", process.env.CLERK_SECRET_KEY);

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "No authorization token provided" });
  }

  const token = authHeader.split(" ")[1];
  console.log("token: ", token)

  try {
    // Verify the JWT Clerk issued to this user
    const payload = await verifyToken(token, {
      secretKey: process.env.CLERK_SECRET_KEY
    });

    // payload.sub is the Clerk user ID (e.g. "user_2abc...")
    console.log(payload.sub);
    req.auth = { clerkId: payload.sub };

    // Attach our DB user to the request so routes don't re-query
    const dbUser = await prisma.user.findUnique({
      where: { clerkId: payload.sub },
      include: { studentProfile: true },
    });

    if (!dbUser) {
      console.log("user not found");
      return res.status(401).json({ error: "User not found in database" });
    }

    req.user = dbUser;
    console.log("Verified with Auth Middleware");
    next();
  } catch (err) {
    console.log("error: ", err);
    console.error("Auth middleware error:", err.message);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
};
