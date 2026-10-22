# Marco 5 — 15 contas independentes e Antigravity CLI como motor de IA

Decisões do dono (2026-10-12):
- **~15 contas independentes** (YouTube Shorts, TikTok e Instagram), **2 vídeos por dia cada**, conteúdo próprio por conta (≈ 30 vídeos únicos/dia). Nunca o mesmo vídeo ou roteiro em duas contas.
- **Testar o Antigravity CLI** (conta Google AI Pro do dono) como motor das chamadas de IA no lugar da API paga, antes de migrar.
- O dono confere tudo à noite e aceita consertar falhas no dia seguinte.

## Parte A — teste de viabilidade do Antigravity CLI (fazer primeiro)

Estado em 2026-10-12: o comando `antigravity` (`D:\Antigravity\...`) é o **editor**. O **Antigravity CLI** está instalado: `%LOCALAPPDATA%\agy\bin\agy.exe` (v1.3.3; pode não estar no PATH de terminais antigos). Já verificado: `agy -p "<prompt>" --output-format json --print-timeout 90s < /dev/null` roda sem interação com o login em cache e devolve `{"status":"SUCCESS","response":"…","usage":{…}}`. Uma chamada trivial levou **13 s** e consumiu **~13.100 tokens de entrada** (instruções internas do agente) — a 1.350 chamadas/dia isso é ~5 h em série e muita cota; medir paralelismo e os limites reais do AI Pro. Ainda falta verificar:

1. Modo não-interativo: recebe um prompt por argumento ou stdin e sai com código de saída (sem pedir confirmação).
2. Entrada de imagens (até 3 quadros por chamada) e saída em JSON validável.
3. Login persistente sem intervenção (o agendador roda sem ninguém na frente do PC).
4. Limites do Google AI Pro por minuto e por dia frente ao volume: ~45 chamadas por vídeo × 30 vídeos = **~1.350 chamadas/dia**, mais ~30 narrações e ~180 buscas na web.
5. Termos de uso do Google AI Pro/Antigravity para uso automatizado (decisão do dono; registrar o que diz).

Implementação do teste: novo provedor `LLM_PROVIDER=antigravity-cli` em `src/orchestrator/lib/llmClient.ts`, ligado só para a avaliação de imagens (`footage.relevance`) por configuração. Rodar com ~20 imagens que já têm nota do Gemini via API (estão nos `context.json` de `render_output/`) e medir: concordância de notas, falhas, tempo por chamada, se a cota aguenta. **Critério para seguir:** ≥ 90% de concordância no "aprova/reprova", < 2% de falhas, sem intervenção manual em 50 chamadas seguidas. Se passar, migrar etapa por etapa (roteiro, checagem de fatos, metadados; a voz depende de o CLI gerar áudio). A API fica como reserva automática quando o CLI falhar.

### Resultados do teste da Parte A (executado em 2026-10-12)

O primeiro teste comparou o `agy` (com modelo medium) contra o histórico da API (que rodava em thinking low/orig), apresentando 50% de concordância devido ao maior rigor visual do raciocínio estendido.

Em seguida, foi realizada a **revisão de segurança e o benchmark comparativo justo** (ambos avaliando as mesmas imagens em tempo real com thinking **medium**):

1. **Medidas de segurança no provedor `antigravity-cli`:**
   - Remoção de `--dangerously-skip-permissions`.
   - Execução em `--sandbox` com permissão estrita (`read_file(*)` / `view_file` para inspeção visual).
   - Execução isolada com `cwd` em pasta temporária contendo unicamente as imagens da chamada.
   - Variáveis de ambiente higienizadas via `minimalChildEnv` (nenhuma chave de API ou segredo exposto ao subprocesso).
   - Caminho configurável via `ANTIGRAVITY_CLI_PATH` ou PATH do sistema operacional (`agy`), eliminando caminhos absolutos fixos.
   - Tratamento de erro de status do agy corrigido (não mais engolido) e rastreamento preciso do `modelToUse` no `recordLlmUsage`.
   - Cópias das 20 mídias arquivadas em `data/benchmark/` para conferência visual.

2. **Resultados do benchmark comparativo justo (API Medium vs AGY Medium):**
   - **Concordância Aprova/Reprova:** **90,0%** (18 de 20) — **atingiu a meta de viabilidade de >= 90%**.
   - **Diferença média de notas:** **0,55 pontos** (escala 0-10) — concordância altíssima entre os modelos.
   - **Taxa de falhas técnicas:** **0,0%** no AGY e **0,0%** na API.
   - **Tempo médio:** 7,3 s na API vs 33,5 s no AGY.
   - **Resultados e amostras salvas:** arquivados em `data/agy_benchmark_results.json` e `data/benchmark/`.

Alternativa para o custo das imagens, independente do CLI: triagem local com SigLIP/CLIP na RTX 3050 (8 GB), mantendo o Gemini só como juiz final dos 1–2 melhores candidatos por cena (corta ~60% das chamadas de imagem).

## Parte B — multicontas

**Configuração por conta** (`config/accounts/<id>.json`, credenciais em `secrets/<id>/`): plataforma, nicho e temas (`topics`), idioma, voz, estilo de legenda, horários, limite diário, rodízio de formatos. Cada conta precisa de identidade própria (nicho, idioma ou estilo visual diferente) para não parecer cópia.

**Unicidade:** histórico de temas por conta e global; um roteiro/vídeo pertence a uma única conta; evitar o mesmo assunto em contas diferentes na mesma semana.

**Fila de produção:** o agendador passa a disparar um despachante a cada ~15 min, que escolhe a próxima conta com horário vencido e produz um vídeo por vez (render ≈ 7 min → ~8 vídeos/hora; 30/dia ocupam ~3,5 h do PC). Horários escalonados entre contas (sugestão da auditoria para o Brasil: ~11:45 e ~18:45, com variação).

**Publicação:**
- YouTube: login OAuth por canal (`npm run auth:youtube -- --account <id>`). A cota de upload é por projeto do Google Cloud: verificar a cota real no Console e pedir aumento (auditoria) se ~10+ uploads/dia não couberem.
- Instagram: cada conta Profissional; app da Meta em modo desenvolvimento aceita testadores, mas o envio direto precisa de vídeo em URL pública ou de um intermediário (ver `marco-4-tiktok-instagram.md`).
- TikTok: API direta só posta privado; usar intermediário (Upload-Post: o plano básico cobre 5 perfis, então 15 contas exigem plano maior; ou Zernio, cobrado por conta).

**Painel:** seletor de conta, métricas por conta e por rede, fila de produção, alertas por conta.

### Mapa do código para multicontas (grafo do graphify, 2026-10-21)

Tudo o que é "por conta" passa por três pontos globais:

1. **`paths`** (`src/orchestrator/lib/config.ts`): `config/`, `data/`, `logs/`, `render_output/` saem todos de `projectRoot`. São 15 usos de `paths.renderOutput` e 15 de `paths.fromRoot`. Inclui `data/history.json` (limite diário e anti-repetição), `data/upload.lock` e o `context.json` de cada execução (`runContext.ts`).
2. **`loadConfig()`**: lê um único `config/pipeline.config.json` e guarda em cache. São 27 ligações no grafo; usado pelos 9 estágios.
3. **Variáveis de ambiente**: `YT_TOKEN_PATH`, `YT_CLIENT_SECRET_PATH` e `YOUTUBE_CHANNEL_ID`, mais `secrets/instagram.token.json` fixo em `instagramAuth.ts`.

**Caminho mais curto:** um processo por conta, com `ACCOUNT=<id>`. Com essa variável, `paths` aponta `config/`, `data/`, `logs/`, `render_output/` e `secrets/` para `accounts/<id>/`. Os estágios, o `RunContext` e as travas não mudam, porque já recebem tudo por `paths` e `loadConfig()`. Não precisa de `accountId` dentro do `RunContext`.

O que continua **global** e precisa de código novo:
- **Unicidade entre contas**: `recentTopics.loadRecentSubjects()` hoje só lê o `render_output/` e o `history.json` da própria conta. Precisa ler os de todas as contas.
- **Cota de upload do YouTube**: é por projeto do Google Cloud, compartilhada entre os canais. Precisa de um contador global, além do limite diário por conta.
- **Despachante e trava de render**: um vídeo por vez no PC. Hoje isso está em `scheduler/run_once.ps1`, que é só para Windows; no Linux falta um equivalente (systemd timer ou cron).
- **Painel**: `dashboard/server/config.ts` duplica os caminhos; precisa do mesmo `ACCOUNT` ou de um seletor que leia `accounts/*/`.

## Riscos (o dono decide)

- **Banimento em cadeia:** as três redes punem conteúdo produzido em massa e contas ligadas entre si (mesmo dispositivo, IP, e-mail, cartão). Separar identidades e manter conteúdo realmente diferente por conta reduz, mas não elimina.
- **Custo pela API a 30 vídeos/dia:** ~US$ 145/mês até dez/2026 e ~US$ 290/mês depois (buscas na web passam da cota grátis de 5.000/mês). É o motivo do teste da Parte A.
- **Capacidade do PC:** render ocupa ~3,5 h/dia; quedas de energia ou suspensão atrasam a fila.

## Ordem sugerida

1. Parte A (teste do CLI) e pendências do `AGENTS.md`.
2. Multicontas com 2 contas de teste (1 YouTube + 1 Instagram) até estabilizar.
3. Escalar para as 15, em lotes, observando métricas e avisos de política de cada rede.
