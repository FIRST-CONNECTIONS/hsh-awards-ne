#!/usr/bin/env node
/*
 * prerender.js — emit one static HTML file per SPA route.
 *
 * Clones index.html per route and swaps the head tags, so crawlers that don't
 * run JavaScript get the right meta instead of six copies of the home page's.
 * index.html stays the only file you edit by hand; the rest is build output.
 */

const fs = require('fs');
const path = require('path');

const SITE = 'https://ne-hsh-awards.co.uk';
const SRC = path.join(__dirname, 'index.html');

/* 'home' is index.html itself and is not re-emitted. */
const ROUTES = ['categories', 'vote', 'about', 'brand-kit', 'contact', 'sponsor'];

/* Read the maps back out of index.html so they stay authoritative there. */
function readMap(html, name) {
  const m = html.match(new RegExp('const\\s+' + name + '\\s*=\\s*(\\{[\\s\\S]*?\\n\\});'));
  if (!m) throw new Error(`prerender: could not find ${name} in index.html`);
  return new Function('return (' + m[1] + ')')();
}

function attr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function setMeta(html, selector, value) {
  const re = new RegExp(
    '(<meta\\s+' + selector + '\\s+content=")[^"]*(")',
    'i'
  );
  if (!re.test(html)) throw new Error(`prerender: no meta tag matching ${selector}`);
  return html.replace(re, '$1' + attr(value) + '$2');
}

const src = fs.readFileSync(SRC, 'utf8');
const titles = readMap(src, 'pageTitles');
const descriptions = readMap(src, 'pageDescriptions');

let written = 0;
for (const route of ROUTES) {
  const title = titles[route];
  const description = descriptions[route];
  if (!title || !description) {
    throw new Error(`prerender: missing title or description for route "${route}"`);
  }

  const url = `${SITE}/${route}`;
  let html = src;

  html = html.replace(
    /<title>[\s\S]*?<\/title>/i,
    '<title>' + attr(title) + '</title>'
  );
  html = html.replace(
    /(<link rel="canonical" href=")[^"]*(")/i,
    '$1' + attr(url) + '$2'
  );
  html = setMeta(html, 'name="description"', description);
  html = setMeta(html, 'property="og:title"', title);
  html = setMeta(html, 'property="og:description"', description);
  html = setMeta(html, 'property="og:url"', url);
  html = setMeta(html, 'name="twitter:title"', title);
  html = setMeta(html, 'name="twitter:description"', description);

  fs.writeFileSync(path.join(__dirname, `${route}.html`), html);
  written++;
}

console.log(`prerender: wrote ${written} route pages from index.html`);
