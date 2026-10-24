// Free-text rules the channel owner writes in Configurações > Roteiro (script.instructions). They go into the script prompt
// (stage 02) and the fact-check rewrite prompt (02b) below the machine's own rules: the fixed rules always win.

export const OWNER_RULES_MAX_CHARS = 1000;

/** Owner text cleaned for a prompt: no control characters, no more than one blank line in a row, bounded length. */
export function cleanOwnerRules(raw: string | undefined): string {
  return (raw ?? "")
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, OWNER_RULES_MAX_CHARS);
}

/** Prompt block (with a trailing blank line) or "" when the owner wrote nothing. */
export function ownerRulesBlock(raw: string | undefined, purpose: "script" | "revision" = "script"): string {
  const text = cleanOwnerRules(raw);
  if (!text) return "";
  const lead =
    purpose === "script"
      ? "Regras do dono do canal (siga-as no estilo e no conteúdo, desde que não contrariem NENHUMA regra acima ou abaixo: fatos, tamanho, número de cenas, formato, chamada final e imagens sempre vencem):"
      : "Regras de estilo do dono do canal (preserve-as ao reescrever; as regras de fatos, tamanho e cenas desta tarefa sempre vencem):";
  return `${lead}\n${text}\n\n`;
}
