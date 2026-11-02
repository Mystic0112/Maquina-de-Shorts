# Matriz de capacidades: o que cada tarefa exige do modelo × o que cada provedor entrega

Documento de planejamento do card "Produto: o usuário pluga a IA que tiver". Não tem código. Serve para decidir **quais provedores de IA a máquina pode aceitar e em que ordem implementar**.

Como ler as marcas: **sim** (confirmado), **não** (confirmado que não tem), **parcial** (funciona com ressalva escrita ao lado), **não verificado** (não consegui confirmar; precisa de teste ou de leitura mais atenta).

Fontes: o código deste repositório (lido em 2026-11-02) e a documentação oficial dos provedores (consultada em 2026-11-02; as URLs estão no fim). Fatos que o dono conferiu em 2026-11-02: Claude Code 2.1.310 tem `-p`, `--output-format json`, `--json-schema`, `--tools`, `--no-session-persistence`, `--model` e `--effort`; Codex, opencode e Cursor CLI **não** estão instalados no PC de casa, então as flags deles são só da documentação e precisam de teste.

## 1. Resumo (o que decide tudo)

1. Só **três** tarefas exigem algo além de "responder em JSON": **busca na web** (checagem de fatos, 02b), **imagem na entrada** (juiz de imagem do 03 e humor dos cortes) e **imagem na saída** (imagens ilustradas). O resto é texto em JSON, que quase qualquer modelo faz.
2. A **voz não depende do provedor de IA**: Kokoro e Whisper rodam no PC. Só a voz Gemini TTS (opcional) precisa de chave Gemini.
3. **Imagem na saída** é o gargalo: hoje só o `agy` (e, pela documentação, a API do Gemini e a API de imagens do OpenRouter) gera. Sem isso, o formato "ilustrado" some e o produto cai nas imagens de acervo.
4. **Busca na web** é o gargalo da checagem de fatos. Modelo local (Ollama, LM Studio) não tem busca. A trava de fatos **não pode ser enfraquecida**: sem busca, o vídeo não pode sair (o código já rejeita "checagem sem fontes da web"). A saída é ter um "provedor de busca" separado do provedor de texto.
5. O código hoje tem **3 provedores** (Gemini, Anthropic, `agy`) numa interface de 2 métodos. Escolher provedor por etapa só existe no juiz de imagem (`footage.relevance.provider`); as etapas dos cortes e a imagem ilustrada **não** têm escolha de provedor.
6. Limite de cota de plano em janelas de horas (o `agy` Pro renova a cada 5 horas, pela documentação) **não é tratado**: o código espera no máximo cerca de 1 minuto e desiste. Antes de aceitar provedores de plano, a fila precisa saber "pausar até a cota voltar".
7. Ordem recomendada (detalhes na seção 5): contrato de capacidades e escolha por etapa → provedor OpenAI-compatível → Claude Code CLI → Codex CLI → geração de imagem como capacidade separada → opencode e Cursor CLI só sob demanda.

## 2. O que cada tarefa exige do modelo (lido no código)

Volumes são **estimativas** a partir dos padrões do código (4 a 7 cenas por vídeo, até 3 trechos por cena, 3 candidatos de cada tipo por busca, 3 quadros por vídeo avaliado). O README e o `planejamento/marco-5-multicontas-e-antigravity.md` falam em ~45 chamadas por vídeo; a conta abaixo é compatível.

| Tarefa (arquivo) | JSON por schema | Imagem na entrada | Busca na web | Imagem na saída | Chamadas por vídeo (estimativa) |
|---|---|---|---|---|---|
| Roteiro (`02-generateScript.ts`) | sim (schema zod, validado, 1 nova tentativa com a correção) | não | não | não | 1 a 3 (assunto repetido ou problema de regra pede nova tentativa) |
| Checagem de fatos (`02b-factCheck.ts`) | sim, na 2ª chamada de cada rodada | não | **sim, obrigatória**: 1ª chamada é texto com busca e devolve fontes; sem fontes = rejeita | não | 2 por rodada (1 com busca + 1 em JSON), até 3 rodadas + 1 verificação final: **2 se passar de primeira, até cerca de 14** |
| Metadados (`07-generateMetadata.ts`) | sim | não | não | não | 1 |
| Juiz de imagem / relevância (`03` + `lib/relevance.ts`) | sim (nota, "combina", texto/logo, etc.) | **sim**: 3 quadros por vídeo, 1 por foto | não | não | **cerca de 30 a 60** com `batchSize` 1 (padrão); cai para 1/3 com lotes de 3, e assim por diante até 6 por chamada. Mais 0 ou 1 chamada de texto para consultas alternativas |
| Imagens ilustradas (`lib/illustrate.ts`, `script.imageSource: "ilustrado"`) | não (o agente responde com um caminho de arquivo, que o código confere) | não | não | **sim**: 1 imagem 9:16 por trecho | cerca de 6 a 15 imagens, de 58 a 112 s cada (medido pelo dono em casa), 2 ao mesmo tempo. Cada imagem ainda passa pelo juiz (1 chamada de visão cada), sem rodada de reserva |
| Formato terminal (`lib/terminalCards.ts`, `imageSource: "terminal"`) | sim | não | não | não | 1 a 3 (usa o modelo configurado para `metadata`) |
| Voz (`04-synthesizeVoice.ts`, `python/tts`) | n/a | n/a | n/a | n/a | **0 chamadas de IA**: Kokoro local; alinhamento com faster-whisper local. Opcional: Gemini TTS (chave Gemini) e edge-tts (legado) |
| Cortes: seleção (`cuts/select.ts`) | sim; recebe a **transcrição inteira** com tempos | não | não | não | 1 a 3 por vídeo de origem (revalida e pede de novo) |
| Cortes: conferência de sentido (`verifyPicks`) | sim | não | não | não | 1 por vídeo de origem (e 1 por compilação) |
| Cortes: humor (`cuts/humor.ts`) | sim | **sim**: até 10 quadros do corte numa chamada | não | não | 1 por corte (3 por vídeo de origem com `perVideo` 3) |
| Cortes: compilações (`cuts/compilation.ts`) | sim | não | não | não | 1 a 3 (escolha) + 1 (conferência) por compilação |
| Cortes: metadados (`cuts/metadata.ts`) | sim | não | não | não | 1 por corte |
| Memes e efeitos (`05b-planEdits.ts`, desligado) | sim | não | não | não | 0 (desligado) |

Transcrição dos cortes (`python/cuts/transcribe.py`) e detector de quem fala são locais; não usam provedor de IA.

### O que acontece se falhar ou a cota acabar

Regras comuns a toda chamada (`lib/llmClient.ts`):

- Erro de limite de uso (texto com `429`, `RESOURCE_EXHAUSTED`, "rate limit" ou "quota"): até 4 novas tentativas com espera crescente, **teto de 60 s por espera**. Na prática o código desiste em cerca de 1 minuto.
- Estouro de tempo (padrão 240 s por chamada do `agy`): até 2 novas tentativas (`LLM_TIMEOUT_RETRIES`).
- JSON inválido ou fora do schema: 1 nova tentativa com a resposta anterior e os problemas no prompt.
- Outros erros: sobem na hora. O README documenta "AI credits balance is too low" (modelos Claude/GPT dentro do `agy`). Pelo código, essa mensagem **não** casa com a regra de limite de uso, então não há nova tentativa (inferência da leitura do código).
- Se `ANTIGRAVITY_FALLBACK=gemini` e há chave, o `agy` cai para a API paga do Gemini; o padrão é `none` (custo zero).

Efeito por etapa:

| Etapa | Se a IA falhar de vez |
|---|---|
| 02 Roteiro | a etapa falha; sem roteiro não há vídeo |
| 02b Checagem | sem fontes da web ou sem afirmações extraídas = **rejeita** o tema (o pipeline tenta outro tema, até `pipeline.maxScriptAttempts`, padrão 2). Nunca publica texto não checado (só com `script.factCheck=false`, que o código avisa em log) |
| 03 Imagens | se **toda** chamada de avaliação falhar, a etapa falha ("Relevance gate unavailable"). Falha em algumas: o clipe fica sem nota e não é usado. Trava dos 60% de cenas com imagem aprovada continua valendo |
| 03 Ilustrado | imagem que falha é pulada e registrada; sem nenhuma, rejeita ("No usable footage") |
| 07 Metadados | **não bloqueia**: usa o título do roteiro como rascunho |
| Cortes: seleção | erro sobe e o vídeo de origem não gera cortes; seleção inválida 3 vezes = erro |
| Cortes: conferência | corte sem veredito é descartado (trava mantida) |
| Cortes: humor | pula o humor daquele corte e segue |
| Cortes: metadados | usa o gancho como resumo e segue |

## 3. Tabela provedor × capacidade

Todas as consultas à documentação são de 2026-11-02 (URLs na seção 6). "Observado" = visto no código ou nos testes do dono registrados no repositório; não é documentação do provedor.

| Provedor | JSON por schema | Imagem na entrada | Busca na web | Imagem na saída | Limite / cota | Custo | Login do plano, sem chave |
|---|---|---|---|---|---|---|---|
| **agy** (Antigravity CLI), no código hoje | sim (`--json-schema`, campo `structured_output`). Em sessão contínua (stream-json) o schema só vale na 1ª resposta, então o código põe o schema no prompt e valida com zod | parcial: **não tem flag de imagem**; o código grava os quadros numa pasta temporária e pede para o agente abrir com `view_file` (benchmark de 2026-10-12: 90% de concordância com a API) | sim (observado: o 02b usa a ferramenta de busca do agente). A documentação do modo headless não detalha as ferramentas | sim (observado em 2026-10-26: ferramenta de imagem do agente; o arquivo cai na pasta interna do agy e o código confere antes de copiar). Não vi isso na documentação oficial | AI Pro: cota alta que **renova a cada 5 horas** até o limite semanal; plano grátis renova por semana; créditos de IA comprados cobrem o excedente. Modelos Claude/GPT dentro do agy gastam o saldo separado "AI credits" (README, teste do dono) | incluso no plano Google; sem BYOK (a página de planos diz que não há chave própria) | **sim**: usa o login em cache; sem login o headless sai com erro de autenticação |
| **Claude Code** (`claude -p`) | sim (`--json-schema` + `--output-format json`; campo `structured_output`; só no modo `-p`). Sem `structured_output` quando o modelo recusa | parcial: sem flag de imagem; a ferramenta `Read` lê PNG, JPEG, GIF e WebP de arquivo e mostra ao modelo. Seria o mesmo truque do agy (pasta temporária). Não testado aqui | sim: ferramenta `WebSearch` (usa a busca da Anthropic; até 8 buscas por chamada). Em `-p` precisa estar liberada (`--allowedTools`). Não confirmei que funciona no login de plano | não (nada na documentação) | limites do plano; a documentação diz que os limites anunciados "assumem uso comum e individual do Claude Code e do Agent SDK". Janela e valores: não verificado | plano ou API | **sim** (OAuth do plano) **mas com ressalva de termos**, ver seção 4. `--bare` não usa o login do plano |
| **Codex** (`codex exec`) | sim (`--output-schema arquivo.json`, `-o` grava a mensagem final) | sim (`--image` / `-i`, repetível) | sim (`--search` liga busca ao vivo; sem ela, busca em cache) | não verificado (a documentação de `exec` não cita geração de imagem) | limites do plano ChatGPT: não verificado | plano ChatGPT (Plus, Pro, Business, Edu, Enterprise) ou API | sim (entrar com conta ChatGPT; também aceita `CODEX_API_KEY`). **Não instalado no PC de casa: flags a confirmar** |
| **opencode** (`opencode run`) | não verificado (`--format json` devolve eventos, a documentação não cita schema) | parcial: `--file/-f` anexa arquivo; imagem: não verificado | não verificado | não verificado | depende do provedor escolhido | depende do provedor escolhido | parcial: a documentação lista login por assinatura para ChatGPT Plus/Pro, GitHub Copilot, GitLab Duo e xAI SuperGrok; para Claude Pro/Max diz que a Anthropic proíbe. Demais provedores: chave. **Não instalado: flags a confirmar** |
| **Cursor CLI** (`cursor-agent -p`) | não verificado (a documentação não cobre schema; só `text`, `json`, `stream-json`) | parcial: o agente lê imagens citadas por caminho no prompt (documentação) | não verificado | não verificado | não verificado | não verificado | não verificado (a documentação mostra `CURSOR_API_KEY` para scripts e não cobre login do plano). **Não instalado: flags a confirmar** |
| **API do Gemini**, no código hoje | sim (`responseJsonSchema`; o código tira do schema as palavras-chave que o Gemini não aceita) | sim (`inlineData`) | sim (`googleSearch`). A documentação atual diz que o schema JSON pode vir junto com a busca nos modelos Gemini 3; o código mantém **duas chamadas** (busca, depois JSON) por causa do comportamento antigo; não retestei | sim: família "Nano Banana" (PNG/JPEG em base64, marca d'água SynthID). O código **não** usa; a documentação não diz se combina com JSON | camada grátis existe para os modelos Flash e TTS; **busca grátis: 5.000 por mês** (depois US$ 14 por 1.000) e teto de 1.500 por dia por projeto | Gemini 3.8 Flash: US$ 0,75 entrada / US$ 3,75 saída por 1 milhão de tokens até 31/12/2026, depois US$ 1,50 / US$ 7,50. Imagem (Flash Lite Image, 1K): cerca de US$ 0,034 | **não** (chave de API) |
| **API da Anthropic**, no código hoje | sim (`output_config.format`; limites: sem `minimum`/`maximum`/`minLength`/`maxLength`; o SDK ajusta o schema) | sim (bloco `image` junto com o schema) | sim (ferramenta `web_search`, versões `20250305`, `20260209`, `20260318`). A documentação de saída estruturada **não** diz se combina com a busca; o código usa duas chamadas | não | por chave (limites de taxa da organização) | Sonnet 5.5: US$ 2 entrada / US$ 10 saída por 1 milhão de tokens; Haiku 5.5 (até 100 mil tokens): US$ 0,10 / US$ 0,50; busca: **US$ 10 por 1.000 buscas** | **não** (chave de API) |
| **API compatível com OpenAI** (Ollama, LM Studio, OpenRouter, OmniRoute etc.), **não existe no código** | parcial: Ollama sim (`response_format` ou `format`; a nuvem do Ollama **não**); LM Studio sim (`json_schema`; modelos abaixo de 7B nem sempre conseguem); OpenRouter só em "modelos selecionados" | parcial: Ollama documenta modelos de visão; LM Studio e OpenRouter: não verificado; depende do modelo | não: Ollama e LM Studio não documentam busca. OpenRouter tem plugin de busca na web: não verificado | parcial: OpenRouter tem API de imagens própria (`/api/v1/images`, não é o formato de chat). Ollama e LM Studio: não verificado | local: limite é o hardware (RTX 3050 de 8 GB limita o tamanho do modelo); OpenRouter: créditos | local: zero; OpenRouter: por token | local: sem chave nenhuma (não há plano); OpenRouter: chave |

Sobre o **OmniRoute**: tratado só como "provedor compatível com OpenAI genérico". As resenhas apontam recursos suspeitos, então nada deste projeto deve depender de recurso próprio dele.

### Tarefa × provedor (serve?)

Resumo da combinação das duas tabelas acima. "sim" = os requisitos da tarefa estão cobertos pela documentação; **nenhuma** célula além do `agy`, Gemini e Anthropic foi testada em execução.

| Tarefa | agy | Claude Code | Codex | opencode | Cursor CLI | Gemini API | Anthropic API | OpenAI-compatível |
|---|---|---|---|---|---|---|---|---|
| Roteiro | sim | sim | sim | parcial (sem schema documentado: depende de zod + nova tentativa) | parcial (idem) | sim | sim | parcial (depende do modelo) |
| Checagem de fatos (busca) | sim | sim (WebSearch, a liberar) | sim (`--search`) | não verificado | não verificado | sim | sim | **não** sem provedor de busca à parte |
| Metadados | sim | sim | sim | parcial | parcial | sim | sim | parcial |
| Juiz de imagem (visão) | sim | parcial (via `Read` de arquivo) | sim (`--image`) | não verificado | parcial (por caminho de arquivo) | sim | sim | parcial (só modelo de visão) |
| Imagens ilustradas | sim (observado) | não | não verificado | não verificado | não verificado | sim (documentação; fora do código) | não | parcial (OpenRouter: API de imagens) |
| Cortes: seleção, conferência, compilação, metadados | sim | sim | sim | parcial | parcial | sim | sim | parcial (transcrição longa exige contexto grande) |
| Cortes: humor (visão, até 10 quadros) | sim | parcial | sim | não verificado | parcial | sim | sim | parcial |
| Voz | local (Kokoro) | local | local | local | local | local ou Gemini TTS | local | local |

## 4. Ressalvas de termos de uso (o dono decide)

- **Claude Code com plano.** Página oficial de aspectos legais: a autenticação por OAuth é "para uso comum" e quem cria produtos ou usa o Agent SDK deve usar chave de API; não é permitido a terceiros rotear pedidos pelas credenciais de plano em nome de usuários. Ao mesmo tempo diz que **cada usuário final pode entrar no binário original com a própria assinatura**. Rodar 30 vídeos por dia, sem parar, no plano pessoal do dono é uma **zona cinzenta** ("uso comum e individual"). Não vou afirmar que é permitido nem proibido; precisa de decisão do dono ou consulta à Anthropic.
- **opencode com Claude Pro/Max:** a própria documentação do opencode diz que a Anthropic proíbe e que removeu o suporte (versão 1.3.0).
- **agy:** a documentação de planos diz que os limites "podem mudar" e que não há chave própria. Os termos de uso automatizado do Google AI Pro/Antigravity continuam sem registro (item 5 da Parte A do marco 5): **não verificado**.
- **Codex, Cursor:** termos para uso automatizado com plano: não verificado.

## 5. O que o código tem HOJE × o que falta

### Hoje (confirmado no código)

- `LlmProvider` (`src/orchestrator/lib/llmClient.ts`) tem **2 métodos**: `completeJson(prompt, schema, imagens, opções)` e `completeGroundedText(prompt, opções)` (texto com busca, devolve fontes e consultas). Nomes aceitos: `"gemini" | "anthropic" | "antigravity-cli"`. O provedor padrão vem de `LLM_PROVIDER` (padrão `antigravity-cli`).
- Camada comum acima dos provedores: validação com zod e nova tentativa com correção, espera em limite de uso, nova tentativa em estouro de tempo, contagem de uso por etapa (`recordLlmUsage`).
- `footage.relevance.provider`: escolhe o provedor **só do juiz de imagem** (mesma lista de 3 nomes, validada em `lib/config.ts`).
- `llm.models.{script, factCheck, metadata, relevance}`: só o **nome do modelo** por etapa, sem escolher provedor. O nome é do provedor ativo (aliases do `agy` como `claude-sonnet-5-5-low` não valem na API da Anthropic). O formato terminal reaproveita `llm.models.metadata`.
- Cortes: seleção, conferência, humor, compilação e consultas alternativas de imagem **não recebem** provedor nem modelo do pipeline (as funções aceitam `provider`/`model`, mas `cuts/pipeline.ts` não passa); usam o padrão do ambiente. Só os metadados dos cortes usam `llm.models.metadata`.
- Imagem ilustrada: **amarrada ao `agy`** (`lib/illustrate.ts`: modelo fixo no código, lê a pasta interna do agy, confere se é imagem). Não está atrás da interface `LlmProvider`.
- Opções de raciocínio: `thinking` vira `thinkingLevel` no Gemini e `--effort` no `agy`; o provedor da Anthropic ignora `thinking` e **`temperature`** (não repassa) e fixa `max_tokens` em 4096.
- Fallback do `agy` só para o Gemini (`ANTIGRAVITY_FALLBACK`), desligado por padrão.
- Chaves de API podem ser guardadas pelo painel (`secrets/api-keys.json`, só escrita), mas a lista é fixa (Gemini, Anthropic, YouTube, Pexels, Pixabay). Não há campo para URL base nem para provedor novo.
- Provedor da Anthropic usa a ferramenta `web_search_20260209`; a documentação diz que, nessa versão, a busca roda por filtragem com código por padrão e que modelos sem chamada programática de ferramenta exigem `allowed_callers: ["direct"]`. Se o provedor da Anthropic já foi testado de ponta a ponta com busca: **não verificado**.

### Falta

1. **Contrato de capacidades.** Cada provedor declara: JSON por schema, imagem na entrada, busca na web, imagem na saída, contexto máximo. Na partida, o pipeline confere cada etapa ligada contra o provedor dela e **bloqueia** (nunca "pula em silêncio") o que não tiver capacidade. Em especial: checagem de fatos sem busca = não publica.
2. **Escolha de provedor (e modelo) por etapa**, não só no juiz: roteiro, checagem, metadados, juiz, cortes (cada função), imagem ilustrada. Hoje o nome do modelo é uma só lista para todos os provedores.
3. **Provedor "compatível com OpenAI"** (URL base, chave opcional, modelo): JSON por `response_format`, imagem por bloco `image_url`.
4. **Provedores por linha de comando** além do `agy`: Claude Code, Codex (depois opencode e Cursor CLI). Cada um segue o mesmo molde de segurança do `agy` (pasta temporária só com as imagens, ambiente sem chaves, ferramentas mínimas).
5. **Provedor de busca separado** do provedor de texto, para quem usa modelo local. Opções com busca confirmada: Gemini (5.000 buscas grátis por mês; a conta do marco 5 estima ~6 buscas por vídeo, então 2 vídeos por dia cabem folgado e 30 por dia passam), Claude Code (`WebSearch`), Codex (`--search`), API da Anthropic (US$ 10 por 1.000).
6. **Geração de imagem como capacidade própria**, com saída de emergência para o acervo de imagens (hoje só o `agy` gera).
7. **Cota em janelas de horas.** Detectar "cota esgotada, volta em X" e pausar a fila em vez de desistir em 1 minuto; distinguir "cota" de "falha". Alertar o dono.
8. **Verificação de login e de conexão** antes de rodar (o `agy` já avisa quando não está instalado; os outros não existem).
9. **Registro de custo e de uso** que não suponha só `gemini | anthropic` (o tipo de uso de LLM hoje é uma lista fechada de nomes).
10. **Testes de paridade**: o juiz de imagem do `agy` foi comparado com a API (90% de concordância). Para cada provedor novo, repetir o benchmark do juiz e uma checagem de fatos com roteiro com erro conhecido, antes de liberar.

### Ordem de implementação recomendada

| # | O quê | Por quê nessa posição |
|---|---|---|
| 0 | Contrato de capacidades + provedor por etapa (itens 1, 2 e 9) | Base de tudo; não adiciona provedor novo, então é seguro; evita refazer cada provedor depois |
| 1 | Provedor compatível com OpenAI genérico (item 3) | Cobre Ollama, LM Studio, OpenRouter e qualquer gateway com um só código; é HTTP simples; sem dúvida de termos de uso; permite rodar tarefas de texto de graça no PC. Entra **sem** checagem de fatos até existir busca (item 5) |
| 2 | Provedor de busca separado (item 5), junto com o 1 | Destrava a checagem de fatos para quem usa modelo local |
| 3 | Claude Code CLI (item 4) | As flags já foram conferidas pelo dono; o molde é o do `agy`; dá JSON, busca e visão por arquivo. Fazer **depois** de o dono decidir a ressalva de termos (seção 4). Testar a cota (item 7) antes de ligar em produção |
| 4 | Codex CLI | Tem flag nativa de imagem e de busca (a mais simples de usar), mas **precisa instalar e confirmar as flags no PC de casa** |
| 5 | Geração de imagem separada (item 6) | Só o `agy` faz hoje; vale esperar o resto estar estável. Antes, decidir se o produto promete "ilustrado" para quem não tem `agy` ou Gemini |
| 6 | opencode e Cursor CLI | A documentação não confirma schema nem busca; só sob demanda de usuário, depois de teste em casa |

## 6. Fontes consultadas (todas em 2026-11-02)

Código: `src/orchestrator/lib/llmClient.ts`, `antigravityCli.ts`, `antigravitySession.ts`, `relevance.ts`, `illustrate.ts`, `terminalCards.ts`, `secretStore.ts`; `src/orchestrator/stages/02-generateScript.ts`, `02b-factCheck.ts`, `03-fetchFootage.ts`, `04-synthesizeVoice.ts`, `07-generateMetadata.ts`; `src/orchestrator/cuts/select.ts`, `humor.ts`, `compilation.ts`, `metadata.ts`, `pipeline.ts`; `src/orchestrator/lib/config.ts`; `README.md`; `planejamento/marco-5-multicontas-e-antigravity.md`.

Documentação oficial:

- Claude Code, modo programático: https://code.claude.com/docs/en/headless
- Claude Code, referência de flags: https://code.claude.com/docs/en/cli-reference
- Claude Code, ferramentas (Read de imagens, WebSearch): https://code.claude.com/docs/en/tools-reference
- Claude Code, aspectos legais e uso de credenciais: https://code.claude.com/docs/en/legal-and-compliance
- Codex, modo não interativo: https://learn.chatgpt.com/docs/non-interactive-mode (antes em developers.openai.com/codex/noninteractive)
- Codex, flags: https://learn.chatgpt.com/docs/developer-commands?surface=cli
- Antigravity CLI, modo headless: https://antigravity.google/docs/cli/headless
- Antigravity, planos e limites: https://antigravity.google/docs/plans
- opencode, CLI: https://opencode.ai/docs/cli/ e provedores: https://opencode.ai/docs/providers/
- Cursor CLI, headless: https://cursor.com/docs/cli/headless e visão geral: https://cursor.com/docs/cli/overview
- Gemini API, preços: https://ai.google.dev/gemini-api/docs/pricing ; saída estruturada: https://ai.google.dev/gemini-api/docs/structured-output ; imagens: https://ai.google.dev/gemini-api/docs/image-generation
- Anthropic, saída estruturada: https://platform.claude.com/docs/en/build-with-claude/structured-outputs ; busca na web: https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool ; preços: https://platform.claude.com/docs/en/about-claude/pricing
- Ollama, saída estruturada: https://docs.ollama.com/capabilities/structured-outputs
- LM Studio, saída estruturada: https://lmstudio.ai/docs/developer/openai-compat/structured-output
- OpenRouter, saída estruturada: https://openrouter.ai/docs/guides/features/structured-outputs ; imagens: https://openrouter.ai/docs/guides/overview/multimodal/image-generation

## 7. Ficou "não verificado" (próximos testes)

- Claude Code: `WebSearch` funcionando no login de plano em `-p`; leitura de imagem em pasta temporária com `--tools`; janela e valores do limite do plano; termos para uso contínuo automatizado.
- Codex, opencode, Cursor CLI: tudo que não for da documentação (flags reais, instalação, saída em JSON, login, cota). Codex: geração de imagem. opencode e Cursor: schema, imagem, busca.
- `agy`: termos de uso automatizado; busca e geração de imagem só têm registro de teste do dono, não documentação oficial.
- Gemini: busca com schema numa só chamada (documentação diz que sim nos modelos 3; o código usa duas); imagem gerada junto com JSON; camada grátis de imagem.
- Anthropic: busca com saída estruturada numa só chamada; execução real com `web_search_20260209`.
- OpenAI-compatível: visão no LM Studio e no OpenRouter; busca no OpenRouter; imagem no Ollama e LM Studio; qualquer modelo local real na RTX 3050 contra o roteiro, a checagem e o juiz.
- Volumes por vídeo são estimativas; para número exato, somar o `llmUsage` dos `context.json` de execuções reais.
