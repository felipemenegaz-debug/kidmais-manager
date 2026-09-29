# Migration 054 — empresa_id explícito em Clientes e Fechamentos (PR-B1)

Segunda etapa do Gate 1 da trilha futura de Importação de Contratos Históricos (roadmap em
documento próprio, fora deste PR), depois da
[053/PR-A](MIGRATION_053_INTEGRIDADE_TENANT_FECHAMENTO.md). **Não altera a unicidade de CPF**:
`clientes_cpf_canonico_uk` continua global até o PR-B2.

**Estado atual:** **aplicada em staging** (depois da 053, também aplicada em staging); o
backfill imediato (`20260928_054_backfill_imediato.sql`) e o postcheck
(`20260928_054_postcheck.sql`) passaram em staging. **Produção NÃO recebeu a 053 nem a 054.**

**Histórico (antes da aplicação em staging):** implementada no repositório; o ciclo completo foi
executado no PostgreSQL descartável autorizado (`127.0.0.1:55498/kidmais_pacotes_v1_descartavel`)
e passou, inclusive nas execuções 4 e 5 com o harness endurecido (seção "Ciclo PostgreSQL
descartável"); a 054 foi removida desse banco ao final.

## 1. Implementado

### Banco (`database/migrations/20260928_054_empresa_id_clientes_fechamentos.sql`)

| Objeto | Tipo | Garante |
|---|---|---|
| `clientes.empresa_id`, `fechamentos.empresa_id` | `uuid` nulo, FK `clientes_054_empresa_fk` / `fechamentos_054_empresa_fk` para `empresas(id)`, `ON UPDATE/DELETE RESTRICT` | vínculo explícito com a empresa; legado continua nulo |
| `clientes_054_empresa_imutavel_trg`, `fechamentos_054_empresa_imutavel_trg` | BEFORE UPDATE OF empresa_id | empresa não muda, nem de NULL para uma empresa |
| `fechamentos_054_empresa_coerente_trg` | BEFORE INSERT/UPDATE OF empresa_id, pacote_id | `fechamentos.empresa_id` = `pacotes.empresa_id` (política da 040/053: NULL/NULL válido, resto recusado) |
| `fechamentos_054_cliente_coerente_trg` | BEFORE INSERT/UPDATE OF cliente_id | **nova** associação cliente↔fechamento exige as duas empresas preenchidas e iguais; linha histórica só é revalidada se o cliente mudar |
| `fechamento_revisoes_054_cliente_coerente_trg` | BEFORE INSERT/UPDATE OF cliente_id, fechamento_id | cliente da revisão preparada = empresa do fechamento pai, as duas preenchidas; NULL nunca autoriza; revisão histórica só é revalidada se cliente ou fechamento mudar |
| `kidmais_054_falhar_se_incompativel()` | função de critério operacional | usada pela migration e pelo postcheck; inclui revisões com cliente de outra empresa |

Cinco funções, todas com nome qualificado, `SET search_path = pg_catalog, pg_temp` e sem
`SECURITY DEFINER`.

**Dependências verificadas antes de criar qualquer objeto**, por um bloco
(`kidmais-054-dependencias`) idêntico na migration, no precheck e no postcheck. Critério da 053:
schema, tabela, gatilho, função, eventos (`tgtype`), colunas, ENABLED (`'O'`), sem WHEN, gatilho
comum ou de restrição `DEFERRABLE INITIALLY DEFERRED` conforme o esperado. Exige:
- 036/038: `pacotes_`, `tabelas_preco_` e `adicionais_empresa_imutavel_trg`;
- 053 inteira: os 9 gatilhos (os dois `_filhos_trg` como restrição diferida), a FK
  `fechamento_pacote_snapshots_anterior_mesmo_fechamento_fk` validada e as 15 funções
  `kidmais_053_*` com search_path fixo e sem SECURITY DEFINER;
- `clientes_atualizado_em_trg` e `fechamentos_atualizado_em_trg` (desligados e religados no
  backfill);
- guardas históricas sobre `fechamentos` que o `SET CONSTRAINTS ALL IMMEDIATE` do backfill
  executa, com a configuração lida das migrations de origem:

  | gatilho | origem | função | eventos (`tgtype`) | tipo |
  |---|---|---|---|---|
  | `fr_fechamento_proteger_trg` | 014 | `kidmais_proteger_fechamento_em_revisao()` (redefinida na 016) | AFTER UPDATE, por linha (17) | restrição diferida |
  | `fr_confirmacao_agenda_trg` | 014 | `kidmais_validar_agenda_revisao()` (redefinida na 019) | AFTER INSERT OR UPDATE, por linha (21) | restrição diferida |
  | `festa019_fechamento` | 019 | `kidmais019_validar_contrato()` | AFTER INSERT OR UPDATE, por linha (21) | restrição diferida |
  | `festa019_lock_fechamento` | 019 | `kidmais019_lock_ocupacao()` | BEFORE INSERT OR UPDATE, por linha (23) | comum |

  Todas sem WHEN e sem lista de colunas. A 054 só as exige: nunca as desliga, recria, altera ou
  remove (nem o rollback).

Qualquer divergência aborta a transação antes do primeiro `ALTER`.

### Backfill

- **Fechamentos:** empresa do pacote gravado. Pacote sem empresa → fechamento fica NULL.
- **Clientes, por grupo canônico** (o cliente e os cadastros mesclados nele): se todos os
  fechamentos do grupo com empresa apontam para exatamente uma empresa, o grupo inteiro recebe
  essa empresa. A empresa comprovada é selecionada com
  `(array_agg(DISTINCT empresa_id ORDER BY empresa_id))[1]` sob `HAVING count(DISTINCT empresa_id) = 1`
  (o PostgreSQL padrão não tem `min(uuid)`). Duas ou mais empresas no mesmo grupo abortam a
  migration (checado no precheck e de novo depois da trava). Grupo sem fechamento com empresa
  permanece NULL — cliente legado sem fechamento não é atribuído por conveniência.
- **Sequência (transação única):** colunas e índices → desliga só `clientes_atualizado_em_trg` e
  `fechamentos_atualizado_em_trg` (nenhum DML ainda, nenhuma fila) → UPDATE de fechamentos (enfileira
  os eventos diferidos das guardas 014/016/019) → `SET CONSTRAINTS ALL IMMEDIATE` (essas guardas
  validam agora cada fechamento tocado e nenhum evento fica pendente) → UPDATE de clientes →
  religa os dois gatilhos → cria funções e gatilhos da 054. O PostgreSQL recusa `ALTER TABLE` com
  evento de gatilho pendente na tabela; por isso nenhum DDL ocorre entre o UPDATE de fechamentos e
  o `SET CONSTRAINTS`. Nenhuma guarda de integridade é desligada (diferente da 046, que desligou
  guardas de imutabilidade). `DISABLE TRIGGER` é DDL transacional: qualquer erro desfaz a 054
  inteira, e os gatilhos voltam ligados.
- **Preservação:** `atualizado_em` não muda. Contagem de linhas e hash de todas as colunas exceto
  `empresa_id` são comparados antes e depois dentro da transação; divergência aborta.
- **Prova do backfill imediato:** antes das colunas existirem, a migration calcula pelos pacotes
  (caminho independente do UPDATE) a empresa esperada de cada cliente (`kidmais_054_esperado`).
  Depois do backfill compara linha a linha, inclusive o NULL: 0 empresas comprovadas → NULL;
  1 → essa empresa; 2+ → já abortou. Fechamentos: empresa = empresa do pacote.

### Precheck, postcheck e rollback

| Arquivo | Faz |
|---|---|
| `database/checks/20260928_054_precheck.sql` | só leitura: dependências (mesmo bloco da migration), ambiguidade por grupo canônico, simulação do backfill, contagem e hash de referência |
| `database/checks/20260928_054_backfill_imediato.sql` | só leitura, **logo depois da aplicação e antes de a aplicação gravar cliente novo**: recalcula o esperado pelos pacotes e compara linha a linha, inclusive o NULL esperado |
| `database/checks/20260928_054_postcheck.sql` | só leitura, validação operacional (vale a qualquer momento): dependências (mesmo bloco), colunas (uuid, nulas, sem default), FKs (RESTRICT, validadas, não diferíveis), 5 gatilhos da 054, 5 funções (search_path, não SECURITY DEFINER), critério operacional, índice global de CPF intacto, contagem e hash para comparar com o precheck |
| `database/checks/20260928_054_rollback_precheck.sql` | só leitura: diz se remover a 054 perderia empresa não reconstruível |
| `database/rollback/20260928_054_empresa_id_clientes_fechamentos_down.sql` | aborta no mesmo critério; senão remove só gatilhos, funções, índices, FKs e colunas da 054 |

### Aplicação (código)

- **Clientes (CRM administrativo):** listagem, busca, leitura, edição, análise de cadastro,
  cadastro, lixeira (listar, consultar, arquivar, excluir, restaurar) e aniversariantes (criar,
  editar) passam por `withTenantTransaction`. `?empresaId=` só escolhe entre memberships ATIVA
  do próprio usuário; nenhuma rota lê empresa do corpo. Cliente de outra empresa ou legado sem
  empresa responde como inexistente.
- **Deduplicação e busca:** todas as consultas (CPF, telefone, WhatsApp, e-mail, e-mail exato,
  nome parecido, listagem) filtram `empresa_id` na própria SQL, antes de ORDER BY/LIMIT. Nenhum
  candidato, id ou nome de outra empresa. `registrarPossivelDuplicidade` recusa par que não seja
  da mesma empresa comprovada.
- **Identidade comprovada ≠ tenant:** `obterClienteBasePorIdentidade` recebe a prova resolvida
  (token válido, não expirado, não consumido, finalidade conferida, cliente canônico) e dá
  acesso só a esse cliente. `atualizarCliente` recebe escopo explícito
  `{ tipo: "TENANT", empresaId }` ou `{ tipo: "IDENTIDADE", clienteIdComprovado }`. A busca global
  por CPF ficou isolada em `buscarClienteCanonicoPorCpfParaIdentidade`, usada só por
  `lib/identidade`.
- **Fechamentos:** `criarFechamento` grava `empresa_id` por subconsulta no próprio `pacote_id`;
  a empresa do fechamento é lida da coluna por duas funções explícitas:
  `empresaDoFechamentoSemTrava` (autorização — leitura simples; tenant A nunca trava nem espera
  linha de B) e `empresaDoFechamentoComTrava` (`FOR SHARE`, só depois de o tenant ser comparado).
  O antigo `empresaDoFechamento`, que escondia um `FOR SHARE` antes da autorização, foi removido.
  Em contratos, o primeiro lock já é tenant-scoped (`WHERE id=$1 AND empresa_id=$2 FOR UPDATE`);
  a revisão comercial trava e revalida a empresa da linha travada. `criarFechamentoComercial` recusa cliente e pacote de
  empresas diferentes (ou sem empresa) antes de gravar (`EMPRESA_INCOMPATIVEL`). O contexto
  administrativo de fechamento (`/api/admin/clientes/[id]/fechamentos`) prova o tenant e só
  carrega cliente dessa empresa. A fila de contratações filtra `fechamentos.empresa_id` do tenant.
- **Contratos/revisão:** `operarContrato` segue a mesma ordem do GET: sessão → `provarTenant` →
  versão/contrato por leitura simples → empresa do fechamento = tenant → só então os locks
  (fechamento → contrato → fluxo → versão → revisão, esta comparada antes de ser travada). Tentativa
  A→B é recusada sem travar nenhum recurso de B. A comparação vale **para toda ação e qualquer payload** (data, pacote, comercial, cadastro, vínculo,
  salvar, revisar, assinar, cancelar, nova versão), antes de qualquer escrita; a revisão precisa
  ser do mesmo fechamento. `editarPreparacao` repete a comparação tenant × fechamento da revisão
  antes de ler ou alterar. Outra empresa, legado sem empresa e inexistente respondem igual
  (`Versão não encontrada.`). O cliente de troca de vínculo precisa ser da mesma empresa.
- **Leitura da edição de contrato** (`GET /api/admin/contratos/versoes/[versaoId]/edicao`):
  sessão → `withTenantTransaction` → versão e fechamento → empresa do fechamento = tenant
  (`versaoDoTenant`) → só então fontes, vínculos, catálogo e prévia. A empresa do alvo nunca
  autoriza; outra empresa, legado e inexistente respondem igual.
- **Revisão comercial** (`/api/admin/fechamentos/[fechamentoId]/revisao`, GET e POST): tenant
  provado; fechamento de outra empresa ou legado responde como inexistente, antes de ler ou gravar.
- **Festas** (`GET /api/admin/festas`, lista, filtro por cliente e detalhe): tenant provado;
  consulta por festa → contrato → `fechamentos.empresa_id` = tenant, na SQL. Festa de outra
  empresa ou de fechamento legado não aparece e responde como inexistente no detalhe.
- **Fluxo público:** a empresa vem do pacote já resolvido por UUID (fonte transitória); pacote
  sem empresa é recusado; cadastro comprovado por identidade de outra empresa (ou legado) não é
  associado (`EMPRESA_INCOMPATIVEL`).

### Testes executados (sem banco)

Novos: `lib/clientes/tenant-054.test.ts`, `lib/clientes/tenant-054-f.test.ts` e
`lib/contratos/tenant-054-contratos.test.ts`. Ajustados para o Tenant Context: `lixeira`,
`aniversariante-crm`, `fechamentos/administrativo`, `fechamentos/contratacoes`,
`components/festas/Contratacoes`, `comercial/integridade-fechamento` (texto da rota de edição),
`contratos/services/revisao-pre-assinatura`, `revisao-pos-assinatura`,
`cancelamento-pre-assinatura` e `pagamentos/services/cancelamento` (os quatro últimos só
simulam o tenant comprovado igual à empresa do fechamento).

Cobrem: sequência do backfill (F1); A/B e legado em lixeira, aniversariantes, contexto de
fechamento, leitura/edição, deduplicação e CRM; contratos com payload só de data, pacote ou
condição comercial (tenant A em fechamento B recusado antes de qualquer escrita); leitura da
edição de contrato; revisão comercial; festas A/B; identidade composta (prova → canonicalização →
leitura) sobre SQL simulada com os mesmos predicados; dependências (bloco idêntico e negativos
sobre um modelo do predicado, incluindo as guardas históricas 014/019); ordem sessão → tenant →
comparação → locks em contratos, com registro explícito das chamadas (A→B não trava nada do alvo);
prova do backfill (modelo da derivação 0/1/2+).

Esses testes provam o texto da SQL, modelos que a espelham termo a termo e o comportamento dos
serviços com executores simulados. A SQL no motor real é provada pelo ciclo descartável abaixo.

### Ciclo PostgreSQL descartável (escrito e executado)

Harness: `lib/fechamentos/migration-054.postgres.test.ts`, com o guarda de alvo
`lib/fechamentos/alvo-054.ts`, o conector `lib/fechamentos/postgres-descartavel-054.ts` e as peças
sem driver `lib/fechamentos/harness-054.ts` (testadas sem banco em `alvo-054.test.ts` e
`harness-054.test.ts`). Só roda com `KIDMAIS_054_PG_HOST/PORT/DATABASE/USER` e
`KIDMAIS_054_AUTORIZACAO=host:porta/banco` literal; `DATABASE_URL` e variáveis `PG*` genéricas
recusam o ciclo; `kidmais_manager` é proibido na configuração e na resposta do servidor.

- **Alvo:** `127.0.0.1:55498/kidmais_pacotes_v1_descartavel`, usuário `kidmais_descartavel`
  (identidade conferida pelo servidor antes de qualquer outro SQL; autenticação local, sem senha).
- **053:** estava ausente; o harness comprovou isso, instalou (precheck + up) e removeu ao final.
- **Execuções:** a terceira passou integralmente. As duas primeiras falharam só por defeitos do
  harness: H1 (a limpeza tentava excluir empresas; a guarda 044 recusa exclusão física), H2 (o
  erro da limpeza mascarava o erro original), H3 (`pg_stat_activity` trunca o texto do statement,
  e a verificação da espera em K2 olhava o texto truncado). Após a execução 1, o banco foi
  recuperado (fixtures removidas, rollback precheck, down da 054, down da 053).
- **Resultados:** precheck, up real (com o BEGIN/COMMIT do arquivo, sem erro de evento diferido
  antes de DDL), backfill imediato e postcheck passaram.
  - Backfill: pacote A → A; pacote NULL → NULL; grupo com 0 empresas → NULL; 1 empresa → o grupo
    inteiro (prova no canônico, só no mesclado, vários fechamentos da mesma empresa, com pacote
    NULL junto); 2+ empresas (canônico e mesclado) → precheck e migration abortam, atômicos.
  - Preservação: `atualizado_em`, contagens e hash sem `empresa_id` idênticos; catálogo de
    gatilhos fora da 054 idêntico; guardas 014/019 `ENABLED`.
  - Dependências degradadas (15 casos, 014/019/036/038/053/timestamps): precheck e up recusam,
    sem objeto residual. Postcheck recusa a 054 ou guarda degradada depois de instalar.
  - Adversariais por SQL direto: cliente↔fechamento só A/A; revisão só A/A; coerência com o pacote
    e imutabilidade de `empresa_id`; legado não adotado.
  - Locks (serviços reais): A→B sem nenhuma consulta com lock e `xmax` do alvo inalterado
    (`operarContrato` com 7 payloads, alvo B e legado; versão inexistente; GET da edição; revisão
    comercial; `editarPreparacao`). A→A: autorização sem lock; primeiro lock tenant-scoped.
  - Concorrência (duas conexões): A não espera lock de B (o controle com a variante com trava toma
    `lock_timeout`); mesmo tenant serializa no lock de domínio e termina no resultado de domínio
    esperado; alteração concorrente de empresa/cliente recusada; ordem comum sem deadlock.
  - Rollback inseguro (cliente com empresa não reconstruível): rollback precheck e down abortam; a
    054 continua íntegra e o dado permanece. Rollback seguro: objetos da 054 removidos, nenhuma
    linha apagada, estado anterior restaurado.
- **Limitações do ciclo:** `provarTenant` é simulado nos testes de lock (os locks dele são só do
  próprio tenant e têm teste PostgreSQL próprio no HG-8); o banco não tinha revisão histórica com
  cliente sem empresa (esse caso ficou coberto só pela recusa de nova associação); as empresas
  reservadas do harness permanecem no banco descartável por causa da guarda 044.
- **Endurecimento posterior do harness:** empresas reservadas por código determinístico
  (`kidmais-fixture-054-a/-b`), com nome, status e ausência de vínculos conferidos (toda FK para
  `empresas` descoberta no catálogo, mais fechamentos, clientes, contratos, revisões e pagamentos
  pelo pacote); as duas empresas das execuções 1–3 ficam como resíduo conhecido, aceito só por
  id + código exatos e sem vínculo; resíduo inesperado aborta sem nenhum DELETE; a limpeza remove
  só IDs registrados pela execução; a 053 só é removida depois de comprovada a ausência completa da
  054; o erro principal é sempre preservado; K2 exige `REVISAO_COMERCIAL_INVALIDA`.
- **Reexecução com o harness endurecido (execuções 4 e 5):** mesmo PostgreSQL descartável
  (`127.0.0.1:55498/kidmais_pacotes_v1_descartavel`); as duas passaram integralmente.
  - A execução 4 criou as empresas reservadas determinísticas; a execução 5 reutilizou exatamente
    as mesmas empresas, localizadas por código, e não criou nenhuma empresa nova.
  - K2 terminou exatamente em `REVISAO_COMERCIAL_INVALIDA`.
  - Rollback seguro e rollback inseguro passaram nas duas execuções.
  - A limpeza removeu somente os IDs registrados pela própria execução; ao final, 053 e 054
    ausentes, zero fixtures relacionais e guardas históricas habilitadas.
  - Resíduo final: apenas 4 empresas de fixture, sem nenhum vínculo — as 2 reservadas
    determinísticas e as 2 legadas das execuções 1–3 (a guarda 044 impede exclusão física).
  - Nenhum defeito funcional encontrado.

## 2. Planejado (não feito)

- Precheck operacional num clone autorizado antes de staging: ambiguidade real, quantos clientes
  ficam sem empresa, privilégios do papel da aplicação (`ALTER TABLE ... DISABLE TRIGGER` exige
  dono da tabela).

## 3. Limitações conhecidas

1. **CPF global (até o PR-B2).** O índice `clientes_cpf_canonico_uk` ainda impede o mesmo CPF
   em duas empresas. No cadastro administrativo, o CPF de outra empresa só aparece como
   violação do índice e responde `CPF_INDISPONIVEL`, sem id, nome ou empresa do dono. No fluxo
   público a resposta continua `CPF_EXISTENTE_REQUER_VALIDACAO` (também sem dono).
2. **Identidade pública por CPF é global.** `lib/identidade` ainda localiza o cliente por CPF sem
   Tenant Context (não há contexto público de empresa). A prova não concede tenant e a associação
   a um fechamento de outra empresa é recusada, mas a identidade em si só fica por empresa com o
   Tenant Context público (PR-C) e o CPF por empresa (PR-B2).
3. **Criação de fechamento continua bloqueada.** `buscarPacoteAtivoPorCodigo` recusa com
   `CATALOGO_PUBLICO_INDETERMINADO` desde a PR-A (commit `d93955e`). A 054 não reabre, não cria
   bypass e não tem teste E2E de criação pública ou administrativa. Restaurar exige Tenant Context
   público explícito: empresa/estabelecimento confiável → pacote dentro do tenant (Gate 1 / PR-C).
4. **Domínios ainda sem Tenant Context (PR-C):** outras rotas de contrato (`/api/admin/contratos`,
   `/resumo`, `/pdf`), comandos de festa (mutações em `/api/admin/festas`), capacidades/perfis/áreas
   de festa, pagamentos e agenda. `operarContrato`, a leitura da edição, a revisão comercial e a
   consulta de festas já provam o tenant.
5. **Cliente legado sem empresa fica inacessível** no CRM administrativo, na lixeira, nos
   aniversariantes e no contexto de fechamento, e não recebe associação nova. Não existe
   remediação nesta etapa; atribuir empresa a um legado exige migration controlada própria
   (a imutabilidade recusa UPDATE de NULL para empresa).
6. **Fechamento legado sem empresa** some da fila de contratações e da consulta de festas, e
   nenhuma ação administrativa de contrato, revisão ou revisão comercial o opera (responde como
   inexistente). Revisão nova para fechamento legado é recusada no banco.
7. **Rollback depois de uso real não é automático.** Cliente criado no CRM depois da 054 tem
   empresa que o backfill não reproduz; o `_down.sql` aborta. Ordem obrigatória: a aplicação volta
   para uma versão sem `empresa_id` primeiro; o schema depois.
8. **Mesclagem entre empresas** não tem caminho no código hoje; o postcheck recusa grupo mesclado
   com empresas diferentes, mas não há gatilho dedicado para uma mesclagem futura.
9. **Contorno por dono ou superusuário**, como toda guarda do repositório.
10. **Backfill toca todos os fechamentos com empresa** e executa, no `SET CONSTRAINTS ALL
    IMMEDIATE`, as guardas diferidas 014/016/019 de cada linha: tempo de trava proporcional ao
    volume, e histórico que viole essas guardas faz a 054 abortar (fail-closed).
11. **Prova do backfill imediato fora da transação** (`20260928_054_backfill_imediato.sql`) só vale
    antes de a aplicação gravar cliente novo; depois, usar o postcheck (critério operacional).
12. **Ordem de travas em contratos:** `operarContrato` agora trava sessão/usuário/empresa/membership
    (`provarTenant`) antes de fechamento/contrato/fluxo/versão/revisão, como o GET. Outros fluxos
    fora deste PR (festas, pagamentos) ainda travam contrato sem tenant; um deadlock com eles é
    detectado pelo PostgreSQL e aborta uma das transações, sem estado inconsistente (PR-C).
13. **Hash de concorrência de edição** (`fonteHash`) inclui o registro do cliente: uma edição
    aberta antes do deploy recebe um conflito e precisa ser reaberta.

## Integração com a 053

A 053 não é reescrita e nunca olha `fechamentos.empresa_id`. Ela continua responsável pelos filhos
comerciais do fechamento (adicionais, revisões, fotografias, composição). A 054 acrescenta a
coerência da coluna nova com o pacote e com o cliente, e exige a 053 instalada. Ordem de rollback:
054 antes da 053.

## Aplicação

**Staging: aplicada** (053 e 054), com backfill imediato e postcheck aprovados. **Produção: não
aplicada** — nem a 053 nem a 054. Qualquer aplicação em produção exige autorização explícita
(`docs/OPERACAO_AGENTES.md`).

Histórico: antes de staging, as execuções 1 a 5 foram no PostgreSQL descartável autorizado, e a
054 ficou ausente desse banco ao final de cada ciclo.
