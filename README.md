# Wiki-Reader

Wiki-Reader is a dark-mode, two-pane desktop app for writing and reading wikitext and hypertext documents.

The project explores a richer alternative to flat, typewriter-style documents: writing built around links, media, references, technical notation, and connected context. It is intended for Wikipedia drafts, documentation, academic notes, books, technical articles, and research writing.

## Modes

### Writing Mode

- Write wikitext source in the left pane.
- See a live rendered article preview in the right pane.

### Reader Mode

- Read the main rendered document in the left pane.
- Open wiki links, Wikipedia articles, images, references, and other media in the right pane.
- Keep the main document anchored so following context never loses your reading position.

## Planned Stack

- [Tauri](https://tauri.app/) for a cross-platform desktop shell
- [React](https://react.dev/) and [TypeScript](https://www.typescriptlang.org/) for the interface
- [CodeMirror 6](https://codemirror.net/) for source editing
- [Rust](https://www.rust-lang.org/) for native application logic

Development will begin on macOS, followed by Windows. Dark mode will be the default.

## Early MVP

- Open, create, edit, and save local wikitext documents
- Two-pane Writing Mode with live preview
- Reader Mode with anchored primary content and contextual link viewing
- Basic wikitext rendering, including headings, links, lists, and tables
- A focused dark interface with resizable panes

Future work may include Wikimedia Commons media, citations, local-file links, math and chemistry notation, charts, and optional AI writing assistance.

## License

The Wiki-Reader source code is licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) for the full license text.

The names “Wiki Reader” and “Wiki-Reader,” along with the project logo and branding, are reserved by the project owner and are not licensed for use in branding forks or implying official affiliation. See [TRADEMARKS.md](TRADEMARKS.md) for the project’s name and trademark policy.
