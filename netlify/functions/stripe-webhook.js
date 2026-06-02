// netlify/functions/stripe-webhook.js
// Stripe calls this endpoint when a sponsorship payment completes. We verify the
// signature (so the request genuinely came from Stripe), then send a confirmation
// email to the sponsor and a notification to the team via Brevo.
//
// Setup (one-off):
//   1. Stripe Dashboard → Developers → Webhooks → Add endpoint
//        URL:    https://ne-hsh-awards.co.uk/.netlify/functions/stripe-webhook
//        Events: checkout.session.completed, checkout.session.async_payment_succeeded
//   2. Copy the endpoint's "Signing secret" (whsec_…) into Netlify →
//        Environment variables → STRIPE_WEBHOOK_SECRET_HSH
//   (BREVO_API_KEY is already configured for the contact forms.)

const crypto = require('crypto');

const TEAM_EMAIL = 'awards@first-connections.co.uk';
const SENDER = { name: 'NE High Street Heroes Awards', email: 'awards@first-connections.co.uk' };

// Verify Stripe's signature header against the raw request body.
function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader) return false;
  let t, v1;
  for (const part of sigHeader.split(',')) {
    const i = part.indexOf('=');
    const k = part.slice(0, i), val = part.slice(i + 1);
    if (k === 't') t = val;
    if (k === 'v1') v1 = val; // first v1 scheme
  }
  if (!t || !v1) return false;

  const expected = crypto.createHmac('sha256', secret).update(`${t}.${rawBody}`, 'utf8').digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(v1);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;

  // Reject events older than 5 minutes to guard against replay.
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(t)) > 300) return false;
  return true;
}

async function sendBrevoEmail(brevoKey, { to, subject, html, replyTo }) {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': brevoKey },
    body: JSON.stringify({
      sender: SENDER,
      to,
      ...(replyTo ? { replyTo } : {}),
      subject,
      htmlContent: html,
    }),
  });
  if (!res.ok) console.error('Brevo send failed:', res.status, await res.text());
  return res.ok;
}

async function sendSponsorEmails(session, brevoKey) {
  if (!brevoKey) { console.error('Missing BREVO_API_KEY — cannot send confirmation'); return; }

  const email = (session.customer_details && session.customer_details.email) || session.customer_email || '';
  const name = (session.customer_details && session.customer_details.name) || '';
  const firstName = (name.split(' ')[0]) || 'there';
  const category = (session.metadata && session.metadata.category) || 'your chosen category';
  const business = (session.metadata && session.metadata.business) || '';
  const amount = '£' + ((session.amount_total || 0) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // ── Confirmation to the sponsor ──────────────────────────────────────
  if (email) {
    const html = `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#222">
        <h2 style="color:#d6336c">You're confirmed as a Category Sponsor 🎉</h2>
        <p>Hi ${firstName},</p>
        <p>Thank you for sponsoring the <strong>${category}</strong> award at the <strong>NE High Street Heroes Awards 2026</strong> — we're thrilled to have ${business ? `<strong>${business}</strong>` : 'you'} on board.</p>
        <table style="font-size:15px;border-collapse:collapse;width:100%;margin:18px 0">
          <tr><td style="padding:8px 12px;font-weight:700;background:#f5f5f5;border:1px solid #ddd;width:40%">Category Sponsored</td><td style="padding:8px 12px;border:1px solid #ddd">${category}</td></tr>
          ${business ? `<tr><td style="padding:8px 12px;font-weight:700;background:#f5f5f5;border:1px solid #ddd">Business</td><td style="padding:8px 12px;border:1px solid #ddd">${business}</td></tr>` : ''}
          <tr><td style="padding:8px 12px;font-weight:700;background:#f5f5f5;border:1px solid #ddd">Amount Paid</td><td style="padding:8px 12px;border:1px solid #ddd">${amount} (inclusive of VAT)</td></tr>
        </table>
        <p><strong>What happens next?</strong> A member of our team will be in touch within 48 hours to collect your logo and branding details and walk you through everything included in your sponsorship — from category naming rights to your place at the Gala on 1st September 2026 at The Hippodrome, Darlington.</p>
        <p>Your card receipt is sent separately by our payment provider, Stripe.</p>
        <p>If you have any questions in the meantime, just reply to this email or contact us at <a href="mailto:${TEAM_EMAIL}">${TEAM_EMAIL}</a>.</p>
        <p style="margin-top:24px">With thanks,<br><strong>The NE High Street Heroes Team</strong><br><span style="color:#888;font-size:13px">A First Connections Initiative</span></p>
      </div>`;
    await sendBrevoEmail(brevoKey, {
      to: [{ email, name: name || 'Sponsor' }],
      replyTo: { email: TEAM_EMAIL, name: 'NE High Street Heroes Awards' },
      subject: `You're confirmed as the ${category} sponsor — NE High Street Heroes 2026`,
      html,
    });
  } else {
    console.error('No customer email on session', session.id);
  }

  // ── Internal notification to the team ────────────────────────────────
  const teamHtml = `
    <div style="font-family:sans-serif;font-size:15px">
      <h2 style="color:#333">💷 New sponsorship paid</h2>
      <table style="border-collapse:collapse;width:100%">
        <tr><td style="padding:8px 12px;font-weight:700;background:#f5f5f5;border:1px solid #ddd;width:40%">Category</td><td style="padding:8px 12px;border:1px solid #ddd">${category}</td></tr>
        <tr><td style="padding:8px 12px;font-weight:700;background:#f5f5f5;border:1px solid #ddd">Business</td><td style="padding:8px 12px;border:1px solid #ddd">${business || '—'}</td></tr>
        <tr><td style="padding:8px 12px;font-weight:700;background:#f5f5f5;border:1px solid #ddd">Contact</td><td style="padding:8px 12px;border:1px solid #ddd">${name || '—'} &lt;${email || '—'}&gt;</td></tr>
        <tr><td style="padding:8px 12px;font-weight:700;background:#f5f5f5;border:1px solid #ddd">Amount</td><td style="padding:8px 12px;border:1px solid #ddd">${amount} (inc VAT)</td></tr>
        <tr><td style="padding:8px 12px;font-weight:700;background:#f5f5f5;border:1px solid #ddd">Stripe session</td><td style="padding:8px 12px;border:1px solid #ddd">${session.id}</td></tr>
      </table>
      <p style="color:#888;font-size:13px">Follow up within 48 hours to collect branding.</p>
    </div>`;
  await sendBrevoEmail(brevoKey, {
    to: [{ email: TEAM_EMAIL, name: 'HSH Awards Team' }],
    ...(email ? { replyTo: { email, name: name || 'Sponsor' } } : {}),
    subject: `💷 Sponsorship paid: ${category}${business ? ' — ' + business : ''}`,
    html: teamHtml,
  });
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const secret = process.env.STRIPE_WEBHOOK_SECRET_HSH || process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error('Missing STRIPE_WEBHOOK_SECRET_HSH');
    return { statusCode: 500, body: 'Webhook not configured' };
  }

  // Signature verification requires the exact raw body.
  const rawBody = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];

  if (!verifyStripeSignature(rawBody, sig, secret)) {
    return { statusCode: 400, body: 'Invalid signature' };
  }

  let evt;
  try { evt = JSON.parse(rawBody); } catch { return { statusCode: 400, body: 'Invalid JSON' }; }

  try {
    if (evt.type === 'checkout.session.completed' || evt.type === 'checkout.session.async_payment_succeeded') {
      const session = evt.data.object;
      if (session.payment_status === 'paid') {
        await sendSponsorEmails(session, process.env.BREVO_API_KEY);
      }
    }
  } catch (err) {
    // Log but still return 200 — we don't want Stripe retrying because our email
    // provider hiccuped; the payment itself is unaffected.
    console.error('Webhook handler error:', err);
  }

  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};
