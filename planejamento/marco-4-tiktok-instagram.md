# Marco 4 — Publicar também no TikTok e no Instagram

Plano para levar o mesmo vídeo (1080x1920, H.264 + AAC, 45–90 s) a TikTok e Instagram Reels, além do YouTube.
Pesquisa feita em 2026-10-03; as regras dessas plataformas mudam com frequência, então reconferir a documentação oficial antes de implementar.

## Resumo

| | Instagram Reels | TikTok |
|---|---|---|
| Dá pra postar 100% sozinho? | **Sim**, na sua própria conta, sem revisão da Meta | **Não, por enquanto**: sem auditoria, todo post sai **privado** (só você vê) |
| Revisão do app | Não precisa (modo desenvolvimento + você como "Instagram Tester") | Auditoria da TikTok (~3 semanas, rejeições comuns, exige tela de confirmação por post) |
| Conta necessária | Instagram **Profissional** (Criador ou Empresa) | Conta TikTok normal + conta TikTok for Developers |
| Upload do arquivo | Direto do PC (upload "resumable"), sem precisar hospedar o vídeo | Direto do PC (`FILE_UPLOAD`) |
| Limite | ~50 posts por 24 h via API | Até 5 usuários/24 h em app não auditado |
| Recomendação | Implementar primeiro, totalmente automático | Começar no modo **rascunho** (vai pra caixa de entrada do app; você publica com 1 toque) |

## Instagram Reels (prioridade 1)

**O que você precisa fazer (só você pode, envolve contas e login):**
1. Converter o Instagram do canal em **conta Profissional → Criador** (Configurações → Tipo de conta).
2. Criar um app em developers.facebook.com, caso de uso **"Instagram API com login do Instagram"**.
3. Em **Funções do app → Funções → Instagram Testers**, adicionar o @ da conta e aceitar o convite no Instagram (Configurações → Apps e sites → Convites de testador).
4. Configurar a URL de redirecionamento do OAuth (usaremos uma página nossa no GitHub Pages, ver "Infraestrutura comum").
5. Colocar o App ID e o App Secret no `chaves.txt`.

**O que a máquina faz:**
- `scripts/auth_instagram.ts`: login único, com permissões `instagram_business_basic`, `instagram_business_content_publish` e `instagram_business_manage_insights`; troca o token curto pelo token longo (60 dias) e guarda em `secrets/instagram.token.json`.
- Renovação automática do token antes de vencer (o agendador renova quando faltar menos de 10 dias).
- Publicação: criar container `media_type=REELS` com `upload_type=resumable` → enviar o mp4 para `rupload.facebook.com` → consultar `status_code` até `FINISHED` → `media_publish`.
- Legenda própria do Instagram (até 2.200 caracteres, até 30 hashtags; créditos das imagens no fim).
- Métricas para o painel: plays, alcance, curtidas, comentários, salvamentos (Insights).

## TikTok (prioridade 2)

**A limitação principal:** a TikTok exige, para liberar posts públicos via API, que cada publicação passe por uma tela onde o criador vê a conta, escolhe a privacidade (sem valor padrão) e os controles de comentário/dueto/stitch. Isso é incompatível com "rodar sozinho", por desenho da própria TikTok.

**Caminho proposto:**
1. **Fase A — rascunho (semiautomático, sem auditoria):** a máquina envia o vídeo com o escopo `video.upload`; ele aparece na **caixa de entrada do app TikTok** e você publica com 1 toque (dá pra ajustar som em alta ali, o que costuma ajudar o alcance).
2. **Fase B — publicação direta (opcional):** criar no painel uma tela "Aprovar no TikTok" que cumpre as exigências (info do criador via `creator_info/query`, seletor de privacidade, toggles, aviso de conteúdo comercial) e pedir a auditoria. Mesmo aprovado, a regra continua exigindo uma confirmação humana por post, então isso vira "1 clique no painel" em vez de "1 toque no celular".

**O que você precisa fazer:** criar conta em developers.tiktok.com, criar o app, adicionar os produtos **Login Kit** e **Content Posting API**, cadastrar as URLs de Termos e Privacidade (vamos publicar no mesmo GitHub Pages) e a URL de redirecionamento, e colocar Client Key e Client Secret no `chaves.txt`.

**O que a máquina faz:** `scripts/auth_tiktok.ts` (OAuth com PKCE, tokens em `secrets/tiktok.token.json`, renovação automática); envio por `FILE_UPLOAD` em blocos; legenda até 2.200 caracteres; métricas via Display API (`video.list`: views, curtidas, comentários, compartilhamentos). Marcar o conteúdo como gerado por IA quando a API oferecer o campo (narração sintética).

## Infraestrutura comum (vale para os dois)

- **Publicadores plugáveis:** transformar o estágio de upload em "publicação" com um publicador por plataforma (`publishers/youtube.ts`, `instagram.ts`, `tiktok.ts`) atrás da mesma interface; cada um liga/desliga em Configurações, com limite diário próprio.
- **Falha isolada:** se uma plataforma falhar, as outras seguem; o painel mostra o status por plataforma, e um "republicar" tenta de novo só onde falhou.
- **Histórico por plataforma:** `data/history.json` ganha o campo `platform` (`youtube` | `instagram` | `tiktok`) e o ID/link do post em cada uma.
- **Metadados por plataforma:** o estágio 07 gera título/descrição do YouTube, legenda do Instagram e legenda do TikTok, cada uma no limite e estilo da rede.
- **Página de callback do OAuth:** `docs/oauth/callback.html` no GitHub Pages, que recebe o `code` e o devolve para o script local (ou mostra para copiar), já que Meta e TikTok exigem URL HTTPS cadastrada.
- **Termos de Serviço:** publicar `docs/termos.html` (a TikTok exige; a Meta pede para alguns casos).
- **Painel:** filtro por plataforma, views somadas e por rede, gráfico comparando desempenho, e a tela "Aprovar no TikTok" (se formos para a Fase B).
- **Configurações:** seção "Plataformas" com liga/desliga, privacidade, limite diário e status do login de cada rede (sem nunca exibir tokens).

## Riscos

- **Conteúdo repetido nas três redes:** TikTok e Instagram reduzem o alcance de vídeos com marca d'água de outra rede. Nossos vídeos saem limpos do render, sem marca, então não há esse problema; só não podemos baixar do YouTube e repostar.
- **Programas de monetização:** o Creator Rewards do TikTok exige vídeos com mais de 1 minuto; Reels e Shorts não exigem. Vale configurar uma duração mínima diferente por plataforma no futuro.
- **Tokens que expiram:** Instagram (60 dias) e TikTok (renovação periódica) precisam de renovação automática; o painel avisa se algum login cair.
- **Mudança de regras:** se a Meta ou a TikTok mudarem acesso, o publicador daquela rede é desligado sem afetar o resto.

## Ordem sugerida

1. Concluir o Marco 2 (YouTube) e validar o primeiro upload.
2. Refatorar o upload para publicadores plugáveis (sem credenciais, dá para fazer já).
3. Instagram Reels completo (depois que você criar o app da Meta).
4. TikTok Fase A (rascunho).
5. Marco 3 (agendamento) publicando nas três redes.
6. TikTok Fase B, se valer a pena depois de ver os números.
