// Pipeline falso para testar scheduler/run_once.ps1 sem tocar no pipeline real.
// Uso: MAQUINA_SCHEDULER_TEST=ok|fail|quality|hang (o wrapper chama: node fake_pipeline.mjs <modo>)
import { spawn } from "node:child_process";

const mode = process.argv[2] ?? "ok";
const runId = "19990101-000000-te57";
const log = (level, msg) => console.log(`${new Date().toISOString()} [${level}] ${msg}`);

log("INFO", `Run ${runId} (fake ${mode}) -> render_output/${runId} (nenhum arquivo é criado)`);

switch (mode) {
  case "ok":
    log("INFO", `Run ${runId} finished (fake)`);
    process.exit(0);
  case "quality":
    console.error(`Pipeline failed: QUALITY GATE: no publishable video after 2 attempt(s) (${runId}); last: fake`);
    process.exit(3);
  case "fail":
    // Segredo falso: o wrapper precisa mascará-lo no alerta.
    console.error("Pipeline failed: falha simulada (teste do agendador) GEMINI_API_KEY=AIzaFAKEfakeFAKEfakeFAKEfake0123456789");
    process.exit(1);
  case "hang": {
    // Filho também preso: prova que o timeout mata a árvore inteira.
    spawn(process.execPath, ["-e", "setInterval(() => {}, 1000) // maquina-scheduler-test-hang-child"], { stdio: "ignore" });
    log("INFO", "travado de propósito (maquina-scheduler-test-hang)");
    setInterval(() => {}, 1000);
    break;
  }
  default:
    console.error(`modo desconhecido: ${mode}`);
    process.exit(1);
}
