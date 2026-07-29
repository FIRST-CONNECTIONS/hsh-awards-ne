# NE High Street Heroes Awards — repo guide

Static site for the NE High Street Heroes Awards 2026, deployed to Netlify.
No framework, no package.json, no test suite.

## Layout

- `index.html` — the whole single-page app: markup, inline `<style>`, inline
  `<script>`. This is the only page you edit by hand.
- `privacy-policy.html` — standalone page, separate from the SPA.
- `admin.html` — standalone admin dashboard, served at `/admin` (rewrite in
  `netlify.toml`). Not prerendered, not indexed. Requires `ADMIN_PASSWORD`,
  `ADMIN_JWT_SECRET`, and `BREVO_API_KEY` env vars to be set (Functions scope).
- `prerender.js` — build step. Clones `index.html` once per route with that
  route's title, description, canonical and og tags swapped in. Run by Netlify
  via `command = "node prerender.js"`.
- `netlify/functions/` — serverless endpoints (Brevo email, Stripe checkout).
- `netlify.toml` — headers, cache rules and clean-URL rewrites.
- `fonts/` — self-hosted Playfair Display and DM Sans (variable woff2).
- `images/`, `NEHSH-2026-Brand-Kit/` — assets.

## Things worth knowing before you edit

- **Generated files are gitignored.** `about.html`, `categories.html`,
  `vote.html`, `brand-kit.html`, `contact.html` and `sponsor.html` are build
  output. Editing them does nothing — change `index.html` and re-run
  `node prerender.js`.
- **Page titles and descriptions live in one place.** The `pageTitles` and
  `pageDescriptions` maps in the inline script are read both by `showPage()` at
  runtime and by `prerender.js` at build time. Add a route to both those maps
  and to the `ROUTES` array in `prerender.js`.
- **Adding a route also means adding a rewrite** in `netlify.toml`
  (`/newroute` → `/newroute.html`) and a cache header rule for the same path.
  Header rules match the request path, so `/*.html` does not cover `/newroute`.
- **The canonical host is the apex**, `https://ne-hsh-awards.co.uk`. Netlify
  301s `www` to it. Do not reintroduce `www` in canonicals, og tags or the
  sitemap.
- **Fonts are self-hosted** and the CSP sets `font-src 'self'`. Do not add a
  Google Fonts link back without updating the policy in `netlify.toml`.
- **Both families are variable fonts**, so one `@font-face` per style covers the
  whole weight range — there is no per-weight file.
- **Form submissions** POST to `netlify/functions/send-form`, which forwards
  to Brevo. The function returns non-2xx on any Brevo failure and logs the
  full response body via `console.error`, so if nominations stop arriving,
  check the Netlify function logs — the actual Brevo error message will be
  there. The function fails loud on purpose; the previous silent-success
  behaviour hid real problems (unverified sender, expired API key, etc.).
- **When Brevo returns 2xx but nothing shows up in the awards inbox**, the
  failure is at delivery time (spam, DMARC quarantine, self-send drop), not
  send time. Hit `/.netlify/functions/brevo-diag?token=<BREVO_DIAG_TOKEN>`
  from a browser — it asks Brevo directly which senders are verified, which
  domains have DKIM/SPF, and what happened to recent sends
  (`delivered`/`bounced`/`spam`/`blocked`). The endpoint refuses to respond
  unless `BREVO_DIAG_TOKEN` is set in Netlify env vars.
- **Sender identity** for outbound mail is `SENDER_EMAIL` + `SENDER_NAME`
  env vars, falling back to `awards@first-connections.co.uk` /
  `HSH Awards Website`. Point `SENDER_EMAIL` at whichever address is
  verified as a sender in Brevo *and* whose domain is DKIM/SPF authenticated
  there — typically a distinct address (e.g. `no-reply@ne-hsh-awards.co.uk`)
  rather than the awards inbox itself, because From = To trips anti-spoofing
  filters at Google Workspace and Microsoft 365.
- **Colour contrast**: the brand pink only reaches 2.3:1 on the cream and white
  panels, so those sections use `--pink-ink`. Keep the bright `--pink` for dark
  sections only.
- **Admin dashboard** (`/admin`) is a standalone page with its own auth flow:
  password → `POST /.netlify/functions/admin-login` → HS256 JWT →
  `Authorization: Bearer …` on every subsequent admin-* request. Token lives
  in `sessionStorage` (auto-clears on tab close). Auth utilities live in
  `netlify/lib/admin-auth.js`; Brevo list-fetch + normalisation lives in
  `netlify/lib/admin-nominations.js`. Env vars required (all Functions scope):
    - `ADMIN_PASSWORD`   — the shared admin password
    - `ADMIN_JWT_SECRET` — long random string (`openssl rand -hex 32`) used
      to sign session tokens; rotating this instantly invalidates every
      logged-in session, which is the panic button for a leaked password
    - `BREVO_API_KEY`    — reused from the form/diag flow
- **Nomination history has one row per unique nominator email** — the send-form
  function writes contacts with `updateEnabled:true`, so a repeat nominator
  overwrites their earlier entry. If we ever need full submission history in
  the admin panel, add Netlify Blobs storage in `send-form.js` and read from
  both sources in `admin-nominations.js` (see the note at the top of that file).

## Local development

```bash
node prerender.js          # generate the route pages
python3 -m http.server 8899
```

Clean URLs (`/about`) will 404 locally — that routing comes from `netlify.toml`.
Use `netlify dev` if you need the rewrites, headers and functions.
