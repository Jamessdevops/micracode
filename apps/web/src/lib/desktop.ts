export function isDesktop(): boolean {
  return typeof window !== "undefined" && Boolean((window as unknown as Record<string, unknown>).__MICRACODE_DESKTOP__);
}
