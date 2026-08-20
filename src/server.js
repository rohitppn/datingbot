// Main entry: Express health server + WhatsApp bot + nightly memory cron.
// Step logs are intentional so a failed boot shows exactly where it stopped.
console.log('1. Script started');

import 'dotenv/config';
console.log('2. dotenv loaded');

console.log('   ANTHROPIC_API_KEY present:', !!process.env.ANTHROPIC_API_KEY);
console.log('   GOOGLE_SHEET_ID present:', !!process.env.GOOGLE_SHEET_ID);
console.log('   PORT:', process.env.PORT || '(not set)');

import express from 'express';
console.log('3. express loaded');

import crypto from 'crypto';
console.log('4. crypto loaded');

import QRCode from 'qrcode';
console.log('4b. qrcode loaded');

import cron from 'node-cron';
console.log('5. cron loaded');

console.log('6. About to import db.js...');
const db = await import('./db.js');
console.log('7. db.js loaded');

console.log('8. About to import sheets.js...');
const sheets = await import('./sheets.js');
console.log('9. sheets.js loaded');

console.log('10. About to import bot.js...');
const bot = await import('./bot.js');
console.log('11. bot.js loaded');

const razorpay = await import('./razorpay.js');
const supa = await import('./supabase.js');

console.log('12. About to import dailyMemoryUpdate.js...');
const job = await import('./jobs/dailyMemoryUpdate.js');
console.log('13. dailyMemoryUpdate.js loaded');

// Nightly memory job: summarize each active user's day + refresh their profile.
// (Previously imported but never scheduled — so summaries/profiles never updated.)
const MEMORY_CRON = process.env.MEMORY_CRON || '30 3 * * *'; // default 3:30 AM daily
const MEMORY_TZ = process.env.TZ || 'Asia/Kolkata';
cron.schedule(
  MEMORY_CRON,
  async () => {
    console.log('⏰ Running nightly memory update...');
    try {
      await job.runDailyMemoryUpdate();
    } catch (err) {
      console.error('❌ Nightly memory update failed:', err.message);
    }
  },
  { timezone: MEMORY_TZ }
);
console.log(`🗓️  Nightly memory job scheduled (${MEMORY_CRON}, ${MEMORY_TZ})`);

const app = express();
console.log('14. express app created');

const PORT = process.env.PORT || 3000;

// QR page gating is OPTIONAL. By default /qr is open so pairing is one click.
// The QR only exists during the brief pre-pairing window (it disappears once
// the bot links), so open access is low-risk. If you want it locked down, set
// QR_ACCESS_TOKEN and the page will then require ?t=<token>.
const QR_TOKEN = process.env.QR_ACCESS_TOKEN || null;

app.get('/', (req, res) => res.send('ok'));

// Razorpay webhook — fires when a user pays. We verify the signature, read the
// WhatsApp number we stamped into the payment link's notes, and unlock that
// number for 30 days. Uses raw body (required for signature verification).
app.post('/razorpay/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    const raw = req.body; // Buffer
    const sig = req.headers['x-razorpay-signature'];
    if (!razorpay.verifyWebhook(raw, sig)) {
      console.warn('⚠️  Razorpay webhook: bad signature');
      return res.status(400).send('invalid signature');
    }
    const evt = JSON.parse(raw.toString('utf8'));
    if (evt.event === 'payment_link.paid') {
      const notes = evt.payload?.payment_link?.entity?.notes || {};
      const phone = notes.phone;
      const days = parseInt(notes.days || '30', 10);
      if (phone) {
        const ok = await supa.markPaid(phone, days);
        console.log(`💰 payment_link.paid → ${phone} unlocked ${days}d (${ok ? 'ok' : 'FAILED'})`);
      } else {
        console.warn('⚠️  paid event had no notes.phone');
      }
    }
    res.json({ ok: true });
  } catch (e) {
    console.error('Razorpay webhook error:', e.message);
    res.status(200).json({ ok: false }); // 200 so Razorpay doesn't retry-storm
  }
});

// Renders the current WhatsApp pairing QR as a scannable image.
// Open the link printed at startup, then scan with the bot's phone.
app.get('/qr', async (req, res) => {
  if (QR_TOKEN && req.query.t !== QR_TOKEN) {
    return res.status(403).send('forbidden — append ?t=YOUR_QR_ACCESS_TOKEN to the URL');
  }
  const { qr, ts } = bot.getLatestQR();
  if (!qr) {
    return res.send(
      '<!doctype html><meta http-equiv="refresh" content="3">' +
      '<body style="font-family:sans-serif;text-align:center;padding:40px">' +
      '<h2>No QR right now</h2><p>The bot is either already paired or still starting. ' +
      'This page refreshes automatically.</p></body>'
    );
  }
  try {
    const dataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 2 });
    const ageSec = Math.round((Date.now() - ts) / 1000);
    res.send(
      '<!doctype html><meta http-equiv="refresh" content="20">' +
      '<body style="font-family:sans-serif;text-align:center;padding:40px">' +
      '<h2>Scan with your bot\'s WhatsApp</h2>' +
      '<p>WhatsApp → Settings → Linked Devices → Link a Device</p>' +
      `<img src="${dataUrl}" width="320" height="320" alt="WhatsApp QR"/>` +
      `<p style="color:#888">QR age: ${ageSec}s · page auto-refreshes every 20s</p>` +
      '</body>'
    );
  } catch (err) {
    res.status(500).send('failed to render QR: ' + err.message);
  }
});

console.log('15. About to start listening on port', PORT);
const server = app.listen(PORT, () => {
  console.log('16. ✅ Server listening on port', PORT);
});

server.on('error', (err) => {
  console.error('17. ❌ Server error:', err.message);
});

// Build the public QR link. On Railway, RAILWAY_PUBLIC_DOMAIN is set once you
// generate a domain (Settings → Networking). Locally it falls back to localhost.
const QR_BASE = process.env.RAILWAY_PUBLIC_DOMAIN
  ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
  : `http://localhost:${PORT}`;
const QR_LINK = QR_TOKEN ? `${QR_BASE}/qr?t=${QR_TOKEN}` : `${QR_BASE}/qr`;
console.log(`📱 QR pairing page → ${QR_LINK}`);
console.log('   Open that link in a browser tab to scan the QR as an image.');

console.log('18. About to start WhatsApp bot...');
try {
  await bot.startBot();
  console.log('19. ✅ Bot started successfully');
} catch (err) {
  console.error('19. ❌ Bot start failed:', err.message);
  console.error(err.stack);
}

console.log('20. ✨ All systems online — process should now stay alive');
