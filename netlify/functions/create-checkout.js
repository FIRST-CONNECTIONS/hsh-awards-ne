// netlify/functions/create-checkout.js
// Creates a Stripe Checkout Session for category sponsorship.
// The Stripe secret key is stored as a Netlify environment variable.
// Set STRIPE_SECRET_KEY in Netlify → Site Settings → Environment Variables.
//
// Security notes:
//  • The price is fixed server-side (SPONSORSHIP_AMOUNT) so it can never be
//    tampered with from the browser — the client only sends which category.
//  • We call Stripe's REST API directly with fetch (form-encoded) so the
//    function has zero npm dependencies.

const SPONSORSHIP_AMOUNT = 250000; // £2,500.00 in pence, INCLUSIVE of VAT — edit here to change the price
const CURRENCY = 'gbp';
const VAT_PERCENTAGE = 20; // UK standard rate; applied as an INCLUSIVE rate so the total stays £2,500

// The ten award categories that may be sponsored. Used to validate input so
// arbitrary product names can't be injected into Checkout.
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

const FALLBACK_ORIGIN = 'https://ne-hsh-awards.co.uk';

// Reuse a single inclusive VAT tax rate across invocations (cached per warm
// container). Prefers STRIPE_TAX_RATE_ID if set, otherwise finds an existing
// matching rate in the Stripe account, otherwise creates one. Returns null on
// failure so checkout still proceeds (the total is unchanged either way).
let cachedTaxRateId = null;
async function getVatTaxRateId(key) {
  if (cachedTaxRateId) return cachedTaxRateId;
  if (process.env.STRIPE_TAX_RATE_ID) { cachedTaxRateId = process.env.STRIPE_TAX_RATE_ID; return cachedTaxRateId; }

  const auth = { Authorization: `Bearer ${key}` };
  try {
    // Look for an existing active, inclusive 20% VAT rate to avoid duplicates.
    const listRes = await fetch('https://api.stripe.com/v1/tax_rates?limit=100&active=true', { headers: auth });
    const list = await listRes.json();
    if (listRes.ok && Array.isArray(list.data)) {
      const found = list.data.find(r =>
        r.inclusive && Number(r.percentage) === VAT_PERCENTAGE && (r.display_name || '').toUpperCase() === 'VAT');
      if (found) { cachedTaxRateId = found.id; return cachedTaxRateId; }
    }

    // None found — create one.
    const p = new URLSearchParams();
    p.append('display_name', 'VAT');
    p.append('description', 'UK VAT');
    p.append('percentage', String(VAT_PERCENTAGE));
    p.append('inclusive', 'true');
    p.append('country', 'GB');
    const createRes = await fetch('https://api.stripe.com/v1/tax_rates', {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: p.toString(),
    });
    const created = await createRes.json();
    if (createRes.ok) { cachedTaxRateId = created.id; return cachedTaxRateId; }
    console.error('Could not create VAT tax rate:', created);
  } catch (err) {
    console.error('VAT tax rate lookup failed:', err);
  }
  return null;
}

exports.handler = async function (event) {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { category, email, business } = body;

  if (!category || !CATEGORIES.includes(category)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Please choose a valid award category.' }) };
  }

  const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
  if (!STRIPE_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Payments are not configured yet.' }) };
  }

  // Build success / cancel URLs from the request origin where possible.
  const origin = event.headers.origin || event.headers.Origin || FALLBACK_ORIGIN;
  const successUrl = `${origin}/sponsor?paid=success&session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl = `${origin}/sponsor?paid=cancel`;

  // Stripe's API is form-encoded; nested params use bracket notation.
  const params = new URLSearchParams();
  params.append('mode', 'payment');
  params.append('success_url', successUrl);
  params.append('cancel_url', cancelUrl);
  params.append('billing_address_collection', 'required');
  params.append('line_items[0][quantity]', '1');
  params.append('line_items[0][price_data][currency]', CURRENCY);
  params.append('line_items[0][price_data][unit_amount]', String(SPONSORSHIP_AMOUNT));
  params.append('line_items[0][price_data][product_data][name]', `Category Sponsorship — ${category}`);
  params.append('line_items[0][price_data][product_data][description]', 'NE High Street Heroes Awards 2026 · price includes VAT');

  // Apply an inclusive VAT rate so the receipt itemises VAT without changing the £2,500 total.
  const vatRateId = await getVatTaxRateId(STRIPE_KEY);
  if (vatRateId) params.append('line_items[0][tax_rates][0]', vatRateId);

  params.append('metadata[category]', category);
  if (business) params.append('metadata[business]', String(business).slice(0, 200));
  if (email) params.append('customer_email', String(email).slice(0, 200));

  try {
    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${STRIPE_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    const data = await res.json();

    if (!res.ok) {
      console.error('Stripe error:', data);
      const msg = (data && data.error && data.error.message) || 'Could not start checkout.';
      return { statusCode: 502, headers, body: JSON.stringify({ error: msg }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ url: data.url }) };

  } catch (err) {
    console.error('Checkout function error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
