// netlify/lib/admin-nominations.js
// Assembles the admin dashboard's nomination list from TWO sources:
//   1. Netlify Blobs — the new source-of-truth: one immutable JSON blob per
//      submission with the full form contents (nominee, category, reason,
//      raw fields, metadata). Powered by netlify/lib/nomination-store.js.
//   2. Brevo CRM list 9 — the historical archive from before Blob storage
//      was introduced. Nominator email + name only; nominee / category are
//      empty (Brevo custom attributes were never defined at the account
//      level so they were silently dropped).
//
// The two sources are merged and de-duplicated by (email + minute-precision
// timestamp) so a submission that landed after the storage switch and
// therefore exists in both doesn't show up twice.

const { listSubmissions } = require('./nomination-store');

const BREVO_LIST_ID = 9;
const BREVO_BASE = 'https://api.brevo.com/v3';
const PAGE_LIMIT = 500;      // Brevo caps per-call at 500
const SAFETY_STOP = 10_000;  // hard ceiling — 10k contacts × 500/page = 20 calls

// ── Brevo pagination (unchanged) ───────────────────────────────────────
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

// ── Shape adapters ─────────────────────────────────────────────────────

// Historical Brevo contact → nomination row.
function contactToNomination(c) {
  const a = (c && c.attributes) || {};
  return {
    id:          `brevo/${c.id || c.email}`,
    source:      'brevo',
    type:        'nomination',            // Brevo list 9 is the nominations list
    email:       c.email || '',
    firstName:   String(a.FIRSTNAME || ''),
    lastName:    String(a.LASTNAME  || ''),
    nominee:     String(a.NOMINEE   || ''),
    category:    String(a.CATEGORY  || ''),
    enquiryType: String(a.ENQUIRY_TYPE || ''),
    reason:      '',                       // Never captured to Brevo
    fields:      null,                     // Not available for historical records
    createdAt:   c.createdAt || '',
    modifiedAt:  c.modifiedAt || '',
    complete:    false,                    // Brevo record — missing fields
  };
}

// New Blob submission → nomination row.
function blobToNomination(b) {
  return {
    id:          b.id,
    source:      'blob',
    type:        b.type || 'other',
    email:       (b.nominator && b.nominator.email) || '',
    firstName:   (b.nominator && b.nominator.firstName) || '',
    lastName:    (b.nominator && b.nominator.lastName)  || '',
    nominee:     b.nominee || '',
    category:    b.category || '',
    enquiryType: b.enquiryType || '',
    reason:      b.reason || '',
    fields:      b.fields || null,
    createdAt:   b.createdAt || '',
    modifiedAt:  b.createdAt || '',
    complete:    true,                     // Blob record — full form captured
  };
}

// Round an ISO timestamp to the nearest minute so a submission that arrives
// in both Blob and Brevo (Blob is written after Brevo contact-add returns)
// can be recognised as the same record.
function minuteKey(iso, email) {
  const t = new Date(iso).getTime();
  if (isNaN(t)) return `${email}|`;
  const rounded = Math.floor(t / 60_000) * 60_000;
  return `${email.toLowerCase()}|${rounded}`;
}

// Merge sources: prefer Blob when we have both. Sort newest first.
function mergeSources(blobs, contacts) {
  const rows = [];
  const claimed = new Set();
  for (const b of blobs) {
    const row = blobToNomination(b);
    rows.push(row);
    claimed.add(minuteKey(row.createdAt, row.email));
  }
  for (const c of contacts) {
    const row = contactToNomination(c);
    if (!claimed.has(minuteKey(row.createdAt, row.email))) rows.push(row);
  }
  rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return rows;
}

// Public: fetch both sources in parallel, return merged nomination list plus
// per-source counts so the dashboard can show data-quality info.
async function fetchAllNominations(apiKey) {
  const [blobList, contactRes] = await Promise.all([
    listSubmissions({ type: 'nomination', limit: 5000 }),
    fetchAllContacts(apiKey),
  ]);
  if (!contactRes.ok) {
    // Brevo is down but we may still have Blobs — return what we have.
    if (blobList.length === 0) return { ok: false, status: contactRes.status, error: contactRes.error };
    console.warn('admin-nominations: Brevo unreachable, returning Blob records only');
    const rows = mergeSources(blobList, []);
    return { ok: true, rows, counts: { blob: blobList.length, brevo: 0, merged: rows.length } };
  }
  const rows = mergeSources(blobList, contactRes.contacts);
  return {
    ok: true,
    rows,
    counts: { blob: blobList.length, brevo: contactRes.contacts.length, merged: rows.length },
  };
}

// The canonical list of the ten award categories.
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

module.exports = {
  fetchAllContacts,       // still exported for anyone that just wants Brevo
  contactToNomination,
  blobToNomination,
  fetchAllNominations,    // new: merged view
  ALL_CATEGORIES,
  BREVO_LIST_ID,
};
