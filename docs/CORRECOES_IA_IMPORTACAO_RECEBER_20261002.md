# Correções de IA, importação e contato — 02/10/2026

Base: `origin/staging` em `881690f`. Branch local: `codex/correcoes-ia-importacao-receber-20261002`.

## Comportamento

- O comando “adicione conta a pagar todos mes dia 10 do Chat-gpt pro 550 rais.” abre a ação `criar_conta_pagar`, preservando descrição, R$ 550 e recorrência mensal. Com outro rascunho aberto, o coordenador substitui o objetivo sem criar cadastros. “Sim” continua a conta a pagar. Primeiro vencimento completo e categoria são pedidos quando ausentes. A revisão avisa que a recorrência gera 12 ocorrências. A gravação exige o clique de confirmação, com tenant, papel, versão/hash e prazo revalidados. Usa `criarContaPagar` do financeiro, chave de idempotência da operação e auditoria oficial.
- A importação exige disponibilidade real do servidor. Erros, flag desligada e indisponibilidade não abrem mais a demonstração: mostram a mensagem e permitem tentar novamente. O upload, extração, revisão e confirmação existentes continuam sujeitos às permissões originais.
- O nome do contato em contas a receber abre `/clientes/{id}`, em tabela e celular. O clique não abre a baixa financeira. Recebimentos sem cliente vinculado continuam como texto. O id é obtido no backend com o vínculo à empresa.

## Diagnóstico de staging

Leitura do Render MCP em 02/10/2026: `kidmais-manager-staging` (`srv-daif418ae00c73e8k2gg`), branch `staging`, auto-deploy OFF. Registros de `importar_contrato` até `2026-10-02T08:30:22Z` mostram `INTELIGENCIA_DESATIVADA`, resultado `desativado`, causa `FLAG`, antes da sessão e do banco. O código exige `INTELIGENCIA_ENABLED=true` e `AI_CONTRACT_IMPORT_ENABLED=true`; a IA em uso indica que o bloqueio específico é a importação, mas a integração não fornece leitura segura dos valores atuais das variáveis. Nenhuma variável foi alterada.

Para concluir em staging: publicar a candidata validada e ativar `AI_CONTRACT_IMPORT_ENABLED=true` no serviço acima, somente com autorização explícita, conforme `OPERACAO_AGENTES.md`. Depois revalidar a disponibilidade autenticada; se houver falha de schema, diagnosticar sem aplicar migrations automaticamente. Importação de imagens sem provedor externo autorizado continua exigindo preenchimento/revisão manual; esta mudança não autoriza enviar contratos a um provedor externo nem altera `AI_DOCUMENT_EXTERNAL_PROVIDER_ALLOWED`.

## Validação

- Regressão estática V1: 1677 testes de produto e 103 testes do harness com mocks, lint sem erros, TypeScript e build aprovados. Um aviso de lint preexistente em `lib/inteligencia/skills/catalogo.ts`.
- Regressões de conversa com e sem Luna: troca de objetivo, dados da frase original, resposta “sim”, gravação só no clique e replay sem duplicação.
- Validação de datas impossíveis, dia mensal divergente e valor negativo; teste do link do contato em desktop e celular, sem propagar para registrar recebimento.
- Fluxo de importação/upload/Human Gate: 52 testes com mocks aprovados.
- Nenhum teste acessou banco real ou fez upload de contrato real. Os testes de domínio e UI usam dados sintéticos. A gravação no PostgreSQL e a disponibilidade no serviço ainda precisam de homologação autorizada.

## Risco e recuperação

Não há migration. A nova capacidade permite criar contas a pagar pelo Human Gate e preserva o serviço financeiro existente. Reverter o commit remove a capacidade e os links; contas já confirmadas permanecem no financeiro. Desativar a flag de importação interrompe novas importações sem apagar os documentos ou cadastros anteriores. Deploy/rollback e alteração de configuração requerem autorização para o ambiente.
