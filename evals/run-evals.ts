const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { dirname, resolve } = require("node:path");
const { spawnSync } = require("node:child_process");

type Category =
  "deterministic" | "consistency" | "regex" | "red-team" | "regression";
type Status = "PASS" | "FAIL" | "SKIPPED";

type EvalResult = {
  name: string;
  category: Category;
  status: Status;
  durationMs: number;
  assertionsPassed: number;
  assertionsFailed: number;
  evidenceIds: string[];
  failureReason: string | null;
};

type CommandEvaluation = {
  name: string;
  category: Category;
  command: string[];
  evidenceIds: string[];
};

const root = process.cwd();
const outputPath = resolve(root, "evals/results/latest.json");
const markdownPath = resolve(root, "evals/results/latest.md");
const categories: Category[] = [
  "deterministic",
  "consistency",
  "regex",
  "red-team",
  "regression",
];

const evaluations: CommandEvaluation[] = [
  {
    name: "persisted payment lifecycle state machine",
    category: "deterministic",
    command: [
      "pnpm",
      "--filter",
      "worker",
      "test:e2e",
      "--",
      "outbox-worker.e2e-spec.ts",
    ],
    evidenceIds: [
      "worker-postgres-lifecycle",
      "reservation-entry-keys",
      "return-idempotency",
    ],
  },
  {
    name: "100-request and concurrent payment creation idempotency",
    category: "consistency",
    command: [
      "pnpm",
      "--filter",
      "api",
      "test:e2e",
      "--",
      "payments-idempotency.e2e-spec.ts",
    ],
    evidenceIds: [
      "api-postgres-idempotency-100",
      "merchant-scoped-idempotency",
    ],
  },
  {
    name: "NACHA fixed-width regex and independent control totals",
    category: "regex",
    command: [
      "pnpm",
      "--filter",
      "worker",
      "test:e2e",
      "--",
      "outbox-worker.e2e-spec.ts",
    ],
    evidenceIds: ["nacha-94-column", "nacha-controls", "nacha-filler-blocks"],
  },
  {
    name: "merchant isolation, rate limits, duplicate effects, and webhook signing",
    category: "red-team",
    command: [
      "pnpm",
      "--filter",
      "api",
      "test:e2e",
      "--",
      "payments-idempotency.e2e-spec.ts",
    ],
    evidenceIds: [
      "cross-merchant-404",
      "merchant-rate-limit-429",
      "api-key-authentication",
    ],
  },
  {
    name: "worker replay, concurrent lifecycle, and webhook signature resistance",
    category: "red-team",
    command: [
      "pnpm",
      "--filter",
      "worker",
      "test:e2e",
      "--",
      "outbox-worker.e2e-spec.ts",
    ],
    evidenceIds: ["outbox-replay", "concurrent-reservation", "webhook-hmac"],
  },
  {
    name: "canonical response, ledger, and NACHA regression contract",
    category: "regression",
    command: [
      "pnpm",
      "--filter",
      "api",
      "test:e2e",
      "--",
      "payments-idempotency.e2e-spec.ts",
    ],
    evidenceIds: [
      "payment-response-contract",
      "ledger-summary-contract",
      "nacha-api-contract",
    ],
  },
  {
    name: "canonical lifecycle, ledger, and NACHA generator regression contract",
    category: "regression",
    command: [
      "pnpm",
      "--filter",
      "worker",
      "test:e2e",
      "--",
      "outbox-worker.e2e-spec.ts",
    ],
    evidenceIds: ["nacha-generator-contract", "lifecycle-outbox-contract"],
  },
];

function selectedCategories(): Category[] {
  const categoryIndex = process.argv.indexOf("--category");
  if (process.argv.includes("--all")) return categories;
  if (categoryIndex === -1 || !process.argv[categoryIndex + 1]) {
    throw new Error("Use --all or --category <category>.");
  }
  const category = process.argv[categoryIndex + 1] as Category;
  if (!categories.includes(category)) {
    throw new Error(`Unsupported evaluation category: ${category}`);
  }
  return [category];
}

function fixtureChecks(): void {
  const payment = JSON.parse(
    readFileSync(
      resolve(root, "evals/fixtures/regression/payment-api-response.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  const ledger = JSON.parse(
    readFileSync(
      resolve(root, "evals/fixtures/regression/ledger-summary.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  const nacha = JSON.parse(
    readFileSync(
      resolve(root, "evals/fixtures/regression/nacha-file.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;

  for (const field of [
    "id",
    "amountCents",
    "currency",
    "status",
    "createdAt",
    "updatedAt",
  ]) {
    if (!(field in payment))
      throw new Error(`payment regression fixture misses ${field}`);
  }
  for (const field of [
    "totalCreditsCents",
    "totalDebitsCents",
    "netPositionCents",
  ]) {
    if (!(field in ledger))
      throw new Error(`ledger regression fixture misses ${field}`);
  }
  if (nacha.recordWidth !== 94 || nacha.recordCountMultiple !== 10) {
    throw new Error(
      "NACHA regression fixture has an invalid fixed-width contract.",
    );
  }
}

function parsePassedAssertions(output: string): number {
  const match = output.match(/Tests:\s+(\d+) passed/);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function runEvaluation(evaluation: CommandEvaluation): EvalResult {
  const startedAt = Date.now();
  if (evaluation.category === "regression") fixtureChecks();
  const command = spawnSync(
    evaluation.command[0],
    evaluation.command.slice(1),
    {
      cwd: root,
      encoding: "utf8",
      env: process.env,
    },
  );
  const output = `${command.stdout ?? ""}\n${command.stderr ?? ""}`;
  const passed = parsePassedAssertions(output);
  const failed = command.status === 0 ? 0 : 1;
  const failureReason =
    command.status === 0
      ? null
      : output.trim().split("\n").slice(-12).join("\n").slice(0, 2_000);
  return {
    name: evaluation.name,
    category: evaluation.category,
    status: command.status === 0 ? "PASS" : "FAIL",
    durationMs: Date.now() - startedAt,
    assertionsPassed: passed,
    assertionsFailed: failed,
    evidenceIds: evaluation.evidenceIds,
    failureReason,
  };
}

function markdown(results: EvalResult[]): string {
  const rows = results.map(
    (result) =>
      `| ${result.category} | ${result.name} | ${result.status} | ${result.durationMs} | ${result.assertionsPassed} | ${result.assertionsFailed} | ${result.evidenceIds.join(", ")} |`,
  );
  return [
    "# ACHFlow evaluation results",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "| Category | Evaluation | Status | Duration (ms) | Assertions passed | Assertions failed | Safe evidence IDs |",
    "| --- | --- | --- | ---: | ---: | ---: | --- |",
    ...rows,
    "",
    ...results
      .filter((result) => result.failureReason)
      .flatMap((result) => [
        `## ${result.name} failure`,
        "",
        "```text",
        result.failureReason!,
        "```",
        "",
      ]),
  ].join("\n");
}

try {
  const selected = selectedCategories();
  const results = evaluations
    .filter((evaluation) => selected.includes(evaluation.category))
    .map(runEvaluation);
  const report = {
    generatedAt: new Date().toISOString(),
    selectedCategories: selected,
    totals: {
      PASS: results.filter((result) => result.status === "PASS").length,
      FAIL: results.filter((result) => result.status === "FAIL").length,
      SKIPPED: results.filter((result) => result.status === "SKIPPED").length,
    },
    results,
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(markdownPath, `${markdown(results)}\n`);
  process.stdout.write(`Evaluation report: ${outputPath}\n`);
  process.stdout.write(
    `Evaluation summary: PASS=${report.totals.PASS} FAIL=${report.totals.FAIL} SKIPPED=${report.totals.SKIPPED}\n`,
  );
  if (report.totals.FAIL > 0) process.exitCode = 1;
} catch (error) {
  const message =
    error instanceof Error
      ? error.message
      : "Unknown evaluation runner failure";
  process.stderr.write(`Evaluation runner failed: ${message}\n`);
  process.exitCode = 1;
}
