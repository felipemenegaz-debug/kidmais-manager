# Aplicador de staging da migration 098 — salão combinado (23/10/2026)

**Estado:** preparado localmente no clone `kidmais-manager-aplicador-098-20261023` (branch `codex/aplicador-098-staging-20261023`, base `origin/staging` `22d4ac30`, que já traz a PR #223). **Nunca executado contra staging nem produção**, só contra PostgreSQL descartável local. Sem commit, push ou PR.

Para executar é preciso:
1. revisão do Astra;
2. PR e deploy em staging de uma árvore com este aplicador;
3. backup registrado;
4. autorização específica de Felipe para a 098 em staging (`docs/OPERACAO_AGENTES.md`).

Desenho da 098, retrato e rollback: `docs/SALOES_COMBINADOS_098.md`.

## Arquivos

- `scripts/migration-098-comum.cjs`: núcleo. Une o padrão da 097 (corte, espera de transações anteriores, prova agregada) com o da 092–094 (dono dos objetos alterados, COMMIT `CONFIRMADO`/`DESFEITA_PELO_SERVIDOR`/`INDETERMINADO`, tentativas anteriores).
- `scripts/migration-098-staging.cjs`: trava de alvo. Fixa o serviço `srv-daif418ae00c73e8k2gg`, o host interno `dpg-daidko3m8hqs73ce4jt0-a`, o banco `kidmais_staging_1z91` e a porta 5432. URL sem query. TLS e identidade vêm de `scripts/conexao-staging.cjs`, e o registro fica no disco persistente.
- `scripts/bloco-shell-098.cjs`: gera os blocos RETRATO, CONFERIR e APLICAR para o Web Shell.
- Testes:
  - `scripts/migration-098.test.cjs`: 17 testes, cliente simulado, no CI;
  - `scripts/bloco-shell-098.test.cjs`: 10 testes, bash e `bash -i` em diretório temporário, no CI;
  - `lib/agenda/aplicador-098.postgres.test.ts`: aplicador REAL no PG descartável, modelo 097.
- Hashes fixados (SHA-256 do conteúdo LF):

| Etapa | Arquivo | SHA-256 |
|---|---|---|
| retrato | `database/checks/20261023_098_retrato.sql` | `34cc5ff6…c0ef1` |
| precheck | `database/checks/20261023_098_precheck.sql` | `5a0e8f56…e137a` |
| migration | `database/migrations/20261023_098_saloes_combinados.sql` | `0e66d023…931d1` |
| postcheck | `database/checks/20261023_098_postcheck.sql` | `46790b6e…9708` |
| integridade | `database/checks/20261023_098_integridade.sql` | `2de27c97…08eb` |

## Modos

```
node scripts/migration-098-staging.cjs                                                 # PLANO: não conecta
node scripts/migration-098-staging.cjs --retrato-098                                   # só leitura: identidade + retrato
node scripts/migration-098-staging.cjs --conferir-098                                  # só leitura: estado, privilégios, retrato, precheck ou integridade
node scripts/migration-098-staging.cjs --aplicar-098-autorizado --backup "<registro>"  # uma vez (marcador exclusivo)
```

- **Retrato:** roda a MESMA expressão de `20261023_098_retrato.sql`, extraída entre os marcadores do arquivo revisado, em READ ONLY e com `search_path = pg_catalog`. Devolve:
  - o SHA-256 do texto inteiro, comparado com `RETRATO_094` e `RETRATO_098` (os mesmos de `scripts/migration-098-retrato.mjs` e dos blocos do precheck, do postcheck e da integridade);
  - o total de linhas;
  - por tipo de linha (T/C/K/I/G/GI/R/P/F/S/Y/X), a contagem e os 12 primeiros hex do md5.

  Com divergência, lista **quais tipos** diferem de cada estado esperado. O texto do retrato não sai. Uma linha lógica vai até o próximo prefixo de tipo: o CHECK com CASE da 098 tem quebras de linha. Os resumos por tipo foram tirados dos modelos 097 e 098 do PG descartável e são conferidos pela suíte PG.
- **Estado:**
  - dependências 093/094: as tabelas `agenda_saloes`, `contratos`, `fechamentos` e `fechamento_revisoes`, `kidmais094_ocupacoes` e os três corpos substituídos;
  - os 22 objetos da 098: 2 colunas e o CHECK, 10 funções, 6 gatilhos e os 3 corpos trocados, por `strpos` no `prosrc`;
  - `pode_criar` (CREATE em public);
  - `dono_098`: `pg_has_role(current_user, dono, 'USAGE')` de `agenda_saloes`, `contratos` e das três funções;
  - `papel_trocado`.

  O resultado é ausente, completa ou parcial. Parcial lista os objetos ausentes.
- **Plano:**
  - parcial → recusa;
  - ausente → exige retrato `094`, CREATE e dono; plano: precheck → migration → postcheck → integridade;
  - completa → exige retrato `098`; plano: **só a integridade**. O postcheck é da instalação e recusa combinados legítimos criados depois.
- **Aplicação:**
  1. identidade, estado e retrato `094`;
  2. corte do relógio e espera de transações de cliente abertas antes do corte (até 30 s; sem isso, recusa antes de escrever);
  3. contagens;
  4. precheck (READ ONLY);
  5. migration: transação do próprio arquivo, `lock_timeout` 5 s, `statement_timeout` 60 s;
  6. `commit = CONFIRMADO` gravado no marcador **antes** de qualquer leitura;
  7. estado completo;
  8. postcheck e integridade (READ ONLY);
  9. retrato `098`;
  10. prova de preservação. Os salões criados até o corte têm a mesma contagem e o mesmo md5 de `id|empresa_id|estabelecimento_id|criado_em`, e nenhum virou combinado.

  Falha na migration: SQLSTATE comum = `DESFEITA_PELO_SERVIDOR`; classes 08/57/58/XX, 40003 (`statement_completion_unknown`) ou sem código = `INDETERMINADO`, a reconciliar com `--conferir-098`.
- **Códigos:**

| Código | Significado |
|---|---|
| 0 | `PLANO`, `RETRATO_094`/`RETRATO_098`, `PRONTA_PARA_APLICAR`, `JA_APLICADA_INTEGRIDADE_PASS`, `APLICADA_POSTCHECK_PASS` |
| 1 | recusa lançada **antes de criar o marcador** desta execução (trava, argumentos, backup, arquivo, tentativa anterior, disco). Depois do marcador, nenhum erro escapa: vira 2 (P2-1 da revisão de 24/10). Mesmo com 1, ler o registro listado pelo bloco e rodar CONFERIR antes de decidir; nunca renomear o marcador só pelo código |
| 2 | `FALHA` de execução iniciada. Com `registroGravado: false` (disco falhou), o marcador pode estar numa etapa anterior e o estado do banco é desconhecido até CONFERIR (`estadoBanco: DESCONHECIDO_CONFERIR`) |
| 3 | `RECUSARIA` (inclusive `SESSOES_NAO_CLASSIFICAVEIS`) ou `RETRATO_DIVERGENTE` |
| 4 | só no bloco: recusa do próprio bloco (destino, ferramenta, arquivo divergente, backup não informado) |

- **Nunca executa:** o down 098, env, deploy, restart ou atualização de linhas existentes. A saída tem só nomes de etapa, booleanos, contagens, hashes e resumos (sem ids, nomes ou URL).

## Sequência operacional proposta (nada disto foi executado)

| # | Passo | Escrita? |
|---|---|---|
| 0 | PR deste aplicador para staging, CI verde, merge e deploy (autorizações próprias); anotar o commit implantado | código |
| 1 | Gerar os blocos da árvore implantada: `node scripts/bloco-shell-098.cjs staging <MODO> <commit>`; conferir sha256 e bytes | não |
| 2 | **RETRATO** no Web Shell. Esperado: `RETRATO_094`, `CODIGO_SAIDA_BLOCO=0`. Com `RETRATO_DIVERGENTE`, parar e investigar pelos `tiposDivergentes` | não |
| 3 | **CONFERIR**. Esperado: `PRONTA_PARA_APLICAR`, `precheck 098: PASS`, `CODIGO_SAIDA_BLOCO=0` | não |
| 4 | **Backup** (Felipe, no painel do Render): export do banco de staging e janela PITR, com id e horário UTC. Vai para `KIDMAIS_REGISTRO_BACKUP` | export |
| 5 | Autorização de Felipe para aplicar a 098 em staging; janela sem cadastro de salões/festas nem DDL concorrente | — |
| 6 | **CONFERIR** de novo, imediatamente antes | não |
| 7 | `export KIDMAIS_REGISTRO_BACKUP="..."` e **APLICAR**. Esperado: `APLICADA_POSTCHECK_PASS`, `commit: CONFIRMADO`, `CODIGO_SAIDA_BLOCO=0` | DDL |
| 8 | **CONFERIR** depois. Esperado: `JA_APLICADA_INTEGRIDADE_PASS` (integridade) | não |
| 9 | **RETRATO** depois. Esperado: `RETRATO_098` | não |

Paradas:
- qualquer código diferente de 0, ou ausência da linha `CODIGO_SAIDA_BLOCO`: parar, copiar a saída e o marcador, e não repetir;
- retomada só com decisão de Felipe: renomear o marcador (nunca apagar) para `migration-098.<horario>.json`. O novo registro lista as tentativas anteriores;
- rollback: `database/rollback/20261023_098_saloes_combinados_down.sql`. Fica **fora** do aplicador e exige pacote e autorização próprios. É recusado se existir qualquer combinado.

Blocos gerados localmente da árvore `22d4ac3` + este diff (só para revisão; regenerar do commit implantado). Ficam em `ambientes-locais/blocos-098-staging-local/`, com `SHA256SUMS`:

| Bloco | SHA-256 | Tamanho |
|---|---|---|
| RETRATO | `fb951852…f5cb0` | 2708 bytes |
| CONFERIR | `bcf27149…16e2f` | 2735 bytes |
| APLICAR | `4a5724f2…36c0c` | 3178 bytes |

O hash de cada bloco muda se mudar o aplicador, o núcleo ou o rótulo.

## Validação local (23/10/2026)

- `scripts/migration-098.test.cjs` 17/17 (inclui falha de disco depois do COMMIT, sessão não classificável e 40003); `scripts/bloco-shell-098.test.cjs` 10/10.
- PG descartável (cluster próprio na porta 55603, encerrado e removido ao final; relatórios preservados em `ambientes-locais/pg-descartavel-aplicador-098-20261023-relatorios`), `lib/agenda/aplicador-098.postgres.test.ts` OK em 2 rodadas depois das correções de 24/10 (~100–120 s):
  1. retrato `RETRATO_094`, com os tipos iguais aos esperados; conferência PRONTA;
  2. papéis: sem CREATE/dono recusa; dono herdado via SET ROLE fica PRONTA; membro sem herança recusa;
  3. função 098 criada à mão é tratada como parcial; índice extra dá retrato DIVERGENTE só no tipo I;
  3c. transação de outra sessão aberta antes do corte: espera e recusa antes de escrever (`TRANSACOES_ANTERIORES_AO_CORTE`);
  3d. aplicador com login NÃO superusuário (membro do administrador) e transação antiga de um terceiro papel que ele não enxerga: CONFERIR `RECUSARIA` e APLICAR `FALHA` com `SESSOES_NAO_CLASSIFICAVEIS 1`, sem escrita. Com a consulta anterior (filtro `backend_type = 'client backend'`), este caso dava PRONTA: no PG 18 a sessão invisível também tem `backend_type` nulo. A consulta da 097 tem o mesmo ponto cego (lá a contagem era só informativa);
  4. erro real (contratos presos em SHARE depois do precheck, `lock_timeout` no CREATE TRIGGER) dá `DESFEITA_PELO_SERVIDOR`, sem nada aplicado;
  5. backend do aplicador derrubado enquanto espera o lock dá `INDETERMINADO`, e a conferência mostra 098 ausente;
  6. retomada com os marcadores renomeados dá APLICADA: retrato 094 → 098, COMMIT CONFIRMADO, preservação ok;
  7. retrato 098 com os tipos esperados; combinado legítimo: o postcheck recusaria, a conferência fica JA_APLICADA pela integridade, e uma nova aplicação só confere;
  8. gatilho da 098 desligado dá retrato DIVERGENTE no tipo G e RECUSARIA; religado, passa.
- Na mesma rodada: `saloes-combinados-098`, `saloes-caminhos-098` e `aplicador-092-094` OK.
- `npm run check:v1:static` PASS (3530/3530; 103/103). Passos do CI local: `npm ci` + os 23 passos do workflow com exit 0 (inclui os 2 novos).

## Riscos e limites

- Espera do corte (P2-2 da revisão de 24/10): roda com o papel do login (`SET LOCAL ROLE NONE`, só na transação READ ONLY), o mesmo das conexões da aplicação. Sessão não classificável (`<insufficient privilege>` ou estado nulo) **impede** a aplicação, como transação anterior ao corte. A CONFERIR já devolve `sessoes: {anteriores, invisiveis}` e RECUSARIA com `SESSOES_NAO_CLASSIFICAVEIS`. Se isso aparecer no staging, nenhum privilégio é concedido automaticamente: é decisão de Felipe.
- A prova de preservação cobre só identidade, empresa, unidade e criação dos salões até o corte, e a ausência de combinado entre eles. Não prova nome, capacidade, ordem, ativo nem as demais tabelas.
- A queda de conexão testada em PG acontece esperando lock, antes do COMMIT; perda de resposta depois de o servidor confirmar não é reproduzida (cai em `INDETERMINADO` pela classificação). Os testes de colagem usam `bash -i` com stdin, não um novo ensaio PTY do Web Shell.
- Uma escrita em `agenda_saloes` entre o COMMIT e o postcheck (combinado criado no meio) faria o postcheck falhar com `commit: CONFIRMADO`. Por isso a janela não tem cadastro de salões.
- O retrato acopla a aplicação ao inventário até a 097 (decisão de Felipe). Uma deriva real de staging faz o RETRATO e o precheck recusarem; o diagnóstico começa pelos `tiposDivergentes`.

## Revisão do Astra de 24/10/2026: REPROVADO (2 P2 + 1 P3) → corrigido LOCAL

- **P2-1 (código 1 depois do COMMIT):** a partir da criação do marcador nenhum erro escapa de `executar`. Uma falha de gravação do registro interrompe a execução e vira `FALHA` (código 2) com o último estado em memória (`commit`). Se a gravação da FALHA também falhar, a saída traz `registroGravado: false` e `estadoBanco: DESCONHECIDO_CONFERIR`. O código 1 fica só para recusas lançadas antes do marcador. Plano, blocos e esta doc dizem: com qualquer código ≠ 0, inclusive 1, ler o registro e rodar CONFERIR; nunca renomear o marcador só pelo código. Teste: disco falhando a partir da gravação do COMMIT CONFIRMADO, com e sem segunda falha.
- **P2-2 (sessões invisíveis):** sessão não classificável impede a aplicação (antes de escrever) e faz a CONFERIR responder `RECUSARIA`. A leitura usa o papel do login (`SET LOCAL ROLE NONE` só na transação READ ONLY). A consulta conta as invisíveis por `backend_type IS NULL` e `<insufficient privilege>` no banco atual (ver o caso 3d). Nenhum privilégio é concedido.
- **P3 (40003):** `statement_completion_unknown` é classificado como `INDETERMINADO`; há um teste.
