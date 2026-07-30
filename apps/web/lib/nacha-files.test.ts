import { describe, expect, it } from "vitest";
import {
  formatNachaCents,
  nachaFilesSearchParams,
  parseNachaFilesData,
} from "@/lib/nacha-files";

describe("NACHA file utilities", () => {
  it("formats bigint-safe amounts and serializes filters", () => {
    expect(formatNachaCents("123456789012345")).toBe("$1,234,567,890,123.45");
    expect(
      nachaFilesSearchParams({
        search: "batch",
        status: "SUBMITTED",
        dateRange: "7d",
        startDate: "",
        endDate: "",
      }),
    ).toBe("dateRange=7d&search=batch&status=SUBMITTED");
  });

  it("rejects malformed API responses", () => {
    expect(() => parseNachaFilesData({ data: [] })).toThrow("invalid format");
  });
});
