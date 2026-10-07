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

## Defesa em profundidade
- Recursos de rede: lista de hosts permitidos para as chamadas do receptor; segredos nunca devolvidos nem logados.
- Interruptor por plataforma (`WRITE_ZERNIO_ENABLED`, `WRITE_GITHUB_ENABLED`, `WRITE_VERCEL_ENABLED`), todos desligados por padrão. Sem as duas flags de página, o receptor não chama GitHub nem Vercel; sem a flag Zernio, publicação retorna `operation_disabled`.
- Mesma máquina de estados e idempotência de hoje (`tasks.jsonl`); timeout = `uncertain`, nunca repetição cega.
- Revalidação de acesso a cada chamada (como hoje), inclusive tarefas na fila.

## Testes obrigatórios antes de ligar cada rota
Servidor falso da plataforma; recurso fora do vínculo; operação não concedida; acesso revogado com tarefa na fila; chave repetida; timeout seguido de reconciliação; releitura divergente (`done`, não `verified`); logs sem conteúdo; execução real somente com autorização do escopo exato (conta/repositório/projeto).

## Pré-requisitos que dependem do operador
1. Chamada real de `POST /v1/posts` do Zernio, embora a documentação oficial atual descreva o endpoint; falta validar o plano, conta conectada e resposta no ambiente do cliente.
2. GitHub App criado e instalado só nos repositórios necessários.
3. Token da Vercel com escopo do time e dos projetos vinculados.
4. Decisão sobre o que conta como produção e sobre limites por cliente.
