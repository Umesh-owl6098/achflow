# ACHFlow API Reference

## Overview

ACHFlow exposes two backend API surfaces:

- **Merchant APIs** create and inspect merchant-owned payments, ledger data, NACHA exports, dashboard data, and webhook configuration.
- **Admin APIs** manage merchants, provide read-only system status, and control local-development simulator runs.

The operations portal uses server-side Next.js BFF routes. Browser requests are sent to the web application’s `/api/...` routes, which add the appropriate server-only merchant or admin credential before calling the NestJS API. Browser code must not call admin APIs with an admin key directly.

All monetary amounts in JSON responses are strings in cents unless an endpoint’s request DTO explicitly accepts an integer cents value.

## Base URLs

| Surface      | Base path               | Local address                        |
| ------------ | ----------------------- | ------------------------------------ |
| Merchant API | `/api/v1`               | `http://localhost:3000/api/v1`       |
| Admin API    | `/api/v1/admin`         | `http://localhost:3000/api/v1/admin` |
| Next.js BFF  | `/api` and `/api/admin` | `http://localhost:3001/api`          |

The BFF uses both `/api/...` merchant proxy routes and `/api/admin/...` control-plane routes. `/api/admin/...` is kept server-side because it reads `ACHFLOW_ADMIN_API_KEY` from the web server environment.

## Authentication

### Merchant API key

Merchant routes require:

```http
Authorization: Bearer <merchant-api-key>
```

`x-api-key` is **not** implemented by the API. Merchant API keys are HMAC-hashed before lookup and resolve to one merchant. Payment, ledger, NACHA, dashboard, and webhook queries are scoped to that merchant.

Example:

```bash
curl http://localhost:3000/api/v1/payments \
  -H 'Authorization: Bearer <merchant-api-key>'
```

### Admin API key

Admin routes require a separate credential:

```http
Authorization: Bearer <admin-api-key>
```

`x-admin-api-key` is **not** implemented. The `AdminApiKeyGuard` returns `401` for a missing Bearer header and `403` for an invalid key. The Next.js BFF is the intended browser-facing caller; it holds the admin key server-side and never returns it to the browser.

## Idempotency

`POST /api/v1/payments` requires:

```http
Idempotency-Key: <client-generated-key>
```

The key is scoped by merchant and stored in `PaymentIdempotencyRecord` with a deterministic request fingerprint.

| Request condition                       | Result                                                                            |
| --------------------------------------- | --------------------------------------------------------------------------------- |
| New merchant/key pair                   | Creates one payment, idempotency record, and initial outbox event; returns `201`. |
| Same merchant/key and matching payload  | Returns the original payment; returns `200`.                                      |
| Same merchant/key and different payload | Returns `409 Conflict`.                                                           |
| Same key for different merchants        | Does not conflict because the uniqueness scope includes merchant ID.              |

```bash
curl -X POST http://localhost:3000/api/v1/payments \
  -H 'Authorization: Bearer <merchant-api-key>' \
  -H 'Idempotency-Key: client-payment-0001' \
  -H 'Content-Type: application/json' \
  --data '{
    "merchantCode": "EXAMPLE_MERCHANT",
    "direction": "CREDIT",
    "amountCents": 2500,
    "currency": "USD",
    "externalReference": "invoice-123",
    "receiverName": "Example Receiver",
    "receiverAccountRef": "account-reference",
    "routingNumber": "021000021",
    "description": "Example payment"
  }'
```

## Error Response

The API uses NestJS HTTP exceptions and the global validation pipe. A typical application error response is:

```json
{
  "statusCode": 400,
  "message": "Idempotency-Key header is required.",
  "error": "Bad Request"
}
```

DTO validation failures use the same NestJS response shape, with `message` commonly containing an array of validation messages. Rate-limit errors use an explicit `code` field.

| Status | Implemented meaning                                                                |
| ------ | ---------------------------------------------------------------------------------- |
| `200`  | Successful read, lifecycle operation, or idempotent payment replay.                |
| `201`  | New payment, merchant, webhook endpoint, or simulator run created.                 |
| `400`  | DTO validation or business validation failure.                                     |
| `401`  | Missing or invalid merchant/admin authentication.                                  |
| `403`  | Invalid admin key.                                                                 |
| `404`  | Missing resource, including cross-merchant payment access.                         |
| `409`  | Merchant code conflict or idempotency key reused with a different payment payload. |
| `429`  | Merchant API rate limit exceeded; includes `Retry-After`.                          |
| `500`  | Unhandled internal error or configured internal exception.                         |
| `503`  | Redis-backed rate-limit service unavailable, or a BFF upstream failure.            |

The repository does not define a dedicated `422` response path.

## Payments

All endpoints in this section use merchant authentication and the payment rate-limit guard.

### Create payment

`POST /api/v1/payments`

Creates a merchant-owned ACH debit or credit payment. The payment and its `PAYMENT_RECEIVED` outbox event are written through the payment creation repository transaction.

#### Headers

```http
Authorization: Bearer <merchant-api-key>
Idempotency-Key: <client-generated-key>
Content-Type: application/json
```

#### Request body

| Field                | Type                | Required | Validation                                                                |
| -------------------- | ------------------- | -------- | ------------------------------------------------------------------------- |
| `merchantCode`       | string              | Yes      | Non-empty, max 100 characters; must belong to the authenticated merchant. |
| `direction`          | `DEBIT` or `CREDIT` | Yes      | `PaymentDirection` enum.                                                  |
| `amountCents`        | integer             | Yes      | Minimum `1`.                                                              |
| `currency`           | string              | No       | Exactly 3 characters; defaults to `USD`.                                  |
| `externalReference`  | string              | No       | Max 100 characters.                                                       |
| `receiverName`       | string              | Yes      | Non-empty, max 140 characters.                                            |
| `receiverAccountRef` | string              | Yes      | Non-empty, max 255 characters.                                            |
| `routingNumber`      | string              | Yes      | Exactly 9 digits.                                                         |
| `description`        | string              | No       | Max 255 characters.                                                       |

`CreatePaymentDto` also accepts an optional body field named `idempotencyKey`, but the implemented creation service requires and uses the `Idempotency-Key` HTTP header.

#### Response

New payment: `201 Created`. Matching idempotent replay: `200 OK`.

```json
{
  "id": "payment-id",
  "idempotencyKey": "client-payment-0001",
  "externalReference": "invoice-123",
  "direction": "CREDIT",
  "status": "RECEIVED",
  "amountCents": "2500",
  "currency": "USD",
  "merchant": {
    "merchantCode": "EXAMPLE_MERCHANT",
    "displayName": "Example Merchant"
  },
  "receiverName": "Example Receiver",
  "receiverAccountRef": "account-reference",
  "routingNumber": "021000021",
  "description": "Example payment",
  "failureCode": null,
  "failureReason": null,
  "validationCode": null,
  "validationMessage": null,
  "validatedAt": null,
  "createdAt": "2026-01-01T00:00:00.000Z",
  "updatedAt": "2026-01-01T00:00:00.000Z"
}
```

Common errors: `400` missing idempotency key or invalid DTO, `401` invalid merchant key, `404` merchant code does not belong to the caller, `409` conflicting key reuse, `429` rate limited, `503` rate-limit service unavailable.

### List payments

`GET /api/v1/payments`

Returns only payments belonging to the authenticated merchant.

| Query parameter        | Values                                                                 |
| ---------------------- | ---------------------------------------------------------------------- |
| `search`               | Payment ID, external reference, merchant code, or display name search. |
| `status`               | Any `PaymentStatus` enum value.                                        |
| `direction`            | `DEBIT` or `CREDIT`.                                                   |
| `dateRange`            | `today`, `7d`, `30d`, or `custom`. Defaults to `30d`.                  |
| `startDate`, `endDate` | ISO date strings; both required for `dateRange=custom`.                |
| `sortBy`               | `createdAt`, `amountCents`, or `status`.                               |
| `sortOrder`            | `asc` or `desc`.                                                       |
| `page`                 | Integer from `1`.                                                      |
| `limit`                | Integer `1`–`25`.                                                      |

```json
{
  "data": [
    {
      "id": "payment-id",
      "merchant": {
        "merchantCode": "EXAMPLE_MERCHANT",
        "displayName": "Example Merchant"
      },
      "externalReference": "invoice-123",
      "direction": "CREDIT",
      "status": "VALIDATED",
      "amountCents": "2500",
      "currency": "USD",
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:00:00.000Z"
    }
  ],
  "page": 1,
  "limit": 25,
  "total": 1,
  "totalPages": 1
}
```

### Payment details

`GET /api/v1/payments/:paymentId`

Returns the payment, related reservation if one exists, related ledger entries, lifecycle outbox events, and current funding-balance data when a reservation exists. This endpoint returns `404` when the payment is absent **or** owned by another merchant.

The response includes a serialized top-level payment view and a nested `payment` view, plus `reservation`, `ledgerEntries`, `outboxEvents`, and balance-related fields from `PaymentEngineService.details()`.

### Validate payment

`POST /api/v1/payments/:paymentId/validate`

Runs the existing API-side validation flow and returns the current serialized payment. It is idempotent when the payment has already left `RECEIVED`.

### Reserve payment

`POST /api/v1/payments/:paymentId/reserve`

Requires a merchant-owned `VALIDATED` payment. For an ACH credit, validates funding availability and returns a reservation object; for an ACH debit, returns `null` because debit payments do not reserve prefunded funding.

```json
{
  "id": "reservation-id",
  "paymentId": "payment-id",
  "fundingAccountId": "funding-account-id",
  "amount": "2500",
  "status": "ACTIVE",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "releasedAt": null,
  "settledAt": null,
  "returnedAt": null,
  "returnCode": null
}
```

### Settle payment

`POST /api/v1/payments/:paymentId/settle`

Requires a merchant-owned `SUBMITTED` payment with an active reservation. Returns the settled reservation. The API rejects unsubmitted payments, absent reservations, or inactive reservations with `400`/`404` as applicable.

### Return settled payment

`POST /api/v1/payments/:paymentId/return`

Requires a merchant-owned payment with a settled reservation. It transitions the reservation and payment to `RETURNED` and returns the reservation.

```json
{ "returnCode": "R01" }
```

`returnCode` must match `^[A-Z0-9]{2,3}$`.

## Merchants

Merchant management is an admin-only API surface.

### List merchants

`GET /api/v1/admin/merchants`

Returns `{ "data": [...] }`, where each row includes merchant identity, `status`, `createdAt`, payment count, settled processed volume, webhook endpoint count, and posted/reserved/available funding totals. Existing raw API keys are not returned.

### Create merchant

`POST /api/v1/admin/merchants`

```json
{
  "merchantCode": "EXAMPLE_MERCHANT",
  "legalName": "Example Merchant LLC",
  "displayName": "Example Merchant",
  "perPaymentLimit": "100000",
  "dailyAmountLimit": "500000",
  "allowAchDebit": true,
  "allowAchCredit": true,
  "status": "ACTIVE"
}
```

`perPaymentLimit` and `dailyAmountLimit` are digit-only strings because they are persisted as bigint cents. A successful response includes a newly generated `apiKey` exactly once:

```json
{
  "merchant": {
    "id": "merchant-id",
    "merchantCode": "EXAMPLE_MERCHANT",
    "displayName": "Example Merchant",
    "status": "ACTIVE"
  },
  "apiKey": "one-time-generated-value"
}
```

Store this value securely when returned; it is not available from list or detail responses.

### Merchant details

`GET /api/v1/admin/merchants/:merchantId`

Returns merchant profile, permission flags, stringified limits, API-key metadata only, funding summary, payment status breakdown, recent payments, and webhook endpoint metadata.

### Update merchant status

`PATCH /api/v1/admin/merchants/:merchantId/status`

```json
{ "status": "SUSPENDED" }
```

Accepted values are the actual `MerchantStatus` enum: `ACTIVE`, `SUSPENDED`, and `CLOSED`.

### Rotate merchant API key

`POST /api/v1/admin/merchants/:merchantId/api-key/rotate`

Returns `{ "merchantId": "...", "apiKey": "one-time-generated-value" }`. Rotation replaces the stored hash immediately; the old key is no longer valid.

## Ledger

### List ledger entries

`GET /api/v1/ledger`

Returns all ledger entries for funding accounts belonging to the authenticated merchant, plus a summary. The implementation performs filtering in service code and does **not** provide pagination.

| Query parameter                    | Values                                                                                                                                                               |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search`                           | Matches payment ID, external reference, merchant code, or display name.                                                                                              |
| `entryType`                        | Any `LedgerEntryType`: `INITIAL_CREDIT`, `RESERVATION`, `RESERVATION_RELEASE`, `SETTLEMENT`, `DEBIT_POSTED`, `CREDIT_POSTED`, `RETURN`, `REVERSAL`, or `ADJUSTMENT`. |
| `dateRange`                        | `all`, `today`, `7d`, `30d`, or `custom`.                                                                                                                            |
| `startDate`, `endDate`             | ISO date strings; both required for custom date range.                                                                                                               |
| `minAmountCents`, `maxAmountCents` | Digit-only string cents values.                                                                                                                                      |

Response fields include `entryKey`, `entryType`, amount/debit/credit/balance-impact/running-balance cents strings, funding account, currency, merchant, optional payment, optional reservation, and status.

```json
{
  "merchant": {
    "merchantCode": "EXAMPLE_MERCHANT",
    "displayName": "Example Merchant"
  },
  "data": [],
  "summary": {
    "totalCreditsCents": "0",
    "totalDebitsCents": "0",
    "netPositionCents": "0",
    "outstandingReservedAmountCents": "0"
  }
}
```

## NACHA

### List NACHA files

`GET /api/v1/nacha-files`

Lists `AchFile` records whose `companyId` matches the authenticated merchant. Each list item includes file metadata and associated merchant-owned payments. There is no separate backend file-details endpoint; details are part of the list item.

| Query parameter        | Values                                    |
| ---------------------- | ----------------------------------------- |
| `search`               | File ID or filename.                      |
| `status`               | `SUBMITTED`, `PENDING`, or `FAILED`.      |
| `dateRange`            | `all`, `today`, `7d`, `30d`, or `custom`. |
| `startDate`, `endDate` | Used for `custom`; both are required.     |

Response rows include `id`, `fileName`, `createdAt`, `effectiveEntryDate`, `submissionStatus`, payment/debit/credit counts and totals, `entryHash`, `sha256`, `exportedBy`, and `payments`.

### Download NACHA file

`GET /api/v1/nacha-files/:fileId/download`

Returns `text/plain; charset=utf-8` with a `Content-Disposition` attachment header. The API renders content from the persisted file metadata and associated payments. It does not retrieve stored raw file bytes from an object store.

## Webhooks

All webhook endpoints use merchant authentication and merchant scope.

| Method   | URL                                       | Purpose                                                                  |
| -------- | ----------------------------------------- | ------------------------------------------------------------------------ |
| `GET`    | `/api/v1/webhooks`                        | List webhook endpoints and endpoint summary.                             |
| `POST`   | `/api/v1/webhooks`                        | Create an endpoint with URL and signing secret.                          |
| `PATCH`  | `/api/v1/webhooks/:endpointId`            | Update URL, signing secret, or `isActive`.                               |
| `DELETE` | `/api/v1/webhooks/:endpointId`            | Delete an unused endpoint or disable one with delivery history.          |
| `GET`    | `/api/v1/webhooks/deliveries`             | List merchant delivery events.                                           |
| `GET`    | `/api/v1/webhooks/:endpointId/deliveries` | List deliveries for one merchant-owned endpoint.                         |
| `POST`   | `/api/v1/webhooks/:endpointId/test`       | Create a persisted `webhook.test` delivery event for an active endpoint. |

### Create webhook endpoint

```json
{
  "url": "https://example.invalid/webhooks/achflow",
  "signingSecret": "client-supplied-secret"
}
```

`url` must be a URL of at most 2048 characters. Embedded username/password and unsupported schemes are rejected. In production, the service requires HTTPS. Signing secrets are encrypted at rest and are never returned by list or detail response data.

### Update webhook endpoint

```json
{
  "url": "https://example.invalid/webhooks/achflow-v2",
  "isActive": true
}
```

`signingSecret` may also be supplied to rotate the secret. Existing raw secrets cannot be retrieved.

### Delivery queries and retry state

Both delivery list routes accept:

| Query parameter | Values                                                                 |
| --------------- | ---------------------------------------------------------------------- |
| `search`        | Delivery event ID, event type, or payment ID where present in payload. |
| `status`        | `all`, `PENDING`, `PROCESSING`, `DELIVERED`, or `FAILED`.              |
| `eventType`     | Event-type string.                                                     |
| `dateRange`     | `all`, `today`, `7d`, or `30d`.                                        |

Delivery responses expose `eventId`, `eventType`, `paymentId`, `status`, `attemptCount`, response status, last error code, retry timestamp, delivered timestamp, endpoint metadata, merchant metadata, and payload. No retry API endpoint is implemented; retry behavior is persisted worker behavior.

When processed, delivery signatures use `X-ACHFlow-Signature: v1=<hex-hmac>` with HMAC-SHA256 over `timestamp + "." + JSON body`.

## Settings and System Status

### Dashboard

`GET /api/v1/dashboard`

Merchant-scoped dashboard data: current-day summary, seven-day volume, selected payment status distribution, recent payments, and `generatedAt`.

### System status

`GET /api/v1/admin/system/status`

Admin-only read-only configuration and health response. It includes general defaults, ACH processing summary, masked NACHA configuration, webhook settings, secret configuration flags, PostgreSQL and Redis health, outbox backlog, pending delivery count, and worker health (`UNKNOWN` without a persisted heartbeat). It does not return raw environment values, connection strings, or keys.

There is also an unversioned `GET /` endpoint that returns the application’s current plain-text greeting. It is not a health endpoint.

## Transaction Simulator

All simulator endpoints are admin-only and available only when `NODE_ENV` is `local`, `development`, or `test`. Outside those environments they return `404`.

| Method | URL                                          | Purpose                                             |
| ------ | -------------------------------------------- | --------------------------------------------------- |
| `GET`  | `/api/v1/admin/simulator/runs`               | List up to 20 recent runs.                          |
| `GET`  | `/api/v1/admin/simulator/runs/:runId`        | Get one run and up to 20 recent generated payments. |
| `POST` | `/api/v1/admin/simulator/runs`               | Create and begin a run.                             |
| `POST` | `/api/v1/admin/simulator/runs/:runId/pause`  | Pause a running run.                                |
| `POST` | `/api/v1/admin/simulator/runs/:runId/resume` | Resume a paused run.                                |
| `POST` | `/api/v1/admin/simulator/runs/:runId/stop`   | Stop a running or paused run.                       |

### Create simulator run

```json
{
  "merchantIds": ["merchant-id"],
  "direction": "MIXED",
  "transactionCount": 10,
  "transactionsPerSecond": 2,
  "minimumAmountCents": 100,
  "maximumAmountCents": 1000,
  "secCode": "PPD",
  "effectiveDate": "2026-01-01",
  "descriptionPrefix": "Simulator",
  "idempotencyKeyPrefix": "local-run",
  "scenario": {
    "successfulPercent": 100,
    "validationFailurePercent": 0,
    "returnPercent": 0,
    "insufficientFundsPercent": 0,
    "duplicatePercent": 0,
    "delayedProcessingPercent": 0,
    "webhookFailurePercent": 0
  }
}
```

Safety constraints in the DTO and service:

- 1–20 selected merchants; all must be `ACTIVE`.
- 1–500 transactions.
- 1–25 TPS.
- 1–1,000,000 cents for each amount boundary.
- Minimum amount must not exceed maximum amount.
- `successfulPercent + validationFailurePercent + insufficientFundsPercent + returnPercent` must equal 100.

The implemented scenarios are successful creation, validation failures using an amount beyond the merchant per-payment limit, and idempotent duplicate replay. Return, insufficient-funds, delayed-processing, and webhook-failure percentages are currently rejected by the service rather than simulated with direct database writes.

## Next.js BFF Routes

The BFF routes live in [`apps/web/app/api`](../apps/web/app/api). They proxy only existing backend routes and do not add a second public domain API.

| BFF route family                                                    | Implemented proxy behavior                                 |
| ------------------------------------------------------------------- | ---------------------------------------------------------- |
| `/api/payments`, `/api/payments/:paymentId`                         | Read-only payment list/detail proxy to `/api/v1/payments`. |
| `/api/dashboard`, `/api/ledger`, `/api/nacha-files`                 | Read-only merchant operational-data proxies.               |
| `/api/nacha-files/:fileId/download`                                 | NACHA download proxy.                                      |
| `/api/webhooks` and nested endpoint routes                          | Merchant webhook proxy routes used by the portal.          |
| `/api/admin/merchants`, `/api/admin/system`, `/api/admin/simulator` | Server-side admin control-plane proxy routes.              |

The BFF returns upstream status/body data or a `503` BFF availability error. It uses server environment variables for API credentials; it does not expose every merchant lifecycle write endpoint as a browser route.

## Response Models

| Model            | Important fields exposed by API                                                                                                                      |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Payment          | ID, idempotency key, merchant display identity, direction, status, amount cents string, receiver fields, validation/failure fields, timestamps.      |
| Reservation      | ID, payment/funding-account IDs, amount string, status, release/settlement/return timestamps, return code.                                           |
| Merchant         | Identity, status, permission flags, stringified limits, funding/volume summaries, key metadata only.                                                 |
| Ledger entry     | Key, type, cents strings, debit/credit/balance/running-balance fields, funding account, optional payment and reservation.                            |
| Webhook endpoint | ID, URL, active flag, timestamps, delivery summary; never the signing secret.                                                                        |
| Webhook delivery | Event identity/type/payload, status, attempts, response status, last error code, retry and delivery timestamps.                                      |
| NACHA file       | ID, filename, effective date, submission status, totals/counts, entry hash, SHA-256, associated payment summaries.                                   |
| Simulator run    | ID, status, configuration, selected merchants, timestamps, generated/successful/failed/returned counters, average latency, optional failure summary. |

## Pagination

Only `GET /api/v1/payments` implements pagination: `page` starts at 1 and `limit` is capped at 25. The response includes `page`, `limit`, `total`, and `totalPages`.

The ledger, webhook, NACHA, merchant, dashboard, system-status, and simulator list endpoints do not expose pagination parameters in their implemented DTOs. Simulator runs are capped at the latest 20; run details include up to 20 recent payments.

## Filtering and Sorting

| Endpoint               | Implemented filtering/sorting                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `GET /payments`        | Search, status, direction, UTC date range, `createdAt`/`amountCents`/`status` sort, ascending/descending order, pagination. |
| `GET /ledger`          | Search, entry type, UTC date range, minimum/maximum amount.                                                                 |
| `GET /nacha-files`     | Search, submission status, UTC date range.                                                                                  |
| `GET /webhooks`        | URL search, endpoint active/disabled status, delivery status.                                                               |
| Webhook delivery lists | Search, delivery status, event type, recent date range.                                                                     |

## Security

- Merchant access is enforced by `MerchantApiKeyGuard` and ownership checks.
- Admin access is enforced by a separate, constant-time compared admin key.
- The browser uses server-side BFF routes for operations portal access.
- Existing raw merchant keys, webhook signing secrets, and raw environment values are not returned by list/detail/status endpoints.
- The simulator is disabled outside local/development/test environments.
- Cross-merchant payment access is represented as `404`.

## Rate Limiting

Merchant-protected API controllers use `PaymentRateLimitGuard`. The guard consumes a Redis-backed, merchant-keyed distributed rate-limit bucket.

- Exceeded requests return `429` with `Retry-After` and `RATE_LIMIT_EXCEEDED`.
- Redis/rate-limit service failures return `503` with `RATE_LIMIT_SERVICE_UNAVAILABLE`.
- Admin routes do not use this merchant rate-limit guard.

## Known Limitations

- No public backend endpoint generates or submits NACHA files; generation is worker-side.
- No separate NACHA file-detail endpoint; file details are embedded in list responses.
- No webhook retry endpoint; delivery retry is worker-managed.
- No direct bank transport, inbound ACH return-file parser, or general reconciliation-file workflow.
- The simulator cannot automate return, NSF, delayed-processing, or webhook-failure scenarios.
- The worker health value is `UNKNOWN` because no heartbeat is persisted.
- The API uses Bearer headers; `x-api-key` and `x-admin-api-key` are not supported.
