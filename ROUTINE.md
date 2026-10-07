# Assistente da Worki pelo WhatsApp (receptor + rotina Claude)

```
WhatsApp → Evolution → receptor (verifica, fila, permissões) → rotina Claude (executor) → API do receptor → Evolution → WhatsApp
                                                                   └→ Zernio / GitHub / Vercel (credenciais da rotina)
```
Nada de IA no código do receptor: o executor é a rotina Claude (assinatura). O receptor **não usa n8n**: é o servidor Node de `server.js`, com fila e estado em disco (`/data`).

## O que o código garante (não depende do prompt)
- **Identidade:** o remetente vem do webhook verificado. A cada pedido o receptor emite um **token de tarefa** ligado a esse remetente; toda chamada da rotina exige `X-Send-Secret` + `Authorization: Bearer <token da tarefa>`. O modelo não declara quem é o remetente.
- **Permissões:** `lib/access.js`. Administradores iniciais por variável de ambiente; demais pessoas em `/data/access.jsonl` (quem concedeu, escopo, validade, revogações). Conferidas **a cada chamada**: revogação, suspensão, expiração ou grupo removido bloqueiam até tarefas já na fila.
- **Grupos:** só grupos registrados, e o remetente individual também precisa de acesso. Estar no grupo não concede nada. Administração de acessos só em conversa privada.
- **Ciclo da tarefa** (`lib/tasks.js`): `persisted → dispatched → started → external_done → verified → replied`, com desvios `dispatch_failed`, `dispatch_uncertain`, `failed`, `uncertain`, `revoked`, `handoff`. "Rotina acionada" é só `dispatched`.
- **Sem repetição cega:** disparo sem resposta (timeout) fica `dispatch_uncertain` e não é refeito; operação externa incerta só é repetida depois de reconciliar (criar grupo procura o grupo antes de recriar).
- **Mensagens e respostas de ferramentas não alteram permissões**: só chamadas administrativas de um administrador autenticado pelo token.

## API (todas `POST`, JSON, headers `X-Send-Secret` e `Authorization: Bearer <token da tarefa>`)
| Rota | Função |
|---|---|
| `/api/task/reply` `{text, final?}` | Responde na conversa da tarefa (destino derivado da tarefa; `to` do corpo é ignorado). `final:false` mantém a tarefa aberta (atualização de progresso) |
| `/api/ops/me` | Permissões efetivas e conversa |
| `/api/ops/can` `{op, client?}` | Pode fazer a operação? (consulta; **não** é a barreira das escritas externas: ver "Limite honesto") |
| `/api/ops/record` `{op, client?, status, platform, ref, evidence, idempotencyKey?}` | Registra operação (`started/done/verified/failed/uncertain`; `done`/`verified` exigem evidência). **Escrita externa** (`publish_instagram`, `deploy_*`, `edit_repo`, `send_email`, campanhas) não pode ser certificada pelo executor: `done`/`verified` voltam `409 mediated_only`. Devolve `previous` |
| `/api/ops/page/publish` `{client, slug, html, target, idempotencyKey?}` | Com flags e vínculos ativos, salva HTML estático no GitHub, publica na Vercel, relê o deployment e verifica a URL. Retorna `status=verified`, URL, deployment ID, referência do commit e hash. Com flag desligada retorna `503 operation_disabled`; o pedido não escolhe repo/projeto livremente |
| `/api/ops/instagram/prepare` `{client, caption, mediaItems[]}` | Guarda o rascunho no receptor, devolve `draft.id` e hash completo; não chama Zernio |
| `/api/ops/instagram/publish` `{client, draftId, contentHash, idempotencyKey?}` | Com `WRITE_ZERNIO_ENABLED=true`, publica o rascunho vinculado, usa `Idempotency-Key`, relê o post e só certifica com `platformPostUrl`; hash ausente ou divergente é recusado |
| `/api/ops/history` `{client?, limit?}` | Pedidos anteriores (a pessoa vê os seus; administrador vê todos) |
| `/api/ops/handoff` `{reason}` | Avisa de fato o atualizador (`OPERATOR_CONTACT`). Sem contato configurado devolve erro: **não prometa humano** |
| `/api/ops/whatsapp/create-group` `{client?, subject, participants[], includeRequester?, description?, register?, allowDuplicate?}` | **Antes de criar, lista os grupos**: se já existe um com o mesmo nome, devolve `status: exists` e **não cria** (só `allowDuplicate:true` cria outro); se não conseguir listar, não cria. Depois de criar, **verifica** (`findGroupInfos`) e informa `missing` (pedidos ausentes) e `unexpected` (presentes que ninguém pediu, exceto a conta criadora). Idempotente |
| `/api/ops/whatsapp/poll` `{name, values[2-10], selectableCount?}` · `/react` `{reaction, messageId?}` · `/ghost-mention` `{text, everyone? \| mentioned[]}` | Operações de WhatsApp com permissão própria |
| `/api/admin/access` `{action: grant\|suspend\|reactivate\|revoke\|revoke_grant\|get\|list, number, name, clients[], ops[], mode?: add\|set, expiresAt?}` | Gestão de acessos (resposta = leitura do que ficou registrado) |
| `/api/ops/plan` e `/api/ops/approval` | Planejamento sem execução e pedido de autorização vinculado ao conteúdo |
| `/api/admin/approvals` `{action: approve\|deny\|list, code?}` | Aprovação pelo administrador em conversa privada |
| `/api/admin/groups` `{action: register\|remove\|list, jid, client}` | Grupos atendidos |
| `/api/admin/tasks` `{state?, limit?}` | Estado das tarefas (investigar travadas) |
`/api/send` (sem token de tarefa) continua só por compatibilidade com o prompt antigo: envia apenas a quem tem acesso. Remover quando a rotina migrar.

## Operações e escopo
Catálogo em `lib/catalog.js` (espelha `OPERATIONS` do repositório `worki-agency-agent`). `manage_access` só administradores do ambiente concedem; quem tem `manage_access` num cliente concede apenas operações que ele próprio tem, só nesse cliente; `"*"` só administrador do ambiente; revogado só volta por concessão de administrador do ambiente. Escritas externas exigem também vínculo em `/data/resources.json`.

## Limite honesto (escritas em Zernio, GitHub e Vercel)
As escritas em Zernio, GitHub e Vercel passam pelas rotas mediadas de [docs/escrita-mediada.md](docs/escrita-mediada.md). A rotina não recebe essas credenciais. Se uma rota responder `operation_disabled`, informe o bloqueio e chame `handoff`; nunca diga que publicou. O `record` continua recusando `done`/`verified` (`mediated_only`) para escritas externas feitas fora do receptor.

## Variáveis do serviço
Ver `.env.example`. Novas: `ADMIN_SENDERS` (cai em `ALLOWED_SENDERS` se vazio), `OPERATOR_CONTACT`, `REPLY_MAX_CHARS`, `TASK_MAX_REPLIES`, `TASK_TTL_SECONDS`, `WRITE_GITHUB_ENABLED`, `WRITE_VERCEL_ENABLED`, `WRITE_ZERNIO_ENABLED`, `GITHUB_TOKEN`, `VERCEL_TOKEN`, `VERCEL_TEAM_ID` e `ZERNIO_API_KEY`. As três flags começam `false`. As credenciais ficam somente no receptor; `resources.json` em `/data` vincula cliente a repositório, projeto e conta. **`SEND_SECRET` deve existir uma única vez** (use `node scripts/env-audit.js` para conferir). Rotação sem parada: `SEND_SECRET_NEXT` e `EVOLUTION_WEBHOOK_SECRET_NEXT` valem junto do principal e ser exclusivo da rotina (≠ `EVOLUTION_WEBHOOK_SECRET`).

## Acionamento da rotina
`POST https://api.anthropic.com/v1/claude_code/routines/<trig_...>/fire`, `Authorization: Bearer <token da rotina>`, `anthropic-beta: experimental-cc-routine-2026-04-01`, `anthropic-version: 2023-06-01`, corpo `{"text": "..."}` (research preview; 30/h por rotina, 100/h na conta). O texto chega à rotina embrulhado como dado não confiável (`<routine-fire-payload>`).

## Configurar a rotina (passo do operador; não feito pelo código)
1. **Prompt:** usar o de [docs/routine-prompt.md](docs/routine-prompt.md).
2. **Repositório:** anexar `WorkiDigital/worki-agency-agent` (skills e documentação).
3. **Ambiente da rotina:** só `SEND_SECRET`. **Sem** credenciais de escrita de Zernio, GitHub ou Vercel (ver "Limite honesto"). Variáveis do ambiente são visíveis a quem o usa.
4. **Rede:** permitir apenas `n8n-receptor.ubufeb.easypanel.host` (receptor) e, para ler este repositório, `github.com`.
5. **Conectores:** remover todos os que a rotina não precisa (por padrão entram todos, sem aprovação, e ela lê texto vindo do WhatsApp).
6. Reimplantar o receptor com a branch desta entrega e **cadastrar o grupo/pessoas pelo WhatsApp** (administrador).

## Recuperação e persistência
Estado em `/data` (volume `receptor-data`): `journal.jsonl` (fila), `access.jsonl` (acessos e grupos), `tasks.jsonl` (tarefas e operações), `mediated.jsonl` (idempotência das escritas) e `resources.json` (vínculos privados). Reiniciar reconstrói tudo por reexecução dos diários (cauda truncada é ignorada). **Backup do volume** é configuração do EasyPanel (não feita aqui); sem ele, perder o volume perde acessos e histórico. Os diários contêm dados privados: definir retenção.

## Histórico opcional

`HISTORY_ENABLED=false` por padrão. Quando ligado, o receptor inclui antes do pedido atual até `HISTORY_MESSAGES=10` mensagens dos últimos `HISTORY_MAX_AGE_HOURS=24`, com 500 caracteres cada. O bloco de histórico é conteúdo não confiável: não concede autorização nem substitui a mensagem atual.

## Menção em grupos

`GROUP_REQUIRE_MENTION=false` por padrão. Quando ligado, só despacha menção ao `AGENT_NUMBER` ou resposta a mensagem do agente em grupo registrado. Sem número configurado usa `sender` do webhook. Sem ambos, libera o despacho autorizado, registra `mention_filter_inactive` com código `self_unknown` e avisa no /health. A regra não concede acesso. `data.contextInfo` e contextInfo de texto estendido, imagem e vídeo são compatibilidades cobertas por fixtures; captura real na Evolution 2.3.7 continua pendente.

## Avisos opcionais de acesso

`UNKNOWN_ALERT_ENABLED=false` controla somente privados sem acesso. `GROUP_ALERT_ENABLED=false` controla separadamente grupos não registrados; o aviso de grupo contém apenas o JID, nunca seu texto. Configurar `OPERATOR_CONTACT`. Um aviso por origem/24h e `ALERT_PER_HOUR=5` no total, sem responder ao desconhecido. Texto de privado fica excluído salvo `ALERT_INCLUDE_TEXT=true`. Reserva durável antes do envio em segundo plano; a fila não espera a rede. Rejeições do despacho registram somente `alert_failed`. O aviso não concede acesso; a liberação continua exigindo administrador autenticado e escopo explícito.

O script `scripts/backup.js` inclui `history.jsonl` e `alerts.jsonl`, quando presentes, em create/verify/restore, com SHA-256 por arquivo. Backups contêm dados privados e devem permanecer fora do Git. Histórico de mensagens de grupo não dirigidas ao agente continua fora do escopo.
