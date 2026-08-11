// netlify/functions/brevo-diag.js
// Read-only diagnostic that asks Brevo directly what it knows: whether the
// API key works, which senders are verified, which domains are DKIM/SPF
// authenticated, and what happened to recent transactional sends
// (delivered / bounced / spam / blocked / …).
//
// Access:
//   GET /.netlify/functions/brevo-diag?token=<value of BREVO_DIAG_TOKEN>
//
// If BREVO_DIAG_TOKEN isn't set in Netlify env vars, this endpoint refuses to
// respond — nobody can enumerate the account without being invited to.
//
// Set BREVO_DIAG_TOKEN to any long random string in Netlify env vars and
// visit the URL with ?token=<that string> to run the check.

const AWARDS_INBOX = 'awards@first-connections.co.uk';

async function callBrevo(path, key) {
  try {
    const res = await fetch('https://api.brevo.com/v3' + path, {
      headers: { 'api-key': key, 'accept': 'application/json' },
    });
    const text = await res.text().catch(() => '');
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: { networkError: err.message } };
  }
}

// Summarise recent transactional sends so we can see whether the last few
// nominations actually got delivered, were bounced, or landed in spam. Brevo
// paginates via limit + offset; 20 events is enough to spot a pattern.
async function recentEvents(key) {
  const r = await callBrevo('/smtp/statistics/events?limit=20', key);
  if (!r.ok || !r.body || !Array.isArray(r.body.events)) return { ok: r.ok, status: r.status, raw: r.body };
  return {
    ok: true,
    status: r.status,
    events: r.body.events.map(e => ({
      date: e.date,
      event: e.event,           // delivered | bounced | spam | blocked | opened | …
      email: e.email,           // recipient
      subject: e.subject,
      messageId: e['message-id'],
      reason: e.reason,         // populated on failure events
    })),
  };
}

// Trigger a real Brevo transactional send using the current SENDER_EMAIL and
// SENDER_NAME env vars, addressed to the awards inbox. Bypasses the frontend
// form entirely — proves whether the CURRENT config actually delivers.
async function sendTestEmail(key) {
  const sender = {
    email: process.env.SENDER_EMAIL || AWARDS_INBOX,
    name: process.env.SENDER_NAME || 'HSH Awards Website',
  };
  const now = new Date().toISOString();
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': key },
    body: JSON.stringify({
      sender,
      to: [{ email: AWARDS_INBOX, name: 'HSH Awards Team' }],
      subject: `[brevo-diag] Test send at ${now}`,
      htmlContent: `<p>This is a diagnostic test send from <code>brevo-diag</code>.</p><p>Sender: <b>${sender.email}</b><br>Recipient: <b>${AWARDS_INBOX}</b><br>Timestamp: ${now}</p><p>If you can see this message in your inbox, delivery from the current Brevo configuration is working. If you can't see it, check Brevo &rarr; Transactional &rarr; Logs for the delivery status of this message.</p>`,
      textContent: `Diagnostic test send from brevo-diag.\n\nSender: ${sender.email}\nRecipient: ${AWARDS_INBOX}\nTimestamp: ${now}\n\nIf this arrives, current Brevo configuration is delivering correctly.`,
    }),
  });
  const text = await res.text().catch(() => '');
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { sender, response: { ok: res.ok, status: res.status, body } };
}

exports.handler = async function (event) {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

  const configuredToken = process.env.BREVO_DIAG_TOKEN;
  if (!configuredToken) {
    // Deliberately vague — if the operator hasn't configured a diag token,
    // this endpoint might as well not exist.
    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Not found' }) };
  }

  const providedToken = (event.queryStringParameters && event.queryStringParameters.token) || '';
  if (providedToken !== configuredToken) {
    return { statusCode: 403, headers, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  // POST ?token=X&sendTest=1 triggers a real Brevo send using the current
  // effective sender. Use this to prove out an env-var change without waiting
  // on a real visitor to fill in the form.
  if (event.httpMethod === 'POST' && event.queryStringParameters && event.queryStringParameters.sendTest) {
    const key = process.env.BREVO_API_KEY;
    if (!key) return { statusCode: 200, headers, body: JSON.stringify({ ok: false, problem: 'BREVO_API_KEY not set' }, null, 2) };
    const r = await sendTestEmail(key);
    return { statusCode: 200, headers, body: JSON.stringify({
      ok: r.response.ok,
      sentAs: r.sender,
      brevo: r.response,
      note: r.response.ok
        ? 'Brevo accepted the test send. Now watch the Brevo → Transactional → Logs for the messageId above and see whether it lands as Delivered, Blocked, spam, or hard-bounce. That final status tells you the truth about deliverability with THIS sender.'
        : 'Brevo rejected the test send. See brevo.body.message for the reason.',
    }, null, 2) };
  }

  const key = process.env.BREVO_API_KEY;
  if (!key) {
    return { statusCode: 200, headers, body: JSON.stringify({
      ok: false,
      problem: 'BREVO_API_KEY is not set in Netlify env vars',
    }, null, 2) };
  }
  if (!/^xkeysib-/.test(key)) {
    return { statusCode: 200, headers, body: JSON.stringify({
      ok: false,
      problem: 'BREVO_API_KEY does not look like a Brevo key (expected the "xkeysib-…" prefix). It may be from another service or truncated.',
      keyPrefix: key.slice(0, 10) + '…',
    }, null, 2) };
  }

  // 1. Prove the key works and see which account it's tied to.
  const account = await callBrevo('/account', key);

  // 2. What sender identities are verified? A send from any address NOT in
  //    this list will fail (400) OR get quarantined by receivers.
  const senders = await callBrevo('/senders', key);

  // 3. What sending domains have DKIM/SPF set up? Without authentication,
  //    receivers (Gmail, Workspace, M365) treat the mail as spoofed.
  const domains = await callBrevo('/senders/domains', key);

  // 4. What did Brevo actually try to deliver recently, and how did it go?
  const events = await recentEvents(key);

  // Compute the sender the send-form function is currently using, so we can
  // cross-check it against the verified-senders list.
  const currentSender = process.env.SENDER_EMAIL || AWARDS_INBOX;
  const currentSenderName = process.env.SENDER_NAME || 'HSH Awards Website';

  // Flatten the useful bits into one report the operator can eyeball.
  const senderList = (senders.body && Array.isArray(senders.body.senders))
    ? senders.body.senders.map(s => ({ id: s.id, name: s.name, email: s.email, active: s.active }))
    : senders.body;

  const domainList = (domains.body && Array.isArray(domains.body.domains))
    ? domains.body.domains.map(d => ({
        domain: d.domain,
        authenticated: d.authenticated,
        verified: d.verified,
        dkim: d.dkim,
        // Brevo returns more here (dnsRecords etc.); trim to what matters.
      }))
    : domains.body;

  const senderMatch = Array.isArray(senderList)
    ? senderList.find(s => (s.email || '').toLowerCase() === currentSender.toLowerCase())
    : null;

  const senderDomain = currentSender.split('@')[1] || '';
  const domainMatch = Array.isArray(domainList)
    ? domainList.find(d => (d.domain || '').toLowerCase() === senderDomain.toLowerCase())
    : null;

  const diagnosis = [];
  if (!account.ok) diagnosis.push(`BREVO_API_KEY rejected by Brevo (status ${account.status}). Rotate the key in Brevo dashboard → SMTP & API → API keys and update it in Netlify env vars.`);
  if (account.ok && !senderMatch) diagnosis.push(`Sender "${currentSender}" is NOT a verified sender in this Brevo account. Add it in Brevo → Senders & IP → Senders, or set SENDER_EMAIL in Netlify env vars to a sender that IS verified.`);
  if (senderMatch && !senderMatch.active) diagnosis.push(`Sender "${currentSender}" exists in Brevo but is marked inactive. Re-verify it in Brevo → Senders & IP → Senders.`);
  if (account.ok && !domainMatch) diagnosis.push(`Domain "${senderDomain}" has no authentication (DKIM/SPF) set up in Brevo. Even if the sender is verified, receivers may quarantine or drop the mail. Add the domain in Brevo → Senders & IP → Domains and publish the DNS records they list.`);
  if (domainMatch && !domainMatch.authenticated) diagnosis.push(`Domain "${senderDomain}" is registered in Brevo but not yet authenticated. Publish the DKIM + SPF DNS records Brevo generated for it.`);
  if (events.ok && Array.isArray(events.events)) {
    const bounces = events.events.filter(e => ['hardBounces', 'hard_bounces', 'bounced', 'blocked'].includes(e.event));
    const spam = events.events.filter(e => ['spam', 'complaint'].includes(e.event));
    if (bounces.length) diagnosis.push(`${bounces.length} recent send(s) bounced or were blocked. Check the "events" section below for the reason.`);
    if (spam.length) diagnosis.push(`${spam.length} recent send(s) were marked as spam.`);
  }
  const awardsSelfSend = (currentSender.toLowerCase() === AWARDS_INBOX.toLowerCase());
  if (awardsSelfSend) diagnosis.push(`Sender = recipient (both "${AWARDS_INBOX}"). Google Workspace and Microsoft 365 often silently drop or quarantine self-sent mail from an unauthenticated origin. Setting SENDER_EMAIL to a different address (e.g. no-reply@ne-hsh-awards.co.uk with the ne-hsh-awards.co.uk domain authenticated in Brevo) usually fixes this immediately.`);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      ok: account.ok,
      diagnosis: diagnosis.length ? diagnosis : ['No obvious misconfiguration detected. If mail still isn\'t arriving, check the recipient mailbox\'s Spam folder and Brevo dashboard → Logs → Transactional log for the exact per-message status.'],
      // Booleans, not values — proves whether the env vars are actually being
      // seen by this function process. If `hasSenderEmail` is false but you
      // set SENDER_EMAIL in Netlify, the scope on that variable doesn't
      // include "Functions" — edit the variable in Netlify and tick the
      // Functions box, then trigger a redeploy.
      envSeenByFunction: {
        hasBrevoKey:      !!process.env.BREVO_API_KEY,
        hasBrevoDiagToken:!!process.env.BREVO_DIAG_TOKEN,
        hasSenderEmail:   !!process.env.SENDER_EMAIL,
        hasSenderName:    !!process.env.SENDER_NAME,
      },
      currentConfig: {
        senderEmail: currentSender,
        senderName: currentSenderName,
        senderIsFromEnvVar: !!process.env.SENDER_EMAIL,
        recipientInbox: AWARDS_INBOX,
        senderIsRecipient: awardsSelfSend,
        senderIsBrevoVerified: !!senderMatch,
        senderDomainAuthenticated: !!(domainMatch && domainMatch.authenticated),
      },
      brevoAccount: {
        ok: account.ok,
        status: account.status,
        body: account.body,
      },
      verifiedSenders: {
        ok: senders.ok,
        status: senders.status,
        list: senderList,
      },
      authenticatedDomains: {
        ok: domains.ok,
        status: domains.status,
        list: domainList,
      },
      recentEvents: events,
    }, null, 2),
  };
};
