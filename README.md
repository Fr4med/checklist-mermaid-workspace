# Checklist + Mermaid Workspace

A self-hosted workspace for Markdown checklists and Mermaid diagrams, running on Cloudflare Workers with D1 storage.

Your backlog is alive. Unfortunately.

Keep tasks in Markdown, check them in the browser, and retain those manual checks when the source changes. Open Mermaid to explain a process, inspect a diagram or point out a change. Both tools share a sign-in and a mode switch. Each has its own records, controls and Codex skill.

![Markdown checklist with project navigation and saved task checks](docs/screenshots/checklist-desktop.png)

Screenshots use fictional projects and demo diagrams.

## What it actually does

| Tool | What you get |
| --- | --- |
| Checklist | Render Markdown, check or uncheck tasks, search a list and download the effective document. |
| Project and chat grouping | Keep a project checklist together with separate checklists for individual chats. |
| Source synchronization | Publish Markdown with stable task IDs and revision checks while retaining manual checkbox decisions. |
| Archive | Keep a checklist readable while revoking its publishing connection. |
| Mermaid | Publish diagrams independently of checklists, inspect their source, and move around them with pan and zoom. |
| Request edits | Mark points or areas, add numbered comments, review the captured diagram context and save a precise edit request. |
| Private access | Sign in with an owner password and give a connected project access only to its own checklist. |

## Give it one small project

Connect a short checklist and check two tasks in the browser. Add another task to the Markdown source and sync it. The new task appears while your earlier checks remain in place. A source update should not be a resurrection event for work you already finished.

Publish a Mermaid source file through the separate diagram tool when you want to show a process. A checklist connection creates only a checklist. Diagrams have their own publishing flow, so you can explain a system without manufacturing a task list to justify it.

![Mermaid diagram workspace with an independent diagram library](docs/screenshots/mermaid-desktop.png)

## Point at the broken bit

Open **Request edits** in Mermaid. Click a point or drag around an area, then describe the change. Add numbered comments for the other parts that need work. "Fix that thing over there" can finally have coordinates.

The saved request keeps the diagram ID, source revision, preview checksum, selected view and locations. The revision and checksum identify the version you reviewed. An outdated request is rejected so you can reconcile it with the current diagram before editing the wrong thing with confidence.

![Diagram review with numbered selections and a requested change](docs/screenshots/request-edits.png)

Use **Copy and open chat** to return to the linked Codex chat, then paste and send the request. Saving records the request; a person still has to send it before an agent starts work. Where the Codex browser provides its native annotation API, the review also offers that editor for the current chat.

The Mermaid CLI can read the saved packet, including every comment and its captured context. An agent can inspect that record before editing and republishing the diagram.

## Get it running

Use a current Node.js release supported by the included dependencies. The [setup guide](docs/SETUP.md) covers local development, the D1 database, Worker secrets and first-owner sign-in.

```sh
npm ci
npm run build
npm test
```

Give your deployment its own database and newly generated secrets. Sign in with your owner key first, then use the password control to choose a browser password. Keep the owner key separately for recovery and publishing.

The setup helper creates ignored local settings and private sign-in files without printing the generated credentials:

```sh
npm run setup -- --url https://your-workspace.example
```

Replace the example URL with your workspace address and follow the setup guide for deployment. The local Mermaid renderer uses the included Playwright package and an installed compatible browser. Install that browser separately. Running a build or test does not download it for you.

## Two Codex tools, separate jobs

The included skills cover the checklist connection and the independent Mermaid workflow. Install or adapt them for your checkout.

| Request | Tool |
| --- | --- |
| Create or synchronize a connected Markdown checklist | `checklist` |
| Preview, publish or update a Mermaid diagram | `mermaid` |
| Read the comments on a saved diagram edit request | Mermaid CLI `requests show` |

Checklist entries follow an append-only rule. Keep stable IDs, add clarifications and corrections as new entries, and change checkmarks as work progresses. The skill and request text carry that rule. The database does not prevent every possible owner edit, so do not mistake a writing instruction for an immutability guarantee.

## Yes, on a phone

The project drawer, task controls and edit-request forms adapt to narrow screens. Move and zoom diagrams with touch controls. Long review forms scroll inside their panel, so a long comment does not push its own buttons off the screen.

<img src="docs/screenshots/mobile.png" alt="Phone view of the workspace using fictional demo data" width="360">

## What runs where

The Worker serves both pages and their authenticated APIs. D1 stores checklists, manual checkbox overrides, diagrams, sessions and edit requests. The checklist CLI sends local Markdown changes. The Mermaid CLI renders source locally, then publishes the SVG preview.

The Worker serves the hosted page independently of your computer. Local file updates need the CLI to run on that computer. There is no background AI worker quietly fixing your project while you sleep. The backlog has enough fictional employees already. A diagram request becomes agent work when a person sends it in Codex.

## Read this before trusting it with your week

Deploy this as a private owner workspace. Public source code gives readers the application code; access to your deployed workspace and database still requires authentication. Keep credentials, connection files, private documents and local runtime data out of Git. Read the [security notes](SECURITY.md) before deploying or reporting an issue. This code does not provide a public multi-user service.

Password verification uses a random salt, a separate Worker Secret and a server-side password hash. The setup and security notes explain the platform's password-derivation limits and recovery procedure. Keep those limits visible when assessing the deployment.

Small workloads can fit Cloudflare's free allowances. Requests, database activity and storage still consume the account's quota. Review current [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) and [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) for your deployment. The free tier has limits and no unlimited-hosting guarantee. Codex usage follows your account and plan.

Flowchart outputs leave through the bottom and inputs enter through the top. Distinct ports and separate lanes help keep connectors readable. Dense diagrams can still contain perpendicular crossings and tight joins. Inspect the preview at a useful zoom before publishing it. Geometry remains immune to enthusiasm.

## Contributing and reuse

Use the [contribution guide](CONTRIBUTING.md) for reproducible bug reports and changes. Include a small fictional example when reporting a rendering or synchronization problem.

A license has not yet been selected. Public visibility alone does not grant permission to reuse or redistribute the code. Confirm the repository's license before doing so.
