# Aplicador da 099 em produção (B-2, 25/10/2026)

Estado: **implementação LOCAL**, sem commit, branch `codex/aplicador-099-production-20261025` sobre staging `54598a921875e7102a689f526f7a6687cf8d2d4f`. Nada foi executado em nenhum banco. Este documento não autoriza aplicação.

Origem: backlog B-2 do plano de promoção (`kidmais-manager-planejamento-production-20261025/docs/PLANO_PROMOCAO_PRODUCTION_20261025.md`, §4.2/§4.3, §5 e §12). A 099 (convites avulsos) vem **antes** do código de Convites avulsos (o código novo não detecta a 099; o antigo continua compatível) — em produção é parte do E3, com o código antigo ainda publicado. O aplicador de staging (`scripts/migration-099-staging.cjs`) já foi usado em 24/10/2026 e não foi alterado.

## O que foi criado

| Arquivo | Conteúdo |
| --- | --- |
| `database/checks/20261025_099_vinculo_versao.sql` | pré-condição nova, só leitura: conta convites vinculados que não satisfazem a regra do corpo novo de `convite_validar_vinculo()` (versão do contrato da festa, além do vínculo festa/contrato/fechamento/empresa/cliente/estabelecimento) e recusa com a contagem, sem ids. O gatilho roda em todo INSERT/UPDATE de convites: um convite assim ficaria impossível de atualizar depois da 099 |
| `scripts/migration-099-comum.cjs` | núcleo no padrão 096/097: estado ausente/completa/parcial pelos objetos da 099 (CHECK, índice, 4 colunas nuláveis, corpos das duas funções por sha256), dependências 073/088, corpos anteriores exatos, **dono** (current_user) de `convites`, `convite_ia_autorizacoes` e das duas funções; plano sem conexão; `--backup` obrigatório; códigos 0/1/2/3; marcador exclusivo `migration-099.json` |
| `scripts/migration-099-production.cjs` | adaptador: alvo fixo de produção, TLS obrigatório com certificado conforme o serviço, identidade provada no servidor, disco persistente, DIR `convites-avulsos-099-producao`, ordem do E3 |
| `scripts/bloco-shell-099.cjs` | blocos de Shell de produção (`CONFERIR`, `APLICAR`), no desenho dos blocos 088/089/097 |
| testes | `scripts/migration-099.test.cjs` (15), `scripts/bloco-shell-099.test.cjs` (6); passo novo no `ci.yml` |

## Aplicação: transação única

BEGIN → `lock_timeout 5s`, `statement_timeout 60s` → `pg_advisory_xact_lock(990024)` + `LOCK TABLE convites, convite_ia_autorizacoes IN ACCESS EXCLUSIVE MODE` → estado ainda ausente sob a trava → precheck → vínculo/versão → retrato agregado (contagens e md5 dos vínculos, sem ids) → DDL da 099 (o arquivo sem `BEGIN;`/`COMMIT;`) → postcheck → estado completo → retrato igual → COMMIT. Qualquer falha antes do COMMIT desfaz tudo (`commit: NAO_ENVIADO`); falha no COMMIT é `DESFEITA_PELO_SERVIDOR` (SQLSTATE fora de 08/57/58/XX) ou `INDETERMINADO` (conferir, nunca repetir). Se o COMMIT for confirmado e a leitura de estado seguinte falhar ou divergir (`ESTADO_FINAL_099`), o resultado é `FALHA` com `commit: CONFIRMADO` e `migracaoCommitada: true`: a 099 está aplicada; conferir com `--conferir-099` e não repetir. A trava exclusiva bloqueia leituras e escritas de convites — inclusive link público e RSVP — durante a transação: por isso a 099 entra na janela com manutenção do E3.

## Uso (artefato de revisão — não executar sem autorização)

```text
node scripts/migration-099-production.cjs                                             # plano, sem conexão
node scripts/migration-099-production.cjs --conferir-099                              # somente leitura
node scripts/migration-099-production.cjs --aplicar-099-autorizado --backup "<registro>" # E3, uma vez
```

A conferência informa `contagens.incompativeis`; com valor > 0 responde `RECUSARIA` (código 3) e nada é alterado — o tratamento desses convites é decisão de Felipe, fora deste aplicador.

## Validação local (sem banco)

- `scripts/migration-099.test.cjs` 15/15; `scripts/bloco-shell-099.test.cjs` 6/6; `scripts/migration-099-staging.test.cjs` 2/2 (staging preservado); `lib/convites/migration-099.test.ts` 3/3; `npm run production:test` 37/37; ESLint dos arquivos novos sem erro; `git diff --check` limpo.
- `npm run check:v1:static` código 0 (3599 + 103 testes, 0 falhas; 2 avisos de ESLint preexistentes em arquivos não tocados; `next build` compilado); o `next-env.d.ts` reescrito pelo build foi restaurado.
- Mutantes em cópia isolada (controle 11/11), todos derrubados: sem o check vínculo/versão na aplicação (2 falhas), sem a exigência de dono (3), COMMIT indeterminado tratado como desfeito (1), sem `LOCK TABLE` (1), sem prova de preservação (1), conferência ignorando o vínculo/versão (1).

## Limites e pendências

- **Nenhum PostgreSQL executado** (nem descartável): falta provar em cluster isolado autorizado a transação única com trava, o check vínculo/versão com dados reais de teste (convite com versão de outro contrato), a recusa por falta de dono e a compatibilidade do código antigo depois da 099.
- **E3 depende de B-4:** o código hoje publicado em produção não contém este aplicador nem o check novo.
- O comportamento do link público/RSVP durante a trava não foi medido (duração esperada: segundos, sem volume conhecido de convites em produção).
- Revisão independente pendente.

## Revisão independente — rodada 1 (APROVADO COM RESSALVAS: 2 P2 + 1 P3) e correção

- **P2-1** — `completa` só exigia o nome do CHECK e do índice. Agora `restricao_definicao` compara `pg_get_constraintdef` (CHECK validado) e `indice_definicao` compara `pg_get_indexdef` (índice válido, pronto, não único, na tabela `convites`), ambos sem parênteses nem espaços, com a expressão da migration (`DEF_CHECK`, `DEF_INDICE`). Nome com definição divergente dá **parcial** (`APLICACAO_PARCIAL_099 restricao_definicao|indice_definicao`). A forma reconstruída pelo servidor só se confirma em PostgreSQL: se divergir, o erro é do lado seguro (parcial e recusa).
- **P2-2** — além de dono das 2 tabelas e 2 funções, a conferência e o plano exigem `CREATE` em `public` e `USAGE` em `plpgsql` quando a 099 está ausente (`SEM_PRIVILEGIO_099 DONO CREATE PLPGSQL`).
- **P3** — `colunas_nulaveis` virou contagem (0–4); 1 a 3 colunas já nuláveis, com ou sem os outros objetos, dão **parcial** com a contagem nas divergências.
- Regressões: definição divergente do CHECK/índice, colunas 1–3, falta de CREATE/PLPGSQL (inclusive na conferência, código 3). Mutantes em cópia isolada (controle 14/14): ignorar a definição do CHECK, ignorar a do índice, colunas parciais tratadas como ausente, sem CREATE, sem PLPGSQL — todos derrubados; os mutantes da rodada 1 continuam derrubados contra o núcleo novo. Suítes: 099 14/14, blocos 6/6, staging 2/2; ESLint e diff-check limpos; `npm run check:v1:static` repetido depois da correção: código 0 (3599 + 103 testes; 2 avisos preexistentes; build compilado).

## Revisão independente — rodada 2 (REPROVADO, 1 P2) e correção

P2: comparar o CHECK sem parênteses apagava o agrupamento lógico — `(A OR F) AND C AND V` colidia com `A OR (F AND C AND V)` (reproduzido offline pelo revisor). Correção: `restricao_definicao` prova a SEMÂNTICA. (1) A expressão reconstruída por `pg_get_constraintdef` só pode conter as 5 colunas, `IS`, `NOT`, `NULL`, `AND`, `OR` e parênteses (`TOKENS_CHECK`); (2) só então, por `CASE WHEN` (que garante a ordem; `AND` não garante), ela é avaliada em leitura (`query_to_xml` sobre `VALUES`, sem tocar tabelas) nas 32 combinações nulo/não nulo das 5 colunas, e cada resultado tem de ser igual ao da regra da migration (`regraCheck099`; 5 combinações aceitas). Qualquer diferença, ou forma inesperada do servidor, dá `parcial`. (Substituído na rodada 3: a avaliação passou a ser local; ver abaixo.) Regressão nova: expressão da migration e forma reconstruída com parênteses aceitas; agrupamento divergente da revisão, tautologia e regra só de vínculo recusados; função, literal, operador e subconsulta barrados pela lista de tokens; estrutura do SQL (tokens antes da avaliação, 32 linhas, sem tabelas). Mutantes em cópia isolada (controle 15/15), todos derrubados: regra com agrupamento divergente, sem lista de tokens, sem tabela-verdade, AND no lugar do CASE, lista de tokens aceitando qualquer caractere (o mutante sem lista de tokens sobreviveu à primeira versão do teste e levou a uma asserção mais forte). Mutantes das rodadas anteriores continuam derrubados. `npm run check:v1:static` repetido: código 0 (3599 + 103 testes; 2 avisos preexistentes; build compilado). **Ainda sem PostgreSQL:** a avaliação real via `query_to_xml` e a forma reconstruída pelo servidor só se confirmam no ensaio isolado autorizado.

## Revisão independente — rodada 3 (REPROVADO, 1 P2) e correção

P2: a lista de tokens da rodada 2 aceitava fragmentos e parênteses sem gramática — `(festa_id() IS NULL)`, `(festa_id(cliente_id) IS NULL)` e `(festa_idfesta_id() IS NULL)` passavam pelo filtro e a expressão seria executada no servidor por `query_to_xml`. Correção: **nada do texto do catálogo é executado**. O `SQL_ESTADO` só LÊ a definição (`pg_get_constraintdef`, como texto, filtrando `contype='c'` e `convalidated`) em `restricao_def`; o aplicador analisa localmente (`definicaoCheck099Valida`): tokens inteiros (só as 5 colunas, `IS`, `NOT`, `NULL`, `AND`, `OR`, `(`, `)`), gramática fechada (`expr := termo (OR termo)*`, `termo := fator (AND fator)*`, `fator := ( expr ) | coluna IS [NOT] NULL`, todos os tokens consumidos) e avaliação da árvore nas 32 combinações contra a regra da migration. Recusa ou diferença = `parcial`. Isso substitui a seção da rodada 2 sobre `query_to_xml`. Os testes exercitam a função de produção (não um avaliador só de teste): forma da migration e forma reconstruída aceitas; agrupamento divergente, tautologia, chamadas com e sem argumento, nomes concatenados, aspas, comentário, `;`, cast, nome qualificado, subconsulta, parênteses desbalanceados e sobra de tokens recusados; `SQL_ESTADO` sem `query_to_xml`, `xpath`, `EXECUTE` ou `format(`. Mutantes em cópia isolada (controle 15/15), todos derrubados: tokens aceitando qualquer palavra, coluna aceitando chamada, sem tabela-verdade, sobra de tokens aceita (sobreviveu à primeira versão do teste; casos de sobra acrescentados), estado ignorando a definição, AND avaliado como OR; as baterias das rodadas anteriores continuam derrubadas. `npm run check:v1:static` repetido: código 0 (3599 + 103 testes; 2 avisos preexistentes; build compilado). Ainda sem PostgreSQL: a forma real de `pg_get_constraintdef` só se confirma no ensaio isolado autorizado; se divergir da gramática, o estado é `parcial` e a aplicação recusa.
