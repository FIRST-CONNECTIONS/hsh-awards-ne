// netlify/functions/send-form.js
// Serverless function — Brevo API key is stored as a Netlify environment
// variable. Set BREVO_API_KEY in Netlify → Site Settings → Environment Variables.
//
// This function is the ONLY path visitor form submissions travel through.
// If it silently reports success while Brevo has rejected the send, users
// get "Thank you!" but the awards inbox stays empty — which is exactly what
// was happening before this rewrite. Every failure now:
//   • reads Brevo's JSON error body (Brevo returns useful messages)
//   • console.error's the details so they surface in Netlify function logs
//   • returns a non-2xx response so the client shows the error banner
//     rather than a false success

const AWARDS_INBOX = 'awards@first-connections.co.uk';
const BREVO_LIST_ID = 9;

// Sender identity used in the `From:` header. Configurable so ops can point
// at whichever address is verified in Brevo (and whose domain is DKIM/SPF
// authenticated) without redeploying. When absent, we fall back to the
// awards inbox — but note that From=To often triggers anti-spoofing filters
// at Google/Microsoft, so setting SENDER_EMAIL to a distinct address on an
// authenticated domain (e.g. awards@ne-hsh-awards.co.uk) is strongly
// preferred. The visitor's email always lands in Reply-To regardless, so
// awards@ can still reply directly to the nominator.
//
// Read PER REQUEST rather than at module load so a warm container picks up
// env var changes the moment Netlify propagates them (module-load reads
// bake stale values into a long-lived container).
function effectiveSender() {
  const email = process.env.SENDER_EMAIL || AWARDS_INBOX;
  const name  = process.env.SENDER_NAME  || 'HSH Awards Website';
  const usingFallback = !process.env.SENDER_EMAIL;
  return { email, name, usingFallback };
}

// Strip HTML from a string so user-supplied values can be safely inlined into
// the plaintext email fallback.
function stripTags(s) {
  return String(s == null ? '' : s).replace(/<[^>]*>/g, '').trim();
}

// Convert the HTML table body into a plain-text alternative. Brevo (and every
// deliverability score) prefers emails that provide both HTML and text parts.
function htmlTableToText(html) {
  if (!html) return '';
  const rows = [...html.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map(m => m[0]);
  const lines = [];
  for (const row of rows) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => stripTags(m[1]));
    if (cells.length === 2) lines.push(`${cells[0]}: ${cells[1]}`);
    else if (cells.length) lines.push(cells.join(' — '));
  }
  return lines.join('\n');
}

// Ask Brevo for its response body — parse JSON when possible so the log line
// carries the structured { code, message } Brevo returns on error.
async function readBrevoBody(res) {
  const text = await res.text().catch(() => '');
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

exports.handler = async function (event) {

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const headers = {
    'Access-Control-Allow-Origin': 'https://ne-hsh-awards.co.uk',
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
    console.error('send-form: BREVO_API_KEY environment variable is not set');
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Email service is not configured. Please email awards@first-connections.co.uk directly.' }) };
  }

  // ── 1. Send transactional email — this is the primary path ─────────────
  // If this fails we bail with a non-2xx so the visitor sees the error banner.
  if (type === 'email' || type === 'both') {
    const sender = effectiveSender();
    // Print the effective sender on EVERY request so the Netlify function log
    // makes it trivial to see whether env-var changes have propagated. When
    // it says "usingFallback: true" the SENDER_EMAIL env var either isn't set
    // or isn't scoped to Functions — no more guessing.
    console.log('send-form: incoming submission', {
      senderEmail: sender.email,
      senderName: sender.name,
      usingFallback: sender.usingFallback,
      subject: emailSubject,
    });
    if (sender.usingFallback) {
      console.warn('send-form: SENDER_EMAIL env var is NOT set — using fallback', AWARDS_INBOX, '(which sends From = To and is likely to be blocked by the receiving Google Workspace tenant). Add SENDER_EMAIL to Netlify env vars with the "Functions" scope selected, then redeploy.');
    }

    const senderName = `${firstName || ''} ${lastName || ''}`.trim() || 'Website Visitor';
    const replyToEmail = (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) ? email : AWARDS_INBOX;

    let emailRes;
    try {
      emailRes = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': BREVO_KEY },
        body: JSON.stringify({
          sender: { name: sender.name, email: sender.email },
          to: [{ email: AWARDS_INBOX, name: 'HSH Awards Team' }],
          replyTo: { email: replyToEmail, name: senderName },
          subject: emailSubject || 'New Submission — NE High Street Heroes 2026',
          htmlContent: emailHtml,
          textContent: htmlTableToText(emailHtml) || 'A new submission was received via ne-hsh-awards.co.uk.',
        }),
      });
    } catch (err) {
      console.error('send-form: network error calling Brevo email API:', err);
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Could not reach the email service. Please try again in a moment, or email awards@first-connections.co.uk.' }) };
    }

    if (!emailRes.ok) {
      const errBody = await readBrevoBody(emailRes);
      // Log everything the operator needs to diagnose — sender not verified,
      // key revoked, attribute mismatch, whatever Brevo tells us.
      console.error('send-form: Brevo email API rejected the send', {
        status: emailRes.status,
        brevo: errBody,
        subject: emailSubject,
        senderEmail: sender.email,
        replyToEmail,
      });
      // Prefer Brevo's own message when it's short enough to show a human.
      const brevoMsg = (errBody && typeof errBody === 'object' && errBody.message) ? errBody.message : null;
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({
          error: 'The email could not be sent. Please email awards@first-connections.co.uk directly and we\'ll pick it up right away.',
          brevoStatus: emailRes.status,
          brevoMessage: brevoMsg,
        }),
      };
    }

    // Log the messageId so ops can look up per-send status in
    // Brevo → Logs → Transactional log. Brevo returns 201 { messageId: "…" }.
    const okBody = await readBrevoBody(emailRes);
    console.log('send-form: Brevo accepted the send', {
      messageId: (okBody && okBody.messageId) || null,
      subject: emailSubject,
      senderEmail: sender.email,
      replyToEmail,
    });
  }

  // ── 2. Best-effort: add / update the sender in the Brevo CRM ───────────
  // A CRM sync failure must NOT hide the fact that the email got through, so
  // this is a non-fatal step: we log but return success. The nomination has
  // already reached the awards inbox by the time we get here.
  if ((type === 'contact' || type === 'both') && email) {
    try {
      const contactRes = await fetch('https://api.brevo.com/v3/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'api-key': BREVO_KEY },
        body: JSON.stringify({
          email,
          attributes: {
            FIRSTNAME: firstName || '',
            LASTNAME: lastName || '',
            ...(extraAttrs || {}),
          },
          listIds: [BREVO_LIST_ID],
          updateEnabled: true,
        }),
      });
      if (!contactRes.ok) {
        const errBody = await readBrevoBody(contactRes);
        console.error('send-form: Brevo contact-add failed (non-fatal)', {
          status: contactRes.status,
          brevo: errBody,
          email,
          listId: BREVO_LIST_ID,
        });
      }
    } catch (err) {
      console.error('send-form: network error calling Brevo contacts API (non-fatal):', err);
    }
  }

  return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
};
