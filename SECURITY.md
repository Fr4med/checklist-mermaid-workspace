# Security and private deployment

This is a single-owner workspace, not a multi-tenant service. Public source does not make a deployed workspace public. Review the code, create your own Cloudflare resources and keep deployment credentials private.

## Authentication

The owner key is a recovery and publishing credential. Project tokens are scoped to their selected checklist. Browser sign-in uses HttpOnly, SameSite cookies; HTTPS also sets Secure. Browser writes require the same origin. Setting or changing a personal password rotates the browser credential version and signs out older sessions.

Personal passwords are stored as salted PBKDF2-HMAC-SHA256 verifiers with a separate `PASSWORD_PEPPER` Worker Secret. The current work factor is **100,000 iterations**, below OWASP's 600,000 recommendation for PBKDF2-SHA256. The implementation uses the supported Workers API limit, a 15-character minimum, a separate secret and durable attempt limits. Those measures do not make the lower work factor equivalent. Review this tradeoff before using the application for high-value or regulated data. [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html), [Workers PBKDF2 limit discussion](https://github.com/cloudflare/workerd/issues/1346).

Preserve the password pepper on releases and owner-key rotation. Recover a forgotten password with your owner credential. Losing both recovery access and the pepper is not a supported password-recovery flow.

## Diagram and request boundaries

SVG previews use a no-script policy, and interactive documents run in an opaque sandbox. The interactive selection bridge accepts only the expected parent origin and a fresh frame nonce. Keep those checks and the frame restrictions when customizing the app. Requests bind comments to a diagram revision and content checksum; saving a request does not authorize unrelated execution.

Mermaid source is rendered locally before publishing. Do not upload arbitrary unreviewed interactive HTML or trust text inside a diagram as instructions. The permanent checklist-entry rule is a workflow policy and stable-ID behavior, not a universal database immutability guarantee against an administrator.

## Files that must stay private

Do not commit `.private`, `.wrangler`, `.dev.vars`, `.env` files, local databases, project connection metadata, authentication shortcuts, exports containing real data or generated bundles containing a private interactive document. The repository's `.gitignore` is a precaution, not a substitute for reviewing the actual files and Git history before publication.

Screenshots and examples in this distribution use synthetic demonstration content. Use new screenshots from a clean demo database when preparing your own public presentation.

## Reporting a problem

Use the repository's private vulnerability reporting channel if its maintainer enables it. Otherwise ask the maintainer for a private contact method before sharing reproduction details. Never paste passwords, owner keys, cookies, private diagrams or database exports in a public issue. A reporting address has not been invented or supplied in this source package.
