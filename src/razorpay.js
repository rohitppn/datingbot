// Razorpay payment links + webhook verification for auto-approve-on-payment.
//
// When a user hits the free limit, the bot creates a Razorpay Payment Link and
// tags it with the user's WhatsApp number (notes.phone). After they pay,
// Razorpay calls our /razorpay/webhook; we read notes.phone back and unlock
// that number for 30 days — no admin action needed.
//
// Env (Railway):
//   RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET   (Razorpay → Settings → API Keys)
//   RAZORPAY_WEBHOOK_SECRET                (Razorpay → Settings → Webhooks)
import crypto from 'crypto';

const KEY_ID = process.env.RAZORPAY_KEY_ID || '';
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || '';
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || '';

export const razorpayEnabled = () => !!(KEY_ID && KEY_SECRET);

// Create a hosted payment link for this WhatsApp number. Returns the short URL,
// or null if Razorpay isn't configured / the call fails (bot falls back to the
// static landing link so nothing breaks).
export async function createPaymentLink({ phone, amountPaise, days = 30 }) {
  if (!razorpayEnabled() || !phone || !amountPaise) return null;
  const auth = Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64');
  const digits = String(phone).replace(/\D/g, '');
  const contact = digits.length >= 10 ? '+' + digits : undefined;
  const body = {
    amount: amountPaise,
    currency: 'INR',
    accept_partial: false,
    description: `FlirtCoachAI — ${days} days unlimited access`,
    ...(contact ? { customer: { contact } } : {}),
    notify: { sms: false, email: false },
    reminder_enable: false,
    notes: { phone: String(phone), days: String(days) },
  };
  try {
    const res = await fetch('https://api.razorpay.com/v1/payment_links', {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) { console.error('Razorpay link error', res.status, (await res.text()).slice(0, 300)); return null; }
    const data = await res.json();
    return data.short_url || null;
  } catch (e) {
    console.error('Razorpay link exception:', e.message);
    return null;
  }
}

// Verify a webhook came from Razorpay (HMAC-SHA256 of the raw body).
export function verifyWebhook(rawBody, signature) {
  if (!WEBHOOK_SECRET || !signature) return false;
  try {
    const expected = crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature)));
  } catch {
    return false;
  }
}
