export function environmentLabel(
  nodeEnv: string | undefined,
): "Local" | "Production" {
  return nodeEnv === "production" ? "Production" : "Local";
}
