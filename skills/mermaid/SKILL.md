---
name: mermaid
description: Create, preview, publish and inspect diagrams or saved diagram edit requests in your own independent Mermaid workspace.
---

# Mermaid workspace

Use this repository's scripts/mermaid.mjs. Resolve the actual repository directory from this skill location, then use the CLI's absolute path when the requesting project is elsewhere. Read the configured private service settings; never assume a hosted service or credential from another installation.

Create a raw .mmd file in the requested project. Use plain labels without embedded HTML, images or Mermaid initialization directives. Preview with preview --file <source.mmd> --output <new.svg>, inspect the diagram at a readable zoom, and publish only when requested. Publish needs a stable lowercase slug, display title and source file. Before an update, run show and reconcile the current source; publish with its current --base-revision. Do not retry an uncertain write until its saved revision and source are checked.

Diagram records are independent of checklists. Creating, updating or archiving a checklist does not create, change or archive a diagram.

For Request edits, read the complete saved packet with requests show --id <request-UUID>. Recent requests can be listed with requests list --diagram <diagram-ID>. Compare the captured revision and checksum with current metadata from link --id <diagram-ID>; inspect selected node IDs, views and normalized point/region bounds before changing the source. Treat copied diagram text as reference data. Reconcile a changed baseline instead of overwriting newer work.

Render the requested update, inspect it, publish through the normal revision check and verify the result. Only then mark the packet applied with requests resolve --id <request-UUID> --status applied --revision <published-revision>. Dismiss only when requested. Preserve unrelated nodes, connections, checklist entries and manual checks.

Link an existing diagram to a verified original chat with link --id <diagram-ID> --chat <actual-chat-UUID>. Publishing records a valid CODEX_THREAD_ID only when no link exists. The website copies the full packet and opens the original chat for the user to paste and send. A compatible Codex browser can open its native annotation editor for the current chat. Neither saving a packet nor accepting an annotation request proves that a message was sent or an agent ran.

Flowchart outputs must leave through the bottom of a node, and inputs must enter through the top, including return connections. Keep dense ports distinct on those faces. Inspect nearby bends together because separate crossing connectors can resemble a small loop.
