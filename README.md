# T3 Code — mobile-first fork

This is a personal fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code) tuned for driving Claude Code from a phone or tablet over [Tailscale](https://tailscale.com). It carries everything in upstream plus:

- **PWA install** — add to home screen on iOS / Android.
- **Per-project Kanban board** at `/board` — read-only UI; Claude is the only mutator.
- **Per-project Wiki** at `/wiki` — living markdown docs at `<repo>/.t3/wiki/` that Claude maintains during normal chat. No API key, no separate billing. Browseable + searchable from the phone.
- **Scheduled automations** — server-side cron-ish triggers that fire prompts into existing threads.
- **Quick-action chips** in the composer for one-tap mobile replies.
- **Web Push notifications** when an agent turn completes or needs review.
- **Composer mascot** because why not.
- Lots of mobile-keyboard, scroll-jump, and reconnection fixes.

## Quickstart — clone & run (from source)

You'll be hacking on the code; this is the dev path. If you just want to *use* T3 Code, the upstream `npx t3` works fine.

### Prerequisites

- **Node ≥ 22.16** (uses built-in `node:sqlite`)
- **Bun ≥ 1.3** — required, but only for installing deps and running build scripts. The actual T3 server runs on Node. Install once with:
  ```bash
  curl -fsSL https://bun.sh/install | bash    # macOS / Linux
  # or:
  npm install -g bun                          # any machine with npm
  # or on Windows:
  powershell -c "irm bun.sh/install.ps1 | iex"
  ```
  Then `exec $SHELL` (or open a new terminal) and verify with `bun --version`.

  > **Why Bun and not npm?** The workspace uses Bun's `catalog:` protocol in 5+ package.json files to pin shared versions in one place. `npm install` fails with `Unsupported URL Type 'catalog:'` because npm doesn't speak that protocol yet.
- **One coding-agent CLI** authenticated on this host:
  - Claude Code — `npm i -g @anthropic-ai/claude-code` then `claude` (use `/login`)
  - or Codex — install [Codex CLI](https://developers.openai.com/codex/cli) and `codex login`
  - or OpenCode — install [OpenCode](https://opencode.ai) and `opencode auth login`
- macOS or Linux. Windows works for the server but I don't dogfood it.

### Copy-paste setup (zero to running)

```bash
# 1. Install Bun if you don't have it
curl -fsSL https://bun.sh/install | bash && exec $SHELL

# 2. Clone + install deps
git clone https://github.com/Apollovishwas/t3code-mobile.git
cd t3code-mobile
bun install

# 3. Make sure at least one agent CLI is logged in (browser opens once)
npm i -g @anthropic-ai/claude-code
claude   # type /login, then Ctrl+C once you see "Logged in as …"

# 4. Build
bun run --filter @t3tools/web build
bun run --filter @t3tools/server build

# 5. Start the server (leave this terminal running)
node apps/server/dist/bin.mjs start \
  --base-dir ~/.t3 --port 3773 --host 127.0.0.1 --no-browser
# Watch for the "Open http://localhost:3773/pair#token=…" line; hit it once.

# 6. (second terminal) Get reachable from your phone
node apps/server/dist/bin.mjs setup-mobile
```

That's everything end-to-end. The rest of this section breaks down each step in case you need to deviate.

### Clone + install

```bash
git clone https://github.com/Apollovishwas/t3code-mobile.git
cd t3code-mobile
bun install
```

### Run the server (dev mode — hot reload)

```bash
# From repo root: builds the web bundle once, then starts the server with watch.
bun run --filter @t3tools/server dev
```

Open `http://localhost:3773` — first run prints a one-time pairing URL like:

```
Open http://localhost:3773/pair#token=ABCD1234EFGH in your browser.
```

Visit that URL once from the browser you'll use; the session cookie is stored and you can ditch the token.

### Build & run a production bundle

```bash
# One-shot build (web bundle → server dist).
bun run --filter @t3tools/web build
bun run --filter @t3tools/server build

# Run the bundled server.
node apps/server/dist/bin.mjs start \
  --base-dir ~/.t3 \
  --port 3773 \
  --host 127.0.0.1 \
  --no-browser
```

State (SQLite, secrets, logs) lives under `~/.t3/userdata/`. A pre-migration backup of `state.sqlite` is automatically written beside the live DB before each migration.

### Mobile access via Tailscale (the whole point)

Run the guided walkthrough — it detects the Tailscale CLI, prompts you through login, confirms MagicDNS, sets up `tailscale serve`, probes the URL, and prints the address ready for your phone:

```bash
node apps/server/dist/bin.mjs setup-mobile
```

Step-by-step output looks like:

```
T3 Code — mobile setup walkthrough
===================================

1. Checking for the Tailscale CLI…
   ✓ Tailscale CLI found.

2. Checking Tailscale login state…
   ✓ Logged in.

3. Checking MagicDNS…
   ✓ MagicDNS name: my-laptop.tail-scales.ts.net

4. Setting up tailscale serve --https=443 → http://127.0.0.1:3773
   ✓ Serve is up.

5. Probing the HTTPS endpoint…
   ✓ Reachable at https://my-laptop.tail-scales.ts.net

📱 Open this URL on your phone (same tailnet):
   https://my-laptop.tail-scales.ts.net

Next:
  1. Visit the pairing URL printed by `t3 start` once.
  2. Add to home screen for the PWA.
  3. Tear down later with: tailscale serve --https=443 off
```

Each step is idempotent — if any check fails the command prints the exact next command to run (install one-liner / `tailscale up` / the admin URL for MagicDNS) and exits. Re-run after fixing.

Flags:

```bash
node apps/server/dist/bin.mjs setup-mobile \
  --port 3773 \          # local T3 port (default 3773)
  --host 127.0.0.1 \     # local interface (default 127.0.0.1)
  --https-port 443 \     # Tailscale HTTPS port (default 443)
  --skip-probe           # skip the final reachability check
```

### Health check

```bash
curl http://127.0.0.1:3773/health
# {"status":"ok","package":"t3","version":"0.0.24","uptimeSeconds":42,"dbMigrationHead":33,"nodeVersion":"v22.22.0"}
```

### Diagnostics

```bash
node apps/server/dist/bin.mjs diagnose --tail-log-lines 50
```

Prints a copy-pasteable markdown block with version / runtime / migration head / last log lines. Useful when something's off and you want to share state without copying twelve files.

---

## Upstream README continues below

## Installation

> [!WARNING]
> T3 Code currently supports Codex, Claude, and OpenCode.
> Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`

### Run without installing

```bash
npx t3
```

### Desktop app

Install the latest version of the desktop app from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), or from your favorite package registry:

#### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

#### Arch Linux (AUR)

```bash
yay -S t3code-bin
```

## Configuration

`t3` resolves its settings in this precedence order (top wins):

1. **Command-line flags** — e.g., `t3 start --port 4000 --base-dir ~/my-t3`. Run `t3 --help` for the full list.
2. **Environment variables** —
   - `T3_DISABLE_UPDATE_CHECK=1` skips the once-per-startup npm registry version probe (useful for air-gapped installs).
   - Other config knobs are surfaced as CLI flags first; envs are added on demand.
3. **State directory contents** under `<base-dir>` (default `~/.t3/`):
   - `state.sqlite` — projection + projection cache. Backed up before each migration as `state.sqlite.backup-<timestamp>`.
   - `secrets/push-vapid.json` — Web Push VAPID keypair (auto-generated on first run, `chmod 600`-equivalent).
   - `settings.json`, `keybindings.json` — UI settings.
   - `logs/` — log files used by `t3 diagnose`.
4. **Built-in defaults** — sensible localhost-only values designed for a single-user self-hosted install.

If you're stuck, `t3 diagnose --state-dir ~/.t3` prints a copy-pasteable diagnostic block (version, runtime, migration head, log tail). Paste it into an issue if anything looks wrong.

`GET /health` (unauthenticated) returns `{status, version, uptimeSeconds, dbMigrationHead, nodeVersion}` — handy for Tailscale serve / systemd / container liveness probes.

## Some notes

We are very very early in this project. Expect bugs.

We are not accepting contributions yet.

Observability guide: [docs/observability.md](./docs/observability.md)

## If you REALLY want to contribute still.... read this first

Before local development, prepare the environment and install dependencies:

```bash
# Optional: only needed if you use mise for dev tool management.
mise install
bun install .
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or PR.

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
