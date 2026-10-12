# Marco 5 — 15 contas independentes e Antigravity CLI como motor de IA

Decisões do dono (2026-10-12):
- **~15 contas independentes** (YouTube Shorts, TikTok e Instagram), **2 vídeos por dia cada**, conteúdo próprio por conta (≈ 30 vídeos únicos/dia). Nunca o mesmo vídeo ou roteiro em duas contas.
- **Testar o Antigravity CLI** (conta Google AI Pro do dono) como motor das chamadas de IA no lugar da API paga, antes de migrar.
- O dono confere tudo à noite e aceita consertar falhas no dia seguinte.

## Parte A — teste de viabilidade do Antigravity CLI (fazer primeiro)

Estado em 2026-10-12: o comando `antigravity` instalado (`D:\Antigravity\Antigravity\bin\antigravity.cmd`, v1.107.0) é o **editor**; não aceita prompt não-interativo. É preciso instalar o **Antigravity CLI** (agente de terminal) e verificar:

1. Modo não-interativo: recebe um prompt por argumento ou stdin e sai com código de saída (sem pedir confirmação).
2. Entrada de imagens (até 3 quadros por chamada) e saída em JSON validável.
3. Login persistente sem intervenção (o agendador roda sem ninguém na frente do PC).
4. Limites do Google AI Pro por minuto e por dia frente ao volume: ~45 chamadas por vídeo × 30 vídeos = **~1.350 chamadas/dia**, mais ~30 narrações e ~180 buscas na web.
5. Termos de uso do Google AI Pro/Antigravity para uso automatizado (decisão do dono; registrar o que diz).

Implementação do teste: novo provedor `LLM_PROVIDER=antigravity-cli` em `src/orchestrator/lib/llmClient.ts`, ligado só para a avaliação de imagens (`footage.relevance`) por configuração. Rodar com ~20 imagens que já têm nota do Gemini via API (estão nos `context.json` de `render_output/`) e medir: concordância de notas, falhas, tempo por chamada, se a cota aguenta. **Critério para seguir:** ≥ 90% de concordância no "aprova/reprova", < 2% de falhas, sem intervenção manual em 50 chamadas seguidas. Se passar, migrar etapa por etapa (roteiro, checagem de fatos, metadados; a voz depende de o CLI gerar áudio). A API fica como reserva automática quando o CLI falhar.

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

## Riscos (o dono decide)

- **Banimento em cadeia:** as três redes punem conteúdo produzido em massa e contas ligadas entre si (mesmo dispositivo, IP, e-mail, cartão). Separar identidades e manter conteúdo realmente diferente por conta reduz, mas não elimina.
- **Custo pela API a 30 vídeos/dia:** ~US$ 145/mês até dez/2026 e ~US$ 290/mês depois (buscas na web passam da cota grátis de 5.000/mês). É o motivo do teste da Parte A.
- **Capacidade do PC:** render ocupa ~3,5 h/dia; quedas de energia ou suspensão atrasam a fila.

## Ordem sugerida

1. Parte A (teste do CLI) e pendências do `AGENTS.md`.
2. Multicontas com 2 contas de teste (1 YouTube + 1 Instagram) até estabilizar.
3. Escalar para as 15, em lotes, observando métricas e avisos de política de cada rede.
