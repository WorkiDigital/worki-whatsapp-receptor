# Implantação: configuração final, backup, rollback e rotação de segredos

**Estado: preparado, NÃO executado.** Nada deste documento foi aplicado em produção. A imagem Docker não foi construída nem testada no EasyPanel.

## 1. O que vai ao ar
| Item | Valor |
|---|---|
| Serviço | EasyPanel, projeto `n8n`, app `receptor` (1 réplica, volume `receptor-data` em `/data`, porta 3000) |
| Fonte hoje | `WorkiDigital/worki-whatsapp-receptor`, branch `claude/stoic-davinci-2x5yda`, commit `e85ea2e` |
| Fonte nova | mesmo repositório, branch `claude/keen-volta-3j55r7` (commit final: ver "Verificação final" no fim) |
| Rollback | voltar a fonte para `claude/stoic-davinci-2x5yda` (`e85ea2e`) e reimplantar; ver seção 5 |

## 2. Configuração final do serviço (nomes; valores só no EasyPanel)
| Variável | Situação | Observação |
|---|---|---|
| `EVOLUTION_WEBHOOK_SECRET` | rotacionar | header `X-Webhook-Secret` da instância; ≠ todos os outros |
| `ALLOWED_CLIENTS` | manter (`worki`) | |
| `ADMIN_SENDERS` | **nova** | número do administrador (DDI+DDD+número). Tem prioridade sobre `ALLOWED_SENDERS` |
| `ALLOWED_SENDERS` | **remover** depois de `ADMIN_SENDERS` | evita ambiguidade |
| `OPERATOR_CONTACT` | **nova** | contato do atualizador para o handoff (dado pessoal) |
| `SEND_SECRET` | **uma única vez**; rotacionar | segredo só da rotina. Hoje aparece 2× com valores diferentes |
| `REPLY_ENABLED` | `true` | |
| `PUBLIC_BASE_URL` | manter | HTTPS |
| `FORWARD_URL` | manter | disparo da rotina |
| `FORWARD_TOKEN` | rotacionar | gerar de novo na rotina (token mostrado uma vez; **Regenerate** invalida o anterior, conforme a documentação) |
| `FORWARD_EXTRA_HEADERS` | manter | `anthropic-beta: experimental-cc-routine-2026-04-01`, `anthropic-version: 2023-06-01` |
| `EVOLUTION_API_URL`, `EVOLUTION_INSTANCE` | manter | instância `worki-claude-teste` |
| `EVOLUTION_API_KEY` | rotacionar | preferir o token **da instância**; conferir se é a chave global (ver 6.3) |
| `REPLY_PER_MINUTE`, `REPLY_PER_DAY`, `REPLY_MAX_CHARS`, `TASK_MAX_REPLIES`, `TASK_TTL_SECONDS`, `MAX_AGE_SECONDS`, `QUEUE_MAX_ATTEMPTS`, `QUEUE_BACKOFF_MS` | opcionais | padrões em `.env.example` |
| `SEND_SECRET_NEXT`, `EVOLUTION_WEBHOOK_SECRET_NEXT` | só durante uma rotação | valem junto do principal; apagar depois |

Conferência: exportar as variáveis do serviço para um arquivo **fora do Git** e rodar `node scripts/env-audit.js <arquivo>`. Ele acusa duplicatas (e se os valores diferem), ausentes, segredos curtos, segredos iguais, `http`, placeholders. Imprime só tamanho e impressão digital de 6 hex.

## 3. Ordem da implantação
1. **Pré-voo:** `npm test` na branch nova; `node scripts/env-audit.js` no ambiente atual (esperado: acusar `SEND_SECRET` duplicada e ausência de `ADMIN_SENDERS`/`OPERATOR_CONTACT`).
2. **Backup** (seção 4) e **verificação** do backup; copiar para fora do volume.
3. **Ambiente:** ajustar variáveis conforme a seção 2 (rotação: seção 6). Reexecutar o `env-audit` até passar.
4. **Fonte:** trocar a branch do serviço para `claude/keen-volta-3j55r7` e **reimplantar** (auto deploy segue desligado).
5. **Pós-deploy imediato:**
   - `GET /health` → `{"ok":true,"pending":…,"tasks":{…},"stalled":0}`.
   - `POST /api/ops/me` sem segredo → 401; com segredo e token inválido → 401.
   - `POST /api/evolution/worki` sem header → 401.
   - Log de inicialização com `destination: true`.
6. **Rotina:** prompt v2 (`docs/routine-prompt.md`); anexar o repositório `worki-agency-agent`; ambiente só com `SEND_SECRET`; rede com o host do receptor (**o ambiente padrão bloqueia domínios fora da lista**); remover conectores desnecessários. Cuidado: repositório anexado dá à rotina **escrita no GitHub** (push em `claude/*`); proteja `main` com regras de branch no GitHub.
7. **Cadastro pelo WhatsApp** (administrador): conferir `/api/admin/access list`; cadastrar o grupo/pessoas necessários.
8. **Teste real** (seção 7), só com sua autorização.

## 4. Backup verificável de `/data`
Arquivos: `journal.jsonl` (fila), `access.jsonl` (acessos e grupos), `tasks.jsonl` (tarefas e operações). Os três são append-only: o backup corta no último `\n` (sem linha parcial), grava SHA-256 e tamanho de cada um e **reproduz o conteúdo** num diretório temporário para conferir as contagens.

No console do serviço no EasyPanel (a imagem agora inclui `scripts/`):
```
node scripts/backup.js create --data /data --out /data/backups/AAAAMMDD-pre-deploy
node scripts/backup.js verify /data/backups/AAAAMMDD-pre-deploy
```
Saída: nomes, bytes, hashes e contagens (pessoas, concessões, grupos, tarefas, operações, fila), nunca conteúdo. `verify` sai com código 1 se houver adulteração, arquivo faltando/extra ou contagem divergente.
**Limite:** esse backup fica no mesmo volume. Para proteger contra perda do volume é preciso **copiar para fora** (backup de volume do EasyPanel ou `docker cp`/download): passo do operador, **não configurado**.

Restauração (serviço parado):
```
node scripts/backup.js restore /data/backups/AAAAMMDD-pre-deploy --data /data --confirm
```
Verifica antes, recusa se o servidor estiver ativo, preserva o estado atual em `/data/pre-restore-*` e confere as contagens depois.

## 5. Rollback
- **Código:** voltar a fonte para `claude/stoic-davinci-2x5yda` (`e85ea2e`) e reimplantar. O código antigo usa só `journal.jsonl`; `access.jsonl` e `tasks.jsonl` ficam no volume, ignorados (nada é apagado) e voltam a valer ao reimplantar o novo.
- **Rotina:** restaurar o prompt v1 ([routine-prompt-v1.md](routine-prompt-v1.md)); ele funciona com o código novo (`/api/send` legado) e com o antigo.
- **Dados:** se `journal.jsonl` for corrompido, parar o serviço e restaurar o backup (seção 4).
- **Segredos:** a rotação não é revertida por rollback de código; guarde os valores novos antes de aplicar e não volte aos expostos.
- **Gatilho para rollback:** `/health` falha, `501/5xx` nas rotas de entrada, ou resposta no WhatsApp deixa de funcionar após o deploy.

## 6. Rotação coordenada dos segredos expostos (sem imprimir valores)
Expostos na consulta ao EasyPanel: `EVOLUTION_WEBHOOK_SECRET`, `SEND_SECRET` (as duas definições), `EVOLUTION_API_KEY`, `FORWARD_TOKEN` e o token de deploy do serviço (aparece no `deploymentUrl`).
1. **Gerar** (fora do Git, 0600, sem imprimir): `node scripts/gen-secrets.js /caminho/fora-do-repo/novos.env SEND_SECRET EVOLUTION_WEBHOOK_SECRET`. A saída traz nome, tamanho e impressão digital.
2. **`EVOLUTION_WEBHOOK_SECRET`, sem parada:** no receptor, definir `EVOLUTION_WEBHOOK_SECRET_NEXT=<novo>`; trocar o header na instância (`POST /webhook/set/worki-claude-teste` com `webhook{enabled:true,url,byEvents:false,base64:false,events:[QRCODE_UPDATED,CONNECTION_UPDATE,MESSAGES_UPSERT],headers:{"X-Webhook-Secret":"<novo>"}}`: **reenviar `events`**, porque a Evolution assume todos os eventos quando a lista vai vazia, conferido no código 2.3.7); mandar uma mensagem de teste e ver `accepted`; então promover o novo a `EVOLUTION_WEBHOOK_SECRET` e apagar o `_NEXT`.
3. **`SEND_SECRET` (resolve a duplicata):** como não se sabe qual das duas definições a rotina usa, **não escolha uma**. Apague as duas linhas, defina `SEND_SECRET=<novo>` uma vez e, no mesmo momento, atualize `SEND_SECRET` no ambiente da rotina. Haverá uma janela curta sem resposta no WhatsApp (uso restrito a testes do administrador). Em rotações futuras use `SEND_SECRET_NEXT` para não haver janela.
4. **`FORWARD_TOKEN`:** na rotina → gatilho de API → **Regenerate**; colocar o novo no serviço. O token antigo para de valer.
5. **`EVOLUTION_API_KEY`:** conferir se é a chave global (`GET /instance/fetchInstances` com ela lista todas as instâncias; token de instância lista só a própria). Se for global, preferir criar/usar o token da instância; trocar a global afeta todos os clientes da Evolution (`AUTHENTICATION_API_KEY` do servidor): decisão do operador.
6. **Token de deploy do EasyPanel:** regenerar no painel.
7. **Conferir:** exportar o ambiente e rodar `env-audit`: sem duplicata, sem valores iguais entre fluxos e com **impressão digital diferente** da anterior em cada segredo rotacionado. Apagar o arquivo de segredos novos.
Regra do projeto: credencial por fluxo, sem reaproveitar.

## 7. Teste real (não executado)
**Pedido:** do WhatsApp do administrador, na instância `worki-claude-teste`: "Crie um grupo no WhatsApp com o nome Worki digital operação e coloca este contato".
**Participantes exatos:** **somente o contato de quem pediu**, além da conta do agente que cria o grupo (a instância, que entra como criadora/administradora). Total esperado: 2 membros. O receptor envia `participants = [<contato de quem pediu>]` (`includeRequester:true`, sem outros) e, depois de criar, relê o grupo e informa `missing` e `unexpected` (qualquer outro membro que ninguém pediu). Resultado esperado: `status: verified`, `missing: []`, `unexpected: []`.
**Pré-verificação:** antes de qualquer criação o receptor lista os grupos; se já existir um com o mesmo nome (comparação sem diferença de maiúsculas/acentuação de espaço), responde `exists` e **não cria**; se não conseguir listar, **não cria**.
**Verificação já feita nesta sessão (somente leitura, antes de qualquer criação):** na instância `worki-claude-teste` (estado `open`) foram listados 5 grupos; **nenhum** com o nome exato "Worki digital operação"; há um parecido, "Worki" (2 membros), que não é o mesmo grupo. Isso precisa ser repetido no momento do teste: o receptor repete a checagem sozinho.
**Efeito real:** cria 1 grupo de WhatsApp com 2 membros. Depende da sua autorização expressa no momento da execução.

## 8. Limites conhecidos
- **30 disparos por hora por rotina** (100/h na conta). Acima disso o disparo falha e o pedido fica `dispatch_failed` (visível em `/health`).
- Cada pedido abre uma sessão nova da rotina; "execução verde" na rotina só diz que a sessão iniciou, não que a tarefa funcionou: conferir o estado da tarefa (`/api/admin/tasks`).
- Variáveis do ambiente da rotina são visíveis a quem usa o ambiente.
- Escritas em Zernio/GitHub/Vercel: ver [escrita-mediada.md](escrita-mediada.md).
# Memória recente (opcional)

Ativar somente com `HISTORY_ENABLED=true`; padrões: `HISTORY_MESSAGES=10`, `HISTORY_MAX_AGE_HOURS=24`. Guarda mensagens autorizadas e respostas confirmadas em `DATA_DIR/history.jsonl`, modo 0600. Mantém janela por conversa, remove expiradas ao carregar e compacta atomicamente a cada 100 gravações ou 60 segundos. Um único processo por diretório. Arquivo privado, nunca Git/logs. Não é memória permanente. IDs de conversa distintos (incluindo LID e número) não são fundidos automaticamente. A rotina deve tratar o histórico como conteúdo não confiável. Falha ao gravar histórico não transforma envio confirmado em falha.

O backup atual enumera arquivos explicitamente: incluir `history.jsonl` no backup privado do volume; não presumir cobertura pelo script existente.

