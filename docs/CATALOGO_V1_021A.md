# Catálogo V1 — Migration 021A (estrutura)

Estado local em 23/09/2026: migrations 021–024 aplicadas **exclusivamente no clone
sanitizado `kidmais_v1_homologacao`**, PostgreSQL local loopback, porta 5432,
na branch `v1/catalogo-021a`. O postcheck 019 passou com `search_path=public`;
cada migration 021–024 teve precheck, aplicação e postcheck aprovados, em ordem.
Não foram reaplicadas 016–019. Esta execução não aplicou migrations em staging,
produção ou qualquer outro banco e não implantou serviços.

A regressão integrada de serviços/handlers passou em sete grupos. A verificação
posterior no navegador concluiu três fechamentos fictícios e edições administrativas
em desktop/celular, com rollback e preservação dos dez fechamentos anteriores.
Há ressalvas de UX, regras comerciais pendentes e renderização do PDF não homologada
no navegador embutido; ver [evidências e limites](REGRESSAO_CATALOGO_021_024.md).

## Numeração

A 017 da V1 já é `pocket_sexta`; o clone estava no estado pós-019 antes deste ensaio e agora contém 021–024. O número 020 foi reservado para a Foundation SaaS desenvolvida em outra branch e não foi aplicado neste ensaio. A 021 não depende da 020, mas a ordem de integração e o gate de inventário de produção devem ser revistos antes de qualquer aplicação fora do clone autorizado.

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
3. Ensaio no clone concluído: prechecks/postchecks, preservação dos dez fechamentos
   e fronteira 79/80 aprovados (rolha R$ 190/R$ 290). Isso não autoriza repetir as
   migrations nem substitui os gates de qualquer outro ambiente.
4. Associar snapshots de buffet às versões de contrato quando o contrato for
   gerado ou revisado; preservar a versão anterior integralmente.
5. Integrar a Foundation 020 ou confirmar sua ausência deliberada, ajustar o
   inventário e o gate de migrations após revisão. Testar staging correto antes
   de qualquer implantação em produção.

Os prechecks e postchecks de 021–024 em `database/checks/` são somente leitura.
Comparar as contagens e a vigência antiga/nova; testes offline não substituem
o ensaio em clone autorizado.

## Composição documentada e decisões ainda necessárias

A comparação utilizou as descrições comerciais versionadas em
`components/fechamento/data.ts`, as regras de 022/023 e a documentação acima.
Não havia um PDF oficial independente versionado nesta pasta para atestar que
essas fontes são a última aprovação comercial. O PDF publicado no teste era
explicitamente fictício e serviu somente para verificar o fluxo de publicação.

| Pacote | Composição registrada e comportamento observado | Ressalva |
|---|---|---|
| Pocket | Salgados, doces e bolo; lembrancinha não inclusa na descrição | Confirmar extras por unidade antes da ativação comercial |
| Mini Festa | Salgados, doces, bolo e lembrancinha | Não presumir quantidade de lembrancinhas por convidado |
| Compacta | Salgados e bolo; sem categoria Doces | Valor acima da base de 40 convidados continua sujeito à confirmação da equipe |
| Essencial | Salgados, doces e bolo | Itens fixos da composição, como bebidas e acompanhamentos, não são categorias de escolhas |
| Completa | Essencial + lembrancinha, salada, penne, crepe de queijo e sorvete; penne/crepe/sorvete não aparecem como extras pagos | A UI oferece **Salada premium** como extra; confirmar se é diferente da salada incluída, sem equiparar os dois nomes por inferência |
| Premium | Completa + bombom, empratado, crepe de chocolate, pastelzinho e demais itens descritos | Bombom aparece no buffet incluído e também como extra; falta comunicar claramente unidade, quantidade e diferença entre incluso e excedente |
| Pizza Party | Sob consulta; catálogo de escolhas/adicionais vazio | Regras comerciais ainda não definidas; não inferir preços ou composição de extras |

Outras pendências explícitas:

- Os limites técnicos `Doces até 16` e `Bombons até 4` coincidem com o número de
  sabores cadastrados. O comentário da 022 diz que esses limites ainda são
  configuráveis; eles não comprovam uma quantidade comercial aprovada ou unidades
  por pessoa. `Até 8 salgados`, `1 massa` e `1 recheio` são regras explícitas na 022.
- A UI de extras mostra `Bombom R$ 7,00` e acrescenta esse valor uma vez, sem seletor
  de quantidade ou indicação de unidade. O cadastro estático legado descreve bombom
  por unidade com outra referência de preço. Não substituir o preço persistido nem
  escolher a unidade correta sem confirmação comercial.
- Lembrancinhas extras estão cadastradas no administrador, mas seus códigos não
  existem no mapa `ADICIONAL_CODIGO_BANCO` e são filtrados da API pública. O cadastro
  administrativo, por si só, não garante que o cliente possa contratar o item.
- `COMBO_ADULTOS`/`COMBO_LANCHINHOS` são inclusos no Premium e indisponíveis na
  Completa pela 023; a composição descritiva não define esses nomes. Exigem revisão
  comercial explícita, sem inventar equivalências.
