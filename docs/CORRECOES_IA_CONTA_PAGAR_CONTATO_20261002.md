# Correções de IA (conta a pagar mensal) e contato no financeiro — 02/10/2026

Origem: commit `4cf8535` da PR #82 (`codex/correcoes-ia-importacao-receber-20261002`), sem a parte de importação.
A importação dessa PR removia a demonstração por completo e conflitava com a #83, já em staging, que mantém o
comportamento acordado: erro real com “Tentar novamente” e demonstração **somente por escolha explícita**. Os arquivos
`components/admin/importacao/*` ficam como estão em staging.

## Comportamento

- O comando “adicione conta a pagar todos mes dia 10 do Chat-gpt pro 550 rais.” abre a ação `criar_conta_pagar`, preservando descrição, R$ 550 e recorrência mensal. Com outro rascunho aberto, o coordenador substitui o objetivo sem criar cadastros. “Sim” continua a conta a pagar. Primeiro vencimento completo e categoria são pedidos quando ausentes. A revisão avisa que a recorrência gera 12 ocorrências. A gravação exige o clique de confirmação, com tenant, papel, versão/hash e prazo revalidados. Usa `criarContaPagar` do financeiro, chave de idempotência da operação e auditoria oficial.
- A ação pertence ao grupo `ADMIN_ACTIONS`: continua indisponível enquanto as ações administrativas da IA estiverem desligadas no ambiente.
- O nome do contato em contas a receber abre `/clientes/{id}`, em tabela e celular. O clique não abre a baixa financeira. Recebimentos sem cliente vinculado continuam como texto. O id é obtido no backend com o vínculo à empresa (`cliente.empresa_id`).

## Validação

- Regressões de conversa com e sem Luna: troca de objetivo, dados da frase original, resposta “sim”, gravação só no clique e replay sem duplicação.
- Validação de datas impossíveis, dia mensal divergente e valor negativo; teste do link do contato em desktop e celular, sem propagar para registrar recebimento.
- Nenhum teste acessou banco real. Os testes de domínio e UI usam dados sintéticos. A gravação no PostgreSQL ainda precisa de homologação autorizada.

## Risco e recuperação

Não há migration nem mudança de variável. A nova capacidade permite criar contas a pagar pelo Human Gate e preserva o serviço financeiro existente. Reverter o commit remove a capacidade e os links; contas já confirmadas permanecem no financeiro. Deploy/rollback e alteração de configuração requerem autorização para o ambiente.
