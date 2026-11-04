# Aplicador da 116 em staging (franquias de IA por plano, F1)

Estado: LOCAL, sem commit. Preparado em 04/11/2026 a pedido de Felipe ("Sim, aplicador 116"), depois da F1 (#319, `37452d09`) LIVE no web de staging sem a 116. A aplicação da 116 em qualquer banco real é passo SEPARADO, com autorização própria, ponto PITR registrado e janela. Production fica para o plano de promoção, com adaptador e autorização próprios.

Plano de origem: `Kidmais-Manager-Second-Brain/02 - Kidmais Manager SaaS/07 - Roadmap/Plano franquias de IA por plano 20261102.md` (F1 r3 APROVADA pelo Astra em 04/11).

## O que entra

| Arquivo | Papel |
|---|---|
| `scripts/migration-116-comum.cjs` | Núcleo (estado pelos 5 objetos, guardas, plano, transação com preservação e postcheck antes do COMMIT, marcador). |
| `scripts/migration-116-staging.cjs` | Trava de alvo de staging (web `srv-daif418ae00c73e8k2gg`, banco `kidmais_staging_1z91`), identidade/TLS/disco de `conexao-staging.cjs`. Registro em `data/creditos-franquias-116-staging`. |
| `scripts/bloco-shell-116.cjs` | Gera os blocos CONFERIR e APLICAR do Web Shell (confere o sha256 dos arquivos implantados e roda o aplicador). |
| `scripts/migration-116.test.cjs`, `scripts/bloco-shell-116.test.cjs` | Cliente simulado e colagem real em bash/bash -i (dois passos novos no `ci.yml`). |
| `lib/creditos/aplicador-116.postgres.test.ts` | Prova real no PG descartável, modelo 112 (staging de hoje sem a 116), registrada em `scripts/regressao-v1-selecao.cjs`. |

Hashes fixados (CRLF normalizado):

| Etapa | Arquivo | sha256 |
|---|---|---|
| precheck 116 | `database/checks/20261103_116_precheck.sql` | `273a03b6d9bdb823b01a72da38403460f62bb4cccc87150af8f34d53e62f4e72` |
| migration 116 | `database/migrations/20261103_116_franquias_ciclo.sql` | `d2fed662fd08ec1fb8ede390f75d12f10823f76512b1b0ff8bd749c86eafd7c2` |
| postcheck 116 | `database/checks/20261103_116_postcheck.sql` | `1e1e01b2d415c746da6b46e6a26209cfdb3ac07e2bd9e81ba6acfe1fb2d86822` |

Qualquer mudança num desses arquivos exige atualizar o hash no núcleo; o gerador de blocos e os testes recusam a árvore divergente.

## Desenho

O desenho é o mesmo do aplicador da 112.

**Estado pelos 5 objetos:**
- as 2 tabelas (`ia_credito_franquias_ciclo`, `ia_credito_franquia_pendencias`);
- a função `kidmais_116_somente_insercao()`;
- o gatilho `ia_credito_franquias_ciclo_116_somente_insercao`;
- o CHECK `ia_credito_notificacoes_tipo_check` com `FRANQUIA_80` e `FRANQUIA_100`.

Leitura do estado:
- nenhum objeto = ausente → precheck, migration, postcheck;
- os 5 = presente → só o postcheck decide;
- qualquer outro número = PARCIAL, recusado com os grupos que faltam (por exemplo `gatilhos 0/1`).

**Guardas antes de qualquer escrita** (catálogo, avaliado como `current_user`, porque no Render a credencial entra com `SET role`). Há três conjuntos:
- **Sempre:**
  - as 4 tabelas existentes;
  - USAGE em public;
  - SELECT em `ia_credito_lotes`, `ia_credito_notificacoes` e `assinatura_contratacoes` (contagens e postcheck).
- **Com a 116 ausente:**
  - DONO de `ia_credito_notificacoes` (troca do CHECK);
  - REFERENCES em `ia_credito_carteiras`, `ia_credito_lotes` e `assinatura_contratacoes` (FKs novas);
  - SELECT em `ia_credito_carteiras`;
  - CREATE em public;
  - USAGE em plpgsql.
- **Com a 116 presente** (P3-1 do Astra, 04/11): o postcheck (bloco `DO`) e as contagens das tabelas novas exigem SELECT em `ia_credito_franquias_ciclo` e `ia_credito_franquia_pendencias` e USAGE em plpgsql. Falta = `SEM_PRIVILEGIO_116_PRESENTE` com o nome, antes de ler dados.

**Achado do PG real:** criar uma FK exige também SELECT na tabela referenciada, não só REFERENCES. Na rodada 1 do teste PG, o papel só com REFERENCES em carteiras falhou na migration com `permission denied for table ia_credito_carteiras`. O aplicador classificou corretamente como NAO_COMMITADA, sem nada criado. A guarda `SELECT_CARTEIRAS` passou a recusar antes de conectar a escrita.

**Sem corte de consumidores:**
- O código da F1 (`37452d09`) convive com e sem a 116.
- O cron de staging (`crn-db493i142hec73ahmoe0`, ainda em `2352f493`) não lê as tabelas novas. O CHECK de tipos só é ampliado.
- A flag `CREDITOS_FRANQUIA_PLANO_ATIVO` continua desligada.
- Limitação declarada da F1: depois da 116, os modos do B-14 diferentes de `--fila` ficam indisponíveis.

**Transação única:**
1. o precheck em READ ONLY;
2. a migration sem o COMMIT final. O arquivo:
   - trava `ia_credito_notificacoes` em ACCESS EXCLUSIVE;
   - trava as 3 tabelas referenciadas em SHARE ROW EXCLUSIVE;
   - define `lock_timeout` 5 s e `statement_timeout` 60 s com SET LOCAL.
3. a **prova de preservação**: nenhuma linha das 4 tabelas existentes com `xmin` igual ao xid desta transação;
4. o corpo do postcheck. Ele exige `ia_credito_franquias_ciclo` vazia, coerente com a flag desligada;
5. só então o COMMIT;
6. o estado e o postcheck de novo, em READ ONLY.

**Situação do COMMIT:** NAO_COMMITADA, CONFIRMADO, DESFEITA_PELO_SERVIDOR ou INDETERMINADO (40003, classes 08/57/58/XX ou sem resposta). Fica registrada no marcador exclusivo `data/creditos-franquias-116-staging/migration-116.json`, criado com `wx` antes de conectar.

**Saída:** só etapas, booleanos, versão do servidor e contagens:
- lotes por origem;
- notificações por tipo;
- linhas das tabelas novas.

Nunca ids nem a URL.

**Nunca executa:** o down, env, deploy, restart, ligar a flag, nem escrita nas 4 tabelas existentes.

**Consequência de desenho:** a conferência só passa com `ia_credito_franquias_ciclo` vazia. Depois que a flag for ligada (passo futuro), este aplicador responde RECUSARIA de propósito. Ele serve para a aplicação, não para auditoria contínua.

## Ordem da janela (staging)

1. Conferir no Render o commit do web (F1 `37452d09` ou posterior com este aplicador) e os hashes implantados. Este aplicador precisa estar publicado no web antes: commit, PR e deploy próprios, com autorização.
2. Gerar os blocos da árvore publicada e conferir sha256 e bytes:
   - `node scripts/bloco-shell-116.cjs CONFERIR <commit>`
   - `node scripts/bloco-shell-116.cjs APLICAR <commit>`
3. Bloco CONFERIR. Esperado: `PRONTA_PARA_APLICAR` e `objetos: 0`. Se recusar privilégio (DONO, REFERENCES ou SELECT), parar: a correção de grants é decisão separada.
4. Ponto PITR do PostgreSQL de staging comprovado e registrado (referência e horário, anterior à aplicação).
5. Autorização de Felipe para a 116 em staging.
6. Janela curta, fora do minuto do cron de reconciliação (a cada 5 min):
   - bloco CONFERIR de novo;
   - bloco APLICAR (`export KIDMAIS_REGISTRO_BACKUP="<referência e horário do PITR>"` antes de colar);
   - bloco CONFERIR.
   - Esperado no fim: `JA_APLICADA_POSTCHECK_PASS`, com `novas.franquias_ciclo = 0`. `novas.pendencias` pode ser maior que 0: a F1 registra pendência legítima pela sincronização logo depois do COMMIT, e o postcheck só aceita as legítimas (P3-2 do Astra). Pendência não é parada; `franquias_ciclo > 0` ou RECUSARIA, sim.
7. Conferência funcional logada: Assinatura → Créditos de IA igual (caminho legado, flag desligada).

**Risco declarado — ordem de travas:** a migration trava primeiro as tabelas das FKs e depois `ia_credito_notificacoes`. Uma transação da aplicação que segure as travas na ordem inversa pode gerar deadlock (40P01). O PostgreSQL aborta um dos lados. Se for o nosso, o erro vem antes do COMMIT, a situação é NAO_COMMITADA e nada é criado (coberto no simulado). Mitigação: janela curta, fora do minuto do cron. Se acontecer: parar, não repetir sem decisão de Felipe.

**Paradas:** qualquer código ≠ 0 → parar, copiar a saída e o marcador, não repetir.

**COMMIT INDETERMINADO:** reconciliar pelo CONFERIR. Retomada só com decisão de Felipe, renomeando o marcador (nunca apagando) para `migration-116.<horario>.json`.

**Recuperação:**
- O down (`database/rollback/20261103_116_franquias_ciclo_down.sql`), só com autorização própria. O down recusa se já existir franquia reconhecida ou aviso `FRANQUIA_80`/`FRANQUIA_100`.
- Depois do primeiro reconhecimento: só correção para frente.
- Em último caso: PITR ao ponto registrado.

## Provas locais (04/11/2026)

**Cliente simulado (`migration-116.test.cjs`): 14/14.** Cobre:
- hashes e molduras;
- os 5 objetos casados com a migration, o postcheck e o down;
- as tabelas preservadas iguais à tabela do CHECK mais as referenciadas pelas FKs;
- estado só de catálogo;
- cada privilégio recusado pelo nome;
- situações do COMMIT, incluindo 40P01 no corpo → NAO_COMMITADA;
- trava de alvo;
- conferência sem escrita;
- ordem preservação → postcheck → COMMIT;
- preservação divergente para cada tabela;
- retomada;
- SQL divergente;
- o plano.

**Blocos (`bloco-shell-116.test.cjs`): 11/11**, com bash e bash -i reais. O bloco CONFERIR da árvore `37452d09` tem 2780 bytes.

**PG descartável (cluster 55743, modelo 112): `aplicador-116` 1/1.** Usa carteira, lote CORTESIA, notificação `LOTE_VENCENDO_30` e contratação CONFIRMADA reais. Relatório `ambientes-locais/pg-descartavel-aplicador-116-relatorios/2026-11-04T05-14-23-447Z-check-v1-postgres.log`. Casos:
1. Conferência PRONTA sem mudança.
2. Função criada à mão → `APLICACAO_PARCIAL_116 tabelas 0/2, gatilhos 0/1, tipos 0/1`, nada escrito.
3. Papel mínimo não superusuário, cada falta recusada pelo nome, na ordem: SELECT_CONTRATACOES → DONO_NOTIFICACOES/REFERENCES/SELECT_CARTEIRAS → … → PRONTA → CREATE revogado → recusa. Com o mínimo, aplica; linhas existentes com o mesmo `xmin`.
4. Código da F1 sobre a 116:
   - `registrarPendenciaFranquia` grava e o postcheck aceita a pendência legítima;
   - `JA_APLICADA` como dono e como admin;
   - o marcador impede a repetição;
   - deriva: gatilho desabilitado → postcheck recusa; gatilho removido → `APLICACAO_PARCIAL_116 gatilhos 0/1`;
   - down pelo dono.
5. Controle positivo da prova de preservação para cada uma das 4 tabelas.
6. Falha real de lock (outra sessão em ROW EXCLUSIVE em `ia_credito_lotes`): NAO_COMMITADA depois do `lock_timeout`; marcador renomeado → retomada aplica → down.

**Rodada 1 do PG (FAIL):** expôs o achado SELECT na tabela referenciada (acima). Corrigido no núcleo e nos testes; rodada 2 PASS.

## Mutantes

Script `ambientes-locais/mutacoes-aplicador-116-20261104.cjs`, cópia isolada `kidmais-manager-aplicador-116-mutacao-20261104` (só os arquivos do aplicador, `node_modules` por junção). Controle verde antes dos mutantes.

Resultado: **34/34 mortos** (relatório `ambientes-locais/mutacoes-aplicador-116-20261104-relatorios/2026-11-04T05-32-41-255Z-mutantes.json`). A cópia foi conferida byte a byte com o clone depois da bateria.

- **29 no núcleo:**
  - parcial aceito;
  - cada privilégio ignorado: DONO, os 3 REFERENCES, SELECT em carteiras, lotes e contratações, CREATE, plpgsql;
  - preservação removida, ou sem contratações;
  - postcheck fora da transação ou com moldura;
  - 40003 como desfeita;
  - reaplicar a presente;
  - COMMIT respondido como ROLLBACK;
  - marcador sobrescrito;
  - releituras finais ignoradas;
  - conferência sem precheck ou gravando arquivo;
  - 4 objetos aceitos como presente;
  - CHECK de tipos sem `FRANQUIA_100`;
  - limite de grupo;
  - hash depois do marcador;
  - fase do COMMIT perdida;
  - tabela de contratações não exigida;
  - backup livre no `executar`.
- **5 no gerador de blocos:** sem guarda de serviço, backup multilinha, modo TypeScript, SQL não conferidos, registro errado.
- **Cada morte conferida pelo motivo.** O A28 da rodada 1 gravava no diretório do Render, inexistente no Windows, e morria por ENOENT, não pela asserção. Ele foi refeito como A28b, gravando de fato no tmp, e morreu por "a conferência não grava arquivos". O runner já usa a forma A28b.
- **Mutante natural:** a rodada 1 do PG (papel só com REFERENCES) mostrou que a guarda de SELECT na referenciada era necessária. O A6 prova que o simulado agora a cobra.

## CI local

CI local completo (todos os passos do `ci.yml`, incluindo os dois desta entrega): **56/56 com saída 0** (rodada 2). A rodada 1 tinha 55/56: o tsc recusou `venceEm` como string ISO no teste PG (o tipo é número em ms; em execução `new Date(string)` aceitava). Corrigido; PG r3 (`aplicador-116` + `franquias-116`) 2/2, relatório `ambientes-locais/pg-descartavel-aplicador-116-relatorios/2026-11-04T05-56-18-116Z-check-v1-postgres.log`. ESLint só com 3 avisos antigos fora desta entrega; `git diff --check` limpo. Cluster 55743 encerrado.

## Rodada 2 — ressalvas do Astra (04/11/2026)

O Astra APROVOU COM RESSALVAS a rodada 1: 0 P1, 0 P2, 2 P3, sem bloqueador.

**P3-1 — guardas da 116 presente.**
- O postcheck é um bloco `DO`, e as contagens leem as 2 tabelas novas. Faltavam guardas para SELECT nessas tabelas e para USAGE em plpgsql.
- Antes, a falta só aparecia na execução, sem falso PASS.
- Agora `exigirCatalogo` recusa com `SEM_PRIVILEGIO_116_PRESENTE SELECT_FRANQUIAS_CICLO / SELECT_PENDENCIAS / LINGUAGEM`, antes de ler dados. Dois booleanos novos no estado: `ler_franquias_ciclo` e `ler_pendencias`.
- Com a 116 ausente, essas guardas não valem: as tabelas ainda não existem.
- Testes:
  - simulado: os 3 casos isolados, os 3 juntos, e ausente sem SELECT nas novas = plano completo;
  - PG: com a 116 presente e o papel mínimo, SELECT em cada tabela nova e plpgsql (de PUBLIC) revogados um a um → RECUSARIA na conferência e FALHA sem commit na aplicação, pelo nome; restaurado → JA_APLICADA.

**P3-2 — resultado esperado.** A ordem da janela agora espera `franquias_ciclo = 0` e aceita pendências legítimas, como o postcheck.

**Provas da rodada 2:**
- simulado 14/14 (com os casos novos);
- blocos 11/11;
- PG r4 2/2 (`aplicador-116` + `franquias-116`), relatório `ambientes-locais/pg-descartavel-aplicador-116-relatorios/2026-11-04T07-19-05-945Z-check-v1-postgres.log`;
- mutantes **38/38**, com 4 novos:
  - A30–A32: cada guarda presente ignorada;
  - A33: guarda presente só na ausente.
  - A âncora do A8 passou a aparecer duas vezes (bateria `2026-11-04T08-02-02-466Z`: 37 mortos + `TRECHO_NAO_UNICO`). Foi fixada na guarda da ausente, e o A8 rodado sozinho morreu.
- CI local completo r3 **56/56** (`ambientes-locais/ci-aplicador-116-20261104-r3/ci-local-resumo.json`); `git diff --check` limpo.
