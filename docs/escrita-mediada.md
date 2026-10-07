# Escritas em Zernio, GitHub e Vercel: aplicação das permissões em código (projeto)

**Estado: projeto, não implementado.** Motivo: um `can` opcional no prompt não garante nada. Quem tem a credencial de escrita pode escrever, ouvindo o prompt ou não.

## Princípio
A credencial de escrita vive **só no receptor**. O executor (rotina) não a tem. Cada escrita é uma rota tipada do receptor que (1) valida o corpo, (2) confere em código pessoa × cliente × operação **e o recurso**, (3) executa, (4) **relê** o resultado na própria plataforma e (5) só então certifica (`verified`). Evidência fornecida pelo executor nunca vira `verified` (já aplicado: `/api/ops/record` devolve `409 mediated_only` para essas operações).

## Recursos vinculados ao cliente (autorização cobre "conta, recurso, limite")
Registro administrado pelo WhatsApp (como acessos), em `/data/resources.jsonl`: por cliente, `zernio.accountIds[]`, `github.repos[]` (+ prefixos de branch permitidos), `vercel.projects[]`, `limits` (posts/semana, produção sim/não). A rota recusa recurso fora do vínculo (`403 resource_not_bound`), ainda que a pessoa tenha a operação.

## Rotas e regras
| Rota | Operação exigida | Regras aplicadas em código |
|---|---|---|
| `POST /api/ops/zernio/draft` | `prepare_instagram_post` | Só guarda o rascunho no receptor (nenhuma chamada à plataforma) |
| `POST /api/ops/zernio/publish` | `publish_instagram` | Conta vinculada ao cliente; mídia HTTPS com host permitido e `HEAD` 200; limite semanal contado pelo receptor; idempotência por chave; **modo `publish`/`schedule` explícito** (nunca inferido de "prepare"); depois de enviar, acompanha o estado assíncrono até resultado final ou `uncertain`; relê o post (ID, estado, link) |
| `POST /api/ops/github/commit` | `edit_repo` | Repositório vinculado; branch com prefixo permitido (nunca a padrão/protegida); caminhos sem `..`, sem `.github/workflows`, tamanho limitado; sem force push; token de instalação de um **GitHub App** com escopo só nos repositórios vinculados, emitido por chamada; relê o commit (SHA e árvore) |
| `POST /api/ops/vercel/deploy` | `deploy_vercel_preview` ou `deploy_vercel_production` | Projeto vinculado; `ref` = SHA que o receptor confirmou no GitHub; produção exige a operação própria e `target:"production"` explícito; espera `READY`; **o receptor acessa a URL pública** (HTTP 200 e, opcional, texto esperado) antes de certificar |
Leituras (`read_meta_insights`) também passam pelo receptor enquanto a chave do Zernio não puder ser restrita a leitura.

## Defesa em profundidade
- Recursos de rede: lista de hosts permitidos para as chamadas do receptor; segredos nunca devolvidos nem logados.
- Interruptor por plataforma (`ZERNIO_WRITES_ENABLED`, `GITHUB_WRITES_ENABLED`, `VERCEL_WRITES_ENABLED`), todos desligados por padrão; modo `dryRun` que valida e registra sem chamar.
- Mesma máquina de estados e idempotência de hoje (`tasks.jsonl`); timeout = `uncertain`, nunca repetição cega.
- Revalidação de acesso a cada chamada (como hoje), inclusive tarefas na fila.

## Testes obrigatórios antes de ligar cada rota
Servidor falso da plataforma; recurso fora do vínculo; operação não concedida; acesso revogado com tarefa na fila; chave repetida; timeout seguido de reconciliação; releitura divergente (`done`, não `verified`); logs sem conteúdo; execução real somente com autorização do escopo exato (conta/repositório/projeto).

## Pré-requisitos que dependem do operador
1. Contrato real de `POST /posts` do Zernio, a confirmar no site oficial (a fonte indireta usada até aqui é do repositório do fornecedor) e se há chave restrita a leitura.
2. GitHub App criado e instalado só nos repositórios necessários.
3. Token da Vercel com escopo do time e dos projetos vinculados.
4. Decisão sobre o que conta como produção e sobre limites por cliente.
