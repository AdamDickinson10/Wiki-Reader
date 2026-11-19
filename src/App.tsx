import { listen } from "@tauri-apps/api/event";
import { Fragment, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode, useEffect, useRef, useState } from "react";
import WikitextEditor, {
  type EditorAction,
  type WikitextEditorHandle,
} from "./WikitextEditor";
import WikitextPreview, {
  getWikitextTitle,
  type ReferenceData,
} from "./WikitextPreview";
import WikipediaReader, { type ReaderTarget } from "./WikipediaReader";
import "./App.css";

const starterDocument = `= Photosynthesis =
'''Photosynthesis''' is the process used by plants, algae, and some bacteria to convert light energy into chemical energy.

== Overview ==
During photosynthesis, [[chlorophyll]] absorbs light energy and transforms it into stored chemical energy in the form of [[glucose]].

The overall reaction can be summarized as:

6CO₂ + 6H₂O + light → C₆H₁₂O₆ + 6O₂

== Key Components ==
* [[Chlorophyll]] absorbs light energy.
* Water supplies electrons.
* Carbon dioxide supplies carbon.
* Sunlight provides energy.

== Process ==
# Light-dependent reactions occur in the [[thylakoid membrane]].
# The [[Calvin cycle]] fixes carbon dioxide into glucose.
`;

type EditingPaneId = "editor" | "preview" | "research";
type EditingPaneWidths = Record<EditingPaneId, number>;

interface ReaderBrowserTab {
  id: string;
  target: ReaderTarget | null;
  title: string;
}

const minimumPaneWidth = 250;
const dividerWidth = 5;
const allEditingPanes: EditingPaneId[] = ["research"];
const editingPaneLabels: Record<EditingPaneId, string> = {
  editor: "Sandbox Editor",
  preview: "Sandbox Preview",
  research: "Wikipedia Reader",
};
const editingPaneDescriptions: Record<EditingPaneId, string> = {
  editor: "Edit the current page's wikitext.",
  preview: "See the sandbox render as you type.",
  research: "Read linked Wikipedia articles and media.",
};


const READER_ARTICLE_BASE_WIDTH = 1050;
const READER_PARSER_BASE_WIDTH = 1006;
const READER_ARTICLE_SIDE_PADDING = 96;
const READER_ARTICLE_WIDTH_MIN_PERCENT = 80;
const READER_ARTICLE_WIDTH_MAX_PERCENT = 400;


type ReaderWidthControlProps = {
  articleWidthPercent: number;
  onDecrease: () => void;
  onIncrease: () => void;
  onDefault: () => void;
  onFullWidth: () => void;
};

function ReaderWidthControl({
  articleWidthPercent,
  onDecrease,
  onIncrease,
  onDefault,
  onFullWidth,
}: ReaderWidthControlProps) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;

      if (popoverRef.current?.contains(target)) return;
      if (buttonRef.current?.contains(target)) return;

      setOpen(false);
    };

    document.addEventListener("pointerdown", handlePointerDown, true);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [open]);

  return (
    <>
      <button
        aria-label="Article width"
        className="app-toolbar-button app-width-button"
        ref={buttonRef}
        title="Article width"
        type="button"
        onClick={() => setOpen((currentOpen) => !currentOpen)}
      >
        Width
      </button>

      <div
        aria-label="Article Width"
        className={`app-width-popover${open ? " app-width-popover-open" : ""}`}
        ref={popoverRef}
        role="dialog"
      >
        <div className="app-width-popover-header">
          <strong>Width Amount</strong>
          <button
            aria-label="Close article width"
            className="app-width-popover-close"
            title="Close"
            type="button"
            onClick={() => setOpen(false)}
          >
            ×
          </button>
        </div>

        <div className="app-width-popover-row">
          <button
            aria-label="Decrease article width"
            className="app-width-step-button"
            title="Decrease article width"
            type="button"
            onClick={onDecrease}
          >
            −
          </button>

          <div className="app-width-value" aria-live="polite">
            {articleWidthPercent}%
          </div>

          <button
            aria-label="Increase article width"
            className="app-width-step-button"
            title="Increase article width"
            type="button"
            onClick={onIncrease}
          >
            +
          </button>
        </div>

        <div className="app-width-popover-actions">
          <button type="button" onClick={onDefault}>
            Default
          </button>
          <button type="button" onClick={onFullWidth}>
            Full width
          </button>
        </div>
      </div>
    </>
  );
}


function App() {
  const [attributionOpen, setAttributionOpen] = useState(false);

  useEffect(() => {
    let dispose: (() => void) | undefined;
    let disposeContents: (() => void) | undefined;
    let disposeWidth: (() => void) | undefined;
    let disposeZoomIn: (() => void) | undefined;
    let disposeZoomOut: (() => void) | undefined;
    let disposeZoomReset: (() => void) | undefined;
    let disposeTools: (() => void) | undefined;
    let disposeBack: (() => void) | undefined;
    let disposeReload: (() => void) | undefined;
    let disposeExternal: (() => void) | undefined;
    let disposeMedia: (() => void) | undefined;
    let disposeAttribution: (() => void) | undefined;

    void listen("reader-menu-find", () => {
      document.dispatchEvent(new KeyboardEvent("keydown", {
        key: "f",
        code: "KeyF",
        metaKey: true,
        bubbles: true,
        cancelable: true,
      }));
    });

    void listen("reader-menu-contents", () => {
      [...document.querySelectorAll<HTMLButtonElement>(
        ".reader-unified-contents-button, .reader-contents-button"
      )]
        .find((button) => button.offsetWidth || button.offsetHeight)
        ?.click();
    }).then((unlisten) => {
      disposeContents = unlisten;
    });

    void listen("reader-menu-width", () => {
      const shell = document.querySelector<HTMLElement>("main.app-shell");
      const widthButton = [...document.querySelectorAll<HTMLButtonElement>(".app-width-button")]
        .find((button) => button.offsetWidth || button.offsetHeight);
      if (!shell || !widthButton) return;

      const currentWidth = getComputedStyle(shell)
        .getPropertyValue("--reader-article-width")
        .trim();
      const targetLabel = currentWidth === String(READER_ARTICLE_BASE_WIDTH) + "px"
        ? "Full width"
        : "Default";

      const applyTarget = () => {
        [...document.querySelectorAll<HTMLButtonElement>(".app-width-popover button")]
          .find((button) =>
            (button.textContent || "").trim() === targetLabel &&
            (button.offsetWidth || button.offsetHeight),
          )
          ?.click();
      };

      const openPopover = [...document.querySelectorAll<HTMLDivElement>(".app-width-popover")]
        .find((popover) => popover.offsetWidth || popover.offsetHeight);

      if (openPopover) {
        applyTarget();
      } else {
        widthButton.click();
        window.setTimeout(applyTarget, 0);
      };
    }).then((unlisten) => {
      disposeWidth = unlisten;
    });

    void listen("reader-menu-zoom-in", () => {
      document.dispatchEvent(new KeyboardEvent("keydown", {
        key: "+", code: "Equal", metaKey: true, bubbles: true, cancelable: true,
      }));
    }).then((unlisten) => { disposeZoomIn = unlisten; });

    void listen("reader-menu-zoom-out", () => {
      document.dispatchEvent(new KeyboardEvent("keydown", {
        key: "-", code: "Minus", metaKey: true, bubbles: true, cancelable: true,
      }));
    }).then((unlisten) => { disposeZoomOut = unlisten; });

    void listen("reader-menu-zoom-reset", () => {
      document.dispatchEvent(new KeyboardEvent("keydown", {
        key: "0", code: "Digit0", metaKey: true, bubbles: true, cancelable: true,
      }));
    }).then((unlisten) => { disposeZoomReset = unlisten; });

    void listen("reader-menu-tools", () => {
      [...document.querySelectorAll<HTMLButtonElement>('button[aria-label="Hide reader tools"], button[aria-label="Show reader tools"]')]
        .find((button) => button.offsetWidth || button.offsetHeight)
        ?.click();
    }).then((unlisten) => {
      disposeTools = unlisten;
    });

    void listen("reader-menu-back", () => {
      [...document.querySelectorAll<HTMLButtonElement>('button[aria-label="Back"]')]
        .find((button) => button.offsetWidth || button.offsetHeight)
        ?.click();
    }).then((unlisten) => {
      disposeBack = unlisten;
    });

    void listen("reader-menu-reload", () => {
      [...document.querySelectorAll<HTMLButtonElement>('button[aria-label="Reload"]')]
        .find((button) => button.offsetWidth || button.offsetHeight)
        ?.click();
    }).then((unlisten) => {
      disposeReload = unlisten;
    });

    void listen("reader-menu-external", () => {
      [...document.querySelectorAll<HTMLAnchorElement>('a[title="Open externally"]')]
        .find((link) => link.offsetWidth || link.offsetHeight)
        ?.click();
    }).then((unlisten) => {
      disposeExternal = unlisten;
    });

    void listen("reader-menu-media", () => {
      document.dispatchEvent(new KeyboardEvent("keydown", {
        key: " ",
        code: "Space",
        bubbles: true,
        cancelable: true,
      }));
    }).then((unlisten) => {
      disposeMedia = unlisten;
    });

    void listen("reader-menu-attribution", () => {
      setAttributionOpen(true);
    }).then((unlisten) => {
      disposeAttribution = unlisten;
    });

    return () => {
      dispose?.();
      disposeContents?.();
      disposeWidth?.();
      disposeZoomIn?.();
      disposeZoomOut?.();
      disposeZoomReset?.();
      disposeTools?.();
      disposeBack?.();
      disposeReload?.();
      disposeExternal?.();
      disposeMedia?.();
      disposeAttribution?.();
    };
  }, []);

  const [readerArticleWidthPercent, setReaderArticleWidthPercent] = useState(100);

  const readerArticleWidthPx = Math.round(READER_ARTICLE_BASE_WIDTH * (readerArticleWidthPercent / 100));
  const readerParserWidthPx = Math.round(READER_PARSER_BASE_WIDTH * (readerArticleWidthPercent / 100));

  const [readerContentZoom, setReaderContentZoom] = useState(1.05);

  useEffect(() => {
    const handleAppZoomKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;

      const isZoomIn = event.key === "+" || event.key === "=";
      const isZoomOut = event.key === "-" || event.key === "_";
      const isZoomReset = event.key === "0";
      if (!isZoomIn && !isZoomOut && !isZoomReset) return;

      event.preventDefault();
      event.stopPropagation();

      if (isZoomReset) {
        setReaderContentZoom(1.05);
      } else {
        setReaderContentZoom((currentZoom) => {
          const delta = isZoomIn ? 0.05 : -0.05;
          const nextZoom = Math.round((currentZoom + delta) * 100) / 100;
          return Math.min(1.6, Math.max(0.7, nextZoom));
        });
      }
    };

    document.addEventListener("keydown", handleAppZoomKeyDown, true);
    return () => document.removeEventListener("keydown", handleAppZoomKeyDown, true);
  }, []);

  function changeReaderContentZoom(delta: number) {
    setReaderContentZoom((currentZoom) => {
      const nextZoom = Math.round((currentZoom + delta) * 100) / 100;
      return Math.min(1.6, Math.max(0.7, nextZoom));
    });
  }


  // ADAM INFOBOX COORDINATE NORMALIZER
  // Infobox coordinate rows sometimes render both DMS and decimal coordinates.
  // Keep the cleaner decimal coordinate only, while preserving the GeoHack link.
  useEffect(() => {
    const clean = (value: string | null | undefined) =>
      String(value || "")
        .replace(/\s+/g, " ")
        .trim();

    const normalizeInfoboxCoordinates = () => {
      const cells = Array.from(
        document.querySelectorAll<HTMLTableCellElement>(
          ".reader-article table.infobox td.infobox-full-data"
        )
      );

      cells.forEach((cell) => {
        if (cell.dataset.adamCoordinateNormalized === "true") return;

        const text = clean(cell.innerText || cell.textContent);

        // Conservative: only rewrite rows that clearly contain both coordinate forms.
        if (!text.includes("/") || !text.includes("°")) return;

        const decimalMatch = text.match(
          /\/\s*([+-]?\d+(?:\.\d+)?)°?\s*([NS])\s+([+-]?\d+(?:\.\d+)?)°?\s*([EW])/i
        );

        if (!decimalMatch) return;

        const coordText = `${decimalMatch[1]}°${decimalMatch[2].toUpperCase()} ${decimalMatch[3]}°${decimalMatch[4].toUpperCase()}`;

        const existingLink =
          Array.from(cell.querySelectorAll<HTMLAnchorElement>("a")).find((link) =>
            (link.getAttribute("href") || "").includes("geohack")
          ) || cell.querySelector<HTMLAnchorElement>("a");

        cell.innerHTML = "";
        cell.dataset.adamCoordinateNormalized = "true";
        cell.classList.add("reader-normalized-coordinate-cell");

        const wrapper = document.createElement("div");
        wrapper.className = "reader-coordinate-line";

        const icon = document.createElement("span");
        icon.className = "reader-coordinate-icon";
        icon.textContent = "🌐";

        wrapper.append(icon, document.createTextNode(" "));

        if (existingLink) {
          const link = existingLink.cloneNode(false) as HTMLAnchorElement;
          link.textContent = coordText;
          wrapper.append(link);
        } else {
          wrapper.append(document.createTextNode(coordText));
        }

        cell.append(wrapper);
      });
    };

    normalizeInfoboxCoordinates();

    const observer = new MutationObserver(normalizeInfoboxCoordinates);
    observer.observe(document.body, { childList: true, subtree: true });

    return () => observer.disconnect();
  }, []);
  // END ADAM INFOBOX COORDINATE NORMALIZER


  // ADAM INFOBOX ADDRESS NORMALIZER
  // Normalize US-style infobox address cells so city/state/ZIP stay on one line.
  useEffect(() => {
    const clean = (value: string | null | undefined) =>
      String(value || "")
        .replace(/\s+/g, " ")
        .trim();

    const decodeWikiHrefTitle = (href: string | null | undefined) => {
      const decoded = decodeURIComponent(String(href || "")).replace(/_/g, " ");
      const match = decoded.match(/\/wiki\/([^#?]+)/);
      return match ? clean(match[1]) : "";
    };

    const stateNames = new Set([
      "Alabama",
      "Alaska",
      "Arizona",
      "Arkansas",
      "California",
      "Colorado",
      "Connecticut",
      "Delaware",
      "Florida",
      "Georgia",
      "Hawaii",
      "Idaho",
      "Illinois",
      "Indiana",
      "Iowa",
      "Kansas",
      "Kentucky",
      "Louisiana",
      "Maine",
      "Maryland",
      "Massachusetts",
      "Michigan",
      "Minnesota",
      "Mississippi",
      "Missouri",
      "Montana",
      "Nebraska",
      "Nevada",
      "New Hampshire",
      "New Jersey",
      "New Mexico",
      "New York",
      "North Carolina",
      "North Dakota",
      "Ohio",
      "Oklahoma",
      "Oregon",
      "Pennsylvania",
      "Rhode Island",
      "South Carolina",
      "South Dakota",
      "Tennessee",
      "Texas",
      "Utah",
      "Vermont",
      "Virginia",
      "Washington",
      "West Virginia",
      "Wisconsin",
      "Wyoming",
    ]);

    const linkLabels = (link: HTMLAnchorElement | null | undefined) =>
      [
        clean(link?.textContent),
        clean(link?.getAttribute("title")),
        decodeWikiHrefTitle(link?.getAttribute("href")),
      ].filter(Boolean);

    const getStateLabel = (links: HTMLAnchorElement[], countryLink: HTMLAnchorElement | undefined) => {
      for (const link of links) {
        if (link === countryLink) continue;

        const found = linkLabels(link).find((label) => stateNames.has(label.replace(/[,\s]+$/, "")));
        if (found) return found.replace(/[,\s]+$/, "");
      }

      return "";
    };

    const getLinkedPlace = (
      cell: HTMLTableCellElement,
      stateLabel: string,
      countryLink: HTMLAnchorElement | undefined
    ) => {
      const cellLinks = Array.from(cell.querySelectorAll<HTMLAnchorElement>("a")).filter(
        (link) => link !== countryLink
      );

      for (const link of cellLinks) {
        const label = linkLabels(link).find(
          (candidate) => candidate.includes(",") && (!stateLabel || candidate.endsWith(`, ${stateLabel}`))
        );

        if (label) {
          return {
            label: label.replace(/[,\s]+$/, ""),
            link,
          };
        }
      }

      const cityLink = cellLinks.find((link) => {
        const label = clean(link.textContent).replace(/[,\s]+$/, "");
        return Boolean(label) && label !== stateLabel && !stateNames.has(label);
      });

      if (cityLink && stateLabel) {
        return {
          label: `${clean(cityLink.textContent).replace(/[,\s]+$/, "")}, ${stateLabel}`,
          link: cityLink,
        };
      }

      const article = cell.closest(".reader-article") || document.querySelector(".reader-article") || document.body;

      for (const link of Array.from(article.querySelectorAll<HTMLAnchorElement>("a"))) {
        const label = linkLabels(link).find((candidate) => {
          if (!candidate.includes(",")) return false;
          if (stateLabel && !candidate.endsWith(`, ${stateLabel}`)) return false;

          const [city, state] = candidate.split(",").map(clean);
          return Boolean(city) && stateNames.has(state);
        });

        if (label) {
          return {
            label: label.replace(/[,\s]+$/, ""),
            link,
          };
        }
      }

      return null;
    };

    const normalizeInfoboxAddresses = () => {
      const cells = Array.from(
        document.querySelectorAll<HTMLTableCellElement>(
          ".reader-article table.infobox td.infobox-full-data"
        )
      );

      cells.forEach((cell) => {
        if (cell.dataset.adamAddressNormalized === "true") return;

        const rawText = cell.innerText || cell.textContent || "";
        const text = clean(rawText);

        // Conservative: only normalize ordinary US address cells, not coordinate rows.
        if (!text.includes("United States")) return;
        if (text.includes("°") || text.includes("|")) return;

        const lines = rawText
          .split(/\n+/)
          .map(clean)
          .filter(Boolean);

        const streetLine = lines.find(
          (line) =>
            /^\d/.test(line) &&
            !/\b\d{5}(?:-\d{4})?\b/.test(line) &&
            !line.includes("°")
        );

        const postalCode =
          lines
            .map((line) => line.match(/\b\d{5}(?:-\d{4})?\b/)?.[0])
            .find(Boolean) || text.match(/\b\d{5}(?:-\d{4})?\b/)?.[0];

        const links = Array.from(cell.querySelectorAll<HTMLAnchorElement>("a"));

        const countryLink = links.find(
          (link) => clean(link.textContent) === "United States"
        );

        if (!streetLine || !postalCode || !countryLink) return;

        const stateLabel = getStateLabel(links, countryLink);
        const linkedPlace = getLinkedPlace(cell, stateLabel, countryLink);

        if (!linkedPlace) return;

        const cloneOrText = (
          link: HTMLAnchorElement | undefined,
          fallback: string
        ): Node => {
          if (!link) return document.createTextNode(fallback);

          const clone = link.cloneNode(false) as HTMLAnchorElement;
          clone.textContent = fallback;
          return clone;
        };

        cell.innerHTML = "";
        cell.dataset.adamAddressNormalized = "true";
        cell.classList.add("reader-normalized-address-cell");

        const line1 = document.createElement("div");
        line1.className = "reader-address-line";
        line1.textContent = streetLine;

        const line2 = document.createElement("div");
        line2.className = "reader-address-line";
        line2.append(cloneOrText(linkedPlace.link, linkedPlace.label));
        line2.append(document.createTextNode(` ${postalCode}`));

        const line3 = document.createElement("div");
        line3.className = "reader-address-line reader-address-country";
        line3.append(countryLink.cloneNode(true));

        cell.append(line1, line2, line3);
      });
    };

    normalizeInfoboxAddresses();

    const observer = new MutationObserver(normalizeInfoboxAddresses);
    observer.observe(document.body, { childList: true, subtree: true });

    return () => observer.disconnect();
  }, []);
  // END ADAM INFOBOX ADDRESS NORMALIZER


  // ADAM HIDE NOTES HEADING ONLY
  // Hide the empty "Notes" section heading, but keep navboxes/content below it.
  useEffect(() => {
    const cleanHeadingText = (text: string | null | undefined) =>
      String(text || "")
        .replace(/[☰≡]/g, "")
        .replace(/\s+/g, " ")
        .trim();

    const hideNotesHeading = () => {
      const candidates = Array.from(
        document.querySelectorAll<HTMLElement>(
          ".reader-article :is(.mw-heading, .reader-heading-row, .reader-section-heading, .reader-heading-with-menu, h1, h2, h3, h4)"
        )
      );

      candidates.forEach((candidate) => {
        if (cleanHeadingText(candidate.innerText || candidate.textContent) !== "Notes") {
          return;
        }

        const row =
          candidate.closest<HTMLElement>(
            ".mw-heading, .reader-heading-row, .reader-section-heading, .reader-heading-with-menu"
          ) || candidate;

        row.classList.add("reader-hidden-notes-heading");
      });
    };

    hideNotesHeading();

    const observer = new MutationObserver(hideNotesHeading);
    observer.observe(document.body, { childList: true, subtree: true });

    return () => observer.disconnect();
  }, []);
  // END ADAM HIDE NOTES HEADING ONLY



  // ADAM GLOBAL TOP SEARCH TYPE FOCUS
  // On article pages, typing from the page body starts typing in the top Search Wikipedia box.
  // The launch page keeps using the middle landing search box.
  useEffect(() => {
    const setNativeValue = (input: HTMLInputElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )?.set;

      setter?.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    };

    const isEditable = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return false;

      return Boolean(
        target.closest(
          [
            "input",
            "textarea",
            "select",
            "[contenteditable='true']",
            "[role='textbox']",
            ".cm-editor",
            ".cm-content",
          ].join(", ")
        )
      );
    };

    const isVisible = (el: HTMLElement) => {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);

      return (
        rect.width > 20 &&
        rect.height > 20 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0"
      );
    };

    const isLandingPage = () => {
      const landing = document.querySelector<HTMLElement>(".wiki-landing");
      return Boolean(landing && isVisible(landing));
    };

    const getTopSearch = () =>
      document.querySelector<HTMLInputElement>(
        '.wiki-search-form input[aria-label="Search Wikipedia"], .wiki-search-form input[placeholder="Search Wikipedia"]'
      );

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (isLandingPage()) return;
      if (event.defaultPrevented) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      const hasVisibleReaderVideo = Array.from(
        document.querySelectorAll<HTMLVideoElement>(".browser-content video"),
      ).some((video) => {
        const rect = video.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });

      if (event.code === "Space" && hasVisibleReaderVideo) return;
      if (event.key.length !== 1) return;
      if (isEditable(event.target)) return;

      const input = getTopSearch();
      if (!input || input.disabled || input.readOnly || !isVisible(input)) return;

      event.preventDefault();

      input.focus({ preventScroll: true });
      setNativeValue(input, event.key);
      input.setSelectionRange(event.key.length, event.key.length);
    };

    document.addEventListener("keydown", handleKeyDown, true);

    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, []);
  // END ADAM GLOBAL TOP SEARCH TYPE FOCUS


  const [source, setSource] = useState(
    () => localStorage.getItem("wikitext-studio-draft") ?? starterDocument,
  );
  const [publishedSource, setPublishedSource] = useState(source);
  const [readerTabs, setReaderTabs] = useState<ReaderBrowserTab[]>(() => [
    {
      id: "reader-1",
      target: null,
      title: "New tab",
    },
  ]);
  const [activeReaderTabId, setActiveReaderTabId] = useState("reader-1");
  const readerTabScrollPositionsRef = useRef<Record<string, number>>({});

  function activateReaderTab(tabId: string) {
    const activePanel = document.querySelector<HTMLElement>(
      ".reader-tab-panel-active",
    );
    const activeScroller = activePanel?.querySelector<HTMLElement>(
      ".wikipedia-reader",
    );
    const activeId = activePanel?.dataset.readerTabPanelId;

    if (activeScroller && activeId) {
      readerTabScrollPositionsRef.current[activeId] = activeScroller.scrollTop;
    }

    setActiveReaderTabId(tabId);

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const panel = document.querySelector<HTMLElement>(
          `[data-reader-tab-panel-id="${tabId}"]`,
        );
        const scroller = panel?.querySelector<HTMLElement>(
          ".wikipedia-reader",
        );
        if (scroller) {
          scroller.scrollTop = readerTabScrollPositionsRef.current[tabId] ?? 0;
        }
      });
    });
  }


  const [readerToolbarHost, setReaderToolbarHost] =
    useState<HTMLDivElement | null>(null);
  const [readerToolsVisible, setReaderToolsVisible] = useState(false);
  const toggleReaderTools = () => {
    setReaderToolsVisible((visible) => !visible);
  };

  /* ADAM STABLE WIKIPEDIA TAB PANELS */
  const [readerTabPanelIds, setReaderTabPanelIds] = useState<string[]>(() => [
    "reader-1",
  ]);

  const nextReaderTabIdRef = useRef(2);

  const MAX_READER_TABS = 20;

  /* ADAM REORDERABLE WIKIPEDIA TABS */
  const readerTabDragRef = useRef<{
    pointerId: number;
    tabId: string;
    tab: HTMLElement;
    row: HTMLDivElement;
    startX: number;
    lastX: number;
    pointerOffsetX: number;
    translateX: number;
    dragging: boolean;
  } | null>(null);
  const readerTabSuppressClickUntilRef = useRef(0);

  const activeReaderTab =
    readerTabs.find((tab) => tab.id === activeReaderTabId) || readerTabs[0];

  function updateReaderTabTarget(tabId: string, target: ReaderTarget) {
    setReaderTabs((tabs) =>
      tabs.map((tab) =>
        tab.id === tabId
          ? { ...tab, target }
          : tab,
      ),
    );
  }

  function openNewReaderTab() {
    if (readerTabs.length >= MAX_READER_TABS) return;
    const id = `reader-${nextReaderTabIdRef.current}`;
    nextReaderTabIdRef.current += 1;

    setReaderTabs((tabs) => [
      ...tabs,
      {
        id,
        target: null,
        title: "New tab",
      },
    ]);
    setReaderTabPanelIds((panelIds) => [...panelIds, id]);
    setActiveReaderTabId(id);
  }

  function openReaderTargetInNewTab(target: ReaderTarget) {
    if (readerTabs.length >= MAX_READER_TABS) return;
    const id = `reader-`;
    nextReaderTabIdRef.current += 1;

    setReaderTabs((tabs) => [
      ...tabs,
      {
        id,
        target,
        title: "New tab",
      },
    ]);
    setReaderTabPanelIds((panelIds) => [...panelIds, id]);
    setActiveReaderTabId(id);

    window.requestAnimationFrame(() => {
      setActiveReaderTabId(id);
    });
  }

  function closeReaderTab(tabId: string) {
    if (readerTabs.length <= 1) {
      const id = `reader-${nextReaderTabIdRef.current}`;
      nextReaderTabIdRef.current += 1;

      setReaderTabs([
        {
          id,
          target: null,
          title: "New tab",
        },
      ]);
      setReaderTabPanelIds([id]);
      setActiveReaderTabId(id);
      return;
    }

    const closingIndex = readerTabs.findIndex((tab) => tab.id === tabId);
    const nextTabs = readerTabs.filter((tab) => tab.id !== tabId);

    if (activeReaderTabId === tabId) {
      const nextActiveTab =
        nextTabs[Math.max(0, Math.min(closingIndex, nextTabs.length - 1))] ||
        nextTabs[0];

      setActiveReaderTabId(nextActiveTab.id);
    }

    setReaderTabs(nextTabs);
    setReaderTabPanelIds((panelIds) =>
      panelIds.filter((id) => id !== tabId),
    );
  }
  function getReaderTabElements(row: HTMLDivElement) {
    return Array.from(
      row.querySelectorAll<HTMLElement>(
        ":scope > .reader-page-tab",
      ),
    );
  }

  function animateReaderTabReorder(
    row: HTMLDivElement,
    draggedTab: HTMLElement,
    reorder: () => void,
  ) {
    const otherTabs = getReaderTabElements(row).filter(
      (tab) => tab !== draggedTab,
    );
    const previousPositions = new Map(
      otherTabs.map((tab) => [
        tab,
        tab.getBoundingClientRect().left,
      ]),
    );

    reorder();

    otherTabs.forEach((tab) => {
      const previousLeft = previousPositions.get(tab);
      if (previousLeft === undefined) return;

      const movement =
        previousLeft - tab.getBoundingClientRect().left;

      if (Math.abs(movement) < 0.5) return;

      tab.animate(
        [
          { transform: `translateX(${movement}px)` },
          { transform: "translateX(0)" },
        ],
        {
          duration: 180,
          easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
        },
      );
    });
  }

  function handleReaderTabPointerDown(
    event: PointerEvent<HTMLDivElement>,
  ) {
    if (event.button !== 0) return;

    const target = event.target;

    if (
      !(target instanceof Element) ||
      target.closest(".pane-tab-actions, button")
    ) {
      return;
    }

    const tab = target.closest<HTMLElement>(
      ".reader-page-tab",
    );
    const tabId = tab?.dataset.readerTabId;

    if (
      !tab ||
      !tabId ||
      !event.currentTarget.contains(tab)
    ) {
      return;
    }

    const tabBounds = tab.getBoundingClientRect();

    readerTabDragRef.current = {
      pointerId: event.pointerId,
      tabId,
      tab,
      row: event.currentTarget,
      startX: event.clientX,
      lastX: event.clientX,
      pointerOffsetX: event.clientX - tabBounds.left,
      translateX: 0,
      dragging: false,
    };

    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  }

  function handleReaderTabPointerMove(
    event: PointerEvent<HTMLDivElement>,
  ) {
    const drag = readerTabDragRef.current;

    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    const distance = event.clientX - drag.startX;

    if (!drag.dragging && Math.abs(distance) < 8) {
      return;
    }

    if (!drag.dragging) {
      drag.dragging = true;
      drag.row.classList.add("reader-tab-drag-active");
      drag.tab.classList.add("reader-page-tab-dragging");
    }

    event.preventDefault();

    const desiredLeft =
      event.clientX - drag.pointerOffsetX;
    const currentBounds = drag.tab.getBoundingClientRect();
    const layoutLeft =
      currentBounds.left - drag.translateX;

    drag.translateX = desiredLeft - layoutLeft;
    drag.tab.style.transform =
      `translate3d(${drag.translateX}px, 0, 0)`;

    const direction = event.clientX - drag.lastX;
    drag.lastX = event.clientX;

    const tabs = getReaderTabElements(drag.row);
    const currentIndex = tabs.indexOf(drag.tab);
    const draggedCenter =
      desiredLeft + currentBounds.width / 2;

    if (direction > 0 && currentIndex < tabs.length - 1) {
      const nextTab = tabs[currentIndex + 1];
      const nextBounds = nextTab.getBoundingClientRect();

      if (
        draggedCenter >
        nextBounds.left + nextBounds.width * 0.1
      ) {
        animateReaderTabReorder(
          drag.row,
          drag.tab,
          () => {
            drag.row.insertBefore(
              drag.tab,
              nextTab.nextSibling,
            );
          },
        );
      }
    } else if (direction < 0 && currentIndex > 0) {
      const previousTab = tabs[currentIndex - 1];
      const previousBounds =
        previousTab.getBoundingClientRect();

      if (
        draggedCenter <
        previousBounds.right - previousBounds.width * 0.1
      ) {
        animateReaderTabReorder(
          drag.row,
          drag.tab,
          () => {
            drag.row.insertBefore(
              drag.tab,
              previousTab,
            );
          },
        );
      }
    }

    const movedBounds = drag.tab.getBoundingClientRect();
    const movedLayoutLeft =
      movedBounds.left - drag.translateX;

    drag.translateX = desiredLeft - movedLayoutLeft;
    drag.tab.style.transform =
      `translate3d(${drag.translateX}px, 0, 0)`;
  }

  function finishReaderTabDrag(
    event: PointerEvent<HTMLDivElement>,
  ) {
    const drag = readerTabDragRef.current;

    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }

    readerTabDragRef.current = null;

    if (
      event.currentTarget.hasPointerCapture(
        event.pointerId,
      )
    ) {
      event.currentTarget.releasePointerCapture(
        event.pointerId,
      );
    }

    if (!drag.dragging) return;

    const orderedIds = getReaderTabElements(drag.row)
      .map((tab) => tab.dataset.readerTabId)
      .filter((id): id is string => Boolean(id));

    setReaderTabs((tabs) => {
      const tabsById = new Map(
        tabs.map((tab) => [tab.id, tab]),
      );
      const reorderedTabs = orderedIds
        .map((id) => tabsById.get(id))
        .filter(
          (tab): tab is ReaderBrowserTab =>
            Boolean(tab),
        );

      return reorderedTabs.length === tabs.length
        ? reorderedTabs
        : tabs;
    });

    drag.row.classList.remove("reader-tab-drag-active");

    const startingTransform =
      drag.tab.style.transform ||
      "translate3d(0, 0, 0)";

    drag.tab.style.removeProperty("transform");

    const snapAnimation = drag.tab.animate(
      [
        { transform: startingTransform },
        { transform: "translate3d(0, 0, 0)" },
      ],
      {
        duration: 180,
        easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
      },
    );

    const finishSnap = () => {
      drag.tab.classList.remove(
        "reader-page-tab-dragging",
      );
    };

    snapAnimation.onfinish = finishSnap;
    snapAnimation.oncancel = finishSnap;

    readerTabSuppressClickUntilRef.current =
      performance.now() + 180;
  }

  const [editingPaneOrder, setEditingPaneOrder] = useState<EditingPaneId[]>(
    () => readStoredPaneOrder(),
  );
  const [editingPaneWidths, setEditingPaneWidths] =
    useState<EditingPaneWidths>(
      () => readStoredPaneWidths(),
    );
  const [draggedPane, setDraggedPane] = useState<EditingPaneId | null>(null);
  const [paneMenuOpen, setPaneMenuOpen] = useState(false);
  const editorRef = useRef<WikitextEditorHandle>(null);
  const paneMenuRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const draggedPaneRef = useRef<EditingPaneId | null>(null);
  const hasUnpublishedChanges = source !== publishedSource;
  const documentTitle = getWikitextTitle(source);

  useEffect(() => {
    localStorage.setItem("wikitext-studio-draft", source);
  }, [source]);

  useEffect(() => {
    localStorage.setItem(
      "wikitext-studio-editing-pane-order",
      JSON.stringify(editingPaneOrder),
    );
  }, [editingPaneOrder]);

  useEffect(() => {
    localStorage.setItem(
      "wikitext-studio-editing-pane-widths",
      JSON.stringify(editingPaneWidths),
    );
  }, [editingPaneWidths]);

  useEffect(() => {
    if (!activeReaderTab?.target) return;

    const clean = (value: string | null | undefined) =>
      String(value || "")
        .replace(/[☰≡]/g, "")
        .replace(/\s+/g, " ")
        .trim();

    const updateActiveReaderTabTitle = () => {
      const activePanel = document.querySelector<HTMLElement>(
        `[data-reader-tab-panel-id="${activeReaderTabId}"]`,
      );
      if (!activePanel) return;

      const titleSource =
        activePanel.querySelector<HTMLElement>(".reader-page-header h2") ||
        activePanel.querySelector<HTMLElement>(".reader-article h2") ||
        activePanel.querySelector<HTMLElement>(".reader-title-row") ||
        activePanel.querySelector<HTMLElement>(".reader-title-block") ||
        activePanel.querySelector<HTMLElement>(".reader-article h1");

      const title = clean(titleSource?.innerText || titleSource?.textContent).replace(/^Wikipedia Reader[[:space:]]*/, "");
      if (!title) return;

      setReaderTabs((tabs) => {
        let changed = false;

        const nextTabs = tabs.map((tab) => {
          if (tab.id === activeReaderTabId && tab.title !== title) {
            changed = true;

            return {
              ...tab,
              title,
            };
          }

          return tab;
        });

        return changed ? nextTabs : tabs;
      });
    };

    updateActiveReaderTabTitle();

    let titleTimer = 0;
    const observer = new MutationObserver(() => {
      window.clearTimeout(titleTimer);
      titleTimer = window.setTimeout(updateActiveReaderTabTitle, 250);
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    return () => {
      window.clearTimeout(titleTimer);
      observer.disconnect();
    };
  }, [activeReaderTabId, activeReaderTab?.target]);

  useEffect(() => {
  if (!paneMenuOpen) return;

  function handlePointerDown(event: globalThis.PointerEvent) {
    const menu = paneMenuRef.current;
    if (!menu || menu.contains(event.target as Node)) return;
    setPaneMenuOpen(false);
  }

  function handleKeyDown(event: globalThis.KeyboardEvent) {
    if (event.key === "Escape") {
      setPaneMenuOpen(false);
    }
  }

  document.addEventListener("pointerdown", handlePointerDown);
  document.addEventListener("keydown", handleKeyDown);

  return () => {
    document.removeEventListener("pointerdown", handlePointerDown);
    document.removeEventListener("keydown", handleKeyDown);
  };
}, [paneMenuOpen]);

  function runEditorAction(action: EditorAction) {
    editorRef.current?.run(action);
  }

  function startEditingResize(
    event: PointerEvent<HTMLDivElement>,
    dividerIndex: number,
  ) {
    startResize(event, (clientX) => {
      const workspace = workspaceRef.current;
      if (!workspace) return;

      const bounds = workspace.getBoundingClientRect();
      const availableWidth =
        bounds.width - dividerWidth * (editingPaneOrder.length - 1);
      const totalWeight = editingPaneOrder.reduce(
        (total, pane) => total + editingPaneWidths[pane],
        0,
      );
      const minimumWeight = (minimumPaneWidth / availableWidth) * totalWeight;
      const leftPane = editingPaneOrder[dividerIndex];
      const rightPane = editingPaneOrder[dividerIndex + 1];
      const pairWeight =
        editingPaneWidths[leftPane] + editingPaneWidths[rightPane];
      const prefixWeight = editingPaneOrder
        .slice(0, dividerIndex)
        .reduce((total, pane) => total + editingPaneWidths[pane], 0);
      const contentX =
        clientX - bounds.left - dividerWidth * dividerIndex;
      const targetWeight =
        (contentX / availableWidth) * totalWeight - prefixWeight;
      const nextLeftWeight = clamp(
        targetWeight,
        minimumWeight,
        pairWeight - minimumWeight,
      );

      setEditingPaneWidths((widths) => {
        return {
          ...widths,
          [leftPane]: nextLeftWeight,
          [rightPane]: pairWeight - nextLeftWeight,
        };
      });
    });
  }

  function resizeEditingPane(dividerIndex: number, delta: number) {
    const leftPane = editingPaneOrder[dividerIndex];
    const rightPane = editingPaneOrder[dividerIndex + 1];
    setEditingPaneWidths((widths) => {
      const pairWeight = widths[leftPane] + widths[rightPane];
      const nextLeft = clamp(
        widths[leftPane] + delta,
        12,
        pairWeight - 12,
      );
      return {
        ...widths,
        [leftPane]: nextLeft,
        [rightPane]: pairWeight - nextLeft,
      };
    });
  }

  function closeEditingPane(pane: EditingPaneId) {
    setEditingPaneOrder((order) => order.filter((item) => item !== pane));
  }

  function openEditingPane(pane: EditingPaneId) {
    setEditingPaneOrder((order) =>
      order.includes(pane) ? order : [...order, pane],
    );
    setPaneMenuOpen(false);
  }

  function moveEditingPane(
  dragged: EditingPaneId,
  target: EditingPaneId,
  insertAfter: boolean,
) {
  if (dragged === target) return;

  setEditingPaneOrder((order) => {
    const withoutDragged = order.filter((pane) => pane !== dragged);
    const targetIndex = withoutDragged.indexOf(target);
    if (targetIndex < 0) return order;

    const insertIndex = targetIndex + (insertAfter ? 1 : 0);
    const nextOrder = [...withoutDragged];
    nextOrder.splice(insertIndex, 0, dragged);

    return nextOrder.join("|") === order.join("|") ? order : nextOrder;
  });
}

function startPaneReorder(
  event: PointerEvent<HTMLDivElement>,
  pane: EditingPaneId,
) {
  if (event.button !== 0) return;

  const clicked = event.target as HTMLElement;
  if (clicked.closest("button, a, input, textarea, select")) return;

  event.preventDefault();
  draggedPaneRef.current = pane;
  setDraggedPane(pane);
  document.body.classList.add("dragging-pane-tabs");

  function handlePointerMove(moveEvent: globalThis.PointerEvent) {
    const currentDraggedPane = draggedPaneRef.current;
    const workspace = workspaceRef.current;
    if (!currentDraggedPane || !workspace) return;

    const paneElements = [
      ...workspace.querySelectorAll<HTMLElement>("[data-pane-id]"),
    ];

    const targetElement = paneElements.find((element) => {
      const targetPane = element.dataset.paneId as EditingPaneId | undefined;
      if (!targetPane || targetPane === currentDraggedPane) return false;

      const bounds = element.getBoundingClientRect();
      return moveEvent.clientX >= bounds.left && moveEvent.clientX <= bounds.right;
    });

    if (!targetElement) return;

    const targetPane = targetElement.dataset.paneId as EditingPaneId | undefined;
    if (!targetPane || targetPane === currentDraggedPane) return;

    const bounds = targetElement.getBoundingClientRect();
    const insertAfter = moveEvent.clientX > bounds.left + bounds.width / 2;
    moveEditingPane(currentDraggedPane, targetPane, insertAfter);
  }

  function handlePointerUp() {
    draggedPaneRef.current = null;
    setDraggedPane(null);
    document.body.classList.remove("dragging-pane-tabs");
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", handlePointerUp);
    window.removeEventListener("pointercancel", handlePointerUp);
  }

  window.addEventListener("pointermove", handlePointerMove);
  window.addEventListener("pointerup", handlePointerUp);
  window.addEventListener("pointercancel", handlePointerUp);
}

  function renderEditingPane(pane: EditingPaneId) {
    const heading = (
      <PaneTabHeader
        pane={pane}
        detail={
          pane === "editor"
            ? `${source.split("\\n").length} lines`
            : pane === "preview"
              ? "Live"
              : ""
        }
        canClose
        dragging={draggedPane === pane}
        onClose={() => closeEditingPane(pane)}
        onPointerDown={(event) => startPaneReorder(event, pane)}
      />
    );

    if (pane === "editor") {
      return (
        <section className="pane source-pane" data-pane-id={pane}>
          {heading}
          <EditorToolbar onAction={runEditorAction} />
          <WikitextEditor
            ref={editorRef}
            value={source}
            onChange={setSource}
          />
        </section>
      );
    }

    if (pane === "preview") {
      return (
        <section className="pane preview-pane" data-pane-id={pane}>
          {heading}
          <WikitextPreview
            source={source}
            onLinkClick={(topic) => updateReaderTabTarget(activeReaderTabId, { kind: "wiki", topic })}
            onReferenceClick={(reference: ReferenceData) =>
              updateReaderTabTarget(activeReaderTabId, { kind: "reference", reference })
            }
          />
        </section>
      );
    }

    return (
      <aside
        className="pane linked-pane"
        data-pane-id={pane}
      >
        <div
          aria-label="Wikipedia tabs"
          className="reader-pane-tab-row"
          onClickCapture={(event) => {
            const target = event.target;

            if (
              performance.now() <
                readerTabSuppressClickUntilRef.current &&
              target instanceof Element &&
              target.closest(".reader-page-tab") &&
              !target.closest(".pane-tab-actions")
            ) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
          onPointerCancel={finishReaderTabDrag}
          onPointerDown={handleReaderTabPointerDown}
          onPointerMove={handleReaderTabPointerMove}
          onPointerUp={finishReaderTabDrag}
          role="tablist"
        >
          {readerTabs.map((tab) => {
            const active = tab.id === activeReaderTabId;
            return (
              <div
                aria-selected={active}
                className={`pane-heading pane-tab reader-page-tab${
                  active ? " reader-page-tab-active" : ""
                }`}
                data-reader-tab-id={tab.id}
                key={tab.id}
                onClick={() => {
                  activateReaderTab(tab.id);
                }}
                role="tab"
                title={tab.title}
              >
                <span className="pane-tab-title" title={tab.title}>
                  {tab.title}
                </span>
                <div className="pane-tab-actions">
                  <button
                    aria-label={`Close ${tab.title} tab`}
                    onClick={(event) => {
                      event.stopPropagation();
                      closeReaderTab(tab.id);
                    }}
                    title="Close tab"
                    type="button"
                  >
                    ×
                  </button>
                </div>
              </div>
            );
          })}
          <button
            aria-label="New Wikipedia tab"
            className="reader-tab-add-button"
            disabled={readerTabs.length >= MAX_READER_TABS}
            title={readerTabs.length >= MAX_READER_TABS ? "Maximum 20 tabs open" : "New tab"}
            type="button"
            onClick={openNewReaderTab}
          >
            +
          </button>
        </div>

        <div className="reader-toolbar-host" ref={setReaderToolbarHost} />

        <div className="reader-tab-panels">
          {readerTabPanelIds.map((tabId) => {
            const tab = readerTabs.find(
              (candidate) => candidate.id === tabId,
            );

            if (!tab) return null;

            const active = tab.id === activeReaderTabId;

            return (
              <div
                aria-hidden={!active}
                className={`reader-tab-panel${
                  active ? " reader-tab-panel-active" : ""
                }`}
                data-reader-tab-panel-id={tab.id}
                key={tab.id}              >
                <WikipediaReader
                  target={tab.target}
                  onTargetChange={(target) =>
                    updateReaderTabTarget(tab.id, target)
                  }
                  onOpenInNewTab={openReaderTargetInNewTab}                  toolbarHost={readerToolbarHost}                  active={active}
                  toolbarVisible={active}
                  readerToolsVisible={readerToolsVisible}
                  onToggleReaderTools={toggleReaderTools}
                />
              </div>
            );
          })}
        </div>

      </aside>
    );
  }

  function openReaderFindFromToolbar() {
    const event = new globalThis.KeyboardEvent("keydown", {
      key: "f",
      code: "KeyF",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });

    document.dispatchEvent(event);
  }

  function changeReaderArticleWidth(delta: number) {
    setReaderArticleWidthPercent((currentPercent) => {
      const nextPercent = Math.round((currentPercent + delta) / 5) * 5;
      return Math.min(
        READER_ARTICLE_WIDTH_MAX_PERCENT,
        Math.max(READER_ARTICLE_WIDTH_MIN_PERCENT, nextPercent),
      );
    });
  }

  function resetReaderArticleWidth() {
    setReaderArticleWidthPercent(100);
  }

  function setReaderArticleFullWidth() {
    const content =
      document.querySelector(".linked-pane[data-pane-id='research'] .reader-tab-panel-active .browser-content") ||
      document.querySelector(".linked-pane[data-pane-id='research'] .browser-content");

    const contentWidth = content
      ? Math.round(content.getBoundingClientRect().width)
      : window.innerWidth;

    const nextArticleWidth = Math.max(READER_ARTICLE_BASE_WIDTH, contentWidth - READER_ARTICLE_SIDE_PADDING);
    const nextPercent = Math.round((nextArticleWidth / READER_ARTICLE_BASE_WIDTH) * 100 / 5) * 5;

    setReaderArticleWidthPercent(
      Math.min(
        READER_ARTICLE_WIDTH_MAX_PERCENT,
        Math.max(100, nextPercent),
      ),
    );
  }


  useEffect(() => {
    let animationFrame = 0;

    const syncReaderHeaderWidth = () => {
      const activePanel = document.querySelector<HTMLElement>(
        ".linked-pane[data-pane-id='research'] .reader-tab-panel-active",
      );
      const researchPane = document.querySelector<HTMLElement>(
        ".linked-pane[data-pane-id='research']",
      );
      const scope = activePanel || researchPane;

      const article = scope?.querySelector(".reader-article");
      const header = scope?.querySelector(".reader-page-header");
      const titleRow = scope?.querySelector(".reader-title-row");
      const titleBlock = scope?.querySelector(".reader-title-block");

      if (!(article instanceof HTMLElement)) return;
      if (!(header instanceof HTMLElement)) return;
      if (!(titleRow instanceof HTMLElement)) return;
      if (!(titleBlock instanceof HTMLElement)) return;

      const articleWidth = Math.round(article.getBoundingClientRect().width);
      if (articleWidth <= 0) return;

      header.style.setProperty("width", `${articleWidth}px`, "important");
      header.style.setProperty("max-width", `${articleWidth}px`, "important");
      header.style.setProperty("margin-left", "auto", "important");
      header.style.setProperty("margin-right", "auto", "important");
      header.style.setProperty("box-sizing", "border-box", "important");

      titleRow.style.setProperty("width", "100%", "important");
      titleRow.style.setProperty("max-width", "100%", "important");
      titleRow.style.setProperty("margin-left", "0", "important");
      titleRow.style.setProperty("margin-right", "0", "important");
      titleRow.style.setProperty("transform", "none", "important");
      titleRow.style.setProperty("box-sizing", "border-box", "important");

      titleBlock.style.setProperty("width", "100%", "important");
      titleBlock.style.setProperty("max-width", "100%", "important");
      titleBlock.style.setProperty("margin-left", "0", "important");
      titleBlock.style.setProperty("margin-right", "0", "important");
      titleBlock.style.setProperty("transform", "none", "important");
      titleBlock.style.setProperty("box-sizing", "border-box", "important");
    };

    const scheduleSync = () => {
      window.cancelAnimationFrame(animationFrame);
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = window.requestAnimationFrame(syncReaderHeaderWidth);
      });
    };

    const root = document.querySelector(".linked-pane[data-pane-id='research']") || document.body;
    const observer = new MutationObserver(scheduleSync);

    observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "style"],
    });

    window.addEventListener("resize", scheduleSync);
    scheduleSync();

    return () => {
      window.cancelAnimationFrame(animationFrame);
      observer.disconnect();
      window.removeEventListener("resize", scheduleSync);
    };
  }, [readerArticleWidthPercent]);


  return (
    <main
      className={readerToolsVisible ? "app-shell" : "app-shell app-reader-tools-collapsed"}
      style={{
        "--reader-content-zoom": readerContentZoom,
        "--reader-article-width": `${readerArticleWidthPx}px`,
        "--reader-parser-width": `${readerParserWidthPx}px`,
      } as CSSProperties}
    >
      <header className="app-header">
        <div
          className="reader-window-masthead"
          data-tauri-drag-region
        >
          Wiki-Reader
        </div>
        <div className="app-top-toolbar" aria-label="Reader tools">
          <button
            aria-label="Find on page"
            className="app-toolbar-button app-find-button"
            title="Find on page"
            type="button"
            onClick={openReaderFindFromToolbar}
          >
            Find
          </button>

          <div className="app-zoom-control" aria-label="Reader zoom controls">
            <button
              aria-label="Zoom in"
              className="app-zoom-button app-zoom-plus"
              title="Zoom in"
              type="button"
              onClick={() => changeReaderContentZoom(0.05)}
            >
              <div className="app-zoom-symbol">+</div>
            </button>

            <div className="app-zoom-label" aria-hidden="true">Zoom</div>

            <button
              aria-label="Zoom out"
              className="app-zoom-button app-zoom-minus"
              title="Zoom out"
              type="button"
              onClick={() => changeReaderContentZoom(-0.05)}
            >
              <div className="app-zoom-symbol">−</div>
            </button>
          </div>

          <ReaderWidthControl
            articleWidthPercent={readerArticleWidthPercent}
            onDecrease={() => changeReaderArticleWidth(-5)}
            onIncrease={() => changeReaderArticleWidth(5)}
            onDefault={resetReaderArticleWidth}
            onFullWidth={setReaderArticleFullWidth}
          />
        </div>


        <div className="document-name">
          <span className="app-mark" aria-hidden="true">W</span>
          <div>
            <strong>{documentTitle}</strong>
            <span>
              <i className="status-dot" />
              {hasUnpublishedChanges ? "Autosaved · Unpublished" : "Published"}
            </span>
          </div>
        </div>

        <div className="workspace-label">Workspace</div>

        <div className="header-actions">
          <div className="pane-menu" ref={paneMenuRef}>
              <button
                className="add-pane-button"
                type="button"
                aria-expanded={paneMenuOpen}
                aria-label="New tab"
                title="New tab"
                onClick={() => setPaneMenuOpen((open) => !open)}
              >
                +
              </button>
              {paneMenuOpen && (
                <div className="pane-menu-popover">
                  <span>New tab</span>
                  {allEditingPanes.map((pane) => (
                    <button
                      type="button"
                      disabled={editingPaneOrder.includes(pane)}
                      key={pane}
                      onClick={() => openEditingPane(pane)}
                    >
                      <span>
                        <strong>{editingPaneLabels[pane]}</strong>
                        <small>{editingPaneDescriptions[pane]}</small>
                      </span>
                      {editingPaneOrder.includes(pane) && <small>Open</small>}
                    </button>
                  ))}
                </div>
              )}
          </div>
          <button
            className="publish-button"
            type="button"
            disabled={!hasUnpublishedChanges}
            onClick={() => setPublishedSource(source)}
          >
            {hasUnpublishedChanges ? "Publish" : "Published"}
          </button>
        </div>
      </header>

      <section
        className="workspace"
        ref={workspaceRef}
        style={
          {
            gridTemplateColumns: editingPaneOrder
              .flatMap((pane, index) => [
                `${editingPaneWidths[pane]}fr`,
                ...(index < editingPaneOrder.length - 1
                  ? [`${dividerWidth}px`]
                  : []),
              ])
              .join(" "),
          } as CSSProperties
        }
      >
        {editingPaneOrder.length > 0 ? (
          editingPaneOrder.map((pane, index) => (
            <Fragment key={pane}>
              {index > 0 && (
                <PaneDivider
                  label={`Resize ${editingPaneLabels[editingPaneOrder[index - 1]]} and ${editingPaneLabels[pane]} tabs`}
                  onKeyboard={(delta) => resizeEditingPane(index - 1, delta)}
                  onPointerDown={(event) =>
                    startEditingResize(event, index - 1)
                  }
                />
              )}
              {renderEditingPane(pane)}
            </Fragment>
          ))
        ) : (
          <div className="empty-tabs">
            <span aria-hidden="true">▣</span>
            <strong>No tabs open</strong>
            <p>
              Use the + button above to open a Wikipedia Reader tab.
            </p>
            <button type="button" onClick={() => setPaneMenuOpen(true)}>
              Open a tab
            </button>
          </div>
        )}
      </section>

      {attributionOpen && (
        <div
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) setAttributionOpen(false);
          }}
          style={{
            position: "fixed", inset: 0, zIndex: 999999, display: "grid",
            placeItems: "center", padding: 24, background: "rgba(0,0,0,.62)",
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="attribution-title"
            style={{
              position: "relative", width: "min(620px, 100%)",
              maxHeight: "90vh", overflow: "auto", padding: "28px 30px 30px",
              color: "#e8edf1", background: "#171d21", border: "1px solid #64727d",
              borderRadius: 10, boxShadow: "0 20px 60px rgba(0,0,0,.55)",
              lineHeight: 1.55,
            }}
          >
            <button
              type="button"
              aria-label="Close attribution"
              onClick={() => setAttributionOpen(false)}
              style={{ position: "absolute", top: 12, right: 14, color: "#dce5eb", background: "transparent", border: 0, fontSize: 22, cursor: "pointer" }}
            >×</button>
            <h2 id="attribution-title">Wikipedia {"&"} Wikimedia Attribution</h2>
            <p>Wiki-Reader is an independent, unofficial reader for Wikipedia and Wikimedia Commons. It is not affiliated with or endorsed by the Wikimedia Foundation.</p>
            <p>Wikipedia text is generally available under the <a href="https://creativecommons.org/licenses/by-sa/4.0/" target="_blank" rel="noreferrer" style={{ color: "#64a8ff" }}>Creative Commons Attribution-ShareAlike 4.0 International License</a> and the <a href="https://www.gnu.org/licenses/fdl-1.3.html" target="_blank" rel="noreferrer" style={{ color: "#64a8ff" }}>GNU Free Documentation License</a>. Images and other media may have separate licenses; see each file page for its author and license information.</p>
            <p>“Wikipedia” and Wikimedia names, logos, and marks belong to the Wikimedia Foundation. They are used here to identify the source of content. No endorsement or affiliation is implied.</p>
            <p><a href="https://donate.wikimedia.org/" target="_blank" rel="noreferrer" style={{ color: "#64a8ff" }}><strong>Donate to Wikipedia and Wikimedia projects</strong></a></p>
          </section>
        </div>
      )}

      <footer className="footer">
        <span>{documentTitle.toLowerCase().replace(/\W+/g, "-")}.wiki</span>
        <span>{source.length} characters</span>
        <span className="footer-spacer" />
        <span>Wikipedia Reader prototype</span>
      </footer>
    </main>
  );
}

function EditorToolbar({
  onAction,
}: {
  onAction: (action: EditorAction) => void;
}) {
  return (
    <div className="editor-toolbar" aria-label="Wikitext editing tools">
      <div className="tool-group">
        <ToolButton label="Undo" onClick={() => onAction("undo")}>↶</ToolButton>
        <ToolButton label="Redo" onClick={() => onAction("redo")}>↷</ToolButton>
      </div>
      <div className="tool-group">
        <ToolButton label="Bold" onClick={() => onAction("bold")}>
          <strong>B</strong>
        </ToolButton>
        <ToolButton label="Italic" onClick={() => onAction("italic")}>
          <em>I</em>
        </ToolButton>
        <ToolButton label="Wiki link" onClick={() => onAction("link")}>
          Link
        </ToolButton>
        <ToolButton label="Section heading" onClick={() => onAction("heading")}>
          Heading
        </ToolButton>
        <ToolButton label="Reference citation" onClick={() => onAction("reference")}>
          Cite
        </ToolButton>
      </div>
    </div>
  );
}

function ToolButton({
  children,
  label,
  onClick,
}: {
  children: ReactNode;
  label: string;
  onClick?: () => void;
}) {
  return (
    <button
      className="tool-button"
      type="button"
      title={label}
      aria-label={label}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function PaneTabHeader({
  canClose,
  detail,
  dragging,
  onClose,
  onPointerDown,
  pane,
}: {
  canClose: boolean;
  detail: string;
  dragging: boolean;
  onClose: () => void;
  onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  pane: EditingPaneId;
}) {
  return (
    <div
      className={`pane-heading pane-tab ${dragging ? "dragging" : ""}`}
      title="Drag to move this pane"
      onPointerDown={onPointerDown}
    >
      <div className="pane-tab-title">
        <span className="pane-drag-handle" aria-hidden="true">⠿</span>
        <span>{editingPaneLabels[pane]}</span>
      </div>
      <div className="pane-tab-actions">
        {detail && <small>{detail}</small>}
        <button
          type="button"
          aria-label={`Close ${editingPaneLabels[pane]} pane`}
          disabled={!canClose}
          draggable={false}
          onClick={onClose}
          onMouseDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          ×
        </button>
      </div>
    </div>
  );
}

function PaneDivider({
  label,
  onKeyboard,
  onPointerDown,
}: {
  label: string;
  onKeyboard: (delta: number) => void;
  onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
}) {
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    onKeyboard(event.key === "ArrowLeft" ? -2 : 2);
  }

  return (
    <div
      className="pane-divider"
      role="separator"
      aria-label={label}
      aria-orientation="vertical"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onPointerDown={onPointerDown}
    >
      <span />
    </div>
  );
}

function startResize(
  event: PointerEvent<HTMLDivElement>,
  onMove: (clientX: number) => void,
) {
  event.preventDefault();
  event.currentTarget.setPointerCapture(event.pointerId);
  document.body.classList.add("resizing-panes");

  function handlePointerMove(moveEvent: globalThis.PointerEvent) {
    onMove(moveEvent.clientX);
  }

  function handlePointerUp() {
    document.body.classList.remove("resizing-panes");
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", handlePointerUp);
    window.removeEventListener("pointercancel", handlePointerUp);
  }

  window.addEventListener("pointermove", handlePointerMove);
  window.addEventListener("pointerup", handlePointerUp);
  window.addEventListener("pointercancel", handlePointerUp);
}

function readStoredPaneOrder(): EditingPaneId[] {
  try {
    const parsed = JSON.parse(
      localStorage.getItem("wikitext-studio-editing-pane-order") || "",
    );
    if (
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every((value) => allEditingPanes.includes(value))
    ) {
      return [...new Set(parsed)] as EditingPaneId[];
    }
  } catch {
    // Ignore invalid saved layout data.
  }
  return [...allEditingPanes];
}

function readStoredPaneWidths(): EditingPaneWidths {
  const fallback: EditingPaneWidths = {
    editor: 39,
    preview: 34,
    research: 27,
  };

  try {
    const parsed = JSON.parse(
      localStorage.getItem("wikitext-studio-editing-pane-widths") || "",
    ) as Partial<EditingPaneWidths>;
    if (
      allEditingPanes.every(
        (pane) => typeof parsed[pane] === "number" && parsed[pane]! > 0,
      )
    ) {
      return parsed as EditingPaneWidths;
    }

    const legacy = JSON.parse(
      localStorage.getItem("wikitext-studio-editing-panes") || "",
    );
    if (
      Array.isArray(legacy) &&
      legacy.length === 3 &&
      legacy.every((value) => typeof value === "number" && value > 0)
    ) {
      return {
        editor: legacy[0],
        preview: legacy[1],
        research: legacy[2],
      };
    }
  } catch {
    // Ignore invalid saved layout data.
  }

  return fallback;
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum);
}

export default App;
