# Reparo dos cinco bloqueios globais da Kidmais em produção — 20/10/2026 (V1 da abertura da venda)

**Status: PREPARADO E ENSAIADO LOCALMENTE, NÃO EXECUTADO.** Nada foi lido, conectado ou gravado em produção ou staging
nesta preparação. Executar qualquer bloco exige autorização própria de Felipe ([OPERACAO_AGENTES.md](OPERACAO_AGENTES.md)):
preparar e ensaiar não autoriza aplicar.

Estado de produção informado em 20/10 (leitura de Felipe/agente, não refeita aqui): migrations até a 086 aplicadas
(074a–086 em 20/10, pacote [MIGRATIONS_PRODUCTION_20261019.md](MIGRATIONS_PRODUCTION_20261019.md)); uma empresa `kidmais`
ATIVA sem assinatura; `bloqueios_globais_ativos 5`, `bloqueios_globais_futuros 4`, `reparo_alvos_intactos 5`,
`reparo_globais_fora_do_alvo 0`; backup P1 do dia feito; flags de abertura ausentes; live `dc157a7`.

## 1. O que o reparo muda nos dados da Kidmais

O SQL é o revisado em 11–13/10 ([database/repairs/20261011_lancamento_bloqueios_kidmais.sql](../database/repairs/20261011_lancamento_bloqueios_kidmais.sql),
sha256 `a36f8fe9…3f85`, o mesmo embutido no corte de 13/10), **sem nenhuma alteração**. A decisão de propriedade é de
Felipe (P0b, 11/10): os cinco bloqueios são da Kidmais inteira.

| # | Data | Horário | Hoje | Depois |
|---|---|---|---|---|
| 1 | 15/10/2026 (já passou) | 17:00–21:00 | global: vale para **todas** as empresas | da Kidmais inteira |
| 2 | 01/11/2026 | 17:00–21:00 | global | da Kidmais inteira |
| 3 | 07/11/2026 | 17:00–21:00 | global | da Kidmais inteira |
| 4 | 13/11/2026 | 17:00–21:00 | global | da Kidmais inteira |
| 5 | 27/05/2027 | 17:00–21:00 | global | da Kidmais inteira |

- **Grava:** `bloqueios_agenda.empresa_id` = Kidmais (`7e990a2b…`) nos cinco; `estabelecimento_id` continua vazio (= todas
  as unidades da Kidmais); mais cinco linhas em `agenda_062_bloqueios_resolucao` (decidido por "Felipe", motivo fixo
  "Propriedade confirmada por Felipe em 11/10/2026 apos leitura P0b…", hora da aplicação).
- **Não muda:** data, horário, motivo, `ativo` (continuam ativos), qualquer outro bloqueio, turno, contratação, cliente,
  assinatura. Nada é apagado nem desativado.
- **Agenda da Kidmais:** nenhum horário muda. Os quatro futuros continuam bloqueados das 17h às 21h para a Kidmais, em
  qualquer unidade (ensaio: 7 de 7 bloqueios ativos valem para a Kidmais antes e depois).
- **Empresas novas:** deixam de herdar esses horários bloqueados (ensaio: 5 → 0).
- **Cadastro público (B9):** `exigirAgendaSemBloqueioGlobal` recusa com 503 enquanto houver bloqueio global ativo de hoje
  em diante (hoje: 4). Depois do reparo: 0. **Sem o reparo, ligar `CADASTRO_PUBLICO_ATIVO=true` continua dando 503.**
- **Painel da agenda:** os cinco deixam de ser "bloqueio anterior à separação da agenda por empresa" (o painel recusa
  liberá-los com `BLOQUEIO_SEM_DONO`) e passam a ser bloqueios da empresa inteira. Ponto a observar (não testado em
  navegador): o "livre" do turno filtra pela unidade exata do painel; liberar um bloqueio da empresa inteira a partir de uma
  unidade pode exigir a desativação pelo bloqueio (id).
- **Reversão:** não há pacote pronto. Desfazer = correção para frente com SQL próprio e autorização (as resoluções têm FK
  `RESTRICT`); o backup P1 cobre o estado anterior.

## 2. O executor de 11/10 continua válido?

| Item | Situação com 074a–086 aplicadas |
|---|---|
| SQL revisado | **Válido, intacto.** Robusto às datas (15/10 já passou; só recusa global futuro fora dos cinco). Usa 062 (`agenda_062_bloqueios_resolucao`, `empresa_id`/`estabelecimento_id`) e 014 (`kidmais_lock_datas_revisao`); nenhuma migration 063–086 toca essas tabelas ou funções. |
| Gatilhos nas tabelas tocadas | Mesmos de antes: `bloqueios_agenda_atualizado_em_trg` (005), `fr_bloqueio_proteger_trg` (014, recusa conflito com contratação vigente) e `bloqueios_agenda_062_unidade_trg` (062). Conferido no ensaio sobre o schema pós-migrations (impressão `c24d84c7…`, 6790 objetos = a do ensaio aprovado de 19/10). |
| `scripts/reparo-bloqueios-production.cjs` (11/10) | Funcionaria, mas: sem conferência somente leitura; identidade só banco + TLS; pós-verificação só conta globais futuros; marcador único `lancamento-venda-20261011/reparo-bloqueios.json` sem retomada (uma falha de `lock_timeout`, sem nada gravado, travaria o reparo); não antecipa conflito, gatilho ou privilégio. **Fica intacto como histórico; não usar.** |

Decisão: executor novo [scripts/reparo-bloqueios-producao-20261020.cjs](../scripts/reparo-bloqueios-producao-20261020.cjs),
que roda o mesmo arquivo SQL (sha conferido antes de conectar e antes de executar).

### Travas do executor novo

- **Modos estritos:** sem argumento = PLANO (sem conexão); `--conferir`; `--aplicar-autorizado --backup <registro>`;
  `--retomar-autorizado --backup <registro>`.
- **Alvo antes de conectar** (igual ao pacote de 19/10): `RENDER=true`, `RENDER_SERVICE_ID=srv-dak77m2d0e5s73b8rkkg`,
  `KIDMAIS_DEPLOY_ENV=production`, `DATABASE_SSL=true`, host interno exato sem domínio, banco `kidmais_production`, porta
  5432, URL sem parâmetros.
- **Identidade vista pelo servidor:** banco, TLS 1.2/1.3, endereço privado, PostgreSQL 18.
- **Aplicar/retomar, antes de conectar:** disco persistente montado; `CADASTRO_PUBLICO_ATIVO`, `ASSINATURA_PLANOS_ATIVOS` e
  `COTACAO_PUBLICA_POR_EMPRESA` desligadas; registro de backup em `data/lancamento-venda-20261011/backup-*.json` conferido
  por `conferirBackup` do aplicador do lançamento (< 24 h, PITR < 24 h, dump íntegro com o hash registrado).
- **Antes da escrita (também no CONFERIR), em transações READ ONLY:**
  - schema e funções exigidos;
  - conjunto exato de gatilhos;
  - privilégios (UPDATE em `bloqueios_agenda`; INSERT/UPDATE em `agenda_062_bloqueios_resolucao`; EXECUTE na trava de datas);
  - Kidmais com o id de produção;
  - cada um dos cinco INTACTO (as mesmas condições do SQL);
  - nenhum global futuro fora dos cinco;
  - nenhuma contratação vigente no horário (o gatilho 014 abortaria o UPDATE).
- **Execução:** trava consultiva própria; marcador exclusivo
  `data/reparo-bloqueios-producao-20261020/reparo.json`. O marcador de 11/10, se existir, também impede a aplicação comum.
  Depois, `SET kidmais.reparo_lancamento` → SQL inteiro (BEGIN…COMMIT dele) → `RESET`.
- **Depois do COMMIT:** os cinco REPARADOS, zero global futuro, total de bloqueios e de ativos iguais, +5 resoluções,
  +5 bloqueios ativos da Kidmais.
- **Falha:** ROLLBACK e leitura do estado. O marcador registra `FALHA_NADA_GRAVADO`, `FALHA_ESTADO_GRAVADO_REVISAR` ou
  `FALHA_ESTADO_DESCONHECIDO`.
- **Retomada:** só com a flag própria, só com os cinco INTACTOS, nunca depois de `COMMIT_CONFIRMADO`
  (`reparo.tentativa-<n>.json`).
- **Saída:** só códigos, booleanos, contagens e as datas dos cinco; nunca URL, credencial ou dado de cliente.

Códigos de saída: 0 PLANO / CONFERIDO / REPARO_JA_APLICADO / PASS; 1 recusa antes de conectar; 2 FALHA (ver `gravado`);
3 conferência RECUSARIA; 4 recusa do bloco de Shell. Qualquer outro (127, 130, 143…) ou ausência de `CODIGO_SAIDA_BLOCO` =
parar e ler.

## 3. Blocos de Shell

Gerador: [scripts/bloco-shell-reparo-bloqueios-producao-20261020.cjs](../scripts/bloco-shell-reparo-bloqueios-producao-20261020.cjs)
(`TODOS <rotulo> <pasta-nova>`). Quatro blocos ASCII, cada um ≤ 32 KB, no desenho revisado em 18–19/10:

- **Guarda e colagem:** `bind` antes da guarda; guarda `RENDER_SERVICE_ID` antes de qualquer leitura ou gravação; corpo
  em subshell; `CODIGO_SAIDA_BLOCO=<n>` no fim. Prompt `>` depois de colar = Ctrl-C e colar o MESMO bloco.
- **CONFERIR, APLICAR e RETOMAR** são autossuficientes: trazem o executor, o SQL e o aplicador do lançamento com a trava de
  alvo dele (4 arquivos). O sha256 de cada um é conferido antes de gravar. A gravação vai para a pasta própria
  `/opt/render/project/src/.kidmais-reparo-bloqueios-20261020`: presente igual = `JA_PRESENTE`; diferente = para com 4 sem
  gravar nada. Nada em `scripts/` do deploy é lido, sobrescrito ou removido.
- **APLICAR e RETOMAR** exigem `export KIDMAIS_REGISTRO_BACKUP=<registro do P1>` antes de colar.
- **LIMPEZA** remove só arquivos da pasta própria com sha conferido; o divergente é preservado. Nunca toca o disco
  persistente (`data/`). A pasta própria some no próximo deploy de qualquer forma.

Os sha256/bytes dos blocos gerados da árvore do commit ficam no `LEIA-ME.md` do pacote
`pacote-abertura-venda-prep-20261020` (fora do repositório); conferir antes de colar.

## 4. Roteiro proposto (cada passo com autorização própria)

1. **Backup:** se o registro do P1 tiver mais de 24 h, refazer o backup com
   [o comando](evidencias/backup-production-comando-codex-20261011.txt) e anotar o caminho do registro.
2. **Pausa:** não editar a agenda (bloqueios, turnos, remarcações) durante a janela (~1 minuto). O `lock_timeout` de
   5 s aborta o reparo inteiro se houver edição concorrente; nesse caso, `FALHA_NADA_GRAVADO` → RETOMAR com decisão.
3. **CONFERIR** → `CONFERIDO` (código 0). Esperado:
   - cinco alvos `INTACTO`, `conflitos` 0;
   - `globais_ativos` 5, `globais_futuros` 4, `globais_futuros_fora_do_alvo` 0;
   - quatro gatilhos esperados;
   - `marcadores.proprios` vazio e `marcadores.legado` nulo.
4. **APLICAR** (com `KIDMAIS_REGISTRO_BACKUP`) → `PASS` (código 0), `gravado: true`, marcador `COMMIT_CONFIRMADO`.
   Esperado em `depois`: `globais_ativos` 0, `globais_futuros` 0, `resolucoes_total` +5, `bloqueios_ativos_kidmais` +5.
5. **CONFERIR** de novo → `REPARO_JA_APLICADO` (código 0).
6. **LIMPEZA** (opcional).
7. Só depois disso faz sentido ligar `CADASTRO_PUBLICO_ATIVO` (último passo da abertura).

| Código | Leitura | Próximo passo |
|---|---|---|
| 1 | recusa antes de conectar (flag ligada, backup antigo, serviço/URL) | corrigir a causa; nada foi gravado |
| 2, `gravado: false` | falha sem gravação (`FALHA_NADA_GRAVADO`) | ler a saída; CONFERIR; RETOMAR só com decisão de Felipe |
| 2, `gravado: true`/`null` | estado gravado ou desconhecido | não repetir; CONFERIR e ler; se `REPARO_JA_APLICADO`, conferir os agregados |
| 3 | conferência recusaria (motivos listados) | não aplicar; levar os motivos para decisão |
| 4 | o bloco recusou (registro, arquivo divergente, pg ausente) | ler a linha; corrigir; colar o MESMO bloco |

## 5. Ensaio local e testes

[scripts/ensaio-reparo-bloqueios-producao-20261020.cjs](../scripts/ensaio-reparo-bloqueios-producao-20261020.cjs), num
PostgreSQL 18 descartável (127.0.0.1:55811, `cluster_name`/usuário `kidmais_descartavel`). O cluster foi encerrado e
removido; os relatórios ficam em `ambientes-locais/pg-descartavel-abertura-venda-20261020-relatorios`.

**Montagem:**
- schema na ordem de produção: …074 sem 060/065, depois 079 e 084;
- os cinco bloqueios globais e os dados sintéticos do ensaio de 19/10;
- o pacote 074a–086 aplicado pelo próprio aplicador de 19/10;
- impressão do schema igual à do ensaio aprovado de 19/10;
- a Kidmais sintética nasce com o id de produção (DEFAULT trocado só durante a 046 e restaurado);
- o banco de trabalho local se chama `kidmais_production`, de modo que o SQL roda **byte a byte**.

**Resultado: PASS, 10/10 casos:**
- montagem e conferência antes (CONFERIDO);
- SQL sem a autorização de sessão recusado sem gravar;
- APLICAR PASS: só `empresa_id` muda nos cinco, demais bloqueios e tabelas intactos, alcance na agenda como na seção 1;
- conferência depois (REPARO_JA_APLICADO);
- repetições recusadas sem gravar (executor, sem marcador, retomada, SQL direto: `BLOQUEIOS_DIVERGENTES_OU_REPARO_JA_INICIADO`);
- global futuro fora dos cinco recusado antes de escrever (mesma recusa do SQL);
- falha injetada por transação aberta na agenda (`lock_timeout` em 5 s), com `FALHA_NADA_GRAVADO`, repetição recusada e
  retomada PASS;
- falha injetada no meio da transação (depois das resoluções): rollback integral e retomada PASS;
- gatilho inesperado, papel sem privilégio e flag ligada recusados.

**Testes offline:** `node --test scripts/reparo-bloqueios-producao-20261020.test.cjs` (11) e
`scripts/bloco-shell-reparo-bloqueios-producao-20261020.test.cjs` (8). Os blocos são executados de verdade com bash num
deploy temporário, inclusive em colagem interativa e truncada; o executor transportado recusa fora do Render com
código 1.

## 6. Limites

- O ensaio não prova o comportamento sob tráfego real nem substitui backup/PITR.
- O estado de produção acima é o informado em 20/10. O CONFERIR no Shell é a prova antes de aplicar.
- Contratação vigente no horário dos cinco bloqueios não pôde ser montada no ensaio: os gatilhos 014/019/062 impedem
  esse estado nos dois sentidos. O CONFERIR a conta assim mesmo, pela mesma regra do gatilho.
