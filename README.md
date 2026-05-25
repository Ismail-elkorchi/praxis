# Praxis

Praxis is a local-first control plane for coordinating agent work inside durable project workspaces. It treats projects, sources, work items, agent runs, artifacts, events, approvals, checks, diffs, and review readiness as durable product state while keeping runtime providers replaceable behind adapters.

The core app runs with the built-in fake provider, so development and tests do not require any real provider account, binary, API key, or network service.

The local runtime auto-registers the optional Codex app-server adapter when it starts. The adapter lives under `src/providers/codex-app-server/`, uses stdio JSONL, reports availability through `codex --version`, and keeps external thread and turn identifiers inside provider references, adapter-local state, redacted diagnostics, or raw provider events. Codex is not the default provider; if the binary is missing, Praxis still starts and reports the provider as unavailable. Set `CODEX_BIN` to use a non-default binary path.

## Status

Praxis is an early implementation. The current focus is the provider-neutral core, fake-provider workflow, replayable event state, approval safety, project workspaces, project checks, and a dashboard built from evidence-backed projections.

## Quickstart

```sh
npm install
npm run verify
npm run dev
```

The development server opens the provider-neutral project cockpit with fake-provider data available for local workflows and tests.

To run a provider-neutral workflow from the command line with the built-in fake provider:

```sh
npx tsx examples/fake-provider-workflow.ts
```

To run the local app server against the production build:

```sh
npm run build
npm run server
```

The local server exposes:

- `GET /health`
- `POST /api`
- `WS /ws`
- static UI assets from `dist/`

The API method names are provider-neutral and cover project registry, project
workspace reads, project profile facets, sources, work items, agent runs,
artifacts, provider status, provider runtime sessions and turns, approvals,
dashboard snapshots, checks, git diff/worktree actions, and event replay/query.

## Core Guarantees

- Core modules use provider-neutral domain types.
- Project is the primary visible object; provider sessions and turns are runtime details.
- Projects use extensible profile facets instead of a fixed project-kind enum.
- Provider adapters live behind a stable interface.
- The app starts and passes tests with the fake provider only.
- Real provider adapters are optional, must not be imported by core-facing modules, and must not become the default provider automatically.
- Dashboard state is derived from domain events and can be replayed.
- Approval decisions are persisted before they are forwarded to providers.
- Approval decisions are routed by the approval's provider id, not by dashboard order.
- Unsupported provider capabilities are hidden or blocked safely.

## Development Commands

```sh
npm run typecheck
npm run test
npm run test:ui
npm run build
npm run verify
```

## Project Shape

```txt
src/core        durable provider-neutral domain types
src/providers   provider interface, fake provider, optional adapters
src/events      append-only event storage and replay
src/dashboard   reducers, Home and Project Workspace projections, explanations, view models
src/projects    project registry and discovery
src/policies    approval and risk policy
src/git         git status and diff services
src/checks      local check definitions and runs
src/app         application services and composition
src/ui          provider-neutral React UI
src/server      local API and WebSocket server
src/plugins     extension registry for inspectable contributions
```
