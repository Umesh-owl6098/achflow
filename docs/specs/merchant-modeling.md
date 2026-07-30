# Merchant Modeling

**Status:** Implemented
**Spec version:** 1.0
**Last updated:** 2026-07-29
**Relates to:** `apps/api/prisma/schema.prisma`, `apps/api/src/payments/`, `apps/worker/src/`

---

## Overview

Every ACH payment in ACHFlow is originated on behalf of a business entity called a **merchant**. The merchant record is the root authorization context for a payment: it controls whether the payment is allowed to proceed, and in which direction.

Without a validated merchant, a payment cannot move past the `RECEIVED` state. The merchant record encodes the business rules — active status, ACH direction permissions, and a per-payment amount ceiling — that the validation worker checks before promoting a payment to `VALIDATED`. This keeps authorization logic centralized and auditable at the merchant level rather than scattered across payment creation code.

---

## Current Architecture

The system is a NestJS monorepo backed by a single PostgreSQL database accessed through Prisma. Merchants are managed records seeded directly into the database. There is no merchant management API; merchants are created and modified through database operations.

Payment creation is the only runtime path that touches merchant records today. When a caller submits a payment, `PaymentsService` resolves the merchant by `merchantCode`, attaches the internal `merchantId` to the payment record, and stores a `PAYMENT_RECEIVED` outbox event atomically in the same transaction.

Merchant validation — checking status, permissions, and per-payment limit — happens in a background worker that consumes the outbox. **The worker is not yet implemented.** The outbox table and all validation-supporting fields on the `Merchant` model exist and are ready. The validation flow described in this document is the design the worker will execute.

---

## Scope

**Included**

- The `Merchant` data model and all its fields.
- Merchant status lifecycle and the three defined statuses.
- ACH direction permissions (`allowAchDebit`, `allowAchCredit`).
- Per-payment amount limit (`perPaymentLimit`).
- How `PaymentsService` resolves a merchant at payment-creation time.
- How the validation worker will use the merchant record to accept or reject a payment.
- Idempotency behavior at payment creation.
- Failure codes set on the `Payment` record when merchant validation fails.

**Out of scope**

- Merchant management API (create, update, suspend via HTTP).
- Daily limit enforcement (`dailyAmountLimit` is stored but intentionally not enforced; see `merchant-daily-limits.md`).
- ODFI assignment.
- Ledger entries.
- ACH batch grouping.
- Authentication and authorization.

---

## Components

### `Merchant` (Prisma model)

The authoritative record for a business entity. Owns the fields the validation worker checks. Modified today only through direct database operations or the seed script.

### `Payment` (Prisma model)

Carries a `merchantId` foreign key. Begins life in `RECEIVED` status. The validation worker transitions it to `VALIDATED` or `VALIDATION_FAILED` after checking the merchant.

### `OutboxEvent` (Prisma model)

Written atomically with every new `Payment` record. Event type `PAYMENT_RECEIVED` signals to the (pending) worker that a payment is ready for validation. The outbox guarantees that no payment is silently lost if the worker is down.

### `MerchantsRepository`

Thin data-access class. Exposes a single method: `findByCode(merchantCode)`. Used by `PaymentsService` at creation time to resolve the merchant before the payment row is written.

### `PaymentsRepository`

Owns the atomic write path: creates the `Payment` row and its `PAYMENT_RECEIVED` outbox event in a single Prisma transaction.

### `PaymentsService`

Orchestrates payment creation: resolves the merchant, builds a deterministic request fingerprint, writes the payment and outbox event, and handles idempotency conflicts.

### Payment Validation Worker _(not yet implemented)_

Will consume `PAYMENT_RECEIVED` outbox events and apply merchant validation rules. The schema is fully prepared for this worker.

---

## Data Model

### `Merchant`

| Field | Type | Notes |
|---|---|---|
| `id` | `String` (UUID) | Internal primary key. |
| `merchantCode` | `String` | Human-readable unique business identifier. Used in all API calls. |
| `legalName` | `String` | Legal name of the business entity. |
| `displayName` | `String` | Short name used in response payloads. |
| `status` | `MerchantStatus` | `ACTIVE`, `SUSPENDED`, or `CLOSED`. Default: `ACTIVE`. |
| `allowAchDebit` | `Boolean` | Merchant may originate DEBIT payments. Default: `false`. |
| `allowAchCredit` | `Boolean` | Merchant may originate CREDIT payments. Default: `false`. |
| `perPaymentLimit` | `BigInt` | Maximum amount (in cents) for any single payment. |
| `dailyAmountLimit` | `BigInt` | Stored; not enforced in this phase. |
| `createdAt` | `DateTime` | Set by the database on insert. |
| `updatedAt` | `DateTime` | Maintained by Prisma `@updatedAt`. |

**Unique constraint:** `merchantCode`
**Relation:** `Payment[] payments`

### `MerchantStatus` enum

| Value | Meaning |
|---|---|
| `ACTIVE` | Merchant may originate payments. |
| `SUSPENDED` | Merchant is temporarily barred. In-flight payments fail validation. |
| `CLOSED` | Merchant is permanently decommissioned. Terminal state. |

### Relevant `Payment` fields (validation results)

| Field | Type | Notes |
|---|---|---|
| `merchantId` | `String` | FK to `Merchant.id`. Set at creation time. |
| `status` | `PaymentStatus` | Worker transitions to `VALIDATED` or `VALIDATION_FAILED`. |
| `failureCode` | `String?` | Short code written on `VALIDATION_FAILED` (e.g., `MERCHANT_SUSPENDED`). |
| `failureReason` | `String?` | Human-readable description of the failure. |
| `validationCode` | `String?` | Reserved for validation pass metadata. |
| `validationMessage` | `String?` | Reserved for validation pass metadata. |
| `validatedAt` | `DateTime?` | Set when the worker transitions to `VALIDATED`. |

---

## Processing Flow

### Payment creation

```
Caller
  │
  │  POST /api/v1/payments  { merchantCode, direction, amountCents, ... }
  ▼
PaymentsController
  │
  ▼
PaymentsService.create(dto)
  │
  ├─► MerchantsRepository.findByCode(dto.merchantCode)
  │       │
  │       ├─ Found     → continue
  │       └─ Not found → throw 404 NotFoundException (payment not written)
  │
  ├─► buildPaymentRequestFingerprint(dto, merchant.id)
  │       Canonical JSON of all request fields → SHA-256 hex string
  │
  ├─► PaymentsRepository.createWithOutbox(data)
  │       Prisma transaction:
  │         1. INSERT INTO payments (status = RECEIVED, ...)
  │         2. INSERT INTO outbox_events (eventType = PAYMENT_RECEIVED, ...)
  │       │
  │       ├─ Success → return PaymentWithMerchant
  │       └─ P2002 unique violation on idempotencyKey → idempotency path (see below)
  │
  └─► HTTP 201 + PaymentResponseDto
```

### Idempotency conflict path

```
P2002 on idempotencyKey
  │
  ├─► findPaymentWithVisibilityRetry(idempotencyKey)
  │       Retries at 10ms, 25ms, 50ms to handle read-after-write lag
  │       │
  │       ├─ Not found after retries → 500 InternalServerErrorException
  │       └─ Found → compare requestFingerprint
  │                       │
  │                       ├─ Fingerprints match   → HTTP 200 + same PaymentResponseDto
  │                       └─ Fingerprints differ  → 409 ConflictException
  │                             (same key, different payload = disallowed replay)
```

### Payment validation (worker — not yet implemented)

The following describes the intended behavior the worker will implement. All required schema fields already exist.

```
Worker
  │
  ├─► Claim next PAYMENT_RECEIVED outbox event
  │
  ├─► Load payment by aggregateId
  │
  ├─► Load merchant by payment.merchantId
  │
  ├─► Run validation checks in order:
  │
  │   Check 1: merchant.status == ACTIVE
  │               └─ Fail → failureCode: MERCHANT_NOT_ACTIVE
  │
  │   Check 2: direction == DEBIT  → merchant.allowAchDebit == true
  │            direction == CREDIT → merchant.allowAchCredit == true
  │               └─ Fail → failureCode: DIRECTION_NOT_PERMITTED
  │
  │   Check 3: payment.amountCents <= merchant.perPaymentLimit
  │               └─ Fail → failureCode: EXCEEDS_PER_PAYMENT_LIMIT
  │
  ├─► All checks pass
  │       UPDATE payments SET status = VALIDATED, validatedAt = now()
  │       Mark outbox event PROCESSED
  │
  └─► Any check fails
        UPDATE payments SET status = VALIDATION_FAILED,
                            failureCode = <code>,
                            failureReason = <message>
        Mark outbox event PROCESSED
```

---

## Validation Rules

| Rule | Field checked | Failure code |
|---|---|---|
| Merchant must exist | `merchantCode` | N/A — 404 at creation time |
| Merchant must be `ACTIVE` | `merchant.status` | `MERCHANT_NOT_ACTIVE` |
| Merchant must allow the payment direction | `allowAchDebit` / `allowAchCredit` | `DIRECTION_NOT_PERMITTED` |
| Payment amount must not exceed per-payment limit | `amountCents` vs `perPaymentLimit` | `EXCEEDS_PER_PAYMENT_LIMIT` |

All amount values are stored and compared in **cents** as `BigInt` to avoid floating-point error.

The `currency` field is validated at DTO level (ISO 4217, exactly 3 characters). Only `USD` is in active use today.

---

## Failure Handling

### Business failures

These are deterministic. A retry will produce the same outcome. The payment is transitioned to `VALIDATION_FAILED` and the outbox event is marked `PROCESSED`. No re-queue occurs.

| Failure | `failureCode` | Recovery |
|---|---|---|
| Merchant not active | `MERCHANT_NOT_ACTIVE` | Operator activates merchant; a new payment must be submitted. |
| Direction not permitted | `DIRECTION_NOT_PERMITTED` | Operator grants permission; a new payment must be submitted. |
| Amount over limit | `EXCEEDS_PER_PAYMENT_LIMIT` | Caller submits a corrected payment with a lower amount. |

### Infrastructure failures

These are transient. The outbox worker retries the event delivery according to its retry policy (defined when the worker is implemented). The `Payment` record is not modified until validation succeeds or deterministically fails.

| Failure | Behavior |
|---|---|
| Database unreachable during worker processing | Outbox event remains `PENDING`; retried on next worker poll. |
| Worker crash mid-validation | Outbox event `claimedAt` timeout causes it to be re-claimed on next cycle. |
| Merchant record not found by internal ID | Treated as infrastructure error; logged and retried. Should not occur given FK integrity. |

---

## State Transitions

### Payment status (merchant-validation phase only)

```
RECEIVED → VALIDATED         (all merchant checks pass)
RECEIVED → VALIDATION_FAILED (any merchant check fails)
```

**Valid transitions in this phase:**

| From | To | Condition |
|---|---|---|
| `RECEIVED` | `VALIDATED` | merchant ACTIVE, direction permitted, amount within limit |
| `RECEIVED` | `VALIDATION_FAILED` | any merchant check fails |

**Invalid transitions in this phase:**

| Transition | Reason |
|---|---|
| `VALIDATED` → `RECEIVED` | No backward transitions. |
| `VALIDATION_FAILED` → any | Terminal for this phase. Requires a new payment submission. |
| `RECEIVED` → any other status | No other status is reachable from `RECEIVED` in this phase. |

### Merchant status

| From | To | Who triggers |
|---|---|---|
| `ACTIVE` | `SUSPENDED` | Database / operator tooling |
| `ACTIVE` | `CLOSED` | Database / operator tooling |
| `SUSPENDED` | `ACTIVE` | Database / operator tooling |
| `SUSPENDED` | `CLOSED` | Database / operator tooling |

**Invalid merchant transitions:**

| Transition | Reason |
|---|---|
| `CLOSED` → any | Terminal state. |
| Any → `ACTIVE` without prior `SUSPENDED` step (from `CLOSED`) | Irreversible by design. |

---

## Concurrency Considerations

### Idempotency at payment creation

Every payment carries a caller-supplied `idempotencyKey` with a unique index in the database. Duplicate submissions within the same operation are handled as follows:

- **Same key, same payload** (matching `requestFingerprint`): The original payment is returned with HTTP 200. No second row is written.
- **Same key, different payload**: The request is rejected with HTTP 409. The original payment is preserved unchanged.

The fingerprint is a SHA-256 hash of the canonical request body fields plus the resolved `merchantId`. This prevents payload substitution attacks on replayed idempotency keys.

### Read-after-write visibility

Under high concurrency, the winning write may not be immediately visible to the concurrent reader that lost the unique constraint race. `findPaymentWithVisibilityRetry` retries the lookup at 10ms, 25ms, and 50ms delays before failing. This handles replication lag and buffer visibility delays within a single PostgreSQL instance.

### Worker claim safety _(design intent, not yet implemented)_

The outbox `claimedAt` column will be used to detect stale claims. A worker that claims an event but does not process it within a configurable timeout will have its claim expired, allowing another worker instance to re-claim it. The `attempts` counter tracks how many times an event has been claimed.

---

## Security Considerations

`receiverAccountRef` is an opaque string today. It is stored and returned as-is, with no masking. When bank account numbers are stored here, this field must be treated as sensitive. Masking or tokenization should be introduced before this field is exposed to external consumers or logged.

`routingNumber` is not sensitive by itself but should not appear in application-level debug logs in production.

`legalName` on the merchant record is a legal business name. It is stored in plaintext today. Encryption at rest should be considered before the platform handles production merchant data.

No authentication or authorization is implemented. All endpoints are open. This is a known gap to be addressed in a future phase.

---

## Acceptance Criteria

1. `POST /api/v1/payments` with a valid `merchantCode` creates a payment in `RECEIVED` status and returns HTTP 201.
2. `POST /api/v1/payments` with an unknown `merchantCode` returns HTTP 404 and no payment row is written.
3. `POST /api/v1/payments` with the same `idempotencyKey` and identical payload returns HTTP 200 with the original payment.
4. `POST /api/v1/payments` with the same `idempotencyKey` and a changed payload returns HTTP 409 and the original payment is unchanged.
5. `GET /api/v1/payments/:id` returns the payment including the merchant's `merchantCode` and `displayName`.
6. Every new payment row has a corresponding `PAYMENT_RECEIVED` outbox event in the same database transaction.
7. The merchant's `perPaymentLimit`, `allowAchDebit`, `allowAchCredit`, and `status` are readable from the database and available for the validation worker to consume.
8. A `SUSPENDED` merchant's payments are created in `RECEIVED` status; the validation worker (when implemented) must transition them to `VALIDATION_FAILED` with `failureCode: MERCHANT_NOT_ACTIVE`.

---

## Future Work

The immediate next phase is implementing the **Payment Validation Worker**. The worker will consume `PAYMENT_RECEIVED` outbox events and apply the merchant checks described in the [Processing Flow](#processing-flow) section. All required schema fields (`failureCode`, `failureReason`, `validationCode`, `validationMessage`, `validatedAt`, and the full `OutboxEvent` model) are already in place. The worker implementation requires no schema changes.
