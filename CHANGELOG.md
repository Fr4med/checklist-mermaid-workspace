# Change log

## November 6, 2026

### Repository presentation

- Rewrote the README and repository notes with direct technical explanations and dry dark humor. The backlog can take a joke; setup commands still need to work.
- Retained the setup steps, fictional screenshots, security limits, source links and the distinction between saving an edit request and actually sending it to an agent.
- Updated the presentation notes for public-source review without claiming search ranking, traffic or a verified visibility change.
- Kept license selection explicit and separate from repository visibility.

### Diagram routing

The arrows now have assigned doors. They were getting creative in all the wrong places.

- Flowchart outputs leave through the bottom of each node. Inputs enter through the top, including return connections.
- Connections use distinct positions on those faces. Crowded connections no longer move onto a side face. A face that cannot fit distinct connections fails with a clear error.
- Opposing long connections use separate straight runs instead of nearby switchbacks that can resemble a small loop.
- Labels require clear space around their backgrounds. A bounded search checks nearby free positions, and rendering stops when a label cannot fit safely.
- Routing tests cover crowded nodes, branches, return connections, self-loops, the opposing long-connection case and blocked labels.

### Optional interactive diagrams

- Packaging includes the interactive viewer corrections for focus outlines, popup placement, long text and connection navigation.
- The viewer supports hover previews, click pinning and connection highlighting while retaining panning and zoom controls.
- The script checksum and single-script packaging contract remain in place.

### Source repository

- Added this change log alongside the setup, security and contribution guides.
- Retained the reviewed screenshots and example diagrams made with fictional data.
- Kept private documents, saved diagrams, research jobs, credentials, runtime databases, generated bundles and deployment configuration out of the source export.
- Made the routing test use the included Playwright dependency and an installed browser rather than a machine-specific runtime path.

Dense diagrams can still have perpendicular crossings and tight spacing around crowded joins. The preferred lane distance is not a guarantee when a fixed layout has insufficient room. Inspect a rendered preview at a readable zoom before publishing a diagram. A more optimistic setting cannot widen the corridor.

## Initial workspace

- Independent Markdown checklist and Mermaid modes on one Cloudflare Worker.
- Project and chat grouping, saved manual checks, source synchronization and checklist archiving.
- Diagram publishing, source previews, pan and zoom.
- Request edits with point or area selections, numbered comments, saved revision context and original-chat handoff.
- Owner password settings, scoped project credentials and D1 storage.
- Responsive controls for desktop and narrow screens.
