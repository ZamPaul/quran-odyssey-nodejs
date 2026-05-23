// src/services/whatsapp.js
// Trial booking WhatsApp notification (Meta Cloud API when configured)

function formatSlotLocal(slotStart, studentTimezone) {
  const start = new Date(slotStart);
  const dateDisplay = start.toLocaleDateString("en-GB", {
    timeZone: studentTimezone,
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  const timeDisplay = start.toLocaleTimeString("en-GB", {
    timeZone: studentTimezone,
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
  return `${dateDisplay} at ${timeDisplay}`;
}

export async function sendTrialBookingWhatsApp({
  to,
  parentName,
  childName,
  teacherName,
  courseLabel,
  slotStart,
  studentTimezone,
  bookingId,
}) {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

  if (!phoneNumberId || !accessToken) {
    console.log("[WhatsApp] Skipped — WHATSAPP_PHONE_NUMBER_ID or WHATSAPP_ACCESS_TOKEN not set");
    return { success: false, skipped: true };
  }

  if (!to) {
    console.log("[WhatsApp] Skipped — no phone number on student profile");
    return { success: false, skipped: true };
  }

  const when = formatSlotLocal(slotStart, studentTimezone);
  const ref = bookingId.toUpperCase().slice(-8);
  const digits = String(to).replace(/\D/g, "");

  const body = [
    `Assalamu alaikum ${parentName}!`,
    "",
    `${childName}'s free trial (${courseLabel}) is confirmed.`,
    `Teacher: ${teacherName}`,
    `When: ${when}`,
    `Ref: ${ref}`,
    "",
    "Quran Odyssey",
  ].join("\n");

  try {
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: digits,
          type: "text",
          text: { body },
        }),
      },
    );

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      console.error("[WhatsApp] API error:", data);
      return { success: false, error: data };
    }

    console.log(`✅ WhatsApp sent to ${digits}`);
    return { success: true, messageId: data.messages?.[0]?.id };
  } catch (err) {
    console.error("[WhatsApp] Send failed:", err.message);
    return { success: false, error: err.message };
  }
}
