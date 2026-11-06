---
name: checklist
description: Connect a requested project or chat to your own Markdown checklist workspace, synchronize tasks and preserve manual checks.
---

# Checklist workspace

Use the checklist CLI in this repository. Resolve this skill's repository directory first and use the absolute path to `scripts/checklist.mjs` when invoking it from another project. The CLI reads the repository's ignored private service settings or CHECKLIST_URL and CHECKLIST_ADMIN_KEY. Never invent or reuse a service credential.

Connect only the project or chat requested by the user. Existing metadata selects the connection; do not reconnect an archived or disconnected checklist. Run status before changes, and pull when there are no unpushed local changes. Preserve all prior entries, their wording, stable IDs, order and manual check decisions. Append new tasks and clarifications instead of silently replacing entries. Explicit changes to the overall checklist structure may reshape necessary content while retaining every task and its meaning.

Use connect --project <absolute-project-path> --name <name> --instructions for a new connection. Add --chat <actual-chat-UUID> --chat-name <title> only for a separate chat checklist. Preserve the verified original chat. Sync the same selector after authorized updates. Conflicts require reviewing and reconciling both versions before a revision-acknowledged sync; do not force a retry.

Write tasks as concrete outcomes with short titles. Put the finish condition and any needed practical explanation underneath. Checking and unchecking remain allowed. Archive disconnects only this checklist and preserves its document; it does not archive a Codex chat.

The Worker receives updates when the CLI syncs. It does not read local project files by itself or run an agent. This public source package does not include an automated research runner.
