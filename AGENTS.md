# AGENTS.md — instruções para o agente que mantém este projeto

Lido automaticamente pelo Antigravity CLI, Gemini CLI, Codex e Claude. Leia inteiro antes de mudar qualquer coisa. Depois leia `README.md` (fonte da verdade do funcionamento, comandos e configuração) e os planos em `planejamento/`.

## O que é

"Máquina de Shorts": pipeline autônomo que produz Shorts de curiosidades em pt-BR (história, ciência, espaço) e publica no YouTube (e, quando ligado, Instagram) **sem revisão humana**. Produção no PC Windows de casa do dono (Hélio, RTX 3050), disparada pelo Agendador de Tarefas; o Linux serve para desenvolvimento. O dono não é programador profissional: explique decisões em português simples e peça confirmação antes de qualquer coisa que publique, gaste dinheiro ou mexa em contas.

**Custo zero de API.** Em produção a IA roda pelo Antigravity CLI (`agy`) com os créditos do plano: `LLM_PROVIDER=antigravity-cli`, `ANTIGRAVITY_FALLBACK=none`. Modelo por etapa em `llm.models` do `config/pipeline.config.json` (Argon no roteiro, Flash na checagem de fatos e nas imagens). Voz local **Kokoro** (`voice.engine: "kokoro"`, `KOKORO_PYTHON` no `.env`). Os modelos Claude/GPT dentro do `agy` gastam um saldo separado de "AI credits" que acabou no teste: **não use** sem o dono confirmar. A API paga do Gemini (`LLM_PROVIDER=gemini`, Gemini TTS) só como alternativa explícita do dono.

## Mapa rápido

| Caminho | O quê |
|---|---|
| `src/orchestrator/runPipeline.ts` | orquestra os estágios; `--resume`, `--until`, `--fixture`, novas tentativas de tema |
| `src/orchestrator/stages/` | 01 tema · 02 roteiro · 02b checagem de fatos · 03 imagens · 04 voz · 05 legendas · 05b memes (`05b-planEdits.ts`, desligado) · 06 render · 07 metadados · 08 publicação |
| `src/orchestrator/publishers/` | `youtube.ts` em uso, `instagram.ts` pronto e desligado; travas em `gates.ts` e `runner.ts` |
| `src/orchestrator/lib/` | cliente LLM, ffmpeg, relevância, redação de segredos, trava de arquivo, retenção, hashes de conteúdo |
| `src/orchestrator/lib/antigravityCli.ts` + `antigravitySession.ts` | chamada isolada ao `agy` e sessão contínua (`ANTIGRAVITY_CLI_SESSION_TURNS`) |
| `src/orchestrator/lib/beats.ts` | trechos da fala (*beats*): uma busca de imagem por trecho |
| `src/orchestrator/lib/verdictLog.ts` + `scripts/export_verdicts_dataset.ts` | grava `footage_verdicts.jsonl` e exporta o dataset do juiz de imagem local (LlamaFactory) |
| `src/orchestrator/cuts/`, `python/cuts/`, `scripts/cuts.ts` | cortes (Onda 4): YouTube ou TikTok, download, transcrição, seleção, conferência de sentido, cortes secos (`jumpcut.ts`), humor (`humor.ts`), compilações de vídeos curtos (`compilation.ts`), recorte vertical; **não publica** |
| `src/orchestrator/viral/`, `scripts/collect_shorts_stats.ts`, `scripts/build_viral_dataset.ts`, `python/viral/` | dados públicos de Shorts de outros canais (título + views, sem baixar vídeo) para treinar o Laya a prever o que viraliza; tudo em `data/datasets/viral/` e `models/laya-viral/`, fora do git |
| `scripts/memes.ts`, `assets/memes/` | biblioteca de memes e sons (Onda 2); só `inventory.json` é versionado |
| `src/remotion/` | composição do vídeo (tomadas, capa, legendas, movimento, camada de memes) |
| `src/shared/settings.ts` | esquemas e padrões das configurações |
| `python/tts/` | Kokoro, corte de pausas, alinhamento (faster-whisper `base`, cache em `models/`); edge-tts legado |
| `vendor/openmontage_adapter/fetch_footage.py` | busca de imagens com filtro de licença; código AGPL — **só via subprocesso**, nunca importar em `src/` ou `python/` |
| `dashboard/` | painel local React (`npm run dashboard`, http://localhost:5180) com a aba Configurações |
| `scheduler/` | scripts do Agendador do Windows |
| `config/pipeline.config.json`, `config/topics.seed.json`, `config/cuts.example.json` | configuração (o `config/cuts.json` real fica fora do git) |
| `docs/` | **público** no GitHub Pages. Nunca colocar nada privado aqui |
| `planejamento/` | planos dos marcos 4 e 5 |

## Regras inegociáveis

1. **Segredos:** nunca imprima, registre em log nem commite `.env`, `secrets/` (tokens OAuth, client secret) ou chaves de API. Antes de todo commit, rode a varredura e **bloqueie** se acusar algo:
   ```bash
   git diff --cached --name-only -z | xargs -0 grep -lE 'AIza[0-9A-Za-z_-]{30,}|sk-ant-[0-9A-Za-z_-]{20,}|GOCSPX-|IGAA[0-9A-Za-z_-]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY'
   ```
   Os testes têm valores falsos de propósito (`AIzaFAKE…`, `GOCSPX-FAKE…`, `IGAAfake…`); confirme que é falso antes de seguir. Nunca commitar `render_output/`, `logs/`, `data/history.json`, `models/`, vídeos ou áudios.
2. **`agy` isolado:** sempre com `--sandbox`, pasta temporária só com as imagens da chamada e ambiente sem chaves. **Nunca** `--dangerously-skip-permissions` nem regra que libere comandos: ele lê imagens baixadas da internet.
3. **Publicação:** só o dono liga `upload.enabled`, `instagram.enabled` ou registra o agendador. Nunca publique, nem como teste, sem confirmação explícita dele naquela conversa.
4. **Não enfraqueça as travas:** checagem de fatos, trava de qualidade (≥60% das cenas com imagem aprovada), filtro de licença (domínio público, CC0, CC BY, Pexels/Pixabay; NASA só com crédito da NASA), créditos CC BY com autor + link + "(recortado e editado)", hashes que prendem aprovações ao conteúdo, diário anti-duplicata, limite diário, trava de arquivo. **Cortes** só de canais ligados pelo dono (`enabled: true`) e fora de `blocked` em `config/cuts.json`; nunca mudar o sentido da fala nem desmoralizar ninguém (a conferência `verifyPicks` descarta o trecho); canal que reclamar vai para `blocked`. **Memes** só com licença da lista permitida (ver README). Se uma trava atrapalhar, explique ao dono em vez de contorná-la.
5. **Testes antes de commit** (tudo verde): `npx tsc -p tsconfig.json --noEmit`, `npx vitest run`, `cd dashboard && npm run typecheck`, e com o Python do projeto `-m unittest discover -s python/tts -p "test_*.py"`, `-m unittest discover -s python/cuts -p "test_*.py"` e `-m unittest discover -s python/viral -p "test_*.py"`.
6. **Faça o que foi pedido, nada além.** Prefira editar arquivos existentes. Leia antes de editar. Commits em português, descrevendo o porquê.

## Coordenação entre agentes

O dono usa várias sessões de IA no mesmo repositório (PC de casa e PC Linux).

- Antigravity trabalha em branch próprio (`antigravity/*`). Ninguém commita direto no `main` sem revisão.
- Nunca mude `upload.enabled`, `instagram.enabled`, o agendador, contas ou `secrets/` (já aconteceu do Antigravity ligar o Instagram sozinho).
- O `config/pipeline.config.json` do PC de produção tem ajustes locais não commitados: não sobrescreva.
- `git pull` só entre vídeos, nunca no meio de uma execução.

## Comandos

```bash
npm run pipeline                                   # gera (e publica, se ligado) um vídeo
npm run pipeline -- --until 06-renderVideo         # gera sem publicar
npm run pipeline -- --resume <runId>               # retoma uma execução
npm run stage -- <estágio> --run <runId>           # refaz um estágio
npm run dashboard                                  # painel em http://localhost:5180
npm run cuts -- --scan                             # cortes dos canais autorizados (não publica)
npm run memes -- list                              # biblioteca de memes (check, demo, add-*)
npx tsx scripts/export_verdicts_dataset.ts --out data/datasets/vision_judge --min-runs 1
npm run auth:youtube / npm run auth:instagram      # logins (uma vez)
powershell -NoProfile -ExecutionPolicy Bypass -File .\scheduler\status.ps1
```

Saída do pipeline e dos cortes: `0` ok, `1` erro, `3` nada publicável/nada a fazer (não é falha). `scripts/test_agy_relevance.ts` usa a API paga do Gemini: só com OK do dono.

## Ambiente

- Produção: Windows de casa (RTX 3050). Desenvolvimento: Linux. O agendador é só do Windows.
- **Nada é baixado no Linux** (vídeos, modelos, pesos, mídia de teste): downloads, transcrições e renders de teste rodam no PC de casa. Se algo for baixado aqui por engano, apague depois.
- Python do projeto: `.venv\Scripts\python.exe` no Windows, `.venv/bin/python` no Linux. Kokoro em venv separado (`KOKORO_PYTHON`); cortes em `.venv-cuts` (`CUTS_PYTHON`).
- `yt-dlp` precisa estar atualizado (versão velha leva 403 do YouTube).
- O ffmpeg é o do Remotion, versão reduzida: sem `hstack`, `fps`, `setsar`, `silenceremove`.
- Windows: Git Bash converte argumentos que começam com `/` (use `MSYS_NO_PATHCONV=1`); `tsx watch` trava com a entrada aberta, em processo sem terminal use `npm run dev < NUL` dentro de `dashboard/`.

## Estado em 2026-10-22

- Loop de teste rodando no PC de casa **sem publicar**: `upload.enabled: false`, tarefa do agendador removida. Canal autorizado: "C9hesky ft" (`YOUTUBE_CHANNEL_ID` no `.env`).
- Planejamento vivo: ClickUp, lista **"Máquina de Shorts"**, e `planejamento/`.
- **Pendências:**
  1. Habilitar Serve/HTTPS do Tailscale na conta do dono (painel remoto).
  2. Cortes: trava trocada em 22/10 (canal ligado + bloqueio; link opcional). Falta o dono ligar o ACF em casa e a transcrição usar a GPU (`CUTS_WHISPER_DEVICE=cuda` no `.env` de casa).
  3. Instalar `@remotion/lottie` — só com OK do dono.
  4. Feito em 22/10: estágio 07 dos cortes (`src/orchestrator/cuts/metadata.ts`, crédito + link do original sempre na descrição) e cortes no loop (`-CutsEveryHours`). Publicar cortes continua decisão do dono.
  5. Feito em 22/10: Kokoro medido em 13,8 letras/s (13 execuções, narração 58–71 s), `LETTERS_PER_SECOND = 14`. Remedir se trocar de voz ou velocidade.
  6. Configurar o app na Meta com conta dedicada (passo a passo no README).
  7. Decisão do dono sobre o TikTok (`planejamento/marco-4-tiktok-instagram.md`).
  8. Marco 5: 15 contas independentes (`planejamento/marco-5-multicontas-e-antigravity.md`).
  9. Treinar o juiz de imagem local com `footage_verdicts.jsonl` (LlamaFactory).
  10. Amostra de voz do painel (`dashboard/server/voices.ts`) ainda usa o edge-tts; trocar por Kokoro/Gemini.

## Pasta `.claude/`

Agentes e configuração do Claude Code para desenvolvimento (QA, DevOps, scripting, especialistas de marketing em vídeo curto). Não afetam a execução; `.claude/agents/*.md` serve de referência para auditorias de conteúdo.
