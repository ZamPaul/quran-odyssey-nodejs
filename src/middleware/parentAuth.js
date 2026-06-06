// src/middleware/parentAuth.js
import 'dotenv/config';
import { verifyToken } from '@clerk/backend';
import { prisma } from '../lib/prisma.js';

export const requireParent = async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No authorization token provided' });
  }

  const token = authHeader.split(' ')[1];

  try {
    // Step 1 — Verify JWT
    const payload = await verifyToken(token, {
      secretKey: process.env.CLERK_SECRET_KEY,
    });

    // Step 2 — Fetch user from DB
    const dbUser = await prisma.user.findUnique({
      where: { clerkId: payload.sub },
    });

    if (!dbUser) {
      return res.status(401).json({ error: 'User not found in database' });
    }

    // Step 3 — Confirm role is PARENT
    if (dbUser.role !== 'PARENT') {
      return res.status(403).json({
        error:    'Access denied. Parent role required.',
        yourRole: dbUser.role,
      });
    }

    // Step 4 — Fetch ParentProfile
    const parentProfile = await prisma.parentProfile.findUnique({
      where: { userId: dbUser.id },
    });

    if (!parentProfile) {
      return res.status(403).json({
        error: 'Parent profile not found. Contact admin to set up your account.',
      });
    }

    // Step 5 — Fetch linked child IDs
    // All parent queries MUST filter to this list — never trust req.body.childId
    const links = await prisma.parentChildLink.findMany({
      where:  { parentUserId: dbUser.id },
      select: { childUserId: true },
    });

    const childIds = links.map(l => l.childUserId);

    // Step 6 — Attach to request
    req.user          = dbUser;
    req.parentProfile = parentProfile;
    req.childIds      = childIds; // array of studentId strings

    next();
  } catch (err) {
    console.error('Parent auth error:', err.message);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};