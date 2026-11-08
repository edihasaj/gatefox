---
summary: 'How the gatefox.dev docs site is built from docs/ and published to GitHub Pages.'
read_when:
  - Editing the guide, a doc page or the docs site builder
  - Publishing the docs site or changing its domain
---

# Docs site

`scripts/build-docs-site.mjs` builds the site into `.state/docs-site`. It copies
the hand-written guide (`docs/index.html`, `styles.css`, `app.js`, `assets/`),
renders every `docs/*.md` page to HTML with `marked` (MIT, build-time only), and
writes `reference.html`, a grouped list of every page built from its front
matter. A page missing from every group appears under "More", so none is dropped.
Links between docs become site pages; links to other repository files go to
GitHub.

```sh
npm run docs:serve      # build and preview at http://127.0.0.1:8765
npm run docs:deploy -- --remote https://github.com/edihasaj/gatefox.git          # dry run
npm run docs:deploy -- --remote https://github.com/edihasaj/gatefox.git --push   # publish
```

The deploy script builds into a temporary folder under `/tmp`, adds `CNAME`
(`gatefox.dev`) and `.nojekyll`, commits the result as a fresh `gh-pages` branch
and, only with `--push`, force-pushes that branch. The branch holds generated
files only. It adds no Actions workflow, so the [CI cost policy](ci-cost-policy.md)
is unchanged; GitHub serves a branch-based Pages site of a public repository at
no cost.

## Search and sharing

Every page gets a title, description, canonical URL, `robots` with
`max-image-preview:large`, Open Graph and Twitter tags with its own 1200x630 image,
and JSON-LD (`SoftwareApplication` on the guide, `TechArticle` and `BreadcrumbList`
on doc pages). The build also writes `robots.txt`, `sitemap.xml` (every page with its
image) and `site.webmanifest`; the 404 page is `noindex`. The guide's head is replaced
at build time, so edit its description in `guideSeo`, not in `docs/index.html`.

Share images live in `docs/assets/og/<page>.jpg`. After adding a page or changing a
title or summary, run `node scripts/render-og-images.mjs` (needs `abx`) and commit the
images. The template is `scripts/og/template.html`.

The deploy adds the shared IndexNow key file (`/<key>.txt`) from `COMPASS_INDEXNOW_KEY`
or `~/.config/compass/search-provider-credentials.json`; the key is never committed to
the source. Bing ownership uses the account-wide `msvalidate.01` tag; Google ownership
uses a DNS TXT record in the `gatefox.dev` zone. Lighthouse scores 100 for performance,
accessibility, best practices and SEO on the guide, All docs and doc pages.

## Hosting

The site is served by GitHub Pages from the `gh-pages` branch of
`edihasaj/gatefox`, with custom domain `gatefox.dev` and HTTPS enforced. The
Cloudflare zone `gatefox.dev` (account "Edi") holds two DNS-only records, set up
on 8 November 2026 through the dashboard's BIND import, because the Wrangler
login cannot edit DNS:

| Name | Type | Content | Proxy |
| --- | --- | --- | --- |
| `gatefox.dev` | CNAME (flattened at the apex) | `edihasaj.github.io` | DNS only |
| `www.gatefox.dev` | CNAME | `edihasaj.github.io` | DNS only |

Keep both records unproxied; GitHub issues the certificate only when it sees its
own addresses. Every `.dev` name is HTTPS-only in browsers, so the site opens
there only once that certificate exists.

Verify a publish with:

```sh
curl -fsSI https://gatefox.dev/
curl -fsS https://gatefox.dev/reference.html | grep -o '<title>[^<]*'
gh api repos/edihasaj/gatefox/pages -q '{status: .status, https: .https_enforced, cname: .cname}'
```
