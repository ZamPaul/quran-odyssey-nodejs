// src/routes/leads.js
import express from "express";
import { prisma } from "../lib/prisma.js";
import {
  sendLeadConfirmationEmail,
  sendAdminLeadNotification,
} from "../services/email.js";

const router = express.Router();

// ─── POST /api/leads/trial ────────────────────────────────
// No auth required — public route
// Called by the landing page opt-in form
router.post("/trial", async (req, res) => {
  const { firstName, lastName, email, phone, isInterested } = req.body;

  // Basic validation
  if (!firstName || !lastName || !email || !phone) {
    return res.status(400).json({
      error: "First name, last name, email, and phone are required",
    });
  }

  // Basic email format check
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res
      .status(400)
      .json({ error: "Please enter a valid email address" });
  }

  try {
    // Save lead to database
    const lead = await prisma.trialLead.create({
      data: {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim().toLowerCase(),
        phone: phone.trim(),
        isInterested: isInterested === "yes",
        source: "landing_page",
        status: "NEW",
      },
    });

    console.log(
      `✅ New trial lead: ${lead.firstName} ${lead.lastName} (${lead.email})`,
    );

    // Fire notifications — non-blocking
    // Confirmation to the lead
    sendLeadConfirmationEmail({
      to: lead.email,
      firstName: lead.firstName,
    }).catch((err) =>
      console.error("Lead confirmation email failed:", err.message),
    );

    // Notification to admin
    sendAdminLeadNotification({
      firstName: lead.firstName,
      lastName: lead.lastName,
      email: lead.email,
      phone: lead.phone,
      leadId: lead.id,
    }).catch((err) =>
      console.error("Admin notification email failed:", err.message),
    );

    return res.status(201).json({
      success: true,
      message: "Thank you! We will be in touch within 2 hours.",
    });
  } catch (err) {
    console.error("❌ Failed to create trial lead:", err);
    return res
      .status(500)
      .json({ error: "Something went wrong. Please try again." });
  }
});

export default router;
