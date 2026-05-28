import { useMemo } from "react";
import ChatMarkdown from "./ChatMarkdown";

/**
 * In-app preview of a file's *after-edit* content, used as an alternative
 * to the line-by-line diff inside `DiffPanel`. Only files whose extension
 * we know how to render get a Preview toggle (markdown, html, svg, plain
 * text). Image and binary previews would require fetching the file from
 * disk via a server endpoint — out of scope for v1.
 *
 * The content fed in is reconstructed from the unified-diff patch (see
 * `extractAfterContentFromPatch`). For files newly created by the agent
 * (Write tool) this is the full file. For partial edits (Edit tool) it's
 * the changed hunks only, which still gives a usable preview of "what
 * does the new section look like rendered?"
 */

export type FilePreviewKind = "markdown" | "html" | "svg" | "text";

const MARKDOWN_EXTS = new Set(["md", "markdown", "mdx"]);
const HTML_EXTS = new Set(["html", "htm"]);
const SVG_EXTS = new Set(["svg"]);
const TEXT_EXTS = new Set([
  "txt",
  "log",
  "json",
  "yaml",
  "yml",
  "toml",
  "ini",
  "env",
  "csv",
  "tsv",
]);

export function getPreviewKind(filePath: string): FilePreviewKind | null {
  const ext = filePath.split(".").pop()?.toLowerCase();
  if (!ext) return null;
  if (MARKDOWN_EXTS.has(ext)) return "markdown";
  if (HTML_EXTS.has(ext)) return "html";
  if (SVG_EXTS.has(ext)) return "svg";
  if (TEXT_EXTS.has(ext)) return "text";
  return null;
}

/**
 * Walk a unified-diff patch and reconstruct the after-edit content for the
 * given file path. Includes added lines AND context lines; drops deleted
 * lines and metadata. Returns `null` if the file isn't found in the patch.
 */
export function extractAfterContentFromPatch(
  patch: string,
  targetFilePath: string,
): string | null {
  if (!patch) return null;
  const lines = patch.split("\n");
  let inTargetFile = false;
  let inHunk = false;
  const out: string[] = [];
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      // `diff --git a/<path> b/<path>` — second path is the new (post-edit) name.
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      const newPath = match?.[2];
      const stripped = newPath?.startsWith("b/") ? newPath.slice(2) : newPath;
      inTargetFile = newPath === targetFilePath || stripped === targetFilePath;
      inHunk = false;
      continue;
    }
    if (!inTargetFile) continue;
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      // diff file headers — skip
      continue;
    }
    if (line.startsWith("@@")) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith("+")) {
      out.push(line.slice(1));
    } else if (line.startsWith(" ")) {
      out.push(line.slice(1));
    } else if (line.startsWith("-")) {
      continue;
    } else if (line.startsWith("\\")) {
      // "\ No newline at end of file" — informational, skip
      continue;
    } else if (line === "") {
      // Defensive: producers sometimes drop the leading space on blank
      // context lines. Treat empty lines inside a hunk as blank context.
      out.push("");
    }
  }
  return out.length > 0 ? out.join("\n") : null;
}

/**
 * Wraps embedded HTML / SVG content in a sandboxed iframe so the diff
 * preview can never run scripts or navigate. The `sandbox` attribute set
 * to the empty string drops every permission including same-origin and
 * script execution.
 */
function SandboxedHtmlPreview({
  html,
  title,
}: {
  readonly html: string;
  readonly title: string;
}) {
  // A tiny stylesheet keeps the preview legible on the dark theme too —
  // we can't reach into the iframe's stylesheets from outside, so we
  // inject one. Pixel art / SVG content is centered.
  const srcDoc = useMemo(
    () =>
      `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
        html, body { margin: 0; padding: 12px; background: white; color: #111;
          font-family: -apple-system, BlinkMacSystemFont, sans-serif;
          font-size: 13px; line-height: 1.45; }
        svg { display: block; max-width: 100%; height: auto; margin: 0 auto; }
        img { max-width: 100%; height: auto; }
      </style></head><body>${html}</body></html>`,
    [html],
  );
  return (
    <iframe
      srcDoc={srcDoc}
      sandbox=""
      title={title}
      className="block h-[60vh] w-full rounded-md border border-border bg-white"
    />
  );
}

interface FilePreviewPaneProps {
  readonly filePath: string;
  readonly afterContent: string;
  readonly cwd: string | undefined;
}

export function FilePreviewPane({ filePath, afterContent, cwd }: FilePreviewPaneProps) {
  const kind = getPreviewKind(filePath);
  if (!kind) return null;
  switch (kind) {
    case "markdown":
      return (
        <div className="rounded-md border border-border bg-card p-3 text-sm">
          <ChatMarkdown text={afterContent} cwd={cwd} />
        </div>
      );
    case "html":
      return <SandboxedHtmlPreview html={afterContent} title={filePath} />;
    case "svg":
      // Wrap SVG content in minimal HTML so the iframe centers it nicely.
      return <SandboxedHtmlPreview html={afterContent} title={filePath} />;
    case "text":
      return (
        <pre className="overflow-auto rounded-md border border-border bg-card p-3 text-xs font-mono whitespace-pre-wrap break-words">
          {afterContent}
        </pre>
      );
  }
}
