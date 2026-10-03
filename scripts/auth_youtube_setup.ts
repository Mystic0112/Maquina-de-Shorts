/**
 * One-time YouTube authorization (interactive). Run: npm run auth:youtube
 *
 * Opens Google's consent screen in the default browser, receives the code on a local loopback port
 * (Desktop OAuth clients accept any http://127.0.0.1:<port>), and stores the refresh token in
 * secrets/youtube.token.json (or YT_TOKEN_PATH). Tokens and client secrets are never printed.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { youtube as youtubeApi } from "@googleapis/youtube";
import { CodeChallengeMethod } from "google-auth-library";
import {
  clientSecretPath,
  createOAuthClient,
  loadClientSecret,
  saveToken,
  tokenPath,
  YOUTUBE_SCOPES,
} from "../src/orchestrator/lib/youtubeAuth.js";

const TIMEOUT_MS = 5 * 60 * 1000;

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

interface CallbackResult {
  code: string;
}

function page(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font-family:sans-serif;max-width:40em;margin:4em auto"><h2>${title}</h2><p>${body}</p></body>`;
}

/** Listens on 127.0.0.1 (random free port) for Google's redirect and resolves with the auth code. */
function waitForCode(server: Server, state: string): Promise<CallbackResult> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Tempo esgotado (5 min) esperando a autorização no navegador.")), TIMEOUT_MS);
    server.on("request", (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/") {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      if (error) {
        res.end(page("Autorização cancelada", `O Google retornou: ${error.replace(/[<>&]/g, "")}. Pode fechar esta aba.`));
        clearTimeout(timer);
        reject(new Error(`Autorização negada ou cancelada (${error}).`));
      } else if (!code || url.searchParams.get("state") !== state) {
        res.end(page("Resposta inválida", "Parâmetros ausentes ou estado inválido. Rode o comando de novo."));
        clearTimeout(timer);
        reject(new Error("Resposta do Google sem código ou com 'state' inválido."));
      } else {
        res.end(page("Pronto!", "A Máquina de Shorts foi autorizada. Pode fechar esta aba e voltar ao terminal."));
        clearTimeout(timer);
        resolve({ code });
      }
    });
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });
}

function printIntro(): void {
  say("=== Autorização do YouTube (uma vez só) ===");
  say();
  say("1. O navegador vai abrir a tela de login do Google. Entre com a conta dona do canal.");
  say('2. Vai aparecer "O Google não verificou este app". Isso é esperado (app em produção, ainda não verificado).');
  say('   Clique em "Avançado" e depois em "Acessar Máquina de Shorts (não seguro)".');
  say("3. Se a conta tiver mais de um canal, escolha o canal dos Shorts.");
  say("4. Marque TODAS as permissões (enviar vídeos, ver a conta e ver relatórios do YouTube Analytics) e clique em Continuar.");
  say("5. Quando a aba disser \"Pronto!\", volte para este terminal.");
  say();
}

async function main(): Promise<void> {
  printIntro();
  const secret = await loadClientSecret();
  if (secret.kind !== "installed") say(`Aviso: ${clientSecretPath()} não é um cliente "Desktop"; o redirecionamento local pode falhar.`);
  const server = createServer();
  const port = await listen(server);
  const redirectUri = `http://127.0.0.1:${port}`;
  const client = createOAuthClient(secret, redirectUri);
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  const state = randomBytes(16).toString("hex");
  const authUrl = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [...YOUTUBE_SCOPES],
    state,
    code_challenge: codeChallenge,
    code_challenge_method: CodeChallengeMethod.S256,
  });
  say("Abrindo o navegador. Se não abrir, copie este link:");
  say(authUrl);
  say();
  openBrowser(authUrl);
  try {
    const { code } = await waitForCode(server, state);
    const { tokens } = await client.getToken({ code, codeVerifier, redirect_uri: redirectUri });
    if (!tokens.refresh_token) {
      throw new Error(
        "O Google não devolveu refresh_token. Remova o acesso em https://myaccount.google.com/permissions e rode de novo.",
      );
    }
    await saveToken(tokens);
    client.setCredentials(tokens);
    say(`Token salvo em ${tokenPath()} (não compartilhe este arquivo).`);
    const granted = new Set((tokens.scope ?? "").split(" "));
    const missing = YOUTUBE_SCOPES.filter((s) => !granted.has(s));
    if (missing.length > 0) say(`Aviso: permissões não concedidas: ${missing.join(", ")}. Rode de novo e marque todas.`);
    const channels = await youtubeApi({ version: "v3", auth: client }).channels.list({ part: ["snippet"], mine: true });
    const channel = channels.data.items?.[0];
    say();
    if (channel?.id) {
      say(`Canal autorizado: ${channel.snippet?.title ?? "(sem título)"}`);
      say(`ID do canal: ${channel.id}`);
      say(`Coloque no .env:  YOUTUBE_CHANNEL_ID=${channel.id}`);
    } else {
      say("A conta autorizada não tem canal do YouTube. Crie o canal e rode o comando de novo.");
    }
  } finally {
    server.close();
  }
}

main().catch((error: unknown) => {
  say();
  say(`Falhou: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
