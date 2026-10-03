# Máquina de Shorts

Pipeline autônomo que produz YouTube Shorts de **curiosidades** (história, ciência, espaço) do tema ao vídeo final, sem edição manual, mais um painel local para acompanhar produção, qualidade, custo e resultados do canal.

> **Status:** Marcos 1 e 2 implementados (tema → vídeo final → metadados → upload). O upload vem **desligado** (`upload.enabled: false`) até o canal ser autorizado com `npm run auth:youtube`. Agendamento automático (Marco 3) ainda não está implementado.

## Como funciona

Cada execução passa por nove estágios. Depois de cada um, o estado completo é salvo em `render_output/<runId>/context.json`, então uma execução pode ser retomada de onde parou.

| # | Estágio | O que faz |
|---|---|---|
| 01 | `pickTopic` | Sorteia categoria e ideia de tema em `config/topics.seed.json`, evitando repetir a última categoria |
| 02 | `generateScript` | O LLM (Gemini por padrão) escreve o roteiro em pt-BR: gancho, cenas, chamada final e uma busca de imagem por cena |
| 02b | `factCheck` | **Checagem de fatos** com busca no Google: cada afirmação vira correta, sem respaldo ou enganosa; frases erradas são reescritas, títulos sensacionalistas são suavizados e o roteiro corrigido é checado de novo |
| 03 | `fetchFootage` | Busca vídeos e imagens com licença livre, normaliza para 1080x1920 e passa cada candidato por uma **checagem visual** com o Gemini |
| 04 | `synthesizeVoice` | Gera a narração com edge-tts, com o tempo de cada palavra |
| 05 | `buildCaptions` | Agrupa as palavras em legendas e alinha cada cena com a fala |
| 06 | `renderVideo` | Renderiza o vídeo com Remotion: legenda com a palavra falada em destaque, zoom e movimento lento nas imagens |
| 07 | `generateMetadata` | Título (até 100 caracteres, com #Shorts), descrição com **créditos das imagens** (autor, licença e link de cada clipe CC BY) e tags, validados contra os limites do YouTube |
| 08 | `uploadYouTube` | Envia o vídeo (upload retomável), confere a privacidade que o YouTube realmente aplicou e registra em `data/history.json`. Só roda com `upload.enabled: true` e respeita o limite diário |

### Travas de qualidade (sem humano no loop)

- **Licença:** só entram NASA, Wikimedia Commons (apenas domínio público, CC0 ou CC BY) e Pexels/Pixabay, quando as chaves estão configuradas. Archive.org e afins ficam de fora, porque a licença é incerta.
- **Checagem visual:** cada clipe recebe nota de 0 a 10 do Gemini contra a narração da cena. Clipes com texto, marca d'água ou pessoas identificáveis são rejeitados.
- **Checagem de fatos:** até 3 rodadas de checagem com busca na web. Se a premissa do vídeo for falsa ou o roteiro continuar com afirmações sem respaldo, a execução é rejeitada. Fontes, afirmações e correções ficam em `factCheck` no `context.json`. Pode ser desligada com `script.factCheck: false` (não recomendado).
- **Trava por vídeo:** se menos de 60% das cenas tiverem um clipe aprovado, o vídeo não é renderizado. O pipeline troca de tema e tenta de novo (até 2 vezes). A checagem de fatos usa a mesma trava: roteiro rejeitado também troca de tema. Se nada passar, encerra com código de saída `3` e não produz vídeo.
- **Upload seguro:** nada é publicado com `upload.enabled: false` (padrão). Com ele ligado, o pipeline nunca envia a mesma execução duas vezes e respeita `upload.maxUploadsPerDay` (janela de 24 h).

## Requisitos

- Windows 10/11 (o pipeline foi construído e testado em Windows)
- Node.js 20 ou mais recente (painel: 22 ou mais recente)
- Python 3.10 ou mais recente
- Git
- ffmpeg não precisa ser instalado: o Remotion já traz o dele

## Instalação

```powershell
npm install
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r python/requirements.txt
powershell -ExecutionPolicy Bypass -File scripts/setup_vendor.ps1   # clone parcial do OpenMontage (ferramentas de footage)
npx remotion browser ensure                                          # baixa o Chrome usado no render
npm --prefix dashboard install
copy .env.example .env                                               # depois preencha as chaves
```

### Variáveis do `.env`

| Variável | Obrigatória | Para quê |
|---|---|---|
| `LLM_PROVIDER` | não | `gemini` (padrão) ou `anthropic` |
| `GEMINI_API_KEY` | sim, com Gemini | Roteiro, checagem visual e metadados |
| `GEMINI_MODEL` | não | Modelo do Gemini (padrão do projeto: `gemini-3.8-flash`) |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | só com `anthropic` | Alternativa ao Gemini |
| `PEXELS_API_KEY` / `PIXABAY_API_KEY` | não | Mais fontes de vídeo e imagem (recomendado) |
| `YOUTUBE_API_KEY` | não | Estatísticas públicas no painel (não serve para upload) |
| `YOUTUBE_CHANNEL_ID` | não | Inscritos e views do canal no painel (o `npm run auth:youtube` mostra o ID) |
| `YT_CLIENT_SECRET_PATH` / `YT_TOKEN_PATH` | para upload | Cliente OAuth (Desktop) e token salvo pelo `npm run auth:youtube` (padrão: `secrets/youtube.client_secret.json` e `secrets/youtube.token.json`) |

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
npm run dashboard                                      # painel em http://localhost:5180
```

### Upload para o YouTube

1. Rode `npm run auth:youtube`. O navegador abre o login do Google. Como o app ainda não foi verificado pelo Google, aparece **"O Google não verificou este app"**: clique em **Avançado** e depois em **Acessar Máquina de Shorts (não seguro)**. Escolha o canal e marque todas as permissões.
2. O terminal mostra o nome e o ID do canal. Coloque o ID em `YOUTUBE_CHANNEL_ID` no `.env`.
3. Em `config/pipeline.config.json`, ligue `"upload": { "enabled": true, ... }`.

O token fica em `secrets/youtube.token.json` e é renovado sozinho. Projetos de API não auditados pelo Google podem ter os vídeos travados como **privados** mesmo pedindo `unlisted`/`public`: o pipeline confere o status real depois do envio e avisa no log ("YouTube travou o vídeo como privado").

A narração é uma voz sintética comum sobre imagens reais/de arquivo, que a política de conteúdo alterado do YouTube não exige declarar; por isso `upload.containsSyntheticMedia` fica `false` por padrão (configurável).

O vídeo final fica em `render_output/<runId>/final.mp4`, e o log em `logs/<runId>.log`.

**Códigos de saída:** `0` sucesso, `1` erro, `3` trava de qualidade (nenhum vídeo publicável nas tentativas).

## Painel

`npm run dashboard` abre um painel local (React) só nesta máquina (`127.0.0.1`). As chaves ficam no servidor e nunca vão pro navegador.

- **Visão geral:** vídeos gerados e publicados, taxa de sucesso, falhas, views, inscritos, status da receita e galeria dos últimos vídeos com player.
- **Vídeos:** todos os vídeos gerados, com status e links.
- **Execuções:** linha do tempo de cada estágio, tempo de render e onde o pipeline falhou.
- **Conteúdo:** duração da narração, fontes e licenças das imagens, notas da checagem visual, trava de qualidade, tokens e custo estimado do LLM.
- **Configurações:** voz (com amostra em áudio), estilo das legendas, visual, roteiro, formato, temas e upload, com pré-visualização ao vivo de um quadro real renderizado pelo Remotion. Cada gravação guarda um backup em `config/backups/`. As mudanças valem a partir da próxima execução.

A receita só aparece depois do OAuth do Marco 2 e da entrada do canal no Programa de Parcerias do YouTube. O painel nunca mostra valor estimado de receita.

## Configuração

- `config/pipeline.config.json`: vídeo (resolução, duração alvo), voz, legendas, visual, roteiro (incluindo `script.factCheck`), footage, trava de qualidade e upload (`enabled`, `privacyStatus`, `categoryId`, `maxUploadsPerDay`, `containsSyntheticMedia`). Validado por `PipelineConfigSchema` (`src/orchestrator/lib/config.ts`); os padrões ficam em `src/shared/settings.ts`.
- `config/topics.seed.json`: categorias e ideias de tema.

Os dois podem ser editados à mão ou pela aba Configurações do painel.

## Estrutura

```
config/                     configuração do pipeline e temas
src/orchestrator/           orquestrador (runPipeline, estágios 01-08, libs de LLM, ffmpeg, relevância, YouTube)
src/remotion/               composição do vídeo (legendas, cenas, movimento)
src/shared/                 contratos compartilhados com o painel (settings, histórico de uploads)
python/tts/                 narração e lista de vozes (edge-tts)
vendor/openmontage_adapter/ adaptador de footage (chamado só como subprocesso)
dashboard/                  painel local (Express + Vite + React)
scripts/                    utilitários (estágio isolado, autorização do YouTube, setup do vendor, preview_still)
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
- O edge-tts usa um serviço não oficial da Microsoft e pode parar sem aviso. A alternativa planejada é o Piper TTS (offline).
- Ao iniciar o painel por um processo sem terminal (sem entrada padrão), use `npm run dev < NUL` dentro de `dashboard/`; caso contrário, o `tsx watch` trava antes de abrir a porta.
