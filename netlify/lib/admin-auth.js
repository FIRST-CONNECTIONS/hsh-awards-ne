// netlify/lib/admin-auth.js
// HS256 JWT sign + verify with zero npm dependencies (Node built-in `crypto`).
// Shared by every admin-scoped Netlify function so token issuance and token
// verification stay in one file.
//
// Design notes:
//   - HS256 with ADMIN_JWT_SECRET is enough for a single-tenant admin surface;
//     no key rotation infrastructure exists yet, so keep the secret long.
//   - Payload carries only { role, iat, exp }. No PII on the wire.
//   - Timing-safe signature comparison — never string-compare HMACs directly.
//   - Every downstream admin function calls requireAuth() first and short-
//     circuits on failure so the auth policy is uniform.

const crypto = require('crypto');

function base64url(input) {
  return Buffer.from(input).toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64urlDecode(input) {
  let s = String(input).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

// Sign a payload as an HS256 JWT. expiresInSec defaults to 12 hours — long
// enough for a working session, short enough that a leaked token loses value.
function signToken(payload, secret, expiresInSec = 60 * 60 * 12) {
  if (!secret) throw new Error('signToken: secret is required');
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const body = { ...payload, iat: now, exp: now + expiresInSec };
  const h = base64url(JSON.stringify(header));
  const b = base64url(JSON.stringify(body));
  const data = h + '.' + b;
  const sig = crypto.createHmac('sha256', secret).update(data).digest();
  return data + '.' + base64url(sig);
}

// Verify + parse a JWT. Returns the payload on success, `null` on any failure
// (malformed, signature mismatch, expired). Never throws so callers can just
// treat any non-object result as "reject".
function verifyToken(token, secret) {
  if (!secret || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, b, s] = parts;
  const data = h + '.' + b;
  const expectedSig = crypto.createHmac('sha256', secret).update(data).digest();
  const providedSig = base64urlDecode(s);
  if (providedSig.length !== expectedSig.length) return null;
  if (!crypto.timingSafeEqual(providedSig, expectedSig)) return null;
  let payload;
  try {
    payload = JSON.parse(base64urlDecode(b).toString('utf8'));
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && now >= payload.exp) return null;
  return payload;
}

// Gate helper for admin functions. Reads the Bearer token from the request,
// verifies it against ADMIN_JWT_SECRET, and returns either
//   { ok: true, payload }
// or
//   { ok: false, status, error }
// so the handler can `if (!auth.ok) return errorResponse(auth)`.
function requireAuth(event) {
  const secret = process.env.ADMIN_JWT_SECRET;
  if (!secret) {
    return { ok: false, status: 500, error: 'ADMIN_JWT_SECRET is not set in Netlify env vars' };
  }
  const raw = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
  if (!raw.startsWith('Bearer ')) {
    return { ok: false, status: 401, error: 'Missing Authorization: Bearer <token> header' };
  }
  const token = raw.slice(7).trim();
  const payload = verifyToken(token, secret);
  if (!payload) {
    return { ok: false, status: 401, error: 'Token is invalid or has expired. Please log in again.' };
  }
  return { ok: true, payload };
}

// Timing-safe string comparison — used for the admin password check so a
// leaking attacker can't time the failure to learn the correct value char-by-
// char. Different-length inputs still consume the same time by comparing the
// short one against zeros before returning false.
function timingSafeStringEqual(a, b) {
  const ab = Buffer.from(String(a == null ? '' : a), 'utf8');
  const bb = Buffer.from(String(b == null ? '' : b), 'utf8');
  if (ab.length !== bb.length) {
    // Still touch the same number of bytes so the failure time doesn't depend
    // on input length.
    crypto.timingSafeEqual(ab, Buffer.alloc(ab.length));
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

module.exports = { signToken, verifyToken, requireAuth, timingSafeStringEqual };
