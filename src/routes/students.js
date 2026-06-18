// src/routes/students.js
//
// REWORKED for the multi-learner model.
// One account (req.user) manages many Student records (req.studentIds).
// This router now also absorbs everything the old parent.js did —
// parents and solo students hit the SAME endpoints. The only difference
// is how many Students they manage.
//
// Ownership rule: every per-learner route validates :studentId against
// req.studentIds and returns 404 (not 403) if not owned — never reveal
// that another account's student exists.

import express from 'express';
import { prisma } from '../lib/prisma.js';
import { requireAuth, ownsStudent } from '../middleware/auth.js';

const router = express.Router();

const VALID_COURSES = ['NOORANI_QAIDA','QURAN_RECITATION','TAJWEED','HIFZ','ISLAMIC_STUDIES','ONE_TO_ONE'];

// ═════════════════════════════════════════════════════════
// ACCOUNT + LEARNERS
// ═════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────
// GET /api/students
// Returns the account holder + the list of all their learners.
// Replaces the old GET /profile (which returned one profile).
// ─────────────────────────────────────────────────────────
router.get('/', requireAuth, async (req, res) => {
  try {
    const students = await prisma.student.findMany({
      where:   { accountId: req.user.id },
      orderBy: { createdAt: 'asc' },
    });

    return res.json({
      account: {
        id:    req.user.id,
        email: req.user.email,
        role:  req.user.role,
        name:  req.user.name,
        phone: req.user.phone,
      },
      students,
    });
  } catch (err) {
    console.error('Account/students fetch failed:', err);
    return res.status(500).json({ error: 'Failed to fetch account' });
  }
});

// ─────────────────────────────────────────────────────────
// POST /api/students
// Create a NEW learner under this account. Callable many times
// (this is the "add a child" action). Also used for the very
// first learner during onboarding.
//
// Optionally accepts account-holder fields (name/phone) to set on
// the User if not already set — used by the first-time onboarding.
//
// isSelf=true marks a solo-adult learner (the account holder is the
// learner themselves).
// ─────────────────────────────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  const {
    name, age, country, timezone, courseInterest, gender, isSelf,
    accountName, accountPhone, // optional: set on the User
  } = req.body;

  const missing = [];
  if (!name)           missing.push('name');
  if (age === undefined) missing.push('age');
  if (!country)        missing.push('country');
  if (!timezone)       missing.push('timezone');
  if (!courseInterest) missing.push('courseInterest');
  if (missing.length) {
    return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
  }

  if (!VALID_COURSES.includes(courseInterest)) {
    return res.status(400).json({ error: 'Invalid courseInterest value' });
  }

  const ageNum = parseInt(age, 10);
  if (isNaN(ageNum) || ageNum < 4 || ageNum > 99) {
    return res.status(400).json({ error: 'Age must be between 4 and 99' });
  }

  try {
    // Optionally backfill account-holder info on first onboarding
    if (accountName || accountPhone) {
      await prisma.user.update({
        where: { id: req.user.id },
        data: {
          ...(accountName  && !req.user.name  ? { name:  accountName.trim()  } : {}),
          ...(accountPhone && !req.user.phone ? { phone: accountPhone.trim() } : {}),
        },
      });
    }

    const student = await prisma.student.create({
      data: {
        accountId:      req.user.id,
        name:           name.trim(),
        age:            ageNum,
        country:        country.trim(),
        timezone:       timezone.trim(),
        courseInterest,
        gender:         gender?.trim() || null,
        isSelf:         isSelf === true,
      },
    });

    console.log(`✅ Student created (${student.name}) under account ${req.user.email}`);
    return res.status(201).json({ student });
  } catch (err) {
    console.error('Student create failed:', err);
    return res.status(500).json({ error: 'Failed to create learner' });
  }
});

// ─────────────────────────────────────────────────────────
// PATCH /api/students/:studentId
// Update one learner. Ownership-checked.
// Replaces the old PATCH /profile.
// ─────────────────────────────────────────────────────────
router.patch('/:studentId', requireAuth, async (req, res) => {
  const { studentId } = req.params;

  if (!ownsStudent(req, studentId)) {
    return res.status(404).json({ error: 'Learner not found' });
  }

  const { name, age, country, timezone, gender } = req.body;

  const data = {};
  if (name     !== undefined) data.name     = name.trim();
  if (country  !== undefined) data.country  = country.trim();
  if (timezone !== undefined) data.timezone = timezone.trim();
  if (gender   !== undefined) data.gender   = gender?.trim() || null;
  if (age      !== undefined) {
    const ageNum = parseInt(age, 10);
    if (isNaN(ageNum) || ageNum < 4 || ageNum > 99) {
      return res.status(400).json({ error: 'Age must be between 4 and 99' });
    }
    data.age = ageNum;
  }

  if (Object.keys(data).length === 0) {
    return res.status(400).json({ error: 'No fields provided to update' });
  }

  try {
    const student = await prisma.student.update({
      where: { id: studentId },
      data,
    });
    return res.json({ student });
  } catch (err) {
    console.error('Student update failed:', err);
    return res.status(500).json({ error: 'Failed to update learner' });
  }
});

// ─────────────────────────────────────────────────────────
// PATCH /api/students/account
// Update the account holder's own name/phone.
// (Note: registered BEFORE /:studentId is irrelevant here because
//  the path segment differs, but we keep account routes grouped.)
// ─────────────────────────────────────────────────────────
router.patch('/account/me', requireAuth, async (req, res) => {
  const { name, phone } = req.body;
  const data = {};
  if (name  !== undefined) data.name  = name?.trim()  || null;
  if (phone !== undefined) data.phone = phone?.trim() || null;

  if (Object.keys(data).length === 0) {
    return res.status(400).json({ error: 'No fields provided to update' });
  }

  try {
    const user = await prisma.user.update({
      where:  { id: req.user.id },
      data,
      select: { id: true, email: true, name: true, phone: true, role: true },
    });
    return res.json({ account: user });
  } catch (err) {
    console.error('Account update failed:', err);
    return res.status(500).json({ error: 'Failed to update account' });
  }
});

// ═════════════════════════════════════════════════════════
// PER-LEARNER DATA (sessions / progress / assignments)
// All ownership-checked against req.studentIds.
// ═════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────
// GET /api/students/:studentId/sessions
// Upcoming + past sessions for one learner.
// ─────────────────────────────────────────────────────────
router.get('/:studentId/sessions', requireAuth, async (req, res) => {
  const { studentId } = req.params;
  if (!ownsStudent(req, studentId)) {
    return res.status(404).json({ error: 'Learner not found' });
  }

  try {
    const [upcoming, past] = await Promise.all([
      prisma.classSession.findMany({
        where:   { studentId, status: 'SCHEDULED' },
        include: {
          teacher:    { select: { name: true, gender: true } },
          attendance: { select: { status: true } },
        },
        orderBy: { scheduledAt: 'asc' },
        take:    20,
      }),
      prisma.classSession.findMany({
        where:   { studentId, status: { in: ['COMPLETED', 'MISSED', 'CANCELLED'] } },
        include: {
          teacher:    { select: { name: true, gender: true } },
          attendance: { select: { status: true } },
        },
        orderBy: { scheduledAt: 'desc' },
        take:    20,
      }),
    ]);

    return res.json({ upcoming, past });
  } catch (err) {
    console.error('Sessions fetch failed:', err);
    return res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

// ─────────────────────────────────────────────────────────
// GET /api/students/:studentId/progress
// Attendance stats + last 10 SENT progress reports for one learner.
// ─────────────────────────────────────────────────────────
router.get('/:studentId/progress', requireAuth, async (req, res) => {
  const { studentId } = req.params;
  if (!ownsStudent(req, studentId)) {
    return res.status(404).json({ error: 'Learner not found' });
  }

  try {
    const [attendanceRecords, reports] = await Promise.all([
      prisma.attendanceRecord.findMany({
        where:   { studentId },
        select:  { status: true, markedAt: true },
        orderBy: { markedAt: 'desc' },
      }),
      prisma.progressReport.findMany({
        where:   { studentId, status: 'SENT' },
        include: { teacher: { select: { name: true } } },
        orderBy: { sentAt: 'desc' },
        take:    10,
      }),
    ]);

    const total   = attendanceRecords.length;
    const present = attendanceRecords.filter(r => r.status === 'PRESENT').length;
    const late    = attendanceRecords.filter(r => r.status === 'LATE').length;
    const absent  = attendanceRecords.filter(r => r.status === 'ABSENT').length;
    const excused = attendanceRecords.filter(r => r.status === 'EXCUSED').length;
    const attended   = present + late;
    const percentage = total > 0 ? Math.round((attended / total) * 100) : 0;

    return res.json({
      attendance: { total, present, late, absent, excused, percentage },
      reports,
    });
  } catch (err) {
    console.error('Progress fetch failed:', err);
    return res.status(500).json({ error: 'Failed to fetch progress' });
  }
});

// ─────────────────────────────────────────────────────────
// GET /api/students/:studentId/attendance
// Full attendance history for one learner (used by the
// attendance tab in the unified dashboard).
// ─────────────────────────────────────────────────────────
router.get('/:studentId/attendance', requireAuth, async (req, res) => {
  const { studentId } = req.params;
  if (!ownsStudent(req, studentId)) {
    return res.status(404).json({ error: 'Learner not found' });
  }

  try {
    const records = await prisma.attendanceRecord.findMany({
      where:   { studentId },
      include: {
        session: { select: { scheduledAt: true, courseType: true } },
        teacher: { select: { name: true } },
      },
      orderBy: { markedAt: 'desc' },
    });

    const total   = records.length;
    const present = records.filter(r => r.status === 'PRESENT').length;
    const late    = records.filter(r => r.status === 'LATE').length;
    const absent  = records.filter(r => r.status === 'ABSENT').length;
    const excused = records.filter(r => r.status === 'EXCUSED').length;
    const percentage = total > 0 ? Math.round(((present + late) / total) * 100) : 0;

    return res.json({
      stats: { total, present, late, absent, excused, percentage },
      records,
    });
  } catch (err) {
    console.error('Attendance fetch failed:', err);
    return res.status(500).json({ error: 'Failed to fetch attendance' });
  }
});

// ─────────────────────────────────────────────────────────
// GET /api/students/:studentId/assignments
// All assignments for one learner. Query: ?status=
// ─────────────────────────────────────────────────────────
router.get('/:studentId/assignments', requireAuth, async (req, res) => {
  const { studentId } = req.params;
  if (!ownsStudent(req, studentId)) {
    return res.status(404).json({ error: 'Learner not found' });
  }

  const { status } = req.query;
  const valid = ['PENDING', 'SUBMITTED', 'GRADED', 'OVERDUE'];
  if (status && !valid.includes(status)) {
    return res.status(400).json({ error: `Invalid status. Must be one of: ${valid.join(', ')}` });
  }

  const where = { studentId };
  if (status) where.status = status;

  try {
    const assignments = await prisma.assignment.findMany({
      where,
      include: {
        teacher:    { select: { name: true } },
        submission: true,
      },
      orderBy: { dueDate: 'asc' },
    });
    return res.json({ assignments, count: assignments.length });
  } catch (err) {
    console.error('Assignments fetch failed:', err);
    return res.status(500).json({ error: 'Failed to fetch assignments' });
  }
});

// ─────────────────────────────────────────────────────────
// POST /api/students/:studentId/assignments/:id/submit
// Account holder submits an assignment on the learner's behalf
// (read-write — confirmed product decision). Ownership-checked.
// ─────────────────────────────────────────────────────────
router.post('/:studentId/assignments/:id/submit', requireAuth, async (req, res) => {
  const { studentId, id } = req.params;
  if (!ownsStudent(req, studentId)) {
    return res.status(404).json({ error: 'Learner not found' });
  }

  const { content, fileUrl, fileName, fileType } = req.body;

  if (!content && !fileUrl) {
    return res.status(400).json({ error: 'Provide either content (text) or a file upload' });
  }
  if (content && content.trim().length > 3000) {
    return res.status(400).json({ error: 'Content exceeds 3000 character limit' });
  }
  if (fileUrl) {
    try { new URL(fileUrl); } catch {
      return res.status(400).json({ error: 'fileUrl must be a valid URL' });
    }
  }

  try {
    const assignment = await prisma.assignment.findUnique({
      where:   { id },
      include: { submission: true },
    });

    // Must exist AND belong to THIS learner
    if (!assignment || assignment.studentId !== studentId) {
      return res.status(404).json({ error: 'Assignment not found' });
    }
    if (assignment.submission) {
      return res.status(409).json({ error: 'Assignment already submitted. Contact your teacher to allow resubmission.' });
    }
    if (assignment.status === 'GRADED') {
      return res.status(409).json({ error: 'Cannot submit a graded assignment' });
    }

    const [submission] = await prisma.$transaction([
      prisma.assignmentSubmission.create({
        data: {
          assignmentId: id,
          studentId,
          content:  content?.trim()  || null,
          fileUrl:  fileUrl?.trim()  || null,
          fileName: fileName?.trim() || null,
          fileType: fileType?.trim() || null,
        },
      }),
      prisma.assignment.update({
        where: { id },
        data:  { status: 'SUBMITTED' },
      }),
    ]);

    console.log(`✅ Assignment ${id} submitted for learner ${studentId}${fileUrl ? ' with file' : ''}`);
    return res.status(201).json({ submission });
  } catch (err) {
    console.error('Submission failed:', err);
    return res.status(500).json({ error: 'Failed to submit assignment' });
  }
});

export default router;