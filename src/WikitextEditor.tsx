import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";
import {
  EditorState,
  RangeSetBuilder,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  redo,
  undo,
} from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  indentOnInput,
} from "@codemirror/language";
import {
  closeBrackets,
  closeBracketsKeymap,
} from "@codemirror/autocomplete";

export type EditorAction =
  | "undo"
  | "redo"
  | "bold"
  | "italic"
  | "link"
  | "heading"
  | "reference"
  | "bulleted-list"
  | "numbered-list"
  | "template"
  | "image"
  | "special-character";

export interface WikitextEditorHandle {
  run: (action: EditorAction) => void;
}

interface WikitextEditorProps {
  value: string;
  onChange: (value: string) => void;
}

const wikiTokenPattern =
  /<!--[\s\S]*?-->|<ref\b[^>]*>[\s\S]*?<\/ref>|<\/?[A-Za-z][^>]*>|\{\{[^{}]*\}\}|\[\[[^\]]+\]\]|\[(?:https?:\/\/)[^\]]+\]|'''[^'\n]+'''|''[^'\n]+''|^={1,6}.+?={1,6}\s*$|__[^_\n]+__/gm;

const wikiDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildWikiDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildWikiDecorations(update.view);
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
  },
);

function buildWikiDecorations(view: EditorView) {
  const builder = new RangeSetBuilder<Decoration>();
  const document = view.state.doc.toString();

  wikiTokenPattern.lastIndex = 0;

  for (const match of document.matchAll(wikiTokenPattern)) {
    const from = match.index;
    const to = from + match[0].length;
    builder.add(
      from,
      to,
      Decoration.mark({ class: tokenClass(match[0]) }),
    );
  }

  return builder.finish();
}

function tokenClass(token: string) {
  if (token.startsWith("<!--")) return "cm-wiki-comment";
  if (token.startsWith("[[")) return "cm-wiki-link";
  if (token.startsWith("[http")) return "cm-wiki-external-link";
  if (token.startsWith("{{")) return "cm-wiki-template";
  if (token.startsWith("<ref")) return "cm-wiki-reference";
  if (token.startsWith("<")) return "cm-wiki-tag";
  if (token.startsWith("=")) return "cm-wiki-heading";
  if (token.startsWith("'''")) return "cm-wiki-bold";
  if (token.startsWith("''")) return "cm-wiki-italic";
  return "cm-wiki-magic-word";
}

const editorTheme = EditorView.theme(
  {
    "&": {
      height: "100%",
      color: "#f1f3f5",
      backgroundColor: "#111111",
      fontSize: "14px",
    },
    ".cm-scroller": {
      overflow: "auto",
      colorScheme: "dark",
      scrollbarColor: "#53616b #151a1e",
      scrollbarGutter: "stable",
      fontFamily:
        '"SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
      lineHeight: "1.48",
    },
    ".cm-scroller::-webkit-scrollbar": {
      width: "11px",
      height: "11px",
    },
    ".cm-scroller::-webkit-scrollbar-track": {
      backgroundColor: "#151a1e",
    },
    ".cm-scroller::-webkit-scrollbar-thumb": {
      minHeight: "38px",
      border: "3px solid #151a1e",
      borderRadius: "8px",
      backgroundColor: "#53616b",
    },
    ".cm-scroller::-webkit-scrollbar-thumb:hover": {
      backgroundColor: "#6c7c87",
    },
    ".cm-scroller::-webkit-scrollbar-corner": {
      backgroundColor: "#151a1e",
    },
    ".cm-content": {
      padding: "7px 0 70px",
      caretColor: "#f4f7fa",
    },
    ".cm-line": {
      padding: "0 18px 0 8px",
    },
    ".cm-gutters": {
      color: "#b0b7be",
      backgroundColor: "#171717",
      borderRight: "1px solid #54595d",
    },
    ".cm-gutterElement": {
      padding: "0 9px 0 8px",
    },
    ".cm-activeLine": {
      backgroundColor: "rgba(82, 120, 146, 0.1)",
    },
    ".cm-activeLineGutter": {
      color: "#ffffff",
      backgroundColor: "#2a2b2c",
    },
    ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
      backgroundColor: "rgba(57, 124, 182, 0.42) !important",
    },
    ".cm-cursor": {
      borderLeftColor: "#f0f4f7",
    },
    ".cm-foldGutter span": {
      color: "#76838d",
    },
    ".cm-wiki-heading": {
      color: "#80aaff",
      fontWeight: "700",
    },
    ".cm-wiki-link, .cm-wiki-external-link": {
      color: "#70a7ff",
      textDecoration: "underline",
      textDecorationColor: "rgba(112, 167, 255, 0.45)",
    },
    ".cm-wiki-template": {
      color: "#ff67df",
      fontWeight: "600",
    },
    ".cm-wiki-reference": {
      color: "#78e276",
      backgroundColor: "rgba(69, 137, 76, 0.16)",
    },
    ".cm-wiki-tag": {
      color: "#78e276",
    },
    ".cm-wiki-bold": {
      color: "#f1f3f5",
      fontWeight: "700",
    },
    ".cm-wiki-italic": {
      color: "#d6c5f5",
      fontStyle: "italic",
    },
    ".cm-wiki-comment": {
      color: "#6f7d75",
      fontStyle: "italic",
    },
    ".cm-wiki-magic-word": {
      color: "#e1ad61",
    },
  },
  { dark: true },
);

const WikitextEditor = forwardRef<
  WikitextEditorHandle,
  WikitextEditorProps
>(({ value, onChange }, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);

  onChangeRef.current = onChange;

  useEffect(() => {
    if (!containerRef.current) return;

    const view = new EditorView({
      parent: containerRef.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          foldGutter(),
          drawSelection(),
          dropCursor(),
          EditorState.allowMultipleSelections.of(true),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          rectangularSelection(),
          crosshairCursor(),
          highlightActiveLine(),
          EditorView.lineWrapping,
          editorTheme,
          wikiDecorations,
          keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            indentWithTab,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              onChangeRef.current(update.state.doc.toString());
            }
          }),
        ],
      }),
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === value) return;

    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: value },
    });
  }, [value]);

  useImperativeHandle(ref, () => ({
    run(action) {
      const view = viewRef.current;
      if (!view) return;

      switch (action) {
        case "undo":
          undo(view);
          break;
        case "redo":
          redo(view);
          break;
        case "bold":
          wrapSelection(view, "'''", "'''", "bold text");
          break;
        case "italic":
          wrapSelection(view, "''", "''", "italic text");
          break;
        case "link":
          wrapSelection(view, "[[", "]]", "Article title");
          break;
        case "heading":
          insertBlock(view, "== Section heading ==");
          break;
        case "reference":
          wrapSelection(view, "<ref>", "</ref>", "source details");
          break;
        case "bulleted-list":
          prefixSelectedLines(view, "* ");
          break;
        case "numbered-list":
          prefixSelectedLines(view, "# ");
          break;
        case "template":
          wrapSelection(view, "{{", "}}", "Template name");
          break;
        case "image":
          insertAtSelection(
            view,
            "[[File:Example.jpg|thumb|Image caption]]",
          );
          break;
        case "special-character":
          insertAtSelection(view, "—");
          break;
      }

      view.focus();
    },
  }));

  return (
    <div
      className="wikitext-editor"
      ref={containerRef}
      aria-label="Wikitext source editor"
    />
  );
});

function wrapSelection(
  view: EditorView,
  before: string,
  after: string,
  placeholder: string,
) {
  const selection = view.state.selection.main;
  const selectedText = view.state.doc.sliceString(
    selection.from,
    selection.to,
  );
  const content = selectedText || placeholder;
  const insert = `${before}${content}${after}`;

  view.dispatch({
    changes: {
      from: selection.from,
      to: selection.to,
      insert,
    },
    selection: {
      anchor: selection.from + before.length,
      head: selection.from + before.length + content.length,
    },
    scrollIntoView: true,
    userEvent: "input",
  });
}

function insertBlock(view: EditorView, text: string) {
  const selection = view.state.selection.main;
  const line = view.state.doc.lineAt(selection.from);
  const needsLeadingBreak = line.text.trim().length > 0;
  const insert = `${needsLeadingBreak ? "\n" : ""}${text}\n`;
  const headingStart = selection.from + (needsLeadingBreak ? 3 : 2);

  view.dispatch({
    changes: { from: selection.from, to: selection.to, insert },
    selection: {
      anchor: headingStart,
      head: headingStart + "Section heading".length,
    },
    scrollIntoView: true,
    userEvent: "input",
  });
}

function prefixSelectedLines(view: EditorView, prefix: string) {
  const selection = view.state.selection.main;
  const firstLine = view.state.doc.lineAt(selection.from);
  const lastLine = view.state.doc.lineAt(selection.to);
  const changes: Array<{ from: number; insert: string }> = [];

  for (
    let lineNumber = firstLine.number;
    lineNumber <= lastLine.number;
    lineNumber += 1
  ) {
    changes.push({
      from: view.state.doc.line(lineNumber).from,
      insert: prefix,
    });
  }

  view.dispatch({
    changes,
    scrollIntoView: true,
    userEvent: "input",
  });
}

function insertAtSelection(view: EditorView, text: string) {
  const selection = view.state.selection.main;

  view.dispatch({
    changes: { from: selection.from, to: selection.to, insert: text },
    selection: { anchor: selection.from + text.length },
    scrollIntoView: true,
    userEvent: "input",
  });
}

WikitextEditor.displayName = "WikitextEditor";

export default WikitextEditor;
