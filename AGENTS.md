# NE High Street Heroes Awards — repo guide

Static site for the NE High Street Heroes Awards 2026, deployed to Netlify.
No framework, no package.json, no test suite.

## Layout

- `index.html` — the whole single-page app: markup, inline `<style>`, inline
  `<script>`. This is the only page you edit by hand.
- `privacy-policy.html` — standalone page, separate from the SPA.
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
- **Forms carry a honeypot** (`.hp-field`, name `website`). It is excluded from
  the field sweep in `submitMailto()` and checked in
  `netlify/functions/send-form.js`.
- **Colour contrast**: the brand pink only reaches 2.3:1 on the cream and white
  panels, so those sections use `--pink-ink`. Keep the bright `--pink` for dark
  sections only.

## Local development

```bash
node prerender.js          # generate the route pages
python3 -m http.server 8899
```

Clean URLs (`/about`) will 404 locally — that routing comes from `netlify.toml`.
Use `netlify dev` if you need the rewrites, headers and functions.
