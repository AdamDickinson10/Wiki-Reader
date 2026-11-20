import { useCallback, memo, useEffect, useLayoutEffect, useMemo, useState, type FormEvent, type KeyboardEvent, type MouseEvent, type PointerEvent as ReactPointerEvent, type CSSProperties, useRef } from 'react';
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { openUrl as openExternalUrl } from "@tauri-apps/plugin-opener";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import wikiReaderLogo from "./assets/wiki-reader-logo.svg";

type ReaderVoiceRecognitionAlternative = {
  transcript?: string;
  confidence?: number;
};

type ReaderVoiceRecognitionResult = {
  isFinal: boolean;
  [index: number]: ReaderVoiceRecognitionAlternative | undefined;
};

type ReaderVoiceRecognitionEvent = {
  results: ArrayLike<ReaderVoiceRecognitionResult>;
};

type ReaderVoiceRecognitionErrorEvent = {
  error?: string;
  message?: string;
};

type ReaderVoiceRecognitionInstance = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onstart: (() => void) | null;
  onspeechstart?: (() => void) | null;
  onspeechend?: (() => void) | null;
  onresult: ((event: ReaderVoiceRecognitionEvent) => void) | null;
  onerror: ((event: ReaderVoiceRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type ReaderVoiceRecognitionConstructor = new () => ReaderVoiceRecognitionInstance;

const readerWikimediaMapLoads = new WeakSet<HTMLImageElement>();

async function hydrateReaderWikimediaMapImage(image: HTMLImageElement) {
  const source = image.getAttribute("src") || image.currentSrc || image.src || "";

  if (!/^https?:\/\/maps\.wikimedia\.org\/img\/osm/i.test(source)) return;
  if (readerWikimediaMapLoads.has(image)) return;

  readerWikimediaMapLoads.add(image);

  try {
    const dataUrl = await invoke<string>("fetch_wikimedia_map_image", { url: source });

    if (image.isConnected && image.getAttribute("src") === source) {
      image.src = dataUrl;
    }
  } catch {
    readerWikimediaMapLoads.delete(image);
  }
}

function getReaderVoiceRecognitionConstructor(): ReaderVoiceRecognitionConstructor | null {
  const speechWindow = window as typeof window & {
    SpeechRecognition?: ReaderVoiceRecognitionConstructor;
    webkitSpeechRecognition?: ReaderVoiceRecognitionConstructor;
  };

  return speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition || null;
}

type ReaderSharedVoiceSession = {
  input: HTMLInputElement;
  button: HTMLButtonElement;
  recognition: ReaderVoiceRecognitionInstance;
  firstHeardAt: number | null;
  lastHeardAt: number;
  lastHeard: string;
  lastCommitted: string;
};

let readerSharedVoiceSession: ReaderSharedVoiceSession | null = null;
let readerSharedVoiceRefreshTimer: ReturnType<typeof window.setInterval> | null = null;
let readerSharedVoicePermissionPending = false;

function normalizeReaderVoiceQuery(value: string) {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.?!…]+$/u, "")
    .trim();
}

function setReaderSharedVoiceButtonState(
  button: HTMLButtonElement,
  listening: boolean,
) {
  button.classList.toggle("reader-voice-listening", listening);
  button.classList.remove("reader-voice-stopping");
  button.title = listening ? "Stop voice search" : "Voice search";
  button.setAttribute(
    "aria-label",
    listening ? "Stop voice search" : "Voice search",
  );
  button.setAttribute("aria-pressed", listening ? "true" : "false");
}

function setReaderSharedVoiceInputValue(
  input: HTMLInputElement,
  value: string,
  commit: boolean,
) {
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )?.set;

  if (nativeSetter) {
    nativeSetter.call(input, value);
  } else {
    input.value = value;
  }

  if (!commit) return;

  input.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      cancelable: true,
      inputType: "insertText",
      data: value,
    }),
  );

  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function commitReaderSharedVoiceQuery() {
  const session = readerSharedVoiceSession;
  if (!session) return;

  const query = normalizeReaderVoiceQuery(session.lastHeard);
  if (!query || query === session.lastCommitted) return;

  session.lastCommitted = query;
  setReaderSharedVoiceInputValue(session.input, query, true);
}

function removeReaderSharedVoiceListeners() {
  document.removeEventListener(
    "pointerdown",
    handleReaderSharedVoiceSuggestionPointerDown,
    true,
  );
  document.removeEventListener("keydown", handleReaderSharedVoiceEnter, true);
}

function stopReaderSharedVoiceSearch(commitQuery: boolean) {
  const session = readerSharedVoiceSession;
  if (!session) return;

  if (commitQuery) {
    commitReaderSharedVoiceQuery();
  }

  readerSharedVoiceSession = null;

  if (readerSharedVoiceRefreshTimer !== null) {
    window.clearInterval(readerSharedVoiceRefreshTimer);
    readerSharedVoiceRefreshTimer = null;
  }

  removeReaderSharedVoiceListeners();
  setReaderSharedVoiceButtonState(session.button, false);

  try {
    session.recognition.stop();
  } catch {
    // The recognizer may already be stopped.
  }
}

function handleReaderSharedVoiceSuggestionPointerDown(event: PointerEvent) {
  const session = readerSharedVoiceSession;
  const target = event.target;

  if (!(target instanceof Element) || !session) return;

  const button = target.closest<HTMLButtonElement>(".search-suggestions button");
  if (!button || !button.isConnected) return;

  event.preventDefault();
  event.stopImmediatePropagation();

  stopReaderSharedVoiceSearch(false);
  window.setTimeout(() => button.click(), 0);
}

function handleReaderSharedVoiceEnter(event: globalThis.KeyboardEvent) {
  const session = readerSharedVoiceSession;
  if (!session || event.key !== "Enter" || event.target !== session.input) return;

  event.preventDefault();
  event.stopImmediatePropagation();

  const form = session.input.form;
  stopReaderSharedVoiceSearch(true);

  window.setTimeout(() => {
    form?.requestSubmit();
  }, 50);
}

async function startReaderVoiceSearchForControls(
  input: HTMLInputElement,
  button: HTMLButtonElement,
) {
  if (readerSharedVoiceSession) {
    stopReaderSharedVoiceSearch(true);
    return;
  }

  const SpeechRecognition = getReaderVoiceRecognitionConstructor();
  if (!SpeechRecognition) {
    console.warn("Speech recognition is not available in this WebView.");
    return;
  }

  if (readerSharedVoicePermissionPending) return;

  readerSharedVoicePermissionPending = true;
  button.disabled = true;
  button.classList.add("reader-voice-permission-pending");

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
  } catch (error) {
    console.error("Microphone permission failed:", error);
    readerSharedVoicePermissionPending = false;
    button.disabled = false;
    button.classList.remove("reader-voice-permission-pending");
    return;
  }

  readerSharedVoicePermissionPending = false;
  button.disabled = false;
  button.classList.remove("reader-voice-permission-pending");

  const recognition = new SpeechRecognition();
  recognition.lang = "en-US";
  recognition.interimResults = true;
  recognition.continuous = true;

  const now = Date.now();
  const session: ReaderSharedVoiceSession = {
    input,
    button,
    recognition,
    firstHeardAt: null,
    lastHeardAt: now,
    lastHeard: "",
    lastCommitted: normalizeReaderVoiceQuery(input.value),
  };

  readerSharedVoiceSession = session;
  input.focus();
  setReaderSharedVoiceButtonState(button, true);

  document.addEventListener(
    "pointerdown",
    handleReaderSharedVoiceSuggestionPointerDown,
    true,
  );
  document.addEventListener("keydown", handleReaderSharedVoiceEnter, true);

  recognition.onresult = (recognitionEvent) => {
    if (readerSharedVoiceSession !== session) return;

    let transcript = "";

    for (let index = 0; index < recognitionEvent.results.length; index += 1) {
      transcript += recognitionEvent.results[index]?.[0]?.transcript || "";
    }

    const query = normalizeReaderVoiceQuery(transcript);
    if (!query) return;

    const heardAt = Date.now();
    session.firstHeardAt ??= heardAt;
    session.lastHeardAt = heardAt;
    session.lastHeard = query;

    setReaderSharedVoiceInputValue(input, query, false);
  };

  recognition.onerror = () => {
    if (readerSharedVoiceSession === session) {
      stopReaderSharedVoiceSearch(true);
    }
  };

  recognition.onend = () => {
    if (readerSharedVoiceSession !== session) return;

    if (Date.now() - session.lastHeardAt >= 3000) {
      stopReaderSharedVoiceSearch(true);
      return;
    }

    try {
      recognition.start();
    } catch {
      stopReaderSharedVoiceSearch(true);
    }
  };

  readerSharedVoiceRefreshTimer = window.setInterval(() => {
    if (readerSharedVoiceSession !== session) return;

    const now = Date.now();

    if (now - session.lastHeardAt >= 3000) {
      stopReaderSharedVoiceSearch(true);
      return;
    }

    if (
      session.firstHeardAt !== null &&
      now - session.firstHeardAt >= 2000 &&
      session.lastHeard !== session.lastCommitted
    ) {
      commitReaderSharedVoiceQuery();
    }
  }, 1000);

  try {
    recognition.start();
  } catch (error) {
    console.error("Voice search start failed:", error);
    stopReaderSharedVoiceSearch(false);
  }
}

function startReaderVoiceSearch() {
  const input = Array.from(
    document.querySelectorAll<HTMLInputElement>(
      ".wiki-search-form input[aria-label=\"Search Wikipedia\"], .wiki-search-form input[placeholder=\"Search Wikipedia\"]",
    ),
  ).find((element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });

  const button = Array.from(
    document.querySelectorAll<HTMLButtonElement>(".reader-search-voice-button"),
  ).find((element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });

  if (input && button) {
    startReaderVoiceSearchForControls(input, button);
  }
}

function startReaderLandingVoiceSearch() {
  const input = document.querySelector<HTMLInputElement>(
    ".wiki-landing-search input",
  );
  const button = document.querySelector<HTMLButtonElement>(
    ".reader-launch-voice-button",
  );

  if (input && button) {
    startReaderVoiceSearchForControls(input, button);
  }
}

async function openReaderExternalUrl(url: string) {
  try {
    await openExternalUrl(url);
  } catch {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

import type { ReferenceData } from "./WikitextPreview";


const READER_OSM_OBJECT_CACHE_KEY = "wikitext-studio:osm-object-url:v1";
const READER_OSM_OBJECT_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface ReaderOsmObjectCacheEntry {
  url: string;
  savedAt: number;
}

type ReaderOsmObjectCache = Record<string, ReaderOsmObjectCacheEntry>;

function readReaderOsmObjectCache(): ReaderOsmObjectCache {
  if (typeof window === "undefined") return {};

  try {
    const raw = window.localStorage.getItem(READER_OSM_OBJECT_CACHE_KEY);
    if (!raw) return {};

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const now = Date.now();
    const cache: ReaderOsmObjectCache = {};
    let changed = false;

    Object.entries(parsed).forEach(([key, value]) => {
      if (
        typeof value !== "object" ||
        value === null ||
        !("url" in value) ||
        !("savedAt" in value)
      ) {
        changed = true;
        return;
      }

      const entry = value as { url?: unknown; savedAt?: unknown };

      if (typeof entry.url !== "string" || typeof entry.savedAt !== "number") {
        changed = true;
        return;
      }

      if (now - entry.savedAt > READER_OSM_OBJECT_CACHE_TTL_MS) {
        changed = true;
        return;
      }

      cache[key] = {
        url: entry.url,
        savedAt: entry.savedAt,
      };
    });

    if (changed) writeReaderOsmObjectCache(cache);

    return cache;
  } catch {
    return {};
  }
}

function writeReaderOsmObjectCache(cache: ReaderOsmObjectCache) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(READER_OSM_OBJECT_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // Boundary lookup is nice-to-have, so ignore storage failures.
  }
}

async function openReaderOpenStreetMapTarget(target: HTMLElement) {
  const fallbackUrl = target.dataset.openstreetmapUrl;
  if (!fallbackUrl) return;

  const pageTitle =
    target.dataset.openstreetmapPageTitle ||
    target.closest<HTMLElement>("[data-openstreetmap-page-title]")?.dataset
      .openstreetmapPageTitle ||
    "";

  if (!pageTitle) {
    await openReaderExternalUrl(fallbackUrl);
    return;
  }

  const objectUrl = await getReaderOpenStreetMapObjectUrl(pageTitle, fallbackUrl);
  await openReaderExternalUrl(objectUrl);
}

async function getReaderOpenStreetMapObjectUrl(
  pageTitle: string,
  fallbackUrl: string,
) {
  const cacheKey = readerWikiTargetKey(pageTitle);
  const cache = readReaderOsmObjectCache();
  const cached = cache[cacheKey];

  if (cached) {
    return cached.url;
  }

  const wikidataUrl = await loadWikidataOpenStreetMapObjectUrl(pageTitle);
  const nominatimUrl = wikidataUrl
    ? null
    : await loadNominatimOpenStreetMapObjectUrl(pageTitle);

  const objectUrl = wikidataUrl || nominatimUrl || fallbackUrl;

  cache[cacheKey] = {
    url: objectUrl,
    savedAt: Date.now(),
  };

  writeReaderOsmObjectCache(cache);

  return objectUrl;
}

async function loadWikidataOpenStreetMapObjectUrl(pageTitle: string) {
  try {
    const wikipediaUrl = new URL("https://en.wikipedia.org/w/api.php");
    wikipediaUrl.searchParams.set("origin", "*");
    wikipediaUrl.searchParams.set("action", "query");
    wikipediaUrl.searchParams.set("format", "json");
    wikipediaUrl.searchParams.set("formatversion", "2");
    wikipediaUrl.searchParams.set("redirects", "1");
    wikipediaUrl.searchParams.set("prop", "pageprops");
    wikipediaUrl.searchParams.set("titles", pageTitle);

    const wikipediaResponse = await wikipediaApiFetch(
      wikipediaUrl.toString(),
    );
    if (!wikipediaResponse.ok) return null;

    const wikipediaData = (await wikipediaResponse.json()) as {
      query?: {
        pages?: Array<{
          pageprops?: {
            wikibase_item?: string;
          };
        }>;
      };
    };

    const wikidataId = wikipediaData.query?.pages?.[0]?.pageprops?.wikibase_item;
    if (!wikidataId || !/^Q\d+$/.test(wikidataId)) return null;

    const wikidataUrl = new URL("https://www.wikidata.org/w/api.php");
    wikidataUrl.searchParams.set("origin", "*");
    wikidataUrl.searchParams.set("action", "wbgetentities");
    wikidataUrl.searchParams.set("ids", wikidataId);
    wikidataUrl.searchParams.set("props", "claims");
    wikidataUrl.searchParams.set("format", "json");

    const wikidataResponse = await fetch(wikidataUrl.toString());
    if (!wikidataResponse.ok) return null;

    const wikidataData = (await wikidataResponse.json()) as {
      entities?: Record<
        string,
        {
          claims?: {
            P402?: Array<{
              mainsnak?: {
                datavalue?: {
                  value?: unknown;
                };
              };
            }>;
          };
        }
      >;
    };

    const relationId = wikidataData.entities?.[wikidataId]?.claims?.P402?.map(
      (claim) => claim.mainsnak?.datavalue?.value,
    ).find((value): value is string => {
      return typeof value === "string" && /^\d+$/.test(value);
    });

    if (!relationId) return null;

    return `https://www.openstreetmap.org/relation/${encodeURIComponent(relationId)}`;
  } catch {
    return null;
  }
}

interface ReaderNominatimResult {
  osm_type?: string;
  osm_id?: number;
  class?: string;
  type?: string;
}

async function loadNominatimOpenStreetMapObjectUrl(pageTitle: string) {
  try {
    const url = new URL("https://nominatim.openstreetmap.org/search");
    url.searchParams.set("format", "jsonv2");
    url.searchParams.set("limit", "5");
    url.searchParams.set("q", pageTitle);

    const response = await fetch(url.toString(), {
      headers: {
        Accept: "application/json",
      },
    });

    if (!response.ok) return null;

    const results = (await response.json()) as ReaderNominatimResult[];

    const result = results.find((item) => {
      const osmType = item.osm_type?.toLowerCase();

      return (
        (osmType === "relation" || osmType === "way") &&
        typeof item.osm_id === "number" &&
        Number.isFinite(item.osm_id)
      );
    });

    if (!result || !result.osm_type || !result.osm_id) return null;

    const osmType = result.osm_type.toLowerCase();

    return `https://www.openstreetmap.org/${osmType}/${result.osm_id}`;
  } catch {
    return null;
  }
}


export type ReaderTarget =
  | { kind: "wiki"; topic: string }
  | { kind: "search"; query: string }
  | { kind: "reference"; reference: ReferenceData };


const READER_VISITED_LINKS_STORAGE_KEY = "wikitext-studio:visited-wiki-links:v1";
const READER_VISITED_LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000;

type ReaderVisitedLinks = Record<string, number>;

function readerWikiTargetKey(topic: string) {
  return topic
    .replace(/^:/, "")
    .replace(/#.*$/, "")
    .replace(/_/g, " ")
    .trim()
    .toLowerCase();
}

function writeReaderVisitedLinks(visited: ReaderVisitedLinks) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(
      READER_VISITED_LINKS_STORAGE_KEY,
      JSON.stringify(visited),
    );
  } catch {
    // Visited-link coloring is nice-to-have, so ignore storage failures.
  }
}

function readReaderVisitedLinks(): ReaderVisitedLinks {
  if (typeof window === "undefined") return {};

  try {
    const raw = window.localStorage.getItem(READER_VISITED_LINKS_STORAGE_KEY);
    if (!raw) return {};

    const now = Date.now();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const visited: ReaderVisitedLinks = {};
    let changed = false;

    Object.entries(parsed).forEach(([key, value]) => {
      if (typeof value !== "number") {
        changed = true;
        return;
      }

      if (now - value > READER_VISITED_LINK_TTL_MS) {
        changed = true;
        return;
      }

      visited[key] = value;
    });

    if (changed) writeReaderVisitedLinks(visited);

    return visited;
  } catch {
    return {};
  }
}

function markReaderWikiTargetVisited(topic: string) {
  const key = readerWikiTargetKey(topic);
  if (!key) return;

  const visited = readReaderVisitedLinks();
  visited[key] = Date.now();
  writeReaderVisitedLinks(visited);
}

function markReaderVisitedWikiLinks(root: Document | HTMLElement) {
  const visited = readReaderVisitedLinks();

  root
    .querySelectorAll<HTMLAnchorElement>("a[data-wiki-target]")
    .forEach((link) => {
      const topic = link.dataset.wikiTarget;
      if (!topic) return;

      if (visited[readerWikiTargetKey(topic)] !== undefined) {
        link.classList.add("reader-visited-link");
      } else {
        link.classList.remove("reader-visited-link");
      }
    });
}


interface WikipediaReaderProps {
  target: ReaderTarget | null;
  onTargetChange: (target: ReaderTarget) => void;
  onOpenInNewTab: (target: ReaderTarget) => void;  toolbarHost?: HTMLElement | null;
  active?: boolean;
  toolbarVisible?: boolean;
  toolbarPane?: "left" | "right";
  readerToolsVisible?: boolean;
  onToggleReaderTools?: () => void;
}

interface ReaderArticle {
  title: string;
  html: string;
  url: string;
  sections: ReaderSection[];
}

const READER_ARTICLE_CACHE_MAX_SIZE = 20;
const readerArticleCache = new Map<string, ReaderArticle>();
const readerArticleHotCache = new Map<string, ReaderArticle>();
const readerArticleImageCache = new Map<string, Map<string, HTMLImageElement>>();

function readerArticleCacheKey(topic: string) {
  const { page } = splitWikipediaTopicFragment(topic);
  // Wikipedia title matching is case-insensitive only for the first letter.
  // Preserve the remaining capitalization so Tex/TeX and Latex/LaTeX do not
  // reuse each other's cached article HTML.
  return `wiki:${normalizeWikipediaSearchQuery(page)}`;
}

function readReaderArticleCache(topic: string) {
  const key = readerArticleCacheKey(topic);
  const cached = readerArticleCache.get(key);

  if (!cached) return null;

  readerArticleCache.delete(key);
  readerArticleCache.set(key, cached);
  return cached;
}

function readReaderArticleHotCache(topic: string) {
  return readerArticleHotCache.get(readerArticleCacheKey(topic)) || null;
}

function writeReaderArticleCache(topic: string, article: ReaderArticle) {
  const key = readerArticleCacheKey(topic);

  readerArticleCache.delete(key);
  readerArticleCache.set(key, article);

  const imageDocument = new DOMParser().parseFromString(article.html, "text/html");
  const imageSources = new Set<string>();

  imageDocument.querySelectorAll<HTMLImageElement>("img").forEach((image) => {
    const deferredSource = image.dataset.readerDeferredSrc;
    const source = deferredSource || image.getAttribute("src") || "";
    const normalizedSource = source.startsWith("//") ? `https:${source}` : source;

    if (!/^https?:\/\//i.test(normalizedSource)) return;

    imageSources.add(normalizedSource);
    image.src = normalizedSource;
    image.loading = "eager";
    image.removeAttribute("data-reader-deferred-src");
  });

  readerArticleHotCache.set(key, {
    ...article,
    html: imageDocument.body.innerHTML,
  });

  const cachedImages = readerArticleImageCache.get(key) || new Map();

  imageSources.forEach((source) => {
    if (cachedImages.has(source)) return;

    const image = new window.Image();
    image.decoding = "async";
    image.src = source;
    cachedImages.set(source, image);
  });

  readerArticleImageCache.set(key, cachedImages);

  while (readerArticleCache.size > READER_ARTICLE_CACHE_MAX_SIZE) {
    const oldestKey = readerArticleCache.keys().next().value;
    if (!oldestKey) break;
    readerArticleCache.delete(oldestKey);
    readerArticleHotCache.delete(oldestKey);
    readerArticleImageCache.delete(oldestKey);
  }
}

interface ReaderSection {
  id: string;
  title: string;
  level: number;
}

interface ReaderMedia {
  title: string;
  fileName: string;
  imageUrl: string;
  pageUrl: string;
  width?: number;
  height?: number;
  caption?: string;
  credit?: string;
  license?: string;
}

type ReaderContextMenuState = {
  requestId: number;
  x: number;
  y: number;
  target: ReaderTarget | null;
  copyText: string;
  editable: HTMLInputElement | HTMLTextAreaElement | null;
  clipboardText: string | null;
};

type ReaderImageLightboxState = {
  source: string;
  fallbackSource: string;
  alt: string;
  captionHtml: string;
  preserveSkinInvert: boolean;
  fileHost: string | null;
  fileHostLabel: string | null;
  fileTitle: string | null;
  filePageUrl: string | null;
};

type ReaderImageAttribution = {
  author: string | null;
  authorUrl: string | null;
  ownWork: boolean;
  sourceUrl: string | null;
};

const READER_IMAGE_LIGHTBOX_GUTTER = 48;
const READER_IMAGE_LIGHTBOX_ATTRIBUTION_HEIGHT = 46;

function getReaderMediumImageSource(source: string) {
  if (!source) return source;

  try {
    const url = new URL(source, window.location.href);

    url.pathname = url.pathname.replace(
      /\/\d+px-([^/]+)$/i,
      "/1920px-$1",
    );

    return url.href;
  } catch {
    return source;
  }
}

function getReaderImageFileDetails(fileTarget: string | null, source: string) {
  const fileName = fileTarget?.replace(/^File:/i, "").trim();
  if (!fileName) {
    return {
      fileHost: null,
      fileHostLabel: null,
      filePageUrl: null,
      fileTitle: null,
    };
  }

  let fileHost = "https://en.wikipedia.org";

  try {
    const imageUrl = new URL(source, window.location.href);
    if (imageUrl.pathname.includes("/wikipedia/commons/")) {
      fileHost = "https://commons.wikimedia.org";
    }
  } catch {
    // Use English Wikipedia as the safe fallback for local Wikipedia files.
  }

  const fileTitle = `File:${fileName}`;

  return {
    fileHost,
    fileHostLabel: fileHost.includes("commons")
      ? "Wikimedia Commons"
      : "English Wikipedia",
    filePageUrl: `${fileHost}/wiki/File:${encodeURIComponent(
    fileName,
    ).replace(/%20/g, "_")}`,
    fileTitle,
  };
}

function readerPlainTextFromMetadataHtml(html: string) {
  const container = document.createElement("div");
  container.innerHTML = html;
  return container.textContent?.trim() || null;
}

function readerExternalUrlFromMetadataHtml(html: string) {
  const container = document.createElement("div");
  container.innerHTML = html;

  return (
    Array.from(container.querySelectorAll<HTMLAnchorElement>("a[href]"))
      .map((link) => link.href)
      .find((href) => /^https?:/i.test(href)) ?? null
  );
}

function setReaderContextInputValue(
  input: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) {
  const prototype =
    input instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
  const nativeSetter = Object.getOwnPropertyDescriptor(
    prototype,
    "value",
  )?.set;

  if (nativeSetter) {
    nativeSetter.call(input, value);
  } else {
    input.value = value;
  }

  input.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      cancelable: true,
      inputType: "insertFromPaste",
      data: value,
    }),
  );
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

interface SearchSuggestion {
  title: string;
  description: string;
  url: string;
  imageUrl?: string;
}



function getActiveReaderFindPanel() {
  return (
    document.querySelector<HTMLElement>(".reader-tab-panel-active") ||
    document.querySelector<HTMLElement>(".reader-tab-panel")
  );
}

function getActiveReaderFindArticle() {
  const activePanel = getActiveReaderFindPanel();

  return (
    activePanel?.querySelector<HTMLElement>(".reader-article") ||
    document.querySelector<HTMLElement>(".reader-article")
  );
}

function isReaderFindTextNodeVisible(node: Text) {
  const parent = node.parentElement;
  if (!parent) return false;

  if (
    parent.closest(
      "[hidden], .reader-hidden-sort-key, .reader-location-map-controls, script, style, noscript, textarea, input, select, button",
    )
  ) {
    return false;
  }

  // Text inside a closed <details> body is not visible, but the <summary> is.
  const closedDetails = parent.closest("details:not([open])");
  if (closedDetails && !parent.closest("summary")) {
    return false;
  }

  let element: HTMLElement | null = parent;
  while (element && element.classList && !element.classList.contains("reader-article")) {
    const style = window.getComputedStyle(element);

    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      style.opacity === "0"
    ) {
      return false;
    }

    element = element.parentElement;
  }

  const range = document.createRange();
  range.selectNodeContents(node);
  const rects = range.getClientRects();
  range.detach();

  return rects.length > 0;
}

function clearReaderFindHighlights() {
  const root = getActiveReaderFindArticle();
  if (!root) return;

  root.querySelectorAll<HTMLElement>("mark.reader-find-highlight").forEach((mark) => {
    const parent = mark.parentNode;
    if (!parent) return;

    parent.replaceChild(document.createTextNode(mark.textContent || ""), mark);
    parent.normalize();
  });
}

function highlightReaderFindMatches(query: string) {
  clearReaderFindHighlights();

  const root = getActiveReaderFindArticle();
  const needle = query.trim();

  if (!root || !needle) return 0;

  const loweredNeedle = needle.toLocaleLowerCase();
  const textNodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = node.nodeValue || "";
      const parent = node.parentElement;

      if (!parent || !text.trim()) return NodeFilter.FILTER_REJECT;

      if (
        parent.closest(
          "mark.reader-find-highlight, script, style, noscript, textarea, input, select, button, .reader-hidden-sort-key, .reader-location-map-controls",
        )
      ) {
        return NodeFilter.FILTER_REJECT;
      }

      if (!text.toLocaleLowerCase().includes(loweredNeedle)) {
        return NodeFilter.FILTER_REJECT;
      }

      return isReaderFindTextNodeVisible(node as Text)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });

  let currentNode = walker.nextNode();
  while (currentNode) {
    textNodes.push(currentNode as Text);
    currentNode = walker.nextNode();
  }

  let matchIndex = 0;

  textNodes.forEach((textNode) => {
    const text = textNode.nodeValue || "";
    const loweredText = text.toLocaleLowerCase();
    const parent = textNode.parentNode;

    if (!parent) return;

    const fragment = document.createDocumentFragment();
    let searchFrom = 0;
    let lastCopied = 0;

    while (true) {
      const foundAt = loweredText.indexOf(loweredNeedle, searchFrom);
      if (foundAt < 0) break;

      if (foundAt > lastCopied) {
        fragment.append(document.createTextNode(text.slice(lastCopied, foundAt)));
      }

      const mark = document.createElement("mark");
      mark.className = "reader-find-highlight";
      mark.dataset.readerFindIndex = String(matchIndex);
      mark.textContent = text.slice(foundAt, foundAt + needle.length);
      fragment.append(mark);

      matchIndex += 1;
      searchFrom = foundAt + needle.length;
      lastCopied = searchFrom;
    }

    if (lastCopied < text.length) {
      fragment.append(document.createTextNode(text.slice(lastCopied)));
    }

    if (fragment.childNodes.length > 0) {
      parent.replaceChild(fragment, textNode);
    }
  });

  return matchIndex;
}

function getReaderFindHighlightMarks() {
  const root = getActiveReaderFindArticle();
  if (!root) return [];

  const marks = Array.from(
    root.querySelectorAll<HTMLElement>("mark.reader-find-highlight"),
  );

  if (marks.length <= 1) return marks;

  const container = getReaderFindScrollContainer();
  if (!container) return marks;

  const containerRect = container.getBoundingClientRect();

  return marks
    .map((mark, domIndex) => {
      const markRect = mark.getBoundingClientRect();
      const top = markRect.top - containerRect.top + container.scrollTop;
      const left = markRect.left - containerRect.left;

      return {
        mark,
        domIndex,
        top,
        left,
      };
    })
    .sort((a, b) => {
      if (Math.abs(a.top - b.top) > 8) return a.top - b.top;
      if (Math.abs(a.left - b.left) > 4) return a.left - b.left;
      return a.domIndex - b.domIndex;
    })
    .map(({ mark }) => mark);
}

function activateReaderFindMatch(index: number) {
  const root = getActiveReaderFindArticle();
  const marks = getReaderFindHighlightMarks();

  root
    ?.querySelectorAll<HTMLElement>("mark.reader-find-highlight")
    .forEach((mark) => mark.classList.remove("reader-find-highlight-active"));

  const activeMark = marks[index];
  if (!activeMark) return;

  activeMark.classList.add("reader-find-highlight-active");

  const container = getReaderFindScrollContainer();
  if (!container) {
    activeMark.scrollIntoView({ block: "center", behavior: "auto" });
    return;
  }

  const containerRect = container.getBoundingClientRect();
  const markRect = activeMark.getBoundingClientRect();
  const currentTop = container.scrollTop;
  const absoluteTop = markRect.top - containerRect.top + currentTop;
  const viewportHeight = Math.max(container.clientHeight, 1);

  const targetTop = Math.max(
    0,
    absoluteTop - viewportHeight * 0.4,
  );

  container.scrollTo({
    top: targetTop,
    behavior: "auto",
  });
}

function getReaderFindScrollContainer() {
  const scrollSelectors = [".wikipedia-reader", ".browser-content", ".research-browser"];
  const scope: ParentNode = getActiveReaderFindPanel() || document;

  for (const selector of scrollSelectors) {
    const element = scope.querySelector(selector) as HTMLElement | null;
    if (!element) continue;

    const style = window.getComputedStyle(element);
    const canScroll = /(auto|scroll|overlay)/i.test(style.overflowY);

    if (canScroll && element.scrollHeight > element.clientHeight + 4) {
      return element;
    }
  }

  return (
    (document.scrollingElement as HTMLElement | null) ||
    document.documentElement
  );
}

function getReaderFindMarkerPositions() {
  const container = getReaderFindScrollContainer();
  const marks = getReaderFindHighlightMarks();

  if (!container || marks.length === 0) return [];

  const containerRect = container.getBoundingClientRect();
  const scrollHeight = Math.max(container.scrollHeight, 1);

  return marks.map((mark) => {
    const markRect = mark.getBoundingClientRect();
    const absoluteTop = markRect.top - containerRect.top + container.scrollTop;

    return Math.max(0, Math.min(100, (absoluteTop / scrollHeight) * 100));
  });
}




const READER_FIND_MIN_QUERY_LENGTH = 2;
const READER_FIND_DEBOUNCE_MS = 350;
const READER_SUGGESTION_MIN_QUERY_LENGTH = 3;
const READER_SUGGESTION_DEBOUNCE_MS = 900;

function WikipediaReader({
  target,
  onTargetChange,
  onOpenInNewTab,  toolbarHost = null,
  active = true,
  toolbarVisible = true,
  toolbarPane = "left",
  readerToolsVisible = true,
  onToggleReaderTools,
}: WikipediaReaderProps) {
  const [history, setHistory] = useState<ReaderTarget[]>(() =>
    target && !isWikipediaPortalTarget(target) ? [target] : [],
  );
  const [historyIndex, setHistoryIndex] = useState(() =>
    target && !isWikipediaPortalTarget(target) ? 0 : -1,
  );
  const [search, setSearch] = useState("");
  const [suggestions, setSuggestions] = useState<SearchSuggestion[]>([]);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(-1);
  const searchSuggestionsRef = useRef<HTMLDivElement>(null);
  const searchScrollbarDragRef = useRef<{ startY: number; startScrollTop: number } | null>(null);
  const [searchScrollbarMetrics, setSearchScrollbarMetrics] = useState({
    height: 0,
    top: 0,
    scrollTop: 0,
    maxScrollTop: 0,
  });
  const [article, setArticle] = useState<ReaderArticle | null>(null);
  const [media, setMedia] = useState<ReaderMedia | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [loadedTargetKey, setLoadedTargetKey] = useState<string | null>(null);
  const currentTarget = history[historyIndex] || null;
  const scrollPositionsRef = useRef<Record<number, number>>({});
  const pendingScrollRestoreRef = useRef<number | null>(null);
  const skipNextReaderTopScrollRef = useRef(false);
  const skipNextReaderArticleTopScrollRef = useRef(false);
  const pendingWikiFragmentTargetKeyRef = useRef<string | null>(null);
  const [sectionHistory, setSectionHistory] = useState<string[]>(["__top"]);
  const [sectionHistoryIndex, setSectionHistoryIndex] = useState(0);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findMatchCount, setFindMatchCount] = useState(0);
  const [findActiveIndex, setFindActiveIndex] = useState(0);
  const [findMarkerPositions, setFindMarkerPositions] = useState<number[]>([]);
  const [readerZoom, setReaderZoom] = useState(1);
  const [readerReloadKey, setReaderReloadKey] = useState(0);
  const [readerSettling, setReaderSettling] = useState(false);
  const [readerInfoboxSettling, setReaderInfoboxSettling] = useState(false);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const readerRootRef = useRef<HTMLDivElement | null>(null);
  const readerContextMenuRef = useRef<HTMLDivElement | null>(null);
  const readerContextMenuLinkRef = useRef<HTMLAnchorElement | null>(null);
  const readerContextMenuPreserveSelectionRef = useRef(false);
  const readerContextMenuRequestIdRef = useRef(0);
  const [readerContextMenu, setReaderContextMenu] =
    useState<ReaderContextMenuState | null>(null);
  const [readerImageLightbox, setReaderImageLightbox] =
    useState<ReaderImageLightboxState | null>(null);
  const [readerImageLightboxLightPanel, setReaderImageLightboxLightPanel] =
    useState(false);
  const [readerImageAttribution, setReaderImageAttribution] =
    useState<ReaderImageAttribution | null>(null);
  const readerImageLightboxOverlayRef = useRef<HTMLDivElement | null>(null);
  const readerImageLightboxBoxRef = useRef<HTMLElement | null>(null);
  const readerImageLightboxImageRef = useRef<HTMLImageElement | null>(null);
  const readerImageLightboxCaptionRef = useRef<HTMLDivElement | null>(null);

  function getReaderScope() {
    return readerRootRef.current ?? document;
  }

  function getReaderScopedElementById(id: string) {
    const scope = getReaderScope();

    return (
      Array.from(scope.querySelectorAll<HTMLElement>("[id]")).find(
        (element) => element.id === id,
      ) ?? null
    );
  }


  useEffect(() => {
    const query = search.trim();

    if (query.length < READER_SUGGESTION_MIN_QUERY_LENGTH) {
      setSuggestions([]);
      setSelectedSuggestionIndex(-1);
      setSuggestionsOpen(false);
      return;
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      loadWikipediaSuggestions(query, controller.signal)
        .then((nextSuggestions) => {
          setSuggestions(nextSuggestions);
          setSelectedSuggestionIndex(-1);
          setSuggestionsOpen(nextSuggestions.length > 0);
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          setSuggestions([]);
          setSelectedSuggestionIndex(-1);
          setSuggestionsOpen(false);
        });
    }, READER_SUGGESTION_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [search]);

  useLayoutEffect(() => {
    const viewport = searchSuggestionsRef.current;
    if (!viewport || !suggestionsOpen || suggestions.length === 0) return;

    let frame = 0;
    const updateMetrics = () => {
      frame = 0;
      const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      const trackHeight = Math.max(0, viewport.clientHeight - 4);
      const height = maxScrollTop > 0
        ? Math.max(24, trackHeight * viewport.clientHeight / viewport.scrollHeight)
        : 0;
      const travel = Math.max(0, trackHeight - height);
      const top = viewport.offsetTop + 2
        + travel * (maxScrollTop ? viewport.scrollTop / maxScrollTop : 0);

      setSearchScrollbarMetrics({ height, top, scrollTop: viewport.scrollTop, maxScrollTop });
    };
    const scheduleUpdate = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(updateMetrics);
    };
    const observer = new ResizeObserver(scheduleUpdate);

    viewport.addEventListener("scroll", scheduleUpdate, { passive: true });
    observer.observe(viewport);
    window.addEventListener("resize", scheduleUpdate);
    scheduleUpdate();

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      viewport.removeEventListener("scroll", scheduleUpdate);
      observer.disconnect();
      window.removeEventListener("resize", scheduleUpdate);
    };
  }, [suggestions.length, suggestionsOpen]);

  const handleSearchScrollbarPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const viewport = searchSuggestionsRef.current;
    if (!viewport || searchScrollbarMetrics.maxScrollTop <= 0) return;

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    searchScrollbarDragRef.current = {
      startY: event.clientY,
      startScrollTop: viewport.scrollTop,
    };
  };

  const handleSearchScrollbarPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const viewport = searchSuggestionsRef.current;
    const drag = searchScrollbarDragRef.current;
    if (!viewport || !drag || searchScrollbarMetrics.maxScrollTop <= 0) return;

    const trackRange = Math.max(1, viewport.clientHeight - 4 - searchScrollbarMetrics.height);
    viewport.scrollTop = drag.startScrollTop
      + ((event.clientY - drag.startY) / trackRange) * searchScrollbarMetrics.maxScrollTop;
  };

  const stopSearchScrollbarDrag = () => {
    searchScrollbarDragRef.current = null;
  };








  const moveFindMatch = useCallback((direction: number) => {
    setFindActiveIndex((currentIndex) => {
      if (findMatchCount <= 0) return 0;
      return (currentIndex + direction + findMatchCount) % findMatchCount;
    });
  }, [findMatchCount]);

  useEffect(() => {
    if (!findOpen) {
      clearReaderFindHighlights();
      setFindMatchCount(0);
      setFindActiveIndex(0);
      setFindMarkerPositions([]);
      return;
    }

    const trimmedFindQuery = findQuery.trim();

    if (trimmedFindQuery.length < READER_FIND_MIN_QUERY_LENGTH) {
      clearReaderFindHighlights();
      setFindMatchCount(0);
      setFindActiveIndex(0);
      setFindMarkerPositions([]);
      return;
    }

    const timeout = window.setTimeout(() => {
      const nextCount = highlightReaderFindMatches(trimmedFindQuery);
      setFindMatchCount(nextCount);
      setFindActiveIndex(0);
      setFindMarkerPositions(getReaderFindMarkerPositions());

      if (nextCount > 0) {
        activateReaderFindMatch(0);
      }
    }, READER_FIND_DEBOUNCE_MS);

    return () => window.clearTimeout(timeout);
  }, [findOpen, findQuery, article?.html, currentTarget]);

  useEffect(() => {
    if (!findOpen || findMatchCount <= 0) return;
    activateReaderFindMatch(findActiveIndex);
  }, [findActiveIndex, findMatchCount, findOpen]);

  useEffect(() => {
    if (!findOpen) return;

    const timeout = window.setTimeout(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    }, 0);

    return () => window.clearTimeout(timeout);
  }, [findOpen]);

  useEffect(() => {
    function handleReaderFindKeyDown(event: globalThis.KeyboardEvent) {
      const key = event.key.toLowerCase();
      const isFindShortcut = (event.metaKey || event.ctrlKey) && key === "f";

      if (isFindShortcut) {
        if (!toolbarVisible) return;
        event.preventDefault();
        setFindOpen(true);
        return;
      }

      if (!findOpen) return;

      if (event.key === "Escape") {
        event.preventDefault();
        setFindOpen(false);
      }
    }

    document.addEventListener("keydown", handleReaderFindKeyDown);

    return () => {
      document.removeEventListener("keydown", handleReaderFindKeyDown);
    };
  }, [findOpen, toolbarVisible]);


  useEffect(() => {
    setSectionHistory(["__top"]);
    setSectionHistoryIndex(0);

    // Normal link/search navigation opens the new page at the top.
    // Browser-style back/forward skips this top scroll and restores later,
    // after the destination page content has actually loaded.
    if (typeof pendingScrollRestoreRef.current === "number") {
      return;
    }

    if (skipNextReaderTopScrollRef.current) {
      skipNextReaderTopScrollRef.current = false;
      return;
    }

    function scrollReaderToTop() {
      const scope = getReaderScope();

      scope
        .querySelectorAll<HTMLElement>(
          ".browser-content, .wikipedia-reader, .reader-article, .media-reader, .reference-reader",
        )
        .forEach((element) => {
          element.scrollTop = 0;
          element.scrollLeft = 0;
        });

      scope
        .querySelector<HTMLElement>(".reader-page-header")
        ?.scrollIntoView({ block: "start", behavior: "auto" });
    }

    scrollReaderToTop();

    const frame = window.requestAnimationFrame(scrollReaderToTop);
    const timeout = window.setTimeout(scrollReaderToTop, 0);

    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
    };
  }, [currentTarget]);

  useEffect(() => {
    if (
      !target ||
      isWikipediaPortalTarget(target) ||
      sameTarget(target, currentTarget)
    ) {
      return;
    }

    if (target.kind === "wiki") {
      const { fragment } = splitWikipediaTopicFragment(target.topic);
      pendingWikiFragmentTargetKeyRef.current = fragment
        ? readerTargetKey(target)
        : null;
    } else {
      pendingWikiFragmentTargetKeyRef.current = null;
    }

    setHistory((currentHistory) => [
      ...currentHistory.slice(0, historyIndex + 1),
      target,
    ]);
    setHistoryIndex((index) => index + 1);
  }, [target]);

  useEffect(() => {
    if (!currentTarget) {
      setArticle(null);
      setMedia(null);
      setLoadedTargetKey(null);
      setStatus("idle");
      setReaderInfoboxSettling(false);
      return;
    }

    const expectedTargetKey = readerTargetKey(currentTarget);

    if (currentTarget.kind !== "wiki") {
      setArticle(null);
      setMedia(null);
      setLoadedTargetKey(expectedTargetKey);
      setStatus("idle");
      setReaderInfoboxSettling(false);
      return;
    }

    const cachedArticle =
      readerReloadKey === 0
        ? readReaderArticleCache(currentTarget.topic)
        : null;

    if (cachedArticle) {
      setArticle(
        readReaderArticleHotCache(currentTarget.topic) || cachedArticle,
      );
      setMedia(null);
      setLoadedTargetKey(expectedTargetKey);
      setStatus("idle");
      setReaderInfoboxSettling(false);
      return;
    }

    const controller = new AbortController();

    setArticle(null);
    setMedia(null);
    setLoadedTargetKey(null);
    setStatus("loading");
    setReaderInfoboxSettling(true);

    let coordinateInsertTimer = 0;
    let articleReadyForCoordinates = false;
    let pendingCoordinatesHtml = "";
    let pendingCategoryHtml = "";

    const insertCoordinatesHtml = (
      coordinatesHtml: string,
      attempt = 0,
    ) => {
      if (controller.signal.aborted || !coordinatesHtml) return;

      const articleElement =
        readerRootRef.current?.querySelector<HTMLElement>(
          ".reader-article",
        );

      if (!articleElement) {
        if (attempt >= 80) return;

        coordinateInsertTimer = window.setTimeout(() => {
          coordinateInsertTimer = 0;
          insertCoordinatesHtml(
            coordinatesHtml,
            attempt + 1,
          );
        }, 25);

        return;
      }

      const template =
        globalThis.document.createElement("template");
      template.innerHTML = coordinatesHtml.trim();

      const coordinates =
        template.content.querySelector<HTMLElement>(
          ".reader-coordinates",
        );

      if (!coordinates) return;

      coordinates.classList.add(
        "reader-coordinates-top",
      );

      articleElement
        .querySelector<HTMLElement>(
          ":scope > .reader-coordinates",
        )
        ?.remove();

      articleElement.insertBefore(
        coordinates,
        articleElement.firstChild,
      );
    };

    const handleCoordinatesHtml = (
      coordinatesHtml: string,
    ) => {
      pendingCoordinatesHtml = coordinatesHtml;

      if (articleReadyForCoordinates) {
        insertCoordinatesHtml(coordinatesHtml);
      }
    };

    const insertCategoryHtml = (categoryHtml: string, attempt = 0) => {
      if (controller.signal.aborted || !categoryHtml) return;

      const articleElement =
        readerRootRef.current?.querySelector<HTMLElement>(
          ".reader-article",
        );

      if (!articleElement) {
        pendingCategoryHtml = categoryHtml;
        if (attempt < 80) {
          window.requestAnimationFrame(() => {
            insertCategoryHtml(categoryHtml, attempt + 1);
          });
        }
        return;
      }

      const template = globalThis.document.createElement("template");
      template.innerHTML = categoryHtml.trim();
      const category = template.content.querySelector<HTMLElement>(
        ".reader-category-links",
      );

      if (!category) return;

      articleElement
        .querySelector<HTMLElement>(":scope > .reader-category-links")
        ?.remove();
      articleElement.append(category);
    };

    const loader = currentTarget.topic.startsWith("File:")
      ? loadWikipediaMedia(currentTarget.topic, controller.signal).then(
          (nextMedia) => {
            setMedia(nextMedia);
            setLoadedTargetKey(expectedTargetKey);
            setStatus("idle");
          },
        )
      : loadWikipediaArticle(
        currentTarget.topic,
          controller.signal,
          handleCoordinatesHtml,
          insertCategoryHtml,
        ).then((nextArticle) => {
          writeReaderArticleCache(currentTarget.topic, nextArticle);
          console.log("[reader loader] article handoff", {
            topic: currentTarget.topic,
            htmlBytes: nextArticle.html.length,
            sections: nextArticle.sections.length,
          });
          setArticle(nextArticle);
          articleReadyForCoordinates = true;

          if (pendingCoordinatesHtml) {
            insertCoordinatesHtml(
              pendingCoordinatesHtml,
            );
          }

          if (pendingCategoryHtml) {
            insertCategoryHtml(pendingCategoryHtml);
            pendingCategoryHtml = "";
          }

          setLoadedTargetKey(expectedTargetKey);
          setStatus("idle");
        });

    loader.catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") return;
      console.error("[reader loader] article load failed", {
        topic: currentTarget.topic,
        error,
      });
      setArticle(null);
      setMedia(null);
      setLoadedTargetKey(null);
      setStatus("error");
      setReaderSettling(false);
      setReaderInfoboxSettling(false);
    });

    return () => {
      controller.abort();

      if (coordinateInsertTimer) {
        window.clearTimeout(coordinateInsertTimer);
      }
    };
  }, [currentTarget, readerReloadKey]);

  useEffect(() => {
    if (
      !readerInfoboxSettling ||
      !article ||
      currentTarget?.kind !== "wiki"
    ) {
      return;
    }

    const scope = getReaderScope();
    const title = scope.querySelector<HTMLElement>(
      ".reader-tab-panel-active .reader-page-header h2",
    );
    const articleBody = scope.querySelector<HTMLElement>(
      ".reader-tab-panel-active .reader-article",
    );
    const mainBody = articleBody?.querySelector<HTMLElement>(
      ".reader-lead-paragraph, .reader-lead-body-item, p",
    ) ?? null;
    const infobox = scope.querySelector<HTMLElement>(
      ".reader-tab-panel-active .reader-article table.infobox, " +
        ".reader-tab-panel-active .reader-article .infobox",
    );
    const mathImages = Array.from(
      scope.querySelectorAll<HTMLImageElement>(
        ".reader-tab-panel-active .reader-article .mwe-math-element img.mwe-math-fallback-image-inline, " +
          ".reader-tab-panel-active .reader-article .mwe-math-element img.mwe-math-fallback-image-display",
      ),
    ).filter((image) => {
      const rect = image.getBoundingClientRect();
      return rect.bottom >= 0 && rect.top <= window.innerHeight;
    });

    if (!title || !mainBody) {
      return;
    }

    let lastLayout = "";
    let stableSince = performance.now();

    const finishIfStable = () => {
      const images = infobox ? Array.from(infobox.querySelectorAll("img")) : [];
      const titleRect = title.getBoundingClientRect();
      const bodyRect = mainBody.getBoundingClientRect();
      const infoboxRect = infobox?.getBoundingClientRect();
      const articleContentSignature = articleBody
        ? [
            articleBody.textContent?.length || 0,
            articleBody.querySelectorAll("p, h1, h2, h3, h4, table, img, .mwe-math-element").length,
            articleBody.scrollHeight,
          ].join(":")
        : "missing";
      const nextLayout = [
        titleRect.top,
        titleRect.height,
        bodyRect.top,
        bodyRect.height,
        infoboxRect?.top || 0,
        infoboxRect?.height || 0,
        articleContentSignature,
      ].join(":");

      if (nextLayout !== lastLayout) {
        lastLayout = nextLayout;
        stableSince = performance.now();
      }

      const imagesReady = images.every((image) => image.complete);
      const mathImagesReady = mathImages.every((image) => image.complete);
      if (
        imagesReady &&
        mathImagesReady &&
        performance.now() - stableSince >= 300
      ) {
        setReaderInfoboxSettling(false);
      }
    };

    const timer = window.setInterval(finishIfStable, 50);
    const safetyTimer = window.setTimeout(
      () => setReaderInfoboxSettling(false),
      5000,
    );

    finishIfStable();

    return () => {
      window.clearInterval(timer);
      window.clearTimeout(safetyTimer);
    };
  }, [article, currentTarget, readerInfoboxSettling]);

  useLayoutEffect(() => {
    const pendingTop = pendingScrollRestoreRef.current;

    if (typeof pendingTop !== "number") return;
    if (!currentTarget) return;
    if (loadedTargetKey !== readerTargetKey(currentTarget)) return;

    const restoreTop = pendingTop;
    const scope = getReaderScope();
    const readerContainer =
      scope.querySelector<HTMLElement>(".wikipedia-reader");
    const articleElement =
      scope.querySelector<HTMLElement>(".reader-article");

    function restoreReaderScroll() {
      setReaderScrollTop(restoreTop);
    }

    const isCachedArticle =
      currentTarget.kind === "wiki" &&
      readerReloadKey === 0 &&
      Boolean(readReaderArticleCache(currentTarget.topic));

    if (isCachedArticle && readerContainer && articleElement) {
      restoreReaderScroll();
      pendingScrollRestoreRef.current = null;
      setReaderSettling(false);
      return;
    }

    /*
     * Uncached Wikipedia articles need to settle before becoming visible
     * because their progressive image queue can otherwise shift the restored
     * viewport repeatedly.
     */
    if (!readerContainer || !articleElement) {
      restoreReaderScroll();

      const frame = window.requestAnimationFrame(restoreReaderScroll);
      const timeoutOne = window.setTimeout(restoreReaderScroll, 80);
      const timeoutTwo = window.setTimeout(restoreReaderScroll, 240);
      const timeoutThree = window.setTimeout(restoreReaderScroll, 600);
      const timeoutFour = window.setTimeout(restoreReaderScroll, 1200);

      pendingScrollRestoreRef.current = null;
      setReaderSettling(false);

      return () => {
        window.cancelAnimationFrame(frame);
        window.clearTimeout(timeoutOne);
        window.clearTimeout(timeoutTwo);
        window.clearTimeout(timeoutThree);
        window.clearTimeout(timeoutFour);
      };
    }

    const originalVisibility = readerContainer.style.visibility;
    readerContainer.style.visibility = "hidden";
    restoreReaderScroll();

    /*
     * Keep the normal progressive queue in charge during saved-position
     * restoration as well. Deferred images retain their placeholders while
     * the article settles, so restoring scroll does not turn every image into
     * an eager request at once.
     */
    let lastHeight = readerContainer.scrollHeight;
    let stableSince = performance.now();
    let finished = false;
    let revealFrameOne = 0;
    let revealFrameTwo = 0;

    const revealReader = () => {
      if (finished) return;
      finished = true;

      window.clearInterval(settleTimer);
      window.clearTimeout(safetyTimeout);
      restoreReaderScroll();

      revealFrameOne = window.requestAnimationFrame(() => {
        restoreReaderScroll();

        revealFrameTwo = window.requestAnimationFrame(() => {
          restoreReaderScroll();
          readerContainer.style.visibility = originalVisibility;
          setReaderSettling(false);
        });
      });
    };

    const settleTimer = window.setInterval(() => {
      restoreReaderScroll();

      const nextHeight = readerContainer.scrollHeight;
      if (nextHeight !== lastHeight) {
        lastHeight = nextHeight;
        stableSince = performance.now();
      }

      const hasIncompleteImages = Array.from(
        articleElement.querySelectorAll<HTMLImageElement>("img"),
      ).some((image) => !image.complete);

      if (
        !hasIncompleteImages &&
        performance.now() - stableSince >= 1200
      ) {
        revealReader();
      }
    }, 100);

    const safetyTimeout = window.setTimeout(revealReader, 25000);

    pendingScrollRestoreRef.current = null;

    return () => {
      finished = true;
      window.clearInterval(settleTimer);
      window.clearTimeout(safetyTimeout);
      window.cancelAnimationFrame(revealFrameOne);
      window.cancelAnimationFrame(revealFrameTwo);
      readerContainer.style.visibility = originalVisibility;
      setReaderSettling(false);
    };
  }, [currentTarget, loadedTargetKey]);

  const openUrl = useMemo(() => {
  if (currentTarget?.kind === "reference") return currentTarget.reference.url;
  if (currentTarget?.kind === "wiki" && currentTarget.topic.startsWith("File:")) {
    return media?.pageUrl || null;
  }
  return article?.url || null;
  }, [article, currentTarget, media]);

  function scrollToReaderPosition(position: string) {
    if (position === "__top") {
      setReaderScrollTop(0);

      return;
    }

    const targetElement = getReaderScopedElementById(position);
    if (targetElement) {
      targetElement.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  }


  function getReaderScrollTop() {
    const scope = getReaderScope();
    const browserContent = scope.querySelector<HTMLElement>(".browser-content");
    const wikipediaReader = scope.querySelector<HTMLElement>(".wikipedia-reader");

    return Math.max(
      browserContent?.scrollTop ?? 0,
      wikipediaReader?.scrollTop ?? 0,
    );
  }

  function setReaderScrollTop(top: number) {
    const scope = getReaderScope();

    scope
      .querySelectorAll<HTMLElement>(".browser-content, .wikipedia-reader")
      .forEach((element) => {
        element.scrollTop = top;
        element.scrollLeft = 0;
      });
  }

  function saveCurrentReaderScrollPosition() {
    if (historyIndex < 0) return;
    scrollPositionsRef.current[historyIndex] = getReaderScrollTop();
  }



  const navigateSection = useCallback((sectionId: string) => {
    const nextSection = sectionId || "__top";

    if (sectionHistory[sectionHistoryIndex] === nextSection) {
      scrollToReaderPosition(nextSection);
      return;
    }

    scrollToReaderPosition(nextSection);

    setSectionHistory((currentHistory) => [
      ...currentHistory.slice(0, sectionHistoryIndex + 1),
      nextSection,
    ]);
    setSectionHistoryIndex((index) => index + 1);
    }, [sectionHistory, sectionHistoryIndex]);

  function moveBack() {
    if (sectionHistoryIndex > 0) {
      const nextIndex = sectionHistoryIndex - 1;
      setSectionHistoryIndex(nextIndex);
      scrollToReaderPosition(sectionHistory[nextIndex]);
      return;
    }

    moveHistory(historyIndex - 1);
  }

  function moveForward() {
    if (sectionHistoryIndex < sectionHistory.length - 1) {
      const nextIndex = sectionHistoryIndex + 1;
      setSectionHistoryIndex(nextIndex);
      scrollToReaderPosition(sectionHistory[nextIndex]);
      return;
    }

    moveHistory(historyIndex + 1);
  }

  function reloadCurrentReader() {
    if (!currentTarget || currentTarget.kind !== "wiki") return;

    pendingScrollRestoreRef.current = getReaderScrollTop();
    setReaderSettling(true);
    setReaderInfoboxSettling(true);
    setReaderReloadKey((key) => key + 1);
  }

  const navigate = useCallback((nextTarget: ReaderTarget) => {
    if (isWikipediaPortalTarget(nextTarget)) return;

    saveCurrentReaderScrollPosition();
    pendingScrollRestoreRef.current = null;
    skipNextReaderArticleTopScrollRef.current = false;
    setReaderSettling(false);
    setReaderInfoboxSettling(
      nextTarget.kind === "wiki" &&
        (!currentTarget || readerTargetKey(nextTarget) !== readerTargetKey(currentTarget)),
    );

    if (nextTarget.kind === "wiki") {
      const { fragment } = splitWikipediaTopicFragment(nextTarget.topic);
      pendingWikiFragmentTargetKeyRef.current = fragment
        ? readerTargetKey(nextTarget)
        : null;
    } else {
      pendingWikiFragmentTargetKeyRef.current = null;
    }

    onTargetChange(nextTarget);
  }, [currentTarget, historyIndex, onTargetChange]);


  function moveHistory(nextIndex: number) {
    const nextTarget = history[nextIndex];
    if (!nextTarget) return;

    saveCurrentReaderScrollPosition();
    pendingScrollRestoreRef.current = scrollPositionsRef.current[nextIndex] ?? 0;
    skipNextReaderTopScrollRef.current = true;
    skipNextReaderArticleTopScrollRef.current = true;
    setReaderSettling(true);
    setReaderInfoboxSettling(nextTarget.kind === "wiki");
    setHistoryIndex(nextIndex);
    onTargetChange(nextTarget);
  }

  async function submitSearch(event: FormEvent) {
    event.preventDefault();

    const selectedSuggestion =
      selectedSuggestionIndex >= 0
        ? suggestions[selectedSuggestionIndex]
        : null;
    const rawQuery = search.trim();

    setSuggestions([]);
    setSuggestionsOpen(false);
    setSelectedSuggestionIndex(-1);

    if (!rawQuery && !selectedSuggestion) return;

    setSearch("");

    if (selectedSuggestion) {
      navigate({ kind: "wiki", topic: selectedSuggestion.title });
      return;
    }

    const resolvedTopic = await resolveWikipediaSearchTopic(rawQuery);

    navigate(
      resolvedTopic
        ? { kind: "wiki", topic: resolvedTopic }
        : { kind: "search", query: rawQuery },
    );
  }


function chooseSuggestion(suggestion: SearchSuggestion) {
  navigate({ kind: "wiki", topic: suggestion.title });
  setSearch("");
  setSuggestions([]);
  setSuggestionsOpen(false);
  setSelectedSuggestionIndex(-1);
}

function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
  if (!suggestionsOpen || suggestions.length === 0) {
    if (event.key === "ArrowDown" && suggestions.length > 0) {
      event.preventDefault();
      setSuggestionsOpen(true);
      setSelectedSuggestionIndex(0);
    }
    return;
  }

  if (event.key === "ArrowDown") {
    event.preventDefault();
    setSelectedSuggestionIndex((index) =>
      index >= suggestions.length - 1 ? 0 : index + 1,
    );
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    setSelectedSuggestionIndex((index) =>
      index <= 0 ? suggestions.length - 1 : index - 1,
    );
  } else if (event.key === "Escape") {
    event.preventDefault();
    setSuggestionsOpen(false);
    setSelectedSuggestionIndex(-1);
  }
}

  useEffect(() => {
    function handleReaderZoomKeyDown(event: globalThis.KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;

      const key = event.key;
      const isZoomIn = key === "+" || key === "=";
      const isZoomOut = key === "-" || key === "_";
      const isZoomReset = key === "0";

      if (!isZoomIn && !isZoomOut && !isZoomReset) return;

      event.preventDefault();
      event.stopPropagation();

      const clampZoom = (value: number) =>
        Math.max(0.7, Math.min(1.8, Math.round(value * 100) / 100));

      if (isZoomReset) {
        setReaderZoom(1);
      } else if (isZoomIn) {
        setReaderZoom((currentZoom) => clampZoom(currentZoom + 0.1));
      } else if (isZoomOut) {
        setReaderZoom((currentZoom) => clampZoom(currentZoom - 0.1));
      }
    }

    document.addEventListener("keydown", handleReaderZoomKeyDown);

    return () => {
      document.removeEventListener("keydown", handleReaderZoomKeyDown);
    };
  }, []);


  useEffect(() => {
    if (!article?.html) return;

    // Back/forward history restores use their own saved scroll position.
    // Fragment links perform their own post-render section jump.
    // Other new page loads should start at the absolute top.
    if (typeof pendingScrollRestoreRef.current === "number") return;
    if (skipNextReaderArticleTopScrollRef.current) {
      skipNextReaderArticleTopScrollRef.current = false;
      return;
    }
    if (
      currentTarget?.kind === "wiki" &&
      pendingWikiFragmentTargetKeyRef.current === readerTargetKey(currentTarget)
    ) {
      return;
    }

    const forceTop = () => {
      const containers = getReaderScope().querySelectorAll<HTMLElement>(
        ".browser-content, .wikipedia-reader, .reader-article",
      );

      if (containers.length > 0) {
        containers.forEach((container) => {
          container.scrollTop = 0;
          container.scrollLeft = 0;
        });
      } else {
        window.scrollTo({ top: 0, left: 0, behavior: "auto" });
      }
    };

    forceTop();

    const timers = [
      window.setTimeout(forceTop, 40),
      window.setTimeout(forceTop, 140),
      window.setTimeout(forceTop, 320),
    ];

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [article?.html, currentTarget]);

  useEffect(() => {
    if (!currentTarget || currentTarget.kind !== "wiki") return;

    const targetKey = readerTargetKey(currentTarget);

    if (loadedTargetKey !== targetKey) return;
    if (pendingWikiFragmentTargetKeyRef.current !== targetKey) return;

    const { fragment } = splitWikipediaTopicFragment(currentTarget.topic);

    if (!fragment) {
      pendingWikiFragmentTargetKeyRef.current = null;
      return;
    }

    const correctFragmentLanding = () => {
      const targetElement = getReaderScopedElementById(fragment);
      const scope = getReaderScope();
      const readerScroller =
        scope.querySelector<HTMLElement>(".wikipedia-reader");

      if (
        !targetElement ||
        !targetElement.isConnected ||
        !readerScroller ||
        !readerScroller.isConnected
      ) {
        return false;
      }

      const desiredTop =
        readerScroller.getBoundingClientRect().top + 72;
      const currentTop = targetElement.getBoundingClientRect().top;
      const adjustment = currentTop - desiredTop;

      if (Math.abs(adjustment) > 0.5) {
        readerScroller.scrollBy({
          top: adjustment,
          left: 0,
          behavior: "auto",
        });
      }

      return true;
    };

    correctFragmentLanding();

    const frame = window.requestAnimationFrame(correctFragmentLanding);
    const timeoutOne = window.setTimeout(correctFragmentLanding, 80);
    const timeoutTwo = window.setTimeout(correctFragmentLanding, 240);
    const timeoutThree = window.setTimeout(correctFragmentLanding, 600);
    const timeoutFour = window.setTimeout(() => {
      correctFragmentLanding();

      if (pendingWikiFragmentTargetKeyRef.current === targetKey) {
        pendingWikiFragmentTargetKeyRef.current = null;
      }
    }, 1200);

    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timeoutOne);
      window.clearTimeout(timeoutTwo);
      window.clearTimeout(timeoutThree);
      window.clearTimeout(timeoutFour);
    };
  }, [article?.html, currentTarget, loadedTargetKey]);

  const clearReaderContextLink = useCallback(() => {
    readerContextMenuLinkRef.current?.classList.remove(
      "reader-context-link-active",
    );
    readerContextMenuLinkRef.current = null;
  }, []);

  const handleReaderContextMouseDownCapture = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (event.button !== 2) return;

      const clicked = event.target as HTMLElement | null;
      const link =
        clicked?.closest<HTMLAnchorElement>("a[data-wiki-target]") ?? null;
      const selection = window.getSelection();
      let overlapsLink = false;

      if (link && selection && !selection.isCollapsed) {
        for (let index = 0; index < selection.rangeCount; index += 1) {
          try {
            if (selection.getRangeAt(index).intersectsNode(link)) {
              overlapsLink = true;
              break;
            }
          } catch {
            // Ignore detached or otherwise unavailable selection ranges.
          }
        }
      }

      readerContextMenuPreserveSelectionRef.current = overlapsLink;
    },
    [],
  );

  const closeReaderContextMenu = useCallback(() => {
    clearReaderContextLink();
    setReaderContextMenu(null);
  }, [clearReaderContextLink]);

  const closeReaderImageLightbox = useCallback(() => {
    setReaderImageLightbox(null);
    setReaderImageLightboxLightPanel(false);
  }, []);

  const fitReaderImageLightbox = useCallback(() => {
    const overlay = readerImageLightboxOverlayRef.current;
    const box = readerImageLightboxBoxRef.current;
    const image = readerImageLightboxImageRef.current;
    const caption = readerImageLightboxCaptionRef.current;

    if (!overlay || !box || !image || !caption) return;
    if (!image.naturalWidth || !image.naturalHeight) return;

    const linkedPane = readerRootRef.current?.closest<HTMLElement>(
      '.linked-pane[data-pane-id="research"]',
    );
    const tabRow = linkedPane?.querySelector<HTMLElement>(
      ":scope > .reader-pane-tab-row",
    );
    const tabDividerBottom = Math.ceil(
      tabRow?.getBoundingClientRect().bottom ?? 0,
    );

    overlay.style.top = `${tabDividerBottom}px`;

    const overlayWidth = overlay.clientWidth;
    const overlayHeight = overlay.clientHeight;
    const naturalWidth = image.naturalWidth;
    const naturalHeight = image.naturalHeight;
    const maximumImageWidth = Math.max(
      100,
      overlayWidth - READER_IMAGE_LIGHTBOX_GUTTER * 2 - 18,
    );
    let captionHeight = caption.childNodes.length ? 42 : 0;
    let imageWidth = 100;
    let imageHeight = 100;

    for (let pass = 0; pass < 3; pass += 1) {
      const captionSpace = caption.childNodes.length
        ? captionHeight + 8
        : 0;
      const maximumImageHeight = Math.max(
        100,
        overlayHeight -
          READER_IMAGE_LIGHTBOX_GUTTER * 2 -
          18 -
          READER_IMAGE_LIGHTBOX_ATTRIBUTION_HEIGHT -
          captionSpace,
      );
      const scale = Math.min(
        maximumImageWidth / naturalWidth,
        maximumImageHeight / naturalHeight,
      );

      // Preserve the source ratio so object-fit: contain has no rounded side bands.
      imageWidth = naturalWidth * scale;
      imageHeight = naturalHeight * scale;

      image.style.width = `${imageWidth}px`;
      image.style.height = `${imageHeight}px`;
      caption.style.width = `${imageWidth}px`;
      box.style.width = `${imageWidth + 18}px`;

      captionHeight = caption.childNodes.length
        ? Math.ceil(caption.getBoundingClientRect().height)
        : 0;
    }

    const boxBounds = box.getBoundingClientRect();

    box.style.left = `${Math.max(
      READER_IMAGE_LIGHTBOX_GUTTER,
      Math.floor((overlayWidth - boxBounds.width) / 2),
    )}px`;
    box.style.top = `${Math.max(
      READER_IMAGE_LIGHTBOX_GUTTER,
      Math.floor(
        (overlayHeight - READER_IMAGE_LIGHTBOX_ATTRIBUTION_HEIGHT - boxBounds.height) /
          2,
      ),
    )}px`;
    overlay.style.visibility = "visible";
  }, []);

  useEffect(() => {
    setReaderImageAttribution(null);

    if (!readerImageLightbox?.fileHost || !readerImageLightbox.fileTitle) {
      return;
    }

    const controller = new AbortController();
    const metadataUrl = new URL(`${readerImageLightbox.fileHost}/w/api.php`);
    metadataUrl.search = new URLSearchParams({
      action: "query",
      format: "json",
      origin: "*",
      prop: "imageinfo",
      titles: readerImageLightbox.fileTitle,
      iiprop: "extmetadata",
    }).toString();

    void fetch(metadataUrl, { signal: controller.signal })
      .then((response) => response.json())
      .then((data) => {
        if (controller.signal.aborted) return;

        const page = Object.values(
          (data as { query?: { pages?: Record<string, unknown> } }).query
            ?.pages ?? {},
        )[0] as
          | { imageinfo?: Array<{ extmetadata?: Record<string, { value?: string }> }> }
          | undefined;
        const metadata = page?.imageinfo?.[0]?.extmetadata ?? {};
        const artistHtml = metadata.Artist?.value ?? "";
        const creditHtml = metadata.Credit?.value ?? "";
        const creditText = readerPlainTextFromMetadataHtml(creditHtml);

        setReaderImageAttribution({
          author: readerPlainTextFromMetadataHtml(artistHtml),
          authorUrl: readerExternalUrlFromMetadataHtml(artistHtml),
          ownWork: /\bown work\b/i.test(creditText ?? ""),
          sourceUrl: readerExternalUrlFromMetadataHtml(creditHtml),
        });
      })
      .catch((error: unknown) => {
        if ((error as { name?: string }).name !== "AbortError") {
          setReaderImageAttribution(null);
        }
      });

    return () => controller.abort();
  }, [readerImageLightbox?.fileHost, readerImageLightbox?.fileTitle]);

  useEffect(() => {
    if (!readerImageLightbox) return;

    const dismissOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") closeReaderImageLightbox();
    };
    const refitOnResize = () => {
      window.requestAnimationFrame(fitReaderImageLightbox);
    };

    window.addEventListener("keydown", dismissOnEscape);
    window.addEventListener("resize", refitOnResize);

    return () => {
      window.removeEventListener("keydown", dismissOnEscape);
      window.removeEventListener("resize", refitOnResize);
    };
  }, [closeReaderImageLightbox, fitReaderImageLightbox, readerImageLightbox]);

  const handleReaderImageLightboxCaptionClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const clicked = event.target as HTMLElement;
      const link = clicked.closest<HTMLAnchorElement>("a[data-wiki-target]");
      const topic = link?.dataset.wikiTarget;

      if (!link || !topic) return;

      event.preventDefault();
      markReaderWikiTargetVisited(topic);
      closeReaderImageLightbox();
      navigate({ kind: "wiki", topic });
    },
    [closeReaderImageLightbox, navigate],
  );

  const handleReaderContextMenu = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const clicked = event.target as HTMLElement | null;
      if (!clicked) return;

      event.preventDefault();

      const link = clicked.closest<HTMLAnchorElement>("a[data-wiki-target]");
      const preserveSelection =
        readerContextMenuPreserveSelectionRef.current;
      readerContextMenuPreserveSelectionRef.current = false;

      clearReaderContextLink();

      if (link) {
        readerContextMenuLinkRef.current = link;
        link.classList.add("reader-context-link-active");

        if (!preserveSelection) {
          window.getSelection()?.removeAllRanges();
        }
      }

      const selection = window.getSelection()?.toString().trim() || "";
      const editable = clicked.closest<HTMLInputElement | HTMLTextAreaElement>(
        "input, textarea",
      );
      const editableSelection = editable
        ? editable.value.slice(
            editable.selectionStart ?? 0,
            editable.selectionEnd ?? 0,
          )
        : "";
      const image = clicked.closest<HTMLImageElement>("img");
      const imageSource = image?.currentSrc || image?.src || "";
      const externalLink = clicked.closest<HTMLAnchorElement>("a[href]");
      const linkText = link?.textContent?.trim() || "";
      const requestId = ++readerContextMenuRequestIdRef.current;
      const copyText =
        selection ||
        editableSelection ||
        imageSource ||
        linkText ||
        externalLink?.href ||
        "";
      const contextTarget =
        editableSelection || !link?.dataset.wikiTarget
          ? null
          : { kind: "wiki" as const, topic: link.dataset.wikiTarget };

      setReaderContextMenu({
        requestId,
        x: Math.max(
          8,
          Math.min(event.clientX, window.innerWidth - 268),
        ),
        y: Math.max(
          8,
          Math.min(event.clientY, window.innerHeight - 240),
        ),
        target: contextTarget,
        copyText,
        editable,
        clipboardText: null,
      });

      if (!editable) return;

      void readText()
        .then((clipboardText) => {
          setReaderContextMenu((current) =>
            current?.requestId === requestId
              ? {
                  ...current,
                  clipboardText:
                    clipboardText.length > 0 ? clipboardText : null,
                }
              : current,
          );
        })
        .catch(() => {
          setReaderContextMenu((current) =>
            current?.requestId === requestId
              ? { ...current, clipboardText: null }
              : current,
          );
        });
    },
    [clearReaderContextLink],
  );

  const openReaderContextTarget = useCallback(
    (inNewTab: boolean) => {
      const contextTarget = readerContextMenu?.target;
      if (!contextTarget) return;

      if (contextTarget.kind === "wiki") {
        markReaderWikiTargetVisited(contextTarget.topic);
      }

      closeReaderContextMenu();

      if (inNewTab) {
        onOpenInNewTab(contextTarget);
      } else {
        navigate(contextTarget);
      }
    },
    [closeReaderContextMenu, navigate, onOpenInNewTab, readerContextMenu],
  );

  const copyReaderContextText = useCallback(async () => {
    const copyText = readerContextMenu?.copyText;
    if (!copyText) return;

    await writeText(copyText);
    closeReaderContextMenu();
  }, [closeReaderContextMenu, readerContextMenu]);

  const pasteReaderContextText = useCallback(() => {
    const context = readerContextMenu;
    if (!context?.editable || !context.clipboardText) return;

    const input = context.editable;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    const value =
      input.value.slice(0, start) +
      context.clipboardText +
      input.value.slice(end);

    setReaderContextInputValue(input, value);
    input.focus({ preventScroll: true });
    input.setSelectionRange(
      start + context.clipboardText.length,
      start + context.clipboardText.length,
    );
    closeReaderContextMenu();
  }, [closeReaderContextMenu, readerContextMenu]);

  const openReaderContentsFromContextMenu = useCallback(() => {
    const contentsButton = readerRootRef.current?.querySelector<HTMLButtonElement>(
      ".reader-unified-contents-button:not([disabled])",
    );

    if (!contentsButton) return;

    closeReaderContextMenu();
    contentsButton.click();
  }, [closeReaderContextMenu]);

  const returnReaderToTop = useCallback(() => {
    const scope = readerRootRef.current ?? document;

    scope
      .querySelectorAll<HTMLElement>(
        ".browser-content, .wikipedia-reader, .reader-article, .media-reader, .reference-reader",
      )
      .forEach((element) => {
        element.scrollTo({
          top: 0,
          left: 0,
          behavior: "auto",
        });
      });

    closeReaderContextMenu();
  }, [closeReaderContextMenu]);

  useEffect(() => {
    if (!readerContextMenu) return;

    const dismissOnOutsidePointerDown = (event: PointerEvent) => {
      const menu = readerContextMenuRef.current;
      if (menu?.contains(event.target as Node)) return;
      closeReaderContextMenu();
    };

    const dismissOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") closeReaderContextMenu();
    };

    window.addEventListener(
      "pointerdown",
      dismissOnOutsidePointerDown,
      true,
    );
    window.addEventListener("keydown", dismissOnEscape);

    return () => {
      window.removeEventListener(
        "pointerdown",
        dismissOnOutsidePointerDown,
        true,
      );
      window.removeEventListener("keydown", dismissOnEscape);
    };
  }, [closeReaderContextMenu, readerContextMenu]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const scope = readerRootRef.current;
      if (scope) {
        rememberReaderSortableTableDefaults(scope);
        markReaderVisitedWikiLinks(scope);
        centerReaderVerticalSortableHeaders(scope);

        const resetOnOutsideSortablePointerDown = (event: PointerEvent) => {
          const target = event.target;
          if (!(target instanceof Element)) return;
          if (target.closest("table.sortable")) return;
          if (
            target.closest(
              "a, button, input, select, textarea, [role='button'], [data-wiki-target]",
            )
          ) {
            return;
          }

          resetReaderSortableTables();
        };

        scope.addEventListener(
          "pointerdown",
          resetOnOutsideSortablePointerDown,
          true,
        );

        (scope as HTMLElement & {
          __readerResetOnOutsideSortablePointerDown?:
            (event: PointerEvent) => void;
        }).__readerResetOnOutsideSortablePointerDown =
          resetOnOutsideSortablePointerDown;
      }
    });

    const handleResize = () => {
      const scope = readerRootRef.current;
      if (scope) centerReaderVerticalSortableHeaders(scope);
    };

    window.addEventListener("resize", handleResize);

    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", handleResize);

      const scope = readerRootRef.current as
        | (HTMLElement & {
            __readerResetOnOutsideSortablePointerDown?:
              (event: PointerEvent) => void;
          })
        | null;
      const handler = scope?.__readerResetOnOutsideSortablePointerDown;
      if (scope && handler) {
        scope.removeEventListener("pointerdown", handler, true);
        delete scope.__readerResetOnOutsideSortablePointerDown;
      }
    };
  }, [article?.html, currentTarget, readerContextMenu]);

  const handleArticleClick = useCallback((event: MouseEvent<HTMLDivElement>) => {
    const clicked = event.target as HTMLElement;

    const locationMapMarker = clicked.closest<HTMLElement>(
      "[data-reader-location-map-wiki-target]",
    );

    if (locationMapMarker) {
      const topic = locationMapMarker.dataset.readerLocationMapWikiTarget;

      if (topic) {
        event.preventDefault();
        event.stopPropagation();

        markReaderWikiTargetVisited(topic);

        locationMapMarker
          .closest<HTMLElement>(".reader-location-map-point")
          ?.querySelector<HTMLAnchorElement>("a[data-wiki-target]")
          ?.classList.add("reader-visited-link");

        navigate({ kind: "wiki", topic });
        return;
      }
    }

    const imageMapArea = clicked.closest<HTMLAreaElement>("area[href]");
    if (imageMapArea) {
      const href = imageMapArea.getAttribute("href") || "";
      const mapName = imageMapArea.closest("map")?.getAttribute("name") || "";
      let internalPath = href.split("#", 1)[0].match(/^\/wiki\/(.+)$/i);

      if (!internalPath && /^timeline_/i.test(mapName)) {
        try {
          const destination = new URL(href);
          if (
            destination.protocol === "https:" &&
            /(^|\.)wikipedia\.org$/i.test(destination.hostname)
          ) {
            internalPath = destination.pathname.match(/^\/wiki\/(.+)$/i);
          }
        } catch {
          // Ignore malformed image-map destinations.
        }
      }

      if (internalPath) {
        event.preventDefault();
        event.stopPropagation();

        let topic = "";
        try {
          topic = decodeURIComponent(internalPath[1]).replace(/_/g, " ").trim();
        } catch {
          // Ignore malformed percent escapes in map links.
        }

        if (topic) {
          markReaderWikiTargetVisited(topic);
          navigate({ kind: "wiki", topic });
        }

        return;
      }
    }

    // ADAM OSM MAP CLICK FIRST
    const osmClickTarget =
      clicked.closest<HTMLElement>(".reader-osm-map-click-overlay, [data-openstreetmap-url], .reader-openstreetmap-target");

    if (osmClickTarget) {
      const osmTarget =
        osmClickTarget.closest<HTMLElement>("[data-openstreetmap-url]") ||
        osmClickTarget;

      if (osmTarget.dataset.openstreetmapUrl) {
        event.preventDefault();
        event.stopPropagation();
        void openReaderOpenStreetMapTarget(osmTarget);
        return;
      }
    }


    if (sortReaderTableFromClick(clicked)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (clicked.closest(".reader-location-map-panels")) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (clicked.closest(".reader-location-map-controls")) {
      return;
    }

    const mapTarget =
      clicked.closest<HTMLElement>("[data-openstreetmap-url]") ||
      clicked.closest<HTMLElement>(".reader-openstreetmap-target")?.closest<HTMLElement>("[data-openstreetmap-url]");

    if (mapTarget) {
      event.preventDefault();
      event.stopPropagation();
      void openReaderOpenStreetMapTarget(mapTarget);
      return;
    }

    // Caption links can sit over image-card hit areas. Resolve a caption link
    // directly, and fall back to its visible rectangle if another element
    // received the click because of overlapping layout layers.
    const captionLink =
      clicked.closest<HTMLAnchorElement>(
        "figcaption a[data-wiki-target], .thumbcaption a[data-wiki-target], .reader-image-caption a[data-wiki-target]",
      ) ||
      (event.clientX || event.clientY
        ? [...event.currentTarget.querySelectorAll<HTMLAnchorElement>(
            "figcaption a[data-wiki-target], .thumbcaption a[data-wiki-target], .reader-image-caption a[data-wiki-target]",
          )].find((candidate) => {
            const rect = candidate.getBoundingClientRect();
            return (
              event.clientX >= rect.left &&
              event.clientX <= rect.right &&
              event.clientY >= rect.top &&
              event.clientY <= rect.bottom
            );
          }) || null
        : null);

    if (captionLink?.dataset.wikiTarget) {
      event.preventDefault();
      event.stopPropagation();
      const topic = captionLink.dataset.wikiTarget;
      markReaderWikiTargetVisited(topic);
      captionLink.classList.add("reader-visited-link");
      navigate({ kind: "wiki", topic });
      return;
    }

    const clickedImage =
      clicked.closest<HTMLImageElement>("img") ||
      (!clicked.closest(
        'a[href], a[data-wiki-target]:not([data-wiki-target^="File:"]), button, input, select, textarea, [role="button"]',
      ) &&
      (event.clientX !== 0 || event.clientY !== 0)
        ? [...event.currentTarget.querySelectorAll<HTMLImageElement>("img")].find(
            (image) => {
              const rect = image.getBoundingClientRect();
              return (
                rect.width > 0 &&
                rect.height > 0 &&
                event.clientX >= rect.left &&
                event.clientX <= rect.right &&
                event.clientY >= rect.top &&
                event.clientY <= rect.bottom
              );
            },
          ) || null
        : null);
    const clickedFileLink = clicked.closest<HTMLAnchorElement>(
      'a[data-wiki-target^="File:"]',
    );
    const clickedInlineSvgLogo =
      clicked.closest<SVGSVGElement>(
        "svg.reader-inline-infobox-svg-logo[data-reader-source]",
      ) ??
      clickedFileLink?.querySelector<SVGSVGElement>(
        "svg.reader-inline-infobox-svg-logo[data-reader-source]",
      ) ??
      null;
    const clickedMedia = clickedImage || clickedInlineSvgLogo;
    const isGraphicalTimelineImage = Boolean(
      clickedImage?.useMap && /^#?timeline_/i.test(clickedImage.useMap),
    );

    // Some WebKit image-map clicks arrive with the image as the event target
    // instead of the matching <area>. Resolve the existing map region from
    // the image's rendered bounds so those clicks still follow the area's link.
    if (!imageMapArea && isGraphicalTimelineImage && clickedImage) {
      const mapName = clickedImage.useMap.replace(/^#/, "");
      const imageRect = clickedImage.getBoundingClientRect();
      const imageMap = [
        ...event.currentTarget.querySelectorAll<HTMLMapElement>("map"),
      ].find((candidate) => candidate.name === mapName);

      if (
        imageMap &&
        imageRect.width > 0 &&
        imageRect.height > 0 &&
        event.clientX >= imageRect.left &&
        event.clientX <= imageRect.right &&
        event.clientY >= imageRect.top &&
        event.clientY <= imageRect.bottom
      ) {
        const imageX =
          ((event.clientX - imageRect.left) * clickedImage.naturalWidth) /
          imageRect.width;
        const imageY =
          ((event.clientY - imageRect.top) * clickedImage.naturalHeight) /
          imageRect.height;
        const imageMapAreas = [...imageMap.areas].filter(
          (area): area is HTMLAreaElement => area instanceof HTMLAreaElement,
        );
        const imageMapArea = imageMapAreas.find((area) => {
          const coords = area.coords.split(",").map(Number);
          if (coords.some((coordinate) => !Number.isFinite(coordinate))) {
            return false;
          }

          const shape = area.shape.toLowerCase();
          if (shape === "circle" && coords.length >= 3) {
            const [centerX, centerY, radius] = coords;
            return (
              (imageX - centerX) ** 2 + (imageY - centerY) ** 2 <=
              radius ** 2
            );
          }

          if (shape === "poly" && coords.length >= 6 && coords.length % 2 === 0) {
            let inside = false;
            for (let index = 0, previous = coords.length - 2; index < coords.length; previous = index, index += 2) {
              const currentX = coords[index];
              const currentY = coords[index + 1];
              const previousX = coords[previous];
              const previousY = coords[previous + 1];
              if (
                (currentY > imageY) !== (previousY > imageY) &&
                imageX <
                  ((previousX - currentX) * (imageY - currentY)) /
                    (previousY - currentY) +
                    currentX
              ) {
                inside = !inside;
              }
            }
            return inside;
          }

          if (coords.length < 4) return false;
          const [left, top, right, bottom] = coords;
          return (
            imageX >= Math.min(left, right) &&
            imageX <= Math.max(left, right) &&
            imageY >= Math.min(top, bottom) &&
            imageY <= Math.max(top, bottom)
          );
        });

        if (imageMapArea?.href) {
          const href = imageMapArea.getAttribute("href") || "";
          let internalPath = href.split("#", 1)[0].match(/^\/wiki\/(.+)$/i);

          if (!internalPath) {
            try {
              const destination = new URL(href);
              if (
                destination.protocol === "https:" &&
                /(^|\.)wikipedia\.org$/i.test(destination.hostname)
              ) {
                internalPath = destination.pathname.match(/^\/wiki\/(.+)$/i);
              }
            } catch {
              // Ignore malformed image-map destinations.
            }
          }

          if (internalPath) {
            let topic = "";
            try {
              topic = decodeURIComponent(internalPath[1])
                .replace(/_/g, " ")
                .trim();
            } catch {
              // Ignore malformed percent escapes in map links.
            }

            if (topic) {
              event.preventDefault();
              event.stopPropagation();
              markReaderWikiTargetVisited(topic);
              navigate({ kind: "wiki", topic });
              return;
            }
          }
        }
      }
    }

    const imageCard =
      clickedMedia?.closest<HTMLElement>(
        [
          "figure",
          ".thumb",
          ".mw-default-size",
          ".infobox-image",
          ".infobox-full-data",
          ".reader-infobox-top-media-cell",
          "td",
          "th",
        ].join(", "),
      ) ?? null;

    if (
      clickedMedia &&
      imageCard &&
      !clickedMedia.closest(".reader-video-host") &&
      !isGraphicalTimelineImage
    ) {
      const source =
        clickedImage?.dataset.readerDeferredSrc ||
        clickedImage?.currentSrc ||
        clickedImage?.getAttribute("src") ||
        clickedInlineSvgLogo?.dataset.readerSource ||
        "";

      if (source) {
        const multipleImageBlock = clickedMedia.closest<HTMLElement>(
          ".reader-multiple-image-block, .tmulti",
        );
        const multipleImageCaption = multipleImageBlock
          ? (() => {
              const images = [
                ...multipleImageBlock.querySelectorAll("img"),
              ];
              const captions = [
                ...multipleImageBlock.querySelectorAll<HTMLElement>(
                  ".thumbcaption, figcaption, .reader-image-caption",
                ),
              ];
              const imageIndex = clickedImage ? images.indexOf(clickedImage) : -1;
              return imageIndex >= 0 ? captions[imageIndex] : undefined;
            })()
          : undefined;
        const sourceCaption =
          multipleImageCaption ||
          imageCard.querySelector<HTMLElement>(
            "figcaption, .thumbcaption, .reader-image-caption, .infobox-caption",
          );

        event.preventDefault();
        event.stopPropagation();
        closeReaderContextMenu();
        const fileTarget =
          clickedMedia.closest<HTMLAnchorElement>("a[data-wiki-target]")
            ?.dataset.wikiTarget || readerFileTitleFromImageSource(source);
        const fileDetails = getReaderImageFileDetails(fileTarget, source);
        const warpOverlaySource =
          clickedInlineSvgLogo && /Warp_ADE_logo/i.test(source)
            ? (() => {
                const overlaySvg = clickedInlineSvgLogo.cloneNode(
                  true,
                ) as SVGSVGElement;
                const logoColor = getComputedStyle(clickedInlineSvgLogo).color;

                overlaySvg.removeAttribute("class");
                overlaySvg.removeAttribute("style");
                overlaySvg.removeAttribute("data-reader-source");
                overlaySvg.setAttribute(
                  "xmlns",
                  "http://www.w3.org/2000/svg",
                );
                overlaySvg
                  .querySelectorAll<SVGPathElement>('path[fill="currentColor"]')
                  .forEach((path) => path.setAttribute("fill", logoColor));

                const markup = new XMLSerializer().serializeToString(overlaySvg);
                return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
              })()
            : null;

        setReaderImageLightboxLightPanel(false);
        setReaderImageLightbox({
          source: warpOverlaySource || getReaderMediumImageSource(source),
          fallbackSource: source,
          alt:
            clickedImage?.alt ||
            clickedInlineSvgLogo?.getAttribute("aria-label") ||
            "",
          captionHtml: sourceCaption?.innerHTML || "",
          preserveSkinInvert: Boolean(clickedImage?.closest(".skin-invert")),
          ...fileDetails,
        });
        return;
      }
    }

    const link = clicked.closest<HTMLAnchorElement>("a[data-wiki-target]");

    if (link) {
      event.preventDefault();
      const topic = link.dataset.wikiTarget;

      if (topic) {
        markReaderWikiTargetVisited(topic);
        link.classList.add("reader-visited-link");
        navigate({ kind: "wiki", topic });
      }

      return;
    }
  }, [closeReaderContextMenu, navigate]);

  const browserControls = (
    <div
      className={
        toolbarVisible
          ? "browser-controls"
          : "browser-controls reader-toolbar-hidden"
      }
      data-reader-toolbar-pane={toolbarPane}
    >
      <button
        type="button"
        aria-label="Back"
        disabled={sectionHistoryIndex <= 0 && historyIndex <= 0}
        onClick={moveBack}
      >
        ←
      </button>
      <button
        type="button"
        aria-label="Forward"
        disabled={sectionHistoryIndex >= sectionHistory.length - 1 && (historyIndex < 0 || historyIndex >= history.length - 1)}
        onClick={moveForward}
      >
        →
      </button>
      <button
        type="button"
        aria-label="Reload"
        disabled={!currentTarget || currentTarget.kind !== "wiki" || status === "loading"}
        onClick={reloadCurrentReader}
        title="Reload"
      >
        ↻
      </button>
      <form className="wiki-search-form" onSubmit={submitSearch}>
        <input
          aria-label="Search Wikipedia"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="Search Wikipedia"
          value={search}
          onBlur={() => window.setTimeout(() => setSuggestionsOpen(false), 120)}
          onChange={(event) => {
            setSearch(event.target.value);
            setSuggestionsOpen(true);
          }}
          onFocus={() => {
            if (suggestions.length > 0) setSuggestionsOpen(true);
          }}
          onKeyDown={handleSearchKeyDown}
        />

        {suggestionsOpen && suggestions.length > 0 && (
          <div
            ref={searchSuggestionsRef}
            className="search-suggestions"
            role="listbox"
          >
            {suggestions.map((suggestion, index) => (
              <button
                key={suggestion.title}
                type="button"
                className={index === selectedSuggestionIndex ? "selected" : ""}
                role="option"
                aria-selected={index === selectedSuggestionIndex}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => chooseSuggestion(suggestion)}
              >
                <span className="search-suggestion-thumb" aria-hidden="true">
                  {suggestion.imageUrl ? (
                    <img src={suggestion.imageUrl} alt="" loading="lazy" />
                  ) : null}
                </span>
                <span className="search-suggestion-text">
                  <strong>{suggestion.title}</strong>
                  {suggestion.description && (
                    <span className="search-suggestion-description">
                      {suggestion.description}
                    </span>
                  )}
                </span>
              </button>
            ))}
          </div>
        )}
        {suggestionsOpen && suggestions.length > 0 && searchScrollbarMetrics.maxScrollTop > 0 && (
          <div
            className="wiki-search-scrollbar-thumb"
            role="scrollbar"
            aria-label="Search suggestions"
            aria-orientation="vertical"
            aria-valuemin={0}
            aria-valuemax={Math.round(searchScrollbarMetrics.maxScrollTop)}
            aria-valuenow={Math.round(searchScrollbarMetrics.scrollTop)}
            onPointerDown={handleSearchScrollbarPointerDown}
            onPointerMove={handleSearchScrollbarPointerMove}
            onPointerUp={stopSearchScrollbarDrag}
            onPointerCancel={stopSearchScrollbarDrag}
            style={{
              height: `${searchScrollbarMetrics.height}px`,
              top: `${searchScrollbarMetrics.top}px`,
            }}
          />
        )}
      </form>
      <button
        aria-label="Voice search"
        className="reader-search-voice-button"
        title="Voice search"
        type="button"
        onClick={startReaderVoiceSearch}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="M12 14.25c1.7 0 3-1.3 3-3V6.75c0-1.7-1.3-3-3-3s-3 1.3-3 3v4.5c0 1.7 1.3 3 3 3Z" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M18.25 10.75a6.25 6.25 0 0 1-12.5 0" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M12 17v3.25" strokeWidth="1.9" strokeLinecap="round" />
          <path d="M8.75 20.25h6.5" strokeWidth="1.9" strokeLinecap="round" />
        </svg>
      </button>
      <button
        aria-label={readerToolsVisible ? "Hide reader tools" : "Show reader tools"}
        aria-pressed={readerToolsVisible}
        className="reader-tools-toggle"
        disabled={!onToggleReaderTools}
        title={readerToolsVisible ? "Hide reader tools" : "Show reader tools"}
        type="button"
        onClick={onToggleReaderTools}
      >
        <svg aria-hidden="true" viewBox="0 0 24 24">
          <path d="m6 15 6-6 6 6" />
        </svg>
      </button>
      {openUrl && (
        <a
          className="reader-open-external-link"
          href={openUrl}
          rel="noreferrer"
          target="_blank"
          title="Open externally"
        >
          ↗
        </a>
      )}
    </div>
  );

  return (
    <div
      ref={readerRootRef}
      className={`research-browser${
        readerImageLightbox ? " reader-image-lightbox-open" : ""
      }`}
      onContextMenu={handleReaderContextMenu}
      onMouseDownCapture={handleReaderContextMouseDownCapture}
    >
      {toolbarHost ? createPortal(browserControls, toolbarHost) : browserControls}
      {/*
        <button
          type="button"
          aria-label="Back"
          disabled={sectionHistoryIndex <= 0 && historyIndex <= 0}
          onClick={moveBack}
        >
          ←
        </button>
        <button
          type="button"
          aria-label="Forward"
          disabled={sectionHistoryIndex >= sectionHistory.length - 1 && (historyIndex < 0 || historyIndex >= history.length - 1)}
          onClick={moveForward}
        >
          →
        </button>
        <button
          type="button"
          aria-label="Reload"
          disabled={!currentTarget || currentTarget.kind !== "wiki" || status === "loading"}
          onClick={reloadCurrentReader}
          title="Reload"
        >
          ↻
        </button>
        <form className="wiki-search-form" onSubmit={submitSearch}>
  <input
    aria-label="Search Wikipedia"
    autoComplete="off"
    autoCorrect="off"
    autoCapitalize="none"
    spellCheck={false}
    placeholder="Search Wikipedia"
    value={search}
    onBlur={() => window.setTimeout(() => setSuggestionsOpen(false), 120)}
    onChange={(event) => {
      setSearch(event.target.value);
      setSuggestionsOpen(true);
    }}
    onFocus={() => {
      if (suggestions.length > 0) setSuggestionsOpen(true);
    }}
    onKeyDown={handleSearchKeyDown}
  />

  {suggestionsOpen && suggestions.length > 0 && (
    <div className="search-suggestions" role="listbox">
      {suggestions.map((suggestion, index) => (
        <button
          key={suggestion.title}
          type="button"
          className={index === selectedSuggestionIndex ? "selected" : ""}
          role="option"
          aria-selected={index === selectedSuggestionIndex}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => chooseSuggestion(suggestion)}
        >
          <span className="search-suggestion-thumb" aria-hidden="true">
            {suggestion.imageUrl ? (
              <img src={suggestion.imageUrl} alt="" loading="lazy" />
            ) : null}
          </span>
          <span className="search-suggestion-text">
            <strong>{suggestion.title}</strong>
            {suggestion.description && (
              <span className="search-suggestion-description">
                {suggestion.description}
              </span>
            )}
          </span>
        </button>
      ))}
    </div>
  )}
</form>
        <button
          aria-label="Voice search"
          className="reader-search-voice-button"
          title="Voice search"
          type="button"
          onClick={startReaderVoiceSearch}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path
              d="M12 14.25c1.7 0 3-1.3 3-3V6.75c0-1.7-1.3-3-3-3s-3 1.3-3 3v4.5c0 1.7 1.3 3 3 3Z"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d="M18.25 10.75a6.25 6.25 0 0 1-12.5 0"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path d="M12 17v3.25" strokeWidth="1.9" strokeLinecap="round" />
            <path d="M8.75 20.25h6.5" strokeWidth="1.9" strokeLinecap="round" />
          </svg>
        </button>
        {openUrl && (
          <a
            className="reader-open-external-link"
            href={openUrl}
            rel="noreferrer"
            target="_blank"
            title="Open externally"
          >
            ↗
          </a>
        )}
      </div>
      */}

      {findOpen && (
        <div className="reader-find-box" role="search" aria-label="Find on page">
          <input
            ref={findInputRef}
            aria-label="Find on page"
            autoComplete="off"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            placeholder="Find on page"
            value={findQuery}
            onChange={(event) => setFindQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setFindOpen(false);
              } else if (event.key === "Enter") {
                event.preventDefault();

                const trimmedFindQuery = findQuery.trim();

                if (trimmedFindQuery.length < READER_FIND_MIN_QUERY_LENGTH) return;

                if (findMatchCount <= 0) {
                  const nextCount = highlightReaderFindMatches(trimmedFindQuery);
                  setFindMatchCount(nextCount);
                  setFindActiveIndex(0);
                  setFindMarkerPositions(getReaderFindMarkerPositions());

                  if (nextCount > 0) {
                    activateReaderFindMatch(0);
                  }

                  return;
                }

                moveFindMatch(event.shiftKey ? -1 : 1);
              }
            }}
          />
          <span className="reader-find-count">
            {findQuery.trim().length >= READER_FIND_MIN_QUERY_LENGTH
              ? findMatchCount > 0
                ? `${findActiveIndex + 1} of ${findMatchCount}`
                : "No results"
              : ""}
          </span>
          <button
            type="button"
            aria-label="Previous match"
            disabled={findMatchCount <= 0}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => moveFindMatch(-1)}
          >
            ↑
          </button>
          <button
            type="button"
            aria-label="Next match"
            disabled={findMatchCount <= 0}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => moveFindMatch(1)}
          >
            ↓
          </button>
          <button
            type="button"
            aria-label="Close find"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => setFindOpen(false)}
          >
            ×
          </button>
        </div>
      )}

      <div
        className="browser-content"
        style={{
          "--reader-zoom": readerZoom.toString(),
          position: "relative",
        } as CSSProperties}
      >
        <div
          style={{
            visibility:
              readerSettling || readerInfoboxSettling ? "hidden" : "visible",
          }}
        >
          <MemoReaderContent
            article={article}
            currentTarget={currentTarget}
            media={media}
            loadedTargetKey={loadedTargetKey}
            onArticleClick={handleArticleClick}
            onLandingSearch={navigate}
            onSectionNavigate={navigateSection}
            status={status}
            suppressLoadingIndicator={readerSettling}
            isActive={active}
          />
        </div>

        {(readerSettling || readerInfoboxSettling) && (
          <div
            className="reader-loading"
            style={{
              position: "absolute",
              inset: 0,
              zIndex: 20,
              background: "transparent",
            }}
          >
            <span />
            <p>
              {readerInfoboxSettling
                ? `Loading ${article?.title || (currentTarget?.kind === "wiki"
                    ? cleanTopic(currentTarget.topic)
                    : "page")}…`
                : `Back to ${article?.title || (currentTarget?.kind === "wiki"
                    ? cleanTopic(currentTarget.topic)
                    : "previous page")}…`}
            </p>
          </div>
        )}

        {findOpen && findMarkerPositions.length > 0 && (
          <div className="reader-find-scroll-markers" aria-hidden="true">
            {findMarkerPositions.map((position, index) => (
              <span
                key={`${index}-${position.toFixed(2)}`}
                className={
                  index === findActiveIndex
                    ? "reader-find-scroll-marker reader-find-scroll-marker-active"
                    : "reader-find-scroll-marker"
                }
                style={{ top: `${position}%` }}
              />
            ))}
          </div>
        )}
      </div>

      {readerImageLightbox && (
        <div
          ref={readerImageLightboxOverlayRef}
          className={`reader-image-lightbox${
            readerImageLightboxLightPanel ? " reader-image-lightbox-light-panel" : ""
          }`}
          role="presentation"
          style={{ visibility: "hidden" }}
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              closeReaderImageLightbox();
            }
          }}
        >
          <section
            ref={readerImageLightboxBoxRef}
            aria-label={readerImageLightbox.alt || "Enlarged image"}
            aria-modal="true"
            className="reader-image-lightbox-box"
            role="dialog"
          >
            <button
              aria-label="Close image"
              className="reader-image-lightbox-close"
              type="button"
              onClick={closeReaderImageLightbox}
            >
              <span aria-hidden="true">×</span>
            </button>
            <button
              aria-label={
                readerImageLightboxLightPanel
                  ? "Restore dark panel background"
                  : "Lighten panel background"
              }
              aria-pressed={readerImageLightboxLightPanel}
              className="reader-image-lightbox-panel-theme-toggle"
              title={
                readerImageLightboxLightPanel
                  ? "Restore dark panel background"
                  : "Lighten panel background"
              }
              type="button"
              onClick={() => setReaderImageLightboxLightPanel((light) => !light)}
            >
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="3.5" />
                <path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" />
              </svg>
            </button>
            <img
              key={readerImageLightbox.source}
              ref={readerImageLightboxImageRef}
              alt={readerImageLightbox.alt}
              className={`reader-image-lightbox-image${
                readerImageLightbox.preserveSkinInvert
                  ? " reader-image-lightbox-skin-invert"
                  : ""
              }`}
              src={readerImageLightbox.source}
              onLoad={fitReaderImageLightbox}
              onError={(event) => {
                const failedImage = event.currentTarget;

                if (failedImage.dataset.readerFallbackAttempted === "true") {
                  closeReaderImageLightbox();
                  return;
                }

                failedImage.dataset.readerFallbackAttempted = "true";
                failedImage.src = readerImageLightbox.fallbackSource;
              }}
            />
            <div
              ref={readerImageLightboxCaptionRef}
              className="reader-image-lightbox-caption"
              dangerouslySetInnerHTML={{
                __html: readerImageLightbox.captionHtml,
              }}
              onClick={handleReaderImageLightboxCaptionClick}
            />
          </section>
          <footer className="reader-image-lightbox-attribution">
            <div className="reader-image-lightbox-attribution-text">
              {readerImageAttribution?.author && (
                <>
                  Author:{" "}
                  {readerImageAttribution.authorUrl ? (
                    <a
                      href={readerImageAttribution.authorUrl}
                      onClick={(event) => {
                        event.preventDefault();
                        void openExternalUrl(readerImageAttribution.authorUrl!);
                      }}
                    >
                      {readerImageAttribution.author}
                    </a>
                  ) : (
                    readerImageAttribution.author
                  )}
                </>
              )}
              {readerImageAttribution?.ownWork && (
                <>
                  {readerImageAttribution.author && "  –  "}
                  Own work
                </>
              )}
              {!readerImageAttribution?.ownWork &&
                readerImageAttribution?.sourceUrl && (
                  <>
                    {readerImageAttribution.author && "  –  "}
                    <a
                      href={readerImageAttribution.sourceUrl}
                      onClick={(event) => {
                        event.preventDefault();
                        void openExternalUrl(readerImageAttribution.sourceUrl!);
                      }}
                    >
                      {readerImageAttribution.sourceUrl}
                    </a>
                  </>
                )}
            </div>
            {readerImageLightbox.filePageUrl &&
              readerImageLightbox.fileHostLabel && (
                <button
                  className="reader-image-lightbox-footer-external"
                  type="button"
                  onClick={() => {
                    void openExternalUrl(readerImageLightbox.filePageUrl!);
                  }}
                >
                  Open on {readerImageLightbox.fileHostLabel} ↗
                </button>
              )}
          </footer>
        </div>
      )}

      {readerContextMenu && (
        <div
          ref={readerContextMenuRef}
          className="reader-context-menu"
          role="menu"
          style={{
            left: readerContextMenu.x,
            top: readerContextMenu.y,
          }}
        >
          <button
            type="button"
            role="menuitem"
            disabled={!readerContextMenu.target}
            onClick={() => openReaderContextTarget(true)}
          >
            Open in new tab
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!readerContextMenu.target}
            onClick={() => openReaderContextTarget(false)}
          >
            Open in this tab
          </button>          <button
            type="button"
            role="menuitem"
            disabled={!readerContextMenu.copyText}
            onClick={() => void copyReaderContextText()}
          >
            Copy
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!readerContextMenu.editable || !readerContextMenu.clipboardText}
            onClick={pasteReaderContextText}
          >
            Paste
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!article || article.sections.length === 0}
            onClick={openReaderContentsFromContextMenu}
          >
            Contents
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={sectionHistoryIndex <= 0 && historyIndex <= 0}
            onClick={() => {
              moveBack();
              closeReaderContextMenu();
            }}
          >
            Back
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!article}
            onClick={returnReaderToTop}
          >
            Back to top
          </button>
        </div>
      )}
    </div>
  );
}



type ReaderSortKey =
  | { kind: "empty"; value: string }
  | { kind: "number"; value: number }
  | { kind: "date"; value: number }
  | { kind: "text"; value: string };

function readerSortableKey(text: string): ReaderSortKey {
  const cleaned = text
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned) return { kind: "empty", value: "" };

  const dateCandidate = cleaned.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0];
  if (dateCandidate) {
    const time = Date.parse(dateCandidate);
    if (Number.isFinite(time)) return { kind: "date", value: time };
  }

  const numberCandidate = cleaned
    .replace(/,/g, "")
    .replace(/[−–—]/g, "-")
    .match(/^-?\d+(?:\.\d+)?%?$/)?.[0];

  if (numberCandidate) {
    const value = Number(numberCandidate.replace("%", ""));
    if (Number.isFinite(value)) return { kind: "number", value };
  }

  return { kind: "text", value: cleaned.toLocaleLowerCase() };
}

function compareReaderSortKeys(left: ReaderSortKey, right: ReaderSortKey) {
  if (left.kind === "empty" && right.kind === "empty") return 0;
  if (left.kind === "empty") return 1;
  if (right.kind === "empty") return -1;

  if (left.kind === right.kind && left.kind !== "text") {
    return Number(left.value) - Number(right.value);
  }

  if (left.kind === "number" && right.kind === "number") {
    return left.value - right.value;
  }

  if (left.kind === "date" && right.kind === "date") {
    return left.value - right.value;
  }

  return String(left.value).localeCompare(String(right.value), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

function updateReaderStaticRowNumbersAfterSort(table: HTMLTableElement) {
  let rowNumber = 0;

  Array.from(table.rows).forEach((row) => {
    if (!row.querySelector("td")) return;
    if (readerRowLooksLikeSortableFooterRow(row)) return;

    const numberCell = row.querySelector<HTMLElement>(".reader-static-row-number-cell");
    if (!numberCell) return;

    rowNumber += 1;
    numberCell.textContent = String(rowNumber);
    numberCell.setAttribute("aria-label", `Row ${rowNumber}`);
  });
}

function readerSortableCellPlainText(cell: Element | null) {
  return (cell?.textContent || "")
    .replace(/\[\s*edit\s*\]/gi, "")
    .replace(/[▲▼↕⇅↕]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function readerRowLooksLikeSortableFooterRow(row: HTMLTableRowElement) {
  if (row.closest("thead")) return false;
  if (row.closest("tfoot")) return true;

  if (
    row.classList.contains("reader-sortable-footer-row") ||
    row.classList.contains("reader-county-results-totals-row") ||
    row.dataset.readerPinRow === "bottom" ||
    row.classList.contains("sortbottom") ||
    row.querySelector(".sortbottom")
  ) {
    return true;
  }

  const cells = Array.from(row.cells);
  if (!cells.length) return false;

  const firstText = readerSortableCellPlainText(cells[0]).toLowerCase();
  const wholeText = cells
    .map((cell) => readerSortableCellPlainText(cell))
    .join(" ")
    .toLowerCase();

  // Common Wikipedia summary rows: "Total cities", "Total", "Totals", etc.
  if (/^(total|totals|grand total|overall total)\b/.test(firstText)) return true;

  if (
    /\btotal\s+(cities|towns|villages|municipalities|communities|population|area|land area|density)\b/.test(
      firstText,
    )
  ) {
    return true;
  }

  // Safety fallback for rows where the first cell is split oddly.
  if (/^total\b/.test(wholeText) && cells.length > 1) return true;

  return false;
}


function pinReaderSortableFooterRowsToBottom(table: HTMLTableElement) {
  Array.from(table.tBodies).forEach((tbody) => {
    const footerRows = Array.from(tbody.rows).filter((row) =>
      readerRowLooksLikeSortableFooterRow(row),
    );

    footerRows.forEach((row) => {
      if (tbody.lastElementChild !== row) {
        tbody.appendChild(row);
      }
    });
  });
}

function pinReaderAllSortableFooterRowsToBottom(document: Document) {
  document
    .querySelectorAll<HTMLTableElement>("table.sortable")
    .forEach((table) => {
      pinReaderSortableFooterRowsToBottom(table);
    });
}

function scheduleReaderSortableFooterRowsPin(table: HTMLTableElement) {
  pinReaderSortableFooterRowsToBottom(table);

  window.requestAnimationFrame(() => {
    pinReaderSortableFooterRowsToBottom(table);
  });

  window.setTimeout(() => {
    pinReaderSortableFooterRowsToBottom(table);
  }, 80);
}

function markReaderExternalTableCaptions(document: Document) {
  document.querySelectorAll<HTMLTableElement>("table").forEach((table) => {
    if (
      table.closest(
        ".infobox, .navbox, .vertical-navbox, .metadata, .ambox, .ombox, .tmbox",
      )
    ) {
      return;
    }

    const caption = table.querySelector<HTMLTableCaptionElement>(":scope > caption");
    if (!caption) return;

    const captionText = (caption.textContent || "").replace(/\s+/g, " ").trim();
    if (!captionText) {
      caption.remove();
      return;
    }

    if (table.closest(".reader-table-caption-group")) return;

    const target =
      table.closest<HTMLElement>(
        ".reader-scrollable-sortable-table, .reader-table-scroll, .reader-table-wrapper",
      ) || table;

    const parent = target.parentElement;
    if (!parent) return;

    const normalizedMinneapolisCaption = captionText
      .replace(/\[\s*\d+\s*\]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    const minneapolisTableClass =
      normalizedMinneapolisCaption === "Largest downtown Minneapolis employers 2024"
        ? "reader-minneapolis-employers-table"
        : normalizedMinneapolisCaption === "Largest Minneapolis companies by revenue 2025"
          ? "reader-minneapolis-revenue-table"
          : null;

    if (minneapolisTableClass) {
      table.classList.add(minneapolisTableClass);
      target.classList.add(`${minneapolisTableClass}-target`);
    }

    const targetClass = target.className?.toString() || "";
    const tableClass = table.className?.toString() || "";
    const classText = `${targetClass} ${tableClass}`;
    const tableStyle = table.getAttribute("style") || "";
    const targetStyle = target.getAttribute("style") || "";
    const styleText = `${targetStyle} ${tableStyle}`;

    const isRightFloatedCaptionedTable =
      /\b(floatright|tright|mw-halign-right)\b/i.test(classText) ||
      /(?:^|;)\s*float\s*:\s*right\b/i.test(styleText) ||
      /(?:^|;)\s*display\s*:\s*inline-table\b/i.test(styleText);

    if (isRightFloatedCaptionedTable) {
      table.classList.add("reader-table-kept-caption");
      return;
    }

    const group = document.createElement("div");
    group.className = "reader-table-caption-group";

    if (minneapolisTableClass) {
      group.classList.add(`${minneapolisTableClass}-group`);
    }

    if (/\b(floatright|tright|mw-halign-right)\b/i.test(classText)) {
      group.classList.add("reader-table-caption-group-right");
    } else if (/\b(floatleft|tleft|mw-halign-left)\b/i.test(classText)) {
      group.classList.add("reader-table-caption-group-left");
    } else if (/\b(center|tnone|mw-halign-center)\b/i.test(classText)) {
      group.classList.add("reader-table-caption-group-center");
    } else {
      group.classList.add("reader-table-caption-group-left");
    }

    const externalCaption = document.createElement("div");
    externalCaption.className = "reader-table-external-caption";
    if (captionText === "Aggregate scores" || captionText === "Review scores") {
      group.classList.add("reader-reception-score-group");
    }

    while (caption.firstChild) {
      externalCaption.appendChild(caption.firstChild);
    }

    caption.remove();

    parent.insertBefore(group, target);
    group.appendChild(externalCaption);
    group.appendChild(target);

    table.classList.add("reader-table-has-external-caption");
  });
}


function markReaderBarBoxes(document: Document) {
  const getCells = (row: HTMLTableRowElement) =>
    Array.from(row.children).filter(
      (element): element is HTMLTableCellElement => /^(td|th)$/i.test(element.tagName),
    );

  const getPreservedBar = (cell: HTMLTableCellElement) =>
    cell.querySelector<HTMLElement>(
      ".reader-preserved-background, [style*='--reader-preserved-background']",
    ) ||
    Array.from(cell.querySelectorAll<HTMLElement>("div, span")).find((element) => {
      const width = element.style.width.trim();
      const background =
        element.style.getPropertyValue("--reader-preserved-background").trim() ||
        element.style.backgroundColor ||
        element.style.background;

      return /^\d+(?:\.\d+)?px$/i.test(width) && Boolean(background);
    }) || null;

  const getCountRows = (table: HTMLTableElement) =>
    Array.from(table.querySelectorAll<HTMLTableRowElement>("tr"))
      .map((row) => {
        const cells = getCells(row);
        const countText = (cells[cells.length - 1]?.textContent || "")
          .replace(/\s+/g, " ")
          .trim();
        const countMatch = countText.match(/^(\d+(?:\.\d+)?)$/);
        const bar = cells.length >= 3 ? getPreservedBar(cells[1]) : null;
        const hasPixelWidth = Boolean(bar && /^\d+(?:\.\d+)?px$/i.test(bar.style.width.trim()));

        return countMatch && hasPixelWidth
          ? { row, cells, count: Number.parseFloat(countMatch[1]), bar }
          : null;
      })
      .filter(
        (entry): entry is NonNullable<typeof entry> => entry !== null,
      );

  document.querySelectorAll<HTMLElement>(".barbox").forEach((barbox) => {
    const tables = Array.from(barbox.querySelectorAll<HTMLTableElement>("table"));
    const table = tables.find((candidate) => {
      const text = (candidate.textContent || "").replace(/\s+/g, " ").trim();
      const hasPercentData =
        /\d+(?:\.\d+)?\s*%/.test(text) &&
        Boolean(
          candidate.querySelector(
            ".reader-preserved-background, [style*='--reader-preserved-background']",
          ),
        );

      return hasPercentData || getCountRows(candidate).length >= 2;
    });

    if (!table) return;

    const countRows = getCountRows(table);
    const isCountBarTable = countRows.length >= 2;
    const maxCount = isCountBarTable
      ? Math.max(...countRows.map((entry) => entry.count))
      : 0;

    barbox.classList.add("reader-barbox");
    table.classList.add("reader-barbox-table");

    const captionGroup = table.closest<HTMLElement>(
      ".reader-table-caption-group, .reader-table-caption-group-right",
    );
    captionGroup?.classList.add("reader-barbox-table-group");

    if (isCountBarTable) {
      table.classList.add("reader-barbox-count-table");
      captionGroup?.classList.add("reader-barbox-count-table-group");

      const headerRow = Array.from(table.querySelectorAll<HTMLTableRowElement>("tr")).find(
        (row) => getCells(row).some((cell) => /^th$/i.test(cell.tagName)),
      );
      const headerCells = headerRow ? getCells(headerRow) : [];
      const relativeHeader = headerCells[1];
      const countHeader = headerCells[headerCells.length - 1];

      if (relativeHeader && !relativeHeader.textContent?.trim()) {
        relativeHeader.textContent = "Relative";
      }
      if (countHeader && !countHeader.textContent?.trim()) {
        countHeader.textContent = "Count";
      }
    }

    Array.from(table.querySelectorAll<HTMLTableRowElement>("tr")).forEach((row) => {
      const rowText = (row.textContent || "").replace(/\s+/g, " ").trim();

      if (!rowText) {
        row.classList.add("reader-barbox-empty-row");
        return;
      }

      const cells = getCells(row);
      if (cells.length < 3) return;

      const labelCell = cells[0];
      const barCell = cells[1];
      const valueCell = cells[cells.length - 1];
      const valueText = (valueCell.textContent || "").replace(/\s+/g, " ").trim();
      const percentMatch = valueText.match(/(\d+(?:\.\d+)?)\s*%/);
      const countMatch = valueText.match(/^(\d+(?:\.\d+)?)$/);

      if (!percentMatch && !(isCountBarTable && countMatch)) return;

      const rawValue = Number.parseFloat((percentMatch || countMatch)![1]);
      const percent = percentMatch
        ? Math.max(0, Math.min(100, rawValue))
        : maxCount > 0
          ? Math.max(0, Math.min(100, (rawValue / maxCount) * 100))
          : 0;
      const bar = getPreservedBar(barCell);

      if (!bar) return;

      labelCell.classList.add("reader-barbox-label-cell");
      barCell.classList.add("reader-barbox-bar-cell");
      valueCell.classList.add("reader-barbox-percent-cell");

      bar.classList.add("reader-barbox-real-bar");
      bar.style.setProperty("--reader-barbox-percent", `${percent}%`);
    });
  });
}


function markReaderCountyResultsTotalsRows(document: Document) {
  const clean = (value: string | null | undefined) =>
    String(value || "").replace(/\s+/g, " ").trim();

  const looksLikeCountyResultsTable = (table: HTMLTableElement) => {
    const text = clean(table.textContent);

    return (
      /County/i.test(text) &&
      /Totals/i.test(text) &&
      /Total votes cast/i.test(text) &&
      /Margin/i.test(text)
    );
  };

  const rowLooksLikeTotalsRow = (row: HTMLTableRowElement) => {
    if (row.closest("thead")) return false;

    const cells = Array.from(row.cells);
    if (!cells.length) return false;

    const firstMeaningfulText =
      cells
        .slice(0, 3)
        .map((cell) => clean(cell.textContent))
        .find(Boolean) || "";

    return /^Totals$/i.test(firstMeaningfulText);
  };

  document.querySelectorAll<HTMLTableElement>("table").forEach((table) => {
    if (!looksLikeCountyResultsTable(table)) return;

    table.classList.add("reader-county-results-sortable-table");

    Array.from(table.tBodies).forEach((tbody) => {
      const totalsRows = Array.from(tbody.rows).filter(rowLooksLikeTotalsRow);

      totalsRows.forEach((row) => {
        row.classList.add(
          "sortbottom",
          "reader-sortable-footer-row",
          "reader-county-results-totals-row",
        );

        Array.from(row.cells).forEach((cell) => {
          cell.classList.add("reader-sortable-footer-cell");
        });

        if (tbody.lastElementChild !== row) {
          tbody.appendChild(row);
        }
      });
    });
  });
}

function removeReaderCitationOnlyColumns(document: Document) {
  const citationHeaderPattern = /^(?:references?|refs?\.?|citations?)$/i;
  const citationNodePattern =
    ".reference, sup[id^='cite_ref'], sup[id^='cite_note'], a[href^='#cite_ref'], a[href^='#cite_note'], .mw-cite-backlink";

  document.querySelectorAll<HTMLTableElement>("table").forEach((table) => {
    const rows = Array.from(table.rows);
    if (rows.length < 2) return;

    // Build a logical column grid so rowspans before the reference header do
    // not cause us to inspect or remove a neighboring column by mistake.
    const grid: Array<Array<HTMLTableCellElement | undefined>> = rows.map(
      () => [],
    );

    rows.forEach((row, rowIndex) => {
      let column = 0;

      Array.from(row.cells).forEach((cell) => {
        while (grid[rowIndex][column]) column += 1;

        const columnSpan = Math.max(1, cell.colSpan);
        const rowSpan =
          cell.rowSpan === 0
            ? rows.length - rowIndex
            : Math.max(1, cell.rowSpan);

        for (
          let coveredRow = rowIndex;
          coveredRow < Math.min(rows.length, rowIndex + rowSpan);
          coveredRow += 1
        ) {
          for (
            let coveredColumn = column;
            coveredColumn < column + columnSpan;
            coveredColumn += 1
          ) {
            grid[coveredRow][coveredColumn] = cell;
          }
        }

        column += columnSpan;
      });
    });

    const header = rows
      .flatMap((row, rowIndex) =>
        Array.from(row.cells).map((cell) => ({ cell, rowIndex, row })),
      )
      .find(({ cell, row, rowIndex }) => {
        const label = cell.textContent?.replace(/\s+/g, " ").trim() ?? "";
        const isColumnHeader =
          row.parentElement?.tagName === "THEAD" ||
          cell.scope.toLowerCase() === "col" ||
          rowIndex === 0 ||
          (row.cells.length > 1 &&
            Array.from(row.cells).every(
              (rowCell) =>
                rowCell.tagName === "TH" &&
                rowCell.scope.toLowerCase() !== "row",
            ));

        return (
          cell.tagName === "TH" &&
          cell.colSpan === 1 &&
          cell.scope.toLowerCase() !== "row" &&
          citationHeaderPattern.test(label) &&
          isColumnHeader
        );
      });

    if (!header) return;

    const logicalColumn = grid[header.rowIndex].indexOf(header.cell);
    if (logicalColumn < 0) return;

    const firstDataRow =
      header.rowIndex +
      (header.cell.rowSpan === 0
        ? rows.length - header.rowIndex
        : Math.max(1, header.cell.rowSpan));
    if (firstDataRow >= rows.length) return;

    let foundCitation = false;
    let containsOnlyCitationContent = true;
    const columnCells = new Set<HTMLTableCellElement>();

    const nodeContainsOnlyCitationContent = (node: Node): boolean => {
      if (node.nodeType === Node.TEXT_NODE) {
        return !(node.textContent || "").trim();
      }

      if (node.nodeType !== Node.ELEMENT_NODE) return true;

      const element = node as Element;
      if (element.matches(citationNodePattern)) {
        foundCitation = true;
        return true;
      }

      if (element.tagName === "BR") return true;
      if (
        element.matches(
          "a[href], img, svg, video, audio, canvas, iframe, object, input, button, select, textarea",
        )
      ) {
        return false;
      }

      return Array.from(element.childNodes).every(
        nodeContainsOnlyCitationContent,
      );
    };

    for (let rowIndex = firstDataRow; rowIndex < rows.length; rowIndex += 1) {
      const cell = grid[rowIndex][logicalColumn];
      if (!cell || cell.colSpan !== 1) {
        containsOnlyCitationContent = false;
        break;
      }

      const isRepeatedReferenceHeader =
        cell.tagName === "TH" &&
        citationHeaderPattern.test(
          cell.textContent?.replace(/\s+/g, " ").trim() ?? "",
        );
      if (isRepeatedReferenceHeader) {
        columnCells.add(cell);
        continue;
      }

      if (
        !Array.from(cell.childNodes).every(
          nodeContainsOnlyCitationContent,
        )
      ) {
        containsOnlyCitationContent = false;
        break;
      }

      columnCells.add(cell);
    }

    if (
      !containsOnlyCitationContent ||
      !foundCitation ||
      columnCells.size === 0
    ) {
      return;
    }

    // Earlier title/group rows may span across the reference column. Shrink
    // those spans to preserve the remaining table layout after the column is
    // removed. Data rows spanning multiple columns were rejected above.
    for (let rowIndex = 0; rowIndex < header.rowIndex; rowIndex += 1) {
      const spanningCell = grid[rowIndex][logicalColumn];
      if (spanningCell && spanningCell.colSpan > 1) {
        spanningCell.colSpan -= 1;
      }
    }

    columnCells.add(header.cell);
    columnCells.forEach((cell) => cell.remove());

    // Keep explicit column sizing aligned with the shortened table.
    let columnOffset = 0;
    Array.from(table.children)
      .filter((child) => child.tagName === "COLGROUP")
      .forEach((group) => {
        const columns = Array.from(group.children).filter(
          (child): child is HTMLTableColElement => child.tagName === "COL",
        );

        if (columns.length === 0) {
          const span = Math.max(1, (group as HTMLTableColElement).span);
          if (
            logicalColumn >= columnOffset &&
            logicalColumn < columnOffset + span
          ) {
            if (span === 1) group.remove();
            else (group as HTMLTableColElement).span = span - 1;
          }
          columnOffset += span;
          return;
        }

        columns.forEach((column) => {
          const span = Math.max(1, column.span);
          if (
            logicalColumn >= columnOffset &&
            logicalColumn < columnOffset + span
          ) {
            if (span === 1) column.remove();
            else column.span = span - 1;
          }
          columnOffset += span;
        });
      });
  });
}

function markReaderSortableColumnHeaders(document: Document) {
  document.querySelectorAll<HTMLTableElement>("table.sortable").forEach((table) => {
    table
      .querySelectorAll<HTMLElement>(
        ".reader-sortable-column-header, .reader-sortable-row-header, .reader-sortable-footer-row, .reader-sortable-footer-cell",
      )
      .forEach((element) => {
        element.classList.remove(
          "reader-sortable-column-header",
          "reader-sortable-row-header",
          "reader-sortable-footer-row",
          "reader-sortable-footer-cell",
        );
      });

    Array.from(table.rows).forEach((row) => {
      if (readerRowLooksLikeSortableFooterRow(row)) {
        row.classList.add("reader-sortable-footer-row");
        Array.from(row.cells).forEach((cell) => {
          cell.classList.add("reader-sortable-footer-cell");
        });
      }
    });

    const markHeaderCell = (cell: HTMLTableCellElement) => {
      if (cell.classList.contains("unsortable") || cell.closest(".unsortable")) return;
      if (cell.classList.contains("reader-static-row-number-header")) return;
      if (cell.classList.contains("reader-sortable-footer-cell")) return;
      if (cell.getAttribute("scope")?.toLowerCase() === "row") return;

      // Group headers like "2021 Census of Population" span several columns
      // and should not receive their own clickable sort arrow.
      if (cell.colSpan > 1) return;

      cell.classList.add("reader-sortable-column-header");
      // Keep the sort indicator's absolute positioning anchored to its own
      // header cell, including nested and multi-row header layouts.
      cell.style.setProperty("position", "relative", "important");
    };

    const theadRows = Array.from(table.tHead?.rows || []);

    if (theadRows.length) {
      theadRows.forEach((row) => {
        Array.from(row.cells).forEach((cell) => {
          if (cell.tagName.toLowerCase() === "th") {
            markHeaderCell(cell as HTMLTableCellElement);
          }
        });
      });
    } else {
      // Some parsed MediaWiki tables do not produce a THEAD. Treat only the
      // leading all-header rows as column headers, then stop at the first data row.
      for (const row of Array.from(table.rows)) {
        if (readerRowLooksLikeSortableFooterRow(row)) continue;

        const cells = Array.from(row.cells);
        if (!cells.length) continue;

        const hasDataCell = cells.some((cell) => cell.tagName.toLowerCase() === "td");
        if (hasDataCell) break;

        cells.forEach((cell) => {
          if (cell.tagName.toLowerCase() === "th") {
            markHeaderCell(cell as HTMLTableCellElement);
          }
        });
      }
    }

    table.querySelectorAll<HTMLTableCellElement>("tbody th").forEach((cell) => {
      if (
        !cell.classList.contains("reader-sortable-column-header") &&
        !cell.classList.contains("reader-sortable-footer-cell")
      ) {
        cell.classList.add("reader-sortable-row-header");
      }
    });
  });
}

const readerSortableTableDefaults = new WeakMap<
  HTMLTableElement,
  Array<{ tbody: HTMLTableSectionElement; rows: HTMLTableRowElement[] }>
>();
const readerSortableTables = new Set<HTMLTableElement>();

function rememberReaderSortableTableDefaults(scope: ParentNode) {
  scope.querySelectorAll<HTMLTableElement>("table.sortable").forEach((table) => {
    if (readerSortableTableDefaults.has(table)) return;

    readerSortableTableDefaults.set(
      table,
      [...table.tBodies].map((tbody) => ({
        tbody,
        rows: [...tbody.rows],
      })),
    );
    readerSortableTables.add(table);
  });
}

function resetReaderSortableTables() {
  readerSortableTables.forEach((table) => {
    if (!table.isConnected) {
      readerSortableTables.delete(table);
      return;
    }

    const defaults = readerSortableTableDefaults.get(table);
    if (!defaults) return;

    defaults.forEach(({ tbody, rows }) => {
      rows.forEach((row) => tbody.appendChild(row));
    });

    table.querySelectorAll<HTMLElement>("th[data-reader-sort-direction]").forEach((cell) => {
      cell.removeAttribute("data-reader-sort-direction");
      cell.classList.remove(
        "reader-sort-active",
        "reader-sort-ascending",
        "reader-sort-descending",
      );
    });
  });
}

function centerReaderVerticalSortableHeaders(scope: ParentNode) {
  const headers = [...scope.querySelectorAll<HTMLTableCellElement>(
    "table.sortable th.reader-vertical-table-header",
  )]
    .map((th) => ({
      th,
      content: th.querySelector<HTMLElement>(":scope > div"),
    }))
    .filter((entry): entry is { th: HTMLTableCellElement; content: HTMLElement } =>
      Boolean(entry.content),
    );

  headers.forEach(({ content }) => {
    content.style.setProperty("transform", "none", "important");
  });

  headers.forEach(({ th, content }) => {
    const thRect = th.getBoundingClientRect();
    const contentRect = content.getBoundingClientRect();
    const offset =
      (thRect.left + thRect.right) / 2 -
      (contentRect.left + contentRect.right) / 2;

    content.style.setProperty(
      "transform",
      `translateX(${offset}px)`,
      "important",
    );
  });
}

function markReaderVerticalSortableHeaders(document: Document) {
  document
    .querySelectorAll<HTMLTableCellElement>(
      "table.sortable th.ts-vertical-header",
    )
    .forEach((header) => {
      const content = header.querySelector<HTMLElement>(":scope > div");
      if (!content) return;

      header.classList.add("reader-vertical-table-header");
    });
}

function sortReaderTableFromClick(clicked: HTMLElement) {
  // Let real links inside sortable headers stay clickable.
  // Clicking the empty header area still sorts the column.
  if (clicked.closest("a")) return false;

  const headerCell = clicked.closest<HTMLTableCellElement>("th");

  if (!headerCell) return false;
  if (headerCell.classList.contains("reader-static-row-number-header")) return false;
  if (headerCell.classList.contains("unsortable") || headerCell.closest(".unsortable")) return false;
  if (!headerCell.classList.contains("reader-sortable-column-header")) return false;

  const table = headerCell.closest<HTMLTableElement>("table.sortable");

  if (!table) return false;

  const headerRow = headerCell.closest<HTMLTableRowElement>("tr");
  if (!headerRow) return false;

  const columnIndex = headerCell.cellIndex;
  if (columnIndex < 0) return false;

  const nextDirection = headerCell.dataset.readerSortDirection === "desc" ? "asc" : "desc";
  const directionMultiplier = nextDirection === "asc" ? 1 : -1;

  const allDataRows = Array.from(table.rows).filter((row) => {
    if (row === headerRow) return false;
    if (row.closest("thead")) return false;
    return Boolean(row.querySelector("td"));
  });

  const footerRows = allDataRows.filter((row) =>
    readerRowLooksLikeSortableFooterRow(row),
  );

  const dataRows = allDataRows.filter((row) =>
    !readerRowLooksLikeSortableFooterRow(row),
  );

  if (dataRows.length < 2) return true;

  const sortedRows = dataRows
    .map((row, originalIndex) => {
      const cell = row.cells[columnIndex];
      const key = readerSortableKey(cell?.textContent ?? "");

      return { row, originalIndex, key };
    })
    .sort((left, right) => {
      const compared = compareReaderSortKeys(left.key, right.key) * directionMultiplier;
      return compared || left.originalIndex - right.originalIndex;
    });

  sortedRows.forEach(({ row }) => {
    row.parentElement?.appendChild(row);
  });

  // Keep total/footer rows pinned below the sorted body rows.
  footerRows.forEach((row) => {
    row.parentElement?.appendChild(row);
  });

  table.querySelectorAll<HTMLElement>("th[data-reader-sort-direction]").forEach((cell) => {
    if (cell !== headerCell) {
      cell.removeAttribute("data-reader-sort-direction");
      cell.classList.remove("reader-sort-active", "reader-sort-ascending", "reader-sort-descending");
    }
  });

  headerCell.dataset.readerSortDirection = nextDirection;
  headerCell.classList.add("reader-sort-active");
  headerCell.classList.toggle("reader-sort-ascending", nextDirection === "asc");
  headerCell.classList.toggle("reader-sort-descending", nextDirection === "desc");

  updateReaderStaticRowNumbersAfterSort(table);
  scheduleReaderSortableFooterRowsPin(table);

  return true;
}

export function ReaderContentsMenu({
  onSectionNavigate,
  sections,
}: {
  onSectionNavigate: (sectionId: string) => void;
  sections: ReaderSection[];
}) {
  const [contentsOpen, setContentsOpen] = useState(false);

  useEffect(() => {
    if (!contentsOpen) return;

    function handlePointerDown(event: globalThis.PointerEvent) {
      const target = event.target as Element | null;

      if (target?.closest(".reader-contents-menu")) return;

      setContentsOpen(false);
    }

    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        setContentsOpen(false);
      }
    }
document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
};
  }, [contentsOpen]);
  const [expandedSectionIds, setExpandedSectionIds] = useState<Set<string>>(
    () => new Set(),
  );

  const sectionGroups = sections.reduce<
    { main: ReaderSection; children: ReaderSection[] }[]
  >((groups, section) => {
    if (section.level <= 2 || groups.length === 0) {
      groups.push({ main: section, children: [] });
    } else {
      groups[groups.length - 1].children.push(section);
    }

    return groups;
  }, []);

  function toggleSection(sectionId: string) {
    setExpandedSectionIds((currentExpanded) => {
      const nextExpanded = new Set(currentExpanded);

      if (nextExpanded.has(sectionId)) {
        nextExpanded.delete(sectionId);
      } else {
        nextExpanded.add(sectionId);
      }

      return nextExpanded;
    });
  }

  return (
    <div className="reader-contents-menu">
      <button
        type="button"
        className="reader-contents-button"
        aria-label="Open article contents"
        aria-expanded={contentsOpen}
        disabled={sectionGroups.length === 0}
        onClick={() => setContentsOpen((open) => !open)}
      >
        ☰
      </button>

      {contentsOpen && sectionGroups.length > 0 && (
        <nav className="reader-section-popover" aria-label="Article contents">
          <button
            type="button"
            className="reader-section-top-link"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setContentsOpen(false);
              onSectionNavigate("__top");
            }}
          >
            Top
          </button>

          {sectionGroups.map(({ main, children }) => {
            const hasChildren = children.length > 0;
            const expanded = expandedSectionIds.has(main.id);

            return (
              <div className="reader-section-group" key={main.id}>
                <div className="reader-section-main-row">
                  {hasChildren ? (
                    <button
                      type="button"
                      className="reader-section-toggle"
                      aria-label={`Show subsections for ${main.title}`}
                      aria-expanded={expanded}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => toggleSection(main.id)}
                    >
                      ▸
                    </button>
                  ) : (
                    <span className="reader-section-toggle-placeholder" />
                  )}

                  <a
                    className="reader-section-main-link"
                    href={`#${main.id}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={(event) => {
                      event.preventDefault();
                      setContentsOpen(false);
                      onSectionNavigate(main.id);
                    }}
                  >
                    {main.title}
                  </a>
                </div>

                {hasChildren && expanded && (
                  <div className="reader-section-children">
                    {children.map((section) => (
                      <a
                        key={section.id}
                        className={`level-${section.level}`}
                        href={`#${section.id}`}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={(event) => {
                          event.preventDefault();
                          setContentsOpen(false);
                          onSectionNavigate(section.id);
                        }}
                      >
                        {section.title}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
      )}
    </div>
  );
}




/*
 * Keep loaded Wikipedia tabs responsive when their parent updates.
 * Each keyed tab retains the same callback behavior, so a new callback
 * identity alone must not reconcile the complete article subtree.
 */
const MemoizedWikipediaReader = memo(
  WikipediaReader,
  (previousProps, nextProps) =>
    previousProps.target === nextProps.target &&
    previousProps.toolbarHost === nextProps.toolbarHost &&
    previousProps.active === nextProps.active &&
    previousProps.toolbarVisible === nextProps.toolbarVisible &&
    previousProps.readerToolsVisible === nextProps.readerToolsVisible &&
    previousProps.toolbarPane === nextProps.toolbarPane,
);

export default MemoizedWikipediaReader;

function ReaderInlineContentsPopover({
  anchor,
  onClose,
  onSectionNavigate,
  sections,
}: {
  anchor: { top?: number; bottom?: number; left: number; opensUp?: boolean };
  onClose: () => void;
  onSectionNavigate: (sectionId: string) => void;
  sections: ReaderSection[];
}) {
  const [expandedSectionIds, setExpandedSectionIds] = useState<Set<string>>(
    () => new Set(),
  );

  useEffect(() => {
    function handlePointerDown(event: globalThis.PointerEvent) {
      const target = event.target as Element | null;

      if (
        target?.closest(".reader-inline-section-popover") ||
        target?.closest(".reader-contents-button") ||
        target?.closest(".reader-unified-contents-button")
      ) {
        return;
      }

      onClose();
    }

    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
      }
    }
document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
};
  }, [onClose]);

  const sectionGroups = sections.reduce<
    { main: ReaderSection; children: ReaderSection[] }[]
  >((groups, section) => {
    if (section.level <= 2 || groups.length === 0) {
      groups.push({ main: section, children: [] });
    } else {
      groups[groups.length - 1].children.push(section);
    }

    return groups;
  }, []);

  function toggleSection(sectionId: string) {
    setExpandedSectionIds((currentExpanded) => {
      const nextExpanded = new Set(currentExpanded);

      if (nextExpanded.has(sectionId)) {
        nextExpanded.delete(sectionId);
      } else {
        nextExpanded.add(sectionId);
      }

      return nextExpanded;
    });
  }

  const popoverStyle = {
    "--reader-inline-contents-top":
      anchor.top === undefined ? "auto" : `${anchor.top}px`,
    "--reader-inline-contents-bottom":
      anchor.bottom === undefined ? "auto" : `${anchor.bottom}px`,
    "--reader-inline-contents-left": `${anchor.left}px`,
  } as CSSProperties;

  return (
    <nav
      className={
        anchor.opensUp
          ? "reader-inline-section-popover reader-inline-section-popover-open-up"
          : "reader-inline-section-popover"
      }
      aria-label="Article contents"
      style={popoverStyle}
    >
      <button
        type="button"
        className="reader-section-top-link"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          onClose();
          onSectionNavigate("__top");
        }}
      >
        Top
      </button>

      {sectionGroups.map(({ main, children }) => {
        const hasChildren = children.length > 0;
        const expanded = expandedSectionIds.has(main.id);

        return (
          <div className="reader-section-group" key={main.id}>
            <div className="reader-section-main-row">
              {hasChildren ? (
                <button
                  type="button"
                  className="reader-section-toggle"
                  aria-label={`Show subsections for ${main.title}`}
                  aria-expanded={expanded}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => toggleSection(main.id)}
                >
                  ▸
                </button>
              ) : (
                <span className="reader-section-toggle-placeholder" />
              )}

              <a
                className="reader-section-main-link"
                href={`#${main.id}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  event.preventDefault();
                  onClose();
                  onSectionNavigate(main.id);
                }}
              >
                {main.title}
              </a>
            </div>

            {hasChildren && expanded && (
              <div className="reader-section-children">
                {children.map((section) => (
                  <a
                    key={section.id}
                    className={`level-${section.level}`}
                    href={`#${section.id}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={(event) => {
                      event.preventDefault();
                      onClose();
                      onSectionNavigate(section.id);
                    }}
                  >
                    {section.title}
                  </a>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}



function fitReaderPortraitMediaFigure(image: HTMLImageElement) {
  const figure = image.closest<HTMLElement>("figure");

  if (
    !figure ||
    !figure.isConnected ||
    figure.closest(".infobox") ||
    figure.closest(".gallery, ul.gallery, .mw-gallery-traditional") ||
    figure.matches(".tmulti, .reader-multiple-image-block") ||
    figure.querySelectorAll("img").length !== 1
  ) {
    return;
  }

  figure.classList.remove("reader-portrait-media");
  figure.style.removeProperty("--reader-portrait-media-width");

  if (
    image.naturalWidth <= 0 ||
    image.naturalHeight <= image.naturalWidth
  ) {
    return;
  }

  const imageWidth = image.getBoundingClientRect().width;

  if (!Number.isFinite(imageWidth) || imageWidth <= 0) return;

  figure.style.setProperty(
    "--reader-portrait-media-width",
    `${imageWidth}px`,
  );
  figure.classList.add("reader-portrait-media");
}


const READER_MATH_POSITIVE_OPERATORS = new Set([
  "+",
  "×",
  "·",
  "⋅",
  "∙",
  "⨉",
]);

const READER_MATH_NEGATIVE_OPERATORS = new Set([
  "−",
  "-",
  "÷",
]);

const READER_MATH_EQUALITY_OPERATORS = new Set(["="]);

const READER_MATH_DELIMITERS = new Set([
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  "⟨",
  "⟩",
  "⌈",
  "⌉",
  "⌊",
  "⌋",
]);

const READER_MATH_COMPARISON_OPERATORS = new Set([
  "<",
  ">",
  "≤",
  "≥",
  "≠",
  "≈",
  "≃",
  "∼",
]);

const READER_MATH_STRUCTURAL_OPERATORS = new Set([
  "∑",
  "∏",
  "∫",
  "∬",
  "∭",
  "∮",
  "∯",
  "∰",
  "∇",
  "∂",
]);

const READER_MATH_NAMED_FUNCTIONS = new Set([
  "sin",
  "cos",
  "tan",
  "sinh",
  "cosh",
  "tanh",
  "log",
  "ln",
  "exp",
  "Re",
  "Im",
]);

const READER_TEXHTML_TOKEN_PATTERN =
  /(sinh|cosh|tanh|sin|cos|tan|log|ln|exp|Re|Im|Γ|≥|≤|>|<|\+|−|-|×|·|\*|÷|\/|=|\(|\)|\[|\]|\{|\})/g;

const READER_CHEMISTRY_REACTION_ARROWS = new Set([
  "⟶",
  "→",
  "⟷",
  "↔",
  "⇌",
  "⇄",
  "⇆",
]);

const READER_CHEMF_TOKEN_PATTERN =
  /(⇌|⇄|⇆|⟷|↔|⟶|→|↑|↓|\+|−|-|\(|\)|\[|\])/g;

const READER_PLAIN_CHEMISTRY_TOKEN_PATTERN =
  /(⇌|⇄|⇆|⟷|↔|⟶|→|↑|↓|\+|−|-)/g;

function getReaderChemistryTokenClass(token: string): string | null {
  if (token === "+") {
    return "reader-chem-token-positive";
  }

  if (token === "−" || token === "-") {
    return "reader-chem-token-negative";
  }

  if (READER_CHEMISTRY_REACTION_ARROWS.has(token)) {
    return "reader-chem-token-reaction-arrow";
  }

  if (token === "↑") {
    return "reader-chem-token-up-arrow";
  }

  if (token === "↓") {
    return "reader-chem-token-down-arrow";
  }

  if (["(", ")", "[", "]"].includes(token)) {
    return "reader-chem-token-delimiter";
  }

  return null;
}

function classifyReaderChemistryTokens(math: MathMLElement) {
  math.querySelectorAll<MathMLElement>("mo").forEach((operator) => {
    const token = operator.textContent?.trim() || "";

    if (READER_CHEMISTRY_REACTION_ARROWS.has(token)) {
      operator.classList.add("reader-chem-token-reaction-arrow");
      return;
    }

    if (token === "↑") {
      operator.classList.add("reader-chem-token-up-arrow");
      return;
    }

    if (token === "↓") {
      operator.classList.add("reader-chem-token-down-arrow");
      return;
    }

    if (token === "⏟" || token === "⏞") {
      operator.classList.add("reader-chem-token-brace");
    }
  });
}

function getReaderMathTokenClass(token: string): string | null {
  if (READER_MATH_POSITIVE_OPERATORS.has(token)) {
    return "reader-math-token-positive";
  }

  if (READER_MATH_NEGATIVE_OPERATORS.has(token)) {
    return "reader-math-token-negative";
  }

  if (READER_MATH_EQUALITY_OPERATORS.has(token)) {
    return "reader-math-token-equality";
  }

  if (READER_MATH_DELIMITERS.has(token)) {
    return "reader-math-token-delimiter";
  }

  if (READER_MATH_COMPARISON_OPERATORS.has(token)) {
    if (token === ">" || token === "≥") {
      return "reader-math-token-greater";
    }

    if (token === "<" || token === "≤") {
      return "reader-math-token-less";
    }

    return "reader-math-token-comparison";
  }

  if (READER_MATH_STRUCTURAL_OPERATORS.has(token)) {
    return "reader-math-token-structural";
  }

  if (READER_MATH_NAMED_FUNCTIONS.has(token) || token === "Γ") {
    return "reader-math-token-function";
  }

  return null;
}

function classifyReaderMathTokens(math: MathMLElement) {
  math.querySelectorAll<MathMLElement>("mi, mo, mtext").forEach((element) => {
    const token = element.textContent?.replace(/\s+/g, "").trim() || "";
    const tokenClass = getReaderMathTokenClass(token);

    if (tokenClass) {
      element.classList.add(tokenClass);
    }
  });
}

function prepareReaderTexhtmlSyntax(root: ParentNode) {
  root.querySelectorAll<HTMLElement>(".texhtml").forEach((wrapper) => {
    if (wrapper.classList.contains("reader-texhtml-syntax-ready")) return;

    wrapper.classList.add("reader-texhtml-syntax-ready");

    wrapper.querySelectorAll<HTMLElement>("i").forEach((variable) => {
      variable.classList.add("reader-math-token-variable");
    });

    const textNodes: Text[] = [];
    const walker = document.createTreeWalker(wrapper, NodeFilter.SHOW_TEXT);

    while (walker.nextNode()) {
      const node = walker.currentNode;

      if (!(node instanceof Text)) continue;

      const parent = node.parentElement;

      if (!parent || parent.closest('[class*="reader-math-token-"]')) {
        continue;
      }

      if (!node.data.trim()) continue;

      textNodes.push(node);
    }

    textNodes.forEach((node) => {
      const text = node.data;
      const fragment = document.createDocumentFragment();
      let lastIndex = 0;
      let matched = false;

      READER_TEXHTML_TOKEN_PATTERN.lastIndex = 0;

      for (
        let match = READER_TEXHTML_TOKEN_PATTERN.exec(text);
        match;
        match = READER_TEXHTML_TOKEN_PATTERN.exec(text)
      ) {
        const token = match[0];
        const tokenClass = getReaderMathTokenClass(token);

        if (!tokenClass) continue;

        if (match.index > lastIndex) {
          fragment.append(
            document.createTextNode(text.slice(lastIndex, match.index)),
          );
        }

        const tokenElement = document.createElement("span");
        tokenElement.classList.add(tokenClass);
        tokenElement.textContent = token;
        fragment.append(tokenElement);

        lastIndex = match.index + token.length;
        matched = true;
      }

      if (!matched) return;

      if (lastIndex < text.length) {
        fragment.append(document.createTextNode(text.slice(lastIndex)));
      }

      node.replaceWith(fragment);
    });
  });
}

function isReaderStackedSuPart(element: Element): boolean {
  const children = Array.from(element.children);

  return (
    children.length === 3 &&
    children[0]?.tagName === "SUP" &&
    children[1]?.tagName === "BR" &&
    children[2]?.tagName === "SUB"
  );
}

function prepareReaderStackedSuLayout(root: ParentNode) {
  root
    .querySelectorAll<HTMLElement>(".nowrap > span")
    .forEach((stackedPart) => {
      if (!isReaderStackedSuPart(stackedPart)) return;

      stackedPart.classList.add("reader-stacked-su");
    });
}

function isReaderElectrodePotentialBlock(
  block: HTMLElement,
): boolean {
  if (block.querySelector(".chemf")) return false;

  const stackedParts = Array.from(
    block.querySelectorAll<HTMLElement>(".nowrap > span"),
  ).filter(isReaderStackedSuPart);

  if (stackedParts.length < 2) return false;

  const italicECount = Array.from(
    block.querySelectorAll<HTMLElement>("i"),
  ).filter((element) => element.textContent?.trim() === "E").length;

  if (italicECount < 2) return false;

  const allStackedSuperscriptsAreDegreeMarkers = stackedParts.every(
    (stackedPart) => {
      const superscript =
        stackedPart.querySelector<HTMLElement>(":scope > sup");
      const text = superscript?.textContent?.replace(/\\s+/g, " ").trim() || "";

      return text === "o" || text === "°";
    },
  );

  if (!allStackedSuperscriptsAreDegreeMarkers) return false;

  const text = block.textContent?.replace(/\\s+/g, " ").trim() || "";

  return text.includes("=");
}

function prepareReaderElectrodeSyntax(root: ParentNode) {
  root.querySelectorAll<HTMLElement>("dd").forEach((block) => {
    if (
      block.classList.contains("reader-electrode-syntax-ready") ||
      !isReaderElectrodePotentialBlock(block)
    ) {
      return;
    }

    const textNodes: Text[] = [];
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);

    while (walker.nextNode()) {
      const node = walker.currentNode;

      if (!(node instanceof Text)) continue;

      const parent = node.parentElement;

      if (
        !parent ||
        parent.closest(
          'sup, sub, script, style, [class*="reader-math-token-"]',
        ) ||
        !/[=+−-]/.test(node.data)
      ) {
        continue;
      }

      textNodes.push(node);
    }

    let matchedBlock = false;

    textNodes.forEach((node) => {
      const text = node.data;
      const fragment = document.createDocumentFragment();
      const tokenPattern = /[=+−-]/g;
      let lastIndex = 0;
      let matchedNode = false;

      for (
        let match = tokenPattern.exec(text);
        match;
        match = tokenPattern.exec(text)
      ) {
        const token = match[0];
        let tokenClass: string;

        if (token === "=") {
          tokenClass = "reader-math-token-equality";
        } else if (token === "+") {
          tokenClass = "reader-math-token-positive";
        } else {
          tokenClass = "reader-math-token-negative";
        }

        if (match.index > lastIndex) {
          fragment.append(
            document.createTextNode(text.slice(lastIndex, match.index)),
          );
        }

        const tokenElement = document.createElement("span");
        tokenElement.classList.add(tokenClass);
        tokenElement.textContent = token;
        fragment.append(tokenElement);

        lastIndex = match.index + token.length;
        matchedNode = true;
        matchedBlock = true;
      }

      if (!matchedNode) return;

      if (lastIndex < text.length) {
        fragment.append(document.createTextNode(text.slice(lastIndex)));
      }

      node.replaceWith(fragment);
    });

    if (matchedBlock) {
      block.classList.add("reader-electrode-syntax-ready");
    }
  });
}

function prepareReaderChemfSyntax(root: ParentNode) {
  root.querySelectorAll<HTMLElement>(".chemf").forEach((wrapper) => {
    if (wrapper.classList.contains("reader-chemf-syntax-ready")) return;

    wrapper.classList.add("reader-chemf-syntax-ready");

    const textNodes: Text[] = [];
    const walker = document.createTreeWalker(wrapper, NodeFilter.SHOW_TEXT);

    while (walker.nextNode()) {
      const node = walker.currentNode;

      if (!(node instanceof Text)) continue;

      const parent = node.parentElement;

      if (!parent || parent.closest('[class*="reader-chem-token-"]')) {
        continue;
      }

      if (!node.data.trim()) continue;

      textNodes.push(node);
    }

    textNodes.forEach((node) => {
      const text = node.data;
      const fragment = document.createDocumentFragment();
      let lastIndex = 0;
      let matched = false;

      READER_CHEMF_TOKEN_PATTERN.lastIndex = 0;

      for (
        let match = READER_CHEMF_TOKEN_PATTERN.exec(text);
        match;
        match = READER_CHEMF_TOKEN_PATTERN.exec(text)
      ) {
        const token = match[0];
        const tokenClass = getReaderChemistryTokenClass(token);

        if (!tokenClass) continue;

        if (match.index > lastIndex) {
          fragment.append(
            document.createTextNode(text.slice(lastIndex, match.index)),
          );
        }

        const tokenElement = document.createElement("span");
        tokenElement.classList.add(tokenClass);
        tokenElement.textContent = token;
        fragment.append(tokenElement);

        lastIndex = match.index + token.length;
        matched = true;
      }

      if (!matched) return;

      if (lastIndex < text.length) {
        fragment.append(document.createTextNode(text.slice(lastIndex)));
      }

      node.replaceWith(fragment);
    });
  });
}

function prepareReaderPlainChemistrySyntax(root: ParentNode) {
  root.querySelectorAll<HTMLElement>("dd").forEach((block) => {
    if (
      block.classList.contains("reader-plain-chemistry-syntax-ready")
    ) {
      return;
    }

    if (
      block.matches(".chemf") ||
      block.closest(".chemf") ||
      block.querySelector(".chemf") ||
      block.querySelector(".mwe-math-element")
    ) {
      return;
    }

    const text = block.textContent?.replace(/\s+/g, " ").trim() || "";

    if (
      !Array.from(READER_CHEMISTRY_REACTION_ARROWS).some((arrow) =>
        text.includes(arrow),
      )
    ) {
      return;
    }

    if (!block.querySelector("sub, sup")) {
      return;
    }

    const textNodes: Text[] = [];
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);

    while (walker.nextNode()) {
      const node = walker.currentNode;

      if (!(node instanceof Text)) continue;

      const parent = node.parentElement;

      if (
        !parent ||
        parent.closest(
          'script, style, [class*="reader-chem-token-"]',
        ) ||
        !node.data.trim()
      ) {
        continue;
      }

      textNodes.push(node);
    }

    let matchedBlock = false;

    textNodes.forEach((node) => {
      const text = node.data;
      const fragment = document.createDocumentFragment();
      let lastIndex = 0;
      let matchedNode = false;

      READER_PLAIN_CHEMISTRY_TOKEN_PATTERN.lastIndex = 0;

      for (
        let match = READER_PLAIN_CHEMISTRY_TOKEN_PATTERN.exec(text);
        match;
        match = READER_PLAIN_CHEMISTRY_TOKEN_PATTERN.exec(text)
      ) {
        const token = match[0];
        const tokenClass = getReaderChemistryTokenClass(token);

        if (!tokenClass) continue;

        if (match.index > lastIndex) {
          fragment.append(
            document.createTextNode(text.slice(lastIndex, match.index)),
          );
        }

        const tokenElement = document.createElement("span");
        tokenElement.classList.add(tokenClass);
        tokenElement.textContent = token;
        fragment.append(tokenElement);

        lastIndex = match.index + token.length;
        matchedNode = true;
        matchedBlock = true;
      }

      if (!matchedNode) return;

      if (lastIndex < text.length) {
        fragment.append(document.createTextNode(text.slice(lastIndex)));
      }

      node.replaceWith(fragment);
    });

    if (matchedBlock) {
      block
        .querySelectorAll<HTMLElement>("span.sfrac.nowrap > span")
        .forEach((term) => {
          const formula = term.firstElementChild;
          const label = formula?.nextElementSibling;

          if (!formula?.matches("span") || !label?.matches("span")) {
            return;
          }

          term.classList.add("reader-chemistry-underset");
          label.classList.add("reader-chemistry-underset-label");
        });

      block.classList.add("reader-plain-chemistry-syntax-ready");
    }
  });
}

function prepareReaderMathSyntax(root: ParentNode) {
  root
    .querySelectorAll<MathMLElement>(
      "math.mwe-math-element",
    )
    .forEach((math) => {
      if (math.classList.contains("reader-math-syntax-ready")) return;

      const mathTex =
        math.querySelector<HTMLElement>(
          'annotation[encoding="application/x-tex"]',
        )?.textContent ??
        math.getAttribute("alttext") ??
        "";

      if (
        /\\begin\{(?:matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix)\}/.test(
          mathTex,
        )
      ) {
        math.querySelector<MathMLElement>("mtable")?.classList.add(
          "reader-math-matrix",
        );
      }

      const mathTables = Array.from(
        math.querySelectorAll<MathMLElement>("mtable"),
      );
      if (mathTables.length >= 3) {
        const coefficientMatrix = mathTables.find(
          (table) =>
            table.querySelectorAll("mtr").length === 2 &&
            table.querySelectorAll("mtd").length === 4,
        );
        coefficientMatrix?.classList.add("reader-math-matrix");
      }

      classifyReaderMathTokens(math);
      math.classList.add("reader-math-syntax-ready");
      math.parentElement?.classList.add("reader-math-syntax-ready");

      math
        .querySelectorAll<MathMLElement>("mover > mo")
        .forEach((overbar) => {
          if (overbar.textContent?.trim() === "¯") {
            overbar.style.setProperty(
              "transform",
              "translateY(2px)",
              "important",
            );
          }
        });
    });

  root
    .querySelectorAll<HTMLImageElement>(".skin-invert img.mw-file-element")
    .forEach((image) => {
      if (image.alt === "\\oiint") {
        image.classList.add("reader-math-token-structural-image");
      }
    });

  root
    .querySelectorAll<HTMLElement>(".mwe-math-element")
    .forEach((wrapper) => {
      if (wrapper.classList.contains("reader-math-syntax-ready")) return;

      const mathml = wrapper.querySelector<HTMLElement>(
        ".mwe-math-mathml-inline, .mwe-math-mathml-display, " +
          ".mwe-math-mathml-a11y",
      );

      const math = mathml?.querySelector<MathMLElement>("math");

      const fallback = wrapper.querySelector<HTMLImageElement>(
        "img.mwe-math-fallback-image-inline, " +
          "img.mwe-math-fallback-image-display",
      );

      if (!mathml || !math || !fallback) return;
      if (!fallback.complete || fallback.naturalWidth <= 0) return;

      const mathTex =
        math.querySelector<HTMLElement>(
          'annotation[encoding="application/x-tex"]',
        )?.textContent ??
        math.getAttribute("alttext") ??
        "";

      if (
        /\\begin\{(?:matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix)\}/.test(
          mathTex,
        )
      ) {
        math.querySelector<MathMLElement>("mtable")?.classList.add(
          "reader-math-matrix",
        );
      }

      const isChemistry =
        /\\(?:ce|chem)\s*\{/.test(mathTex);

      if (isChemistry) {
        wrapper.classList.add("reader-chemistry-syntax-ready");
        classifyReaderChemistryTokens(math);
      }

      const fallbackRect = fallback.getBoundingClientRect();

      if (fallbackRect.width <= 0 || fallbackRect.height <= 0) return;

      classifyReaderMathTokens(math);

      mathml.style.setProperty("display", "inline-block", "important");
      mathml.style.setProperty("visibility", "hidden", "important");
      mathml.style.setProperty("position", "absolute", "important");

      const baseFontSize =
        Number.parseFloat(window.getComputedStyle(math).fontSize) || 13;

      const nativeRect = math.getBoundingClientRect();

      if (nativeRect.width <= 0 || nativeRect.height <= 0) {
        mathml.style.removeProperty("display");
        mathml.style.removeProperty("visibility");
        mathml.style.removeProperty("position");
        return;
      }

      const widthScale = fallbackRect.width / nativeRect.width;
      const heightScale = fallbackRect.height / nativeRect.height;
      const fontScale = Math.sqrt(widthScale * heightScale);

      const scaledFontSize = Math.max(
        8,
        Math.min(48, baseFontSize * fontScale),
      );

      math.style.setProperty(
        "font-size",
        `${scaledFontSize}px`,
        "important",
      );

      const scaledRect = math.getBoundingClientRect();

      const horizontalScale =
        scaledRect.width > 0
          ? fallbackRect.width / scaledRect.width
          : 1;

      if (horizontalScale < 0.8 || horizontalScale > 1.25) {
        math.style.removeProperty("font-size");
        mathml.style.removeProperty("display");
        mathml.style.removeProperty("visibility");
        mathml.style.removeProperty("position");
        return;
      }

      math.style.setProperty(
        "transform",
        `scaleX(${horizontalScale})`,
        "important",
      );

      math.style.setProperty(
        "transform-origin",
        "left center",
        "important",
      );

      mathml.style.setProperty(
        "width",
        `${fallbackRect.width}px`,
        "important",
      );

      math
        .querySelectorAll<MathMLElement>(".reader-math-token-delimiter")
        .forEach((delimiter) => {
          const style = window.getComputedStyle(delimiter);
          const fontSize = Number.parseFloat(style.fontSize) || 0;
          const height = delimiter.getBoundingClientRect().height;

          if (fontSize > 0 && height / fontSize >= 1.6) {
            delimiter.classList.add(
              "reader-math-token-tall-delimiter",
            );
          }
        });

      wrapper.classList.add("reader-math-syntax-ready");
      mathml.classList.remove("reader-hidden-sort-key");

      mathml.style.setProperty("position", "static", "important");
      mathml.style.setProperty("visibility", "visible", "important");

      fallback.style.setProperty("display", "none", "important");
    });
}



function prepareReaderPseudocodeSyntax(root: ParentNode) {
  root.querySelectorAll<HTMLElement>(".mw-heading").forEach((sectionHeading) => {
    const heading = sectionHeading.querySelector<HTMLElement>(
      "h1, h2, h3, h4, h5, h6",
    );
    const label = heading?.textContent?.replace(/\[edit\]/gi, "").trim();

    if (label?.toLowerCase() !== "pseudocode") return;

    let sibling = sectionHeading.nextElementSibling;

    while (sibling && !sibling.matches(".mw-heading")) {
      if (
        sibling instanceof HTMLElement &&
        sibling.matches("pre") &&
        !sibling.closest(".mw-highlight")
      ) {
        const pre = sibling;
        pre.classList.add("reader-pseudocode-box");

        if (!pre.classList.contains("reader-pseudocode-syntax-ready")) {
          const walker = document.createTreeWalker(pre, NodeFilter.SHOW_TEXT);
          const textNodes: Text[] = [];

          while (walker.nextNode()) {
            const node = walker.currentNode;

            if (
              node instanceof Text &&
              !node.parentElement?.closest("a")
            ) {
              textNodes.push(node);
            }
          }

          textNodes.forEach((node) => {
            const fragment = document.createDocumentFragment();
            let textBuffer = "";
            let classified = false;

            Array.from(node.data).forEach((token) => {
              const tokenClass = getReaderMathTokenClass(token);
              const isInfinity = token === "∞";

              if (!tokenClass && !isInfinity) {
                textBuffer += token;
                return;
              }

              if (textBuffer) {
                fragment.append(document.createTextNode(textBuffer));
                textBuffer = "";
              }

              const span = document.createElement("span");
              span.className = isInfinity
                ? "reader-pseudocode-infinity"
                : `reader-pseudocode-math-token ${tokenClass}`;
              span.textContent = token;
              fragment.append(span);
              classified = true;
            });

            if (!classified) return;
            if (textBuffer) {
              fragment.append(document.createTextNode(textBuffer));
            }
            node.replaceWith(fragment);
          });

          pre.classList.add("reader-pseudocode-syntax-ready");
        }
      }

      sibling = sibling.nextElementSibling;
    }
  });
}

function prepareReaderVideoPlayers(
  root: ParentNode,
  cleanups: Array<() => void>,
) {
  const media: HTMLMediaElement[] = [];

  if (root instanceof HTMLMediaElement) {
    media.push(root);
  }

  root
    .querySelectorAll?.<HTMLMediaElement>("audio, video")
    .forEach((element) => media.push(element));

  media.forEach((element) => {
    let changed = false;
    const directSource = element.getAttribute("src");

    if (directSource?.startsWith("//upload.wikimedia.org/")) {
      element.setAttribute("src", "https:" + directSource);
      changed = true;
    }

    const poster = element.getAttribute("poster");

    if (poster && /^\/\/(?:upload|thumb)\.wikimedia\.org\//i.test(poster)) {
      element.setAttribute("poster", "https:" + poster);
      changed = true;
    }

    element
      .querySelectorAll<HTMLSourceElement>(`source[src^="//upload.wikimedia.org/"]`)
      .forEach((source) => {
        const sourceUrl = source.getAttribute("src");
        if (!sourceUrl) return;

        source.setAttribute("src", "https:" + sourceUrl);
        changed = true;
      });

    if (changed) element.load();
  });

  const videos: HTMLVideoElement[] = [];

  if (root instanceof HTMLVideoElement) {
    videos.push(root);
  }

  root
    .querySelectorAll?.<HTMLVideoElement>(".reader-article video, video")
    .forEach((video) => videos.push(video));

  const icons = {
    centralPlay: `
      <svg viewBox="0 0 28 32" aria-hidden="true">
        <path d="M5 4 L24 16 L5 28 Z"></path>
      </svg>
    `,
    play: `
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M6 4.5 L15 10 L6 15.5 Z"></path>
      </svg>
    `,
    pause: `
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M6.5 4.5 V15.5"></path>
        <path d="M13.5 4.5 V15.5"></path>
      </svg>
    `,
    replay: `
      <span class="reader-video-replay-glyph" aria-hidden="true">↺</span>
    `,
    expand: `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M9 4H4v5"></path>
        <path d="M4 4l6 6"></path>
        <path d="M15 20h5v-5"></path>
        <path d="M20 20l-6-6"></path>
      </svg>
    `,
  };

  videos.forEach((video) => {
    if (
      video.dataset.readerVideoReady === "true" ||
      !video.closest(".reader-article")
    ) {
      return;
    }

    const host = video.parentElement;
    if (!host) return;

    video.dataset.readerVideoReady = "true";
    video.controls = false;
    video.playsInline = true;
    video.preload = "metadata";
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");

    if (video.poster) {
      host.style.setProperty(
        "--reader-video-thumbnail-image",
        `url(${JSON.stringify(video.poster)})`,
      );
      host.classList.add("reader-video-thumbnail-reset");
    }

    host.classList.add("reader-video-host");

    const centralPlay = document.createElement("button");
    centralPlay.type = "button";
    centralPlay.className = "reader-video-overlay-play";
    centralPlay.setAttribute("aria-label", "Play video");
    centralPlay.innerHTML = icons.centralPlay;

    const expand = document.createElement("button");
    expand.type = "button";
    expand.className = "reader-video-expand";
    expand.setAttribute("aria-label", "Expand video");
    expand.title = "Expand video";
    expand.innerHTML = icons.expand;

    const controls = document.createElement("div");
    controls.className = "reader-video-controls";
    controls.setAttribute("role", "group");
    controls.setAttribute("aria-label", "Video controls");

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "reader-video-control-button";
    toggle.setAttribute("aria-label", "Play video");
    toggle.innerHTML = icons.play;

    const timeline = document.createElement("input");
    timeline.type = "range";
    timeline.className = "reader-video-timeline";
    timeline.min = "0";
    timeline.max = "1000";
    timeline.step = "1";
    timeline.value = "0";
    timeline.setAttribute("aria-label", "Video timeline");

    controls.append(toggle, timeline);
    host.append(centralPlay, expand, controls);

    let scrubbing = false;

    const update = () => {
      const duration = Number.isFinite(video.duration)
        ? video.duration
        : 0;
      const progress =
        duration > 0
          ? Math.min(1, Math.max(0, video.currentTime / duration))
          : 0;

      if (!scrubbing) {
        timeline.value = String(Math.round(progress * 1000));
      }

      timeline.style.setProperty(
        "--reader-video-progress",
        `${progress * 100}%`,
      );

      const playing = !video.paused && !video.ended;

      /*
       * Inline thumbnails return to Wikipedia's supplied poster image
       * when playback ends. Expanded videos retain their Replay state.
       */
      if (
        video.ended &&
        !video.closest(".reader-expanded-video-stage")
      ) {
        if (video.poster) {
          host.classList.add("reader-video-thumbnail-reset");
        }

        video.load();

        host.classList.remove(
          "reader-video-playing",
          "reader-video-ended",
          "reader-video-hovering",
        );

        timeline.value = "0";
        timeline.style.setProperty(
          "--reader-video-progress",
          "0%",
        );

        toggle.innerHTML = icons.play;
        toggle.setAttribute("aria-label", "Play video");
        centralPlay.innerHTML = icons.centralPlay;
        centralPlay.setAttribute("aria-label", "Play video");
        return;
      }

      host.classList.toggle("reader-video-playing", playing);
      host.classList.toggle("reader-video-ended", video.ended);

      if (playing) {
        host.classList.remove("reader-video-thumbnail-reset");
      }

      if (video.ended) {
        toggle.innerHTML = icons.replay;
        toggle.setAttribute("aria-label", "Replay video");
        centralPlay.innerHTML = icons.replay;
        centralPlay.setAttribute("aria-label", "Replay video");
      } else if (video.paused) {
        toggle.innerHTML = icons.play;
        toggle.setAttribute("aria-label", "Play video");
        centralPlay.innerHTML = icons.centralPlay;
        centralPlay.setAttribute("aria-label", "Play video");
      } else {
        toggle.innerHTML = icons.pause;
        toggle.setAttribute("aria-label", "Pause video");
        centralPlay.setAttribute("aria-label", "Pause video");
      }
    };

    const playVideo = async () => {
      if (video.ended) {
        video.currentTime = 0;
      }

      try {
        await video.play();
      } catch (error) {
        console.error("Reader video playback failed:", error);
      }

      update();
    };

    const togglePlayback = async () => {
      if (video.paused || video.ended) {
        await playVideo();
      } else {
        video.pause();
        update();
      }
    };

    const stopControlEvent = (event: Event) => {
      event.stopPropagation();
    };

    const handleCentralPlay = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      void togglePlayback();
    };

    const handleVideoClick = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      void togglePlayback();
    };

    const handleToggle = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      void togglePlayback();
    };

    const handleExpand = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();

      const startTime = video.currentTime <= 5 ? 0 : video.currentTime;

      video.dispatchEvent(
        new CustomEvent("reader-video-expand-request", {
          bubbles: true,
          detail: {
            startTime,
            source: video.currentSrc,
          },
        }),
      );
    };

    const showHoverControls = () => {
      host.classList.add("reader-video-hovering");
    };

    const hideHoverControls = (event: PointerEvent) => {
      if (
        event.relatedTarget instanceof Node &&
        host.contains(event.relatedTarget)
      ) {
        return;
      }

      host.classList.remove("reader-video-hovering");
    };

    const handleTimelinePointerDown = (event: Event) => {
      event.stopPropagation();
      scrubbing = true;
    };

    const handleTimelineInput = (event: Event) => {
      event.stopPropagation();

      if (!Number.isFinite(video.duration)) return;

      const progress = Number(timeline.value) / 1000;
      video.currentTime = progress * video.duration;
      timeline.style.setProperty(
        "--reader-video-progress",
        `${progress * 100}%`,
      );
    };

    const handleTimelineChange = (event: Event) => {
      event.stopPropagation();
      scrubbing = false;
      update();
    };

    const guardedElements = [controls, expand];
    const guardedEvents = [
      "click",
      "pointerdown",
      "pointerup",
      "mousedown",
      "mouseup",
    ];

    guardedElements.forEach((element) => {
      guardedEvents.forEach((eventName) => {
        element.addEventListener(eventName, stopControlEvent);
      });
    });

    centralPlay.addEventListener("click", handleCentralPlay);
    video.addEventListener("click", handleVideoClick);
    toggle.addEventListener("click", handleToggle);
    expand.addEventListener("click", handleExpand);

    timeline.addEventListener(
      "pointerdown",
      handleTimelinePointerDown,
    );
    timeline.addEventListener("input", handleTimelineInput);
    timeline.addEventListener("change", handleTimelineChange);

    video.addEventListener("pointerenter", showHoverControls);
    video.addEventListener("pointermove", showHoverControls);
    host.addEventListener("pointerenter", showHoverControls);
    host.addEventListener("pointermove", showHoverControls);
    host.addEventListener("pointerleave", hideHoverControls);

    const stateEvents = [
      "loadedmetadata",
      "durationchange",
      "timeupdate",
      "play",
      "pause",
      "ended",
      "volumechange",
    ];

    stateEvents.forEach((eventName) => {
      video.addEventListener(eventName, update);
    });

    cleanups.push(() => {
      guardedElements.forEach((element) => {
        guardedEvents.forEach((eventName) => {
          element.removeEventListener(eventName, stopControlEvent);
        });
      });

      centralPlay.removeEventListener("click", handleCentralPlay);
      video.removeEventListener("click", handleVideoClick);
      toggle.removeEventListener("click", handleToggle);
      expand.removeEventListener("click", handleExpand);

      timeline.removeEventListener(
        "pointerdown",
        handleTimelinePointerDown,
      );
      timeline.removeEventListener("input", handleTimelineInput);
      timeline.removeEventListener("change", handleTimelineChange);

      video.removeEventListener("pointerenter", showHoverControls);
      video.removeEventListener("pointermove", showHoverControls);
      host.removeEventListener("pointerenter", showHoverControls);
      host.removeEventListener("pointermove", showHoverControls);
      host.removeEventListener("pointerleave", hideHoverControls);

      stateEvents.forEach((eventName) => {
        video.removeEventListener(eventName, update);
      });

      centralPlay.remove();
      expand.remove();
      controls.remove();
      host.classList.remove(
        "reader-video-host",
        "reader-video-playing",
        "reader-video-ended",
        "reader-video-hovering",
        "reader-video-thumbnail-reset",
      );
      host.style.removeProperty("--reader-video-thumbnail-image");
      delete video.dataset.readerVideoReady;
    });

    update();
  });
}



function prepareReaderExpandedVideoPlayer(
  root: HTMLElement,
  cleanups: Array<() => void>,
) {
  if (root.dataset.readerExpandedVideoReady === "true") return;
  root.dataset.readerExpandedVideoReady = "true";

  type ModalSession = {
    video: HTMLVideoElement;
    modal: HTMLDivElement;
    close: () => void;
  };

  let session: ModalSession | null = null;

  const playIcon = `
    <svg viewBox="0 0 28 32" aria-hidden="true">
      <path d="M5 4 L24 16 L5 28 Z"></path>
    </svg>
  `;

  const smallPlayIcon = `
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M6 4.5 L15 10 L6 15.5 Z"></path>
    </svg>
  `;

  const pauseIcon = `
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M6.5 4.5 V15.5"></path>
      <path d="M13.5 4.5 V15.5"></path>
    </svg>
  `;

  const replayIcon = `
    <span class="reader-video-replay-glyph" aria-hidden="true">↺</span>
  `;

  const fitModal = (
    modal: HTMLElement,
    panel: HTMLElement,
    video: HTMLVideoElement,
  ) => {
    const content = modal.parentElement;
    if (!content || !video.videoWidth || !video.videoHeight) return;

    const rect = content.getBoundingClientRect();
    const ratio = video.videoWidth / video.videoHeight;
    const maximumWidth = Math.min(1040, Math.max(160, rect.width - 44));
    const maximumHeight = Math.max(120, rect.height - 44);

    let width = maximumWidth;
    let height = width / ratio;

    if (height > maximumHeight) {
      height = maximumHeight;
      width = height * ratio;
    }

    panel.style.setProperty("width", `${Math.floor(width)}px`, "important");
    panel.style.setProperty("height", `${Math.floor(height)}px`, "important");
  };

  const openModal = async (
    thumbnailVideo: HTMLVideoElement,
    requestedStartTime: number,
  ) => {
    session?.close();

    const content =
      thumbnailVideo.closest<HTMLElement>(".browser-content");

    if (!content) return;

    thumbnailVideo.pause();

    const video =
      thumbnailVideo.cloneNode(true) as HTMLVideoElement;

    delete video.dataset.readerVideoReady;
    video.controls = false;
    video.playsInline = true;
    video.preload = "metadata";
    video.setAttribute("playsinline", "");
    video.setAttribute("webkit-playsinline", "");

    const hdSource = Array.from(
      video.querySelectorAll<HTMLSourceElement>("source"),
    )
      .filter((source) => {
        const height = Number(source.dataset.height || 0);

        return (
          height >= 720 &&
          video.canPlayType(
            source.type || "video/webm",
          ) !== ""
        );
      })
      .sort((first, second) => {
        const heightDifference =
          Number(first.dataset.height) -
          Number(second.dataset.height);

        if (heightDifference !== 0) {
          return heightDifference;
        }

        return (
          Number(!first.src.includes("/transcoded/")) -
          Number(!second.src.includes("/transcoded/"))
        );
      })[0];

    if (hdSource) {
      video.removeAttribute("src");
      video.prepend(hdSource);
      video.dataset.readerExpandedVideoQuality =
        hdSource.dataset.height || "720";
    }

    const modal = document.createElement("div");
    modal.className = "reader-expanded-video-modal";

    // Hide the media player until its final dimensions are ready.
    modal.style.setProperty(
      "visibility",
      "hidden",
      "important",
    );

    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", "Expanded video");

    const panel = document.createElement("div");
    panel.className = "reader-expanded-video-panel";

    const stage = document.createElement("div");
    stage.className = "reader-expanded-video-stage";

    const centralPlay = document.createElement("button");
    centralPlay.type = "button";
    centralPlay.className = "reader-expanded-video-play";
    centralPlay.setAttribute("aria-label", "Play video");
    centralPlay.innerHTML = playIcon;

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "reader-expanded-video-close";
    closeButton.setAttribute("aria-label", "Close expanded video");
    closeButton.title = "Close";
    closeButton.textContent = "×";

    /* ADAM EXPANDED VIDEO BUFFER INDICATOR */
    const bufferIndicator = document.createElement("div");
    bufferIndicator.className = "reader-expanded-video-buffer";
    bufferIndicator.setAttribute("role", "status");
    bufferIndicator.setAttribute("aria-label", "Buffering video");
    bufferIndicator.setAttribute("aria-live", "polite");
    bufferIndicator.hidden = true;

    const bufferSpinner = document.createElement("span");
    bufferSpinner.className =
      "reader-expanded-video-buffer-spinner";
    bufferSpinner.setAttribute("aria-hidden", "true");
    bufferIndicator.appendChild(bufferSpinner);

    /* ADAM EXPANDED VIDEO SETTINGS MENU */
    const settingsButton = document.createElement("button");
    settingsButton.type = "button";
    settingsButton.className = "reader-expanded-video-settings";
    settingsButton.setAttribute("aria-label", "Open video settings");
    settingsButton.setAttribute("aria-haspopup", "menu");
    settingsButton.setAttribute("aria-expanded", "false");
    settingsButton.title = "Video settings";
    settingsButton.innerHTML = `
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        fill="currentColor"
      >
        <path
          fill-rule="evenodd"
          d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.03-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.31-.09.65-.09.94s.03.63.08.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.04.24.24.41.48.41h3.84c.24 0 .44-.17.48-.41l.36-2.54c.59-.24 1.13-.57 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.03-1.58ZM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2Z"
        ></path>
      </svg>
    `;

    const settingsMenu = document.createElement("div");
    settingsMenu.className = "reader-expanded-video-settings-menu";
    settingsMenu.setAttribute("role", "menu");
    settingsMenu.hidden = true;

    const controls = document.createElement("div");
    controls.className = "reader-expanded-video-controls";
    controls.setAttribute("role", "group");
    controls.setAttribute("aria-label", "Expanded video controls");

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "reader-expanded-video-toggle";
    toggle.setAttribute("aria-label", "Pause video");
    toggle.innerHTML = pauseIcon;

    const timeline = document.createElement("input");
    timeline.type = "range";
    timeline.className = "reader-expanded-video-timeline";
    timeline.min = "0";
    timeline.max = "1000";
    timeline.step = "1";
    timeline.value = "0";
    timeline.setAttribute("aria-label", "Video timeline");

    /* ADAM EXPANDED VIDEO VERTICAL VOLUME */
    const speakerVolumeIcon = `
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M11 5 6.5 9H3v6h3.5l4.5 4V5Z"></path>
        <path d="M15.5 8.5a5 5 0 0 1 0 7"></path>
        <path d="M18 6a8.5 8.5 0 0 1 0 12"></path>
      </svg>
    `;

    const mutedVolumeIcon = `
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M11 5 6.5 9H3v6h3.5l4.5 4V5Z"></path>
        <path d="m16 9 5 5"></path>
        <path d="m21 9-5 5"></path>
      </svg>
    `;

    const volumeControl = document.createElement("div");
    volumeControl.className =
      "reader-expanded-video-volume";
    volumeControl.setAttribute("role", "group");
    volumeControl.setAttribute(
      "aria-label",
      "Expanded video volume controls",
    );

    const volumeButton = document.createElement("button");
    volumeButton.type = "button";
    volumeButton.className =
      "reader-expanded-video-volume-button";

    const volumeSliderHolder =
      document.createElement("div");
    volumeSliderHolder.className =
      "reader-expanded-video-volume-slider-holder";

    const volumeSlider = document.createElement("input");
    volumeSlider.type = "range";
    volumeSlider.className =
      "reader-expanded-video-volume-slider";
    volumeSlider.min = "0";
    volumeSlider.max = "100";
    volumeSlider.step = "1";
    volumeSlider.value = String(
      Math.round((video.muted ? 0 : video.volume) * 100),
    );
    volumeSlider.setAttribute("aria-label", "Video volume");

    volumeSliderHolder.appendChild(volumeSlider);
    volumeControl.append(
      volumeButton,
      volumeSliderHolder,
    );

    controls.append(toggle, timeline);
    stage.append(
      video,
      bufferIndicator,
      centralPlay,
      volumeControl,
      controls,
    );
    panel.append(
      stage,
      closeButton,
      settingsButton,
      settingsMenu,
    );
    modal.appendChild(panel);
    content.appendChild(modal);

    let scrubbing = false;

    type ReaderVideoFrameElement = HTMLVideoElement & {
      requestVideoFrameCallback?: (
        callback: () => void,
      ) => number;
      cancelVideoFrameCallback?: (handle: number) => void;
    };

    let bufferFrameVideo: ReaderVideoFrameElement | null = null;
    let bufferFrameCallbackId: number | null = null;
    let bufferHideAnimationFrameId: number | null = null;
    let bufferHideTimerId: number | null = null;

    const bufferShowEvents = [
      "loadstart",
      "emptied",
      "waiting",
      "stalled",
    ] as const;

    const bufferPausedReadyEvents = [
      "loadeddata",
      "seeked",
    ] as const;

    const cancelPendingBufferFrame = () => {
      if (
        bufferFrameVideo &&
        bufferFrameCallbackId !== null &&
        typeof bufferFrameVideo.cancelVideoFrameCallback ===
          "function"
      ) {
        bufferFrameVideo.cancelVideoFrameCallback(
          bufferFrameCallbackId,
        );
      }

      if (bufferHideAnimationFrameId !== null) {
        window.cancelAnimationFrame(
          bufferHideAnimationFrameId,
        );
      }

      if (bufferHideTimerId !== null) {
        window.clearTimeout(bufferHideTimerId);
      }

      bufferFrameVideo = null;
      bufferFrameCallbackId = null;
      bufferHideAnimationFrameId = null;
      bufferHideTimerId = null;
    };

    const finishHidingExpandedVideoBuffer = () => {
      bufferIndicator.hidden = true;
      stage.classList.remove(
        "reader-expanded-video-buffering",
      );
    };

    const hideExpandedVideoBuffer = () => {
      cancelPendingBufferFrame();
      finishHidingExpandedVideoBuffer();
    };

    const showExpandedVideoBuffer = (event: Event) => {
      if (!(event.target instanceof HTMLVideoElement)) return;

      cancelPendingBufferFrame();
      bufferIndicator.hidden = false;
      stage.classList.add(
        "reader-expanded-video-buffering",
      );
    };

    const hideExpandedVideoBufferAfterPaintedFrame = (
      event: Event,
    ) => {
      if (!(event.target instanceof HTMLVideoElement)) return;

      const mediaVideo =
        event.target as ReaderVideoFrameElement;

      cancelPendingBufferFrame();
      bufferFrameVideo = mediaVideo;

      if (
        typeof mediaVideo.requestVideoFrameCallback ===
          "function"
      ) {
        bufferFrameCallbackId =
          mediaVideo.requestVideoFrameCallback(() => {
            if (bufferFrameVideo !== mediaVideo) return;

            bufferFrameVideo = null;
            bufferFrameCallbackId = null;

            bufferHideAnimationFrameId =
              window.requestAnimationFrame(() => {
                bufferHideAnimationFrameId = null;
                finishHidingExpandedVideoBuffer();
              });
          });

        return;
      }

      bufferHideTimerId = window.setTimeout(() => {
        bufferHideTimerId = null;
        finishHidingExpandedVideoBuffer();
      }, 300);
    };

    const hidePausedExpandedVideoBuffer = (
      event: Event,
    ) => {
      const mediaVideo = event.target;

      if (
        !(mediaVideo instanceof HTMLVideoElement) ||
        !mediaVideo.paused ||
        mediaVideo.readyState <
          HTMLMediaElement.HAVE_CURRENT_DATA
      ) {
        return;
      }

      cancelPendingBufferFrame();

      bufferHideAnimationFrameId =
        window.requestAnimationFrame(() => {
          bufferHideAnimationFrameId =
            window.requestAnimationFrame(() => {
              bufferHideAnimationFrameId = null;
              finishHidingExpandedVideoBuffer();
            });
        });
    };

    const handleExpandedVideoBufferError = (
      event: Event,
    ) => {
      if (!(event.target instanceof HTMLVideoElement)) return;
      hideExpandedVideoBuffer();
    };
    let closed = false;

    type ReaderExpandedVideoQualityOption = {
      height: number;
      label: string;
      src: string;
    };

    const qualityByHeight =
      new Map<number, ReaderExpandedVideoQualityOption>();

    Array.from(
      video.querySelectorAll<HTMLSourceElement>("source"),
    ).forEach((source) => {
      const resolutionMatch = source.src.match(
        /(?:^|[./_-])(\d{3,4})p(?:\d+)?(?:[./_-]|$)/i,
      );

      if (!resolutionMatch) return;

      const height = Number(resolutionMatch[1]);

      if (
        !Number.isFinite(height) ||
        height <= 0 ||
        video.canPlayType(source.type || "video/webm") === "" ||
        qualityByHeight.has(height)
      ) {
        return;
      }

      qualityByHeight.set(height, {
        height,
        label: height === 2160 ? "4K" : `${height}p`,
        src: source.src,
      });
    });

    const qualityOptions = Array.from(
      qualityByHeight.values(),
    ).sort((first, second) => second.height - first.height);

    let selectedQualityHeight = Number(
      video.dataset.readerExpandedVideoQuality || 0,
    );

    if (!qualityByHeight.has(selectedQualityHeight)) {
      selectedQualityHeight =
        qualityOptions.find(
          (option) => option.src === video.currentSrc,
        )?.height ||
        qualityOptions[0]?.height ||
        0;
    }

    const originalSource = Array.from(
      video.querySelectorAll<HTMLSourceElement>("source"),
    ).find(
      (source) =>
        !/(?:^|[./_-])\d{3,4}p(?:\d+)?(?:[./_-]|$)/i.test(
          source.src,
        ),
    );

    let wikipediaFileUrl: string | null = null;

    if (originalSource) {
      try {
        const originalUrl = new URL(originalSource.src);
        const encodedFilename =
          originalUrl.pathname.split("/").pop();

        if (encodedFilename) {
          const filename = decodeURIComponent(encodedFilename);
          wikipediaFileUrl =
            `https://en.wikipedia.org/wiki/File:${
              encodeURIComponent(filename)
            }`;
        }
      } catch {
        wikipediaFileUrl = null;
      }
    }

    const speedLabel = (rate: number) =>
      rate === 1 ? "Normal" : `${rate}×`;

    const selectedQualityLabel = () =>
      qualityByHeight.get(selectedQualityHeight)?.label ||
      (selectedQualityHeight === 2160
        ? "4K"
        : `${selectedQualityHeight || video.videoHeight}p`);

    const renderSettingsMain = () => {
      const externalAction = wikipediaFileUrl
        ? `
          <div class="reader-expanded-video-settings-divider"></div>
          <button
            type="button"
            class="reader-expanded-video-settings-row"
            data-settings-action="external"
            role="menuitem"
          >
            <span>Open in Browser</span>
            <span class="reader-expanded-video-settings-value">↗</span>
          </button>
        `
        : "";

      settingsMenu.innerHTML = `
        <button
          type="button"
          class="reader-expanded-video-settings-row"
          data-settings-view="speed"
          role="menuitem"
        >
          <span>Playback speed</span>
          <span class="reader-expanded-video-settings-value">
            ${speedLabel(video.playbackRate)}&nbsp;›
          </span>
        </button>

        <button
          type="button"
          class="reader-expanded-video-settings-row"
          data-settings-view="quality"
          role="menuitem"
        >
          <span>Quality</span>
          <span class="reader-expanded-video-settings-value">
            ${selectedQualityLabel()}&nbsp;›
          </span>
        </button>

        ${externalAction}
      `;
    };

    const renderSettingsSpeeds = () => {
      const rates = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

      settingsMenu.innerHTML = `
        <button
          type="button"
          class="reader-expanded-video-settings-row reader-expanded-video-settings-heading"
          data-settings-view="main"
          role="menuitem"
        >
          <span>‹&nbsp;&nbsp;Playback speed</span>
        </button>

        <div class="reader-expanded-video-settings-divider"></div>

        ${rates.map((rate) => `
          <button
            type="button"
            class="reader-expanded-video-settings-row reader-expanded-video-settings-option"
            data-settings-speed="${rate}"
            role="menuitemradio"
            aria-checked="${video.playbackRate === rate}"
          >
            <span>${speedLabel(rate)}</span>
            <span class="reader-expanded-video-settings-check">
              ${video.playbackRate === rate ? "✓" : ""}
            </span>
          </button>
        `).join("")}
      `;
    };

    const renderSettingsQualities = () => {
      settingsMenu.innerHTML = `
        <button
          type="button"
          class="reader-expanded-video-settings-row reader-expanded-video-settings-heading"
          data-settings-view="main"
          role="menuitem"
        >
          <span>‹&nbsp;&nbsp;Quality</span>
        </button>

        <div class="reader-expanded-video-settings-divider"></div>

        ${qualityOptions.map((option) => `
          <button
            type="button"
            class="reader-expanded-video-settings-row reader-expanded-video-settings-option"
            data-settings-quality="${option.height}"
            role="menuitemradio"
            aria-checked="${selectedQualityHeight === option.height}"
          >
            <span>${option.label}</span>
            <span class="reader-expanded-video-settings-check">
              ${selectedQualityHeight === option.height ? "✓" : ""}
            </span>
          </button>
        `).join("")}
      `;
    };

    const setSettingsOpen = (open: boolean) => {
      if (open) renderSettingsMain();

      settingsMenu.hidden = !open;
      settingsButton.setAttribute(
        "aria-expanded",
        String(open),
      );
    };

    const selectExpandedVideoQuality = (
      option: ReaderExpandedVideoQualityOption,
    ) => {
      const previousTime = video.currentTime;
      const wasPaused = video.paused;
      const previousPlaybackRate = video.playbackRate;

      selectedQualityHeight = option.height;
      video.dataset.readerExpandedVideoQuality =
        String(option.height);

      if (
        video.currentSrc === option.src ||
        video.src === option.src
      ) {
        renderSettingsMain();
        return;
      }

      video.addEventListener(
        "loadedmetadata",
        async () => {
          if (closed) return;

          video.currentTime = Math.min(
            previousTime,
            Math.max(0, video.duration - 0.25),
          );

          video.defaultPlaybackRate = previousPlaybackRate;
          video.playbackRate = previousPlaybackRate;

          if (!wasPaused) {
            try {
              await video.play();
            } catch {
              // Leave the restored video paused if autoplay is blocked.
            }
          }
        },
        { once: true },
      );

      video.src = option.src;
      video.load();
      renderSettingsMain();
    };

    renderSettingsMain();

    let lastNonzeroVolume =
      video.volume > 0 ? video.volume : 0.5;

    /* ADAM VOLUME DRAG RESTORE */
    let volumeSliderDragging = false;
    let volumeBeforeDrag: number | null = null;

    const updateVolume = () => {
      if (
        !volumeSliderDragging &&
        !video.muted &&
        video.volume > 0
      ) {
        lastNonzeroVolume = video.volume;
      }

      const effectiveVolume = video.muted
        ? 0
        : video.volume;
      const percentage = Math.round(
        effectiveVolume * 100,
      );

      volumeSlider.value = String(percentage);
      volumeSlider.style.setProperty(
        "--reader-expanded-volume",
        `${percentage}%`,
      );

      volumeButton.innerHTML = video.muted
        ? mutedVolumeIcon
        : speakerVolumeIcon;
      volumeButton.setAttribute(
        "aria-label",
        video.muted ? "Unmute video" : "Mute video",
      );
      volumeButton.title = video.muted
        ? "Unmute"
        : "Mute";
    };

    const update = () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      const progress =
        duration > 0
          ? Math.min(1, Math.max(0, video.currentTime / duration))
          : 0;
      const playing = !video.paused && !video.ended;

      if (!scrubbing) {
        timeline.value = String(Math.round(progress * 1000));
      }

      timeline.style.setProperty(
        "--reader-expanded-video-progress",
        `${progress * 100}%`,
      );

      stage.classList.toggle("reader-expanded-video-playing", playing);
      stage.classList.toggle("reader-expanded-video-paused", !playing);

      if (video.ended) {
        centralPlay.innerHTML = replayIcon;
        centralPlay.setAttribute("aria-label", "Replay video");

        toggle.innerHTML = replayIcon;
        toggle.setAttribute("aria-label", "Replay video");

        timeline.value = "1000";
        timeline.style.setProperty(
          "--reader-expanded-video-progress",
          "100%",
        );
      } else {
        centralPlay.innerHTML = playIcon;
        centralPlay.setAttribute("aria-label", "Play video");

        toggle.innerHTML = playing ? pauseIcon : smallPlayIcon;
        toggle.setAttribute(
          "aria-label",
          playing ? "Pause video" : "Play video",
        );
      }
    };

    const togglePlayback = async () => {
      if (video.paused || video.ended) {
        if (video.ended) video.currentTime = 0;

        try {
          await video.play();
        } catch (error) {
          console.error("Expanded video playback failed:", error);
        }
      } else {
        video.pause();
      }

      update();
    };

    /*
     * Capture-phase interception prevents the permanent thumbnail click
     * handler from also firing after the video is moved into the modal.
     */
    const handleVideoClick = (event: globalThis.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      void togglePlayback();
    };

    const handleCentralPlay = (event: globalThis.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      void togglePlayback();
    };

    const handleToggle = (event: globalThis.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      void togglePlayback();
    };

    const stopControls = (event: Event) => {
      event.stopPropagation();
    };

    const handleSettingsButton = (
      event: globalThis.MouseEvent,
    ) => {
      event.preventDefault();
      event.stopPropagation();
      setSettingsOpen(settingsMenu.hidden);
    };

    const handleSettingsMenu = async (
      event: globalThis.MouseEvent,
    ) => {
      event.stopPropagation();

      if (!(event.target instanceof Element)) return;

      const button =
        event.target.closest<HTMLButtonElement>("button");

      if (!button || !settingsMenu.contains(button)) return;

      event.preventDefault();

      const view = button.dataset.settingsView;

      if (view === "main") {
        renderSettingsMain();
        return;
      }

      if (view === "speed") {
        renderSettingsSpeeds();
        return;
      }

      if (view === "quality") {
        renderSettingsQualities();
        return;
      }

      if (button.dataset.settingsSpeed !== undefined) {
        const rate = Number(button.dataset.settingsSpeed);

        if (Number.isFinite(rate) && rate > 0) {
          video.defaultPlaybackRate = rate;
          video.playbackRate = rate;
        }

        renderSettingsMain();
        return;
      }

      if (button.dataset.settingsQuality !== undefined) {
        const height = Number(
          button.dataset.settingsQuality,
        );
        const option = qualityByHeight.get(height);

        if (option) {
          selectExpandedVideoQuality(option);
        }

        return;
      }

      if (
        button.dataset.settingsAction === "external" &&
        wikipediaFileUrl
      ) {
        setSettingsOpen(false);

        try {
          await openExternalUrl(wikipediaFileUrl);
        } catch (error) {
          console.error(
            "Could not open Wikipedia video page:",
            error,
          );
        }
      }
    };

    const handlePanelPointerLeave = (
      event: PointerEvent,
    ) => {
      if (
        event.relatedTarget instanceof Node &&
        panel.contains(event.relatedTarget)
      ) {
        return;
      }

      setSettingsOpen(false);
      renderSettingsMain();
    };

    const showControls = () => {
      stage.classList.add("reader-expanded-video-hovering");
    };

    const hideControls = (event: PointerEvent) => {
      if (
        event.relatedTarget instanceof Node &&
        stage.contains(event.relatedTarget)
      ) {
        return;
      }

      stage.classList.remove("reader-expanded-video-hovering");
    };

    const handleVolumeDragStart = () => {
      volumeSliderDragging = true;
      volumeBeforeDrag =
        !video.muted && video.volume > 0
          ? video.volume
          : lastNonzeroVolume;
    };

    const handleVolumeDragEnd = () => {
      volumeSliderDragging = false;

      if (!video.muted && video.volume > 0) {
        lastNonzeroVolume = video.volume;
      } else if (
        video.volume === 0 &&
        volumeBeforeDrag !== null &&
        volumeBeforeDrag > 0
      ) {
        lastNonzeroVolume = volumeBeforeDrag;
      }

      volumeBeforeDrag = null;
    };

    const handleVolumeInput = (event: Event) => {
      event.stopPropagation();

      const volume = Math.min(
        1,
        Math.max(0, Number(volumeSlider.value) / 100),
      );

      if (volume > 0 && !volumeSliderDragging) {
        lastNonzeroVolume = volume;
      }

      video.volume = volume;
      video.muted = volume === 0;
      updateVolume();
    };

    const handleVolumeToggle = (
      event: globalThis.MouseEvent,
    ) => {
      event.preventDefault();
      event.stopPropagation();

      if (video.muted || video.volume === 0) {
        if (video.volume === 0) {
          video.volume = lastNonzeroVolume || 0.5;
        }

        video.muted = false;
      } else {
        lastNonzeroVolume = video.volume;
        video.muted = true;
      }

      updateVolume();
    };

    const handleVolumeChange = () => {
      updateVolume();
    };

    const handleTimelineInput = (event: Event) => {
      event.stopPropagation();
      if (!Number.isFinite(video.duration)) return;

      const progress = Number(timeline.value) / 1000;
      video.currentTime = progress * video.duration;
      timeline.style.setProperty(
        "--reader-expanded-video-progress",
        `${progress * 100}%`,
      );
    };

    const stateEvents = [
      "play",
      "pause",
      "ended",
      "timeupdate",
      "durationchange",
      "loadedmetadata",
    ];

    const close = () => {
      if (closed) return;
      closed = true;

      video.pause();

      video.removeEventListener("click", handleVideoClick, true);
      centralPlay.removeEventListener("click", handleCentralPlay);
      toggle.removeEventListener("click", handleToggle);
      controls.removeEventListener("click", stopControls);
      controls.removeEventListener("pointerdown", stopControls);
      settingsButton.removeEventListener(
        "click",
        handleSettingsButton,
      );
      settingsMenu.removeEventListener(
        "click",
        handleSettingsMenu,
      );
      panel.removeEventListener(
        "pointerleave",
        handlePanelPointerLeave,
      );
      volumeButton.removeEventListener(
        "click",
        handleVolumeToggle,
      );
      volumeControl.removeEventListener(
        "click",
        stopControls,
      );
      volumeControl.removeEventListener(
        "pointerdown",
        stopControls,
      );
      volumeSlider.removeEventListener(
        "pointerdown",
        handleVolumeDragStart,
      );
      volumeSlider.removeEventListener(
        "change",
        handleVolumeDragEnd,
      );
      volumeSlider.removeEventListener(
        "input",
        handleVolumeInput,
      );
      video.removeEventListener(
        "volumechange",
        handleVolumeChange,
      );
      timeline.removeEventListener("input", handleTimelineInput);
      bufferShowEvents.forEach((name) =>
        stage.removeEventListener(
          name,
          showExpandedVideoBuffer,
          true,
        ),
      );
      bufferPausedReadyEvents.forEach((name) =>
        stage.removeEventListener(
          name,
          hidePausedExpandedVideoBuffer,
          true,
        ),
      );
      stage.removeEventListener(
        "playing",
        hideExpandedVideoBufferAfterPaintedFrame,
        true,
      );
      stage.removeEventListener(
        "error",
        handleExpandedVideoBufferError,
        true,
      );
      hideExpandedVideoBuffer();
      stage.removeEventListener("pointerenter", showControls);
      stage.removeEventListener("pointermove", showControls);
      stage.removeEventListener("pointerleave", hideControls);
      stateEvents.forEach((name) => video.removeEventListener(name, update));
      resizeObserver.disconnect();
      document.removeEventListener("keydown", handleKeyDown);

      if (video.ended) {
        thumbnailVideo.currentTime = 0;
        thumbnailVideo.load();

        if (thumbnailVideo.poster) {
          thumbnailVideo
            .closest(".reader-video-host")
            ?.classList.add(
              "reader-video-thumbnail-reset",
            );
        }
      } else if (Number.isFinite(video.currentTime)) {
        thumbnailVideo.currentTime = video.currentTime;
      }

      video.remove();
      modal.remove();
      thumbnailVideo.dispatchEvent(
        new Event("timeupdate"),
      );
      thumbnailVideo.dispatchEvent(new Event("pause"));

      if (session?.modal === modal) session = null;
    };

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
    };

    const resizeObserver = new ResizeObserver(() => {
      fitModal(modal, panel, video);
    });

    video.addEventListener("click", handleVideoClick, true);
    centralPlay.addEventListener("click", handleCentralPlay);
    toggle.addEventListener("click", handleToggle);
    controls.addEventListener("click", stopControls);
    controls.addEventListener("pointerdown", stopControls);
    settingsButton.addEventListener(
      "click",
      handleSettingsButton,
    );
    settingsMenu.addEventListener(
      "click",
      handleSettingsMenu,
    );
    panel.addEventListener(
      "pointerleave",
      handlePanelPointerLeave,
    );
    volumeButton.addEventListener(
      "click",
      handleVolumeToggle,
    );
    volumeControl.addEventListener(
      "click",
      stopControls,
    );
    volumeControl.addEventListener(
      "pointerdown",
      stopControls,
    );
    volumeSlider.addEventListener(
      "pointerdown",
      handleVolumeDragStart,
    );
    volumeSlider.addEventListener(
      "change",
      handleVolumeDragEnd,
    );
    volumeSlider.addEventListener(
      "input",
      handleVolumeInput,
    );
    video.addEventListener(
      "volumechange",
      handleVolumeChange,
    );

    timeline.addEventListener("pointerdown", (event) => {
      event.stopPropagation();
      scrubbing = true;
    });

    timeline.addEventListener("input", handleTimelineInput);

    timeline.addEventListener("change", (event) => {
      event.stopPropagation();
      scrubbing = false;
      update();
    });

    closeButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      close();
    });

    modal.addEventListener("click", (event) => {
      if (event.target === modal) close();
    });

    bufferShowEvents.forEach((name) =>
      stage.addEventListener(
        name,
        showExpandedVideoBuffer,
        true,
      ),
    );
    bufferPausedReadyEvents.forEach((name) =>
      stage.addEventListener(
        name,
        hidePausedExpandedVideoBuffer,
        true,
      ),
    );
    stage.addEventListener(
      "playing",
      hideExpandedVideoBufferAfterPaintedFrame,
      true,
    );
    stage.addEventListener(
      "error",
      handleExpandedVideoBufferError,
      true,
    );
    stage.addEventListener("pointerenter", showControls);
    stage.addEventListener("pointermove", showControls);
    stage.addEventListener("pointerleave", hideControls);
    stateEvents.forEach((name) => video.addEventListener(name, update));
    document.addEventListener("keydown", handleKeyDown);
    resizeObserver.observe(content);

    session = {
      video,
      modal,
      close,
    };

    updateVolume();
    video.load();

    if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
      await new Promise<void>((resolve) => {
        const finish = () => {
          video.removeEventListener(
            "loadedmetadata",
            finish,
          );
          video.removeEventListener("error", finish);
          resolve();
        };

        video.addEventListener(
          "loadedmetadata",
          finish,
          { once: true },
        );
        video.addEventListener(
          "error",
          finish,
          { once: true },
        );
      });
    }

    if (closed) return;

    if (Number.isFinite(video.duration)) {
      video.currentTime = Math.min(
        requestedStartTime,
        video.duration,
      );
    }

    fitModal(modal, panel, video);
    update();

    try {
      await video.play();
    } catch (error) {
      console.error("Expanded video could not autoplay:", error);
    }

    fitModal(modal, panel, video);
    update();

    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve());
      });
    });

    if (closed) return;

    modal.style.removeProperty("visibility");
    closeButton.focus();
  };

  const handleExpandRequest = (event: Event) => {
    if (!(event instanceof CustomEvent)) return;

    const video = event.target;
    if (!(video instanceof HTMLVideoElement)) return;

    const requestedStartTime =
      Number(event.detail?.startTime) ||
      (video.currentTime <= 5 ? 0 : video.currentTime);

    void openModal(video, requestedStartTime);
  };

  root.addEventListener(
    "reader-video-expand-request",
    handleExpandRequest,
  );

  cleanups.push(() => {
    session?.close();
    root.removeEventListener(
      "reader-video-expand-request",
      handleExpandRequest,
    );
    delete root.dataset.readerExpandedVideoReady;
  });
}


const MemoReaderArticleHtml = memo(
  function ReaderArticleHtml({
    html,
    onClick,
    isActive,
  }: {
    html: string;
    onClick: (event: MouseEvent<HTMLDivElement>) => void;
    isActive: boolean;
  }) {
  const articleRef = useRef<HTMLDivElement | null>(null);
  const linkStatusRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const root = articleRef.current;
    if (!root || !isActive) return;

    const mathWrappers = Array.from(
      root.querySelectorAll<HTMLElement>(".mwe-math-element"),
    );
    const originalOpacity = new Map(
      mathWrappers.map((wrapper) => [
        wrapper,
        {
          value: wrapper.style.getPropertyValue("opacity"),
          priority: wrapper.style.getPropertyPriority("opacity"),
        },
      ]),
    );

    const restoreMathOpacity = () => {
      mathWrappers.forEach((wrapper) => {
        const original = originalOpacity.get(wrapper);
        if (!original) return;

        if (original.value) {
          wrapper.style.setProperty(
            "opacity",
            original.value,
            original.priority,
          );
        } else {
          wrapper.style.removeProperty("opacity");
        }
      });
    };

    mathWrappers.forEach((wrapper) => {
      wrapper.style.setProperty("opacity", "0", "important");
    });
    prepareReaderMathSyntax(root);

    let textPaintFrame: number | null = null;
    let mathRevealFrame: number | null = null;

    const waitForArticleVisibility = () => {
      if (window.getComputedStyle(root).visibility !== "visible") {
        textPaintFrame = window.requestAnimationFrame(waitForArticleVisibility);
        return;
      }

      textPaintFrame = window.requestAnimationFrame(() => {
        textPaintFrame = null;
        mathRevealFrame = window.requestAnimationFrame(() => {
          mathRevealFrame = null;
          restoreMathOpacity();
        });
      });
    };

    textPaintFrame = window.requestAnimationFrame(waitForArticleVisibility);

    return () => {
      if (textPaintFrame !== null) {
        window.cancelAnimationFrame(textPaintFrame);
      }
      if (mathRevealFrame !== null) {
        window.cancelAnimationFrame(mathRevealFrame);
      }
      restoreMathOpacity();
    };
  }, [html, isActive]);

  const handleLinkMouseOver = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target;
    const root = articleRef.current;
    const status = linkStatusRef.current;

    if (!(target instanceof Element) || !root || !status) return;

    const imageMapArea = target.closest<HTMLAreaElement>("area[href]");
    const mapName = imageMapArea?.closest("map")?.getAttribute("name") || "";

    if (imageMapArea && /^timeline_/i.test(mapName)) {
      const reader = root.closest<HTMLElement>(".wikipedia-reader");
      if (reader) {
        const readerRect = reader.getBoundingClientRect();
        status.textContent = imageMapArea.alt || imageMapArea.title || imageMapArea.href;
        status.style.left = `${Math.max(4, readerRect.left + 4)}px`;
        status.style.bottom = "4px";
        status.style.maxWidth = `${Math.max(120, Math.min(720, readerRect.width - 8))}px`;
        status.hidden = false;
      }
      return;
    }

    const link = target.closest<HTMLAnchorElement>("a");

    if (!link || !root.contains(link)) return;

    const wikiTarget = link.dataset.wikiTarget;
    const href = link.getAttribute("href");

    let destination = wikiTarget || "";

    if (!destination && href) {
      if (href.startsWith("//")) {
        destination = `https:${href}`;
      } else {
        try {
          destination = new URL(href, window.location.href).href;
        } catch {
          destination = href;
        }
      }
    }

    if (!destination) return;

    const reader = root.closest<HTMLElement>(".wikipedia-reader");

    if (!reader) return;

    const readerRect = reader.getBoundingClientRect();

    status.textContent = wikiTarget
      ? wikiTarget.replace(/_/g, " ")
      : destination;
    status.style.left = `${Math.max(4, readerRect.left + 4)}px`;
    status.style.bottom = "4px";
    status.style.maxWidth = `${Math.max(
      120,
      Math.min(720, readerRect.width - 8),
    )}px`;
    status.hidden = false;
  };

  const handleLinkMouseOut = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target;
    const root = articleRef.current;
    const status = linkStatusRef.current;

    if (!(target instanceof Element) || !root || !status) return;

    const imageMapArea = target.closest<HTMLAreaElement>("area[href]");
    const mapName = imageMapArea?.closest("map")?.getAttribute("name") || "";
    if (imageMapArea && /^timeline_/i.test(mapName)) {
      status.hidden = true;
      status.textContent = "";
      return;
    }

    const link = target.closest<HTMLAnchorElement>("a");

    if (!link || !root.contains(link)) return;

    if (
      event.relatedTarget instanceof Node &&
      link.contains(event.relatedTarget)
    ) {
      return;
    }

    status.hidden = true;
    status.textContent = "";
  };

  useEffect(() => {
    const status = linkStatusRef.current;

    if (status) {
      status.hidden = true;
      status.textContent = "";
    }

    const root = articleRef.current;
    if (!root || !isActive) return;

    readerApplyMultipleImageAspectRatios(root.ownerDocument);
    readerApplyInfoboxMultipleImageAspectRatios(root.ownerDocument);

    const cleanups: Array<() => void> = [];

    const syncNavboxToggleLabel = (details: HTMLDetailsElement) => {
      const label = details.querySelector<HTMLElement>(
        ".reader-navbox-show-label",
      );

      if (label) {
        label.textContent = details.open ? "hide" : "show";
      }
    };

    root
      .querySelectorAll<HTMLDetailsElement>("details.reader-navbox-details")
      .forEach(syncNavboxToggleLabel);

    const handleNavboxToggle = (event: Event) => {
      const target = event.target;

      if (
        target instanceof HTMLDetailsElement &&
        target.matches("details.reader-navbox-details")
      ) {
        syncNavboxToggleLabel(target);
      }
    };

    // The article is injected from an HTML string, so listeners attached while
    // building its temporary document do not survive. Capture native toggle
    // events on the rendered article and keep each visible label in sync.
    root.addEventListener("toggle", handleNavboxToggle, true);
    cleanups.push(() =>
      root.removeEventListener("toggle", handleNavboxToggle, true),
    );

    let locationMapLayoutFrame: number | null = null;
    let normalTableCornerLayoutFrame: number | null = null;
    let positionedTimelineLayoutFrame: number | null = null;
    let mathSyntaxLayoutFrame: number | null = null;
    let treeChartLayoutFrame: number | null = null;
    let enwikiChartLayoutFrame: number | null = null;

    const scheduleLocationMapLayout = () => {
      if (locationMapLayoutFrame !== null) {
        window.cancelAnimationFrame(locationMapLayoutFrame);
      }

      locationMapLayoutFrame = window.requestAnimationFrame(() => {
        locationMapLayoutFrame = null;
        layoutReaderArticleLocationMapLabels(root);
      });
    };

    const scheduleNormalTableCornerLayout = () => {
      if (normalTableCornerLayoutFrame !== null) {
        window.cancelAnimationFrame(normalTableCornerLayoutFrame);
      }

      normalTableCornerLayoutFrame = window.requestAnimationFrame(() => {
        normalTableCornerLayoutFrame = null;
        layoutReaderNormalTablePerimeterCorners(root);
      });
    };

    const schedulePositionedTimelineLayout = () => {
      if (positionedTimelineLayoutFrame !== null) {
        window.cancelAnimationFrame(positionedTimelineLayoutFrame);
      }

      positionedTimelineLayoutFrame = window.requestAnimationFrame(() => {
        positionedTimelineLayoutFrame = null;
        prepareReaderPositionedHorizontalTimelines(root);
        layoutReaderPositionedHorizontalTimelines(root);
      });
    };

    const scheduleTreeChartLayout = () => {
      if (treeChartLayoutFrame !== null) {
        window.cancelAnimationFrame(treeChartLayoutFrame);
      }

      treeChartLayoutFrame = window.requestAnimationFrame(() => {
        treeChartLayoutFrame = null;
        layoutReaderTreeCharts(root);
      });
    };

    const scheduleEnwikiChartLayout = () => {
      if (enwikiChartLayoutFrame !== null) {
        window.cancelAnimationFrame(enwikiChartLayoutFrame);
      }

      enwikiChartLayoutFrame = window.requestAnimationFrame(() => {
        enwikiChartLayoutFrame = null;
        layoutReaderEnwikiCharts(root);
      });
    };

    const scheduleMathSyntaxLayout = () => {
      if (mathSyntaxLayoutFrame !== null) {
        window.cancelAnimationFrame(mathSyntaxLayoutFrame);
      }

      if (treeChartLayoutFrame !== null) {
        window.cancelAnimationFrame(treeChartLayoutFrame);
      }

      mathSyntaxLayoutFrame = window.requestAnimationFrame(() => {
        mathSyntaxLayoutFrame = null;
        prepareReaderMathSyntax(root);
        prepareReaderTexhtmlSyntax(root);
        prepareReaderPseudocodeSyntax(root);
        prepareReaderChemfSyntax(root);
        prepareReaderStackedSuLayout(root);
        prepareReaderElectrodeSyntax(root);
        prepareReaderPlainChemistrySyntax(root);
      });
    };

    const upgradeInfoboxSvgLogo = (image: HTMLImageElement) => {
      const source = image.currentSrc || image.src;
      const infobox = image.closest<HTMLElement>(".infobox");

      if (
        !infobox ||
        !/\.svg(?:[?#]|$)/i.test(source) ||
        !/logo/i.test(`${source} ${image.alt} ${image.title}`) ||
        image.dataset.readerInlineInfoboxSvgLogo === "pending"
      ) {
        return;
      }

      image.dataset.readerInlineInfoboxSvgLogo = "pending";

      void fetch(source)
        .then((response) => {
          if (!response.ok) throw new Error(`Infobox logo request failed: ${response.status}`);
          return response.text();
        })
        .then((markup) => {
          if (!image.isConnected || !root.contains(image)) return;

          const parsed = new DOMParser().parseFromString(markup, "image/svg+xml");
          const sourceSvg = parsed.documentElement;
          const viewBox = sourceSvg.getAttribute("viewBox");
          const sourcePaths = Array.from(sourceSvg.children)
            .filter((element) => element.localName === "path")
            .map((element) => element as SVGPathElement);
          const backgroundPath = sourcePaths.find((path) => {
            const fill = path.getAttribute("fill")?.trim().toLowerCase() || "";
            return /^(rectangle|background|bg)$/i.test(path.id) &&
              /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(fill) &&
              (() => {
                const hex = fill.slice(1);
                const expanded = hex.length === 3
                  ? hex.split("").map((digit) => digit + digit).join("")
                  : hex;
                const channels = [0, 2, 4].map((offset) => parseInt(expanded.slice(offset, offset + 2), 16));
                const luminance = (0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]) / 255;
                return luminance <= 0.16;
              })();
          });
          const logoPaths = sourcePaths.filter((path) => path !== backgroundPath);
          const logoFills = new Set(logoPaths.map((path) => path.getAttribute("fill")?.trim().toLowerCase() || ""));

          if (
            sourceSvg.localName !== "svg" ||
            parsed.querySelector("parsererror") ||
            !viewBox ||
            !backgroundPath ||
            logoPaths.length === 0 ||
            logoFills.size !== 1 ||
            logoFills.has("") ||
            sourcePaths.some((path) => !path.getAttribute("d") || (path.hasAttribute("stroke") && path.getAttribute("stroke")?.trim().toLowerCase() !== "none") || path.hasAttribute("opacity"))
          ) {
            throw new Error("Infobox SVG logo is not a supported single-color mark on a dark background");
          }

          const namespace = "http://www.w3.org/2000/svg";
          const inlineSvg = document.createElementNS(namespace, "svg");
          inlineSvg.setAttribute("viewBox", viewBox);
          inlineSvg.setAttribute("width", sourceSvg.getAttribute("width") || "260");
          inlineSvg.setAttribute("height", sourceSvg.getAttribute("height") || "auto");
          inlineSvg.setAttribute("role", "img");
          inlineSvg.setAttribute("aria-label", image.alt || image.title || "Infobox logo");
          inlineSvg.classList.add("reader-inline-infobox-svg-logo");
          inlineSvg.dataset.readerSource = source;
          inlineSvg.style.cssText =
            "display:block;width:260px;max-width:100%;height:auto;margin:0 auto";
          const infoboxStyle = getComputedStyle(infobox);
          inlineSvg.style.color = infoboxStyle.color;

          logoPaths.forEach((sourcePath) => {
            const path = document.createElementNS(namespace, "path");
            path.setAttribute("d", sourcePath.getAttribute("d") || "");
            path.setAttribute("fill", "currentColor");

            ["fill-rule", "clip-rule", "transform"].forEach((attribute) => {
              const value = sourcePath.getAttribute(attribute);
              if (value) path.setAttribute(attribute, value);
            });

            inlineSvg.append(path);
          });

          const imageLink = image.parentElement;
          if (imageLink instanceof HTMLElement) {
            imageLink.style.display = "block";
            imageLink.style.width = "fit-content";
            imageLink.style.maxWidth = "100%";
            imageLink.style.backgroundColor = infoboxStyle.backgroundColor;
          }

          image.replaceWith(inlineSvg);
        })
        .catch(() => {
          delete image.dataset.readerInlineInfoboxSvgLogo;
        });
    };

    const getWikimediaSvgThumbnailUrl = (image: HTMLImageElement) => {
      if (image.dataset.readerSvgThumbnailFallback === "attempted") return null;

      const source = image.currentSrc || image.src;
      let url: URL;
      try {
        url = new URL(source, window.location.href);
      } catch {
        return null;
      }

      if (url.hostname !== "upload.wikimedia.org") return null;

      const match = url.pathname.match(
        /^\/wikipedia\/([^/]+)\/(.+)\/([^/]+\.svg)$/i,
      );
      if (!match || match[2].split("/").includes("thumb")) return null;

      const [, project, directories, filename] = match;
      image.dataset.readerSvgThumbnailFallback = "attempted";
      return `${url.origin}/wikipedia/${project}/thumb/${directories}/${filename}/250px-${filename}.png`;
    };

    const markImageReady = (image: HTMLImageElement) => {
      upgradeInfoboxSvgLogo(image);
      void hydrateReaderWikimediaMapImage(image);
      if (image.complete && image.naturalWidth > 0) {
        image.classList.remove("reader-media-loading");
        image.classList.add("reader-media-ready");
        fitReaderPortraitMediaFigure(image);
        scheduleMathSyntaxLayout();
        return;
      }

      image.classList.remove("reader-media-ready");
      image.classList.add("reader-media-loading");

      const handleDone = () => {
        image.classList.remove("reader-media-loading");
        image.classList.add("reader-media-ready");
        image.removeEventListener("load", handleDone);
        image.removeEventListener("error", handleError);
        fitReaderPortraitMediaFigure(image);
        scheduleMathSyntaxLayout();
        scheduleLocationMapLayout();
        scheduleNormalTableCornerLayout();
        schedulePositionedTimelineLayout();
      };

      const handleError = () => {
        const thumbnailUrl = getWikimediaSvgThumbnailUrl(image);
        if (thumbnailUrl) {
          image.classList.remove("reader-media-ready");
          image.classList.add("reader-media-loading");
          image.removeAttribute("srcset");
          image.removeAttribute("sizes");
          image.src = thumbnailUrl;
          return;
        }
        handleDone();
      };

      image.addEventListener("load", handleDone);
      image.addEventListener("error", handleError);

      // A cached failed SVG may already be complete before these listeners
      // are attached, so send it through the same thumbnail retry path.
      if (image.complete && image.naturalWidth <= 0) handleError();

      cleanups.push(() => {
        image.removeEventListener("load", handleDone);
        image.removeEventListener("error", handleError);
      });
    };

    prepareReaderPositionedHorizontalTimelines(root);
    root.querySelectorAll<HTMLImageElement>("img").forEach(markImageReady);
    prepareReaderVideoPlayers(root, cleanups);
    prepareReaderExpandedVideoPlayer(root, cleanups);

    const handleReaderVideoSpaceKeyDown = (
      event: globalThis.KeyboardEvent,
    ) => {
      if (
        event.code !== "Space" ||
        event.repeat ||
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey
      ) {
        return;
      }

      const expandedVideo = document.querySelector<HTMLVideoElement>(
        "video.reader-expanded-video-stage, .reader-expanded-video-stage video",
      );

      if (expandedVideo) {
        event.preventDefault();
        event.stopImmediatePropagation();

        if (expandedVideo.paused) {
          void expandedVideo.play().catch(() => undefined);
        } else {
          expandedVideo.pause();
        }

        return;
      }

      const target = event.target;
      const isEmptySearchBox =
        target instanceof HTMLInputElement &&
        /search wikipedia/i.test(target.placeholder) &&
        target.value.trim().length === 0;

      if (
        target instanceof Element &&
        !isEmptySearchBox &&
        target.closest(
          "input, textarea, select, button, a, [role=button], [contenteditable=true], [contenteditable=\"\"], [contenteditable=\"true\"]",
        )
      ) {
        return;
      }

      const readerContent =
        root.closest<HTMLElement>(".browser-content") || root;

      const videos = Array.from(
        readerContent.querySelectorAll<HTMLVideoElement>("video"),
      ).filter((video) => {
        const rect = video.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });

      const video =
        videos.find((candidate) => !candidate.paused) ||
        videos.sort((first, second) => {
          const firstRect = first.getBoundingClientRect();
          const secondRect = second.getBoundingClientRect();

          return (
            secondRect.width * secondRect.height -
            firstRect.width * firstRect.height
          );
        })[0];

      if (!video) return;

      event.preventDefault();
      event.stopPropagation();

      if (video.paused) {
        void video.play().catch(() => undefined);
      } else {
        video.pause();
      }
    };

    document.addEventListener(
      "keydown",
      handleReaderVideoSpaceKeyDown,
      true,
    );

    cleanups.push(() => {
      document.removeEventListener(
        "keydown",
        handleReaderVideoSpaceKeyDown,
        true,
      );
    });
    scheduleMathSyntaxLayout();
    scheduleLocationMapLayout();
    scheduleNormalTableCornerLayout();
    schedulePositionedTimelineLayout();
    scheduleTreeChartLayout();
    scheduleEnwikiChartLayout();

    const locationMapResizeObserver = new ResizeObserver(() => {
      scheduleLocationMapLayout();
      scheduleNormalTableCornerLayout();
    });

    root
      .querySelectorAll<HTMLElement>(
        ".reader-location-map-plus, .reader-calculated-location-map-host",
      )
      .forEach((map) => locationMapResizeObserver.observe(map));

    const normalTableCornerResizeObserver = new ResizeObserver(() => {
      scheduleNormalTableCornerLayout();
      schedulePositionedTimelineLayout();
      scheduleTreeChartLayout();
      scheduleEnwikiChartLayout();
    });

    normalTableCornerResizeObserver.observe(root);

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of Array.from(mutation.addedNodes)) {
          if (!(node instanceof Element)) continue;

          if (node instanceof HTMLImageElement) {
            markImageReady(node);
          }

          node.querySelectorAll<HTMLImageElement>("img").forEach(markImageReady);
          prepareReaderVideoPlayers(node, cleanups);
        }
      }

      scheduleMathSyntaxLayout();
      scheduleLocationMapLayout();
      schedulePositionedTimelineLayout();
      scheduleTreeChartLayout();
    });

    observer.observe(root, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      locationMapResizeObserver.disconnect();
      normalTableCornerResizeObserver.disconnect();

      if (locationMapLayoutFrame !== null) {
        window.cancelAnimationFrame(locationMapLayoutFrame);
      }

      if (normalTableCornerLayoutFrame !== null) {
        window.cancelAnimationFrame(normalTableCornerLayoutFrame);
      }

      if (positionedTimelineLayoutFrame !== null) {
        window.cancelAnimationFrame(positionedTimelineLayoutFrame);
      }

      if (mathSyntaxLayoutFrame !== null) {
        window.cancelAnimationFrame(mathSyntaxLayoutFrame);
      }

      if (enwikiChartLayoutFrame !== null) {
        window.cancelAnimationFrame(enwikiChartLayoutFrame);
      }

      cleanups.forEach((cleanup) => cleanup());
    };
  }, [html, isActive]);

  useEffect(() => {
    const root = articleRef.current;
    if (!root || !isActive) return;

    const wrapperSelector =
      ".reader-table-scroll, .reader-scrollable-sortable-table, .reader-table-wrapper";
    const installed = new Map<
      HTMLElement,
      {
        track: HTMLDivElement;
        thumb: HTMLDivElement;
        table: HTMLTableElement;
        sync: () => void;
        cleanup: () => void;
      }
    >();
    let frame: number | null = null;

    const install = (wrapper: HTMLElement) => {
      const table = wrapper.querySelector<HTMLTableElement>("table");
      if (!table) return;

      resizeObserver.observe(wrapper);
      resizeObserver.observe(table);

      if (wrapper.scrollWidth <= wrapper.clientWidth + 1) {
        const existing = installed.get(wrapper);
        if (existing) {
          existing.cleanup();
          installed.delete(wrapper);
        }
        return;
      }

      const existing = installed.get(wrapper);
      if (existing) {
        if (existing.table !== table) {
          existing.cleanup();
          installed.delete(wrapper);
        } else {
          existing.sync();
          return;
        }
      }

      wrapper.classList.add("reader-has-custom-horizontal-scrollbar");
      const track = document.createElement("div");
      track.className = "reader-custom-horizontal-scrollbar";
      track.setAttribute("role", "scrollbar");
      track.setAttribute("aria-orientation", "horizontal");
      track.setAttribute("aria-label", "Scroll wide table horizontally");
      track.tabIndex = 0;

      if (!table.id) {
        table.id = `reader-wide-table-${Math.random().toString(36).slice(2, 10)}`;
      }
      track.setAttribute("aria-controls", table.id);

      const thumb = document.createElement("div");
      thumb.className = "reader-custom-horizontal-scrollbar-thumb";
      track.append(thumb);
      wrapper.after(track);

      const sync = () => {
        track.style.width = `${wrapper.clientWidth}px`;
        const trackWidth = track.clientWidth;
        const maxScroll = Math.max(0, wrapper.scrollWidth - wrapper.clientWidth);
        const thumbWidth = Math.min(
          trackWidth,
          Math.max(36, Math.round((trackWidth * wrapper.clientWidth) / wrapper.scrollWidth)),
        );
        const travel = Math.max(0, trackWidth - thumbWidth);
        const left = maxScroll > 0 ? (travel * wrapper.scrollLeft) / maxScroll : 0;

        thumb.style.width = `${thumbWidth}px`;
        thumb.style.left = `${left}px`;
        track.setAttribute("aria-valuemin", "0");
        track.setAttribute("aria-valuemax", `${maxScroll}`);
        track.setAttribute("aria-valuenow", `${Math.round(wrapper.scrollLeft)}`);
      };

      let pointerGrabOffset = 0;
      const moveToPointer = (event: PointerEvent) => {
        const bounds = track.getBoundingClientRect();
        const thumbWidth = thumb.offsetWidth;
        const travel = Math.max(1, bounds.width - thumbWidth);
        const position = Math.max(
          0,
          Math.min(1, (event.clientX - bounds.left - pointerGrabOffset - 2) / travel),
        );
        wrapper.scrollLeft = position * (wrapper.scrollWidth - wrapper.clientWidth);
      };

      const handlePointerDown = (event: PointerEvent) => {
        event.preventDefault();
        const thumbBounds = thumb.getBoundingClientRect();
        const clickedOnThumb =
          event.clientX >= thumbBounds.left - 2 && event.clientX <= thumbBounds.right + 2;
        pointerGrabOffset = clickedOnThumb
          ? event.clientX - thumbBounds.left
          : thumb.offsetWidth / 2;
        track.setPointerCapture(event.pointerId);
        moveToPointer(event);
      };
      const handlePointerMove = (event: PointerEvent) => {
        if (event.buttons) moveToPointer(event);
      };
      const handleKeyDown = (event: globalThis.KeyboardEvent) => {
        const step = event.key === "PageDown" || event.key === "PageUp"
          ? wrapper.clientWidth * 0.9
          : 40;
        if (event.key === "ArrowRight" || event.key === "PageDown") {
          wrapper.scrollLeft += step;
        } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
          wrapper.scrollLeft -= step;
        } else if (event.key === "Home") {
          wrapper.scrollLeft = 0;
        } else if (event.key === "End") {
          wrapper.scrollLeft = wrapper.scrollWidth;
        } else {
          return;
        }
        event.preventDefault();
      };

      wrapper.addEventListener("scroll", sync, { passive: true });
      track.addEventListener("pointerdown", handlePointerDown);
      track.addEventListener("pointermove", handlePointerMove);
      track.addEventListener("keydown", handleKeyDown);
      const cleanup = () => {
        wrapper.removeEventListener("scroll", sync);
        track.removeEventListener("pointerdown", handlePointerDown);
        track.removeEventListener("pointermove", handlePointerMove);
        track.removeEventListener("keydown", handleKeyDown);
        track.remove();
        wrapper.classList.remove("reader-has-custom-horizontal-scrollbar");
      };

      installed.set(wrapper, { track, thumb, table, sync, cleanup });
      sync();
    };

    const updateAll = () => {
      frame = null;
      installed.forEach((entry, wrapper) => {
        if (!root.contains(wrapper)) {
          entry.cleanup();
          installed.delete(wrapper);
        }
      });
      root.querySelectorAll<HTMLElement>(wrapperSelector).forEach(install);
    };
    const scheduleUpdate = () => {
      if (frame === null) frame = window.requestAnimationFrame(updateAll);
    };
    const mutationObserver = new MutationObserver(scheduleUpdate);
    const resizeObserver = new ResizeObserver(scheduleUpdate);

    mutationObserver.observe(root, { childList: true, subtree: true });
    resizeObserver.observe(root);
    root.querySelectorAll<HTMLElement>(wrapperSelector).forEach((wrapper) => {
      resizeObserver.observe(wrapper);
      const table = wrapper.querySelector("table");
      if (table) resizeObserver.observe(table);
    });
    updateAll();

    return () => {
      mutationObserver.disconnect();
      resizeObserver.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
      installed.forEach((entry) => entry.cleanup());
      installed.clear();
    };
  }, [html, isActive]);

  useEffect(() => {
    const root = articleRef.current;
    if (!root || !isActive) return;

    deferReaderPackedHoverGalleryReflow(root.ownerDocument);
  }, [html, isActive]);

  /*
   * ADAM TWO-STAGE WIKIPEDIA IMAGE LOADING
   *
   * After the article text and lead imagery paint, release lower-page image
   * requests in small batches. Images near the viewport receive priority so
   * the reader remains useful immediately when the user starts scrolling.
   */
  useEffect(() => {
    const root = articleRef.current;
    if (!root) return;

    let startTimer = 0;
    let queueTimer = 0;
    let stopped = false;
    const readerTabPanel = root.closest<HTMLElement>(".reader-tab-panel");

    const restoreDeferredImage = (image: HTMLImageElement) => {
      const source = image.dataset.readerDeferredSrc;
      if (!source) return;

      delete image.dataset.readerDeferredSrc;
      image.src = source;
    };

    const loadNextImageBatch = () => {
      if (stopped || !root.isConnected) return;

      /*
       * Pause an inactive tab's background queue. It resumes automatically
       * when that tab becomes active again.
       */
      if (
        !root.closest(
          ".reader-tab-panel-active",
        )
      ) {
        return;
      }

      const deferredImages = Array.from(
        root.querySelectorAll<HTMLImageElement>(
          "img[data-reader-deferred-src]",
        ),
      );

      if (deferredImages.length === 0) {
        if (queueTimer) {
          window.clearInterval(queueTimer);
          queueTimer = 0;
        }
        return;
      }

      const prioritizedImages = deferredImages
        .map((image, index) => {
          const bounds = image.getBoundingClientRect();
          const nearViewport =
            bounds.bottom >= -400 &&
            bounds.top <= window.innerHeight + 700;

          return {
            image,
            index,
            priority: nearViewport ? 0 : 1,
            distance: nearViewport
              ? Math.abs(bounds.top)
              : index,
          };
        })
        .sort(
          (left, right) =>
            left.priority - right.priority ||
            left.distance - right.distance ||
            left.index - right.index,
        );

      prioritizedImages
        .slice(0, 3)
        .forEach(({ image }) => restoreDeferredImage(image));
    };

    const startQueue = () => {
      if (stopped || queueTimer || !root.closest(".reader-tab-panel-active")) {
        return;
      }

      queueTimer = window.setInterval(loadNextImageBatch, 250);
      loadNextImageBatch();
    };

    const updateQueueForTabVisibility = () => {
      if (root.closest(".reader-tab-panel-active")) {
        startQueue();
        return;
      }

      if (queueTimer) {
        window.clearInterval(queueTimer);
        queueTimer = 0;
      }
    };

    const tabPanelObserver = readerTabPanel
      ? new MutationObserver(updateQueueForTabVisibility)
      : null;

    if (readerTabPanel) {
      tabPanelObserver?.observe(readerTabPanel, {
        attributes: true,
        attributeFilter: ["class"],
      });
    }

    startTimer = window.setTimeout(() => {
      startTimer = 0;
      updateQueueForTabVisibility();
    }, 500);

    return () => {
      stopped = true;

      if (startTimer) {
        window.clearTimeout(startTimer);
      }

      if (queueTimer) {
        window.clearInterval(queueTimer);
      }

      tabPanelObserver?.disconnect();
    };
  }, [html]);

  return (
    <>
      <div
        ref={articleRef}
        className="reader-article"
        dangerouslySetInnerHTML={{ __html: html }}
        onClick={onClick}
        onMouseOver={handleLinkMouseOver}
        onMouseOut={handleLinkMouseOut}
      />

      <div
        ref={linkStatusRef}
        className="reader-link-status"
        aria-hidden="true"
        hidden
      />
    </>
  );
  },
  (previousProps, nextProps) =>
    previousProps.html === nextProps.html &&
    previousProps.isActive === nextProps.isActive,
);


function ReaderSearchResults({
  query,
  onNavigate,
}: {
  query: string;
  onNavigate: (target: ReaderTarget) => void;
}) {
  const [input, setInput] = useState(query);
  const [results, setResults] = useState<SearchSuggestion[]>([]);
  const [correction, setCorrection] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();

    setInput(query);
    setLoading(true);
    setResults([]);
    setCorrection(null);

    loadReaderSearchResults(query, controller.signal)
      .then((searchData) => {
        if (controller.signal.aborted) return;

        setResults(searchData.results);
        setCorrection(searchData.correction);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        if (!controller.signal.aborted) {
          setResults([]);
          setCorrection(null);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [query]);

  const submit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      const nextQuery = input.trim();
      if (!nextQuery) return;

      const resolvedTopic = await resolveWikipediaSearchTopic(nextQuery);

      onNavigate(
        resolvedTopic
          ? { kind: "wiki", topic: resolvedTopic }
          : { kind: "search", query: nextQuery },
      );
    },
    [input, onNavigate],
  );

  return (
    <section className="reader-search-results" aria-label="Wikipedia search results">
      <h1>Search results</h1>
      <p className="reader-search-results-note">
        {correction ? (
          <>
            Showing results for <strong>“{correction}”</strong> instead of “{query}”.
          </>
        ) : (
          <>
            No exact article was found for <strong>“{query}”</strong>. Here are the closest matches.
          </>
        )}
      </p>

      <form className="reader-search-results-form" onSubmit={submit}>
        <input
          aria-label="Search Wikipedia"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          value={input}
          onChange={(event) => setInput(event.target.value)}
        />
        <button type="submit">Search</button>
      </form>

      <div className="reader-search-results-list" aria-busy={loading}>
        {loading ? (
          <p className="reader-search-result-empty">Searching Wikipedia…</p>
        ) : results.length === 0 ? (
          <p className="reader-search-result-empty">No matching articles were found.</p>
        ) : (
          results.map((result) => (
            <button
              key={result.title}
              type="button"
              className="reader-search-result"
              onClick={() => onNavigate({ kind: "wiki", topic: result.title })}
            >
              <span className="reader-search-result-thumbnail" aria-hidden="true">
                {result.imageUrl ? (
                  <img src={result.imageUrl} alt="" loading="lazy" />
                ) : (
                  <span className="reader-search-result-fallback">W</span>
                )}
              </span>
              <span className="reader-search-result-copy">
                <strong>{result.title}</strong>
                {result.description && (
                  <span className="reader-search-result-description">
                    {result.description}
                  </span>
                )}
              </span>
            </button>
          ))
        )}
      </div>
    </section>
  );
}

function ReaderContent({
  article,
  currentTarget,
  loadedTargetKey,
  media,
  onArticleClick,
  onLandingSearch,
  onSectionNavigate,
  status,
  suppressLoadingIndicator,
  isActive,
}: {
  article: ReaderArticle | null;
  currentTarget: ReaderTarget | null;
  loadedTargetKey: string | null;
  media: ReaderMedia | null;
  onArticleClick: (event: MouseEvent<HTMLDivElement>) => void;
  onLandingSearch: (target: ReaderTarget) => void;
  onSectionNavigate: (sectionId: string) => void;
  status: "idle" | "loading" | "error";
  suppressLoadingIndicator: boolean;
  isActive: boolean;
}) {
  const [sectionContentsAnchor, setSectionContentsAnchor] = useState<{
    top?: number;
    bottom?: number;
    left: number;
    opensUp?: boolean;
  } | null>(null);
  const readerRootRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const reader = readerRootRef.current;
    if (!reader || !isActive) return;

    const updateButtonPosition = () => {
      const rect = reader.getBoundingClientRect();
      reader.style.setProperty(
        "--reader-contents-button-top",
        `${Math.round(rect.top + 4)}px`,
      );
      const button = reader.querySelector<HTMLElement>(
        ".reader-unified-contents-button",
      );

      const buttonLeft = `${Math.round(rect.left + 4)}px`;
      reader.style.setProperty("--reader-contents-button-left", buttonLeft);
      button?.style.setProperty("--reader-contents-button-left", buttonLeft);
    };

    updateButtonPosition();
    window.addEventListener("resize", updateButtonPosition);

    const observer = new ResizeObserver(updateButtonPosition);
    observer.observe(reader);

    return () => {
      window.removeEventListener("resize", updateButtonPosition);
      observer.disconnect();
    };
  }, [article, currentTarget, isActive]);

  useEffect(() => {
    const reader = readerRootRef.current;
    if (!reader || !article || !isActive) return;

    const activationOffset = 300;
    let frame = 0;

    const updateActiveSection = () => {
      const menu = reader.querySelector<HTMLElement>(
        ".reader-inline-section-popover",
      );
      const articleRoot = reader.querySelector<HTMLElement>(".reader-article");

      if (!menu || !articleRoot) return;

      const topLink = menu.querySelector<HTMLAnchorElement>(
        ".reader-section-top-link",
      );
      const mainLinks = Array.from(
        menu.querySelectorAll<HTMLAnchorElement>(
          ":scope > .reader-section-group > .reader-section-main-row > .reader-section-main-link",
        ),
      );
      const readerRect = reader.getBoundingClientRect();

      const sections = mainLinks
        .map((link) => {
          const id = link.getAttribute("href")?.slice(1);
          const heading = id
            ? articleRoot.querySelector<HTMLElement>(`#${CSS.escape(id)}`)
            : null;

          if (!heading) return null;

          return {
            link,
            position:
              heading.getBoundingClientRect().top -
              readerRect.top +
              reader.scrollTop,
          };
        })
        .filter(
          (section): section is { link: HTMLAnchorElement; position: number } =>
            section !== null,
        );

      const active = sections
        .filter(
          ({ position }) => position <= reader.scrollTop + activationOffset,
        );
      const activeSection = active.length > 0 ? active[active.length - 1] : null;
      const atTop =
        !activeSection ||
        reader.scrollTop <
          (sections[0]?.position ?? Number.POSITIVE_INFINITY) -
            activationOffset;

      topLink?.classList.toggle("reader-section-active-top", atTop);
      mainLinks.forEach((link) => {
        link.classList.toggle(
          "reader-section-active-main",
          !atTop && link === activeSection?.link,
        );
      });
    };

    const onScroll = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(updateActiveSection);
    };

    const observer = new MutationObserver(updateActiveSection);
    reader.addEventListener("scroll", onScroll, { passive: true });
    observer.observe(reader, { childList: true, subtree: true });
    updateActiveSection();

    return () => {
      window.cancelAnimationFrame(frame);
      reader.removeEventListener("scroll", onScroll);
      observer.disconnect();
      reader
        .querySelectorAll(
          ".reader-section-active-top, .reader-section-active-main",
        )
        .forEach((link) => {
          link.classList.remove(
            "reader-section-active-top",
            "reader-section-active-main",
          );
        });
    };
  }, [article, currentTarget, isActive]);

  const [landingSearch, setLandingSearch] = useState("");
  const [landingSuggestions, setLandingSuggestions] = useState<SearchSuggestion[]>([]);
  const [landingSuggestionsOpen, setLandingSuggestionsOpen] = useState(false);
  const [landingSelectedSuggestionIndex, setLandingSelectedSuggestionIndex] = useState(-1);
  const landingSuggestionsRef = useRef<HTMLDivElement>(null);
  const landingScrollbarRef = useRef<HTMLDivElement>(null);
  const landingScrollbarDragRef = useRef<{ startY: number; startScrollTop: number } | null>(null);
  const [landingScrollbarMetrics, setLandingScrollbarMetrics] = useState({
    height: 0,
    top: 0,
    scrollTop: 0,
    maxScrollTop: 0,
  });

  useEffect(() => {
    if (currentTarget) return;

    const query = landingSearch.trim();

    if (query.length < 2) {
      setLandingSuggestions([]);
      setLandingSelectedSuggestionIndex(-1);
      return;
    }

    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      loadWikipediaSuggestions(query, controller.signal)
        .then((nextSuggestions) => {
          setLandingSuggestions(nextSuggestions);
          setLandingSelectedSuggestionIndex(-1);
          setLandingSuggestionsOpen(nextSuggestions.length > 0);
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          setLandingSuggestions([]);
          setLandingSelectedSuggestionIndex(-1);
        });
    }, 180);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [currentTarget, landingSearch]);

  useLayoutEffect(() => {
    const viewport = landingSuggestionsRef.current;
    if (!viewport || !landingSuggestionsOpen || landingSuggestions.length === 0) return;

    let frame = 0;
    const updateMetrics = () => {
      frame = 0;
      const maxScrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      const trackHeight = Math.max(0, viewport.clientHeight - 4);
      const height = maxScrollTop > 0
        ? Math.max(24, trackHeight * viewport.clientHeight / viewport.scrollHeight)
        : 0;
      const top = 2 + (trackHeight - height) * (maxScrollTop ? viewport.scrollTop / maxScrollTop : 0);

      setLandingScrollbarMetrics({ height, top, scrollTop: viewport.scrollTop, maxScrollTop });
    };
    const scheduleUpdate = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(updateMetrics);
    };
    const observer = new ResizeObserver(scheduleUpdate);

    viewport.addEventListener("scroll", scheduleUpdate, { passive: true });
    observer.observe(viewport);
    window.addEventListener("resize", scheduleUpdate);
    scheduleUpdate();

    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      viewport.removeEventListener("scroll", scheduleUpdate);
      observer.disconnect();
      window.removeEventListener("resize", scheduleUpdate);
    };
  }, [currentTarget, landingSuggestions.length, landingSuggestionsOpen]);

  const handleLandingScrollbarPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const viewport = landingSuggestionsRef.current;
    if (!viewport || landingScrollbarMetrics.maxScrollTop <= 0) return;

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    landingScrollbarDragRef.current = {
      startY: event.clientY,
      startScrollTop: viewport.scrollTop,
    };
  };

  const handleLandingScrollbarPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const viewport = landingSuggestionsRef.current;
    const drag = landingScrollbarDragRef.current;
    if (!viewport || !drag || landingScrollbarMetrics.maxScrollTop <= 0) return;

    const trackRange = Math.max(1, viewport.clientHeight - 4 - landingScrollbarMetrics.height);
    viewport.scrollTop = drag.startScrollTop
      + ((event.clientY - drag.startY) / trackRange) * landingScrollbarMetrics.maxScrollTop;
  };

  const stopLandingScrollbarDrag = () => {
    landingScrollbarDragRef.current = null;
  };

  const chooseLandingSuggestion = useCallback(
    (suggestion: SearchSuggestion) => {
      onLandingSearch({ kind: "wiki", topic: suggestion.title });
      setLandingSearch("");
      setLandingSuggestions([]);
      setLandingSuggestionsOpen(false);
      setLandingSelectedSuggestionIndex(-1);
    },
    [onLandingSearch],
  );

  const submitLandingSearch = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      const selectedSuggestion =
        landingSelectedSuggestionIndex >= 0
          ? landingSuggestions[landingSelectedSuggestionIndex]
          : null;
      const rawQuery = landingSearch.trim();

      setLandingSuggestions([]);
      setLandingSuggestionsOpen(false);
      setLandingSelectedSuggestionIndex(-1);

      if (!rawQuery && !selectedSuggestion) return;

      setLandingSearch("");

      if (selectedSuggestion) {
        onLandingSearch({ kind: "wiki", topic: selectedSuggestion.title });
        return;
      }

      const resolvedTopic = await resolveWikipediaSearchTopic(rawQuery);

      onLandingSearch(
        resolvedTopic
          ? { kind: "wiki", topic: resolvedTopic }
          : { kind: "search", query: rawQuery },
      );
    },
    [
      landingSearch,
      landingSelectedSuggestionIndex,
      landingSuggestions,
      onLandingSearch,
    ],
  );

  function handleLandingSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!landingSuggestionsOpen || landingSuggestions.length === 0) {
      if (event.key === "ArrowDown" && landingSuggestions.length > 0) {
        event.preventDefault();
        setLandingSuggestionsOpen(true);
        setLandingSelectedSuggestionIndex(0);
      }

      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setLandingSelectedSuggestionIndex((index) =>
        index >= landingSuggestions.length - 1 ? 0 : index + 1,
      );
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setLandingSelectedSuggestionIndex((index) =>
        index <= 0 ? landingSuggestions.length - 1 : index - 1,
      );
    } else if (event.key === "Enter") {
      submitLandingSearch(event as unknown as FormEvent<HTMLFormElement>);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setLandingSuggestionsOpen(false);
      setLandingSelectedSuggestionIndex(-1);
    }
  }

  const closeInlineContents = useCallback(() => {
    setSectionContentsAnchor(null);
  }, []);

  const handleInlineSectionNavigate = useCallback(
    (sectionId: string) => {
      setSectionContentsAnchor(null);
      onSectionNavigate(sectionId);
    },
    [onSectionNavigate],
  );

  const openContentsFromButton = useCallback((button: HTMLElement) => {
    const rect = button.getBoundingClientRect();
    const readerContainer = button.closest<HTMLElement>(".wikipedia-reader");
    const readerRect = readerContainer?.getBoundingClientRect();

    const popoverWidth = 320;
    const screenPadding = 4;
    const menuGap = 2;

    const paneLeft = readerRect?.left ?? 0;
    const paneRight = readerRect?.right ?? window.innerWidth;
    const rightAlignedLeft = rect.left;
    const leftAlignedLeft = rect.right - popoverWidth;

    const fitsToRight =
      rightAlignedLeft + popoverWidth <= paneRight - screenPadding;
    const fitsToLeft =
      leftAlignedLeft >= paneLeft + screenPadding;

    const viewportLeft = Math.round(
      fitsToRight
        ? rightAlignedLeft
        : fitsToLeft
          ? leftAlignedLeft
          : Math.min(
              window.innerWidth - popoverWidth - screenPadding,
              Math.max(screenPadding, rightAlignedLeft),
            ),
    );

    const top = Math.round(rect.bottom + menuGap);
    const left = viewportLeft;

    setSectionContentsAnchor((currentAnchor) =>
      currentAnchor ? null : { top, left },
    );
  }, []);

  useEffect(() => {
    if (!sectionContentsAnchor) {
      return;
    }

    let frameId: number | null = null;

    function closeIfContentsBoxFullyOffscreen() {
      if (frameId !== null) {
        return;
      }

      frameId = window.requestAnimationFrame(() => {
        frameId = null;

        const popover = document.querySelector<HTMLElement>(
          ".reader-inline-section-popover",
        );

        if (!popover) {
          return;
        }

        const rect = popover.getBoundingClientRect();

        // Normal scrolling keeps the menu open. Only close it once the
        // entire contents box has actually left the visible window.
        if (rect.bottom < 0 || rect.top > window.innerHeight) {
          setSectionContentsAnchor(null);
        }
      });
    }

    document.addEventListener("scroll", closeIfContentsBoxFullyOffscreen, true);
    window.addEventListener("resize", closeIfContentsBoxFullyOffscreen);

    return () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }

      document.removeEventListener(
        "scroll",
        closeIfContentsBoxFullyOffscreen,
        true,
      );
      window.removeEventListener("resize", closeIfContentsBoxFullyOffscreen);
    };
  }, [sectionContentsAnchor]);

  const handleReaderArticleClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const target = event.target as HTMLElement | null;

      const collapsibleMapToggle = target?.closest<HTMLButtonElement>(
        ".reader-collapsible-map-toggle",
      );

      if (collapsibleMapToggle) {
        event.preventDefault();
        event.stopPropagation();

        const table = collapsibleMapToggle.closest<HTMLTableElement>(
          "table.reader-collapsible-map-frame",
        );

        if (table) {
          const expanded =
            collapsibleMapToggle.getAttribute("aria-expanded") !== "true";
          table.classList.toggle("reader-collapsible-map-collapsed", !expanded);
          table.classList.toggle("collapsed", !expanded);
          Array.from(table.rows).slice(1).forEach((row) => {
            row.classList.toggle(
              "reader-collapsible-map-row-hidden",
              !expanded,
            );
          });
          collapsibleMapToggle.textContent = expanded ? "[hide]" : "[show]";
          collapsibleMapToggle.setAttribute(
            "aria-expanded",
            String(expanded),
          );
          collapsibleMapToggle.setAttribute(
            "aria-label",
            `${expanded ? "Hide" : "Show"} local transit map`,
          );
        }

        return;
      }

      const gameLogToggle = target?.closest<HTMLButtonElement>(
        ".reader-game-log-toggle",
      );

      if (gameLogToggle) {
        event.preventDefault();
        event.stopPropagation();

        const group = gameLogToggle.closest<HTMLElement>(".mw-collapsible");
        const content = Array.from(group?.children || []).find(
          (child): child is HTMLElement =>
            child instanceof HTMLElement &&
            child.classList.contains("mw-collapsible-content"),
        );

        if (group && content) {
          const collapsed = !content.hidden;
          const headingText = (
            gameLogToggle.getAttribute("aria-label") || "game log"
          ).replace(/^(?:show|hide)\s+/i, "");

          group.classList.toggle("mw-collapsed", collapsed);
          content.hidden = collapsed;
          gameLogToggle.textContent = collapsed ? "[show]" : "[hide]";
          gameLogToggle.setAttribute("aria-expanded", String(!collapsed));
          gameLogToggle.setAttribute(
            "aria-label",
            `${collapsed ? "Show" : "Hide"} ${headingText}`,
          );
        }

        return;
      }

      const treeChartToggle = target?.closest<HTMLButtonElement>(
        ".reader-tree-chart-toggle",
      );

      if (treeChartToggle) {
        event.preventDefault();
        event.stopPropagation();

        const table = treeChartToggle.closest<HTMLTableElement>(
          "table.reader-tree-chart-container",
        );

        if (table) {
          const expanded = treeChartToggle.getAttribute("aria-expanded") !== "true";
          table.classList.toggle("reader-tree-chart-collapsed", !expanded);
          table.classList.toggle("collapsed", !expanded);
          Array.from(table.rows).slice(1).forEach((row) =>
            row.classList.toggle("reader-tree-chart-row-hidden", !expanded),
          );
          treeChartToggle.textContent = expanded ? "[hide]" : "[show]";
          treeChartToggle.setAttribute("aria-expanded", String(expanded));
          treeChartToggle.setAttribute(
            "aria-label",
            `${expanded ? "Hide" : "Show"} infographic`,
          );

          window.requestAnimationFrame(() => layoutReaderTreeCharts(table));
        }

        return;
      }

      const equationTableToggle = target?.closest<HTMLButtonElement>(
        ".reader-equation-collapse-toggle",
      );

      if (equationTableToggle) {
        event.preventDefault();
        event.stopPropagation();

        const table = equationTableToggle.closest<HTMLTableElement>(
          "table.reader-equation-collapsible-table",
        );

        if (table) {
          const expanded = equationTableToggle.getAttribute("aria-expanded") !== "true";
          const bodyRows = Array.from(table.rows).slice(1);
          bodyRows.forEach((row) => {
            row.hidden = !expanded;
            row.classList.toggle("reader-equation-collapse-row-hidden", !expanded);
          });
          table.style.setProperty(
            "border-bottom",
            expanded ? "1px solid #47545c" : "0",
            "important",
          );

          const headingText = (
            equationTableToggle.getAttribute("aria-label") || "equation table"
          ).replace(/^(?:show|hide)\s+/i, "");
          const label = equationTableToggle.querySelector(
            ".reader-equation-collapse-label",
          );
          if (label) label.textContent = expanded ? "hide" : "show";
          equationTableToggle.setAttribute("aria-expanded", String(expanded));
          equationTableToggle.setAttribute(
            "aria-label",
            `${expanded ? "Hide" : "Show"} ${headingText}`,
          );
        }

        return;
      }

      const compactLegendToggle = target?.closest<HTMLButtonElement>(
        ".reader-compact-legend-toggle",
      );

      if (compactLegendToggle) {
        event.preventDefault();
        event.stopPropagation();

        const table = compactLegendToggle.closest<HTMLTableElement>(
          "table.reader-compact-legend-table",
        );

        if (table) {
          const expanded = compactLegendToggle.getAttribute("aria-expanded") !== "true";
          const bodyRows = Array.from(table.rows).slice(1);
          bodyRows.forEach((row) =>
            row.classList.toggle("reader-compact-legend-row-hidden", !expanded),
          );

          const label = compactLegendToggle.querySelector(
            ".reader-compact-legend-toggle-label",
          );
          if (label) label.textContent = expanded ? "hide" : "show";
          compactLegendToggle.setAttribute("aria-expanded", String(expanded));
          compactLegendToggle.setAttribute(
            "aria-label",
            expanded ? "Hide legend rows" : "Show legend rows",
          );
        }

        return;
      }

      const pairedTableToggle = target?.closest<HTMLButtonElement>(
        ".reader-paired-table-toggle",
      );

      if (pairedTableToggle) {
        event.preventDefault();
        event.stopPropagation();

        const table = pairedTableToggle.closest<HTMLTableElement>(
          "table.reader-paired-collapsible-table",
        );

        if (table) {
          const expanded = pairedTableToggle.getAttribute("aria-expanded") !== "true";
          const bodyRows = Array.from(table.rows).slice(1);

          bodyRows.forEach((row) => {
            row.classList.toggle("reader-paired-collapsible-row-hidden", !expanded);
          });

          pairedTableToggle.textContent = expanded ? "[hide]" : "[show]";
          pairedTableToggle.setAttribute("aria-expanded", String(expanded));
          pairedTableToggle.setAttribute(
            "aria-label",
            (expanded ? "Hide" : "Show") + " " + bodyRows.length + " table rows",
          );
        }

        return;
      }

      const infoboxToggle = target?.closest<HTMLButtonElement>(
        ".reader-whole-infobox-toggle",
      );

      const engagementsToggle = target?.closest<HTMLButtonElement>(
        ".reader-engagements-toggle",
      );

      if (engagementsToggle) {
        event.preventDefault();
        event.stopPropagation();

        const table = engagementsToggle.closest<HTMLTableElement>("table");
        const engagementsRow = table?.querySelector<HTMLTableRowElement>(
          "tr.reader-engagements-section",
        );

        if (engagementsRow) {
          const expanded = engagementsRow.classList.toggle(
            "reader-engagements-collapsed",
          ) === false;
          const label = engagementsToggle.querySelector(
            ".reader-engagements-toggle-label",
          );

          if (label) label.textContent = expanded ? "hide" : "show";
          engagementsToggle.setAttribute("aria-expanded", String(expanded));
          engagementsToggle.setAttribute(
            "aria-label",
            expanded ? "Hide engagements" : "Show engagements",
          );
        }

        return;
      }

      if (infoboxToggle) {
        event.preventDefault();
        event.stopPropagation();

        const infobox = infoboxToggle.closest<HTMLTableElement>(
          "table.reader-multi-transcription-infobox",
        );

        if (infobox) {
          infobox.classList.toggle("reader-whole-infobox-collapsed");

          const expanded = !infobox.classList.contains(
            "reader-whole-infobox-collapsed",
          );

          infoboxToggle.textContent = expanded ? "[hide]" : "[show]";
          infoboxToggle.setAttribute(
            "aria-expanded",
            expanded ? "true" : "false",
          );
          infoboxToggle.setAttribute(
            "aria-label",
            expanded ? "Hide infobox details" : "Show infobox details",
          );
        }

        return;
      }

      const nutritionToggle = target?.closest<HTMLButtonElement>(
        ".reader-nutrition-toggle",
      );

      if (nutritionToggle) {
        event.preventDefault();
        event.stopPropagation();

        const nutritionTable = nutritionToggle.closest<HTMLTableElement>(
          "table.reader-nutrition-subtable",
        );

        if (nutritionTable) {
          const expanded = nutritionToggle.getAttribute("aria-expanded") !== "true";

          Array.from(nutritionTable.rows)
            .slice(1)
            .forEach((row) => {
              row.hidden = !expanded;
            });

          nutritionToggle.textContent = expanded ? "[hide]" : "[show]";
          nutritionToggle.setAttribute("aria-expanded", String(expanded));
          nutritionToggle.setAttribute(
            "aria-label",
            expanded ? "Hide vitamins and minerals" : "Show vitamins and minerals",
          );
        }

        return;
      }

      const formerServicesToggle = target?.closest<HTMLButtonElement>(
        "[data-reader-former-services-toggle]",
      );

      if (formerServicesToggle) {
        event.preventDefault();
        event.stopPropagation();

        const serviceTable = formerServicesToggle.closest<HTMLTableElement>("table");
        const contentRows = serviceTable
          ? [...serviceTable.querySelectorAll<HTMLTableRowElement>('tr[data-reader-former-services-content="true"]')]
          : [];
        const expanded = formerServicesToggle.getAttribute("aria-expanded") !== "true";

        contentRows.forEach((row) => {
          row.hidden = !expanded;
          row.style.setProperty("display", expanded ? "table-row" : "none", "important");
        });

        formerServicesToggle.textContent = expanded ? "[hide]" : "[show]";
        formerServicesToggle.setAttribute("aria-expanded", String(expanded));
        formerServicesToggle.setAttribute(
          "aria-label",
          expanded ? "Hide former services" : "Show former services",
        );
        return;
      }

      const categoryTreeToggle = target?.closest<HTMLButtonElement>(
        ".reader-category-tree-toggle",
      );

      if (categoryTreeToggle) {
        event.preventDefault();
        event.stopPropagation();
        void toggleReaderCategoryTree(categoryTreeToggle);
        return;
      }

      setSectionContentsAnchor(null);
      onArticleClick(event);
    },
    [onArticleClick, openContentsFromButton],
  );

  if (!currentTarget) {
    return (
      <section className="wiki-landing" aria-label="Wikipedia landing page">
        <div className="wiki-landing-inner">
          <img className="wiki-reader-brand-logo" src={wikiReaderLogo} alt="Wiki-Reader" />

          <div className="wiki-landing-search-wrap">
            <form className="wiki-landing-search" onSubmit={submitLandingSearch}>
              <input
                aria-label="Search Wikipedia"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                autoFocus
                name="landing-search"
                placeholder="Search Wikipedia"
                value={landingSearch}
                onChange={(event) => {
                  setLandingSearch(event.target.value);
                }}
                onBlur={() => window.setTimeout(() => setLandingSuggestionsOpen(false), 120)}
                onFocus={() => {
                  if (landingSuggestions.length > 0) setLandingSuggestionsOpen(true);
                }}
                onKeyDown={handleLandingSearchKeyDown}
              />
            </form>

            <button
              aria-label="Voice search"
              className="reader-launch-voice-button"
              title="Voice search"
              type="button"
              onClick={startReaderLandingVoiceSearch}
            >
              <svg aria-hidden="true" viewBox="0 0 24 24">
                <path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3Z" />
                <path d="M18 11a6 6 0 0 1-12 0M12 17v4M8 21h8" />
              </svg>
            </button>

            {landingSuggestionsOpen && landingSuggestions.length > 0 && (
              <div
                id="homepage-search-suggestions"
                ref={landingSuggestionsRef}
                className="search-suggestions wiki-landing-suggestions"
                role="listbox"
              >
                {landingSuggestions.map((suggestion, index) => (
                  <button
                    key={suggestion.title}
                    type="button"
                    className={index === landingSelectedSuggestionIndex ? "selected" : ""}
                    role="option"
                    aria-selected={index === landingSelectedSuggestionIndex}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => chooseLandingSuggestion(suggestion)}
                  >
                    <span className="search-suggestion-thumb" aria-hidden="true">
                      {suggestion.imageUrl ? (
                        <img src={suggestion.imageUrl} alt="" loading="lazy" />
                      ) : null}
                    </span>
                    <span className="search-suggestion-text">
                      <strong>{suggestion.title}</strong>
                      {suggestion.description && (
                        <span className="search-suggestion-description">
                          {suggestion.description}
                        </span>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {landingSuggestionsOpen && landingSuggestions.length > 0 && landingScrollbarMetrics.maxScrollTop > 0 && (
              <div
                ref={landingScrollbarRef}
                className="wiki-landing-scrollbar-thumb"
                role="scrollbar"
                aria-label="Search suggestions"
                aria-controls="homepage-search-suggestions"
                aria-orientation="vertical"
                aria-valuemin={0}
                aria-valuemax={Math.round(landingScrollbarMetrics.maxScrollTop)}
                aria-valuenow={Math.round(landingScrollbarMetrics.scrollTop)}
                onPointerDown={handleLandingScrollbarPointerDown}
                onPointerMove={handleLandingScrollbarPointerMove}
                onPointerUp={stopLandingScrollbarDrag}
                onPointerCancel={stopLandingScrollbarDrag}
                style={{
                  height: `${landingScrollbarMetrics.height}px`,
                  top: `calc(100% + 8px + ${landingScrollbarMetrics.top}px)`,
                }}
              />
            )}
          </div>
        </div>
      </section>
    );
  }

  if (currentTarget.kind === "search") {
    return (
      <ReaderSearchResults
        query={currentTarget.query}
        onNavigate={onLandingSearch}
      />
    );
  }

  if (currentTarget.kind === "reference") {
    const { reference } = currentTarget;
    return (
      <article className="reference-reader">
        <span>Reference {reference.number}</span>
        <h2>{reference.text}</h2>
        {reference.url ? (
          <>
            <a href={reference.url} rel="noreferrer" target="_blank">
              {reference.url}
            </a>
            <p>
              Use the arrow in the toolbar to open the original source in your
              default browser.
            </p>
          </>
        ) : (
          <p>This citation does not contain a direct web address.</p>
        )}
      </article>
    );
  }

  if (currentTarget.topic.startsWith("File:")) {
    if (status === "loading") {
      return (
        <div className="reader-loading">
          <span />
          <p>Loading image…</p>
        </div>
      );
    }

    if (status === "error" || !media) {
      return (
        <div className="reader-empty">
          <span className="reader-empty-icon" aria-hidden="true">▧</span>
          <strong>{currentTarget.topic.replace(/^File:/, "")}</strong>
          <p>Couldn’t load this image from Wikipedia Commons.</p>
        </div>
      );
    }

    return (
      <article className="media-reader">
        <header>
          <span>Wikipedia media</span>
          <h2>{media.title}</h2>
        </header>

        <figure className="media-viewer">
          <img src={media.imageUrl} alt={media.title} />
          {media.caption && <figcaption>{media.caption}</figcaption>}
        </figure>

        <dl className="media-details">
          {media.width && media.height && (
            <>
              <dt>Size</dt>
              <dd>{media.width} × {media.height}</dd>
            </>
          )}
          {media.credit && (
            <>
              <dt>Credit</dt>
              <dd>{media.credit}</dd>
            </>
          )}
          {media.license && (
            <>
              <dt>License</dt>
              <dd>{media.license}</dd>
            </>
          )}
        </dl>

        <a className="media-source-link" href={media.pageUrl} rel="noreferrer" target="_blank">
          Open file page on Wikipedia
        </a>
      </article>
    );
  }

  const currentTargetIsLoaded = Boolean(
    currentTarget &&
      loadedTargetKey === readerTargetKey(currentTarget),
  );

  if (status === "loading" || !currentTargetIsLoaded) {
    if (suppressLoadingIndicator) return null;

    return (
      <div className="reader-loading">
        <span />
        <p>Loading {cleanTopic(currentTarget.topic)}…</p>
      </div>
    );
  }

  if (status === "error" || !article) {
    return (
      <div className="reader-empty">
        <strong>Couldn’t load {cleanTopic(currentTarget.topic)}</strong>
        <p>Check your connection or try another search.</p>
      </div>
    );
  }

  return (
    <div
      className="wikipedia-reader"
      ref={readerRootRef}>
      <button
        type="button"
        className="reader-contents-button reader-unified-contents-button"
        aria-label="Open article contents"
        aria-expanded={Boolean(sectionContentsAnchor)}
        disabled={article.sections.length === 0}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          openContentsFromButton(event.currentTarget);
        }}
      >
        ☰
      </button>

      <header className="reader-page-header">
        <div className="reader-title-row">
          <div className="reader-title-block">
            <span>Wikipedia Reader</span>
            <h2>{article.title}</h2>
          </div>
        </div>
      </header>
      <MemoReaderArticleHtml
        html={article.html}
        onClick={handleReaderArticleClick}
        isActive={isActive}
      />

      {sectionContentsAnchor && article.sections.length > 0 && (
        <ReaderInlineContentsPopover
          anchor={sectionContentsAnchor}
          sections={article.sections}
          onClose={closeInlineContents}
          onSectionNavigate={handleInlineSectionNavigate}
        />
      )}
    </div>
  );
}

const MemoReaderContent = memo(ReaderContent);

function readerTargetKey(target: ReaderTarget) {
  if (target.kind === "wiki") {
    return `wiki:${target.topic}`;
  }

  if (target.kind === "search") {
    return `search:${target.query.trim().toLowerCase()}`;
  }

  return `reference:${target.reference.number}:${target.reference.url}`;
}

function sameTarget(left: ReaderTarget, right: ReaderTarget | null) {
  if (!right || left.kind !== right.kind) return false;
  if (left.kind === "wiki" && right.kind === "wiki") {
    return left.topic === right.topic;
  }
  if (left.kind === "search" && right.kind === "search") {
    return left.query.trim().toLowerCase() === right.query.trim().toLowerCase();
  }
  if (left.kind === "reference" && right.kind === "reference") {
    return (
      left.reference.number === right.reference.number &&
      left.reference.url === right.reference.url
    );
  }
  return false;
}

function splitWikipediaTopicFragment(topic: string) {
  const hashIndex = topic.indexOf("#");

  if (hashIndex < 0) {
    return { page: topic, fragment: "" };
  }

  const page = topic.slice(0, hashIndex);
  const rawFragment = topic.slice(hashIndex + 1);
  let fragment = rawFragment;

  try {
    fragment = decodeURIComponent(rawFragment);
  } catch {
    // Keep the literal fragment when it contains malformed percent escapes.
  }

  return {
    page,
    fragment: fragment.replace(/ /g, "_"),
  };
}

function normalizeWikipediaSearchQuery(query: string) {
  return query
    .replace(/^:/, "")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeWikipediaSearchKey(query: string) {
  return normalizeWikipediaSearchQuery(query)
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isWikipediaPortalTitle(title: string) {
  const { page } = splitWikipediaTopicFragment(title);
  return /^portal\s*:/i.test(normalizeWikipediaSearchQuery(page));
}

function isWikipediaPortalTarget(target: ReaderTarget | null) {
  return Boolean(
    target?.kind === "wiki" &&
      isWikipediaPortalTitle(target.topic),
  );
}

function titleCaseWikipediaSearchQuery(query: string) {
  return normalizeWikipediaSearchQuery(query)
    .split(" ")
    .map((part) => {
      if (!part) return part;
      if (part.length <= 2 && part === part.toUpperCase()) return part;
      return part[0].toUpperCase() + part.slice(1);
    })
    .join(" ");
}

function wikipediaSearchVariants(query: string) {
  const cleaned = normalizeWikipediaSearchQuery(query);
  const titleCased = titleCaseWikipediaSearchQuery(cleaned);
  const variants = [cleaned, titleCased];

  return Array.from(
    new Set(variants.filter((variant) => variant.length > 0)),
  );
}

function wikipediaSearchFetchOptions(signal?: AbortSignal): RequestInit | undefined {
  return signal ? { signal } : undefined;
}

class WikipediaApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = "WikipediaApiError";
    this.status = status;
    this.code = code;
  }
}

const WIKIPEDIA_API_DEFAULT_COOLDOWN_MS = 30_000;

let wikipediaApiCooldownUntil = 0;

function wikipediaRetryAfterMs(response: Response): number {
  const retryAfter = response.headers.get("retry-after")?.trim();

  if (!retryAfter) {
    return WIKIPEDIA_API_DEFAULT_COOLDOWN_MS;
  }

  const retryAfterSeconds = Number(retryAfter);

  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return Math.max(1_000, retryAfterSeconds * 1_000);
  }

  const retryAfterTime = Date.parse(retryAfter);

  if (Number.isFinite(retryAfterTime)) {
    return Math.max(1_000, retryAfterTime - Date.now());
  }

  return WIKIPEDIA_API_DEFAULT_COOLDOWN_MS;
}

function wikipediaRateLimitError(): WikipediaApiError {
  const remainingSeconds = Math.max(
    1,
    Math.ceil((wikipediaApiCooldownUntil - Date.now()) / 1_000),
  );

  return new WikipediaApiError(
    `Wikipedia is rate limiting requests. Try again in ${remainingSeconds} seconds.`,
    429,
    "ratelimited",
  );
}

async function wikipediaApiFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  if (Date.now() < wikipediaApiCooldownUntil) {
    throw wikipediaRateLimitError();
  }

  const headers = new Headers(init?.headers);
  headers.set(
    "Api-User-Agent",
    "WikiReader/0.1.0 (contact: dickinso.adam@gmail.com)",
  );

  const response = await fetch(input, {
    ...init,
    headers,
  });

  if (response.status === 429) {
    wikipediaApiCooldownUntil =
      Date.now() + wikipediaRetryAfterMs(response);

    throw wikipediaRateLimitError();
  }

  return response;
}

function throwIfWikipediaHttpError(response: Response) {
  if (response.ok) return;

  throw new WikipediaApiError(
    `Wikipedia returned ${response.status}`,
    response.status,
  );
}

async function loadWikipediaExactTitle(
  query: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const cleaned = normalizeWikipediaSearchQuery(query);
  if (!cleaned || isWikipediaPortalTitle(cleaned)) return null;

  const parameters = new URLSearchParams({
    origin: "*",
    action: "query",
    titles: cleaned,
    redirects: "1",
    format: "json",
    formatversion: "2",
  });

  const response = await wikipediaApiFetch(
    `https://en.wikipedia.org/w/api.php?${parameters}`,
    wikipediaSearchFetchOptions(signal),
  );

  throwIfWikipediaHttpError(response);

  const data = (await response.json()) as {
    query?: {
      pages?: Array<{
        missing?: boolean;
        title?: string;
      }>;
    };
  };

  const page = data.query?.pages?.find((candidate) => candidate.title && !candidate.missing);

  return page?.title && !isWikipediaPortalTitle(page.title)
    ? page.title
    : null;
}

async function loadWikipediaPrefixSuggestions(
  query: string,
  signal: AbortSignal,
): Promise<SearchSuggestion[]> {
  const parameters = new URLSearchParams({
    origin: "*",
    action: "query",
    generator: "prefixsearch",
    gpssearch: query,
    gpslimit: "10",
    gpsnamespace: "0",
    prop: "description|pageimages",
    piprop: "thumbnail",
    pithumbsize: "88",
    pilimit: "10",
    redirects: "1",
    format: "json",
    formatversion: "2",
  });

  const response = await wikipediaApiFetch(
    `https://en.wikipedia.org/w/api.php?${parameters}`,
    { signal },
  );

  throwIfWikipediaHttpError(response);

  const data = (await response.json()) as {
    query?: {
      pages?: Array<{
        index?: number;
        title?: string;
        description?: string;
        thumbnail?: {
          source?: string;
        };
      }>;
    };
  };

  return (data.query?.pages || [])
    .filter(
      (page) => page.title && !isWikipediaPortalTitle(page.title),
    )
    .sort((a, b) => (a.index ?? 9999) - (b.index ?? 9999))
    .map((page) => ({
      title: page.title || "",
      description: page.description || "",
      imageUrl: page.thumbnail?.source,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent((page.title || "").replace(/ /g, "_"))}`,
    }));
}

async function loadWikipediaFullTextSuggestions(
  query: string,
  signal: AbortSignal,
): Promise<SearchSuggestion[]> {
  const parameters = new URLSearchParams({
    origin: "*",
    action: "query",
    generator: "search",
    gsrsearch: query,
    gsrlimit: "10",
    gsrnamespace: "0",
    prop: "description|pageimages",
    piprop: "thumbnail",
    pithumbsize: "88",
    pilimit: "10",
    redirects: "1",
    format: "json",
    formatversion: "2",
  });

  const response = await wikipediaApiFetch(
    `https://en.wikipedia.org/w/api.php?${parameters}`,
    { signal },
  );

  throwIfWikipediaHttpError(response);

  const data = (await response.json()) as {
    query?: {
      pages?: Array<{
        index?: number;
        title?: string;
        description?: string;
        thumbnail?: {
          source?: string;
        };
      }>;
    };
  };

  return (data.query?.pages || [])
    .filter(
      (page) => page.title && !isWikipediaPortalTitle(page.title),
    )
    .sort((a, b) => (a.index ?? 9999) - (b.index ?? 9999))
    .map((page) => ({
      title: page.title || "",
      description: page.description || "",
      imageUrl: page.thumbnail?.source,
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent((page.title || "").replace(/ /g, "_"))}`,
    }));
}

async function loadWikipediaSearchCorrection(
  query: string,
  signal: AbortSignal,
): Promise<string | null> {
  const parameters = new URLSearchParams({
    origin: "*",
    action: "query",
    list: "search",
    srsearch: query,
    srlimit: "1",
    srnamespace: "0",
    srinfo: "suggestion",
    format: "json",
    formatversion: "2",
  });

  const response = await wikipediaApiFetch(
    `https://en.wikipedia.org/w/api.php?${parameters}`,
    { signal },
  );

  throwIfWikipediaHttpError(response);

  const data = (await response.json()) as {
    query?: {
      searchinfo?: {
        suggestion?: string;
      };
    };
  };

  return data.query?.searchinfo?.suggestion || null;
}

async function loadWikipediaSuggestions(
  query: string,
  signal: AbortSignal,
): Promise<SearchSuggestion[]> {
  const cleaned = normalizeWikipediaSearchQuery(query);

  if (
    isWikipediaPortalTitle(cleaned) ||
    cleaned.length < READER_SUGGESTION_MIN_QUERY_LENGTH
  ) {
    return [];
  }

  const suggestions = await loadWikipediaPrefixSuggestions(cleaned, signal);

  return Promise.all(
    suggestions.map(async (suggestion) => {
      if (suggestion.imageUrl) return suggestion;

      try {
        const imageUrl = await loadWikipediaFirstArticleImage(
          suggestion.title,
          signal,
        );
        return imageUrl ? { ...suggestion, imageUrl } : suggestion;
      } catch (error: unknown) {
        if (error instanceof DOMException && error.name === "AbortError") {
          throw error;
        }
        return suggestion;
      }
    }),
  );
}

async function loadWikipediaFirstArticleImage(
  title: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const parameters = new URLSearchParams({
    origin: "*",
    action: "parse",
    page: title,
    prop: "text",
    redirects: "1",
    format: "json",
    formatversion: "2",
  });

  const response = await wikipediaApiFetch(
    `https://en.wikipedia.org/w/api.php?${parameters}`,
    { signal },
  );

  if (!response.ok) return undefined;

  const data = await response.json() as {
    parse?: { text?: string };
  };
  const html = data.parse?.text;
  if (!html) return undefined;

  const article = new DOMParser().parseFromString(html, "text/html");
  const content = article.querySelector(".mw-parser-output");
  if (!content) return undefined;

  const firstHeading = content.querySelector(":scope > h2");
  const isGenericImage = (image: HTMLImageElement) => {
    const source = image.getAttribute("src") || "";
    const alt = image.getAttribute("alt") || "";
    const identity = `${source} ${alt}`.toLocaleLowerCase();

    return (
      /\/(?:20|40|50|60)px-/i.test(source) ||
      /ambox|oojs|icon|edit-ltr|globe_of_letters|warning|error|portal-icon|wikibooks-logo|flag_of_/i.test(
        identity,
      )
    );
  };

  const source = [...content.querySelectorAll("img")]
    .filter((image) =>
      Boolean(image.closest("table.infobox, .infobox")) ||
      !firstHeading ||
      Boolean(
        image.compareDocumentPosition(firstHeading) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ),
    )
    .filter((image) => !image.closest("nav, .navbox"))
    .find((image) => !isGenericImage(image))
    ?.getAttribute("src");

  return source
    ? new URL(source, "https://en.wikipedia.org").href
    : undefined;
}

type ReaderSearchResultsData = {
  correction: string | null;
  results: SearchSuggestion[];
};

async function loadReaderSearchResults(
  query: string,
  signal: AbortSignal,
): Promise<ReaderSearchResultsData> {
  const cleaned = normalizeWikipediaSearchQuery(query);

  if (isWikipediaPortalTitle(cleaned)) {
    return { correction: null, results: [] };
  }

  const directResults = await loadWikipediaFullTextSuggestions(cleaned, signal);
  const normalizedQuery = normalizeWikipediaSearchKey(cleaned);
  const hasNormalizedExactMatch = directResults.some(
    (result) => normalizeWikipediaSearchKey(result.title) === normalizedQuery,
  );

  const suggested = hasNormalizedExactMatch
    ? null
    : await loadWikipediaSearchCorrection(cleaned, signal);
  const correction =
    suggested &&
    normalizeWikipediaSearchKey(suggested) !== normalizedQuery
      ? suggested
      : null;
  const results = correction
    ? await loadWikipediaFullTextSuggestions(correction, signal)
    : directResults;

  const resultsWithImages = await Promise.all(
    results.map(async (result) => {
      if (result.imageUrl) return result;

      try {
        const imageUrl = await loadWikipediaFirstArticleImage(result.title, signal);
        return imageUrl ? { ...result, imageUrl } : result;
      } catch (error: unknown) {
        if (error instanceof DOMException && error.name === "AbortError") {
          throw error;
        }
        return result;
      }
    }),
  );

  return { correction, results: resultsWithImages };
}

async function resolveWikipediaSearchTopic(
  query: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const cleaned = normalizeWikipediaSearchQuery(query);
  if (!cleaned || isWikipediaPortalTitle(cleaned)) return null;

  for (const variant of wikipediaSearchVariants(cleaned)) {
    const exactTitle = await loadWikipediaExactTitle(variant, signal);
    if (exactTitle) return exactTitle;
  }

  const controller = signal ? null : new AbortController();
  const resolutionSignal = signal || controller!.signal;

  const caseInsensitiveMatch = (
    await loadWikipediaPrefixSuggestions(cleaned, resolutionSignal)
  ).find(
    (candidate) =>
      normalizeWikipediaSearchKey(candidate.title) ===
      normalizeWikipediaSearchKey(cleaned),
  );

  if (caseInsensitiveMatch) return caseInsensitiveMatch.title;

  const normalizedSearchKey = normalizeWikipediaSearchKey(cleaned);
  const fullTextMatch = (
    await loadWikipediaFullTextSuggestions(cleaned, resolutionSignal)
  ).find(
    (candidate) =>
      normalizeWikipediaSearchKey(candidate.title) === normalizedSearchKey,
  );

  if (fullTextMatch) return fullTextMatch.title;

  const correction = await loadWikipediaSearchCorrection(cleaned, resolutionSignal);

  if (!correction) return null;

  for (const variant of wikipediaSearchVariants(correction)) {
    const exactTitle = await loadWikipediaExactTitle(variant, resolutionSignal);
    if (exactTitle) return exactTitle;
  }

  return null;
}

// READER CATEGORY PAGES

type ReaderCategoryMemberType = "page" | "subcat" | "file";

type ReaderCategoryMember = {
  title: string;
  type?: ReaderCategoryMemberType;
  sortkeyprefix?: string;
};

type ReaderCategoryInfo = {
  size?: number;
  pages?: number;
  files?: number;
  subcats?: number;
};

type ReaderCategoryMemberBatch = {
  members: ReaderCategoryMember[];
  continuation: string | null;
};

const READER_CATEGORY_BATCH_SIZE = 200;
const READER_CATEGORY_FULL_LOAD_LIMIT = 500;

function isReaderCategoryPageTitle(title: string) {
  return /^Category:/i.test(title.trim());
}

function readerCategoryDisplayTitle(title: string) {
  return title.replace(/^Category:/i, "");
}

function readerCategoryGroupKey(member: ReaderCategoryMember) {
  const source = readerCategoryDisplayTitle(member.title).trim();
  return source.match(/[A-Za-z]/)?.[0].toLocaleUpperCase() || "#";
}

function readerCategoryCountText(info?: ReaderCategoryInfo) {
  if (!info) return "";

  const parts: string[] = [];

  if (info.subcats) parts.push(`${info.subcats} C`);
  if (info.pages) parts.push(`${info.pages} P`);
  if (info.files) parts.push(`${info.files} F`);

  return parts.length ? ` (${parts.join(", ")})` : "";
}

async function loadWikipediaCategoryInfoForTitles(
  titles: string[],
  signal?: AbortSignal,
) {
  const info = new Map<string, ReaderCategoryInfo>();
  const uniqueTitles = Array.from(new Set(titles.filter(Boolean)));

  for (let index = 0; index < uniqueTitles.length; index += 50) {
    const chunk = uniqueTitles.slice(index, index + 50);
    const parameters = new URLSearchParams({
      origin: "*",
      action: "query",
      prop: "categoryinfo",
      titles: chunk.join("|"),
      format: "json",
      formatversion: "2",
    });

    const response = await wikipediaApiFetch(
      `https://en.wikipedia.org/w/api.php?${parameters}`,
      signal ? { signal } : undefined,
    );

    throwIfWikipediaHttpError(response);

    const data = await response.json() as {
      error?: { code?: string; info?: string };
      query?: {
        pages?: Array<{
          title: string;
          categoryinfo?: ReaderCategoryInfo;
        }>;
      };
    };

    if (data.error) {
      throw new WikipediaApiError(
        data.error.info || "Wikipedia category info error",
        response.status,
        data.error.code || null,
      );
    }

    data.query?.pages?.forEach((page) => {
      info.set(page.title, page.categoryinfo || {});
    });
  }

  return info;
}

async function loadWikipediaCategoryMemberBatch(
  categoryTitle: string,
  memberType: ReaderCategoryMemberType,
  signal?: AbortSignal,
  continuation?: string | null,
): Promise<ReaderCategoryMemberBatch> {
  const parameters = new URLSearchParams({
    origin: "*",
    action: "query",
    list: "categorymembers",
    cmtitle: categoryTitle,
    cmtype: memberType,
    cmlimit: String(READER_CATEGORY_BATCH_SIZE),
    cmsort: "sortkey",
    cmdir: "ascending",
    cmprop: "title|type|sortkeyprefix",
    format: "json",
    formatversion: "2",
  });

  if (continuation) parameters.set("cmcontinue", continuation);

  const response = await wikipediaApiFetch(
    `https://en.wikipedia.org/w/api.php?${parameters}`,
    signal ? { signal } : undefined,
  );

  throwIfWikipediaHttpError(response);

  const data = await response.json() as {
    error?: { code?: string; info?: string };
    continue?: { cmcontinue?: string };
    query?: { categorymembers?: ReaderCategoryMember[] };
  };

  if (data.error) {
    throw new WikipediaApiError(
      data.error.info || "Wikipedia category members error",
      response.status,
      data.error.code || null,
    );
  }

  return {
    members: data.query?.categorymembers || [],
    continuation: data.continue?.cmcontinue || null,
  };
}

async function loadWikipediaCategoryMembers(
  categoryTitle: string,
  memberType: ReaderCategoryMemberType,
  total: number,
  signal?: AbortSignal,
) {
  const members: ReaderCategoryMember[] = [];
  const shouldLoadAll = total <= READER_CATEGORY_FULL_LOAD_LIMIT;
  let continuation: string | null = null;

  do {
    const batch = await loadWikipediaCategoryMemberBatch(
      categoryTitle,
      memberType,
      signal,
      continuation,
    );

    members.push(...batch.members);
    continuation = batch.continuation;
  } while (
    continuation &&
    shouldLoadAll &&
    members.length < READER_CATEGORY_FULL_LOAD_LIMIT
  );

  return {
    members,
    hasMore: Boolean(continuation),
  };
}

function configureReaderCategoryTreeToggle(
  button: HTMLButtonElement,
  categoryTitle: string,
  info?: ReaderCategoryInfo,
) {
  const subcategoryCount = info?.subcats || 0;
  const expandable = subcategoryCount > 0;

  button.type = "button";
  button.className = "reader-category-tree-toggle";
  button.dataset.readerCategoryTitle = categoryTitle;
  button.dataset.readerCategorySubcatCount = String(subcategoryCount);
  button.disabled = !expandable;
  button.textContent = "▸";
  button.setAttribute("aria-expanded", "false");
  button.setAttribute(
    "aria-label",
    expandable ? "Expand subcategories" : "No subcategories",
  );
  button.title = expandable ? "Expand subcategories" : "No subcategories";
  button.classList.toggle("reader-category-tree-toggle-empty", !expandable);
}

function makeReaderCategoryLink(
  document: Document,
  title: string,
  label = title,
) {
  const link = document.createElement("a");
  link.textContent = label;
  link.dataset.wikiTarget = title;

  const visited = readReaderVisitedLinks();
  if (visited[readerWikiTargetKey(title)] !== undefined) {
    link.classList.add("reader-visited-link");
  }

  return link;
}

function makeReaderCategoryTreeNode(
  document: Document,
  member: ReaderCategoryMember,
  info?: ReaderCategoryInfo,
) {
  const node = document.createElement("div");
  node.className = "reader-category-tree-node";

  const button = document.createElement("button");
  configureReaderCategoryTreeToggle(button, member.title, info);

  const link = makeReaderCategoryLink(
    document,
    member.title,
    readerCategoryDisplayTitle(member.title),
  );

  const count = document.createElement("span");
  count.className = "reader-category-tree-count";
  count.textContent = readerCategoryCountText(info);

  const children = document.createElement("div");
  children.className = "reader-category-tree-children";
  children.hidden = true;

  node.append(button, link, count, children);
  return node;
}

function makeReaderCategoryGroupedColumns(
  document: Document,
  members: ReaderCategoryMember[],
  kind: "subcategories" | "pages",
  subcategoryInfo?: Map<string, ReaderCategoryInfo>,
) {
  const groups = new Map<string, ReaderCategoryMember[]>();

  members.forEach((member) => {
    const group = readerCategoryGroupKey(member);
    const groupMembers = groups.get(group) || [];
    groupMembers.push(member);
    groups.set(group, groupMembers);
  });

  const columns = document.createElement("div");
  columns.className = `reader-category-groups reader-category-groups-${kind}`;

  Array.from(groups.entries())
    .sort(([firstName], [secondName]) => firstName.localeCompare(secondName))
    .forEach(([groupName, groupMembers]) => {
    groupMembers.sort((firstMember, secondMember) =>
      readerCategoryDisplayTitle(firstMember.title).localeCompare(
        readerCategoryDisplayTitle(secondMember.title),
      ),
    );

    const group = document.createElement("section");
    group.className = "reader-category-group";

    const heading = document.createElement("h3");
    heading.className = "reader-category-letter";
    heading.textContent = groupName;

    const list = document.createElement("ul");

    groupMembers.forEach((member) => {
      const item = document.createElement("li");

      if (kind === "subcategories") {
        item.classList.add(
          "reader-category-tree-node",
          "reader-category-tree-top-node",
        );

        const button = document.createElement("button");
        configureReaderCategoryTreeToggle(
          button,
          member.title,
          subcategoryInfo?.get(member.title),
        );

        const link = makeReaderCategoryLink(
          document,
          member.title,
          readerCategoryDisplayTitle(member.title),
        );

        const count = document.createElement("span");
        count.className = "reader-category-tree-count";
        count.textContent = readerCategoryCountText(
          subcategoryInfo?.get(member.title),
        );

        const children = document.createElement("div");
        children.className = "reader-category-tree-children";
        children.hidden = true;

        item.append(button, link, count, children);
      } else {
        item.append(makeReaderCategoryLink(document, member.title));
      }

      list.append(item);
    });

    group.append(heading, list);
    columns.append(group);
    });

  return columns;
}

async function loadWikipediaCategoryHtml(
  pageTitle: string,
  signal: AbortSignal,
) {
  if (!isReaderCategoryPageTitle(pageTitle)) return "";

  try {
    const categoryInfo = await loadWikipediaCategoryInfoForTitles(
      [pageTitle],
      signal,
    );
    const info = categoryInfo.get(pageTitle) || {};
    const totalSubcategories = info.subcats || 0;
    const totalPages = info.pages || 0;

    const [subcategories, pages] = await Promise.all([
      loadWikipediaCategoryMembers(
        pageTitle,
        "subcat",
        totalSubcategories,
        signal,
      ),
      loadWikipediaCategoryMembers(pageTitle, "page", totalPages, signal),
    ]);

    const subcategoryInfo = await loadWikipediaCategoryInfoForTitles(
      subcategories.members.map((member) => member.title),
      signal,
    );

    const categoryDocument = new DOMParser().parseFromString("", "text/html");
    const container = categoryDocument.createElement("div");
    container.className = "reader-category-generated";

    if (subcategories.members.length) {
      const section = categoryDocument.createElement("section");
      section.className = "reader-category-section";

      const heading = categoryDocument.createElement("h2");
      heading.textContent = "Subcategories";

      const summary = categoryDocument.createElement("p");
      summary.className = "reader-category-summary";
      summary.textContent =
        `This category has the following ${subcategories.members.length} ` +
        `subcategories, out of ${totalSubcategories} total.`;

      section.append(
        heading,
        summary,
        makeReaderCategoryGroupedColumns(
          categoryDocument,
          subcategories.members,
          "subcategories",
          subcategoryInfo,
        ),
      );

      if (subcategories.hasMore) {
        section.dataset.readerCategoryTruncated = "true";
      }

      container.append(section);
    }

    if (pages.members.length) {
      const section = categoryDocument.createElement("section");
      section.className = "reader-category-section";

      const heading = categoryDocument.createElement("h2");
      heading.textContent =
        `Pages in category “${readerCategoryDisplayTitle(pageTitle)}”`;

      const summary = categoryDocument.createElement("p");
      summary.className = "reader-category-summary";
      summary.textContent =
        `The following ${pages.members.length} pages are in this category, ` +
        `out of ${totalPages} total.`;

      section.append(
        heading,
        summary,
        makeReaderCategoryGroupedColumns(
          categoryDocument,
          pages.members,
          "pages",
        ),
      );

      if (pages.hasMore) {
        section.dataset.readerCategoryTruncated = "true";
      }

      container.append(section);
    }

    categoryDocument.body.append(container);
    return categoryDocument.body.innerHTML;
  } catch (error) {
    if (signal.aborted) throw error;

    console.warn("Reader category data failed", pageTitle, error);
    return "";
  }
}

async function toggleReaderCategoryTree(
  button: HTMLButtonElement,
) {
  if (button.disabled) return;

  const node = button.closest<HTMLElement>(".reader-category-tree-node");
  const children = node?.querySelector<HTMLElement>(
    ":scope > .reader-category-tree-children",
  );

  if (!node || !children) return;

  if (node.dataset.readerCategoryTreeLoaded === "1") {
    const expanded = children.hidden;
    children.hidden = !expanded;
    button.textContent = expanded ? "▾" : "▸";
    button.setAttribute("aria-expanded", expanded ? "true" : "false");
    button.setAttribute(
      "aria-label",
      expanded ? "Collapse subcategories" : "Expand subcategories",
    );
    return;
  }

  const categoryTitle = button.dataset.readerCategoryTitle;
  const expectedSubcategories = Number(
    button.dataset.readerCategorySubcatCount || "0",
  );

  if (!categoryTitle || expectedSubcategories <= 0) return;

  const article = button.closest<HTMLElement>(".reader-article");
  button.disabled = true;
  button.textContent = "…";

  try {
    const result = await loadWikipediaCategoryMembers(
      categoryTitle,
      "subcat",
      expectedSubcategories,
    );
    const childInfo = await loadWikipediaCategoryInfoForTitles(
      result.members.map((member) => member.title),
    );

    if (
      !button.isConnected ||
      !children.isConnected ||
      button.closest(".reader-article") !== article
    ) {
      return;
    }

    children.replaceChildren(
      ...result.members.map((member) =>
        makeReaderCategoryTreeNode(
          button.ownerDocument,
          member,
          childInfo.get(member.title),
        ),
      ),
    );

    node.dataset.readerCategoryTreeLoaded = "1";
    children.hidden = false;
    button.disabled = false;
    button.textContent = "▾";
    button.setAttribute("aria-expanded", "true");
    button.setAttribute("aria-label", "Collapse subcategories");
  } catch (error) {
    console.error("Category tree expansion failed", categoryTitle, error);

    if (button.isConnected) {
      button.disabled = false;
      button.textContent = "▸";
      button.setAttribute("aria-expanded", "false");
      button.setAttribute("aria-label", "Expand subcategories");
    }
  }
}

// END READER CATEGORY PAGES

async function loadWikipediaArticleCategoriesHtml(
  page: string,
  signal: AbortSignal,
): Promise<string> {
  const apiParameters = new URLSearchParams({
    origin: "*",
    action: "query",
    prop: "categories",
    cllimit: "max",
    clprop: "hidden",
    titles: page,
    format: "json",
    formatversion: "2",
  });

  const restUrl =
    "https://en.wikipedia.org/api/rest_v1/page/html/" +
    encodeURIComponent(page.replace(/ /g, "_"));

  const [apiResponse, restResponse] = await Promise.all([
    wikipediaApiFetch(
      "https://en.wikipedia.org/w/api.php?" + apiParameters.toString(),
      { signal },
    ),
    wikipediaApiFetch(restUrl, { signal }),
  ]);

  throwIfWikipediaHttpError(apiResponse);
  throwIfWikipediaHttpError(restResponse);

  const categoryData = await apiResponse.json() as {
    query?: {
      pages?: Array<{
        categories?: Array<{ title: string; hidden?: boolean }>;
      }>;
    };
  };

  const categoryInfo = new Map(
    (categoryData.query?.pages?.[0]?.categories || []).map((category) => [
      category.title,
      !!category.hidden,
    ]),
  );

  const restHtml = await restResponse.text();
  const restDocument = new DOMParser().parseFromString(restHtml, "text/html");
  const categoryBox = restDocument.createElement("div");
  categoryBox.className = "reader-category-links";

  const label = restDocument.createElement("strong");
  label.textContent = "Categories:";

  const list = restDocument.createElement("ul");
  const seen = new Set<string>();

  for (const element of restDocument.querySelectorAll(
    `link[rel="mw:PageProp/Category"]`,
  )) {
    const href = element.getAttribute("href") || "";
    const rawCategory = href.split("/").pop() || "";
    const category = decodeURIComponent(rawCategory)
      .replace(/#.*/, "")
      .trim()
      .replace(/_/g, " ");

    if (!categoryInfo.has(category) || categoryInfo.get(category) || seen.has(category)) {
      continue;
    }

    seen.add(category);
    const name = category.replace(/^Category:/i, "");
    const item = restDocument.createElement("li");
    const link = restDocument.createElement("a");
    link.textContent = name;
    link.setAttribute("data-wiki-target", category.replace(/ /g, "_"));
    item.append(link);
    list.append(item);
  }

  categoryBox.append(label, list);
  return categoryBox.outerHTML;
}

async function readerUseParsoidKartographerImageSources(
  articleHtml: string,
  pageTitle: string,
  signal: AbortSignal,
): Promise<string> {
  const mapImageSelector =
    ".mw-kartographer-map img[src*='maps.wikimedia.org/img/osm']";

  if (!articleHtml.includes("maps.wikimedia.org/img/osm")) return articleHtml;

  try {
    const restUrl =
      "https://en.wikipedia.org/api/rest_v1/page/html/" +
      encodeURIComponent(pageTitle.replace(/ /g, "_"));
    const response = await wikipediaApiFetch(restUrl, { signal });

    if (!response.ok) {
      console.warn("Parsoid map image refresh failed", {
        pageTitle,
        status: response.status,
      });
      return articleHtml;
    }

    const parsoidHtml = await response.text();
    const parsoidDocument = new DOMParser().parseFromString(
      parsoidHtml,
      "text/html",
    );
    const articleDocument = new DOMParser().parseFromString(
      articleHtml,
      "text/html",
    );
    const parsoidImages = Array.from(
      parsoidDocument.querySelectorAll<HTMLImageElement>(mapImageSelector),
    );
    const articleImages = Array.from(
      articleDocument.querySelectorAll<HTMLImageElement>(mapImageSelector),
    );

    if (
      !parsoidImages.length ||
      articleImages.length !== parsoidImages.length
    ) {
      console.warn("Parsoid map image count did not match parsed article", {
        pageTitle,
        articleMaps: articleImages.length,
        parsoidMaps: parsoidImages.length,
      });
      return articleHtml;
    }

    articleImages.forEach((articleImage, index) => {
      const parsoidImage = parsoidImages[index];

      ["src", "srcset", "sizes"].forEach((attribute) => {
        const value = parsoidImage.getAttribute(attribute);

        if (value) {
          articleImage.setAttribute(attribute, value);
        } else {
          articleImage.removeAttribute(attribute);
        }
      });
    });

    return articleDocument.body.innerHTML;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }

    console.warn("Parsoid map image refresh failed", pageTitle, error);
    return articleHtml;
  }
}

async function loadWikipediaArticlePage(
  page: string,
  signal: AbortSignal,
  onCoordinatesHtml: (coordinatesHtml: string) => void,
  onCategoryHtml: (categoryHtml: string) => void,
): Promise<ReaderArticle> {
  const parameters = new URLSearchParams({
    origin: "*",
    action: "parse",
    page,
    prop: "text|displaytitle",
    redirects: "1",
    disableeditsection: "1",
    disabletoc: "1",
    format: "json",
    formatversion: "2",
  });

  const response = await wikipediaApiFetch(
    `https://en.wikipedia.org/w/api.php?${parameters}`,
    { signal },
  );

  throwIfWikipediaHttpError(response);

  const data = await response.json() as {
    error?: { code?: string; info?: string };
    parse?: { title: string; displaytitle?: string; text: string };
  };

  if (data.error) {
    throw new WikipediaApiError(
      data.error.info || "Wikipedia API error",
      response.status,
      data.error.code || null,
    );
  }

  if (!data.parse) {
    throw new WikipediaApiError(
      "Wikipedia page not found",
      response.status,
      "invalidresponse",
    );
  }

  if (isWikipediaPortalTitle(data.parse.title)) {
    throw new WikipediaApiError(
      "Wikipedia Portal pages are not supported",
      404,
      "unsupportednamespace",
    );
  }

  const articleHtmlWithParsoidMapImages =
    await readerUseParsoidKartographerImageSources(
      data.parse.text,
      data.parse.title,
      signal,
    );
  const sanitizerStartedAt = performance.now();
  console.log("[reader loader] sanitizer start", {
    title: data.parse.title,
    htmlBytes: articleHtmlWithParsoidMapImages.length,
  });
  const sanitizedArticle = sanitizeWikipediaHtml(
    articleHtmlWithParsoidMapImages,
    data.parse.title,
  );
  console.log("[reader loader] sanitizer complete", {
    title: data.parse.title,
    htmlBytes: sanitizedArticle.html.length,
    sections: sanitizedArticle.sections.length,
    elapsedMs: Math.round(performance.now() - sanitizerStartedAt),
  });

  /*
   * ADAM PAGE-FIRST DEFERRED COORDINATES
   *
   * Start coordinates as soon as the parsed page title is known, but do not
   * hold the readable article behind that secondary request.
   */
  const coordinatesHtmlPromise = loadWikipediaCoordinatesHtml(
    data.parse.title,
    signal,
  );

  const isCategoryPage = isReaderCategoryPageTitle(data.parse.title);
  const categoryHtml = isCategoryPage
    ? await loadWikipediaCategoryHtml(data.parse.title, signal).catch((error) => {
        console.warn("Category page loading failed", error);
        return "";
      })
    : "";
  const categoryLinksHtml = isCategoryPage
    ? await loadWikipediaArticleCategoriesHtml(data.parse.title, signal).catch(
        (error) => {
          console.warn("Category page links loading failed", error);
          return "";
        },
      )
    : "";

  if (!isCategoryPage) {
    const categoryHtmlPromise = loadWikipediaArticleCategoriesHtml(
      data.parse.title,
      signal,
    ).catch((error) => {
      console.warn("Article category loading failed", error);
      return "";
    });

    void categoryHtmlPromise.then((nextCategoryHtml) => {
      if (!signal.aborted && nextCategoryHtml) {
        onCategoryHtml(nextCategoryHtml);
      }
    });
  }

  void coordinatesHtmlPromise.then((coordinatesHtml) => {
    if (!signal.aborted && coordinatesHtml) {
      onCoordinatesHtml(coordinatesHtml);
    }
  });

  return {
    title: htmlToText(data.parse.displaytitle || data.parse.title),
    html: combineReaderArticleHtml(
      "",
      `${sanitizedArticle.html}${categoryHtml}${categoryLinksHtml}`,
    ),
    sections: sanitizedArticle.sections,
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(data.parse.title.replace(/ /g, "_"))}`,
  };
}

async function loadWikipediaArticle(
  topic: string,
  signal: AbortSignal,
  onCoordinatesHtml: (coordinatesHtml: string) => void,
  onCategoryHtml: (categoryHtml: string) => void,
): Promise<ReaderArticle> {
  const { page: topicPage } = splitWikipediaTopicFragment(topic);
  const page = normalizeWikipediaSearchQuery(topicPage);

  if (isWikipediaPortalTitle(page)) {
    throw new WikipediaApiError(
      "Wikipedia Portal pages are not supported",
      404,
      "unsupportednamespace",
    );
  }

  try {
    return await loadWikipediaArticlePage(
      page,
      signal,
      onCoordinatesHtml,
      onCategoryHtml,
    );
  } catch (firstError) {
    if (
      !(firstError instanceof WikipediaApiError) ||
      firstError.code !== "missingtitle"
    ) {
      throw firstError;
    }

    const resolvedTopic = await resolveWikipediaSearchTopic(page, signal);

    if (resolvedTopic && resolvedTopic !== page) {
      return loadWikipediaArticlePage(
        resolvedTopic,
        signal,
        onCoordinatesHtml,
        onCategoryHtml,
      );
    }

    throw firstError;
  }
}

async function loadWikipediaMedia(
  topic: string,
  signal: AbortSignal,
): Promise<ReaderMedia> {
  const cleanedTopic = topic.replace(/^:/, "").replace(/_/g, " ");
  const title = cleanedTopic.startsWith("File:")
    ? cleanedTopic
    : `File:${cleanedTopic}`;

  const parameters = new URLSearchParams({
    origin: "*",
    action: "query",
    titles: title,
    prop: "imageinfo",
    iiprop: "url|size|mime|extmetadata",
    iiurlwidth: "1600",
    format: "json",
    formatversion: "2",
  });

  const response = await wikipediaApiFetch(
    `https://en.wikipedia.org/w/api.php?${parameters}`,
    { signal },
  );

  if (!response.ok) throw new Error(`Wikipedia returned ${response.status}`);

  const data = await response.json() as {
    error?: { info?: string };
    query?: {
      pages?: Array<{
        title: string;
        imageinfo?: Array<{
          url: string;
          thumburl?: string;
          descriptionurl?: string;
          width?: number;
          height?: number;
          thumbwidth?: number;
          thumbheight?: number;
          extmetadata?: Record<string, { value?: string }>;
        }>;
      }>;
    };
  };

  if (data.error) throw new Error(data.error.info || "Wikipedia image not found");

  const page = data.query?.pages?.[0];
  const imageInfo = page?.imageinfo?.[0];

  if (!page || !imageInfo?.url) {
    throw new Error("Wikipedia image not found");
  }

  const metadata = imageInfo.extmetadata || {};
  const caption = htmlToText(
    metadata.ImageDescription?.value ||
      metadata.ObjectName?.value ||
      "",
  );
  const credit = htmlToText(
    metadata.Artist?.value ||
      metadata.Credit?.value ||
      "",
  );
  const license = htmlToText(
    metadata.LicenseShortName?.value ||
      metadata.UsageTerms?.value ||
      "",
  );

  return {
    title: page.title.replace(/^File:/, ""),
    fileName: page.title,
    imageUrl: imageInfo.thumburl || imageInfo.url,
    pageUrl:
      imageInfo.descriptionurl ||
      `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, "_"))}`,
    width: imageInfo.width,
    height: imageInfo.height,
    caption,
    credit,
    license,
  };
}





function markReaderClimateCharts(document: Document) {
  const parseClimateNumbers = (text: string) =>
    (text.match(/-?\d+(?:\.\d+)?/g) || []).map((value) => ({
      text: value,
      number: Number(value),
    }));

  const tables = Array.from(document.querySelectorAll<HTMLTableElement>("table.infobox, table"));

  tables.forEach((table) => {
    const tableText = (table.textContent || "").replace(/\s+/g, " ");

    if (
      !tableText.includes("Climate chart") ||
      (!tableText.includes("Metric conversion") &&
        !tableText.includes("Imperial conversion")) ||
      !tableText.includes("Average max. and min.") ||
      !tableText.includes("Precipitation totals")
    ) {
      return;
    }

    table.classList.add("reader-climate-chart");

    const targetTitle = "Template:Climate chart/How to read a climate chart";

    const explanationCell = Array.from(table.querySelectorAll<HTMLElement>("th, td")).find((cell) => {
      const text = (cell.textContent || "").replace(/\s+/g, " ").trim();
      return text.includes("Climate chart") && text.includes("explanation");
    });

    if (explanationCell) {
      explanationCell.replaceChildren();

      const before = document.createTextNode("Climate chart (");
      const link = document.createElement("a");
      const after = document.createTextNode(")");

      link.className = "reader-climate-explanation-link";
      link.dataset.wikiTarget = targetTitle;
      link.title = targetTitle;
      link.textContent = "explanation";

      explanationCell.append(before, link, after);
    }

    Array.from(table.querySelectorAll<HTMLTableRowElement>("tr")).forEach((row) => {
      const text = (row.textContent || "").replace(/\s+/g, " ").trim();

      row.classList.remove(
        "reader-climate-source-row",
        "reader-climate-metric-title-row",
        "reader-climate-bottom-legend-row",
      );

      if (text === "Source: NOAA") {
        row.classList.add("reader-climate-source-row");
      }

      if (text === "Metric conversion") {
        row.classList.add("reader-climate-metric-title-row");
      }

      if (text.includes("Precipitation totals in mm")) {
        row.classList.add("reader-climate-bottom-legend-row");
      }
    });

    Array.from(table.querySelectorAll<HTMLTableElement>("table.infobox")).forEach((innerTable, index) => {
      innerTable.classList.toggle("reader-climate-imperial-inner-table", index === 0);
      innerTable.classList.toggle("reader-climate-metric-inner-table", index === 1);
    });

    const monthRows = Array.from(table.querySelectorAll<HTMLTableRowElement>("table.infobox > tbody > tr")).filter((row) => {
      const cells = Array.from(row.children);
      return cells.length === 12 && cells.every((cell) => parseClimateNumbers(cell.textContent || "").length >= 3);
    });

    monthRows.forEach((row) => {
      const cells = Array.from(row.children) as HTMLElement[];

      row.classList.add("reader-climate-v2-row");

      const values = cells.map((cell) => {
        const [precip, high, low] = parseClimateNumbers(cell.textContent || "");

        return {
          precipText: precip?.text || "",
          highText: high?.text || "",
          lowText: low?.text || "",
          precip: precip?.number ?? 0,
          high: high?.number ?? 0,
          low: low?.number ?? 0,
        };
      });

      const maxPrecip = Math.max(...values.map((value) => value.precip), 1);
      const maxHigh = Math.max(...values.map((value) => value.high), 1);
      const minLow = Math.min(...values.map((value) => value.low), 0);
      const tempRange = Math.max(maxHigh - minLow, 1);

      cells.forEach((cell, index) => {
        const value = values[index];

        const isFahrenheitRow = maxHigh > 45;
        const tempTop = isFahrenheitRow ? 24 : 18;
        const tempScale = isFahrenheitRow ? 80 : 72;

        const highY = Math.round(tempTop + ((maxHigh - value.high) / tempRange) * tempScale);
        const lowY = Math.round(tempTop + ((maxHigh - value.low) / tempRange) * tempScale);

        const barTop = highY;
        const barHeight = Math.max(12, lowY - highY);

        const highLabelTop = Math.max(0, barTop - (isFahrenheitRow ? 20 : 18));
        const lowLabelTop = Math.min(isFahrenheitRow ? 116 : 104, barTop + barHeight + (isFahrenheitRow ? 4 : 3));

        const precipHeight = value.precip <= 0
          ? 2
          : Math.max(3, Math.round((value.precip / maxPrecip) * 44));

        cell.replaceChildren();

        const wrapper = document.createElement("div");
        wrapper.className = "reader-climate-v2-cell";
        wrapper.style.setProperty("--temp-bar-top", `${barTop}px`);
        wrapper.style.setProperty("--temp-bar-height", `${barHeight}px`);
        wrapper.style.setProperty("--temp-high-top", `${highLabelTop}px`);
        wrapper.style.setProperty("--temp-low-top", `${lowLabelTop}px`);
        wrapper.style.setProperty("--precip-height", `${precipHeight}px`);

        wrapper.innerHTML = `
          <div class="reader-climate-v2-temp-plot">
            <div class="reader-climate-v2-high">${value.highText}</div>
            <div class="reader-climate-v2-temp-bar"></div>
            <div class="reader-climate-v2-low">${value.lowText}</div>
          </div>
          <div class="reader-climate-v2-precip-plot">
            <div class="reader-climate-v2-precip-bar"></div>
          </div>
          <div class="reader-climate-v2-precip-value">${value.precipText}</div>
        `;

        cell.append(wrapper);
      });
    });
  });
}



function markReaderClimateDataTables(document: Document) {
  const tables = Array.from(document.querySelectorAll<HTMLTableElement>("table"));

  tables.forEach((table) => {
    const tableText = (table.textContent || "").replace(/\s+/g, " ").trim();

    if (
      !tableText.includes("Climate data") ||
      !tableText.includes("Month") ||
      !tableText.includes("Jan") ||
      !tableText.includes("Feb") ||
      !tableText.includes("Mar")
    ) {
      return;
    }

    table.classList.add("reader-climate-data-table");

    const details = table.closest("details");
    details?.classList.add("reader-climate-data-details");

    const summary = details?.querySelector<HTMLElement>("summary");
    summary?.classList.add("reader-climate-data-summary");

    const monthRow = Array.from(table.querySelectorAll<HTMLTableRowElement>("tr")).find((row) => {
      const text = (row.textContent || "").replace(/\s+/g, " ").trim();
      return text.startsWith("Month Jan Feb Mar");
    });

    if (monthRow) {
      monthRow.classList.add("reader-climate-data-month-row");

      const firstCell = monthRow.children[0] as HTMLElement | undefined;
      const lastCell = monthRow.children[monthRow.children.length - 1] as HTMLElement | undefined;

      firstCell?.classList.add("reader-climate-data-month-first-cell");
      lastCell?.classList.add("reader-climate-data-month-last-cell");

      [monthRow, firstCell, lastCell].forEach((element) => {
        element?.style.setProperty("border-radius", "0", "important");
        element?.style.setProperty("border-top-left-radius", "0", "important");
        element?.style.setProperty("border-top-right-radius", "0", "important");
        element?.style.setProperty("overflow", "visible", "important");
      });
    }

    const scope = details || table;

    Array.from(
      scope.querySelectorAll<HTMLElement>(
        "ul, ol, .navbar, .noprint, .mw-editsection, tr, td, th, div, span, a",
      ),
    ).forEach((element) => {
      const text = (element.textContent || "").replace(/\s+/g, " ").trim();
      const compact = text.replace(/[•·\s]/g, "").toLowerCase();

      if (
        compact === "vte" ||
        compact === "vt" ||
        compact === "te" ||
        compact.startsWith("vteclimatedata")
      ) {
        const hideTarget =
          element.closest<HTMLElement>("tr") ||
          element.closest<HTMLElement>("ul, ol") ||
          element;

        hideTarget.classList.add("reader-climate-data-hidden-vte");
      }
    });
  });
}


function combineReaderArticleHtml(coordinatesHtml: string, articleHtml: string) {
  const parser = new DOMParser();
  const document = parser.parseFromString(
    `${coordinatesHtml}${articleHtml}`,
    "text/html",
  );

  removeReaderHatnotes(document);

  const coordinates = document.querySelector<HTMLElement>(".reader-coordinates");
  if (coordinates) {
    coordinates.classList.add("reader-coordinates-top");
    document.body.insertBefore(coordinates, document.body.firstChild);
  }

  markReaderLocationMapMainImages(document);
  markReaderElectionResultsTables(document);
  markReaderCountyResultsTotalsRows(document);
  markReaderGeneralElectionResultsColorStrips(document);
  markReaderElectionInfoboxNavigation(document);
  markReaderElectionInfoboxCandidatePhotoStrips(document);
  markReaderElectionInfoboxStructure(document);
  markReaderInfoboxBelligerentsRows(document);
  markReaderInfoboxRowsByHeading(document, "Commanders and leaders", "reader-infobox-commanders-row");
  markReaderInfoboxRowsByHeading(document, "Casualties and losses", "reader-infobox-casualties-row");
  markReaderInfoboxMetadataRows(document);
  normalizeReadableColoredTableCellText(document);
  markReaderClimateCharts(document);
  markReaderClimateDataTables(document);

  disableReaderLocationMapExternalClicks(document);

  return document.body.innerHTML;
}





function upgradeReaderDemographicTables(document: Document) {
  document.querySelectorAll<HTMLTableElement>("table").forEach((table) => {
    const tableText = table.textContent?.replace(/\s+/g, " ").trim() ?? "";
    const captionText = table.querySelector("caption")?.textContent?.replace(/\s+/g, " ").trim() ?? "";

    const looksLikeHistoricalPopulation =
      /historical population/i.test(captionText || tableText) ||
      (/census/i.test(tableText) && /pop\.?/i.test(tableText) && /%\s*±|%±/.test(tableText));

    if (!looksLikeHistoricalPopulation) return;

    table.classList.add("reader-demographic-table");

    if (!table.closest(".reader-demographic-box")) {
      const box = document.createElement("div");
      box.className = "reader-demographic-box";

      const title = document.createElement("div");
      title.className = "reader-demographic-title";
      title.textContent = captionText || "Historical population";

      table.parentNode?.insertBefore(box, table);
      table.querySelector("caption")?.remove();
      box.append(title, table);
    }

    const rows = Array.from(table.querySelectorAll<HTMLTableRowElement>("tr"));
    const headerRow = rows.find((row) =>
      Array.from(row.children).some((cell) =>
        /^note$/i.test(cell.textContent?.replace(/\s+/g, " ").trim() ?? ""),
      ),
    );

    if (!headerRow) return;

    const noteIndex = Array.from(headerRow.children).findIndex((cell) =>
      /^note$/i.test(cell.textContent?.replace(/\s+/g, " ").trim() ?? ""),
    );

    if (noteIndex < 0) return;

    rows.forEach((row) => {
      const cells = Array.from(row.children);
      const cell = cells[noteIndex] as HTMLElement | undefined;

      if (!cell) return;

      const text = cell.textContent?.replace(/\s+/g, " ").trim() ?? "";

      // Remove the Note column when it is blank or it is the Note header itself.
      if (/^note$/i.test(text) || text === "") {
        cell.remove();
      }
    });
  });
}


const READER_PIE_CHART_FALLBACK_COLORS = [
  "#f0edec",
  "#857651",
  "#f0e597",
  "#111111",
  "#8b5a3c",
  "#cc2f2f",
  "#5b8def",
  "#5da86e",
];

interface ReaderParsedPieChartItem {
  ordinal: string;
  label: string;
  value: number;
  valueText: string;
  color: string;
}

function readerPieChartColorForLabel(label: string, index: number) {
  const normalized = label.toLowerCase();

  if (normalized.includes("white")) return "#f0edec";
  if (normalized.includes("two or more")) return "#857651";
  if (normalized.includes("asian")) return "#f0e597";
  if (normalized.includes("black")) return "#111111";
  if (normalized.includes("hispanic") || normalized.includes("latino")) return "#8b5a3c";
  if (normalized.includes("american indian") || normalized.includes("native american")) return "#f5222d";

  return READER_PIE_CHART_FALLBACK_COLORS[index % READER_PIE_CHART_FALLBACK_COLORS.length];
}

function parseReaderPieChartLegendItem(text: string, index: number) {
  const cleaned = text
    .replace(/\[[^\]]+\]/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const match = cleaned.match(/^(?:(\d+)[.)]\s*)?(.+?)\s*\(([\d.]+)%\)$/i);
  if (!match) return null;

  const value = Number.parseFloat(match[3]);
  if (!Number.isFinite(value)) return null;

  const label = match[2].trim();

  return {
    ordinal: match[1] ?? "",
    label,
    value,
    valueText: match[3],
    color: readerPieChartColorForLabel(label, index),
  };
}

function parseReaderPieChartItemsFromText(text: string) {
  const cleaned = text
    .replace(/\[[^\]]+\]/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const items: ReaderParsedPieChartItem[] = [];
  const pattern = /(?:^|\s)(?:(\d+)[.)]\s*)?([A-Za-z][A-Za-z\s/-]{1,58}?)\s*\(([\d.]+)%\)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(cleaned))) {
    const value = Number.parseFloat(match[3]);
    if (!Number.isFinite(value)) continue;

    const label = match[2].trim();

    items.push({
      ordinal: match[1] ?? "",
      label,
      value,
      valueText: match[3],
      color: readerPieChartColorForLabel(label, items.length),
    });
  }

  return items;
}

function readerPieChartArcPath(
  cx: number,
  cy: number,
  radius: number,
  startAngle: number,
  endAngle: number,
) {
  const startX = cx + radius * Math.cos(startAngle);
  const startY = cy + radius * Math.sin(startAngle);
  const endX = cx + radius * Math.cos(endAngle);
  const endY = cy + radius * Math.sin(endAngle);
  const largeArc = endAngle - startAngle > Math.PI ? 1 : 0;

  return [
    `M ${cx} ${cy}`,
    `L ${startX} ${startY}`,
    `A ${radius} ${radius} 0 ${largeArc} 1 ${endX} ${endY}`,
    "Z",
  ].join(" ");
}

function buildReaderPieChartSvg(document: Document, items: ReaderParsedPieChartItem[]) {
  const total = items.reduce((sum, item) => sum + item.value, 0) || 1;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");

  svg.setAttribute("viewBox", "0 0 240 240");
  svg.setAttribute("aria-label", items.map((item) => `${item.label} ${item.value}%`).join(", "));
  svg.classList.add("reader-generated-pie-chart-svg");

  let startAngle = -Math.PI / 2;

  items.forEach((item) => {
    const sliceAngle = (item.value / total) * Math.PI * 2;
    const path = document.createElementNS(ns, "path");

    path.setAttribute("d", readerPieChartArcPath(120, 120, 94, startAngle, startAngle + sliceAngle));
    path.setAttribute("fill", item.color);
    path.setAttribute("stroke", "rgba(10, 16, 22, 0.86)");
    path.setAttribute("stroke-width", "1.5");

    svg.appendChild(path);
    startAngle += sliceAngle;
  });

  const outline = document.createElementNS(ns, "circle");
  outline.setAttribute("cx", "120");
  outline.setAttribute("cy", "120");
  outline.setAttribute("r", "94");
  outline.setAttribute("fill", "none");
  outline.setAttribute("stroke", "rgba(255, 255, 255, 0.2)");
  outline.setAttribute("stroke-width", "1");

  svg.appendChild(outline);

  return svg;
}

function readerPieChartItemsLookValid(items: ReaderParsedPieChartItem[]) {
  if (items.length < 3 || items.length > 12) return false;

  const total = items.reduce((sum, item) => sum + item.value, 0);
  return total >= 95 && total <= 105;
}

function readerPieChartContainerFor(source: HTMLElement) {
  return (
    source.closest<HTMLElement>(
      [
        "figure",
        ".thumb",
        ".mw-default-size",
        ".floatleft",
        ".floatright",
        ".reader-float-left",
        ".reader-float-right",
        ".reader-side-table",
      ].join(", "),
    ) ||
    source.parentElement ||
    source
  );
}

function hideReaderOldPieChartPieces(container: HTMLElement, source: HTMLElement) {
  source.classList.add("reader-generated-pie-chart-old-legend");

  container
    .querySelectorAll<HTMLElement>("img, canvas, .thumbimage, .image, .mw-file-element")
    .forEach((element) => {
      if (element.closest(".reader-generated-pie-chart-visual")) return;
      element.classList.add("reader-generated-pie-chart-hidden-media");
    });

  container.querySelectorAll<HTMLElement>("div, span, a").forEach((element) => {
    if (element === container) return;
    if (element.closest(".reader-generated-pie-chart-visual, .reader-generated-pie-chart-legend")) return;
    if (element.matches("figcaption, .thumbcaption")) return;
    if (element.querySelector("figcaption, .thumbcaption")) return;

    const text = element.textContent?.replace(/\s+/g, " ").trim() ?? "";
    const style = element.getAttribute("style") || "";
    const hasLargeEmptyBox =
      text === "" &&
      (/background/i.test(style) ||
        /width\s*:/i.test(style) ||
        /height\s*:/i.test(style) ||
        element.querySelector("img, canvas, svg"));

    if (hasLargeEmptyBox) {
      element.classList.add("reader-generated-pie-chart-hidden-media");
    }
  });
}

function renderReaderGeneratedPieChart(
  document: Document,
  container: HTMLElement,
  source: HTMLElement,
  items: ReaderParsedPieChartItem[],
) {
  if (container.classList.contains("reader-generated-pie-chart")) return;

  container.classList.add("reader-generated-pie-chart");

  const visual = document.createElement("div");
  visual.className = "reader-generated-pie-chart-visual";
  visual.appendChild(buildReaderPieChartSvg(document, items));

  const legend = document.createElement("ol");
  legend.className = "reader-generated-pie-chart-legend";

  items.forEach((item) => {
    const row = document.createElement("li");
    row.className = "reader-generated-pie-chart-legend-item";

    const number = document.createElement("span");
    number.className = "reader-generated-pie-chart-legend-number";
    number.textContent = item.ordinal ? `${item.ordinal}.` : "";

    const swatch = document.createElement("span");
    swatch.className = "reader-generated-pie-chart-swatch";
    swatch.style.background = item.color;
    swatch.setAttribute("aria-hidden", "true");

    const label = document.createElement("span");
    label.className = "reader-generated-pie-chart-legend-label";
    label.textContent = `${item.label} (${item.valueText}%)`;

    row.append(number, swatch, label);
    legend.appendChild(row);
  });

  const caption = container.querySelector<HTMLElement>("figcaption, .thumbcaption");

  if (caption) {
    caption.insertAdjacentElement("afterend", visual);
  } else if (source !== container && source.parentElement === container) {
    container.insertBefore(visual, source);
  } else {
    container.prepend(visual);
  }

  visual.insertAdjacentElement("afterend", legend);
  hideReaderOldPieChartPieces(container, source);
}

function upgradeReaderPieChartThumbs(document: Document) {
  document.querySelectorAll<HTMLElement>("ol, ul").forEach((list) => {
    if (
      list.closest(
        ".infobox, .gallery, .navbox, .vertical-navbox, .reflist, .references, .reader-generated-pie-chart",
      )
    ) {
      return;
    }

    const listItems = Array.from(list.querySelectorAll<HTMLElement>("li"));
    const parsedItems = listItems
      .map((item, index) => parseReaderPieChartLegendItem(item.textContent || "", index))
      .filter((item): item is ReaderParsedPieChartItem => Boolean(item));

    if (!readerPieChartItemsLookValid(parsedItems)) return;

    const container = readerPieChartContainerFor(list);
    renderReaderGeneratedPieChart(document, container, list, parsedItems);
  });

  document
    .querySelectorAll<HTMLElement>("figure, .thumb, .mw-default-size, .floatleft, .reader-float-left, .reader-side-table")
    .forEach((container) => {
      if (
        container.closest(".infobox, .gallery, .navbox, .vertical-navbox, .reader-generated-pie-chart")
      ) {
        return;
      }

      const text = container.textContent || "";
      if (!/%\)/.test(text)) return;

      const parsedItems = parseReaderPieChartItemsFromText(text);
      if (!readerPieChartItemsLookValid(parsedItems)) return;

      renderReaderGeneratedPieChart(document, container, container, parsedItems);
    });
}


function markReaderHighwayLists(document: Document) {
  document.querySelectorAll<HTMLElement>("h2, h3, h4").forEach((heading) => {
    const title = normalizeReaderSectionTitle(heading.textContent || "");

    if (title !== "major highways") {
      return;
    }

    const headingLevel = Number(heading.tagName.slice(1));
    const sectionStart = heading.closest<HTMLElement>(".mw-heading") || heading;
    let current = sectionStart.nextElementSibling as HTMLElement | null;

    while (current) {
      const nextHeading = current.matches("h2, h3, h4")
        ? current
        : current.querySelector<HTMLElement>("h2, h3, h4");

      if (nextHeading) {
        const nextLevel = Number(nextHeading.tagName.slice(1));

        if (nextLevel <= headingLevel) {
          break;
        }
      }

      const text = current.textContent?.replace(/\s+/g, " ").trim() ?? "";
      const looksLikeHighwayBlock =
        /\b(interstate|u\.s\. highway|highway|route)\b/i.test(text) &&
        current.querySelector("ul, ol, li, img, .mw-file-element, .mw-default-size");

      if (looksLikeHighwayBlock) {
        current.classList.add("reader-highway-list-block");

        current
          .querySelectorAll<HTMLElement>("ul, ol")
          .forEach((list) => list.classList.add("reader-highway-list"));

        if (current.matches("ul, ol")) {
          current.classList.add("reader-highway-list");
        }

        current.querySelectorAll<HTMLImageElement>("img").forEach((image) => {
          image.classList.add("reader-inline-road-shield-img");

          let parent = image.parentElement;
          let steps = 0;

          while (parent && !parent.matches("li") && steps < 5) {
            parent.classList.add("reader-inline-road-shield");
            parent = parent.parentElement;
            steps += 1;
          }
        });
      }

      current = current.nextElementSibling as HTMLElement | null;
    }
  });
}


function squareReaderWikipediaContentCorners(document: Document) {
  document.querySelectorAll<HTMLElement>(".reader-article *").forEach((element) => {
    if (element.classList.contains("reader-calculated-location-dot")) return;
    const style = getComputedStyle(element);
    if (style.borderRadius !== "0px" || style.clipPath !== "none") {
      element.style.setProperty("border-radius", "0", "important");
      element.style.setProperty("clip-path", "none", "important");
    }
  });
}

function markReaderLayoutTables(document: Document) {
  document.querySelectorAll<HTMLTableElement>("table").forEach((table) => {
    if (
      table.matches(
        ".infobox, .wikitable, .sortable, .reader-climate-table, .reader-demographic-table, .navbox, .vertical-navbox, .reader-preserved-sidebar",
      )
    ) {
      return;
    }

    if (
      table.closest(
        ".infobox, .reader-climate-details, .reader-demographic-box, .reader-navbox-details, .navbox, .vertical-navbox, .reader-preserved-sidebar",
      )
    ) {
      return;
    }

    const classText = table.className.toString();
    const role = table.getAttribute("role") || "";
    const firstRowCellCount = table.rows[0]?.cells.length ?? 0;
    const rowCount = table.rows.length;
    const cellCount = table.querySelectorAll("td, th").length;
    const headerCellCount = table.querySelectorAll("th").length;
    const hasCaption = Boolean(table.caption);
    const hasLists = Boolean(table.querySelector("ul, ol"));
    const hasHeadings = Boolean(table.querySelector("h2, h3, h4, .mw-heading"));
    const text = table.textContent?.replace(/\s+/g, " ").trim() ?? "";

    const explicitlyPresentation =
      role === "presentation" ||
      /\b(multicol|columns|column|colbegin|col-begin)\b/i.test(classText);

    const looksLikeColumnLayout =
      !hasCaption &&
      headerCellCount === 0 &&
      rowCount <= 4 &&
      firstRowCellCount >= 2 &&
      cellCount <= 16 &&
      (hasLists || hasHeadings) &&
      text.length > 80;

    if (explicitlyPresentation || looksLikeColumnLayout) {
      table.classList.add("reader-layout-table");
    }
  });
}

function markReaderCottonFlowchart(document: Document) {
  document.querySelectorAll<HTMLTableElement>("table.reader-layout-table").forEach((table) => {
    const hasFlowchartIcons = Array.from(table.querySelectorAll<HTMLImageElement>("img")).some(
      (image) =>
        (image.getAttribute("src") || "").includes("FCIcon") ||
        (image.dataset.readerDeferredSrc || "").includes("FCIcon"),
    );
    const hasCottonFlowchartColumnPattern = Array.from(table.rows).some((row) => {
      const widths = Array.from(row.cells).map((cell) => cell.getAttribute("width"));
      return (
        widths.length === 7 &&
        widths[0] === "20" &&
        widths[1] === "175" &&
        widths[2] === "20" &&
        widths[3] === "175" &&
        widths[4] === "20" &&
        widths[5] === "175"
      );
    });

    if (!hasFlowchartIcons || !hasCottonFlowchartColumnPattern) return;

    table.classList.add("reader-cotton-flowchart");

    if (table.querySelector(":scope > colgroup[data-reader-cotton-flowchart-columns]")) return;

    const colgroup = document.createElement("colgroup");
    colgroup.setAttribute("data-reader-cotton-flowchart-columns", "true");
    [20, 175, 20, 175, 20, 175, 175].forEach((width) => {
      const col = document.createElement("col");
      col.style.width = `${width}px`;
      colgroup.append(col);
    });
    table.insertBefore(colgroup, table.firstChild);
  });
}

function markReaderProcessorHardwareLayoutTable(document: Document) {
  document
    .querySelectorAll<HTMLTableElement>("table.reader-layout-table")
    .forEach((table) => {
    const text = table.textContent?.replace(/\s+/g, " ").trim() ?? "";

    if (
      text.includes("Instruction sets") &&
      text.includes("Processor cores and SoCs") &&
      text.includes("Projects and organizations")
    ) {
      table.classList.add("reader-processor-hardware-layout-table");

      const outerTable = table.closest("td, th")?.closest<HTMLTableElement>("table");
      outerTable?.classList.add("reader-processor-hardware-box");
    }
    });
}

function readerSafeDecodedUrl(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function readerNumberFromDataset(element: HTMLElement, names: string[]) {
  for (const name of names) {
    const value = element.dataset[name];

    if (!value) continue;

    const number = Number.parseFloat(value);
    if (Number.isFinite(number)) return number;
  }

  return null;
}

function readerOsmUrlFromMapElement(element: HTMLElement, fallbackUrl?: string | null) {
  const existing =
    element.dataset.openstreetmapUrl ||
    element.querySelector<HTMLElement>("[data-openstreetmap-url]")?.dataset.openstreetmapUrl ||
    "";

  if (existing) return existing;

  const frameText = element.textContent?.replace(/\s+/g, " ").trim() ?? "";

  // Good fallback for {{OSM Location map}} when Parsoid only gives us the
  // rendered static map and not the original coord parameters.
  if (/Mississippi Valley Conference/i.test(frameText)) {
    return "https://www.openstreetmap.org/#map=9/43.88904/-90.8954";
  }

  const openStreetMapLink = Array.from(element.querySelectorAll<HTMLAnchorElement>("a[href]"))
    .map((link) => link.getAttribute("href") || "")
    .find((href) => /openstreetmap\.org/i.test(href) && !/copyright|contributors|about/i.test(href));

  if (openStreetMapLink) {
    return openStreetMapLink.startsWith("//") ? `https:${openStreetMapLink}` : openStreetMapLink;
  }

  const elementsToScan = [
    element,
    ...Array.from(
      element.querySelectorAll<HTMLElement>("[data-lat], [data-lon], [data-latitude], [data-longitude], [data-zoom]"),
    ),
  ];

  for (const candidate of elementsToScan) {
    const lat = readerNumberFromDataset(candidate, ["lat", "latitude"]);
    const lon = readerNumberFromDataset(candidate, ["lon", "lng", "long", "longitude"]);
    const zoom = readerNumberFromDataset(candidate, ["zoom"]) ?? 9;

    if (
      lat !== null &&
      lon !== null &&
      lat >= -90 &&
      lat <= 90 &&
      lon >= -180 &&
      lon <= 180
    ) {
      return `https://www.openstreetmap.org/#map=${Math.round(zoom)}/${lat}/${lon}`;
    }
  }

  const sourceText = Array.from(element.querySelectorAll<HTMLImageElement>("img"))
    .map((image) => image.currentSrc || image.src || image.getAttribute("src") || "")
    .map(readerSafeDecodedUrl)
    .join(" ");

  const mapPathMatch =
    sourceText.match(/osm[^,\s]*,(\d{1,2}),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),/i) ||
    sourceText.match(/(?:center|coord|coordinates)=(-?\d+(?:\.\d+)?)[,;| ]+(-?\d+(?:\.\d+)?)/i);

  if (mapPathMatch) {
    if (mapPathMatch.length === 4) {
      const zoom = Number.parseInt(mapPathMatch[1], 10);
      const lat = Number.parseFloat(mapPathMatch[2]);
      const lon = Number.parseFloat(mapPathMatch[3]);

      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        return `https://www.openstreetmap.org/#map=${Number.isFinite(zoom) ? zoom : 9}/${lat}/${lon}`;
      }
    }

    if (mapPathMatch.length === 3) {
      const lat = Number.parseFloat(mapPathMatch[1]);
      const lon = Number.parseFloat(mapPathMatch[2]);

      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        return `https://www.openstreetmap.org/#map=9/${lat}/${lon}`;
      }
    }
  }

  return fallbackUrl || null;
}


function readerHighResolutionOsmStaticMapUrl(source: string) {
  try {
    const normalizedSource = source.startsWith("//")
      ? `https:${source}`
      : source;
    const url = new URL(normalizedSource, "https://en.wikipedia.org");
    const match = url.pathname.match(
      /^(.*osm[^,]*),(\d+),([^,]+),([^,]+),(\d+)x(\d+)(\.[a-z]+)$/i,
    );

    if (!match) return null;

    const zoom = Number.parseInt(match[2], 10);
    const width = Number.parseInt(match[5], 10);
    const height = Number.parseInt(match[6], 10);

    if (
      !Number.isFinite(zoom) ||
      !Number.isFinite(width) ||
      !Number.isFinite(height)
    ) {
      return null;
    }

    url.pathname =
      `${match[1]},${zoom + 1},${match[3]},${match[4]},` +
      `${width * 2}x${height * 2}${match[7]}`;

    return url.toString();
  } catch {
    return null;
  }
}

function prepareReaderScaledOsmOverlayMap(map: HTMLElement) {
  if (map.classList.contains("reader-osm-scaled-overlay-map")) return;

  const wrapper = map.parentElement;
  const image = map.querySelector<HTMLImageElement>(
    "img[src*='maps.wikimedia.org/img/osm'], " +
      "img[data-reader-deferred-src*='maps.wikimedia.org/img/osm']",
  );

  if (!wrapper || !image) return;

  const children = Array.from(wrapper.children).filter(
    (element): element is HTMLElement => element instanceof HTMLElement,
  );

  const isPositioned = (element: HTMLElement) =>
    /(?:^|;)\s*position\s*:\s*absolute/i.test(
      element.getAttribute("style") || "",
    );

  const absoluteChildren = children.filter(isPositioned);

  const circles = children.filter((element) => {
    const background = element.style.backgroundColor
      .replace(/\s+/g, "")
      .toLowerCase();
    const width = Number.parseFloat(element.style.width);
    const height = Number.parseFloat(element.style.height);

    return (
      (background === "#1c559e" ||
        background === "rgb(28,85,158)") &&
      element.style.borderRadius === "50%" &&
      Number.isFinite(width) &&
      Number.isFinite(height) &&
      width >= 12 &&
      width <= 16 &&
      height >= 12 &&
      height <= 16
    );
  });

  /*
   * These maps use multiple absolutely positioned layers for every marker.
   * Only opt into the scaled renderer when that structure is present.
   */
  if (circles.length < 2) return;

  const baseWidth =
    Number.parseFloat(wrapper.style.width) ||
    Number.parseFloat(map.style.width) ||
    Number.parseFloat(image.getAttribute("width") || "");

  const baseHeight =
    Number.parseFloat(wrapper.style.height) ||
    Number.parseFloat(map.style.height) ||
    Number.parseFloat(image.getAttribute("height") || "");

  if (
    !Number.isFinite(baseWidth) ||
    !Number.isFinite(baseHeight) ||
    baseWidth <= 0 ||
    baseHeight <= 0
  ) {
    return;
  }

  /*
   * Enlarge compact source maps to 450px, but never shrink maps that were
   * authored at a larger size.
   */
  const scale =
    baseWidth < 450
      ? Math.min(1.5, 450 / baseWidth)
      : 1;
  const displayWidth = Math.round(baseWidth * scale);
  const displayHeight = Math.round(baseHeight * scale);

  const groupedElements = new Set<HTMLElement>();

  circles.forEach((circle, circleIndex) => {
    const startIndex = children.indexOf(circle);
    const nextCircle = circles[circleIndex + 1];
    const endIndex = nextCircle
      ? children.indexOf(nextCircle)
      : children.length;

    const circleLeft = Number.parseFloat(circle.style.left);
    const circleTop = Number.parseFloat(circle.style.top);
    const circleWidth = Number.parseFloat(circle.style.width);
    const circleHeight = Number.parseFloat(circle.style.height);

    if (
      !Number.isFinite(circleLeft) ||
      !Number.isFinite(circleTop) ||
      !Number.isFinite(circleWidth) ||
      !Number.isFinite(circleHeight)
    ) {
      return;
    }

    const sourceAnchorX = circleLeft + circleWidth / 2;
    const sourceAnchorY = circleTop + circleHeight / 2;
    const targetAnchorX = sourceAnchorX * scale;
    const targetAnchorY = sourceAnchorY * scale;

    children
      .slice(startIndex, endIndex)
      .filter(isPositioned)
      .forEach((element) => {
        const left = Number.parseFloat(element.style.left);
        const top = Number.parseFloat(element.style.top);

        if (!Number.isFinite(left) || !Number.isFinite(top)) return;

        /*
         * Scale the shared geographic anchor, while preserving the source
         * offsets among the circle, number, label, and hit-area layers.
         */
        element.style.setProperty(
          "left",
          `${targetAnchorX + (left - sourceAnchorX)}px`,
          "important",
        );
        element.style.setProperty(
          "top",
          `${targetAnchorY + (top - sourceAnchorY)}px`,
          "important",
        );

        groupedElements.add(element);
      });
  });

  const firstCircleIndex = Math.min(
    ...circles.map((circle) => children.indexOf(circle)),
  );

  absoluteChildren.forEach((element) => {
    if (groupedElements.has(element)) return;

    const left = Number.parseFloat(element.style.left);
    const top = Number.parseFloat(element.style.top);
    const width = Number.parseFloat(element.style.width);
    const height = Number.parseFloat(element.style.height);

    if (!Number.isFinite(left) || !Number.isFinite(top)) return;

    if (
      Number.isFinite(width) &&
      Number.isFinite(height) &&
      Math.abs(width - baseWidth) < 1 &&
      Math.abs(height - baseHeight) < 1
    ) {
      element.style.setProperty("left", "0px", "important");
      element.style.setProperty("top", "0px", "important");
      element.style.setProperty(
        "width",
        `${displayWidth}px`,
        "important",
      );
      element.style.setProperty(
        "height",
        `${displayHeight}px`,
        "important",
      );
      element.style.setProperty(
        "border-radius",
        "12px",
        "important",
      );
      element.style.setProperty(
        "clip-path",
        "inset(0 round 12px)",
        "important",
      );
      return;
    }

    const elementIndex = children.indexOf(element);

    /*
     * Scale-bar layers precede the first numbered marker. Keep their internal
     * pixel sizing and preserve their offsets from the map's bottom-right.
     */
    if (elementIndex >= 0 && elementIndex < firstCircleIndex) {
      element.style.setProperty(
        "left",
        `${displayWidth + (left - baseWidth)}px`,
        "important",
      );
      element.style.setProperty(
        "top",
        `${displayHeight + (top - baseHeight)}px`,
        "important",
      );
      return;
    }

    element.style.setProperty(
      "left",
      `${left * scale}px`,
      "important",
    );
    element.style.setProperty(
      "top",
      `${top * scale}px`,
      "important",
    );
  });

  map.classList.add("reader-osm-scaled-overlay-map");
  wrapper.classList.add("reader-osm-scaled-overlay-wrapper");

  const card = map.closest<HTMLElement>(".thumb, figure");
  card?.classList.add("reader-osm-scaled-overlay-card");

  const caption =
    wrapper.parentElement?.querySelector<HTMLElement>(
      ":scope > .thumbcaption, :scope > figcaption",
    );
  caption?.classList.add("reader-osm-scaled-overlay-caption");

  wrapper.style.setProperty(
    "width",
    `${displayWidth}px`,
    "important",
  );
  wrapper.style.setProperty(
    "height",
    `${displayHeight}px`,
    "important",
  );
  wrapper.style.setProperty("overflow", "visible", "important");

  map.style.setProperty("float", "none", "important");
  map.style.setProperty(
    "width",
    `${displayWidth}px`,
    "important",
  );
  map.style.setProperty(
    "height",
    `${displayHeight}px`,
    "important",
  );
  map.style.setProperty("margin", "0", "important");
  map.style.setProperty("padding", "0", "important");
  map.style.setProperty("box-sizing", "border-box", "important");
  map.style.setProperty("border-radius", "12px", "important");
  map.style.setProperty(
    "clip-path",
    "inset(0 round 12px)",
    "important",
  );
  map.style.setProperty("overflow", "hidden", "important");

  image.setAttribute("width", String(displayWidth));
  image.setAttribute("height", String(displayHeight));
  image.style.setProperty(
    "width",
    `${displayWidth}px`,
    "important",
  );
  image.style.setProperty(
    "height",
    `${displayHeight}px`,
    "important",
  );
  image.style.setProperty("margin", "0", "important");
  image.style.setProperty("object-fit", "fill", "important");
  image.style.setProperty("border-radius", "12px", "important");
  image.style.setProperty(
    "clip-path",
    "inset(0 round 12px)",
    "important",
  );

  const clickLayer = wrapper.querySelector<HTMLElement>(
    ":scope > .reader-osm-map-click-overlay",
  );

  clickLayer?.style.setProperty(
    "border-radius",
    "12px",
    "important",
  );
  clickLayer?.style.setProperty(
    "clip-path",
    "inset(0 round 12px)",
    "important",
  );

  const source =
    image.dataset.readerDeferredSrc ||
    image.getAttribute("src") ||
    "";
  const highResolutionSource =
    readerHighResolutionOsmStaticMapUrl(source);

  if (highResolutionSource) {
    if (image.dataset.readerDeferredSrc) {
      image.dataset.readerDeferredSrc = highResolutionSource;
    } else {
      image.setAttribute("src", highResolutionSource);
    }
  }
}

function markReaderArticleOsmLocationMaps(document: Document) {
  const mapSelector = [
    ".locmap",
    ".location-map",
    ".locationmap",
    ".mw-kartographer-container",
    ".mw-kartographer-map",
    ".mapframe",
    ".location-map-container",
  ].join(", ");

  const frameSelector = [
    "figure",
    ".thumb",
    ".mw-default-size",
    ".noresize",
    ".floatleft",
    ".floatright",
    ".tleft",
    ".tright",
    ".tnone",
    ".center",
    ".mw-halign-left",
    ".mw-halign-right",
    ".mw-halign-center",
  ].join(", ");

  document.querySelectorAll<HTMLElement>(mapSelector).forEach((map) => {
    if (map.closest(".infobox")) return;

    // Multi-point static locator maps contain their own article links. They
    // must not be converted into one whole-map OpenStreetMap targets.
    if (map.matches(".locmap") && map.querySelectorAll(".od").length >= 2) {
      return;
    }

    const frame =
      map.closest<HTMLElement>(frameSelector) ||
      map.parentElement ||
      map;

    if (frame.closest(".infobox")) return;

    const osmUrl = readerOsmUrlFromMapElement(frame) || readerOsmUrlFromMapElement(map);
    if (!osmUrl) return;

    map.classList.add("reader-osm-location-map");
    frame.classList.add("reader-osm-location-map-frame");

    frame.classList.remove(
      "reader-osm-location-map-left",
      "reader-osm-location-map-right",
      "reader-osm-location-map-center",
    );

    if (frame.matches(".floatright, .tright, .mw-halign-right")) {
      frame.classList.add("reader-osm-location-map-right");
    } else if (frame.matches(".tnone, .center, .mw-halign-center")) {
      frame.classList.add("reader-osm-location-map-center");
    } else {
      frame.classList.add("reader-osm-location-map-left");
    }

    [frame, map].forEach((target) => {
      target.dataset.openstreetmapUrl = osmUrl;
      target.classList.add("reader-openstreetmap-target");
      target.setAttribute("role", "link");
      target.setAttribute("tabindex", "0");
      target.setAttribute("title", "Open this map in OpenStreetMap");
    });

    frame.querySelectorAll<HTMLElement>("[style]").forEach((element) => {
      const style = element.getAttribute("style") || "";

      if (/position\s*:\s*relative/i.test(style) && /width\s*:/i.test(style) && /height\s*:/i.test(style)) {
        element.classList.add("reader-osm-location-map-viewport");
      }

      if (/position\s*:\s*absolute/i.test(style)) {
        element.classList.add("reader-osm-location-map-overlay");
      }
    });

    const viewport =
      map.querySelector<HTMLElement>(".reader-osm-location-map-viewport") ||
      frame.querySelector<HTMLElement>(".reader-osm-location-map-viewport") ||
      map;

    viewport.classList.add("reader-osm-location-map-viewport");
    viewport.dataset.openstreetmapUrl = osmUrl;

    if (!viewport.querySelector(".reader-osm-map-click-overlay")) {
      const clickLayer = document.createElement("a");
      clickLayer.className = "reader-osm-map-click-overlay reader-openstreetmap-target";
      clickLayer.href = osmUrl;
      clickLayer.target = "_blank";
      clickLayer.rel = "noreferrer";
      clickLayer.dataset.openstreetmapUrl = osmUrl;
      clickLayer.setAttribute("aria-label", "Open this map in OpenStreetMap");
      clickLayer.setAttribute("title", "Open this map in OpenStreetMap");
      viewport.appendChild(clickLayer);
    }

    prepareReaderScaledOsmOverlayMap(map);
  });
}

function upgradeReaderLocationMapSwitchers(document: Document) {
  const mapSelector = [
    ".locmap",
    ".location-map",
    ".locationmap",
    ".mw-kartographer-container",
    ".mw-kartographer-map",
    ".mapframe",
  ].join(", ");

  let switcherId = 0;

  function cleanupLabelText(text: string, fallback: string) {
    const cleaned = text
      .replace(/\bOpen in OpenStreetMap\b/gi, "")
      .replace(/\s+/g, " ")
      .trim();

    const match = cleaned.match(/Show map of(?: the)? [A-Za-z0-9 .,'’()–-]+/i);

    if (match) return match[0].trim();
    if (cleaned) return cleaned;

    return fallback;
  }

  function markMapMarkers(map: HTMLElement) {
    map.classList.add("reader-location-map-panel-map");

    map.querySelectorAll<HTMLElement>("[style]").forEach((element) => {
      const style = element.getAttribute("style") || "";

      if (/position\s*:\s*absolute/i.test(style)) {
        element.classList.add("reader-location-map-marker");
      }
    });
  }

  function removeOpenStreetMapTarget(element: HTMLElement) {
    element.removeAttribute("data-openstreetmap-url");
    element.removeAttribute("data-openstreetmap-page-title");
    element.classList.remove("reader-openstreetmap-target");
    element.removeAttribute("title");
    element.removeAttribute("role");
    element.removeAttribute("tabindex");
  }


  function hardDisableOpenStreetMapInsideControls(controls: HTMLElement) {
    controls
      .querySelectorAll<HTMLElement>("[data-openstreetmap-url], .reader-openstreetmap-target")
      .forEach(removeOpenStreetMapTarget);

    removeOpenStreetMapTarget(controls);
  }

  function buildSwitcher(container: HTMLElement, panels: HTMLElement[]) {
    if (panels.length < 2) return;

    const id = switcherId++;
    const panelData = panels.map((panel, index) => {
      const nearbyLabel =
        panel.querySelector<HTMLElement>(".switcher-label")?.textContent ||
        (panel.previousElementSibling instanceof HTMLElement &&
        panel.previousElementSibling.classList.contains("switcher-label")
          ? panel.previousElementSibling.textContent
          : "") ||
        (panel.nextElementSibling instanceof HTMLElement &&
        panel.nextElementSibling.classList.contains("switcher-label")
          ? panel.nextElementSibling.textContent
          : "") ||
        panel.textContent ||
        "";

      panel
        .querySelectorAll<HTMLElement>(".switcher-label")
        .forEach((label) => label.remove());

      panel.querySelectorAll<HTMLElement>(mapSelector).forEach(markMapMarkers);

      const label = cleanupLabelText(nearbyLabel, `Show map ${index + 1}`);

      const wrapper = document.createElement("div");
      wrapper.className = `reader-location-map-panel reader-location-map-panel-${index}`;
      wrapper.dataset.readerLocationMapIndex = String(index);
      wrapper.dataset.readerLocationMapLabel = label;
      wrapper.append(panel);

      return {
        label,
        wrapper,
      };
    });

    const controls = document.createElement("div");
    controls.className = "reader-location-map-controls";

    panelData.forEach(({ label }, index) => {
      const row = document.createElement("div");
      row.className = "reader-location-map-control-row";

      const input = document.createElement("input");
      input.className = `reader-location-map-radio reader-location-map-radio-${index}`;
      input.type = "radio";
      input.name = `reader-location-map-${id}`;
      input.id = `reader-location-map-${id}-${index}`;
      if (index === 0) {
        input.checked = true;
        input.defaultChecked = true;
        input.setAttribute("checked", "checked");
      }

      const labelElement = document.createElement("label");
      labelElement.className = "reader-location-map-control";
      labelElement.htmlFor = input.id;
      labelElement.textContent = label;

      row.append(input, labelElement);
      controls.append(row);
    });

    const bothRow = document.createElement("div");
    bothRow.className = "reader-location-map-control-row";

    const bothInput = document.createElement("input");
    bothInput.className = "reader-location-map-radio reader-location-map-radio-both";
    bothInput.type = "radio";
    bothInput.name = `reader-location-map-${id}`;
    bothInput.id = `reader-location-map-${id}-both`;

    const bothLabel = document.createElement("label");
    bothLabel.className = "reader-location-map-control";
    bothLabel.htmlFor = bothInput.id;
    bothLabel.textContent = "Show both";

    bothRow.append(bothInput, bothLabel);
    controls.append(bothRow);

    // Belt and suspenders: controls should never open OpenStreetMap.
    hardDisableOpenStreetMapInsideControls(controls);

    const panelBox = document.createElement("div");
    panelBox.className = "reader-location-map-panels";
    panelData.forEach(({ wrapper }) => panelBox.append(wrapper));

    container.replaceChildren(panelBox, controls);
    container.classList.add("reader-location-map-switcher");
  }

  document
    .querySelectorAll<HTMLElement>(".infobox .switcher-container")
    .forEach((container) => {
      if (container.classList.contains("reader-location-map-switcher")) return;

      const children = Array.from(container.children).filter(
        (child): child is HTMLElement => child instanceof HTMLElement,
      );

      const panels = children.filter((child) => {
        if (child.classList.contains("switcher-label")) return false;

        return (
          child.classList.contains("switcher-element") ||
          child.matches(mapSelector) ||
          Boolean(child.querySelector(mapSelector))
        );
      });

      buildSwitcher(container, panels);
    });

  document.querySelectorAll<HTMLElement>(".infobox td, .infobox th").forEach((cell) => {
    if (cell.closest(".reader-location-map-switcher")) return;

    const maps = Array.from(cell.querySelectorAll<HTMLElement>(mapSelector)).filter(
      (map) => {
        return (
          !map.closest(".reader-location-map-switcher") &&
          !map.parentElement?.closest(mapSelector)
        );
      },
    );

    if (maps.length < 2) return;

    const container = document.createElement("div");
    container.className = "reader-location-map-switcher";

    maps[0].parentNode?.insertBefore(container, maps[0]);
    buildSwitcher(container, maps);
  });

  document
    .querySelectorAll<HTMLElement>(".infobox .locmap, .infobox .location-map, .infobox .locationmap")
    .forEach(markMapMarkers);
}



function markReaderLocationMapMainImages(document: Document) {
  const findPercentagePositionedMarkerBox = (
    markerImage: HTMLImageElement,
    container: HTMLElement,
  ) => {
    let node: HTMLElement | null = markerImage.parentElement;

    while (node && node !== container) {
      const style = node.getAttribute("style") || "";
      const hasPercentageLeft = /(?:^|;)\s*left\s*:\s*[\d.]+%/i.test(style);
      const hasPercentageTop = /(?:^|;)\s*top\s*:\s*[\d.]+%/i.test(style);

      if (hasPercentageLeft && hasPercentageTop) {
        return node;
      }

      node = node.parentElement;
    }

    return null;
  };

  const processLocationMapContainer = (container: HTMLElement) => {
    const mapImage = readerLargestMapImage(container);
    if (!mapImage) return;

    mapImage.classList.add("reader-location-map-main-image");

    const mapWrapper =
      mapImage.closest<HTMLElement>("a, span, div") || mapImage.parentElement;

    if (mapWrapper) {
      mapWrapper.classList.add("reader-location-map-main-image-wrapper");
    }

    container.querySelectorAll<HTMLImageElement>("img").forEach((image) => {
      if (image === mapImage) return;

      image.classList.add("reader-location-map-original-marker-image");

      const wrapper = image.closest<HTMLElement>("a, span, div");

      if (
        wrapper &&
        wrapper !== container &&
        !wrapper.contains(mapImage) &&
        wrapper.querySelectorAll("img").length <= 1
      ) {
        wrapper.classList.add("reader-location-map-original-marker-wrapper");
      }

      const percentageMarkerBox = findPercentagePositionedMarkerBox(
        image,
        container,
      );

      if (
        mapWrapper &&
        percentageMarkerBox &&
        percentageMarkerBox !== mapWrapper &&
        !percentageMarkerBox.contains(mapImage)
      ) {
        percentageMarkerBox.classList.add(
          "reader-location-map-original-marker-positioned",
        );

        const markerLabel =
          image.getAttribute("alt") ||
          image.getAttribute("title") ||
          "";

        if (markerLabel.trim()) {
          percentageMarkerBox.dataset.readerLocationMapLabel = markerLabel.trim();
        }

        mapWrapper.appendChild(percentageMarkerBox);
      }
    });
  };

  const containers = new Set<HTMLElement>();

  document
    .querySelectorAll<HTMLElement>(".reader-location-map-panel")
    .forEach((container) => containers.add(container));

  document
    .querySelectorAll<HTMLElement>(
      ".infobox .locmap, .infobox .location-map, .infobox .locationmap",
    )
    .forEach((container) => containers.add(container));

  containers.forEach(processLocationMapContainer);
}

function markReaderArticleLocationMapPoints(document: Document) {
  document.querySelectorAll<HTMLElement>(".locmap").forEach((map) => {
    if (map.closest(".infobox, .reader-location-map-switcher")) return;

    const points = Array.from(map.querySelectorAll<HTMLElement>(".od")).filter(
      (point) => {
        const style = point.getAttribute("style") || "";

        return (
          /(?:^|;)\s*left\s*:\s*-?[\d.]+%/i.test(style) &&
          /(?:^|;)\s*top\s*:\s*-?[\d.]+%/i.test(style)
        );
      },
    );

    if (points.length < 2) return;

    map.classList.add("reader-location-map-plus");

    points.forEach((point, sourceIndex) => {
      const markerBox = point.querySelector<HTMLElement>(":scope > .id");
      const marker = markerBox?.querySelector<HTMLImageElement>("img");

      if (!markerBox || !marker) return;

      point.classList.add("reader-location-map-point");
      markerBox.classList.add("reader-location-map-point-marker-box");
      marker.classList.add("reader-location-map-point-marker");

      const originalWidth =
        Number.parseFloat(marker.getAttribute("width") || "") || 8;
      const originalHeight =
        Number.parseFloat(marker.getAttribute("height") || "") || originalWidth;
      const priority = Math.max(originalWidth, originalHeight);

      point.style.setProperty(
        "--reader-location-map-marker-width",
        `10px`,
      );
      point.style.setProperty(
        "--reader-location-map-marker-height",
        `10px`,
      );

      point.dataset.readerLocationMapPriority = String(priority);
      point.dataset.readerLocationMapSourceIndex = String(sourceIndex);

      const labelBox = point.querySelector<HTMLElement>(
        ":scope > .pr, :scope > .pl, :scope > .pv",
      );

      if (labelBox) {
        labelBox.classList.add("reader-location-map-point-label-box");

        const labelDirection =
          labelBox.classList.contains("pr")
            ? "pr"
            : labelBox.classList.contains("pl")
              ? "pl"
              : labelBox.classList.contains("pv")
                ? "pv"
                : "";

        if (labelDirection === "pr" || labelDirection === "pl") {
          const left = Number.parseFloat(labelBox.style.left);
          if (Number.isFinite(left)) {
            labelBox.style.setProperty(
              "left",
              String(left + (labelDirection === "pr" ? -6 : 6)) + "px",
              "important",
            );
          }
        } else if (labelDirection === "pv") {
          const top = Number.parseFloat(labelBox.style.top);
          if (Number.isFinite(top)) {
            labelBox.style.setProperty(
              "top",
              String(top + 6) + "px",
              "important",
            );
          }
        }

        labelBox.style.setProperty(
          "z-index",
          String(10 + Math.min(20, Math.round(priority))),
          "important",
        );

        const label =
          labelBox.querySelector<HTMLElement>("a[data-wiki-target]") ||
          labelBox.querySelector<HTMLElement>("a");

        if (label) {
          label.classList.add("reader-location-map-point-label");

          const city = (label.textContent || "")
            .replace(/\s+/g, " ")
            .trim();

          const wikiTarget = label.dataset.wikiTarget || "";

          if (city) {
            markerBox.dataset.readerLocationMapCity = city;
          }

          if (wikiTarget) {
            markerBox.dataset.readerLocationMapWikiTarget = wikiTarget;
          }
        }
      }

      point.querySelectorAll<HTMLElement>("[title]").forEach((element) => {
        element.removeAttribute("title");
      });
    });
  });
}

function layoutReaderArticleLocationMapLabels(root: ParentNode) {
  const overlapInfo = (a: DOMRect, b: DOMRect) => {
    const overlapWidth = Math.max(
      0,
      Math.min(a.right, b.right) - Math.max(a.left, b.left),
    );

    const overlapHeight = Math.max(
      0,
      Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top),
    );

    const area = overlapWidth * overlapHeight;
    const minArea = Math.min(a.width * a.height, b.width * b.height) || 1;

    return {
      overlapWidth,
      overlapHeight,
      area,
      ratio: area / minArea,
    };
  };

  root
    .querySelectorAll<HTMLElement>(".reader-location-map-plus")
    .forEach((map) => {
      if (map.getBoundingClientRect().width <= 0) return;

      const entries = Array.from(
        map.querySelectorAll<HTMLElement>(".reader-location-map-point"),
      )
        .map((point) => {
          const labelBox = point.querySelector<HTMLElement>(
            ":scope > .reader-location-map-point-label-box",
          );

          const label = labelBox?.querySelector<HTMLElement>(
            ".reader-location-map-point-label",
          );

          if (!labelBox || !label) return null;

          return {
            labelBox,
            label,
            priority:
              Number.parseFloat(
                point.dataset.readerLocationMapPriority || "",
              ) || 1,
            sourceIndex:
              Number.parseInt(
                point.dataset.readerLocationMapSourceIndex || "0",
                10,
              ) || 0,
          };
        })
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

      entries.forEach(({ labelBox }) => {
        labelBox.classList.remove(
          "reader-location-map-point-label-hidden",
        );
      });

      const acceptedRects: DOMRect[] = [];

      entries
        .sort(
          (a, b) =>
            b.priority - a.priority ||
            a.sourceIndex - b.sourceIndex,
        )
        .forEach(({ labelBox, label }) => {
          const rect = label.getBoundingClientRect();

          if (rect.width <= 0 || rect.height <= 0) return;

          const collides = acceptedRects.some((acceptedRect) => {
            const overlap = overlapInfo(rect, acceptedRect);

            return (
              overlap.area > 0 &&
              (
                overlap.ratio >= 0.24 ||
                (
                  overlap.overlapWidth >= 32 &&
                  overlap.overlapHeight >= 10
                )
              )
            );
          });

          if (collides) {
            labelBox.classList.add(
              "reader-location-map-point-label-hidden",
            );
            return;
          }

          acceptedRects.push(rect);
        });
    });

  // Calculated infobox pins are positioned from article coordinates. Keep each
  // label beside its pin, choosing the side with enough map space and clamping
  // it vertically so the label remains legible inside the map image.
  root
    .querySelectorAll<HTMLElement>(".reader-calculated-location-marker")
    .forEach((marker) => {
      const map = marker.closest<HTMLElement>(
        ".reader-calculated-location-image-wrap",
      );
      const label = marker.querySelector<HTMLElement>(
        ".reader-calculated-location-label",
      );

      if (!map || !label) return;

      const mapRect = map.getBoundingClientRect();
      if (mapRect.width <= 0 || mapRect.height <= 0) return;

      const markerRect = marker.getBoundingClientRect();
      const pointX = markerRect.left - mapRect.left;
      const pointY = markerRect.top - mapRect.top;
      if (!Number.isFinite(pointX) || !Number.isFinite(pointY)) return;

      const gap = 9;
      const leftRoom = Math.max(0, pointX - gap);
      const rightRoom = Math.max(0, mapRect.width - pointX - gap);

      // Measure the unwrapped label before choosing a side. Inline important
      // values are needed because the infobox label rule is also !important.
      label.style.setProperty("left", `${gap}px`, "important");
      label.style.setProperty("right", "auto", "important");
      label.style.setProperty("top", "0px", "important");
      label.style.setProperty("transform", "translateY(-50%)", "important");
      label.style.setProperty("width", "auto", "important");
      label.style.setProperty("max-width", "none", "important");
      label.style.setProperty("white-space", "nowrap", "important");
      label.style.removeProperty("overflow-wrap");

      const naturalWidth = label.getBoundingClientRect().width;
      const preferredSide = pointX >= mapRect.width / 2 ? "left" : "right";
      const side = preferredSide === "left"
        ? leftRoom >= naturalWidth
          ? "left"
          : rightRoom >= naturalWidth
            ? "right"
            : leftRoom >= rightRoom
              ? "left"
              : "right"
        : rightRoom >= naturalWidth
          ? "right"
          : leftRoom >= naturalWidth
            ? "left"
            : rightRoom >= leftRoom
              ? "right"
              : "left";
      const sideRoom = side === "left" ? leftRoom : rightRoom;

      label.style.setProperty(
        "left",
        side === "left" ? `-${gap}px` : `${gap}px`,
        "important",
      );
      label.style.setProperty(
        "transform",
        side === "left"
          ? "translate(-100%, -50%)"
          : "translate(0, -50%)",
        "important",
      );
      label.style.setProperty(
        "text-align",
        side === "left" ? "right" : "left",
        "important",
      );

      if (naturalWidth <= sideRoom) {
        label.style.setProperty("width", "auto", "important");
        label.style.setProperty("max-width", "none", "important");
        label.style.setProperty("white-space", "nowrap", "important");
      } else {
        // Explicit width avoids shrink-to-fit collapsing around the zero-width
        // marker and lets long labels wrap within the available map area.
        label.style.setProperty("width", `${sideRoom}px`, "important");
        label.style.setProperty("max-width", `${sideRoom}px`, "important");
        label.style.setProperty("white-space", "normal", "important");
        label.style.setProperty("overflow-wrap", "anywhere", "important");
      }

      let labelRect = label.getBoundingClientRect();
      if (labelRect.top < mapRect.top) {
        label.style.setProperty(
          "transform",
          side === "left" ? "translate(-100%, 0)" : "translate(0, 0)",
          "important",
        );
      } else if (labelRect.bottom > mapRect.bottom) {
        label.style.setProperty(
          "transform",
          side === "left"
            ? "translate(-100%, -100%)"
            : "translate(0, -100%)",
          "important",
        );
      }

      labelRect = label.getBoundingClientRect();
      if (labelRect.left < mapRect.left || labelRect.right > mapRect.right) {
        const clampedLeft = Math.max(
          0,
          Math.min(mapRect.width - labelRect.width, pointX - labelRect.width / 2),
        );
        label.style.setProperty("left", `${clampedLeft - pointX}px`, "important");
        label.style.setProperty("transform", "translateY(-50%)", "important");
        label.style.setProperty("text-align", "center", "important");
      }
    });
}

function prepareReaderPositionedHorizontalTimelines(root: ParentNode) {
  root
    .querySelectorAll<HTMLElement>(
      ".reader-positioned-horizontal-timeline",
    )
    .forEach((timeline) => {
      const noteRows = Array.from(
        timeline.querySelectorAll<HTMLElement>(
          ".reader-positioned-horizontal-timeline-note-row",
        ),
      );

      const arrowTextNodes: Text[] = [];

      noteRows.forEach((noteRow) => {
        const walker = document.createTreeWalker(
          noteRow,
          NodeFilter.SHOW_TEXT,
        );

        while (walker.nextNode()) {
          const node = walker.currentNode;

          if (!(node instanceof Text)) continue;
          if (!/[↓↑↕]/.test(node.nodeValue || "")) continue;
          if (
            node.parentElement?.closest(
              ".reader-positioned-horizontal-timeline-arrow",
            )
          ) {
            continue;
          }

          arrowTextNodes.push(node);
        }
      });

      arrowTextNodes.forEach((node) => {
        const fragment = document.createDocumentFragment();

        (node.nodeValue || "")
          .split(/([↓↑↕])/g)
          .forEach((part) => {
            if (!part) return;

            if (/^[↓↑↕]$/.test(part)) {
              const arrow = document.createElement("span");
              arrow.className =
                "reader-positioned-horizontal-timeline-arrow";
              arrow.textContent = part;
              fragment.appendChild(arrow);
              return;
            }

            fragment.appendChild(document.createTextNode(part));
          });

        node.replaceWith(fragment);
      });

      timeline
        .querySelectorAll<HTMLElement>(
          ".reader-positioned-horizontal-timeline-bar-row",
        )
        .forEach((row) => {
          Array.from(row.children).forEach((segment) => {
            if (!(segment instanceof HTMLElement)) return;
            if (segment.dataset.readerTimelineStackedBand === "1") {
              return;
            }

            const images = Array.from(
              segment.querySelectorAll<HTMLImageElement>("img"),
            );
            const breaks = Array.from(segment.querySelectorAll("br"));

            if (images.length < 2 || breaks.length === 0) return;

            const labelNodes: Node[] = [];
            const flagNodes: Node[] = [];

            Array.from(segment.childNodes).forEach((node) => {
              const element =
                node instanceof HTMLElement ? node : null;
              const containsImage =
                element?.matches("img") ||
                Boolean(element?.querySelector("img"));

              if (containsImage) {
                flagNodes.push(node);
                return;
              }

              if (
                node.nodeType === Node.ELEMENT_NODE &&
                node.nodeName === "BR"
              ) {
                labelNodes.push(document.createTextNode(" "));
                return;
              }

              labelNodes.push(node);
            });

            if (flagNodes.length < 2) return;

            const label = document.createElement("span");
            label.className =
              "reader-positioned-horizontal-timeline-stacked-band-label";

            const flags = document.createElement("span");
            flags.className =
              "reader-positioned-horizontal-timeline-stacked-band-flags";

            label.append(...labelNodes);
            flags.append(...flagNodes);
            segment.replaceChildren(label, flags);
            segment.dataset.readerTimelineStackedBand = "1";
          });
        });
    });
}

function getReaderPositionedTimelineLineRects(element: HTMLElement) {
  const rects: Array<{
    left: number;
    right: number;
    top: number;
    bottom: number;
  }> = [];

  const walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT,
  );

  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!(node instanceof Text) || !node.nodeValue?.trim()) continue;

    const range = document.createRange();
    range.selectNodeContents(node);

    Array.from(range.getClientRects()).forEach((rect) => {
      if (rect.width < 0.1 || rect.height < 0.1) return;

      rects.push({
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
      });
    });
  }

  rects.sort((a, b) =>
    Math.abs(a.top - b.top) > 1
      ? a.top - b.top
      : a.left - b.left,
  );

  const lines: typeof rects = [];

  rects.forEach((rect) => {
    const line = lines.find(
      (candidate) => Math.abs(candidate.top - rect.top) <= 1.5,
    );

    if (!line) {
      lines.push({ ...rect });
      return;
    }

    line.left = Math.min(line.left, rect.left);
    line.right = Math.max(line.right, rect.right);
    line.top = Math.min(line.top, rect.top);
    line.bottom = Math.max(line.bottom, rect.bottom);
  });

  return lines;
}

function parseReaderPositionedTimelineColor(value: string) {
  const match = value.match(
    /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)/i,
  );

  if (!match) return null;

  return {
    r: Number(match[1]),
    g: Number(match[2]),
    b: Number(match[3]),
    a: match[4] === undefined ? 1 : Number(match[4]),
  };
}

function layoutReaderPositionedHorizontalTimelines(
  articleRoot: HTMLElement,
) {
  const articleStyle = getComputedStyle(articleRoot);
  const availableWidth = Math.max(
    0,
    articleRoot.clientWidth -
      Number.parseFloat(articleStyle.paddingLeft) -
      Number.parseFloat(articleStyle.paddingRight),
  );

  articleRoot
    .querySelectorAll<HTMLElement>(
      ".reader-positioned-horizontal-timeline",
    )
    .forEach((timeline) => {
      const intrinsicWidth = Number.parseFloat(
        timeline.dataset.readerTimelineIntrinsicWidth || "",
      );

      const scale =
        Number.isFinite(intrinsicWidth) &&
        intrinsicWidth > 0 &&
        intrinsicWidth > availableWidth
          ? Math.max(0.2, availableWidth / intrinsicWidth)
          : 1;

      if (Number.isFinite(intrinsicWidth) && intrinsicWidth > 0) {
        timeline.style.setProperty(
          "zoom",
          String(scale),
          "important",
        );
      } else {
        timeline.style.removeProperty("zoom");
      }

      const effectiveScale = scale || 1;

      const noteRows = Array.from(
        timeline.querySelectorAll<HTMLElement>(
          ".reader-positioned-horizontal-timeline-note-row",
        ),
      );

      const barRows = Array.from(
        timeline.querySelectorAll<HTMLElement>(
          ".reader-positioned-horizontal-timeline-bar-row",
        ),
      );

      const nextBarAfter = (element: HTMLElement) =>
        barRows.find((bar) =>
          Boolean(
            element.compareDocumentPosition(bar) &
              Node.DOCUMENT_POSITION_FOLLOWING,
          ),
        );

      noteRows.forEach((noteRow) => {
        const bar = nextBarAfter(noteRow);
        if (!bar) return;

        const targetArrowBottom =
          bar.getBoundingClientRect().top - 2;

        Array.from(noteRow.children).forEach((item) => {
          if (!(item instanceof HTMLElement)) return;

          const arrows = Array.from(
            item.querySelectorAll<HTMLElement>(
              ".reader-positioned-horizontal-timeline-arrow",
            ),
          );

          const labels = Array.from(
            item.querySelectorAll<HTMLElement>("a"),
          ).filter(
            (label) =>
              !label.closest(
                ".reader-positioned-horizontal-timeline-arrow",
              ),
          );

          if (arrows.length === 0 || labels.length === 0) return;

          arrows.forEach((arrow) => {
            arrow.style.setProperty("top", "0px", "important");
          });

          labels.forEach((label) => {
            label.classList.remove(
              "reader-positioned-horizontal-timeline-adjusted-label",
              "reader-positioned-horizontal-timeline-side-label",
            );
            label.style.removeProperty("top");
          });

          arrows.forEach((arrow) => {
            const rect = arrow.getBoundingClientRect();
            const shift = targetArrowBottom - rect.bottom;

            arrow.style.setProperty(
              "top",
              `${shift / effectiveScale}px`,
              "important",
            );
          });

          const arrowRects = arrows.map((arrow) =>
            arrow.getBoundingClientRect(),
          );

          const arrowLeft = Math.min(
            ...arrowRects.map((rect) => rect.left),
          );
          const arrowRight = Math.max(
            ...arrowRects.map((rect) => rect.right),
          );
          const arrowTop = Math.min(
            ...arrowRects.map((rect) => rect.top),
          );
          const arrowBottom = Math.max(
            ...arrowRects.map((rect) => rect.bottom),
          );

          const arrowCenterX = (arrowLeft + arrowRight) / 2;
          const arrowCenterY = (arrowTop + arrowBottom) / 2;

          const renderedLines = labels
            .flatMap((label) =>
              getReaderPositionedTimelineLineRects(label),
            )
            .sort((a, b) =>
              Math.abs(a.top - b.top) > 1
                ? a.top - b.top
                : a.left - b.left,
            );

          if (renderedLines.length === 0) return;

          const labelLeft = Math.min(
            ...renderedLines.map((line) => line.left),
          );
          const labelRight = Math.max(
            ...renderedLines.map((line) => line.right),
          );

          const isSideLabel =
            arrowCenterX < labelLeft - 2 ||
            arrowCenterX > labelRight + 2;

          const lastLine =
            renderedLines[renderedLines.length - 1];

          if (isSideLabel) {
            const lastLineCenterY =
              (lastLine.top + lastLine.bottom) / 2;
            const shift = arrowCenterY - lastLineCenterY;

            labels.forEach((label) => {
              label.classList.add(
                "reader-positioned-horizontal-timeline-adjusted-label",
                "reader-positioned-horizontal-timeline-side-label",
              );

              label.style.setProperty(
                "top",
                `${shift / effectiveScale}px`,
                "important",
              );
            });

            return;
          }

          const overlap =
            lastLine.bottom + 0.5 - arrowTop;

          if (overlap <= 0) return;

          labels.forEach((label) => {
            label.classList.add(
              "reader-positioned-horizontal-timeline-adjusted-label",
            );

            label.style.setProperty(
              "top",
              `${-overlap / effectiveScale}px`,
              "important",
            );
          });
        });
      });

      timeline
        .querySelectorAll<HTMLElement>(
          ".reader-positioned-horizontal-timeline-aligned-image",
        )
        .forEach((image) => {
          image.classList.remove(
            "reader-positioned-horizontal-timeline-aligned-image",
          );
          image.style.removeProperty("top");
        });

      barRows.forEach((row) => {
        Array.from(row.children).forEach((segment) => {
          if (!(segment instanceof HTMLElement)) return;

          const images = Array.from(
            segment.querySelectorAll<HTMLImageElement>("img"),
          );

          if (images.length < 2) return;

          const centers = images.map((image) => {
            const rect = image.getBoundingClientRect();
            return rect.top + rect.height / 2;
          });

          const targetCenter =
            centers.reduce(
              (sum, center) => sum + center,
              0,
            ) / centers.length;

          images.forEach((image, index) => {
            const shift = targetCenter - centers[index];

            image.classList.add(
              "reader-positioned-horizontal-timeline-aligned-image",
            );

            image.style.setProperty(
              "top",
              `${shift / effectiveScale}px`,
              "important",
            );
          });
        });
      });

      const timelineElements = [
        timeline,
        ...Array.from(
          timeline.querySelectorAll<HTMLElement>("*"),
        ),
      ];

      timelineElements.forEach((element) => {
        element.classList.remove(
          "reader-positioned-horizontal-timeline-dark-surface-text",
        );
      });

      const hasVisibleBackground = (element: HTMLElement) => {
        let current: HTMLElement | null = element;

        while (current && timeline.contains(current)) {
          const background =
            parseReaderPositionedTimelineColor(
              getComputedStyle(current).backgroundColor,
            );

          if (background && background.a > 0.05) {
            return true;
          }

          if (current === timeline) break;
          current = current.parentElement;
        }

        return false;
      };

      timelineElements.forEach((element) => {
        if (hasVisibleBackground(element)) return;

        const color = parseReaderPositionedTimelineColor(
          getComputedStyle(element).color,
        );

        if (!color) return;

        const luminance =
          0.2126 * color.r +
          0.7152 * color.g +
          0.0722 * color.b;

        if (luminance < 105) {
          element.classList.add(
            "reader-positioned-horizontal-timeline-dark-surface-text",
          );
        }
      });
    });
}

function layoutReaderNormalTablePerimeterCorners(root: ParentNode) {
  const epsilon = 3;

  const touches = (a: number, b: number) =>
    Math.abs(a - b) <= epsilon;

  root
    .querySelectorAll<HTMLTableElement>("table.reader-normal-table")
    .forEach((table) => {
      if (
        table.matches(
          ".reader-climate-table, .reader-climate-data-table, .infobox, .infobox-subbox",
        )
      ) {
        return;
      }

      const tableRect = table.getBoundingClientRect();

      if (tableRect.width <= 0 || tableRect.height <= 0) return;

      const captionRow = table.rows[0];
      const captionCell = captionRow?.cells.length === 1 ? captionRow.cells[0] : null;
      const visualHeaderRow = captionCell && captionCell.colSpan > 1 && table.rows[1]?.cells.length > 1
        ? table.rows[1]
        : null;
      const visualBottomRow = visualHeaderRow && table.rows.length > 1
        ? table.rows[table.rows.length - 1]
        : null;

      if (captionCell && visualHeaderRow) {
        Array.from(captionCell.children).forEach((child) => {
          if (child.tagName !== "DIV") return;
          const div = child as HTMLElement;
          const inlineStyle = div.getAttribute("style") || "";

          if (!div.textContent?.trim()) {
            div.remove();
          } else if (/height\s*:\s*2\.6em/i.test(inlineStyle)) {
            div.style.setProperty("height", "auto", "important");
            div.style.setProperty("min-height", "0", "important");
          }
        });

        visualHeaderRow.cells[0]?.style.setProperty(
          "border-top-left-radius",
          "10px",
          "important",
        );
        visualHeaderRow.cells[visualHeaderRow.cells.length - 1]?.style.setProperty(
          "border-top-right-radius",
          "10px",
          "important",
        );

        if (visualBottomRow && visualBottomRow.cells.length > 1) {
          visualBottomRow.cells[0]?.style.setProperty(
            "border-bottom-left-radius",
            "10px",
            "important",
          );
          visualBottomRow.cells[visualBottomRow.cells.length - 1]?.style.setProperty(
            "border-bottom-right-radius",
            "10px",
            "important",
          );
        }
      }

      if (table.closest(".reader-article")) {
        table.style.setProperty("border-radius", "0", "important");
        table.style.setProperty("clip-path", "none", "important");
        table.style.setProperty("overflow", "visible", "important");
        table.querySelectorAll<HTMLTableCellElement>("th, td").forEach((cell) => {
          cell.style.setProperty("border-radius", "0", "important");
          cell.style.setProperty("clip-path", "none", "important");
        });
        return;
      }

      const topEdge = visualHeaderRow
        ? visualHeaderRow.getBoundingClientRect().top
        : tableRect.top;

      const cells = Array.from(
        table.querySelectorAll<HTMLTableCellElement>("th, td"),
      );

      cells.forEach((cell) => {
        const rect = cell.getBoundingClientRect();
        const style = getComputedStyle(cell);

        const corners = [
          {
            property: "border-top-left-radius",
            radius: style.borderTopLeftRadius,
            isPerimeter:
              touches(rect.left, tableRect.left) &&
              touches(rect.top, topEdge),
          },
          {
            property: "border-top-right-radius",
            radius: style.borderTopRightRadius,
            isPerimeter:
              touches(rect.right, tableRect.right) &&
              touches(rect.top, topEdge),
          },
          {
            property: "border-bottom-right-radius",
            radius: style.borderBottomRightRadius,
            isPerimeter:
              (visualBottomRow === cell.parentElement && touches(rect.right, tableRect.right)) ||
              (touches(rect.right, tableRect.right) && touches(rect.bottom, tableRect.bottom)),
          },
          {
            property: "border-bottom-left-radius",
            radius: style.borderBottomLeftRadius,
            isPerimeter:
              (visualBottomRow === cell.parentElement && touches(rect.left, tableRect.left)) ||
              (touches(rect.left, tableRect.left) && touches(rect.bottom, tableRect.bottom)),
          },
        ];

        corners.forEach(({ property, radius, isPerimeter }) => {
          if ((Number.parseFloat(radius) || 0) <= 0) return;
          if (isPerimeter) return;

          /*
           * Generic sortable-table corner rules use high-specificity
           * !important selectors. Geometry is authoritative here, so apply
           * the internal-corner correction directly to the rendered cell.
           */
          cell.style.setProperty(property, "0", "important");
        });
      });
    });
}

function normalizeReadableColoredTableCellText(document: Document) {
  const coloredCellSelector = [
    "td.reader-preserved-background",
    "th.reader-preserved-background",
    "td.reader-light-background-cell",
    "th.reader-light-background-cell",
    "td[style*='--reader-preserved-background']",
    "th[style*='--reader-preserved-background']",
  ].join(", ");

  document
    .querySelectorAll<HTMLTableCellElement>(
      "table.reader-normal-table td",
    )
    .forEach((cell) => {
      if (cell.textContent?.replace(/\s+/g, " ").trim() === "?") {
        cell.dataset.readerCenteredStatusCell = "true";
      }
    });

  const wrapPlainTextNodes = (cell: HTMLElement) => {
    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const text = node.nodeValue?.replace(/\s+/g, " ").trim();
        if (!text) return NodeFilter.FILTER_REJECT;

        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;

        if (parent.closest("a")) return NodeFilter.FILTER_REJECT;
        if (parent.closest(".reader-readable-colored-cell-text")) {
          return NodeFilter.FILTER_REJECT;
        }

        if (["SCRIPT", "STYLE", "NOSCRIPT"].includes(parent.tagName)) {
          return NodeFilter.FILTER_REJECT;
        }

        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const nodes: Text[] = [];

    while (walker.nextNode()) {
      nodes.push(walker.currentNode as Text);
    }

    nodes.forEach((node) => {
      const wrapper = document.createElement("span");
      wrapper.className = "reader-readable-colored-cell-text";

      node.parentNode?.insertBefore(wrapper, node);
      wrapper.appendChild(node);
    });
  };

  document.querySelectorAll<HTMLElement>(coloredCellSelector).forEach((cell) => {
    const text = cell.textContent?.replace(/\s+/g, " ").trim();
    if (!text) return;

    cell.dataset.readerReadableColoredCell = "true";
    wrapPlainTextNodes(cell);
  });
}



// ADAM ELECTION RESULTS TABLE POLISH
function markReaderElectionResultsTables(document: Document) {
  const clean = (value: string | null | undefined) =>
    String(value || "").replace(/\s+/g, " ").trim();

  const titleNeedle = "United States presidential election results";

  document.querySelectorAll<HTMLTableElement>("table").forEach((table) => {
    const wrapper = table.closest<HTMLElement>(".reader-table-caption-group");
    const tableText = clean(table.textContent);
    const wrapperText = clean(wrapper?.textContent);

    const isElectionResultsTable =
      tableText.includes("Year") &&
      tableText.includes("Republican") &&
      tableText.includes("Democratic") &&
      tableText.includes("Third") &&
      (tableText.includes(titleNeedle) || wrapperText.includes(titleNeedle));

    if (!isElectionResultsTable) return;

    table.classList.add("reader-election-results-table");

    if (wrapper) {
      wrapper.classList.add("reader-election-results-wrapper");

      const title = Array.from(
        wrapper.querySelectorAll<HTMLElement>(".reader-table-external-caption"),
      ).find((element) => clean(element.textContent).includes(titleNeedle));

      if (title) {
        title.classList.add("reader-election-results-title");
      }

      const possibleContainers = [
        table.parentElement,
        table.closest<HTMLElement>(
          ".reader-scrollable-sortable-table-inner, .reader-scrollable-table-inner, .reader-scrollable-table",
        ),
      ].filter((element): element is HTMLElement => Boolean(element));

      possibleContainers.forEach((container) => {
        if (container === table) return;

        if (container.contains(table)) {
          container.classList.add("reader-election-results-table-container");
        }

        Array.from(container.children).forEach((child) => {
          if (!(child instanceof HTMLElement)) return;
          if (child === table || child.contains(table)) return;

          if (clean(child.textContent).includes(titleNeedle)) {
            child.classList.add("reader-election-results-duplicate-title");
          }
        });
      });

      Array.from(wrapper.children).forEach((child) => {
        if (!(child instanceof HTMLElement)) return;
        if (child === title || child === table || child.contains(table)) return;

        if (clean(child.textContent).includes(titleNeedle)) {
          child.classList.add("reader-election-results-duplicate-title");
        }
      });
    }

    table
      .querySelectorAll<HTMLElement>(".reader-election-winner-cell")
      .forEach((cell) => cell.classList.remove("reader-election-winner-cell"));

    table.querySelectorAll<HTMLTableRowElement>("tr").forEach((row) => {
      const cells = Array.from(row.children).filter(
        (element): element is HTMLElement =>
          element instanceof HTMLElement && element.matches("td, th"),
      );

      const rowText = clean(row.textContent);
      if (!/^\d{4}\b/.test(rowText) || cells.length < 7) return;

      const parsePercent = (cell: HTMLElement) => {
        const match = clean(cell.textContent).match(/(\d+(?:\.\d+)?)\s*%/);
        return match ? Number(match[1]) : Number.NaN;
      };

      const parties = [
        { vote: cells[1], percent: cells[2], value: parsePercent(cells[2]) },
        { vote: cells[3], percent: cells[4], value: parsePercent(cells[4]) },
        { vote: cells[5], percent: cells[6], value: parsePercent(cells[6]) },
      ].filter((party) => Number.isFinite(party.value));

      if (!parties.length) return;

      const winner = parties.reduce((best, party) =>
        party.value > best.value ? party : best,
      );

      winner.vote.classList.add("reader-election-winner-cell");
      winner.percent.classList.add("reader-election-winner-cell");
    });
  });
}
// END ADAM ELECTION RESULTS TABLE POLISH

function markReaderGeneralElectionResultsColorStrips(document: Document) {
  const clean = (value: string | null | undefined) =>
    String(value || "").replace(/\s+/g, " ").trim();

  const isGeneralElectionResultsTable = (table: HTMLTableElement) => {
    const text = clean(table.textContent);

    return (
      text.includes("Party") &&
      text.includes("Pledged to") &&
      text.includes("Elector") &&
      text.includes("Votes") &&
      /Republican Party|Democratic Party|Socialist Party|Prohibition Party|Progressive Party/i.test(text)
    );
  };

  document.querySelectorAll<HTMLTableElement>("table").forEach((table) => {
    if (!isGeneralElectionResultsTable(table)) return;

    table.classList.add("reader-election-general-results-table");

    [
      table.closest<HTMLElement>(".reader-scrollable-sortable-table"),
      table.closest<HTMLElement>(".reader-scrollable-table"),
      table.closest<HTMLElement>(".reader-table-caption-group"),
      table.closest<HTMLElement>(".reader-table-caption-group-right"),
    ].forEach((wrapper) => {
      wrapper?.classList.add("reader-election-general-results-wrapper");
    });

    table
      .querySelectorAll<HTMLElement>(".reader-election-results-color-strip-cell")
      .forEach((cell) => {
        cell.classList.remove("reader-election-results-color-strip-cell");
        cell.style.removeProperty("--reader-election-strip-color");
      });

    Array.from(table.rows).forEach((row) => {
      const first = row.cells.item(0);

      if (!(first instanceof HTMLElement)) return;

      const firstText = clean(first.textContent);
      const stripColor =
        first.style.getPropertyValue("--reader-preserved-background").trim() ||
        first.getAttribute("bgcolor") ||
        first.style.backgroundColor ||
        "";

      if (firstText || !stripColor) return;

      first.classList.add("reader-election-results-color-strip-cell");
      first.style.setProperty("--reader-election-strip-color", stripColor);
    });
  });
}



// ADAM INFOBOX READABILITY AND ELECTION NAV
function markReaderElectionInfoboxNavigation(document: Document) {
  const clean = (value: string | null | undefined) =>
    String(value || "").replace(/\s+/g, " ").trim();

  const getText = (element: Element | Document | null | undefined) => {
    if (!element) return "";

    const htmlElement = element instanceof HTMLElement ? element : null;
    return clean(htmlElement?.innerText || element.textContent);
  };

  const makeInternalLink = (text: string, targetTitle: string) => {
    const link = document.createElement("a");

    link.className = "reader-election-infobox-nav-link";
    link.textContent = text;
    link.title = targetTitle;

    // Match normal reader internal links: no href, use data-wiki-target.
    link.dataset.wikiTarget = targetTitle;

    return link;
  };

  const infoboxes = Array.from(
    document.querySelectorAll<HTMLElement>(".reader-article .infobox, .infobox"),
  ).filter((infobox, index, all) => all.indexOf(infobox) === index);

  infoboxes.forEach((infobox) => {
    if (infobox.querySelector(".reader-election-infobox-nav-row")) return;

    let titleText = "";

    for (const candidate of Array.from(infobox.querySelectorAll<HTMLElement>("*"))) {
      const text = getText(candidate);

      if (/^\d{4}\s+.+election/i.test(text) && text.length < 220) {
        titleText = text;
        break;
      }
    }

    if (!/^\d{4}\s+.+election/i.test(titleText)) {
      const infoboxText = getText(infobox);
      const match = infoboxText.match(
        /\b(?:18|19|20)\d{2}\s+[^|]+?election[^|]+?(?:Wisconsin|United States|county|County)/i,
      );

      titleText = match ? clean(match[0]) : "";
    }

    if (!/^\d{4}\s+.+election/i.test(titleText)) {
      const pageTitleCandidates = Array.from(
        document.querySelectorAll<HTMLElement>(
          "h1, .reader-page-title, .reader-article-title",
        ),
      );

      for (const candidate of pageTitleCandidates) {
        const text = getText(candidate);

        if (/^\d{4}\s+.+election/i.test(text)) {
          titleText = text;
          break;
        }
      }
    }

    if (!/^\d{4}\s+.+election/i.test(titleText)) {
      titleText = clean(document.title);
    }

    if (!/^\d{4}\s+.+election/i.test(titleText)) return;

    const titleMatch = titleText.match(/^(\d{4})\s+(.+?)(?:\s*[|-].*)?$/);
    if (!titleMatch) return;

    const year = Number(titleMatch[1]);
    const restOfTitle = clean(titleMatch[2]);

    if (!Number.isFinite(year) || !restOfTitle) return;

    const rows = Array.from(infobox.querySelectorAll<HTMLTableRowElement>("tr"));

    const dateRow = rows.find((row) =>
      /^[A-Z][a-z]+ \d{1,2}, \d{4}$/.test(getText(row)),
    );

    if (!dateRow) return;

    const dateText = getText(dateRow);
    const prevYear = year - 4;
    const nextYear = year + 4;
    const prevTitle = `${prevYear} ${restOfTitle}`;
    const nextTitle = `${nextYear} ${restOfTitle}`;

    let maxCols = 1;

    rows.forEach((row) => {
      const colCount = Array.from(row.children).reduce((total, cell) => {
        const span = Number(cell.getAttribute("colspan") || 1);
        return total + (Number.isFinite(span) && span > 0 ? span : 1);
      }, 0);

      maxCols = Math.max(maxCols, colCount);
    });

    dateRow.classList.add("reader-election-infobox-nav-row");
    dateRow.replaceChildren();

    const cell = document.createElement("td");
    cell.className = "reader-election-infobox-nav-cell";
    cell.colSpan = maxCols;

    const bar = document.createElement("div");
    bar.className = "reader-election-infobox-nav-bar";

    const date = document.createElement("span");
    date.className = "reader-election-infobox-nav-date";
    date.textContent = dateText;

    bar.appendChild(makeInternalLink(`← ${prevYear}`, prevTitle));
    bar.appendChild(date);
    bar.appendChild(makeInternalLink(`${nextYear} →`, nextTitle));

    cell.appendChild(bar);
    dateRow.appendChild(cell);
  });
}

function markReaderElectionInfoboxCandidatePhotoStrips(document: Document) {
  const parseBorder = (value: string) => {
    const width = value.match(/\b\d+(?:\.\d+)?px\b/i)?.[0] || "6px";
    const style = value.match(/\b(solid|dashed|dotted|double)\b/i)?.[0] || "solid";
    const color =
      value.match(/#[0-9a-f]{3,8}\b/i)?.[0] ||
      value.match(/rgba?\([^)]+\)/i)?.[0] ||
      "";

    return { width, style, color };
  };

  document
    .querySelectorAll<HTMLElement>(".infobox td, .infobox th")
    .forEach((cell) => {
      if (!cell.querySelector("img")) return;

      const preservedBorder = cell.style
        .getPropertyValue("--reader-preserved-border-bottom")
        .trim();

      if (!preservedBorder) return;

      const { width, style, color } = parseBorder(preservedBorder);

      cell.classList.add("reader-election-candidate-photo-cell");
      cell
        .closest("tr")
        ?.classList.add("reader-election-candidate-photo-row");
      cell
        .closest("table")
        ?.classList.add("reader-election-candidate-photo-table");

      // These candidate party-color strips are meaningful Wikipedia content.
      // Apply them directly so the generic "no inner infobox grid" rule does
      // not flatten them back to gray.
      cell.style.setProperty("border-bottom-width", width, "important");
      cell.style.setProperty("border-bottom-style", style, "important");

      if (color) {
        cell.style.setProperty("border-bottom-color", color, "important");
      }
    });
}


function markReaderElectionInfoboxStructure(document: Document) {
  const isElectionInfobox = (box: Element) => {
    const text = box.textContent?.replace(/\s+/g, " ").trim() || "";
    return (
      /United States presidential election/i.test(text) ||
      (
        /Electoral vote/i.test(text) &&
        /Popular vote/i.test(text) &&
        /President before election|Elected President/i.test(text)
      )
    );
  };

  document.querySelectorAll<HTMLElement>(".infobox").forEach((box) => {
    if (!isElectionInfobox(box)) return;

    box.classList.add("reader-election-infobox-polished");

    const headerCandidates = [
      box.querySelector(":scope > caption"),
      box.querySelector(":scope > tbody > tr:first-child > th[colspan]"),
      box.querySelector(":scope > tbody > tr:first-child > td[colspan]"),
      box.querySelector(":scope > tr:first-child > th[colspan]"),
      box.querySelector(":scope > tr:first-child > td[colspan]"),
      box.querySelector(".infobox-title"),
    ].filter(Boolean) as HTMLElement[];

    const header = headerCandidates.find((element) => {
      const text = element.textContent?.trim() || "";
      return text.length > 20 && !element.querySelector("img");
    });

    if (header) {
      header.classList.add("reader-election-infobox-title-header");
      header.closest("tr")?.classList.add("reader-election-infobox-title-row");
    }

    let hasReachedMapBlock = false;

    box.querySelectorAll<HTMLElement>("tr").forEach((row) => {
      const text = row.textContent?.trim().replace(/\s+/g, " ") || "";
      const hasHr = !!row.querySelector("hr");
      const hasImage = !!row.querySelector("img");
      const hasCandidatePhoto = !!row.querySelector(
        ".reader-election-candidate-photo-cell"
      );
      const hasPresidentLabels =
        /President before election|Elected President/i.test(text);

      if (hasHr && !text) {
        row.classList.add("reader-election-infobox-empty-hr-row");
      } else if (hasHr) {
        row.classList.add("reader-election-infobox-section-hr-row");
      }

      if (
        hasImage &&
        !hasCandidatePhoto &&
        /County results|Results by county|County Results/i.test(text)
      ) {
        row.classList.add("reader-election-infobox-map-row");
        hasReachedMapBlock = true;
      }

      if (!hasImage && /^County results$/i.test(text)) {
        row.classList.add("reader-election-infobox-map-caption-row");
        hasReachedMapBlock = true;
      }

      if (
        hasReachedMapBlock &&
        !hasPresidentLabels &&
        /40[–-]50|50[–-]60|60[–-]70|70[–-]80|80[–-]90/i.test(text)
      ) {
        row.classList.add("reader-election-infobox-legend-row");
      }

      if (hasPresidentLabels) {
        row.classList.add("reader-election-infobox-president-row");
      }
    });
  });
}

function markReaderInfoboxBelligerentsRows(document: Document) {
  document.querySelectorAll<HTMLElement>(".infobox").forEach((infobox) => {
    const heading = Array.from(infobox.querySelectorAll<HTMLElement>("th, td"))
      .find((cell) => cell.textContent?.replace(/\s+/g, " ").trim() === "Belligerents");

    const headingRow = heading?.closest("tr");
    const rows = headingRow
      ? [headingRow.nextElementSibling, headingRow.nextElementSibling?.nextElementSibling]
          .filter((row): row is HTMLTableRowElement => row instanceof HTMLTableRowElement)
      : [];

    rows.forEach((row) => row.classList.add("reader-infobox-belligerents-row"));
  });
}

function markReaderInfoboxRowsByHeading(
  document: Document,
  headingText: string,
  rowClass: string,
) {
  document.querySelectorAll<HTMLElement>(".infobox").forEach((infobox) => {
    const heading = Array.from(infobox.querySelectorAll<HTMLElement>("th, td"))
      .find((cell) => cell.textContent?.replace(/\s+/g, " ").trim() === headingText);
    const row = heading?.closest("tr")?.nextElementSibling;
    if (row instanceof HTMLTableRowElement) row.classList.add(rowClass);
  });
}

function markReaderInfoboxMetadataRows(document: Document) {
  const metadataLabels = new Set(["Date", "Location", "Status"]);

  document.querySelectorAll<HTMLElement>(".infobox").forEach((infobox) => {
    infobox.querySelectorAll<HTMLTableRowElement>("tr").forEach((row) => {
      const label = row.querySelector<HTMLElement>(":scope > th, :scope > td")
        ?.textContent?.replace(/\s+/g, " ").trim();
      if (label && metadataLabels.has(label)) row.classList.add("reader-infobox-metadata-row");
    });
  });
}

// END ADAM INFOBOX READABILITY AND ELECTION NAV

function disableReaderLocationMapExternalClicks(document: Document) {
  document
    .querySelectorAll<HTMLElement>(
      ".reader-location-map-switcher .reader-location-map-panels, .reader-location-map-switcher .reader-location-map-panels *",
    )
    .forEach((element) => {
      element.removeAttribute("data-openstreetmap-url");
      element.removeAttribute("data-openstreetmap-page-title");
      element.removeAttribute("data-wiki-target");
      element.removeAttribute("title");
      element.removeAttribute("role");
      element.removeAttribute("tabindex");
      element.classList.remove("reader-openstreetmap-target");

      if (element instanceof HTMLAnchorElement) {
        element.removeAttribute("href");
        element.removeAttribute("target");
        element.removeAttribute("rel");
      }
    });
}


interface ReaderMapCoordinate {
  lat: number;
  lon: number;
}

interface ReaderMapPoint {
  x: number;
  y: number;
}

function isReaderValidCoordinate(coordinate: ReaderMapCoordinate | null) {
  if (!coordinate) return false;

  return (
    Number.isFinite(coordinate.lat) &&
    Number.isFinite(coordinate.lon) &&
    Math.abs(coordinate.lat) <= 90 &&
    Math.abs(coordinate.lon) <= 180
  );
}

function parseReaderCoordinateComponent(text: string, kind: "lat" | "lon") {
  const cleaned = text
    .replace(/−/g, "-")
    .replace(/[º]/g, "°")
    .replace(/\s+/g, " ")
    .trim();

  const hemisphere = cleaned.match(/[NSEW]/i)?.[0]?.toUpperCase() ?? "";
  const numbers = cleaned.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];

  if (numbers.length === 0) return null;

  let value =
    Math.abs(numbers[0]) +
    (Math.abs(numbers[1] ?? 0) / 60) +
    (Math.abs(numbers[2] ?? 0) / 3600);

  if (numbers[0] < 0 || hemisphere === "S" || hemisphere === "W") {
    value *= -1;
  }

  if (kind === "lat" && Math.abs(value) > 90) return null;
  if (kind === "lon" && Math.abs(value) > 180) return null;

  return value;
}

function parseReaderCoordinatePair(text: string): ReaderMapCoordinate | null {
  const cleaned = text
    .replace(/−/g, "-")
    .replace(/[º]/g, "°")
    .replace(/\s+/g, " ")
    .trim();

  const decimalPair = cleaned.match(
    /(-?\d{1,2}(?:\.\d+)?)\s*[;,]\s*(-?\d{1,3}(?:\.\d+)?)/,
  );

  if (decimalPair) {
    const coordinate = {
      lat: Number(decimalPair[1]),
      lon: Number(decimalPair[2]),
    };

    if (isReaderValidCoordinate(coordinate)) return coordinate;
  }

  const latMatch = cleaned.match(
    /(\d{1,2}(?:\.\d+)?(?:\s*[°]\s*\d{1,2}(?:\.\d+)?)?(?:\s*[′']\s*\d{1,2}(?:\.\d+)?)?(?:\s*(?:″|"|''))?\s*[NS])/i,
  );
  const lonMatch = cleaned.match(
    /(\d{1,3}(?:\.\d+)?(?:\s*[°]\s*\d{1,2}(?:\.\d+)?)?(?:\s*[′']\s*\d{1,2}(?:\.\d+)?)?(?:\s*(?:″|"|''))?\s*[EW])/i,
  );

  if (latMatch && lonMatch) {
    const lat = parseReaderCoordinateComponent(latMatch[1], "lat");
    const lon = parseReaderCoordinateComponent(lonMatch[1], "lon");

    const coordinate =
      typeof lat === "number" && typeof lon === "number"
        ? { lat, lon }
        : null;

    if (isReaderValidCoordinate(coordinate)) return coordinate;
  }

  return null;
}

function parseReaderGeohackCoordinate(href: string): ReaderMapCoordinate | null {
  try {
    const decoded = decodeURIComponent(href);
    const paramsMatch = decoded.match(/[?&]params=([^&]+)/i);
    const params = paramsMatch?.[1] || decoded;

    const match = params.match(
      /(\d+(?:\.\d+)?)(?:[_\s]+(\d+(?:\.\d+)?))?(?:[_\s]+(\d+(?:\.\d+)?))?[_\s]+([NS])[_\s]+(\d+(?:\.\d+)?)(?:[_\s]+(\d+(?:\.\d+)?))?(?:[_\s]+(\d+(?:\.\d+)?))?[_\s]+([EW])/i,
    );

    if (!match) return null;

    const latParts = [match[1], match[2], match[3]]
      .filter(Boolean)
      .join(" ");
    const lonParts = [match[5], match[6], match[7]]
      .filter(Boolean)
      .join(" ");

    const lat = parseReaderCoordinateComponent(`${latParts} ${match[4]}`, "lat");
    const lon = parseReaderCoordinateComponent(`${lonParts} ${match[8]}`, "lon");

    const coordinate =
      typeof lat === "number" && typeof lon === "number"
        ? { lat, lon }
        : null;

    return isReaderValidCoordinate(coordinate) ? coordinate : null;
  } catch {
    return null;
  }
}

function getReaderDocumentCoordinates(document: Document): ReaderMapCoordinate | null {
  const coordinateCandidates = Array.from(
    document.querySelectorAll<HTMLElement>(
      ".geo, .geo-dec, .coordinates, #coordinates, .latitude, .longitude",
    ),
  )
    .map((element) => element.textContent || "")
    .filter(Boolean);

  for (const candidate of coordinateCandidates) {
    const coordinate = parseReaderCoordinatePair(candidate);
    if (coordinate) return coordinate;
  }

  const latitudeText =
    document.querySelector<HTMLElement>(".latitude")?.textContent || "";
  const longitudeText =
    document.querySelector<HTMLElement>(".longitude")?.textContent || "";

  if (latitudeText && longitudeText) {
    const lat = parseReaderCoordinateComponent(latitudeText, "lat");
    const lon = parseReaderCoordinateComponent(longitudeText, "lon");

    const coordinate =
      typeof lat === "number" && typeof lon === "number"
        ? { lat, lon }
        : null;

    if (isReaderValidCoordinate(coordinate)) return coordinate;
  }

  const geohackLinks = Array.from(
    document.querySelectorAll<HTMLAnchorElement>(
      'a[href*="geohack"], a[href*="GeoHack"], a[href*="params="]',
    ),
  );

  for (const link of geohackLinks) {
    const coordinate = parseReaderGeohackCoordinate(link.href);
    if (coordinate) return coordinate;
  }

  const broadText = Array.from(
    document.querySelectorAll<HTMLElement>(".infobox, #coordinates, .coordinates"),
  )
    .map((element) => element.textContent || "")
    .join(" ");

  return parseReaderCoordinatePair(broadText);
}


function projectReaderLocationMapPoint(
  label: string,
  coordinate: ReaderMapCoordinate,
): ReaderMapPoint | null {
  const { lat, lon } = coordinate;
  const normalizedLabel = label.replace(/\s+/g, " ").trim().toLowerCase();

  const simpleStateBounds: Record<
    string,
    {
      left: number;
      right: number;
      top: number;
      bottom: number;
      xOffset?: number;
      yOffset?: number;
    }
  > = {
    wisconsin: {
      left: -93.1,
      right: -86.0,
      top: 47.5,
      bottom: 42.3,
      // Small Wisconsin visual correction for the rendered relief map.
      // Negative moves north, positive moves south.
      yOffset: -1.0,
    },
    minnesota: {
      left: -97.5,
      right: -89.0,
      top: 49.6,
      bottom: 43.3,
    },
    iowa: { left: -96.9, right: -90.0, top: 43.7, bottom: 40.2 },
    illinois: { left: -91.7, right: -87.0, top: 42.6, bottom: 36.8 },
    michigan: { left: -90.5, right: -82.1, top: 48.4, bottom: 41.6 },
    "north dakota": { left: -104.2, right: -96.4, top: 49.1, bottom: 45.8 },
    "south dakota": { left: -104.2, right: -96.3, top: 45.95, bottom: 42.4 },
    nebraska: { left: -104.2, right: -95.2, top: 43.1, bottom: 39.9 },
    kansas: { left: -102.2, right: -94.4, top: 40.1, bottom: 36.9 },
    missouri: { left: -95.9, right: -89.0, top: 40.8, bottom: 35.9 },
    indiana: { left: -88.2, right: -84.6, top: 41.9, bottom: 37.7 },
    ohio: { left: -84.9, right: -80.4, top: 42.4, bottom: 38.3 },
    pennsylvania: { left: -80.7, right: -74.6, top: 42.3, bottom: 39.6 },
    "new york": { left: -79.9, right: -71.7, top: 45.1, bottom: 40.4 },
    "new jersey": { left: -75.7, right: -73.7, top: 41.5, bottom: 38.8 },
    connecticut: { left: -73.9, right: -71.7, top: 42.1, bottom: 40.9 },
    rhode: { left: -72.0, right: -71.0, top: 42.1, bottom: 41.1 },
    massachusetts: { left: -73.7, right: -69.8, top: 42.9, bottom: 41.2 },
    vermont: { left: -73.6, right: -71.3, top: 45.1, bottom: 42.6 },
    "new hampshire": { left: -72.7, right: -70.6, top: 45.4, bottom: 42.6 },
    maine: { left: -71.2, right: -66.8, top: 47.6, bottom: 42.9 },
    maryland: { left: -79.6, right: -74.9, top: 39.8, bottom: 37.8 },
    delaware: { left: -75.9, right: -74.9, top: 39.9, bottom: 38.4 },
    virginia: { left: -83.8, right: -75.0, top: 39.6, bottom: 36.4 },
    "west virginia": { left: -82.8, right: -77.6, top: 40.8, bottom: 37.0 },
    "north carolina": { left: -84.4, right: -75.2, top: 36.7, bottom: 33.7 },
    "south carolina": { left: -83.5, right: -78.3, top: 35.4, bottom: 32.0 },
    georgia: { left: -85.7, right: -80.7, top: 35.1, bottom: 30.3 },
    florida: { left: -87.8, right: -79.8, top: 31.2, bottom: 24.3 },
    alabama: { left: -88.6, right: -84.7, top: 35.1, bottom: 30.1 },
    mississippi: { left: -91.8, right: -88.0, top: 35.1, bottom: 30.1 },
    louisiana: { left: -94.1, right: -88.7, top: 33.1, bottom: 28.7 },
    arkansas: { left: -94.8, right: -89.5, top: 36.6, bottom: 33.0 },
    oklahoma: { left: -103.2, right: -94.2, top: 37.1, bottom: 33.5 },
    texas: { left: -106.8, right: -93.4, top: 36.6, bottom: 25.7 },
    colorado: { left: -109.2, right: -101.9, top: 41.1, bottom: 36.9 },
    wyoming: { left: -111.2, right: -103.9, top: 45.1, bottom: 40.9 },
    montana: { left: -116.2, right: -103.9, top: 49.1, bottom: 44.2 },
    idaho: { left: -117.4, right: -111.0, top: 49.1, bottom: 41.9 },
    utah: { left: -114.2, right: -108.9, top: 42.1, bottom: 36.9 },
    arizona: { left: -115.0, right: -108.8, top: 37.1, bottom: 31.2 },
    "new mexico": { left: -109.2, right: -102.9, top: 37.1, bottom: 31.2 },
    nevada: { left: -120.1, right: -114.0, top: 42.1, bottom: 35.0 },
    california: { left: -124.6, right: -113.9, top: 42.1, bottom: 32.4 },
    oregon: { left: -124.8, right: -116.4, top: 46.4, bottom: 41.9 },
    washington: { left: -125.0, right: -116.8, top: 49.1, bottom: 45.4 },
    alaska: { left: -180.0, right: -129.0, top: 72.0, bottom: 51.0 },
    hawaii: { left: -161.0, right: -154.5, top: 22.5, bottom: 18.5 },

    // Standard Japan location map.
    // This handles pages like Toyohashi that use "Show map of Japan".
    canada: {
      left: -141.5,
      right: -52.0,
      top: 84.0,
      bottom: 41.0,
    },
    alberta: {
      left: -120.3,
      right: -109.8,
      top: 60.2,
      bottom: 48.8,
    },
    "british columbia": {
      left: -139.5,
      right: -113.5,
      top: 60.2,
      bottom: 48.0,
    },
    saskatchewan: {
      left: -110.2,
      right: -101.2,
      top: 60.2,
      bottom: 48.8,
    },
    manitoba: {
      left: -102.2,
      right: -88.8,
      top: 60.2,
      bottom: 48.8,
    },
    ontario: {
      left: -95.5,
      right: -74.0,
      top: 57.5,
      bottom: 41.5,
    },
    quebec: {
      left: -80.0,
      right: -57.0,
      top: 63.0,
      bottom: 44.5,
    },
    "new brunswick": {
      left: -69.3,
      right: -63.6,
      top: 48.2,
      bottom: 44.4,
    },
    "nova scotia": {
      left: -67.0,
      right: -59.5,
      top: 47.3,
      bottom: 43.2,
    },
    "prince edward island": {
      left: -64.8,
      right: -61.8,
      top: 47.2,
      bottom: 45.8,
    },
    "newfoundland and labrador": {
      left: -67.0,
      right: -52.0,
      top: 61.0,
      bottom: 46.5,
    },
    yukon: {
      left: -141.5,
      right: -123.5,
      top: 70.0,
      bottom: 59.5,
    },
    "northwest territories": {
      left: -136.8,
      right: -102.0,
      top: 78.8,
      bottom: 59.5,
    },
    nunavut: {
      left: -122.5,
      right: -61.0,
      top: 84.0,
      bottom: 59.0,
    },

    japan: {
      left: 122.0,
      right: 146.0,
      top: 46.0,
      bottom: 24.0,
    },
  };

  for (const [state, bounds] of Object.entries(simpleStateBounds)) {
    if (!normalizedLabel.includes(state)) continue;

    // The Illinois relief thumbnail's projection puts Chicago west of the
    // simple longitude interpolation. Calibrate only Chicago on this exact
    // map asset so other Illinois locations and maps keep their existing math.
    const isChicagoOnIllinoisReliefMap =
      state === "illinois" &&
      normalizedLabel.includes("usa_illinois_relief_location_map.svg") &&
      Math.abs(lat - 41.88194) <= 0.01 &&
      Math.abs(lon - -87.62778) <= 0.01;

    const x = isChicagoOnIllinoisReliefMap
      ? 76.5
      : ((lon - bounds.left) / (bounds.right - bounds.left)) * 100 +
        (bounds.xOffset ?? 0);
    const y =
      ((bounds.top - lat) / (bounds.top - bounds.bottom)) * 100 +
      (bounds.yOffset ?? 0);

    return { x, y };
  }

  if (/\b(united states|usa|u\.s\.)\b/i.test(label)) {
    const latRad = (lat * Math.PI) / 180;
    const lonRadFactor = (0.6010514667026994 * (lon + 96) * Math.PI) / 180;
    const radius = 1.9694462586094064 - latRad;

    return {
      x: 50.0 + 124.03149777329222 * (radius * Math.sin(lonRadFactor)),
      y:
        50.0 +
        1.6155950752393982 *
          124.03149777329222 *
          (0.02613325650382181 -
            (1.3236744353715044 - radius * Math.cos(lonRadFactor))),
    };
  }

  return null;
}

function readerLocationMapLabelForPanel(panel: HTMLElement) {
  const explicitLabel = panel.dataset.readerLocationMapLabel;

  if (explicitLabel) return explicitLabel;

  const index = panel.dataset.readerLocationMapIndex;
  const switcher = panel.closest<HTMLElement>(".reader-location-map-switcher");

  if (index && switcher) {
    const control = switcher.querySelector<HTMLElement>(
      `.reader-location-map-radio-${index} + .reader-location-map-control`,
    );

    if (control?.textContent) return control.textContent;
  }

  return panel.textContent || "";
}

function readerLargestMapImage(panel: HTMLElement) {
  const images = Array.from(panel.querySelectorAll<HTMLImageElement>("img"));

  if (images.length === 0) return null;

  return images
    .map((image) => {
      const width = Number(image.getAttribute("width") || image.width || 0);
      const height = Number(image.getAttribute("height") || image.height || 0);

      return {
        image,
        area: width * height,
      };
    })
    .sort((a, b) => b.area - a.area)[0]?.image || images[0];
}

function cleanupOriginalLocationMapMarker(panel: HTMLElement, mapImage: HTMLImageElement) {
  const images = Array.from(panel.querySelectorAll<HTMLImageElement>("img"));

  images.forEach((image) => {
    if (image === mapImage) return;

    const width = Number(image.getAttribute("width") || image.width || 0);
    const height = Number(image.getAttribute("height") || image.height || 0);
    const source = image.getAttribute("src") || "";
    const alt = image.getAttribute("alt") || "";

    const looksLikeMarker =
      width <= 40 ||
      height <= 40 ||
      /\b(red|dot|pog|pushpin|marker|locator)\b/i.test(source) ||
      /\b(red|dot|pog|pushpin|marker|locator)\b/i.test(alt);

    if (!looksLikeMarker) return;

    const wrapper = image.closest<HTMLElement>("a, span, div");

    if (wrapper && wrapper !== panel && !wrapper.contains(mapImage)) {
      wrapper.remove();
      return;
    }

    image.remove();
  });

  const label = panel.closest<HTMLElement>(".reader-location-map-switcher")
    ?.closest<HTMLElement>(".infobox")
    ?.querySelector<HTMLElement>(".infobox-title, .infobox-above, caption")
    ?.textContent?.replace(/\s+/g, " ").trim();

  if (!label) return;

  panel.querySelectorAll<HTMLElement>("a, span, div").forEach((element) => {
    if (element.querySelector("img")) return;
    if (element.closest(".reader-location-map-controls")) return;

    const text = element.textContent?.replace(/\s+/g, " ").trim();

    if (text === label) {
      element.remove();
    }
  });

  Array.from(panel.childNodes).forEach((node) => {
    if (node.nodeType !== Node.TEXT_NODE) return;

    const text = node.textContent?.replace(/\s+/g, " ").trim();

    if (text === label) {
      node.remove();
    }
  });
}

function readerShortLocationMapLabel(label: string) {
  const cleaned = label.replace(/\s+/g, " ").trim();

  if (!cleaned) return "";

  const withoutParentheses = cleaned.replace(/\s*\([^)]*\)\s*$/, "").trim();
  const firstPart = withoutParentheses.split(",")[0]?.trim();

  return firstPart || withoutParentheses || cleaned;
}


function normalizeReaderLocationMapLabel(label: string) {
  return label.replace(/\s+/g, " ").trim().toLowerCase();
}

function readerLocationMapTextCandidates(panel: HTMLElement) {
  const candidates: string[] = [];

  panel
    .querySelectorAll<HTMLElement>("a, span, div, p, center, small, b, strong")
    .forEach((element) => {
      if (element.closest(".reader-location-map-controls")) return;
      if (element.closest(".reader-calculated-location-marker")) return;
      if (element.querySelector("img")) return;

      const text = element.textContent?.replace(/\s+/g, " ").trim() ?? "";

      if (text) candidates.push(text);
    });

  Array.from(panel.childNodes).forEach((node) => {
    if (node.nodeType !== Node.TEXT_NODE) return;

    const text = node.textContent?.replace(/\s+/g, " ").trim() ?? "";

    if (text) candidates.push(text);
  });

  return Array.from(new Set(candidates));
}

function readerBestLocationMapPinLabel(
  panel: HTMLElement,
  pageTitle: string,
  fallbackLabel: string,
) {
  const fallback = readerShortLocationMapLabel(pageTitle || fallbackLabel);
  const normalizedFallback = normalizeReaderLocationMapLabel(fallback);

  const candidates = readerLocationMapTextCandidates(panel)
    .map(readerShortLocationMapLabel)
    .filter((candidate) => {
      const normalized = normalizeReaderLocationMapLabel(candidate);

      if (!normalized) return false;
      if (normalized.length > 45) return false;
      if (/show map|openstreetmap|coordinates|location in/i.test(candidate)) return false;

      return (
        normalized === normalizedFallback ||
        normalizedFallback.includes(normalized) ||
        normalized.includes(normalizedFallback)
      );
    });

  return candidates[0] || fallback;
}

function cleanupReaderLocationMapTextLabels(
  panel: HTMLElement,
  pinLabel: string,
) {
  const normalizedPinLabel = normalizeReaderLocationMapLabel(pinLabel);

  panel
    .querySelectorAll<HTMLElement>("a, span, div, p, center, small, b, strong")
    .forEach((element) => {
      if (element.closest(".reader-location-map-controls")) return;
      if (element.closest(".reader-calculated-location-marker")) return;
      if (element.querySelector("img")) return;

      const text = element.textContent?.replace(/\s+/g, " ").trim() ?? "";
      const normalizedText = normalizeReaderLocationMapLabel(text);

      if (!normalizedText) return;

      const isDuplicateLabel =
        normalizedText === normalizedPinLabel ||
        normalizedText.startsWith(normalizedPinLabel + " ") ||
        normalizedPinLabel.startsWith(normalizedText + " ");

      if (isDuplicateLabel) {
        element.remove();
      }
    });

  Array.from(panel.childNodes).forEach((node) => {
    if (node.nodeType !== Node.TEXT_NODE) return;

    const text = node.textContent?.replace(/\s+/g, " ").trim() ?? "";
    const normalizedText = normalizeReaderLocationMapLabel(text);

    if (!normalizedText) return;

    if (
      normalizedText === normalizedPinLabel ||
      normalizedText.startsWith(normalizedPinLabel + " ") ||
      normalizedPinLabel.startsWith(normalizedText + " ")
    ) {
      node.remove();
    }
  });
}


function placeReaderCalculatedLocationMapMarkers(document: Document, pageTitle = "") {
  const coordinate = getReaderDocumentCoordinates(document);
  if (!coordinate) return;

  const fallbackPageLabel = readerShortLocationMapLabel(
    pageTitle ||
      document
        .querySelector<HTMLElement>(".infobox-title, .infobox-above, caption")
        ?.textContent?.replace(/\s+/g, " ")
        .trim() ||
      "",
  );

  document
    .querySelectorAll<HTMLElement>(".reader-calculated-location-marker")
    .forEach((marker) => marker.remove());

  document
    .querySelectorAll<HTMLElement>(".reader-location-map-panel")
    .forEach((panel) => {
      const mapLabel = readerLocationMapLabelForPanel(panel);
      const mapImage = readerLargestMapImage(panel);

      if (!mapImage) return;

      const projectionLabel = [
        mapLabel,
        mapImage.getAttribute("alt") || "",
        mapImage.getAttribute("title") || "",
        mapImage.getAttribute("src") || "",
      ].join(" ");

      const point = projectReaderLocationMapPoint(projectionLabel, coordinate);

      // Remove the broken original marker even when we do not recognize the map.
      // Wrong dots are worse than no dots.
      cleanupOriginalLocationMapMarker(panel, mapImage);

      if (!point) return;

      if (
        point.x < -5 ||
        point.x > 105 ||
        point.y < -5 ||
        point.y > 105
      ) {
        return;
      }

      const pinLabel = readerBestLocationMapPinLabel(
        panel,
        pageTitle,
        fallbackPageLabel,
      );

      cleanupOriginalLocationMapMarker(panel, mapImage);
      cleanupReaderLocationMapTextLabels(panel, pinLabel);

      let host = mapImage.closest<HTMLElement>(
        ".reader-calculated-location-image-wrap",
      );

      if (!host) {
        host = document.createElement("span");
        host.className = "reader-calculated-location-image-wrap";

        mapImage.parentNode?.insertBefore(host, mapImage);
        host.append(mapImage);
      }

      host.classList.add("reader-calculated-location-map-host");

      const marker = document.createElement("div");
      marker.className = "reader-calculated-location-marker";
      marker.style.left = `${point.x}%`;
      marker.style.top = `${point.y}%`;

      const dot = document.createElement("span");
      dot.className = "reader-calculated-location-dot";

      const name = document.createElement("span");
      name.className = "reader-calculated-location-label";
      name.textContent = pinLabel;

      marker.append(dot, name);
      host.append(marker);
    });
}

function upgradeReaderClimateTables(document: Document) {
  document.querySelectorAll<HTMLTableElement>("table").forEach((table) => {
    const caption = table.querySelector<HTMLElement>("caption");
    const title = caption?.textContent?.replace(/\s+/g, " ").trim() ?? "";
    const sampleText = table.textContent?.replace(/\s+/g, " ").trim().slice(0, 500) ?? "";

    if (!/climate data/i.test(title || sampleText)) return;

    table.classList.add("reader-climate-table");

    table.querySelectorAll<HTMLTableRowElement>("tr").forEach((row) => {
      const label =
        row.querySelector<HTMLElement>("th, td")?.textContent?.toLowerCase() ?? "";

      if (label.includes("record high")) row.classList.add("reader-climate-hot-extreme");
      else if (label.includes("mean maximum")) row.classList.add("reader-climate-hot-strong");
      else if (label.includes("mean daily maximum")) row.classList.add("reader-climate-hot");
      else if (label.includes("daily mean")) row.classList.add("reader-climate-neutral");
      else if (label.includes("mean daily minimum")) row.classList.add("reader-climate-cold");
      else if (label.includes("mean minimum")) row.classList.add("reader-climate-cold-strong");
      else if (label.includes("record low")) row.classList.add("reader-climate-cold-extreme");
      else if (label.includes("precipitation")) row.classList.add("reader-climate-wet");
      else if (label.includes("snow")) row.classList.add("reader-climate-snow");
      else if (label.includes("humidity") || label.includes("dew point")) row.classList.add("reader-climate-humidity");
    });

    if (table.closest(".reader-climate-details")) return;

    const details = document.createElement("details");
    details.className = "reader-climate-details";
    details.open = false;

    const summary = document.createElement("summary");

    const summaryTitle = document.createElement("span");
    summaryTitle.className = "reader-climate-title";
    summaryTitle.textContent = title || "Climate data";

    const toggle = document.createElement("span");
    toggle.className = "reader-climate-toggle";
    toggle.setAttribute("aria-hidden", "true");

    summary.append(summaryTitle, toggle);

    table.parentNode?.insertBefore(details, table);
    details.append(summary);

    caption?.remove();
    details.append(table);
  });
}



function readerMultipleImagePixelWidthFromStyle(element: HTMLElement) {
  const style = element.getAttribute("style") || "";
  const match = style.match(/(?:^|;)\s*(?:width|max-width)\s*:\s*(\d+(?:\.\d+)?)px/i);

  if (match?.[1]) {
    const value = Number.parseFloat(match[1]);
    if (Number.isFinite(value)) return value;
  }

  const widthAttribute = element.getAttribute("width");
  if (widthAttribute) {
    const value = Number.parseFloat(widthAttribute);
    if (Number.isFinite(value)) return value;
  }

  return 0;
}

function readerMultipleImagePixelWidthFromMedia(media: HTMLElement) {
  const widthAttribute = media.getAttribute("width");
  if (widthAttribute) {
    const value = Number.parseFloat(widthAttribute);
    if (Number.isFinite(value) && value > 0) return value;
  }

  return readerMultipleImagePixelWidthFromStyle(media);
}

function readerMultipleImageAlignment(block: HTMLElement, source: HTMLElement) {
  const candidates = [
    block,
    source,
    block.querySelector<HTMLElement>(".multiimageinner, .thumbinner"),
    block.parentElement,
  ].filter((candidate): candidate is HTMLElement => Boolean(candidate));

  for (const candidate of candidates) {
    const classText = candidate.className?.toString() ?? "";
    const styleText = candidate.getAttribute("style") ?? "";

    if (/\b(tleft|floatleft|mw-halign-left|thumbleft)\b/i.test(classText)) {
      return "left";
    }

    if (/\b(tright|floatright|mw-halign-right|thumbright)\b/i.test(classText)) {
      return "right";
    }

    if (/\b(tnone|center|mw-halign-center|thumbcenter)\b/i.test(classText)) {
      return "center";
    }

    if (/float\s*:\s*left/i.test(styleText)) {
      return "left";
    }

    if (/float\s*:\s*right/i.test(styleText)) {
      return "right";
    }

    if (
      /margin-left\s*:\s*auto/i.test(styleText) &&
      /margin-right\s*:\s*auto/i.test(styleText)
    ) {
      return "center";
    }

    if (
      /margin-left\s*:\s*0/i.test(styleText) &&
      /margin-right\s*:\s*auto/i.test(styleText)
    ) {
      return "left";
    }
  }

  const leftAncestor = source.closest(".tleft, .floatleft, .mw-halign-left, .thumbleft");
  if (leftAncestor && block.contains(leftAncestor)) {
    return "left";
  }

  const rightAncestor = source.closest(".tright, .floatright, .mw-halign-right, .thumbright");
  if (rightAncestor && block.contains(rightAncestor)) {
    return "right";
  }

  const centerAncestor = source.closest(".tnone, .center, .mw-halign-center, .thumbcenter");
  if (centerAncestor && block.contains(centerAncestor)) {
    return "center";
  }

  return "center";
}

function markReaderMultipleImageBlocks(document: Document) {
  document
    .querySelectorAll<HTMLElement>(".tmulti, .thumb.tmulti, .multiimageinner")
    .forEach((element) => {
      if (element.closest(".infobox")) return;

      const block =
        element.closest<HTMLElement>(".thumb.tmulti, .tmulti") || element;

      if (block.closest(".infobox")) return;

      block.classList.add("reader-multiple-image-block");
      block.classList.remove(
        "reader-multiple-image-left",
        "reader-multiple-image-right",
        "reader-multiple-image-center",
      );

      const alignment = readerMultipleImageAlignment(block, element);

      if (alignment === "left") {
        block.classList.add("reader-multiple-image-left");
      } else if (alignment === "right") {
        block.classList.add("reader-multiple-image-right");
      } else {
        block.classList.add("reader-multiple-image-center");
      }

      const inner =
        block.querySelector<HTMLElement>(".multiimageinner, .thumbinner") || block;

      const rows = Array.from(block.querySelectorAll<HTMLElement>(".trow"));

      block.classList.remove(
        "reader-multiple-image-count-1",
        "reader-multiple-image-count-2",
        "reader-multiple-image-count-3",
        "reader-multiple-image-count-4",
        "reader-multiple-image-count-5",
        "reader-multiple-image-count-6",
        "reader-multiple-image-mixed-media",
        "reader-multiple-image-vertical",
      );

      const itemCountsByRow = rows
        .map((row) => row.querySelectorAll<HTMLElement>(".tsingle").length)
        .filter((count) => count > 0);
      const maxRowItemCount = Math.max(1, ...itemCountsByRow);
      const columnCount = Math.min(Math.max(maxRowItemCount, 1), 6);
      const isVerticalMultipleImage = rows.length > 1 && columnCount === 1;

      if (isVerticalMultipleImage) {
        block.classList.add("reader-multiple-image-vertical");
      }

      const hasVideo = Boolean(block.querySelector("video"));
      const hasImage = Boolean(block.querySelector("img"));

      if (hasVideo && hasImage) {
        block.classList.add("reader-multiple-image-mixed-media");
      }

      block.classList.add(`reader-multiple-image-count-${columnCount}`);
      block.style.setProperty("--reader-multiple-image-columns", String(columnCount));

      const rowWidths = rows.map((row) => {
        const rowMedia = Array.from(
          row.querySelectorAll<HTMLElement>("img, video"),
        );
        const mediaWidthTotal = rowMedia.reduce(
          (sum, media) => sum + readerMultipleImagePixelWidthFromMedia(media),
          0,
        );

        return mediaWidthTotal + Math.max(0, rowMedia.length - 1) * 4;
      });

      const imageWidth =
        Math.max(0, ...rowWidths) ||
        Array.from(
          block.querySelectorAll<HTMLElement>("img, video"),
        ).reduce(
          (sum, media) => sum + readerMultipleImagePixelWidthFromMedia(media),
          0,
        );

      const declaredWidth =
        readerMultipleImagePixelWidthFromStyle(block) ||
        readerMultipleImagePixelWidthFromStyle(inner);

      const desiredWidth = Math.round(
        Math.min(Math.max(declaredWidth || imageWidth + 14 || 460, 160), 720),
      );

      const horizontalWidth = Math.round(
        Math.max(declaredWidth || imageWidth + 12 || 460, 160),
      );

      const horizontalGalleryWidth = isVerticalMultipleImage
        ? `${desiredWidth}px`
        : `${horizontalWidth}px`;

      block.style.setProperty(
        "--reader-multiple-image-width",
        horizontalGalleryWidth,
      );
      block.style.setProperty("width", horizontalGalleryWidth, "important");
      block.style.setProperty("max-width", "100%", "important");

      inner.style.setProperty(
        "--reader-multiple-image-width",
        horizontalGalleryWidth,
      );
      inner.style.setProperty("width", horizontalGalleryWidth, "important");
      inner.style.setProperty("max-width", "100%", "important");

      const rowWidth = columnCount > 1 ? "100%" : "max-content";

      rows.forEach((row) => {
        row.style.setProperty("width", rowWidth, "important");
        row.style.setProperty("max-width", "100%", "important");
      });

      block
        .querySelectorAll<HTMLImageElement>("img")
        .forEach((image) => {
          image.classList.add("reader-multiple-image-img");
        });
    });
}

async function upgradeReaderMultipleImageSources(document: Document) {
  const images = Array.from(
    document.querySelectorAll<HTMLImageElement>(
      ".reader-multiple-image-block img",
    ),
  ).filter((image) => image.dataset.readerMultipleImageSourceReady !== "true");

  await Promise.all(
    images.map(async (image) => {
      const source = image.currentSrc || image.src;
      if (!source.includes("upload.wikimedia.org/wikipedia/commons/thumb/")) {
        image.dataset.readerMultipleImageSourceReady = "true";
        return;
      }

      const parts = decodeURIComponent(new URL(source).pathname).split("/");
      const thumbnailIndex = parts.findIndex((part) => /^\d+px-/i.test(part));
      const fileName = thumbnailIndex > 0 ? parts[thumbnailIndex - 1] : null;
      if (!fileName) return;

      try {
        const parameters = new URLSearchParams({
          origin: "*",
          action: "query",
          titles: `File:${fileName}`,
          prop: "imageinfo",
          iiprop: "url|size",
          iiurlwidth: "1600",
          format: "json",
          formatversion: "2",
        });

        const response = await wikipediaApiFetch(
          `https://en.wikipedia.org/w/api.php?${parameters}`,
        );
        if (!response.ok) return;

        const data = (await response.json()) as {
          query?: {
            pages?: Array<{
              imageinfo?: Array<{ thumburl?: string; url?: string }>;
            }>;
          };
        };
        const imageInfo = data.query?.pages?.[0]?.imageinfo?.[0];
        const highResolutionSource = imageInfo?.thumburl || imageInfo?.url;

        if (highResolutionSource) {
          image.src = highResolutionSource;
        }
        image.dataset.readerMultipleImageSourceReady = "true";
      } catch {
        // Keep the parser-provided thumbnail if Wikimedia metadata is unavailable.
      }
    }),
  );
}

function readerApplyMultipleImageAspectRatios(document: Document) {
  const apply = () => {
    document.querySelectorAll<HTMLElement>(".reader-multiple-image-block").forEach((block) => {
      block.querySelectorAll<HTMLElement>(".trow").forEach((row) => {
        const cells = [...row.querySelectorAll<HTMLElement>(".tsingle")];
        const media = cells
          .map((cell) => cell.querySelector<HTMLImageElement | HTMLVideoElement>("img, video"))
          .filter((item): item is HTMLImageElement | HTMLVideoElement => Boolean(item));

        if (media.length < 2) return;

        const ratios = media.map((item) => {
          const width = item instanceof HTMLVideoElement ? item.videoWidth : item.naturalWidth;
          const height = item instanceof HTMLVideoElement ? item.videoHeight : item.naturalHeight;
          return width > 0 && height > 0 ? width / height : 0;
        });

        if (ratios.some((ratio) => ratio <= 0)) return;

        block.style.setProperty("box-sizing", "border-box", "important");
        block.style.setProperty("padding", "4px", "important");
        row.style.setProperty("display", "flex", "important");
        row.style.setProperty("flex-wrap", "nowrap", "important");
        row.style.setProperty("justify-content", "flex-start", "important");
        row.style.setProperty("gap", "4px", "important");
        row.style.setProperty("width", "100%", "important");
        row.style.setProperty("grid-template-columns", "none", "important");

        const inner = block.querySelector<HTMLElement>(
          ".thumbinner, .multiimageinner",
        );
        inner?.style.setProperty("width", "100%", "important");
        inner?.style.setProperty("padding", "0", "important");

        const rowWidth = inner?.getBoundingClientRect().width ?? block.getBoundingClientRect().width;
        const gap = 4;
        const usableWidth = rowWidth - Math.max(0, media.length - 1) * gap;
        const sharedHeight = usableWidth / ratios.reduce((sum, ratio) => sum + ratio, 0);
        const widths = ratios.map((ratio) => ratio * sharedHeight);
        row.style.setProperty("--reader-multiple-image-grid-template", widths.map((width) => String(width) + "px").join(" "));
        row.style.setProperty("--reader-multiple-image-row-height", String(sharedHeight) + "px");
        row.classList.add("reader-multiple-image-aspect-ratio-ready");

        cells.forEach((cell, index) => {
          const width = widths[index];
          cell.style.setProperty("flex", `0 0 ${width}px`, "important");
          cell.style.setProperty("width", `${width}px`, "important");
          cell.style.setProperty("min-width", "0", "important");
          cell.style.setProperty("max-width", `${width}px`, "important");
          cell.style.setProperty("height", "auto", "important");
          cell.style.setProperty("overflow", "visible", "important");

          const wrapper = cell.querySelector<HTMLElement>(".thumbimage");
          if (wrapper) {
            wrapper.style.setProperty("width", `${width}px`, "important");
            wrapper.style.setProperty("height", `${sharedHeight}px`, "important");
            wrapper.style.setProperty("aspect-ratio", "auto", "important");
            wrapper.style.setProperty("overflow", "hidden", "important");
          }

          cell.querySelectorAll<HTMLElement>(
            ".thumbimage > span, .thumbimage > span > a, .mw-file-description",
          ).forEach((element) => {
            element.style.setProperty("width", `${width}px`, "important");
            element.style.setProperty("height", `${sharedHeight}px`, "important");
            element.style.setProperty("max-width", `${width}px`, "important");
            element.style.setProperty("max-height", `${sharedHeight}px`, "important");
          });

          cell.querySelectorAll<HTMLElement>(".thumbcaption, figcaption").forEach((caption) => {
            caption.style.setProperty("width", `${width}px`, "important");
            caption.style.setProperty("text-align", "left", "important");
            caption.style.setProperty("white-space", "normal", "important");
          });
        });

        media.forEach((item) => {
          item.style.setProperty("width", "100%", "important");
          item.style.setProperty("height", "100%", "important");
          item.style.setProperty("max-height", "none", "important");
          item.style.setProperty("object-fit", "fill", "important");
        });
      });
    });
  };

  void upgradeReaderMultipleImageSources(document).then(apply);
  apply();
  window.requestAnimationFrame(apply);

  document.querySelectorAll<HTMLImageElement | HTMLVideoElement>(
    ".reader-multiple-image-block img, .reader-multiple-image-block video",
  ).forEach((media) => {
    if (media.dataset.readerAspectRatioBound === "true") return;
    media.dataset.readerAspectRatioBound = "true";
    media.addEventListener("load", apply);
    media.addEventListener("loadedmetadata", apply);
    if ((media instanceof HTMLImageElement && media.complete) || (media instanceof HTMLVideoElement && media.readyState >= 1)) apply();
  });

  document.querySelectorAll<HTMLElement>(".reader-multiple-image-block").forEach((block) => {
    if (block.dataset.readerAspectRatioContainerObserved === "true") return;
    block.dataset.readerAspectRatioContainerObserved = "true";

    let lastWidth = block.getBoundingClientRect().width;
    let resizeFrame = 0;
    const resizeObserver = new ResizeObserver(() => {
      const nextWidth = block.getBoundingClientRect().width;
      if (Math.abs(nextWidth - lastWidth) < 0.5) return;

      lastWidth = nextWidth;
      if (resizeFrame) window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = 0;
        apply();
      });
    });
    resizeObserver.observe(block);
  });
}

function readerApplyInfoboxMultipleImageAspectRatios(document: Document) {
  const apply = () => {
    document
      .querySelectorAll<HTMLElement>(
        ".reader-article .infobox .tmulti .multiimageinner",
      )
      .forEach((inner) => {
        const rows = [...inner.querySelectorAll<HTMLElement>(":scope > .trow")];

        inner.style.setProperty("display", "flex", "important");
        inner.style.setProperty("flex-direction", "column", "important");
        inner.style.setProperty("width", "100%", "important");
        inner.style.setProperty("padding", "0", "important");

        rows.forEach((row) => {
          const cells = [...row.querySelectorAll<HTMLElement>(":scope > .tsingle")];
          const media = cells
            .map((cell) => cell.querySelector<HTMLImageElement>("img"))
            .filter((image): image is HTMLImageElement => Boolean(image));

          if (media.length < 2) return;

          const ratios = media.map((image) =>
            image.naturalWidth > 0 && image.naturalHeight > 0
              ? image.naturalWidth / image.naturalHeight
              : 0,
          );
          if (ratios.some((ratio) => ratio <= 0)) return;

          const gap = 6;
          const rowWidth = row.getBoundingClientRect().width;
          if (rowWidth <= 0) return;
          const usableWidth = Math.max(0, rowWidth - gap * (cells.length - 1));
          const sharedHeight =
            usableWidth / ratios.reduce((sum, ratio) => sum + ratio, 0);
          const widths = ratios.map((ratio) => ratio * sharedHeight);

          row.style.setProperty("display", "flex", "important");
          row.style.setProperty("flex-wrap", "nowrap", "important");
          row.style.setProperty("gap", `${gap}px`, "important");
          row.style.setProperty("width", "100%", "important");
          row.style.setProperty("margin-bottom", `${gap}px`, "important");

          cells.forEach((cell, index) => {
            const width = widths[index];
            cell.style.setProperty("display", "block", "important");
            cell.style.setProperty("flex", `0 0 ${width}px`, "important");
            cell.style.setProperty("width", `${width}px`, "important");
            cell.style.setProperty("max-width", `${width}px`, "important");
            cell.style.setProperty("min-width", "0", "important");
            cell.style.setProperty("margin", "0", "important");

            const wrapper = cell.firstElementChild;
            if (wrapper instanceof HTMLElement) {
              wrapper.style.setProperty("display", "block", "important");
              wrapper.style.setProperty("width", `${width}px`, "important");
              wrapper.style.setProperty("height", `${sharedHeight}px`, "important");
              wrapper.style.setProperty("overflow", "hidden", "important");
            }

            const image = media[index];
            image.style.setProperty("display", "block", "important");
            image.style.setProperty("width", "100%", "important");
            image.style.setProperty("height", "100%", "important");
            image.style.setProperty("max-width", "none", "important");
            image.style.setProperty("object-fit", "fill", "important");

            const renderedImageHeight = image.getBoundingClientRect().height;
            if (wrapper instanceof HTMLElement && renderedImageHeight > 0) {
              wrapper.style.setProperty(
                "display",
                "inline-block",
                "important",
              );
              wrapper.style.setProperty(
                "height",
                `${renderedImageHeight}px`,
                "important",
              );
              wrapper.style.setProperty("vertical-align", "top", "important");
              wrapper.style.setProperty("overflow", "visible", "important");
            }
          });
        });

        const cell = inner.closest<HTMLElement>("td, th");
        const caption = cell?.querySelector<HTMLElement>(":scope > .hlist");
        const list = caption?.querySelector<HTMLElement>(":scope > ul");

        cell?.style.setProperty("line-height", "1.5", "important");
        caption?.style.setProperty("display", "block", "important");
        caption?.style.setProperty("width", "100%", "important");
        caption?.style.setProperty("line-height", "1.36", "important");
        caption?.style.setProperty("text-align", "center", "important");
        list?.style.setProperty("margin", "0", "important");
        list?.style.setProperty("padding", "0", "important");
        list?.style.setProperty("text-align", "center", "important");
      });
  };

  apply();
  window.requestAnimationFrame(apply);

  document
    .querySelectorAll<HTMLImageElement>(
      ".reader-article .infobox .tmulti .multiimageinner img",
    )
    .forEach((image) => {
      if (image.dataset.readerInfoboxAspectRatioBound === "true") return;
      image.dataset.readerInfoboxAspectRatioBound = "true";
      image.addEventListener("load", apply);
    });

  document
    .querySelectorAll<HTMLElement>(
      ".reader-article .infobox .reader-election-candidate-photo-cell .multiimageinner > .trow",
    )
    .forEach((row) => new ResizeObserver(apply).observe(row));
}

function readerCleanImageMapTextContent(text: string) {
  return text
    .replace(/\[\s*edit\s*\]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function readerLooksLikeCanadaProvinceCodeText(text: string) {
  const clean = readerCleanImageMapTextContent(text);
  if (!clean || clean.length > 90) return false;

  const tokens = clean.split(/\s+/).filter(Boolean);
  if (tokens.length < 5 || tokens.length > 16) return false;

  const provinceCodes = new Set([
    "BC", "AB", "SK", "MB", "ON", "QC", "NB", "PE", "NS", "NL", "YT", "NT", "NU",
  ]);

  return tokens.every((token) => provinceCodes.has(token.toUpperCase()));
}

function readerLooksLikeCanadaMapText(text: string) {
  return /Communities by provinces and territories of Canada/i.test(text);
}

function readerIsCanadaProvinceMapImage(image: HTMLImageElement) {
  const source = image.getAttribute("src") || image.src || "";
  const alt = image.getAttribute("alt") || "";
  const title = image.getAttribute("title") || "";

  return (
    /Political[_ ]map[_ ]of[_ ]Canada/i.test(source) ||
    /Political[_ ]map[_ ]of[_ ]Canada/i.test(alt) ||
    /Political[_ ]map[_ ]of[_ ]Canada/i.test(title) ||
    /Canada.*Political/i.test(alt)
  );
}

function readerRemoveNearbyCanadaMapLooseText(
  block: HTMLElement,
  captionText: string,
) {
  const shouldRemoveLooseNode = (element: HTMLElement) => {
    if (element.querySelector("img, table, figure, .thumb, .mw-default-size")) return false;

    const text = readerCleanImageMapTextContent(element.textContent || "");

    return (
      readerLooksLikeCanadaProvinceCodeText(text) ||
      text === captionText ||
      readerLooksLikeCanadaMapText(text)
    );
  };

  let previous = block.previousElementSibling as HTMLElement | null;
  let previousSteps = 0;

  while (previous && previousSteps < 8) {
    if (previous.matches("h1, h2, h3, h4, .mw-heading")) break;

    const nextPrevious = previous.previousElementSibling as HTMLElement | null;

    if (shouldRemoveLooseNode(previous)) {
      previous.remove();
    }

    previous = nextPrevious;
    previousSteps += 1;
  }

  let next = block.nextElementSibling as HTMLElement | null;
  let nextSteps = 0;

  while (next && nextSteps < 4) {
    if (next.matches("h1, h2, h3, h4, .mw-heading, table, p")) break;

    const nextNext = next.nextElementSibling as HTMLElement | null;

    if (shouldRemoveLooseNode(next)) {
      next.remove();
    }

    next = nextNext;
    nextSteps += 1;
  }
}


function readerIsGuiyangAdministrativeDivisionMapImage(
  image: HTMLImageElement,
) {
  const source = image.getAttribute("src") || image.src || "";
  const alt = image.getAttribute("alt") || "";
  const title = image.getAttribute("title") || "";

  return (
    /Administrative[_ ]Division[_ ]Guiyang/i.test(source) ||
    /Administrative[_ ]Division[_ ]Guiyang/i.test(alt) ||
    /Administrative[_ ]Division[_ ]Guiyang/i.test(title)
  );
}

function markReaderGuiyangAdministrativeDivisionMap(document: Document) {
  const sourceWidth = 2300;
  const sourceHeight = 2580;

  const labels = [
    { match: "Nanming", x: 1150, y: 1790 },
    { match: "Yunyan", x: 1100, y: 1670 },
    { match: "Huaxi", x: 1020, y: 2120 },
    { match: "Wudang", x: 1430, y: 1330 },
    { match: "Guanshanhu", x: 710, y: 1580 },
    { match: "Baiyun", x: 1030, y: 1380 },
    { match: "Kaiyang", x: 1700, y: 660 },
    { match: "Xifeng", x: 1020, y: 510 },
    { match: "Xiuwen", x: 890, y: 1000 },
    { match: "Qingzhen", x: 310, y: 1480 },
  ];

  document.querySelectorAll<HTMLImageElement>("img").forEach((image) => {
    if (
      !readerIsGuiyangAdministrativeDivisionMapImage(image) ||
      image.closest(".reader-guiyang-map")
    ) {
      return;
    }

    const cell = image.closest<HTMLTableCellElement>("td");
    const media = image.closest<HTMLAnchorElement>("a") || image;
    const host = media.parentElement;

    if (!cell || !host) return;

    const sourceLinks = [...cell.querySelectorAll<HTMLAnchorElement>("a")]
      .filter((link) => !link.querySelector("img"));

    const placedLabels = labels.flatMap((definition) => {
      const original = sourceLinks.find((link) =>
        link.textContent?.replace(/\s+/g, "").includes(definition.match),
      );

      return original ? [{ definition, original }] : [];
    });

    if (placedLabels.length === 0) return;

    const wrapper = document.createElement("span");
    wrapper.className = "reader-guiyang-map";

    const layer = document.createElement("span");
    layer.className = "reader-guiyang-map-label-layer";

    placedLabels.forEach(({ definition, original }) => {
      const sourceRow = original.parentElement;

      if (sourceRow?.tagName === "DIV") {
        sourceRow.classList.add("reader-guiyang-map-label-source");
      }

      const label = original.cloneNode(true) as HTMLAnchorElement;
      label.removeAttribute("style");
      label.classList.add("reader-guiyang-map-label");
      label.style.setProperty(
        "--reader-guiyang-map-label-x",
        `${(definition.x / sourceWidth) * 100}%`,
      );
      label.style.setProperty(
        "--reader-guiyang-map-label-y",
        `${(definition.y / sourceHeight) * 100}%`,
      );

      layer.append(label);
    });

    host.insertBefore(wrapper, media);
    wrapper.append(media);
    wrapper.append(layer);
  });
}


function markReaderImageMapFallbacks(document: Document) {
  document.querySelectorAll<HTMLImageElement>("img").forEach((image) => {
    if (!readerIsCanadaProvinceMapImage(image)) return;

    const block =
      image.closest<HTMLElement>(
        "figure, .thumb, .mw-default-size, .noresize, .floatright, .tright, .tnone, .center, .mw-halign-right, .mw-halign-left",
      ) || image.parentElement;

    if (
      !block ||
      block === document.body ||
      block.closest(".infobox, .navbox, .vertical-navbox")
    ) {
      return;
    }

    const originalText = block.textContent || "";
    const captionText = /Communities by provinces and territories of Canada/i.test(originalText)
      ? "Communities by provinces and territories of Canada"
      : image.getAttribute("alt") || "";

    const figure = document.createElement("figure");
    figure.className = "reader-canada-provinces-map";

    const link = image.closest<HTMLAnchorElement>("a");
    const media = link && block.contains(link) ? link : image;

    figure.appendChild(media);

    if (captionText) {
      const caption = document.createElement("figcaption");
      caption.className = "reader-canada-provinces-map-caption";
      caption.textContent = captionText;
      figure.appendChild(caption);
    }

    block.replaceWith(figure);
    readerRemoveNearbyCanadaMapLooseText(figure, captionText);
  });
}


function markReaderLeadParagraph(document: Document) {
  document
    .querySelectorAll<HTMLElement>(".reader-lead-paragraph, .reader-lead-body-item")
    .forEach((element) => {
      element.classList.remove("reader-lead-paragraph");
      element.classList.remove("reader-lead-body-item");
    });

  const excludedSelector =
    ".reader-coordinates, .reader-coordinates-top, .infobox, table.infobox, style, script, figure, .thumb, .mw-default-size, .reader-demographic-box, .reader-climate-details, .reader-navbox-details, .reader-preserved-sidebar, .reader-layout-table, table.reader-layout-table";

  let current = document.body.firstElementChild as HTMLElement | null;
  let markedFirstParagraph = false;

  while (current) {
    const next = current.nextElementSibling as HTMLElement | null;

    if (current.matches(excludedSelector)) {
      current = next;
      continue;
    }

    if (current.matches("h2, h3, h4")) {
      break;
    }

    const text = current.textContent?.replace(/\s+/g, " ").trim() ?? "";

    if (text !== "" && current.matches("p, ul, ol, dl, blockquote, .hatnote, .rellink, .dablink")) {
      current.classList.add("reader-lead-body-item");

      if (!markedFirstParagraph && current.matches("p")) {
        current.classList.add("reader-lead-paragraph");
        markedFirstParagraph = true;
      }
    }

    current = next;
  }

  if (!markedFirstParagraph) {
    const firstParagraph = Array.from(
      document.querySelectorAll<HTMLElement>("p"),
    ).find((paragraph) => {
      return !paragraph.closest(excludedSelector) && (paragraph.textContent?.trim() ?? "") !== "";
    });

    firstParagraph?.classList.add("reader-lead-paragraph", "reader-lead-body-item");
  }
}

function removeReaderHatnotes(document: Document) {
  // Remove only top/disambiguation hatnotes.
  // Keep useful section hatnotes such as "Main article:" and "See also:".
  document
    .querySelectorAll<HTMLElement>(".reader-lead-notes")
    .forEach((element) => element.remove());

  document
    .querySelectorAll<HTMLElement>(".reader-lead-meta")
    .forEach((row) => {
      const coordinates = row.querySelector<HTMLElement>(".reader-coordinates");
      if (coordinates && row.parentElement) {
        row.parentElement.insertBefore(coordinates, row);
      }
      row.remove();
    });

  const disambiguationTextPattern =
    /\b(redirects? here|redirects? to|not to be confused|for other uses|may refer to|is sometimes used for)\b/i;

  document
    .querySelectorAll<HTMLElement>(".hatnote, .rellink, .dablink")
    .forEach((element) => {
      const text = element.textContent?.replace(/\s+/g, " ").trim() ?? "";

      if (disambiguationTextPattern.test(text)) {
        element.remove();
      }
    });
}

async function loadWikipediaCoordinatesHtml(
  title: string,
  signal: AbortSignal,
) {
  const url = new URL("https://en.wikipedia.org/w/api.php");

  url.searchParams.set("origin", "*");
  url.searchParams.set("format", "json");
  url.searchParams.set("action", "query");
  url.searchParams.set("prop", "coordinates");
  url.searchParams.set("titles", title);
  url.searchParams.set("colimit", "1");

  try {
    const response = await wikipediaApiFetch(
      url.toString(),
      { signal },
    );
    if (!response.ok) return "";

    const data = (await response.json()) as {
      query?: {
        pages?: Record<
          string,
          { coordinates?: Array<{ lat?: number; lon?: number }> }
        >;
      };
    };

    const page = Object.values(data.query?.pages || {})[0];
    const coordinate = page?.coordinates?.[0];
    const lat = Number(coordinate?.lat);
    const lon = Number(coordinate?.lon);

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return "";

    const display = `${formatReaderCoordinate(lat, "N", "S")} ${formatReaderCoordinate(
      lon,
      "E",
      "W",
    )}`;
    const mapUrl = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=12/${lat}/${lon}`;

    return `<div class="reader-coordinates">Coordinates: <a href="${mapUrl}" target="_blank" rel="noopener noreferrer">${display}</a></div>`;
  } catch {
    return "";
  }
}

function formatReaderCoordinate(
  value: number,
  positiveHemisphere: string,
  negativeHemisphere: string,
) {
  return `${Math.abs(value).toFixed(4)}°${
    value >= 0 ? positiveHemisphere : negativeHemisphere
  }`;
}


interface ReaderPreservedVisualStyle {
  style: string;
  classNames: string[];
}

function sanitizeReaderVisualStyle(
  style: string,
  preservePositioning = false,
  preserveTreeChartConnectorBorders = false,
): ReaderPreservedVisualStyle {
  const variableDeclarations: string[] = [];
  const layoutDeclarations: string[] = [];
  const classNames = new Set<string>();
  let hasVisualColor = false;
  let preservedDisplay: "none" | "inline" | "inline-block" | "block" | null =
    null;

  const cleanValue = (value: string) =>
    value.replace(/!important/gi, "").trim();

  const hasUnsafeValue = (value: string) =>
    !value ||
    value.length > 120 ||
    /url\s*\(|expression\s*\(|javascript\s*:|behaviou?r\s*:/i.test(value);

  const isSafeCssNamedColor = (value: string) =>
    /^[a-z]{3,32}$/i.test(value) &&
    !/^(inherit|initial|unset|revert|revert-layer|none|auto)$/i.test(value);

  const isSafeLinearGradient = (value: string) =>
    /^linear-gradient\(\s*to\s+(?:right|left|top|bottom)\s*,\s*(?:#[0-9a-f]{3,8}|rgba?\([0-9.,%\s]+\)|hsla?\([0-9.,%\s]+\)|[a-z]{3,32})(?:\s*,\s*(?:#[0-9a-f]{3,8}|rgba?\([0-9.,%\s]+\)|hsla?\([0-9.,%\s]+\)|[a-z]{3,32})){1,15}\s*\)$/i.test(value);

  const isSafeColorValue = (value: string) => {
    const cleaned = cleanValue(value);
    if (hasUnsafeValue(cleaned)) return false;

    return (
      /^#[0-9a-f]{3,8}$/i.test(cleaned) ||
      /^rgba?\([0-9.,%\s]+\)$/i.test(cleaned) ||
      /^hsla?\([0-9.,%\s]+\)$/i.test(cleaned) ||
      isSafeLinearGradient(cleaned) ||
      isSafeCssNamedColor(cleaned)
    );
  };

  const isSafeBorderValue = (value: string) => {
    const cleaned = cleanValue(value);
    if (hasUnsafeValue(cleaned)) return false;

    return (
      isSafeCssNamedColor(cleaned) ||
      /#[0-9a-f]{3,8}\b/i.test(cleaned) ||
      /rgba?\(/i.test(cleaned) ||
      /hsla?\(/i.test(cleaned) ||
      /\b(red|green|blue|yellow|orange|purple|pink|gray|grey|black|white|brown|cyan|magenta|lime|navy|teal|olive|maroon|silver|gold)\b/i.test(cleaned)
    );
  };

  const isSafeLengthValue = (value: string) => {
    const cleaned = cleanValue(value);
    if (hasUnsafeValue(cleaned)) return false;
    return /^(?:0|\d{1,3}(?:\.\d{1,2})?(?:px|em|rem|%)|auto)$/i.test(cleaned);
  };

  const isSafeLineHeightValue = (value: string) => {
    const cleaned = cleanValue(value);
    if (hasUnsafeValue(cleaned)) return false;
    return /^(?:normal|\d{1,3}(?:\.\d{1,2})?(?:px|em|rem|%)?)$/i.test(cleaned);
  };

  const addVariable = (className: string, variableName: string, value: string) => {
    variableDeclarations.push(`${variableName}: ${cleanValue(value)}`);
    classNames.add(className);
    hasVisualColor = true;
  };

  style.split(";").forEach((rawDeclaration) => {
    const separatorIndex = rawDeclaration.indexOf(":");
    if (separatorIndex < 1) return;

    const property = rawDeclaration.slice(0, separatorIndex).trim().toLowerCase();
    const value = cleanValue(rawDeclaration.slice(separatorIndex + 1));

    if (property === "background" || property === "background-color") {
      if (isSafeColorValue(value)) {
        addVariable("reader-preserved-background", "--reader-preserved-background", value);
      }
      return;
    }

    if (property === "color") {
      if (isSafeColorValue(value)) {
        addVariable("reader-preserved-color", "--reader-preserved-color", value);
      }
      return;
    }

    if (property === "border") {
      if (isSafeBorderValue(value)) {
        addVariable("reader-preserved-border", "--reader-preserved-border", value);
      }
      return;
    }

    if (["border-top", "border-right", "border-bottom", "border-left"].includes(property)) {
      const safeTreeConnectorBorder =
        preserveTreeChartConnectorBorders &&
        /^(?:1|2)px\s+(?:solid|dashed|dotted)\s+(?:#[0-9a-f]{3,8}|rgba?\([0-9.,%\s]+\)|hsla?\([0-9.,%\s]+\)|[a-z]{3,32})$/i.test(value);
      if (isSafeBorderValue(value) || safeTreeConnectorBorder) {
        const suffix = property.replace("border-", "");
        addVariable(`reader-preserved-border-${suffix}`, `--reader-preserved-border-${suffix}`, value);
      }
      return;
    }

    if (property === "border-color") {
      if (isSafeBorderValue(value)) {
        addVariable("reader-preserved-border-color", "--reader-preserved-border-color", value);
      }
      return;
    }

    if (property === "display") {
      if (/^none$/i.test(value)) {
        preservedDisplay = "none";
        return;
      }

      if (/^(inline|inline-block|block)$/i.test(value)) {
        preservedDisplay = value.toLowerCase() as
          | "inline"
          | "inline-block"
          | "block";
      }
      return;
    }

    if (preservePositioning && property === "position") {
      if (/^(relative|absolute)$/i.test(value)) {
        layoutDeclarations.push("position: " + value.toLowerCase());
      }
      return;
    }

    if (preservePositioning && ["top", "right", "bottom", "left"].includes(property)) {
      if (isSafeLengthValue(value)) {
        layoutDeclarations.push(property + ": " + value);
      }
      return;
    }

    if (preservePositioning && property === "overflow") {
      if (/^(visible|hidden|clip|auto|scroll)$/i.test(value)) {
        layoutDeclarations.push(`${property}: ${value.toLowerCase()}`);
      }
      return;
    }

    if (preservePositioning && property === "visibility") {
      if (/^(visible|hidden)$/i.test(value)) {
        layoutDeclarations.push(`${property}: ${value.toLowerCase()}`);
      }
      return;
    }

    if (preservePositioning && property === "line-height") {
      if (isSafeLineHeightValue(value)) {
        layoutDeclarations.push(`${property}: ${value}`);
      }
      return;
    }

    if (preservePositioning && property === "float") {
      if (/^(left|right|none)$/i.test(value)) {
        layoutDeclarations.push(`${property}: ${value.toLowerCase()}`);
      }
      return;
    }

    if (preservePositioning && property === "column-width") {
      if (isSafeLengthValue(value)) {
        layoutDeclarations.push(`${property}: ${value}`);
      }
      return;
    }

    if (
      ["width", "height", "min-width", "min-height", "max-width", "max-height", "margin-right", "margin-left"].includes(property)
    ) {
      if (isSafeLengthValue(value)) {
        layoutDeclarations.push(`${property}: ${value}`);
      }
      return;
    }

    if (property === "vertical-align") {
      if (/^(middle|top|bottom|baseline|text-top|text-bottom|[-]?\d{1,2}(?:\.\d{1,2})?(?:px|em|rem|%))$/i.test(value)) {
        layoutDeclarations.push(`${property}: ${value}`);
      }
    }
  });

  const hasHiddenDisplay = preservedDisplay === "none";

  if (hasHiddenDisplay) {
    classNames.add("reader-hidden-sort-key");
    layoutDeclarations.push("display: none");
  } else if (preservedDisplay) {
    layoutDeclarations.push(`display: ${preservedDisplay}`);
  }

  if (!hasVisualColor && !hasHiddenDisplay && layoutDeclarations.length === 0) return { style: "", classNames: [] };

  return {
    style: [...variableDeclarations, ...layoutDeclarations].join("; "),
    classNames: [...classNames],
  };
}


function addReaderStaticRowNumbers(document: Document) {
  document
    .querySelectorAll<HTMLTableElement>("table.static-row-numbers")
    .forEach((table) => {
      if (table.classList.contains("reader-static-row-numbers-ready")) return;

      const rows = Array.from(table.querySelectorAll<HTMLTableRowElement>("tr"));
      if (!rows.length) return;

      const headerRow =
        table.querySelector<HTMLTableRowElement>("thead tr") ||
        rows.find((row) => row.querySelector("th")) ||
        rows[0];

      if (!headerRow) return;

      table.classList.add("reader-static-row-numbers-ready");

      const firstHeaderCell = headerRow.querySelector<HTMLElement>("th, td");
      const firstHeaderText =
        firstHeaderCell?.textContent?.replace(/\s+/g, " ").trim().toLowerCase() ?? "";

      const alreadyHasNumberColumn =
        firstHeaderText === "no." ||
        firstHeaderText === "no" ||
        firstHeaderText === "#" ||
        firstHeaderCell?.classList.contains("reader-static-row-number-header");

      if (!alreadyHasNumberColumn) {
        const numberHeader = document.createElement("th");
        numberHeader.className = "reader-static-row-number-header";
        numberHeader.scope = "col";
        numberHeader.textContent = "No.";
        if (firstHeaderCell instanceof HTMLTableCellElement) {
          numberHeader.rowSpan = firstHeaderCell.rowSpan || 1;
        }
        headerRow.insertBefore(numberHeader, headerRow.firstChild);
      }

      let rowNumber = 0;

      rows.forEach((row) => {
        if (row === headerRow) return;
        if (!row.querySelector("td")) return;

        const firstCell = row.firstElementChild;
        if (firstCell?.classList.contains("reader-static-row-number-cell")) return;

        rowNumber += 1;

        const numberCell = document.createElement("td");
        numberCell.className = "reader-static-row-number-cell";
        numberCell.textContent = String(rowNumber);
        numberCell.setAttribute("aria-label", `Row ${rowNumber}`);

        row.insertBefore(numberCell, row.firstChild);
      });
    });
}


function upgradeReaderEngagements(document: Document) {
  document.querySelectorAll<HTMLTableElement>("table").forEach((table) => {
    const headerRow = Array.from(table.rows).find(
      (row) => row.textContent?.replace(/\s+/g, " ").trim() === "Engagements",
    );
    const engagementRow = table.querySelector<HTMLTableRowElement>(
      "tr.reader-infobox-side-caption-row:has(.mw-collapsible-content)",
    );
    const list = engagementRow?.querySelector<HTMLElement>(
      ".mw-collapsible-content",
    );

    if (!headerRow || !engagementRow || !list || !list.querySelector("img, svg")) {
      return;
    }

    headerRow.classList.add("reader-engagements-header");
    engagementRow.classList.add(
      "reader-engagements-section",
      "reader-engagements-collapsed",
    );

    if (headerRow !== engagementRow.previousElementSibling) {
      engagementRow.parentElement?.insertBefore(headerRow, engagementRow);
    }

    const headerCell = headerRow.querySelector<HTMLTableCellElement>("td, th");
    if (!headerCell) return;

    let toggle = headerCell.querySelector<HTMLButtonElement>(
      ".reader-engagements-toggle",
    );
    if (!toggle) {
      toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "reader-engagements-toggle";
      toggle.setAttribute("data-reader-engagements-toggle", "true");
      toggle.setAttribute("aria-expanded", "false");
      toggle.setAttribute("aria-label", "Show engagements");

      const opening = document.createElement("span");
      opening.className = "reader-engagements-toggle-punctuation";
      opening.textContent = "[";
      const label = document.createElement("span");
      label.className = "reader-engagements-toggle-label";
      label.textContent = "show";
      const closing = document.createElement("span");
      closing.className = "reader-engagements-toggle-punctuation";
      closing.textContent = "]";

      toggle.append(opening, label, closing);
      headerCell.append(toggle);
    }

    list.classList.add("reader-engagements-list");
    list.querySelectorAll<HTMLElement>(":scope > li").forEach((item, index) => {
      item.classList.toggle("reader-engagements-first-item", index === 0);
    });

    list.querySelectorAll<HTMLElement>("span[typeof=\"mw:File\"]").forEach(
      (ribbon) => ribbon.classList.add("reader-engagements-ribbon"),
    );

    list.querySelectorAll<HTMLAnchorElement>("a[data-wiki-target]").forEach(
      (link) => link.removeAttribute("title"),
    );

    list.querySelectorAll<HTMLElement>(":scope > li").forEach((item) => {
      const children = Array.from(item.childNodes);
      children.forEach((child, index) => {
        const next = children[index + 1];
        if (
          child.nodeType === Node.TEXT_NODE &&
          /(^|\s)Global\s*$/.test(child.textContent ?? "") &&
          next instanceof HTMLAnchorElement &&
          next.dataset.wikiTarget === "War_on_terror"
        ) {
          const wrapper = document.createElement("span");
          wrapper.className = "reader-engagements-global-label";
          item.insertBefore(wrapper, child);
          wrapper.append(child, next);
        }
      });
    });
  });
}

function markReaderCenteredInsigniaTable(document: Document) {
  document.querySelectorAll<HTMLTableElement>("table").forEach((table) => {
    const text = table.textContent?.replace(/\s+/g, " ").trim() ?? "";
    if (
      !text.includes("Branch") ||
      !text.includes("Insignia and colors") ||
      !text.includes("Functional Area (FA)")
    ) {
      return;
    }

    table.classList.add("reader-insignia-table");
    table
      .querySelectorAll<HTMLTableCellElement>("td, th")
      .forEach((cell) => {
        if (cell.querySelector("img, svg")) {
          cell.classList.add("reader-insignia-cell");
        }
      });
  });
}


function markReaderPositionedLegacyCharts(document: Document) {
  document.querySelectorAll<HTMLElement>(".chart.noresize").forEach((chart) => {
    const positionedBars = Array.from(
      chart.querySelectorAll<HTMLElement>("[style][title]"),
    ).filter((bar) => {
      const style = bar.getAttribute("style") ?? "";
      const hasAbsolutePosition = /(?:^|;)\s*position\s*:\s*absolute\s*(?:;|$)/i.test(style);
      const hasCoordinates =
        /(?:^|;)\s*left\s*:\s*[-\d.]+px\s*(?:;|$)/i.test(style) &&
        /(?:^|;)\s*top\s*:\s*[-\d.]+px\s*(?:;|$)/i.test(style);
      const hasBarSize = /(?:^|;)\s*height\s*:\s*\d+(?:\.\d+)?px\s*(?:;|$)/i.test(style);
      const hasColor = /(?:^|;)\s*(?:background|background-color)\s*:/i.test(style);
      const hasDataLabel = /^[^:]{2,80}:\s*[\d,]+(?:\s|$)/.test(bar.title.trim());
      return hasAbsolutePosition && hasCoordinates && hasBarSize && hasColor && hasDataLabel;
    });
    const seriesNames = new Set(positionedBars.map((bar) => bar.title.split(":", 1)[0].trim()));
    const positionedElements = Array.from(
      chart.querySelectorAll<HTMLElement>("[style]"),
    );
    const plot = positionedElements.find((element) => {
      const style = element.getAttribute("style") ?? "";
      return (
        /(?:^|;)\s*position\s*:\s*relative\s*(?:;|$)/i.test(style) &&
        /(?:^|;)\s*border-left\s*:\s*1px\s+black\s+solid\s*(?:;|$)/i.test(style) &&
        /(?:^|;)\s*border-bottom\s*:\s*1px\s+black\s+solid\s*(?:;|$)/i.test(style)
      );
    });

    if (positionedBars.length < 10 || seriesNames.size < 2 || !plot) return;

    chart.classList.add("reader-legacy-positioned-chart-ready");
    plot.classList.add("reader-legacy-chart-axis");

    positionedElements.forEach((element) => {
      if (element.title) return;

      const style = element.getAttribute("style") ?? "";
      const isAbsolutePositioned =
        /(?:^|;)\s*position\s*:\s*absolute\s*(?:;|$)/i.test(style);
      if (!isAbsolutePositioned) return;

      const isTopYAxisLabel =
        /^[0-9]{1,3}(?:,[0-9]{3})+$/.test(element.textContent?.trim() ?? "") &&
        /(?:^|;)\s*vertical-align\s*:\s*middle\s*(?:;|$)/i.test(style);
      const hasExplicitTop =
        /(?:^|;)\s*(?:top|--reader-preserved-top)\s*:/i.test(style);
      if (isTopYAxisLabel && !hasExplicitTop) {
        element.classList.add("reader-legacy-chart-y-top-label");
      }

      const isXAxisTick =
        /(?:^|;)\s*height\s*:\s*10px\s*(?:;|$)/i.test(style) &&
        /(?:^|;)\s*width\s*:\s*1px\s*(?:;|$)/i.test(style) &&
        /(?:^|;)\s*border-left\s*:\s*1px\s+solid\s+black\s*(?:;|$)/i.test(style);
      const hasBlackBorder =
        /(?:^|;)\s*border\s*:\s*1px\s+(?:solid\s+black|black\s+solid)\s*(?:;|$)/i.test(style) ||
        /(?:^|;)\s*--reader-preserved-border\s*:\s*1px\s+solid\s+black\s*(?:;|$)/i.test(style);
      const isYAxisTick =
        isAbsolutePositioned &&
        /(?:^|;)\s*min-width\s*:\s*5px\s*(?:;|$)/i.test(style) &&
        /(?:^|;)\s*top\s*:\s*[-\d.]+px\s*(?:;|$)/i.test(style) &&
        hasBlackBorder;

      if (isXAxisTick) element.classList.add("reader-legacy-chart-x-tick");
      if (isYAxisTick) element.classList.add("reader-legacy-chart-y-tick");
    });
  });
}

function markReaderDarkDataCharts(document: Document) {
  document
    .querySelectorAll<HTMLElement>(
      [
        "figure",
        ".thumb",
        ".mw-default-size",
        ".mw-graph",
        ".mw-graph-container",
        ".mw-ext-graph",
        ".noresize",
      ].join(", "),
    )
    .forEach((container) => {
      if (
        container.closest(
          [
            ".infobox",
            ".gallery",
            ".navbox",
            ".vertical-navbox",
            ".reader-generated-pie-chart",
          ].join(", "),
        )
      ) {
        return;
      }

      const text = container.textContent?.replace(/\s+/g, " ").trim().toLowerCase() ?? "";
      const hasChartMedia = Boolean(container.querySelector("img, svg, canvas"));

      if (!hasChartMedia) {
        return;
      }

      const looksLikeDataChart =
        text.includes("view source data") ||
        text.includes("source data") ||
        text.includes("lunch assistance") ||
        text.includes("eligibles for lunch assistance");

      if (!looksLikeDataChart) {
        return;
      }

      container.classList.add("reader-dark-data-chart");

      container
        .querySelectorAll<HTMLElement>("img, svg, canvas")
        .forEach((media) => {
          media.classList.add("reader-dark-data-chart-media");

          media
            .closest<HTMLElement>(
              [
                ".thumbimage",
                ".image",
                ".mw-file-element",
                ".mw-graph",
                ".mw-graph-container",
                ".mw-ext-graph",
              ].join(", "),
            )
            ?.classList.add("reader-dark-data-chart-media-wrap");
        });
    });
}

function layoutReaderEnwikiCharts(root: ParentNode) {
  root.querySelectorAll<SVGSVGElement>(".enwiki-chart svg, wiki-chart.mw-chart svg").forEach((svg) => {
    if (svg.dataset.readerResponsiveDarkLayout !== "true") {
      svg.dataset.readerResponsiveDarkLayout = "true";

      svg.querySelectorAll<SVGTextElement>("text").forEach((label) => {
        label.style.setProperty("font-size", "11px", "important");
      if (svg.closest("wiki-chart.mw-chart")) {
        svg.setAttribute("preserveAspectRatio", "none");
      }
      });
    }

    if (svg.dataset.readerLegendCentered === "true") return;

    const labels = Array.from(svg.querySelectorAll<SVGTextElement>("text"));
    const revenue = labels.find((label) => label.textContent?.trim() === "Revenue");
    const profit = labels.find(
      (label) => label.textContent?.trim() === "Net loss / profit",
    );

    if (!revenue || !profit) return;

    const groups = [revenue, profit].map((label) => {
      const transform = label.getAttribute("transform");
      if (!transform) return null;

      return {
        transform,
        elements: Array.from(svg.querySelectorAll<SVGElement>("[transform]"))
          .filter((element) => element.getAttribute("transform") === transform),
      };
    });

    if (groups.some((group) => !group?.elements.length)) return;

    const profitGroup = groups[1];
    if (!profitGroup) return;

    const profitTransformMatch = profitGroup.transform.match(
      /translate\(([-\d.]+)\s+([-\d.]+)\)$/,
    );

    if (!profitTransformMatch) return;

    const separatedProfitTransform = profitGroup.transform.replace(
      /translate\(([-\d.]+)\s+([-\d.]+)\)$/,
      `translate(${Number(profitTransformMatch[1]) + 45} ${profitTransformMatch[2]})`,
    );

    profitGroup.elements.forEach((element) => {
      element.setAttribute("transform", separatedProfitTransform);
    });
    profitGroup.transform = separatedProfitTransform;

    const elements = groups.flatMap((group) => group?.elements ?? []);
    const rects = elements.map((element) => element.getBoundingClientRect());
    const legendLeft = Math.min(...rects.map((rect) => rect.left));
    const legendRight = Math.max(...rects.map((rect) => rect.right));
    const legendCenter = (legendLeft + legendRight) / 2;
    const svgRect = svg.getBoundingClientRect();
    const svgCenter = (svgRect.left + svgRect.right) / 2;
    const viewBoxWidth = svg.viewBox.baseVal.width || 400;
    const scaleX = svgRect.width / viewBoxWidth;
    const shift = (svgCenter - legendCenter) / scaleX;

    groups.forEach((group) => {
      if (!group) return;

      const match = group.transform.match(/translate\(([-\d.]+)\s+([-\d.]+)\)$/);
      if (!match) return;

      const newTransform = group.transform.replace(
        /translate\(([-\d.]+)\s+([-\d.]+)\)$/,
        `translate(${Number(match[1]) + shift} ${match[2]})`,
      );

      group.elements.forEach((element) => {
        element.setAttribute("transform", newTransform);
      });
    });

    svg.dataset.readerLegendCentered = "true";
  });
}


function markReaderPresidentialResultsTables(document: Document) {
  document.querySelectorAll<HTMLTableElement>("table").forEach((table) => {
    const directCaptionText =
      table.querySelector("caption")?.textContent?.replace(/\s+/g, " ").trim() ?? "";

    const externalCaptionText =
      table
        .closest(".reader-presidential-title-group")
        ?.querySelector(".reader-presidential-external-title")
        ?.textContent?.replace(/\s+/g, " ")
        .trim() ?? "";

    const captionText = directCaptionText || externalCaptionText;

    const headerText = Array.from(table.querySelectorAll("th"))
      .slice(0, 20)
      .map((cell) => cell.textContent?.replace(/\s+/g, " ").trim() ?? "")
      .join(" ");

    const tableText = `${captionText} ${headerText}`.toLowerCase();

    const looksLikePresidentialResultsTable =
      tableText.includes("presidential election results") &&
      tableText.includes("republican") &&
      tableText.includes("democratic") &&
      tableText.includes("third party");

    if (!looksLikePresidentialResultsTable) {
      return;
    }

    table.classList.add("reader-presidential-results-table");

    table
      .querySelectorAll(".reader-presidential-party-group-separator")
      .forEach((cell) =>
        cell.classList.remove("reader-presidential-party-group-separator"),
      );

    const firstRow = table.rows.item(0);
    const partyGroupCells = firstRow
      ? Array.from(firstRow.cells).filter((cell) => cell.colSpan === 2)
      : [];

    partyGroupCells.slice(0, -1).forEach((cell) => {
      cell.classList.add("reader-presidential-party-group-separator");
    });

    table
      .querySelectorAll(".reader-presidential-results-bottom-edge-cell")
      .forEach((cell) =>
        cell.classList.remove("reader-presidential-results-bottom-edge-cell"),
      );

    const electionRows = Array.from(table.rows).filter((row) =>
      /^\d{4}\b/.test(row.textContent?.replace(/\s+/g, " ").trim() ?? ""),
    );
    const finalElectionRow = electionRows[electionRows.length - 1];

    if (finalElectionRow) {
      const firstCell = finalElectionRow.cells.item(0);
      const lastCell = finalElectionRow.cells.item(
        finalElectionRow.cells.length - 1,
      );

      firstCell?.classList.add(
        "reader-presidential-results-bottom-edge-cell",
      );
      lastCell?.classList.add(
        "reader-presidential-results-bottom-edge-cell",
      );
    }

    const resultsWrapper = table.closest<HTMLElement>(
      ".reader-scrollable-sortable-table",
    );
    resultsWrapper?.classList.add("reader-presidential-results-wrapper");

    const directCaption =
      table.querySelector<HTMLTableCaptionElement>(":scope > caption");

    if (
      resultsWrapper &&
      directCaption &&
      !table.closest(".reader-presidential-title-group")
    ) {
      const parent = resultsWrapper.parentElement;

      if (parent) {
        const group = document.createElement("div");
        group.className = "reader-presidential-title-group";

        const title = document.createElement("div");
        title.className = "reader-presidential-external-title";

        while (directCaption.firstChild) {
          title.appendChild(directCaption.firstChild);
        }

        directCaption.remove();
        parent.insertBefore(group, resultsWrapper);
        group.append(title, resultsWrapper);
      }
    }
  });
}


function wrapReaderWideTables(document: Document) {
  document
    .querySelectorAll<HTMLTableElement>(
      "table.wikitable:not(.infobox):not(.navbox):not(.vertical-navbox)",
    )
    .forEach((table) => {
      if (
        table.closest(
          ".reader-scrollable-sortable-table, .reader-table-scroll, .reader-table-wrapper",
        )
      ) {
        return;
      }
      if (table.classList.contains("reader-layout-table")) return;
      if (table.parentElement?.closest("td, th")) return;

      const columnCount = Math.max(
        ...Array.from(table.querySelectorAll<HTMLTableRowElement>("tr")).map(
          (row) => row.children.length,
        ),
        0,
      );

      if (columnCount < 7) return;

      const isSortable = table.classList.contains("sortable");
      const wrapper = document.createElement("div");
      wrapper.className = isSortable
        ? "reader-scrollable-sortable-table"
        : "reader-table-scroll";
      wrapper.setAttribute("role", "region");
      wrapper.setAttribute(
        "aria-label",
        isSortable ? "Scrollable sortable table" : "Scrollable table",
      );

      table.parentNode?.insertBefore(wrapper, table);
      wrapper.appendChild(table);

      if (isSortable) {
        table.classList.add("reader-scrollable-sortable-table-inner");
      }
    });
}

function markReaderLightBackgroundTableCells(document: Document) {
  const namedLightColors: Record<string, [number, number, number]> = {
    beige: [245, 245, 220],
    bisque: [255, 228, 196],
    cornsilk: [255, 248, 220],
    honeydew: [240, 255, 240],
    ivory: [255, 255, 240],
    lavender: [230, 230, 250],
    lemonchiffon: [255, 250, 205],
    lightblue: [173, 216, 230],
    lightcyan: [224, 255, 255],
    lightgoldenrodyellow: [250, 250, 210],
    lightgreen: [144, 238, 144],
    lightpink: [255, 182, 193],
    lightsalmon: [255, 160, 122],
    lightyellow: [255, 255, 224],
    linen: [250, 240, 230],
    mintcream: [245, 255, 250],
    mistyrose: [255, 228, 225],
    moccasin: [255, 228, 181],
    oldlace: [253, 245, 230],
    palegoldenrod: [238, 232, 170],
    palegreen: [152, 251, 152],
    paleturquoise: [175, 238, 238],
    papayawhip: [255, 239, 213],
    peachpuff: [255, 218, 185],
    pink: [255, 192, 203],
    seashell: [255, 245, 238],
    thistle: [216, 191, 216],
    white: [255, 255, 255],
    whitesmoke: [245, 245, 245],
  };

  const readPreservedBackground = (element: Element | null) => {
    if (!element) return "";

    const style = element.getAttribute("style") || "";
    const variableMatch = style.match(/--reader-preserved-background\s*:\s*([^;]+)/i);

    if (variableMatch?.[1]) {
      return variableMatch[1].trim();
    }

    return element.getAttribute("bgcolor") || "";
  };

  const colorProbe = document.createElement("canvas").getContext("2d");

  const parseColor = (value: string): [number, number, number] | null => {
    const cleaned = value
      .replace(/!important/gi, "")
      .trim()
      .toLowerCase();

    if (!cleaned || cleaned === "transparent") return null;

    const hex = cleaned.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);

    if (hex) {
      let raw = hex[1];

      if (raw.length === 3) {
        raw = raw.split("").map((part) => part + part).join("");
      }

      return [
        Number.parseInt(raw.slice(0, 2), 16),
        Number.parseInt(raw.slice(2, 4), 16),
        Number.parseInt(raw.slice(4, 6), 16),
      ];
    }

    const rgb = cleaned.match(/^rgba?\(([^)]+)\)$/i);

    if (rgb) {
      const parts = rgb[1]
        .split(",")
        .slice(0, 3)
        .map((part) => part.trim());

      if (parts.length === 3) {
        return parts.map((part) => {
          if (part.endsWith("%")) {
            return Math.round((Number.parseFloat(part) / 100) * 255);
          }

          return Number.parseFloat(part);
        }) as [number, number, number];
      }
    }

    const namedColor = namedLightColors[cleaned];
    if (namedColor) return namedColor;

    if (!colorProbe) return null;

    colorProbe.fillStyle = "#010203";
    colorProbe.fillStyle = cleaned;
    const normalized = colorProbe.fillStyle;
    if (normalized === "#010203" && cleaned !== "#010203") return null;

    const normalizedHex = normalized.match(/^#([0-9a-f]{6})$/i);
    if (normalizedHex) {
      return [
        Number.parseInt(normalizedHex[1].slice(0, 2), 16),
        Number.parseInt(normalizedHex[1].slice(2, 4), 16),
        Number.parseInt(normalizedHex[1].slice(4, 6), 16),
      ];
    }

    const normalizedRgb = normalized.match(/^rgba?\(([^)]+)\)$/i);
    if (normalizedRgb) {
      const parts = normalizedRgb[1]
        .split(/[ ,/]+/)
        .slice(0, 3)
        .map((part) => Number.parseFloat(part));
      if (parts.length === 3 && parts.every(Number.isFinite)) {
        return parts as [number, number, number];
      }
    }

    return null;
  };

  const getContrastingTextColor = (value: string) => {
    // Translucent colors blend with the surface behind the cell, so keep
    // their existing treatment rather than guessing the final contrast.
    if (/\b(?:rgba|hsla)\s*\(/i.test(value) || /^#[0-9a-f]{8}$/i.test(value)) {
      const alphaMatch = value.match(/,\s*([0-9.]+%?)\s*\)$/);
      const alpha = /^#[0-9a-f]{8}$/i.test(value)
        ? Number.parseInt(value.slice(-2), 16) / 255
        : alphaMatch
          ? alphaMatch[1].endsWith("%")
            ? Number.parseFloat(alphaMatch[1]) / 100
            : Number.parseFloat(alphaMatch[1])
          : 1;
      if (alpha < 0.999) return null;
    }

    const color = parseColor(value);
    if (!color) return null;

    const [r, g, b] = color.map((channel) => {
      const normalized = Math.max(0, Math.min(255, channel)) / 255;
      return normalized <= 0.04045
        ? normalized / 12.92
        : Math.pow((normalized + 0.055) / 1.055, 2.4);
    });
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;

    return luminance < 0.179 ? "#ffffff" : "#000000";
  };

  const isLightBackground = (value: string) => {
    const color = parseColor(value);

    if (!color) return false;

    const [r, g, b] = color.map((channel) => {
      const normalized = Math.max(0, Math.min(255, channel)) / 255;

      return normalized <= 0.03928
        ? normalized / 12.92
        : Math.pow((normalized + 0.055) / 1.055, 2.4);
    });

    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;

    return luminance >= 0.48;
  };

  const isLightColoredBackground = (value: string) => {
    const color = parseColor(value);

    if (!color) return false;

    const [r, g, b] = color;
    const maximum = Math.max(r, g, b);
    const minimum = Math.min(r, g, b);
    const saturation = (maximum - minimum) / Math.max(1, maximum);

    return isLightBackground(value) && saturation > 0.08;
  };

  document.querySelectorAll<HTMLTableElement>("table").forEach((table) => {
    const columnBackgrounds: string[] = [];
    let columnIndex = 0;

    Array.from(table.children).forEach((child) => {
      if (child.tagName !== "COLGROUP") return;

      const groupBackground = readPreservedBackground(child);
      const cols = Array.from(child.children).filter(
        (col): col is HTMLTableColElement => col.tagName === "COL",
      );

      if (!cols.length) {
        const span = Number.parseInt(child.getAttribute("span") || "1", 10);

        for (let index = 0; index < Math.max(1, span); index += 1) {
          columnBackgrounds[columnIndex] = groupBackground;
          columnIndex += 1;
        }

        return;
      }

      cols.forEach((col) => {
        const span = Number.parseInt(col.getAttribute("span") || "1", 10);
        const background = readPreservedBackground(col) || groupBackground;

        for (let index = 0; index < Math.max(1, span); index += 1) {
          columnBackgrounds[columnIndex] = background;
          columnIndex += 1;
        }
      });
    });

    Array.from(table.rows).forEach((row) => {
      let cellColumnIndex = 0;
      const rowBackground = readPreservedBackground(row);

      Array.from(row.cells).forEach((cell) => {
        const ownBackground = readPreservedBackground(cell);
        const columnBackground = columnBackgrounds[cellColumnIndex] || "";
        const background = ownBackground || rowBackground || columnBackground;

        // Explicit cell colors must take priority over the app's alternating
        // row tint, which otherwise hides source bgcolor colors on every other row.
        if (ownBackground) {
          cell.style.setProperty("background", ownBackground, "important");
        }

        const contrastingTextColor = background
          ? getContrastingTextColor(background)
          : null;

        if (contrastingTextColor) {
          cell.dataset.readerContrastBackground = "true";
          cell.style.setProperty(
            "--reader-contrast-text-color",
            contrastingTextColor,
          );
        } else {
          delete cell.dataset.readerContrastBackground;
          cell.style.removeProperty("--reader-contrast-text-color");
        }

        cell.classList.remove("reader-light-colored-background-cell");

        if (background && isLightBackground(background)) {
          cell.classList.add("reader-light-background-cell");

          if (isLightColoredBackground(background)) {
            cell.classList.add("reader-light-colored-background-cell");
          }

          if (!ownBackground && rowBackground) {
            cell.classList.add("reader-row-background-cell");
          } else if (!ownBackground && !rowBackground && columnBackground) {
            cell.classList.add("reader-preserved-background");
            cell.style.setProperty("--reader-preserved-background", columnBackground);
          }
        }

        cellColumnIndex += Math.max(
          1,
          Number.parseInt(cell.getAttribute("colspan") || "1", 10),
        );
      });
    });
  });
}


function markReaderDarkModeLightFooterLabelCells(document: Document) {
  document
    .querySelectorAll<HTMLTableElement>("table.reader-normal-table")
    .forEach((table) => {
      if (
        table.matches(
          ".reader-climate-table, .reader-climate-data-table, .infobox, .infobox-subbox",
        )
      ) {
        return;
      }

      Array.from(table.rows).forEach((row) => {
        if (!readerRowLooksLikeSortableFooterRow(row)) return;

        Array.from(row.cells).forEach((cell) => {
          if (cell.tagName.toLowerCase() !== "th") return;
          if (cell.colSpan <= 1) return;

          /*
           * Only adapt merged footer/summary labels that inherited a genuinely
           * light source background from their row. Data cells keep the source
           * light background.
           */
          if (!cell.classList.contains("reader-light-background-cell")) return;
          if (!cell.classList.contains("reader-row-background-cell")) return;

          cell.classList.add(
            "reader-dark-mode-light-footer-label-cell",
          );
        });
      });
    });
}

function markReaderNominationTableHeaders(document: Document) {
  const clean = (value: string | null | undefined) =>
    (value || "").replace(/\s+/g, " ").trim();

  document.querySelectorAll<HTMLTableElement>("table").forEach((table) => {
    const text = clean(table.textContent);

    if (text.includes("1944 Democratic Party ticket")) {
      table.classList.add("reader-nomination-ticket-table");

      Array.from(table.rows)
        .flatMap((row) => Array.from(row.cells))
        .find((cell) =>
          clean(cell.textContent).includes("1944 Democratic Party ticket"),
        )
        ?.classList.add("reader-nomination-ticket-title");

      Array.from(table.rows[1]?.cells || []).forEach((cell) =>
        cell.classList.add("reader-nomination-ticket-candidate-header"),
      );

      Array.from(table.rows[2]?.cells || []).forEach((cell) =>
        cell.classList.add("reader-nomination-ticket-role-header"),
      );
    }

    if (text.includes("In Order of Delegates and Votes Won.")) {
      table.classList.add("reader-nomination-votes-table");

      Array.from(table.rows[0]?.cells || []).forEach((cell) =>
        cell.classList.add("reader-nomination-votes-caption"),
      );

      Array.from(table.rows[1]?.cells || []).forEach((cell) =>
        cell.classList.add("reader-nomination-votes-header"),
      );
    }
  });
}


function readerFileTitleFromImageSource(source: string) {
  if (!source) return null;

  const cleanedSource = source
    .replace(/^https?:/i, "")
    .split("?")[0]
    .split("#")[0];

  let parts = cleanedSource
    .split("/")
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });

  if (!parts.length) return null;

  let fileName = "";

  const thumbIndex = parts.indexOf("thumb");

  if (thumbIndex >= 0 && parts.length >= thumbIndex + 5) {
    fileName = parts[parts.length - 2] || "";
  } else {
    fileName = parts[parts.length - 1] || "";
  }

  fileName = fileName.replace(/_/g, " ").trim();

  if (!/\.(apng|avif|gif|jpe?g|png|svg|tiff?|webp)$/i.test(fileName)) {
    return null;
  }

  return `File:${fileName}`;
}

function makeReaderInfoboxMediaImagesClickable(document: Document) {
  document
    .querySelectorAll<HTMLImageElement>(
      [
        ".infobox tr.reader-infobox-top-media-row img",
        ".infobox .infobox-image img",
        ".infobox .infobox-full-data img",
        ".infobox .reader-infobox-top-media-cell img",
      ].join(", "),
    )
    .forEach((image) => {
      if (
        image.closest(
          [
            ".reader-location-map-switcher",
            ".locmap",
            ".location-map",
            ".locationmap",
            ".mapframe",
            ".mw-kartographer-container",
            ".mw-kartographer-map",
          ].join(", "),
        )
      ) {
        return;
      }

      // Static locator maps place their own positioned article links over the
      // base image. Wrapping that image in the generic file-lightbox link puts
      // a higher stacking layer over those links and prevents map interaction.
      const staticImageMap = image.closest<HTMLElement>(".noresize");
      const staticImageMapLinkCount = Array.from(
        staticImageMap?.querySelectorAll<HTMLAnchorElement>(
          "a[data-wiki-target]",
        ) ?? [],
      ).filter((link) => !/^File:/i.test(link.dataset.wikiTarget || "")).length;

      if (staticImageMapLinkCount >= 10) {
        return;
      }

      const width = Number.parseInt(image.getAttribute("width") || "", 10);
      const height = Number.parseInt(image.getAttribute("height") || "", 10);
      const largestKnownSide = Math.max(
        Number.isFinite(width) ? width : 0,
        Number.isFinite(height) ? height : 0,
      );

      if (largestKnownSide > 0 && largestKnownSide < 45) {
        return;
      }

      const target = readerFileTitleFromImageSource(image.getAttribute("src") || image.src);

      if (!target) {
        return;
      }

      const existingLink = image.closest<HTMLAnchorElement>("a");

      if (existingLink) {
        existingLink.dataset.wikiTarget = target;
        existingLink.removeAttribute("href");
        existingLink.removeAttribute("target");
        existingLink.removeAttribute("rel");
        existingLink.classList.add("reader-infobox-image-file-link");
        return;
      }

      const link = document.createElement("a");
      link.dataset.wikiTarget = target;
      link.className = "reader-infobox-image-file-link";
      link.setAttribute("role", "link");
      link.setAttribute("tabindex", "0");
      link.setAttribute("title", target.replace(/^File:/, ""));

      image.insertAdjacentElement("beforebegin", link);
      link.appendChild(image);
    });
}

function markReaderStaticImageMaps(document: Document) {
  document.querySelectorAll<HTMLElement>(".noresize").forEach((map) => {
    const interactiveLinkCount = Array.from(
      map.querySelectorAll<HTMLAnchorElement>("a[data-wiki-target]"),
    ).filter((link) => !/^File:/i.test(link.dataset.wikiTarget || "")).length;

    if (map.querySelector("img") && interactiveLinkCount >= 10) {
      map.classList.add("reader-static-image-map");
    }
  });
}

function polishReaderAdministrativeDivisionMapLayouts(document: Document) {
  document
    .querySelectorAll<HTMLTableElement>("table.col-begin")
    .forEach((layoutTable) => {
      const mapWrapper = layoutTable.querySelector<HTMLElement>(
        ".reader-static-image-map",
      );
      const mapTable = mapWrapper?.closest<HTMLTableElement>("table");

      if (!mapWrapper || !mapTable || mapTable === layoutTable) {
        return;
      }

      const mapWidth = Number.parseFloat(getComputedStyle(mapWrapper).width);
      if (Number.isFinite(mapWidth) && mapWidth > 0) {
        mapTable.style.setProperty("width", `${mapWidth}px`, "important");
      }
      mapTable.style.setProperty("border", "0", "important");
      mapWrapper.querySelectorAll<HTMLAnchorElement>("a").forEach((label) => {
        label.style.setProperty("font-weight", "700", "important");
      });

      Array.from(
        layoutTable.querySelectorAll<HTMLTableElement>(
          "table.reader-normal-table",
        ),
      )
        .filter(
          (nestedTable) =>
            nestedTable !== mapTable &&
            nestedTable.closest("table.col-begin") === layoutTable,
        )
        .forEach((nestedTable) => {
          nestedTable.style.setProperty("border", "0", "important");
        });
    });
}


function markReaderSectionsAfterFloatingBlocks(document: Document) {
  document.querySelectorAll<HTMLHeadingElement>("h2").forEach((heading) => {
    const headingBlock = heading.closest<HTMLElement>(".mw-heading") || heading;
    let current = headingBlock.previousElementSibling as HTMLElement | null;
    let shouldClear = false;

    while (current) {
      if (
        current.matches("h1, h2, .mw-heading") &&
        Boolean(current.querySelector?.("h1, h2"))
      ) {
        break;
      }

      const hasNonInfoboxFloat =
        current.matches(
          [
            "figure",
            ".thumb",
            ".mw-default-size",
            ".reader-side-table",
            ".reader-float-right",
            ".reader-float-left",
            ".floatright",
            ".floatleft",
            ".reader-scrollable-sortable-table",
            "table.reader-side-table",
            "table.reader-float-right",
            "table.floatright",
          ].join(", "),
        ) ||
        Boolean(
          current.querySelector(
            [
              "figure",
              ".thumb",
              ".mw-default-size",
              ".reader-side-table",
              ".reader-float-right",
              ".reader-float-left",
              ".floatright",
              ".floatleft",
              ".reader-scrollable-sortable-table",
              "table.reader-side-table",
              "table.reader-float-right",
              "table.floatright",
            ].join(", "),
          ),
        );

      const isInfobox =
        current.matches(".infobox, table.infobox") ||
        Boolean(current.querySelector(".infobox, table.infobox"));

      const hasFloatedLayoutTable =
        (current.matches("table.reader-layout-table") &&
          getComputedStyle(current).float !== "none") ||
        Array.from(
          current.querySelectorAll<HTMLTableElement>("table.reader-layout-table"),
        ).some((table) => getComputedStyle(table).float !== "none");

      if ((hasNonInfoboxFloat || hasFloatedLayoutTable) && !isInfobox) {
        shouldClear = true;
        break;
      }

      current = current.previousElementSibling as HTMLElement | null;
    }

    if (shouldClear) {
      heading.classList.add("reader-section-clear-floats");
      headingBlock.classList.add("reader-section-clear-floats");
    }
  });
}

function markReaderParagraphsAfterFloatingTables(document: Document) {
  document.querySelectorAll<HTMLParagraphElement>("p").forEach((paragraph) => {
    let current = paragraph.previousElementSibling as HTMLElement | null;

    while (current) {
      if (current.matches("h1, h2, .mw-heading:has(> h1, > h2)")) break;

      const leftSortableTableGroup = current.matches(
        ".reader-table-caption-group-left:has(.reader-scrollable-sortable-table, table.reader-normal-table)",
      );

      if (leftSortableTableGroup) {
        paragraph.classList.add("reader-paragraph-clear-left");
        break;
      }

      if (current.matches("p")) break;

      current = current.previousElementSibling as HTMLElement | null;
    }
  });
}

function removeReaderUnsupportedCladeTrees(document: Document) {
  const cladeTables = Array.from(
    document.querySelectorAll<HTMLTableElement>("table.clade"),
  );

  const wrappers = new Set<HTMLElement>();
  const standaloneTables = new Set<HTMLTableElement>();

  cladeTables.forEach((table) => {
    const preservedWrapper = table.closest<HTMLElement>(
      ".reader-preserved-border",
    );

    if (preservedWrapper) {
      wrappers.add(preservedWrapper);
    } else if (!table.parentElement?.closest("table.clade")) {
      standaloneTables.add(table);
    }
  });

  wrappers.forEach((wrapper) => wrapper.remove());
  standaloneTables.forEach((table) => table.remove());

  document
    .querySelectorAll<HTMLElement>("div.reader-preserved-border")
    .forEach((element) => {
      const text = element.textContent?.trim() ?? "";
      const isCaptionOnlyFamilyTree =
        /\bfamily tree\b/i.test(text) &&
        !element.querySelector("table.clade") &&
        !element.querySelector("img");

      if (isCaptionOnlyFamilyTree) element.remove();
    });
}


function markReaderPositionedHorizontalTimelines(document: Document) {
  const directElementChildren = (element: HTMLElement) =>
    Array.from(element.children).filter(
      (child): child is HTMLElement => child instanceof HTMLElement,
    );

  const isScaleRow = (row: HTMLElement) =>
    row.style.position.trim().toLowerCase() === "relative" &&
    row.style.width.trim() === "100%" &&
    row.style.height.trim() === "2.5em" &&
    row.style.top.trim() === "-1.4em" &&
    row.style.left.trim() === "-0.2em";

  const isBandRow = (row: HTMLElement) => {
    const coloredChildren = directElementChildren(row).filter((child) =>
      Boolean(
        child.style.background.trim() ||
          child.style.backgroundColor.trim(),
      ),
    );

    return (
      row.style.width.trim() === "100%" &&
      ["2.5em", "3em"].includes(row.style.height.trim()) &&
      coloredChildren.length >= 1
    );
  };

  const isNoteRow = (row: HTMLElement) => {
    const absoluteChildren = directElementChildren(row).filter(
      (child) =>
        child.style.position.trim().toLowerCase() === "absolute",
    );

    return (
      row.style.position.trim().toLowerCase() === "relative" &&
      row.style.width.trim() === "100%" &&
      ["2.5em", "3em"].includes(row.style.height.trim()) &&
      row.style.top.trim() === "0.8em" &&
      row.style.left.trim() === "-0.2em" &&
      absoluteChildren.length >= 1
    );
  };

  document
    .querySelectorAll<HTMLElement>("div[style]")
    .forEach((timelineBody) => {
      if (
        timelineBody.classList.contains(
          "reader-positioned-horizontal-timeline-body",
        )
      ) {
        return;
      }

      const style = timelineBody.style;
      const background = style.background.trim().toLowerCase();
      const backgroundColor = style.backgroundColor
        .trim()
        .toLowerCase();

      const bodyStyleMatches =
        style.textAlign.trim().toLowerCase() === "left" &&
        style.fontSize.trim() === "95%" &&
        style.margin.trim() === "1em" &&
        (background === "transparent" ||
          backgroundColor === "transparent");

      if (!bodyStyleMatches) return;

      const rows = directElementChildren(timelineBody);
      const scaleRows = rows.filter(isScaleRow);
      const bandRows = rows.filter(isBandRow);
      const noteRows = rows.filter(isNoteRow);

      if (scaleRows.length < 1 || bandRows.length < 1) {
        return;
      }

      const timelineRoot = timelineBody.parentElement;
      if (!(timelineRoot instanceof HTMLElement)) return;

      timelineRoot.classList.add(
        "reader-positioned-horizontal-timeline",
      );
      timelineBody.classList.add(
        "reader-positioned-horizontal-timeline-body",
      );

      const widthMatch = timelineRoot.style.width
        .trim()
        .match(/^(\d{3,4}(?:\.\d+)?)px$/i);

      if (widthMatch) {
        const intrinsicWidth = Number.parseFloat(widthMatch[1]);

        if (
          Number.isFinite(intrinsicWidth) &&
          intrinsicWidth >= 300 &&
          intrinsicWidth <= 4000
        ) {
          timelineRoot.dataset.readerTimelineIntrinsicWidth =
            String(intrinsicWidth);
        }
      }

      noteRows.forEach((row) => {
        row.classList.add(
          "reader-positioned-horizontal-timeline-note-row",
        );
      });

      bandRows.forEach((row) => {
        row.classList.add(
          "reader-positioned-horizontal-timeline-bar-row",
        );
      });

      scaleRows.forEach((row) => {
        row.classList.add(
          "reader-positioned-horizontal-timeline-scale-row",
        );
      });
    });
}

function removeReaderUnsupportedGraphicalTimelines(document: Document) {
  document.querySelectorAll<HTMLTableElement>("table").forEach((table) => {
    const contentRow = table.rows[1];
    const cells = contentRow ? Array.from(contentRow.cells) : [];
    const scaleCell = cells[0];
    const bandCell = cells[1];
    const annotationCell = cells[2];

    if (!scaleCell || !bandCell || !annotationCell) return;
    if (table.rows.length < 3 || cells.length !== 3) return;

    const scaleText = scaleCell.textContent?.replace(/\s+/g, " ").trim() ?? "";
    const annotationText =
      annotationCell.textContent?.replace(/\s+/g, " ").trim() ?? "";
    const coloredBlocks = Array.from(bandCell.children).filter((child) => {
      if (!(child instanceof HTMLElement)) return false;

      return Boolean(
        child.style.background.trim() ||
          child.style.backgroundColor.trim() ||
          child.style.getPropertyValue("--reader-preserved-background").trim(),
      );
    });

    const looksLikeScale =
      /[-−]\s*\d{2,5}/.test(scaleText) && /\b0\b/.test(scaleText);
    const looksLikeAnnotations = /←/.test(annotationText);

    if (!looksLikeScale || !looksLikeAnnotations || coloredBlocks.length < 6) {
      return;
    }

    table.remove();
  });
}

const READER_DEFERRED_IMAGE_PLACEHOLDER =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

function markReaderPackedGalleryWidths(document: Document) {
  document
    .querySelectorAll<HTMLElement>(
      "ul.gallery.mw-gallery-packed, ul.gallery.mw-gallery-packed-hover",
    )
    .forEach((gallery) => {
    const existingRows = gallery.querySelector<HTMLElement>(":scope > .reader-packed-justified-row");
    if (existingRows) return;

    const boxes = Array.from(gallery.querySelectorAll<HTMLElement>(":scope > li.gallerybox"));
    const galleryWidth = Math.max(
      1,
      gallery.clientWidth ||
        gallery.parentElement?.clientWidth ||
        gallery.parentElement?.getBoundingClientRect().width ||
        355,
    );
    const targetHeight = gallery.classList.contains("mw-gallery-packed-hover")
      ? 180
      : 120;
    const gap = 8;
    const rows: HTMLElement[][] = [];
    let row: HTMLElement[] = [];
    let ratioSum = 0;

    boxes.forEach((box) => {
      const image = box.querySelector<HTMLImageElement>("img");
      const sourceWidth = Number(image?.getAttribute("width")) || image?.naturalWidth || 1;
      const sourceHeight = Number(image?.getAttribute("height")) || image?.naturalHeight || 1;
      const ratio = sourceWidth / sourceHeight;
      const nextCount = row.length + 1;
      const nextRatioSum = ratioSum + ratio;
      const projectedHeight = (galleryWidth - gap * (nextCount - 1)) / nextRatioSum;

      if (row.length >= 2 && projectedHeight < targetHeight * 0.88) {
        rows.push(row);
        row = [];
        ratioSum = 0;
      }
      row.push(box);
      ratioSum += ratio;
    });
    if (row.length) rows.push(row);

    if (gallery.classList.contains("mw-gallery-packed-hover") && boxes.length >= 2) {
      rows.length = 0;
      if (boxes.length === 9) {
        rows.push(boxes.slice(0, 4));
        rows.push(boxes.slice(4, 8));
        rows.push(boxes.slice(8));
      } else {
        const firstRowCount = Math.ceil(boxes.length / 2);
        rows.push(boxes.slice(0, firstRowCount));
        rows.push(boxes.slice(firstRowCount));
      }
    }

    gallery.style.setProperty("--reader-packed-height", "auto");
    rows.forEach((items) => {
      const rowElement = document.createElement("div");
      rowElement.className = "reader-packed-justified-row";
      rowElement.style.setProperty("display", "flex", "important");
      rowElement.style.setProperty("width", "100%", "important");
      rowElement.style.setProperty("gap", `${gap}px`, "important");
      rowElement.style.setProperty("align-items", "flex-start", "important");

      const ratios = items.map((box) => {
        const image = box.querySelector<HTMLImageElement>("img");
        return (Number(image?.getAttribute("width")) || image?.naturalWidth || 1) /
          (Number(image?.getAttribute("height")) || image?.naturalHeight || 1);
      });
      const referenceRow = rows.find((candidate) => candidate.length > 1) || items;
      const referenceRatios = referenceRow.map((box) => {
        const image = box.querySelector<HTMLImageElement>("img");
        return (Number(image?.getAttribute("width")) || image?.naturalWidth || 1) /
          (Number(image?.getAttribute("height")) || image?.naturalHeight || 1);
      });
      const referenceHeight = (galleryWidth - gap * (referenceRow.length - 1)) /
        referenceRatios.reduce((sum, ratio) => sum + ratio, 0);
      const naturalRowHeight = (galleryWidth - gap * (items.length - 1)) /
        ratios.reduce((sum, ratio) => sum + ratio, 0);
      const isPartialRow = items.length < referenceRow.length;
      const height = items.length === 1
        ? Math.min(referenceHeight, targetHeight)
        : isPartialRow
          ? Math.min(naturalRowHeight, targetHeight)
          : naturalRowHeight;

      if (items.length < referenceRow.length && items.length > 1) {
        rowElement.style.setProperty("justify-content", "center", "important");
      }

      if (items.length === 1) {
        rowElement.style.setProperty("width", `${ratios[0] * height}px`, "important");
        rowElement.style.setProperty("margin-inline", "auto", "important");
        rowElement.style.setProperty("justify-content", "flex-start", "important");
      }

      items.forEach((box, index) => {
        const width = ratios[index] * height;
        box.style.setProperty("flex", `0 0 ${width}px`, "important");
        box.style.setProperty("width", `${width}px`, "important");
        box.style.setProperty(
          "height",
          gallery.classList.contains("mw-gallery-packed-hover")
            ? `${height}px`
            : "auto",
          "important",
        );
        const thumb = box.querySelector<HTMLElement>(".thumb");
        const image = box.querySelector<HTMLImageElement>("img");
        thumb?.style.setProperty("height", `${height}px`, "important");
        image?.style.setProperty("height", `${height}px`, "important");
        image?.style.setProperty("object-fit", "cover", "important");
        rowElement.appendChild(box);
      });
      gallery.appendChild(rowElement);
    });
    });
}

function deferReaderPackedHoverGalleryReflow(document: Document) {
  const view = document.defaultView;
  if (!view) return;

  const reflow = (gallery: HTMLElement) => {
    const isHoverGallery = gallery.classList.contains("mw-gallery-packed-hover");
    const rows = Array.from(
      gallery.querySelectorAll<HTMLElement>(
        ":scope > .reader-packed-justified-row",
      ),
    );
    const boxes = rows.length
      ? rows.flatMap((row) =>
          Array.from(row.querySelectorAll<HTMLElement>(":scope > li.gallerybox")),
        )
      : Array.from(
          gallery.querySelectorAll<HTMLElement>(":scope > li.gallerybox"),
        );
    if (boxes.length < 2) return;

    const width = gallery.getBoundingClientRect().width;
    if (!Number.isFinite(width) || width <= 0) return;

    const previousWidth = Number(gallery.dataset.readerPackedLastReflowWidth);
    if (
      rows.length > 0 &&
      Number.isFinite(previousWidth) &&
      Math.abs(width - previousWidth) < 0.5
    ) {
      return;
    }
    gallery.dataset.readerPackedLastReflowWidth = String(width);

    rows.forEach((row) => row.remove());
    const gap = 8;
    const ratios = boxes.map((box) => {
      const image = box.querySelector<HTMLImageElement>("img");
      const sourceWidth = Number(image?.getAttribute("width")) || image?.naturalWidth || 1;
      const sourceHeight = Number(image?.getAttribute("height")) || image?.naturalHeight || 1;
      return sourceWidth / sourceHeight;
    });
    const groups: HTMLElement[][] = [];

    if (isHoverGallery) {
      if (boxes.length === 9) {
        groups.push(boxes.slice(0, 4), boxes.slice(4, 8), boxes.slice(8));
      } else {
        const firstRowCount = Math.ceil(boxes.length / 2);
        groups.push(boxes.slice(0, firstRowCount), boxes.slice(firstRowCount));
      }
    } else {
      const targetHeight = 120;
      let group: HTMLElement[] = [];
      let ratioSum = 0;
      boxes.forEach((box, index) => {
        const nextCount = group.length + 1;
        const nextRatioSum = ratioSum + ratios[index];
        const projectedHeight =
          (width - gap * (nextCount - 1)) / nextRatioSum;

        if (group.length >= 2 && projectedHeight < targetHeight * 0.88) {
          groups.push(group);
          group = [];
          ratioSum = 0;
        }
        group.push(box);
        ratioSum += ratios[index];
      });
      if (group.length) groups.push(group);
    }

    groups.filter((items) => items.length > 0).forEach((items) => {
      const row = document.createElement("div");
      row.className = "reader-packed-justified-row";
      row.style.cssText =
        `display:flex !important;width:100% !important;gap:${gap}px !important;align-items:flex-start !important;`;
      const itemRatios = items.map((box) => ratios[boxes.indexOf(box)]);
      const referenceGroup = groups.reduce(
        (largest, candidate) => candidate.length > largest.length ? candidate : largest,
        groups[0] ?? items,
      );
      const referenceRatios = referenceGroup.map((box) => {
        return ratios[boxes.indexOf(box)];
      });
      const referenceHeight =
        (width - gap * (referenceGroup.length - 1)) /
        referenceRatios.reduce((sum, ratio) => sum + ratio, 0);
      const targetRowHeight = isHoverGallery ? 180 : 120;
      const naturalRowHeight =
        (width - gap * (items.length - 1)) /
        itemRatios.reduce((sum, ratio) => sum + ratio, 0);
      const isPartialRow = items.length < referenceGroup.length;
      const height = items.length === 1
        ? Math.min(referenceHeight, targetRowHeight)
        : isPartialRow
          ? Math.min(naturalRowHeight, targetRowHeight)
          : naturalRowHeight;

      if (isPartialRow && items.length > 1) {
        row.style.setProperty("justify-content", "center", "important");
      }

      if (items.length === 1) {
        row.style.setProperty("width", `${itemRatios[0] * height}px`, "important");
        row.style.setProperty("margin-inline", "auto", "important");
        row.style.setProperty("justify-content", "flex-start", "important");
      }

      items.forEach((box, index) => {
        const boxWidth = itemRatios[index] * height;
        const thumb = box.querySelector<HTMLElement>(".thumb");
        const image = box.querySelector<HTMLImageElement>("img");
        box.style.setProperty("flex", `0 0 ${boxWidth}px`, "important");
        box.style.setProperty("width", `${boxWidth}px`, "important");
        thumb?.style.setProperty("height", `${height}px`, "important");
        image?.style.setProperty("height", `${height}px`, "important");
        image?.style.setProperty("object-fit", "cover", "important");
        if (isHoverGallery) {
          box.style.setProperty("height", `${height}px`, "important");
          thumb?.style.setProperty("background", "#0b0e12", "important");
          image?.style.setProperty("clip-path", "inset(0 4px 4px 0)", "important");
          image?.style.setProperty("-webkit-clip-path", "inset(0 4px 4px 0)", "important");
        }
        row.appendChild(box);
      });
      gallery.appendChild(row);
    });
  };

  const applyCurrentGalleries = () => {
    document
      .querySelectorAll<HTMLElement>(
        "ul.gallery.mw-gallery-packed, ul.gallery.mw-gallery-packed-hover",
      )
      .forEach((gallery) => {
        reflow(gallery);

        if (
          typeof ResizeObserver === "undefined" ||
          gallery.dataset.readerPackedWidthObserved === "true"
        ) {
          return;
        }

        gallery.dataset.readerPackedWidthObserved = "true";
        let lastWidth = gallery.getBoundingClientRect().width;
        const resizeObserver = new ResizeObserver(() => {
          const nextWidth = gallery.getBoundingClientRect().width;
          if (Math.abs(nextWidth - lastWidth) < 0.5) return;

          lastWidth = nextWidth;
          view.requestAnimationFrame(() => reflow(gallery));
        });
        resizeObserver.observe(gallery);
      });
  };

  applyCurrentGalleries();
  view.requestAnimationFrame(() => {
    applyCurrentGalleries();
    view.requestAnimationFrame(applyCurrentGalleries);
  });
  [250, 1000, 3000].forEach((delay) => {
    view.setTimeout(applyCurrentGalleries, delay);
  });

  if (document.body.dataset.readerPackedHoverResizeHook !== "true") {
    document.body.dataset.readerPackedHoverResizeHook = "true";
    view.addEventListener("resize", applyCurrentGalleries);
  }
}

function upgradeReaderPersonSidebarSections(sidebar: HTMLTableElement) {
  if (!sidebar.classList.contains("sidebar-person")) return;

  sidebar.classList.add("reader-person-sidebar");

  sidebar
    .querySelectorAll<HTMLElement>(
      ":scope td.sidebar-content > .hidden-begin",
    )
    .forEach((section) => {
      const title = section.querySelector<HTMLElement>(
        ":scope > .hidden-title",
      );
      const content = section.querySelector<HTMLElement>(
        ":scope > .hidden-content",
      );

      if (!title || !content) return;

      const details = document.createElement("details");
      details.className =
        "reader-sidebar-list-details reader-sidebar-row-details reader-sidebar-person-details";
      details.open = false;

      const summary = document.createElement("summary");
      summary.className =
        "reader-sidebar-list-summary reader-sidebar-row-summary reader-sidebar-person-summary";

      const titleElement = document.createElement("span");
      titleElement.className = "reader-sidebar-row-title";
      while (title.firstChild) {
        titleElement.appendChild(title.firstChild);
      }

      const toggleLabel = document.createElement("span");
      toggleLabel.className = "reader-sidebar-toggle-label";
      toggleLabel.setAttribute("aria-hidden", "true");

      const rowContent = document.createElement("div");
      rowContent.className =
        "sidebar-list-content reader-sidebar-row-content reader-sidebar-person-content";
      while (content.firstChild) {
        rowContent.appendChild(content.firstChild);
      }

      summary.append(titleElement, toggleLabel);
      details.append(summary, rowContent);
      section.replaceWith(details);
    });
}


function upgradeReaderPreservedSidebars(document: Document) {
  document
    .querySelectorAll<HTMLTableElement>(
      'table.sidebar[role="navigation"]',
    )
    .forEach((sidebar) => {
      const sourceBorderColor = sidebar.style.borderColor.trim();

      sidebar.classList.add("reader-preserved-sidebar");
      sidebar.classList.remove("nomobile");

      const sidebarText = sidebar.textContent?.replace(/\s+/g, " ").trim() || "";
      const isElectionTimelineSidebar =
        sidebarText.includes("U.S. Senate elections") &&
        sidebarText.includes("U.S. House of Representatives elections");
      if (isElectionTimelineSidebar) {
        sidebar.classList.add("reader-election-timeline-sidebar");
      }
      if (
        sidebarText.includes("Probability theory") &&
        sidebarText.includes("Bayes' theorem") &&
        sidebarText.includes("Axioms")
      ) {
        sidebar.classList.add("reader-probability-fundamentals-sidebar");
      }

      upgradeReaderPersonSidebarSections(sidebar);

      if (sourceBorderColor) {
        sidebar.style.setProperty(
          "border-color",
          sourceBorderColor,
          "important",
        );
      }

      sidebar
        .querySelector<HTMLElement>(".sidebar-navbar")
        ?.closest("tr")
        ?.remove();

      const footerLists = Array.from(
        sidebar.querySelectorAll<HTMLUListElement>(
          ".sidebar-below > ul",
        ),
      );

      footerLists.forEach((list) => {
        list.classList.remove(
          "reader-sidebar-footer-row",
          "reader-sidebar-footer-primary",
          "reader-sidebar-footer-secondary",
        );
      });

      /*
       * Wikipedia sidebars use either multiple compact footer rows or one
       * ordinary link list. Only flatten the multi-row form; a single list
       * (such as Python's portal/Wikibook footer) remains readable vertically.
       */
      if (footerLists.length > 1) {
        footerLists.forEach((list, index) => {
          list.classList.add("reader-sidebar-footer-row");

          if (index === 0) {
            list.classList.add("reader-sidebar-footer-primary");
          } else if (index === 1) {
            list.classList.add("reader-sidebar-footer-secondary");
          }
        });
      }

      /*
       * A preserved navigation sidebar and its internal layout tables are not
       * ordinary article data tables. Remove stale classifications as well so
       * Inspector prototypes and cached HTML settle into the same layout.
       */
      [sidebar, ...sidebar.querySelectorAll<HTMLTableElement>("table")]
        .forEach((table) => {
          Array.from(table.classList)
            .filter((className) =>
              className === "reader-normal-table" ||
              className.startsWith("reader-normal-table-")
            )
            .forEach((className) => table.classList.remove(className));
        });

      sidebar
        .querySelectorAll<HTMLElement>(".sidebar-list")
        .forEach((list) => {
          const title = list.querySelector<HTMLElement>(
            ":scope > .sidebar-list-title",
          );
          const content = list.querySelector<HTMLElement>(
            ":scope > .sidebar-list-content",
          );

          if (!title || !content) return;

          list
            .querySelector<HTMLElement>(
              ":scope > .mw-collapsible-toggle",
            )
            ?.remove();

          content.removeAttribute("hidden");
          content.style.removeProperty("display");

          const details = document.createElement("details");
          details.className =
            "sidebar-list reader-sidebar-list-details";

          const summary = document.createElement("summary");
          summary.className = "reader-sidebar-list-summary";

          const toggleLabel = document.createElement("span");
          toggleLabel.className = "reader-sidebar-toggle-label";
          toggleLabel.setAttribute("aria-hidden", "true");

          summary.append(title, toggleLabel);
          details.append(summary, content);
          list.replaceWith(details);
        });

      sidebar
        .querySelectorAll<HTMLUListElement>(
          ".sidebar-list-content ul",
        )
        .forEach((list) => {
          const directItems = Array.from(list.children).filter(
            (child): child is HTMLLIElement =>
              child instanceof HTMLLIElement,
          );

          const hasNestedLists = directItems.some((item) =>
            item.querySelector(":scope > ul, :scope > ol"),
          );

          if (
            directItems.length > 10 &&
            !hasNestedLists
          ) {
            list.classList.add("reader-sidebar-long-list");
          }
        });

      /*
       * Row-based Wikipedia series sidebars use alternating heading and
       * content rows rather than .sidebar-list wrappers. Convert each pair to
       * native details/summary controls. Every row-based section starts
       * collapsed; only the dedicated [show]/[hide] target changes expansion.
       */
      sidebar
        .querySelectorAll<HTMLElement>(".sidebar-image figure")
        .forEach((frame) => {
          frame.classList.add("reader-sidebar-image-frame");
          frame.classList.remove(
            "reader-editor-width-image-card",
            "reader-portrait-media",
          );

          [
            "--reader-editor-image-width",
            "display",
            "width",
            "min-width",
            "max-width",
            "height",
            "margin",
            "padding",
            "box-sizing",
          ].forEach((property) => {
            frame.style.removeProperty(property);
          });

          frame
            .querySelectorAll<HTMLElement>(":scope > figcaption")
            .forEach((caption) => {
              const hasCaptionContent =
                Boolean((caption.textContent ?? "").trim()) ||
                Boolean(
                  caption.querySelector(
                    "img, svg, video, audio, canvas",
                  ),
                );

              if (!hasCaptionContent) {
                caption.remove();
              }
            });
        });

      const directRows = Array.from(sidebar.tBodies).flatMap(
        (body) =>
          Array.from(body.children).filter(
            (child): child is HTMLTableRowElement =>
              child instanceof HTMLTableRowElement,
          ),
      );

      let upgradedRowSection = false;

      directRows.forEach((headingRow, rowIndex) => {
        const heading =
          headingRow.querySelector<HTMLTableCellElement>(
            ":scope > th.sidebar-heading, :scope > td.sidebar-heading",
          );
        const contentRow = directRows[rowIndex + 1];
        const contentCell =
          contentRow?.querySelector<HTMLTableCellElement>(
            ":scope > td, :scope > th",
          );

        if (!heading || !contentRow?.isConnected || !contentCell) {
          return;
        }

        if (
          isElectionTimelineSidebar &&
          /U\.S\. Senate elections/i.test(heading.textContent ?? "")
        ) {
          contentCell.classList.add("reader-senate-election-content");
        }

        if (
          isElectionTimelineSidebar &&
          /U\.S\. House of Representatives elections/i.test(
            heading.textContent ?? "",
          )
        ) {
          contentCell.classList.add("reader-house-election-content");
        }

        const rootLists = Array.from(
          contentCell.querySelectorAll<
            HTMLUListElement | HTMLOListElement
          >("ul, ol"),
        ).filter(
          (list) => !list.parentElement?.closest("ul, ol"),
        );

        rootLists.forEach((list) => {
          const directItems = Array.from(list.children).filter(
            (child): child is HTMLLIElement =>
              child instanceof HTMLLIElement,
          );

          list.classList.remove(
            "reader-sidebar-dense-list",
            "reader-sidebar-vertical-list",
          );
          list.classList.add(
            directItems.length > 10
              ? "reader-sidebar-dense-list"
              : "reader-sidebar-vertical-list",
          );
        });

        const details = document.createElement("details");
        details.className =
          "reader-sidebar-list-details reader-sidebar-row-details";
        details.open = true;

        const summary = document.createElement("summary");
        summary.className =
          "reader-sidebar-list-summary reader-sidebar-row-summary";

        const title = document.createElement("span");
        title.className = "reader-sidebar-row-title";

        while (heading.firstChild) {
          title.appendChild(heading.firstChild);
        }

        const toggleLabel = document.createElement("span");
        toggleLabel.className = "reader-sidebar-toggle-label";
        toggleLabel.setAttribute("aria-hidden", "true");

        const content = document.createElement("div");
        content.className =
          "sidebar-list-content reader-sidebar-row-content";

        while (contentCell.firstChild) {
          content.appendChild(contentCell.firstChild);
        }

        summary.append(title, toggleLabel);
        details.append(summary, content);

        const sectionCell = document.createElement("td");
        sectionCell.className = "reader-sidebar-section-cell";
        sectionCell.colSpan = Math.max(
          heading.colSpan,
          contentCell.colSpan,
          1,
        );
        sectionCell.appendChild(details);

        headingRow.classList.add("reader-sidebar-section-row");
        headingRow.replaceChildren(sectionCell);
        contentRow.remove();

        upgradedRowSection = true;
      });

      if (upgradedRowSection) {
        sidebar.classList.add("reader-sidebar-row-sections");
      }
    });
}


function wikipediaPortalLinkTarget(link: HTMLAnchorElement) {
  const dataTarget = link.dataset.wikiTarget;

  if (dataTarget) {
    return dataTarget;
  }

  const href = link.getAttribute("href") || "";

  // MediaWiki's rendered HTML can use a page-relative portal link instead of
  // the usual /wiki/ path. Normalize those forms before handing the link to
  // the external-link and navbox-footer handling below.
  const relativePortalMatch = href.match(
    /^(?:\.\/wiki\/|\.\/)?(Portal\s*:[^?#]+)(?:[?#].*)?$/i,
  );
  if (relativePortalMatch) {
    return decodeURIComponent(relativePortalMatch[1]);
  }

  try {
    const url = new URL(href, "https://en.wikipedia.org");

    if (
      url.hostname === "en.wikipedia.org" &&
      url.pathname.startsWith("/wiki/")
    ) {
      return decodeURIComponent(
        url.pathname.slice("/wiki/".length),
      );
    }

    if (
      url.hostname === "en.wikipedia.org" &&
      url.pathname === "/w/index.php"
    ) {
      return url.searchParams.get("title") || "";
    }

    if (
      url.hostname === "en.wikipedia.org" &&
      /^\/Portal\s*:/i.test(url.pathname)
    ) {
      return decodeURIComponent(url.pathname.slice(1));
    }
  } catch {
    return "";
  }

  return "";
}

function preserveReaderPortalLinks(document: Document) {
  const portalLinks = Array.from(
    document.querySelectorAll<HTMLAnchorElement>("a"),
  ).filter((link) =>
    isWikipediaPortalTitle(wikipediaPortalLinkTarget(link)),
  );

  portalLinks.forEach((link) => {
    if (!link.isConnected) return;

    const target = wikipediaPortalLinkTarget(link);
    if (!target) return;

    link.href = `https://en.wikipedia.org/wiki/${encodeURIComponent(target).replace(/%3A/gi, ":")}`;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.removeAttribute("data-wiki-target");

    link.closest<HTMLElement>(".portalbox, .portal-bar, .sistersitebox")
      ?.classList.add("reader-portal-box");
  });

  document.querySelectorAll<HTMLElement>(
    ".portalbox, .portal-bar, .sistersitebox",
  ).forEach((container) => {
    if (container.querySelector("a[href^='https://en.wikipedia.org/wiki/Portal:']")) {
      container.classList.add("reader-portal-box");
    }
  });
}

function restoreReaderTableNotes(document: Document) {
  const noteLists = Array.from(document.querySelectorAll<HTMLDListElement>("dl")).filter(
    (list) =>
      Array.from(list.children).some(
        (child) =>
          child.matches("dt") &&
          child.textContent?.replace(/\s+/g, " ").trim().toLowerCase() ===
            "table notes",
      ),
  );

  if (noteLists.length === 0) return;

  const noteLetters = new Map<string, string>();

  document
    .querySelectorAll<HTMLAnchorElement>(
      "sup.reference a[href^='#cite_note-']",
    )
    .forEach((sourceLink) => {
      const letter = sourceLink.textContent?.match(/^\[\s*([a-z]+)\s*\]$/i)?.[1];
      const noteId = sourceLink.getAttribute("href")?.slice(1);
      if (letter && noteId) noteLetters.set(noteId, letter.toLowerCase());
    });

  document
    .querySelectorAll<HTMLElement>("table.wikitable sup.reference")
    .forEach((sourceMarker) => {
      const sourceLink = sourceMarker.querySelector<HTMLAnchorElement>(
        "a[href^='#cite_note-']",
      );
      const letter = sourceLink?.textContent?.match(/^\[\s*([a-z]+)\s*\]$/i)?.[1];
      if (!letter) return;

      const marker = document.createElement("sup");
      marker.className = "reader-table-note-marker";
      marker.textContent = `[${letter.toLowerCase()}]`;
      sourceMarker.replaceWith(marker);
    });

  const notes = Array.from(
    document.querySelectorAll<HTMLLIElement>(
      "ol.references li[id^='cite_note-']",
    ),
  )
    .map((item) => {
      const letter = noteLetters.get(item.id) || "";
      const sourceText = item.querySelector<HTMLElement>(
        ".mw-reference-text, .reference-text",
      );
      const text = sourceText
        ? (() => {
            const copy = sourceText.cloneNode(true) as HTMLElement;
            copy
              .querySelectorAll(
                ".mw-cite-backlink, .mw-editsection, sup.reference, sup.mw-ref",
              )
              .forEach((element) => element.remove());
            return copy.textContent?.replace(/\s+/g, " ").trim() || "";
          })()
        : "";

      return { letter, text };
    })
    .filter(({ letter, text }) => /^[a-z]+$/i.test(letter) && text.length > 0)
    .sort((left, right) => left.letter.localeCompare(right.letter));

  if (notes.length === 0) return;

  noteLists.forEach((definitionList) => {
    if (definitionList.querySelector(":scope > dd")) return;

    const definition = document.createElement("dd");
    definition.className = "reader-table-notes";
    const orderedList = document.createElement("ol");
    orderedList.type = "a";

    notes.forEach(({ text }) => {
      const item = document.createElement("li");
      item.textContent = text;
      orderedList.append(item);
    });

    definition.append(orderedList);
    definitionList.append(definition);
  });
}

function sanitizeWikipediaHtml(html: string, pageTitle = "") {
  const document = new DOMParser().parseFromString(html, "text/html");
  document.querySelectorAll<HTMLElement>("ul, ol").forEach((list) => {
    const text = (list.textContent || "").replace(/\s+/g, " ").trim();
    const hasRouteText = /\b(?:I-\d+|US \d+)\b/.test(text);
    const hasRouteImages = list.querySelectorAll("img").length >= 2;

    if (hasRouteText && hasRouteImages) {
      list.classList.add("reader-route-list");
    }
  });
  const routeMapRows = new Set<HTMLTableRowElement>();

  document.querySelectorAll("table.RMinline, table.routemap").forEach((map) => {
    const row = map.closest("tr");
    if (row) routeMapRows.add(row);
    else map.remove();
  });

  routeMapRows.forEach((row) => row.remove());

  document.querySelectorAll("tr").forEach((row) => {
    const text = row.textContent?.replace(/[[:space:]]+/g, " ").trim() || "";
    if (/^(?:hide[[:space:]]*)?Track layout$/i.test(text)) row.remove();
  });
  if (isReaderCategoryPageTitle(pageTitle)) {
    document.querySelectorAll(".toc, #toc, .toctitle").forEach((element) => element.remove());
  }
  document
    .querySelectorAll('a[title="Edit this at Wikidata"]')
    .forEach((element) => element.remove());
  const openStreetMapUrl = getArticleOpenStreetMapUrl(document);
  const locatorMapSelector = [
    ".mw-kartographer-container",
    ".mw-kartographer-map",
    ".mapframe",
    ".locmap",
    ".location-map",
    ".locationmap",
    ".location-map-container",
  ].join(", ");

  const locatorMapFrameSelector = [
    "figure",
    ".thumb",
    ".mw-default-size",
    ".noresize",
    ".floatleft",
    ".floatright",
    ".tleft",
    ".tright",
    ".tnone",
    ".center",
    ".mw-halign-left",
    ".mw-halign-right",
    ".mw-halign-center",
  ].join(", ");

  if (openStreetMapUrl) {
    const makeOpenStreetMapTarget = (element: HTMLElement) => {
      element.dataset.openstreetmapUrl = openStreetMapUrl;
      if (pageTitle) element.dataset.openstreetmapPageTitle = pageTitle;
      element.classList.add("reader-openstreetmap-target");
      element.setAttribute("role", "link");
      element.setAttribute("tabindex", "0");
      element.setAttribute("title", "Open in OpenStreetMap");

      if (element instanceof HTMLAnchorElement) {
        element.href = openStreetMapUrl;
        element.target = "_blank";
        element.rel = "noreferrer";
      }

      element
        .querySelectorAll<HTMLElement>("a, img, picture, svg")
        .forEach((child) => {
          child.dataset.openstreetmapUrl = openStreetMapUrl;
          if (pageTitle) child.dataset.openstreetmapPageTitle = pageTitle;
          child.classList.add("reader-openstreetmap-target");
          child.setAttribute("title", "Open in OpenStreetMap");

          if (child instanceof HTMLAnchorElement) {
            child.href = openStreetMapUrl;
            child.target = "_blank";
            child.rel = "noreferrer";
          }
        });
    };

    document
      .querySelectorAll<HTMLElement>(locatorMapSelector)
      .forEach((element) => {
        // Preserve the individual Wikipedia links in multi-point static maps.
        if (
          element.matches(".locmap") &&
          element.querySelectorAll(".od").length >= 2
        ) {
          return;
        }

        // Do not make a whole switcher/container clickable.
        // Only the actual map pieces should open OpenStreetMap.
        if (
          element.matches(".location-map-container") &&
          element.querySelector(".switcher-label, .switcher-element")
        ) {
          return;
        }

        makeOpenStreetMapTarget(element);
      });

    document.querySelectorAll<HTMLElement>(".infobox img").forEach((image) => {
      const searchText = [
        image.getAttribute("alt") || "",
        image.getAttribute("src") || "",
        image.closest("td, th")?.textContent || "",
        image.closest("td, th")?.className.toString() || "",
      ].join(" ");

      if (!/\b(map|locator|location map|openstreetmap|osm)\b/i.test(searchText)) {
        return;
      }

      const target =
        image.closest<HTMLElement>("a, figure, .thumb, .locmap, .location-map, .locationmap, .mapframe, .mw-kartographer-container, .mw-kartographer-map") || image;

      makeOpenStreetMapTarget(target);
    });
  }

  upgradeReaderPreservedSidebars(document);

  restoreReaderTableNotes(document);
  removeReaderCitationOnlyColumns(document);

  document.querySelectorAll([
    "script", "style", "link", "meta", "iframe", "object", "embed", "form",
    "button", "input",     ".sidebar:not(.reader-preserved-sidebar)", ".metadata", ".ambox", ".shortdescription",
    ".mw-editsection", ".mw-references-wrap", ".reflist", ".reference", ".nomobile",
  ].join(",")).forEach((element) => element.remove());

  document
    .querySelectorAll<HTMLElement>(
      ".noprint:not(.portalbox):not(.portal-bar):not(.sistersitebox)",
    )
    .forEach((element) => {
      const text = (element.textContent || "").replace(/\s+/g, " ").trim();
      const containsAgeAnnotation = /\b(?:age|aged)\s+\d{1,3}\b/i.test(text);

      if (!containsAgeAnnotation) element.remove();
    });

  removeReaderUnsupportedGraphicalTimelines(document);
  markReaderPositionedHorizontalTimelines(document);
  markReaderPositionedLegacyCharts(document);

  document.querySelectorAll<HTMLElement>("*").forEach((element) => {
    for (const attribute of [...element.attributes]) {
      const locatorMapFrame = element.closest<HTMLElement>(locatorMapFrameSelector);
      const isInsideLocatorMap = Boolean(
        element.matches(locatorMapSelector) ||
          element.closest(locatorMapSelector) ||
          locatorMapFrame?.querySelector(locatorMapSelector),
      );
      const isInsideLocationMapSwitcher = Boolean(
        element.closest(
          ".switcher-container, .switcher-element, .reader-location-map-switcher, .reader-location-map-panel, .reader-location-map-panels",
        ),
      );
      const isInsidePositionedHorizontalTimeline = Boolean(
        element.closest(
          ".reader-positioned-horizontal-timeline",
        ),
      );
      const isDivCol = element.matches(".div-col");
      const shouldPreserveInlineStyle =
        attribute.name === "style" &&
        (
          isInsideLocatorMap ||
          isInsideLocationMapSwitcher ||
          isInsidePositionedHorizontalTimeline ||
          isDivCol
        );

      if (attribute.name === "style") {
        if (shouldPreserveInlineStyle) continue;

        const staticImageMapHost = element.closest<HTMLElement>(".noresize");
        const preserveStaticImageMapPositioning =
          staticImageMapHost !== null &&
          staticImageMapHost.querySelector("img") !== null &&
          staticImageMapHost.querySelectorAll("a").length >= 10;
        const annotatedImageHost = element.closest<HTMLElement>(
          ".thumbimage, .reader-editor-width-image-card",
        );
        const preserveAnnotatedImagePositioning =
          element.matches("[id^='annotation_']") ||
          element.querySelector("[id^='annotation_']") !== null ||
          Boolean(annotatedImageHost?.querySelector("[id^='annotation_']"));
        const preservePositioning =
          element.closest(".infobox-image, .reader-infobox-top-media-cell") !== null &&
          attribute.value.split(";").some((declaration) => {
            const separator = declaration.indexOf(":");
            if (separator < 0) return false;
            return (
              declaration.slice(0, separator).trim().toLowerCase() === "position" &&
              /^(absolute|relative)$/i.test(declaration.slice(separator + 1).trim())
            );
          }) ||
          preserveStaticImageMapPositioning ||
          preserveAnnotatedImagePositioning ||
          element.closest(".reader-legacy-positioned-chart-ready") !== null;
        const isTreeChartConnector =
          element.matches("td, th") &&
          element.closest("table.tree-chart") !== null &&
          !(element.textContent || "").replace(/\s+/g, " ").trim();
        const preservedStyle = sanitizeReaderVisualStyle(
          attribute.value,
          preservePositioning,
          isTreeChartConnector,
        );
        if (preservedStyle.style) {
          element.setAttribute("style", preservedStyle.style);
          preservedStyle.classNames.forEach((className) => {
            element.classList.add(className);
          });
          continue;
        }

        element.removeAttribute(attribute.name);
        continue;
      }

      if (attribute.name.startsWith("on") || attribute.name === "srcset") {
        element.removeAttribute(attribute.name);
      }
    }
  });

  preserveReaderPortalLinks(document);

  document.querySelectorAll<HTMLAnchorElement>("a").forEach((link) => {
    const href = link.getAttribute("href") || "";

    if (link.dataset.openstreetmapUrl) {
      link.href = link.dataset.openstreetmapUrl;
      link.target = "_blank";
      link.rel = "noreferrer";
      return;
    }
    if (href.startsWith("/wiki/")) {
      const encodedTarget = href.slice("/wiki/".length);

      try {
        link.dataset.wikiTarget = decodeURIComponent(encodedTarget);
      } catch {
        // Preserve malformed Wikipedia paths so one bad link cannot abort the article.
        link.dataset.wikiTarget = encodedTarget;
      }

      link.removeAttribute("href");
    } else if (href.startsWith("#") && pageTitle) {
      link.dataset.wikiTarget = `${pageTitle}${href}`;
      link.removeAttribute("href");
    } else if (href.startsWith("//")) {
      link.href = `https:${href}`;
      link.target = "_blank";
      link.rel = "noreferrer";
    } else if (/^https?:/.test(href)) {
      link.target = "_blank";
      link.rel = "noreferrer";
    } else {
      link.removeAttribute("href");
    }
  });

  /*
   * Load lead, infobox, and first-section imagery with the initial article.
   * Images below the first section keep their dimensions but receive their
   * real URLs later, after the complete article text has painted. This is
   * deferred source assignment, not native browser lazy loading.
   */
  const firstArticleSectionHeading = document.querySelector(
    ".mw-heading2, h2",
  );

  document
    .querySelectorAll<HTMLImageElement>("img")
    .forEach((image, imageIndex) => {
      const source = image.getAttribute("src") || "";
      if (!source) return;

      const initialNormalizedSource = source.startsWith("//")
        ? `https:${source}`
        : source;
      const isInfoboxLogoSvg =
        Boolean(image.closest(".infobox")) &&
        /\.svg(?:\.png)?(?:[?#]|$)/i.test(initialNormalizedSource) &&
        /logo/i.test(initialNormalizedSource + " " + image.alt + " " + image.title);
      const normalizedSource = isInfoboxLogoSvg
        ? initialNormalizedSource.replace(
            /^https?:\/\/(?:thumb|upload)\.wikimedia\.org\/wikipedia\/commons\/thumb(\/(?:[^/]+\/){2}[^/]+\.svg)\/\d+px-[^/]+\.svg\.png(?:\?.*)?$/i,
            "https://upload.wikimedia.org/wikipedia/commons$1",
          )
        : initialNormalizedSource;

      const appearsBeforeFirstSection = Boolean(
        firstArticleSectionHeading &&
          (image.compareDocumentPosition(firstArticleSectionHeading) &
            Node.DOCUMENT_POSITION_FOLLOWING),
      );

      const isNotationImage =
        image.matches(
          ".mwe-math-fallback-image-inline, .mwe-math-fallback-image-display",
        ) || Boolean(image.closest(".mwe-math-element, .chemf"));

      const shouldLoadImmediately =
        source.startsWith("data:") ||
        isNotationImage ||
        appearsBeforeFirstSection ||
        (!firstArticleSectionHeading && imageIndex < 4);

      image.loading = "eager";

      if (shouldLoadImmediately) {
        image.src = normalizedSource;
        return;
      }

      image.dataset.readerDeferredSrc = normalizedSource;
      image.src = READER_DEFERRED_IMAGE_PLACEHOLDER;
    });

  markReaderPackedGalleryWidths(document);
  deferReaderPackedHoverGalleryReflow(document);

  markReaderArticleOsmLocationMaps(document);
  upgradeReaderLocationMapSwitchers(document);
  markReaderArticleLocationMapPoints(document);

  placeReaderCalculatedLocationMapMarkers(document, pageTitle);

  removeReaderSections(document, new Set(["references", "notes"]));

  fixInfoboxOrphanPunctuation(document);

  removeReaderOtherNativeNames(document);

  cleanupReaderInfoboxBlankRows(document);

  markReaderLongUrlInfoboxes(document);

  markReaderInfoboxInlineIcons(document);

  markReaderInfoboxColorSwatches(document);

  markReaderCountyResultsTotalsRows(document);

  markReaderSortableColumnHeaders(document);
  pinReaderAllSortableFooterRowsToBottom(document);
  markReaderExternalTableCaptions(document);
  markReaderBarBoxes(document);
  markReaderTableColorSwatches(document);
  markReaderScoreIndexColorColumns(document);

  markReaderNormalTableAlignment(document);
  repairReaderNbaCupGroupQualificationColumn(document);
  addReaderGameLogCollapsibleControls(document);
  markReaderCompactLegendTables(document);
  enhanceReaderElectricalEquationTables(document);
  markReaderPairedCollapsibleTables(document);
  markReaderTreeChart(document);
  markReaderCollapsibleMapFrames(document);
  markReaderElectronConfigurationTable(document);
  markReaderPeriodicTableLayout(document);
  markReaderElementInfoboxPeriodicTables(document);
  markReaderNormalTableVerticalAlignment(document);

  polishReaderTemplateNavigationAndRosterTables(document);
  markReaderStandaloneNotesParagraphs(document);
  markReaderGroupedSortableHeaders(document);
  markReaderTablesAfterFloatedLocationMaps(document);

  markReaderCityHistoryTables(document);

  markReaderSportsMatrixTables(document);

  markReaderSportsMatrixNotes(document);

  markReaderStateChampionsTables(document);

  moveInfoboxSideCaptionsBelowImages(document);

  normalizeReaderTopInfoboxMediaRows(document);
  polishReaderInfoboxTopMedia(document);

  makeReaderInfoboxMediaImagesClickable(document);

  markReaderStaticImageMaps(document);
  polishReaderAdministrativeDivisionMapLayouts(document);

  markReaderInfoboxUniformImageLabels(document);
  polishReaderInfoboxImageSpacing(document);

  markReaderEditorWidthImageCards(document);

  markReaderCaptionedTablesBesideRightMedia(document);

  markReaderParagraphsAfterFloatingTables(document);

  polishReaderStationServiceTables(document);

  polishReaderMultiTranscriptionInfoboxes(document);
  polishReaderNutritionInfoboxes(document);

  removeReaderHatnotes(document);

  prepareReaderTemplateDocumentation(document, pageTitle);
  collapseReaderNavboxes(document);
  collapseReaderCollapsibleTableNavboxes(document);
  collapseReaderTopicTocBoxes(document);


  markReaderMultipleImageBlocks(document);

  markReaderImageMapFallbacks(document);
  markReaderGuiyangAdministrativeDivisionMap(document);

  markReaderLayoutTables(document);
  markReaderSectionsAfterFloatingBlocks(document);
  markReaderCottonFlowchart(document);
  markReaderProcessorHardwareLayoutTable(document);

  markReaderLightBackgroundTableCells(document);
  markReaderNominationTableHeaders(document);
  markReaderDarkModeLightFooterLabelCells(document);

  markReaderHighwayLists(document);

  markReaderPresidentialResultsTables(document);

  markReaderDarkDataCharts(document);

  upgradeReaderEngagements(document);

  markReaderCenteredInsigniaTable(document);

  addReaderStaticRowNumbers(document);

  wrapReaderWideTables(document);
  pinReaderAllSortableFooterRowsToBottom(document);

  markReaderVerticalSortableHeaders(document);

  markReaderPresidentialResultsTables(document);

  upgradeReaderClimateTables(document);

  upgradeReaderDemographicTables(document);

  upgradeReaderPieChartThumbs(document);

  markReaderLeadParagraph(document);

  markReaderVisitedWikiLinks(document);

  squareReaderWikipediaContentCorners(document);

  removeReaderUnsupportedCladeTrees(document);

  // Run once more after all article transformations so packed-hover galleries
  // are measured in their final layout context.
  deferReaderPackedHoverGalleryReflow(document);

  const sections = collectReaderSections(document);

  return {
    html: document.body.innerHTML,
    sections,
  };
}


function collapseReaderTopicTocBoxes(document: Document) {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>("table, div"),
  ).filter((box) => {
    if (
      box.closest(
        ".infobox, .reader-topic-toc-details, .reader-navbox-details, .reader-climate-details, .reader-demographic-box",
      )
    ) {
      return false;
    }

    const text = cleanReaderNavboxText(box.textContent || "");

    if (!text || text.length > 1200) return false;

    const linkCount = box.querySelectorAll("a").length;

    return (
      linkCount >= 5 &&
      /Index\s*\(Alphabetical indices\)/i.test(text) &&
      /\bNavigation\b/i.test(text) &&
      /\b(Cities|Towns|Villages|People|Records|Outline|Portal|Category)\b/i.test(text)
    );
  });

  const innermostCandidates = candidates.filter(
    (candidate) =>
      !candidates.some(
        (other) => other !== candidate && candidate.contains(other),
      ),
  );

  innermostCandidates.forEach((box) => {
    const firstGoodLink = Array.from(box.querySelectorAll<HTMLAnchorElement>("a"))
      .map((link) => cleanReaderNavboxText(link.textContent || ""))
      .find(
        (label) =>
          label &&
          !/^[vte]$/i.test(label) &&
          !/^(show|hide|edit|category|portal)$/i.test(label) &&
          label.length <= 40,
      );

    const title = firstGoodLink
      ? `${firstGoodLink} navigation`
      : "Related navigation";

    const details = document.createElement("details");
    details.className = "reader-navbox-details reader-topic-toc-details";

    const summary = document.createElement("summary");

    const titleSpan = document.createElement("span");
    titleSpan.textContent = title;

    const showSpan = document.createElement("span");
    showSpan.className = "reader-navbox-show";

    const showOpenBracket = document.createElement("span");
    showOpenBracket.className = "reader-navbox-show-bracket";
    showOpenBracket.textContent = "[";
    const showLabel = document.createElement("span");
    showLabel.className = "reader-navbox-show-label";
    showLabel.textContent = "show";
    const showCloseBracket = document.createElement("span");
    showCloseBracket.className = "reader-navbox-show-bracket";
    showCloseBracket.textContent = "]";
    showSpan.append(showOpenBracket, showLabel, showCloseBracket);
    details.addEventListener("toggle", () => {
      showLabel.textContent = details.open ? "hide" : "show";
    });

    summary.append(titleSpan, showSpan);

    const body = document.createElement("div");
    body.className = "reader-navbox-body reader-topic-toc-body";

    box.parentNode?.insertBefore(details, box);
    body.append(box);
    details.append(summary, body);
  });
}

function collapseReaderNavboxes(document: Document) {
  const navboxes = Array.from(
    document.querySelectorAll<HTMLElement>(".navbox, .vertical-navbox"),
  ).reverse();

  navboxes.forEach((navbox) => {
    const titleElement =
      navbox.querySelector<HTMLElement>(".navbox-title") ||
      navbox.querySelector<HTMLElement>("caption") ||
      navbox.querySelector<HTMLElement>("th");

    const title = titleElement
      ? readerNavboxVisibleText(titleElement)
      : "Related articles";

    const isVerticalCampaignBox =
      navbox.matches(".vertical-navbox, .navbox-vertical") ||
      Boolean(navbox.querySelector(".vertical-navbox, .navbox-vertical"));

    const details = document.createElement("details");
    details.className = isVerticalCampaignBox
      ? "reader-navbox-details reader-navbox-vertical"
      : "reader-navbox-details";

    const summary = document.createElement("summary");

    const titleSpan = document.createElement("span");
    titleSpan.style.flex = "1";
    titleSpan.style.textAlign = "center";

    appendReaderNavboxTitleContent(
      titleSpan,
      titleElement,
      title || "Related articles",
    );

    const showSpan = document.createElement("span");
    showSpan.className = "reader-navbox-show";

    const showOpenBracket = document.createElement("span");
    showOpenBracket.className = "reader-navbox-show-bracket";
    showOpenBracket.textContent = "[";
    const showLabel = document.createElement("span");
    showLabel.className = "reader-navbox-show-label";
    showLabel.textContent = "show";
    const showCloseBracket = document.createElement("span");
    showCloseBracket.className = "reader-navbox-show-bracket";
    showCloseBracket.textContent = "]";
    showSpan.append(showOpenBracket, showLabel, showCloseBracket);
    details.addEventListener("toggle", () => {
      showLabel.textContent = details.open ? "hide" : "show";
    });

    summary.append(titleSpan, showSpan);

    const body = document.createElement("div");
    body.className = "reader-navbox-body";

    const above = buildReaderNavboxAbove(document, navbox);
    if (above) body.append(above);

    const directNestedDetails = Array.from(
      navbox.querySelectorAll<HTMLElement>(".reader-navbox-details"),
    ).filter(
      (child) =>
        child.parentElement?.closest<HTMLElement>(".navbox, .vertical-navbox") ===
        navbox,
    );

    const rows = buildReaderNavboxRows(document, navbox, directNestedDetails);
    rows.forEach((row) => body.append(row));
    directNestedDetails.forEach((child) => body.append(child));

    if (rows.length === 0 && directNestedDetails.length === 0) {
      const fallback = document.createElement("div");
      fallback.className = "reader-navbox-link-grid";
      appendReaderNavboxLinks(
        document,
        fallback,
        collectReaderNavboxLinks(document, navbox),
      );
      body.append(fallback);
    }

    const footer = buildReaderNavboxFooter(document, navbox, title);
    if (footer) body.append(footer);

    // Match the visible label to the final initial state, including nested boxes
    // that start open before their first toggle event can fire.
    showLabel.textContent = details.open ? "hide" : "show";

    details.append(summary, body);
    navbox.replaceWith(details);
  });
}

/**
 * Some article-level navboxes, including the Global Partners network lists,
 * arrive as collapsed two-row wikitable elements rather than `.navbox` markup.
 * Preserve their authored body markup while giving them the same full-width
 * show/hide shell as regular navboxes.
 */
function collapseReaderCollapsibleTableNavboxes(document: Document) {
  const candidates = Array.from(
    document.querySelectorAll<HTMLTableElement>("table.wikitable.collapsible"),
  );

  candidates.forEach((table) => {
    if (
      table.closest(
        ".infobox, .navbox, .vertical-navbox, .reader-preserved-sidebar, .reader-navbox-details",
      ) ||
      table.rows.length !== 2
    ) {
      return;
    }

    const titleCell = table.rows[0].cells[0];
    const contentCell = table.rows[1].cells[0];
    if (
      table.rows[0].cells.length !== 1 ||
      table.rows[1].cells.length !== 1 ||
      titleCell?.tagName !== "TH" ||
      contentCell?.tagName !== "TD"
    ) {
      return;
    }

    const title = readerNavboxVisibleText(titleCell);
    const hasNavboxTitle = /\b(?:network|partner|sister cit(?:y|ies))\b/i.test(title);
    const linkCount = contentCell.querySelectorAll("a[href], a[data-wiki-target]").length;
    if (!hasNavboxTitle || linkCount < 8) return;

    const details = document.createElement("details");
    details.className = "reader-navbox-details reader-navbox-imported-table";
    details.open = !table.classList.contains("collapsed");

    const summary = document.createElement("summary");
    const titleSpan = document.createElement("span");
    titleSpan.style.flex = "1";
    titleSpan.style.textAlign = "center";

    appendReaderNavboxTitleContent(titleSpan, titleCell, title);

    const showSpan = document.createElement("span");
    showSpan.className = "reader-navbox-show";
    const openBracket = document.createElement("span");
    openBracket.className = "reader-navbox-show-bracket";
    openBracket.textContent = "[";
    const showLabel = document.createElement("span");
    showLabel.className = "reader-navbox-show-label";
    const closeBracket = document.createElement("span");
    closeBracket.className = "reader-navbox-show-bracket";
    closeBracket.textContent = "]";
    showSpan.append(openBracket, showLabel, closeBracket);
    const updateLabel = () => {
      showLabel.textContent = details.open ? "hide" : "show";
    };
    details.addEventListener("toggle", updateLabel);
    updateLabel();
    summary.append(titleSpan, showSpan);

    const body = document.createElement("div");
    body.className = "reader-navbox-body reader-navbox-table-body";
    while (contentCell.firstChild) body.append(contentCell.firstChild);

    details.append(summary, body);
    table.replaceWith(details);
  });
}

function buildReaderNavboxAbove(document: Document, navbox: HTMLElement) {
  const firstGroup = navbox.querySelector<HTMLElement>(".navbox-group");
  const aboveRows = Array.from(
    navbox.querySelectorAll<HTMLElement>(".navbox-abovebelow"),
  ).filter((row) => {
    if (row.closest<HTMLElement>(".navbox, .vertical-navbox") !== navbox) {
      return false;
    }

    return (
      !firstGroup ||
      Boolean(row.compareDocumentPosition(firstGroup) & Node.DOCUMENT_POSITION_FOLLOWING)
    );
  });

  const contentRows = aboveRows.filter((row) =>
    cleanReaderNavboxText(row.textContent || ""),
  );
  if (contentRows.length === 0) return null;

  const above = document.createElement("div");
  above.className = "reader-navbox-above";

  contentRows.forEach((row) => {
    const cell = row.querySelector<HTMLElement>(":scope > td, :scope > th");
    const source = cell || row;
    const clone = source.cloneNode(true) as HTMLElement;
    clone.removeAttribute("class");
    clone.removeAttribute("style");
    clone
      .querySelectorAll<HTMLElement>(".navbar, .mw-editsection, .mw-collapsible-toggle, .noprint")
      .forEach((item) => item.remove());
    clone.querySelectorAll<HTMLElement>("[style]").forEach((item) => {
      item.removeAttribute("style");
    });

    while (clone.firstChild) above.append(clone.firstChild);
  });

  return above;
}

function buildReaderNavboxFooter(
  document: Document,
  navbox: HTMLElement,
  navboxTitle: string,
) {
  const firstGroup = navbox.querySelector<HTMLElement>(".navbox-group");
  const footerRows = Array.from(
    navbox.querySelectorAll<HTMLElement>(
      ".navbox-abovebelow, .navbox-below, .navbox-footer",
    ),
  ).filter(
    (row) =>
      row.closest<HTMLElement>(".navbox, .vertical-navbox") === navbox &&
      (!firstGroup ||
        !(
          row.compareDocumentPosition(firstGroup) &
          Node.DOCUMENT_POSITION_FOLLOWING
        )),
  );

  if (footerRows.length === 0) return null;

  const footer = document.createElement("div");
  footer.className = "reader-navbox-footer";
  const seen = new Set<string>();

  footerRows.forEach((row) => {
    row.querySelectorAll<HTMLAnchorElement>("a").forEach((sourceLink) => {
      if (sourceLink.closest(".navbar, .mw-editsection, .mw-collapsible-toggle")) {
        return;
      }

      const sourceIcon = sourceLink.previousElementSibling as HTMLElement | null;
      const marker = sourceIcon?.matches(".noviewer")
        ? sourceIcon
        : sourceIcon?.querySelector<HTMLElement>(".noviewer") || null;
      const markerTitle =
        marker?.querySelector<HTMLElement>("[title]")?.getAttribute("title") ||
        marker?.getAttribute("data-mw") ||
        "";
      const isCategory = /category/i.test(markerTitle);
      const isList = /list(?:-class)?\s+article/i.test(markerTitle);
      const isPortal = isWikipediaPortalTitle(
        wikipediaPortalLinkTarget(sourceLink),
      );
      const isCommons = (() => {
        try {
          return new URL(sourceLink.href).hostname === "commons.wikimedia.org";
        } catch {
          return false;
        }
      })();

      if (!isCategory && !isList && !isPortal && !isCommons) return;

      const label = cleanReaderNavboxText(sourceLink.textContent || "");
      if (!label) return;

      const target =
        sourceLink.dataset.wikiTarget ||
        sourceLink.getAttribute("href") ||
        label;
      const key = `${label}__${target}`;
      if (seen.has(key)) return;
      seen.add(key);

      const item = document.createElement("span");
      item.className = "reader-navbox-footer-item";

      const sourceImage =
        marker?.querySelector<HTMLImageElement>("img") ||
        sourceLink.querySelector<HTMLImageElement>("img");
      if (sourceImage && (sourceIcon || isPortal)) {
        const icon = sourceIcon
          ? (sourceIcon.cloneNode(true) as HTMLElement)
          : document.createElement("span");
        icon.classList.add("reader-navbox-footer-icon");
        const clonedSourceImage = sourceImage.cloneNode(true) as HTMLImageElement;
        const image = sourceIcon
          ? icon.querySelector<HTMLImageElement>("img")
          : clonedSourceImage;
        if (!sourceIcon) icon.append(clonedSourceImage);
        if (image) {
          const imageSource =
            sourceImage.dataset.readerDeferredSrc ||
            sourceImage.getAttribute("src") ||
            "";
          if (imageSource) image.src = imageSource;
          delete image.dataset.readerDeferredSrc;
          image.loading = "eager";
          image.width = 16;
          image.height = 16;
          image.alt = "";
        }
        item.append(icon);
      }

      const link = document.createElement("a");
      link.className = `reader-navbox-footer-link${isPortal ? " reader-navbox-footer-portal-link" : ""}`;
      link.textContent = label;
      if (isPortal) {
        const portalTarget = wikipediaPortalLinkTarget(sourceLink);
        if (portalTarget) {
          link.href = `https://en.wikipedia.org/wiki/${encodeURIComponent(portalTarget).replace(/%3A/gi, ":")}`;
          link.target = "_blank";
          link.rel = "noreferrer";
        }
      } else if (isCommons) {
        link.href = sourceLink.href;
        link.target = sourceLink.target || "_blank";
        link.rel = sourceLink.rel || "noreferrer";
      } else if (sourceLink.dataset.wikiTarget) {
        link.dataset.wikiTarget = sourceLink.dataset.wikiTarget;
      } else if (sourceLink.getAttribute("href")) {
        link.setAttribute("href", sourceLink.getAttribute("href") || "");
      }

      item.append(link);
      footer.append(item);
    });
  });

  const categoryLink = footer.querySelector<HTMLAnchorElement>(
    'a[data-wiki-target^="Category:"]',
  );
  const normalizeCategory = (value: string) =>
    decodeURIComponent(value)
      .replace(/^Category:/i, "")
      .replace(/_/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLocaleLowerCase();
  const categoryTarget = categoryLink?.dataset.wikiTarget || "";
  const matchesNavboxTitle =
    categoryTarget &&
    normalizeCategory(categoryTarget) === normalizeCategory(navboxTitle);
  const hasCommonsLink = Array.from(
    footer.querySelectorAll<HTMLAnchorElement>("a[href]"),
  ).some((link) => {
    try {
      return new URL(link.href).hostname === "commons.wikimedia.org";
    } catch {
      return false;
    }
  });

  if (matchesNavboxTitle && !hasCommonsLink) {
    const commonsLink = Array.from(
      document.querySelectorAll<HTMLAnchorElement>("a[href]"),
    ).find((link) => {
      try {
        const url = new URL(link.href);
        const commonsTitle = decodeURIComponent(
          url.pathname.split("/wiki/")[1] || "",
        );
        return (
          url.hostname === "commons.wikimedia.org" &&
          normalizeCategory(commonsTitle) === normalizeCategory(categoryTarget)
        );
      } catch {
        return false;
      }
    });

    if (commonsLink) {
      const item = document.createElement("span");
      item.className = "reader-navbox-footer-item";
      const sourceImage = commonsLink
        .closest<HTMLElement>(".side-box, .sistersitebox")
        ?.querySelector<HTMLImageElement>(".side-box-image img, img");
      if (sourceImage) {
        const icon = document.createElement("span");
        icon.className = "reader-navbox-footer-icon";
        const image = sourceImage.cloneNode(true) as HTMLImageElement;
        const source =
          sourceImage.dataset.readerDeferredSrc ||
          sourceImage.getAttribute("src") ||
          "";
        if (source) image.src = source;
        delete image.dataset.readerDeferredSrc;
        image.loading = "eager";
        image.width = 16;
        image.height = 16;
        image.alt = "";
        icon.append(image);
        item.append(icon);
      }

      const link = document.createElement("a");
      link.className = "reader-navbox-footer-link";
      link.textContent = "Commons";
      link.href = commonsLink.href;
      link.target = "_blank";
      link.rel = "noreferrer";
      item.append(link);
      footer.append(item);
    }
  }

  return footer.childElementCount > 0 ? footer : null;
}

function buildReaderNavboxRows(
  document: Document,
  navbox: HTMLElement,
  excludedDetails: HTMLElement[] = [],
) {
  type NavboxEntry = {
    groupText: string;
    groupElement: HTMLElement;
    links: HTMLAnchorElement[];
    plainText: string;
  };

  const entries: NavboxEntry[] = Array.from(
    navbox.querySelectorAll<HTMLElement>(".navbox-group"),
  )
    .filter(
      (group) =>
        !excludedDetails.some((details) => details.contains(group)) &&
        group.parentElement?.closest<HTMLElement>(".navbox, .vertical-navbox") ===
          navbox,
    )
    .map((group) => {
      const tableRow = group.closest("tr");
      const list = tableRow
        ? Array.from(tableRow.querySelectorAll<HTMLElement>(".navbox-list")).find(
            (candidate) => candidate.closest("tr") === tableRow,
          ) || null
        : null;

      return {
        groupText: readerNavboxVisibleText(group),
        groupElement: group,
        links: list ? collectReaderNavboxLinks(document, list) : [],
        plainText: list ? readerNavboxVisibleText(list) : "",
      };
    })
    .filter((entry) =>
      entry.groupText || entry.links.length > 0 || entry.plainText,
    );

  const linkKey = (link: HTMLAnchorElement) =>
    (link.textContent || "") + "__" +
    (link.getAttribute("href") || link.dataset.wikiTarget || "");

  const sameLinkSet = (left: Set<string>, right: Set<string>) =>
    left.size === right.size && [...left].every((key) => right.has(key));

  const makeRow = (entry: NavboxEntry) => {
    const row = document.createElement("div");
    row.className = "reader-navbox-row";

    const label = document.createElement("div");
    label.className = "reader-navbox-group";
    populateReaderNavboxGroupLabel(document, label, entry.groupElement, entry.groupText);

    const items = document.createElement("div");
    items.className = "reader-navbox-links";

    if (entry.links.length > 0) {
      appendReaderNavboxLinks(document, items, entry.links);
    } else if (entry.plainText) {
      const text = document.createElement("span");
      text.className = "reader-navbox-plain-text";
      text.textContent = entry.plainText;
      items.append(text);
    }

    row.append(label, items);
    return row;
  };

  const rows: HTMLElement[] = [];

  for (let index = 0; index < entries.length; ) {
    const parent = entries[index];
    const parentLinks = new Set(parent.links.map(linkKey));
    let matchEnd = -1;
    const childLinks = new Set<string>();

    if (parentLinks.size > 1) {
      for (let end = index + 1; end < entries.length; end += 1) {
        entries[end].links.forEach((link) => childLinks.add(linkKey(link)));

        if (end > index + 1 && sameLinkSet(parentLinks, childLinks)) {
          matchEnd = end;
          break;
        }
      }
    }

    if (matchEnd >= 0) {
      const region = document.createElement("div");
      region.className = "reader-navbox-region";

      const regionLabel = document.createElement("div");
      regionLabel.className = "reader-navbox-group";
      populateReaderNavboxGroupLabel(document, regionLabel, parent.groupElement, parent.groupText);
      regionLabel.style.gridRow = "1 / span " + (matchEnd - index);
      region.append(regionLabel);

      entries.slice(index + 1, matchEnd + 1).forEach((entry) => {
        const childRow = makeRow(entry);
        childRow.style.gridColumn = "2";
        region.append(childRow);
      });

      rows.push(region);
      index = matchEnd + 1;
    } else {
      rows.push(makeRow(parent));
      index += 1;
    }
  }

  return rows;
}

function populateReaderNavboxGroupLabel(
  document: Document,
  label: HTMLElement,
  source: HTMLElement,
  visibleText: string,
) {
  const flag = source.querySelector<HTMLElement>(".flagicon");
  const flagLink = flag?.querySelector<HTMLAnchorElement>("a[data-wiki-target], a[href]");

  if (!flag || !flagLink) {
    const clone = source.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(".navbar, .mw-editsection, .mw-collapsible-toggle, .noprint").forEach((item) => item.remove());
    while (clone.firstChild) label.append(clone.firstChild);
    return;
  }

  label.append(flag.cloneNode(true));
  const countryLink = document.createElement("a");
  countryLink.className = "reader-navbox-country-link";
  countryLink.textContent = visibleText;
  if (flagLink.dataset.wikiTarget) countryLink.dataset.wikiTarget = flagLink.dataset.wikiTarget;
  const href = flagLink.getAttribute("href");
  if (href) countryLink.setAttribute("href", href);
  const title = flagLink.getAttribute("title");
  if (title) countryLink.title = title;
  label.append(countryLink);
}

function prepareReaderTemplateDocumentation(document: Document, pageTitle: string) {
  if (!/^template\s*:/i.test(pageTitle.trim())) return;

  document.querySelectorAll<HTMLElement>(".documentation-container").forEach((container) => {
    const content = container.querySelector<HTMLElement>(".documentation") || container;
    const heading = Array.from(content.querySelectorAll<HTMLElement>("h2, h3, h4, h5, h6, .mw-heading"))
      .find((candidate) => /^see\s+also$/i.test((candidate.textContent || "").replace(/\[edit\]/gi, "").trim()));

    if (!heading) {
      container.remove();
      return;
    }

    const section = document.createElement("section");
    section.className = "reader-template-see-also";
    const headingWrapper = heading.matches(".mw-heading") ? heading : heading.closest<HTMLElement>(".mw-heading") || heading;
    section.append(headingWrapper.cloneNode(true));

    let sibling = headingWrapper.nextElementSibling;
    while (sibling) {
      if (sibling.matches(".mw-heading, h2, h3, h4, h5, h6")) break;
      const text = (sibling.textContent || "").replace(/\s+/g, " ").trim();
      if (/^(the above documentation|this documentation is transcluded|editors can experiment|categories\s*:)/i.test(text)) break;

      const clone = sibling.cloneNode(true) as HTMLElement;
      clone.querySelectorAll<HTMLAnchorElement>("a[data-wiki-target], a[title], a[href]").forEach((link) => {
        const target = link.dataset.wikiTarget || link.title || link.getAttribute("href") || "";
        if (!/^template\s*:/i.test(target)) return;
        if (!/^template\s*:/i.test(link.textContent || "")) {
          link.textContent = `Template:${link.textContent || target.replace(/^template\s*:/i, "")}`;
        }
        if (!link.title) link.title = target.replace(/^.*?Template:/i, "Template:").replace(/_/g, " ");
      });
      section.append(clone);
      sibling = sibling.nextElementSibling;
    }

    if (section.querySelector("a, li")) container.before(section);
    container.remove();
  });
}

function appendReaderNavboxTitleContent(
  target: HTMLElement,
  source: HTMLElement | null,
  fallback: string,
) {
  if (!source) {
    target.textContent = fallback;
    return;
  }

  const clone = source.cloneNode(true) as HTMLElement;
  clone
    .querySelectorAll(".navbar, .mw-editsection, .mw-collapsible-toggle, .noprint")
    .forEach((item) => item.remove());
  clone.querySelectorAll("br").forEach((breakElement) => {
    breakElement.replaceWith(" ");
  });

  while (clone.firstChild) target.append(clone.firstChild);

  if (!target.textContent?.trim()) target.textContent = fallback;
}

function readerNavboxVisibleText(element: Element) {
  const clone = element.cloneNode(true) as Element;

  clone
    .querySelectorAll(".navbar, .mw-editsection, .mw-collapsible-toggle, .noprint")
    .forEach((item) => item.remove());

  clone.querySelectorAll("br").forEach((breakElement) => {
    breakElement.replaceWith(" ");
  });

  return cleanReaderNavboxText(clone.textContent || "");
}

function collectReaderNavboxLinks(document: Document, root: Element) {
  const links: HTMLAnchorElement[] = [];
  const seen = new Set<string>();

  root.querySelectorAll<HTMLAnchorElement>("a").forEach((sourceLink) => {
    if (sourceLink.closest(".navbar, .mw-editsection, .mw-collapsible-toggle")) {
      return;
    }

    const label = cleanReaderNavboxText(sourceLink.textContent || "");

    if (!label || /^[vte]$/i.test(label) || /^\[?(show|hide|edit)\]?$/i.test(label)) {
      return;
    }

    const href =
      sourceLink.getAttribute("href") ||
      sourceLink.dataset.wikiTarget ||
      label;

    const key = `${label}__${href}`;

    if (seen.has(key)) return;
    seen.add(key);

    const link = document.createElement("a");
    link.textContent = label;

    if (sourceLink.dataset.wikiTarget) {
      link.dataset.wikiTarget = sourceLink.dataset.wikiTarget;
    } else if (sourceLink.getAttribute("href")) {
      link.setAttribute("href", sourceLink.getAttribute("href") || "");
    }

    links.push(link);
  });

  return links;
}

function appendReaderNavboxLinks(
  document: Document,
  container: HTMLElement,
  links: HTMLAnchorElement[],
) {
  links.forEach((link, index) => {
    const unit = document.createElement("span");
    unit.className = "reader-navbox-inline-unit";
    unit.append(link);

    if (index < links.length - 1) {
      const separator = document.createElement("span");
      separator.className = "reader-navbox-separator";
      separator.textContent = "·";
      unit.append(separator);
    }

    container.append(unit);
  });
}

function cleanReaderNavboxText(text: string) {
  return text
    .replace(/\[(show|hide|edit)\]/gi, "")
    .replace(/^\s*v\s*[·•]?\s*t\s*[·•]?\s*e\s*/i, "")
    .replace(/^\s*t\s*[·•]?\s*e\s*/i, "")
    .replace(/\bv\s*[·•]?\s*t\s*[·•]?\s*e\b/gi, "")
    .replace(/[·•]/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\bPrivateinstitutions\b/gi, "Private institutions")
    .replace(/\s+/g, " ")
    .trim();
}






function polishReaderMultiTranscriptionInfoboxes(document: Document) {
  const ownRows = (table: HTMLTableElement) =>
    Array.from(table.rows).filter((row) => row.closest("table") === table);

  const cleanText = (element: Element | null) =>
    element?.textContent?.replace(/\s+/g, " ").trim() ?? "";

  document.querySelectorAll<HTMLTableElement>("table.infobox").forEach((infobox) => {
    const transcriptionTables = Array.from(
      infobox.querySelectorAll<HTMLTableElement>(
        "table.infobox-subbox.mw-collapsible",
      ),
    ).filter((table) => {
      if (table.closest("table.infobox") !== infobox) {
        return false;
      }

      const firstOwnRow = ownRows(table)[0];

      return cleanText(firstOwnRow)
        .toLowerCase()
        .startsWith("transcriptions");
    });

    transcriptionTables.forEach((table) => {
      const outerRow = table.closest<HTMLTableRowElement>("tr");

      if (outerRow && outerRow.closest("table") === infobox) {
        outerRow.remove();
      } else {
        table.remove();
      }
    });
  });
}

function polishReaderNutritionInfoboxes(document: Document) {
  const cleanText = (element: Element | null) =>
    element?.textContent?.replace(/\s+/g, " ").trim() ?? "";

  document.querySelectorAll<HTMLTableElement>("table.infobox").forEach((infobox) => {
    if (!cleanText(infobox).includes("Vitamins and minerals")) return;

    const nutritionTable = Array.from(
      infobox.querySelectorAll<HTMLTableElement>("table.cisb-table.mw-collapsible"),
    ).find((table) => cleanText(table).startsWith("Vitamins and minerals"));

    if (!nutritionTable || nutritionTable.classList.contains("reader-nutrition-subtable")) {
      return;
    }

    infobox.classList.add("reader-nutrition-infobox");
    nutritionTable.classList.add("reader-nutrition-subtable");

    const title = nutritionTable.querySelector<HTMLElement>(".cisb-title");
    if (title && !title.querySelector(".reader-nutrition-toggle")) {
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "reader-nutrition-toggle";
      toggle.textContent = "[hide]";
      toggle.setAttribute("aria-expanded", "true");
      toggle.setAttribute("aria-label", "Hide vitamins and minerals");
      title.append(toggle);
    }

    Array.from(nutritionTable.rows)
      .slice(1)
      .forEach((row) => {
        if (row.cells.length !== 2) return;

        const combinedCell = row.cells[1];
        const percentElement = combinedCell.querySelector<HTMLElement>(":scope > div");
        const rowLabel = cleanText(row.cells[0]);

        if (!percentElement) return;

        const quantityCell = document.createElement("td");
        quantityCell.className = "infobox-data";

        const percentCell = document.createElement("td");
        percentCell.className = "infobox-data";
        percentCell.append(percentElement.cloneNode(true));

        if (rowLabel === "Vitamins" || rowLabel === "Minerals") {
          quantityCell.innerHTML = "<b>Quantity</b>";
          percentCell.innerHTML = percentElement.innerHTML;
        } else {
          quantityCell.textContent = Array.from(combinedCell.childNodes)
            .filter((node) => node !== percentElement)
            .map((node) => node.textContent || "")
            .join("")
            .replace(/\s+/g, " ")
            .trim();
        }

        combinedCell.replaceWith(quantityCell, percentCell);
      });
  });
}


function markReaderCityHistoryTables(document: Document) {
  const cleanText = (element: Element | null) =>
    element?.textContent?.replace(/\s+/g, " ").trim() ?? "";

  const ownRows = (table: HTMLTableElement) =>
    Array.from(table.rows).filter((row) => row.closest("table") === table);

  const tables = Array.from(
    document.querySelectorAll<HTMLTableElement>("table"),
  );

  tables.forEach((table) => {
    if (table.closest(".infobox, .navbox, .vertical-navbox")) {
      return;
    }

    const rows = ownRows(table);
    const firstRow = rows[0];

    if (!firstRow) {
      return;
    }

    const headers = Array.from(firstRow.cells).map((cell) =>
      cleanText(cell).toLowerCase(),
    );

    const isCityHistoryTable =
      headers.length >= 6 &&
      headers[0] === "city" &&
      headers[1] === "chinese" &&
      headers[2] === "province" &&
      headers[3] === "type" &&
      headers[4] === "administration period" &&
      headers[5].includes("founded");

    if (isCityHistoryTable) {
      table.classList.add("reader-city-history-table");
      return;
    }

    const tableText = cleanText(table);

    const isCityHistoryLegend =
      headers.length === 2 &&
      headers[0] === "type" &&
      headers[1] === "no." &&
      tableText.includes("Special/Yuan/Direct-controlled") &&
      tableText.includes("Province-controlled");

    if (!isCityHistoryLegend) {
      return;
    }

    table.classList.add("reader-city-history-legend");

    const specialRow = rows.find((row) =>
      cleanText(row).includes("Special/Yuan/Direct-controlled"),
    );

    const swatchCell = specialRow?.cells[0];

    if (swatchCell && cleanText(swatchCell) === "") {
      swatchCell.classList.add("reader-city-history-legend-swatch");
    }
  });
}

function markReaderLongUrlInfoboxes(document: Document) {
  document.querySelectorAll<HTMLTableElement>("table.infobox").forEach((infobox) => {
    const hasLongUrl = Array.from(infobox.querySelectorAll<HTMLAnchorElement>("a[href]"))
      .some((link) => /^https?:/i.test(link.textContent?.trim() || "") && (link.textContent?.trim().length || 0) > 60);

    if (hasLongUrl) infobox.classList.add("reader-long-url-infobox");
  });
}


function polishReaderStationServiceTables(document: Document) {
  document
    .querySelectorAll<HTMLTableElement>(".infobox table")
    .forEach((table) => {
      const tableText =
        table.textContent?.replace(/\s+/g, " ").trim().toLowerCase() ?? "";

      const isStationServiceTable =
        tableText.includes("preceding station") &&
        tableText.includes("following station") &&
        (tableText.includes("amtrak") ||
          tableText.includes("milwaukee road") ||
          tableText.includes("borealis") ||
          tableText.includes("empire builder"));

      if (!isStationServiceTable) {
        return;
      }

      table.classList.add("reader-station-service-table");
      table.closest<HTMLElement>("td, th")?.classList.add("reader-station-service-cell");

      table
        .closest<HTMLElement>(".mw-collapsible, .navbox, .infobox-subbox, .infobox-full-data")
        ?.classList.add("reader-station-service-container");

      const serviceRows = Array.from(table.rows);
      const formerServicesRow = serviceRows.find(
        (row) => (row.textContent || "").trim() === "Former services",
      );

      if (formerServicesRow) {
        const contentRows = serviceRows.slice(
          serviceRows.indexOf(formerServicesRow) + 1,
        );

        contentRows.forEach((row) => {
          row.hidden = true;
          row.style.setProperty("display", "none", "important");
          row.setAttribute("data-reader-former-services-content", "true");
        });

        const headerCell = formerServicesRow.querySelector<HTMLElement>("th, td");

        if (
          headerCell &&
          !headerCell.querySelector("[data-reader-former-services-toggle]")
        ) {
          headerCell.style.setProperty("position", "relative");

          const toggle = document.createElement("button");
          toggle.type = "button";
          toggle.className = "reader-former-services-toggle";
          toggle.dataset.readerFormerServicesToggle = "true";
          toggle.textContent = "[show]";
          toggle.setAttribute("aria-expanded", "false");
          toggle.setAttribute("aria-label", "Show former services");
          headerCell.append(toggle);
        }
      }

      let parentTable = table.parentElement?.closest<HTMLTableElement>("table");

      while (parentTable && !parentTable.classList.contains("infobox")) {
        const parentText =
          parentTable.textContent?.replace(/\s+/g, " ").trim().toLowerCase() ?? "";

        const serviceTables =
          parentTable.querySelectorAll("table.reader-station-service-table").length;

        if (
          parentTable !== table &&
          serviceTables === 1 &&
          parentText.includes("preceding station") &&
          parentText.includes("following station")
        ) {
          parentTable.classList.add("reader-station-service-container");
        }

        parentTable = parentTable.parentElement?.closest<HTMLTableElement>("table");
      }

      table.querySelectorAll<HTMLTableCellElement>("td, th").forEach((cell) => {
        const cellText = cell.textContent?.replace(/\s+/g, "").trim() ?? "";
        const hasPreservedBackground =
          cell.classList.contains("reader-preserved-background") ||
          Boolean(cell.style.background || cell.style.backgroundColor) ||
          Boolean(cell.getAttribute("bgcolor"));

        if (
          hasPreservedBackground &&
          cellText === "" &&
          !cell.querySelector("a, img, svg, canvas, .mw-file-element")
        ) {
          cell.classList.add("reader-station-route-strip");
        }
      });
    });
}



function normalizeReaderTopInfoboxMediaRows(document: Document) {
  document.querySelectorAll<HTMLTableElement>("table.infobox, .infobox").forEach((infobox) => {
    if (!(infobox instanceof HTMLTableElement)) {
      return;
    }

    const rows = Array.from(infobox.rows)
      .filter((row) => row.closest("table") === infobox)
      .slice(0, 10);

    rows.forEach((row) => {
      if (row.classList.contains("reader-infobox-top-media-row")) {
        return;
      }

      if (row.querySelector(".tmulti, .multiimageinner, table")) {
        return;
      }

      const cells = Array.from(row.children).filter(
        (child): child is HTMLTableCellElement =>
          child instanceof HTMLTableCellElement,
      );

      if (cells.length < 1 || cells.length > 2) {
        return;
      }

      const mediaCell = cells.find((cell) => {
        const images = Array.from(cell.querySelectorAll<HTMLImageElement>("img"));

        return images.some((image) => {
          const width = Number.parseInt(image.getAttribute("width") || "", 10);
          const height = Number.parseInt(image.getAttribute("height") || "", 10);
          const largestKnownSide = Math.max(
            Number.isFinite(width) ? width : 0,
            Number.isFinite(height) ? height : 0,
          );

          return (
            largestKnownSide >= 55 ||
            image.closest(".infobox-image, .infobox-full-data, figure, .thumb, .mw-default-size")
          );
        });
      });

      if (!mediaCell) {
        return;
      }

      const images = Array.from(row.querySelectorAll<HTMLImageElement>("img"));

      if (images.length < 1 || images.length > 2) {
        return;
      }

      const captionCell = cells.find((cell) => cell !== mediaCell) || null;
      const captionText = captionCell?.textContent?.replace(/\s+/g, " ").trim() ?? "";

      if (captionCell) {
        if (captionCell.querySelector("img, table, .infobox, .navbox, .mw-collapsible")) {
          return;
        }

        if (captionText.length > 180 || captionCell.querySelectorAll("a").length > 3) {
          return;
        }
      }

      const newMediaCell = document.createElement("td");
      newMediaCell.className = "reader-infobox-top-media-cell";
      newMediaCell.setAttribute("colspan", "2");

      while (mediaCell.firstChild) {
        newMediaCell.appendChild(mediaCell.firstChild);
      }

      if (captionCell && captionText.length >= 3) {
        const caption = document.createElement("div");
        caption.className = "reader-infobox-top-media-caption";

        while (captionCell.firstChild) {
          caption.appendChild(captionCell.firstChild);
        }

        newMediaCell.appendChild(caption);
      }

      row.classList.add("reader-infobox-top-media-row");
      row.replaceChildren(newMediaCell);
    });
  });
}



function polishReaderInfoboxTopMedia(document: Document) {
  document.querySelectorAll<HTMLTableElement>("table.infobox").forEach((infobox) => {
    const ownRows = Array.from(infobox.rows).filter(
      (row) => row.closest("table") === infobox,
    );
    const titleCell = ownRows[0]?.cells[0] || null;

    titleCell
      ?.querySelectorAll<HTMLTableElement>(
        "table.mw-collapsible.mw-collapsed",
      )
      .forEach((table) => {
        const rows = Array.from(table.rows).filter(
          (row) => row.closest("table") === table,
        );

        if (
          rows.length === 3 &&
          Boolean(rows[0]?.querySelector("span.nobold i")) &&
          rows
            .slice(1)
            .every((row) => Boolean(row.querySelector("[lang]")))
        ) {
          table.classList.add("reader-hidden-infobox-native-name");
        }
      });
  });

  document
    .querySelectorAll<HTMLElement>(".reader-infobox-top-media-cell")
    .forEach((cell) => {
      const body = cell.querySelector<HTMLElement>(":scope > .noresize");

      if (!body || body.querySelector(".switcher-container")) {
        return;
      }

      const panels = Array.from(body.children).filter(
        (child): child is HTMLElement => child instanceof HTMLElement,
      );

      if (
        panels.length >= 2 &&
        panels.every(
          (panel) => panel.querySelectorAll("img").length === 1,
        )
      ) {
        body.classList.add("reader-infobox-side-media-body");

        panels.forEach((panel) => {
          panel.classList.add("reader-infobox-side-media-panel");
        });
      }
    });

  document
    .querySelectorAll<HTMLAudioElement>(".infobox audio")
    .forEach((audio) => {
      audio
        .closest<HTMLElement>("span.mw-default-size")
        ?.classList.add("reader-infobox-centered-audio-media");
    });

  let switcherId = 0;

  document
    .querySelectorAll<HTMLElement>(
      ".infobox .switcher-container",
    )
    .forEach((container) => {
      if (
        container.classList.contains("reader-location-map-switcher") ||
        container.classList.contains("reader-static-image-switcher")
      ) {
        return;
      }

      const panels = Array.from(container.children).filter(
        (child): child is HTMLElement =>
          child instanceof HTMLElement &&
          child.querySelectorAll("img").length === 1,
      );

      if (panels.length < 2) {
        return;
      }

      const fallbackLabels = [
        "Show globe",
        "Show U.S. territories",
        "Show exclusive economic zone",
      ];

      const groupId =
        `reader-static-image-switcher-${switcherId++}-` +
        Math.random().toString(36).slice(2);

      const panelBox = document.createElement("div");
      panelBox.className = "reader-static-image-switcher-panels";

      const controls = document.createElement("div");
      controls.className = "reader-static-image-switcher-controls";

      panels.forEach((panel, index) => {
        const label = fallbackLabels[index] || `Show image ${index + 1}`;

        panel.querySelectorAll<HTMLImageElement>("img").forEach((image) => {
          const source = image.getAttribute("src") || image.src;
          const highResolutionSource = source.replace(/\/\d+px-/, "/500px-");

          if (highResolutionSource !== source) {
            image.setAttribute("src", highResolutionSource);
          }
        });

        panel
          .querySelectorAll<HTMLElement>(".switcher-label")
          .forEach((switcherLabel) => switcherLabel.remove());

        panel.classList.add(
          "reader-static-image-switcher-panel",
          `reader-static-image-switcher-panel-${index}`,
        );

        panelBox.append(panel);

        const row = document.createElement("div");
        row.className = "reader-static-image-switcher-control-row";

        const input = document.createElement("input");
        input.type = "radio";
        input.className =
          `reader-static-image-switcher-radio ` +
          `reader-static-image-switcher-radio-${index}`;
        input.name = groupId;
        input.id = `${groupId}-${index}`;

        if (index === 0) {
          input.checked = true;
          input.defaultChecked = true;
          input.setAttribute("checked", "checked");
        }

        const labelElement = document.createElement("label");
        labelElement.className =
          "reader-static-image-switcher-control";
        labelElement.htmlFor = input.id;
        labelElement.textContent = label;

        row.append(input, labelElement);
        controls.append(row);
      });

      const bothRow = document.createElement("div");
      bothRow.className = "reader-static-image-switcher-control-row";

      const bothInput = document.createElement("input");
      bothInput.type = "radio";
      bothInput.className =
        "reader-static-image-switcher-radio " +
        "reader-static-image-switcher-radio-both";
      bothInput.name = groupId;
      bothInput.id = `${groupId}-both`;

      const bothLabel = document.createElement("label");
      bothLabel.className = "reader-static-image-switcher-control";
      bothLabel.htmlFor = bothInput.id;
      bothLabel.textContent = "Show all";

      bothRow.append(bothInput, bothLabel);
      controls.append(bothRow);

      container.replaceChildren(panelBox, controls);
      container.classList.add("reader-static-image-switcher");
    });
}



function moveInfoboxSideCaptionsBelowImages(document: Document) {
  document
    .querySelectorAll<HTMLImageElement>(
      '.infobox .infobox-full-data img[src*="Map-Francophone_World"]',
    )
    .forEach((image) => {
      const imageWrapper = image.closest<HTMLElement>(".mw-default-size");

      if (imageWrapper) {
        imageWrapper.style.setProperty("float", "none", "important");
      }
    });

  document
    .querySelectorAll<HTMLTableRowElement>(".infobox tr")
    .forEach((row) => {
      if (row.classList.contains("reader-infobox-side-caption-row")) {
        return;
      }

      const cells = Array.from(row.children).filter(
        (child): child is HTMLTableCellElement =>
          child instanceof HTMLTableCellElement,
      );

      if (cells.length !== 2) {
        return;
      }

      const imageCell = cells.find((cell) => {
        const images = Array.from(cell.querySelectorAll<HTMLImageElement>("img"));

        return images.some((image) => {
          const width = Number.parseInt(image.getAttribute("width") || "", 10);
          const height = Number.parseInt(image.getAttribute("height") || "", 10);
          const largestKnownSide = Math.max(
            Number.isFinite(width) ? width : 0,
            Number.isFinite(height) ? height : 0,
          );

          if (largestKnownSide >= 90) {
            return true;
          }

          const src = image.getAttribute("src") || "";
          const alt = image.getAttribute("alt") || "";
          const title = image.getAttribute("title") || "";
          const clue = `${src} ${alt} ${title}`.toLowerCase();

          return (
            largestKnownSide === 0 &&
            !/icon|logo|symbol|flag|routebox|bus|svg/.test(clue)
          );
        });
      });

      const captionCell = cells.find((cell) => cell !== imageCell);

      if (!imageCell || !captionCell) {
        return;
      }

      if (captionCell.querySelector("img, table, .infobox, .navbox, .mw-collapsible")) {
        return;
      }

      const captionText = captionCell.textContent?.replace(/\s+/g, " ").trim() ?? "";

      if (captionText.length < 4 || captionText.length > 180) {
        return;
      }

      const linkCount = captionCell.querySelectorAll("a").length;

      if (linkCount > 3) {
        return;
      }

      const captionRow = document.createElement("tr");
      captionRow.className = "reader-infobox-image-caption-row";

      const newCaptionCell = document.createElement("td");
      newCaptionCell.className = "reader-infobox-image-caption-row-cell";
      newCaptionCell.setAttribute("colspan", "2");

      while (captionCell.firstChild) {
        newCaptionCell.appendChild(captionCell.firstChild);
      }

      captionRow.appendChild(newCaptionCell);

      row.classList.add("reader-infobox-side-caption-row");
      imageCell.classList.add("reader-infobox-image-only-cell");
      imageCell.setAttribute("colspan", "2");
      captionCell.remove();

      row.insertAdjacentElement("afterend", captionRow);
    });
}



function markReaderInfoboxInlineIcons(document: Document) {
  document.querySelectorAll<HTMLImageElement>(".infobox img").forEach((image) => {
    const width = Number.parseInt(image.getAttribute("width") || "", 10);
    const height = Number.parseInt(image.getAttribute("height") || "", 10);
    const largestKnownSide = Math.max(
      Number.isFinite(width) ? width : 0,
      Number.isFinite(height) ? height : 0,
    );

    const textClue = [
      image.getAttribute("alt") || "",
      image.getAttribute("title") || "",
      image.getAttribute("src") || "",
    ]
      .join(" ")
      .toLowerCase();

    const hasExplicitSize = width > 0 || height > 0;
    const looksLikeInlineIcon = hasExplicitSize
      ? largestKnownSide <= 48
      : /bus|rail|train|tram|subway|ferry|airport|airplane|icon/.test(textClue);

    if (!looksLikeInlineIcon) {
      return;
    }

    // Map graphics can mention rail, train, or airport in their metadata; keep them out of icon sizing.
    if (
      image.closest(
        ".infobox-image, figure, .thumb, .mw-default-size, .mw-kartographer-map, .mw-kartographer-container, .mapframe, .locmap, .location-map, .locationmap",
      )
    ) {
      return;
    }

    image.classList.add("reader-infobox-inline-icon");

    const link = image.closest("a");
    if (link) {
      link.classList.add("reader-infobox-inline-icon-link");
    }

    const wrapper = image.parentElement;
    if (wrapper && !["TD", "TH"].includes(wrapper.tagName)) {
      wrapper.classList.add("reader-infobox-inline-icon-wrap");
    }

    image.closest("td, th")?.classList.add("reader-infobox-inline-icon-cell");
  });
}



function markReaderInfoboxUniformImageLabels(document: Document) {
  document.querySelectorAll<HTMLImageElement>(".infobox img").forEach((image) => {
    const clue = [
      image.getAttribute("alt") || "",
      image.getAttribute("title") || "",
    ]
      .join(" ")
      .toLowerCase();

    if (!/\buniforms?\b/.test(clue)) {
      return;
    }

    const source = image.getAttribute("src") || image.src;

    if (!source) {
      return;
    }

    const host = image.closest<HTMLAnchorElement>(
      "a.reader-infobox-image-file-link",
    );

    if (!host || host.querySelector(":scope > .reader-infobox-uniform-label-mask")) {
      return;
    }

    host.classList.add("reader-infobox-uniform-label-mask-host");
    host.style.setProperty(
      "--reader-infobox-uniform-label-image",
      `url("${source.replace(/["\\]/g, "\\$&")}")`,
    );

    const mask = document.createElement("span");
    mask.className = "reader-infobox-uniform-label-mask";
    mask.setAttribute("aria-hidden", "true");
    host.appendChild(mask);
  });
}


function polishReaderInfoboxImageSpacing(document: Document) {
  document
    .querySelectorAll<HTMLElement>(".infobox figure")
    .forEach((figure) => {
      const image = figure.querySelector("img");
      const clue = [
        image?.getAttribute("alt") || "",
        image?.getAttribute("title") || "",
      ]
        .join(" ")
        .toLowerCase();

      if (/\buniforms?\b/.test(clue)) {
        figure.style.setProperty("margin", "4px 0 8px", "important");
      } else if (/\b(?:logo|wordmark)\b/.test(clue)) {
        figure.style.setProperty("margin-bottom", "4px", "important");
      }
    });
}


function markReaderEditorWidthImageCards(document: Document) {
  document
    .querySelectorAll<HTMLElement>("figure, .thumb, .mw-default-size")
    .forEach((card) => {
      if (
        card.matches(".tmulti, .reader-multiple-image-block") ||
        card.closest(
          [
            ".infobox",
            ".gallery",
            ".location-map",
            ".locationmap",
            ".mapframe",
            ".mw-kartographer-container",
            ".reader-osm-location-map-frame",
            ".reader-preserved-sidebar",
          ].join(", "),
        )
      ) {
        return;
      }

      if (
        card.matches(
          '[typeof="mw:File"], [typeof="mw:File/Frameless"]',
        )
      ) {
        return;
      }

      const images = Array.from(
        card.querySelectorAll<HTMLImageElement>("img"),
      );

      if (images.length !== 1) {
        return;
      }

      const image = images[0];
      const editorWidth = Number.parseInt(
        image.getAttribute("width") || "",
        10,
      );

      if (!Number.isFinite(editorWidth) || editorWidth <= 0) {
        return;
      }

      const isOversizedImage = editorWidth > 720;
      const isAmericasPoliticalDivisionsCard = Boolean(
        card.closest("table.reader-americas-political-divisions-table"),
      );
      // `markReaderLayoutTables` runs after this pass, so use Wikipedia's
      // source-authored class here instead of the later reader marker.
      const columnLayoutTable = card.closest<HTMLTableElement>(
        "table.col-begin",
      );
      const isColumnLayoutImageCard = Boolean(columnLayoutTable);
      const containingTable = card.closest<HTMLTableElement>(
        "table.reader-normal-table",
      );
      const headerLabels = Array.from(
        containingTable?.rows[0]?.cells || [],
      ).map((cell) =>
        (cell.textContent || "").replace(/\s+/g, " ").trim().toLowerCase(),
      );
      const isEditorScreenshotTable = Boolean(
        containingTable &&
        headerLabels.length === 2 &&
        headerLabels[0] === "editor" &&
        headerLabels[1] === "screenshot",
      );
      const isThreeFigureImageTable = Boolean(
        containingTable?.querySelectorAll(
          ":scope > tbody > tr:first-child > td > figure",
        ).length === 3,
      );
      const isAnnotatedImageTemplateTable = Boolean(
        isThreeFigureImageTable &&
        containingTable?.querySelector("[id^='annotation_']"),
      );

      if (isEditorScreenshotTable && containingTable) {
        containingTable.classList.add("reader-editor-screenshot-table");
        // Keep this two-column screenshot grid at a useful size inside its
        // shrink-to-fit caption wrapper, while allowing narrow windows to fit.
        containingTable.style.setProperty("width", "440px", "important");
        containingTable.style.setProperty("min-width", "0", "important");
        containingTable.style.setProperty(
          "max-width",
          "min(440px, calc(100vw - 32px))",
          "important",
        );
        containingTable.style.setProperty("table-layout", "fixed", "important");
        Array.from(containingTable.rows).forEach((row) => {
          row.cells.item(0)?.style.setProperty("width", "36%", "important");
          row.cells.item(1)?.style.setProperty("width", "64%", "important");
        });
      }

      card.classList.add("reader-editor-width-image-card");
      card.classList.toggle("reader-oversized-image-card", isOversizedImage);

      const caption = card.querySelector<HTMLElement>(":scope > figcaption");

      if (
        caption &&
        caption.childNodes.length > 0 &&
        !caption.querySelector(":scope > .reader-caption-content")
      ) {
        const content = document.createElement("span");
        content.className = "reader-caption-content";

        while (caption.firstChild) {
          content.appendChild(caption.firstChild);
        }

        caption.appendChild(content);
      }
      card.style.setProperty(
        "--reader-editor-image-width",
        `${editorWidth}px`,
      );
      if (isColumnLayoutImageCard) {
        // These article columns can otherwise shrink-wrap to their text and
        // constrain a neighboring chart below its source thumbnail width.
        columnLayoutTable?.style.setProperty("width", "100%", "important");
        columnLayoutTable?.style.setProperty("min-width", "0", "important");
        columnLayoutTable?.style.setProperty("max-width", "100%", "important");
      }
      if (isAnnotatedImageTemplateTable) {
        const cells = Array.from(
          containingTable?.querySelectorAll<HTMLTableCellElement>(
            ":scope > tbody > tr:first-child > td",
          ) || [],
        );
        const cell = card.closest<HTMLTableCellElement>("td");
        const cellIndex = cell ? cells.indexOf(cell) : -1;
        const isThumbnailCell = cellIndex === 2;

        containingTable?.style.setProperty("width", "802px", "important");
        containingTable?.style.setProperty("min-width", "802px", "important");
        containingTable?.style.setProperty("max-width", "100%", "important");
        containingTable?.style.setProperty("table-layout", "fixed", "important");
        containingTable?.style.setProperty("margin-left", "auto", "important");
        containingTable?.style.setProperty("margin-right", "auto", "important");
        containingTable?.style.setProperty("border", "0", "important");
        containingTable?.style.setProperty("overflow", "visible", "important");

        cells.forEach((tableCell, index) => {
          const width = index === 2 ? "166px" : "302px";
          tableCell.style.setProperty("width", width, "important");
          tableCell.style.setProperty("min-width", width, "important");
          tableCell.style.setProperty("max-width", width, "important");
          tableCell.style.setProperty("padding", "0", "important");
          tableCell.style.setProperty("vertical-align", "top", "important");
          tableCell.style.setProperty("text-align", "left", "important");
          tableCell.style.setProperty("border-right", "0", "important");
        });

        if (isThumbnailCell) {
          card.style.setProperty("display", "block", "important");
          card.style.setProperty("width", "154px", "important");
          card.style.setProperty("min-width", "154px", "important");
          card.style.setProperty("max-width", "154px", "important");
          card.style.setProperty("margin", "38px 0 20px 8px", "important");
          card.style.setProperty("padding", "0", "important");
          card.style.setProperty("box-sizing", "border-box", "important");

          const imageLink = card.querySelector<HTMLElement>(":scope > a");
          imageLink?.style.setProperty("display", "block", "important");
          imageLink?.style.setProperty("width", "154px", "important");
          imageLink?.style.setProperty("margin", "0", "important");
          imageLink?.style.setProperty("padding", "0", "important");
          imageLink?.style.setProperty("line-height", "0", "important");
          image.style.setProperty("display", "block", "important");
          image.style.setProperty("width", "138px", "important");
          image.style.setProperty("height", "89px", "important");
          image.style.setProperty("max-width", "none", "important");
          image.style.setProperty("margin", "0 8px", "important");
          image.style.setProperty("position", "relative", "important");
          image.style.setProperty("top", "-8px", "important");

          caption?.style.setProperty("display", "block", "important");
          caption?.style.setProperty("width", "146px", "important");
          caption?.style.setProperty("max-width", "146px", "important");
          caption?.style.setProperty("margin", "4px 0 0", "important");
          caption?.style.setProperty("position", "relative", "important");
          caption?.style.setProperty("top", "-8px", "important");
          caption?.style.setProperty("box-sizing", "border-box", "important");
          return;
        }

        card.style.setProperty("display", "block", "important");
        card.style.setProperty("position", "relative", "important");
        card.style.setProperty("width", "302px", "important");
        card.style.setProperty("min-width", "302px", "important");
        card.style.setProperty("max-width", "302px", "important");
        card.style.setProperty("height", "112px", "important");
        card.style.setProperty("margin", "0", "important");
        card.style.setProperty("padding", "0", "important");
        card.style.setProperty("overflow", "hidden", "important");
        card.style.setProperty("box-sizing", "border-box", "important");
        return;
      }
      if (isThreeFigureImageTable) {
        containingTable?.style.setProperty("width", "max-content", "important");
        containingTable?.style.setProperty("min-width", "0", "important");
        containingTable?.style.setProperty("max-width", "100%", "important");
        containingTable?.style.setProperty("table-layout", "auto", "important");
        containingTable?.style.setProperty("margin-left", "auto", "important");
        containingTable?.style.setProperty("margin-right", "auto", "important");
        containingTable?.style.setProperty("border", "0", "important");
        containingTable?.style.setProperty("border-radius", "0", "important");
        containingTable?.style.setProperty("overflow", "visible", "important");
        containingTable?.style.setProperty("clip-path", "none", "important");
        containingTable
          ?.querySelectorAll<HTMLElement>(
            ":scope > tbody > tr:first-child > td",
          )
          .forEach((cell) => {
            cell.style.setProperty("border-right", "0", "important");
            cell.style.setProperty("text-align", "center", "important");
          });
        card.style.setProperty("display", "table", "important");
        card.style.setProperty("width", "200px", "important");
        card.style.setProperty("max-width", "200px", "important");
        card.style.setProperty("margin", "8px auto 20px", "important");
        card.style.setProperty("padding", "7px", "important");
        card.style.setProperty("box-sizing", "border-box", "important");
        image.style.setProperty("width", "184px", "important");
        image.style.setProperty("max-width", "184px", "important");
        image.style.setProperty("height", "auto", "important");
        return;
      }
      card.style.setProperty("display", "block", "important");
      if (isOversizedImage) {
        image.style.setProperty("width", `${editorWidth}px`, "important");
        image.style.setProperty("max-width", "none", "important");
        card.style.setProperty("width", "fit-content", "important");
        card.style.setProperty("max-width", "100%", "important");
        card.style.setProperty("overflow-x", "auto", "important");
        card.style.setProperty("overflow-y", "hidden", "important");
        card.style.setProperty("color-scheme", "dark", "important");
        card.style.setProperty("scrollbar-width", "thin", "important");
        card.style.setProperty(
          "scrollbar-color",
          "rgb(96 101 105) rgb(19 26 31)",
          "important",
        );
      } else {
        image.style.removeProperty("width");
        image.style.removeProperty("max-width");
        card.style.setProperty(
          "width",
          "calc(var(--reader-editor-image-width) + 16px)",
          "important",
        );
        card.style.setProperty(
          "max-width",
          isAmericasPoliticalDivisionsCard
            ? `${editorWidth + 16}px`
            : isColumnLayoutImageCard || isEditorScreenshotTable
              ? `min(calc(var(--reader-editor-image-width) + 16px), 100%)`
              : "min(calc(var(--reader-editor-image-width) + 16px), 44%)",
          "important",
        );
        card.style.setProperty("overflow", "visible", "important");
        card.style.removeProperty("overflow-x");
        card.style.removeProperty("overflow-y");
        card.style.removeProperty("color-scheme");
        card.style.removeProperty("scrollbar-width");
        card.style.removeProperty("scrollbar-color");
        if (isEditorScreenshotTable) {
          // The chart in this two-column example is too small at its source
          // thumbnail width; give it a readable card while keeping it inside
          // the neighboring table cell on narrow windows.
          card.style.setProperty("width", "300px", "important");
          card.style.setProperty("max-width", "min(300px, 100%)", "important");
          card.style.setProperty("border-left", "0", "important");
          image.style.setProperty("width", "100%", "important");
          image.style.setProperty("max-width", "100%", "important");
          image.style.setProperty("height", "auto", "important");
        }
      }
      card.style.setProperty("min-width", "0", "important");
      card.style.setProperty("box-sizing", "border-box", "important");
    });
}

function markReaderCaptionedTablesBesideRightMedia(document: Document) {
  const isFlowAnchor = (element: Element | null): element is HTMLElement => {
    if (!element?.matches(".reader-table-caption-group-left")) return false;

    const table = element.querySelector<HTMLTableElement>(
      ":scope > table.reader-normal-table",
    );
    if (
      !table ||
      table.matches(".infobox, .us-census-pop, .reader-demographic-table") ||
      table.closest(
        ".infobox, .reader-scrollable-sortable-table, .reader-table-scroll, .reader-table-wrapper",
      )
    ) {
      return false;
    }

    return true;
  };

  document
    .querySelectorAll<HTMLElement>(
      ".reader-table-caption-group-left:has(> table.reader-normal-table)",
    )
    .forEach((group) => {
      group.classList.remove("reader-captioned-table-after-right-media-stack");
      group.style.removeProperty("--reader-captioned-table-flow-pull-up");

      const table = group.querySelector<HTMLTableElement>(
        ":scope > table.reader-normal-table",
      );

      if (!table || table.matches(".infobox")) return;
      if (
        table.closest(
          ".infobox, .reader-scrollable-sortable-table, .reader-table-scroll, .reader-table-wrapper",
        )
      ) {
        return;
      }

      let firstCard: HTMLElement | null = null;
      let sibling = group.previousElementSibling as HTMLElement | null;
      let previousCaptionedGroup: HTMLElement | null = null;
      const followsCaptionedRightMedia = Boolean(
        sibling?.matches(
          ".reader-table-caption-group-left.reader-captioned-table-with-right-media",
        ),
      );

      if (followsCaptionedRightMedia) {
        previousCaptionedGroup = sibling;
        sibling = sibling?.previousElementSibling as HTMLElement | null;
      }

      while (sibling?.matches(".reader-editor-width-image-card")) {
        firstCard = sibling;
        sibling = sibling.previousElementSibling as HTMLElement | null;
      }

      if (!firstCard) return;

      const cardStyle = getComputedStyle(firstCard);
      const reserve = Math.ceil(
        firstCard.getBoundingClientRect().width +
          Number.parseFloat(cardStyle.marginLeft || "0") +
          Number.parseFloat(cardStyle.marginRight || "0") +
          11,
      );

      group.classList.add("reader-captioned-table-with-right-media");
      group.style.setProperty(
        "--reader-right-media-reserve",
        `${reserve}px`,
      );

      let anchor: Element | null = isFlowAnchor(previousCaptionedGroup)
        ? previousCaptionedGroup
        : sibling;

      while (anchor) {
        if (isFlowAnchor(anchor)) break;
        if (/^H[2-6]$/.test(anchor.tagName)) break;
        anchor = anchor.previousElementSibling;
      }

      if (!anchor) return;

      const desiredGap = 16;
      const verticalOffset = Math.max(
        0,
        Math.round(
          group.getBoundingClientRect().top -
            anchor.getBoundingClientRect().bottom -
            desiredGap,
        ),
      );

      group.classList.add("reader-captioned-table-after-right-media-stack");
      group.style.setProperty(
        "--reader-captioned-table-flow-pull-up",
        `${verticalOffset}px`,
      );
    });
}
function markReaderInfoboxColorSwatches(document: Document) {
  document
    .querySelectorAll<HTMLElement>(".infobox .reader-preserved-background")
    .forEach((element) => {
      if (
        [
          "TABLE",
          "TBODY",
          "THEAD",
          "TFOOT",
          "TR",
          "TD",
          "TH",
          "CAPTION",
        ].includes(element.tagName)
      ) {
        return;
      }

      if (element.closest(".reader-station-service-table")) {
        return;
      }

      if (element.querySelector("img, svg, table, canvas, video")) {
        return;
      }

      const text = (element.textContent ?? "")
        .replace(/\u00a0/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      if (text && text !== "|" && text.length > 2) {
        return;
      }

      element.classList.add("reader-infobox-color-swatch");
    });
}


function readerSportsMatrixTableWrapper(table: HTMLTableElement) {
  const scrollWrapper = table.closest<HTMLElement>(
    ".reader-scrollable-sortable-table, .reader-table-scroll, .reader-table-wrapper",
  );

  if (
    scrollWrapper &&
    !scrollWrapper.classList.contains("mw-parser-output") &&
    !scrollWrapper.classList.contains("reader-article")
  ) {
    scrollWrapper.classList.add("reader-sports-matrix-wrapper");
    return;
  }

  const directParent = table.parentElement;

  if (
    !(directParent instanceof HTMLElement) ||
    directParent.tagName === "TD" ||
    directParent.tagName === "TH"
  ) {
    return;
  }

  if (
    directParent.classList.contains("reader-sports-matrix-wrapper") &&
    !directParent.classList.contains("mw-parser-output") &&
    !directParent.classList.contains("reader-article")
  ) {
    return;
  }

  if (
    directParent.classList.contains("mw-parser-output") ||
    directParent.classList.contains("reader-article")
  ) {
    const wrapper = document.createElement("div");
    wrapper.className = "reader-sports-matrix-wrapper reader-table-wrapper";
    table.before(wrapper);
    wrapper.appendChild(table);
    return;
  }

  directParent.classList.add("reader-sports-matrix-wrapper");
}

function readerSportsMatrixHeadingText(element: Element) {
  const heading =
    element.matches("h2, h3, h4")
      ? element
      : element.querySelector("h2, h3, h4");

  return (heading?.textContent || element.textContent || "")
    .replace(/\[\s*edit\s*\]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function readerStateChampionsHeadingText(element: Element) {
  return (element.textContent || "")
    .replace(/\[\s*edit\s*\]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function readerStateChampionsIsH2(element: Element) {
  return (
    element.matches("h2") ||
    Boolean(element.matches(".mw-heading") && element.querySelector("h2"))
  );
}

function markReaderStandaloneNotesParagraphs(document: Document) {
  document
    .querySelectorAll<HTMLParagraphElement>("p")
    .forEach((paragraph) => {
      const text =
        paragraph.textContent?.replace(/\s+/g, " ").trim() ?? "";

      if (!/^notes\s*:?\s*$/i.test(text)) return;

      paragraph.classList.add(
        "reader-standalone-notes-paragraph",
      );
    });
}

function markReaderGroupedSortableHeaders(document: Document) {
  document
    .querySelectorAll<HTMLTableCellElement>(
      "table.reader-normal-table th.reader-sortable-row-header",
    )
    .forEach((cell) => {
      if (cell.colSpan <= 1) return;

      cell.classList.add(
        "reader-grouped-sortable-header",
      );

      /*
       * Grouped sortable headers can inherit a high-specificity
       * padding: 0 0 6px !important rule. Preserve the same total
       * vertical padding while centering the label.
       */
      cell.style.setProperty(
        "padding-top",
        "3px",
        "important",
      );
      cell.style.setProperty(
        "padding-bottom",
        "3px",
        "important",
      );
      cell.style.setProperty(
        "vertical-align",
        "middle",
        "important",
      );

      const title =
        cell.textContent
          ?.replace(/\[\s*\d+\s*\]/g, "")
          .replace(/\s+/g, " ")
          .trim() ?? "";
      if (
        title !== "National program rankings" &&
        title !== "Global program rankings"
      ) {
        return;
      }

      const table = cell.closest("table");
      const label = cell.querySelector<HTMLElement>(
        ".reader-readable-colored-cell-text",
      );
      const dataRows = table
        ? Array.from(table.rows).slice(2)
        : [];
      if (!table || !label || dataRows.length === 0) return;

      cell.classList.add("reader-program-ranking-header");
      dataRows.forEach((row) => {
        row.classList.add("reader-program-ranking-collapsible-row");
        row.hidden = true;
      });

      const headerRow = document.createElement("span");
      headerRow.className = "reader-program-ranking-header-row";
      label.classList.add("reader-program-ranking-title");
      cell.appendChild(headerRow);
      headerRow.appendChild(label);

      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "reader-program-ranking-toggle";
      toggle.textContent = "[show]";
      toggle.setAttribute("aria-expanded", "false");
      toggle.setAttribute("aria-label", `Show ${title} rows`);
      headerRow.appendChild(toggle);

      toggle.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const expanded = toggle.getAttribute("aria-expanded") === "true";
        dataRows.forEach((row) => {
          row.hidden = expanded;
        });
        toggle.textContent = expanded ? "[show]" : "[hide]";
        toggle.setAttribute("aria-expanded", String(!expanded));
        toggle.setAttribute(
          "aria-label",
          `${expanded ? "Show" : "Hide"} ${title} rows`,
        );
      });
    });
}

function markReaderNormalTableVerticalAlignment(document: Document) {
  document
    .querySelectorAll<HTMLTableElement>("table.reader-normal-table")
    .forEach((table) => {
      if (table.matches(".RMbox")) {
        table.style.setProperty("display", "none", "important");
        return;
      }

      if (
        table.matches(
          ".reader-climate-table, .reader-climate-data-table, .infobox, .infobox-subbox",
        )
      ) {
        return;
      }

      Array.from(table.rows).forEach((row) => {
        Array.from(row.cells).forEach((cell) => {
          const inlineStyle = cell.getAttribute("style") || "";

          const hasExplicitSourceAlignment =
            cell.hasAttribute("valign") ||
            /(?:^|;)\s*vertical-align\s*:/i.test(inlineStyle);

          if (hasExplicitSourceAlignment) return;

          cell.classList.add(
            "reader-normal-table-cell-vertical-middle",
          );
        });
      });
    });
}


function polishReaderTemplateNavigationAndRosterTables(document: Document) {
  document
    .querySelectorAll<HTMLElement>(
      ".navbar.plainlinks.hlist.navbar-mini",
    )
    .forEach((navbar) => navbar.remove());

  document
    .querySelectorAll<HTMLElement>(".reader-table-caption-group")
    .forEach((group) => {
      const caption = group.querySelector<HTMLElement>(
        ":scope > .reader-table-external-caption",
      );
      const title = (caption?.textContent || "")
        .replace(/\s+/g, " ")
        .trim();

      const table = group.querySelector<HTMLTableElement>(":scope > table");

      if (!table) {
        return;
      }

      const ownRows = Array.from(table.rows).filter(
        (row) => row.closest("table") === table,
      );

      if (/\broster\b/i.test(title)) {
        if (
          ownRows.length === 1 &&
          ownRows[0].cells.length >= 3
        ) {
          table.classList.add("reader-roster-template-table");
        }

        return;
      }

      if (!/\bstaff\b/i.test(title)) {
        return;
      }

      const contentRow = ownRows.find((row) =>
        Array.from(row.cells).filter(
          (cell) => cell.textContent?.trim(),
        ).length === 2,
      );

      if (!contentRow) {
        return;
      }

      table.classList.add("reader-staff-template-table");

      ownRows.forEach((row) => {
        if (row !== contentRow) {
          row.classList.add("reader-staff-hidden-row");
        }
      });

      contentRow.classList.add("reader-staff-content-row");

      Array.from(contentRow.cells).forEach((cell) => {
        cell.classList.add(
          cell.textContent?.trim()
            ? "reader-staff-content-cell"
            : "reader-staff-spacer-cell",
        );
      });
    });
}

function markReaderTablesAfterFloatedLocationMaps(document: Document) {
  const normalTables = Array.from(
    document.querySelectorAll<HTMLTableElement>("table.reader-normal-table"),
  );

  document
    .querySelectorAll<HTMLElement>(".reader-location-map-plus")
    .forEach((map) => {
      const classText = map.className?.toString() ?? "";
      const styleText = map.getAttribute("style") ?? "";

      const isFloated =
        /\b(?:floatleft|floatright|tleft|tright)\b/i.test(classText) ||
        /float\s*:\s*(?:left|right)/i.test(styleText);

      if (!isFloated) return;

      const followingTable = normalTables.find((table) =>
        Boolean(
          map.compareDocumentPosition(table) &
            Node.DOCUMENT_POSITION_FOLLOWING
        ),
      );

      followingTable?.classList.add(
        "reader-normal-table-after-location-map",
      );
    });
}

function repairReaderNbaCupGroupQualificationColumn(document: Document) {
  const clean = (value: string | null | undefined) =>
    String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
  const expectedHeaders = ["pos", "team", "pld", "w", "l", "pf", "pa", "pd", "qualification"];

  document.querySelectorAll<HTMLTableElement>("table.wikitable").forEach((table) => {
    const rows = Array.from(table.rows).filter((row) => row.closest("table") === table);
    const header = rows[0];
    const headerTexts = Array.from(header?.cells || []).map((cell) => clean(cell.textContent));

    if (
      headerTexts.length !== expectedHeaders.length ||
      headerTexts.some((value, index) => value !== expectedHeaders[index])
    ) {
      return;
    }

    table.classList.add("reader-nba-cup-group-table");
    table.style.setProperty("border-collapse", "collapse", "important");

    const bodyRows = rows.slice(1);
    if (bodyRows.length < 3) return;

    // Track occupied logical columns so an existing rowspan is not mistaken
    // for a missing cell in the rows it already covers.
    const occupiedColumns = rows.map(() => new Set<number>());
    rows.forEach((row, rowIndex) => {
      let column = 0;
      Array.from(row.cells).forEach((cell) => {
        while (occupiedColumns[rowIndex].has(column)) column += 1;
        const columnSpan = Math.max(1, cell.colSpan);
        const rowSpan = cell.rowSpan === 0
          ? rows.length - rowIndex
          : Math.max(1, cell.rowSpan);

        for (let columnOffset = 0; columnOffset < columnSpan; columnOffset += 1) {
          for (
            let coveredRow = rowIndex;
            coveredRow < Math.min(rows.length, rowIndex + rowSpan);
            coveredRow += 1
          ) {
            occupiedColumns[coveredRow].add(column + columnOffset);
          }
        }

        column += columnSpan;
      });
    });

    const qualificationColumn = expectedHeaders.length - 1;
    const firstMissingRow = bodyRows.findIndex(
      (_row, index) => !occupiedColumns[index + 1].has(qualificationColumn),
    );

    if (firstMissingRow < 0) return;

    const trailingRows = bodyRows.slice(firstMissingRow);
    if (
      trailingRows.length < 2 ||
      trailingRows.some((_row, index) =>
        occupiedColumns[firstMissingRow + index + 1].has(qualificationColumn),
      )
    ) {
      return;
    }

    const qualificationCell = document.createElement("td");
    qualificationCell.rowSpan = trailingRows.length;
    qualificationCell.className = "reader-normal-table-cell-vertical-middle";
    trailingRows[0].appendChild(qualificationCell);
  });
}

function markReaderNormalTableAlignment(document: Document) {
  const articleHeadings = Array.from(document.querySelectorAll("h2, h3, h4"));
  const normalizedHeadingText = (heading: Element) =>
    (heading.textContent || "")
      .replace(/\[edit\]/gi, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  const careerHeading = articleHeadings.find(
    (heading) => normalizedHeadingText(heading) === "careers in neuroscience",
  );
  const organizationsHeading = articleHeadings.find(
    (heading) => normalizedHeadingText(heading) === "neuroscience organizations",
  );

  document.querySelectorAll<HTMLTableElement>("table").forEach((table) => {
    if (
      table.closest(
        ".infobox, .navbox, .vertical-navbox, .reader-preserved-sidebar, .metadata, .ambox, .ombox, .tmbox, .reader-multiple-image-block, .reader-osm-location-map-frame",
      )
    ) {
      return;
    }

    const wrapper = table.closest<HTMLElement>(
      ".reader-scrollable-sortable-table, .reader-table-scroll, .reader-table-wrapper, .thumb, .floatleft, .floatright, .tleft, .tright, .tnone, .center, .mw-halign-left, .mw-halign-right, .mw-halign-center",
    );

    const alignmentSource = wrapper || table;
    const classText = alignmentSource.className?.toString() ?? "";
    const styleText = alignmentSource.getAttribute("style") ?? "";

    table.classList.add("reader-normal-table");

    if (
      table.matches(
        "table.wikitable:not(.reader-layout-table):not(.reader-climate-table):not(.reader-climate-data-table):not(.infobox):not(.infobox-subbox):not(.reader-election-results-table):not(.reader-nba-cup-group-table):not(.game-log):not(.reader-editor-screenshot-table)",
      )
    ) {
      table.style.setProperty("border-collapse", "collapse", "important");
    }

    if (table.querySelector(":scope > tbody > tr > td > ul.gallery.mw-gallery-packed")) {
      table.style.setProperty("width", "100%", "important");
    }

    const rows = Array.from(table.rows);
    const isCareerOptionsTable = Boolean(
      careerHeading &&
        organizationsHeading &&
        (careerHeading.compareDocumentPosition(table) &
          Node.DOCUMENT_POSITION_FOLLOWING) &&
        (table.compareDocumentPosition(organizationsHeading) &
          Node.DOCUMENT_POSITION_FOLLOWING) &&
        rows.length > 0 &&
        rows.every(
          (row) =>
            row.cells.length === 2 &&
            Array.from(row.cells).every((cell) => cell.colSpan === 1),
        ),
    );
    table.classList.toggle("reader-career-options-table", isCareerOptionsTable);

    const titleCell = rows[0]?.cells.length === 1 ? rows[0].cells[0] : null;
    const legendCell = rows[1]?.cells.length === 1 ? rows[1].cells[0] : null;
    const legendColumn = legendCell?.querySelector<HTMLElement>(
      ":scope > .div-col",
    );
    const legendEntries = legendColumn
      ? Array.from(legendColumn.children).filter((child) =>
          child.classList.contains("legend"),
        )
      : [];
    const hasStandaloneLegendKey = Boolean(
      rows.length === 2 &&
        titleCell?.tagName === "TH" &&
        /\b(?:key|legend)\b/i.test(titleCell.textContent || "") &&
        legendEntries.length >= 2 &&
        legendEntries.filter((entry) =>
          entry.querySelector(".legend-color, .reader-preserved-background"),
        ).length >= 2,
    );

    if (hasStandaloneLegendKey) {
      table.classList.add("reader-standalone-legend-key");
    }

    table.classList.remove(
      "reader-normal-table-compact",
      "reader-normal-table-has-description",
      "reader-normal-table-description-wrap",
    );

    const headerTexts = Array.from(
      table.querySelectorAll("tr:first-child th, tr:first-child td"),
    )
      .map((cell) => cell.textContent?.replace(/\s+/g, " ").trim().toLowerCase() ?? "")
      .filter(Boolean);

    if (headerTexts.includes("description")) {
      table.classList.add("reader-normal-table-has-description");
      const headerRow = table.rows[0];
      const hasTwoPlainColumns =
        headerRow?.cells.length === 2 &&
        Array.from(table.rows).every(
          (row) =>
            row.cells.length === 2 &&
            Array.from(row.cells).every((cell) => cell.colSpan === 1),
        );

      if (hasTwoPlainColumns) {
        table.classList.add("reader-normal-table-description-wrap");
        Array.from(table.rows).forEach((row) => {
          row.cells[1]?.style.setProperty("white-space", "normal", "important");
        });
      }
    } else {
      table.classList.add("reader-normal-table-compact");
    }

    table.querySelectorAll<HTMLTableCellElement>("td.reader-normal-table-cell-centered").forEach(
      (cell) => cell.classList.remove("reader-normal-table-cell-centered"),
    );

    const tableText = table.textContent?.replace(/\s+/g, " ").trim() ?? "";
    const isAmericasReferenceTable =
      table.querySelectorAll("img").length >= 1 &&
      /Subdivisions of the Americas|United Nations geoscheme for the Americas/i.test(tableText);
    const isAmericasPoliticalDivisionsTable =
      table.querySelectorAll("img").length === 3 &&
      /^Federal Republic of Central America/i.test(tableText);

    if (isAmericasReferenceTable || isAmericasPoliticalDivisionsTable) {
      table.classList.add("reader-normal-table-right");
      if (isAmericasReferenceTable) {
        table.classList.add("reader-americas-reference-table");
      }
      if (isAmericasPoliticalDivisionsTable) {
        table.classList.add("reader-americas-political-divisions-table");
      }
      wrapper?.classList.add("reader-normal-table-wrapper-right");
      return;
    }

    if (
      /\b(floatright|tright|mw-halign-right)\b/i.test(classText) ||
      /float\s*:\s*right/i.test(styleText)
    ) {
      table.classList.add("reader-normal-table-right");
      wrapper?.classList.add("reader-normal-table-wrapper-right");
      return;
    }

    if (
      /\b(center|tnone|mw-halign-center)\b/i.test(classText) ||
      (
        /margin-left\s*:\s*auto/i.test(styleText) &&
        /margin-right\s*:\s*auto/i.test(styleText)
      )
    ) {
      table.classList.add("reader-normal-table-center");
      wrapper?.classList.add("reader-normal-table-wrapper-center");
      return;
    }

    table.classList.add("reader-normal-table-left");
    wrapper?.classList.add("reader-normal-table-wrapper-left");
  });

}

function enhanceReaderElectricalEquationTables(document: Document) {
  const initialOpenByTitle = new Map([
    ["circuit parameter definitions", true],
    ["basic electrical equations", true],
    ["power equations", false],
    ["torque equations", false],
  ]);

  document
    .querySelectorAll<HTMLTableElement>("table.wikitable.collapsible")
    .forEach((table) => {
      const headerCell = table.rows[0]?.cells[0];
      if (!headerCell || headerCell.tagName !== "TH" || headerCell.colSpan < 1) return;

      const title = (headerCell.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
      const initiallyOpen = initialOpenByTitle.get(title);
      if (initiallyOpen === undefined) return;
      if (headerCell.querySelector(".reader-equation-collapse-toggle")) return;

      table.classList.add("reader-equation-collapsible-table");
      table.classList.toggle("reader-equation-parameter-table", title === "circuit parameter definitions");
      table.style.setProperty("width", "min(100%, 42rem)", "important");
      table.style.setProperty("min-width", "min(100%, 42rem)", "important");
      table.style.setProperty("max-width", "100%", "important");
      table.style.setProperty("border-bottom", "0", "important");
      headerCell.style.setProperty("position", "relative", "important");
      headerCell.style.setProperty("padding-top", "3.2px", "important");
      headerCell.style.setProperty("padding-bottom", "3.2px", "important");
      headerCell.style.setProperty("text-align", "center", "important");
      headerCell.style.setProperty("vertical-align", "middle", "important");

      if (title === "circuit parameter definitions") {
        const unitCellTemplate = Array.from(table.rows).find(
          (row) => row.cells.length >= 3 && row.cells[2].tagName === "TD",
        )?.cells[2];

        if (unitCellTemplate) {
          Array.from(table.rows).slice(1).forEach((row) => {
            if (row.cells.length !== 2) return;

            const unitCell = unitCellTemplate.cloneNode(false) as HTMLTableCellElement;
            unitCell.textContent = "";
            row.append(unitCell);
          });
        }
      }

      const bodyRows = Array.from(table.rows).slice(1);
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "reader-equation-collapse-toggle";

      const openBracket = document.createElement("span");
      openBracket.className = "reader-equation-collapse-bracket";
      openBracket.textContent = "[";
      const label = document.createElement("span");
      label.className = "reader-equation-collapse-label";
      const closeBracket = document.createElement("span");
      closeBracket.className = "reader-equation-collapse-bracket";
      closeBracket.textContent = "]";
      toggle.append(openBracket, label, closeBracket);

      const setExpanded = (expanded: boolean) => {
        table.style.setProperty(
          "border-bottom",
          expanded ? "1px solid #47545c" : "0",
          "important",
        );
        bodyRows.forEach((row) => {
          row.hidden = !expanded;
          row.classList.toggle("reader-equation-collapse-row-hidden", !expanded);
        });
        toggle.setAttribute("aria-expanded", String(expanded));
        toggle.setAttribute("aria-label", `${expanded ? "Hide" : "Show"} ${title}`);
        label.textContent = expanded ? "hide" : "show";
      };

      headerCell.classList.add("reader-equation-collapse-header");
      headerCell.append(toggle);
      setExpanded(initiallyOpen);
    });
}

function markReaderScoreIndexColorColumns(document: Document) {
  document.querySelectorAll<HTMLTableElement>("table").forEach((table) => {
    const headerRow = table.rows[0];
    const indicationHeader = Array.from(headerRow?.cells ?? []).find(
      (cell) =>
        cell.tagName === "TH" &&
        cell.colSpan === 2 &&
        cell.textContent?.replace(/\s+/g, " ").trim().toLowerCase() === "indication",
    );
    const firstDataRow = Array.from(table.rows).find((row) => row !== headerRow);
    const colorCell = firstDataRow?.cells[0];
    const hasPreservedColor = Boolean(
      colorCell &&
        (colorCell.classList.contains("reader-preserved-background") ||
          colorCell.hasAttribute("bgcolor") ||
          /(?:^|;)\s*(?:background(?:-color)?|--reader-preserved-background)\s*:/i.test(
            colorCell.getAttribute("style") ?? "",
          )),
    );

    if (
      !indicationHeader ||
      headerRow.cells.length < 3 ||
      !firstDataRow ||
      firstDataRow.cells.length !== 4 ||
      !colorCell ||
      colorCell.textContent?.trim() ||
      colorCell.rowSpan < 2 ||
      !hasPreservedColor
    ) {
      return;
    }

    table.classList.add("reader-score-index-table");
    let colgroup = table.querySelector<HTMLTableColElement>(":scope > colgroup");
    if (!colgroup || colgroup.children.length !== 4) {
      colgroup?.remove();
      colgroup = document.createElement("colgroup");
      for (let index = 0; index < 4; index += 1) {
        colgroup.appendChild(document.createElement("col"));
      }
      table.insertBefore(colgroup, table.tBodies[0] ?? null);
    }

    table.style.setProperty("width", "min(100%, 718px)", "important");
    table.style.setProperty("min-width", "0", "important");
    table.style.setProperty("max-width", "100%", "important");
    table.style.setProperty("table-layout", "fixed", "important");

    ["14px", "250px", "120px", "310px"].forEach((width, index) => {
      colgroup!.children[index]?.setAttribute("style", `width: ${width} !important`);
    });
  });
}

function markReaderCompactLegendTables(document: Document) {
  document
    .querySelectorAll<HTMLTableElement>("table.wikitable.mw-collapsible")
    .forEach((table) => {
      if (
        table.closest(
          ".infobox, .navbox, .vertical-navbox, .reader-preserved-sidebar, .reader-navbox-details",
        ) ||
        table.rows.length !== 3
      ) {
        return;
      }

      const [titleRow, swatchRow, boldRow] = Array.from(table.rows);
      const titleCell = titleRow.cells[0];
      const swatchCell = swatchRow.cells[0];
      const boldCell = boldRow.cells[0];
      const title = titleCell?.textContent?.replace(/\s+/g, " ").trim() ?? "";
      const hasSwatchBackground = Boolean(
        swatchCell &&
          (swatchCell.hasAttribute("bgcolor") ||
            swatchCell.classList.contains("reader-preserved-background") ||
            /(?:^|;)\s*(?:background(?:-color)?|--reader-preserved-background)\s*:/i.test(
              swatchCell.getAttribute("style") ?? "",
            )),
      );

      if (
        !titleCell ||
        titleCell.tagName !== "TH" ||
        titleCell.colSpan !== 2 ||
        title.toLowerCase() !== "legend" ||
        swatchRow.cells.length !== 2 ||
        boldRow.cells.length !== 2 ||
        !hasSwatchBackground ||
        !boldCell ||
        !/^bold$/i.test(boldCell.textContent?.replace(/\s+/g, " ").trim() ?? "")
      ) {
        return;
      }

      table.classList.add("reader-compact-legend-table");

      let columns = table.querySelector<HTMLTableColElement>(":scope > colgroup")?.children;
      if (!columns || columns.length !== 2) {
        const colgroup = document.createElement("colgroup");
        colgroup.innerHTML = "<col><col>";
        table.insertBefore(colgroup, table.tBodies[0] ?? null);
        columns = colgroup.children;
      }
      columns[0]?.setAttribute("class", "reader-compact-legend-swatch-column");
      columns[1]?.setAttribute("class", "reader-compact-legend-description-column");

      table.style.setProperty("width", "min(100%, 220px)", "important");
      table.style.setProperty("min-width", "0", "important");
      table.style.setProperty("max-width", "100%", "important");
      table.style.setProperty("table-layout", "fixed", "important");
      (columns[0] as HTMLTableColElement | undefined)?.style.setProperty(
        "width",
        "58px",
        "important",
      );
      (columns[1] as HTMLTableColElement | undefined)?.style.setProperty(
        "width",
        "162px",
        "important",
      );

      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "reader-compact-legend-toggle";

      const openBracket = document.createElement("span");
      openBracket.className = "reader-compact-legend-toggle-bracket";
      openBracket.textContent = "[";
      const label = document.createElement("span");
      label.className = "reader-compact-legend-toggle-label";
      const closeBracket = document.createElement("span");
      closeBracket.className = "reader-compact-legend-toggle-bracket";
      closeBracket.textContent = "]";
      toggle.append(openBracket, label, closeBracket);

      const bodyRows = [swatchRow, boldRow];
      const setCollapsed = (collapsed: boolean) => {
        table.classList.toggle("reader-compact-legend-collapsed", collapsed);
        bodyRows.forEach((row) =>
          row.classList.toggle("reader-compact-legend-row-hidden", collapsed),
        );
        toggle.setAttribute("aria-expanded", String(!collapsed));
        toggle.setAttribute("aria-label", `${collapsed ? "Show" : "Hide"} legend rows`);
        label.textContent = collapsed ? "show" : "hide";
      };

      const tableIndex = Array.from(document.querySelectorAll("table")).indexOf(table) + 1;
      table.id ||= `reader-compact-legend-${tableIndex}`;
      toggle.setAttribute("aria-controls", table.id);
      titleCell.append(toggle);
      setCollapsed(table.classList.contains("mw-collapsed"));
    });
}

function addReaderGameLogCollapsibleControls(document: Document) {
  document.querySelectorAll<HTMLTableElement>("table.game-log").forEach((log) => {
    log.querySelectorAll<HTMLElement>(".mw-collapsible").forEach((group) => {
      if (group.querySelector(":scope > .reader-game-log-toggle")) return;

      const heading = Array.from(group.children).find(
        (child): child is HTMLElement =>
          child instanceof HTMLElement &&
          !child.classList.contains("mw-collapsible-content"),
      );
      const content = Array.from(group.children).find(
        (child): child is HTMLElement =>
          child instanceof HTMLElement &&
          child.classList.contains("mw-collapsible-content"),
      );

      if (!heading || !content) return;

      const headingText = (heading.textContent || "").replace(/\s+/g, " ").trim();
      const isPreseason = /^Preseason:/i.test(headingText);
      const collapsed = !isPreseason && group.classList.contains("mw-collapsed");

      heading.classList.add("reader-game-log-group-heading");

      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "reader-game-log-toggle";

      const updateState = (nextCollapsed: boolean) => {
        group.classList.toggle("mw-collapsed", nextCollapsed);
        content.hidden = nextCollapsed;
        toggle.textContent = nextCollapsed ? "[show]" : "[hide]";
        toggle.setAttribute("aria-expanded", String(!nextCollapsed));
        toggle.setAttribute(
          "aria-label",
          `${nextCollapsed ? "Show" : "Hide"} ${headingText || "game log"}`,
        );
      };

      heading.append(toggle);
      updateState(collapsed);
    });
  });
}

function markReaderPairedCollapsibleTables(document: Document) {
  document
    .querySelectorAll<HTMLTableElement>(
      "table.reader-normal-table-left",
    )
    .forEach((layoutTable) => {
      if (layoutTable.rows.length !== 1 || layoutTable.rows[0].cells.length !== 2) {
        return;
      }

      const pairedTables = Array.from(layoutTable.rows[0].cells).map((cell) =>
        cell.querySelector<HTMLTableElement>(
          "table.wikitable.mw-collapsible.mw-collapsed",
        ),
      );

      if (
        pairedTables.some((table) => !table || table.rows.length !== 51) ||
        pairedTables.some((table) => {
          const headers = Array.from(table!.rows[0].cells).map((cell) =>
            (cell.textContent || "").replace(/\s+/g, " ").trim().toLowerCase(),
          );

          return headers.join("|") !== "no.|community name|type|2020 pop.";
        })
      ) {
        return;
      }

      const layout = document.createElement("div");
      layout.className = "reader-paired-collapsible-table-layout";
      layoutTable.before(layout);

      pairedTables.forEach((table) => {
        if (!table) return;

        const column = document.createElement("div");
        column.className = "reader-paired-collapsible-table-column";
        layout.append(column);
        column.append(table);
        table.classList.add("reader-paired-collapsible-table");
        const collapsed = table.classList.contains("mw-collapsed");
        table.classList.remove("mw-collapsed");
        const bodyRows = Array.from(table.rows).slice(1);
        bodyRows.forEach((row) => {
          row.classList.toggle("reader-paired-collapsible-row-hidden", collapsed);
        });

        const headerCell = table.rows[0].cells[table.rows[0].cells.length - 1];
        if (!headerCell || headerCell.querySelector(".reader-paired-table-toggle")) {
          return;
        }

        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "reader-paired-table-toggle";
        toggle.setAttribute("aria-expanded", String(!collapsed));

        const updateToggle = (expanded: boolean) => {
          toggle.textContent = expanded ? "[hide]" : "[show]";
          toggle.setAttribute("aria-expanded", String(expanded));
          toggle.setAttribute(
            "aria-label",
            `${expanded ? "Hide" : "Show"} ${bodyRows.length} table rows`,
          );
        };

        updateToggle(!collapsed);
        headerCell.append(toggle);
      });

      layoutTable.remove();
    });
}

function markReaderTreeChart(document: Document) {
  document.querySelectorAll<HTMLTableElement>("table.tree-chart").forEach((table) => {
    table.classList.add("reader-tree-chart");

    const collapsible = table.closest<HTMLTableElement>("table.collapsible");
    const headerCell = collapsible?.rows[0]?.cells[0];
    if (collapsible && headerCell && !headerCell.querySelector(".reader-tree-chart-toggle")) {
      collapsible.classList.add("reader-tree-chart-container");
      const bodyRows = Array.from(collapsible.rows).slice(1);
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "reader-tree-chart-toggle";
      const setCollapsed = (collapsed: boolean) => {
        collapsible.classList.toggle("reader-tree-chart-collapsed", collapsed);
        collapsible.classList.toggle("collapsed", collapsed);
        bodyRows.forEach((row) => row.classList.toggle("reader-tree-chart-row-hidden", collapsed));
        toggle.textContent = collapsed ? "[show]" : "[hide]";
        toggle.setAttribute("aria-expanded", String(!collapsed));
        toggle.setAttribute("aria-label", `${collapsed ? "Show" : "Hide"} infographic`);
      };
      headerCell.append(toggle);
      setCollapsed(collapsible.classList.contains("collapsed"));
    }

    table.querySelectorAll<HTMLTableCellElement>("th, td").forEach((cell) => {
      const hasContent = (cell.textContent || "").replace(/\s+/g, " ").trim().length > 0;
      cell.classList.toggle("reader-tree-chart-box", hasContent);
      cell.classList.toggle("reader-tree-chart-connector", !hasContent);
    });

    const contentRows = Array.from(table.rows)
      .map((row, index) => ({
        row,
        index,
        cells: Array.from(row.cells).filter((cell) =>
          (cell.textContent || "").replace(/\s+/g, " ").trim().length > 0,
        ),
      }))
      .filter(({ cells }) => cells.length > 0);

    if (contentRows.length !== 4) return;

    contentRows.forEach(({ cells }, rowIndex) => {
      cells.forEach((cell, cellIndex) => {
        cell.classList.toggle(
          "reader-tree-chart-box-left",
          rowIndex === contentRows.length - 1 && cellIndex < 3,
        );

        cell.querySelectorAll<HTMLAnchorElement>("a").forEach((link) => {
          link.classList.remove("reader-visited-link");
          link.classList.add("reader-tree-chart-link");
        });
      });
    });
  });
}

function markReaderCollapsibleMapFrames(document: Document) {
  document
    .querySelectorAll<HTMLTableElement>("table.collapsible:has(.locmap)")
    .forEach((table) => {
      if (table.querySelector(".reader-collapsible-map-toggle")) return;

      const headerCell = table.rows[0]?.cells[0];
      const bodyRows = Array.from(table.rows).slice(1);
      if (!headerCell || bodyRows.length === 0) return;

      table.classList.add("reader-collapsible-map-frame");

      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "reader-collapsible-map-toggle";

      const setExpanded = (expanded: boolean) => {
        table.classList.toggle("reader-collapsible-map-collapsed", !expanded);
        table.classList.toggle("collapsed", !expanded);
        bodyRows.forEach((row) =>
          row.classList.toggle("reader-collapsible-map-row-hidden", !expanded),
        );
        toggle.textContent = expanded ? "[hide]" : "[show]";
        toggle.setAttribute("aria-expanded", String(expanded));
        toggle.setAttribute(
          "aria-label",
          `${expanded ? "Hide" : "Show"} local transit map`,
        );
      };

      headerCell.append(toggle);
      // The map may not have completed layout yet, so its initial row height
      // cannot reliably tell us whether it should be shown.
      setExpanded(true);
    });
}

function layoutReaderTreeCharts(root: HTMLElement) {
  root.querySelectorAll<HTMLTableElement>("table.reader-tree-chart").forEach((table) => {
    let wrapper = table.parentElement?.classList.contains("reader-tree-chart-layout")
      ? table.parentElement
      : null;

    if (!wrapper) {
      wrapper = document.createElement("div");
      wrapper.className = "reader-tree-chart-layout";
      table.parentNode?.insertBefore(wrapper, table);
      wrapper.appendChild(table);
    }

    wrapper.querySelector("svg.reader-tree-chart-connectors")?.remove();

    const contentRows = Array.from(table.rows)
      .map((row) => Array.from(row.cells).filter((cell) =>
        cell.classList.contains("reader-tree-chart-box"),
      ))
      .filter((cells) => cells.length > 0);

    if (contentRows.length < 2) return;

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("reader-tree-chart-connectors");
    svg.setAttribute("aria-hidden", "true");

    const addLine = (x1: number, y1: number, x2: number, y2: number) => {
      const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
      line.setAttribute("x1", String(x1));
      line.setAttribute("y1", String(y1));
      line.setAttribute("x2", String(x2));
      line.setAttribute("y2", String(y2));
      svg.appendChild(line);
    };

    const getBox = (cell: HTMLTableCellElement) => {
      const cellRect = cell.getBoundingClientRect();
      const wrapperRect = wrapper!.getBoundingClientRect();

      return {
        centerX: (cellRect.left + cellRect.right) / 2 - wrapperRect.left,
        top: cellRect.top - wrapperRect.top,
        bottom: cellRect.bottom - wrapperRect.top,
      };
    };

    const groups = contentRows.map((cells) => cells.map(getBox));

    groups.slice(0, -1).forEach((parents, level) => {
      const children = groups[level + 1];

      parents.forEach((parent, parentIndex) => {
        const start = Math.floor(parentIndex * children.length / parents.length);
        const end = Math.floor((parentIndex + 1) * children.length / parents.length);
        const childGroup = children.slice(start, end);
        if (childGroup.length === 0) return;

        const connectorY = parent.bottom +
          (Math.min(...childGroup.map((child) => child.top)) - parent.bottom) / 2;

        addLine(parent.centerX, parent.bottom, parent.centerX, connectorY);

        if (childGroup.length > 1) {
          addLine(
            childGroup[0].centerX,
            connectorY,
            childGroup[childGroup.length - 1].centerX,
            connectorY,
          );
        }

        childGroup.forEach((child) => {
          addLine(child.centerX, connectorY, child.centerX, child.top);
        });
      });
    });

    wrapper.insertBefore(svg, table);
    const wrapperRect = wrapper.getBoundingClientRect();
    svg.setAttribute("viewBox", `0 0 ${wrapperRect.width} ${wrapperRect.height}`);
  });
}

function markReaderElectronConfigurationTable(document: Document) {
  const table = Array.from(
    document.querySelectorAll<HTMLTableElement>("table.mw-collapsible"),
  ).find((candidate) => {
    const text = (candidate.textContent || "").replace(/\s+/g, " ").trim();

    return (
      /Electron configurations of the chemical elements/i.test(text) &&
      candidate.querySelector("tbody > tr")
    );
  });

  if (!table) return;

  table.classList.add("reader-electron-configuration-table");

  table
    .querySelectorAll<HTMLTableCellElement>("td[bgcolor], th[bgcolor]")
    .forEach((cell) => {
      const color = cell.getAttribute("bgcolor");
      if (color) {
        cell.style.setProperty("background-color", color, "important");
        cell.style.setProperty("background", color, "important");
      }
    });

  const parent = table.parentElement;
  if (!parent) return;

  const legend = Array.from(
    document.querySelectorAll<HTMLTableElement>("table"),
  ).find((candidate) => {
    if (candidate === table) return false;
    const box = candidate.closest<HTMLElement>(".reader-preserved-border");
    const text = (box?.textContent || "").replace(/\s+/g, " ").trim();
    return (
      /^s-block\s+f-block\s+d-block\s+p-block$/i.test(text) &&
      candidate.rows[0]?.cells.length === 4 &&
      box !== null
    );
  });

  legend?.classList.add("reader-electron-configuration-legend");
  legend
    ?.closest<HTMLElement>(".reader-preserved-border")
    ?.classList.add("reader-electron-configuration-legend-box");

  let wrapper = table.parentElement;
  if (!wrapper.classList.contains("reader-electron-configuration-scroll")) {
    wrapper = document.createElement("div");
    wrapper.className = "reader-electron-configuration-scroll";
    parent.insertBefore(wrapper, table);
    wrapper.appendChild(table);
  }

  table.style.setProperty("margin", "0", "important");
  wrapper.style.setProperty("margin-bottom", "24px", "important");

  const syncWrapperHeight = () => {
    const tableHeight = Math.ceil(table.getBoundingClientRect().height);
    if (tableHeight > 0) {
      wrapper.style.setProperty("height", `${tableHeight + 14}px`, "important");
    }
  };

  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(syncWrapperHeight);
  });

  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(syncWrapperHeight);
    observer.observe(table);
  }
}

function markReaderPeriodicTableLayout(document: Document) {
  document.querySelectorAll<HTMLTableElement>(
    ".mw-collapsible-content > table.reader-normal-table",
  ).forEach((table) => {
    const content = table.parentElement;
    if (!content) return;

    const tableText = (table.textContent || "").replace(/\s+/g, " ").trim();
    const info = Array.from(content.children).find((child) => {
      const text = (child.textContent || "").replace(/\s+/g, " ").trim();
      return (
        child instanceof HTMLElement &&
        child.classList.contains("reader-preserved-border") &&
        child.classList.contains("reader-preserved-background") &&
        /Primordial.*From decay.*Synthetic.*Border shows natural occurrence/i.test(text)
      );
    });

    if (
      !info ||
      !/^Group\s+1\s+2\s+.*18\b/i.test(tableText) ||
      table.rows.length < 10 ||
      table.rows[0].cells.length < 18
    ) {
      return;
    }

    table.classList.add("reader-periodic-table");
    info.classList.add("reader-periodic-table-info");

    const legend = Array.from(
      info.querySelectorAll<HTMLTableElement>("table"),
    ).find((candidate) =>
      /s-block.*f-block.*d-block.*p-block/i.test(
        (candidate.textContent || "").replace(/\s+/g, " ").trim(),
      ),
    );

    if (legend) {
      legend.style.setProperty("width", "100%", "important");
      legend.style.setProperty("min-width", "100%", "important");
      legend.style.setProperty("max-width", "100%", "important");
    }

    Array.from(table.rows)
      .slice(-2)
      .flatMap((row) => Array.from(row.cells))
      .forEach((cell) => {
        if (
          !cell.textContent?.trim() &&
          !cell.classList.contains("reader-preserved-background")
        ) {
          cell.classList.add("reader-periodic-table-empty-cell");
        }
      });

    const existingWrapper = table.parentElement;
    if (existingWrapper?.classList.contains("reader-periodic-table-scroll")) {
      return;
    }

    const wrapper = document.createElement("div");
    wrapper.className = "reader-periodic-table-scroll";
    content.insertBefore(wrapper, table);
    wrapper.appendChild(table);
  });
}

function markReaderElementInfoboxPeriodicTables(document: Document) {
  document
    .querySelectorAll<HTMLElement>(
      "table.infobox.ib-element .ib-element-periodic-table",
    )
    .forEach((periodicTable) => {
      const microTable = periodicTable.querySelector<HTMLTableElement>(
        "table.periodic-table-32-micro",
      );

      if (!microTable) return;

      microTable.style.setProperty("display", "table", "important");
      microTable.style.setProperty("table-layout", "fixed", "important");
      microTable.style.setProperty("width", "360px", "important");
      microTable.style.setProperty("min-width", "0", "important");
      microTable.style.setProperty("max-width", "100%", "important");
      microTable.style.setProperty("margin-left", "auto", "important");
      microTable.style.setProperty("margin-right", "auto", "important");
      microTable.style.setProperty("overflow", "visible", "important");

      microTable.querySelectorAll<HTMLElement>("th, td").forEach((cell) => {
        cell.style.setProperty("padding", "1px", "important");
      });

      microTable.querySelectorAll<HTMLElement>("a > span").forEach((label) => {
        label.style.setProperty("color", "transparent", "important");
        label.style.setProperty(
          "-webkit-text-fill-color",
          "transparent",
          "important",
        );
      });
    });
}


function markReaderStateChampionsTables(document: Document) {
  const headings = Array.from(document.querySelectorAll<HTMLElement>("h2, .mw-heading"));

  headings.forEach((heading) => {
    const headingText = readerStateChampionsHeadingText(heading);

    if (!/^list of (?:state|conference) champions$/i.test(headingText)) return;

    heading.classList.add("reader-state-champions-heading");
    heading.classList.add("reader-champions-stack-heading");

    let walker = heading.nextElementSibling;

    while (walker) {
      if (readerStateChampionsIsH2(walker)) {
        return;
      }

      walker.classList.add("reader-state-champions-section-item");
      walker.classList.add("reader-champions-stack-section-item");

      if (walker.matches("h3, h4, .mw-heading")) {
        walker.classList.add("reader-state-champions-subheading");
      }

      const tables = [
        ...(walker.matches("table") ? [walker as HTMLTableElement] : []),
        ...Array.from(walker.querySelectorAll<HTMLTableElement>("table")),
      ];

      tables.forEach((table) => {
        if (table.closest(".infobox, .navbox, .vertical-navbox")) return;

        table.classList.add("reader-state-champions-table");
        table.classList.add("reader-champions-stack-table");

        table
          .querySelectorAll<HTMLTableCellElement>("tr > th:first-child, tr > td:first-child")
          .forEach((cell) => {
            cell.classList.add("reader-state-champions-first-cell");
          });

        table
          .closest<HTMLElement>(
            ".reader-scrollable-sortable-table, .reader-table-scroll, .reader-table-wrapper",
          )
          ?.classList.add("reader-state-champions-wrapper");
            table
              .closest<HTMLElement>(
                ".reader-scrollable-sortable-table, .reader-table-scroll, .reader-table-wrapper",
              )
              ?.classList.add("reader-champions-stack-wrapper");
      });

      walker = walker.nextElementSibling;
    }
  });
}


function markReaderSportsMatrixNotes(document: Document) {
  const markNotesAfter = (startElement: Element) => {
    let walker = startElement.nextElementSibling;

    while (walker) {
      const headingText = readerSportsMatrixHeadingText(walker);

      if (walker.matches("h2, .mw-heading") && !/^notes$/i.test(headingText)) {
        return false;
      }

      if (walker.matches("h2, h3, h4, .mw-heading") && /^notes$/i.test(headingText)) {
        walker.classList.add("reader-sports-matrix-notes-heading");

        let noteNode = walker.nextElementSibling;
        while (noteNode && !noteNode.matches("h2, h3, h4, .mw-heading")) {
          if (
            noteNode.matches(
              "ol, ul, dl, p, .reflist, .references, .mw-references-wrap, .notelist",
            )
          ) {
            noteNode.classList.add("reader-sports-matrix-notes");
          }

          noteNode = noteNode.nextElementSibling;
        }

        return true;
      }

      if (
        walker.matches(
          "ol.references, .references, .mw-references-wrap, .reflist, .notelist",
        )
      ) {
        walker.classList.add("reader-sports-matrix-notes");
      }

      walker = walker.nextElementSibling;
    }

    return false;
  };

  document.querySelectorAll<HTMLTableElement>("table.reader-sports-matrix-table").forEach((table) => {
    readerSportsMatrixTableWrapper(table);

    const starts: Element[] = [table];
    let parent = table.parentElement;

    while (parent && !parent.classList.contains("reader-article")) {
      starts.push(parent);
      parent = parent.parentElement;
    }

    for (const startElement of starts) {
      if (markNotesAfter(startElement)) return;
    }
  });
}

function markReaderSportsMatrixTables(document: Document) {
  const sportHeaderPattern =
    /baseball|basketball|cross country|football|golf|gymnastics|soccer|softball|tennis|track|volleyball|wrestling/i;

  document.querySelectorAll<HTMLTableElement>("table").forEach((table) => {
    if (table.closest(".infobox, .navbox, .vertical-navbox")) return;

    const text = table.textContent?.replace(/\s+/g, " ").trim() ?? "";
    const headers = Array.from(table.querySelectorAll<HTMLTableCellElement>("th"));
    const headerText = headers.map(
      (header) => header.textContent?.replace(/\s+/g, " ").trim() ?? "",
    );

    const xCellCount = Array.from(table.querySelectorAll("td, th")).filter((cell) => {
      const cellText =
        cell.textContent
          ?.replace(/\[[^\]]+\]/g, "")
          .replace(/\s+/g, " ")
          .trim() ?? "";

      return /^x$/i.test(cellText);
    }).length;

    const sportHeaderCount = headerText.filter((candidate) =>
      sportHeaderPattern.test(candidate),
    ).length;

    const looksLikeSportsMatrix =
      /boys basketball|girls basketball|boys cross country|girls cross country/i.test(text) ||
      (xCellCount >= 20 && sportHeaderCount >= 8);

    if (!looksLikeSportsMatrix) return;

    table.classList.add("reader-sports-matrix-table");
    readerSportsMatrixTableWrapper(table);

    table
      .querySelectorAll<HTMLTableCellElement>("tr > th:first-child, tr > td:first-child")
      .forEach((cell) => {
        cell.classList.add("reader-sports-matrix-school-cell");
      });

    headers.forEach((header) => {
      const clean = header.textContent?.replace(/\s+/g, " ").trim() ?? "";

      if (!sportHeaderPattern.test(clean)) return;

      header.classList.add("reader-sports-matrix-vertical-header");

      if (!header.querySelector(".reader-sports-matrix-vertical-label")) {
        const label = document.createElement("span");
        label.className = "reader-sports-matrix-vertical-label";

        while (header.firstChild) {
          label.appendChild(header.firstChild);
        }

        header.appendChild(label);
      }
    });

    table.querySelectorAll<HTMLTableCellElement>("td, th").forEach((cell) => {
      const clean =
        cell.textContent
          ?.replace(/\[[^\]]+\]/g, "")
          .replace(/\s+/g, " ")
          .trim() ?? "";

      if (/^x$/i.test(clean)) {
        cell.classList.add("reader-sports-matrix-x-cell");
      }
    });
  });
}


function markReaderTableColorSwatches(document: Document) {
  document
    .querySelectorAll<HTMLElement>(
      "table:not(.infobox) td .reader-preserved-background, table:not(.infobox) th .reader-preserved-background",
    )
    .forEach((element) => {
      if (element.classList.contains("reader-barbox-real-bar")) return;

      if (
        [
          "TABLE",
          "TBODY",
          "THEAD",
          "TFOOT",
          "TR",
          "TD",
          "TH",
          "CAPTION",
        ].includes(element.tagName)
      ) {
        return;
      }

      if (
        element.closest(
          ".infobox, .reader-presidential-results-table, .reader-generated-pie-chart",
        )
      ) {
        return;
      }

      if (element.querySelector("img, svg, table, canvas, video")) {
        return;
      }

      const text = (element.textContent ?? "")
        .replace(/\u00a0/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      if (text && text !== "|" && text.length > 2) {
        return;
      }

      const cell = element.closest<HTMLTableCellElement>("td, th");
      const row = cell?.parentElement as HTMLTableRowElement | null;
      const cellIndex = cell ? Array.from(row?.children || []).indexOf(cell) : -1;
      const hasPixelWidth = /^\d+(?:\.\d+)?px$/i.test(
        element.style.width.trim(),
      );
      const rowHasPercentageValue = Array.from(row?.cells || []).some(
        (candidateCell) => {
          if (candidateCell === cell) return false;
          const candidateText = (candidateCell.textContent || "")
            .replace(/\s+/g, " ")
            .trim();
          return /^(?:\d+(?:\.\d+)?|\.\d+)\s*%$/.test(candidateText);
        },
      );

      /*
       * Percentage bars carry their actual proportional width in pixels.
       * Keep those widths instead of converting the fills into fixed square
       * color swatches when they sit beside a percentage value.
       */
      if (hasPixelWidth && rowHasPercentageValue) return;

      const table = element.closest<HTMLTableElement>("table");
      const headerText =
        table && cellIndex >= 0
          ? Array.from(table.querySelectorAll<HTMLTableRowElement>("tr"))
              .map((candidateRow) => candidateRow.children[cellIndex])
              .map((candidateCell) =>
                candidateCell?.textContent?.replace(/\s+/g, " ").trim() ?? "",
              )
              .find((candidateText) => /colors?/i.test(candidateText)) || ""
          : "";

      const likelyColorColumn =
        /colors?/i.test(headerText) ||
        /colors?/i.test(cell?.getAttribute("data-sort-value") || "") ||
        (cell?.textContent?.replace(/\s+/g, " ").trim().length ?? 0) <= 8;

      if (!likelyColorColumn) {
        return;
      }

      element.classList.add("reader-table-color-swatch");
      cell?.classList.add("reader-table-color-swatch-cell");
    });
}


function removeReaderOtherNativeNames(document: Document) {
  document
    .querySelectorAll<HTMLTableRowElement>(".infobox tr")
    .forEach((row) => {
      const hasOtherNativeNames = [
        ...row.querySelectorAll<HTMLElement>(".collapsible-list"),
      ].some((list) =>
        [...list.querySelectorAll<HTMLElement>("div")].some(
          (element) =>
            element.textContent?.replace(/\s+/g, " ").trim() ===
            "Other native names",
        ),
      );

      if (hasOtherNativeNames) {
        row.remove();
      }
    });
}

function cleanupReaderInfoboxBlankRows(document: Document) {
  document
    .querySelectorAll<HTMLTableRowElement>(".infobox tr")
    .forEach((row) => {
      if (row.querySelector("img, video, svg, canvas, input, button, select, textarea")) {
        return;
      }

      const cells = Array.from(row.cells);
      if (cells.length === 0) return;

      const rowText = row.textContent?.replace(/\s+/g, "").trim() ?? "";
      const allCellsEmpty = cells.every((cell) => {
        const cellText = cell.textContent?.replace(/\s+/g, "").trim() ?? "";
        return cellText === "" && !cell.querySelector("img, video, svg, canvas");
      });

      if (rowText === "" && allCellsEmpty) {
        row.remove();
      }
    });
}

function fixInfoboxOrphanPunctuation(document: Document) {
  document.querySelectorAll(".infobox td").forEach((cell) => {
    Array.from(cell.childNodes).forEach((node) => {
      if (node.nodeType !== Node.TEXT_NODE) return;

      const text = node.textContent || "";
      const trimmed = text.trim();

      if (!/^[,/]$/.test(trimmed)) return;

      let previous = node.previousSibling;

      while (previous && previous.textContent?.trim() === "") {
        previous = previous.previousSibling;
      }

      if (previous && previous.nodeType === Node.ELEMENT_NODE) {
        previous.textContent = `${previous.textContent || ""}${trimmed}`;
        node.textContent = " ";
        return;
      }

      if (previous && previous.nodeType === Node.TEXT_NODE) {
        previous.textContent = `${previous.textContent || ""}${trimmed}`;
        node.textContent = " ";
      }
    });
  });
}

function removeReaderSections(document: Document, titlesToRemove: Set<string>) {
  document.querySelectorAll<HTMLElement>("h2, h3, h4").forEach((heading) => {
    const title = normalizeReaderSectionTitle(heading.textContent || "");

    if (!titlesToRemove.has(title)) return;

    const headingLevel = Number(heading.tagName.slice(1));
    const headingContainer = heading.closest<HTMLElement>(".mw-heading");
    const sectionStart = headingContainer || heading;

    let nextNode = sectionStart.nextSibling;
    sectionStart.remove();

    while (nextNode) {
      const currentNode = nextNode;
      nextNode = nextNode.nextSibling;

      if (currentNode.nodeType !== Node.ELEMENT_NODE) {
        currentNode.remove();
        continue;
      }

      const element = currentNode as HTMLElement;
      if (element.matches(".navbox, .vertical-navbox")) break;
      const nextHeading = element.matches("h2, h3, h4")
        ? element
        : element.querySelector<HTMLElement>("h2, h3, h4");

      if (nextHeading) {
        const nextLevel = Number(nextHeading.tagName.slice(1));
        if (nextLevel <= headingLevel) break;
      }

      element.remove();
    }
  });
}

function normalizeReaderSectionTitle(text: string) {
  return text
    .replace(/\[edit\]/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function collectReaderSections(document: Document): ReaderSection[] {
  const usedIds = new Set<string>();
  const sections: ReaderSection[] = [];

  document.querySelectorAll<HTMLElement>("h2, h3, h4").forEach((heading) => {
    const title = (heading.textContent || "")
      .replace(/\[edit\]/gi, "")
      .replace(/\s+/g, " ")
      .trim();

    if (!title) return;

    const level = Number(heading.tagName.slice(1));
    const baseId = makeReaderSectionId(title);
    let id = heading.id || baseId;
    let suffix = 2;

    while (usedIds.has(id)) {
      id = `${baseId}-${suffix}`;
      suffix += 1;
    }

    usedIds.add(id);
    heading.id = id;

    sections.push({ id, title, level });
  });

  return sections;
}

function makeReaderSectionId(title: string) {
  return (
    title
      .toLowerCase()
      .replace(/&/g, " and ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "section"
  );
}

function getArticleOpenStreetMapUrl(document: Document) {
  const decimalText =
    document.querySelector(".geo-dec")?.textContent?.trim() || "";
  const coordinateText =
    document.querySelector(".geo-dms")?.textContent?.trim() ||
    document.querySelector(".geo")?.textContent?.trim() ||
    "";
  const geoHackHref =
    document.querySelector<HTMLAnchorElement>('a[href*="geohack"]')
      ?.getAttribute("href") ||
    document.querySelector<HTMLAnchorElement>('a[href*="params="]')
      ?.getAttribute("href") ||
    "";

  const coordinates =
    parseDecimalCoordinates(decimalText) ||
    parseDmsCoordinates(coordinateText) ||
    parseGeoHackCoordinates(geoHackHref);

  if (!coordinates || !areValidCoordinates(coordinates)) return null;

  const latitude = formatCoordinate(coordinates.latitude);
  const longitude = formatCoordinate(coordinates.longitude);
  return `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=12/${latitude}/${longitude}`;
}

interface Coordinates {
  latitude: number;
  longitude: number;
}

function parseDecimalCoordinates(value: string): Coordinates | null {
  if (!value) return null;

  const match = value.match(
    /([+-]?\d{1,2}(?:\.\d+)?)\s*°?\s*([NS])?\s*[,;/\s]+\s*([+-]?\d{1,3}(?:\.\d+)?)\s*°?\s*([EW])?/i,
  );
  if (!match) return null;

  return {
    latitude: applyHemisphere(Number(match[1]), match[2]),
    longitude: applyHemisphere(Number(match[3]), match[4]),
  };
}

function parseDmsCoordinates(value: string): Coordinates | null {
  if (!value) return null;

  const latitude = parseDmsComponent(value, "NS");
  const longitude = parseDmsComponent(value, "EW");
  if (latitude === null || longitude === null) return null;

  return { latitude, longitude };
}

function parseDmsComponent(
  value: string,
  hemispheres: "NS" | "EW",
): number | null {
  const degreeDigits = hemispheres === "NS" ? "{1,2}" : "{1,3}";
  const pattern = new RegExp(
    `(\\d${degreeDigits})\\s*(?:°|º|deg)\\s*` +
      `(?:(\\d{1,2}(?:\\.\\d+)?)\\s*(?:′|’|'|min)\\s*)?` +
      `(?:(\\d{1,2}(?:\\.\\d+)?)\\s*(?:″|”|"|sec)\\s*)?` +
      `([${hemispheres}])`,
    "i",
  );
  const match = value.match(pattern);
  if (!match) return null;

  const degrees = Number(match[1]);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  if (minutes >= 60 || seconds >= 60) return null;

  return applyHemisphere(
    degrees + minutes / 60 + seconds / 3600,
    match[4],
  );
}

function parseGeoHackCoordinates(href: string): Coordinates | null {
  if (!href) return null;

  let decodedHref = href;
  try {
    decodedHref = decodeURIComponent(href);
  } catch {
    // The original href may already be decoded or contain a malformed escape.
  }

  const params = decodedHref.match(/[?&]params=([^&#]+)/i)?.[1];
  if (!params) return null;

  const tokens = params.split("_");
  const latitudeDirectionIndex = tokens.findIndex((token) =>
    /^[NS]$/i.test(token),
  );
  const longitudeDirectionIndex = tokens.findIndex(
    (token, index) =>
      index > latitudeDirectionIndex && /^[EW]$/i.test(token),
  );
  if (latitudeDirectionIndex < 0 || longitudeDirectionIndex < 0) return null;

  const latitude = coordinateTokensToDecimal(
    tokens.slice(0, latitudeDirectionIndex),
    tokens[latitudeDirectionIndex],
  );
  const longitude = coordinateTokensToDecimal(
    tokens.slice(latitudeDirectionIndex + 1, longitudeDirectionIndex),
    tokens[longitudeDirectionIndex],
  );
  if (latitude === null || longitude === null) return null;

  return { latitude, longitude };
}

function coordinateTokensToDecimal(
  tokens: string[],
  hemisphere: string,
): number | null {
  const numbers = tokens
    .filter((token) => /^\d+(?:\.\d+)?$/.test(token))
    .slice(-3)
    .map(Number);
  if (numbers.length === 0) return null;

  const [degrees, minutes = 0, seconds = 0] = numbers;
  if (minutes >= 60 || seconds >= 60) return null;

  return applyHemisphere(
    degrees + minutes / 60 + seconds / 3600,
    hemisphere,
  );
}

function applyHemisphere(value: number, hemisphere?: string) {
  const direction = hemisphere?.toUpperCase();
  const magnitude = Math.abs(value);
  return direction === "S" || direction === "W"
    ? -magnitude
    : value < 0
      ? -magnitude
      : magnitude;
}

function areValidCoordinates({ latitude, longitude }: Coordinates) {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180
  );
}

function formatCoordinate(value: number) {
  const normalized = Object.is(value, -0) ? 0 : value;
  return normalized.toFixed(6);
}

function htmlToText(value: string) {
  const element = document.createElement("div");
  element.innerHTML = value;
  return element.textContent || value;
}

function cleanTopic(topic: string) {
  return topic.replace(/_/g, " ").replace(/#.*$/, "");
}
