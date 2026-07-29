// netlify/functions/admin-export.js
// GET /.netlify/functions/admin-export   (Bearer admin JWT)
//
// Streams a CSV of every nomination — Blob records first (with full form
// contents), then historical Brevo records (nominator only). Columns cover
// every useful field so the CSV is self-contained for offline analysis.

const { requireAuth } = require('../lib/admin-auth');
const { fetchAllNominations } = require('../lib/admin-nominations');

// RFC 4180-ish CSV escape: wrap in quotes if the value contains comma,
// quote or newline; double any embedded quotes. Excel and Google Sheets
// both round-trip this correctly.
function csvEscape(value) {
  if (value == null) return '';
  const s = String(value);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

exports.handler = async function (event) {
  const jsonHeaders = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };

  const auth = requireAuth(event);
  if (!auth.ok) {
    return { statusCode: auth.status, headers: jsonHeaders, body: JSON.stringify({ error: auth.error }) };
  }

  const result = await fetchAllNominations(process.env.BREVO_API_KEY);
  if (!result.ok) {
    return { statusCode: result.status, headers: jsonHeaders, body: JSON.stringify({ error: result.error }) };
  }

  const header = [
    'Submitted',
    'Source',
    'Type',
    'Nominator First Name',
    'Nominator Last Name',
    'Nominator Email',
    'Nominee',
    'Category',
    'Enquiry Type',
    'Reason / Message',
    'Record complete?',
    'Record ID',
  ];

  const rows = [header.map(csvEscape).join(',')];
  for (const n of result.rows) {
    rows.push([
      n.createdAt,
      n.source,
      n.type,
      n.firstName,
      n.lastName,
      n.email,
      n.nominee,
      n.category,
      n.enquiryType,
      n.reason,
      n.complete ? 'yes' : 'no',
      n.id,
    ].map(csvEscape).join(','));
  }

  // ISO date in the filename so repeated exports don't clobber each other.
  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `hsh-nominations-${stamp}.csv`;

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
    body: rows.join('\r\n'),
  };
};
