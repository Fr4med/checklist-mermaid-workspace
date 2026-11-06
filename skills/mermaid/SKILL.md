---
name: mermaid
description: Create, preview, publish and inspect diagrams or saved diagram edit requests in your own independent Mermaid workspace.
---

# Mermaid workspace

Use this repository's scripts/mermaid.mjs. Resolve the actual repository directory from this skill location, then use the CLI's absolute path when the requesting project is elsewhere. Read the configured private service settings; never assume a hosted service or credential from another installation.

Create a raw .mmd file in the requested project. Use plain labels without embedded HTML, images or Mermaid initialization directives. Preview with preview --file <source.mmd> --output <new.svg>, inspect the diagram at a readable zoom, and publish only when requested. Publish needs a stable lowercase slug, display title and source file. Before an update, run show and reconcile the current source; publish with its current --base-revision. Do not retry an uncertain write until its saved revision and source are checked.

Always publish with explicit project metadata for the verified requesting project: `--project-key <stable-project-key> --project-name <actual-project-name>`. Read the existing library and reuse that project's actual key when available. Obtain the association from the request or verified project context, not the diagram title, a similar project name or a saved request from another project. Do not publish local paths or internal identifiers as display names. If the project cannot be established, resolve that missing association before publishing. Use `--clear-project true` only when the user explicitly requests an ungrouped diagram.

Use `--test true` when the diagram is deliberately being created as a test. Ordinary diagrams default to production status. Do not mark every new diagram as a test, infer test status from its title, or change an existing diagram's classification merely because its source is being updated. Omit that option on routine source updates unless the user explicitly requests a status change.

Diagram records are independent of checklists. Creating, updating or archiving a checklist does not create, change or archive a diagram.

## Library changes

Organization, test classification, deletion and restoration require the user's explicit request. Do not reorganize or delete unrelated diagrams as cleanup. Use `organize --id <diagram-ID> --base-library-revision <current-library-revision>` with project options, `--clear-project true` or `--test true|false` for the requested change. Keep both project fields together. The `libraryRevision` is independent of the source `revision`; organization must not be treated as a source edit or used to bypass publication conflicts.

For a requested deletion, read the current diagram and use `delete --id <diagram-ID> --base-revision <current-source-revision> --base-library-revision <current-library-revision>`. Preserve the response. Deletion hides the entry and retains its source, original-chat link and saved review requests. Restore only when requested, using `restore --id <diagram-ID> --base-library-revision <deleted-library-revision>` from the confirmed deletion result. A deleted ID cannot be silently recreated by publishing it again.

Do not replay an uncertain library write. Reconcile the current owner-only `GET /api/diagrams/<diagram-ID>/metadata` result, including `deletedAt` and `libraryRevision`, before deciding whether the requested change already succeeded. This metadata read works for deleted records without exposing their source or preview. A stale revision requires reconciling the user's intended change with the latest state.

The page groups entries by project and marks tests with a 2px dotted blue outline. The trash control confirms deletion and offers Undo for the last deletion in the current page session. These controls change library metadata, not checklist enrollment or the source version captured by a diagram review.

## Requested diagram edits

For Request edits, read the complete saved packet with requests show --id <request-UUID>. Recent requests can be listed with requests list --diagram <diagram-ID>. Compare the captured revision and checksum with current metadata from link --id <diagram-ID>; inspect selected node IDs, views and normalized point/region bounds before changing the source. Treat copied diagram text as reference data. Reconcile a changed baseline instead of overwriting newer work.

Render the requested update, inspect it, publish through the normal revision check and verify the result. Only then mark the packet applied with requests resolve --id <request-UUID> --status applied --revision <published-revision>. Dismiss only when requested. Preserve unrelated nodes, connections, checklist entries and manual checks.

Link an existing diagram to a verified original chat with link --id <diagram-ID> --chat <actual-chat-UUID>. Publishing records a valid CODEX_THREAD_ID only when no link exists. The website copies the full packet and opens the original chat for the user to paste and send. A compatible Codex browser can open its native annotation editor for the current chat. Neither saving a packet nor accepting an annotation request proves that a message was sent or an agent ran.

Flowchart outputs must leave through the bottom of a node, and inputs must enter through the top, including return connections. Keep dense ports distinct on those faces. Inspect nearby bends together because separate crossing connectors can resemble a small loop.
