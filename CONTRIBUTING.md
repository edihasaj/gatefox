# Contributing

Thanks for helping. Issues and pull requests are welcome.

## Before you start

- Read the [guide](https://gatefox.dev) and the doc page for the area you change;
  every page lists when to read it on [All docs](https://gatefox.dev/reference.html).
- For a larger change, open an issue first so we can agree on the approach.
- GateFox translates and transports requests. Your client owns tools,
  permissions, roles and model choices, and changes must keep it that way.

## Development

Use Node 22 or later and npm.

```sh
npm ci
npm run build && npm run check && npm test
npm run docs:serve     # preview the docs site at http://127.0.0.1:8765
```

Tests run in a private temporary home and never touch a real installation.

## Pull requests

- Keep each pull request focused, and add a regression test for a bug fix.
- Update the docs when behavior changes, and add a line to `CHANGELOG.md`
  under **Unreleased**.
- Use [Conventional Commits](https://www.conventionalcommits.org/) such as
  `fix: ...` or `docs: ...`.
- Never include tokens, request bodies, tool arguments or personal paths in code,
  tests, logs or screenshots.
- Hosted CI runs only when a maintainer starts it, so run the full local gate
  above before you open the pull request.

By contributing, you agree that your contribution is licensed under the
[MIT License](LICENSE).
