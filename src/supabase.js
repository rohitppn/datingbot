// Admin-approval check for the website dashboard.
// If an admin flips "Approve" on someone in the TheBroThing backend, that
// person's WhatsApp number chats free (skips the trial/payment gate).
//
// Uses only fetch (no new dependency) and the PUBLIC anon key — it calls a
// Supabase function that returns just true/false, so no lead data is exposed.
//
// Set these in the bot's env (Railway):
//   SUPABASE_URL        = https://<project>.supabase.co
//   SUPABASE_ANON_KEY   = sb_publishable_...   (public anon key)

const URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_ANON_KEY || '';
// Service key is used ONLY for the payment webhook write (server-side, never
// exposed). Keeps the paid-unlock secure — random callers with the public anon
// key can't mark themselves paid.
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

// Called by the Razorpay webhook after a successful payment: unlock this number
// for `days` days (sets leads.paid_until). Matches on last-10-digits.
export async function markPaid(phone, days = 30) {
  if (!URL || !SERVICE_KEY || !phone) return false;
  const p10 = String(phone).replace(/\D/g, '').slice(-10);
  if (p10.length < 10) return false;
  const until = new Date(Date.now() + days * 86400000).toISOString();
  const h = { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': 'application/json' };
  try {
    // Update the lead if they filled the form...
    const res = await fetch(`${URL}/rest/v1/leads?phone10=eq.${p10}`, {
      method: 'PATCH', headers: { ...h, Prefer: 'return=representation' },
      body: JSON.stringify({ paid_until: until }),
    });
    const rows = res.ok ? await res.json() : [];
    if (Array.isArray(rows) && rows.length > 0) return true;
    // ...else create a minimal paid row (they paid without filling the form).
    const ins = await fetch(`${URL}/rest/v1/leads`, {
      method: 'POST', headers: { ...h, Prefer: 'return=minimal' },
      body: JSON.stringify({ phone: String(phone), source: 'flirtcoachai', paid_until: until }),
    });
    return ins.ok;
  } catch (e) {
    console.error('markPaid failed:', e.message);
    return false;
  }
}

// Bot config set from the website dashboard: the "free limit over" message and
// the free-window limits (minutes / message count). Any field null → bot uses
// its env/default. One fetch per message; safe with the public anon key.
export async function getBotConfig() {
  const out = { trialMessage: null, freeMinutes: null, freeMsgs: null };
  if (!URL || !KEY) return out;
  try {
    const res = await fetch(`${URL}/rest/v1/settings?id=eq.1&select=data`, {
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
    });
    if (!res.ok) return out;
    const d = (await res.json())?.[0]?.data || {};
    if (typeof d.flirt_trial_message === 'string' && d.flirt_trial_message.trim()) out.trialMessage = d.flirt_trial_message;
    const mins = parseInt(d.flirt_free_minutes, 10);
    const msgs = parseInt(d.flirt_free_msgs, 10);
    if (Number.isFinite(mins) && mins > 0) out.freeMinutes = mins;
    if (Number.isFinite(msgs) && msgs >= 0) out.freeMsgs = msgs;
    return out;
  } catch {
    return out;
  }
}

export async function isApproved(phone) {
  if (!URL || !KEY || !phone) return false;
  const p10 = String(phone).replace(/\D/g, '').slice(-10);
  if (p10.length < 10) return false;
  try {
    const res = await fetch(`${URL}/rest/v1/rpc/is_number_approved`, {
      method: 'POST',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p10 }),
    });
    if (!res.ok) return false;
    return (await res.json()) === true;
  } catch {
    return false;
  }
}
