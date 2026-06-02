// netlify/functions/send-form.js
// Serverless function — Brevo API key is stored as a Netlify environment variable
// Set BREVO_API_KEY in Netlify → Site Settings → Environment Variables

exports.handler = async function (event) {

  // Only allow POST
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // CORS headers — restrict to your domain in production
  const headers = {
    'Access-Control-Allow-Origin': 'https://www.ne-hsh-awards.co.uk',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { type, email, firstName, lastName, extraAttrs, emailSubject, emailHtml } = body;

  const BREVO_KEY = process.env.BREVO_API_KEY;
  if (!BREVO_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'API key not configured' }) };
  }

  try {
    const results = {};

    // ── 1. Send transactional email ──────────────────────────────────
    if (type === 'email' || type === 'both') {
      const emailRes = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': BREVO_KEY },
        body: JSON.stringify({
          sender: { name: 'HSH Awards Website', email: 'awards@first-connections.co.uk' },
          to: [{ email: 'awards@first-connections.co.uk', name: 'HSH Awards Team' }],
          replyTo: { email: email || 'awards@first-connections.co.uk', name: `${firstName || ''} ${lastName || ''}`.trim() || 'Website Visitor' },
          subject: emailSubject || 'New Submission — NE High Street Heroes 2026',
          htmlContent: emailHtml,
        }),
      });

      results.email = emailRes.ok ? 'sent' : `failed (${emailRes.status})`;
    }

    // ── 2. Add / update contact in Brevo CRM ─────────────────────────
    if ((type === 'contact' || type === 'both') && email) {
      const contactRes = await fetch('https://api.brevo.com/v3/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': BREVO_KEY },
        body: JSON.stringify({
          email,
          attributes: {
            FIRSTNAME: firstName || '',
            LASTNAME: lastName || '',
            ...extraAttrs,
          },
          listIds: [9],
          updateEnabled: true,
        }),
      });

      results.contact = contactRes.ok ? 'added' : `failed (${contactRes.status})`;
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, results }) };

  } catch (err) {
    console.error('Brevo function error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
