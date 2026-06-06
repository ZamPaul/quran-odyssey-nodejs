// src/routes/students.js
import express from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";

const router = express.Router();

// ─── POST /api/students/profile ───────────────────────────
// Creates the StudentProfile after registration
// Called once — immediately after Clerk signup flow completes
router.post("/profile", requireAuth, async (req, res) => {
  const {
    parentName,
    childName,
    childAge,
    country,
    timezone,
    courseInterest,
    phone,
  } = req.body;

  console.log("post request received at this route");
  console.log("req body:", req.body);

  // Validate required fields
  const missing = [];
  if (!parentName) missing.push("parentName");
  if (!childName) missing.push("childName");
  if (!childAge) missing.push("childAge");
  if (!country) missing.push("country");
  if (!timezone) missing.push("timezone");
  if (!courseInterest) missing.push("courseInterest");

  if (missing.length > 0) {
    return res.status(400).json({
      error: `Missing required fields: ${missing.join(", ")}`,
    });
  }

  // Don't let them create a second profile
  if (req.user.studentProfile) {
    return res.status(409).json({
      error: "Profile already exists",
      profileId: req.user.studentProfile.id,
    });
  }

  // Validate courseInterest is a valid enum value
  const validCourses = [
    "NOORANI_QAIDA",
    "QURAN_RECITATION",
    "TAJWEED",
    "HIFZ",
    "ISLAMIC_STUDIES",
    "ONE_TO_ONE",
  ];

  if (!validCourses.includes(courseInterest)) {
    return res.status(400).json({ error: "Invalid course interest value" });
  }

  // Validate age is a reasonable number
  const age = parseInt(childAge, 10);
  if (isNaN(age) || age < 4 || age > 18) {
    return res
      .status(400)
      .json({ error: "Child age must be between 4 and 18" });
  }

  try {
    const profile = await prisma.studentProfile.create({
      data: {
        userId: req.user.id,
        parentName: parentName.trim(),
        childName: childName.trim(),
        childAge: age,
        country: country.trim(),
        timezone,
        courseInterest,
        phone: phone?.trim() || null,
      },
    });

    console.log(`✅ StudentProfile created for user: ${req.user.email}`);

    return res.status(201).json({ profile });
  } catch (err) {
    console.error("Failed to create StudentProfile:", err);
    return res.status(500).json({ error: "Failed to create profile" });
  }
});

// ─── GET /api/students/profile ────────────────────────────
// Returns the current user + their profile
// Used by the frontend to check if profile exists
router.get("/profile", requireAuth, async (req, res) => {
  console.log("GET request at student apis profile");
  return res.json({
    user: {
      id: req.user.id,
      email: req.user.email,
      role: req.user.role,
    },
    profile: req.user.studentProfile || null,
  });
});

// Add to src/routes/students.js
// (needs the existing requireStudent middleware — same pattern as requireTeacher)

// ─────────────────────────────────────────────────────────
// GET /api/students/assignments
// Student views their own assignments
// ─────────────────────────────────────────────────────────
router.get('/assignments', requireAuth, async (req, res) => {
  const { status } = req.query;

  const where = { studentId: req.user.id };
  if (status) where.status = status;

  try {
    const assignments = await prisma.assignment.findMany({
      where,
      include: {
        teacher: {
          select: { id: true, name: true, gender: true },
        },
        submission: true,
      },
      orderBy: { dueDate: 'asc' },
    });

    return res.json({ assignments, count: assignments.length });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch assignments' });
  }
});

// ─────────────────────────────────────────────────────────
// POST /api/students/assignments/:id/submit
// Student submits an assignment
// Body: { content, fileUrl }
// ─────────────────────────────────────────────────────────
router.post('/assignments/:id/submit', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { content, fileUrl } = req.body;

  if (!content && !fileUrl) {
    return res.status(400).json({
      error: 'Provide either content (text) or fileUrl',
    });
  }

  try {
    const assignment = await prisma.assignment.findUnique({
      where:   { id },
      include: { submission: true },
    });

    // Assignment must exist and belong to this student
    if (!assignment || assignment.studentId !== req.user.id) {
      return res.status(404).json({ error: 'Assignment not found' });
    }

    // Already submitted
    if (assignment.submission) {
      return res.status(409).json({
        error: 'Assignment already submitted. Ask your teacher to allow resubmission.',
      });
    }

    const [submission] = await prisma.$transaction([
      prisma.assignmentSubmission.create({
        data: {
          assignmentId: id,
          studentId:    req.user.id,
          content:      content?.trim() || null,
          fileUrl:      fileUrl?.trim() || null,
        },
      }),
      prisma.assignment.update({
        where: { id },
        data:  { status: 'SUBMITTED' },
      }),
    ]);

    console.log(`✅ Assignment ${id} submitted by student ${req.user.id}`);
    return res.status(201).json({ submission });
  } catch (err) {
    console.error('Submission failed:', err);
    return res.status(500).json({ error: 'Failed to submit assignment' });
  }
});

// ─────────────────────────────────────────────────────────
// GET /api/students/sessions
// Upcoming + past sessions for the logged-in student
// ─────────────────────────────────────────────────────────
router.get('/sessions', requireAuth, async (req, res) => {
  try {
    const [upcoming, past] = await Promise.all([
      prisma.classSession.findMany({
        where: {
          studentId: req.user.id,
          status: 'SCHEDULED',
        },
        include: {
          teacher: { select: { name: true, gender: true } },
          attendance: { select: { status: true } },
        },
        orderBy: { scheduledAt: 'asc' },
        take: 20,
      }),
      prisma.classSession.findMany({
        where: {
          studentId: req.user.id,
          status: { in: ['COMPLETED', 'MISSED', 'CANCELLED'] },
        },
        include: {
          teacher: { select: { name: true, gender: true } },
          attendance: { select: { status: true } },
        },
        orderBy: { scheduledAt: 'desc' },
        take: 20,
      }),
    ]);

    return res.json({ upcoming, past });
  } catch (err) {
    console.error('Student sessions fetch failed:', err);
    return res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

// ─────────────────────────────────────────────────────────
// GET /api/students/progress
// Attendance stats + last 5 sent progress reports
// ─────────────────────────────────────────────────────────
router.get('/progress', requireAuth, async (req, res) => {
  try {
    const [attendanceRecords, reports] = await Promise.all([
      prisma.attendanceRecord.findMany({
        where: { studentId: req.user.id },
        select: { status: true, markedAt: true },
        orderBy: { markedAt: 'desc' },
      }),
      prisma.progressReport.findMany({
        where: { studentId: req.user.id, status: 'SENT' },
        include: {
          teacher: { select: { name: true } },
        },
        orderBy: { sentAt: 'desc' },
        take: 10,
      }),
    ]);

    const total   = attendanceRecords.length;
    const present = attendanceRecords.filter(r => r.status === 'PRESENT').length;
    const late    = attendanceRecords.filter(r => r.status === 'LATE').length;
    const absent  = attendanceRecords.filter(r => r.status === 'ABSENT').length;
    const excused = attendanceRecords.filter(r => r.status === 'EXCUSED').length;
    const attended    = present + late;
    const percentage  = total > 0 ? Math.round((attended / total) * 100) : 0;

    return res.json({
      attendance: { total, present, late, absent, excused, percentage },
      reports,
    });
  } catch (err) {
    console.error('Student progress fetch failed:', err);
    return res.status(500).json({ error: 'Failed to fetch progress' });
  }
});

// ─────────────────────────────────────────────────────────
// GET /api/students/assignments
// All assignments for the student, asc by dueDate
// ─────────────────────────────────────────────────────────
router.get('/assignments', requireAuth, async (req, res) => {
  const { status } = req.query;

  const where = { studentId: req.user.id };
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
    console.error('Student assignments fetch failed:', err);
    return res.status(500).json({ error: 'Failed to fetch assignments' });
  }
});

// ─────────────────────────────────────────────────────────
// POST /api/students/assignments/:id/submit
// Student submits an assignment
// ─────────────────────────────────────────────────────────
router.post('/assignments/:id/submit', requireAuth, async (req, res) => {
  const { id }              = req.params;
  const { content, fileUrl } = req.body;

  if (!content && !fileUrl) {
    return res.status(400).json({ error: 'Provide content or a file URL' });
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

    if (!assignment || assignment.studentId !== req.user.id) {
      return res.status(404).json({ error: 'Assignment not found' });
    }

    if (assignment.submission) {
      return res.status(409).json({ error: 'Assignment already submitted' });
    }

    if (assignment.status === 'GRADED') {
      return res.status(409).json({ error: 'Cannot submit a graded assignment' });
    }

    const [submission] = await prisma.$transaction([
      prisma.assignmentSubmission.create({
        data: {
          assignmentId: id,
          studentId:    req.user.id,
          content:      content?.trim() || null,
          fileUrl:      fileUrl?.trim() || null,
        },
      }),
      prisma.assignment.update({
        where: { id },
        data:  { status: 'SUBMITTED' },
      }),
    ]);

    console.log(`✅ Assignment ${id} submitted by student ${req.user.id}`);
    return res.status(201).json({ submission });
  } catch (err) {
    console.error('Assignment submission failed:', err);
    return res.status(500).json({ error: 'Failed to submit assignment' });
  }
});

// ─────────────────────────────────────────────────────────
// PATCH /api/students/profile
// Student can update their own profile fields
// ─────────────────────────────────────────────────────────
router.patch('/profile', requireAuth, async (req, res) => {
  const { parentName, childName, childAge, country, timezone, phone } = req.body;

  if (!req.user.studentProfile) {
    return res.status(404).json({ error: 'Profile not found' });
  }

  if (childAge !== undefined) {
    const age = parseInt(childAge, 10);
    if (isNaN(age) || age < 4 || age > 18) {
      return res.status(400).json({ error: 'Child age must be between 4 and 18' });
    }
  }

  const updateData = {};
  if (parentName !== undefined) updateData.parentName = parentName.trim();
  if (childName  !== undefined) updateData.childName  = childName.trim();
  if (childAge   !== undefined) updateData.childAge   = parseInt(childAge, 10);
  if (country    !== undefined) updateData.country    = country.trim();
  if (timezone   !== undefined) updateData.timezone   = timezone.trim();
  if (phone      !== undefined) updateData.phone      = phone.trim() || null;

  if (Object.keys(updateData).length === 0) {
    return res.status(400).json({ error: 'No fields provided to update' });
  }

  try {
    const profile = await prisma.studentProfile.update({
      where: { userId: req.user.id },
      data:  updateData,
    });
    return res.json({ profile });
  } catch (err) {
    console.error('Profile update failed:', err);
    return res.status(500).json({ error: 'Failed to update profile' });
  }
});

export default router;
