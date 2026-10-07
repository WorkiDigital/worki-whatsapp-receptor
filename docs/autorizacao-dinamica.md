# Autorização dinâmica por ação

Estado: implementada no código, desligada por padrão e testada somente com serviços simulados. Não está implantada nem validada pelo WhatsApp real.

## Objetivo

O agente pode planejar qualquer pedido. Leituras continuam seguindo as permissões existentes. Ações sensíveis só executam depois de uma aprovação explícita, curta e vinculada ao conteúdo exato.

## Controles

- `DYNAMIC_APPROVAL_ENABLED=false`: preserva o comportamento anterior.
- `APPROVAL_TTL_SECONDS=900`: validade padrão de 15 minutos.
- Diário privado: `DATA_DIR/approvals.jsonl`, incluído no backup.
- Código de uso único, vinculado ao hash do remetente, cliente, operação e parâmetros.
- Aprovação somente por administrador, em conversa privada.
- Um código não serve para outro conteúdo, remetente, cliente ou operação.

## Fluxo

1. A rotina chama `/api/ops/plan`.
2. Se não houver operação tipada, recebe `missing_tool` com a capacidade necessária. Nada é executado.
3. Para ação sensível, chama `/api/ops/approval` com resumo e o `payload` exato.
4. O receptor devolve `A-XXXXXXXX` e grava o pedido.
5. O administrador responde no privado `AUTORIZO A-XXXXXXXX`.
6. A rotina chama `/api/admin/approvals` com `approve` e executa a rota tipada com o mesmo payload mais `approvalCode`.
7. O receptor consome o código antes da operação e continua exigindo verificação e evidência.

Se a confirmação chegar em nova tarefa, a rotina consulta `/api/ops/history` para recuperar o pedido anterior. Se os parâmetros não puderem ser reconstruídos sem ambiguidade, pergunta somente o que falta; não amplia o escopo.

## Limites

Autorização não cria ferramenta. Uma capacidade nova ainda precisa de rota tipada, integração confirmada, vínculo do cliente, testes, idempotência e verificação. Não existe rota genérica para fazer requisições arbitrárias.
