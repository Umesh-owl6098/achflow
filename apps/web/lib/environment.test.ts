import { describe, expect, it } from "vitest";
import { environmentLabel } from "./environment";

describe("environmentLabel", () => {
  it("shows Production only for production deployments", () => {
    expect(environmentLabel("production")).toBe("Production");
    expect(environmentLabel("development")).toBe("Local");
    expect(environmentLabel(undefined)).toBe("Local");
  });
});
