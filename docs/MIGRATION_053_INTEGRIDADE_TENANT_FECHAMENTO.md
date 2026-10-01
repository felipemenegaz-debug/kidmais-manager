# Migration 053 — Integridade de tenant no Fechamento (PR-A)

Primeira barreira da trilha de Importação de Contratos Históricos. O Fechamento não tem `empresa_id`: a empresa dele é a empresa do pacote. A partir da 053, um fechamento não combina recursos de empresas diferentes, e a empresa dele não muda.

## Invariantes protegidos

1. A empresa do fechamento é a empresa do pacote gravado, e é **imutável**.
2. Fechamento, revisão e fotografia: tabela da mesma empresa do pacote, preço do par (pacote, tabela), regra de desconto do pacote.
3. Revisão e fotografia são da empresa do fechamento.
4. Adicional do fechamento ou da revisão: da mesma empresa, com preço do par (adicional, tabela **atual** do pai), inclusive no COMMIT, depois de uma troca de tabela.
5. Composição: adicional incluso da empresa da fotografia.
6. Fotografia anterior (`snapshot_anterior_id`) é do mesmo fechamento, e portanto do mesmo tenant.
7. Regra de desconto utilizada não muda de pacote; a não utilizada não muda de empresa.

**Política de legado (a mesma da 040):**
- NULL/NULL é válido;
- a mesma empresa nos dois lados é válida;
- empresas diferentes são inválidas;
- NULL com empresa é inválido.

## Defesa em profundidade

**Serviço:**
- `calcularResumoComercial(empresaEsperada)`: um pacote de outra empresa responde exatamente como um pacote inexistente (`PACOTE_NAO_ENCONTRADO`, 404, mesma mensagem e detalhes). A resposta não revela se o id existe em outro tenant.
- `empresaDoFechamento` lê a empresa do banco, nunca do pedido. Edição, revisão e prévia a usam.
- `listarAdicionaisAtivosComPreco` faz JOIN com a tabela: uma tabela inexistente não devolve nada e não vira legado.
- `listarCodigosInclusos(empresaEsperada)` lê a composição já escopada: um pacote de outra empresa, ativo ou inativo, devolve lista vazia.
- A listagem de pacotes da prévia é escopada pela empresa.

**Banco:**

| Objeto | Tipo | Garante |
|---|---|---|
| `fechamentos_053_empresa_trg` | BEFORE INSERT/UPDATE OF colunas comerciais | invariantes 1 e 2 |
| `fechamentos_053_filhos_trg` | CONSTRAINT TRIGGER DEFERRABLE INITIALLY DEFERRED, AFTER UPDATE OF pacote/tabela | invariante 4 no COMMIT |
| `fechamento_adicionais_053_empresa_trg` | BEFORE INSERT/UPDATE | invariante 4, com o pai travado |
| `fechamento_revisoes_053_empresa_trg` | BEFORE INSERT/UPDATE | invariantes 2 e 3 |
| `fechamento_revisoes_053_filhos_trg` | CONSTRAINT TRIGGER diferido | invariante 4 para a revisão |
| `fechamento_revisao_adicionais_053_empresa_trg` | BEFORE INSERT/UPDATE | invariante 4, com a revisão travada |
| `fechamento_pacote_snapshots_053_empresa_trg` | BEFORE INSERT | invariantes 2 e 3 |
| `fechamento_pacote_snapshots_anterior_mesmo_fechamento_fk` | FK composta `(snapshot_anterior_id, fechamento_id)` → `(id, fechamento_id)` | invariante 6 |
| `fechamento_pacote_composicao_053_empresa_trg` | BEFORE INSERT | invariante 5 |
| `regras_desconto_pacote_053_utilizada_trg` | BEFORE UPDATE OF pacote_id | invariante 7 |

Todas as 15 funções usam nomes qualificados (`public.`) e `SET search_path = pg_catalog, pg_temp`. Nenhuma é SECURITY DEFINER.

## Protocolo de locking

**Validação** (gatilhos BEFORE):
1. linha do pai, só na validação de adicional: fechamento com `FOR SHARE`; revisão com `FOR UPDATE` (ver "Caminho de revisão");
2. `precos_pacote` com `FOR SHARE`;
3. `regras_desconto_pacote` com `FOR SHARE`;
4. `precos_adicional` com `FOR SHARE`.

**Escritas concorrentes:** a troca de tabela do pai e as reatribuições de preço ou desconto são UPDATEs. O UPDATE trava a linha antes de rodar os gatilhos BEFORE da 030 e da 053, e essa trava conflita com `FOR SHARE`.

| Corrida | Quem chega primeiro | O que acontece |
|---|---|---|
| **Preço de pacote** (A4) | reatribuição | a utilização espera, o PostgreSQL reavalia o WHERE (READ COMMITTED) e ela é recusada (`053: … preço do pacote`) |
| | utilização | a reatribuição espera, o gatilho da 030 reconsulta com snapshot novo e ela é recusada (`030: preço de pacote utilizado`) |
| **Desconto** (A2/A4) | reatribuição | a utilização é recusada (`053: fechamento: regra de desconto`) |
| | utilização | a reatribuição é recusada (`053: regra de desconto utilizada`) |
| **Preço de adicional** | reatribuição | o adicional é recusado (`053: adicional do fechamento: preço do adicional`) |
| | utilização | a reatribuição é recusada (`030: preço de adicional utilizado`) |
| **Troca de tabela × inclusão de adicional** (F1) | troca de tabela | o adicional espera no `FOR SHARE` do pai, relê a tabela nova e o preço antigo é recusado |
| | inclusão de adicional | a troca espera; no COMMIT, o gatilho diferido vê o filho já confirmado e recusa (`053: adicionais do fechamento após troca de tabela ou pacote`) |

**Mesma transação:** o fluxo legítimo continua funcionando. O pai é atualizado, os filhos são apagados e reinseridos com a tabela nova, e o `FOR SHARE` sobre a própria linha já travada não conflita.

**Deadlock:** a reatribuição trava uma linha só, e a troca de tabela trava o pai e depois os preços. Não há ciclo sistemático. Numa reprecificação em lote concorrendo com um fechamento de vários adicionais, o PostgreSQL detecta o deadlock e aborta uma das transações, sem confirmar estado incompatível.

**Caminho de revisão:** `kidmais_053_revisao_adicional` trava a revisão com **`FOR UPDATE OF r`** desde a primeira leitura, e não com `FOR SHARE`.
- **Motivo:** os gatilhos BEFORE disparam em ordem alfabética. `fechamento_revisao_adicionais_053_empresa_trg` roda antes de `fra_preservar_trg` (014), que trava a mesma revisão com `FOR UPDATE`.
- **O que evita:** se a 053 travasse com `FOR SHARE`, duas inclusões concorrentes na mesma revisão obteriam ambas o `FOR SHARE` e depois se bloqueariam ao tentar promovê-lo a `FOR UPDATE` (deadlock evitável). Com `FOR UPDATE` desde o início, a segunda inclusão simplesmente espera a primeira terminar, e as duas concluem se forem válidas.
- **Troca de tabela da revisão:** é um UPDATE, que trava a mesma linha e se serializa com a inclusão.
- **Guardas diferidas:** as validações da 014 continuam diferidas e independentes; no COMMIT, as duas famílias precisam passar.

## Dependências

A migration e o precheck recusam instalar se faltar alguma destas:

| Migration | Dependência |
|---|---|
| **030** | `kidmais_030_preco_utilizado` com os gatilhos de preço de pacote e de adicional. Sem ela, a reatribuição de preço utilizado não seria barrada. |
| **034** | guarda de tenant do catálogo (preço de pacote, preço de adicional, pacote_adicionais) |
| **036/038** | `pacotes_empresa_imutavel_trg`, `tabelas_preco_empresa_imutavel_trg` e `adicionais_empresa_imutavel_trg`: ligados, com `kidmais_036_empresa_pai_imutavel()`, BEFORE UPDATE OF `empresa_id` e sem WHEN. A 053 não os recria; só exige. |
| **029** | `fechamento_pacote_snapshots_imutavel` e `fechamento_pacote_composicao_imutavel`: `kidmais_029_fotografia_imutavel()`, BEFORE UPDATE OR DELETE, ligados, sem WHEN. As guardas de fotografia e composição da 053 são só de INSERT e dependem dessa imutabilidade. |
| **Chave única** | `fechamento_pacote_snapshots_id_fechamento_uk`, usada pela FK composta |

**Um único critério para todas as dependências.** Precheck, pré-condições da migration e postcheck usam o mesmo critério para 029, 030, 034 e 036/038:
- schema `public`, tabela e nome do gatilho;
- função (`tgfoid`), eventos (`tgtype`) e colunas de UPDATE OF;
- ENABLED, sem WHEN (`tgqual`), gatilho comum (sem restrição).

A instalação aborta **antes de criar qualquer objeto** se alguma dependência estiver ausente ou degradada.

**O postcheck confere, pelo catálogo:**
- os 9 gatilhos da 053 pelo mesmo critério, mais o diferimento dos 2 gatilhos de restrição;
- a FK composta: colunas, referência, `ON UPDATE/DELETE RESTRICT`, MATCH SIMPLE, não diferível e validada;
- as 15 funções: `search_path` fixo e nenhuma SECURITY DEFINER;
- o critério do histórico.

**O teste Postgres prova que:**
- precheck e migration recusam, sem criar nada, com uma guarda da 029, 030, 034 ou 036/038 desligada, ausente ou com função, eventos ou WHEN divergentes;
- o postcheck recusa gatilho desligado, recriado com WHEN, com diferimento, colunas ou função trocados; dependência desligada ou ausente; FK removida ou com ação `ON DELETE CASCADE`; função sem `search_path` ou SECURITY DEFINER.

## Privilégios exigidos (antes de staging)

As funções rodam com os privilégios de quem escreve no fechamento (SECURITY INVOKER). `SELECT … FOR SHARE` exige UPDATE em pelo menos uma coluna de cada tabela travada:
- `fechamentos`;
- `fechamento_revisoes`;
- `precos_pacote`;
- `precos_adicional`;
- `regras_desconto_pacote`.

**Antes de staging, o precheck operacional deve confirmar que o papel efetivo da aplicação tem esses privilégios.** Este PR não altera GRANTs. As migrations do repositório não definem nenhum, e o descartável roda com o dono das tabelas.

## Arquivos

| Tipo | Arquivo |
|---|---|
| Migration | `database/migrations/20260928_053_integridade_tenant_fechamento.sql` |
| Precheck (só leitura) | `database/checks/20260928_053_precheck.sql` |
| Postcheck (só leitura) | `database/checks/20260928_053_postcheck.sql` |
| Rollback | `database/rollback/20260928_053_integridade_tenant_fechamento_down.sql` |

A migration não corrige, não apaga e não reescreve dado. Se o histórico tiver algo incompatível, precheck e migration abortam, com a contagem por tabela.

## Rollback

O `_down.sql` remove exatamente o que a 053 criou: 9 gatilhos, a FK composta e 15 funções, todos com `IF EXISTS`. Não toca em gatilhos ou funções de outras migrations e não apaga linhas.

## Testes

- **`lib/comercial/integridade-fechamento.test.ts` (estático):**
  - resposta uniforme para pacote de outra empresa e pacote inexistente;
  - JOIN do adicional com a tabela;
  - composição escopada;
  - listagem da prévia;
  - empresa da edição vinda do fechamento gravado.
- **`lib/comercial/integridade-fechamento-053.postgres.test.ts`** (descartável, via `check:v1:postgres`). Faz o próprio ciclo precheck → migration → postcheck → testes → rollback oficial, e confere que a 053 foi removida, que nenhum fechamento foi apagado e que nenhuma fixture ficou.
  - **Concorrência com duas conexões e prova de bloqueio** (`pg_blocking_pids`): 8 cenários, os dois sentidos de preço de pacote, desconto, preço de adicional e F1.
  - **Validade no COMMIT:** tenants A e B e legado explícito, com `SET CONSTRAINTS ALL IMMEDIATE`.
  - **Recusas:** todas as combinações cruzadas em INSERT e UPDATE; cadeia de fotografias; desconto utilizado e não utilizado; composição; tabela inexistente; adicional de mesmo código nas duas empresas.
  - **Troca de tabela no fechamento:** COMMIT real.
  - **Precheck e migration** abortam com histórico incompatível ou sem as guardas 036/038.
  - **Postcheck** recusa cada configuração divergente.

## Limitações conhecidas

1. **Revisão integrada (F3), teste de integração pendente.** Uma revisão que passe nas guardas diferidas da 014 exige:
   - versão base assinada (`ASSINADA`, `aceite_metodo = 'OTP'`, `documento_pdf_hash`);
   - `contrato_documentos` com o PDF em `bytea`;
   - `contrato_assinaturas` das duas partes (Kidmais por sessão autenticada, cliente por `validacoes_identidade_cliente`);
   - `contrato_edicoes` com `dados_fonte` válido e `contrato_fluxos` coerente.

   Montar isso é infraestrutura de fixture contratual, desproporcional ao PR-A. A fixture de revisão dos testes é mínima e força só a restrição diferida da 053.

   **Por que não bloqueia:** as guardas da 053 são independentes das da 014 (as duas precisam passar), a lógica da revisão é a mesma do fechamento, e no fechamento o COMMIT real foi testado.
2. **Concorrência no caminho de revisão sem teste com duas conexões.** Isso vale para a troca de tabela × inclusão e para duas inclusões na mesma revisão.
   - **Por que não dá:** as duas conexões precisam ver uma revisão confirmada, e o `fr_validar_trg` (014, diferido) recusa o COMMIT de uma revisão sem a fixture contratual do item 1. Não foi criado bypass, como desligar gatilhos.
   - **O que está provado no nível possível:** o teste confere pelo catálogo que `kidmais_053_revisao_adicional` trava `FOR UPDATE OF r`, sem `FOR SHARE OF r`, e que `kidmais_preservar_adicional_revisao` (014) trava a mesma revisão `FOR UPDATE`. Os dois pedem o mesmo modo de trava na mesma linha, então não há promoção.
   - **Comportamento dos dois modos no PostgreSQL:** duas transações com `FOR UPDATE` na mesma linha se serializam, sem deadlock. Duas com `FOR SHARE` seguidas de `FOR UPDATE` se bloqueiam mutuamente.
3. **Contorno por dono ou superusuário.** Como todas as guardas do repositório, os gatilhos podem ser contornados pelo dono das tabelas ou pelo superusuário (`DISABLE TRIGGER`, `session_replication_role`).

## Aplicação

**Estado atual: aplicada em staging** (seguida da 054, também aplicada em staging, com backfill imediato e postcheck aprovados). **Produção NÃO recebeu a 053 nem a 054.** Qualquer aplicação em produção exige autorização explícita (`docs/OPERACAO_AGENTES.md`).

Histórico: antes de staging, a 053 era instalada e removida pelo ciclo autorizado no descartável.

## Fora do escopo (PR-B e seguintes)

- `empresa_id` explícito em clientes e fechamentos (quando existir, a 053 deve conferi-lo contra a empresa do pacote);
- CPF por empresa;
- agenda por empresa;
- atribuição de tenant no fluxo público;
- catálogo de buffet.
