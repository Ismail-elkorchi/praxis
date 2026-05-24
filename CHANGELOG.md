# Changelog

## 0.1.0

- Added the initial provider-neutral domain model, provider interface, fake provider, and optional generic process adapter.
- Added append-only SQLite event storage, replayable projections, approval ordering, project registry, git status, check runs, diff handling, and redacted logging helpers.
- Added a provider-neutral dashboard shell with project cards, approval center, provider status, activity timeline, explain mode, and keyboard smoke tests.
- Added public verification scripts, CI, package metadata, and contributor-facing project files.

## Unreleased

- Continue production-depth implementation of the local runtime, persistence, API, UI integration, settings, and extension surfaces.
- Added the complete provider-neutral API method surface and a plugin registry that emits commands instead of mutating core state directly.
- Persisted SQLite read models for projects, providers, provider capabilities, sessions, turns, approvals, checks, git snapshots, provider refs, and redacted event payload audit copies.
- Persisted app settings across SQLite-backed restarts and made worktree creation emit provider-neutral domain events.
- Persisted derived dashboard propositions into SQLite after append and replay so explanation evidence is durable.
- Made provider status/capability API calls targeted and made availability checks emit normalized provider status events with WebSocket pushes.
- Wired event query filters through the API for project, provider, session, and event-type activity views.
- Projected provider command-run events into first-class project state with replay coverage.
- Added provider-neutral Activity timeline filters for project, provider, session, and event type.
- Added provider-neutral project settings for default provider, default checks, worktree mode, auto-refresh, and dashboard visibility, with restart restore coverage.
- Added a fake-provider user-input workflow, waiting-for-user-input projection, and ordered user-input response persistence before provider continuation.
- Derived local WebSocket push channels from newly appended domain events so approval, provider, check, git, project, and agent updates reach subscribed clients consistently.
- Added provider-neutral observability diagnostics for provider logs, event logs, projection/proposition/safety inspectors, replay health, redaction, and runtime timing metrics.
- Made enabled plugin risk-rule contributions inspectable through safety diagnostics and removed from diagnostics when disabled.
- Added provider adapter contract validation for plugin-contributed adapters before plugin enablement.
- Prevented provider-sourced approval resolution events from bypassing stored app-level approval decisions.
