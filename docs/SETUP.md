# Set up your own workspace

Use Node.js 22.16 or newer and your own Cloudflare account. The application needs one Worker and one D1 database. This source tree contains no hosted account, database, owner credential, personal password or connected project.

The publishing CLIs protect your home directory by default. Put this checkout and projects you enroll in a directory outside that protected home location. The browser application itself does not need access to local project files.

## Install and check

```sh
npm ci
npm run build
npm test
```

Build and tests do not deploy a Worker, connect to someone else's service or invoke a language model. Tests use synthetic credentials and an in-memory database. The optional browser renderer is not needed for these checks.

## Local development

Run `npm run dev` once to see the local origin printed by Wrangler, then stop that development process with Ctrl+C. The unconfigured private API rejects access at this point. Generate your own ignored credentials for the printed origin, apply the local migrations and start it again:

```sh
npm run setup -- --url <your-localhost-origin>
npx wrangler d1 migrations apply checklist-mermaid --local
npm run dev
```

The setup command writes `.dev.vars`, `.private/deploy-secrets.json`, `.private/service.json` and `.private/open-workspace.html`. It prints no credential values and does not contact the cloud. If a generated file already contains different settings, it stops instead of replacing them. If you choose a different origin later, preserve your credentials and update the private service URL and shortcut deliberately.

The all-zero-style D1 identifier in `wrangler.jsonc` is a placeholder, never a deployed database. For local work the Wrangler binding provides the local database; replace the identifier before remote deployment. Follow the URL printed by Wrangler rather than relying on a hardcoded port in this repository.

Open `.private/open-workspace.html` directly in a normal browser window. Do not open it inside an embedded document preview: the application intentionally blocks framing. The shortcut signs in with your local owner credential, then removes the credential fragment from the address bar. Use the key icon to set a personal password. That password works in Checklist and Mermaid.

## Cloudflare deployment

Authenticate Wrangler with your own account, then create a new D1 database:

```sh
npx wrangler login
npx wrangler d1 create checklist-mermaid
```

Replace `database_id` in `wrangler.jsonc` with the identifier returned for your database. Confirm the Worker name and intended account before any remote command. Apply all six migrations only to this new database:

```sh
npx wrangler d1 migrations apply checklist-mermaid --remote
npm run build
npx wrangler deploy
```

Use the deployed HTTPS origin to generate the ignored private files in a fresh checkout or deliberate deployment configuration:

```sh
npm run setup -- --url <your-deployed-https-origin>
npx wrangler secret bulk .private/deploy-secrets.json
```

The private API rejects requests until an owner key is configured. The public login page can load during that first setup interval. Keep both `ADMIN_KEY` and `PASSWORD_PEPPER` as Worker Secrets. Preserve the pepper through future owner-key rotations; changing it invalidates existing password verification.

Open the generated private browser shortcut and set your own password with the key icon. Keep the owner key for recovery and publishing. Never commit the generated files, paste their contents in an issue or place the private shortcut in documentation.

## Connect a project

Create or use a project's `CHECKLIST.md`, then invoke the CLI from this checkout. Use absolute paths when calling it from another directory:

```sh
node scripts/checklist.mjs connect --project <absolute-project-path> --name "Example project" --instructions
node scripts/checklist.mjs status --project <absolute-project-path>
node scripts/checklist.mjs sync --project <absolute-project-path>
```

The CLI reads this checkout's ignored `.private/service.json`, or `CHECKLIST_URL` and `CHECKLIST_ADMIN_KEY`. Project-scoped tokens stay in the private configuration directory. Check `status` and pull remote edits before changing a connected Markdown file when there are no unpushed local changes. Archive is terminal for that connection and preserves its local document.

## Publish a Mermaid diagram

The renderer uses the pinned npm Playwright package. To use its bundled Chromium, explicitly install that browser:

```sh
npx playwright install chromium
node scripts/mermaid.mjs preview --file examples/workflow.mmd --output <new-preview.svg>
```

Alternatively set `MERMAID_CHROME_PATH` to an existing local Chrome executable. `MERMAID_PLAYWRIGHT_MODULE` can select an already installed compatible Playwright module. Browser downloads and rendering run only when you request them.

```sh
node scripts/mermaid.mjs publish --id example-workflow --title "Example workflow" --file examples/workflow.mmd
node scripts/mermaid.mjs show --id example-workflow
```

Use the current revision from `show` with `--base-revision` when updating. The optional built-in interactive document is disabled by default. Set `INTERACTIVE_DIAGRAM_FILE` explicitly before building if you want to package an interactive document you own; review its content before publication. The included small HTML example is synthetic.

## Request and apply diagram edits

In Mermaid, select Request edits, mark a point or region, add comments and review the request. Saving stores a bounded immutable snapshot. Copy it and open the linked original chat to paste and send it yourself. A compatible Codex browser can instead open its native annotation editor for the current chat; opening or saving an annotation does not send it.

```sh
node scripts/mermaid.mjs requests list --diagram example-workflow
node scripts/mermaid.mjs requests show --id <saved-request-uuid>
```

Compare the captured revision and checksum against the current diagram before editing. Render and publish the revised source, verify it, then record the result:

```sh
node scripts/mermaid.mjs requests resolve --id <saved-request-uuid> --status applied --revision <published-revision>
```

No browser action starts an agent automatically. The app does not include an always-running Codex bridge or model service.
