// src/routes/booking.js
import express from "express";
import { prisma } from "../lib/prisma.js";
import { requireAuth } from "../middleware/auth.js";
import { getAvailableSlots } from "../services/googleCalendar.js";

const router = express.Router();

// ─── GET /api/booking/availability ────────────────────────
// Returns available 30-min slots for a specific teacher
// Query params:
//   teacherId  (required) — our DB teacher ID
//   daysAhead  (optional) — how many days to look ahead, default 14
router.get("/availability", requireAuth, async (req, res) => {
  const { teacherId, daysAhead } = req.query;

  if (!teacherId) {
    return res
      .status(400)
      .json({ error: "teacherId query parameter is required" });
  }

  // Fetch teacher from DB to get their calendar ID
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
      slots, // array of { start, end } in UTC ISO strings
      count: slots.length,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Availability fetch failed:", err.message);

    // Don't expose internal error details to client
    return res.status(503).json({
      error: "Calendar availability temporarily unavailable. Please try again.",
    });
  }
});

// ─── GET /api/booking/teachers ────────────────────────────
// Returns active teachers filtered by course interest
// Used in the booking UI Step 2 to populate the teacher selection
router.get("/teachers", requireAuth, async (req, res) => {
  const { courseInterest } = req.query;

  const teachers = await prisma.teacher.findMany({
    where: {
      isActive: true,
      // If courseInterest is passed, filter by specialty
      // specialty is a String[] so we use the 'has' filter
      ...(courseInterest && {
        specialty: {
          hasSome: [
            courseInterest
              .replace(/_/g, " ")
              .toLowerCase()
              .replace(/\b\w/g, (c) => c.toUpperCase()),
          ],
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

  console.log("successfully fetched all available teachers with this course");

  return res.json({ teachers });
});

export default router;
