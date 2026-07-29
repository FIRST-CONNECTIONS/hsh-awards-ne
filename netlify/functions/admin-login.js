// netlify/functions/admin-login.js
// POST { password } → 200 { token, expiresInSec } | 401 { error }
//
// Env vars required:
//   ADMIN_PASSWORD    — the shared admin password (mark as secret in Netlify)
//   ADMIN_JWT_SECRET  — long random string used to sign session tokens
//
// The client posts the password JSON-body, gets back a bearer token to keep
// in sessionStorage, and passes it as `Authorization: Bearer <token>` on
// every subsequent admin-* request.

const { signToken, timingSafeStringEqual } = require('../lib/admin-auth');

const SESSION_SECONDS = 60 * 60 * 12; // 12 hours

exports.handler = async function (event) {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const adminPassword = process.env.ADMIN_PASSWORD;
  const jwtSecret     = process.env.ADMIN_JWT_SECRET;
  if (!adminPassword || !jwtSecret) {
    console.error('admin-login: ADMIN_PASSWORD or ADMIN_JWT_SECRET is not set in Netlify env vars');
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Admin login is not configured yet. Set ADMIN_PASSWORD and ADMIN_JWT_SECRET in Netlify env vars (scoped to Functions), then redeploy.' }),
    };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const provided = typeof body.password === 'string' ? body.password : '';

  // 400ms floor on every login attempt so an attacker can't spray passwords
  // faster than ~2/sec per Netlify instance. Not a substitute for a proper
  // rate limiter, but meaningful given free-tier serverless concurrency.
  const wait = new Promise(resolve => setTimeout(resolve, 400));

  if (!timingSafeStringEqual(provided, adminPassword)) {
    await wait;
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Incorrect password.' }) };
  }

  const token = signToken({ role: 'admin' }, jwtSecret, SESSION_SECONDS);
  await wait; // uniform timing whether or not the password matched
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ token, expiresInSec: SESSION_SECONDS }),
  };
};
