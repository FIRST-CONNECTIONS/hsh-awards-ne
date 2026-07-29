// netlify/functions/admin-data.js
// GET /.netlify/functions/admin-data   (Bearer admin JWT)
//
// Returns the merged nomination list — Blob storage (new, complete records)
// deduplicated against Brevo (historical, nominator-only) — plus per-category
// counts and a source breakdown so the dashboard can show data-quality info.

const { requireAuth } = require('../lib/admin-auth');
const { fetchAllNominations, ALL_CATEGORIES } = require('../lib/admin-nominations');

exports.handler = async function (event) {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

  const auth = requireAuth(event);
  if (!auth.ok) {
    return { statusCode: auth.status, headers, body: JSON.stringify({ error: auth.error }) };
  }

  const result = await fetchAllNominations(process.env.BREVO_API_KEY);
  if (!result.ok) {
    return { statusCode: result.status, headers, body: JSON.stringify({ error: result.error }) };
  }

  const nominations = result.rows;

  // Zero-fill so every award category appears in the summary, even the ones
  // nobody has nominated for yet. Unknown categories (typos / drift) fall
  // through to their own bucket so ops sees the deviation.
  const categoryCounts = {};
  for (const cat of ALL_CATEGORIES) categoryCounts[cat] = 0;
  for (const n of nominations) {
    if (!n.category) continue;
    if (Object.prototype.hasOwnProperty.call(categoryCounts, n.category)) categoryCounts[n.category] += 1;
    else categoryCounts[n.category] = (categoryCounts[n.category] || 0) + 1;
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      total: nominations.length,
      nominations,
      categoryCounts,
      sources: result.counts,   // { blob, brevo, merged } — surfaced in UI banner
    }),
  };
};
