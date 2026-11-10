# Aplicador da 112 em staging (cliente pessoa jurídica, Entrega B)

Estado: LOCAL, sem commit. Preparado em 01/11/2026 a pedido de Felipe ("Sim, aplicadores"), depois do fechamento PJ (D-IMP-8) e da regra de mesclagem só do mesmo tipo. A aplicação da 112 em qualquer banco real é passo SEPARADO, com autorização própria. Production fica para o plano de promoção, com adaptador e autorização próprios.

Plano de origem: `Kidmais-Manager-Second-Brain/02 - Kidmais Manager SaaS/07 - Roadmap/Plano importacao contrato dados completos 20261031.md` (rev. 2.1 APROVADO, Entrega B).

## O que entra

| Arquivo | Papel |
|---|---|
| `scripts/migration-112-comum.cjs` | Núcleo do aplicador (estado pelos 19 objetos, guardas, plano, transação com verificação antes do COMMIT, marcador). |
| `scripts/migration-112-staging.cjs` | Trava de alvo de staging (web `srv-daif418ae00c73e8k2gg`, banco `kidmais_staging_1z91`), identidade/TLS/disco de `conexao-staging.cjs`. |
| `scripts/bloco-shell-112.cjs` | Gera os blocos CONFERIR e APLICAR do Web Shell (confere sha256 dos arquivos implantados e roda o aplicador). |
| `scripts/migration-112.test.cjs`, `scripts/bloco-shell-112.test.cjs` | Cliente simulado e colagem real em bash/bash -i (dois passos novos no `ci.yml`). |
| `lib/clientes/aplicador-112.postgres.test.ts` | Prova real no PG descartável, modelo 109 (staging de hoje sem a 112), registrada em `scripts/regressao-v1-selecao.cjs`. |

O aplicador fixa o sha256 (CRLF normalizado) dos três SQL:

| Etapa | Arquivo | sha256 |
|---|---|---|
| precheck 112 | `database/checks/20261101_112_precheck.sql` | `0020a57bea747de911f16186276e2a7e4d363513ceb265a7145516ed0498bdde` |
| migration 112 | `database/migrations/20261101_112_clientes_pessoa_juridica.sql` | `8c80940613ebe00050c185ca7e323419ae9a49f379a6ff09c26e28f112e2a5e3` |
| postcheck 112 | `database/checks/20261101_112_postcheck.sql` | `eda573af1acea80ffe1343c0948af857350899f544545a770699773b93927a57` |

Qualquer mudança num desses arquivos exige atualizar o hash no núcleo (o gerador de blocos e os testes recusam a árvore divergente).

## Desenho

- **Mesmo desenho do aplicador da 109**, sem o contrato TypeScript: a 112 é só acréscimo e o estado sai do catálogo.
- **Estado pelos 19 objetos** (6 colunas, 7 CHECKs, o índice de CNPJ por empresa, 3 funções, 2 gatilhos):
  - nenhum = ausente → precheck, migration, postcheck;
  - os 19 = presente → só o postcheck decide (passa = já aplicada; falha = RECUSARIA com a mensagem do postcheck);
  - qualquer outro número = PARCIAL, recusado com os grupos que faltam (por exemplo `restricoes 6/7`).
- **Guardas antes de qualquer escrita** (só catálogo e privilégios, avaliados como `current_user`, porque no Render a credencial entra com `SET role`):
  - sempre: USAGE em public e SELECT em clientes (contagens);
  - 112 ausente: privilégios do DONO de `clientes` e de `mesclagens_clientes` (ALTER TABLE, índice e gatilhos), CREATE em public (3 funções) e USAGE em plpgsql.
- **Sem corte de consumidores.** O código anterior convive com a 112 (linhas novas nascem PF pelo DEFAULT; nenhuma consulta antiga lê as colunas novas). O código da Entrega B convive sem ela (PJ recusada com `PJ_INDISPONIVEL` / `MIGRACAO_PENDENTE`, detectada a cada transação, sem cache). Não há sessão a drenar nem cron a suspender.
- **Transação única:**
  1. precheck em READ ONLY;
  2. a migration sem o COMMIT final (o próprio arquivo abre a transação, trava `clientes` em ACCESS EXCLUSIVE e define `lock_timeout` 5 s e `statement_timeout` 60 s com SET LOCAL);
  3. ainda na mesma transação: a **prova de preservação** — nenhuma linha de `clientes` nem de `mesclagens_clientes` com `xmin` igual ao xid desta transação (ADD COLUMN com DEFAULT constante não reescreve; a 112 não atualiza linha) — e o corpo do postcheck;
  4. só então o COMMIT;
  5. depois, o estado (19 objetos) e o postcheck de novo em READ ONLY.
- **Prazos:** os dois vêm do SQL fixado (SET LOCAL), e valem para o corpo, a preservação, o postcheck e o COMMIT. Diferente da 109, o aplicador não define prazo de sessão: o `statement_timeout` do SQL já cobre a transação inteira. Estouro antes do COMMIT = NAO_COMMITADA; no COMMIT, 57014 = INDETERMINADO.
- **Situação do COMMIT:** NAO_COMMITADA, CONFIRMADO, DESFEITA_PELO_SERVIDOR (SQLSTATE fora de 08/57/58/XX e diferente de 40003, ou COMMIT respondido como ROLLBACK) ou INDETERMINADO (40003, classes 08/57/58/XX ou sem resposta). Fica registrada num marcador exclusivo no disco persistente (`data/clientes-pj-112-staging/migration-112.json`), criado antes de conectar.
- **Saída:** só nomes de etapas, booleanos, a versão do servidor, contagens por status e por tipo e nomes de divergências. Nunca ids, CPF, CNPJ ou a URL.
- **Nunca executa:** o down, env, deploy, restart, escrita em `clientes` ou `mesclagens_clientes`.

## Ordem da janela (staging)

1. Deploy em staging do código da Entrega B (traz este aplicador e os SQL), com autorização própria. Conferir no Render o commit do web.
2. Gerar os blocos da árvore publicada e conferir sha256 e bytes:
   - `node scripts/bloco-shell-112.cjs CONFERIR <commit>`
   - `node scripts/bloco-shell-112.cjs APLICAR <commit>`
3. Bloco CONFERIR. Esperado: `PRONTA_PARA_APLICAR`, `objetos: 0`, contagens por status.
4. Ponto PITR do PostgreSQL de staging comprovado e registrado (referência e horário, anterior à aplicação).
5. Autorização de Felipe para a 112 em staging.
6. Bloco CONFERIR de novo, depois o bloco APLICAR (`export KIDMAIS_REGISTRO_BACKUP="<referência e horário do PITR>"` antes de colar), depois o bloco CONFERIR. Esperado no fim: `JA_APLICADA_POSTCHECK_PASS`, `porTipo: {PF: <total>}`.
7. Conferência funcional logada: cadastro PF igual; cliente PJ, importação PJ e fechamento PJ liberados.

Durante a transação, leituras e escritas de `clientes` esperam (ACCESS EXCLUSIVE). A transação dura milissegundos; com outra transação longa segurando `clientes`, o `lock_timeout` de 5 s encerra a tentativa como NAO_COMMITADA, sem nada criado.

**Paradas:** qualquer código diferente de 0 → parar, copiar a saída e o marcador, não repetir.

**Se o COMMIT ficar INDETERMINADO:** reconciliar pelo CONFERIR. A retomada só acontece com decisão de Felipe, renomeando o marcador (nunca apagando) para `migration-112.<horario>.json`.

**Recuperação:**
- O down (`database/rollback/20261101_112_clientes_pessoa_juridica_down.sql`), só com autorização própria e SEM nenhum dado de PJ (o down recusa).
- Depois da primeira PJ, só correção para frente.
- Em último caso, PITR ao ponto registrado.

## Provas locais (01/11/2026)

- Cliente simulado (`migration-112.test.cjs`): 14/14. Cobre hashes e molduras, os 19 objetos casados com a migration, o postcheck e o down, estado só de catálogo, ausente/presente/parcial, privilégios um a um, trava de alvo, conferência sem escrita (nem no disco), ordem preservação → postcheck → COMMIT, preservação divergente (NAO_COMMITADA), 11 situações de COMMIT, retomada pelo marcador renomeado, deriva depois do postcheck, SQL divergente (recusa antes de qualquer marcador) e o plano.
- Blocos (`bloco-shell-112.test.cjs`): 11/11, com bash e bash -i reais.
- PG descartável (cluster 55712, modelo 109): `aplicador-112` 1/1, com clientes PF reais e uma mesclagem. Casos:
  - conferência PRONTA sem mudar a impressão do schema nem os dados;
  - função da 112 criada à mão → `APLICACAO_PARCIAL_112 … funcoes 1/3`, nada escrito;
  - papel não superusuário: sem ser dono, dono só de `clientes` e sem CREATE, cada falta recusada com o nome; dono das duas tabelas com o mínimo, aplica;
  - depois de aplicar: linhas com o mesmo `xmin` (nada reescrito), todas PF; `JA_APLICADA` como dono e como admin; marcador impede a repetição;
  - deriva: gatilho desabilitado → postcheck recusa; CHECK removido → parcial `restricoes 6/7`; restaurado → JA_APLICADA;
  - down volta à impressão;
  - controle positivo da prova de preservação: uma linha escrita na própria transação é contada;
  - falha real de lock (outra sessão em ROW EXCLUSIVE): NAO_COMMITADA depois do `lock_timeout`, nada criado; marcador renomeado → retomada aplica.
- Estática + production: 44/44. tsc e ESLint limpos.
- Mutantes: ver a seção abaixo.

## Mutantes

Script `ambientes-locais/mutacoes-aplicador-112-20261101.cjs`, cópia isolada LF `kidmais-manager-aplicador-112-mutacao-20261101` (só os arquivos do aplicador, `node_modules` por junção).

Resultado: **29/29 mortos** (relatório `ambientes-locais/mutacoes-aplicador-112-20261101-relatorios/2026-11-01T14-13-40-895Z-mutantes.json`).

- 24 no núcleo: parcial aceito, cada privilégio ignorado, preservação removida ou só de clientes, postcheck fora da transação ou com moldura, 40003 como desfeita, reaplicar a presente, COMMIT respondido como ROLLBACK, marcador sobrescrito, releituras ignoradas, conferência sem precheck ou gravando arquivo, 18 objetos aceitos como presente, CHECK fora da lista, limite de grupo, hash depois do marcador, fase do COMMIT perdida, tabela de mesclagens não exigida, backup livre no `executar`.
- 5 no gerador de blocos: sem guarda de serviço, backup multilinha, modo TypeScript, SQL não conferidos, registro listado errado.
- Na primeira rodada sobreviveram 2: **A22** (`executar` chamado direto aceitava backup ausente ou inseguro: só a CLI recusava) e **B5** (nada ligava o diretório listado pelo bloco ao diretório do marcador). Os dois testes novos (backup recusado antes do marcador e de qualquer consulta; `DESTINO + REGISTRO` igual ao `DIR` do aplicador) os mataram.

## CI local e telas da Entrega B (01/11/2026)

- CI local completo (todos os passos do `ci.yml`, incluindo os dois desta entrega): 51/51 com saída 0. O ESLint só tem 3 avisos antigos fora da Entrega B.
- Telas no navegador real (next dev no banco descartável com a 112): 16/16 PASS. Cobrem o cadastro e a edição de PJ, o fechamento admin da PJ (com o modelo legado bloqueando) e o fechamento público com CNPJ novo (1366 e 390 px) e com a PJ cadastrada e comprovada. Detalhes na nota do plano, no vault.

## Rodada 2 — revisão do Astra (02/11/2026)

O Astra reprovou a rodada 1 (0 P1, 2 P2, 4 P3). Correções:

- **P2-2 — postcheck não via corpo trocado da função:** o postcheck agora compara, para as 3 funções da 112, o SHA-256 do corpo instalado (`prosrc` sem CR, igual ao texto entre os delimitadores da migration), a linguagem, a assinatura, o retorno, a volatilidade, `strict`, `parallel`, `security definer` e `proconfig`. Uma função com a mesma assinatura e os mesmos atributos, mas outro corpo, é divergência.
  - Novo hash do postcheck: `eda573af1acea80ffe1343c0948af857350899f544545a770699773b93927a57` (era `a11b8906…`), atualizado em `migration-112-comum.cjs`.
  - Provas:
    - PG `migration-112` 8/8, com o teste novo: a mesclagem trocada por `RETURN NEW` e um `cpf_valido` permissivo que passa nos vetores conhecidos são recusados; o corpo original volta a passar.
    - Controle: postcheck sem a comparação do corpo → o teste novo falha (7/1).
    - Simulado 15/15, com o teste estático do corpo esperado das 3 funções. Blocos 11/11. Aplicador PG 1/1.
- **Mutantes:** 31/31 mortos (relatório `…-relatorios/2026-11-02T22-18-19-631Z-mutantes.json`).
  - Inclui 2 novos no postcheck: sem a comparação do corpo, e corpo esperado da mesclagem trocado.
  - Esses dois morrem pelo hash fixado do arquivo (`ARQUIVO_DIVERGENTE`). A prova funcional da conferência do corpo é o teste PG e o seu controle.
- **P2-1 — aprovação da preparação sem checar o modelo:** `aprovarPreparacao` e `editarPreparacao` (alteração comercial) recusam `MODELO_INCOMPATIVEL_PJ` com a mesma guarda do fechamento (`exigirModeloCompativelNoFechamento`), na mesma transação, antes da primeira escrita.
  - O outro chamador (revisão de documento em `administrativo.service.ts`) passa por `aprovarPreparacao`.
  - PG `importacao-pj` 3/3 com o teste novo:
    - modelo legado: a alteração comercial é recusada sem mudar a revisão nem gravar aprovação;
    - a chamada direta é recusada sem nenhum INSERT/UPDATE/DELETE;
    - modelo compatível: aprova.
  - Controles: sem as duas guardas o teste falha; sem só a guarda de `aprovarPreparacao`, também falha.
- **P3-1..P3-3 — fechamento público:**
  - subtítulo "Use seu CPF ou o CNPJ da empresa…";
  - escolha "Pessoa física (CPF)" / "Empresa (CNPJ)", com CPF por padrão: teclado numérico no CPF, de texto no CNPJ (alfanumérico); a validação segue o tipo escolhido;
  - o cartão de novo aniversariante diz "Adicionar ao mesmo cadastro" na PJ.
- **P3-4 — perfil, Responsáveis e lista:** a PJ aparece como "Nome fantasia (Razão social)", com o CNPJ no lugar do CPF e o representante no cartão do contratante.
- **Achado da regressão PG completa:** o harness das suítes do atendimento WhatsApp carrega o repositório de clientes com mapa fechado de dependências. A rodada 1 passou a importar `cadastro/cnpj.ts` nele, e 22 de 261 arquivos falhavam (`dependência não prevista`).
  - Isso não foi visto na rodada 1, que rodou as suítes PG por seleção, e o CI não tem banco.
  - Correção só no harness: o módulo real entra no mapa.
  - Resultado: regressão PG completa 261/261 (relatório `pg-descartavel-cliente-pj-relatorios/2026-11-02T23-48-49-649Z-check-v1-postgres.log`).
- **Telas:** 25/25 PASS no navegador real. Inclui as novas verificações de P3-1..P3-4, em 1366 e 390 px.
