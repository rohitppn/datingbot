import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers,
  downloadMediaMessage
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import pino from 'pino';

import {
  getUser, upsertUser, saveMessage,
  getRecentMessages, getRecentSummaries
} from './db.js';
import { checkPaymentStatus } from './sheets.js';
import { generateReply } from './claude.js';
import { unpaidReply } from './knowledge.js';
import { transcribeAudio, transcriptionEnabled } from './transcribe.js';

// Claude vision accepts these. WhatsApp usually sends jpeg; we normalize any webp to jpeg upload via Claude's native support.
const SUPPORTED_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB safety cap

const AUTH_DIR = process.env.AUTH_DIR || './auth';
const MIN_DELAY = parseInt(process.env.MIN_REPLY_DELAY_MS || '2000');
const MAX_DELAY = parseInt(process.env.MAX_REPLY_DELAY_MS || '5000');
const LANDING_URL = process.env.LANDING_PAGE_URL || 'https://yoursite.com';

const logger = pino({ level: 'warn' });

let sock = null;
// Latest WhatsApp pairing QR, exposed so the Express server can render it as a
// scannable image at /qr (easier than reading the ASCII QR out of deploy logs).
// Cleared once the connection opens (paired) so the page stops showing a stale QR.
let latestQR = null;
let latestQRAt = 0;

export function getLatestQR() {
  return { qr: latestQR, ts: latestQRAt };
}

function randomDelay() {
  return MIN_DELAY + Math.floor(Math.random() * (MAX_DELAY - MIN_DELAY));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Get the actual phone number from a Baileys message.
// Handles: regular DMs, LID-format users (Baileys 7.x privacy feature),
// group messages, and business accounts.
function getPhoneFromMessage(msg) {
  // For LID accounts, the real phone is in senderPn / participantPn
  // These are added by Baileys when the JID is a "lid" instead of a phone
  const senderPn = msg.key.senderPn || msg.key.participantPn;
  if (senderPn) {
    return senderPn.split('@')[0].split(':')[0];
  }

  // Group messages: use participant (the actual sender)
  if (msg.key.remoteJid?.endsWith('@g.us')) {
    const participant = msg.key.participant;
    if (participant) return participant.split('@')[0].split(':')[0];
  }

  // Regular DM: extract from remoteJid
  // BUT: if the JID looks like a LID (typically 13+ digits or @lid suffix), we can't trust it
  const jid = msg.key.remoteJid || '';
  if (jid.endsWith('@lid')) {
    // LID without senderPn — we don't have the real number
    console.warn(`⚠️  LID without senderPn: ${jid}. Full key:`, JSON.stringify(msg.key));
    return null;
  }

  return jid.split('@')[0].split(':')[0];
}

async function handleMessage(msg) {
  if (msg.key.fromMe) return;
  if (msg.key.remoteJid === 'status@broadcast') return;
  if (msg.key.remoteJid?.endsWith('@g.us')) return;

  const jid = msg.key.remoteJid;
  const phone = getPhoneFromMessage(msg);

  // Diagnostic log — shows raw key so we can see what WhatsApp sends
  console.log(`🔑 Raw key:`, JSON.stringify(msg.key));
  console.log(`📞 Extracted phone: ${phone}`);

  if (!phone) {
    console.warn(`⚠️  Could not extract phone — skipping message`);
    return;
  }

  // Extract text + any media (images / voice notes).
  // Images → passed to Claude as vision input.
  // Audio → transcribed via Groq Whisper, then treated as text.
  let text = null;
  let images = [];
  let storedText = null; // what we save to DB (images get a placeholder)

  try {
    if (msg.message?.conversation) {
      text = msg.message.conversation;
      storedText = text;
    } else if (msg.message?.extendedTextMessage?.text) {
      text = msg.message.extendedTextMessage.text;
      storedText = text;
    } else if (msg.message?.imageMessage) {
      const caption = (msg.message.imageMessage.caption || '').trim();
      const mimeType = msg.message.imageMessage.mimetype || 'image/jpeg';

      if (!SUPPORTED_IMAGE_MIMES.has(mimeType.split(';')[0].trim())) {
        await sock.sendMessage(jid, { text: 'is image format ko read nahi kar paya, jpeg ya png bhej.' });
        return;
      }

      const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
        logger,
        reuploadRequest: sock.updateMediaMessage
      });

      if (buffer.length > MAX_IMAGE_BYTES) {
        await sock.sendMessage(jid, { text: 'image thodi badi hai, compress karke bhej.' });
        return;
      }

      images.push({ base64: buffer.toString('base64'), mimeType: mimeType.split(';')[0].trim() });
      text = caption || 'read this screenshot and coach me on what to reply';
      storedText = caption ? `[image] ${caption}` : '[image attached]';
    } else if (msg.message?.audioMessage) {
      if (!transcriptionEnabled) {
        await sock.sendMessage(jid, { text: 'voice notes abhi support nahi kar raha. text mein bhej.' });
        return;
      }

      const mimeType = msg.message.audioMessage.mimetype || 'audio/ogg';
      const buffer = await downloadMediaMessage(msg, 'buffer', {}, {
        logger,
        reuploadRequest: sock.updateMediaMessage
      });

      const transcript = await transcribeAudio(buffer, mimeType);
      if (!transcript) {
        await sock.sendMessage(jid, { text: 'voice note khaali lagi, phir bhej.' });
        return;
      }
      text = transcript;
      storedText = `[voice] ${transcript}`;
    }
  } catch (err) {
    console.error('Media handling error:', err);
    await sock.sendMessage(jid, { text: 'kuch issue aaya read karne mein, phir try kar.' });
    return;
  }

  if (!text || text.trim().length === 0) {
    await sock.sendMessage(jid, { text: 'samajh nahi aaya, text ya screenshot bhej.' });
    return;
  }

  console.log(`📩 [${phone}] ${storedText?.substring(0, 80)}`);

  try {
    await sock.readMessages([msg.key]);
  } catch {}

  // Check payment status from Google Sheet
  const status = await checkPaymentStatus(phone);
  if (!status.isPaid) {
    console.log(`🚫 [${phone}] not paid — replying with payment prompt`);
    await sock.sendPresenceUpdate('composing', jid);
    await sleep(1500);
    await sock.sendMessage(jid, { text: unpaidReply(LANDING_URL) });
    return;
  }

  // Ensure user exists in local DB for memory tracking.
  // Sheet is the source of truth for payment; SQLite stores conversations.
  let user = getUser(phone);
  if (!user) {
    user = upsertUser({
      phone,
      name: status.name,
      payment_id: status.paymentId || 'sheet_grant',
      amount_days: 365  // long expiry — actual gate is the sheet
    });
    console.log(`👤 New user added to DB: ${status.name} (${phone})`);
  }

  saveMessage(phone, 'user', storedText || text);

  let profile = {};
  try {
    profile = JSON.parse(user.profile_json || '{}');
  } catch {}

  const summaries = getRecentSummaries(phone, 7);
  const recentMessages = getRecentMessages(phone, 20);
  const history = recentMessages.slice(0, -1);

  await sock.sendPresenceUpdate('composing', jid);

  const reply = await generateReply({
    profile,
    summaries,
    recentMessages: history,
    newMessage: text,
    images
  });

  await sleep(randomDelay());

  await sock.sendMessage(jid, { text: reply });
  saveMessage(phone, 'assistant', reply);

  await sock.sendPresenceUpdate('paused', jid);

  console.log(`💬 [${phone}] → ${reply.substring(0, 80)}`);
}

export async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`📦 Baileys WA version: ${version.join('.')} (latest: ${isLatest})`);

  sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    browser: Browsers.macOS('Desktop'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    generateHighQualityLinkPreview: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQR = qr;
      latestQRAt = Date.now();
      console.log('\n📱 Scan this QR code with your bot WhatsApp:\n');
      console.log('   (WhatsApp → Settings → Linked Devices → Link a Device)');
      console.log('   Or open the /qr link printed at startup to scan an image in your browser.\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output.statusCode
        : 0;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(`❌ Connection closed (code: ${statusCode}). Reconnecting: ${shouldReconnect}`);
      if (shouldReconnect) {
        setTimeout(startBot, 3000);
      } else {
        console.log('🚪 Logged out. Delete auth/ folder and restart to re-pair.');
      }
    } else if (connection === 'open') {
      latestQR = null; // paired — no QR to show anymore
      console.log('✅ WhatsApp connected as:', sock.user?.id);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      try {
        await handleMessage(msg);
      } catch (err) {
        console.error('Message handler error:', err);
      }
    }
  });

  return sock;
}

export function getSocket() {
  return sock;
}
