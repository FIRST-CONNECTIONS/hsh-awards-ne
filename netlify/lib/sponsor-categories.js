// Single source of truth for award-category sponsorship state.
// Required by netlify/functions/categories-status.js and create-checkout.js.
// Lives outside the functions directory so Netlify never treats it as a
// deployable function; the esbuild bundler inlines it into any function that
// requires it.

// The ten award categories that may be sponsored.
const CATEGORIES = Object.freeze([
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
]);

// Categories already sponsored via off-Stripe direct partnerships. Always
// excluded from the /sponsor dropdown and rejected at checkout — keep this
// list in sync with the sponsor-to-category mapping shown on the homepage
// and the categories page.
const MANUALLY_SPONSORED = Object.freeze([
  'Hospitality Hero',                  // NE Hotels Association
  'Digital Innovator',                 // Surgotech Solutions
  'Sustainability Leader',             // Lumo Trains
  'Independent Business of the Year',  // The Ironing Man
  'High Street of the Year',           // Roam Local
]);

// Precomputed once per cold-start; Set gives O(1) lookups on every request.
const MANUALLY_SPONSORED_SET = new Set(MANUALLY_SPONSORED);

// Merge a list of Stripe-paid categories with the manually-sponsored list and
// return both the taken and available views in a single pass — used by
// categories-status.js to build its JSON response.
function computeAvailability(paidList = []) {
  const takenSet = new Set(MANUALLY_SPONSORED);
  for (const c of paidList) takenSet.add(c);
  const available = CATEGORIES.filter(c => !takenSet.has(c));
  return { taken: [...takenSet], available };
}

module.exports = {
  CATEGORIES,
  MANUALLY_SPONSORED,
  MANUALLY_SPONSORED_SET,
  computeAvailability,
};
