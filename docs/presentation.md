# Repository presentation

This is the proposed GitHub presentation for the release candidate. No public repository or search placement is asserted by this document.

## Proposed identity

| Field | Prepared value |
| --- | --- |
| Repository name | `checklist-mermaid-workspace` |
| README title | Checklist + Mermaid Workspace |
| About description | Self-hosted Markdown checklists and Mermaid diagrams on Cloudflare Workers. Preserve manual task checks, publish diagrams from Codex, and request precise edits with point or area comments. |
| Website | Leave empty until there is an intentionally public project page. A private workspace is not a public demo. |
| License | Maintainer decision required before describing the project as open source. |

The name says what the project contains. The description adds the platform, the source workflow and the diagram-review feature without repeating a list of search terms.

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

The README opens with the product, deployment model and reason to use the two tools separately. It then shows the checklist, gives a short exercise, shows Mermaid and explains Request edits. Each feature connects to something a reader can do.

Screenshots should come from the exported application with fictional data:

| File | Capture |
| --- | --- |
| `docs/screenshots/checklist-desktop.png` | A short project checklist with both checked and open tasks. |
| `docs/screenshots/mermaid-desktop.png` | A small readable diagram and its independent library. |
| `docs/screenshots/request-edits.png` | Numbered selections and a concrete diagram change comment. |
| `docs/screenshots/mobile.png` | A narrow screen with usable controls and scrolling. |

Capture the app area rather than browser chrome. Inspect visible text, image metadata and any generated diagram payload before accepting an image. Screenshots must not reveal account identity, original project content, connection links or local infrastructure details.

## Writing direction

The requested reference is DavidAU's practical explanatory style. The prepared prose uses feature explanations, concrete exercises, usage instructions and explicit limits. It does not copy model-card phrasing or adopt model-performance claims. [DavidAU's profile](https://huggingface.co/DavidAU) and a [representative current model card](https://huggingface.co/DavidAU/Qwen3.8-27B-Ultimate-Heretic-Uncensored) were inspected as style references.

Keep release notes equally concrete. For example:

> Diagram comments now keep their selected point or area with the saved request. Open a request from the library and you can see which diagram revision it refers to before changing the source.

Use that form only when the release actually contains the described behavior. Avoid unsupported speed, security, adoption or ranking claims.

## Social preview

Prepare a simple image containing the project title and clean views of the two modes. Use a solid dark background, readable text and fictional demo data. Keep the main labels away from the edges so link previews can crop them safely.

GitHub recommends an image at least 640 by 320 pixels, with 1280 by 640 pixels for best display, under 1 MB. It accepts PNG, JPG and GIF. Uploading the social image is a repository setting, separate from placing README screenshots in Git. [GitHub social-preview guidance](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview).

## Before publication

Review the exported source tree and its generated build separately. Confirm the selected license, screenshot contents, links, setup instructions and security guidance. Enable the repository security features appropriate to the account, including dependency alerts, secret scanning and push protection. [GitHub repository best practices](https://docs.github.com/en/repositories/creating-and-managing-repositories/best-practices-for-repositories).

Publishing this prepared tree, changing repository visibility and applying the About settings are separate actions. They remain pending maintainer approval.
