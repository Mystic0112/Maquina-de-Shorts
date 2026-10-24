# CapCut — automação de "templates" (gerar projeto por código)

> Handoff para outra sessão de IA. **Leia o `AGENTS.md` da raiz antes de mexer em qualquer coisa.**
> Status em 2026-10-24: **prova de conceito CONCLUÍDA e validada** (abriu no CapCut com o vídeo trocado). Falta virar módulo da pipeline.

## Como isto foi levantado (importante)

Nada aqui veio de documentação oficial do CapCut. Tudo foi descoberto **olhando os arquivos de
projeto do CapCut** (são JSON em texto) e **testando na prática**: criar um projeto, trocar
valores, abrir no editor e **conferir por prints (capturas de tela)** se o resultado bateu.
Ou seja, boa parte é **suposição confirmada empiricamente** — hipótese testada, não verdade
garantida. Pode variar entre versões do CapCut. Quando mexer, **confirme abrindo no editor**.

## 1. Objetivo

Reproduzir, **por fora**, o comportamento de "template de vídeo" do CapCut: pegar um
projeto-mestre (com o estilo pronto — efeitos, legendas, transições, cortes) e **trocar a
mídia** automaticamente, gerando um novo projeto que o CapCut abre pronto. Fim: a Máquina de
Shorts montar o projeto CapCut sem ninguém abrir o editor na mão.

O caminho é **só manipular os arquivos JSON** do projeto — não é preciso mexer no programa do
CapCut em si. A lógica que importa está nos dados.

## 2. Como o CapCut guarda um projeto (observado nos arquivos)

Versão observada: **CapCut 9.6.0.4097** (Windows). Os projetos são arquivos JSON em texto.

- Raiz dos projetos: `C:\Users\<user>\AppData\Local\CapCut\User Data\Projects\com.lveditor.draft\`
- Cada projeto é **uma pasta** (ex.: `0116`). Arquivos que importam:
  - `draft_content.json` — **a timeline inteira** (o coração). Também há `.bak` e `.tmp`.
  - `draft_meta_info.json` — metadados do projeto + lista de materiais importados (com caminhos).
  - `draft_cover.jpg` — miniatura.
  - vários auxiliares (`draft.extra`, `key_value.json`, `attachment_editing.json`, etc.).
- `root_meta_info.json` (na raiz de `com.lveditor.draft`) — **registro** de todos os projetos
  (`all_draft_store[]`), com nome, caminho, id, duração.

### Estrutura do `draft_content.json`
- **Tempo em MICROSSEGUNDOS** (ex.: `"duration": 65133333` = 65,13 s). Não confundir com ms.
- `canvas_config` → `width`/`height`/`ratio` do projeto.
- `tracks[]` → cada trilha tem `segments[]`. Cada segmento referencia:
  - `material_id` → aponta para um item em `materials.*`.
  - `extra_material_refs[]` → efeitos/velocidade/denoise/etc. aplicados.
  - `source_timerange` (trecho usado da mídia) e `target_timerange` (onde fica na timeline),
    ambos `{start, duration}` em µs.
- `materials{}` → arrays por tipo: `videos`, `audios`, `images`, `texts`, `text_templates`,
  `effects`, `speeds`, `canvases`, `transitions`, `placeholder_infos`, ... Os segmentos só
  **referenciam por id**; os dados ficam aqui.
  - Um `video` tem: `id`, `path` (caminho absoluto, **com barra normal `/`**), `material_name`,
    `width`, `height`, `duration`, `local_material_id`, etc.
- Caminhos relativos ao projeto usam um placeholder tipo `##_draftpath_placeholder_<GUID>_##/...`
  (parece ser o que torna o projeto portável entre pastas). Efeitos de *beauty* referenciam o
  vídeo por esse placeholder + o `material_id` — por isso **não mude o `material_id`** ao trocar
  a mídia; só troque o `path`/dimensões. (Suposição confirmada no teste: os efeitos ficaram.)

### Campos que parecem ser de "template/slot"
`is_placeholder`, `placeholder_infos[]`, `template_id`, `template_scene`, `text_templates[]`,
`uneven_animation_template_info`. Pela ajuda oficial do CapCut, clipes substituíveis
(placeholder) **só podem ser DEFINIDOS no Mobile/Web — o PC não cria**. Pra automação isso não
importa: a gente escolhe por código qual segmento trocar.

### Comportamentos do app notados nos testes
1. **O CapCut re-escaneia a pasta `com.lveditor.draft` sozinho.** Bastou criar uma pasta de
   projeto válida que ele detectou e listou. **Não foi preciso editar `root_meta_info.json`.**
2. Ao re-escanear, ele **mostrou o nome da PASTA como nome de exibição** (ignorou o `draft_name`
   do meta). ⇒ pra controlar o nome mostrado, **nomeie a pasta** com o nome final.
3. Com o CapCut **aberto**, ele reescreveu o `root_meta_info.json` por cima. ⇒ rode a automação
   com o **CapCut fechado** (ou aceite que o registro vai ser o do scan dele).
4. Export automático via libs externas (pyJianYingDraft/pyCapCut) é descrito como suportado
   **só no Windows** — combina com o setup (produção é o PC de casa).

## 3. Prova de conceito (já funcionou)

Script que **clona o `0116`** e **troca o vídeo** pelo Short mais recente de
`render_output/*/final.mp4`. **Validado por print:** o CapCut abriu o projeto `poc_...` com o
Short novo na timeline (~65 s), 1080x1920, 30 fps, com o `0116` **intacto** e backup do
registro. Os efeitos continuaram (mantivemos os `material_id`).

> **Script versionado no repo:** [`python/capcut/clone_draft.py`](../python/capcut/clone_draft.py)
> (função reutilizável: `clone_and_swap`).

O que ele faz:
1. Copia a pasta do projeto de origem.
2. Gera novos GUIDs (`draft_content.id` e `draft_meta.draft_id`).
3. Acha o **1º segmento de vídeo**, pega o `material_id`, e no material correspondente troca
   `path`/`material_name`/`width`/`height`/`duration` (sondados com `ffprobe`).
4. Ajusta `source_timerange`/`target_timerange` do segmento e a `duration` do projeto.
5. Atualiza `draft_meta_info.json` (inclui a lista `draft_materials`).
6. Registra em `root_meta_info.json` com backup (opcional, já que o CapCut re-escaneia).

Rodar (da raiz do repo; python = `.venv\Scripts\python.exe` ou outro 3.10+):
```bash
python python/capcut/clone_draft.py                                  # 0116 + Short mais recente
python python/capcut/clone_draft.py --video "C:/caminho/meu.mp4" --name "Teste 1"
python python/capcut/clone_draft.py --list                           # lista projetos
```
Opções extras: `--src-id <pasta>` (projeto de origem) e `--user-data <caminho>` /
env `CAPCUT_USER_DATA` (pasta "User Data" do CapCut, caso não seja o padrão).

Sonda o vídeo com o ffprobe do Remotion (`node_modules/@remotion/compositor-*/ffprobe.exe`).
Nada é publicado nem enviado: tudo local.

## 4. Limitações da PoC (resolver no módulo)

1. **Só troca o 1º segmento de vídeo.** Um template real tem vários slots (vídeo, áudio,
   texto). Precisa mapear por índice/ordem ou por marcação.
2. **Não troca áudio nem texto/legenda.** A narração (Kokoro) e as legendas da Máquina de
   Shorts precisam entrar nos `materials.audios` / `materials.texts` + segmentos próprios.
3. **Nome de exibição** = nome da pasta (o CapCut parece ignorar `draft_name`). ⇒ nomear a pasta.
4. **Duração**: a PoC estica/encolhe o slot para a duração do vídeo. Num template de verdade,
   o certo pode ser **manter a duração do slot** e cortar a mídia (`source_timerange`), pra não
   quebrar o timing de transições/beats. Decidir por caso e **conferir no editor**.
5. **Capa** continua a do projeto de origem até o CapCut regerar.
6. **Caminhos**: sempre barra normal `/` nos `path` do JSON; `draft_root_path` usa `\\`.
7. **CapCut aberto** reescreve o registro — rodar com ele fechado.

## 5. Ajuste de conceito do "projeto-mestre"

O vídeo trocado deve ser **matéria-prima crua**, e o **projeto-mestre** carrega o ESTILO
(transições, legendas animadas, efeitos, cortes no beat). Cada Short novo herda o estilo.
Montar 1 mestre no CapCut na mão (ou alguns, por nicho: história/ciência/espaço) e anotar os
ids dos slots que o script vai preencher. Alternativa: gerar o `draft_content.json` do zero com
**pyCapCut** (porta do pyJianYingDraft pro CapCut) — mais trabalho, mais controle.

Referências de formato:
- pyJianYingDraft: https://github.com/GuanYixuan/pyJianYingDraft
- pyCapCut (irmão pro CapCut): procurar `pyCapCut` do mesmo autor.
- Ajuda CapCut (clipes substituíveis só Mobile/Web): https://www.capcut.com/help/how-to-set-replaceable-material-clips

## 6. Plano do módulo (sugestão)

1. Evoluir o módulo já criado em [`python/capcut/clone_draft.py`](../python/capcut/clone_draft.py)
   (a função reutilizável é `clone_and_swap`). Seguir o padrão do repo (ver `python/cuts/`),
   inclusive adicionar `python/capcut/test_*.py`.
2. API: `montar_projeto(mestre_id, {video, audio, legendas, nome})` → cria a pasta nomeada.
3. Trocar **múltiplos** materiais por papel (slot nomeado), não por índice fixo.
4. Inserir **áudio** (narração Kokoro) e **legendas** como materiais+segmentos.
5. Validar: abrir o JSON gerado e **conferir que o CapCut abre sem erro** (teste manual por
   print + futura checagem automática de schema).
6. Testes (padrão do `AGENTS.md`): `npx tsc --noEmit`, `npx vitest run`, e unittest do Python
   do módulo novo. **Rodar os testes antes de commitar.**
7. Integração opcional no `src/orchestrator/runPipeline.ts` como estágio final alternativo ao
   render direto — **sem publicar nada** (publicação é decisão do dono).

## 7. Regras do projeto a respeitar (do AGENTS.md)

- **Não publicar**, não ligar upload/instagram, não mexer no agendador ou em `secrets/`.
- Não commitar `render_output/`, `data/history.json`, vídeos/áudios, nem `User Data` do CapCut.
- Faça o que foi pedido; prefira editar arquivos existentes; leia antes de editar; commits em
  português explicando o porquê.
- Downloads/renders/testes pesados rodam no **PC de casa (Windows)**, não no Linux.
