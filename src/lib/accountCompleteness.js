// ═══════════════════════════════════════════════════════════
// PROFILE COMPLETENESS — single source of truth
// NEW FILE: src/lib/accountCompleteness.js
//
// "Complete" = name set AND phone set AND >= 1 student.
//
// Two granularities, because the booking endpoint legitimately creates
// the FIRST student inline — so for the hard API block we only require
// the account-holder fields (name + phone), while "fully complete"
// (incl. >=1 student) drives the frontend redirect.
// ═══════════════════════════════════════════════════════════

import { prisma } from "./prisma.js";

// The account-holder fields the team needs to make contact.
export function hasContactDetails(user) {
  return !!(user && user.name && user.name.trim() && user.phone && user.phone.trim());
}

// Full completion: contact details AND at least one learner.
// Pass studentCount if you already have it to avoid an extra query.
export function isAccountComplete(user, studentCount) {
  return hasContactDetails(user) && (studentCount || 0) > 0;
}

// Resolve completion for a userId (used where we don't already have counts).
// Returns { complete, hasContact, studentCount, missing: [...] }.
export async function resolveCompleteness(userId) {
  const [user, studentCount] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { name: true, phone: true } }),
    prisma.student.count({ where: { accountId: userId } }),
  ]);

  const hasContact = hasContactDetails(user);
  const complete = hasContact && studentCount > 0;

  const missing = [];
  if (!user?.name?.trim())  missing.push("name");
  if (!user?.phone?.trim()) missing.push("phone");
  if (studentCount === 0)   missing.push("learner");

  return { complete, hasContact, studentCount, missing };
}