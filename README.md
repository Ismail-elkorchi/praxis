# Praxis

Praxis is a local-first control plane for coordinating agent work across software projects. It treats projects, events, approvals, checks, diffs, and review readiness as durable product state while keeping runtime providers replaceable behind adapters.

The core app runs with the built-in fake provider, so development and tests do not require any real provider account, binary, API key, or network service.

## Status

Praxis is an early implementation. The current focus is the provider-neutral core, fake-provider workflow, replayable event state, approval safety, project checks, and a dashboard built from evidence-backed projections.

## Quickstart

```sh
npm install
npm run verify
npm run dev
```

The development server opens the provider-neutral dashboard with fake-provider data available for local workflows and tests.

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

The API method names are provider-neutral and cover project registry, provider
status, agent sessions and turns, approvals, dashboard snapshots, checks, git
diff/worktree actions, and event replay/query.

## Core Guarantees

- Core modules use provider-neutral domain types.
- Provider adapters live behind a stable interface.
- The app starts and passes tests with the fake provider only.
- Dashboard state is derived from domain events and can be replayed.
- Approval decisions are persisted before they are forwarded to providers.
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
src/dashboard   reducers, projections, explanations, view models
src/projects    project registry and discovery
src/policies    approval and risk policy
src/git         git status and diff services
src/checks      local check definitions and runs
src/app         application services and composition
src/ui          provider-neutral React UI
src/server      local API and WebSocket server
src/plugins     extension registry for inspectable contributions
```
