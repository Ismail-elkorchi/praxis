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
- Required explicit confirmation for broad permission profile changes and surfaced confirmed full-access profiles as unsafe attention.
- Added durable project discovery metadata for package manager, scripts, metadata files, worktree refs, and refreshed check definitions.
- Added a local runtime host for SQLite startup, provider availability checks, local server launch, restart restore, and coordinated shutdown.
- Added a provider-neutral command palette with global search shortcut and API-method command mappings.
- Hardened provider-neutral UI interactions with risky approval confirmation, approval/project keyboard navigation, modal focus trapping, and action method mappings.
- Elevated outside-workspace file change approvals into unsafe attention with visible risk badges and replay coverage.
- Hardened git diff classification for created, modified, deleted, renamed, untracked, binary, and non-git project cases.
- Added searchable provider-neutral diff review UI with source session/turn details, rename display, and binary metadata handling.
- Added dashboard check-run view models and Checks UI for active/recent runs, commands, durations, exit codes, output, and failed-file triage links.
- Hardened the activity timeline with turn grouping, lazy details expansion, event-kind coverage, and hidden raw provider payloads.
- Expanded provider status cards with availability, compatibility, capability support details, and provider-neutral actions.
- Wired project-card evidence actions to the detail panel with proposition and evidence-reference display.
- Added provider-neutral settings API/UI coverage with raw-provider-log confirmation and provider settings kept under Providers.
- Changed compact and medium layouts to keep approvals visible while rendering Details as a responsive drawer.
- Added provider-neutral diagnostics API and a Settings debug-export preview covering logs, inspectors, metrics, and replay health.
- Added shipped public examples for fake-provider onboarding and release-hardening tests that execute the example surface.
- Added unclean-runtime restart recovery, unknown event-version audit handling, and provider process crash tests.
- Added reduced-motion and color-independent project-state accessibility smoke tests, plus Node 24 CI action hardening.
- Added control-plane normalization for thrown provider turn crashes into provider error, failed turn, and stale session events.
- Required git-backed dirty state for review-ready and diff-review project states, while keeping non-git projects out of git-based review modes.
- Added explicit reviewed-state marking for review-ready projects, with ready-to-merge projection, persisted evidence, API/UI wiring, and stale-mark invalidation when git status changes.
- Added explicit required-check waivers, selected-provider capability gating for project actions, and acceptance coverage for declined approvals, pending-approval review blockers, conflicted git state, and out-of-date ready-to-merge confirmation.
- Added capability-gated provider session import so providers that support import can map external sessions to internal sessions without exposing provider-owned identifiers as core primary keys.
