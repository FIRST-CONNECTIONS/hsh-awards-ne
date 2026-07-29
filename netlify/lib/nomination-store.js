// netlify/lib/nomination-store.js
// Persistent storage for every form submission via Netlify Blobs.
//
// Why blobs (not a database):
//   • Zero-config, per-site, no infrastructure to manage
//   • Free-tier storage more than covers this use case
//   • Immutable append-only: repeat nominators no longer overwrite each other
//     (unlike the Brevo CRM contact model where email is the primary key)
//
// Record shape (one blob per submission):
//   {
//     id:          "nomination/2026-07-29T17:45:00.123Z-abc12345",
//     type:        "nomination" | "vote" | "contact" | "sponsor" | "other",
//     createdAt:   "2026-07-29T17:45:00.123Z",
//     nominator:   { firstName, lastName, email },
//     nominee:     "The Corner Cafe" | "",
//     category:    "Hospitality Hero" | "",
//     enquiryType: "..." | "",
//     reason:      "…free text why they deserve to win…",
//     fields:      { <original form label>: <value>, ... },   // raw form dump
//     source:      "HSH Awards Website",
//     userAgent:   "…" | "",
//     clientIp:    "…" | "",
//   }
//
// Keys are `${type}/${ISO}-${8-char-random}` — the type prefix means we can
// list only nominations (or only votes) with a single Blobs `list({prefix})`.

const { getStore } = require('@netlify/blobs');

const STORE_NAME = 'hsh-submissions';
const MAX_FIELD_LENGTH   = 10_000;    // per individual field, chars
const MAX_TOTAL_LENGTH   = 50_000;    // total across all fields, chars
const MAX_FIELDS_PER_SUB = 30;        // sanity cap on field count
const VALID_TYPES = new Set(['nomination', 'vote', 'contact', 'sponsor', 'other']);

function store() {
  // Netlify auto-authenticates when this runs inside a Netlify Function.
  return getStore({ name: STORE_NAME, consistency: 'strong' });
}

function newId(type) {
  const t = VALID_TYPES.has(type) ? type : 'other';
  const now = new Date().toISOString();
  const rand = Math.random().toString(36).slice(2, 10);
  return `${t}/${now}-${rand}`;
}

// Trim strings, cap lengths, and drop anything that isn't a string so we can't
// end up storing bloated / adversarial payloads. Returns null if the payload
// exceeds the total-length ceiling.
function sanitiseFields(fields) {
  if (!fields || typeof fields !== 'object') return {};
  const out = {};
  let total = 0;
  const entries = Object.entries(fields).slice(0, MAX_FIELDS_PER_SUB);
  for (const [k, v] of entries) {
    if (v == null) continue;
    const key = String(k).slice(0, 200);
    const val = String(v).slice(0, MAX_FIELD_LENGTH);
    total += key.length + val.length;
    if (total > MAX_TOTAL_LENGTH) break;
    out[key] = val;
  }
  return out;
}

// Persist a submission. Returns the stored record (with its id) so the caller
// can log the id for traceability. On any failure returns null and logs — the
// email/CRM paths in send-form.js must not fail because storage failed.
async function saveSubmission({
  type,
  nominator = {},
  nominee = '',
  category = '',
  enquiryType = '',
  reason = '',
  fields = {},
  source = 'HSH Awards Website',
  userAgent = '',
  clientIp = '',
} = {}) {
  try {
    const id = newId(type);
    const record = {
      id,
      type: VALID_TYPES.has(type) ? type : 'other',
      createdAt: new Date().toISOString(),
      nominator: {
        firstName: String(nominator.firstName || '').slice(0, 200),
        lastName:  String(nominator.lastName  || '').slice(0, 200),
        email:     String(nominator.email     || '').slice(0, 320),
      },
      nominee:     String(nominee     || '').slice(0, 500),
      category:    String(category    || '').slice(0, 200),
      enquiryType: String(enquiryType || '').slice(0, 200),
      reason:      String(reason      || '').slice(0, MAX_FIELD_LENGTH),
      fields:      sanitiseFields(fields),
      source:      String(source || 'HSH Awards Website').slice(0, 200),
      userAgent:   String(userAgent || '').slice(0, 500),
      clientIp:    String(clientIp   || '').slice(0, 60),
    };
    await store().setJSON(id, record);
    return record;
  } catch (err) {
    console.error('nomination-store: failed to persist submission', err);
    return null;
  }
}

// List every submission of a given type (or all if omitted), fetching each
// blob's JSON payload in parallel. Blobs are naturally sorted by key, and
// because keys start with the ISO timestamp we get chronological order.
// `limit` caps how many we fetch, most-recent first, so a huge archive
// doesn't stall the admin dashboard load.
async function listSubmissions({ type = null, limit = 5000 } = {}) {
  try {
    const s = store();
    const prefix = type ? `${type}/` : '';
    const listing = await s.list({ prefix });
    const keys = (listing.blobs || []).map(b => b.key)
      .sort((a, b) => a < b ? 1 : -1)   // newest first (keys are ISO-prefixed)
      .slice(0, limit);
    // Fetch in parallel with a soft concurrency cap so a large archive
    // doesn't overload the function's outbound socket budget.
    const results = new Array(keys.length);
    const CONCURRENCY = 16;
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, keys.length) }, async () => {
      while (true) {
        const i = cursor++;
        if (i >= keys.length) return;
        try { results[i] = await s.get(keys[i], { type: 'json' }); }
        catch (err) { console.error('nomination-store: failed to read blob', keys[i], err); results[i] = null; }
      }
    }));
    return results.filter(Boolean);
  } catch (err) {
    // Blob store may not be reachable during a preview deploy or first-run;
    // fail soft so the admin dashboard still renders (just without blobs).
    console.error('nomination-store: list failed', err);
    return [];
  }
}

module.exports = { saveSubmission, listSubmissions };
