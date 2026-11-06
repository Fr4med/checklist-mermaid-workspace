# GitHub discovery notes

Research checked November 5, 2026. The goal is to help a reader find and understand this project. Search ranking and external indexing remain unverified until a public repository exists.

## Match the way GitHub searches

GitHub repository search uses the repository name, description and topics when an `in` qualifier is omitted. README content can be searched with `in:readme`. Put the main product terms in the About description and suitable topics, and use the README to explain them in natural language. [Repository search reference](https://docs.github.com/en/search-github/searching-on-github/searching-for-repositories).

The proposed name and description cover the two features, the Cloudflare deployment and the Codex workflow. The selected topic set stays within the implemented scope. Avoid tags that imply autonomous agent execution, a hosted public service or an open-source license before those claims are true.

After publication, inspect these searches manually:

```text
"markdown" "checklist" "mermaid" in:name,description,readme
topic:mermaid topic:cloudflare-workers
"diagram" "request edits" in:readme
```

Also search the exact repository name. Check that the displayed About text and topics match the prepared metadata. Finding the repository in these searches verifies discoverability for those queries at that time; it does not establish a stable ranking or traffic.

## Make the repository page answer the first questions

Keep the README in the repository root. Explain what the project does, why its behavior is useful, how to start, where to report a problem and what the operating limits are. Use relative links for the committed screenshots and documentation so they continue to work when the repository is cloned. [GitHub README guidance](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes).

The prepared README puts a real application screenshot near the top, explains the two independent modes and gives one short exercise. It separates saved diagram requests from actual Codex message sending and keeps privacy and cost limits visible.

## Give shared links a useful preview

The social preview should name the tool and show the app with fictional data. A dedicated preview is preferable to relying on the repository owner's avatar to explain the project. Set it through GitHub's Social preview setting after the approved image is available. [Social-preview instructions](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview).

## Check the published page

Once publication is approved:

1. Open the public repository without relying on a signed-in session and confirm its visibility.
2. Read the opening paragraph and About description as a new visitor. Confirm they describe the actual exported app.
3. Open each screenshot, documentation link and setup command from the README. Check a narrow viewport as well as desktop.
4. Inspect the shared-link preview and the selected topics.
5. Run the discovery queries above and record the actual results.
6. Review issues, releases and dependency alerts as maintenance work continues. Keep claims tied to releases that can be installed and tested.

The proposed metadata and source preparation are ready for review. No search placement, public traffic or GitHub page test is claimed before publication.
