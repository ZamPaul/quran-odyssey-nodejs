// src/services/email.js
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

// ─── Template ─────────────────────────────────────────────
function trialBookingTemplate({
  parentName,
  childName,
  teacherName,
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
                  ['👩‍🏫 Teacher',  teacherName],
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

// ─── Send Functions ────────────────────────────────────────
export async function sendTrialBookingConfirmation({
  to,
  parentName,
  childName,
  teacherName,
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
    teacherName,
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


// ─── Lead confirmation email ───────────────────────────────
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

// ─── Admin notification email ──────────────────────────────
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
      to:      ['info@quranodyssey.com', 'zamielpaul@gmail.com'],
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