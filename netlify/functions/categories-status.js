// netlify/functions/categories-status.js
// Returns which award categories have already been sponsored (paid for), so the
// /sponsor page can remove them from the dropdown. Stripe is the source of truth
// for online-paid sponsors; manually-arranged sponsors are merged in from the
// shared module. No database required.

const { computeAvailability } = require('../lib/sponsor-categories');

// List completed Checkout Sessions and collect the categories that have been paid for.
async function getPaidCategories(key) {
  const paid = new Set();
  let url = 'https://api.stripe.com/v1/checkout/sessions?status=complete&limit=100';
  let pages = 0;
  while (url && pages < 5) { // cap at 500 sessions — far more than 10 categories needs
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    const data = await res.json();
    if (!res.ok) throw new Error((data.error && data.error.message) || 'Stripe list failed');
    for (const s of (data.data || [])) {
      if (s.payment_status === 'paid' && s.metadata && s.metadata.category) paid.add(s.metadata.category);
    }
    if (data.has_more && data.data.length) {
      url = 'https://api.stripe.com/v1/checkout/sessions?status=complete&limit=100&starting_after=' + data.data[data.data.length - 1].id;
      pages++;
    } else {
      url = null;
    }
  }
  return [...paid];
}

exports.handler = async function () {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };

  const key = process.env.STRIPE_SECRET_KEY;
  // Fail open: if payments aren't configured or Stripe is unreachable, still
  // exclude the manually-arranged sponsors rather than blocking sponsorship
  // entirely. Also treat a malformed key (not an sk_/rk_ Stripe key) as
  // unconfigured instead of calling Stripe.
  if (!key || !/^(sk|rk)_(live|test)_/.test(key)) {
    if (key) console.error('STRIPE_SECRET_KEY is set but is not a valid Stripe secret key (expected sk_/rk_ prefix).');
    return { statusCode: 200, headers, body: JSON.stringify(computeAvailability()) };
  }

  try {
    const paid = await getPaidCategories(key);
    return { statusCode: 200, headers, body: JSON.stringify(computeAvailability(paid)) };
  } catch (err) {
    console.error('categories-status error:', err);
    return { statusCode: 200, headers, body: JSON.stringify({ ...computeAvailability(), error: err.message }) };
  }
};
