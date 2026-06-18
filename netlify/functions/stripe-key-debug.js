// netlify/functions/stripe-key-debug.js
// TEMPORARY diagnostic endpoint. Reports SAFE metadata about the Stripe key the
// function actually receives at runtime — never the secret value itself. Used to
// diagnose the "Payments are not configured yet" error. DELETE after debugging.
//
// Visit: https://ne-hsh-awards.co.uk/.netlify/functions/stripe-key-debug

exports.handler = async function () {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

  const raw = process.env.STRIPE_SECRET_KEY;
  const present = typeof raw === 'string' && raw.length > 0;

  const info = {
    STRIPE_SECRET_KEY_present: present,
    length: present ? raw.length : 0,
    // first 8 chars only reveals the (non-secret) prefix e.g. "sk_live_"
    prefix: present ? raw.slice(0, 8) : null,
    // detect copy/paste artefacts that break the prefix match
    hasLeadingWhitespace: present ? /^\s/.test(raw) : false,
    hasTrailingWhitespace: present ? /\s$/.test(raw) : false,
    hasQuotes: present ? /["']/.test(raw) : false,
    hasNewline: present ? /[\r\n]/.test(raw) : false,
    passesValidation: present ? /^(sk|rk)_(live|test)_/.test(raw) : false,
    // which other Stripe-related vars exist (names only)
    relatedVarsPresent: {
      STRIPE_TAX_RATE_ID: !!process.env.STRIPE_TAX_RATE_ID,
      STRIPE_WEBHOOK_SECRET: !!process.env.STRIPE_WEBHOOK_SECRET,
      STRIPE_WEBHOOK_SECRET_HSH: !!process.env.STRIPE_WEBHOOK_SECRET_HSH,
    },
    // all env var NAMES that contain STRIPE (values never shown) — catches typos
    // like STRIPE_SECRET_KEY_ or STRIPE_SK etc.
    stripeVarNames: Object.keys(process.env).filter(k => /STRIPE/i.test(k)),
  };

  return { statusCode: 200, headers, body: JSON.stringify(info, null, 2) };
};
