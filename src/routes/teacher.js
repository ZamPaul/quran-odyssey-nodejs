// src/routes/teacher.js
import express from 'express';
import { requireTeacher } from '../middleware/teacherAuth.js';

const router = express.Router();

// ── GET /api/teacher/me ───────────────────────────────────
// Returns the authenticated teacher's profile
// Used by: auth callback redirect, dashboard header
router.get('/me', requireTeacher, async (req, res) => {
  return res.json({
    user: {
      id:    req.user.id,
      email: req.user.email,
      role:  req.user.role,
    },
    teacher: {
      id:         req.teacher.id,
      name:       req.teacher.name,
      email:      req.teacher.email,
      specialty:  req.teacher.specialty,
      timezone:   req.teacher.timezone,
      gender:     req.teacher.gender,
      bio:        req.teacher.bio,
      rating:     req.teacher.rating,
      isActive:   req.teacher.isActive,
    },
  });
});

export default router;