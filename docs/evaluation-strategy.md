# ACHFlow Evaluation Strategy

ACHFlow is evaluated primarily through deterministic and PostgreSQL-backed
integration tests. The payment system has no LLM interface, so model/tool-use
evaluations are explicitly deferred rather than simulated.

## Deterministic evaluations

| Area          | Invariant evaluated                                                                                                                                                              | Existing coverage                      |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Lifecycle     | A valid received payment reaches `VALIDATED`; business failures reach `VALIDATION_FAILED`; export marks eligible payments `SUBMITTED`; settled reservations return exactly once. | Worker PostgreSQL integration suite    |
| Reservations  | One payment has one reservation; active holds reduce only the selected funding account; released/settled holds no longer reduce availability.                                    | Worker PostgreSQL integration suite    |
| Ledger        | Deterministic entry keys prevent duplicate financial entries; posted balance uses the implemented positive/negative entry semantics.                                             | Worker PostgreSQL integration suite    |
| NACHA         | Each record is 94 characters; record types, transaction codes, routing prefixes, amounts, control totals, block count, hash, and SHA-256 are deterministic.                      | NACHA generator integration evaluation |
| API contracts | Creation returns `201`, an identical idempotent replay returns `200`, conflicting reuse returns `409`, and protected resources use the expected `401`/`404` behavior.            | API PostgreSQL integration suite       |

Run:

```bash
pnpm eval:deterministic
```

## Consistency evaluations

The API suite evaluates 100 concurrent calls with the same merchant, payload,
and idempotency key. It requires one persisted payment, one idempotency record,
one received outbox event, no reservation, no ledger entry, and one identical
returned payment identity/timestamp across all calls.

The worker suite separately evaluates concurrent lifecycle calls, deterministic
ledger entry keys, and repeated outbox processing. This exercises PostgreSQL
unique constraints and advisory-lock paths rather than relying on in-memory
locking.

Run the PostgreSQL-backed consistency evaluation with:

```bash
pnpm eval:consistency
```

The API accepts arbitrary non-empty client idempotency keys; ACHFlow does not
impose a UUID or vendor-specific key format. The key is uniquely scoped by
merchant. The same raw key can therefore be used by separate merchants, while
an identical request under one merchant returns its original payment and a
different payload under that scope returns `409 Conflict`.

## Red-team evaluations

| Threat                                  | Expected result                                                                                                                                             | Coverage                                           |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Merchant enumeration                    | Another merchant receives `404` for a payment it does not own.                                                                                              | API integration: cross-merchant payment access     |
| Missing/invalid merchant authentication | Requests receive `401`.                                                                                                                                     | API integration: payment access guard              |
| Rate-limit bypass across merchants      | A limited merchant receives `429` with `Retry-After`; another merchant remains unaffected.                                                                  | API integration: distributed Redis rate-limit test |
| Duplicate financial effect              | Concurrent idempotency, reservation uniqueness, deterministic ledger keys, and lifecycle replay tests retain exactly one financial record.                  | API and worker PostgreSQL integration suites       |
| Webhook signature tampering             | Delivery signing uses `v1=<hex HMAC-SHA256>` over `timestamp.rawBody`; the integration test recomputes this exact value with the persisted endpoint secret. | Worker webhook-delivery integration test           |
| Webhook secret disclosure               | Endpoint secrets are AES-256-GCM encrypted at rest and decrypt only through the crypto service; plaintext is not persisted.                                 | API integration test                               |

## Regression practice

Canonical, normalized contracts live in `evals/fixtures/regression/`. They
describe stable response, ledger, and fixed-width NACHA expectations without
including generated IDs, timestamps, account references, or secrets. The
runner writes a readable local report to `evals/results/latest.json` and
`evals/results/latest.md`; generated reports are intentionally ignored by Git.

Run all executable evaluation categories after code changes:

```bash
pnpm eval
```

Individual categories are also available as `pnpm eval:deterministic`,
`pnpm eval:consistency`, `pnpm eval:regex`, `pnpm eval:red-team`, and
`pnpm eval:regression`.

The live portal evidence is separately reproducible with:

```bash
pnpm --filter web demo:capture
```

## Deferred model and tool-use evaluations

ACHFlow currently has no natural-language operations layer. Do not add model
evaluations until such a layer exists. If one is introduced, evaluate it against
a curated set of merchant-scoped intents and verify that it calls only the
correct read APIs, sends valid filter values, preserves merchant scope, and
never exposes secrets or uses write operations without explicit confirmation.
