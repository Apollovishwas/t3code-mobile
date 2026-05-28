/**
 * Per-deploy build identifier surfaced as a tiny chip in the sidebar
 * footer. The value comes from the `BUILD_ID` env var injected at
 * build time by `vite.config.ts`; an empty value means a local dev
 * run, in which case the badge collapses to nothing.
 *
 * The number itself is maintained by the deploy workflow — a counter
 * file at `~/.claude/projects/-home-claude-Documents-t3code/.build-counter`
 * that increments on every `bun run build`. Useful for confirming a
 * fresh bundle is loaded on a phone where devtools aren't handy.
 */

const buildId: string = import.meta.env.BUILD_ID ?? "";

export function BuildBadge() {
  if (!buildId) return null;
  return (
    <span
      className="select-none rounded-full bg-muted/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground/80"
      title={`Build ${buildId}`}
    >
      B{buildId}
    </span>
  );
}
