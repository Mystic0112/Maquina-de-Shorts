// Publishing platforms. Dependency-free (no Node imports) so browser code (dashboard) can import it.
export const PLATFORMS = ["youtube", "instagram", "tiktok"] as const;
export type Platform = (typeof PLATFORMS)[number];
