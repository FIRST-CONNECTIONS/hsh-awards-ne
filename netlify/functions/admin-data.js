// netlify/functions/admin-data.js
// GET /.netlify/functions/admin-data
// Authorization: Bearer <ADMIN_JWT>
//
// Returns:
//   {
//     total,
//     nominations: [{ email, firstName, lastName, nominee, category, ... }],
//     categoryCounts: { "Retailer of the Year": 12, ... } // every category, zero-filled
//   }
//
// Requires a valid admin JWT (see admin-login.js). Pulls the Brevo CRM list
// via the shared fetcher and normalises the shape for the dashboard UI.

const { requireAuth } = require('../lib/admin-auth');
const { fetchAllContacts, contactToNomination, ALL_CATEGORIES } = require('../lib/admin-nominations');

exports.handler = async function (event) {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

  const auth = requireAuth(event);
  if (!auth.ok) {
    return { statusCode: auth.status, headers, body: JSON.stringify({ error: auth.error }) };
  }

  const result = await fetchAllContacts(process.env.BREVO_API_KEY);
  if (!result.ok) {
    return { statusCode: result.status, headers, body: JSON.stringify({ error: result.error }) };
  }

  const nominations = result.contacts.map(contactToNomination);

  // Zero-fill so every category appears in the summary, even the ones nobody
  // has nominated for yet — the dashboard shows category coverage at a glance.
  const categoryCounts = {};
  for (const cat of ALL_CATEGORIES) categoryCounts[cat] = 0;
  for (const n of nominations) {
    if (n.category && Object.prototype.hasOwnProperty.call(categoryCounts, n.category)) {
      categoryCounts[n.category] += 1;
    } else if (n.category) {
      // Unrecognised category value — count it separately so ops sees the drift.
      categoryCounts[n.category] = (categoryCounts[n.category] || 0) + 1;
    }
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      total: nominations.length,
      nominations,
      categoryCounts,
    }),
  };
};
