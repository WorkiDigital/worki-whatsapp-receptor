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
| `/api/ops/can` `{op, client?}` | Pode fazer a operação? Chamar **antes** de operar em Zernio/GitHub/Vercel |
| `/api/ops/record` `{op, client?, status, platform, ref, evidence, idempotencyKey?}` | Grava o resultado de operação em outra plataforma (`started/done/verified/failed/uncertain`; `done` e `verified` exigem evidência). Devolve `previous`: se já `verified`, **não repetir** |
| `/api/ops/history` `{client?, limit?}` | Pedidos anteriores (a pessoa vê os seus; administrador vê todos) |
| `/api/ops/handoff` `{reason}` | Avisa de fato o atualizador (`OPERATOR_CONTACT`). Sem contato configurado devolve erro: **não prometa humano** |
| `/api/ops/whatsapp/create-group` `{client?, subject, participants[], includeRequester?, description?, register?}` | Cria, **verifica** (`findGroupInfos`) e informa participantes ausentes. Idempotente |
| `/api/ops/whatsapp/poll` `{name, values[2-10], selectableCount?}` · `/react` `{reaction, messageId?}` · `/ghost-mention` `{text, everyone? \| mentioned[]}` | Operações de WhatsApp com permissão própria |
| `/api/admin/access` `{action: grant\|set\|suspend\|reactivate\|revoke\|revoke_grant\|get\|list, number, name, clients[], ops[], expiresAt?}` | Gestão de acessos (resposta = leitura do que ficou registrado) |
| `/api/admin/groups` `{action: register\|remove\|list, jid, client}` | Grupos atendidos |
| `/api/admin/tasks` `{state?, limit?}` | Estado das tarefas (investigar travadas) |
`/api/send` (sem token de tarefa) continua só por compatibilidade com o prompt antigo: envia apenas a quem tem acesso. Remover quando a rotina migrar.

## Operações e escopo
Catálogo em `lib/catalog.js` (espelha `OPERATIONS` do repositório `worki-agency-agent`). `manage_access` só administradores do ambiente concedem; quem tem `manage_access` num cliente concede apenas operações que ele próprio tem, só nesse cliente; `"*"` só administrador do ambiente; revogado só volta por concessão de administrador do ambiente.

## Limite honesto
Para Zernio, GitHub e Vercel as credenciais ficam no ambiente da rotina: o receptor **não** consegue impedir tecnicamente uma chamada direta. A barreira ali é `can` + `record` + prompt/skills. Se isso não bastar, o próximo passo é fazer o receptor intermediar essas chamadas.

## Variáveis do serviço
Ver `.env.example`. Novas: `ADMIN_SENDERS` (cai em `ALLOWED_SENDERS` se vazio), `OPERATOR_CONTACT`, `REPLY_MAX_CHARS`, `TASK_MAX_REPLIES`, `TASK_TTL_SECONDS`. **`SEND_SECRET` deve existir uma única vez** e ser exclusivo da rotina (≠ `EVOLUTION_WEBHOOK_SECRET`).

## Acionamento da rotina
`POST https://api.anthropic.com/v1/claude_code/routines/<trig_...>/fire`, `Authorization: Bearer <token da rotina>`, `anthropic-beta: experimental-cc-routine-2026-04-01`, `anthropic-version: 2023-06-01`, corpo `{"text": "..."}` (research preview; 30/h por rotina, 100/h na conta). O texto chega à rotina embrulhado como dado não confiável (`<routine-fire-payload>`).

## Configurar a rotina (passo do operador; não feito pelo código)
1. **Prompt:** usar o de [docs/routine-prompt.md](docs/routine-prompt.md).
2. **Repositório:** anexar `WorkiDigital/worki-agency-agent` (skills e documentação).
3. **Ambiente da rotina:** `SEND_SECRET`; `ZERNIO_API_KEY`; `VERCEL_TOKEN` (e `VERCEL_TEAM_ID`); acesso GitHub com escopo mínimo aos repositórios necessários. Variáveis do ambiente são visíveis a quem o usa.
4. **Rede:** permitir `n8n-receptor.ubufeb.easypanel.host` (receptor), `api.zernio.com`, `api.vercel.com`, `github.com`/`api.github.com`.
5. **Conectores:** remover todos os que a rotina não precisa (por padrão entram todos, sem aprovação, e ela lê texto vindo do WhatsApp).
6. Reimplantar o receptor com a branch desta entrega e **cadastrar o grupo/pessoas pelo WhatsApp** (administrador).

## Recuperação e persistência
Estado em `/data` (volume `receptor-data`): `journal.jsonl` (fila), `access.jsonl` (acessos e grupos), `tasks.jsonl` (tarefas e operações). Reiniciar reconstrói tudo por reexecução dos diários (cauda truncada é ignorada). **Backup do volume** é configuração do EasyPanel (não feita aqui); sem ele, perder o volume perde acessos e histórico. Os diários contêm dados privados: definir retenção.
