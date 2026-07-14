// netlify/functions/categories-status.js
// Returns which award categories have already been sponsored (paid for), so the
// /sponsor page can remove them from the dropdown. Stripe is the source of truth
// — no database required: we list completed Checkout Sessions and read the
// category from each session's metadata.

const CATEGORIES = [
  'Retailer of the Year',
  'Hospitality Hero',
  'Community Champion',
  'Digital Innovator',
  'Sustainability Leader',
  'Customer Experience Excellence',
  'Rising Star',
  'Employer of the Year',
  'Independent Business of the Year',
  'High Street of the Year',
];

// Categories sponsored via off-Stripe arrangements (direct partnerships).
// Always excluded from the /sponsor dropdown alongside anything paid via Stripe.
const MANUALLY_SPONSORED = [
  'Hospitality Hero',                  // NE Hotels Association
  'Digital Innovator',                 // Surgotech Solutions
  'Sustainability Leader',             // Lumo Trains
  'Independent Business of the Year',  // The Ironing Man
  'High Street of the Year',           // Roam Local
];

// List completed Checkout Sessions and collect the categories that have been paid for.
async function getTakenCategories(key) {
  const taken = new Set();
  let url = 'https://api.stripe.com/v1/checkout/sessions?status=complete&limit=100';
  let pages = 0;
  while (url && pages < 5) { // cap at 500 sessions — far more than 10 categories needs
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    const data = await res.json();
    if (!res.ok) throw new Error((data.error && data.error.message) || 'Stripe list failed');
    for (const s of (data.data || [])) {
      if (s.payment_status === 'paid' && s.metadata && s.metadata.category) taken.add(s.metadata.category);
    }
    if (data.has_more && data.data.length) {
      url = 'https://api.stripe.com/v1/checkout/sessions?status=complete&limit=100&starting_after=' + data.data[data.data.length - 1].id;
      pages++;
    } else {
      url = null;
    }
  }
  return [...taken];
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
    const taken = [...MANUALLY_SPONSORED];
    const available = CATEGORIES.filter(c => !taken.includes(c));
    return { statusCode: 200, headers, body: JSON.stringify({ taken, available }) };
  }

  try {
    const paid = await getTakenCategories(key);
    const taken = [...new Set([...paid, ...MANUALLY_SPONSORED])];
    const available = CATEGORIES.filter(c => !taken.includes(c));
    return { statusCode: 200, headers, body: JSON.stringify({ taken, available }) };
  } catch (err) {
    console.error('categories-status error:', err);
    const taken = [...MANUALLY_SPONSORED];
    const available = CATEGORIES.filter(c => !taken.includes(c));
    return { statusCode: 200, headers, body: JSON.stringify({ taken, available, error: err.message }) };
  }
};
