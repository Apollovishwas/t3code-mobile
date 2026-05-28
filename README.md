# T3 Code

T3 Code is a minimal web GUI for coding agents (currently Codex, Claude, and OpenCode, more coming soon).

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
