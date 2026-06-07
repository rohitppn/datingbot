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

// Per-boot secret so the QR page isn't publicly scannable. Whoever scans the
// pairing QR links the bot to THEIR WhatsApp, so the page must be gated.
// Override with QR_ACCESS_TOKEN to keep a stable link across restarts.
const QR_TOKEN = process.env.QR_ACCESS_TOKEN || crypto.randomUUID();

app.get('/', (req, res) => res.send('ok'));

// Renders the current WhatsApp pairing QR as a scannable image.
// Open the tokenized link printed at startup, then scan with the bot's phone.
app.get('/qr', async (req, res) => {
  if (req.query.t !== QR_TOKEN) {
    return res.status(403).send('forbidden — use the /qr link from the startup logs');
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
console.log(`📱 QR pairing page → ${QR_BASE}/qr?t=${QR_TOKEN}`);
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
