# Revisão independente — Financeiro P2 fase A — 09/11/2026

**REPROVADO: 0 P0, 1 P1, 2 P2, 1 P3.** Branch codex/financeiro-p2-20261109, base cbf84e017733078352e1709ac8fb11c22f7d2b22, árvore sem commit. Contrato rev. 3.2 C.2/C.2.1/C.2.2/E.2. Revisados status/diff, arquivos novos, leitor, telas, exportação, migrations, checks e rollback. Escritores de B estão fora do escopo; schema/leitor de A precisam suportar o que B gravará.

## R1 — P1 — 121 impede reconferir atributos alterados

`database/migrations/20261109_121_financeiro_abertura.sql:67` e `:78`; leitor em `lib/financeiro/servico.ts:1376`.

Uma origem da janela é conferida com H1; valor/data/taxa/estado muda para H2. O leitor reabre corretamente a pendência, mas INSERT da nova conferência colide com UNIQUE (abertura_id, origem_tipo, origem_id); UPDATE/DELETE são recusados. DO NOTHING conserva H1. A Gestão precisaria trocar a abertura inteira, contrariando a resolução individual de C.2.2. Preparar histórico de versões conferidas com idempotência, acréscimo e ordenação inequívoca; atualizar checks e provar H1 → H2 → conferir H2 → nova mudança. O comentário sobre a conferência mais recente não é realizável pelo schema atual.

## R2 — P2 — Cliente novo aceita saldo do fluxo de servidor antigo

`components/admin/FinanceiroTelas.tsx:16`, `:133`, `:185`.

O fluxo retorna versao 3, mas o tipo Fluxo e a guarda de renderização não verificam essa versão. Na coexistência de instâncias durante implantação, ou retorno ao código anterior antes de B, cliente novo pode atingir servidor da base: a base não versiona fluxo-caixa (confirmado por git show HEAD:lib/financeiro/calculos.ts), ignora cabeçalho 3 e retorna saldo absoluto sem abertura. O cliente aceita números/gráfico sem motivo ou aviso. Validar versão do DTO antes de renderizar e testar resposta antiga sem versão. A proteção inversa, cliente antigo contra servidor novo, está presente.

## R3 — P2 — Aviso de abertura não chega ao Copiloto

`lib/financeiro/servico.ts:1443` e `:1458`; consumidor atual em `lib/inteligencia/atencao-hoje.ts:165`.

A busca dos consumidores mostra caixaDaEmpresa usada só por painelGeral; pendenciasAtuais só por painel/fluxo. Ferramentas financeiras da IA não consultam pendências da abertura. Uma importação retroativa mostra aviso no fluxo e nenhuma pendência correspondente no Copiloto, divergindo de C.2.2 e do plano da fase A. Integrar leitura autorizada do mesmo agregado à IA e testar quantidade/centavos. Evitar painelGeral inteiro: grava categorias e lê outros domínios.

## R4 — P3 — Dashboard omite valor a conferir

`components/admin/DashboardGeral.tsx:167`.

DTO traz pendencias.centavos, mas a tela mostra só quantidade. No exemplo de C.2.2 falta R$ 2.000 no aviso. Exibir quantidade e valor do mesmo agregado.

## Pontos conferidos e provas

Sem outro achado: cinco linhas/contiguidade do saldo puro; janela D0..véspera e hash por origem tipada; estorno/devolução com origem própria; to_regclass e ramos legados; caixa manual valor menos taxa e NOT EXISTS contra dupla contagem; pago líquido nos cinco consumidores pedidos; status parcial nos filtros alterados; linhas anteriores a D0 sem saldo, abertura marcada ao atravessar D0 e reversão como saída negativa; versão 3 e guardas das duas rotas; FKs compostas/idempotência por empresa; rollback com trava e recusa com dados; autorização explícita em check-migrations; travessão para saldo null e novas linhas do Dashboard ocultas sem abertura. SQL apenas inspecionado.

Executado: node --experimental-strip-types --test lib/financeiro/abertura.test.ts lib/financeiro/servico.test.ts lib/financeiro/titulos-motor.test.ts — **53/53 PASS**, zero skip, funções puras/executores simulados. git diff --check PASS. Tsc, ESLint, build, production 37/37, financeiro+IA 118/118 e static 4846/4849 permanecem relatos da implementação, não repetidos. Falhas de CRLF não reclassificadas nesta revisão.

Sem navegador, PostgreSQL, migrations aplicadas, staging/production, commit/push/PR ou correção silenciosa. Só documentação desta revisão foi escrita. Nenhum servidor/cluster/dependência/temporário foi criado; artefatos preexistentes preservados. Próximo passo: corrigir R1–R4 e revisar novo diff local; PG continua dependendo de autorização específica.


## Complemento de revisão independente — 09/11/2026

Veredito vigente: **REPROVADO — 0 P0, 1 P1, 3 P2, 2 P3**. O parecer já existente foi lido e seus quatro achados foram reconferidos no código atual; não houve correção de código. Branch codex/financeiro-p2-20261109 e HEAD cbf84e017733078352e1709ac8fb11c22f7d2b22 confirmados localmente. Dois achados adicionais:

### R5 — P2 — Amostras na versão 2 bloqueiam as prévias

A mudança está em lib/financeiro/calculos.ts:12 (versão 3), mas lib/financeiro/vitrine.ts:7 e :29 continuam fixando versão 2. DashboardGeral.tsx:88 e FinanceiroTelas.tsx:185 aplicam a guarda também aos dados iniciais/amostras. Com KIDMAIS_PREVIEW_UX=1, /preview-ux/dashboard e as cinco telas de /preview-ux/financeiro passam a mostrar somente a mensagem de recarregar; recarregar mantém a mesma amostra incompatível. Atualizar os fixtures para o contrato 3, incluindo a semântica de abertura no fluxo. Evidência por inspeção dos caminhos de renderização; navegador não executado.

### R6 — P3 — Oráculos PostgreSQL ainda exigem saldo sem abertura

lib/financeiro/titulos-motor.postgres.test.ts:342 e :344 esperam saldos 100000/60000 sem criar uma abertura. O novo leitor deve devolver null nesse cenário. Também há expectativas antigas em :405, :421, :1060, :1077 e :1115. A alteração de financeiro.postgres.test.ts não atualiza esta outra suíte. Antes do ensaio autorizado, separar casos sem abertura e casos com abertura explícita; preservar a prova de contiguidade a partir de D0. Não foi executado PostgreSQL nem se afirma falha observada da suíte: incompatibilidade identificada na leitura das fixtures e asserções.

### Validação desta rodada e limites

Executado novamente nesta rodada: node --experimental-strip-types --test lib/financeiro/abertura.test.ts lib/financeiro/servico.test.ts lib/financeiro/titulos-motor.test.ts: **53/53 PASS**, zero skip. git diff --check: PASS antes desta atualização documental. Inspecionados novamente migrations, checks, rollbacks e autorização 120/121 no check-migrations. Tsc/ESLint/build e baterias amplas continuam sendo provas informadas pelo implementador. Nenhum acesso a PostgreSQL, staging, production, GitHub ou Render; sem commit/push/PR. Nenhuma alteração de código, schema ou testes. Nenhum servidor, cluster, dependência ou temporário criado nesta rodada; recursos preexistentes preservados.

Próximo passo: corrigir R1–R6 localmente e revisar o diff corrigido. Fase B e operações externas continuam fora do escopo desta revisão.

## Correções R1–R6 (implementador, rodada 2 — 09/11/2026)

Ainda LOCAL e sem commit, sobre a mesma base cbf84e01. Nenhum PostgreSQL, staging, production, GitHub ou Render foi usado.

- **R1 (P1) — reconferência.**
  - Em `financeiro_abertura_conferencias` entram `sequencia` (≥ 1) e `chave_idempotencia`.
  - Unicidade:
    - `UNIQUE (abertura_id, origem_tipo, origem_id, sequencia)`, que substitui a unicidade por origem;
    - `UNIQUE (empresa_id, chave_idempotencia)`.
  - `CHECK (modo <> 'PREVIA' OR sequencia = 1)`.
  - Os triggers continuam só por acréscimo. O comentário da migration documenta que o escritor da fase B calcula máx + 1 sob trava da revisão.
  - O postcheck da 121 confere as quatro definições novas.
  - **Leitor:** a função pura `ultimaConferencia` (abertura.ts) escolhe a maior sequência por origem, sem depender da ordem das linhas.
  - **Testes:**
    - H1 conferido → H2 pendente → H2 conferido na sequência 2 → H3 pendente de novo;
    - linhas fora de ordem;
    - a volta a H1 não reabre a conferência antiga;
    - a separação por tipo e id.
- **R2 (P2) — versão do fluxo.** O tipo `Fluxo` ganha `versao`. A guarda passa a usar `respostaFinanceiraDesatualizada(resumo, relatorio?, fluxo?)`, de calculos.ts.
  - O teste usa a resposta antiga, sem versão e com saldo 0 → 4.350.000, e também a versão 2: as duas são recusadas. A versão 3 com saldo null é aceita.
  - O retorno de `fluxoCaixa` com versão é conferido pela fonte.
- **R3 (P2) — Copiloto.** `pendenciasDoCaixa` (servico.ts) é só leitura: abertura vigente + pendências, sem painelGeral.
  - `atencao_hoje` lê esse dado só com `financeiroCompleto === true` pela porta do plano.
  - Novo item `CAIXA_A_CONFERIR`, com prioridade média, destino `/admin/financeiro/fluxo-caixa` e evidência `financeiro.caixa.abertura` (quantidade, valorCentavos).
  - Com pendência, o estado é `atencao`. Sem recebíveis e com pendência, não é `sem_dados`.
  - O enum de `saidaAtencaoSchema` foi ampliado.
  - **Testes:** quantidade/centavos, o schema, sem_dados e a porta (true lê a empresa comprovada; false e ausente não leem).
- **R4 (P3).** O Dashboard mostra "N movimentos · R$ X".
- **R5 (P2).** vitrine.ts usa `VERSAO_RESUMO_FINANCEIRO` em painel, resumo, relatório e fluxo.
  - O fluxo de amostra tem abertura em 01/03 (R$ 15.000), período começando em D0, final = inicial + entradas − saídas, previsto sem saldo e 1 pendência.
  - O painel de amostra tem caixa.
  - Teste das amostras contra o contrato.
- **R6 (P3).**
  - **titulos-motor.postgres.test.ts:** os cinco pontos conferem primeiro o caso sem abertura (null + SEM_ABERTURA + movimento do período) e depois inserem uma abertura explícita em D0 = 01/03 com saldo 0, antes de todo movimento do cenário. Os números antigos ficam preservados, assim como a contiguidade abril → maio.
  - **financeiro.postgres.test.ts:486:** tinha a mesma expectativa e não estava listado. O ponto foi corrigido do mesmo jeito, com a prova de contiguidade a partir de D0.
  - O auxiliar exige a 121 no descartável e falha com mensagem clara se ela faltar.
  - **Não executado:** precisa de "Sim, rodar PostgreSQL".

**Provas locais da rodada 2:** tsc 0; ESLint 0 nos 14 arquivos tocados; next build 0; git diff --check limpo; production.test 37/37; focais financeiro+IA 162/162 (abertura 13, atencao-hoje 9, titulos-motor 33); arquitetura da IA 9/9 (pendenciasDoCaixa entrou na lista fechada PERMITIDOS_IA); check:v1:static 4853/4856, com as 3 falhas de CRLF já conhecidas em arquivos não tocados (postcheck 109, fonte.test, acervo.test). PG não rodado; telas não vistas no navegador.

**Mudança fora dos arquivos do parecer:** `lib/inteligencia/arquitetura.test.ts` passou a permitir `pendenciasDoCaixa` de `lib/financeiro/servico` na lista fechada da IA. É uma função só de leitura, exigida pelo R3.

## Revisão independente da rodada 2 — 09/11/2026

**Veredito vigente: APROVADO para a fase A local — 0 P0, 0 P1, 0 P2, 0 P3.** R1–R6 encerrados no diff revisado. Este parecer substitui o veredito anterior para esta árvore, preservado acima como histórico. Não equivale a homologação PostgreSQL, aceite visual ou autorização para fase B/publicação.

Confirmados localmente: branch `codex/financeiro-p2-20261109`, HEAD/base `cbf84e017733078352e1709ac8fb11c22f7d2b22`, implementação sem commit. Revisados o diff do working tree, arquivos novos pertinentes e resposta do implementador; nenhum código corrigido nesta revisão.

### Conferência R1–R6

| Item | Resultado e referência na árvore revisada |
| --- | --- |
| R1 / P1 | **Encerrado.** `database/migrations/20261109_121_financeiro_abertura.sql:67`, `:73`, `:74`, `:76`: sequência positiva obrigatória, unicidade por abertura/origem tipada/sequência, chave idempotente por empresa e PREVIA restrita à sequência 1. UPDATE/DELETE continuam recusados. `database/checks/20261109_121_postcheck.sql:10` acompanha as novas constraints. `lib/financeiro/abertura.ts:117` escolhe a maior sequência, e `lib/financeiro/servico.ts:1372` lê sequência com filtro de empresa e abertura. `lib/financeiro/abertura.test.ts:78` prova H1 → H2 pendente → H2 conferido → H3 pendente, ordem invertida e retorno a H1 sem ressuscitar conferência antiga. A unicidade elimina empate válido na mesma origem/revisão; a ordem entre origens diferentes é irrelevante. |
| R2 / P2 | **Encerrado.** `lib/financeiro/calculos.ts:28` recusa versão ausente ou diferente; `components/admin/FinanceiroTelas.tsx:185` aplica a guarda ao fluxo antes dos números/gráfico. `lib/financeiro/titulos-motor.test.ts:347` exercita a resposta antiga sem versão e a v2, aceitando v3 com saldo null. `lib/financeiro/servico.ts:1532` devolve a versão. |
| R3 / P2 | **Encerrado.** `lib/financeiro/servico.ts:1467` usa abertura vigente e o mesmo agregado de pendências do painel/fluxo. A cadeia esquemaP2 → aberturaVigente → movimentosCaixa/abatimentosContratuais → conferidosDaAbertura contém apenas SELECTs e funções puras, sem garantirCategorias/painelGeral. `lib/inteligencia/atencao-hoje.ts:198` exige financeiroCompleto === true pela porta do plano, usando a empresa comprovada recebida da ferramenta. `:126` publica quantidade/centavos, destino e evidência; pendência isolada produz estado atencao. Enum em `lib/inteligencia/registro-ferramentas.ts:98` atualizado. A inclusão nominal em `lib/inteligencia/arquitetura.test.ts:54` é aceitável: autoriza essa leitura específica, sem liberar o módulo inteiro ou escritores. |
| R4 / P3 | **Encerrado.** `components/admin/DashboardGeral.tsx:167` mostra quantidade com singular/plural e valor formatado do mesmo agregado. |
| R5 / P2 | **Encerrado.** `lib/financeiro/vitrine.ts:10`, `:33`, `:45`, `:60` usam a versão atual. Fluxo traz abertura em D0, saldo inicial correspondente, final = inicial + entradas − saídas, previsto sem saldo e pendência; painel traz caixa. `lib/financeiro/titulos-motor.test.ts:362` valida o contrato das amostras. Não houve inspeção visual em navegador. |
| R6 / P3 | **Encerrado por inspeção dos oráculos, sem execução PG.** `lib/financeiro/titulos-motor.postgres.test.ts:65` / `:74` separam abertura explícita e ausência de saldo; chamadas em `:362`, `:429`, `:1086`, `:1141` precedem os grupos correspondentes. As expectativas posteriores de devolução usam a abertura do mesmo cenário, sem nova inserção; abril → maio mantém a contiguidade. `lib/financeiro/financeiro.postgres.test.ts:486` também prova null/motivo/movimento e depois D0 com saldo zero, 3900 → 2900 e contiguidade. A execução futura requer a 121 presente no descartável; a preparação da suíte/receita não foi executada nem homologada aqui. |

### R1: alcance da regra do futuro escritor

**Máx + 1 sob SELECT FOR UPDATE da revisão é suficiente para serializar a sequência de conferências da mesma revisão**, desde que leitura do máximo e INSERT ocorram depois da obtenção da trava, na mesma transação, e todos os escritores sigam esse protocolo. A constraint fornece uma segunda barreira contra sequência duplicada. Não é necessário impor contiguidade por CHECK para o leitor: vale o maior número.

**Essa frase, sozinha, não implementa toda a segurança da fase B.** A unicidade da chave impede duas gravações com a mesma identidade, mas o escritor ainda deve reconhecer a repetição, confrontar o pedido e devolver o resultado já persistido sem criar sequência adicional; chave reutilizada com outro pedido deve ser recusada. Deve também revalidar revisão vigente/versaoEsperada e atributos vistos na confirmação, coordenar com a criação de uma revisão substituta e tratar conflito/repetição conforme o isolamento transacional adotado. Travar apenas a revisão antiga não impede inserir uma revisão nova. Esses requisitos pertencem ao escritor ainda fora do escopo; o schema/leitor de A agora os comportam. Provas físicas de idempotência, conferência concorrente e conferência × troca de revisão continuam pendentes de B e de ensaio PostgreSQL autorizado.

### Provas independentes e limites

Executado nesta rodada, sem carregar arquivo de ambiente: `node --experimental-strip-types --test` com abertura, servico, titulos-motor, atencao-hoje, arquitetura, copiloto, demerzel, gateway, integrado-v1 e scripts/production/production.test.mjs: **177/177 PASS, 0 falhas, 0 skips** (inclui production 37/37 e arquitetura 9/9). Os verificadores production foram exercitados pelos seus testes locais com dependências simuladas; nenhum ambiente real foi consultado.

Sonda adicional via stdin, sem arquivo criado: **PASS**, 15 consultas simuladas, validando pendenciasDoCaixa pela cadeia real do leitor, maior sequência recebida fora de ordem, H2 resolvido/H3 pendente, parâmetros de empresa/abertura, ausência de schema e recusa de qualquer comando diferente de SELECT. Isso não prova locks ou constraints PostgreSQL reais. `git diff --check`: PASS.

Tsc, ESLint, next build, a bateria informada como 162/162 e check:v1:static 4853/4856 continuam provas relatadas pelo implementador; não foram repetidos integralmente aqui. As três falhas de CRLF informadas não foram reclassificadas nem corrigidas por esta revisão. SQL, postcheck e suítes PG foram inspecionados, não executados.

Somente este documento e os registros/índices relacionados no Obsidian foram atualizados. Sem PostgreSQL, navegador, staging/production, GitHub, Render, commit/push/PR ou alteração de código/schema/testes. Nenhum servidor, cluster, instalação de dependência, build ou temporário persistente criado nesta rodada; node_modules/.next preexistentes e clone preservados. Próximo passo: definir e autorizar separadamente o ensaio PostgreSQL/visual e a continuidade da fase B; este parecer não autoriza essas operações.

## PostgreSQL descartável da fase A (implementador, 09/11/2026)

Autorizado por Felipe ("Rodar PostgreSQL"). Cluster PostgreSQL 18.6 em `E:/kidmais-pg-descartavel/financeiro-p2-20261109`, porta 55498, `cluster_name = kidmais_descartavel`. O cluster foi parado e removido. Logs em `ambientes-locais/pg-descartavel-financeiro-p2-20261109-relatorios`. Nenhum banco real foi tocado.

**Lacuna achada antes de rodar.** Nenhum modelo da receita tinha 120 e 121: `titulos-motor` rodava em 062 e 114, e `financeiro.postgres` em `atual`, que vai até a 057. Com isso, o `abrirCaixa` da R6 falharia em todos. Correção, que muda arquivos já aprovados pelo Astra:

- **`scripts/regressao-v1-postgres-receita.cjs`:** novo modelo `121`, com o inventário até a 121 sem a 098. É o estado do staging com 120 e 121.
- **`scripts/regressao-v1-selecao.cjs`:**
  - `titulos-motor` passa a rodar em 062, 114 e 121;
  - `financeiro.postgres` passa a rodar em `atual` e 121.
- **`titulos-motor.postgres.test.ts`:**
  - `abrirCaixa` devolve se abriu. No modelo 121 a tabela é obrigatória.
  - Nos modelos sem a 121 só vale o caso sem abertura (null + SEM_ABERTURA), e os oráculos de saldo absoluto ficam dentro de `if (comSaldo)`.
  - O movimento do estorno (saídas e linha) passou para antes da abertura, então roda em todos os modelos.
- **`financeiro.postgres.test.ts`:**
  - A parte com abertura roda só onde a tabela existe, e a suíte afirma que ela existe exatamente no modelo 121.
  - No segundo teste entrou a trava compartilhada `kidmais:agenda-config:<empresa>`, como em `titulos-motor`. Sem ela, o modelo 121 recusa com KD114, porque a 114 exige a trava nos gatilhos da 019.

**Final de linha.** O modelo 121 parou no postcheck da 116 ("função do gatilho de só inserção divergente"). Neste clone, os 453 arquivos de `database/` estão com LF no índice e CRLF no disco, e o corpo da função gravado com CR diverge do esperado. Convertidos para LF no disco, sem diferença de conteúdo no git (`git diff` vazio). Com isso, o postcheck 109 também passa no static.

**Resultado**, na última rodada de cada suíte:

| Suíte | Modelo | Resultado |
|---|---|---|
| baixa.postgres | atual | OK |
| titulos-motor.postgres | 062 | OK (3/3) |
| titulos-motor.postgres | 114 | OK (3/3) |
| titulos-motor.postgres | 121 | OK (3/3), com os oráculos de saldo absoluto, a contiguidade abril → maio e a devolução pendente e concluída |
| financeiro.postgres | atual | 1/2 |
| financeiro.postgres | 121 | 1/2 |

Os modelos e as migrations passaram: 120 e 121 aplicaram com pré e postcheck, dentro da cadeia da receita.

**Falha preexistente, que não vem da P2.** O teste "parcela de contrato aparece só na empresa dona…" (`financeiro.postgres.test.ts`, `abril.aReceberCentavos`, 0 !== 1000; a parcela 3 vence em 15/04, PENDENTE) falha igual no código da base `cbf84e01`. Isso foi rodado num worktree destacado da base, no mesmo cluster e no modelo `atual`, e o worktree já foi removido. A causa NÃO foi investigada. Como o teste para nessa asserção, a parte da P2 que vem depois (abertura em D0 e contiguidade) não executou nessa suíte. A mesma regra está provada em `titulos-motor` no modelo 121.

**Provas locais depois da rodada:**

| Prova | Resultado |
|---|---|
| tsc | 0 |
| ESLint, nos 4 arquivos tocados | 0 |
| `git diff --check` | limpo |
| production.test | 37/37 |
| check:v1:static | 4854/4856 |

As 2 falhas do static são as de CRLF conhecidas: `contratos/documento/fonte.test` e `convites/acervo.test`.

**Não feito:** os testes de concorrência da fase B, previstos no item 7 do plano: duas liquidações, reversão × pagamento e conferência × troca de revisão. O escritor ainda não existe.

## Revisão independente da mudança de harness PostgreSQL — 09/11/2026

**Veredito: APROVADO para a mudança de harness da fase A local — 0 P0, 0 P1, 0 P2, 0 P3 novos.** R6 permanece encerrado. Mantido o aceite local da fase A; a suíte `financeiro.postgres` continua vermelha e não está integralmente homologada. O aceite não autoriza fase B, publicação ou operações de banco.

Confirmados por Git local: branch `codex/financeiro-p2-20261109`, HEAD/base `cbf84e017733078352e1709ac8fb11c22f7d2b22`, implementação no working tree sem commit. Escopo desta rodada: diff dos quatro arquivos do harness/oráculos, cadeia da receita e do runner, protocolo de trava, plano local e logs fornecidos. Não houve nova revisão integral de todos os itens da P2 nem alteração de código.

### Modelos antigos e R6

- `scripts/regressao-v1-selecao.cjs:81` e `:85` mantêm `financeiro.postgres` em atual/121 e `titulos-motor` em 062/114/121. O runner expande `tambem` em execuções independentes (`scripts/regressao-v1-postgres.cjs:41`), recria/restaura os modelos e propaga o modelo efetivo por `ambienteDaSuite` (`scripts/regressao-v1-selecao.cjs:541`). Assim, a execução normal dessas suítes inclui a 121; não é um ramo opcional omitido pela seleção padrão.
- `lib/financeiro/titulos-motor.postgres.test.ts:66`: a ausência da tabela no modelo 121 lança erro antes de devolver false. A inserção de abertura também precisa ter sucesso. Portanto, os `if (comSaldo)` não permitem que a 121 passe silenciosamente sem provar os saldos.
- 062/114 continuam úteis: exercitam o leitor novo sobre schemas sem 120/121, o contrato null/SEM_ABERTURA, movimentos, motor, estorno/devolução, isolamento e demais consumidores. 062 cobre também a ausência original da 066; 114 cobre os gatilhos que exigem a trava da agenda. Não são provas de saldo com abertura e não devem ser contabilizados como tal.
- `lib/financeiro/titulos-motor.postgres.test.ts:368`: movimento de -40000, saída de 40000 e linha do estorno são conferidos antes da abertura em todos os modelos. `:372` preserva no 121 os saldos 100000 → 60000 e a contiguidade abril → maio. Os grupos de devolução em `:438` e `:1095` conservam os oráculos pendente/concluída no 121; a transferência em `:1150` conserva a comparação antes/depois. O gating é compatível com D-FIN-9 e não reabre R6.

### Estado 121 e trava do fixture

`scripts/regressao-v1-postgres-receita.cjs:128` define ate=121, sem=[098]. A receita seleciona um prefixo do inventário oficial e aplica os checks exigidos. Conferido sem conexão: o fim da cadeia é 118, 120, 121; não há 119 no inventário e a 098 é excluída. Isso corresponde à premissa local de staging até 118, mais as duas migrations aditivas exigidas para A (`docs/FINANCEIRO_P2_PLANO_20261109.md:21` e `:37`). A exclusão da 098 segue a cadeia rebaseada 107/108 já usada pelos modelos recentes. **É o estado correto para o ensaio desta fase A segundo o plano local**, sem atestar o estado atual de um ambiente remoto, que não foi consultado. A antiga redação do item 7 do plano, “062 e 114 com as migrations novas”, deve ser entendida à luz desta matriz: 062/114 são controles legados; 121 é o alvo com 120/121.

`lib/financeiro/financeiro.postgres.test.ts:361` usa exatamente a advisory compartilhada transacional da entrada real: `hashtextextended('kidmais:agenda-config:' || empresa, 0)`, por `pg_advisory_xact_lock_shared`. Comparado com `lib/agenda/trava-configuracao.ts:25` e `:27` e com a verificação de chave/modo em `database/migrations/20261031_114_trava_configuracao_gatilhos.sql:36`. A trava é tomada antes das inserções que disparam a 019 e dura até ROLLBACK. Empresa A foi criada/atualizada na mesma transação, portanto sua linha já está protegida antes da advisory. O fixture não reproduz todo o helper: não faz seu `set_config`, nem prova o protocolo concorrente da entrada real. Isso é aceitável para preparar esta fixture; a 114 exige a trava efetiva em pg_locks, não apenas uma variável. Não há desativação da proteção KD114 nesta mudança.

### Falha preexistente: aceite e limite

**Aceito a falha de abril como preexistente e fora da regressão introduzida pela P2 nesta revisão.** O log `financeiro-p2-pg-base-20261109.log` registra 1/2 na cópia indicada como base, no modelo atual, com 0 !== 1000 na linha original 469. A asserção e a preparação relevante continuam presentes na base local consultada por `git show HEAD`. O log final `financeiro-p2-pg-r2-20261109.log` registra a mesma falha na linha atual `lib/financeiro/financeiro.postgres.test.ts:476`, tanto em atual como em 121, depois de resolvido o KD114 do fixture. É evidência suficiente de reprodução anterior à P2 para não abrir novo achado contra este diff; não é diagnóstico da causa nem prova de que não possa coexistir outra falha depois dela. A identidade do worktree de base removido depende do registro fornecido; ele não pôde ser reinspecionado.

O teste para antes de `lib/financeiro/financeiro.postgres.test.ts:489`: nem a asserção de presença da 121, nem a abertura em D0, nem 3900 → 2900/contiguidade desse cenário executaram. Esses trechos estão corretos por inspeção, mas continuam sem prova PG nessa suíte. O log `financeiro-p2-pg-20261109.log` registra titulos-motor 3/3 em 062/114/121, incluindo seus grupos de saldo/contiguidade/devolução no 121; isso sustenta R6, sem substituir a execução do cenário específico interrompido. Resultado global do ensaio continua FALHA, e não deve ser anunciado como PostgreSQL integralmente aprovado. A falha legada merece investigação separada, sem corrigir ou remover sua asserção para obter verde nesta revisão.

### Provas desta revisão e finais de linha

Executado independentemente, sem arquivo de ambiente e sem conexão: `node --experimental-strip-types --test lib/financeiro/abertura.test.ts lib/financeiro/servico.test.ts lib/financeiro/titulos-motor.test.ts` — **57/57 PASS, 0 falhas, 0 skips**. Sonda local via stdin — **PASS** para inventário até 121 sem 098, cauda 118/120/121, matrizes das duas suítes e propagação de `KIDMAIS_POSTGRES_MODELO`; somente imports e funções sem conexão. `git diff --check` — PASS antes desta inclusão documental.

Conferido o diff dos arquivos rastreados de `database/`: vazio, inclusive com comparação ignorando fim de linha. O status pode listar arquivos após a conversão física; isso não constitui diferença de conteúdo no diff revisado. Não foi refeita a normalização nem alterado arquivo de database nesta revisão. O sucesso do postcheck 116 após LF e a aplicação física de 120/121 permanecem evidências da rodada do implementador, não execução independente. Tsc 0, ESLint 0, production 37/37 e static 4854/4856 permanecem provas relatadas; as duas falhas de CRLF do static não foram repetidas nem resolvidas aqui.

Somente este complemento foi anexado ao documento. Nenhum PostgreSQL, staging, production, GitHub, Render, commit, push ou PR; nenhum código, teste, migration ou configuração alterado. Não foram criados cluster, servidor ou dependência.
## Falha de abril em financeiro.postgres — investigação (implementador, 09/11/2026)

Pedido de Felipe: "Investigar abril". Só leitura de código, histórico e uma simulação sem banco. Não houve PostgreSQL, nem mudança de código ou teste.

**Causa, com evidência.** A asserção `abril.aReceberCentavos === 1000` ficou incompatível com a P1 (`38861ec5`, 08/11, "P1 títulos pelo motor em todas as leituras"):

- **O que mudou na P1:** desde ela, `consolidarTitulos` limita o saldo de cada título ao que falta pagar no pagamento: `restante = max(0, obrigação − líquido da posição)`. Esse restante é distribuído por ordem de vencimento. Antes da P1 (`38861ec5^`), o saldo era só `valor − recebido`, por parcela.
- **O fixture do teste, de 27/09 (`9e0a4a7e`):**
  - pagamento com `valor_total_contratado = 100`;
  - parcela 1 de 100, que recebe 40;
  - parcela 2 de 50, CANCELADA;
  - parcela 3 de 10, que vence em 15/04, PENDENTE.

  As parcelas ativas somam 110, acima dos 100 contratados.
- **Como a conta fecha:** a obrigação é 10000 e o líquido 4000, então o restante é 6000. A parcela 1 vence antes e consome os 6000. A parcela 3 fica com saldo 0, status "Pago", e sai do a receber de abril.

**Simulação de `consolidarTitulos`** com as mesmas linhas, via tsx e sem banco:

| Contratado | Parcela 1 | Parcela 2 | Parcela 3 |
|---|---|---|---|
| 100 | Vencido, saldo 6000 | Cancelado | Pago, saldo 0 |
| 110 | Vencido, saldo 6000 | Cancelado | A receber, saldo 1000 |

**Por que só apareceu agora:** a P1 rodou PG só em `titulos-motor` (062/114). `financeiro.postgres` não estava naquela rodada.

**Leitura:** o comportamento novo é o pretendido pela P1. O comentário do código diz que o saldo "nunca passa do saldo da posição". O que ficou desatualizado é o fixture. A falha não é regressão da P2.

**Correção proposta, não aplicada:** no teste, deixar o contrato coerente com as parcelas, com `valor_total_contratado = 110`. Pode ser no INSERT do pagamento ou num UPDATE junto com a parcela 3. Antes, é preciso conferir as asserções seguintes que dependem do total. Depois, rodar de novo o PG descartável (atual e 121), o que precisa de autorização, e mandar para revisão do Astra. Isso também destrava o trecho P2 da suíte (abertura em D0 e contiguidade), que nunca executou.

## Correção do teste de abril e PostgreSQL descartável (implementador, 09/11/2026)

Felipe pediu "Sim, corrigir e rodar". Cluster PostgreSQL 18 em `E:/kidmais-pg-descartavel/financeiro-p2-abril-20261109`, porta 55498, `cluster_name = kidmais_descartavel`. Ao final foi parado e removido. Nenhum banco real foi tocado. Só `lib/financeiro/financeiro.postgres.test.ts` mudou, em dois pontos, os dois causados pela P1 (`38861ec5`):

1. **Contrato de 110.** `valor_total_contratado` passou de 100 para 110, a soma das parcelas ativas (100 + 10). Os outros oráculos da suíte já esperavam 11000 de contratado e de faturamento, e 7000/18000 de a receber com a parcela 3. Com isso, `abril.aReceberCentavos` dá 1000.
2. **Margem fora do escopo.** O relatório de agosto mostra a festa de março só pelo caixa de agosto. A P1 trocou explicitamente `margemEstimadaCentavos: 0` por `null` nesse caso: a festa está fora do escopo e a regra é "Nunca zero presumido". O teste agora afirma `noEscopo === false` e `margemEstimadaCentavos === null`. Essa asserção só apareceu depois que a de abril passou.

**Resultado:**

| Suíte | Modelo | Resultado |
|---|---|---|
| financeiro.postgres | atual | OK, 2/2 |
| financeiro.postgres | 121 | OK, 2/2, incluindo a parte P2: abertura em D0, saldo 0 → 3900 e contiguidade 3900 → 2900 |
| titulos-motor | 062, 114, 121 | OK, 3/3 em cada (mesma rodada, antes da 2ª correção, que não toca essa suíte) |

Também deram 0: tsc, ESLint no arquivo e `git diff --check`.

Logs em `ambientes-locais/pg-descartavel-financeiro-p2-20261109-relatorios`: `financeiro-p2-pg-abril-20261109.log` (1ª rodada, que parou na margem) e `financeiro-p2-pg-abril-r2-20261109.log` (verde).

Nada commitado. Falta a revisão do Astra para essas duas mudanças de oráculo.

## Revisão independente dos dois oráculos de abril/agosto — 09/11/2026

**Veredito: APROVADO no escopo destas duas correções — 0 P0, 0 P1, 0 P2, 0 P3.** As mudanças alinham o fixture e a expectativa de margem ao contrato já introduzido pela P1 (`38861ec5`); não há evidência de defeito do leitor sendo encoberto. Revisados o working tree da branch `codex/financeiro-p2-20261109`, HEAD/base `cbf84e017733078352e1709ac8fb11c22f7d2b22`, o histórico local da P1, o leitor atual, os oráculos relacionados e os dois logs de abril. Implementação continua sem commit. Este complemento é restrito aos dois pontos da seção anterior; não representa nova revisão integral da P2 nem autorização operacional.

### Fixture de 110 e coerência dos valores

Em `lib/financeiro/financeiro.postgres.test.ts:407`, os 110 correspondem às parcelas ativas de 100 e 10; a parcela 2 de 50 está CANCELADA. `consolidarTitulos` (`lib/financeiro/servico.ts:267`) já limitava na P1 cada saldo ao restante da posição, ordenando por vencimento. Com recebimento bruto de 40, sem estorno/devolução, 100 contratados deixam 6000 centavos, inteiramente consumidos pela parcela 1; a parcela 3 fica com saldo zero. Com 110, restam 7000: 6000 em março e 1000 em abril. A taxa de 100 centavos pertence ao caixa e não reduz os 4000 de quitação contratual. Não houve mudança dessa regra no leitor para obter o verde.

| Oráculo preservado | Conta em centavos e alcance |
| --- | --- |
| Contratado/faturamento 11000 | 10000 + 1000 das parcelas ativas, excluindo a cancelada. Sem cronograma, `somaContratual` soma os nominais ativos; por isso esse valor já podia passar com o pagamento incoerente de 100. Corrigir o pagamento também alinha essa soma à posição. |
| Margem estimada 8000 | 11000 − 3000 de custos lançados (1000 pagos + 2000 em aberto). Continua numérica no relatório de março e no financeiro da festa. |
| Posição a receber 7000 | 6000 da parcela 1 + 1000 da parcela 3. Março continua 6000 e abril continua 1000, comprovando vencimento versus data do evento. |
| Março posterior 9000 | 6000 contratuais vencendo em março + 3000 da entrada manual antiga; os 1000 de abril ficam fora do período. Inadimplência de março também continua 9000. |
| Painel a receber 18000 | 6000 + 1000 contratuais + 3000 manuais antigos + 8000 manuais de outubro. A entrada manual paga não entra no saldo. |
| Caixa da festa 2900 / 251900 | 4000 − 100 de taxa − 1000 de despesa paga = 2900; depois soma 250000 − 1000 de taxa de agosto = 249000, chegando a 251900. O contratado de 110 não cria recebimento. Março posterior permanece 2900; agosto isolado permanece 249000. |

### Agosto: margem ausente e caixa presente

O histórico de `38861ec5` mostra explicitamente a substituição de `margemEstimadaCentavos: 0` por `null` para festas fora do escopo e o contrato “Nunca zero presumido”. `leituraPeriodo` (`lib/financeiro/servico.ts:795`) inclui a festa de março pelo mapa de caixa de agosto, com `noEscopo: false` e margem nula. As novas igualdades estritas (`financeiro.postgres.test.ts:615`) exigem ambos os campos; uma festa ausente produziria `undefined` e falharia. Permanecem as verificações de faturamento zero, recebido líquido 249000, taxa 1000, forma PIX, resultado da festa 249000 e linha/entrada do fluxo. Assim, não se aceita uma margem numérica incorreta nem se perde a comprovação do caixa vinculado.

### Cobertura preservada e limite do cenário

Nenhuma asserção financeira restante foi removida ou relaxada por estas duas correções. Permanecem baixa parcial com saldo 6000, recusa de baixa de 101 sobre a parcela de 100 (mesmo com posição total de 110), exclusão da parcela cancelada nos agregados, isolamento de empresa, separação das entradas manuais, idempotência e os oráculos de março/abril/agosto. Abertura em D0, saldo 0 → 3900 e contiguidade 3900 → 2900 continuam no ramo 121, cuja presença é afirmada antes do `if`.

Há uma mudança deliberada de condição do fixture: este cenário PG deixa de ter parcelas ativas acima da obrigação e, portanto, não demonstra mais o corte do saldo por esse excesso. Ele já não tinha um oráculo válido para esse corte: exigia cobrar abril mesmo quando a posição estava esgotada. A proteção continua explicitamente testada em `lib/financeiro/titulos-motor.test.ts:132` (“o saldo somado nunca passa da posição do pagamento”: parcelas de 500 + 500, obrigação 800, saldos 500 + 300). Esta revisão não atribui ao cenário corrigido uma cobertura PG específica desse excesso. Os testes do motor também preservam a margem nula fora do período e a distinção entre caixa zero e ausência de margem.

### Evidências e limites desta revisão

Executado independentemente, sem carregar arquivo de ambiente ou conectar a banco: `node --experimental-strip-types --test lib/financeiro/titulos-motor.test.ts lib/financeiro/servico.test.ts` — **44/44 PASS, 0 falhas, 0 skips**. Inclui a limitação pela posição e os casos de margem fora do escopo. Diff do teste conferido contra a base; as demais mudanças P2/advisory preexistentes foram distinguidas destes dois pontos.

Logs locais lidos em `D:/glass/KidMais Manager/ambientes-locais/pg-descartavel-financeiro-p2-20261109-relatorios`: `financeiro-p2-pg-abril-20261109.log` confirma a primeira rodada interrompida por `null !== 0` em agosto nos dois modelos e titulos-motor 3/3 em 062, 114 e 121; `financeiro-p2-pg-abril-r2-20261109.log` confirma financeiro.postgres 2/2, zero skips, em atual e 121. Com a presença da 121 afirmada no teste e seu término sem falha, a evidência fornecida agora alcança o trecho de abertura/contiguidade antes bloqueado. São execuções do implementador conferidas por log, não PostgreSQL repetido por esta revisão. Tsc 0 e ESLint 0 permanecem evidências relatadas, não reexecutadas aqui.

Somente este complemento foi anexado a este documento, conforme o pedido. Sem PostgreSQL, serviços externos, commit, push ou PR; sem alteração de código, testes, schema, configuração ou vault. Nenhum cluster, servidor, dependência ou arquivo temporário foi criado nesta revisão.