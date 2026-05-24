# Contributing

Praxis is a provider-neutral local app. Core modules should model projects, sessions, turns, approvals, file changes, checks, events, and dashboard projections without assuming any specific runtime provider.

## Setup

```sh
npm install
npm run verify
```

## Architecture Rules

- Core code imports provider interfaces, not provider implementations.
- Optional provider adapters live under `src/providers/<adapter-name>/`.
- The fake provider must remain enough to run core tests and UI smoke tests.
- Dashboard state is derived from events and reducers.
- Approval decisions are stored before they are forwarded to a provider.

## Pull Requests

Use small, reviewable changes with tests for behavior changes. Run `npm run verify` before requesting review.
