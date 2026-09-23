# Catálogo V1 — Migration 021A (estrutura)

Estado: preparada para revisão. Não aplicada a qualquer banco. Não habilita telas ou leitura dinâmica.

## Numeração

A 017 da V1 já é `pocket_sexta`; a sequência local vai até 019. O número 020 foi reservado para a Foundation SaaS desenvolvida em outra branch. A 021 não depende da 020, mas a ordem de integração e o gate de inventário de produção devem ser revistos antes de aplicar qualquer migration posterior à 019.

## Escopo desta etapa

- Catálogo de buffet: categorias, itens, regras por pacote e escolhas com nome aplicado no fechamento.
- Adicionais: categorias administráveis relacionadas à coluna legada `adicionais.categoria` e regra pacote × adicional com ausência interpretada como indisponível.
- Cortesia: `precos_adicional.valor` passa a aceitar zero, sem alterar preços existentes.
- PDF informativo: metadados e unicidade de um documento vigente; nenhum arquivo é armazenado ou publicado nesta migration.
- Nenhuma coluna `buffet_*` é removida, nenhum preço da taxa de bebida alcoólica é alterado e nenhum fechamento histórico é reescrito.

## Etapas seguintes antes da ativação

1. Conferir as listas oficiais de buffet e composições de **todos** os pacotes, inclusive Pocket, Mini Festa, Compacta e Pizza Party. Fazer seed idempotente em mudança separada; validar que categorias obrigatórias tenham opções ativas suficientes.
2. Decidir a representação comercial da Taxa de Rolha diante do adicional legado `BEBIDA_ALCOOLICA` e de suas faixas 1–80/R$200, 81–120/R$300 e 121–150/R$400. Desativar faixas antigas e criar 1–79/R$190 e 80+/R$290 somente depois de validar precificação, disponibilidade e snapshots históricos.
3. Criar APIs autorizadas de edição, arquivamento e ordenação. Fazer validação transacional de limites de escolha, vínculos com pacote e ausência de itens ativos; o schema sozinho não garante esses invariantes dinâmicos.
4. Implementar leitura pública e snapshot no marco comercial existente, mantendo compatibilidade com Fechamento, Contrato e Festa.
5. Escolher armazenamento persistente para o PDF, implementar upload seguro e troca atômica da referência ativa, então mostrar o botão no Fechamento.
6. Atualizar o inventário de migrations e seu gate de produção após a revisão da Foundation 020. Preparar rollback, regressão em clone sanitizado e aprovação específica antes de executar SQL em qualquer banco.

`database/checks/20260923_021_precheck.sql` e `postcheck.sql` são somente leitura. Comparar as quatro contagens retornadas; testes offline não substituem a aplicação em clone autorizado.
