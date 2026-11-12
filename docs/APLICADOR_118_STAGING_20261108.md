# Aplicador da 118 em staging (cota de leitura da importação, L2)

Estado: LOCAL, sem commit. Preparado em 08/11/2026 a pedido de Felipe ("Sim, começar"), depois da L2 (#354, `9691392c`) LIVE no web de staging. A aplicação da 118 em qualquer banco real é passo SEPARADO, com autorização própria, ponto PITR registrado e janela. Production fica para a promoção, com adaptador e autorização próprios.

Plano de origem: `Kidmais-Manager-Second-Brain/02 - Kidmais Manager SaaS/07 - Roadmap/Plano importacao contratos em lote 20261031.md` (L2 r4 APROVADA pelo Astra em 08/11; o parecer exigiu o ensaio no esquema pré-118 do alvo, com 116 e 117).

## Por que importa agora

O código da L2 está LIVE no web de staging. Sem a 118, a leitura de documento na importação responde `503 COTA_INDISPONIVEL` antes de qualquer trabalho caro, a menos que `IMPORTACAO_COTA_DISPENSADA` esteja configurada com o id do próprio web de staging. Se a 118 está aplicada no banco de staging e se a dispensa está configurada não foi conferido (exige banco ou env, com autorização). A conferência deste aplicador (`--conferir-118`, só leitura) responde a primeira pergunta e informa a segunda sem mostrar o valor.

## O que entra

| Arquivo | Papel |
|---|---|
| `scripts/migration-118-comum.cjs` | Núcleo: estado pelos 7 objetos, guardas, plano, transação com preservação, índices e postcheck antes do COMMIT, marcador. |
| `scripts/migration-118-staging.cjs` | Trava de alvo de staging (web `srv-daif418ae00c73e8k2gg`, banco `kidmais_staging_1z91`), identidade/TLS/disco de `conexao-staging.cjs`. Registro em `data/importacao-cotas-118-staging`. |
| `scripts/bloco-shell-118.cjs` | Gera os blocos CONFERIR e APLICAR do Web Shell (confere o sha256 dos arquivos implantados e roda o aplicador). |
| `scripts/migration-118.test.cjs`, `scripts/bloco-shell-118.test.cjs` | Cliente simulado e colagem real em bash/bash -i (dois passos novos no `ci.yml`). |
| `lib/importacao-contrato/aplicador-118.postgres.test.ts` | Ensaio real no PG descartável, modelo **117** novo: inventário até a 117 sem a 098 (112, 114, 116 e 117 presentes, 118 ausente), o esquema do staging antes da 118. Registrado em `scripts/regressao-v1-selecao.cjs`; o modelo em `scripts/regressao-v1-postgres-receita.cjs`. |

Hashes fixados (CRLF normalizado):

| Etapa | Arquivo | sha256 |
|---|---|---|
| precheck 118 | `database/checks/20261104_118_precheck.sql` | `76bbf46d76c88d02c61c9ba9604dd609bab6448c50e816050227dbac0881758c` |
| migration 118 | `database/migrations/20261104_118_importacao_cotas.sql` | `a2414dec0d9e78aa3d9eab5bec90c88b52874c01311c75fbb12c76dd4dd48033` |
| postcheck 118 | `database/checks/20261104_118_postcheck.sql` | `e71a94c9ff8b848e729b2c89e7495395c0af9b07faca9dbd365dbfc2dad204bc` |

## Desenho

Mesmo desenho dos aplicadores da 116 e da 117.

**Estado pelos 7 objetos** (tabelas `ia_importacao_cotas` e `ia_importacao_usos`; índices `ia_importacao_usos_vivo_uk` e `ia_importacao_usos_periodo_idx`; funções `kidmais_118_janela_migracao(timestamptz,timestamptz)`, `kidmais_118_periodo_mensal(timestamptz)` e `kidmais_118_guarda()`):
- nenhum = ausente → precheck, migration, postcheck;
- os 7 = presente → só o postcheck decide (as tabelas podem ter linhas: o código publicado reserva assim que elas existem);
- qualquer outro número = PARCIAL, recusado com os grupos (ex.: `funcoes 1/3`).

**Travas.** A 118 só cria objetos. As FKs novas pegam SHARE ROW EXCLUSIVE em `empresas` e em `ia_documentos`: uploads de documento e escritas em empresas esperam a transação (lock_timeout 5 s e statement_timeout 60 s do próprio SQL).

**Aplicação:** precheck (READ ONLY) → migration sem o COMMIT final → na mesma transação: preservação (nenhuma linha de `empresas` nem de `ia_documentos` com o xid da transação), índices válidos/prontos/ativos e o postcheck → COMMIT → postcheck de novo (READ ONLY). Situação do COMMIT: `NAO_COMMITADA`, `CONFIRMADO`, `DESFEITA_PELO_SERVIDOR` (SQLSTATE de resposta fora de 08/57/58/XX e diferente de 40003) ou `INDETERMINADO` (reconciliar com a conferência).

**Privilégios** (como `current_user`; no Render a credencial entra com `SET role`):
- sempre: USAGE em public (conferido antes de qualquer `to_regclass`), SELECT em `empresas` e em `ia_documentos`;
- 118 ausente: REFERENCES em `empresas` e em `ia_documentos`, CREATE em public, USAGE em plpgsql e em sql, PostgreSQL 13 ou mais novo (`gen_random_uuid()`);
- 118 presente: SELECT nas 2 tabelas novas e USAGE em plpgsql.

**Dispensa `IMPORTACAO_COTA_DISPENSADA`:** só informada (`AUSENTE`, `ESTE_SERVICO` ou `OUTRO_VALOR`, nunca o valor), na conferência e no marcador. Não muda o plano nem o resultado. Com a 118 presente ela fica inerte (`lib/inteligencia/flags.ts`); removê-la do env é decisão à parte.

**Conexão (r2, parecer r1 do Astra, P1):**
- O cliente `pg` recebe só os valores já validados: host, porta 5432, banco, usuário e senha da URL, e TLS explícito (`ssl: false` sem TLS). Não recebe `connectionString`.
- Por isso PGPORT, PGHOST, PGDATABASE, PGUSER, PGPASSWORD e PGSSLMODE do ambiente não entram.
- A URL precisa ser `postgres:` ou `postgresql:`, com usuário e senha. `?` e `#` são recusados mesmo vazios (r3).
- Usuário e senha com caractere de controle depois da decodificação (NUL, C0 ou DEL) recusam com `CREDENCIAL_COM_CONTROLE`, antes de instanciar o cliente (r3). O pacote de inicialização separa chave e valor por NUL; um usuário com `%00options%00-c ...` injetaria opções de sessão.
- PGOPTIONS, PGREPLICATION, PGBINARY, PGSSLNEGOTIATION e PGCLIENT_ENCODING (o nome que o `pg` lê; PGCLIENTENCODING, do libpq, fica por precaução) presentes no ambiente recusam (`AMBIENTE_PG_RECUSADO`), porque a configuração explícita não consegue anulá-las.
- O teste extrai do fonte do `pg` instalado toda variável lida em `connection-parameters.js`. Cada uma precisa estar anulada (exercitada com valor hostil) ou na lista de recusa.

**Nunca executa:** o down, alteração de env, deploy, restart, a dispensa, escrita em `empresas` ou em `ia_documentos`.

## Rollback

- Sem nenhuma leitura contada: `database/rollback/20261104_118_importacao_cotas_down.sql`, com autorização própria. Ele recusa com qualquer linha de cota.
- Depois do primeiro uso: desligar o grupo `CONTRACT_IMPORT` (o histórico é preservado; a guarda da 118 impede apagar linhas). Nunca dispensar a cota.
- Em último caso, PITR ao ponto registrado.

## Ordem em staging (cada passo com autorização própria)

1. Publicar o código deste aplicador no web de staging (PR, CI e deploy — nenhum deles feito).
2. Conferir no Render o commit do web e os hashes implantados.
3. Bloco CONFERIR (`node scripts/bloco-shell-118.cjs CONFERIR <commit>`): só leitura. Dois resultados saem com código 0 e levam a caminhos diferentes:
   - `PRONTA_PARA_APLICAR` (118 ausente, privilégios suficientes): é o **único** resultado que segue para os passos 4–6.
   - `JA_APLICADA_POSTCHECK_PASS` (118 presente e íntegra): **não aplicar**. Pular os passos 4–6 e ir direto ao passo 7, com autorização própria para a conferência funcional.
   - `RECUSARIA` (código 3), PARCIAL ou qualquer outro código: parar e ler o motivo.
4. Só com `PRONTA_PARA_APLICAR`: ponto PITR comprovado e registrado; autorização de Felipe para a 118 em staging.
5. Janela curta, sem importação em andamento. CONFERIR de novo, imediatamente antes; seguir só se der `PRONTA_PARA_APLICAR` outra vez.
6. Bloco APLICAR com `KIDMAIS_REGISTRO_BACKUP` definida. Uma vez.
7. CONFERIR de novo (esperado `JA_APLICADA_POSTCHECK_PASS`); conferência funcional autorizada: importar um contrato sintético conta 1 leitura, sem 503.

## Provas locais

Ver a seção "Provas" do vault (`Plano importacao contratos em lote 20261031.md`, "Aplicador da 118 — 08/11/2026").
