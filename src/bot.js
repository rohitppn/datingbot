import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  downloadMediaMessage,
  downloadContentFromMessage
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import fs from 'fs';
import path from 'path';

import {
  getUser, upsertUser, saveMessage,
  getRecentMessages, getRecentSummaries,
  startTrial, incrementFreeUsage
} from './db.js';
import { checkPaymentStatus } from './sheets.js';
import { isApproved, getBotConfig } from './supabase.js';
import { generateReply } from './claude.js';
import { trialEndedReply } from './knowledge.js';
import { transcribeAudio, transcriptionEnabled } from './transcribe.js';

// Claude vision accepts these. WhatsApp usually sends jpeg; we normalize any webp to jpeg upload via Claude's native support.
const SUPPORTED_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB safety cap

const AUTH_DIR = process.env.AUTH_DIR || './auth';
// If set (digits only, e.g. 917303965115), the bot logs in via an 8-char
// pairing CODE instead of a QR — more reliable on headless servers.
const PAIRING_NUMBER = (process.env.PAIRING_NUMBER || '').replace(/[^0-9]/g, '');
const MIN_DELAY = parseInt(process.env.MIN_REPLY_DELAY_MS || '2000');
const MAX_DELAY = parseInt(process.env.MAX_REPLY_DELAY_MS || '5000');
const LANDING_URL = process.env.LANDING_PAGE_URL || 'https://yoursite.com';
// Free window for unpaid users (from their first message): time in MINUTES and/or
// a message-count cap. Whichever hits first locks them to the payment prompt.
// Dashboard values override these; 0 for messages disables that cap.
const FREE_MINUTES_ENV = parseInt(process.env.FREE_TRIAL_MINUTES || '10', 10);
const FREE_MSGS_ENV = parseInt(process.env.FREE_MSG_LIMIT || '20', 10);

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

// --- Connection lifecycle hardening ---------------------------------------
// "conflict / device_removed" (status 401) means the WhatsApp session was used
// from two places at once, or the link was revoked. We:
//   1. never hold two live sockets (a duplicate triggers the conflict),
//   2. back off and reconnect through a single timer,
//   3. auto-clear dead auth so /qr serves a fresh QR instead of getting stuck,
//   4. bail out if logouts storm (a sign a second instance is fighting us).
let connecting = false;
let reconnectTimer = null;
let recentLogouts = [];

function scheduleReconnect(delayMs) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startBot().catch(err => console.error('Reconnect failed:', err.message));
  }, delayMs);
}

// Empty the auth dir's CONTENTS (not the dir itself — it's a Railway volume
// mount point) so the next connect generates a fresh pairing QR.
function clearAuthState() {
  try {
    if (fs.existsSync(AUTH_DIR)) {
      for (const f of fs.readdirSync(AUTH_DIR)) {
        fs.rmSync(path.join(AUTH_DIR, f), { recursive: true, force: true });
      }
    }
    latestQR = null;
    console.log('🧹 Cleared stale auth — a fresh QR will be generated on reconnect.');
  } catch (err) {
    console.error('Failed to clear auth state:', err.message);
  }
}

// True if we've logged out too many times in a short window — clearing auth
// won't help when another running instance keeps stealing the session.
function logoutStorm() {
  const now = Date.now();
  recentLogouts = recentLogouts.filter(t => now - t < 5 * 60 * 1000);
  recentLogouts.push(now);
  return recentLogouts.length > 4;
}

function randomDelay() {
  return MIN_DELAY + Math.floor(Math.random() * (MAX_DELAY - MIN_DELAY));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Robustly download media (screenshots especially). WhatsApp/Baileys downloads
// fail intermittently — when they do and we proceed anyway, Claude gets text
// with no image and says "I can't see images". So we try hard and only ever
// return a NON-EMPTY buffer, else throw (caller then asks the user to resend).
//   1. high-level helper (handles media re-upload) — retried once
//   2. low-level stream straight off the media node — the most reliable path
async function streamToBuffer(stream) {
  let buffer = Buffer.from([]);
  for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
  return buffer;
}

async function downloadMediaBuffer(msg) {
  // 1) high-level helper, retried once
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const b = await downloadMediaMessage(msg, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage });
      if (b && b.length > 0) return b;
      console.error(`⚠️  downloadMediaMessage returned empty (attempt ${attempt})`);
    } catch (err) {
      console.error(`⚠️  downloadMediaMessage failed (attempt ${attempt}): ${err.message}`);
    }
    if (attempt < 2) await sleep(900);
  }

  // 2) low-level fallback straight off the media node
  const m = msg.message || {};
  const node = m.imageMessage || m.documentMessage || m.audioMessage || m.videoMessage;
  const type = m.imageMessage ? 'image' : m.documentMessage ? 'document' : m.audioMessage ? 'audio' : 'video';
  if (!node) throw new Error('no media node on message');
  try {
    const b = await streamToBuffer(await downloadContentFromMessage(node, type));
    if (b && b.length > 0) return b;
    throw new Error('empty buffer from downloadContentFromMessage');
  } catch (err) {
    console.error(`⚠️  downloadContentFromMessage fallback failed: ${err.message}`);
    throw err;
  }
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
  // Ignore WhatsApp Channels/newsletters and broadcast lists — these aren't
  // real 1:1 users and have no phone number to gate on.
  if (msg.key.remoteJid?.endsWith('@newsletter')) return;
  if (msg.key.remoteJid?.endsWith('@broadcast')) return;

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
  // Unwrap view-once / ephemeral / sent-as-document wrappers so the screenshot
  // inside is actually visible. This is the #1 reason "the bot didn't read it".
  const inner = msg.message?.ephemeralMessage?.message
    || msg.message?.viewOnceMessageV2?.message
    || msg.message?.viewOnceMessageV2Extension?.message
    || msg.message?.viewOnceMessage?.message
    || msg.message?.documentWithCaptionMessage?.message;
  if (inner) msg.message = inner;

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
    } else if (msg.message?.imageMessage
        || (msg.message?.documentMessage && /^image\//i.test(msg.message.documentMessage.mimetype || ''))) {
      // Screenshots arrive either as a normal image OR as a "document" (file).
      const node = msg.message.imageMessage || msg.message.documentMessage;
      const caption = (node.caption || '').trim();
      const mimeType = (node.mimetype || 'image/jpeg').split(';')[0].trim();
      console.log(`🖼️  [${phone}] screenshot received (${mimeType})`);

      if (!SUPPORTED_IMAGE_MIMES.has(mimeType)) {
        await sock.sendMessage(jid, { text: "I couldn't read that image format. Please send it as a JPEG or PNG screenshot." });
        return;
      }

      let buffer;
      try {
        buffer = await downloadMediaBuffer(msg);
      } catch (err) {
        await sock.sendMessage(jid, { text: "I couldn't open that screenshot. Please send it again as a photo (not a document), or retake it." });
        return;
      }

      if (buffer.length > MAX_IMAGE_BYTES) {
        await sock.sendMessage(jid, { text: 'That image is a bit large. Please compress it and send it again.' });
        return;
      }

      images.push({ base64: buffer.toString('base64'), mimeType });
      text = caption || 'read this screenshot of our chat and coach me on exactly what to reply';
      storedText = caption ? `[image] ${caption}` : '[image attached]';
      console.log(`🖼️  [${phone}] screenshot decoded (${Math.round(buffer.length / 1024)}KB) → sending to Claude vision`);
    } else if (msg.message?.audioMessage) {
      if (!transcriptionEnabled) {
        await sock.sendMessage(jid, { text: "Voice notes aren't supported yet — send it as text." });
        return;
      }

      const mimeType = msg.message.audioMessage.mimetype || 'audio/ogg';
      const buffer = await downloadMediaBuffer(msg);

      const transcript = await transcribeAudio(buffer, mimeType);
      if (!transcript) {
        await sock.sendMessage(jid, { text: 'That voice note seemed empty — send it again.' });
        return;
      }
      text = transcript;
      storedText = `[voice] ${transcript}`;
    }
  } catch (err) {
    console.error('Media handling error:', err);
    await sock.sendMessage(jid, { text: 'Something went wrong reading that — please try again.' });
    return;
  }

  if (!text || text.trim().length === 0) {
    await sock.sendMessage(jid, { text: "I didn't get that — send text or a screenshot." });
    return;
  }

  console.log(`📩 [${phone}] ${storedText?.substring(0, 80)}`);

  try {
    await sock.readMessages([msg.key]);
  } catch {}

  // --- Access gate ---------------------------------------------------------
  // Paid (Google Sheet) or admin-approved (dashboard) users get unlimited coaching.
  // Unpaid users get a free window — FREE_TRIAL_MINUTES minutes OR FREE_MSG_LIMIT
  // messages from their first message — then the bot locks to the payment prompt.
  const status = await checkPaymentStatus(phone);
  // Admin-approved from the website dashboard → treat as paid (chats free).
  const approved = await isApproved(phone);
  const isPaid = status.isPaid || approved;
  if (approved && !status.isPaid) console.log(`✅ [${phone}] admin-approved from dashboard — free access`);

  if (!isPaid) {
    const startedAt = startTrial(phone); // first contact stamps the clock
    const now = Math.floor(Date.now() / 1000);

    // Limits: dashboard overrides env; env has 10 min / 20 msgs defaults.
    const cfg = await getBotConfig();
    const freeMinutes = cfg.freeMinutes ?? FREE_MINUTES_ENV;
    const freeMsgs = cfg.freeMsgs ?? FREE_MSGS_ENV;

    const elapsedMin = (now - startedAt) / 60;
    const used = incrementFreeUsage(phone); // count this message

    const overTime = elapsedMin >= freeMinutes;
    const overMsgs = freeMsgs > 0 && used > freeMsgs;

    if (overTime || overMsgs) {
      console.log(`🚫 [${phone}] free window over (${elapsedMin.toFixed(1)}min, ${used} msgs) — locking to payment`);
      await sock.sendPresenceUpdate('composing', jid);
      await sleep(1200);
      // Admin-set message from the dashboard ({link} → landing URL); else default.
      const endText = cfg.trialMessage ? cfg.trialMessage.replace(/\{link\}/g, LANDING_URL) : trialEndedReply(LANDING_URL);
      await sock.sendMessage(jid, { text: endText });
      return; // LOCK: no coaching reply past the free window
    }
    console.log(`🆓 [${phone}] free active (${elapsedMin.toFixed(1)}/${freeMinutes}min · ${used}/${freeMsgs} msgs)`);
  }

  // Ensure paid users exist in local DB for memory tracking.
  // Sheet is the source of truth for payment; SQLite stores conversations.
  let user = getUser(phone);
  if (isPaid && !user) {
    user = upsertUser({
      phone,
      name: status.name,
      payment_id: status.paymentId || 'sheet_grant',
      amount_days: 365  // long expiry — actual gate is the sheet
    });
    console.log(`👤 New paid user added to DB: ${status.name} (${phone})`);
  }

  saveMessage(phone, 'user', storedText || text);

  let profile = {};
  try {
    profile = JSON.parse(user?.profile_json || '{}');
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
  // Single-flight: never let two startBot calls race into two live sockets.
  if (connecting) {
    console.log('⏳ startBot already in progress — skipping duplicate call.');
    return sock;
  }
  connecting = true;

  // Tear down any existing socket first. Listeners are removed BEFORE end() so
  // the teardown's own 'close' event can't trigger another reconnect.
  if (sock) {
    try {
      sock.ev.removeAllListeners();
      sock.end(undefined);
    } catch {}
    sock = null;
  }

  try {
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
      // Distinct identity so it can't collide with your real WhatsApp Web
      // (which often registers as "macOS Desktop").
      browser: ['DatingCoachBot', 'Chrome', '1.0.0'],
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false
    });

    sock.ev.on('creds.update', saveCreds);

    // Optional pairing-code login. When PAIRING_NUMBER is set and we're not yet
    // registered, request an 8-char code and print it — enter it in WhatsApp
    // under "Link with phone number instead". Requested after a short delay so
    // the socket is connecting first (Baileys requirement).
    if (PAIRING_NUMBER && !sock.authState.creds.registered) {
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(PAIRING_NUMBER);
          const pretty = code?.match(/.{1,4}/g)?.join('-') || code;
          console.log('\n🔢 ========================================');
          console.log(`🔢  PAIRING CODE: ${pretty}`);
          console.log(`🔢  For number: ${PAIRING_NUMBER}`);
          console.log('🔢  WhatsApp → Linked Devices → Link a device →');
          console.log('🔢  "Link with phone number instead" → enter the code.');
          console.log('🔢 ========================================\n');
        } catch (err) {
          console.error('❌ Failed to request pairing code:', err.message);
          console.error('   Check PAIRING_NUMBER is correct (full number incl. country code, digits only).');
        }
      }, 3000);
    }

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
      const loggedOut = statusCode === DisconnectReason.loggedOut; // 401: conflict / device_removed / revoked

      if (loggedOut) {
        if (logoutStorm()) {
          console.error('🛑 Repeated logouts — another instance is likely using this WhatsApp session. ' +
            'Ensure only ONE copy of the bot is running, then redeploy. Not auto-clearing (would loop).');
          return;
        }
        console.log(`🚪 Session ended (code ${statusCode} — logged out / device removed). Clearing auth and re-pairing...`);
        clearAuthState();
        scheduleReconnect(3000);
      } else {
        console.log(`❌ Connection closed (code: ${statusCode}). Reconnecting in 3s...`);
        scheduleReconnect(3000);
      }
    } else if (connection === 'open') {
      latestQR = null;       // paired — no QR to show anymore
      recentLogouts = [];    // healthy connection resets the storm counter
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
  } finally {
    connecting = false;
  }
}

export function getSocket() {
  return sock;
}
