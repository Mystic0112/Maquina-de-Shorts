# AGENTS.md — instruções para o agente que mantém este projeto

Este arquivo é lido automaticamente pelo Antigravity CLI (e por Gemini CLI, Codex e outros agentes). Leia-o inteiro antes de mudar qualquer coisa. Depois leia `README.md` (funcionamento, comandos, configuração) e os planos em `planejamento/`.

## O que é

"Máquina de Shorts": pipeline autônomo que produz Shorts de curiosidades em pt-BR (história, ciência, espaço) e publica no YouTube **sem revisão humana**. Roda no PC Windows do dono (Hélio), agendado pelo Agendador de Tarefas. O dono não é programador profissional: explique decisões em português simples e peça confirmação antes de qualquer coisa que publique, gaste dinheiro ou mexa em contas.

Em produção tudo roda com a API do Gemini (`LLM_PROVIDER=gemini`): roteiro, checagem de fatos, avaliação de imagens, metadados e narração (Gemini TTS). Nenhuma parte depende do Claude.

## Mapa rápido

| Caminho | O quê |
|---|---|
| `src/orchestrator/runPipeline.ts` | orquestra os estágios; retomada (`--resume`), `--until`, `--fixture`, novas tentativas de tema |
| `src/orchestrator/stages/` | 01 tema · 02 roteiro · 02b checagem de fatos · 03 imagens · 04 voz · 05 legendas · 06 render · 07 metadados · 08 publicação |
| `src/orchestrator/publishers/` | publicadores plugáveis (`youtube.ts` em uso, `instagram.ts` pronto e desligado); travas compartilhadas em `gates.ts` e `runner.ts` |
| `src/orchestrator/lib/` | cliente LLM, Gemini TTS, ffmpeg, relevância, redação de segredos, trava de arquivo, retenção, hashes de conteúdo |
| `src/remotion/` | composição do vídeo (tomadas, texto de capa, legendas, movimento) |
| `src/shared/settings.ts` | esquemas e padrões das configurações (fonte da verdade dos padrões) |
| `python/tts/` | Gemini TTS: corte de pausas e alinhamento de palavras (faster-whisper `base`, cache em `models/`); edge-tts legado |
| `vendor/openmontage_adapter/fetch_footage.py` | busca de imagens/vídeos com filtro de licença; usa código AGPL do OpenMontage — **só via subprocesso**, nunca importar em `src/` ou `python/` |
| `dashboard/` | painel local React (`npm run dashboard`, http://localhost:5180), inclui a aba Configurações |
| `scheduler/` | scripts do Agendador do Windows (`register_task.ps1`, `unregister_task.ps1`, `status.ps1`, `run_once.ps1`) |
| `config/pipeline.config.json`, `config/topics.seed.json` | configuração do dono (versionada) |
| `docs/` | **público** no GitHub Pages: página inicial, privacidade, termos, callback OAuth. Nunca colocar nada privado aqui |
| `planejamento/` | planos (Marco 4: TikTok e Instagram) |

## Regras inegociáveis

1. **Segredos:** nunca imprima, registre em log nem commite o conteúdo de `.env`, `secrets/` (tokens OAuth do YouTube/Instagram, client secret) ou chaves de API. Antes de todo commit, rode a varredura e **bloqueie** se acusar algo:
   ```bash
   git diff --cached --name-only -z | xargs -0 grep -lE 'AIza[0-9A-Za-z_-]{30,}|sk-ant-[0-9A-Za-z_-]{20,}|GOCSPX-|IGAA[0-9A-Za-z_-]{30,}|-----BEGIN [A-Z ]*PRIVATE KEY'
   ```
   Os testes têm valores falsos de propósito (`AIzaFAKE…`, `GOCSPX-FAKE…`, `IGAAfake…`); confirme que é falso antes de seguir. Também nunca commitar `render_output/`, `logs/`, `data/history.json`, `models/`, vídeos ou áudios.
2. **Publicação:** só o dono decide ligar o upload (`upload.enabled`, `instagram.enabled`) ou registrar o agendador. Nunca publique, nem como teste, sem confirmação explícita dele naquela conversa.
3. **Não enfraqueça as travas:** checagem de fatos, trava de qualidade (≥60% das cenas com imagem aprovada), filtro de licença (só domínio público, CC0, CC BY; NASA só com crédito atribuído à NASA), créditos CC BY com autor + link + "(recortado e editado)", hashes que prendem aprovações ao conteúdo, diário anti-duplicata, limite diário, trava de arquivo. Se uma trava atrapalhar, explique ao dono em vez de contorná-la.
4. **Testes antes de commit:** `npx tsc -p tsconfig.json --noEmit`, `npx vitest run`, `cd dashboard && npm run typecheck`, e `.venv\Scripts\python.exe -m unittest discover -s python/tts -p "test_*.py"`. Tudo verde.
5. **Faça o que foi pedido, nada além.** Prefira editar arquivos existentes. Leia antes de editar. Commits em português, descrevendo o porquê.

## Comandos

```bash
npm run pipeline                                   # gera (e publica, se ligado) um vídeo
npm run pipeline -- --until 06-renderVideo         # gera sem publicar
npm run pipeline -- --resume <runId>               # retoma uma execução
npm run stage -- <estágio> --run <runId>           # reexecuta um estágio
npm run dashboard                                  # painel em http://localhost:5180
npm run auth:youtube                               # login do YouTube (feito; refazer se o token cair)
npm run auth:instagram                             # login do Instagram (falta configurar o app na Meta)
powershell -NoProfile -ExecutionPolicy Bypass -File .\scheduler\status.ps1
```

Códigos de saída do pipeline: `0` ok, `1` erro, `3` nenhum vídeo publicável (trava de qualidade/fatos; não é falha).

## Ambiente (Windows)

- Git Bash converte caminhos que começam com `/` em argumentos (use `MSYS_NO_PATHCONV=1` quando precisar).
- O ffmpeg disponível é o do Remotion (`node_modules/@remotion/compositor-win32-x64-msvc/ffmpeg.exe`), versão reduzida: sem `hstack`, `fps`, `setsar`, `silenceremove`.
- `tsx watch` trava se a entrada padrão estiver aberta: em processos sem terminal use `npm run dev < NUL` dentro de `dashboard/`.
- Python do projeto: `.venv\Scripts\python.exe` (3.13).

## Estado em 2026-10-12

- **Pausado pelo dono:** tarefa do agendador removida e `upload.enabled: false` (privacidade configurada como `public`). Canal autorizado: "C9hesky ft" (`YOUTUBE_CHANNEL_ID` no `.env`). Primeiro upload de teste (não listado) funcionou sem trava de privado.
- **Feito recentemente:** lote 1 de melhorias de conteúdo (gancho, texto de capa, formatos, loop, imagens específicas com checagem de época, ritmo de 4,5 s por tomada, legendas) e troca da voz para Gemini TTS (`voice.engine: gemini`, voz `Fenrir`; edge-tts foi bloqueado pela Microsoft e não tem licença comercial).
- **Pendências:**
  1. A amostra de voz do painel (`dashboard/server/voices.ts`) ainda chama o edge-tts e espera `narration.mp3`; precisa listar e gerar amostras das vozes do Gemini.
  2. `02-generateScript.ts` estima a duração do gancho com `LETTERS_PER_SECOND = 16` (velocidade do edge-tts); medir de novo com o Gemini (~17–18).
  3. Comentário desatualizado em `types.ts` (`audioPath` "narration.mp3"; agora é `narration.wav`).
  4. Decisão do dono: TikTok/Instagram (ver `planejamento/marco-4-tiktok-instagram.md`; pesquisa recomendou testar Zernio grátis ou Upload-Post pago para o TikTok, que pela API direta só posta privado; o Instagram direto precisa de vídeo em URL pública ou de um intermediário).
  5. Configurar o app na Meta (conta Instagram Profissional, Instagram Tester, URI `https://mystic0112.github.io/Maquina-de-Shorts/oauth/callback.html`).
  6. Lote 2 de conteúdo (trilha e efeitos com licença verificada, gráficos próprios) — só com aprovação do dono.
  7. Para religar: `upload.enabled: true` em Configurações e `scheduler\register_task.ps1` (09:00/18:00). A auditoria sugeriu 11:45 e 18:45 para o público brasileiro.

## Pasta `.claude/`

Agentes e configuração usados pelo Claude Code durante o desenvolvimento (personas de QA, DevOps, scripting e quatro especialistas de marketing em vídeo curto). Não afetam a execução. As instruções desses especialistas em `.claude/agents/*.md` podem ser reaproveitadas como referência para auditorias de conteúdo.
