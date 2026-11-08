# Security

Please report vulnerabilities privately through
[GitHub's private vulnerability reporting](https://github.com/edihasaj/gatefox/security/advisories/new),
not in a public issue. Include the Gatefox version (`gateway --version`), what you
ran, and what happened. Do not include account tokens, client tokens, request
bodies or tool arguments; describe them instead.

You can expect an acknowledgement within a few days. Fixes ship in a normal
release, and the changelog credits the reporter unless you ask otherwise.

## Scope

Gatefox runs on your own Mac and listens on `127.0.0.1` by default. Reports are
especially welcome for:

- a way to reach the gateway from another machine without the client token;
- a credential, token, request body or tool argument written to a log, a report
  or another account;
- a request sent to an account, provider or billing plan other than the one selected;
- the gateway executing a tool itself instead of returning it to the client.
