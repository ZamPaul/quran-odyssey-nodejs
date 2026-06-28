// src/routes/admin/index.js  (NEW)
//
// The root admin router. In Phase 1 it only has the auth-check
// endpoint that the frontend uses to confirm a user is a valid admin.
// Later phases mount sub-routers here (accounts, students, teachers,
// enrollment, etc.).
//
// Mount in src/index.js as:  app.use('/api/admin', adminRouter);
// (see ap1_06 for the exact index.js edits)

import express from "express";
import { requireAdmin } from "../../middleware/adminAuth.js";
import { prisma } from "../../lib/prisma.js";
import dashboardRouter from './dashboard.js';
import accountsRouter from './accounts.js';
import studentsRouter from './students.js';
import teachersRouter from './teachers.js';
import requestsRouter from './enrollmentRequests.js';
import trialsRouter from './trials.js';
    

const router = express.Router();

// Every admin route requires a valid, active ADMIN.
router.use(requireAdmin);

// ─────────────────────────────────────────────────────────
// GET /api/admin/me
// Confirms the caller is an admin and returns minimal identity.
// The frontend calls this on /admin load; a 200 = allowed, a 401/403
// = bounce to /login (or a "not authorised" screen).
// ─────────────────────────────────────────────────────────
router.get("/me", async (req, res) => {
  return res.json({
    admin: {
      id: req.user.id,
      email: req.user.email,
      name: req.user.name,
      role: req.user.role,
    },
  });
});

// ─────────────────────────────────────────────────────────
// GET /api/admin/ping
// Trivial health/permission check (handy while wiring the shell).
// ─────────────────────────────────────────────────────────
router.get("/ping", (req, res) => {
  res.json({ ok: true, admin: req.user.email });
});

router.use('/dashboard', dashboardRouter);
router.use('/accounts', accountsRouter);
router.use('/students', studentsRouter);
router.use('/teachers', teachersRouter);
router.use('/enrollment-requests', requestsRouter);
router.use('/trials', trialsRouter);

// Future sub-routers (added in later phases), e.g.:
//   import accountsRouter from './accounts.js';
//   router.use('/accounts', accountsRouter);
//   router.use('/students', studentsRouter);
//   ...

export default router;
