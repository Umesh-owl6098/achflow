# ACHFlow Live Demo Script

This is a practical speaking guide for demonstrating the running local ACHFlow
application. It reflects the repository as implemented: ACHFlow has an
append-only internal financial audit ledger and funding-balance calculation; it
does **not** claim to be a complete general-purpose double-entry accounting
system.

## 1. Demo objective

Show that ACHFlow processes real local ACH debit and credit requests through
merchant-scoped authentication, idempotent creation, validation, credit-funding
reservations, lifecycle state, ledger audit entries, transactional outbox work,
NACHA export, webhooks, merchant administration, health reporting, and the
local transaction simulator.

## 2. Demo duration

### Quick demo — 5–7 minutes

| Time      | Section                         |
| --------- | ------------------------------- |
| 0:00–0:45 | Opening and architecture        |
| 0:45–1:30 | Dashboard and health            |
| 1:30–3:15 | Payments and one payment detail |
| 3:15–4:15 | Ledger and funding reservation  |
| 4:15–5:15 | NACHA and webhooks              |
| 5:15–6:30 | Merchants, simulator, close     |

### Full demo — 15–20 minutes

| Time        | Section                                  |
| ----------- | ---------------------------------------- |
| 0:00–1:00   | Opening and architecture                 |
| 1:00–3:00   | Dashboard and system health              |
| 3:00–6:00   | Merchant administration and isolation    |
| 6:00–10:00  | Payments, lifecycle, idempotency, ledger |
| 10:00–12:00 | NACHA files and submission state         |
| 12:00–14:00 | Webhook endpoints and delivery state     |
| 14:00–17:00 | Transaction simulator and run history    |
| 17:00–20:00 | Reliability, security, limitations, Q&A  |

## 3. Pre-demo checklist

Run only safe checks from the repository root.

```bash
lsof -nP -iTCP:3001 -sTCP:LISTEN
lsof -nP -iTCP:3000 -sTCP:LISTEN
curl -I http://localhost:3001
curl -I http://localhost:3000
pnpm --filter api exec prisma migrate status
```

Start missing services in separate terminals:

```bash
pnpm --filter api start:dev
pnpm --filter worker start:dev
pnpm web:dev
```

Before sharing the screen, confirm:

- PostgreSQL and Redis are running through the repository Compose setup.
- The API listens on port 3000 and the web portal on port 3001.
- Migrations report current.
- An active demo merchant and payment records exist.
- A webhook receiver is running only if you will show an actual delivery attempt.
- No terminal, browser tab, or form shows raw API keys, connection strings, or
  signing secrets.

> Do not delete `apps/web/.next` while Next.js is running. Do not run a web
> production build while `next dev` is using that same `.next` directory.

Fallback evidence is available in [working-demo.md](./working-demo.md).

## 4. Opening statement

> “ACHFlow is a local ACH payments platform. The point of the demo is not just
> creating a payment: it is showing how an authenticated request moves through
> validation, credit-funding controls, durable background work, NACHA export,
> and operational visibility. The system uses PostgreSQL as the transactional
> source of truth, and the portal is reading live data through a server-side
> BFF rather than exposing control-plane credentials to the browser.”

## 5. High-level architecture

**Open:** [architecture.md](./architecture.md)

**Say (under one minute):**

> “The browser talks to the Next.js operations portal. Its server-side BFF
> calls the NestJS API. PostgreSQL holds payment, funding, ledger, outbox, and
> operational state. Redis is used for the distributed payment API rate limiter
> and health checks; it is not the durable queue. The worker claims durable
> outbox records and performs asynchronous validation and provider work. This
> keeps a committed payment update and its follow-up event recoverable.”

**Point out:** PostgreSQL is the source of truth, the BFF keeps the admin key
server-side, and worker health is honestly `UNKNOWN` until a persisted heartbeat
exists.

## 6. Dashboard walkthrough

**Open:** `http://localhost:3001/`

| Action                                        | Say                                                                                                                   | Expected result                                                      |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Open Dashboard                                | “This is the operating view: it summarizes payments and recent activity from live portal data.”                       | Dashboard cards, status distribution, and operational sections load. |
| Point to status/metric cards                  | “These are operational views, not manually edited counters.”                                                          | Live values match current local records.                             |
| Use the health fallback in Settings if needed | “The status endpoint separately reports API, database, Redis, outbox backlog, pending deliveries, and worker status.” | No raw environment values appear.                                    |

Screenshot fallback: [dashboard](./demo-screenshots/01-dashboard.png).

## 7. Merchant management walkthrough

**Open:** `http://localhost:3001/merchants`

| Action                             | Say                                                                                                                                  | Expected result                                          |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| Search or filter the merchant list | “This is a separate admin control plane, not the merchant payment API.”                                                              | Active, suspended, and closed merchant state is visible. |
| Open a merchant row                | “The drawer combines funding summary, processed volume, status breakdown, recent payments, webhook endpoints, and API-key metadata.” | Existing raw API key is never displayed.                 |
| Point to balances                  | “Available funding is based on qualifying posted ledger balance less active reservations.”                                           | Funding summary is read-only operational data.           |
| Explain controls                   | “Suspend, disable, and rotate require confirmation.”                                                                                 | Buttons are visible but do not need to be used.          |

**Safe fallback:** do not mutate a shared demo merchant. Explain that rotation
returns a raw merchant key once only, then persists only its HMAC hash. Show the
metadata sentence instead.

Screenshots: [list](./demo-screenshots/11-merchants-list.png) and
[details](./demo-screenshots/12-merchant-details.png).

## 8. Payments walkthrough

**Open:** `http://localhost:3001/payments`

**Action:** show debit and credit rows, use the search/filter controls, then
open one real payment.

**Say:**

> “Payments are merchant-owned records. Creation requires merchant
> authentication and an `Idempotency-Key`. Replaying the same request/key
> returns the original payment; reusing the key with a different request
> conflicts. The details view brings together lifecycle, reservation when the
> payment is a credit, ledger audit entries, and outbox events.”

**Expected result:** payment list filtering and detail navigation work. The
details view shows the merchant, direction, amount, currency, timestamps, and
the persisted lifecycle state.

Screenshots: [list](./demo-screenshots/02-payments-list.png) and
[details](./demo-screenshots/03-payment-details-overview.png).

## 9. Payment lifecycle explanation

Use this precise model:

```text
RECEIVED
  → VALIDATED
  → [ACTIVE Reservation for ACH CREDIT]
  → SUBMITTED (during NACHA generation)
  → SETTLED

RECEIVED → VALIDATION_FAILED
SETTLED  → RETURNED
```

`RESERVED` is not a `PaymentStatus`; it is an active related `Reservation` and
a `PAYMENT_RESERVED` lifecycle event. ACH debits validate without a prefunded
funding reservation. ACH credits validate available prefunding and create a
single reservation and reservation audit entry.

**Say:**

> “The API durably accepts the request, the worker validates the received
> event, credit validation reserves available merchant funding, and NACHA
> generation marks eligible validated payments submitted. Settlement and return
> are explicit protected transitions. Deterministic ledger keys and database
> uniqueness make financial retries safe.”

## 10. Ledger walkthrough

**Open:** `http://localhost:3001/ledger`

| Action                    | Say                                                                                                                                                                                           | Expected result                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Filter or search an entry | “Each entry links to the payment and carries a deterministic entry key.”                                                                                                                      | Ledger table and filter controls update.                |
| Open an entry panel       | “Reservation and settlement entries are audit records. Posted balance is calculated from the implemented posted-entry types; active reservations are subtracted separately for availability.” | Detail panel shows payment linkage and balance context. |

> “ACHFlow does not rely solely on later bank reporting to decide whether an
> ACH credit can be initiated. It maintains a PostgreSQL-backed financial audit
> trail and calculates available prefunding as posted balance minus active
> holds. That prevents a second credit from consuming money already reserved.”

Screenshot: [ledger](./demo-screenshots/06-ledger.png).

## 11. NACHA Files walkthrough

**Open:** `http://localhost:3001/nacha-files`

**Action:** open a file row and show its details; optionally use the existing
download action.

**Say:**

> “NACHA generation groups eligible validated payments into generated files.
> The file record tracks totals, entry hash, checksum, payment relationship, and
> submission status. Generation marks exported payments `SUBMITTED` exactly
> once. ACHFlow generates and stores the file through its configured local
> storage abstraction; it does not claim direct production bank transport.”

**Fallback:** if there is no file, use
[the captured list](./demo-screenshots/07-nacha-files.png) and
[real detail dialog](./demo-screenshots/08-nacha-file-details.png).

## 12. Webhooks walkthrough

**Open:** `http://localhost:3001/webhooks`

### Endpoint management

**Action:** keep the **Endpoints** tab selected, show URL, active status, and
the endpoint/delivery controls.

**Say:**

> “A merchant signing secret is encrypted at rest with AES-256-GCM. The portal
> never reads it back. Endpoint configuration is merchant-scoped, and raw
> secrets are not exposed after creation.”

### Delivery events

**Action:** select **Delivery Events**, then open a real row.

**Say:**

> “Webhook delivery is persisted work. The processor claims a delivery before
> HTTP runs, records each completed attempt independently, returns retryable
> failures to `PENDING`, and leaves terminal `DELIVERED` or `FAILED` rows alone.
> The delivery detail includes payload, headers, response status, and attempts.”

Screenshots: [endpoints](./demo-screenshots/09-webhook-endpoints.png) and
[delivery detail](./demo-screenshots/10-webhook-delivery-events.png).

## 13. Settings and health walkthrough

**Open:** `http://localhost:3001/settings`

**Show:** API/database/Redis health, outbox backlog, pending webhook deliveries,
masked NACHA configuration, and environment-health flags.

**Say:**

> “Settings are intentionally read-only today: there is no persisted
> platform-settings model. Health returns no raw connection strings or secrets.
> API, database, and Redis are reported independently. Worker health is
> `UNKNOWN`, not falsely green, because the implementation has no persisted
> worker heartbeat.”

Screenshot: [settings](./demo-screenshots/13-settings-system-health.png).

## 14. Transaction simulator walkthrough

**Open:** `http://localhost:3001/simulator`

Use this safe supported configuration:

```text
Merchant: an active demo merchant
Direction: Mixed
Transactions: 10
TPS: 1
Minimum / maximum: small safe amounts
Success: 80%
Validation failure: 20%
All unavailable fault-injection percentages: 0%
```

The current scenario total includes **success**, **validation failure**,
**insufficient funds**, and **return**. Set unavailable scenario controls to
zero. Duplicate retry is implemented as an additional replay behavior, rather
than a weighted outcome.

| Action                                   | Say                                                                                                      | Expected result                              |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Select active merchant and configure run | “The simulator is local/development/test only, admin protected, and limited to 500 payments and 25 TPS.” | Start control becomes available.             |
| Confirm Start                            | “These are real payment API calls through `PaymentsService.create()`, not direct database inserts.”      | A persisted run starts.                      |
| Observe monitoring                       | “Generated, accepted, errors, latency, TPS, and recent generated payments are persisted run data.”       | Values update while a run is active.         |
| Open completed history item              | “The run history survives refresh and links to actual generated payments.”                               | Completed counts and recent payments appear. |

Do not claim automatic return, insufficient-funds, delayed-processing, or
webhook-failure injection. The UI labels those unavailable because safe test
hooks are not exposed.

Screenshots: [configuration](./demo-screenshots/14-simulator-configuration.png),
[completed](./demo-screenshots/16-simulator-completed.png), and
[history](./demo-screenshots/17-simulator-run-history.png).

## 15. Reliability explanation

### Idempotency

> “The merchant-scoped idempotency key prevents a retry from creating a second
> payment, outbox event, or financial effect. The first request persists a
> deterministic request fingerprint; a matching replay returns the original
> result, while different input for the same key returns a conflict.”

### Transactional outbox

> “The payment update and its outbox event commit in one PostgreSQL
> transaction. The worker claims and processes the event afterward, so a
> committed payment does not lose its follow-up work if the process crashes.”

### Worker and webhooks

> “The API handles synchronous authenticated requests. The worker handles
> persisted asynchronous work such as received-payment validation. Webhook
> deliveries have separate persisted attempts, retry timing, stale-claim
> recovery, and terminal states.”

## 16. Security explanation

**30-second version:**

> “Merchant keys authenticate merchant-scoped payment operations, and one
> merchant cannot enumerate another merchant’s payment. The operations portal
> uses a separate admin key only on the Next.js server-side BFF; the browser
> never receives it. Merchant keys are HMAC-hashed at rest, raw keys are
> returned only when initially created or rotated, webhook signing secrets are
> encrypted at rest, and the simulator is restricted to local, development, and
> test environments. Payment APIs are also Redis-rate-limited.”

## 17. Known limitations

- No persisted worker heartbeat; health reports worker status as `UNKNOWN`.
- Platform settings are read-only; there is no persisted platform-settings
  model.
- No direct production bank transport, bank callback adapter, or inbound return
  file parser.
- No safe automated injection for ACH returns, insufficient funds, delayed
  processing, or webhook failures in the simulator.
- ACH debit validation is supported, but the implemented settlement operation
  requires a reservation and therefore does not model an independent external
  debit settlement posting.

Frame these as explicit next steps, not hidden behavior.

## 18. Closing statement

> “The core proof here is that ACH processing is more than an endpoint that
> inserts a payment. ACHFlow protects against duplicate requests, validates
> merchant and funding rules, makes credit holds visible, uses durable outbox
> processing, generates NACHA files, records lifecycle audit entries, and gives
> operations a real portal to inspect the result. The local simulator uses that
> same payment path, so it exercises the system instead of displaying static
> demo data.”

## 19. Questions a reviewer may ask

1. **Why maintain an internal ledger?** ACH movement is asynchronous. ACHFlow
   uses immutable audit entries and active reservations to calculate available
   credit funding before later bank outcomes arrive. It is not presented as a
   complete general ledger.
2. **Why use one payment model for debit and credit?** Both share merchant,
   idempotency, validation, lifecycle events, and operational views. Credit
   adds funding-account and reservation requirements; debit does not.
3. **Why use an outbox?** Payment state and its event commit together. A worker
   can retry durable work after a crash without losing the event.
4. **How is idempotency enforced?** PostgreSQL enforces merchant/key uniqueness;
   a deterministic request fingerprint distinguishes matching replays from
   conflicts.
5. **What happens when Redis is unavailable?** The API rate-limiter dependency
   is unavailable and its health check reports unhealthy. Payment lifecycle
   source-of-truth state remains PostgreSQL, not Redis.
6. **How do you prevent cross-merchant access?** Merchant API authentication
   resolves the merchant, and payment lookups require the payment’s merchant ID
   to match. Cross-merchant payment access returns 404.
7. **Why use a BFF?** The admin key stays on the Next.js server. Browser code
   calls internal BFF routes rather than receiving a control-plane credential.
8. **How does API-key rotation work?** A new key is generated, its HMAC hash is
   stored, the prior active key is replaced, and the raw value is shown only in
   that create/rotate response.
9. **How do webhook retries work?** Deliveries have persisted claims, attempts,
   response/error state, retry timing, stale-claim recovery, and terminal
   `DELIVERED`/`FAILED` states.
10. **Why is the simulator restricted to development?** It creates real payment
    traffic through the normal service path and must not be an exposed
    production load-generation surface.
11. **How would you add bank callbacks and returns?** Add a bank adapter that
    authenticates inbound records, persists an idempotent bank event, then uses
    the existing submitted-to-settled and settled-to-returned lifecycle methods.
12. **What would change before production?** Add an identity provider/RBAC,
    managed secret storage and key rotation, worker heartbeat/observability,
    bank transport and reconciliation adapters, stronger operational alerting,
    and production deployment controls.

## 20. Demo recovery guide

### Port 3001 already in use

```bash
lsof -nP -iTCP:3001 -sTCP:LISTEN
```

Reuse a healthy frontend, or stop only the identified process before starting
`pnpm web:dev` again.

### Missing Next.js chunk

For an error such as `Cannot find module './79.js'`:

1. Stop the frontend.
2. Confirm port 3001 is free.
3. Delete `apps/web/.next`.
4. Restart with `pnpm web:dev`.
5. Hard refresh the browser.

Never remove `.next` while the frontend is running.

### API unavailable

```bash
lsof -nP -iTCP:3000 -sTCP:LISTEN
curl -I http://localhost:3000
pnpm --filter api start:dev
```

### Database or Redis unhealthy

Start the repository Compose services, then verify migrations:

```bash
docker compose -f infrastructure/docker/docker-compose.yml up -d
pnpm --filter api exec prisma migrate status
```

Use `/settings` to show the masked API database/Redis health result. Do not
paste connection strings into a shared terminal.

### Simulator run does not progress

Confirm API and worker processes are running, the selected merchant is active,
the run uses only supported scenario percentages, and the persisted run status
is visible at `/simulator`. A worker heartbeat is not available, so do not use
the health screen alone to infer worker activity.

## 21. Final demo checklist

- [ ] API, worker, PostgreSQL, Redis, and web processes are running.
- [ ] Browser opens Dashboard, Payments, Merchants, Webhooks, and Simulator.
- [ ] No raw API key, signing secret, connection string, or rotated key is on screen.
- [ ] An active merchant, payment, ledger data, NACHA file, and simulator history exist.
- [ ] Architecture document is open.
- [ ] [Working-demo screenshots](./working-demo.md) are ready as a fallback.
