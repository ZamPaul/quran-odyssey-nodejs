// src/routes/admin/_credentials.js  (NEW)
//
// The three credential actions, written ONCE and mounted by both
// accounts.js and teachers.js. One implementation, two mounts — so the two
// panels can't drift apart.
//
//   POST /:id/password         set a new password (returned once, never stored)
//   POST /:id/signin-link      email a one-time sign-in link; they set their own
//   POST /:id/revoke-sessions  sign out of every device
//
// Nothing here writes a password to the database. Ever.

import { createClerkClient } from "@clerk/backend";
import { prisma } from "../../lib/prisma.js";
import { logAudit } from "../../lib/audit.js";
import { generatePassword, validatePassword } from "../../lib/password.js";
import { sendPasswordChangedNotice, sendSignInLink } from "../../services/email.js";

const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });

// A one-time sign-in link is a bearer credential sitting in an inbox.
// Clerk's default lifetime is 30 days — far too long. One hour.
const SIGNIN_LINK_TTL_SECONDS = 60 * 60;

/**
 * Mount the credential routes onto a router.
 *
 * @param {object} router      express router (already behind requireAdmin)
 * @param {object} opts
 *   subjectType  'User' | 'Teacher'   — for the audit trail
 *   findSubject  async (id) => ({ clerkId, email, name, blocked? }) | null
 *                `blocked` is a string reason that refuses the operation.
 */
export function mountCredentialRoutes(router, { subjectType, findSubject }) {
  // ── Set a new password ──────────────────────────────────
  // Body: { password?, signOutEverywhere?, emailIt? }
  // With no password supplied, a strong one is generated.
  router.post("/:id/password", async (req, res) => {
    const { password, signOutEverywhere = true, emailIt = false } = req.body || {};
    try {
      const subject = await findSubject(req.params.id);
      if (!subject) return res.status(404).json({ error: `${subjectType} not found` });
      if (subject.blocked) return res.status(403).json({ error: subject.blocked });
      if (!subject.clerkId) {
        return res.status(409).json({ error: "This person has no linked sign-in account." });
      }

      let newPassword = password;
      if (newPassword) {
        const bad = validatePassword(newPassword);
        if (bad) return res.status(400).json({ error: bad });
      } else {
        newPassword = generatePassword();
      }

      try {
        await clerk.users.updateUser(subject.clerkId, {
          password: newPassword,
          signOutOfOtherSessions: signOutEverywhere === true,
        });
      } catch (clerkErr) {
        // Clerk rejects weak or breached passwords — surface its own wording.
        const msg = clerkErr?.errors?.[0]?.message || clerkErr.message || "Clerk rejected the password";
        return res.status(400).json({ error: msg });
      }

      // Security notice — a silent credential change is what a breach looks like.
      let noticeSent = false;
      try {
        await sendPasswordChangedNotice({
          to: subject.email,
          name: subject.name,
          actorEmail: req.user?.email || "an administrator",
          temporaryPassword: emailIt === true ? newPassword : null,
        });
        noticeSent = true;
      } catch (e) {
        console.error("Password-changed notice failed:", e.message);
      }

      await logAudit(req, {
        action: "credentials.setPassword",
        targetType: subjectType,
        targetId: req.params.id,
        targetLabel: subject.email,
        // The password itself is NEVER logged.
        metadata: { generated: !password, signedOutEverywhere: signOutEverywhere === true, emailed: emailIt === true, noticeSent },
      });

      return res.json({
        ok: true,
        // Returned ONCE for the admin to relay. Not stored anywhere.
        password: newPassword,
        emailed: emailIt === true,
        noticeSent,
      });
    } catch (err) {
      console.error("Set password failed:", err);
      return res.status(500).json({ error: "Failed to set password" });
    }
  });

  // ── Email a one-time sign-in link ───────────────────────
  // The safest option: nobody relays a credential. They click, they're in,
  // and they set their own password from their account page.
  router.post("/:id/signin-link", async (req, res) => {
    try {
      const subject = await findSubject(req.params.id);
      if (!subject) return res.status(404).json({ error: `${subjectType} not found` });
      if (subject.blocked) return res.status(403).json({ error: subject.blocked });
      if (!subject.clerkId) {
        return res.status(409).json({ error: "This person has no linked sign-in account." });
      }

      let token;
      try {
        token = await clerk.signInTokens.createSignInToken({
          userId: subject.clerkId,
          expiresInSeconds: SIGNIN_LINK_TTL_SECONDS,
        });
      } catch (clerkErr) {
        const msg = clerkErr?.errors?.[0]?.message || clerkErr.message || "Could not create sign-in link";
        return res.status(502).json({ error: msg });
      }

      const url = token?.url;
      if (!url) return res.status(502).json({ error: "Clerk did not return a sign-in URL." });

      let sent = false;
      let sendError = null;
      try {
        await sendSignInLink({
          to: subject.email,
          name: subject.name,
          url,
          expiresMinutes: SIGNIN_LINK_TTL_SECONDS / 60,
        });
        sent = true;
      } catch (e) {
        sendError = e.message;
      }

      await logAudit(req, {
        action: "credentials.signInLink",
        targetType: subjectType,
        targetId: req.params.id,
        targetLabel: subject.email,
        // The link is a live credential — never written to the audit trail.
        metadata: { expiresMinutes: SIGNIN_LINK_TTL_SECONDS / 60, emailSent: sent, sendError: sendError || undefined },
      });

      if (!sent) {
        return res.status(502).json({ error: `Link created but the email failed to send: ${sendError}` });
      }
      return res.json({ ok: true, sentTo: subject.email, expiresMinutes: SIGNIN_LINK_TTL_SECONDS / 60 });
    } catch (err) {
      console.error("Sign-in link failed:", err);
      return res.status(500).json({ error: "Failed to send sign-in link" });
    }
  });

  // ── Sign out of every device ────────────────────────────
  router.post("/:id/revoke-sessions", async (req, res) => {
    try {
      const subject = await findSubject(req.params.id);
      if (!subject) return res.status(404).json({ error: `${subjectType} not found` });
      if (subject.blocked) return res.status(403).json({ error: subject.blocked });
      if (!subject.clerkId) {
        return res.status(409).json({ error: "This person has no linked sign-in account." });
      }

      let revoked = 0;
      try {
        const list = await clerk.sessions.getSessionList({ userId: subject.clerkId, status: "active" });
        const sessions = list?.data || list || [];
        for (const s of sessions) {
          try { await clerk.sessions.revokeSession(s.id); revoked++; } catch { /* already gone */ }
        }
      } catch (clerkErr) {
        const msg = clerkErr?.errors?.[0]?.message || clerkErr.message || "Could not list sessions";
        return res.status(502).json({ error: msg });
      }

      await logAudit(req, {
        action: "credentials.revokeSessions",
        targetType: subjectType,
        targetId: req.params.id,
        targetLabel: subject.email,
        metadata: { revoked },
      });
      return res.json({ ok: true, revoked });
    } catch (err) {
      console.error("Revoke sessions failed:", err);
      return res.status(500).json({ error: "Failed to sign out sessions" });
    }
  });
}

// ─────────────────────────────────────────────────────────
// Subject resolvers — one per panel.
// ─────────────────────────────────────────────────────────

// accounts.js — PARENT / STUDENT only. Admin credentials stay in Clerk.
export async function findAccountSubject(id) {
  const user = await prisma.user.findUnique({
    where: { id },
    select: { id: true, clerkId: true, email: true, name: true, role: true },
  });
  if (!user) return null;
  if (user.role === "ADMIN") {
    return { ...user, blocked: "Administrator passwords are managed in the Clerk dashboard, not here." };
  }
  return { clerkId: user.clerkId, email: user.email, name: user.name };
}

// teachers.js — resolves through the linked User row.
export async function findTeacherSubject(id) {
  const teacher = await prisma.teacher.findUnique({
    where: { id },
    select: { id: true, name: true, email: true, user: { select: { clerkId: true, email: true, role: true } } },
  });
  if (!teacher) return null;
  if (teacher.user?.role === "ADMIN") {
    return { blocked: "Administrator passwords are managed in the Clerk dashboard, not here." };
  }
  return {
    clerkId: teacher.user?.clerkId || null,
    email: teacher.user?.email || teacher.email,
    name: teacher.name,
  };
}