# Máquina de Shorts

Pipeline autônomo que produz YouTube Shorts de **curiosidades** (história, ciência, espaço) do tema ao vídeo final, sem edição manual, mais um painel local para acompanhar produção, qualidade, custo e resultados do canal.

> **Status:** Marcos 1 e 2 implementados (tema → vídeo final → metadados → upload). O upload vem **desligado** (`upload.enabled: false`) até o canal ser autorizado com `npm run auth:youtube`. Os scripts de agendamento (Marco 3) estão em `scheduler/`, mas a tarefa no Agendador do Windows só existe depois de registrada à mão (veja [Agendamento](#agendamento-marco-3)).

## Como funciona

Cada execução passa por nove estágios. Depois de cada um, o estado completo é salvo em `render_output/<runId>/context.json`, então uma execução pode ser retomada de onde parou.

| # | Estágio | O que faz |
|---|---|---|
| 01 | `pickTopic` | Sorteia categoria e ideia de tema em `config/topics.seed.json`, evitando repetir a última categoria |
| 02 | `generateScript` | O LLM (Gemini por padrão) escreve o roteiro em pt-BR: gancho, cenas, chamada final e uma busca de imagem por cena |
| 02b | `factCheck` | **Checagem de fatos** com busca no Google: cada afirmação vira correta, sem respaldo ou enganosa; frases erradas são reescritas, títulos sensacionalistas são suavizados e o roteiro corrigido é checado de novo |
| 03 | `fetchFootage` | Busca vídeos e imagens com licença livre, normaliza para 1080x1920 e passa cada candidato por uma **checagem visual** com o Gemini |
| 04 | `synthesizeVoice` | Gera a narração com o Gemini TTS (padrão) ou o edge-tts, encurta pausas longas e marca o tempo de cada palavra (veja [Narração](#narração)) |
| 05 | `buildCaptions` | Agrupa as palavras em legendas e alinha cada cena com a fala |
| 06 | `renderVideo` | Renderiza o vídeo com Remotion: legenda com a palavra falada em destaque, zoom e movimento lento nas imagens |
| 07 | `generateMetadata` | Título (até 100 caracteres, com #Shorts), descrição com **créditos das imagens** (autor, licença e link de cada clipe CC BY) e tags, validados contra os limites do YouTube |
| 08 | `uploadYouTube` | Publica o vídeo em cada plataforma ligada (YouTube e Instagram Reels): upload retomável, confere a privacidade que a plataforma realmente aplicou e registra em `data/history.json`. Cada plataforma só publica quando ligada (`upload.enabled` no YouTube, `instagram.enabled` no Instagram) e respeita o próprio limite diário; se uma plataforma falhar, as outras seguem |

### Travas de qualidade (sem humano no loop)

- **Licença:** só entram NASA, Wikimedia Commons (apenas domínio público, CC0 ou CC BY) e Pexels/Pixabay, quando as chaves estão configuradas. Archive.org e afins ficam de fora, porque a licença é incerta.
- **Checagem visual:** cada clipe recebe nota de 0 a 10 do Gemini contra a narração da cena. Clipes com texto, marca d'água ou pessoas identificáveis são rejeitados.
- **Checagem de fatos:** até 3 rodadas de checagem com busca na web; todo texto publicado passa por uma checagem com busca (inclusive a última correção). Checagem sem fontes da web ou sem afirmações extraídas é rejeitada. Se a premissa do vídeo for falsa ou o roteiro continuar com afirmações sem respaldo, a execução é rejeitada. Fontes, afirmações e correções ficam em `factCheck` no `context.json`. Pode ser desligada com `script.factCheck: false` (não recomendado; aí o upload também exige `upload.allowWithoutFactCheck: true`).
- **Título e descrição:** o título publicado é o título do roteiro já checado; a descrição só usa frases copiadas do roteiro checado, mais hashtags e créditos.
- **Sem repetição de assunto:** o roteiro recebe os ~30 assuntos mais recentes (publicados e gerados) e é rejeitado se o título repetir um deles.
- **Trava por vídeo:** se menos de 60% das cenas tiverem um clipe aprovado (o revisor precisa dizer que o clipe combina com a cena; clipes de reserva não contam), o vídeo não é renderizado. O pipeline troca de tema e tenta de novo (até 2 vezes). Roteiro reprovado na checagem de fatos, assunto repetido, nenhum clipe utilizável, créditos que não cabem na descrição e narração fora de `video.minSeconds`–`video.maxSeconds` também trocam de tema. Se nada passar, encerra com código de saída `3` e não produz vídeo. Uma execução rejeitada não pode ser retomada com `--resume`.
- **Upload seguro:** nada é publicado com `upload.enabled: false` (padrão). Com ele ligado, o estágio 08 só envia execuções com trava de qualidade aprovada e checagem de fatos aprovada, nunca envia a mesma execução duas vezes (um diário por plataforma, `upload.<plataforma>.journal.json`, na pasta da execução guarda a sessão de upload e o ID do vídeo, então uma nova tentativa retoma em vez de reenviar) e respeita `upload.maxUploadsPerDay` (janela de 24 h, com trava entre processos). Se `data/history.json` estiver ilegível, o upload é bloqueado até o arquivo ser corrigido.
- **Segredos:** chaves de API e tokens são mascarados nos logs, e os subprocessos (Python, ffmpeg) recebem só as variáveis de ambiente de que precisam.

## Requisitos

- Windows 10/11 (o pipeline foi construído e testado em Windows)
- Node.js 20 ou mais recente (painel: 22 ou mais recente)
- Python 3.11 ou mais recente
- Git
- ffmpeg não precisa ser instalado: o Remotion já traz o dele

## Instalação

```powershell
npm install
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r python/requirements.txt
.venv\Scripts\python.exe python/tts/align_narration.py --download-only   # modelo Whisper (~140 MB) que marca o tempo das palavras
powershell -ExecutionPolicy Bypass -File scripts/setup_vendor.ps1   # clone parcial do OpenMontage (ferramentas de footage)
npx remotion browser ensure                                          # baixa o Chrome usado no render
npm --prefix dashboard install
copy .env.example .env                                               # depois preencha as chaves
```

### Variáveis do `.env`

| Variável | Obrigatória | Para quê |
|---|---|---|
| `LLM_PROVIDER` | não | `gemini` (padrão), `anthropic` ou `antigravity-cli` |
| `GEMINI_API_KEY` | sim, com Gemini ou com a voz Gemini (padrão) | Roteiro, checagem visual, metadados e narração (Gemini TTS) |
| `GEMINI_MODEL` | não | Modelo do Gemini (padrão do projeto: `gemini-3.8-flash`) |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | só com `anthropic` | Alternativa ao Gemini |
| `ANTIGRAVITY_CLI_PATH` / `ANTIGRAVITY_MODEL` / `ANTIGRAVITY_CLI_TIMEOUT_S` / `ANTIGRAVITY_CLI_CONCURRENCY` / `ANTIGRAVITY_FALLBACK` | só com `antigravity-cli` | Usa o Antigravity CLI (`agy`) já logado no PC, sem chave de API: binário (padrão `agy`), modelo (padrão `gemini-3.8-flash-medium`), tempo limite por chamada (180 s), processos simultâneos (2) e fallback para a API paga (`none`, padrão, ou `gemini`) |
| `PEXELS_API_KEY` / `PIXABAY_API_KEY` | não | Mais fontes de vídeo e imagem (recomendado) |
| `YOUTUBE_API_KEY` | não | Estatísticas públicas no painel (não serve para upload) |
| `YOUTUBE_CHANNEL_ID` | não | Inscritos e views do canal no painel (o `npm run auth:youtube` mostra o ID) |
| `YT_CLIENT_SECRET_PATH` / `YT_TOKEN_PATH` | para upload | Cliente OAuth (Desktop) e token salvo pelo `npm run auth:youtube` (padrão: `secrets/youtube.client_secret.json` e `secrets/youtube.token.json`) |
| `INSTAGRAM_APP_ID` / `INSTAGRAM_APP_SECRET` | só para o Instagram | Instagram App ID e App Secret do app da Meta, usados uma vez pelo `npm run auth:instagram` (o token fica em `secrets/instagram.token.json`) |

O `.env` e a pasta `secrets/` nunca entram no git.

## Uso

```powershell
npm run pipeline                                       # execução completa com tema novo
npm run pipeline -- --until 02-generateScript          # para depois de um estágio
npm run pipeline -- --resume <runId>                   # retoma, pulando o que já está pronto
npm run pipeline -- --fixture test/fixtures/context.script-only.json   # roteiro pronto, sem LLM
npm run stage -- 06-renderVideo --run <runId>          # reexecuta um único estágio
npm run stage -- 08-uploadYouTube --run <runId>        # envia um vídeo já renderizado (ex.: depois do limite diário)
npm run auth:youtube                                   # autoriza o canal (uma vez só, interativo)
npm run auth:instagram                                 # autoriza a conta do Instagram (uma vez só, interativo)
npm run dashboard                                      # painel em http://localhost:5180
```

### Upload para o YouTube

1. Rode `npm run auth:youtube`. O navegador abre o login do Google. Como o app ainda não foi verificado pelo Google, aparece **"O Google não verificou este app"**: clique em **Avançado** e depois em **Acessar Máquina de Shorts (não seguro)**. Escolha o canal e marque todas as permissões.
2. O terminal mostra o nome e o ID do canal. Coloque o ID em `YOUTUBE_CHANNEL_ID` no `.env`.
3. Em `config/pipeline.config.json`, ligue `"upload": { "enabled": true, ... }`.

O token fica em `secrets/youtube.token.json` e é renovado sozinho. Projetos de API não auditados pelo Google podem ter os vídeos travados como **privados** mesmo pedindo `unlisted`/`public`: o pipeline confere o status real depois do envio e avisa no log ("YouTube travou o vídeo como privado").

A narração é uma voz sintética comum sobre imagens reais/de arquivo, que a política de conteúdo alterado do YouTube não exige declarar; por isso `upload.containsSyntheticMedia` fica `false` por padrão (configurável).

### Instagram Reels

O mesmo vídeo vai para o Instagram como Reel, pela "API do Instagram com login do Instagram" (sem página do Facebook). Vem **desligado**; para ligar, uma vez só:

1. **Conta profissional:** no app do Instagram, Configurações → Tipo de conta e ferramentas → mude para conta profissional, tipo **Criador** (Empresa também serve).
2. **App da Meta:** em [developers.facebook.com/apps](https://developers.facebook.com/apps), crie um app do tipo **Empresa** com o caso de uso **"Gerenciar mensagens e conteúdo no Instagram"** (produto **Instagram → API com login do Instagram**).
3. **Testador:** em Funções do app → Funções → **Testadores do Instagram**, adicione o @ da conta. Aceite o convite no Instagram (Configurações → Apps e sites → Convites de testador; também em [instagram.com/accounts/manage_access](https://www.instagram.com/accounts/manage_access/)). Com o app em modo de desenvolvimento e a conta como testadora, não precisa de revisão da Meta.
4. **Redirecionamento:** em Instagram → Configuração da API com login do Instagram → **3. Configurar o login comercial do Instagram** → Configurações do login comercial, cadastre exatamente esta URL em "URIs de redirecionamento do OAuth":
   `https://mystic0112.github.io/Maquina-de-Shorts/oauth/callback.html`
   (a página fica em `docs/oauth/callback.html`, publicada pelo GitHub Pages; ela só repassa o código para o terminal deste PC em `127.0.0.1`).
5. **Chaves:** copie o **Instagram App ID** e o **Instagram App Secret** (na mesma tela) para o `chaves.txt`; no `.env` eles viram `INSTAGRAM_APP_ID` e `INSTAGRAM_APP_SECRET`.
6. Rode `npm run auth:instagram`. Entre com a conta do Instagram e permita tudo (perfil, publicar conteúdo e insights). A página do GitHub Pages devolve o login para o terminal; se o navegador bloquear, ela mostra um código com o botão **Copiar código**: cole no terminal e tecle Enter. O terminal mostra `@usuário` e o tipo da conta.
7. Ligue em **Configurações** (enquanto a seção do Instagram não chega ao painel, edite o `config/pipeline.config.json`: `"instagram": { "enabled": true, "maxPostsPerDay": 3 }`).

O token vale 60 dias e é renovado sozinho quando faltam menos de 10 dias (a renovação acontece na publicação). Se vencer, o Instagram fica bloqueado com o aviso no log e o YouTube segue normal; é só rodar `npm run auth:instagram` de novo. Antes de cada post, o pipeline confere o limite de publicações da Meta (`content_publishing_limit`) além do limite diário próprio. A legenda reaproveita o título, o gancho, as hashtags e os **créditos das imagens** da descrição do YouTube, dentro dos limites do Instagram (2.200 caracteres, 30 hashtags); se os créditos CC BY não couberem, o Instagram é pulado naquele vídeo. O diário `upload.instagram.journal.json` guarda o ID do container antes do envio, então uma nova tentativa retoma o mesmo container em vez de criar um post duplicado.

O vídeo final fica em `render_output/<runId>/final.mp4`, e o log em `logs/<runId>.log`.

**Códigos de saída:** `0` sucesso, `1` erro, `3` trava de qualidade (nenhum vídeo publicável nas tentativas).

## Agendamento (Marco 3)

Os scripts ficam em `scheduler/` e rodam no Windows PowerShell 5.1 (já vem no Windows). Nada é registrado sozinho: a tarefa só existe depois de rodar o `register_task.ps1`.

| Script | O que faz |
|---|---|
| `scheduler/run_once.ps1` | Uma execução desassistida: trava contra execução dupla, timeout (padrão 60 min, mata a árvore de processos), log em `logs/scheduler/<data>.log` (30 dias), alerta em `data/alerts.jsonl` + notificação do Windows em falha/timeout |
| `scheduler/register_task.ps1` | Cria/atualiza a tarefa **Maquina de Shorts** no Agendador de Tarefas (`-DryRun` só mostra) |
| `scheduler/unregister_task.ps1` | Remove a tarefa (mantém logs e alertas) |
| `scheduler/status.ps1` | Estado da tarefa, última/próxima execução, último resultado e os 3 últimos alertas |

```powershell
# conferir o que seria registrado (não registra nada)
powershell -NoProfile -ExecutionPolicy Bypass -File scheduler\register_task.ps1 -DryRun
# registrar: 09:00 e 18:00, atraso aleatório de até 20 min, só com você logado
powershell -NoProfile -ExecutionPolicy Bypass -File scheduler\register_task.ps1
# outros horários
powershell -NoProfile -ExecutionPolicy Bypass -File scheduler\register_task.ps1 -Times 08:30,20:00 -RandomDelayMinutes 10
# testar já, sem esperar o horário / ver o estado / remover
Start-ScheduledTask -TaskName 'Maquina de Shorts'
powershell -NoProfile -ExecutionPolicy Bypass -File scheduler\status.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scheduler\unregister_task.ps1
```

**A tarefa:** roda `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scheduler\run_once.ps1` como o seu usuário, acorda o PC (se o plano de energia permitir *timers de ativação*), só com rede, recupera um horário perdido quando o PC volta (`StartWhenAvailable`), nunca abre uma segunda instância e é encerrada pelo Windows após 90 min (o wrapper já encerra o pipeline aos 60). Roda também na bateria; `-RequireAC` volta ao padrão do Windows (não inicia na bateria e para ao desconectar).

**Logado ou não:** o padrão (`-LogonType Interactive`) só roda com você logado (sessão bloqueada conta como logado) e não guarda senha. Para rodar deslogado, registre num PowerShell **como administrador** com `-LogonType S4U` (sem senha guardada; sem acesso a pastas de rede) ou `-LogonType Password` (pede a senha do Windows, guardada pelo próprio Windows). Nesses dois modos a notificação do Windows não aparece, mas o alerta continua em `data/alerts.jsonl`.

**Códigos de saída do `run_once.ps1`** (também viram o "Último resultado" da tarefa): `0` sucesso ou execução pulada porque outra estava em andamento, `1` erro (pipeline ou wrapper, ex.: node ausente), `3` trava de qualidade ("nenhum vídeo publicável hoje": só aviso no log, sem alerta), `124` timeout.

**Alertas:** uma linha JSON por falha em `data/alerts.jsonl`: `timestamp`, `kind` (`failure`, `timeout`, `wrapper_error`), `message` (segredos mascarados), `exitCode`, `runId` (quando detectado) e `log`.

**Testar sem o pipeline real:** `$env:MAQUINA_SCHEDULER_TEST='fail'` (ou `ok`, `quality`, `hang` com `-TimeoutMinutes 0.3`) faz o `run_once.ps1` rodar `scheduler/test/fake_pipeline.mjs`; o log vai para `logs/scheduler/<data>.test.log` e o alerta sai com `"test": true`. `MAQUINA_NODE_DIR` força uma pasta específica do Node.

## Painel

`npm run dashboard` abre um painel local (React) só nesta máquina (`127.0.0.1`). As chaves ficam no servidor e nunca vão pro navegador.

- **Visão geral:** vídeos gerados e publicados, taxa de sucesso, falhas, views, inscritos, status da receita e galeria dos últimos vídeos com player.
- **Vídeos:** todos os vídeos gerados, com status e links.
- **Execuções:** linha do tempo de cada estágio, tempo de render e onde o pipeline falhou.
- **Conteúdo:** duração da narração, fontes e licenças das imagens, notas da checagem visual, trava de qualidade, tokens e custo estimado do LLM.
- **Configurações:** voz (com amostra em áudio), estilo das legendas, visual, roteiro, formato, temas e upload, com pré-visualização ao vivo de um quadro real renderizado pelo Remotion. Cada gravação guarda um backup em `config/backups/`. As mudanças valem a partir da próxima execução.

A receita só aparece depois do OAuth do Marco 2 e da entrada do canal no Programa de Parcerias do YouTube. O painel nunca mostra valor estimado de receita.

## Configuração

- `config/pipeline.config.json`: vídeo (resolução, duração alvo), voz, legendas, visual, roteiro (incluindo `script.factCheck`), footage, trava de qualidade, upload (`enabled`, `privacyStatus`, `categoryId`, `maxUploadsPerDay`, `containsSyntheticMedia`, `allowWithoutFactCheck`), Instagram (`instagram.enabled`, padrão `false`; `instagram.maxPostsPerDay`, padrão 3), render (`render.totalTimeoutSeconds`, padrão 600) e armazenamento (`storage.keepFailedRunsDays`, padrão 3: execuções rejeitadas ou interrompidas são apagadas depois disso; `storage.keepUploadedVideosDays`, padrão 14: execuções publicadas perdem o `final.mp4` e as imagens, mas mantêm `context.json` e log). Execuções renderizadas e não publicadas nunca são apagadas automaticamente; a limpeza roda no início de cada `npm run pipeline`. Validado por `PipelineConfigSchema` (`src/orchestrator/lib/config.ts`); os padrões ficam em `src/shared/settings.ts`.
- `config/topics.seed.json`: categorias e ideias de tema.

Os dois podem ser editados à mão ou pela aba Configurações do painel.

## Narração

A seção `voice` do `config/pipeline.config.json` escolhe o motor em `voice.engine`:

- **`gemini`** (padrão): Gemini TTS pela Interactions API ([documentação](https://ai.google.dev/gemini-api/docs/speech-generation)), com a mesma `GEMINI_API_KEY`. A resposta é PCM 16-bit, 24 kHz, mono. O Gemini não informa o tempo de cada palavra, então `python/tts/align_narration.py`:
  1. encurta as pausas (trechos abaixo de -40 dBFS) para no máximo `voice.maxPauseMs`, com 50 ms de silêncio no início e 100 ms no fim;
  2. transcreve o áudio final com o faster-whisper (modelo `base`, CPU/int8, ~5 s por minuto de áudio);
  3. alinha o texto reconhecido ao roteiro, então as legendas usam exatamente as palavras do roteiro, na ordem certa.

  Os números por extenso que o Whisper escreve com algarismos ("1818") recebem o tempo por interpolação. Se menos de 50% do roteiro for reconhecido no áudio (texto pulado, idioma errado), o estágio falha.

  A saída é `narration.wav`; o áudio original do Gemini fica em `narration.source.wav`. O modelo do Whisper fica em `models/whisper/` (fora do Git): baixe uma vez com `--download-only`. Se ele faltar, a primeira execução baixa o modelo e avisa no log.

  Os tokens de áudio entram em `llmUsage` como modelo `gemini-3.8-flash-tts`, a 25 tokens por segundo de áudio; um minuto de narração custa cerca de US$ 0,014 ([preços](https://ai.google.dev/gemini-api/docs/pricing)).
- **`edge-tts`**: serviço não oficial da Microsoft (retorna 403 desde outubro de 2026). Gera `narration.mp3` com o tempo de cada palavra e encurta as pausas removendo quadros MP3 silenciosos (`python/tts/mp3_pauses.py`).

| Campo | Motor | Padrão | Para quê |
|---|---|---|---|
| `engine` | os dois | `gemini` | `gemini` ou `edge-tts` |
| `maxPauseMs` | os dois | `250` | maior pausa mantida entre palavras/frases, em ms (`0` não corta nada) |
| `geminiModel` | gemini | `gemini-3.8-flash-tts` | também existe o `gemini-3.8-flash-lite-tts`, mais barato |
| `geminiVoice` | gemini | `Fenrir` | voz pré-pronta (`Fenrir`, `Puck`, ...), da biblioteca (`pt-br-podcaster-12`, ...) ou criada (`voice_...`) |
| `style` | gemini | "Narre em português do Brasil, tom curioso e envolvente, ritmo ágil de vídeo curto, sem pausas longas" | instrução de entrega (`speech_metadata.style`); o texto do roteiro é lido literalmente |
| `name` | edge-tts | `pt-BR-AntonioNeural` | voz do edge-tts |
| `rate` / `pitch` / `volume` | edge-tts | `+10%` / `+0Hz` / `+0%` | o Gemini ignora; para mudar o ritmo dele, use `style` |

## Estrutura

```
config/                     configuração do pipeline e temas
src/orchestrator/           orquestrador (runPipeline, estágios 01-08, libs de LLM, ffmpeg, relevância, YouTube)
src/orchestrator/publishers/ publicadores por plataforma (YouTube, Instagram; nova rede = um arquivo + uma linha no registro)
src/remotion/               composição do vídeo (legendas, cenas, movimento)
src/shared/                 contratos compartilhados com o painel (settings, histórico de uploads)
python/tts/                 narração: corte de pausas, alinhamento de palavras (Whisper) e o motor edge-tts
models/whisper/             modelo do faster-whisper (baixado, fora do Git)
vendor/openmontage_adapter/ adaptador de footage (chamado só como subprocesso)
dashboard/                  painel local (Express + Vite + React)
scripts/                    utilitários (estágio isolado, autorização do YouTube e do Instagram, setup do vendor, preview_still)
docs/                       site do GitHub Pages (início, privacidade, termos, página de retorno do OAuth)
test/fixtures/              roteiro de exemplo para testar sem LLM
```

## Licenças e atribuição

- `vendor/openmontage_adapter/` importa código do [OpenMontage](https://github.com/calesthio/OpenMontage), licenciado sob **AGPL-3.0**. O resto do projeto só chama esse adaptador como processo separado, nunca importa dele. Se este repositório for distribuído ou tornado público, o adaptador precisa ser publicado sob AGPL-3.0.
- O clone do OpenMontage em `vendor/openmontage/` não é versionado: é recriado por `scripts/setup_vendor.ps1`, fixado num commit.
- Clipes com licença CC BY exigem crédito ao autor. O autor, a licença e o link de cada clipe ficam registrados no `context.json`, e o estágio 07 coloca esses créditos na seção "Créditos das imagens" da descrição do vídeo.

## Roteiro

- [x] **Marco 1:** tema → vídeo final, com travas de licença e qualidade
- [x] Painel local de acompanhamento
- [x] Checagem de fatos automática do roteiro
- [x] **Marco 2:** metadados, upload via YouTube Data API (OAuth) e registro em `data/history.json`
- [ ] **Marco 3:** agendamento pelo Agendador de Tarefas do Windows, controle de temas já usados, alertas de falha

## Problemas conhecidos

- O Remotion avisa que esperava zod 4.5.4 (o projeto usa 4.6.5). Não afeta o render.
- Ocasionalmente o Remotion registra `Page.bringToFront: Target closed` ao fechar o navegador. É inofensivo, o render termina normalmente.
- O edge-tts usa um serviço não oficial da Microsoft e retorna 403 desde outubro de 2026. Por isso o motor padrão agora é o Gemini TTS; o edge-tts continua disponível com `voice.engine: "edge-tts"`, caso volte a funcionar.
- A amostra de voz do painel (Configurações) ainda usa o edge-tts e o `narration.mp3`, então não funciona enquanto ele estiver fora do ar.
- Ao iniciar o painel por um processo sem terminal (sem entrada padrão), use `npm run dev < NUL` dentro de `dashboard/`; caso contrário, o `tsx watch` trava antes de abrir a porta.
