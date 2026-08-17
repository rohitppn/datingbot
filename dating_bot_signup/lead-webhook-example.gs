// Google Apps Script Web App — FlirtCoachAI lead capture.
// Writes website signups straight into the SAME sheet the bot reads, so a new
// lead shows up ready to use. You only fill in "Payment Status" by hand once
// they pay.
//
// SETUP
// 1. Open your bot's Google Sheet (the one in GOOGLE_SHEET_ID).
// 2. Extensions > Apps Script. Paste this whole file in. Save.
// 3. Deploy > New deployment > type "Web app".
//      Execute as: Me.   Who has access: Anyone.
// 4. Copy the Web App URL it gives you.
// 5. Paste that URL into CONFIG.LEAD_WEBHOOK_URL in index.html.
//
// The bot reads the FIRST tab by these column headers:
//   Name | Source | Whatsapp Number | Payment Status | Payment ID
// This script writes to that same first tab and leaves Payment Status blank.
// We also keep Email and Timestamp columns for your own records (the bot
// ignores any extra columns).

// Canonical headers. Order here = order they're created if the sheet is empty.
// The bot only cares about the names existing, not their position.
const HEADERS = [
  'Name',
  'Source',
  'Whatsapp Number',
  'Payment Status',
  'Payment ID',
  'Email',
  'Timestamp'
];

function doPost(e) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    // First tab — must match the bot, which reads sheetsByIndex[0].
    const sheet = ss.getSheets()[0];
    const data = JSON.parse((e && e.postData && e.postData.contents) || '{}');

    // Make sure a header row exists and contains every header we need.
    const headerRow = ensureHeaders(sheet);

    // Values for this lead, keyed by header name.
    const values = {
      'Name': data.fullName || '',
      'Source': 'Website',
      'Whatsapp Number': normalizePhone(data.phone || ''),
      'Payment Status': '',            // blank — you set this to "Paid" manually
      'Payment ID': '',
      'Email': data.email || '',
      'Timestamp': data.timestamp || new Date().toISOString()
    };

    // Build the row in the sheet's actual column order so nothing misaligns.
    const row = headerRow.map(function (h) {
      return Object.prototype.hasOwnProperty.call(values, h) ? values[h] : '';
    });
    sheet.appendRow(row);

    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

// Ensure row 1 has headers; add any missing canonical headers to the end.
// Returns the final header row as an array of strings.
function ensureHeaders(sheet) {
  var lastCol = sheet.getLastColumn();
  var current = lastCol > 0
    ? sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(String)
    : [];

  // Empty sheet — lay down the canonical headers and return.
  if (current.length === 0 || current.join('').trim() === '') {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    return HEADERS.slice();
  }

  // Append any of our required headers that aren't already present.
  var missing = HEADERS.filter(function (h) { return current.indexOf(h) === -1; });
  if (missing.length) {
    sheet.getRange(1, current.length + 1, 1, missing.length).setValues([missing]);
    current = current.concat(missing);
  }
  return current;
}

// Mirror the bot's normalizePhone: digits only, strip @-suffix, add 91 to a
// bare 10-digit Indian number. Keeps the website and bot matching the same way.
function normalizePhone(raw) {
  if (!raw) return '';
  var p = String(raw).split('@')[0].replace(/[^0-9]/g, '');
  if (p.length === 10) p = '91' + p;
  return p;
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
