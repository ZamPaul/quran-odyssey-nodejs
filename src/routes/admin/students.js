// src/routes/admin/students.js  (NEW)
//
// Student/learner management. List + filter, full 360° profile, manual
// create under an account, edit, move between accounts, manual enrol
// (fires confirmation email per decision #5), and delete (cascade).
//
// Mount in src/routes/admin/index.js:
//   import studentsRouter from './students.js';
//   router.use('/students', studentsRouter);

import express from "express";
import { prisma } from "../../lib/prisma.js";
import { logAudit } from "../../lib/audit.js";
import { sendEnrollmentApproved } from "../../services/email.js";

const router = express.Router();

const VALID_COURSES = [
  "NOORANI_QAIDA",
  "QURAN_RECITATION",
  "TAJWEED",
  "HIFZ",
  "ISLAMIC_STUDIES",
  "ONE_TO_ONE",
];

function courseLabel(c) {
  return (c || "")
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function attendancePct(records) {
  if (!records || records.length === 0) return 0;
  const present = records.filter(
    (r) => r.status === "PRESENT" || r.status === "LATE",
  ).length;
  return Math.round((present / records.length) * 100);
}

// ═════════════════════════════════════════════════════════
// GET /api/admin/students
// List + search + filter + paginate.
// Query: ?q= &course= &country= &accountId= &page= &pageSize=
//        &sort=createdAt|name|age &dir=asc|desc
// ═════════════════════════════════════════════════════════
router.get("/", async (req, res) => {
  const {
    q,
    course,
    country,
    accountId,
    page = "1",
    pageSize = "25",
    sort = "createdAt",
    dir = "desc",
  } = req.query;

  const where = {};
  if (course && VALID_COURSES.includes(course)) where.courseInterest = course;
  if (accountId) where.accountId = accountId;
  if (country && country.trim())
    where.country = { contains: country.trim(), mode: "insensitive" };
  if (q && q.trim()) {
    where.OR = [
      { name: { contains: q.trim(), mode: "insensitive" } },
      { account: { email: { contains: q.trim(), mode: "insensitive" } } },
    ];
  }

  const sortField = ["createdAt", "name", "age"].includes(sort)
    ? sort
    : "createdAt";
  const sortDir = dir === "asc" ? "asc" : "desc";
  const take = Math.min(parseInt(pageSize, 10) || 25, 100);
  const skip = ((parseInt(page, 10) || 1) - 1) * take;

  try {
    const [rows, total] = await Promise.all([
      prisma.student.findMany({
        where,
        orderBy: { [sortField]: sortDir },
        skip,
        take,
        select: {
          id: true,
          name: true,
          age: true,
          country: true,
          courseInterest: true,
          isSelf: true,
          createdAt: true,
          account: {
            select: { id: true, email: true, name: true, status: true },
          },
          _count: { select: { enrollments: true, classSessions: true } },
        },
      }),
      prisma.student.count({ where }),
    ]);

    const students = rows.map((s) => ({
      id: s.id,
      name: s.name,
      age: s.age,
      country: s.country,
      courseInterest: s.courseInterest,
      courseLabel: courseLabel(s.courseInterest),
      isSelf: s.isSelf,
      createdAt: s.createdAt,
      account: s.account,
      enrollments: s._count.enrollments,
      sessions: s._count.classSessions,
    }));

    return res.json({
      students,
      total,
      page: parseInt(page, 10) || 1,
      pageSize: take,
    });
  } catch (err) {
    console.error("Students list failed:", err);
    return res.status(500).json({ error: "Failed to load students" });
  }
});

// ═════════════════════════════════════════════════════════
// GET /api/admin/students/:id
// Full 360° profile.
// ═════════════════════════════════════════════════════════
router.get("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const student = await prisma.student.findUnique({
      where: { id },
      include: {
        account: {
          select: {
            id: true,
            email: true,
            name: true,
            phone: true,
            status: true,
          },
        },
        enrollments: {
          orderBy: { createdAt: "desc" },
          include: { teacher: { select: { id: true, name: true } } },
        },
        classSessions: {
          orderBy: { scheduledAt: "desc" },
          take: 20,
          include: { teacher: { select: { name: true } } },
        },
        assignments: {
          orderBy: { createdAt: "desc" },
          take: 20,
          include: { submission: true, teacher: { select: { name: true } } },
        },
        progressReports: {
          orderBy: { createdAt: "desc" },
          take: 10,
          include: { teacher: { select: { name: true } } },
        },
        attendanceRecords: { select: { status: true } },
        trialBookings: {
          orderBy: { slotStart: "desc" },
          include: { teacher: { select: { name: true } } },
        },
        enrollmentRequests: { orderBy: { createdAt: "desc" } },
      },
    });

    if (!student) return res.status(404).json({ error: "Student not found" });

    const att = student.attendanceRecords;
    const attendance = {
      total: att.length,
      present: att.filter((r) => r.status === "PRESENT").length,
      late: att.filter((r) => r.status === "LATE").length,
      absent: att.filter((r) => r.status === "ABSENT").length,
      excused: att.filter((r) => r.status === "EXCUSED").length,
      percentage: attendancePct(att),
    };

    return res.json({
      student: { ...student, attendanceRecords: undefined },
      attendance,
    });
  } catch (err) {
    console.error("Student detail failed:", err);
    return res.status(500).json({ error: "Failed to load student" });
  }
});

// ═════════════════════════════════════════════════════════
// POST /api/admin/students
// Manually create a learner under an account.
// Body: { accountId, name, age, country, timezone, courseInterest,
//         gender?, dateOfBirth?, isSelf? }
// ═════════════════════════════════════════════════════════
router.post("/", async (req, res) => {
  const {
    accountId,
    name,
    age,
    country,
    timezone,
    courseInterest,
    gender,
    dateOfBirth,
    isSelf,
  } = req.body;

  const missing = [];
  if (!accountId) missing.push("accountId");
  if (!name) missing.push("name");
  if (age === undefined) missing.push("age");
  if (!country) missing.push("country");
  if (!timezone) missing.push("timezone");
  if (!courseInterest) missing.push("courseInterest");
  if (missing.length)
    return res.status(400).json({ error: `Missing: ${missing.join(", ")}` });

  if (!VALID_COURSES.includes(courseInterest)) {
    return res.status(400).json({ error: "Invalid courseInterest" });
  }
  const ageNum = parseInt(age, 10);
  if (isNaN(ageNum) || ageNum < 1 || ageNum > 99) {
    return res.status(400).json({ error: "Age must be 1–99" });
  }

  try {
    const account = await prisma.user.findUnique({ where: { id: accountId } });
    if (!account) return res.status(404).json({ error: "Account not found" });

    let dob = null;
    if (dateOfBirth) {
      const d = new Date(dateOfBirth);
      if (isNaN(d.getTime()))
        return res.status(400).json({ error: "Invalid dateOfBirth" });
      if (d > new Date())
        return res
          .status(400)
          .json({ error: "Date of birth cannot be in the future" });
      dob = d;
    }

    const student = await prisma.student.create({
      data: {
        accountId,
        name: name.trim(),
        age: ageNum,
        country: country.trim(),
        timezone: timezone.trim(),
        courseInterest,
        gender: gender?.trim() || null,
        dateOfBirth: dob,
        isSelf: isSelf === true,
      },
    });

    await logAudit(req, {
      action: "student.create",
      targetType: "Student",
      targetId: student.id,
      targetLabel: student.name,
      metadata: { accountId, course: courseInterest },
    });

    return res.status(201).json({ student });
  } catch (err) {
    console.error("Student create failed:", err);
    return res.status(500).json({ error: "Failed to create student" });
  }
});

// ═════════════════════════════════════════════════════════
// PATCH /api/admin/students/:id
// Edit fields. Body may include name/age/country/timezone/gender/
// courseInterest/dateOfBirth.
// ═════════════════════════════════════════════════════════
router.patch("/:id", async (req, res) => {
  const { id } = req.params;
  const { name, age, country, timezone, gender, courseInterest, dateOfBirth } =
    req.body;

  try {
    const existing = await prisma.student.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: "Student not found" });

    const data = {};
    if (name !== undefined) data.name = name.trim();
    if (country !== undefined) data.country = country.trim();
    if (timezone !== undefined) data.timezone = timezone.trim();
    if (gender !== undefined) data.gender = gender?.trim() || null;
    if (courseInterest !== undefined) {
      if (!VALID_COURSES.includes(courseInterest))
        return res.status(400).json({ error: "Invalid courseInterest" });
      data.courseInterest = courseInterest;
    }
    if (dateOfBirth !== undefined) {
      if (dateOfBirth === null || dateOfBirth === "") {
        data.dateOfBirth = null;
      } else {
        const d = new Date(dateOfBirth);
        if (isNaN(d.getTime()))
          return res.status(400).json({ error: "Invalid dateOfBirth" });
        if (d > new Date())
          return res
            .status(400)
            .json({ error: "Date of birth cannot be in the future" });
        data.dateOfBirth = d;
      }
    }
    if (age !== undefined && data.dateOfBirth === undefined) {
      const ageNum = parseInt(age, 10);
      if (isNaN(ageNum) || ageNum < 1 || ageNum > 99)
        return res.status(400).json({ error: "Age must be 1–99" });
      data.age = ageNum;
    }
    if (Object.keys(data).length === 0)
      return res.status(400).json({ error: "No fields to update" });

    const updated = await prisma.student.update({ where: { id }, data });

    await logAudit(req, {
      action: "student.update",
      targetType: "Student",
      targetId: id,
      targetLabel: updated.name,
      metadata: { changed: Object.keys(data) },
    });

    return res.json({ student: updated });
  } catch (err) {
    console.error("Student update failed:", err);
    return res.status(500).json({ error: "Failed to update student" });
  }
});

// ═════════════════════════════════════════════════════════
// PATCH /api/admin/students/:id/move
// Move a learner to a different account. Body: { accountId }
// ═════════════════════════════════════════════════════════
router.patch("/:id/move", async (req, res) => {
  const { id } = req.params;
  const { accountId } = req.body;
  if (!accountId)
    return res.status(400).json({ error: "Target accountId is required" });

  try {
    const [student, target] = await Promise.all([
      prisma.student.findUnique({
        where: { id },
        include: { account: { select: { email: true } } },
      }),
      prisma.user.findUnique({
        where: { id: accountId },
        select: { id: true, email: true },
      }),
    ]);
    if (!student) return res.status(404).json({ error: "Student not found" });
    if (!target)
      return res.status(404).json({ error: "Target account not found" });
    if (student.accountId === accountId)
      return res
        .status(400)
        .json({ error: "Student already belongs to that account" });

    const fromEmail = student.account.email;
    const updated = await prisma.student.update({
      where: { id },
      data: { accountId },
    });

    await logAudit(req, {
      action: "student.move",
      targetType: "Student",
      targetId: id,
      targetLabel: student.name,
      metadata: { fromAccount: fromEmail, toAccount: target.email },
    });

    return res.json({ student: updated });
  } catch (err) {
    console.error("Student move failed:", err);
    return res.status(500).json({ error: "Failed to move student" });
  }
});

// ═════════════════════════════════════════════════════════
// POST /api/admin/students/:id/enroll
// Manual enrolment: create an Enrollment with a teacher assigned, and
// send the family the approval/confirmation email (decision #5: not
// silent). Does NOT auto-generate recurring sessions — that's Phase 7.
//
// Body: { teacherId, courseType, sessionsPerWeek?, startDate?, notes? }
// ═════════════════════════════════════════════════════════
router.post("/:id/enroll", async (req, res) => {
  const { id } = req.params;
  const { teacherId, courseType, sessionsPerWeek, startDate, notes } = req.body;

  if (!teacherId)
    return res.status(400).json({ error: "teacherId is required" });
  if (!courseType || !VALID_COURSES.includes(courseType)) {
    return res.status(400).json({ error: "Valid courseType is required" });
  }

  try {
    const [student, teacher] = await Promise.all([
      prisma.student.findUnique({
        where: { id },
        include: { account: { select: { email: true, name: true } } },
      }),
      prisma.teacher.findUnique({ where: { id: teacherId } }),
    ]);
    if (!student) return res.status(404).json({ error: "Student not found" });
    if (!teacher) return res.status(404).json({ error: "Teacher not found" });

    const enrollment = await prisma.enrollment.create({
      data: {
        studentId: id,
        teacherId,
        courseType,
        sessionsPerWeek: sessionsPerWeek ? parseInt(sessionsPerWeek, 10) : 2,
        startDate: startDate ? new Date(startDate) : new Date(),
        status: "ACTIVE",
        notes: notes?.trim() || null,
      },
    });

    await logAudit(req, {
      action: "student.enroll",
      targetType: "Enrollment",
      targetId: enrollment.id,
      targetLabel: student.name,
      metadata: { teacher: teacher.name, course: courseType, viaPanel: true },
    });

    // Decision #5: fire the confirmation email (non-blocking).
    sendEnrollmentApproved({
      to: student.account.email,
      parentName: student.account.name || "Parent",
      childName: student.name,
      courseLabel: courseLabel(courseType),
      applicationId: enrollment.id,
    }).catch((e) => console.error("⚠️  Enrollment email failed:", e.message));

    return res.status(201).json({ enrollment });
  } catch (err) {
    console.error("Manual enroll failed:", err);
    return res.status(500).json({ error: "Failed to enroll student" });
  }
});

// ═════════════════════════════════════════════════════════
// GET /api/admin/students/meta/teachers
// Lightweight active-teachers list for the manual-enrol dropdown.
// (Phase 5 builds the full teachers section; this is just the picker.)
// ═════════════════════════════════════════════════════════
router.get("/meta/teachers", async (req, res) => {
  try {
    const teachers = await prisma.teacher.findMany({
      where: { isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true, specialty: true, gender: true },
    });
    return res.json({ teachers });
  } catch (err) {
    console.error("Teachers meta failed:", err);
    return res.status(500).json({ error: "Failed to load teachers" });
  }
});

// ═════════════════════════════════════════════════════════
// GET /api/admin/students/meta/accounts
// Lightweight account list for the "move learner" picker.
// ═════════════════════════════════════════════════════════
router.get("/meta/accounts", async (req, res) => {
  const { q } = req.query;
  try {
    const where = { role: { in: ["PARENT", "STUDENT"] } };
    if (q && q.trim()) {
      where.OR = [
        { email: { contains: q.trim(), mode: "insensitive" } },
        { name: { contains: q.trim(), mode: "insensitive" } },
      ];
    }
    const accounts = await prisma.user.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true, email: true, name: true },
    });
    return res.json({ accounts });
  } catch (err) {
    console.error("Accounts meta failed:", err);
    return res.status(500).json({ error: "Failed to load accounts" });
  }
});

// ═════════════════════════════════════════════════════════
// DELETE /api/admin/students/:id?confirm=true
// Hard delete the learner (cascades to their learning data).
// ═════════════════════════════════════════════════════════
router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  if (req.query.confirm !== "true") {
    return res
      .status(400)
      .json({ error: "Deletion must be confirmed (?confirm=true)" });
  }

  try {
    const student = await prisma.student.findUnique({
      where: { id },
      select: { id: true, name: true, account: { select: { email: true } } },
    });
    if (!student) return res.status(404).json({ error: "Student not found" });

    await logAudit(req, {
      action: "student.delete",
      targetType: "Student",
      targetId: id,
      targetLabel: student.name,
      metadata: { account: student.account.email },
    });

    await prisma.student.delete({ where: { id } });
    return res.json({ message: "Student and all associated data deleted" });
  } catch (err) {
    console.error("Student delete failed:", err);
    return res.status(500).json({ error: "Failed to delete student" });
  }
});

export default router;
