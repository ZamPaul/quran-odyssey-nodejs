// src/services/email.js
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

// ─── Template ─────────────────────────────────────────────
function trialBookingTemplate({
  parentName,
  childName,
  // teacherName,
  courseLabel,
  dateDisplay,    // e.g. "Wednesday, 28 May 2026"
  timeDisplay,    // e.g. "6:00 PM – 6:30 PM (BST)"
  bookingId,
}) {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Trial Class Confirmed — Quran Odyssey</title>
</head>
<body style="margin:0;padding:0;background:#f7f9fb;font-family:'Segoe UI',Arial,sans-serif;-webkit-font-smoothing:antialiased;">

  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f7f9fb;padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

          <!-- Header -->
          <tr>
            <td style="background:#0d2840;border-radius:16px 16px 0 0;padding:32px 40px;text-align:center;">
              <div style="font-size:22px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;">
                Quran <span style="color:#28b7d9;">Odyssey</span>
              </div>
              <div style="font-size:12px;font-weight:500;color:rgba(255,255,255,0.4);margin-top:4px;letter-spacing:0.5px;text-transform:uppercase;">
                Online Quran Classes
              </div>
            </td>
          </tr>

          <!-- Hero confirmation strip -->
          <tr>
            <td style="background:#28b7d9;padding:20px 40px;text-align:center;">
              <div style="font-size:13px;font-weight:700;color:rgba(255,255,255,0.85);text-transform:uppercase;letter-spacing:0.8px;">
                ✓ &nbsp; Trial Class Confirmed
              </div>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="background:#ffffff;padding:40px 40px 32px;border-left:1px solid #e2e8f0;border-right:1px solid #e2e8f0;">

              <p style="font-size:16px;font-weight:700;color:#0f172a;margin:0 0 8px;">
                Assalamu Alaikum, ${parentName} 👋
              </p>
              <p style="font-size:14px;color:#64748b;line-height:1.7;margin:0 0 28px;">
                Great news — <strong style="color:#0f172a;">${childName}'s</strong> free 30-minute trial class has been booked. Here are the details:
              </p>

              <!-- Booking details card -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#f7f9fb;border-radius:12px;border:1px solid #e2e8f0;margin-bottom:28px;">
                <tr>
                  <td style="padding:24px 24px 8px;">
                    <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:#94a3b8;margin-bottom:16px;">
                      Booking Details
                    </div>
                  </td>
                </tr>
                ${[
                  ['👤 Student',  childName],
                  ['📖 Course',   courseLabel],
                  // ['👩‍🏫 Teacher',  teacherName],
                  ['📅 Date',     dateDisplay],
                  ['⏰ Time',     timeDisplay],
                  ['🆔 Ref',      bookingId.toUpperCase().slice(-8)],
                ].map(([label, value]) => `
                <tr>
                  <td style="padding:0 24px 14px;">
                    <table width="100%" cellpadding="0" cellspacing="0">
                      <tr>
                        <td width="130" style="font-size:12px;font-weight:600;color:#94a3b8;">${label}</td>
                        <td style="font-size:13px;font-weight:700;color:#0f172a;">${value}</td>
                      </tr>
                    </table>
                  </td>
                </tr>`).join('')}
                <tr><td style="padding:0 24px 16px;"></td></tr>
              </table>

              <div style="background:#daf4fb;border-radius:10px;padding:16px 18px;margin-bottom:20px;border-left:4px solid #28b7d9;">
                <div style="font-size:13px;font-weight:700;color:#0e6e8a;margin-bottom:4px;">What happens next?</div>
                <div style="font-size:13px;color:#0e6e8a;line-height:1.7;">
                  Your trial is confirmed. A teacher will be assigned and you'll receive class details within 24 hours.
                </div>
              </div>

              <!-- Zoom link notice -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#e8f8fc;border-radius:10px;border:1px solid rgba(40,183,217,0.25);margin-bottom:28px;">
                <tr>
                  <td style="padding:18px 20px;">
                    <p style="font-size:13px;font-weight:700;color:#0e6e8a;margin:0 0 4px;">
                      📹 Zoom Link
                    </p>
                    <p style="font-size:13px;color:#0e6e8a;margin:0;line-height:1.6;">
                      Your teacher will send the Zoom link to this email <strong>at least 1 hour before class</strong>. Please check your inbox and spam folder before the session.
                    </p>
                  </td>
                </tr>
              </table>

              <!-- What to prepare -->
              <p style="font-size:13px;font-weight:700;color:#0f172a;margin:0 0 10px;">
                What to prepare:
              </p>
              <ul style="margin:0 0 28px;padding-left:20px;color:#64748b;font-size:13px;line-height:2;">
                <li>A quiet space with a stable internet connection</li>
                <li>A device with camera and microphone (laptop or tablet preferred)</li>
                <li>A Quran or Noorani Qaida if your child has one</li>
                <li>A pen and paper for notes</li>
              </ul>

              <!-- Need to reschedule -->
              <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff7e0;border-radius:10px;border:1px solid rgba(250,167,26,0.25);margin-bottom:28px;">
                <tr>
                  <td style="padding:16px 20px;">
                    <p style="font-size:13px;color:#92400e;margin:0;line-height:1.6;">
                      <strong>Need to reschedule?</strong> Reply to this email or message us on WhatsApp at least 24 hours before the class.
                    </p>
                  </td>
                </tr>
              </table>

              <p style="font-size:14px;color:#64748b;margin:0;">
                We look forward to meeting ${childName} and starting this journey together. 🤲
              </p>

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f7f9fb;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 16px 16px;padding:24px 40px;text-align:center;">
              <p style="font-size:12px;color:#94a3b8;margin:0 0 6px;">
                Quran Odyssey · Online Quran Classes · UK · USA · Canada
              </p>
              <p style="font-size:11px;color:#cbd5e1;margin:0;">
                Booking ref: ${bookingId.toUpperCase().slice(-8)} · Do not reply to this email for urgent matters — use WhatsApp.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>

</body>
</html>
  `.trim();
}

// ─── Send Functions to ────────────────────────────────────────
// trial confirmation to client
export async function sendTrialBookingConfirmation({
  to,
  parentName,
  childName,
  // teacherName,
  courseLabel,
  slotStart,        // UTC ISO string
  studentTimezone,  // IANA e.g. "Europe/London"
  bookingId,
}) {
  // Format the date and time in the student's local timezone
  const start = new Date(slotStart);
  const end   = new Date(start.getTime() + 30 * 60 * 1000);

  const dateDisplay = start.toLocaleDateString('en-GB', {
    timeZone: studentTimezone,
    weekday:  'long',
    year:     'numeric',
    month:    'long',
    day:      'numeric',
  });

  const timeStart = start.toLocaleTimeString('en-GB', {
    timeZone: studentTimezone,
    hour:     '2-digit',
    minute:   '2-digit',
  });

  const timeEnd = end.toLocaleTimeString('en-GB', {
    timeZone: studentTimezone,
    hour:     '2-digit',
    minute:   '2-digit',
  });

  // Get timezone abbreviation e.g. "BST", "EST"
  const tzAbbr = start.toLocaleTimeString('en-GB', {
    timeZone:     studentTimezone,
    timeZoneName: 'short',
  }).split(' ').pop();

  const timeDisplay = `${timeStart} – ${timeEnd} (${tzAbbr})`;

  const html = trialBookingTemplate({
    parentName,
    childName,
    // teacherName,
    courseLabel,
    dateDisplay,
    timeDisplay,
    bookingId,
  });

  try {
    const { data, error } = await resend.emails.send({
      from:    'Quran Odyssey <bookings@quranodyssey.com>',
      to:      [to],
      subject: `✓ Trial Class Confirmed — ${dateDisplay} at ${timeStart} (${tzAbbr})`,
      html,
    });

    if (error) {
      console.error('❌ Resend error:', error);
      return { success: false, error };
    }

    console.log(`✅ Booking confirmation email sent to ${to} — ID: ${data.id}`);
    return { success: true, emailId: data.id };
  } catch (err) {
    console.error('❌ Email send failed:', err.message);
    return { success: false, error: err.message };
  }
}

// ── Add this function to src/services/email.js ─────────────
export async function sendAdminTrialNotification({
  parentName,
  childName,
  parentEmail,
  phone,
  courseLabel,
  studentTimezone,
  genderPreference,
  dateDisplay,
  timeDisplay,
}) {
  const rawEmails = process.env.ADMIN_NOTIFICATION_EMAILS || '';
  const adminEmails = rawEmails
    .split(',')
    .map(e => e.trim())
    .filter(Boolean);

  if (adminEmails.length === 0) {
    console.warn('⚠️  ADMIN_NOTIFICATION_EMAILS not set — skipping admin notification');
    return;
  }

  const start = new Date(timeDisplay);
  const end   = new Date(start.getTime() + 30 * 60 * 1000);

  const timeStart = start.toLocaleTimeString('en-GB', {
    timeZone: studentTimezone,
    hour:     '2-digit',
    minute:   '2-digit',
  });

  const timeEnd = end.toLocaleTimeString('en-GB', {
    timeZone: studentTimezone,
    hour:     '2-digit',
    minute:   '2-digit',
  });

  // Get timezone abbreviation e.g. "BST", "EST"
  const tzAbbr = start.toLocaleTimeString('en-GB', {
    timeZone:     studentTimezone,
    timeZoneName: 'short',
  }).split(' ').pop();

  const newDateDisplay = start.toLocaleDateString('en-GB', {
    timeZone: studentTimezone,
    timeZoneName: "short",
    weekday:  'long',
    year:     'numeric',
    month:    'long',
    day:      'numeric',
  });

  const newTimeDisplay = `${timeStart} – ${timeEnd} (${tzAbbr})`;

  const genderLabel = {
    MALE:          'Male teacher preferred',
    FEMALE:        'Female teacher preferred',
    NO_PREFERENCE: 'No preference',
  }[genderPreference] || 'No preference';

  const html = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><title>New Trial Booking</title></head>
<body style="margin:0;padding:0;background:#f7f9fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:32px 16px;">

    <div style="background:#0d2840;border-radius:16px 16px 0 0;padding:28px 32px;">
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:#28b7d9;margin-bottom:6px;">
        Quran Odyssey
      </div>
      <div style="font-size:22px;font-weight:800;color:#ffffff;">
        🗓 New Trial Class Booked
      </div>
      <div style="font-size:13px;color:rgba(255,255,255,0.5);margin-top:4px;">
        Action required — assign a teacher
      </div>
    </div>

    <div style="background:#ffffff;border-radius:0 0 16px 16px;padding:32px;border:1px solid #e2e8f0;border-top:none;">

      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
        ${[
          ['Parent Name',        parentName],
          ['Child Name',         childName],
          ['Email',              parentEmail],
          ['Phone / WhatsApp',   phone || '—'],
          ['Course Interest',    courseLabel],
          ['Teacher Preference', genderLabel],
          ['Requested Date',     newDateDisplay],
          ['Requested Time',     newTimeDisplay],
        ].map(([label, value], i) => `
          <tr>
            <td style="padding:10px 14px;background:${i%2===0?'#f7f9fb':'#ffffff'};border:1px solid #e2e8f0;font-size:12px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.04em;width:36%;">
              ${label}
            </td>
            <td style="padding:10px 14px;background:${i%2===0?'#f7f9fb':'#ffffff'};border:1px solid #e2e8f0;font-size:13px;font-weight:600;color:#0f172a;">
              ${value}
            </td>
          </tr>`).join('')}
      </table>

      <div style="background:#fff8e7;border-radius:10px;padding:16px 18px;border-left:4px solid #faa71a;">
        <div style="font-size:13px;font-weight:700;color:#92400e;margin-bottom:4px;">
          Next Step
        </div>
        <div style="font-size:13px;color:#92400e;line-height:1.6;">
          1. Assign an appropriate teacher in Supabase → <strong>trial_bookings</strong> table → update <strong>teacherId</strong><br/>
          2. Create a Zoom link and share it with the student<br/>
          3. Event is visible in the <strong>Quran Odyssey — Trial Classes</strong> Google Calendar
        </div>
      </div>

      <p style="font-size:12px;color:#94a3b8;margin-top:20px;border-top:1px solid #e2e8f0;padding-top:16px;">
        Sent automatically by Quran Odyssey platform on booking confirmation.
      </p>
    </div>
  </div>
</body>
</html>`;

  const { error } = await resend.emails.send({
    from:    'Quran Odyssey <bookings@quranodyssey.com>',
    to:      adminEmails,
    subject: `New Trial Booking — ${childName} | ${dateDisplay} at ${timeDisplay}`,
    html,
  });

  if (error) throw new Error(`Admin notification failed: ${JSON.stringify(error)}`);
  console.log(`✅ Admin trial notification sent to: ${adminEmails.join(', ')}`);
}

// ─── Lead confirmation email to client ───────────────────────────────
export async function sendLeadConfirmationEmail({ to, firstName }) {
  const html = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/></head>
<body style="margin:0;padding:0;background:#f7f9fb;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">

        <tr>
          <td style="background:#0d2840;border-radius:16px 16px 0 0;padding:32px 40px;text-align:center;">
            <div style="font-size:22px;font-weight:800;color:#fff;">
              Quran <span style="color:#28b7d9;">Odyssey</span>
            </div>
          </td>
        </tr>

        <tr>
          <td style="background:#28b7d9;padding:16px 40px;text-align:center;">
            <div style="font-size:13px;font-weight:700;color:rgba(255,255,255,0.9);text-transform:uppercase;letter-spacing:0.8px;">
              ✓ &nbsp; We've received your request
            </div>
          </td>
        </tr>

        <tr>
          <td style="background:#fff;padding:40px;border:1px solid #e2e8f0;border-top:none;">
            <p style="font-size:16px;font-weight:700;color:#0f172a;margin:0 0 12px;">
              Assalamu Alaikum, ${firstName}! 👋
            </p>
            <p style="font-size:14px;color:#64748b;line-height:1.75;margin:0 0 24px;">
              Thank you for your interest in Quran Odyssey. We've received your request and one of our team members will be in touch within <strong style="color:#0f172a;">2 hours</strong> to arrange your child's free trial class.
            </p>

            <table width="100%" cellpadding="0" cellspacing="0" style="background:#f7f9fb;border-radius:12px;border:1px solid #e2e8f0;margin-bottom:24px;">
              <tr><td style="padding:20px 24px;">
                <div style="font-size:13px;font-weight:700;color:#0f172a;margin-bottom:12px;">What to expect:</div>
                <table cellpadding="0" cellspacing="0">
                  ${[
                    ['📞', 'We contact you on WhatsApp or email to confirm a time'],
                    ['👩‍🏫', 'We match your child with the right teacher for their level'],
                    ['🎓', '30-minute free trial class — no commitment required'],
                    ['📊', 'Teacher recommends the right course and starting point'],
                  ].map(([icon, text]) => `
                  <tr>
                    <td style="padding:6px 12px 6px 0;font-size:16px;vertical-align:top;">${icon}</td>
                    <td style="padding:6px 0;font-size:13px;color:#64748b;line-height:1.6;">${text}</td>
                  </tr>`).join('')}
                </table>
              </td></tr>
            </table>

            <table width="100%" cellpadding="0" cellspacing="0" style="background:#e8f8fc;border-radius:10px;border:1px solid rgba(40,183,217,0.25);margin-bottom:24px;">
              <tr><td style="padding:16px 20px;">
                <p style="font-size:13px;color:#0e6e8a;margin:0;line-height:1.6;">
                  <strong>Need to reach us sooner?</strong> Message us directly on WhatsApp for the fastest response.
                </p>
              </td></tr>
            </table>

            <p style="font-size:14px;color:#64748b;margin:0;">
              Jazakallah Khayran,<br/>
              <strong style="color:#0f172a;">The Quran Odyssey Team</strong>
            </p>
          </td>
        </tr>

        <tr>
          <td style="background:#f7f9fb;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 16px 16px;padding:20px 40px;text-align:center;">
            <p style="font-size:11px;color:#cbd5e1;margin:0;">
              Quran Odyssey · UK · USA · Canada · quranodyssey.com
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>
  `.trim();

  try {
    const { data, error } = await resend.emails.send({
      from:    'Quran Odyssey <bookings@quranodyssey.com>',
      to:      [to],
      subject: "We've received your request — Quran Odyssey",
      html,
    });

    if (error) {
      console.error('Lead confirmation email error:', error);
      return { success: false };
    }

    console.log(`✅ Lead confirmation sent to ${to}`);
    return { success: true };
  } catch (err) {
    console.error('Lead confirmation email failed:', err.message);
    return { success: false };
  }
}

// ─── Admin notification email to admins ──────────────────────────────
export async function sendAdminLeadNotification({ firstName, lastName, email, phone, leadId }) {
  const html = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:0;background:#f7f9fb;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

        <tr>
          <td style="background:#0d2840;border-radius:14px 14px 0 0;padding:24px 32px;">
            <div style="font-size:16px;font-weight:800;color:white;">
              🔔 New Trial Lead
            </div>
            <div style="font-size:12px;color:rgba(255,255,255,0.4);margin-top:4px;">
              Submitted via landing page · ${new Date().toLocaleString('en-GB')}
            </div>
          </td>
        </tr>

        <tr>
          <td style="background:white;padding:28px 32px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 14px 14px;">
            ${[
              ['Name',  `${firstName} ${lastName}`],
              ['Email', email],
              ['Phone', phone],
              ['Lead ID', leadId.slice(-8).toUpperCase()],
            ].map(([label, value]) => `
            <div style="display:flex;justify-content:space-between;padding:12px 0;border-bottom:1px solid #f0f4f8;">
              <span style="font-size:12px;color:#94a3b8;font-weight:600;">${label}</span>
              <span style="font-size:13px;color:#0f172a;font-weight:700;">${value}</span>
            </div>`).join('')}

            <div style="margin-top:20px;padding:14px 16px;background:#e8f8fc;border-radius:8px;border:1px solid rgba(40,183,217,0.2);">
              <div style="font-size:12px;font-weight:700;color:#0e6e8a;">Action needed:</div>
              <div style="font-size:12px;color:#0e6e8a;margin-top:4px;line-height:1.6;">
                Contact this lead within 2 hours via WhatsApp or email to arrange their trial class.
              </div>
            </div>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>
  `.trim();

  try {
    const { data, error } = await resend.emails.send({
      from:    'Quran Odyssey System <bookings@quranodyssey.com>',
      to:      ['zamielpaul@gmail.com', 'irhaasif@gmail.com', 'waqarbasit61@gmail.com', 'mahilmalik23@gmail.com'],
      subject: `🔔 New Trial Lead: ${firstName} ${lastName}`,
      html,
    });

    if (error) {
      console.error('Admin notification email error:', error);
      return { success: false };
    }

    return { success: true };
  } catch (err) {
    console.error('Admin notification failed:', err.message);
    return { success: false };
  }
}

// Add this function to your existing src/services/email.js
export async function sendProgressReport({
  parentEmail,
  parentName,
  childName,
  teacherName,
  period,
  courseType,
  overallRating,
  tajweedProgress,
  recitationNotes,
  behaviourNotes,
  homeworkNotes,
  attachmentUrl,        // ← NEW
  attachmentName,       // ← NEW
  isResend = false,     // ← NEW
  teacherMessage,
  nextSteps,
}) {
  const stars     = '⭐'.repeat(overallRating || 0);
  const noStars   = '☆'.repeat(5 - (overallRating || 0));
  const ratingStr = overallRating ? `${stars}${noStars} (${overallRating}/5)` : 'Not rated';

  const courseLabel = {
    NOORANI_QAIDA:    'Noorani Qaida',
    QURAN_RECITATION: 'Quran Recitation',
    TAJWEED:          'Tajweed',
    HIFZ:             'Hifz Programme',
    ISLAMIC_STUDIES:  'Islamic Studies',
    ONE_TO_ONE:       'One-to-One Classes',
  }[courseType] || courseType;

  // Build optional sections — only include what the teacher filled in
  const sections = [];

  if (tajweedProgress) {
    sections.push(`
      <tr>
        <td style="padding: 12px 0; border-bottom: 1px solid #e2e8f0;">
          <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #94a3b8; margin-bottom: 4px;">Tajweed Progress</div>
          <div style="font-size: 14px; color: #334155; line-height: 1.6;">${tajweedProgress}</div>
        </td>
      </tr>`);
  }

  if (recitationNotes) {
    sections.push(`
      <tr>
        <td style="padding: 12px 0; border-bottom: 1px solid #e2e8f0;">
          <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #94a3b8; margin-bottom: 4px;">Recitation</div>
          <div style="font-size: 14px; color: #334155; line-height: 1.6;">${recitationNotes}</div>
        </td>
      </tr>`);
  }

  if (behaviourNotes) {
    sections.push(`
      <tr>
        <td style="padding: 12px 0; border-bottom: 1px solid #e2e8f0;">
          <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #94a3b8; margin-bottom: 4px;">Behaviour & Attitude</div>
          <div style="font-size: 14px; color: #334155; line-height: 1.6;">${behaviourNotes}</div>
        </td>
      </tr>`);
  }

  if (homeworkNotes) {
    sections.push(`
      <tr>
        <td style="padding: 12px 0; border-bottom: 1px solid #e2e8f0;">
          <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #94a3b8; margin-bottom: 4px;">Homework & Practice</div>
          <div style="font-size: 14px; color: #334155; line-height: 1.6;">${homeworkNotes}</div>
        </td>
      </tr>`);
  }

  if (nextSteps) {
    sections.push(`
      <tr>
        <td style="padding: 12px 0;">
          <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #94a3b8; margin-bottom: 4px;">Next Steps</div>
          <div style="font-size: 14px; color: #334155; line-height: 1.6;">${nextSteps}</div>
        </td>
      </tr>`);
  }

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Progress Report — ${childName}</title>
</head>
<body style="margin: 0; padding: 0; background: #f7f9fb; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;">

  <div style="max-width: 600px; margin: 0 auto; padding: 32px 16px;">

    <!-- Header -->
    <div style="background: #0d2840; border-radius: 16px 16px 0 0; padding: 32px 36px;">
      <div style="font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.8px; color: #28b7d9; margin-bottom: 8px;">
        Quran Odyssey
      </div>
      <div style="font-size: 24px; font-weight: 800; color: #ffffff; line-height: 1.2;">
        Progress Report
      </div>
      <div style="font-size: 14px; color: rgba(255,255,255,0.5); margin-top: 6px;">
        ${period} · ${courseLabel}
      </div>
    </div>

    <!-- Body -->
    <div style="background: #ffffff; border-radius: 0 0 16px 16px; padding: 36px; border: 1px solid #e2e8f0; border-top: none;">

      <!-- Greeting -->
      <p style="font-size: 15px; color: #0f172a; margin: 0 0 8px; font-weight: 600;">
        As-salamu alaykum, ${parentName},
      </p>
      <p style="font-size: 14px; color: #64748b; line-height: 1.7; margin: 0 0 28px;">
        Here is ${childName}'s progress report for <strong>${period}</strong>, prepared by <strong>${teacherName}</strong>.
      </p>

      ${isResend ? `
        <div style="background:#fff7e0;border:1px solid rgba(245,158,11,0.3);border-radius:8px;padding:12px 16px;margin-bottom:20px;">
          <div style="font-size:13px;color:#92400e;font-weight:600;">
            📝 This is an updated version of ${childName}'s ${period} report.
          </div>
        </div>
      ` : ''}

      <!-- Overall rating -->
      <div style="background: #f7f9fb; border-radius: 10px; padding: 18px 20px; margin-bottom: 28px; display: flex; alignItems: center; justifyContent: space-between;">
        <div>
          <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #94a3b8; margin-bottom: 4px;">Overall Rating</div>
          <div style="font-size: 18px; text-align:bottom">${ratingStr}</div>
        </div>
        <div style="text-align: right; margin-left: 70px;">
          <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #94a3b8; margin-bottom: 4px;">Student</div>
          <div style="font-size: 14px; font-weight: 700; color: #0f172a;">${childName}</div>
        </div>
      </div>

      <!-- Dynamic sections -->
      ${sections.length > 0 ? `
        <table style="width: 100%; border-collapse: collapse; margin-bottom: 28px;">
          <tbody>
            ${sections.join('')}
          </tbody>
        </table>
      ` : ''}

      <!-- Teacher's personal message -->
      ${teacherMessage ? `
        <div style="background: linear-gradient(135deg, #daf4fb, #c2eaf9); border-radius: 10px; padding: 20px; margin-bottom: 28px; border-left: 4px solid #28b7d9;">
          <div style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #0e6e8a; margin-bottom: 8px;">
            Message from ${teacherName}
          </div>
          <div style="font-size: 14px; color: #0e6e8a; line-height: 1.7; font-style: italic;">
            "${teacherMessage}"
          </div>
        </div>
      ` : ''}

      ${attachmentUrl ? `
        <div style="margin-bottom:28px;">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#94a3b8;margin-bottom:10px;">
            Attachment
          </div>
          <a href="${attachmentUrl}" target="_blank"
              style="display:inline-block;background:#28b7d9;color:#ffffff;text-decoration:none;
                    font-size:14px;font-weight:700;padding:12px 22px;border-radius:8px;">
            📎 View ${attachmentName || 'attached file'}
          </a>
        </div>
      ` : ''}

      <!-- Footer note -->
      <p style="font-size: 13px; color: #94a3b8; line-height: 1.6; border-top: 1px solid #e2e8f0; padding-top: 20px; margin: 0;">
        This report was sent from Quran Odyssey on behalf of ${teacherName}. 
        If you have any questions, reply to this email or message us on WhatsApp.
      </p>
    </div>

    <!-- Footer -->
    <div style="text-align: center; padding: 20px 0; font-size: 12px; color: #94a3b8;">
      © 2026 Quran Odyssey
    </div>
  </div>

</body>
</html>`;

  const { data, error } = await resend.emails.send({
    from:    'Quran Odyssey <reports@quranodyssey.com>',
    to:      parentEmail,
    subject: `${childName}'s Progress Report — ${period}`,
    html,
  });

  if (error) {
    throw new Error(`Resend error: ${JSON.stringify(error)}`);
  }

  return data;
}

// ─────────────────────────────────────────────────────────
// ENROLLMENT EMAILS — append these to src/services/email.js
// ─────────────────────────────────────────────────────────

// ─── sendEnrollmentAdminNotification ─────────────────────
// Fired when a student submits an enrollment application.
// Sends to ADMIN_NOTIFICATION_EMAILS env var.
export async function sendEnrollmentAdminNotification({
  applicationId,
  parentName,
  childName,
  parentEmail,
  phone,
  courseLabel,
  genderPreference,
  preferredDays,
  preferredTime,
  message,
}) {
  const rawEmails   = process.env.ADMIN_NOTIFICATION_EMAILS || '';
  const adminEmails = rawEmails.split(',').map(e => e.trim()).filter(Boolean);

  if (adminEmails.length === 0) {
    console.warn('⚠️  ADMIN_NOTIFICATION_EMAILS not set — skipping enrollment admin notification');
    return;
  }

  const genderLabel = { MALE: 'Male teacher preferred', FEMALE: 'Female teacher preferred', NO_PREFERENCE: 'No preference' }[genderPreference] || 'No preference';
  const timeLabel   = { MORNING: 'Morning (9am–12pm)', AFTERNOON: 'Afternoon (12pm–5pm)', EVENING: 'Evening (5pm–9pm)' }[preferredTime] || preferredTime;

  const html = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><title>New Enrollment Application</title></head>
<body style="margin:0;padding:0;background:#f7f9fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:580px;margin:0 auto;padding:32px 16px;">
    <div style="background:#0d2840;border-radius:16px 16px 0 0;padding:28px 32px;">
      <div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.8px;color:#28b7d9;margin-bottom:6px;">Quran Odyssey</div>
      <div style="font-size:22px;font-weight:800;color:#ffffff;">📋 New Enrollment Application</div>
      <div style="font-size:13px;color:rgba(255,255,255,0.5);margin-top:4px;">Action required — review and approve or reject</div>
    </div>
    <div style="background:#ffffff;border-radius:0 0 16px 16px;padding:32px;border:1px solid #e2e8f0;border-top:none;">
      <table style="width:100%;border-collapse:collapse;margin-bottom:24px;">
        ${[
          ['Application ID', applicationId.slice(-10).toUpperCase()],
          ['Parent Name',    parentName],
          ['Child Name',     childName],
          ['Email',          parentEmail],
          ['Phone',          phone || '—'],
          ['Course',         courseLabel],
          ['Teacher Pref',   genderLabel],
          ['Preferred Days', preferredDays.join(', ')],
          ['Preferred Time', timeLabel],
        ].map(([label, value], i) => `
          <tr>
            <td style="padding:10px 14px;background:${i%2===0?'#f7f9fb':'#fff'};border:1px solid #e2e8f0;font-size:12px;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.04em;width:36%;">${label}</td>
            <td style="padding:10px 14px;background:${i%2===0?'#f7f9fb':'#fff'};border:1px solid #e2e8f0;font-size:13px;font-weight:600;color:#0f172a;">${value}</td>
          </tr>`).join('')}
      </table>
      ${message ? `
      <div style="background:#f7f9fb;border-radius:10px;padding:16px 18px;margin-bottom:20px;border-left:4px solid #28b7d9;">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#94a3b8;margin-bottom:6px;">Student Message</div>
        <div style="font-size:13px;color:#334155;line-height:1.7;">${message}</div>
      </div>` : ''}
      <div style="background:#fff8e7;border-radius:10px;padding:16px 18px;border-left:4px solid #faa71a;">
        <div style="font-size:13px;font-weight:700;color:#92400e;margin-bottom:4px;">Next Step</div>
        <div style="font-size:13px;color:#92400e;line-height:1.6;">
          Review this application in the Admin Panel's → <strong>Enrollment Requests</strong> tab.<br/>
          Update <strong>status</strong> to <strong>APPROVED</strong> or <strong>REJECTED</strong><br/>
          The student will receive an automated email notification.
        </div>
      </div>
      <p style="font-size:12px;color:#94a3b8;margin-top:20px;border-top:1px solid #e2e8f0;padding-top:16px;">
        Sent automatically by Quran Odyssey platform on enrollment application submission.
      </p>
    </div>
  </div>
</body>
</html>`;

  const { error } = await resend.emails.send({
    from:    'Quran Odyssey <bookings@quranodyssey.com>',
    to:      adminEmails,
    subject: `New Enrollment Application — ${childName} | ${courseLabel}`,
    html,
  });

  if (error) throw new Error(`Enrollment admin notification failed: ${JSON.stringify(error)}`);
  console.log(`✅ Enrollment admin notification sent to: ${adminEmails.join(', ')}`);
}

// ─── sendEnrollmentApproved ───────────────────────────────
// Fired when admin approves an enrollment application.
export async function sendEnrollmentApproved({
  to,
  parentName,
  childName,
  courseLabel,
  applicationId,
}) {
  const html = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><title>Enrollment Approved — Quran Odyssey</title></head>
<body style="margin:0;padding:0;background:#f7f9fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
        <tr>
          <td style="background:#0d2840;border-radius:16px 16px 0 0;padding:32px 40px;text-align:center;">
            <div style="font-size:22px;font-weight:800;color:#fff;">Quran <span style="color:#28b7d9;">Odyssey</span></div>
          </td>
        </tr>
        <tr>
          <td style="background:#22c55e;padding:16px 40px;text-align:center;">
            <div style="font-size:13px;font-weight:700;color:rgba(255,255,255,0.95);text-transform:uppercase;letter-spacing:0.8px;">✓ &nbsp; Enrollment Application Approved</div>
          </td>
        </tr>
        <tr>
          <td style="background:#fff;padding:40px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 16px 16px;">
            <p style="font-size:16px;font-weight:700;color:#0f172a;margin:0 0 12px;">Assalamu Alaikum, ${parentName}! 🎉</p>
            <p style="font-size:14px;color:#64748b;line-height:1.75;margin:0 0 24px;">
              Great news — <strong style="color:#0f172a;">${childName}'s</strong> enrollment application for <strong style="color:#0f172a;">${courseLabel}</strong> has been <strong style="color:#22c55e;">approved</strong>.
            </p>
            <div style="background:#dcfce7;border-radius:10px;padding:20px 24px;margin-bottom:24px;border-left:4px solid #22c55e;">
              <div style="font-size:14px;font-weight:700;color:#166534;margin-bottom:6px;">What happens next?</div>
              <div style="font-size:13px;color:#166534;line-height:1.75;">
                We are now preparing ${childName}'s course and matching them with the right teacher.<br/>
                You will receive full payment and scheduling details within <strong>24 hours</strong>.
              </div>
            </div>
            <p style="font-size:14px;color:#64748b;margin:0 0 6px;">
              In the meantime, you can check your application status in your student dashboard.
            </p>
            <p style="font-size:12px;color:#94a3b8;margin:24px 0 0;border-top:1px solid #e2e8f0;padding-top:16px;">
              Ref: ${applicationId.slice(-10).toUpperCase()} · Quran Odyssey · UK · USA · Canada
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const { data, error } = await resend.emails.send({
    from:    'Quran Odyssey <bookings@quranodyssey.com>',
    to:      [to],
    subject: `✓ Enrollment Approved — ${childName} | ${courseLabel}`,
    html,
  });

  if (error) {
    console.error('Enrollment approved email error:', error);
    return { success: false };
  }
  console.log(`✅ Enrollment approved email sent to ${to} — ID: ${data.id}`);
  return { success: true };
}

// ─── sendEnrollmentRejected ───────────────────────────────
// Fired when admin rejects an enrollment application.
export async function sendEnrollmentRejected({
  to,
  parentName,
  childName,
  courseLabel,
  rejectionReason,
}) {
  const html = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"/><title>Enrollment Update — Quran Odyssey</title></head>
<body style="margin:0;padding:0;background:#f7f9fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
        <tr>
          <td style="background:#0d2840;border-radius:16px 16px 0 0;padding:32px 40px;text-align:center;">
            <div style="font-size:22px;font-weight:800;color:#fff;">Quran <span style="color:#28b7d9;">Odyssey</span></div>
          </td>
        </tr>
        <tr>
          <td style="background:#fff;padding:40px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 16px 16px;">
            <p style="font-size:16px;font-weight:700;color:#0f172a;margin:0 0 12px;">Assalamu Alaikum, ${parentName},</p>
            <p style="font-size:14px;color:#64748b;line-height:1.75;margin:0 0 24px;">
              Thank you for applying to enroll <strong style="color:#0f172a;">${childName}</strong> in <strong style="color:#0f172a;">${courseLabel}</strong>. Unfortunately, we are unable to approve this application at this time.
            </p>
            <div style="background:#fff7f7;border-radius:10px;padding:20px 24px;margin-bottom:24px;border-left:4px solid #ef4444;">
              <div style="font-size:13px;font-weight:700;color:#991b1b;margin-bottom:6px;">Reason</div>
              <div style="font-size:13px;color:#991b1b;line-height:1.75;">${rejectionReason}</div>
            </div>
            <p style="font-size:14px;color:#64748b;line-height:1.75;margin:0 0 24px;">
              This does not prevent you from applying again. If you have questions or would like to discuss alternatives, please reach out to us on WhatsApp — we are happy to help find the right solution for ${childName}.
            </p>
            <p style="font-size:12px;color:#94a3b8;margin:24px 0 0;border-top:1px solid #e2e8f0;padding-top:16px;">
              Quran Odyssey · UK · USA · Canada · quranodyssey.com
            </p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const { data, error } = await resend.emails.send({
    from:    'Quran Odyssey <bookings@quranodyssey.com>',
    to:      [to],
    subject: `Enrollment Application Update — ${courseLabel}`,
    html,
  });

  if (error) {
    console.error('Enrollment rejected email error:', error);
    return { success: false };
  }
  console.log(`✅ Enrollment rejected email sent to ${to} — ID: ${data.id}`);
  return { success: true };
}