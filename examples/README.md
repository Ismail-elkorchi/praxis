# Praxis Examples

These examples exercise Praxis with the built-in fake provider only. They do not require a real provider account, external agent runtime, API key, or network service.

## Fake Provider Workflow

Run the provider-neutral workflow example from a source checkout:

```sh
npx tsx examples/fake-provider-workflow.ts
```

The example creates a temporary project, registers it, starts an agent session through the fake provider, sends a turn, records an approval decision, and prints a compact JSON summary of the resulting dashboard state.

The output is intentionally provider-neutral: it uses project, provider, session, turn, approval, command, check, and event concepts without depending on any real provider adapter.
