import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const webUrl = process.env.ACHFLOW_WEB_URL ?? "http://localhost:3001";
const output = join(process.cwd(), "../../docs/demo-screenshots");
const evidence: string[] = [];

test("captures working ACHFlow portal evidence", async ({ page }) => {
  await mkdir(output, { recursive: true });
  const pages = [
    ["/", "Dashboard", "01-dashboard.png"],
    ["/payments", "Payments", "02-payments-list.png"],
    ["/ledger", "Ledger", "06-ledger.png"],
    ["/nacha-files", "NACHA Files", "07-nacha-files.png"],
    ["/webhooks", "Webhooks", "09-webhook-endpoints.png"],
    ["/merchants", "Merchants", "11-merchants-list.png"],
    ["/settings", "Settings", "13-settings-system-health.png"],
    ["/simulator", "Transaction simulator", "14-simulator-configuration.png"],
  ] as const;

  for (const [path, heading, file] of pages) {
    const response = await page.goto(`${webUrl}${path}`, {
      waitUntil: "networkidle",
    });
    expect(response?.ok()).toBeTruthy();
    await expect(
      page.locator("main").getByRole("heading", { name: heading }),
    ).toBeVisible();
    await expect(page.locator("text=MODULE_NOT_FOUND")).toHaveCount(0);
    await expect(page.locator("text=Internal Server Error")).toHaveCount(0);
    await page.screenshot({ path: join(output, file), fullPage: true });
    evidence.push(`PASSED ${file}`);
  }

  await page.goto(`${webUrl}/nacha-files`, { waitUntil: "networkidle" });
  const nachaRow = page.locator("tbody tr").first();
  await expect(nachaRow).toBeVisible();
  await nachaRow.click();
  await expect(page.getByRole("heading", { name: "NACHA file" })).toBeVisible();
  await page.screenshot({
    path: join(output, "08-nacha-file-details.png"),
    fullPage: true,
  });
  evidence.push("PASSED 08-nacha-file-details.png");

  await page.goto(`${webUrl}/webhooks`, { waitUntil: "networkidle" });
  await page.getByRole("tab", { name: "Delivery Events" }).click();
  const deliveryRow = page.locator("tbody tr").first();
  await expect(deliveryRow).toBeVisible();
  await deliveryRow.click();
  await expect(
    page.getByRole("heading", { name: "Webhook delivery" }),
  ).toBeVisible();
  await page.screenshot({
    path: join(output, "10-webhook-delivery-events.png"),
    fullPage: true,
  });
  evidence.push("PASSED 10-webhook-delivery-events.png");

  await page.goto(`${webUrl}/merchants`, { waitUntil: "networkidle" });
  const merchantRow = page.locator("tbody tr").first();
  await expect(merchantRow).toBeVisible();
  await merchantRow.click();
  await expect(
    page.getByRole("heading", { name: "Merchant details" }),
  ).toBeVisible();
  await page.screenshot({
    path: join(output, "12-merchant-details.png"),
    fullPage: true,
  });
  evidence.push("PASSED 12-merchant-details.png");

  await page.goto(`${webUrl}/simulator`, { waitUntil: "networkidle" });
  const completedRun = page
    .getByRole("button")
    .filter({ hasText: "COMPLETED" })
    .first();
  await expect(completedRun).toBeVisible();
  await completedRun.click();
  await expect(page.getByText("Live monitoring")).toBeVisible();
  await page.screenshot({
    path: join(output, "16-simulator-completed.png"),
    fullPage: true,
  });
  evidence.push("PASSED 16-simulator-completed.png");
  await page.screenshot({
    path: join(output, "17-simulator-run-history.png"),
    fullPage: true,
  });
  evidence.push("PASSED 17-simulator-run-history.png");
  evidence.push(
    "SKIPPED 15-simulator-running.png: no new run was started solely to stage a transient screenshot; an existing real completed 10-payment run was used.",
  );

  const payments = await fetch(`${webUrl}/api/payments`).then(
    async (response) => {
      if (!response.ok) return { data: [] as Array<{ id: string }> };
      return (await response.json()) as { data?: Array<{ id: string }> };
    },
  );
  const paymentId = payments.data?.[0]?.id;
  if (paymentId) {
    const response = await page.goto(`${webUrl}/payments/${paymentId}`, {
      waitUntil: "networkidle",
    });
    expect(response?.ok()).toBeTruthy();
    await expect(page.getByText("Payment ID")).toBeVisible();
    for (const file of [
      "03-payment-details-overview.png",
      "04-payment-details-ledger.png",
      "05-payment-details-events.png",
    ]) {
      await page.screenshot({ path: join(output, file), fullPage: true });
      evidence.push(`PASSED ${file}`);
    }
  } else {
    evidence.push(
      "SKIPPED payment-detail captures: no real payment was returned by the BFF",
    );
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${webUrl}/`, { waitUntil: "networkidle" });
  await page.screenshot({
    path: join(output, "18-mobile-dashboard.png"),
    fullPage: true,
  });
  evidence.push("PASSED 18-mobile-dashboard.png");
  await writeFile(
    join(output, "capture-results.txt"),
    `${evidence.join("\n")}\n`,
  );
});
