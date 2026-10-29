# Aplicador da 105 de produção (canal MCP por assinatura) — P1

**Estado:** LOCAL, sem commit. Clone `kidmais-manager-aplicador-105-production-20261029`, branch
`codex/aplicador-105-production-20261029`, base `staging` 18c976d4. Não é autorização de execução: produção exige a
janela própria do MCP e autorização de Felipe por ação.

**Origem:** plano "MCP produção pré-requisitos" (rev. 3), item P1, no vault. O Astra aprovou a rev. 2 com ressalvas para
iniciar P1/P2 locais.

## Arquivos

| Arquivo | Papel |
|---|---|
| `scripts/migration-105-production.cjs` | Adaptador: alvo fixo de produção, TLS obrigatório, identidade e **papel**, disco persistente, ordem da janela |
| `scripts/migration-105-production-nucleo.cjs` | Núcleo de produção: conferência com cinco estados, transação única, marcador, PITR, códigos |
| `scripts/migration-105-definicoes.cjs` | Inventário esperado (145 definições) e comparação exata |
| `database/checks/20261029_105_definicoes.sql` | Inventário das definições no catálogo (só leitura) |
| `scripts/bloco-shell-105.cjs` | Ganha o ambiente `production`. Os blocos de staging ficam **byte a byte iguais** |
| `scripts/migration-105-production.test.cjs`, `scripts/bloco-shell-105-production.test.cjs` | Suítes novas (24 + 8), no `ci.yml` |
| `lib/integracoes/oauth/aplicador-105-production.postgres.test.ts` | Suíte PG opt-in, registrada em `scripts/regressao-v1-selecao.cjs` (b14-P11 + 103) |

O núcleo de staging (`migration-105-comum.cjs`), o adaptador de staging e os 4 SQL da 105 **não mudam**. O núcleo de
produção reaproveita deles só o que é leitura pura: hashes, `SQL_ESTADO`/`lerEstado`/`exigirCatalogo` e `commitNaFalha`.

## O que muda em relação ao aplicador de staging

### Alvo e identidade

- Serviço `srv-dak77m2d0e5s73b8rkkg`, `KIDMAIS_DEPLOY_ENV=production`, host interno `dpg-dak750gae00c73fudmg0-a`, banco
  `kidmais_production`, porta 5432, URL sem query.
- `DATABASE_SSL=true` obrigatório, mínimo TLSv1.2; certificado conforme `DATABASE_SSL_REJECT_UNAUTHORIZED`, como nos
  aplicadores de produção B-1..B-3.
- No servidor: banco exato, TLS ativo 1.2/1.3 e endereço privado.
- **Papel** (lição de 14/10: o Render usa `SET role`):
  - `session_user` precisa ser membro de `current_user`;
  - nenhum dos dois pode ser superusuário;
  - `current_user` precisa ser o **dono** de `empresas` e `usuarios_administrativos`, para que as tabelas da 105 nasçam
    com o dono que o código usa.
  - Só booleanos saem na saída, nunca nomes de papéis.
- Os privilégios de `current_user` continuam conferidos um a um pelo `exigirCatalogo` (CREATE, REFERENCES, plpgsql,
  `gen_random_uuid`).
- Qualquer divergência recusa antes de conectar (alvo) ou antes de qualquer escrita (identidade, papel e estado).

### CONFERIR (somente leitura)

Nada é gravado no banco nem no disco.

| Estado | Código | Quando |
|---|---|---|
| `PRONTA_PARA_APLICAR` | 0 | 105 ausente, guardas ok, precheck PASS (READ ONLY) |
| `JA_APLICADA_INTEGRIDADE_PASS` | 0 | 105 completa, integridade antiga **e** definições PASS |
| `DIVERGENTE` | 3 | 105 completa pelos nomes, mas a integridade ou as definições divergem (a saída lista as chaves) |
| `PARCIAL` | 3 | Só parte dos objetos da 105 existe |
| `FALHA_DE_CONFERENCIA` | 3 | Conexão, identidade, papel, dependência, privilégio ou consulta falhou |

Os três últimos param e pedem análise. O aplicador não corrige nada.

### APLICAR numa única transação

`BEGIN` → `SET LOCAL` (lock 5 s, statement 60 s, search_path) → `pg_try_advisory_xact_lock` → estado relido com as
guardas (precisa estar ausente) → precheck → corpo da migration (o arquivo revisado **sem** o `BEGIN;` e sem o `COMMIT;`
finais) → postcheck → integridade antiga → definições → estado completo → registro no marcador → `COMMIT`.

- Depois do COMMIT, um CONFERIR em READ ONLY precisa dar `JA_APLICADA_INTEGRIDADE_PASS`. Senão a saída é FALHA, com o
  COMMIT CONFIRMADO.
- Com a 105 já completa, o APLICAR não escreve: confere e devolve `JA_APLICADA_INTEGRIDADE_PASS` ou FALHA.

### Integridade reforçada por definições

O SQL lê o catálogo com `search_path = pg_catalog, pg_temp` e `IntervalStyle = postgres`, fixados pelo aplicador na mesma
transação. Assim o deparse sempre qualifica `public.` e o intervalo sai em formato fixo. Há uma linha por objeto:

- **tabela:** tipo, persistência, opções, tipada, partição, REPLICA IDENTITY, herança, RLS e FORCE RLS, políticas,
  **RULEs** e dono igual ao de `empresas`;
- **coluna:** posição, `format_type`, nulidade, DEFAULT, identidade, gerada e collation explícita;
- **restrição:** `pg_get_constraintdef`, validada e "enforced". O NOT NULL do PG18 (`contype 'n'`) fica fora, porque a
  nulidade já cobre;
- **índice:** `pg_get_indexdef` **com o predicado parcial** e as flags de chave (único, primário, válido, pronto, vivo,
  imediato, NULLS NOT DISTINCT);
- **gatilho:** `pg_get_triggerdef` e `tgenabled`. Para os internos de cada tabela, quantos estão **fora do modo `O`**
  (`D`, `R` ou `A`; esperado 0);
- **gatilhos de cada FK** (rodada 2): pelo `tgconstraint`, **nos dois lados** (inclusive `empresas` e
  `usuarios_administrativos`), com tabela, função `RI_FKey_*`, `tgtype` e modo. Esperado: 4 por FK, todos em `O`;
- **função:** sha256 do corpo, linguagem, retorno, tipo, SECURITY DEFINER, volatilidade, STRICT, LEAKPROOF, PARALLEL,
  `proconfig` e dono.

A comparação é exata, sem faltar nem sobrar (FALTA, SOBRA, DIFERENTE, REPETIDA, ILEGIVEL). Nenhum texto do catálogo é
executado e a saída traz só as chaves. Há uma única alternativa aceita: o DEFAULT das chaves uuid pode sair como
`gen_random_uuid()` (pg_catalog) ou como `public.gen_random_uuid()`.

- A forma qualificada só vale se `public.gen_random_uuid()` for o **pgcrypto genuíno** (rodada 2). A linha
  `uuid_publico` exige membro da extensão pgcrypto, linguagem C, símbolo `pg_random_uuid` e `$libdir/pgcrypto`.
- Um homônimo qualquer diverge. DEFAULT qualificado sem o pgcrypto genuíno é `INCOERENTE`.
- Com a 105 ausente, a conferência lê a mesma linha e recusa um homônimo (`UUID_PUBLICO_HOMONIMO`) **antes** de aplicar.
- O schema real da aplicação (modelos b14-P11 e 103) já tem o pgcrypto em public: é o caminho normal.

**Deparse confirmado no PostgreSQL 18.6 real** (descartável autorizado por Felipe, 29/10): as definições batem
exatamente com o esperado. A primeira execução achou um defeito do SQL: `'texto' || "char"` é ambíguo (42725). Na
aplicação isso deu FALHA com ROLLBACK, o lado seguro. A correção foi `::text` em todas as concatenações de `"char"`,
booleanos e contagens.

Outra versão do PostgreSQL (16/17) **não** foi ensaiada. Se a forma divergir, o resultado é `DIVERGENTE` ou ROLLBACK,
nunca aceitação. Conferir a versão de produção antes da janela.

**Mutantes de schema que preservam nomes e contagens** (16 offline, todos DIVERGENTE na conferência e ROLLBACK na
aplicação, mesmo com a integridade antiga PASS; 6 deles também REAIS no PG):

- predicado do `mcp_oauth_concessoes_ativa_uk` invertido;
- CHECK afrouxado (escopos até 30; ACESSO até 31 dias);
- FK trocada para **ON DELETE CASCADE**;
- corpo do gatilho trocado;
- gatilho desabilitado e gatilho de FK desabilitado;
- RLS ligada e RULE criada;
- dono diferente;
- SECURITY DEFINER;
- coluna anulável e DEFAULT trocado;
- índice único virou comum;
- CHECK NOT VALID;
- agrupamento trocado com os mesmos tokens (lição do B-2).

A integridade reforçada deve ser **reconferida em staging** (somente leitura, com autorização). A 105 de staging foi
aceita com a integridade antiga. Isso fica como passo próprio.

### COMMIT, 40003 e marcador

- A situação do COMMIT é `NAO_COMMITADA`, `CONFIRMADO`, `DESFEITA_PELO_SERVIDOR` ou `INDETERMINADO`.
  - 40003, 08/57/58/XX ou ausência de SQLSTATE dão `INDETERMINADO` (núcleo F-1).
  - Um COMMIT respondido como ROLLBACK dá `DESFEITA_PELO_SERVIDOR`.
  - O COMMIT nunca é repetido. INDETERMINADO = CONFERIR antes de decidir.
- O marcador `migration-105.json` fica em `data/mcp-105-producao` e é exclusivo (`wx`). Grava o PITR, cada etapa, o
  registro **antes do COMMIT** e o COMMIT.
  - A gravação é atômica (`.tmp` + rename): o último registro íntegro nunca é truncado.
- O estado do COMMIT fica **em memória** e é a fonte da saída (solução do B-3):
  - antes do COMMIT, falha de disco desfaz a transação: nada é confirmado sem o marcador saber;
  - depois de conectar, falha de disco nunca vira recusa (código 1);
  - se o marcador registrou a falha: `FALHA`, código 2;
  - se não registrou: `FALHA_MARCADOR_DESATUALIZADO`, **código 5**, com `commit`, `erroMarcador` e o aviso de que a saída
    é o único registro do COMMIT.
- O marcador antigo continua no disco e impede a repetição. A retomada exige decisão de Felipe e renomear o marcador
  (nunca apagar).

### PITR como gate operacional

O `--backup` de produção exige `PITR <AAAA-MM-DDTHH:MMZ> <referência>`. Felipe confere no painel do Render que o ponto
de restauração cobre o instante da aplicação e anota o horário UTC dessa conferência.

- O aplicador recusa horário inválido, conferência com **mais de 120 min** ou mais de 5 min no futuro.
- O marcador guarda a referência e o gate. A referência textual sozinha **não** comprova PITR.
- O bloco de Shell recusa (código 4) o que não estiver nesse formato.

### Rollback

O aplicador nunca executa o down. O down 105 só vale **antes do piloto**, com autorização própria, e recusa se houver
concessão ou auditoria. Depois de uso real: `MCP_ENABLED=false` + deploy, tabelas preservadas. PITR só em último caso.

## Códigos

| Código | Significado |
|---|---|
| 0 | PLANO, PRONTA, JA_APLICADA, APLICADA_POSTCHECK_PASS |
| 1 | Recusa antes de conectar |
| 2 | FALHA registrada no marcador |
| 3 | Conferência que para |
| 4 | Recusa do bloco |
| 5 | FALHA com o marcador desatualizado |

## Ordem na janela do MCP

1. Promoção geral com o código **dormente**, já com o aplicador e os 5 SQL. Conferir os hashes.
2. `--conferir-105` → `PRONTA_PARA_APLICAR`.
3. Autorização de Felipe.
4. PITR conferido no painel.
5. Janela sem DDL concorrente.
6. `--conferir-105` de novo.
7. `--aplicar-105-autorizado --backup "PITR …"`.
8. `--conferir-105` → `JA_APLICADA_INTEGRIDADE_PASS`.
9. Deploy desligado → CONFERIR.

P3, P4 e ligar o canal para o piloto são passos separados.

Blocos: `node scripts/bloco-shell-105.cjs production <CONFERIR|APLICAR> <rotulo>`, regenerados na árvore final composta.

## Rodada 2 — revisão do Astra (rodada 1: REPROVADO, 2 P2 + 1 P3)

| Achado | Correção | Prova |
|---|---|---|
| **P2-1** Gatilhos internos de FK só contados como `D`; `O→R` passava; lado referenciado fora | Contador "fora do modo `O`" e 7 linhas `gatilhos_fk`, pelo `tgconstraint`, nos dois lados (função, `tgtype`, modo) | Mutantes offline: `O→R`, desabilitado em `empresas`, gatilho ausente, CASCADE. PG real: `ENABLE REPLICA TRIGGER` em `mcp_oauth_tokens` e `DISABLE TRIGGER` em `empresas` → DIVERGENTE com a integridade antiga PASS. Código: M29 |
| **P2-2** `public.gen_random_uuid()` aceita sem provar a implementação | Linha `uuid_publico`; DEFAULT qualificado só com o pgcrypto genuíno (`INCOERENTE` senão); conferência com a 105 ausente recusa um homônimo | PG real: pgcrypto genuíno → PRONTA (PGCRYPTO) e aplica. Homônimo (solto da extensão, UUID constante) → conferência `UUID_PUBLICO_HOMONIMO` e aplicação NAO_COMMITADA. Código: M26–M28 |
| **P3** PITR multilinha passava no `grep` do bloco (1 em vez de 4) | Bloco de produção exige linha única (`tr -d "\r\n"` igual ao valor); `tr` na lista de ferramentas | `bash`/`bash -i`: 4 casos (LF antes, LF depois, LF final, CR). PTY real: multilinha → 4. Código: M25. Staging byte a byte igual |

## Validação local (29/10/2026)

- `migration-105-production.test.cjs` **24/24**; `bloco-shell-105-production.test.cjs` **8/8** (bash e bash -i reais). Os números valem para a rodada 2 (casos novos dentro dos testes existentes).
- Staging preservado: `migration-105.test.cjs` e `bloco-shell-105.test.cjs` (10/10, só a asserção de ambientes ajustada).
  Os blocos de staging gerados antes e depois são idênticos byte a byte (CONFERIR c6541ea2…, APLICAR cde83d98…, rótulo
  18c976d4).
- PTY real (`C:\msys64\usr\bin\script.exe`, `/dev/ptyN`, bracketed paste ativo): **9/9** colagens do bloco de produção (rodada 2, com o PITR multilinha).
  Os códigos 1/4/5/3 e a guarda chegam legíveis, o shell do operador continua vivo e as opções, umask, diretório e
  variáveis ficam intactos. Roteiro e log em `ambientes-locais/aplicador-105-production-20261029/`.
- Mutantes de código em cópia isolada (scripts/ + database/ copiados, node_modules por junção): **29/29 derrubados** na rodada 2, controle 32/32. M11 (comparar sem parênteses) sobreviveu na 1ª execução e M20/M22 na 2ª; os testes novos os derrubam. Logs: `mutantes-rodada1.log`, `mutantes-rodada1b.log` e `mutantes.log`.
- CI local completo em LF (`ci-local.cjs`, todos os passos do `ci.yml`): **35/35** com código 0 na rodada 2, inclusive o `check:v1:static` (4029 + 103, build). `tsc --noEmit` e ESLint repetidos na árvore final (o teste PG mudou durante o CI): verdes.
- **PostgreSQL descartável** (autorização de Felipe, 29/10: "autorizo o PG descartável da 105"): PG 18.6, porta 55701,
  cluster novo, **removido ao fim**. `lib/integracoes/oauth/aplicador-105-production.postgres.test.ts` nos modelos
  b14-P11 (produção depois da promoção geral) e 103. **Três execuções PASS na rodada 1 e outras três na rodada 2** (nova autorização de Felipe no chat), com a suíte do aplicador de staging como
  vizinha. Cobriu:
  - superusuário e papel que não é o dono recusados;
  - sessão não superusuário com `SET SESSION AUTHORIZATION` + `SET ROLE` para o dono;
  - aplicação real na transação única e conferência com as definições;
  - tabelas com o dono da aplicação;
  - 6 mutantes reais (predicado, CHECK, FK CASCADE, corpo, RLS, RULE), DIVERGENTE e restaurados;
  - marcador e reaplicação sem DDL;
  - down;
  - `lock_timeout` real na FK → NAO_COMMITADA e retomada.
- Logs em `ambientes-locais/aplicador-105-production-20261029/pg-exec{1,2,3}.log` e em
  `pg-descartavel-105p-20261029-relatorios`.
