import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import { normalizePhone } from './db.js';

// ============================================================
// Sheet schema (columns):
//   A: Name
//   B: Source
//   C: Whatsapp Number
//   D: Payment Status   ← "Paid" enables the bot
//   E: Payment ID
// ============================================================

let sheet = null;
let cache = { rows: [], expiresAt: 0 };
const CACHE_TTL_MS = 30 * 1000; // 30 seconds

async function getSheet() {
  if (sheet) return sheet;

  if (!process.env.GOOGLE_SHEET_ID) {
    console.warn('⚠️  GOOGLE_SHEET_ID not set — bot will reject all users');
    return null;
  }

  const jwt = new JWT({
    email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
  });

  const doc = new GoogleSpreadsheet(process.env.GOOGLE_SHEET_ID, jwt);
  await doc.loadInfo();
  sheet = doc.sheetsByIndex[0];

  console.log(`📊 Connected to sheet: "${doc.title}" / "${sheet.title}"`);
  return sheet;
}

// Read all rows from the sheet (with caching to avoid rate limits)
async function loadRows(force = false) {
  const now = Date.now();
  if (!force && cache.expiresAt > now) {
    return cache.rows;
  }

  try {
    const s = await getSheet();
    if (!s) return [];

    const rows = await s.getRows();
    cache = {
      rows,
      expiresAt: now + CACHE_TTL_MS
    };
    return rows;
  } catch (err) {
    console.error('❌ Failed to load sheet:', err.message);
    // Return stale cache if available
    return cache.rows;
  }
}

// Check if a phone number has paid status
// Returns: { isPaid: bool, name: string|null, source: string|null }
export async function checkPaymentStatus(phone) {
  const normalized = normalizePhone(phone);
  const rows = await loadRows();

  for (const row of rows) {
    const sheetPhone = normalizePhone(row.get('Whatsapp Number'));
    if (sheetPhone === normalized) {
      const status = (row.get('Payment Status') || '').trim().toLowerCase();
      return {
        isPaid: status === 'paid',
        name: row.get('Name') || null,
        source: row.get('Source') || null,
        paymentId: row.get('Payment ID') || null
      };
    }
  }

  return { isPaid: false, name: null, source: null, paymentId: null };
}

// Force a sheet refresh (useful after manual edits)
export async function refreshSheetCache() {
  await loadRows(true);
  console.log(`🔄 Sheet cache refreshed (${cache.rows.length} rows)`);
}

// Add a new row to the sheet (for future Razorpay integration)
export async function appendUserRow({ name, source = 'Razorpay', phone, status = 'Paid', paymentId }) {
  try {
    const s = await getSheet();
    if (!s) return;

    await s.addRow({
      'Name': name || '',
      'Source': source,
      'Whatsapp Number': normalizePhone(phone),
      'Payment Status': status,
      'Payment ID': paymentId || ''
    });

    // Invalidate cache so next check picks up the new row
    cache.expiresAt = 0;
    console.log(`📊 Added to sheet: ${name} (${phone})`);
  } catch (err) {
    console.error('Sheets append failed:', err.message);
  }
}
