# Correções de agenda contratos e login

Registro do pedido de Felipe em 05/10/2026 e da decisão após a conferência em staging. Somente o destino padrão do login para Dashboard deve ser promovido a production. As alterações de agenda e cancelamento do PR #96 foram descartadas e retiradas da candidata de staging, para não entrarem em uma promoção futura.

| Solicitação | Decisão atual |
| --- | --- |
| Excluir o bloqueio criado | Preservar o comportamento anterior ao PR #96, que já funciona em production. Descartar a alteração de listagem, texto e confirmação desse PR. |
| Encontrar o cancelamento do contrato | Preservar os fluxos anteriores ao PR #96. Descartar o novo link, a consulta da Festa no painel e a mudança de posição dos botões. |
| Abrir Dashboard após login | Usar Dashboard como destino padrão. Retornos internos válidos solicitados pelo fluxo de acesso continuam sendo respeitados. |

## Evidências do histórico

O cancelamento pré-assinatura já existe no serviço e na interface, mas estava dentro de Mais ações. Contratos com Festa usam o fluxo de cancelamento da Festa. A listagem dos bloqueios dependia do período escolhido e dos horários operacionais carregados. Bloqueios globais anteriores à separação por empresa continuam protegidos contra exclusão por uma empresa isolada.

O histórico local da página de login contém Contratos como destino desde `fdb9bda`; `03a4aea` acrescentou o retorno interno seguro e manteve esse padrão. Nas referências consultadas não foi encontrada uma remoção de um redirecionamento anterior para Dashboard.

A conferência na interface autenticada de staging identificou uma Festa em 18/10/2026, das 10h às 14h. A data estava ocupada por uma contratação, não por um bloqueio manual removível. Não foi executado cancelamento nem acesso direto ao banco. Felipe decidiu manter em production apenas a mudança do login.

## Promoção isolada e próximas atualizações

Preparar o PR do login a partir de `origin/production`: alterar somente `router.replace('/admin/contratos')` para `router.replace('/admin/dashboard')` em `app/admin/login/page.tsx`. Não promover staging inteira nem usar o commit completo do PR #96 para essa publicação.

A limpeza de staging restaura somente os quatro arquivos alterados pelo PR #96 fora do login. Outras funcionalidades de staging, incluindo o retorno interno seguro após autenticação, permanecem preservadas.

A candidata de limpeza de staging também incorpora o commit isolado do login em sua ancestralidade. O conflito dessa sincronização foi resolvido mantendo `destinoSeguro()` e seu padrão Dashboard, sem alterar o conteúdo já validado. Integrar a limpeza usando merge, preservando essa ancestralidade, antes da próxima promoção. Conferir o diff final da promoção para não reintroduzir as alterações descartadas.

## Validação local

O PR #96 passou no CI e foi publicado em staging no commit `f908d0d`, com health aprovado. A limpeza posterior passou nos 23 testes pertinentes a disponibilidade, cancelamento pré-assinatura, isolamento dos contratos, navegação e Festa. As validações de lint, TypeScript e build de cada candidata ficam registradas nos respectivos PRs. A publicação do login em production exige aprovação operacional conforme [OPERACAO_AGENTES.md](OPERACAO_AGENTES.md).

## Outras correções

Felipe informou que continuará verificando o sistema e apontará outras correções. A lista permanece aberta para os próximos apontamentos.
