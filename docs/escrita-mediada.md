# Escritas em Zernio, GitHub e Vercel: aplicação das permissões em código (projeto)

**Estado: implementado em branch, sem teste real.** As rotas tipadas existem atrás de flags desligadas; credenciais e vínculos ainda precisam ser configurados pelo operador e as chamadas a serviços reais continuam pendentes.

## Princípio
A credencial de escrita vive **só no receptor**. O executor (rotina) não a tem. Cada escrita é uma rota tipada do receptor que (1) valida o corpo, (2) confere em código pessoa × cliente × operação **e o recurso**, (3) executa, (4) **relê** o resultado na própria plataforma e (5) só então certifica (`verified`). Evidência fornecida pelo executor nunca vira `verified` (já aplicado: `/api/ops/record` devolve `409 mediated_only` para essas operações).

## Recursos vinculados ao cliente (autorização cobre "conta, recurso, limite")
Registro privado em `/data/resources.json`: por cliente, `zernio.accountId`, `github.repo`/`baseBranch`/`pathPrefix` e `vercel.projectId`/`name`. O pedido só informa o cliente; a rota recusa recurso fora do vínculo e não recebe repo, projeto ou conta arbitrários.

## Rotas e regras
| Rota | Operação exigida | Regras aplicadas em código |
|---|---|---|
| `POST /api/ops/page/publish` | `edit_repo` + `deploy_vercel_preview`/`deploy_vercel_production` | HTML estático validado; vínculo privado; GitHub cria árvore/commit e branch do agente; Vercel cria deployment, relê `READY` e verifica URL `.vercel.app`; idempotência persistente e estados `started/uncertain/verified` |
| `POST /api/ops/instagram/prepare` | `prepare_instagram_post` | Só guarda rascunho local e calcula hash SHA-256 completo; nenhuma chamada externa |
| `POST /api/ops/instagram/publish` | `publish_instagram` | Exige draft e hash exatos; conta vinculada; `Idempotency-Key`; POST `/v1/posts`; releitura GET `/v1/posts/{id}` e `platformPostUrl` antes de `verified` |
Leituras (`read_meta_insights`) também passam pelo receptor enquanto a chave do Zernio não puder ser restrita a leitura.

## Idempotência e reconciliação

Cada operação recebe uma chave canônica derivada de cliente, operação, alvo e
hash do conteúdo. O `idempotencyKey` enviado pelo chamador é tratado somente
como referência de retry; ele não escolhe o recurso, não atravessa clientes e
não pode furar a deduplicação.

Um `started` ou `uncertain` não é repetido às cegas. Antes de abrir uma nova
tentativa, o receptor consulta o provedor:

- Vercel: lista deployments por projeto (`GET /v7/deployments`) e procura
  `meta.workiOperation` + `meta.workiPageDigest`; depois relê o deployment e
  verifica a URL.
- Zernio: lista posts (`GET /v1/posts`) e procura `metadata.workiOperation`
  ou o hash de conteúdo associado à conta; depois relê o post por ID e exige o
  link da publicação.

Se encontrar a operação, registra `verified` com a evidência. Uma listagem
sem correspondência não comprova ausência: paginação e consistência eventual
impedem essa conclusão. A repetição automática por ausência permanece
desligada; o receptor devolve `uncertain_previous_attempt` e o operador deve
conferir o provedor. Ao iniciar o processo, `recover()` reavalia operações órfãs
`started`/`uncertain` persistidas em `mediated.jsonl`.

As consultas e campos usados acima são os contratos documentados nas fontes
dos provedores; os testes deste repositório continuam simulados e não provam
acesso à conta do cliente.

Fontes consultadas (verificação documental em 2026-10-07):

- Vercel REST API: [criar deployment](https://vercel.com/docs/rest-api/reference/endpoints/deployments/create-a-new-deployment), [obter deployment](https://vercel.com/docs/rest-api/reference/endpoints/deployments/get-a-deployment) e [listar deployments](https://vercel.com/docs/rest-api/reference/endpoints/deployments/list-deployments).
- Zernio Posts API: [criar post](https://docs.zernio.com/posts/create-post), [obter post](https://docs.zernio.com/posts/get-post) e [listar posts](https://docs.zernio.com/posts/list-posts).

Essas referências descrevem os endpoints e os campos usados para a
reconciliação. A autenticação, o plano, a conta e os limites do ambiente do
cliente ainda não foram testados neste repositório.

## Verificação da Vercel

O polling padrão é `VERCEL_POLL_ATTEMPTS=120` com `VERCEL_POLL_MS=500` (cerca de
60 segundos), ambos configuráveis e limitados pelo receptor. Um deployment
`READY` só é certificado depois de um GET HTTPS da URL. Hosts `.vercel.app`
são aceitos; alias próprio só é aceito quando estiver no `allowedHosts` do
 vínculo privado do cliente.

Previews protegidos podem responder 401/403 mesmo estando prontos. Isso só é
aceito quando `VERCEL_ACCEPT_PROTECTED=true`; o resultado fica marcado como
`protected: true` e `publicVerified: false`, ou seja, a API confirmou o
deployment, mas o acesso público não foi confirmado. O padrão é `false`.

## Rascunhos do Instagram

`instagramPrepare` guarda o remetente que criou o rascunho e uma validade de
24 horas (`INSTAGRAM_DRAFT_TTL_HOURS`, entre 1 e 720). Outro remetente não
pode publicar; rascunho expirado ou com hash diferente é recusado. A mídia
continua sem restrição quando não há allowlist. Para restringir, o vínculo
privado em `/data/resources.json` pode conter, por cliente:

```json
{"mediaAllowedHosts":["cdn.cliente.example"]}
```

Com a lista presente, cada URL HTTPS precisa usar exatamente um desses hosts.

## Logs e defesa em profundidade
- Recursos de rede: lista de hosts permitidos para as chamadas do receptor; segredos nunca devolvidos nem logados.
- Interruptor por plataforma (`WRITE_ZERNIO_ENABLED`, `WRITE_GITHUB_ENABLED`, `WRITE_VERCEL_ENABLED`), todos desligados por padrão. Sem as duas flags de página, o receptor não chama GitHub nem Vercel; sem a flag Zernio, publicação retorna `operation_disabled`.
- Mesma máquina de estados e idempotência de hoje (`tasks.jsonl`); timeout = `uncertain`, nunca repetição cega.
- Auditoria de escrita registra somente evento, operação (hash), provedor,
  estado e código HTTP. Não registra corpo, caption, URL privada, token,
  número ou JID.
- Revalidação de acesso a cada chamada (como hoje), inclusive tarefas na fila.

## Testes obrigatórios antes de ligar cada rota
Servidor falso da plataforma; recurso fora do vínculo; operação não concedida; acesso revogado com tarefa na fila; chave repetida; timeout seguido de reconciliação; releitura divergente (`done`, não `verified`); logs sem conteúdo; execução real somente com autorização do escopo exato (conta/repositório/projeto).

## Pré-requisitos que dependem do operador
1. Chamada real de `POST /v1/posts` do Zernio, embora a documentação oficial atual descreva o endpoint; falta validar o plano, conta conectada e resposta no ambiente do cliente.
2. GitHub App criado e instalado só nos repositórios necessários.
3. Token da Vercel com escopo do time e dos projetos vinculados.
4. Decisão sobre o que conta como produção e sobre limites por cliente.

## Estado desta entrega

Itens 1–5 foram implementados em branch/PR com flags desligadas por padrão.
`npm test` passou com 86 testes em Node 20.20.2. Todos os testes usam serviços
falsos; não houve publicação, deploy, leitura ou alteração em serviço externo
real. A confirmação real das versões, permissões, contas vinculadas e URLs
continua pendente antes de ligar qualquer `WRITE_*`.
