# Repository presentation

This file records the repository's presentation copy and the checks needed around it. Visibility, applied metadata and search placement need their own verification; prose cannot certify them into existence.

## Repository identity

| Field | Presentation value |
| --- | --- |
| Repository name | `checklist-mermaid-workspace` |
| README title | Checklist + Mermaid Workspace |
| About description | Markdown checklists and Mermaid diagrams on Cloudflare Workers. Preserve task checks, request precise diagram edits, and keep your backlog's resurrection attempts on record. |
| Website | Leave empty until there is an intentionally public project page. A private workspace is not a public demo. |
| License | Maintainer decision required before describing the project as open source. |

The name says what the project contains. The description names the platform and two useful behaviors before the joke. A reader should understand the product before meeting its coping mechanism.

Suggested topics:

```text
mermaid
markdown
checklist
task-management
cloudflare-workers
cloudflare-d1
self-hosted
codex
javascript
svg
diagram-review
developer-tools
```

These topics describe the implemented purpose, platform and language. GitHub permits up to 20 topics, each using lowercase letters, numbers or hyphens and at most 50 characters. Topic names remain public even for private repositories. [GitHub topic guidance](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/classifying-your-repository-with-topics).

## First-screen content

The README opens with the product and deployment model, then gives the backlog one short insult. It shows the checklist, gives a small exercise, shows Mermaid and explains Request edits. Concrete controls and examples carry the explanation; jokes do not replace instructions.

Screenshots should come from the exported application with fictional data:

| File | Capture |
| --- | --- |
| `docs/screenshots/checklist-desktop.png` | A short project checklist with both checked and open tasks. |
| `docs/screenshots/mermaid-desktop.png` | A small readable diagram and its independent library. |
| `docs/screenshots/request-edits.png` | Numbered selections and a concrete diagram change comment. |
| `docs/screenshots/mobile.png` | A narrow screen with usable controls and scrolling. |

Capture the app area rather than browser chrome. Inspect visible text, image metadata and any generated diagram payload before accepting an image. Screenshots must not reveal account identity, original project content, connection links or local infrastructure details.

## Writing direction

The owner requested blunt technical explanations with dry dark humor. Use an opinionated developer voice, exact controls, a small worked example and candid limits. Direct the humor at recurring tasks, broken software and our own overconfidence. Keep people and their personal circumstances out of the firing line.

Earlier research inspected [DavidAU's profile](https://huggingface.co/DavidAU) and a [representative current model card](https://huggingface.co/DavidAU/Qwen3.8-27B-Ultimate-Heretic-Uncensored). Those are reference sources, not authorship or endorsement. The repository uses original wording and does not borrow model-performance claims or copy a model card's distinctive phrasing.

Keep release notes equally concrete. For example:

> Diagram comments now keep their selected point or area and the reviewed revision. Open the saved request before editing. "I fixed the wrong version" is a poor resurrection story.

Use that form only when the release contains the described behavior. Keep commands, password guidance and recovery instructions precise. Do not force a joke into every section or make unsupported speed, security, adoption or ranking claims.

## Social preview

Prepare a simple image containing the project title and clean views of the two modes. Use a solid dark background, readable text and fictional demo data. Keep the main labels away from the edges so link previews can crop them safely.

GitHub recommends an image at least 640 by 320 pixels, with 1280 by 640 pixels for best display, under 1 MB. It accepts PNG, JPG and GIF. Uploading the social image is a repository setting, separate from placing README screenshots in Git. [GitHub social-preview guidance](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview).

## Publication checks

Review the exported source tree and its generated build separately. Check the actual license status, screenshot contents, links, setup instructions and security guidance. A license remains a maintainer decision; public visibility does not select one. Enable the repository security features appropriate to the account, including dependency alerts, secret scanning and push protection. [GitHub repository best practices](https://docs.github.com/en/repositories/creating-and-managing-repositories/best-practices-for-repositories).

Publishing source, changing visibility and applying the About settings are separate operations. Record the verified result of each. This document alone makes no claim that the metadata was applied, that the repository is public or that the social image was installed.
