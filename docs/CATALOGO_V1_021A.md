# Catálogo V1 — Migration 021A (estrutura)

Estado: migrações 021–024 e fluxos de catálogo preparados no PR de rascunho. Nenhuma
migration foi aplicada a um banco e nenhum serviço foi implantado.

## Numeração

A 017 da V1 já é `pocket_sexta`; a sequência local vai até 019. O número 020 foi reservado para a Foundation SaaS desenvolvida em outra branch. A 021 não depende da 020, mas a ordem de integração e o gate de inventário de produção devem ser revistos antes de aplicar qualquer migration posterior à 019.

## Escopo desta etapa

- Catálogo de buffet: categorias, itens, regras por pacote e escolhas com nome aplicado no fechamento.
- Adicionais: categorias administráveis relacionadas à coluna legada `adicionais.categoria` e regra pacote × adicional com ausência interpretada como indisponível.
- Cortesia: `precos_adicional.valor` passa a aceitar zero, sem alterar preços existentes.
- PDF informativo: metadados e unicidade de um documento vigente; nenhum arquivo é armazenado ou publicado nesta migration.
- Nenhuma coluna `buffet_*` é removida, nenhum preço da taxa de bebida alcoólica é alterado e nenhum fechamento histórico é reescrito.

## Implementação preparada

- 022 cadastra as opções de buffet e vínculos iniciais por pacote.
- 023 define inclusão, indisponibilidade e extras pagos por pacote.
- 024 cria uma nova versão da tabela comercial, copiando os preços existentes
  e aplicando taxa de rolha de R$ 190 (1–79) e R$ 290 (80–150). A vigência
  começa em `CURRENT_DATE` do banco no momento da aplicação; revisar o fuso e
  as tabelas ativas no precheck. Fechamentos antigos retêm seus snapshots.
- Fechamento público e interno consultam preço e disponibilidade dos extras
  no servidor. O cálculo final recusa adicionais que não estejam marcados
  como `EXTRA` no pacote.
- O proprietário edita categorias, itens, limites por pacote e modalidades
  dos adicionais; escolhas do buffet são validadas e registradas com IDs e nomes.
- O PDF de pacotes pode ser publicado na área administrativa e aberto pelo cliente.

## Conferência necessária antes da ativação

1. Conferir as composições de todos os pacotes com a tabela oficial, em especial
   Pocket, Mini Festa, Compacta e Pizza Party; para Pizza Party o catálogo de
   adicionais permanece vazio até as regras comerciais serem definidas.
2. Conferir o tratamento dos extras por unidade, como bombom e lembrancinha,
   para não cobrar como pacote inteiro nem cobrar o item incluso duas vezes.
3. Executar prechecks, migrations e postchecks em clone sanitizado autorizado,
   comparar contagens, limites e cálculo de fronteira (79/80 convidados).
4. Associar snapshots de buffet às versões de contrato quando o contrato for
   gerado ou revisado; preservar a versão anterior integralmente.
5. Integrar a Foundation 020 ou confirmar sua ausência deliberada, ajustar o
   inventário e o gate de migrations após revisão. Testar staging correto antes
   de qualquer implantação em produção.

`database/checks/20260923_021_precheck.sql` e `postcheck.sql` são somente leitura. Comparar as quatro contagens retornadas; testes offline não substituem a aplicação em clone autorizado.
