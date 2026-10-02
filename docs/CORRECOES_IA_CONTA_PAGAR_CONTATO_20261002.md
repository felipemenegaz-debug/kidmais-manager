# Correções de IA (conta a pagar mensal) e contato no financeiro — 02/10/2026

Origem: commit `4cf8535` da PR #82 (`codex/correcoes-ia-importacao-receber-20261002`), sem a parte de importação.
A importação dessa PR removia a demonstração por completo e conflitava com a #83, já em staging, que mantém o
comportamento acordado: erro real com “Tentar novamente” e demonstração **somente por escolha explícita**. Os arquivos
`components/admin/importacao/*` ficam como estão em staging.

## Comportamento

- O comando “adicione conta a pagar todos mes dia 10 do Chat-gpt pro 550 rais.” abre a ação `criar_conta_pagar`, preservando descrição, R$ 550 e recorrência mensal. Com outro rascunho aberto e a IA operacional ligada, o coordenador substitui o objetivo sem criar cadastros; com ela desligada, a mensagem responde ao rascunho aberto, como antes. “Sim” continua a conta a pagar. Primeiro vencimento completo e categoria são pedidos quando ausentes. A revisão avisa que a recorrência gera 12 ocorrências. A gravação exige o clique de confirmação, com tenant, papel, versão/hash e prazo revalidados. Usa `criarContaPagar` do financeiro, chave de idempotência da operação e auditoria oficial.
- O nome do contato em contas a receber abre `/clientes/{id}`, em tabela e celular. O clique não abre a baixa financeira. Recebimentos sem cliente vinculado continuam como texto. O id é obtido no backend com o vínculo à empresa (`cliente.empresa_id`).

## Flags

`criar_conta_pagar` é uma ação administrativa independente (grupo `ADMIN_ACTIONS`, como os pacotes), não uma capacidade da IA operacional:

| Condição | Pedido novo | Clique em revisão já aberta |
|---|---|---|
| `AI_ADMIN_ACTIONS_ENABLED` desligada | “ainda não está liberado”, nenhum rascunho | 503, nada gravado |
| Empresa fora de `AI_TENANT_ALLOWLIST` | “não está liberado para esta empresa”, nenhum rascunho | 503, nada gravado |
| `AI_OPERACIONAL_ENABLED` desligada | a ação funciona sozinha | grava normalmente |

`AI_OPERACIONAL_ENABLED` só decide se um pedido novo troca outro rascunho aberto (coordenador). A versão da #82 ligava o coordenador para conta a pagar mesmo com a flag desligada; isso foi revertido para manter “desligada, a conversa segue exatamente como antes”.

## Validação

- Regressões de conversa com e sem Luna: troca de objetivo, dados da frase original, resposta “sim”, gravação só no clique e replay sem duplicação.
- Validação de datas impossíveis, dia mensal divergente e valor negativo; teste do link do contato em desktop e celular, sem propagar para registrar recebimento.
- Flags (com mocks): ações administrativas desligadas, IA operacional desligada, empresa fora da allowlist e nenhuma gravação antes do clique (coleta, revisão, “sim” digitado, cancelamento). Controle negativo: com a linha da #82 no `conversa.ts`, o teste da IA operacional desligada falha.
- PostgreSQL descartável (`lib/inteligencia/acoes/conta-pagar.postgres.test.ts`, cluster `kidmais_descartavel`, 055b instalada só na transação, tudo desfeito no fim): Human Gate em `ia_operacoes`; revisão sem gravação; flag desligada e empresa fora da allowlist barram o clique (503) e outra empresa recebe 404; o clique cria 12 contas de 10/10/2026 a 10/09/2027 numa única série com `chave_idempotencia` = operação e uma auditoria; replay do clique e retry do serviço com a mesma chave não duplicam; conta única é idempotente por `chave_criacao`; cancelada não grava. Controle negativo: sem a chave da operação, a suíte falha.
- Nenhum teste acessou banco real (staging, production ou `kidmais_manager`).

## Risco e recuperação

Não há migration nem mudança de variável. A ação depende do Human Gate já existente (`ia_operacoes`, 055b) e falha fechada sem ele; em production, a ativação de ações administrativas continua sujeita ao diagnóstico pendente das divergências de schema `ia_*` e a homologação própria. A nova capacidade permite criar contas a pagar pelo Human Gate e preserva o serviço financeiro existente. Reverter o commit remove a capacidade e os links; contas já confirmadas permanecem no financeiro. Deploy/rollback e alteração de configuração requerem autorização para o ambiente.
