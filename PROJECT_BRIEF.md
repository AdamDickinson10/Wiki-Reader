# Wiki-Reader Project Brief

## What We Are Building

Wiki-Reader is a dark-mode desktop app for writing and reading wikitext and hypertext documents. It uses two side-by-side panes so writers can see their work as they create it and readers can explore links without losing their place.

The app is intended for Wikipedia drafts, documentation, academic notes, books, technical articles, and research writing.

## The Two Modes

### Writing Mode

- The left pane is where the user writes and edits wikitext.
- The right pane shows a live rendered version of the document.
- Changes should appear in the preview as the user writes.

### Reader Mode

- The left pane shows the main rendered document.
- The right pane shows clicked wiki links, Wikipedia articles, images, references, and other media.
- The main document stays in place while the user explores related material.

## First Version

The first usable version should:

- Create, open, edit, and save local wikitext documents.
- Provide Writing Mode with a source editor and live preview.
- Provide Reader Mode with an anchored main document and a context pane.
- Render common wikitext such as headings, links, lists, and tables.
- Use a focused dark interface with resizable panes.
- Run on macOS first.

## Planned Technology

The likely tools are:

- Tauri for packaging the project as a desktop app.
- React and TypeScript for building the visible interface.
- CodeMirror 6 for the text editor.
- Rust for native desktop features and file handling.

These choices can change if testing reveals a better fit.

## Later Possibilities

Features outside the first version may include:

- Wikimedia Commons media
- Citations and references
- Local-file links
- Math and chemistry notation
- Charts
- AI writing assistance
- Windows and Linux support

## Project Principles

- Keep the interface calm, clear, and useful.
- Preserve the reader's place while they explore links and media.
- Build the smallest useful version before adding advanced features.
- Keep the project open source and GitHub-friendly.
- Prefer a public-domain-style license if practical.
