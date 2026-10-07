# worki-whatsapp-receptor

Receptor de webhooks da **Evolution API 2.3.7** (WhatsApp) como função da Vercel. Valida o segredo, filtra os eventos e só encaminha mensagens reais. **Não responde no WhatsApp.**

```
Evolution → POST /api/evolution/<cliente> → valida X-Webhook-Secret → filtra → (opcional) encaminha
```

| Evento | Tratamento |
|---|---|
| `qrcode.updated`, `connection.update` | 200, só estado no log (sem QR); nunca encaminha nem aciona IA |
| `messages.upsert` com `fromMe=true`, broadcast, outros eventos | 200 `ignored` |
| `messages.upsert` real | 202; duplicada 200 `duplicate`; encaminha em segundo plano (`waitUntil`) se `FORWARD_URL` existir |

## Variáveis de ambiente (projeto Vercel; nunca no Git)
| Variável | Uso |
|---|---|
| `EVOLUTION_WEBHOOK_SECRET` | **obrigatória**; mesmo valor do header `X-Webhook-Secret` configurado na instância. Sem ela: 503 |
| `ALLOWED_CLIENTS` | **obrigatória**; slugs aceitos na URL, separados por vírgula (ex.: `worki`) |
| `FORWARD_URL` | opcional (HTTPS); destino das mensagens reais. Vazio = só recebe e filtra (`accepted_no_destination`) |
| `FORWARD_TOKEN`, `FORWARD_EXTRA_HEADERS` | opcionais; Bearer e headers extras (JSON) do destino |

## Publicar
1. Vercel → *Add New → Project* → importe este repositório; defina as variáveis acima.
2. A URL do webhook da instância é `https://<projeto>.vercel.app/api/evolution/<cliente>`.
3. Na instância Evolution: `webhook{enabled:true, url, byEvents:false, events:[QRCODE_UPDATED, CONNECTION_UPDATE, MESSAGES_UPSERT], headers:{"X-Webhook-Secret": <segredo>}}`.

## Modo VPS / EasyPanel (fila durável) — 1 serviço
`server.js` + `Dockerfile`: mesma rota (`POST /api/evolution/<cliente>`) e mesmo filtro, mas a mensagem real vai para uma **fila durável em disco** (diário com fsync, deduplicação por cliente + id da mensagem que sobrevive a reinício) e um worker entrega ao destino com até 3 tentativas. Sem `FORWARD_URL`, as mensagens ficam guardadas na fila.
1. EasyPanel → *Create → App*, fonte GitHub (este repositório, branch `main`), build por **Dockerfile**.
2. *Mounts → Volume* persistente em `/data` (obrigatório; sem ele a fila se perde a cada deploy).
3. *Domains*: subdomínio com HTTPS apontando para a porta `3000`.
4. Variáveis: `EVOLUTION_WEBHOOK_SECRET`, `ALLOWED_CLIENTS` (opcional: `FORWARD_URL`, `FORWARD_TOKEN`, `FORWARD_EXTRA_HEADERS`). `GET /health` mostra pendentes/concluídas/falhas (sem conteúdo).
- Processo único (trava por pid); rodar **1 réplica**. Falhas definitivas ficam no diário; reprocessamento manual não está implementado. Não testado em Docker nem no EasyPanel.

## Limites (honestos)
- **Modo Vercel sem banco:** a deduplicação é em memória (10 min, 5000 ids) e vale só por instância da função; reentregas podem passar. Mensagens não ficam guardadas: se o destino falhar, a mensagem se perde. Para garantia, adicionar armazenamento (ex.: Redis do Marketplace da Vercel) e fila.
- **Formato do destino não validado:** o corpo enviado a `FORWARD_URL` é `{ "text": "..." }`; confirme o que o destino aceita antes de ligar.
- **Contrato Evolution** conferido no código oficial 2.3.7; **nenhum evento real recebido ainda**; função **não publicada**.
- Logs sem texto, remetente, conversa, segredo ou QR (testado).

`npm test` roda os testes locais (sem rede).
