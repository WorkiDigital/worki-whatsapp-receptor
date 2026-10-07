# A2 passo 0 — leitura do executor paralelo (2026-10-07)

Fonte lida antes da implementação: `WorkiDigital/worki-agency-agent`, branch `claude/intelligent-babbage-7m19gv`, commit `8c8ca31f16e1c0f8c36e5848aeac131e1563a976`. Não é código implantado.

| Arquivo | O que faz | Reaproveitamento / ajuste necessário |
|---|---|---|
| `src/agent/flows.js` | Encadeia criar/testar página, Git, Vercel READY, verificar URL, resposta | Preservar sequência e evidência por etapa; persistir checkpoints e operações incertas no receptor |
| `src/agent/page.js` | Gera HTML, serve em localhost para teste, verifica URL | Portar validação/title, hash, teste HTTP local e verificação; limitar arquivos e hosts, sem executar código arbitrário |
| `src/agent/instagram.js` | Rascunho, hash, publicação, releitura do post e limite semanal | Portar normalização/rascunho; hash passa a obrigatório e cobre conta, tipo, ordem e URL da mídia; timeout não volta para preparado |
| `src/agent/gitsave.js` | Branch nova, commit/push e ls-remote | Preservar branch nova e prova do SHA remoto; substituir shell/checkout pelo Git Database API para recurso fixo e credencial somente no receptor |
| `src/agent/policy.js` | Operador, permissões, pedido explícito e limites | Portar a composição das permissões de página; identidade e autorização vêm do token de tarefa e AccessStore, sem grant paralelo |
| `src/integrations/vercel.js` | POST /v13/deployments, GET do deployment | Reaproveitar shape de arquivos inline, preview sem target e produção explícita; acrescentar projeto fixo e reconciliação |
| `src/integrations/zernio.js` | GET posts e POST posts com publishNow | Reaproveitar shape apenas após conferir fonte; preparar nunca faz POST |

Lidos também `test/agent-flows.test.js`, `test/agent.test.js`, `test/integrations.test.js`, `test/zernio.test.js`: Git e HTTP locais reais, plataformas externas/WhatsApp simulados. Evidência de fixtures não prova respostas reais. O fluxo anterior não exige hash em todas as chamadas, restaura preparado em erro de POST, permite projeto Vercel pelo nome e devolve trechos de erro externo; esses comportamentos não serão transplantados.

Contratos: documentação oficial Vercel acessível para criação/leitura e GitHub para trees/commits/refs. Fonte anterior Zernio era indireta (`zernio-dev/zernio-api`, rules/posts.md); endpoint antigo de documentação falhou, mas índice oficial `https://docs.zernio.com/llms.txt` está acessível. Conferir schema atual antes de implementar publicação. Todas as escritas continuam sem teste real. Não há aprovação da reserva LLM.
