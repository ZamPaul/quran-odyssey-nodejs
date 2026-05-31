// src/services/whatsapp.js
import axios from 'axios';

const BASE_URL = 'https://graph.facebook.com/v19.0';

// ─── Format phone for WhatsApp API ────────────────────────
// Input:  "+447911123456" or "447911123456" or "07911123456"
// Output: "447911123456" (E.164 without the + sign)
function formatPhone(phone) {
  if (!phone) return null;

  // Strip everything except digits
  const digits = phone.replace(/\D/g, '');

  // UK numbers starting with 07 → replace with 447
  if (digits.startsWith('07') && digits.length === 11) {
    return '44' + digits.slice(1);
  }

  return digits;
}

// ─── Send trial booking confirmation ──────────────────────
export async function sendTrialBookingWhatsApp({
  phone,
  parentName,
  childName,
  // teacherName,
  dateDisplay,    // "Wednesday, 28 May 2026"
  timeDisplay,    // "6:00 PM – 6:30 PM (BST)"
  courseLabel,
}) {
  const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const ACCESS_TOKEN    = process.env.WHATSAPP_ACCESS_TOKEN;

  if (!PHONE_NUMBER_ID || !ACCESS_TOKEN) {
    console.error('WhatsApp env vars not configured');
    return { success: false, error: 'WhatsApp not configured' };
  }

  const formattedPhone = formatPhone(phone);

  if (!formattedPhone) {
    console.warn('No valid phone number for WhatsApp — skipping');
    return { success: false, error: 'No phone number' };
  }

  const url = `${BASE_URL}/${PHONE_NUMBER_ID}/messages`;

  const payload = {
    messaging_product: 'whatsapp',
    to:                formattedPhone,
    type:              'template',
    template: {
      name:     'trial_booking_confirmation',
      language: { code: 'en' },
      components: [
        {
          type:       'body',
          parameters: [
            { type: 'text', text: parentName   },  // {{1}}
            { type: 'text', text: childName    },  // {{2}}
            // { type: 'text', text: teacherName  },  // {{3}}
            { type: 'text', text: courseLabel  },  // {{4}}
            { type: 'text', text: dateDisplay  },  // {{5}}
            { type: 'text', text: timeDisplay  },  // {{6}}
          ],
        },
      ],
    },
  };

  try {
    const response = await axios.post(url, payload, {
      headers: {
        'Authorization': `Bearer ${ACCESS_TOKEN}`,
        'Content-Type':  'application/json',
      },
    });

    console.log(`✅ WhatsApp message sent to ${formattedPhone} — ID: ${response.data.messages?.[0]?.id}`);
    return { success: true, messageId: response.data.messages?.[0]?.id };
  } catch (err) {
    const errorData = err.response?.data?.error;
    console.error('❌ WhatsApp send failed:', errorData || err.message);
    return {
      success: false,
      error:   errorData?.message || err.message,
      code:    errorData?.code,
    };
  }
}