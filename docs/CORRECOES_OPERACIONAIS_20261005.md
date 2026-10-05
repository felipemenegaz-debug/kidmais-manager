# Correções de agenda contratos e login

Registro do pedido de Felipe em 05/10/2026. As correções estão preparadas localmente a partir de staging `ff095cf`. Ainda precisam de publicação e homologação no ambiente usado por Felipe.

| Solicitação | Alteração preparada |
| --- | --- |
| Excluir o bloqueio criado | Listar todos os bloqueios ativos da data, independentemente do período selecionado, com o botão Excluir bloqueio e confirmação. A operação desativa o bloqueio e preserva o histórico. |
| Encontrar o cancelamento do contrato | Exibir Cancelar contrato diretamente no cabeçalho. Quando houver Festa vinculada, abrir essa Festa pelo link Cancelar contrato na Festa; nela, o botão também fica visível. Motivo, confirmação e verificações de permissão continuam nos fluxos existentes. |
| Abrir Dashboard após login | Usar Dashboard como destino padrão. Retornos internos válidos solicitados pelo fluxo de acesso continuam sendo respeitados. |

## Evidências do histórico

O cancelamento pré-assinatura já existe no serviço e na interface, mas estava dentro de Mais ações. Contratos com Festa usam o fluxo de cancelamento da Festa. A listagem dos bloqueios dependia do período escolhido e dos horários operacionais carregados. Bloqueios globais anteriores à separação por empresa continuam protegidos contra exclusão por uma empresa isolada.

O histórico local da página de login contém Contratos como destino desde `fdb9bda`; `03a4aea` acrescentou o retorno interno seguro e manteve esse padrão. Nas referências consultadas não foi encontrada uma remoção de um redirecionamento anterior para Dashboard.

Essas evidências explicam as condições do código, mas não confirmam por que o bloqueio específico da imagem não apareceu. Não foram consultados dados do banco nem determinada a versão em execução na tela enviada.

## Validação local

Os 23 testes existentes pertinentes a disponibilidade, cancelamento pré-assinatura, isolamento dos contratos, navegação e Festa passaram. TypeScript e build passaram. ESLint concluiu sem erros, com um aviso preexistente em `lib/inteligencia/skills/catalogo.ts`. Nenhum deploy ou alteração de banco foi executado.

## Outras correções

Felipe informou que continuará verificando o sistema e apontará outras correções. A lista permanece aberta para os próximos apontamentos.
