/**
 * One-time Instagram authorization (interactive). Run: npm run auth:instagram
 *
 * Meta only redirects to a registered HTTPS URI, so the redirect goes to our GitHub Pages callback page
 * (docs/oauth/callback.html). That page forwards the browser to this script's loopback server
 * (http://127.0.0.1:<port>/callback); the port and a random nonce travel in `state`. If the browser
 * blocks the forward, the page shows the code and it can be pasted here. The code becomes a 60-day token
 * saved in secrets/instagram.token.json. App secret and tokens are never printed.
 */
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createInterface } from "node:readline";
import {
  AuthCallbackError,
  buildAuthorizeUrl,
  completeLogin,
  createState,
  INSTAGRAM_REDIRECT_URI,
  INSTAGRAM_SCOPES,
  instagramTokenPath,
  loadAppCredentials,
  parseCallbackInput,
  parseCallbackParams,
  type InstagramToken,
} from "../src/orchestrator/lib/instagramAuth.js";

const TIMEOUT_MS = 10 * 60 * 1000;

const say = (text = ""): void => {
  process.stdout.write(`${text}\n`);
};

function openBrowser(url: string): void {
  // `start` lives inside cmd; quoting the URL keeps its "&" from being parsed as a command separator.
  const [cmd, args] =
    process.platform === "win32"
      ? ["cmd.exe", ["/d", "/s", "/c", `"start "" "${url}""`]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsVerbatimArguments: process.platform === "win32" });
  child.on("error", () => say("(Não consegui abrir o navegador automaticamente; copie o link acima.)"));
  child.unref();
}

function page(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>${title}</title><body style="font-family:sans-serif;max-width:40em;margin:4em auto"><h2>${title}</h2><p>${body}</p></body>`;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

/** Resolves with the code from the loopback callback or from a line pasted in the terminal, whichever comes first. */
function waitForCode(server: Server, port: number, state: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin });
    const finish = (outcome: () => void): void => {
      clearTimeout(timer);
      rl.close();
      outcome();
    };
    const timer = setTimeout(() => finish(() => reject(new Error("Tempo esgotado (10 min) esperando a autorização."))), TIMEOUT_MS);
    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      // Only our own loopback host (no DNS-rebinding pages) and only the callback path.
      if (req.headers.host !== `127.0.0.1:${port}` || url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      try {
        const code = parseCallbackParams(url.searchParams, state);
        res.end(page("Pronto!", "O Instagram foi autorizado. Pode fechar esta aba e voltar ao terminal."));
        finish(() => resolve(code));
      } catch (error) {
        res.end(page("Não deu certo", "Volte ao terminal para ver o motivo e rode o comando de novo."));
        finish(() => reject(error));
      }
    });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const code = parseCallbackInput(line, state);
        finish(() => resolve(code));
      } catch (error) {
        if (error instanceof AuthCallbackError && /negada|state/.test(error.message)) finish(() => reject(error));
        else say(`${error instanceof Error ? error.message : String(error)} Tente colar de novo.`);
      }
    });
  });
}

function printIntro(): void {
  say("=== Autorização do Instagram (uma vez só) ===");
  say();
  say("1. O navegador vai abrir o login do Instagram. Entre com a conta PROFISSIONAL (Criador/Empresa) dos Reels.");
  say("2. Permita todas as permissões pedidas (perfil, publicar conteúdo e ver insights).");
  say("3. Você vai passar pela página da Máquina de Shorts no GitHub Pages, que devolve o login para este terminal.");
  say("   Se ela mostrar um código em vez de voltar sozinha, clique em \"Copiar código\" e cole aqui (Enter).");
  say();
}

function accountTypeLabel(type: string | undefined): string {
  if (type === "MEDIA_CREATOR" || type === "Media_Creator") return "Criador de conteúdo";
  if (type?.toUpperCase() === "BUSINESS") return "Empresa";
  return type ?? "desconhecido";
}

function printResult(token: InstagramToken): void {
  say();
  say(`Conta autorizada: @${token.username ?? "(sem nome)"} (${accountTypeLabel(token.accountType)})`);
  say(`Token salvo em ${instagramTokenPath()} (não compartilhe este arquivo).`);
  say(`Validade: até ${new Date(token.expiresAt).toLocaleDateString("pt-BR")}. O pipeline renova sozinho quando faltarem menos de 10 dias.`);
  const granted = new Set(token.permissions ?? []);
  const missing = INSTAGRAM_SCOPES.filter((s) => granted.size > 0 && !granted.has(s));
  if (missing.length > 0) say(`Aviso: permissões não concedidas: ${missing.join(", ")}. Rode de novo e permita todas.`);
  say();
  say("Próximo passo: ligue o Instagram em Configurações (ou \"instagram\": { \"enabled\": true } no config/pipeline.config.json).");
}

async function main(): Promise<void> {
  printIntro();
  const creds = loadAppCredentials();
  const server = createServer();
  const port = await listen(server);
  const state = createState(port);
  const authUrl = buildAuthorizeUrl(creds.appId, state);
  say(`URL de redirecionamento cadastrada no app da Meta: ${INSTAGRAM_REDIRECT_URI}`);
  say("Abrindo o navegador. Se não abrir, copie este link:");
  say(authUrl);
  say();
  openBrowser(authUrl);
  try {
    const code = await waitForCode(server, port, state);
    say("Código recebido. Trocando pelo token de 60 dias...");
    printResult(await completeLogin(code, creds));
  } finally {
    server.close();
  }
}

main().catch((error: unknown) => {
  say();
  say(`Falhou: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
