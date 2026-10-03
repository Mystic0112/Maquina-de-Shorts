// Revenue boundary. Real numbers need the YouTube Analytics API (OAuth scope
// yt-analytics-monetary.readonly), which is not implemented yet, and the channel only earns after it
// joins the YouTube Partner Program. Until then this returns an honest status: never estimated money.
import type { RevenueResult } from "../shared/api.js";

export async function getRevenue(): Promise<RevenueResult> {
  // Marco 2: load the OAuth token, call youtubeAnalytics.reports.query with metrics=estimatedRevenue,
  // return "not_monetized" when the channel has no monetary data and "ok" with real values otherwise.
  return {
    status: "not_connected",
    message:
      "Receita disponível após conectar o OAuth do YouTube (Marco 2) e o canal entrar no Programa de Parcerias.",
  };
}
