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
