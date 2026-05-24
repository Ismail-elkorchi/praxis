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
