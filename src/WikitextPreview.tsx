import { Fragment, type CSSProperties, type ReactNode } from "react";
import katex from "katex";
import "katex/contrib/mhchem";
import "katex/dist/katex.min.css";

interface WikitextPreviewProps {
  source: string;
  onLinkClick: (topic: string) => void;
  onReferenceClick?: (reference: ReferenceData) => void;
}

export interface ReferenceData {
  number: number;
  text: string;
  url: string | null;
}

interface InfoboxData {
  type: string;
  fields: Array<{ key: string; value: string }>;
}

interface FileData {
  name: string;
  caption: string;
  width: number;
  alignment: "left" | "center" | "right" | "none" | "inline";
  thumbnail: boolean;
}

interface FormulaData {
  display: boolean;
  formula: string;
  kind: "math" | "chem";
}

interface DivColumnSettings {
  columnCount: number;
  columnWidth?: string;
}

interface BlockListItem {
  type: "*" | "#";
  text: string;
  divColumn: DivColumnSettings | null;
}


const hiddenInfoboxFields = new Set([
  "image_size",
  "logo_size",
  "screenshot_size",
  "image_upright",
]);

const imageFieldNames = [
  "image",
  "logo",
  "screenshot",
  "image_name",
  "image_file",
];

export default function WikitextPreview({
  source,
  onLinkClick,
  onReferenceClick,
}: WikitextPreviewProps) {
  const { source: numberedSource, references } = numberReferences(source);
  const { body, infobox } = extractLeadTemplates(numberedSource);
  const title = getWikitextTitle(source);
  const hasSourceTitle = /^=\s*[^=\n].*?\s*=\s*$/m.test(body);

  return (
    <article className="article">
      {!hasSourceTitle && title && (
        <h1 className="article-title">{title}</h1>
      )}
      {infobox && (
        <Infobox
          data={infobox}
          onLinkClick={onLinkClick}
          onReferenceClick={onReferenceClick}
          references={references}
        />
      )}
      {renderBlocks(body, onLinkClick, references, onReferenceClick)}
    </article>
  );
}

function Infobox({
  data,
  onLinkClick,
  onReferenceClick,
  references,
}: {
  data: InfoboxData;
  onLinkClick: (topic: string) => void;
  onReferenceClick?: (reference: ReferenceData) => void;
  references: Map<number, ReferenceData>;
}) {
  const fieldMap = new Map(data.fields.map((field) => [field.key, field.value]));
  const title =
    fieldMap.get("name") ||
    fieldMap.get("title") ||
    humanizeField(data.type.replace(/^infobox\s*/i, ""));

  const media = imageFieldNames
    .map((key) => {
      const value = fieldMap.get(key);
      if (!value) return null;

      const captionKey =
        key === "logo"
          ? "logo_caption"
          : key === "screenshot"
            ? "caption"
            : "image_caption";
      const sizeKey =
        key === "logo"
          ? "logo_size"
          : key === "screenshot"
            ? "screenshot_size"
            : "image_size";

      return {
        key,
        file: fileFromInfoboxValue(
          value,
          fieldMap.get(captionKey) || "",
          fieldMap.get(sizeKey),
        ),
      };
    })
    .filter((item): item is { key: string; file: FileData } => Boolean(item?.file));

  const excludedFields = new Set([
    "name",
    "title",
    ...imageFieldNames,
    "caption",
    "image_caption",
    "logo_caption",
    ...hiddenInfoboxFields,
  ]);

  return (
    <aside className="infobox">
      <div className="infobox-title">
        {renderInline(title, onLinkClick, references, onReferenceClick)}
      </div>
      {media.map(({ key, file }) => (
        <WikiImage
          className="infobox-media"
          data={file}
          key={`${key}-${file.name}`}
          onLinkClick={onLinkClick}
        />
      ))}
      <dl className="infobox-fields">
        {data.fields
          .filter(
            ({ key, value }) =>
              value.trim() &&
              hasRenderableValue(value) &&
              !excludedFields.has(key) &&
              !hiddenInfoboxFields.has(key),
          )
          .map(({ key, value }) => (
            <div className="infobox-row" key={key}>
              <dt>{humanizeField(key)}</dt>
              <dd>
                {renderInline(value, onLinkClick, references, onReferenceClick)}
              </dd>
            </div>
          ))}
      </dl>
    </aside>
  );
}

export function getWikitextTitle(source: string) {
  const sourceHeading = source.match(/^=\s*([^=\n].*?)\s*=\s*$/m)?.[1];
  if (sourceHeading) return plainText(sourceHeading);

  const { infobox } = extractLeadTemplates(source);
  const nameField = infobox?.fields.find(({ key }) => key === "name" || key === "title");
  return nameField ? plainText(nameField.value) : "Untitled";
}

function WikiImage({
  data,
  onLinkClick,
  className = "",
}: {
  data: FileData;
  onLinkClick: (topic: string) => void;
  className?: string;
}) {
  const filePage = `File:${data.name}`;

  return (
    <figure
      className={[
        "wiki-image",
        data.thumbnail ? "thumbnail" : "",
        `align-${data.alignment}`,
        className,
      ].filter(Boolean).join(" ")}
      style={{ maxWidth: `${data.width}px` }}
    >
      <button
        type="button"
        className="wiki-image-link"
        title={`Open ${filePage}`}
        onClick={() => onLinkClick(filePage)}
      >
        <img
          alt={plainText(data.caption) || data.name}
          loading="lazy"
          src={commonsFileUrl(data.name, data.width)}
          onError={(event) => {
            event.currentTarget.closest("figure")?.classList.add("image-missing");
          }}
        />
        <span className="image-fallback">
          <strong>Image unavailable</strong>
          {data.name}
        </span>
      </button>
      {data.caption && (
        <figcaption>
          {renderInline(data.caption, onLinkClick, new Map())}
        </figcaption>
      )}
    </figure>
  );
}

function parseDivColumnTemplateLine(line: string): DivColumnSettings | "end" | null {
  const match = line.match(/^\{\{\s*([^|}]+)([\s\S]*?)\}\}\s*$/);
  if (!match) return null;

  const name = match[1]
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");

  if (name === "div col end" || name === "div colend") {
    return "end";
  }

  if (name !== "div col") return null;

  const content = line.slice(2, -2);
  const parts = splitTopLevel(content, "|").map((part) => part.trim()).slice(1);

  let columnCount: number | undefined;
  let columnWidth: string | undefined;

  for (const part of parts) {
    if (!part) continue;

    const keyValue = part.match(/^([^=]+)=(.*)$/);

    if (keyValue) {
      const key = keyValue[1]
        .trim()
        .toLowerCase()
        .replace(/[_-]+/g, " ")
        .replace(/\s+/g, " ");
      const value = keyValue[2].trim();

      if (key === "colwidth" || key === "col width" || key === "width") {
        columnWidth = sanitizeDivColumnLength(value);
        continue;
      }

      if (key === "cols" || key === "columns" || key === "column count") {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed) && parsed > 0 && parsed <= 6) {
          columnCount = parsed;
        }
        continue;
      }
    }

    if (/^\d+$/.test(part)) {
      const parsed = Number.parseInt(part, 10);
      if (parsed > 0 && parsed <= 6) {
        columnCount = parsed;
      }
    }
  }

  return {
    columnCount: columnCount ?? 3,
    columnWidth,
  };
}

function sanitizeDivColumnLength(value: string) {
  const trimmed = value.trim();

  if (/^\d+(?:\.\d+)?(?:px|em|rem|ch|%)$/i.test(trimmed)) {
    return trimmed;
  }

  return undefined;
}


function renderBlocks(
  source: string,
  onLinkClick: (topic: string) => void,
  references: Map<number, ReferenceData>,
  onReferenceClick?: (reference: ReferenceData) => void,
) {
  const lines = source.split("\n");
  const output: ReactNode[] = [];
  let paragraph: string[] = [];
  let listItems: BlockListItem[] = [];
  let activeDivColumn: DivColumnSettings | null = null;

  function flushParagraph() {
    if (!paragraph.length) return;
    const text = paragraph.join(" ").trim();
    if (text) {
      output.push(
        <p key={`paragraph-${output.length}`}>
          {renderInline(text, onLinkClick, references, onReferenceClick)}
        </p>,
      );
    }
    paragraph = [];
  }

  function flushList() {
    if (!listItems.length) return;

    const groups: Array<typeof listItems> = [];
    for (const item of listItems) {
      const group = groups[groups.length - 1];
      const previous = group?.[0];

      if (
        !group ||
        !previous ||
        previous.type !== item.type ||
        previous.divColumn?.columnCount !== item.divColumn?.columnCount ||
        previous.divColumn?.columnWidth !== item.divColumn?.columnWidth
      ) {
        groups.push([item]);
      } else {
        group.push(item);
      }
    }

    for (const group of groups) {
      const Tag = group[0].type === "*" ? "ul" : "ol";
      const divColumn = group[0].divColumn;
      const className = divColumn
        ? "article-list article-div-col-list"
        : "article-list";
      const style = divColumn
        ? ({
            "--preview-div-col-count": divColumn.columnCount,
            "--preview-div-col-width": divColumn.columnWidth || "18em",
          } as CSSProperties)
        : undefined;

      output.push(
        <Tag className={className} key={`list-${output.length}`} style={style}>
          {group.map((item, index) => (
            <li key={`${item.text}-${index}`}>
              {renderInline(
                item.text,
                onLinkClick,
                references,
                onReferenceClick,
              )}
            </li>
          ))}
        </Tag>,
      );
    }
    listItems = [];
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    const taggedFormula = consumeTaggedFormula(lines, index);
    const heading = line.match(/^(={1,6})\s*(.*?)\s*\1$/);
    const file = parseFileMarkup(line);

    const divColumnTemplate = parseDivColumnTemplateLine(line);

    if (divColumnTemplate) {
      flushParagraph();
      flushList();
      activeDivColumn = divColumnTemplate === "end" ? null : divColumnTemplate;
      continue;
    }

    if (taggedFormula) {
      flushParagraph();
      flushList();
      output.push(
        <Formula
          data={taggedFormula.data}
          key={`formula-${index}`}
        />,
      );
      index = taggedFormula.endIndex;
      continue;
    }

    if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(heading[1].length, 3);
      const Tag = `h${level}` as "h1" | "h2" | "h3";
      output.push(
        <Tag key={`heading-${index}`}>
          {renderInline(
            heading[2],
            onLinkClick,
            references,
            onReferenceClick,
          )}
        </Tag>,
      );
      continue;
    }

    if (file) {
      flushParagraph();
      flushList();
      output.push(
        <WikiImage
          data={file}
          key={`file-${index}-${file.name}`}
          onLinkClick={onLinkClick}
        />,
      );
      continue;
    }

    if (/^[*#]\s*/.test(line)) {
      flushParagraph();
      const type = line[0] as "*" | "#";
      listItems.push({ type, text: line.slice(1).trim(), divColumn: activeDivColumn });
      continue;
    }

    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }

    if (/^\[\[Category:/i.test(line) || /^__\w+__$/.test(line)) {
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  return output;
}

function renderInline(
  text: string,
  onLinkClick: (topic: string) => void,
  references: Map<number, ReferenceData>,
  onReferenceClick?: (reference: ReferenceData) => void,
): ReactNode[] {
  const normalized = simplifyTemplates(
    text
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<ref\b[^>]*>[\s\S]*?<\/ref>/gi, "")
      .replace(/<ref\b[^>]*\/>/gi, ""),
  );
  const pattern =
    /(<(?:math|chem|ce)\b[^>]*>[\s\S]*?<\/(?:math|chem|ce)>|\[\[[^\]]+\]\]|\[(?:https?:)?\/\/[^\]\s]+(?:\s+[^\]]+)?\]|'''[^'\n]+'''|''[^'\n]+''|⌑REFERENCE:\d+⌑)/gi;

  return normalized.split(pattern).filter(Boolean).map((part, index) => {
    const key = `${part}-${index}`;
    const formula = parseFormulaMarkup(part);

    if (formula) {
      return <Formula data={formula} key={key} />;
    }

    if (part.startsWith("[[") && part.endsWith("]]")) {
      const content = part.slice(2, -2);
      const segments = splitTopLevel(content, "|");
      const target = segments[0].trim();

      if (/^(File|Image):/i.test(target)) {
        const file = parseFileMarkup(part);
        return file ? (
          <WikiImage data={file} key={key} onLinkClick={onLinkClick} />
        ) : null;
      }

      if (/^Category:/i.test(target)) return null;

      const label = displayLinkLabel(target, segments.slice(1).join("|"));
      return (
        <button
          className="wiki-link"
          key={key}
          title={target.replace(/_/g, " ")}
          onClick={() => onLinkClick(target)}
        >
          {label}
        </button>
      );
    }

    if (part.startsWith("[") && part.endsWith("]")) {
      const content = part.slice(1, -1).trim();
      const space = content.search(/\s/);
      const href = space === -1 ? content : content.slice(0, space);
      const label = space === -1 ? "External link" : content.slice(space).trim();
      return (
        <a
          className="external-link"
          href={href.startsWith("//") ? `https:${href}` : href}
          key={key}
          rel="noreferrer"
          target="_blank"
        >
          {label}
        </a>
      );
    }

    if (part.startsWith("'''") && part.endsWith("'''")) {
      return <strong key={key}>{part.slice(3, -3)}</strong>;
    }

    if (part.startsWith("''") && part.endsWith("''")) {
      return <em key={key}>{part.slice(2, -2)}</em>;
    }

    if (/^⌑REFERENCE:\d+⌑$/.test(part)) {
      const number = Number(part.match(/\d+/)?.[0]);
      const reference = references.get(number);
      return (
        <sup className="reference-marker" key={key}>
          <button
            className="reference-link"
            type="button"
            title={`Reference ${number}`}
            onClick={() => reference && onReferenceClick?.(reference)}
          >
            [{number}]
          </button>
          {reference && (
            <span className="reference-preview">
              <strong>Reference {number}</strong>
              <span>{reference.text}</span>
              <small>
                {reference.url
                  ? referenceHostname(reference.url)
                  : "Citation details"}
              </small>
            </span>
          )}
        </sup>
      );
    }

    return <Fragment key={key}>{stripHtml(part)}</Fragment>;
  });
}

function Formula({ data }: { data: FormulaData }) {
  const expression =
    data.kind === "chem"
      ? `\\ce{${normalizeChemistry(data.formula)}}`
      : normalizeMath(data.formula);

  try {
    const markup = katex.renderToString(expression, {
      displayMode: data.display,
      output: "htmlAndMathml",
      strict: "ignore",
      throwOnError: true,
    });

    return (
      <span
        className={`wiki-formula ${data.display ? "display" : "inline"} ${data.kind}`}
        dangerouslySetInnerHTML={{ __html: markup }}
      />
    );
  } catch {
    return (
      <code
        className={`wiki-formula-error ${data.display ? "display" : "inline"}`}
        title={`Could not render ${data.kind} notation`}
      >
        {data.formula}
      </code>
    );
  }
}

function consumeTaggedFormula(lines: string[], startIndex: number) {
  const firstLine = lines[startIndex].trim();
  const opening = firstLine.match(/^<(math|chem|ce)\b[^>]*>/i);
  if (!opening) return null;

  const tag = opening[1].toLowerCase();
  const closingPattern = new RegExp(`</${tag}>`, "i");
  const collected: string[] = [];

  for (let index = startIndex; index < lines.length; index += 1) {
    collected.push(lines[index]);
    if (closingPattern.test(lines[index])) {
      const data = parseFormulaMarkup(collected.join("\n"));
      return data
        ? { data: { ...data, display: true }, endIndex: index }
        : null;
    }
  }

  return null;
}

function parseFormulaMarkup(markup: string): FormulaData | null {
  const match = markup.trim().match(
    /^<(math|chem|ce)\b([^>]*)>([\s\S]*?)<\/\1>$/i,
  );
  if (!match) return null;

  const tag = match[1].toLowerCase();
  const attributes = match[2];
  const formula = decodeHtmlEntities(match[3]).trim();
  if (!formula) return null;

  return {
    display:
      tag === "math" &&
      (/\bdisplay\s*=\s*(?:"block"|'block'|block)/i.test(attributes) ||
        /\bmode\s*=\s*(?:"display"|'display'|display)/i.test(attributes)),
    formula,
    kind: tag === "math" ? "math" : "chem",
  };
}

function normalizeMath(formula: string) {
  return formula
    .replace(/\\begin\{align\}/g, "\\begin{aligned}")
    .replace(/\\end\{align\}/g, "\\end{aligned}")
    .replace(/\\begin\{align\*\}/g, "\\begin{aligned}")
    .replace(/\\end\{align\*\}/g, "\\end{aligned}")
    .trim();
}

function normalizeChemistry(formula: string) {
  return formula.replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(value: string) {
  const element = document.createElement("textarea");
  element.innerHTML = value;
  return element.value;
}

function extractLeadTemplates(source: string) {
  let body = source;
  let infobox: InfoboxData | null = null;
  const templates = findTopLevelTemplates(source);

  for (const template of templates) {
    const content = template.text.slice(2, -2);
    const parts = splitTopLevel(content, "|");
    const type = parts[0].trim();

    if (/^short description$/i.test(type)) {
      body = replaceRangeWithWhitespace(body, template.from, template.to);
      continue;
    }

    if (/^infobox\b/i.test(type) && !infobox) {
      infobox = {
        type,
        fields: parts.slice(1).flatMap((part) => {
          const equals = findTopLevelCharacter(part, "=");
          if (equals === -1) return [];
          return [{
            key: part.slice(0, equals).trim().toLowerCase(),
            value: part.slice(equals + 1).trim(),
          }];
        }),
      };
      body = replaceRangeWithWhitespace(body, template.from, template.to);
    }
  }

  return { body, infobox };
}

function findTopLevelTemplates(source: string) {
  const templates: Array<{ from: number; to: number; text: string }> = [];
  let depth = 0;
  let start = -1;

  for (let index = 0; index < source.length - 1; index += 1) {
    const pair = source.slice(index, index + 2);
    if (pair === "{{") {
      if (depth === 0) start = index;
      depth += 1;
      index += 1;
    } else if (pair === "}}" && depth > 0) {
      depth -= 1;
      index += 1;
      if (depth === 0 && start >= 0) {
        templates.push({
          from: start,
          to: index + 1,
          text: source.slice(start, index + 1),
        });
        start = -1;
      }
    }
  }

  return templates;
}

function splitTopLevel(value: string, separator: string) {
  const parts: string[] = [];
  let current = "";
  let braceDepth = 0;
  let bracketDepth = 0;

  for (let index = 0; index < value.length; index += 1) {
    const pair = value.slice(index, index + 2);
    if (pair === "{{") {
      braceDepth += 1;
      current += pair;
      index += 1;
      continue;
    }
    if (pair === "}}" && braceDepth > 0) {
      braceDepth -= 1;
      current += pair;
      index += 1;
      continue;
    }
    if (pair === "[[") {
      bracketDepth += 1;
      current += pair;
      index += 1;
      continue;
    }
    if (pair === "]]" && bracketDepth > 0) {
      bracketDepth -= 1;
      current += pair;
      index += 1;
      continue;
    }
    if (
      value[index] === separator &&
      braceDepth === 0 &&
      bracketDepth === 0
    ) {
      parts.push(current);
      current = "";
      continue;
    }
    current += value[index];
  }

  parts.push(current);
  return parts;
}

function findTopLevelCharacter(value: string, character: string) {
  const parts = splitTopLevel(value, character);
  return parts.length > 1 ? parts[0].length : -1;
}

function parseFileMarkup(markup: string): FileData | null {
  const match = markup.trim().match(/^\[\[(?:File|Image):([\s\S]+)\]\]$/i);
  if (!match) return null;

  const parts = splitTopLevel(match[1], "|").map((part) => part.trim());
  const name = parts.shift();
  if (!name) return null;

  const widthOption = parts.find((part) => /^\d+\s*px$/i.test(part));
  const width = widthOption ? Number.parseInt(widthOption, 10) : 320;
  const thumbnail = parts.some((part) => /^(thumb|thumbnail|frame)$/i.test(part));
  const explicitAlignment = parts
    .find((part) => /^(left|center|right|none)$/i.test(part))
    ?.toLowerCase() as FileData["alignment"] | undefined;
  const alignment = explicitAlignment || (thumbnail ? "right" : "inline");
  const optionWords = /^(thumb|thumbnail|frame|frameless|border|left|center|right|none|upright(?:=.*)?|\d+\s*px|alt=.*|link=.*|class=.*|lang=.*|page=.*)$/i;
  const captionParts = parts.filter((part) => !optionWords.test(part));
  const caption = captionParts[captionParts.length - 1] || "";

  return {
    name: normalizeFileName(name),
    caption,
    width: Math.min(Math.max(width, 80), 900),
    alignment,
    thumbnail,
  };
}

function fileFromInfoboxValue(
  value: string,
  caption: string,
  size?: string,
): FileData | null {
  const embedded = parseFileMarkup(value);
  if (embedded) return { ...embedded, caption: caption || embedded.caption };

  const cleanName = normalizeFileName(
    value
      .replace(/^\[\[(?:File|Image):/i, "")
      .replace(/\]\]$/, "")
      .split("|")[0]
      .trim(),
  );
  if (!cleanName || cleanName.includes("{{")) return null;

  const parsedSize = size?.match(/\d+/)?.[0];
  return {
    name: cleanName,
    caption,
    width: parsedSize ? Math.min(Number(parsedSize), 500) : 320,
    alignment: "center",
    thumbnail: false,
  };
}

function displayLinkLabel(target: string, pipedLabel: string) {
  const explicit = pipedLabel.trim();
  if (explicit) return explicit;

  if (pipedLabel === "") {
    return target
      .replace(/^.*:/, "")
      .replace(/\s*\([^)]*\)\s*$/, "")
      .replace(/_/g, " ");
  }

  return target.replace(/_/g, " ").replace(/^:/, "");
}

function simplifyTemplates(value: string) {
  let output = value;
  let previous = "";

  while (output !== previous) {
    previous = output;
    output = output.replace(/\{\{([^{}]+)\}\}/g, (_match, content: string) => {
      const parts = splitTopLevel(content, "|").map((part) => part.trim());
      const name = parts.shift()?.toLowerCase() || "";

      if (name === "url") {
        const url = parts.find((part) => /^https?:\/\//.test(part)) || parts[0] || "";
        return url ? `[${url} ${url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}]` : "";
      }
      if (name.startsWith("start date")) {
        return parts.slice(0, 3).filter(Boolean).join("-");
      }
      if (name === "nowrap" || name === "small" || name === "code") {
        return parts[parts.length - 1] || "";
      }
      if (name === "unbulleted list" || name === "plainlist") {
        return parts.filter(Boolean).join(", ");
      }
      if (name === "ubl") return parts.filter(Boolean).join(", ");
      if (name === "wikidata") return "";
      if (name.startsWith("cite ")) return "";
      return parts.find((part) => part && !part.includes("=")) || "";
    });
  }

  return output;
}

function commonsFileUrl(name: string, width: number) {
  const encodedName = encodeURIComponent(normalizeFileName(name)).replace(/%2F/g, "/");
  return `https://commons.wikimedia.org/wiki/Special:Redirect/file/${encodedName}?width=${Math.round(width * 2)}`;
}

function normalizeFileName(name: string) {
  return name.replace(/^(?:File|Image):/i, "").replace(/_/g, " ").trim();
}

function humanizeField(field: string) {
  return field
    .replace(/_/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function replaceRangeWithWhitespace(value: string, from: number, to: number) {
  return `${value.slice(0, from)}${value.slice(from, to).replace(/[^\n]/g, " ")}${value.slice(to)}`;
}

function stripHtml(value: string) {
  return value
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<\/?(?:small|span|div|nowiki|code|syntaxhighlight)[^>]*>/gi, "")
    .replace(/&nbsp;/gi, " ");
}

function plainText(value: string) {
  return stripHtml(simplifyTemplates(value))
    .replace(/\[\[([^|\]]+)\|?([^\]]*)\]\]/g, (_match, target, label) => label || target)
    .replace(/'{2,3}/g, "")
    .trim();
}

function hasRenderableValue(value: string) {
  return plainText(value)
    .replace(/\[\s*(?:source|citation needed)\s*\]/gi, "")
    .trim().length > 0;
}

function numberReferences(source: string) {
  const names = new Map<string, number>();
  const references = new Map<number, ReferenceData>();
  let nextNumber = 1;
  const referencePattern =
    /<ref\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/ref\s*>)/gi;

  const numberedSource = source.replace(
    referencePattern,
    (_match, attributes: string, content = "") => {
      const nameMatch = attributes.match(
        /\bname\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s/>]+))/i,
      );
      const name = (nameMatch?.[1] || nameMatch?.[2] || nameMatch?.[3] || "").trim();

      if (name) {
        const existingNumber = names.get(name);
        if (existingNumber) return `⌑REFERENCE:${existingNumber}⌑`;
        names.set(name, nextNumber);
      }

      const number = nextNumber;
      nextNumber += 1;
      references.set(number, {
        number,
        text: referenceText(content) || `Reference ${number}`,
        url: firstReferenceUrl(content),
      });
      return `⌑REFERENCE:${number}⌑`;
    },
  );

  return { source: numberedSource, references };
}

function firstReferenceUrl(content: string) {
  const directUrl = content.match(/https?:\/\/[^\s|}\]<>"]+/i)?.[0];
  return directUrl?.replace(/[.,;:)]+$/, "") || null;
}

function referenceHostname(url: string) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "Web source";
  }
}

function referenceText(content: string) {
  return plainText(
    content
      .replace(/\{\{(?:webarchive|cite web|cite news|cite book)\b/gi, "{{")
      .replace(/\|\s*(?:url|archive-url|archiveurl)\s*=\s*https?:\/\/[^\s|}]+/gi, "")
      .replace(/\|\s*(?:access-date|archive-date|date|df)\s*=\s*[^|}]+/gi, "")
      .replace(/\[(https?:\/\/[^\s\]]+)\s+([^\]]+)\]/gi, "$2"),
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 260);
}
