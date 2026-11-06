# Checklist + Mermaid Workspace

Markdown checklists and independent Mermaid diagrams, self-hosted on Cloudflare Workers with D1 storage.

I wanted tasks I could read, check and keep. Then I wanted diagrams I could inspect and mark up. Putting them in the same workspace made sense. A diagram should not need checklist enrollment as a permission slip. I wanted the two tools independent.

The result is two tools behind one sign-in and a mode switch. Checklist keeps the task record. Mermaid explains the system and captures precise change requests. Each has its own records, controls, publishing flow and Codex skill.

![Markdown checklist with project navigation and saved task checks](docs/screenshots/checklist-desktop.png)

Screenshots use fictional projects and demo diagrams.

## The list is a record, not an alibi

A task should tell me what to do and what finished looks like. “Improve the workflow” tells me neither. It is a meeting that escaped into Markdown.

The checklist workflow calls for a concrete action, a checkable result and a practical walkthrough where the task needs one. Projects have their own lists; individual chats can have separate lists nested under their project.

I also wanted existing entries to stay put. Once a task has entered the chat or checklist, keep its wording, details, stable ID and place in the record. Add corrections and clarifications underneath, referencing the original. Changing a requirement until the implementation looks finished is a remarkably cheap way to manufacture progress.

Checkmarks can change. The record of what was asked should survive the change of mind.

This append-only rule lives in the checklist workflow and agent request instructions. It is not a universal database lock against every owner edit. The explicit exception for changing the overall list structure still requires retaining every entry and its meaning.

Manual checks are stored separately from source Markdown. Stable task IDs connect the two, and revision checks catch conflicting updates. Try it with a short list: check two tasks in the browser, add a third in the source and sync. The new task should appear with the earlier manual checks intact. A source update does not get to vote on whether you finished the work.

Archive keeps the checklist readable and revokes its publishing connection. It does not delete the list or archive the actual Codex chat. Finished projects are allowed to remain evidence.

## Two tools were the point

The combined design tied the tools together too closely. That was the wrong relationship. A diagram can explain a process before there is any task list, and a checklist can be useful without a diagram attached to it.

We split the records, pages, APIs and skills. The mode switch changes the tool you are using; it does not generate a second artifact behind your back. Checklist enrollment leaves the diagram library alone. Mermaid has its own publishing flow.

![Mermaid diagram workspace with an independent diagram library](docs/screenshots/mermaid-desktop.png)

| What you want | What to use |
| --- | --- |
| Create or synchronize a connected Markdown checklist | `checklist` skill and CLI |
| Check tasks, search a list or download its effective Markdown | Checklist page |
| Preview, publish or update a Mermaid diagram | `mermaid` skill and CLI |
| Inspect diagram source, pan or zoom | Mermaid page |
| Read a saved diagram change request and its captured context | Mermaid CLI `requests show` |

The included skills can be installed or adapted for your checkout. They share the application, not responsibility for each other's records.

## The library should fit the work

I wanted project folders, readable titles and a way to remove diagrams I no longer needed. Cutting every title off at the same width is not minimalism. It is making the user finish the interface in their head.

Drag the divider beside the diagram library to widen or shrink it. The width stays in this browser. Focus the divider and use the arrow keys for smaller adjustments, or double-click to reset it. The canvas keeps a minimum usable width instead of disappearing to accommodate one heroic filename.

Use a diagram's folder icon to choose its project or change its **Test diagram** setting. Project folders collapse independently. Diagrams without a project stay under **Ungrouped**; the app does not invent an association from a similar title. A test diagram gets a thin **2px dotted blue outline** around its library row. On a phone, the grouped picker and selected-diagram controls provide the same organization and deletion actions, with the test outline around the picker.

The trash icon opens a confirmation for that diagram. **Delete** removes it from the visible library; **Undo** restores it. Source, original-chat links and saved review requests remain stored. Deleting a draft should not require performing amateur evidence disposal. The CLI can also restore it using the library revision returned by deletion.

Library changes use `libraryRevision`, independently of the diagram's source `revision`. Moving a diagram to another project or marking it as a test does not change the content version someone reviewed. Deletion checks both versions so an old tab cannot remove a newer diagram by accident.

## “Fix this” needs an address

The change-request button belongs in Mermaid, with the functions behind it. A button that merely looks like an editing tool is just a very small lie.

Open **Request edits**, click a point or drag around an area, then describe the change. Add numbered comments for the other parts that need work. “Move this branch below the review step” now travels with the branch you selected.

The saved request contains the diagram ID, source revision, preview checksum, selected view and locations. Those identify what you actually reviewed. An outdated request is rejected for reconciliation before an agent edits a different version with tremendous confidence.

![Diagram review with numbered selections and a requested change](docs/screenshots/request-edits.png)

Use **Copy and open chat** to return to the linked Codex chat. Paste and send the request there. Saving records the request; sending it is the human step that asks an agent to act. Where the Codex browser exposes its compatible native annotation API, the review also offers that editor for the current chat.

The Mermaid CLI can read the saved packet, including every comment and its captured context, before a diagram is edited and republished. Coordinates without the reviewed version would only make the misunderstanding more precise.

## The connectors were the problem

I wanted continuous right-angle lines with evenly spaced runs. The earlier routing could preserve Mermaid's side attachments, and straightening individual connections did not resolve the crowded layout. Several perfectly straight lines can still make a complete mess together. A ruler does not constitute a routing algorithm.

The local flowchart router now requires outputs through the bottom and inputs through the top. Connections get distinct ports and separate lanes. Crowding cannot silently push an endpoint onto a side face; if the required ports cannot fit, rendering fails with an explanation. Opposing long connections also get separate runs instead of nearby switchbacks that can look like a tiny accidental loop.

These rules improve a fixed layout; they do not create infinite room inside it. Dense diagrams can still have perpendicular crossings and tight joins. Inspect the preview at a readable zoom before publishing. “All lines are right angles” and “I can follow this” are separate acceptance tests.

## A phone should still operate the thing

Both modes have responsive navigation and controls. The project drawer, task actions and edit-request forms adapt to narrow screens. Diagrams support touch pan and zoom. Long review forms scroll inside their panel, keeping their controls reachable.

<img src="docs/screenshots/mobile.png" alt="Phone view of the workspace using fictional demo data" width="360">

Phone-width browser checks cover layout, scrolling and the review controls. They are browser checks, not a claim that every physical phone has personally signed off on the release.

## Get it running

Use a current Node.js release supported by the included dependencies. The [setup guide](docs/SETUP.md) covers local development, the D1 database, Worker secrets and first-owner sign-in.

```sh
npm ci
npm run build
npm test
```

Give your deployment its own database and newly generated secrets. Sign in with your owner key first, then use the password control to choose a browser password. Keep the owner key separately for recovery and publishing. Connected projects receive credentials scoped to their own checklist.

The setup helper creates ignored local settings and private sign-in files without printing the generated credentials:

```sh
npm run setup -- --url https://your-workspace.example
```

Replace the example URL with your workspace address and follow the setup guide for deployment. The local Mermaid renderer uses the included Playwright package and an installed compatible browser. Install that browser separately; a build or test does not download it.

## Available all day does not mean an agent is working all day

The Worker serves both pages and their authenticated APIs independently of your computer. D1 stores checklists, manual checkbox overrides, diagrams, sessions and edit requests. The checklist CLI sends local Markdown changes. The Mermaid CLI renders source locally, then publishes its SVG preview.

Local file updates and rendering need those local tools to run. The public package does not include an automated research runner. There is no permanently running AI process inside the Worker. A saved request becomes agent work when a person sends it in Codex. Keeping a website online and employing an invisible night shift are different infrastructure decisions.

Small workloads can fit Cloudflare's free allowances. Requests, database activity and storage still consume quota. Check current [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) and [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) for your deployment. There is no unlimited-hosting guarantee. Codex usage follows your account and plan.

## Public code, private workspace

Deploy this as a private owner workspace. The public repository contains portable source and fictional examples. Your deployed workspace and database still require authentication. This code does not provide a public multi-user service.

Keep credentials, connection files, private documents and local runtime data out of Git. A clean screenshot is not a substitute for checking the files beside it. Read the [security notes](SECURITY.md) before deploying or reporting an issue.

Password verification uses a random salt, a separate Worker Secret and a server-side password hash. The setup and security notes explain the platform's password-derivation limits and recovery procedure. Choosing your own password does not require storing a readable copy for the next breach to enjoy.

## Contributing and reuse

Use the [contribution guide](CONTRIBUTING.md) for reproducible bug reports and changes. Include a small fictional example for rendering or synchronization problems. The smaller the reproduction, the sooner someone can stop admiring the bug and remove it.

A license has not yet been selected. Public visibility alone does not grant permission to reuse or redistribute the code. Confirm the repository's license before doing so.
