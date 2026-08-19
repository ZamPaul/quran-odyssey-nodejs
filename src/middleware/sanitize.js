// src/middleware/sanitize.js

// ── String helpers ────────────────────────────────────────

export function cleanStr(val, maxLength = 2000) {
    if (val === null || val === undefined) return null;
    if (typeof val !== 'string') return null;
    const trimmed = val.trim();
    if (!trimmed) return null;
    return trimmed.slice(0, maxLength);
}
  
// export function requireStr(val, fieldName, maxLength = 2000) {
//   const cleaned = cleanStr(val, maxLength);
//   if (!cleaned) return { error: `${fieldName} is required` };
//   return { value: cleaned };
// }

export function requireStr(val, fieldName, maxLength = 2000, label = null) {
  const name = label || fieldName;
  if (val !== null && val !== undefined && typeof val === 'string' && val.trim().length > maxLength) {
    return { error: `${name} is too long — keep it under ${maxLength} characters.` };
  }
  const cleaned = cleanStr(val, maxLength);
  if (!cleaned) return { error: `${name} is required.` };
  return { value: cleaned };
}
  
// ── Number helpers ────────────────────────────────────────

export function cleanInt(val, min, max) {
  const n = parseInt(val, 10);
  if (isNaN(n)) return null;
  if (min !== undefined && n < min) return null;
  if (max !== undefined && n > max) return null;
  return n;
}
  
  // ── Date helpers ──────────────────────────────────────────
  
  // export function cleanFutureDate(val, fieldName = 'date') {
  //   if (!val) return { error: `${fieldName} is required` };
  //   const d = new Date(val);
  //   if (isNaN(d.getTime())) return { error: `${fieldName} is not a valid date` };
  //   if (d <= new Date()) return { error: `${fieldName} must be in the future` };
  //   return { value: d };
  // }

  // Kept for existing callers. `label` is what the USER calls the field.
  export function cleanFutureDate(val, fieldName = 'date', label = null) {
    const name = label || fieldName;
    if (!val) return { error: `${name} is required` };
    const d = new Date(val);
    if (isNaN(d.getTime())) {
      return { error: `${name} is not a valid date. Please pick a date and time.` };
    }
    if (d <= new Date()) {
      return { error: `${name} must be in the future. Pick a later time today, or a future date.` };
    }
    return { value: d };
  }

  /**
   * A deadline that may fall LATER TODAY.
   *
   * `<input type="date">` yields "2026-08-14", which Date() reads as midnight
   * UTC — already past. So a plain "must be in the future" check makes it
   * impossible to set a deadline for today, which is a normal thing to want.
   *
   * Rules:
   *   • date-only input  → treated as END of that day (23:59:59 local)
   *   • date+time input  → taken literally, must be at least `graceMinutes` ahead
   */
  export function cleanDeadline(val, label = 'Due date', graceMinutes = 5) {
    if (!val) {
      return { error: `${label} is required — choose when this is due.` };
    }
    if (typeof val !== 'string' && !(val instanceof Date)) {
      return { error: `${label} is not a valid date.` };
    }

    const raw = typeof val === 'string' ? val.trim() : val;
    const dateOnly = typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw);

    let d;
    if (dateOnly) {
      // End of that calendar day, in the server's local zone.
      const [y, m, day] = raw.split('-').map(Number);
      d = new Date(y, m - 1, day, 23, 59, 59, 999);
    } else {
      d = new Date(raw);
    }

    if (isNaN(d.getTime())) {
      return { error: `${label} is not a valid date. Please pick a date and time.` };
    }

    const floor = new Date(Date.now() + graceMinutes * 60 * 1000);
    if (d < floor) {
      const isToday = d.toDateString() === new Date().toDateString();
      return {
        error: isToday
          ? `${label} has already passed. Pick a time later today, or a future date.`
          : `${label} is in the past. Please choose a future date.`,
      };
    }

    // Two years out is almost certainly a typo (2206 instead of 2026).
    const maxAhead = new Date();
    maxAhead.setFullYear(maxAhead.getFullYear() + 2);
    if (d > maxAhead) {
      return { error: `${label} is more than two years away — please check the year.` };
    }

    return { value: d };
  }
  
  // ── Enum helpers ──────────────────────────────────────────
  
// export function requireEnum(val, allowed, fieldName) {
//   if (!val) return { error: `${fieldName} is required` };
//   if (!allowed.includes(val)) {
//     return { error: `${fieldName} must be one of: ${allowed.join(', ')}` };
//   }
//   return { value: val };
// }

export function requireEnum(val, allowed, fieldName, label = null) {
  const name = label || fieldName;
  if (!val) return { error: `${name} is required — please choose an option.` };
  if (!allowed.includes(val)) {
    return { error: `${name} isn't a valid choice. Please select one from the list.` };
  }
  return { value: val };
}
  
export function optionalEnum(val, allowed, fieldName) {
  if (!val) return { value: null };
  if (!allowed.includes(val)) {
    return { error: `${fieldName} must be one of: ${allowed.join(', ')}` };
  }
  return { value: val };
}
  
  // ── Bulk error collector ──────────────────────────────────
  // Usage:
  //   const errs = [];
  //   const title = collect(errs, requireStr(req.body.title, 'title', 200));
  //   if (errs.length) return res.status(400).json({ error: 'Validation failed', details: errs });
  
  export function collect(errArray, result) {
    if (result.error) { errArray.push(result.error); return null; }
    return result.value;
  }