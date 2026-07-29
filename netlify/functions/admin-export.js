// netlify/functions/admin-export.js
// GET /.netlify/functions/admin-export
// Authorization: Bearer <ADMIN_JWT>
//
// Streams a CSV of every nomination in the Brevo list. Because the admin UI
// passes the auth token in a Bearer header, the browser can't just navigate
// to this URL — the frontend fetches the CSV, converts to a Blob, and
// triggers a download via a temporary object URL. See admin.html.

const { requireAuth } = require('../lib/admin-auth');
const { fetchAllContacts } = require('../lib/admin-nominations');

// RFC 4180-ish CSV escape: wrap the value in quotes if it contains a comma,
// quote, or newline; double any embedded quotes. Excel and Google Sheets
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

  const result = await fetchAllContacts(process.env.BREVO_API_KEY);
  if (!result.ok) {
    return { statusCode: result.status, headers: jsonHeaders, body: JSON.stringify({ error: result.error }) };
  }

  const header = [
    'Submitted', 'Nominator Email', 'Nominator First Name', 'Nominator Last Name',
    'Nominee', 'Category', 'Enquiry Type', 'Source',
  ];

  const rows = [header.map(csvEscape).join(',')];
  for (const c of result.contacts) {
    const a = c.attributes || {};
    rows.push([
      c.createdAt,
      c.email,
      a.FIRSTNAME,
      a.LASTNAME,
      a.NOMINEE,
      a.CATEGORY,
      a.ENQUIRY_TYPE,
      a.SOURCE,
    ].map(csvEscape).join(','));
  }

  // ISO date in the filename so repeated exports don't clobber each other in
  // the downloads folder.
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
