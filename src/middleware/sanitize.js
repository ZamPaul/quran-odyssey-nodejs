// src/middleware/sanitize.js

// ── String helpers ────────────────────────────────────────

export function cleanStr(val, maxLength = 2000) {
    if (val === null || val === undefined) return null;
    if (typeof val !== 'string') return null;
    const trimmed = val.trim();
    if (!trimmed) return null;
    return trimmed.slice(0, maxLength);
  }
  
  export function requireStr(val, fieldName, maxLength = 2000) {
    const cleaned = cleanStr(val, maxLength);
    if (!cleaned) return { error: `${fieldName} is required` };
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
  
  export function cleanFutureDate(val, fieldName = 'date') {
    if (!val) return { error: `${fieldName} is required` };
    const d = new Date(val);
    if (isNaN(d.getTime())) return { error: `${fieldName} is not a valid date` };
    if (d <= new Date()) return { error: `${fieldName} must be in the future` };
    return { value: d };
  }
  
  // ── Enum helpers ──────────────────────────────────────────
  
  export function requireEnum(val, allowed, fieldName) {
    if (!val) return { error: `${fieldName} is required` };
    if (!allowed.includes(val)) {
      return { error: `${fieldName} must be one of: ${allowed.join(', ')}` };
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