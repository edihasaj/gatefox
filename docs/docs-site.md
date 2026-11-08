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

## One-time setup

1. In the public repository, set Pages to deploy from the `gh-pages` branch and
   enter `gatefox.dev` as the custom domain, then enable HTTPS.
2. In the Cloudflare DNS for `gatefox.dev`, add `A` records for `185.199.108.153`,
   `185.199.109.153`, `185.199.110.153` and `185.199.111.153`, and `AAAA` records
   for `2606:50c0:8000::153` through `2606:50c0:8003::153`, all DNS only (not
   proxied), so GitHub can issue the certificate.
3. Verify with `curl -fsSI https://gatefox.dev/` and `curl -fsSI https://gatefox.dev/reference.html`.
