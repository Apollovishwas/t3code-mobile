/**
 * Tiny markdown-with-YAML-frontmatter parser for `.t3/wiki/<slug>.md`.
 *
 * Deliberately minimal: handles scalar string/number/boolean values plus
 * inline-array (`[a, b]`) and block-array (`- item`) lists. No anchors,
 * no nested objects, no quoted multi-line scalars. Matches the page
 * shape T3 produces and what Claude will be told to write.
 */

export interface ParsedPage {
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly topics: ReadonlyArray<string>;
  readonly fileRefs: ReadonlyArray<{ path: string; isDir: boolean }>;
  /** Epoch ms; falls back to file mtime in the caller if frontmatter is empty. */
  readonly updatedAt: number;
  readonly archived: boolean;
  readonly supersededBy: string | null;
  readonly body: string;
  readonly outgoingLinks: ReadonlyArray<string>;
  readonly crossWikiLinks: ReadonlyArray<{ wiki: string; slug: string }>;
}

const WIKILINK_RE = /\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]/g;
const CROSS_WIKI_RE = /\[\[([a-z0-9-]+):([a-z0-9-]+?)(?:\|[^\]]*)?\]\]/g;
const SLUG_OK_RE = /^[a-z0-9][a-z0-9-]*$/;

export function slugFromFilename(filename: string): string | null {
  const base = filename.replace(/\.md$/i, "");
  return SLUG_OK_RE.test(base) ? base : null;
}

interface FrontmatterValue {
  readonly raw: string;
  readonly list: ReadonlyArray<string> | null;
}

/** Split `---\n…\n---\n<body>` into raw frontmatter text + body.
 *  Accepts a closing `---` followed by either a newline or EOF — Claude's
 *  Write tool occasionally omits the trailing newline. */
function splitFrontmatter(content: string): { fm: string; body: string } {
  // Accept BOM + CRLF.
  const normalized = content.replace(/^﻿/, "");
  if (!normalized.startsWith("---")) return { fm: "", body: normalized };
  const after = normalized.slice(3);
  const endIdx = after.search(/\r?\n---(?:\r?\n|$)/);
  if (endIdx === -1) return { fm: "", body: normalized };
  const fm = after.slice(after.indexOf("\n") + 1, endIdx);
  const bodyStart = endIdx + after.slice(endIdx).indexOf("\n---") + "\n---".length;
  const body = after.slice(bodyStart).replace(/^\r?\n/, "");
  return { fm, body };
}

function parseFrontmatter(raw: string): Map<string, FrontmatterValue> {
  const out = new Map<string, FrontmatterValue>();
  const lines = raw.split(/\r?\n/);
  let currentKey: string | null = null;
  let currentList: string[] | null = null;
  for (const line of lines) {
    if (line.length === 0) continue;
    // Block-array item.
    const listMatch = /^\s*-\s+(.+)$/.exec(line);
    if (listMatch && currentList !== null) {
      currentList.push(stripQuotes(listMatch[1]!.trim()));
      continue;
    }
    // key: value.
    const kvMatch = /^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!kvMatch) continue;
    if (currentKey && currentList !== null) {
      out.set(currentKey, { raw: currentList.join(", "), list: currentList });
    }
    const [, key, valueRaw] = kvMatch as unknown as [string, string, string];
    const value = valueRaw.trim();
    currentKey = key;
    currentList = null;
    if (value.length === 0) {
      // Opens a block-array on subsequent `- item` lines.
      currentList = [];
      continue;
    }
    if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1).trim();
      const list = inner.length === 0
        ? []
        : inner.split(",").map((s) => stripQuotes(s.trim())).filter((s) => s.length > 0);
      out.set(key, { raw: value, list });
      continue;
    }
    out.set(key, { raw: stripQuotes(value), list: null });
  }
  if (currentKey && currentList !== null) {
    out.set(currentKey, { raw: currentList.join(", "), list: currentList });
  }
  return out;
}

function stripQuotes(s: string): string {
  if (s.length >= 2) {
    const first = s.at(0);
    const last = s.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

function asBool(v: FrontmatterValue | undefined): boolean {
  if (!v) return false;
  return /^(true|yes|on|1)$/i.test(v.raw.trim());
}

function asNumber(v: FrontmatterValue | undefined, fallback: number): number {
  if (!v) return fallback;
  const n = Number(v.raw.trim());
  return Number.isFinite(n) ? n : fallback;
}

function asString(v: FrontmatterValue | undefined): string {
  if (!v) return "";
  return v.raw.trim();
}

function asStringOrNull(v: FrontmatterValue | undefined): string | null {
  if (!v) return null;
  const s = v.raw.trim();
  return s === "" || s.toLowerCase() === "null" ? null : s;
}

function asList(v: FrontmatterValue | undefined): ReadonlyArray<string> {
  if (!v) return [];
  if (v.list !== null) return v.list;
  // Single scalar — treat as one-element list when context expects array.
  return v.raw.trim().length === 0 ? [] : [v.raw.trim()];
}

function collectLinks(body: string): {
  readonly outgoing: ReadonlyArray<string>;
  readonly crossWiki: ReadonlyArray<{ wiki: string; slug: string }>;
} {
  const outgoing = new Set<string>();
  const crossWiki: Array<{ wiki: string; slug: string }> = [];

  // Cross-wiki links first (more specific syntax `[[wiki:slug]]`).
  for (const match of body.matchAll(CROSS_WIKI_RE)) {
    crossWiki.push({ wiki: match[1]!, slug: match[2]! });
  }
  // Plain wikilinks — skip ones containing `:` (already matched as cross-wiki).
  for (const match of body.matchAll(WIKILINK_RE)) {
    const target = match[1]!.trim();
    if (target.includes(":")) continue;
    if (SLUG_OK_RE.test(target)) outgoing.add(target);
  }
  return { outgoing: Array.from(outgoing), crossWiki };
}

/** Parse a single markdown page. Returns null for invalid filenames. */
export function parsePage(
  filename: string,
  content: string,
  mtimeMs: number,
): ParsedPage | null {
  const slug = slugFromFilename(filename);
  if (!slug) return null;
  const { fm, body } = splitFrontmatter(content);
  const front = parseFrontmatter(fm);
  const fileRefs = asList(front.get("file_refs")).map((entry) => ({
    path: entry,
    isDir: entry.endsWith("/"),
  }));
  const { outgoing, crossWiki } = collectLinks(body);
  return {
    slug,
    title: asString(front.get("title")) || prettifySlug(slug),
    summary: asString(front.get("summary")),
    topics: asList(front.get("topics")),
    fileRefs,
    updatedAt: asNumber(front.get("updated_at"), mtimeMs),
    archived: asBool(front.get("archived")),
    supersededBy: asStringOrNull(front.get("superseded_by")),
    body: body.trim(),
    outgoingLinks: outgoing,
    crossWikiLinks: crossWiki,
  };
}

function prettifySlug(slug: string): string {
  return slug
    .split("-")
    .map((part) => (part.length === 0 ? part : part[0]!.toUpperCase() + part.slice(1)))
    .join(" ");
}
