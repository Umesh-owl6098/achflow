# ACHFlow Working Demo

## Demo summary

| Item              | Evidence                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------- |
| Verification time | 2026-07-30 local verification                                                                           |
| Environment       | Local development services on localhost                                                                 |
| Web application   | `http://localhost:3001`                                                                                 |
| API               | `http://localhost:3000/api/v1`                                                                          |
| Test method       | Playwright Chromium against the running Next.js application                                             |
| Desktop viewport  | 1440 × 1000                                                                                             |
| Mobile viewport   | 390 × 844                                                                                               |
| Commit            | `e110d36`                                                                                               |
| Overall result    | Partial: major portal pages and real BFF data loaded; unsupported/absent UI states were not fabricated. |

## Runtime verification

| Component  | Result  | Evidence                                                               |
| ---------- | ------- | ---------------------------------------------------------------------- |
| Web        | PASSED  | Playwright loaded all captured routes from port 3001.                  |
| API        | PASSED  | Existing BFF data requests completed during captured pages.            |
| Worker     | UNKNOWN | No persisted worker heartbeat is implemented.                          |
| PostgreSQL | PASSED  | Settings/system-status screen loaded the API’s database health result. |
| Redis      | PASSED  | Settings/system-status screen loaded the API’s Redis health result.    |

## Feature verification matrix

| Feature         | Status  | Verification performed                                                                                        | Screenshot                                                                                                                                                          |
| --------------- | ------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dashboard       | PASSED  | Loaded live dashboard route and asserted its main heading.                                                    | [01](./demo-screenshots/01-dashboard.png)                                                                                                                           |
| Payments        | PASSED  | Loaded real payment list from BFF.                                                                            | [02](./demo-screenshots/02-payments-list.png)                                                                                                                       |
| Payment details | PASSED  | Opened a real payment returned by the BFF.                                                                    | [03](./demo-screenshots/03-payment-details-overview.png)                                                                                                            |
| Ledger          | PASSED  | Loaded merchant-scoped ledger page.                                                                           | [06](./demo-screenshots/06-ledger.png)                                                                                                                              |
| NACHA files     | PASSED  | Loaded list route and its operational controls.                                                               | [07](./demo-screenshots/07-nacha-files.png)                                                                                                                         |
| NACHA details   | PASSED  | Opened a real generated-file details dialog.                                                                  | [08](./demo-screenshots/08-nacha-file-details.png)                                                                                                                  |
| Webhooks        | PASSED  | Loaded endpoint configuration and a real delivery detail.                                                     | [09](./demo-screenshots/09-webhook-endpoints.png), [10](./demo-screenshots/10-webhook-delivery-events.png)                                                          |
| Merchants       | PASSED  | Loaded the real admin BFF list and a real merchant detail drawer.                                             | [11](./demo-screenshots/11-merchants-list.png), [12](./demo-screenshots/12-merchant-details.png)                                                                    |
| Settings        | PASSED  | Loaded system-health/settings view.                                                                           | [13](./demo-screenshots/13-settings-system-health.png)                                                                                                              |
| Simulator       | PARTIAL | Configuration plus a real completed 10-payment run and history loaded. No transient running state was staged. | [14](./demo-screenshots/14-simulator-configuration.png), [16](./demo-screenshots/16-simulator-completed.png), [17](./demo-screenshots/17-simulator-run-history.png) |
| Responsive UI   | PASSED  | Captured dashboard at 390 × 844.                                                                              | [18](./demo-screenshots/18-mobile-dashboard.png)                                                                                                                    |

## Feature walkthrough

### Dashboard and payments

The dashboard and payments pages loaded from the live web application. The capture test asserted successful route responses, main headings, and the absence of visible `MODULE_NOT_FOUND` and internal-server-error text.

![Dashboard working demonstration](./demo-screenshots/01-dashboard.png)

![Payments working demonstration](./demo-screenshots/02-payments-list.png)

### Payment detail and lifecycle evidence

The capture script requested the real BFF payment list, selected the first returned payment ID, and opened its real details route. The detail page was captured three times to preserve overview, ledger, and event evidence using the actual rendered page.

![Payment detail overview](./demo-screenshots/03-payment-details-overview.png)

![Payment detail ledger evidence](./demo-screenshots/04-payment-details-ledger.png)

![Payment detail event evidence](./demo-screenshots/05-payment-details-events.png)

The exact payment ID is intentionally not repeated here because the UI already presents the real identifier and the demo does not rely on a static fixture. The capture script never inserts a payment directly into PostgreSQL.

### Ledger and NACHA files

The ledger and NACHA file modules were loaded through their real BFF/API data paths.

![Ledger working demonstration](./demo-screenshots/06-ledger.png)

![NACHA files working demonstration](./demo-screenshots/07-nacha-files.png)

The existing list data powers the details dialog; the capture opened a real file record.

![NACHA file details](./demo-screenshots/08-nacha-file-details.png)

### Webhooks

The webhook endpoint module and a real persisted delivery were loaded from the merchant BFF. No synthetic delivery or response was created.

![Webhook endpoint demonstration](./demo-screenshots/09-webhook-endpoints.png)

![Webhook delivery event demonstration](./demo-screenshots/10-webhook-delivery-events.png)

### Merchants and settings

The merchant list uses the admin BFF, keeping the admin credential on the web server. The settings page shows API, database, Redis, outbox, webhook, and honest unknown-worker health state without raw environment values.

![Merchant list demonstration](./demo-screenshots/11-merchants-list.png)

![Merchant details demonstration](./demo-screenshots/12-merchant-details.png)

![Settings and health demonstration](./demo-screenshots/13-settings-system-health.png)

### Transaction simulator

The simulator configuration screen loaded from the local-only admin BFF route and shows merchant selection, direction, TPS, count, amount range, scenario mix, and safety limits.

![Simulator configuration demonstration](./demo-screenshots/14-simulator-configuration.png)

The implemented simulator supports successful requests, validation failures using real merchant limits, and duplicate idempotent requests. It does not currently automate return, NSF, delayed-processing, or webhook-failure scenarios.

The capture selected an existing real completed 10-payment simulator run and its persisted history. It deliberately did not start a second run just to stage a transient image.

![Completed simulator run](./demo-screenshots/16-simulator-completed.png)

![Simulator run history](./demo-screenshots/17-simulator-run-history.png)

### Responsive rendering

![Mobile dashboard demonstration](./demo-screenshots/18-mobile-dashboard.png)

## Security verification

- Screenshots were produced by the running application through Playwright Chromium.
- No admin key, merchant raw key, database URL, Redis URL, webhook signing secret, routing number, or raw account reference was inserted into the capture script or document.
- BFF routes were used for portal data; admin credentials remain server-side.
- The capture did not create or display one-time raw merchant API-key responses.
- Simulator routing remains restricted by the backend to local, development, and test environments.

## Known limitations

- No persisted worker heartbeat; worker health remains `UNKNOWN` in system status.
- Platform settings are read-only configuration, not persisted settings.
- No safe automated ACH return, NSF, delayed-processing, or webhook-failure simulator injection.
- No direct bank transport or inbound bank return-file processing.
- The transient `RUNNING` simulator state was not captured because the evidence script deliberately does not create an additional run solely for a screenshot.

## Final result

The Playwright run passed and created seventeen non-empty screenshots from the running local application. Dashboard, payments, real payment details, ledger, NACHA list and detail, webhook endpoint and delivery detail, merchants list and detail, settings, simulator configuration/completed/history, and responsive dashboard rendering were verified.

The only requested evidence not claimed as passed is the transient `15-simulator-running.png` state. It would require starting another real ten-payment run solely for screenshot timing; no mocked or static substitute was used.

Regenerate with:

```bash
pnpm --filter web demo:capture
```
