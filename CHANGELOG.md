# Changelog

All notable changes to the `t3` package will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Until `1.0.0` we may make breaking changes in any `0.x.y` release — see
[Versioning policy](#versioning-policy) at the bottom of this file.

## [Unreleased]

### Added

- Scheduled automations: per-project recurring triggers that dispatch
  prompts into existing threads on a schedule.
- Per-project Kanban board with read-only mobile UI and direct mutations
  via Claude in any thread. Includes auto-bind of creating thread,
  schedule integration, `Run now`, mark done / needs-review, and a
  Recently Done section in the Today view.
- Composer enhancements: quick-action chips, prompt queueing across the
  agent's running turns, in-app preview pane for diff viewer.
- Granular push notification categories: agent-finished, task-completed,
  approval-needed, question-for-you, plan-ready.
- Working mascot during agent processing (pixel-art Push sprite +
  Idle/Walk/Run/Jump/Climb/Attack/Throw/Hurt action sprites; per-thread
  action chosen from the live activity stream).
- Build counter chip in the sidebar footer (`Bn`) for verifying which
  bundle is loaded on a phone.
- `.t3/board.md` always-on snapshot export of the per-project Kanban
  board into the user's workspace.

### Fixed

- Composer ↔ mascot transition is now coordinated (300ms max-height +
  opacity crossfade) instead of three independent animations colliding.
- "Waiting" indicator no longer flickers between send-ack and turn-start;
  a `pendingTurnStart` bridge keeps the working state continuous.
- Card detail page can no longer overflow the viewport left edge
  (`overflow-x-hidden` + `min-w-0` on action button labels).
- Card tap correctly navigates to detail — was hitting a TanStack Router
  nesting bug where `/board` lacked an `<Outlet />` for child routes.
  Resolved by renaming the route to use the flat-route `_` convention.

## [0.0.24] – 2026-05

### Added

- Initial public release of `t3` on npm.
- Web + PWA front-end, Effect-based server, Claude Agent SDK + OpenCode
  + Codex provider drivers.
- Tailscale-friendly self-hosted deployment.
- SQLite persistence with automatic schema migrations up to
  `032_Automations`.

## Versioning policy

While the package is in the `0.x.y` range:

- **MINOR (`0.x`) bumps may include breaking changes**, including data
  model migrations, command-line flags being renamed, and protocol
  changes between the server and the bundled web client.
- **PATCH (`0.x.y`) bumps are bug-fix only** and should be safe to apply
  to a running install. Schema migrations included in PATCH releases
  must be auto-applied without user intervention and must be
  forward-compatible with the previous PATCH.

On reaching `1.0.0` we will commit to standard semver semantics.

[Unreleased]: https://github.com/pingdotgg/t3code/compare/v0.0.24...HEAD
[0.0.24]: https://github.com/pingdotgg/t3code/releases/tag/v0.0.24
