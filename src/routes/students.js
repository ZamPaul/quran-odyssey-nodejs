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

export default router;
