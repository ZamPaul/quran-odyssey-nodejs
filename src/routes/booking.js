// src/routes/booking.js
import express from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import {
  getAvailableSlots,
  createBookingEvent,
} from "../services/googleCalendar.js";
import { sendTrialBookingConfirmation } from "../services/email.js";
import { sendTrialBookingWhatsApp } from "../services/whatsapp.js";

const router = express.Router();

const VALID_COURSES = [
  "NOORANI_QAIDA",
  "QURAN_RECITATION",
  "TAJWEED",
  "HIFZ",
  "ISLAMIC_STUDIES",
  "ONE_TO_ONE",
];

function courseEnumToLabel(enumVal) {
  return enumVal
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ─── GET /api/booking/availability ────────────────────────
router.get("/availability", requireAuth, async (req, res) => {
  const { teacherId, daysAhead } = req.query;

  if (!teacherId) {
    return res
      .status(400)
      .json({ error: "teacherId query parameter is required" });
  }

  const teacher = await prisma.teacher.findUnique({
    where: { id: teacherId },
    select: {
      id: true,
      name: true,
      calendarId: true,
      timezone: true,
      isActive: true,
    },
  });

  if (!teacher) {
    return res.status(404).json({ error: "Teacher not found" });
  }

  if (!teacher.isActive) {
    return res
      .status(400)
      .json({ error: "Teacher is not currently accepting bookings" });
  }

  if (!teacher.calendarId || teacher.calendarId.startsWith("placeholder")) {
    return res
      .status(503)
      .json({ error: "Teacher calendar not configured yet" });
  }

  try {
    const slots = await getAvailableSlots(
      teacher.calendarId,
      daysAhead ? parseInt(daysAhead, 10) : 14,
    );

    return res.json({
      teacher: {
        id: teacher.id,
        name: teacher.name,
        timezone: teacher.timezone,
      },
      slots,
      count: slots.length,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Availability fetch failed:", err.message);
    return res.status(503).json({
      error: "Calendar availability temporarily unavailable. Please try again.",
    });
  }
});

// ─── GET /api/booking/teachers ────────────────────────────
router.get("/teachers", requireAuth, async (req, res) => {
  const { courseInterest } = req.query;

  const teachers = await prisma.teacher.findMany({
    where: {
      isActive: true,
      ...(courseInterest && {
        specialty: {
          hasSome: [courseEnumToLabel(courseInterest)],
        },
      }),
    },
    select: {
      id: true,
      name: true,
      specialty: true,
      timezone: true,
      gender: true,
      bio: true,
      rating: true,
    },
    orderBy: { rating: "desc" },
  });

  return res.json({ teachers });
});

// ─── POST /api/booking/trial ──────────────────────────────
router.post("/trial", requireAuth, async (req, res) => {
  const profile = req.user.studentProfile;
  if (!profile) {
    return res.status(403).json({
      error: "Complete your student profile before booking a trial class.",
    });
  }

  const {
    teacherId,
    slotStart,
    slotEnd,
    courseInterest,
    childName,
    childAge,
    studentTimezone,
  } = req.body;

  if (!teacherId || !slotStart || !slotEnd) {
    return res.status(400).json({
      error: "teacherId, slotStart, and slotEnd are required",
    });
  }

  const resolvedCourse = courseInterest || profile.courseInterest;
  if (!VALID_COURSES.includes(resolvedCourse)) {
    return res.status(400).json({ error: "Invalid course interest value" });
  }

  const age = parseInt(childAge ?? profile.childAge, 10);
  if (isNaN(age) || age < 4 || age > 18) {
    return res.status(400).json({ error: "Child age must be between 4 and 18" });
  }

  const resolvedChildName = (childName || profile.childName)?.trim();
  const resolvedTimezone = studentTimezone || profile.timezone;
  if (!resolvedChildName) {
    return res.status(400).json({ error: "Child name is required" });
  }
  if (!resolvedTimezone) {
    return res.status(400).json({ error: "Timezone is required" });
  }

  const existingTrial = await prisma.trialBooking.findFirst({
    where: {
      studentId: req.user.id,
      status: { in: ["PENDING", "CONFIRMED"] },
    },
  });

  if (existingTrial) {
    return res.status(409).json({
      code: "TRIAL_EXISTS",
      error: "You already have a trial class booked.",
      bookingId: existingTrial.id,
    });
  }

  const teacher = await prisma.teacher.findUnique({
    where: { id: teacherId },
  });

  if (!teacher || !teacher.isActive) {
    return res.status(404).json({ error: "Teacher not found or inactive" });
  }

  if (!teacher.calendarId || teacher.calendarId.startsWith("placeholder")) {
    return res.status(503).json({ error: "Teacher calendar not configured yet" });
  }

  const slotStartIso = new Date(slotStart).toISOString();
  const slotEndIso = new Date(slotEnd).toISOString();
  const expectedEnd = new Date(new Date(slotStartIso).getTime() + 30 * 60 * 1000);
  if (slotEndIso !== expectedEnd.toISOString()) {
    return res.status(400).json({ error: "Invalid slot duration" });
  }

  try {
    const slots = await getAvailableSlots(teacher.calendarId, 14);
    const stillAvailable = slots.some((s) => s.start === slotStartIso);
    if (!stillAvailable) {
      return res.status(409).json({
        code: "SLOT_TAKEN",
        error: "This slot was just taken. Please pick another.",
      });
    }
  } catch (err) {
    console.error("Slot re-check failed:", err.message);
    return res.status(503).json({
      error: "Could not verify slot availability. Please try again.",
    });
  }

  const courseLabel = courseEnumToLabel(resolvedCourse);
  let booking;

  try {
    booking = await prisma.trialBooking.create({
      data: {
        studentId: req.user.id,
        teacherId: teacher.id,
        slotStart: new Date(slotStartIso),
        slotEnd: new Date(slotEndIso),
        status: "PENDING",
        studentTimezone: resolvedTimezone,
      },
      include: { teacher: { select: { name: true } } },
    });
  } catch (err) {
    if (err.code === "P2002") {
      return res.status(409).json({
        code: "SLOT_TAKEN",
        error: "This slot was just taken. Please pick another.",
      });
    }
    console.error("TrialBooking create failed:", err);
    return res.status(500).json({ error: "Failed to create booking" });
  }

  let calEventId;
  try {
    calEventId = await createBookingEvent({
      calendarId: teacher.calendarId,
      slotStart: slotStartIso,
      slotEnd: slotEndIso,
      studentName: resolvedChildName,
      parentName: profile.parentName,
      courseInterest: resolvedCourse,
      studentEmail: req.user.email,
    });
  } catch (err) {
    console.error("Calendar event failed, rolling back booking:", err.message);
    await prisma.trialBooking.delete({ where: { id: booking.id } });
    return res.status(503).json({
      error: "Could not reserve this slot on the calendar. Please try another.",
    });
  }

  booking = await prisma.trialBooking.update({
    where: { id: booking.id },
    data: { calEventId },
    include: { teacher: { select: { name: true } } },
  });

  try {
    const emailResult = await sendTrialBookingConfirmation({
      to: req.user.email,
      parentName: profile.parentName,
      childName: resolvedChildName,
      teacherName: teacher.name,
      courseLabel,
      slotStart: slotStartIso,
      studentTimezone: resolvedTimezone,
      bookingId: booking.id,
    });
    if (emailResult.success) {
      await prisma.trialBooking.update({
        where: { id: booking.id },
        data: { emailSent: true },
      });
    }
  } catch (err) {
    console.error("Email notification failed:", err.message);
  }

  try {
    const waResult = await sendTrialBookingWhatsApp({
      to: profile.phone,
      parentName: profile.parentName,
      childName: resolvedChildName,
      teacherName: teacher.name,
      courseLabel,
      slotStart: slotStartIso,
      studentTimezone: resolvedTimezone,
      bookingId: booking.id,
    });
    if (waResult.success) {
      await prisma.trialBooking.update({
        where: { id: booking.id },
        data: { whatsappSent: true },
      });
    }
  } catch (err) {
    console.error("WhatsApp notification failed:", err.message);
  }

  return res.status(201).json({
    bookingId: booking.id,
    status: booking.status,
    teacher: { id: teacher.id, name: teacher.name },
    slotStart: slotStartIso,
    slotEnd: slotEndIso,
    childName: resolvedChildName,
    courseInterest: resolvedCourse,
    courseLabel,
    studentTimezone: resolvedTimezone,
    bookingRef: booking.id.toUpperCase().slice(-8),
  });
});

export default router;
