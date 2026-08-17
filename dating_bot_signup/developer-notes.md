# FlirtCoachAI Complete Website Package

This package contains a full two-step funnel website:

1. `index.html` — premium landing page with form-first lead capture.
2. `thank-you.html` — post-signup WhatsApp handoff page.
3. `assets/logos/` — logo files supplied by Arunav, processed for the dark/gold layout.
4. `assets/photos/` — seminar, workshop and founder photos supplied by Arunav.
5. `lead-webhook-example.gs` — Google Apps Script that writes signups straight into the bot's Google Sheet.

## Funnel logic

Landing page objective: collect name, email and WhatsApp number first.

After form submit:
- POST the lead to `CONFIG.LEAD_WEBHOOK_URL` if configured. The Apps Script in
  `lead-webhook-example.gs` appends the lead to the FIRST tab of the bot's
  Google Sheet (the same one the bot reads, set via `GOOGLE_SHEET_ID`), using
  the bot's headers: `Name | Source | Whatsapp Number | Payment Status |
  Payment ID`. It fills Name / Source="Website" / Whatsapp Number / Email /
  Timestamp and leaves **Payment Status blank**. You flip it to "Paid" by hand
  once they pay; the bot then unlocks unlimited replies for that number.
- Store lead in localStorage as backup.
- Redirect to `thank-you.html`.

So the lead auto-appears exactly where the bot checks. The website phone is
normalized the same way the bot does (digits only, bare 10-digit numbers get a
`91` prefix) so the two always match.

Thank-you page objective:
- Confirm access.
- Explain how to use the bot.
- Push the user to WhatsApp with a prefilled message.

Payment should not appear on the landing page. It should appear inside WhatsApp only after the 5 free replies are used.

## Required developer edits

In `index.html`, update:

```js
const CONFIG = {
  LEAD_WEBHOOK_URL: "", // Paste the Apps Script Web App URL from lead-webhook-example.gs here.
  THANK_YOU_URL: "thank-you.html",
  WHATSAPP_NUMBER: "917303965115" // the bot's WhatsApp number
};
```

In `thank-you.html`, update:

```js
const CONFIG = {
  WHATSAPP_NUMBER: "917303965115",
  BOT_PREFILL_TEXT: "Hi FlirtCoachAI, I want to start my 5 free replies."
};
```

## Tracking events already included

Landing page:
- `page_view`
- `form_start`
- `form_submit_attempt`
- `form_submit`
- `form_submit_error`

Thank-you page:
- `thank_you_page_view`
- `whatsapp_click`

These are pushed to `window.dataLayer`. Add Google Tag Manager to send them to GA4/Meta.

## Recommended GTM/Pixel setup

Add inside `<head>`:
- Google Tag Manager container
- Meta Pixel base code

Recommended custom events:
- `form_submit` = lead conversion
- `whatsapp_click` = high-intent conversion
- `payment_link_clicked` = WhatsApp/bot side event
- `payment_completed` = payment provider event

## ConvertKit / Kit integration

Best setup:
- Submit form to Make/Zapier/custom API.
- Add subscriber to Kit/ConvertKit.
- Save row to Google Sheets.
- Trigger email sequence.

Fields to save:
- Full Name
- Email
- Phone
- Source form
- Timestamp
- UTM source/medium/campaign/content/term
- Referrer

## Image use

Use the current images sparingly:
- Portrait = founder authority section
- TEDx image = public credibility proof
- Workshop image = real coaching proof
- Logos = credibility strip only

Do not turn it into a gallery. The site should stay premium and focused.

## FAQ Privacy Wording

Recommended privacy FAQ copy now included on the landing page:

“Your messages are processed confidentially to generate your replies and improve the AI experience. Conversation data may be used for AI training and product improvement under strict confidentiality controls. Human access is restricted to authorized technical/security processes only; your conversations are not manually read by coaches or sold to third parties. We use safeguards designed to prevent unauthorized access, though no online system can guarantee zero risk.”

Before launch, confirm this wording with the final Privacy Policy, Terms, WhatsApp/API vendor, AI processor, and payment provider.
