/**
 * Profile of the Claude Code CLI (`claude`) for the generic CliAgentProvider (cliAgent.ts): it spends the user's own
 * Claude plan (login done once in `claude`), never an API key. Contract of the profile: see cliAgent.ts.
 *
 * Flags confirmed on Claude Code 2.1.310 by the owner: -p, --output-format json, --json-schema, --tools "",
 * --no-session-persistence, --model, --effort. Others come from the official docs (code.claude.com/docs/en/headless,
 * cli-reference, tools-reference, errors, consulted 2026-11-02) and are "to confirm at home": --safe-mode (no
 * CLAUDE.md, hooks, skills, MCP from the user's setup; login still works), --strict-mcp-config, --disable-slash-commands,
 * --permission-mode dontAsk, --allowedTools WebSearch.
 *
 * Images: `-p` has no image flag. Like agy, the images go to the (empty) temp cwd and the built-in Read tool opens them
 * (PNG/JPEG/WebP are returned as visual content). Read inside the working directory needs no permission, and Read is
 * NOT put in --allowedTools (that would allow reading any path); outside the cwd it is denied (dontAsk).
 * Web search: tool WebSearch only, allowed explicitly (it asks permission by default); no WebFetch, no Bash.
 */
import type { ThinkingSetting } from "./llmClient.js";
import type { CliAgentMode, CliAgentOutput, CliAgentProfile } from "./cliAgent.js";

const EFFORT: Partial<Record<ThinkingSetting, string>> = { minimal: "low", low: "low", medium: "medium", high: "high" };

const TOOLS: Record<CliAgentMode, string[]> = {
  text: ["--tools", ""],
  images: ["--tools", "Read"],
  search: ["--tools", "WebSearch", "--allowedTools", "WebSearch"],
};

function resultText(result: unknown): string {
  if (typeof result === "string") return result;
  if (Array.isArray(result)) return result.map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string" ? (b as { text: string }).text : "")).join("");
  return "";
}

/** `--output-format json` prints one result object (older builds: an array of messages whose last item is the result). */
export function parseClaudeOutput(stdout: string): CliAgentOutput | undefined {
  let json: unknown;
  try {
    json = JSON.parse(stdout.trim());
  } catch {
    return undefined;
  }
  const msg = (Array.isArray(json) ? [...json].reverse().find((m) => m && typeof m === "object" && (m as { type?: unknown }).type === "result") : json) as
    | Record<string, unknown>
    | undefined;
  if (!msg || typeof msg !== "object") return undefined;
  const usage = msg["usage"] as Record<string, unknown> | undefined;
  const n = (v: unknown): number => (typeof v === "number" ? v : 0);
  const subtype = msg["subtype"];
  return {
    isError: msg["is_error"] === true || (typeof subtype === "string" && subtype.startsWith("error")),
    ...(msg["structured_output"] !== undefined ? { structured: msg["structured_output"] } : {}),
    text: resultText(msg["result"]),
    ...(usage
      ? { usage: { inputTokens: n(usage["input_tokens"]) + n(usage["cache_creation_input_tokens"]) + n(usage["cache_read_input_tokens"]), outputTokens: n(usage["output_tokens"]) } }
      : {}),
  };
}

export const CLAUDE_CODE_PROFILE: CliAgentProfile = {
  provider: "claude-code",
  command: "claude",
  pathEnv: "CLAUDE_CLI_PATH",
  modelEnv: "CLAUDE_CLI_MODEL",
  // Alias resolved by the CLI to the plan's current Sonnet; any alias or full model id works.
  defaultModel: "sonnet",
  // Only a folder (not a secret): lets the CLI find a login kept outside ~/.claude. HOME/USERPROFILE already pass.
  extraEnv: ["CLAUDE_CONFIG_DIR"],
  // With any of these the CLI would bill the API (or another cloud) instead of the plan.
  neverEnv: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"],
  baseArgs: [
    "-p",
    "--output-format", "json",
    "--no-session-persistence",
    "--safe-mode",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--permission-mode", "dontAsk",
  ],
  toolArgs: (mode) => TOOLS[mode],
  schemaArgs: (schemaJson) => ["--json-schema", schemaJson],
  modelArgs: (model) => (model ? ["--model", model] : []),
  effortArgs: (thinking) => (EFFORT[thinking] ? ["--effort", EFFORT[thinking]!] : []),
  directInstruction: "Responda diretamente, sem usar ferramentas.",
  imagePrompt: (files, prompt) =>
    [
      files.length === 1
        ? "Examine o seguinte arquivo de imagem usando APENAS a ferramenta Read (nenhuma outra ferramenta, nenhum outro arquivo):"
        : `Examine TODOS os ${files.length} arquivos de imagem abaixo usando APENAS a ferramenta Read (nenhuma outra ferramenta, nenhum outro arquivo). Eles estão na ordem em que são numerados nas instruções ("image 1" = o primeiro arquivo, "image 2" = o segundo, e assim por diante); arquivos diferentes podem pertencer a candidatos diferentes:`,
      ...files.map((f, i) => `- image ${i + 1}: "${f}"`),
      "",
      prompt,
      "",
      "Responda somente com o JSON correspondente.",
    ].join("\n"),
  searchPrompt: (prompt) =>
    [
      "Antes de responder, pesquise na web (use a ferramenta WebSearch) para fundamentar a resposta.",
      "Não use nenhuma outra ferramenta: só a busca na web e a sua resposta.",
      "Responda em JSON com: text (a resposta completa), sources (as páginas consultadas, cada uma com uri = URL completa e title)",
      "e queries (as buscas que você fez). Se não conseguir pesquisar, responda mesmo assim com sources vazio.",
      "",
      prompt,
    ].join("\n"),
  parseOutput: parseClaudeOutput,
  authErrorPattern: /not logged in|please run \/login|invalid api key|authentication[_ ]failed|oauth token (?:has )?expired/i,
  missingCommandMessage: (cliPath) =>
    `Claude Code (${cliPath}) não encontrado ou não executável: instale o Claude Code (instalador nativo; no Windows o claude.exe), entre com a sua conta do plano e deixe o comando claude no PATH, ou aponte CLAUDE_CLI_PATH para ele. Se --safe-mode não for reconhecido, atualize o Claude Code.`,
};
