import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NachaFilesTable } from "@/components/nacha-files/nacha-files-table";

const data = {
  merchant: { merchantCode: "DEMO_BOTH", displayName: "Northstar Paper" },
  summary: {
    filesGeneratedToday: 1,
    paymentsExported: 2,
    totalExportAmountCents: "7000",
    pendingSubmissionFiles: 0,
  },
  data: [
    {
      id: "file-001",
      fileName: "ach-260730-demo.ach",
      createdAt: "2026-07-30T12:00:00.000Z",
      effectiveEntryDate: "2026-07-30T00:00:00.000Z",
      submissionStatus: "SUBMITTED",
      totalPayments: 2,
      totalAmountCents: "7000",
      debitCount: 1,
      creditCount: 1,
      debitTotalCents: "2000",
      creditTotalCents: "5000",
      entryHash: "21000002",
      sha256: "abc123",
      exportedBy: "ACHFlow worker",
      payments: [
        {
          id: "payment-001",
          externalReference: "batch-reference",
          direction: "CREDIT",
          amountCents: "5000",
          currency: "USD",
          status: "SUBMITTED",
          exportedAt: "2026-07-30T12:00:00.000Z",
          createdAt: "2026-07-30T11:00:00.000Z",
          merchant: {
            merchantCode: "DEMO_BOTH",
            displayName: "Northstar Paper",
          },
        },
      ],
    },
  ],
};

function renderTable() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <NachaFilesTable />
    </QueryClientProvider>,
  );
}

describe("NachaFilesTable", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue({ ok: true, json: async () => data });
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:nacha"),
      revokeObjectURL: vi.fn(),
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      () => undefined,
    );
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders file summaries and metadata", async () => {
    renderTable();
    expect(await screen.findByText("ach-260730-demo.ach")).toBeInTheDocument();
    expect(screen.getAllByText("$70.00")).toHaveLength(2);
    expect(screen.getByText("Payments exported")).toBeInTheDocument();
    expect(screen.getByText("Files generated today (UTC)")).toBeInTheDocument();
    expect(screen.getByText("Created (UTC)")).toBeInTheDocument();
  });

  it("filters files and debounces search", async () => {
    renderTable();
    await screen.findByText("ach-260730-demo.ach");
    fireEvent.change(screen.getByLabelText("Submission status filter"), {
      target: { value: "SUBMITTED" },
    });
    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(
        expect.stringContaining("status=SUBMITTED"),
        expect.anything(),
      ),
    );
    await screen.findByPlaceholderText("Search file ID or file name");
    fireEvent.change(
      screen.getByPlaceholderText("Search file ID or file name"),
      { target: { value: "demo" } },
    );
    await waitFor(() =>
      expect(fetchMock).toHaveBeenLastCalledWith(
        expect.stringContaining("search=demo"),
        expect.anything(),
      ),
    );
  });

  it("opens details and downloads through the BFF", async () => {
    renderTable();
    const fileName = await screen.findByText("ach-260730-demo.ach");
    fireEvent.click(fileName);
    expect(await screen.findByText("Batch summary")).toBeInTheDocument();
    expect(screen.getByText("abc123")).toBeInTheDocument();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      blob: async () => new Blob(["nacha"]),
    });
    fireEvent.click(screen.getByRole("button", { name: "Download NACHA" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/nacha-files/file-001/download",
      ),
    );
  });
});
