export const HUB_LOGO_KEYS = [
  "sparkles", "book", "brain", "database", "library", "search", "files", "code",
  "workflow", "network", "puzzle", "boxes", "layers", "bot", "wand", "lightbulb",
  "rocket", "globe", "cloud", "atom", "flask", "graduation", "briefcase", "compass",
  "gauge", "gem"
] as const;

export const HUB_LOGO_COLORS = [
  "#2563eb", "#7c3aed", "#db2777", "#dc2626", "#ea580c",
  "#ca8a04", "#16a34a", "#0d9488", "#0891b2", "#475569"
] as const;

export function normalizeHubLogo(value: unknown, fallback = "sparkles") {
  return typeof value === "string" && (HUB_LOGO_KEYS as readonly string[]).includes(value) ? value : fallback;
}

export function normalizeHubLogoColor(value: unknown, fallback = "#2563eb") {
  return typeof value === "string" && (HUB_LOGO_COLORS as readonly string[]).includes(value) ? value : fallback;
}
