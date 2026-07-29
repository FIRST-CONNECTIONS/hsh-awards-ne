// netlify/lib/admin-nominations.js
// Fetches the Brevo CRM list of nominations and normalises each contact into
// a nomination-shaped object. Shared by admin-data.js (JSON view) and
// admin-export.js (CSV download) so pagination and field mapping only exist
// in one place.
//
// Known limitation: send-form.js writes contacts with updateEnabled:true,
// which means a nominator who submits twice overwrites their prior entry —
// only the most-recent nomination per unique email survives here. Phase 2
// (not this PR) should switch storage to Netlify Blobs so full history is
// preserved. For now the admin view accurately reflects Brevo's CRM state.

const BREVO_LIST_ID = 9;
const BREVO_BASE = 'https://api.brevo.com/v3';
const PAGE_LIMIT = 500;      // Brevo caps per-call at 500
const SAFETY_STOP = 10_000;  // hard ceiling — 10k contacts × 500/page = 20 calls

// Fetch every contact in the awards list, paginating until Brevo runs out.
// Returns { ok: true, contacts } on success, { ok: false, status, error } on
// any Brevo failure so the caller can bubble a useful message back to the UI.
async function fetchAllContacts(apiKey) {
  if (!apiKey) return { ok: false, status: 500, error: 'BREVO_API_KEY is not set in Netlify env vars' };

  const contacts = [];
  let offset = 0;

  while (offset < SAFETY_STOP) {
    const url = `${BREVO_BASE}/contacts/lists/${BREVO_LIST_ID}/contacts?limit=${PAGE_LIMIT}&offset=${offset}&sort=desc`;
    let res;
    try {
      res = await fetch(url, {
        headers: { 'api-key': apiKey, 'accept': 'application/json' },
      });
    } catch (err) {
      console.error('admin-nominations: network error calling Brevo', err);
      return { ok: false, status: 502, error: 'Could not reach Brevo. Try again in a moment.' };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let brevo = text;
      try { brevo = JSON.parse(text); } catch {}
      console.error('admin-nominations: Brevo error', { status: res.status, body: brevo });
      const msg = (brevo && typeof brevo === 'object' && brevo.message) ? brevo.message : `Brevo returned ${res.status}`;
      return { ok: false, status: 502, error: msg };
    }
    const data = await res.json();
    const page = Array.isArray(data.contacts) ? data.contacts : [];
    contacts.push(...page);
    if (page.length < PAGE_LIMIT) break;
    offset += PAGE_LIMIT;
  }

  return { ok: true, contacts };
}

// Turn a Brevo contact into the nomination shape the admin UI expects. Every
// value is coerced to a string so downstream CSV / JSON handling never has to
// null-check individual attributes.
function contactToNomination(c) {
  const a = (c && c.attributes) || {};
  return {
    email:       c.email || '',
    firstName:   String(a.FIRSTNAME || ''),
    lastName:    String(a.LASTNAME  || ''),
    nominee:     String(a.NOMINEE   || ''),
    category:    String(a.CATEGORY  || ''),
    enquiryType: String(a.ENQUIRY_TYPE || ''),
    source:      String(a.SOURCE    || ''),
    createdAt:   c.createdAt || '',
    modifiedAt:  c.modifiedAt || '',
  };
}

// The canonical list of the ten award categories. Kept here (rather than
// imported from sponsor-categories.js) so the admin dashboard can also show
// a zero-count row when a category has no nominations yet.
const ALL_CATEGORIES = [
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

module.exports = { fetchAllContacts, contactToNomination, ALL_CATEGORIES, BREVO_LIST_ID };
