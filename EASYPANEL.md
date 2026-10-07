# Publicar no EasyPanel (1 serviço)

Repositório: `WorkiDigital/worki-whatsapp-receptor` (privado). Branch implantada hoje: `claude/stoic-davinci-2x5yda` (a `main` só tem o README). **Atualizar o serviço com a nova entrega exige reimplantar; auto deploy está desligado.**

## Criar o serviço
| Campo | Valor |
|---|---|
| Tipo | **App** |
| Nome | `receptor` (em um projeto existente; não mexe nos outros serviços) |
| Source → GitHub | owner `WorkiDigital`, repo `worki-whatsapp-receptor`, branch `main` (ou `claude/stoic-davinci-2x5yda` enquanto não houver merge), path `/` |
| Build | **Dockerfile** (`Dockerfile` na raiz) |
| Environment | ver `.env.example` (`EVOLUTION_WEBHOOK_SECRET` e `ALLOWED_CLIENTS` são obrigatórias) |
| Mounts | **Volume** `receptor-data` → `/data` (obrigatório: é a fila) |
| Domains | host do EasyPanel (`*.easypanel.host`) ou subdomínio seu; HTTPS ligado; porta **3000** |
| Deploy → Replicas | **1** (processo único, trava por pid) |
| Auto deploy | desligado até validar |

Se o EasyPanel não enxergar o repositório privado: conecte o GitHub em *Settings → GitHub* do painel (ou use uma deploy key).

## Conferir
1. `GET https://<host>/health` → `{"ok":true,"pending":0,"done":0,"failed":0}`.
2. `POST` sem header → 401; com `X-Webhook-Secret` correto e `{"event":"qrcode.updated"}` → 200 `state_only`.
3. Só então aplicar o webhook na instância Evolution: URL `https://<host>/api/evolution/worki`, eventos `QRCODE_UPDATED`, `CONNECTION_UPDATE`, `MESSAGES_UPSERT`, header `X-Webhook-Secret`.

## Operação
- `/health` mostra contagens (sem conteúdo). Logs sem texto, remetente, conversa, segredo ou QR.
- Fila: diário em `/data/journal.jsonl` (contém mensagens: dado privado; definir retenção).
- Sem `FORWARD_URL` as mensagens ficam guardadas (`pending`); com ela, o worker entrega (3 tentativas, depois `failed`).

## Mudanças da versão com acessos e tarefas
- Novas variáveis: `ADMIN_SENDERS`, `OPERATOR_CONTACT` (ver `.env.example`). Conferir que `SEND_SECRET` aparece **uma vez**.
- O mesmo volume `/data` passa a guardar `access.jsonl` e `tasks.jsonl` além do `journal.jsonl`. Configurar backup do volume.
- `/health` passa a incluir `tasks` (contagem por estado) e `stalled`.
- Depois de reimplantar: conferir `/health`; pelo WhatsApp, o administrador cadastra pessoas e grupos.
