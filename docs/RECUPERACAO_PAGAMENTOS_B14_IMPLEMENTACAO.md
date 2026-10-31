# B-14 — andamento da implementação local (27/10/2026)

LOCAL, sem commit. Plano: `docs/PLANO_RECUPERACAO_PAGAMENTOS_B14_20261027.md` (rev. 8.1, sha `c076f04b…`, aprovado com ressalvas pelo Astra para a implementação local). Clone `kidmais-manager-recuperacao-pagamentos-b14-20261027`, branch `codex/recuperacao-pagamentos-b14-20261027`, base staging `eb1af426`.

## Incremento 1 — bases sem banco (feito)

| Parte do plano | Arquivos | Testes (sem banco) |
| --- | --- | --- |
| §3.3.1 gravação só com mudança | `lib/creditos/pagamento.ts` (guarda `IS DISTINCT FROM` em todos os `UPDATE`; `mudarEstado` não regrava `REVISAO` com o mesmo motivo), `lib/assinatura/sincronizacao.ts` (guarda no `UPDATE` do ramo com mudança, comparando os valores calculados; sem diferença real cai no ramo de observação, sem auditoria repetida), etiquetas `// B14:` em `ledger.ts`, `ofertas.ts`, `devolucao-registro.ts`, `reconciliacao-contratacao.ts` | `lib/assinatura/gravacao-so-com-mudanca.test.ts` (teste estático dos seis módulos; já pegou o `UPDATE` de `sincronizarEmpresa`, que só era protegido por `alvo.mudou` no JavaScript); dublês de `webhook-asaas.test.ts` e `ofertas.test.ts` passam a imitar a guarda (`rowCount`) |
| §5 `application_name` | `lib/db/postgres.ts` (`kidmais-web`, `opcoesDaConexaoWeb`) | `lib/http/origem-cliente.test.ts` |
| §3.1 provedor somente leitura | `lib/assinatura/recuperacao-provedor.ts` (lista fechada, objeto congelado) | `lib/assinatura/recuperacao-provedor.test.ts` |
| §3.6 a, §3.7 listagens | `lib/assinatura/asaas.ts` (`listarCobrancas` por data e `listarWebhooks`, com `totalCount` estável, cardinalidade e ids únicos; o `listar` antigo não mudou) | `lib/assinatura/asaas.test.ts` (+4) |
| §3.4 serialização canônica e hash | `lib/assinatura/recuperacao-hash.ts` | `lib/assinatura/recuperacao-hash.test.ts` |
| §3.1 opções do ciclo | `scripts/assinatura-reconciliar.cjs` (`provedorEfetivo`, `antesDoCommit`, `ParadaCiclo`, `COMMIT_INDETERMINADO`) | `scripts/assinatura-reconciliar-preservacao.test.cjs` + referência `…preservacao.referencia.json`, capturada executando o mesmo cenário contra `eb1af426` (cron idêntico sem as opções); no CI |

## Incremento 2 — proposta, aplicação e validade (feito)

**Desenho adotado para o resultado estruturado e o modo proposta (§3.3, §3.4).** Em vez de duplicar a lógica de cada serviço num modo "proposta", o caso roda o **próprio processamento normal** dentro de um `SAVEPOINT`, fotografa as linhas de cobrança da empresa antes e depois e desfaz.

- **Proposta:** pré-condições (hash da fotografia local + todas as leituras do provedor, gravadas por um embrulho do provedor somente leitura) + efeitos por linha (diferença das fotografias). Assim a proposta inclui **todos** os efeitos, também os de gatilho (`versao`, `atualizado_em`) e as linhas criadas, sem reimplementar regras.
- **Aplicação:** refaz o mesmo caminho em T2, **regrava os valores comerciais do instante aprovados** (`em_atraso_desde`, `cancelada_em`, `encerrada_em`; nunca recalculados de agora) e só mantém as escritas se o hash for idêntico ao aprovado. Senão desfaz e devolve `DIVERGENTE`.

| Parte | Arquivos | Testes (sem banco) |
| --- | --- | --- |
| Efeitos e `SEM_EFEITO` | `lib/assinatura/recuperacao-efeitos.ts`: chaves naturais por tabela, símbolos para ids gerados (inclusive referências, ex.: `lançamento.lote_id`), marcadores `$gerado` (instante, id, contador), domínio exato do `SEM_EFEITO` com derivadas condicionais, valores do instante | `recuperacao-efeitos.test.ts` (8): assinatura e crédito corretos → `SEM_EFEITO`; derivada sem observação não tolerada; crédito novo com símbolos; mesmo hash em T1/T2 com ids, instantes e contadores diferentes |
| Fotografia | `lib/assinatura/recuperacao-fotografia.ts`: `to_jsonb` das tabelas da lista fechada filtradas pela empresa (tabela ausente fica de fora); `regravarDoInstante` (lista fechada de colunas, só com mudança) | **sem teste ainda** — o SQL precisa de PostgreSQL descartável (autorização pendente) |
| Caso | `lib/assinatura/recuperacao-caso.ts`: `proporCaso`, `aplicarCaso`, `gravarLeituras` | `recuperacao-caso.test.ts` (6) com banco simulado: nada fica gravado na proposta; T2 com outro instante/id aplica com o mesmo hash e a data aprovada; mudança remota ou local → `DIVERGENTE` desfeito; proposta adulterada ou de outro caso recusada antes de qualquer SQL |
| D-B14-15 | `lib/creditos/pagamento.ts`: `ContextoProvedor.baseValidade = 'PAGAMENTO'`, `baseDaValidade` (data mais antiga informada pelo Asaas, meio-dia de Brasília; sem data → `REVISAO SEM_DATA_PAGAMENTO`) | `lib/creditos/base-validade.test.ts` (3) |
| Origem da auditoria | `lib/assinatura/sincronizacao-auditoria.ts`: tipo `RECUPERACAO_B14` e `caso` em `dados_depois` (`requestId` = execução) | coberto pelos testes existentes (cron e web não usam) |

**Desvio a registrar na próxima revisão:** a §3.2 do plano diz `--restore --inventario` em `REPEATABLE READ READ ONLY`. A enumeração das chaves continua assim, mas as **propostas** precisam rodar o processamento normal, que trava linhas (`FOR UPDATE`) e escreve. Elas rodam em transação de escrita **desfeita** (`SAVEPOINT … ROLLBACK TO`), como o `--conferir` (DML revertido, já previsto na A-B14-L). No RESTORE o web está em manutenção, então as travas de linha não concorrem com ninguém.

## PostgreSQL descartável (autorizado por Felipe em 27/10/2026; só local)

Cluster `kidmais_descartavel` (PostgreSQL 18, 127.0.0.1:55498) criado pela ferramenta do repositório (`scripts/cluster-descartavel-postgres.cjs`), usado pelo runner oficial (`scripts/regressao-v1-postgres.cjs`, modelo 097) e **parado e removido** ao fim. Nunca `kidmais_manager`, staging ou production.

Suíte `lib/assinatura/recuperacao-pagamentos.postgres.test.ts` (declarada em `scripts/regressao-v1-selecao.cjs`), **5/5 PASS** em cinco rodadas seguidas:
1. fotografia real das tabelas da lista fechada;
2. idempotência por fotografia — assinatura ATIVA e CANCELADA_FIM_PERIODO estáveis, com o gatilho real da 074a, e mudança real no provedor ainda como efeito;
3. idempotência — créditos AGUARDANDO_PAGAMENTO/PENDING, VENCIDO/OVERDUE e CREDITADO/RECEIVED estáveis, com o gatilho real da 095, e estorno parcial remoto como efeito;
4. caso real — proposta sem gravação; aplicação em T2 com o mesmo hash e a data comercial aprovada; repetição → DIVERGENTE;
5. crédito recriado pelo caso com a validade pela data do pagamento.

**Defeitos que o banco real encontrou e foram corrigidos:**
- `fotografar` mandava dois parâmetros para filtros que só usam `$1` (o PostgreSQL recusa) → parâmetros por filtro.
- **Hash instável em T1 × T2 (≈ 1 em 4 aplicações):** com chave natural repetida (duas auditorias da mesma ação), a diferença pareava linhas pela posição na fotografia, que depende do `id` aleatório. Corrigido: linhas existentes pareiam pela identidade (`id`); novas são ordenadas pelo conteúdo sem colunas geradas. Prova na cópia isolada: com o pareamento antigo, **3 de 12** aplicações do caso real divergiram; com o novo, **0 de 12**. Teste unitário novo em `recuperacao-efeitos.test.ts`.
- **A fotografia final não enxergava uma regravação redundante** cuja coluna derivada a marca de observação já renova (`atualizada_em`). O mutante da guarda em `AGUARDAR` (`pagamento.ts`) **sobreviveu** à primeira versão do teste. A idempotência passou a contar as escritas da 2ª execução por diferença de `pg_stat_xact_user_tables` dentro da transação: só o `UPDATE` de observação esperado (1 em `empresa_assinaturas` ou 1 em `ia_credito_cobrancas`). Com isso o mutante **morre** (2 `UPDATE` em vez de 1); o teste estático também o pega.
- `aplicarCaso` passou a devolver a proposta recalculada, para mostrar o que divergiu.

Cópia isolada do mutante: `D:\glass\KidMais Manager\ambientes-locais\b14-mutante-aguardar` (a remoção automática foi barrada pela trava de segurança; apagar manualmente).

## Incremento 3 — caso ligado aos serviços, classes e linha de base (feito)

| Parte do plano | Arquivos | Testes |
| --- | --- | --- |
| §3.1, §3.4 ligação aos serviços | `lib/assinatura/recuperacao-casos.ts`: `depsDoCaso` (EMPRESA → `sincronizarEmpresa`, EVENTO → `processarEvento`, PEDIDO → `processarPedido`), sempre com `provedorSomenteLeitura`; no RESTORE os créditos levam `baseValidade: 'PAGAMENTO'`, também pelo caminho do evento (`ContextoCreditos.baseValidade` opcional em `sincronizacao.ts`); auditoria com origem `RECUPERACAO_B14` (`requestId` = execução, `caso` = identidade estável) — `processarEvento` ganhou `origem?` opcional (web e cron continuam `WEBHOOK`); `proporCasoReal` devolve a falha do serviço como código sanitizado (`codigoErro`), com o SAVEPOINT já desfeito; `aplicarCasoReal` | `recuperacao-casos.test.ts` (3, sem banco); 2 testes novos na suíte PG |
| §3.6.1, §4 recusas e classes | `lib/assinatura/recuperacao-classes.ts`: recusas ANTES da classe. JANELA: só as do próprio serviço (`recusa`, `RECUSADA`, `SEM_CONFIRMACAO`, evento `IGNORADO`/`FALHOU`, falha). RESTORE: também as da §4 — `PERIODO_LOCAL_MAIOR` (local maior que o fim pela última cobrança paga lida), `QUEDA_SITUACAO`, `DATA_DO_INSTANTE` (cancelamento novo; encerramento novo fora do fim do período), `OFERTA_FUNDADOR` (códigos de domínio de `ofertas.ts`), `ENCERRAMENTO_089_097` (linhas ou efeitos em encerramentos/arrependimentos), `ESTORNO_CHARGEBACK` (status remoto ou `estornos[]`), `CREDITOS_ESTORNO_DISPUTA_DEVOLUCAO`. Classe: há efeito → PROPOSTA (com as recusas marcadas); sem efeito, mas com recusa ou vínculo não comprovado → CORRELACIONADA_NAO_COMPROVADA; senão RECONCILIADA. Comprovação: empresa sincronizada e cobranças da própria assinatura; evento processado; pedido sem revisão/disputa/estorno, com TODAS as cobranças locais do pedido lidas, mesma conta e ambiente. ORFA_*/INDETERMINADA só no RESTORE | `recuperacao-classes.test.ts` (10) |
| §3.5 linha de base | `lib/assinatura/recuperacao-baseline.ts`: `PREFIXOS` P0a…P11 (impressão digital = migrations > 088; P0b/P1 iguais), `prefixoDoSchema` (parcial, fora de ordem ou 098 → fora da lista), `selarBase` (sha do conteúdo canônico; a ordem dos itens não importa), `validarBase` (BASELINE_INVALIDA código 2: ausente, formato, sha, prefixo da base ou atual fora da lista, atual não contém a base, classe desconhecida), `compararComBase` (CLASSE_PIOR; ESTADO_PIOR — estado sem ordem conhecida fecha em falha; INDICADOR_AUMENTOU; LIMITE_CRUZADO entre os dois instantes; HASH_DIFERENTE; ITEM_NOVO_DA_EMPRESA; créditos novos desde P7 sobre base anterior = "novo sem comparação"; resolvidos à parte), `indicadoresDoCaso` e `itemDaBase` (identidade sha(tipo:id), empresa como sha, prazos em instante absoluto) | `recuperacao-baseline.test.ts` (6) |
| Fotografia | `assinatura_arrependimentos` (097) entra na lista fechada: lida para a recusa 089/097; qualquer escrita aparece como efeito | PG |

**PostgreSQL descartável (mesma autorização; cluster criado, usado e removido de novo, porta 55498 livre):** suíte **7/7 PASS em 5 rodadas seguidas** — os 5 testes anteriores e 2 novos:
- (a) empresa estável → RECONCILIADA nos dois modos; cancelada no provedor → PROPOSTA com `DATA_DO_INSTANTE` + `QUEDA_SITUACAO`, item da base, aplicação por OUTRA execução com o mesmo hash, auditoria com a identidade do caso;
- (b) evento pendente processado na proposta sem gravar, com a auditoria da transição pela origem da recuperação; pedido no RESTORE com o lote pela data do pagamento e, na JANELA, pela regra da candidata; depois de aplicado, RECONCILIADA.

**Mutantes:** sem `baseValidade` no RESTORE → morto; evento voltando a auditar como `WEBHOOK` → morto. Um teste novo falhou na 1ª versão por premissa errada do próprio teste (empresa estável não audita); corrigido com mudança real no provedor.

**CI local 28/28 PASS** (sem banco; o `check:v1:static` descobre os `*.test.ts` novos); `tsc` e `eslint` limpos; a preservação do cron (`executarCiclo` idêntico a `eb1af426`) continua passando.

**A registrar na próxima revisão (escolhas de interpretação):**
- "089/097" = qualquer linha ou efeito de encerramento/arrependimento da empresa (conservador);
- "datas do instante" detectadas pelo efeito (cancelamento novo; encerramento novo diferente do fim do período), porque `em_atraso_desde` vem do vencimento;
- indicadores (`cobrancas_problematicas`, `estorno_disputa_devolucao`, `periodo_local_menos_calculado_s`, `creditos_pagos_sem_lote`) e limites (`periodo_atual_fim`, `lote_vence_em`).

## Revisão do Astra dos incrementos 1–3 (27/10/2026): REPROVADO → rodada de correção 1 (feita)

Revisão sobre o diff `1720bf75…` (38 arquivos, HEAD `eb1af426`). Veredito: REPROVADO para o incremento 4, com 2 P1, 3 P2 e 1 P3; D2, D3, D5 e D7 aceitos; D1, D4 e D6 aceitos com ajuste.

| Achado | Correção | Prova |
| --- | --- | --- |
| **P1-1** crédito já vencido não é recuperável: a 095 força `liberado_em = agora` no INSERT e exige `vence_em > liberado_em`; o INSERT falha | **Decisão de Felipe (27/10): revisão, sem lote.** Em `creditar` (`lib/creditos/pagamento.ts`), com `baseValidade: 'PAGAMENTO'` e vencimento comercial ≤ agora (relógio do banco), o pedido vai para `REVISAO CREDITO_VENCIDO_NA_RECUPERACAO`, sem lote nem notificação. **Furo achado na correção:** o processamento normal (cron/web) também processa pedidos em REVISAO e creditaria com a validade contada de agora. Por isso `REVISOES_DA_PESSOA` (`SEM_DATA_PAGAMENTO`, `CREDITO_VENCIDO_NA_RECUPERACAO`) faz o caminho `CREDITAR` devolver a revisão sem creditar; só `creditarAposRevisao` (a pessoa) credita | PG: pagamento de 100 dias → REVISAO, sem lote; aplicação; o normal não credita; a repetição é SEM_EFEITO (não bloqueia a liberação); a pessoa credita. Troca do efeito T1→T2 → DIVERGENTE, nada gravado. Mutantes: sem o desvio → morto (2 falhas); sem a revisão persistente → morto |
| **P1-2** a comprovação de créditos aceitava ausência (`every([])`) e CREDITADO sem lote | `naoComprovado` devolve o motivo; `coerenciaDoPedido`: o pedido existe; exatamente uma cobrança, canônica, lida com o mesmo id, conta e ambiente; status local = lido; sem estorno, disputa ou devolução. Estado ↔ remoto: CREDITADO⇔pago, AGUARDANDO⇔PENDING, VENCIDO⇔OVERDUE, ENCERRADO⇔removida; os demais não são comprováveis. CREDITADO exige um lote com a quantidade do pedido, um único CREDITO, contadores do lote = reconstrução pelos lançamentos e carteira = Σ(disponível+reservado+bloqueado) dos lotes do recurso | `recuperacao-classes.test.ts` (13): os dois contraexemplos do Astra e mais 12 incoerências; PG com a fotografia real (coerente → RECONCILIADA; sem lote → `CREDITADO_SEM_LOTE`) |
| **P2-3** `JA_CONCLUIDO` comprovava evento inexistente ou IGNORADO | Evento: existe, já estava PROCESSADO e o objeto ligado foi RECONCILIADA no próprio caso (`relacionadoReconciliado`, dado pelo inventário do incremento 4). Inexistente, IGNORADO ou sem o objeto → não comprovado | unitário (4 casos) |
| **P2-4** sincronização só de observação mudava o hash da base | `hashComparavel` (fotografia, leituras e efeitos sem as colunas de observação toleradas e as derivadas — `COLUNAS_DE_OBSERVACAO`, exportada de `recuperacao-efeitos.ts`); a base compara só ele. O hash estrito da aplicação não mudou | unitário: o estrito muda, o comparável não; mudança comercial muda os dois |
| **P2-5** só o primeiro vencimento de lote entrava | Um limite por lote com saldo, `lote:<sha de recurso+chave de origem>`; a comparação confere cada um desde a base original | unitário com o cenário do Astra (01/10 e 28/10; base 27/10; conferência 29/10 → LIMITE_CRUZADO) |
| **P3-6** a fotografia devolvia texto pessoal | Na origem: `motivo`, `intermediador_referencia` e `conclusao_referencia` da 097 saem da fotografia (`to_jsonb(t) - ARRAY[…]`). A omissão não esconde escrita: `motivo` é imutável pelo gatilho; as referências mudam junto de colunas que ficam. Evidência exportável separada: `recuperacao-evidencia.ts` (lista explícita; sem a fotografia interna) | unitário (sem fotografia nem texto livre); PG (expressão de omissão) |
| **D1** (ajuste) | `LimpezaDoCasoFalhou`: falha do ROLLBACK TO/RELEASE sobe tipada, e `proporCasoReal` não a converte em falha do caso; o chamador desfaz a transação externa. Sequências consumidas não voltam (por isso os ids novos são símbolos) | unitário |

**Limitação declarada:** a virada real do dia (vencimento à 00:00 de Brasília) entre T1 e T2 não é reproduzível no PostgreSQL sem relógio falso. O teste troca a data lida em T2, o que produz a mesma troca de efeito (lote → revisão).

**Fora desta rodada (observações do Astra, sem achado):** a preservação do cron testa a orquestração com serviços simulados; a matriz completa de estados estáveis da §3.3.1 ainda não está toda no PG.

**Execução:** sem banco, 56/56 nos arquivos do B-14. PG descartável (mesma autorização; cluster criado e removido de novo, porta 55498 livre): **11/11 em 5 rodadas**, 2 mutantes mortos. `tsc` e `eslint` limpos. **CI local 28/28** (`check:v1:static` 3822).

## Revisão do Astra da rodada de correção 1 (27/10/2026): REPROVADO → rodada de correção 2 (feita)

Revisão sobre o diff `0dd56867…` (39 hashes conferidos). Veredito: REPROVADO para o incremento 4 (1 P1, 1 P2, 1 P3). Fechados: P1-2, P2-3, P2-4, P2-5 e D1. Parciais: P1-1 e P3-6, cobertos pelos achados abaixo.

| Achado | Correção | Prova |
| --- | --- | --- |
| **P1** uma leitura intermediária apagava a retenção: AGUARDAR voltava REVISAO → AGUARDANDO_PAGAMENTO (motivo apagado), REVISAO trocava o motivo pelo diagnóstico, e a leitura paga seguinte creditava sem a pessoa | `processarPedido` (`lib/creditos/pagamento.ts`): pedido em REVISAO, sem crédito, com motivo de `REVISOES_DA_PESSOA` fica **congelado** logo depois da leitura (antes de qualquer decisão: AGUARDAR, VENCIDO, CANCELADO, ESTORNO, DISPUTA, REVISAO ou CREDITAR). Só a situação lida é registrada na cobrança. Saídas: `creditarAposRevisao` (exige pagamento confirmado no provedor) ou o encerramento do operador (`lib/creditos/operacao.ts`). A guarda antiga dentro de CREDITAR foi removida (redundante) | PG, para os dois motivos (vencido e sem data): leituras nula → PENDING → OVERDUE → removida → REFUNDED → paga hoje (normal) → paga hoje (RESTORE). Em todas: REVISAO com o mesmo motivo, 0 lote. No fim, só a pessoa credita |
| **P2** meia-noite entre a conferência do vencimento e o INSERT: o CHECK `vence_em > liberado_em` falhava como erro do caso | `loteAntesDoVencimento`: no RESTORE (`baseValidade: 'PAGAMENTO'`) o lote é gravado num SAVEPOINT próprio (`b14_lote`). Recusa **exatamente** 23514/`ia_credito_lotes_vencimento_check` → desfaz a tentativa e abre a mesma revisão `CREDITO_VENCIDO_NA_RECUPERACAO`. Qualquer outro erro sobe. O caminho normal (validade de agora) não mudou | PG com gatilho de teste só no cluster descartável (roda depois do gatilho da 095 e iguala `liberado_em` a `vence_em`, simulando a meia-noite): o CHECK real recusa → proposta REVISAO, sem lote nem lançamento, `falha` nula. Controle: outro 23514 (`outra_check`) sobe no RESTORE e no normal, nada gravado |
| **P3** a evidência exportava `estornos[].descricao` (texto livre do painel do Asaas) dentro das leituras da proposta | `minimizarLeitura` em `gravarLeituras` (`recuperacao-caso.ts`): campos de `CAMPOS_LIVRES_DO_PROVEDOR` (hoje só `descricao`, que nenhuma decisão usa) saem da leitura GRAVADA **antes** da proposta e do hash. O serviço continua recebendo a leitura inteira | unitário (o serviço recebe a descrição; a gravação, não; recursivo); PG: o marcador não aparece na proposta nem em `evidenciaDoCaso` |

**Decisão declarada (para o Astra):** `invoiceUrl` continua nas leituras e em `url_fatura` (efeito do vínculo). É link da página hospedada do Asaas, validado por domínio, e não texto livre. Retirá-lo só das leituras não protegeria nada, porque ele entra nos efeitos. Se a evidência não puder levar esse link, a minimização terá de valer também para os efeitos, com o hash calculado sobre a forma minimizada.

**Comportamento novo aceito pelo Astra:** `SEM_DATA_PAGAMENTO` passou a exigir a pessoa mesmo que depois apareça uma data válida (mudança conservadora).

**Execução:** sem banco 57/57 nos arquivos do B-14; PG descartável (mesma autorização; cluster criado e removido, porta 55498 livre) 16/16 em 5 rodadas seguidas; 4 mutantes mortos (sem congelar a retenção: 3 falhas; sem tratar a meia-noite: 1; mascarando qualquer erro: 1; sem minimizar a leitura: 1); tsc e eslint limpos; CI local 28/28.

## Revisão do Astra da rodada de correção 2 (27/10/2026): APROVADO COM RESSALVAS para o incremento 4

Revisão sobre o diff `110e9885…` (39 hashes, HEAD e hash acumulado conferidos; 57/57, tsc, eslint e `git diff --check` reproduzidos; PG e mutantes lidos, não executados). Todos os achados anteriores estão FECHADOS: P1-1, P1 (retenção), P2 (meia-noite), P3 (descrição do estorno) e P3-6, este no recorte revisado.

Ressalvas para o incremento 4:
- **P3-R2-1 (novo):** a cobrança retida pode passar a REFUNDED ou CHARGEBACK_DISPUTE e só `situacao_provedor` muda. A fila de pedidos não mostra esse status, e a fila de cobranças (`lib/desenvolvedor/creditos.ts`:53/:59) exclui o registro. Correção: mostrar a situação e a última conferência da cobrança canônica na fila dos pedidos retidos, preservando o motivo da retenção.
- **Exportações novas:** `externalReference` (string de correlação) e a URL de `listarWebhooks` precisam ser consideradas em qualquer arquivo novo.
- **invoiceUrl:** aceito no artefato operacional restrito (inclusive `url_fatura`), com o hash fiel ao conteúdo aprovado. Se houver uma versão compartilhável da evidência, minimizar leituras e efeitos, mantendo a detecção de mudança por digest do valor original.
- **Pareceres sem achado:** a reconciliação continuar selecionando o retido é aceitável (rotação por `reconciliado_em`); o congelamento antes de estorno/disputa sem crédito é aceitável; o SAVEPOINT aninhado está correto.
- **Continuam pendentes:** a preservação do cron com serviços reais e a matriz completa da §3.3.1 no PG.

## Incremento 4 — entrada de produção, modos, inventário, fila e liberação (feito, 27/10/2026)

Arquivos novos:
- `scripts/recuperacao-pagamentos-producao.cjs` (+ `.test.cjs`, no CI): a entrada.
- `lib/assinatura/recuperacao-execucao.ts` (+ `.test.ts`): regras puras.
- `lib/assinatura/recuperacao-modos.ts`: os modos sobre uma conexão já conferida.
- `lib/creditos/fila.ts`: P3-R2-1.
- `lib/assinatura/recuperacao-modos.postgres.test.ts`: suíte no PG descartável, modelo 097, registrada em `regressao-v1-selecao.cjs`.

Alterados:
- `recuperacao-efeitos.ts` ganhou `efeitosPresentes`.
- `lib/desenvolvedor/creditos.ts` passou a usar `pedidosDaFila`.

**Entrada.** Modos por lista fechada de opções: `--fila`, `--janela --conferir|--recuperar`, `--restore --drenagem|--inventario|--liberacao`, `--restore --aplicar-caso=|--conferir-caso=`.
- **Alvo** (D-B14-1): a `DATABASE_URL` do serviço, confirmada pelo literal `KIDMAIS_B14_ALVO`.
  - Production e staging exigem o alvo exato, `RENDER=true` e o par serviço/provedor do ambiente; o local, só o descartável nomeado.
  - TLS obrigatório fora do local (`DATABASE_SSL=true`), conferido depois de conectar por `current_database()` e `pg_stat_ssl`.
- **Sessão:** `application_name = kidmais-recuperacao-b14`, `statement_timeout` de 60 s e `lock_timeout` de 5 s.
- **Trava global de sessão** (`pg_try_advisory_lock(1414, 1027)`), só do B-14: ocupada → 1. A posse é reconferida antes de cada caso e de cada COMMIT (TRAVA_PERDIDA → 1).
- **Paradas:** SIGTERM → 1; prazo total de 15 min → LIMITE_EXECUCAO → 3.
- **Matriz ramo × código × schema** (§3.8): o código no ar vem de `RENDER_GIT_COMMIT`, que tem de ser a `--candidata` exata ou uma base antiga da lista fechada `CODIGOS_ANTIGOS` (SHA completo; B-23: `00d3019a…` e `4ef9adb6…`). O prefixo vem de `--migracoes` (o CONFERIR do B-5), cruzado com os marcadores no banco; divergência → 1.
- **Backup** obrigatório nos modos que gravam (§3.9; D-B14-2/12).
- **Arquivos** em `/opt/render/project/src/data/b14/`: pasta 700, arquivos 600 criados com `wx` (nunca sobrescritos), só nomes simples.
- **Stdout** sanitizado (D-B14-3): só números, booleanos, ids opacos, datas e códigos. Cada execução deixa `execucao-<id>.json`.

**Modos.**
- **JANELA:**
  - as chaves locais são lidas num snapshot `REPEATABLE READ READ ONLY`;
  - cada caso roda numa transação própria e é proposto **duas vezes** (consistência por caso, §3.6 b): diferente → terceira leitura; diferente de novo → INCONCLUSIVO;
  - `--conferir`: sempre ROLLBACK;
  - `--recuperar`: COMMIT só do caso `PROPOSTA` sem recusa, com hash idêntico e depois de `parar()`;
  - código 0 só com cobertura completa e todo item RECONCILIADA ou preexistente igual à base;
  - a base é selada uma única vez (`--selar-base`, só de conferência completa) e comparada com `--base`/`--base-sha` (BASELINE_INVALIDA → 2).
- **RESTORE:**
  - **drenagem:** nenhuma sessão anterior ao reinício `R` fora das identificadas, e amostras 13 × 10 s sem sessão presa;
  - **inventário:**
    - exige a drenagem PASS do mesmo `R` e revalida;
    - uma transação RR desfeita no fim;
    - casos propostos duas vezes;
    - leitura remota por `dateCreated` e `paymentDate` (desde `--desde`), cada filtro duas vezes;
    - órfãs classificadas;
    - arquivo de casos com `evidenciaDoCaso` (sem a fotografia interna);
  - **`aplicar-caso`:** confere o hash informado contra o arquivo e o conteúdo, aplica em T2, faz COMMIT só se APLICADO e invalida liberações anteriores;
  - **`conferir-caso`:**
    - NAO_APLICADO quando a proposta recalculada tem o mesmo hash;
    - APLICADO quando os efeitos aprovados estão presentes pela chave natural (`efeitosPresentes`);
    - DIVERGENTE (1) nos demais casos;
  - **liberação** (§5): todo caso decidido, tudo SEM_EFEITO, órfãs decididas, cobertura completa ou aceita, fila 0 ou só `interrupted` (com as três exigências pós-reabertura); com o código antigo, a prova do cron `7ce0916f` (D-B14-18). Termina sempre em 2 (ou 3).
- **`relacionadoReconciliado`:** calculado pelo inventário. Evento de créditos → classe do pedido; de assinatura → classe da empresa no mesmo inventário.

**P3-R2-1 (revisão da rodada 2).** `pedidosDaFila` (`lib/creditos/fila.ts`) traz na fila do painel a situação e a última conferência da cobrança canônica, além de `retida_pela_pessoa`. O motivo da retenção continua igual.

**Decisões de implementação para o Astra conferir:**
- **D-I4-1:** inventário, `conferir-caso` e liberação usam uma transação REPEATABLE READ **sem** READ ONLY, sempre ROLLBACK. A proposta É o processamento normal num SAVEPOINT desfeito (§3.4), e o READ ONLY recusaria a primeira escrita. A enumeração das chaves, essa sim, é READ ONLY. Prova: digest de todas as tabelas da lista fechada igual antes e depois.
- **D-I4-2:** a JANELA usa o caminho de casos (mesmos serviços, provedor da lista fechada), não `executarCiclo`.
  - A enumeração do ciclo do cron não cobre a §3.6 (todos os pedidos, todas as cobranças, eventos da janela).
  - As opções `provedorEfetivo`/`antesDoCommit` do incremento 1 ficam no `executarCiclo`, sem uso pelo B-14, e o teste de preservação continua.
  - Remover essas opções é decisão do Astra.
- **D-I4-3:** a consistência é por caso (a proposta inteira, local e remota, duas vezes), o que cobre as listas que o próprio serviço lê. As listas por data do RESTORE são lidas sempre duas vezes, não só quando têm mais de uma página.
- **D-I4-4:** as migrations vêm de `--migracoes` (o CONFERIR do B-5), cruzadas com marcadores por presença (089, 090, 091, 093, 094, 095, 096, 097). A 092, a 099 e a 100 só trocam funções e não têm marcador: dependem do CONFERIR. No PG descartável, o modelo 097 tem a 091; para cair na lista, o teste declara a 100 (P11).
- **D-I4-5:** o backup é o manifesto JSON do export (`banco`, `sha256`, `validado: true`, `concluido_em` há no máximo 24 h e, no RESTORE, posterior a `--restaurado-em`). O formato final é o do export verificável do B-4, a fixar na homologação.
- **D-I4-6:** a drenagem (a), com os metadados de instâncias do Render, fica com o bloco de Shell (A-B14-C). A ferramenta faz (b) e (c), e inventário e liberação exigem o arquivo PASS do mesmo `R`.
- **D-I4-7:** `conferir-caso` não usa `--execucao`. A localização é por chave natural e conteúdo (a auditoria da ferramenta traz o caso), e um DELETE aprovado não é localizável, então dá DIVERGENTE.
- **D-I4-8:** `aplicar-caso` só localiza eventos ainda PENDENTE/FALHOU (os da janela já processados não geram proposta com efeito).
- **D-I4-9:** um evento sem empresa resolvível vai para a pessoa e bloqueia a liberação até ser resolvido fora da ferramenta.
  Achado do H7 (29/10) e revisão do Astra (P2-1, 30/10): a "resolução" é registrada nas decisões, em `eventosSemEmpresa`, por
  evento: `SEM_EFEITO_COMPROVADO` (investigado no provedor, sem efeito KidMais) ou `TRATADO_FORA` (tratamento externo
  concluído), com `evidencia` (10 a 500 caracteres, uma linha, sem dado pessoal). O inventário grava, por evento, o contexto
  (tipo, situação, recebimento, motivo; referências do Asaas só no arquivo restrito); decidir exige esse contexto no mesmo
  arquivo (digest). Evento do inventário sem decisão → recusa `EVENTO_SEM_EMPRESA_DO_INVENTARIO_SEM_DECISAO`; evento novo
  depois do inventário → bloqueio `EVENTO_SEM_EMPRESA_SEM_DECISAO`. Risco assumido sem investigação não é disposição aceita.
  A JANELA continua contando esses eventos como pendência.
- **D-I4-10:** com o código antigo, o SEM_EFEITO sob as regras da candidata é evidência complementar e não bloqueia. A prova é o cron antigo.

**Execução:** sem banco 84/84 nos arquivos do B-14 (13 novos das regras, 7 da entrada); PG descartável (mesma autorização; cluster criado e removido, porta 55498 livre): as duas suítes do B-14 23/23 em 5 rodadas seguidas (a nova 7/7; uma falha intermitente de TESTE — arquivo de drenagem escolhido pela ordem do nome — achada nas rodadas e corrigida); 13 mutantes mortos (RESTORE devolvendo 0, código 3 virando 2, aplicar sem conferir o hash, "nenhuma ação" com efeito aceita, liberação não invalidada, drenagem não exigida, conferir-caso sem pré-condição, efeitos sempre presentes, inventário com aplicação, lista instável aceita, fila sem SEQUENTIALLY, sem trava global, sem conferir marcadores); tsc e eslint limpos; CI local 28/28 (check:v1:static 3836).

**Fora deste incremento:**
- o empacotador da árvore e os blocos de Shell em PTY real (incremento 5);
- os prefixos P0a…P11 em PG (cada linha da matriz);
- a matriz completa da §3.3.1;
- o cron com serviços reais;
- a homologação em staging;
- `docs/RECUPERACAO_PAGAMENTOS_B14.md`.

## Revisão do Astra do incremento 4 (27/10/2026): REPROVADO → rodada de correção 1 (feita)

Revisão sobre o diff `5c26563c…` (47 hashes conferidos). Veredito: REPROVADO para o incremento 5, com 8 P2; P3-R2-1 FECHADO. D-I4-1..6 e 8..10 foram aceitos (alguns com observação); D-I4-7 não foi aceito como implementado.

| Achado | Correção | Prova |
| --- | --- | --- |
| **P2-1** cobrança não canônica só contada, nunca lida sem evento | Caso próprio `COBRANCA` (cada `ia_credito_cobrancas` não canônica), processado por `processarExtra` pelo mesmo ponto do webhook (`processarEventoCreditos`). Nunca é comprovado automaticamente (`COBRANCA_NAO_CANONICA`); existe desde P7 na base | PG: extra paga sem evento vira `PROPOSTA` com a recusa `SERVICO:PAGAMENTO_DUPLICADO`, não é gravada pela JANELA e aparece no inventário do RESTORE |
| **P2-2** `conferir-caso` não achava o evento concluído pela própria aplicação | Localização por identidade direto no banco (sha-256 no SQL), sem janela nem limite. A aplicação só aceita evento PENDENTE/FALHOU (D-I4-8); a conferência acha também o concluído | PG: aplicar evento → PROCESSADO → `conferir-caso` APLICADO; repetir a aplicação → `CASO_NAO_LOCALIZADO` |
| **P2-3** auditoria histórica dava falso APLICADO | `efeitosPresentes` exige a prova da aplicação: INSERT com instante gerado ≥ início registrado (ao menos um) e, na auditoria, `request_id` = execução da aplicação; UPDATE com instantes gerados ≥ início; símbolos resolvidos para o id da linha inserida; DELETE não localizável. `conferir-caso` exige `--execucao` (registro `aplicacao-<execução>.json`); sem registro → DIVERGENTE | unitário: contraexemplo do Astra (só a fotografia anterior → falso), outra execução, início posterior, lote/lançamento; PG: sem registro → DIVERGENTE; registro com início posterior → DIVERGENTE |
| **P2-4** decisões não presas ao inventário | Decisões formato 2: `inventario` (uuid), `digestInventario` (hash canônico do arquivo de casos), por caso `{ decisao, proposta }` com o hash apresentado, `retencaoAceita`. `conferirVinculoDasDecisoes`: arquivo existe, formato, digest, mesmo schema, código no ar e reinício, cada caso e órfã do inventário decididos e nada fora dele → senão código 1 | unitário (8 recusas); PG: inventário inexistente, digest alterado, inventário do código antigo com a candidata no ar |
| **P2-5** COMMIT indeterminado podia deixar liberação válida | `aplicar-caso` invalida as liberações e grava `aplicacao-<execução>.json` (início no relógio do banco, `COMMIT_TENTADO`) ANTES de tentar o COMMIT; falha em qualquer um → ROLLBACK e recusa | PG: registro impossível → `REGISTRO_DA_APLICACAO_FALHOU`, nada gravado, liberação já invalidada |
| **P2-6** paradas não conferidas antes da evidência final | `parar()` na entrada de todo modo, depois das listagens remotas, depois da fila e imediatamente antes de gravar a liberação/inventário | PG: SIGTERM chegando durante a leitura da fila → INTERROMPIDA (1), sem registro de liberação |
| **P2-7** tabela única de códigos | Composição só por `codigoFinal`/`codigoDaParada`: drenagem com prazo → 3; fila ilegível → cobertura (3); falha absorvida pelo evento (`{situacao:'FALHOU', motivo}`) conta via `falhaDoCaso`; aplicação DIVERGENTE na JANELA → recusa técnica (1, `HASH_DIVERGENTE`) | PG: drenagem 3/1; liberação com fila fora → 3; JANELA com leitura que muda entre proposta e aplicação → 1, nada gravado; evento com provedor fora → 3 e inconclusivo |
| **P2-8** retenção acima de 14 dias | A drenagem exige `--contencao-desde` (início da manutenção, ≤ reinício) e o registra; a liberação calcula Tf − início e, acima de 14 dias, exige `retencaoAceita` (o aceite de cobertura não serve); a limitação vai para o registro | unitário; PG: 15 dias → BLOQUEADA sem aceite, LIBERADA com aceite e `limitacoes: [RETENCAO_ACIMA_DE_14_DIAS]` |

**Observações da revisão também tratadas:** pasta de evidências forçada a 700 mesmo se já existia (POSIX); stdout por lista estrita de formas (códigos, sha-256, uuid, ISO, prefixos, nomes de arquivo da ferramenta) — palavra comum vira OUTRO. Sequências consumidas pelo inventário não voltam com o ROLLBACK (D-I4-1): os ids novos são símbolos na proposta; declarado.

**Pendências mantidas (não são desta rodada):** remover as opções sem consumidor do `executarCiclo` em alteração própria (D-I4-2); contrato do manifesto com o export do B-4 (D-I4-5); prova Render da drenagem (a) no bloco (D-I4-6); P11 real com a 100 aplicada (D-I4-4).

**Execução:** sem banco 87/87 nos arquivos do B-14; PG descartável (mesma autorização; cluster criado e removido, porta 55498 livre): as duas suítes 27/27 em 5 rodadas seguidas (a dos modos 11/11); 14 mutantes desta rodada mortos — um por achado, e para o P2-6 o mutante que tira todas as conferências de parada posteriores aos casos (tirar só a da fila sobrevive porque a conferência imediatamente antes de gravar pega o mesmo sinal, redundância intencional); tsc e eslint limpos; CI local 28/28 (check:v1:static 3839).

## Revisão do Astra da rodada 1 do incremento 4 (27/10/2026): REPROVADO → rodada de correção 2 (feita)

Revisão sobre o diff `aa28b0a6…` (47 hashes conferidos). Veredito: REPROVADO para o incremento 5.
- **FECHADOS:** P2-1, P2-2, P2-4, P2-5, P2-7 e P2-8.
- **PARCIAIS:** P2-3 e P2-6.
- **Novos achados:** P2-R1-1, P2-R1-2 e P2-R1-3 (todos P2).
- **Pareceres:**
  - o digest integral do arquivo de casos é âncora adequada;
  - `--contencao-desde` atende ao contrato como declaração persistida;
  - o sha-256 no SQL é compatível (o custo da varredura não foi medido).

| Achado | Correção | Prova |
| --- | --- | --- |
| **P2-R1-1** efeitos de outra execução comprovavam a original: o caso de cobrança extra só faz UPDATE, sem auditoria | **Comprovante transacional.** Na MESMA transação dos efeitos, antes de tentar o COMMIT, `aplicar-caso` grava uma linha em `auditoria` (tabela só de inserção) com `acao = RECUPERACAO_B14_CASO_APLICADO`, `request_id` = execução e `dados_depois = {caso, hash, execucao}`. A linha existe se, e só se, aquele COMMIT confirmou. `conferir-caso` só devolve APLICADO com o comprovante da execução informada E os efeitos presentes | PG: a execução A registra a tentativa e não confirma; a B aplica a mesma proposta; conferir A → DIVERGENTE; conferir B → APLICADO, com o comprovante (caso, hash) na auditoria |
| **P2-R1-2** o `now()` da auditoria podia ser anterior ao início registrado | O início é `now()` (início da transação), o mesmo marco do DEFAULT da auditoria; `clock_timestamp()` é sempre ≥. A prova de identidade é o comprovante; o instante é um filtro adicional | PG: início registrado = `min(criado_em)` das auditorias da execução, comparado no banco com precisão de microssegundo |
| **P2-R1-3** evidência emitida depois de uma parada | **Drenagem:** parada conferida depois da última amostra, antes de gravar o PASS. **`conferir-caso`:** na entrada e antes do resultado. **Inventário:** qualquer parada (inclusive prazo depois das listagens) encerra sem arquivo de casos, com 3 para o prazo e 1 para SIGTERM/trava | PG: SIGTERM na última amostra → INTERROMPIDA sem arquivo; `conferir-caso` com SIGTERM na entrada → INTERROMPIDA, com prazo no fim → 3; prazo esgotado depois das listagens do inventário → 3 sem arquivo |

**Execução:** sem banco 87/87; PG descartável (mesma autorização; cluster criado e removido, porta 55498 livre): as duas suítes 27/27 em 5 rodadas seguidas; 6 mutantes desta rodada mortos (conferência sem comprovante, aplicação sem gravar o comprovante, início pelo relógio em vez da transação, drenagem/conferir-caso sem parada final, inventário gravando com parada); tsc e eslint limpos; CI local 28/28 (check:v1:static 3839).

## Revisão do Astra da rodada 2 do incremento 4 (27/10/2026): REPROVADO → rodada de correção 3 (feita)

Revisão sobre o diff `1afa1679…` (47 hashes conferidos). Veredito: REPROVADO para o incremento 5.
- **FECHADOS:** P2-3, P2-R1-1 e P2-R1-2.
- **PARCIAIS:** P2-6 e P2-R1-3.
- **Novos:** P2-R2-1 e P2-R2-2.
- **Pareceres do Astra:**
  - comprovante e efeitos confirmam juntos;
  - o comprovante muda a fotografia da empresa (propostas anteriores dela podem pedir novo inventário), mas não cria efeito nem impede SEM_EFEITO;
  - a auditoria aceita a ação nova sem migration;
  - o filtro de instante não rejeita UPDATE legítimo.

| Achado | Correção | Prova |
| --- | --- | --- |
| **P2-R2-1** `parar()` do script devolvia "continuar" quando o sinal ou o prazo chegavam DURANTE a consulta da trava | `criarControle` (exportado): SIGTERM e prazo são reavaliados DEPOIS da consulta a `pg_locks`. Ordem: SIGTERM e trava perdida (1) antes do prazo (3) | Unitário: sinal durante a consulta → SIGTERM; prazo durante a consulta → LIMITE_EXECUCAO; trava perdida e consulta com erro → TRAVA_PERDIDA. O cenário do Astra com a drenagem e o controle real (sinal na última consulta) → INTERROMPIDA, sem arquivo |
| **P2-R2-2** a aplicação confirmava depois de uma parada ocorrida durante a gravação do comprovante | `parar()` de novo depois do comprovante e antes da invalidação, do registro e do COMMIT; com parada, ROLLBACK explícito nesse ramo e só então `ParadaExecucao` | PG: parada na 3ª conferência (depois do comprovante) → rejeita com SIGTERM; digest igual (nem efeitos nem comprovante); nenhum registro de aplicação |

**Execução:** sem banco 88/88; PG descartável (mesma autorização; cluster criado e removido, porta 55498 livre): as duas suítes 27/27 em 5 rodadas seguidas; 3 mutantes desta rodada mortos (SIGTERM e prazo não reavaliados depois da consulta da trava; sem parada depois do comprovante); tsc e eslint limpos; CI local 28/28 (check:v1:static 3839).

## Revisão do Astra da rodada 3 do incremento 4 (27/10/2026): REPROVADO → rodada de correção 4 (feita)

Revisão sobre o diff `51ae3a5d…` (47 hashes conferidos). Veredito: REPROVADO para o incremento 5, com um P2. P2-6, P2-R1-3 e P2-R2-2 foram FECHADOS; P2-R2-1 ficou PARCIAL. O Astra confirmou que não resta `await` entre a última conferência e a evidência ou o COMMIT em nenhum modo.

| Achado | Correção | Prova |
| --- | --- | --- |
| **P2-R3-1** com o prazo vencido, o controle retornava antes de consultar a trava: a trava perdida saía como LIMITE_EXECUCAO (3, encerrável com aceite) em vez de recusa técnica (1) | `criarControle`: só o SIGTERM retorna sem consultar. A trava é sempre consultada; depois da consulta, a prioridade é SIGTERM, depois trava perdida ou consulta com erro (1), e por último o prazo (3) | Unitário: prazo vencido antes + trava ausente → TRAVA_PERDIDA, com a consulta feita; prazo vencido + consulta rejeitada → TRAVA_PERDIDA; prazo vencido + trava ok → LIMITE_EXECUCAO; SIGTERM imediato, sem consulta. O mutante que devolve o retorno antecipado pelo prazo foi morto |

**Execução:** sem banco 89/89; PG descartável (mesma autorização; cluster criado e removido, porta 55498 livre): as duas suítes 27/27 em 2 rodadas (o teste da entrada real usa o controle); mutante "prazo antes da trava" morto; eslint limpo; CI local 28/28 (check:v1:static 3839).

## Revisão do Astra da rodada 4 do incremento 4 (27/10/2026): REPROVADO → rodada de correção 5 (feita)

Revisão sobre o diff `5471ffb6…`: REPROVADO para o incremento 5 com um P2. P2-R2-1 e P2-R3-1 foram FECHADOS; a prioridade foi validada em 27 combinações em memória.

| Achado | Correção | Prova |
| --- | --- | --- |
| **P2-R4-1** a consulta da trava sem resposta prendia a parada: `statement_timeout` limita o servidor, não a entrega da resposta, e o cliente não tem `query_timeout` | `criarControle`: a espera pela consulta tem limite NO PROCESSO (`LIMITE_CONSULTA_TRAVA_MS` = 10 s) e é interrompida por SIGTERM (vigia a cada 100 ms). Em qualquer dos dois, a conexão é DESCARTADA (`client.connection.stream.destroy()`: o servidor desfaz a transação aberta) e a parada é 1 — SIGTERM ou TRAVA_SEM_RESPOSTA, nunca cobertura. `descartada()` informa o motivo; o encerramento do CLI usa esse motivo (o ROLLBACK seguinte, numa conexão destruída, não o troca) | Unitário: o cenário do Astra (prazo vencido, consulta pendente, SIGTERM durante a espera) → SIGTERM em < 2 s sem a resposta, conexão descartada uma vez, chamadas seguintes sem nova consulta; sem sinal, o limite → TRAVA_SEM_RESPOSTA (fora de PARADAS_DE_COBERTURA); resposta normal → sem descarte |

**Limitação declarada:** as demais consultas da ferramenta continuam limitadas pelo `statement_timeout` (60 s) e pelo `lock_timeout` (5 s). A garantia de término no processo cobre a conferência de parada, que é o ponto que encerra o trabalho.

**Execução:** sem banco 90/90; PG descartável (mesma autorização; cluster criado e removido, porta 55498 livre): as duas suítes 27/27 em 2 rodadas (o teste da entrada real usa o controle); 4 mutantes mortos (SIGTERM não interrompe a espera; sem limite no processo — o teste trava e estoura o tempo; sem descartar a conexão; limite vira cobertura); eslint limpo; CI local 28/28 (check:v1:static 3839).

## Revisão do Astra da rodada 5 do incremento 4 (27/10/2026): APROVADO COM RESSALVAS para o incremento 5

Revisão sobre o diff `079d05cf…`, com hashes, HEAD e branch conferidos. P2-R4-1 FECHADO; nenhum achado bloqueante novo. O Astra reproduziu em memória, com o `pg 8.23.0` instalado, quatro combinações de sinal e limite, com e sem ROLLBACK, encerrando em 31–39 ms. Não encontrou caminho de COMMIT ou de evidência depois do descarte.

Ressalvas (alcance, para o incremento 5 e a homologação):
- **10 s** é um limite conservador para a consulta da trava, mas não foi medido sob carga.
- **As demais consultas** não têm garantia de término no cliente: o encerramento global em tempo limitado não está comprovado.
- **Destruir o soquete** não comprova rollback imediato no servidor, que depende de ele detectar o fim da sessão. Medir na homologação, por exemplo com `pg_stat_activity` depois do descarte.

## Incremento 5 — árvore mínima e blocos de Shell (feito, 27/10/2026)

Arquivos novos:
- `scripts/arvore-recuperacao-b14.cjs`: o empacotador.
- `scripts/bloco-shell-recuperacao-b14.cjs`: o gerador dos blocos.
- `scripts/bloco-shell-recuperacao-b14.test.cjs`: os testes, no CI.

Alterado: `scripts/recuperacao-pagamentos-producao.cjs`, que agora publica o modo em maiúsculas (ver abaixo).

**Árvore mínima** (D-B14-13):
- Fecho das dependências de EXECUÇÃO a partir da entrada: imports estáticos, dinâmicos e de efeito, requires e reexportações (`export { … } from`, `export * from`). Ficam de fora `import type` e `export type`, que o strip-types apaga.
- Conteúdo LF (CR recusado), sha-256 por arquivo, `SHA256SUMS` no formato do sha256sum e o hash da árvore (sha do SHA256SUMS).
- Leva um `package.json` próprio (privado, sem "type", como o do repositório).
- Externos só por lista fechada: `pg` e `zod`, do node_modules do serviço; qualquer outro recusa.
- Hoje: 45 arquivos, cerca de 610 KB. Runtime exigido: Node 22.23.2 (engines), pg 8.23.0 e zod 4.5.4.

**Blocos** (padrão dos blocos de produção de 18–20/10):
- **Estrutura comum:** `bind` antes da guarda, guarda de `RENDER_SERVICE_ID` antes de qualquer leitura ou gravação, corpo em subshell e `CODIGO_SAIDA_BLOCO=<n>` (0/1/2/3 da entrada; 4 do bloco). ASCII puro, no máximo 32 KB por bloco. Há variantes de staging (homologação) e de production.
- **`ENTREGA-1..12`:** as partes da árvore em gzip+base64.
  - Cada parte confere o sha de TODOS os seus arquivos num temporário e recusa presente-diferente; só então grava na pasta própria `/opt/render/project/src/.kidmais-recuperacao-b14/<árvore>`, fora de `scripts/` e `lib/` do deploy, efêmera.
  - Colar de novo é idempotente (`JA_PRESENTE`).
  - A pasta fica DENTRO da raiz do deploy de propósito: a resolução ESM de `zod` e a de `pg` sobem os diretórios até o `node_modules` do serviço (o NODE_PATH não vale para ESM).
- **`ENTREGA-CONFERIR`:**
  - grava o `SHA256SUMS` fixado e confere a árvore inteira com `sha256sum -c`, sem arquivo a mais ou a menos;
  - confere o runtime;
  - informa a equivalência de `lib/` com o deploy;
  - termina com `ARVORE_OK`.
- **Blocos de operação** (`FILA`, `DRENAGEM`, `CONFERIR`, `RECUPERAR`, `INVENTARIO`, `APLICAR-CASO`, `CONFERIR-CASO`, `LIBERACAO`):
  - reconferem a árvore e o runtime;
  - na JANELA, exigem `lib/` idêntico ao deploy (§3.8; `JANELA_EXIGE_LIB_IDENTICA_AO_DEPLOY`); o RESTORE admite o código antigo;
  - rodam a entrada a partir da árvore, com o alvo literal (`KIDMAIS_B14_ALVO`) e a candidata fixados no bloco;
  - os valores de cada execução vêm de `KIDMAIS_B14_*` exportadas antes de colar, validadas por lista de caracteres (sem espaço, aspas ou metacaracteres); a entrada valida cada formato de novo;
  - evidências em `/opt/render/project/src/data/b14`.
- **`LIMPEZA`:** remove só os arquivos da árvore cujo sha confere (divergente preservado) e os arquivos de casos `casos-*.json` (D-B14-8); as demais evidências ficam.
- **Gerar:** `node scripts/bloco-shell-recuperacao-b14.cjs <staging|production> <candidata-sha40> <pasta-de-saida-inexistente>` imprime sha e bytes de cada bloco.

**Defeitos achados pelos testes deste incremento (corrigidos):**
1. **Reexportações fora do fecho.** O empacotador não seguia `export { ROTA_AJUDA } from './rota.ts'` (em `lib/suporte/canais.ts`). A árvore entregue falhava fora do checkout com `ERR_MODULE_NOT_FOUND`, mascarado pela saída como `ERRO_INTERNO`. Agora as reexportações entram, com teste dedicado.
2. **Modo saindo como `OUTRO`.** A saída estrita da rodada 1 transformava o nome do modo em minúsculas (`fila`, `janela-conferir`) em `OUTRO` nas recusas da entrada. Agora a entrada publica o modo em maiúsculas (`FILA`, `JANELA_CONFERIR`).

**Testes:**
- Estrutura de todos os blocos (staging e production): tamanho, ASCII, guarda, subshell, código impresso, sem segredo, escrita marcada, alvo e candidata fixados.
- Execução real com bash num deploy temporário FORA do clone (node_modules por junção):
  - serviço errado → nada executado;
  - entrega parcial → `ARVORE_DIVERGENTE`;
  - completa → `ARVORE_OK` com equivalência total; parte colada de novo → `JA_PRESENTE`;
  - FILA e CONFERIR a partir da árvore → a entrada carrega todos os módulos e recusa com `ASAAS_DESLIGADO` (1);
  - variáveis ausentes ou com injeção → 4 (nada criado);
  - `lib/` do deploy diferente → JANELA recusa (4) e RESTORE segue;
  - runtime divergente → 4;
  - árvore adulterada ou com arquivo a mais → 4;
  - LIMPEZA → árvore e casos removidos, o resto preservado.
- Colagem truncada em bash interativo: nada gravado, sem código.
- **PTY real** (`script` do util-linux: MSYS2 no Windows, nativo no Linux do CI; sem ele o teste é pulado com motivo): a maior parte da entrega (cerca de 29 KB) e a ENTREGA-CONFERIR coladas com bracketed paste → `CODIGO_SAIDA_BLOCO=0` nas duas; o shell do operador continua vivo e sem `set -e/-u` herdado.

**Execução:** testes dos blocos 5/5 (inclui PTY real com o script do MSYS2) e da entrada 10/10; sem banco 90/90; PG descartável (mesma autorização; cluster criado e removido, porta 55498 livre) as duas suítes 27/27; 5 mutantes MORTOS numa CÓPIA ISOLADA, removida depois (empacotador sem reexportações, operação sem conferir a árvore, JANELA sem lib/ idêntica, variável sem lista de caracteres, sem conferir o runtime); tsc e eslint limpos; CI local 28/28 (o passo dos scripts subiu de 87 para 92 com os blocos).

**Ainda fora:**
- homologação em staging/sandbox (autorização própria), incluindo a medida das ressalvas do incremento 4 (limite de 10 s sob carga, rollback no servidor depois do descarte);
- os prefixos P0a…P11 em PG;
- a matriz completa da §3.3.1;
- o cron com serviços reais;
- `docs/RECUPERACAO_PAGAMENTOS_B14.md` (procedimento operacional);
- remover as opções sem consumidor do `executarCiclo` (D-I4-2).

### Incremento 5 — rodada de correção 1 (revisão do Astra: REPROVADO; feito, 27/10/2026)

- **P1 — alvo divergente pela query da URL.** O `pg` relê `host`, `port` e outros parâmetros da query da `DATABASE_URL` e os faz valer sobre o host validado. Agora:
  - a conexão é montada por campos já validados (host, porta, banco, usuário, senha, TLS), sem `connectionString`;
  - qualquer parâmetro na query que não seja `sslmode` recusa antes de conectar (`ALVO_COM_PARAMETRO_NA_URL`);
  - o teste confere os parâmetros EFETIVOS do `pg` (`new Client(conexao).connectionParameters`) contra o alvo, e recusa `?host=other.invalid&port=5433` e variantes.
- **P2 — o CONFERIR bloqueava a linha de base E0.** Na E0 (P0a/P0b) o código antigo está no ar, logo `lib/` difere da árvore por definição. Novo bloco `CONFERIR-E0`:
  - só roda se `RENDER_GIT_COMMIT` existe e é diferente da candidata (`CONFERIR_E0_SO_COM_CODIGO_ANTIGO`, código 4);
  - a equivalência de `lib/` é só informativa;
  - `CONFERIR` e `RECUPERAR` seguem rigorosos (`JANELA_EXIGE_LIB_IDENTICA_AO_DEPLOY`), assim como a JANELA depois da promoção.
- **P3 — fecho por expressão regular.** O empacotador passa a usar a árvore sintática do TypeScript (só no gerador local; a árvore entregue não leva o compilador):
  - fica de fora só `import type` e `export type … from`; `import { type X }` carrega o módulo e entra;
  - comentários e strings não contam (o contraexemplo do Astra, comentário depois de `import type`, está nos testes);
  - `import()`/`require()` com argumento que não seja literal recusa (`DEPENDENCIA_NAO_DETERMINAVEL`).
  - A árvore continua com 45 arquivos.
- **P3 — teste de PTY fraco.** Agora exige nem `-e` nem `-u` nas opções do shell do operador (`!/[eu]/`), e que a PRIMEIRA colagem tenha saído de fato com bracketed paste ativo.
- **Observação — LIMPEZA.** Ela apaga TODOS os `casos-*.json`, por isso agora exige `export KIDMAIS_B14_ENCERRAMENTO=SIM` (exatamente `SIM`); sem isso, código 4 e nada removido.
- **Observação — "fora do checkout".** A pasta da árvore fica DENTRO da raiz do deploy (`/opt/render/project/src/.kidmais-recuperacao-b14/<árvore>`), mas fora dos arquivos implantados (`scripts/`, `lib/`), e é efêmera. "Fora do checkout" nos testes quer dizer: a árvore roda sem nenhum arquivo do repositório além dela mesma. As únicas dependências de execução fora dela são declaradas e conferidas pelo bloco: Node 22.23.2, `pg` 8.23.0 e `zod` 4.5.4 do `node_modules` do serviço.

**Execução:** testes dos blocos 5/5 (inclui CONFERIR-E0, trava da LIMPEZA e PTY real com bracketed paste exigido) e da entrada 10/10; PG descartável (mesma autorização; cluster criado e removido, porta 55498 livre) as duas suítes 27/27; 7 mutantes MORTOS numa CÓPIA ISOLADA, removida depois (query da URL aceita, URL repassada ao pg, import type no fecho, import() não literal aceito, E0 sem a guarda, E0 rigorosa, LIMPEZA sem a trava); eslint limpo; CI local 28/28 (tsc e static incluídos). Árvore 5847b1d1… (45 arquivos).

### Incremento 5 — rodada de correção 2 (revisão da rodada 1: REPROVADO; feito, 28/10/2026)

- **P2-R1-1 — credenciais e opções herdadas pelo pg.** O `pg` completa todo campo vazio com `PG<CAMPO>` do ambiente (`PGUSER`, `PGPASSWORD`, `PGOPTIONS`, `PGPORT`, `PGSSLMODE`, `PGAPPNAME`…). E `NODE_PG_FORCE_NATIVE` troca o driver pelo libpq, que lê ainda mais variáveis.
  - Qualquer `PG*` ou `NODE_PG_FORCE_NATIVE` PRESENTE recusa com `AMBIENTE_COM_VARIAVEL_PG`. Isso vale tanto no `env` recebido quanto no `process.env`, que é o que o `pg` de fato lê. Nada é neutralizado em silêncio, e só o código sai na saída, nunca o valor.
  - Credenciais explícitas: usuário sempre; senha obrigatória fora do local (`ALVO_SEM_CREDENCIAL`). O cluster descartável usa trust, e sem `PG*` a senha vazia não é completada por nada.
  - O teste prova o vetor: com `PGUSER`/`PGOPTIONS` no processo, o `pg` herda os dois em campo vazio. Depois prova as recusas e o `main` recusando com `PGOPTIONS` só no `process.env`.
- **P2-R1-2 — porta zero.** A porta precisa ser um inteiro entre 1 e 65535 (`ALVO_INVALIDO`). O teste confere que a porta efetiva do `pg` é a validada.
- **P3-R1-3 — carregadores indiretos.** O fecho recusa (`DEPENDENCIA_NAO_DETERMINAVEL`):
  - `require` fora da chamada direta (alias, argumento); `require.main`, `require.resolve` e `require.cache` seguem admitidos, porque não carregam módulo;
  - `module.require`, `createRequire`, `_load`, `dlopen` e `import.meta.resolve`, em qualquer posição.
  - A árvore atual não tem nenhuma dessas formas e continua com 45 arquivos.
- **Pontos especiais respondidos pelo Astra, sem mudança:**
  - O caminho da URL não tem bypass.
  - O E0 com commit arbitrário passa na guarda do bloco, mas a entrada o recusa antes do `Client`.
  - O harness de PTY parte de ambiente limpo e não testa opções herdadas antes da colagem.

**Execução:** entrada 11/11 (+1 teste do main com PGOPTIONS só no process.env); blocos 5/5, nenhum pulado (PTY real incluído); PG descartável (mesma autorização; cluster criado e removido, porta 55498 livre) as duas suítes 27/27; 8 mutantes MORTOS numa CÓPIA ISOLADA, removida depois (PG* do env aceitas, process.env não conferido, NODE_PG_FORCE_NATIVE ignorada, credencial vazia aceita, porta 0 aceita, alias de require, createRequire/_load/dlopen, import.meta.resolve); eslint limpo; CI local 28/28 (passo 4 com 93 testes; tsc e static incluídos). Árvore 5ca4db2b… (45 arquivos).

### Incremento 5 — ressalvas P3 da aprovação (feito, 28/10/2026)

- **AST: colchetes e `require.call`.** As três provas do Astra (`module['require'](…)`, `require('node:module')['createRequire'](…)` e `require.call(null, …)`) agora recusam com `DEPENDENCIA_NAO_DETERMINAVEL`. Também recusam:
  - chave literal perigosa entre colchetes: `require`, `createRequire`, `_load`, `dlopen`, `resolve`, `call`, `apply` e `bind`;
  - chave não literal sobre `module`, `require`, `process`, `Module`, `globalThis` ou `import.meta`;
  - de `require.x`, tudo que não seja `main`, `resolve` ou `cache`.
  - Colchetes em outros objetos (`obj[k]`, `mapa['chave']`) seguem admitidos. A árvore atual passa e continua com 45 arquivos.
- **P3-R2-1: comentário do pgpass corrigido** (`validarAlvo`, `recuperacao-pagamentos-producao.cjs`). No local sem senha, se o servidor pedir senha, o `pg` 8 ainda consulta o pgpass padrão; o `PGPASSFILE` é recusado com as demais `PG*`. Em production e staging a senha é obrigatória.

**Execução:** entrada 11/11 e blocos 5/5 (nenhum pulado, PTY real); 4 mutantes MORTOS numa CÓPIA ISOLADA, removida depois (colchetes não inspecionados, require.call/apply/bind admitidos, chave não literal em base sensível, chave literal require); eslint limpo; CI local 28/28. PG não repetido: a entrada só mudou em comentário. Árvore bd65d273… (45 arquivos, mesma lista).

## Prefixo de homologação PH e mudança de base (D-HML-1 = B; feito, 28/10/2026)

**Base nova.** O trabalho saiu do clone `kidmais-manager-recuperacao-pagamentos-b14-20261027` (base `eb1af426`, 30 commits atrás do staging) para `kidmais-manager-recuperacao-pagamentos-b14-20261028`, branch `codex/recuperacao-pagamentos-b14-20261028`, sobre o staging `db8d083b` (#258). Sem commit.
- O diff aplicou limpo com `git apply --3way`, e os 34 arquivos novos foram copiados.
- A sobreposição era só em `ci.yml` e `regressao-v1-selecao.cjs`, ambos com acréscimos.
- A árvore mínima ficou idêntica: `bd65d273…`, 45 arquivos.
- O clone antigo fica intacto como referência.

**Decisão.** A rev. 1 do pedido de homologação partia de uma premissa errada (HB-2). Pela D-ESC-3 = (a), a lista P0a…P11 é exatamente a cadeia de production. O staging tem 102, 103 e 105 aplicadas, e o código de 104/106. Felipe decidiu, em 28/10, a opção B: um prefixo de homologação só em sandbox.

**Código:**
- **`lib/assinatura/recuperacao-baseline.ts`**
  - `NEUTRAS_HOMOLOGACAO` = 102–106.
  - `prefixoDoSchema(aplicadas, ambiente = 'producao')` devolve `PH` (índice do P11) só quando `ambiente === 'sandbox'` e o schema é o P11 completo mais um subconjunto não vazio das neutras. As 31 impressões possíveis são pré-calculadas.
  - Production nunca admite `PH`, e o padrão é production.
  - `validarBase(..., ambiente)`: base `PH` só em sandbox, com impressão de P11 + neutras. Uma base P11 confere num schema PH, e o inverso também.
- **`lib/assinatura/recuperacao-execucao.ts`**
  - `MARCADORES_NEUTROS` (102 tabela `agenda_salao_itens_catalogo`, 104 função `kidmais104_hash_versao_imutavel`, 105 tabela `mcp_oauth_clientes`, 106 função `kidmais106_salao_preferido_escopo`), conferidos só em sandbox por `marcadoresDoAmbiente`. Production confere exatamente os mesmos marcadores de antes.
  - A 103 só insere uma linha e por isso não tem marcador; vale a declaração do CONFERIR.
- **`lib/assinatura/recuperacao-modos.ts` e a entrada:** o ambiente do alvo chega a `schemaAtual`, a `validarBase`, à checagem de prefixo da entrada e aos marcadores.
- **`scripts/recuperacao-neutras-b14.test.cjs`** (novo, no CI), teste estático sem banco:
  - o conteúdo de cada neutra está fixado por sha (LF);
  - sem comentários e literais, nenhuma instrução altera, indexa, dá gatilho, regra, política ou permissão a uma tabela que a árvore usa;
  - nenhuma função criada ou substituída aparece na árvore, fora do bloco de marcadores;
  - a única ligação admitida é REFERENCES de tabela nova para `empresas`/`usuarios_administrativos`, das quais a árvore não apaga linhas nem muda o id;
  - um teste de controle prova que o detector reprova toques reais.

**Prova:**
- Unidade: baseline + execução 28/28; neutras 2/2.
- PG descartável (mesma autorização; cluster criado e removido, porta 55498 livre): a suíte de modos passou nos modelos **097** (P11), **103** (o staging de hoje: PH com 102/103) e **106** (todas as neutras), e a de pagamentos no 097.
  - No PH, a CLI recusa uma neutra presente e não declarada (`MIGRACOES_DIVERGENTES`).
  - Também no PH, P10 + neutras recusa pelo schema (`SCHEMA_FORA_DA_LISTA`).
- 8 mutantes MORTOS numa cópia isolada com cluster próprio, ambos removidos:
  - PH aceito em production;
  - PH sobre P10;
  - base PH aceita em production;
  - marcadores das neutras ignorados;
  - detector sem ALTER TABLE;
  - entrada sem o ambiente;
  - modos sem o ambiente;
  - entrada só com os marcadores de production.
- eslint e tsc limpos. CI local: CI local 32/32 na base nova (static 4018, passo dos scripts 98). A primeira rodada deu 2 falhas fora do B-14 (checksums de importados e e-mail de production), causadas pelo clone novo ter herdado core.autocrlf=true; corrigido com autocrlf=false local e os 3014 arquivos não mexidos restaurados do índice em LF. PG e mutantes rodaram antes dessa troca: o conteúdo é o mesmo, e o empacotador e o teste das neutras normalizam LF..

**Limites:**
- A neutralidade é estática, pelo texto do SQL. O sha fixado obriga a revê-la se um arquivo mudar.
- Em staging, que 102, 103 e 105 estão aplicadas vem da memória dos registros de 27/10. 104/106 a confirmar. O próprio bloco confere por marcador antes de rodar.

## P3 da aprovação do PH + HB-3/HB-4 (feito, 28/10/2026)

**P3 da aprovação do PH:**
- **Detector de mudança de `id`** (`scripts/recuperacao-neutras-b14.test.cjs`): `idMudadoEm` examina a lista inteira do `SET`, em qualquer posição, qualificado, entre aspas e em tupla. Controles: `SET nome = $1, id = $2` e vizinhos reprovam; `empresa_id =` e `WHERE id =` não contam.
- **Descrição do modelo** (`scripts/regressao-v1-selecao.cjs`): o 103 não é "o staging de hoje". Entrou o modelo `b14-PH-staging` (P11 + 102/103/105, sem 104/106), a combinação exata registrada para o staging. Também entrou o 105. A suíte de modos roda em 097, 103, 105, 106 e `b14-PH-staging`.

**HB-3 — matriz por prefixo (§3.8, §11 item 2):**
- **Receita** (`scripts/regressao-v1-postgres-receita.cjs`):
  - um modelo por prefixo, de `b14-P0a` a `b14-P11`, com o conjunto exato de migrations além da 088;
  - a receita aplica em ordem numérica. A ordem do runbook só difere na posição da 090/091, que não dependem das outras.
- **Runner:** passa `KIDMAIS_POSTGRES_MODELO` à suíte, com teste estático.
- **Suíte nova `lib/assinatura/recuperacao-prefixos.postgres.test.ts`**, rodada em cada prefixo e no PH do staging (13 modelos):
  1. as migrations declaradas são lidas do inventário aprovado da própria receita (`check-migrations.mjs`); o prefixo é o esperado e os marcadores do sandbox batem;
  2. com o **pacote entregue** (a árvore mínima escrita num temporário fora do checkout, `node_modules` por junção), para os dois códigos e os 7 modos:
     - não admitido → 1 `MODO_NAO_ADMITIDO`;
     - admitido → passa da porta;
     - nada gravado em nenhuma combinação;
     - oráculo explícito por faixa: P0a/P1 conferem com o antigo; P2/P3 só RESTORE; P4+ JANELA com a candidata; P5+ nada com o antigo;
  3. JANELA admitida (`--conferir`; `--recuperar` com manifesto de backup válido) executa no schema do prefixo pelo pacote: código 0;
  4. RESTORE admitido: drenagem e inventário executam no schema do prefixo; créditos só a partir do P7.
- **Limite:** o domínio está vazio nessa suíte. Os casos com dados ficam na suíte de modos (P11/PH) e na de pagamentos.

**HB-3 — matriz da §3.3.1 completa** (`recuperacao-pagamentos.postgres.test.ts`, modelo 097): cada estado estável com a 2ª execução medida pela fotografia **e** pela contagem de escritas, e um controle com mudança real.
- **Créditos:**
  - estorno parcial tratado;
  - disputa ABERTA e FAVORAVEL;
  - estorno total externo sem devolução;
  - disputa PERDIDA;
  - devolução CONCLUIDO;
  - ENCERRADO com cobrança cancelada;
  - REVISAO com o mesmo motivo;
  - cobrança não canônica pelo `processarExtra`.
- **Assinatura:**
  - TESTE vinculada sem pagamento;
  - EM_ATRASO;
  - ENCERRADA;
  - encerramento AUSENTE.
- Já existiam: ATIVA (com oferta confirmada), CANCELADA_FIM_PERIODO, AGUARDANDO/PENDING, VENCIDO/OVERDUE e CREDITADO/RECEIVED.
- Nos testes novos as empresas viram ATIVA pelo pagamento, sem a oferta Fundador, porque as vagas limitadas esgotavam (`OFERTA_ALTERADA`).

**Defeito achado pela matriz e corrigido** (`lib/creditos/pagamento.ts`, estorno externo): na disputa perdida (ABERTA → PERDIDA), a leitura seguinte, com a disputa já PERDIDA, caía no `ELSE` do `CASE` e gravava `revisao_motivo = 'ESTORNO_SEM_PEDIDO'`. O estado só convergia na 2ª execução, e a liberação do RESTORE veria efeito numa cobrança estável. Agora o motivo fica como estava para ABERTA **e** PERDIDA, no `SET` e na guarda.

**HB-3 — mutantes avaliados pela fotografia (§11 item 3).** Rodados numa cópia isolada com cluster próprio, ambos removidos. Na primeira bateria, 11 de 14 morreram. Dos 3 sobreviventes, o da idade ganhou um teste e morreu na segunda bateria; os outros dois são equivalentes (abaixo), e o mutante duplo que derruba as duas barreiras do snapshot morreu. Lista:
- **Mortos:**
  - COMMIT no `--conferir`;
  - RESTORE com 0;
  - código 3 virando 2;
  - "nenhuma ação" aceita com efeito;
  - linha de base recriada;
  - lista instável aceita;
  - aplicar-caso sem conferir as pré-condições;
  - UPDATE sem guarda em AGUARDAR;
  - `mudarEstado` regravando REVISAO;
  - disputa PERDIDA voltando ao motivo antigo;
  - **idade como critério**: sobreviveu à primeira bateria. Entrou um caso no teste da base (limite vencido antes da base não agrava) e ele morreu;
  - **savepoint da proposta mantido + snapshot confirmado** (mutante duplo): morreu;
  - **só o savepoint mantido**: morreu, porque a JANELA usa a mesma proposta fora do snapshot.
- **Equivalentes (documentados):**
  - **snapshot do inventário confirmado, sozinho:** a proposta já desfaz o próprio savepoint (`limpar(d.tx, true)`), então o `ROLLBACK` externo é defesa em profundidade;
  - **disputa ABERTA reprocessada sem a guarda `c.disputa !== 'ABERTA'`:** depois do primeiro bloqueio não sobra disponível (`bloquearDisponivel` não lança nada com 0) e o `UPDATE` é guardado, então nada é gravado.

**HB-4 — procedimento operacional:** `docs/RECUPERACAO_PAGAMENTOS_B14.md` (rev. 1) cobre:
- quando usar e a matriz;
- antes da colagem: geração, conferência de sha/bytes e nomes de `PG*`;
- colagem;
- tabela de códigos e o que fazer;
- RESTORE passo a passo;
- homologação com PH;
- encerramento e LIMPEZA;
- o efeito observável da §3.3.1 na fila do painel;
- o que nunca fazer.

**Prova:** PG descartável (mesma autorização; cluster criado e removido, porta 55498 livre): 19/19 execuções de suíte — prefixos em 13 modelos (P0a…P11 e PH do staging), modos em 5 (097, 103, 105, 106, PH do staging), pagamentos no 097 com a §3.3.1 completa. Mutantes: 1ª bateria 11/14 mortos, 2ª bateria 3/3 mortos (idade com teste novo, duplo do snapshot, só o savepoint), 2 equivalentes documentados; cópias isoladas com cluster próprio, removidas. Unidade, eslint e tsc limpos; CI local 32/32 (static 4018).

## HB-3/HB-4 — rodada de correção 1 (revisão: REPROVADO, 5 P2 e 2 P3; feito, 28/10/2026)

- **P2 — matriz sem dados.** A suíte de prefixos ganhou um teste **com dados** em cada um dos 13 modelos, para cada código admitido no RESTORE:
  - empresa ATIVA cujo cancelamento no provedor se perdeu localmente ("decisão perdida": recusas `QUEDA_SITUACAO` e `DATA_DO_INSTANTE`);
  - desde o P1, um pedido de encerramento local (`ENCERRAMENTO_089_097`);
  - desde o P7, um crédito pago no provedor e perdido localmente.

  A cadeia testada:
  1. drenagem;
  2. inventário sem gravar;
  3. T1/T2: o provedor muda entre o inventário e a aplicação → `DIVERGENTE`, nada gravado;
  4. aplicação com os **efeitos exatos** da proposta (fotografia antes/depois);
  5. COMMIT incerto: `CONFERIR-CASO` dá `APLICADO` pela execução da aplicação e `DIVERGENTE` por outra;
  6. liberação, com o código antigo só com a prova do cron.

  Também JANELA com dados onde é admitida: `--conferir` dá 2 sem gravar; `--recuperar` aplica e a conferência seguinte fecha 0.
- **Dois achados da matriz com dados:**
  - **Consistência por caso** (`recuperacao-execucao.ts`, `assinaturaDoCaso`). Comparar o hash inteiro deixava INCONCLUSIVO todo caso com coluna comercial do instante: um cancelamento grava `cancelada_em` = agora, e duas propostas a milissegundos de distância nunca batiam. Resultado: código 3 na JANELA e cobertura incompleta no RESTORE. Agora a comparação usa as pré-condições mais os efeitos com o **valor** dessas colunas mascarado; presença × ausência continua contando. Há teste de unidade.
  - **Vários casos da mesma empresa.** A pré-condição local de todo caso é a fotografia da empresa inteira, então aplicar um invalida a proposta dos outros (`DIVERGENTE`, nada gravado). O comportamento é seguro e está registrado no procedimento: um INVENTARIO novo entre as aplicações. O teste prova a recusa e o fluxo.
- **P2 — convergência em dois passos.** Creditado em CONFIRMED e relido RECEIVED com estorno parcial novo, o tratamento do estorno retornava antes de gravar o status. Agora `situacao_provedor` é gravado (com guarda) **antes** do estorno parcial. Há teste que reproduz o cenário.
- **P2 — disputa ABERTA.** O fluxo real: uma reserva feita antes da disputa e consumida depois. A exposição ficava congelada no valor da abertura. Agora ela acompanha o consumo a cada leitura, só sobe e só grava com mudança; o bloqueio do remanescente continua sendo só na abertura (o que volta de reserva já cai em bloqueado). O teste mostra a exposição 0 → 2970 como efeito e o novo estado estável. **Isso muda o comportamento do web:** D-HML-4, **aceita por Felipe em 28/10/2026**.
- **P2 — ordem do RESTORE no procedimento.** O procedimento agora segue a §5:
  - barreira B-16;
  - `R` e as instâncias pelos metadados do Render;
  - reinício;
  - prova da drenagem em três partes, com a (a) fora do SQL;
  - **só então** o restore, o export novo, a VSC e o inventário.

  Depois da reabertura com o código antigo vale a próxima execução do cron antigo, não o CONFERIR do B-14. A exceção `interrupted` traz as três exigências.
- **P2 — código 1.** Não há mais a garantia de "nada gravado": casos já confirmados antes de uma parada continuam gravados, e um COMMIT sem resposta exige conferir.
- **P3 — fila do painel.** O texto distingue os casos:
  - cobrança canônica: o cursor `conferida_em` renova `atualizada_em` a cada leitura;
  - cobrança extra: sem cursor, só mudança real renova;
  - pedido: cursor `reconciliado_em`.
- **P3 — ordem.** Os modelos de prefixo (`runbook: true`) aplicam as migrations da promoção na **ordem do runbook** (089, 092, 093, 099 → 090, 094, 095, 096, 097, 100, 091). O PH do staging segue a ordem numérica, que é a do staging.

**Prova:** PG descartável (mesma autorização; cluster criado e removido, porta 55498 livre): 19/19 — prefixos com dados nos 13 modelos (na ordem do runbook), modos em 5, pagamentos no 097. Mutantes numa cópia isolada com cluster próprio (removidos): 7/7 mortos (estorno parcial em 2 passos, exposição congelada, consistência sem máscara no PG e na unidade, disputa PERDIDA, lista instável, aplicar-caso sem pré-condições), controle PASS. Unidade, eslint e tsc limpos; CI local 32/32 (static 4018).

## HB-3/HB-4 — rodada de correção 2 (revisão da rodada 1: REPROVADO, 3 P2 e 1 P3; feito, 28/10/2026)

- **P2 — estorno parcial × disputa no mesmo fluxo** (`lib/creditos/pagamento.ts`).
  - Um estorno parcial NOVO que chega junto com a abertura da disputa, ou com a resolução favorável, tem os dois efeitos na MESMA leitura. Antes, o parcial retornava cedo e a disputa ficava para a leitura seguinte.
  - A disputa favorável **não desbloqueia** enquanto houver retenção de estorno parcial pendente (`retencao_motivo = ESTORNO_EXTERNO_PARCIAL`, decisão do operador). Antes, a favorável desbloqueava tudo e a retenção ficava só no rótulo; acontecia também em leituras separadas.
  - Testes em PG, com saldos do lote, retenção e fotografia:
    - ABERTA + RECEIVED com parcial → FAVORAVEL e retenção numa leitura, com o lote em disponível 0 / bloqueado 1000;
    - abertura com parcial → ABERTA, exposição 1980 e retenção, com disponível 0 / bloqueado 800 / consumido 200;
    - parcial durante a disputa e favorável na leitura seguinte → a retenção se mantém.
  - Em todos, a leitura seguinte é SEM_EFEITO.
  - **Muda o comportamento do web:** a disputa favorável deixa de liberar crédito retido por estorno parcial. **D-HML-5, aceita por Felipe em 28/10/2026.**
- **P2 — cobertura dos contraexemplos, pelo PACOTE ENTREGUE.**
  - Os testes com dados da suíte de prefixos passam a usar os modos carregados da árvore entregue (escrita fora do checkout); as fixtures continuam do checkout.
  - Nos 13 modelos:
    - **COMMIT sem resposta injetado** (cliente que perde a resposta do COMMIT): se o servidor desfez, `COMMIT_INDETERMINADO` e o CONFERIR-CASO dá `NAO_APLICADO`, sem nada gravado; se gravou, `COMMIT_INDETERMINADO`, efeitos exatos e `APLICADO`;
    - **invalidação após Tf:** uma liberação bloqueada é registrada, e a aplicação seguinte a invalida;
    - **contraexemplos novos:** período local maior (`PERIODO_LOCAL_MAIOR`) e Fundador perdido (`OFERTA_FUNDADOR`) em todos os prefixos;
    - **desde o P7:**
      - devolução perdida (`ESTORNO_CHARGEBACK`);
      - estorno de crédito com mais de 90 dias sem evento (fixture histórica com gatilhos desligados só na transação dela; `ESTORNO_CHARGEBACK`);
      - crédito vencido (`SERVICO:CREDITO_VENCIDO_NA_RECUPERACAO`);
      - pedido `CRIACAO_INCERTA` sem vínculo (caso encontrado, não reconciliado);
      - cobrança extra paga (`SERVICO:PAGAMENTO_DUPLICADO`);
    - **trajetória S0 → S2 com dados** (no P0a): base selada com o código antigo; migrations até o P10 na ordem do runbook, no mesmo banco; conferência com a candidata: base válida, nada agravado, código 0, e a pendência preexistente é tolerada pela base.
- **Dois achados novos, corrigidos:**
  - **Conferir-caso** (`recuperacao-modos.ts`): `NAO_APLICADO` exigia o hash integral igual, e a proposta recalculada leva um instante novo. Um COMMIT que não gravou saía `DIVERGENTE`. Agora compara a assinatura mascarada (`assinaturaDaProposta`, a mesma da consistência).
  - **Linha de base entre prefixos** (`recuperacao-baseline.ts`): o hash comparável cobre a fotografia inteira, que cresce com o schema, então toda comparação entre prefixos saía agravada. Agora `HASH_DIFERENTE` só vale na MESMA impressão de schema; entre prefixos valem classe, estado, indicadores, limites e itens novos (§3.5). Há teste de unidade.
- **P2 — procedimento:** a tabela inicial segue a §5 (drenagem antes do restore, INVENTARIO novo entre casos da mesma empresa).
- **P3 — código 4:** a entrada não rodou, mas ENTREGA e LIMPEZA podem ter mexido em parte dos arquivos antes da recusa; o procedimento diz como retomar.

**Prova:** PG descartável (mesma autorização; clusters criados e removidos, porta 55498 livre): suíte de prefixos 13/13 com dados, contraexemplos e a trajetória S0 → S2 (que roda só no P0a); pagamentos com o fluxo composto; controle das três suítes (19/19) PASS na cópia dos mutantes. No clone, a rodada completa deu 18/19: 1 statement timeout (30 s) no teste P2-2 da suíte de modos no modelo 103. Não reproduziu em duas novas rodadas da suíte de modos (5/5 cada, 103 em 6 s e 8 s). Uma conexão só, sem trava de outra sessão do teste: registrado como intermitente, provavelmente carga da máquina, a investigar. Mutantes numa cópia isolada com cluster próprio (removidos): 5/5 mortos (parcial com disputa retornando cedo, favorável desfazendo a retenção, conferir-caso sem a assinatura mascarada, hash entre prefixos na unidade e na trajetória). Unidade, eslint e tsc limpos; CI local 32/32 (static 4019).

## HB-3/HB-4 — rodada de correção 3 (revisão da rodada 2: REPROVADO, 2 P2 e 1 P3; feito, 28/10/2026)

- **P2 — 3b, regressão: o hash entre schemas perdia mudanças comerciais.** Formato da base 2 (`recuperacao-baseline.ts`, `recuperacao-modos.ts`):
  - a base guarda a **forma** do schema em que foi selada (colunas de cada tabela da lista fechada, pelo catálogo);
  - o hash comparável do item atual é calculado **na forma da base**: tabelas e colunas surgidas depois ficam de fora (adição estrutural); tudo o que existia continua comparado, inclusive o contraexemplo do Astra (estorno de R$ 10 → R$ 80, P7 → P8); coluna da base que sumiu vira `$ausente` e conta;
  - `HASH_DIFERENTE` volta a valer no mesmo schema e entre prefixos. Há teste de unidade.
- **Achado novo da trajetória S0 → S2, corrigido.** O hash comparável da base **não mascarava o valor das colunas do instante**. Um cancelamento pendente (`cancelada_em` = agora) parecia agravado em qualquer comparação, inclusive no mesmo schema. Agora tem a mesma máscara da consistência e da conferência. Achado por diagnóstico das propostas antes e depois das migrations; as migrations não alteraram nenhum dado projetado. Há teste de unidade.
- **P2 — efeitos e combinações** (`recuperacao-prefixos.postgres.test.ts`):
  - **efeitos COMPLETOS:** tabela, chave, operação, antes e depois de cada coluna, **inclusive a auditoria**. Os gravados por uma aplicação = os da proposta + **exatamente um** comprovante transacional desta aplicação (identidade conferida);
  - os contraexemplos rodam para **cada código admitido** em cada prefixo;
  - **combinações novas:**
    - mudança **só operacional** entre T1 e T2 (uma auditoria nova) → `DIVERGENTE` (1), nada gravado, INVENTARIO novo;
    - "nenhuma ação" num caso com efeito: com a candidata a liberação bloqueia (`COM_EFEITO_NORMAL`); com o código antigo, `SEM_PROVA_DO_CRON_ANTIGO`;
    - desde o P7, aplicados com efeitos completos: **crédito vencido** (REVISAO, sem lote), **parcial × disputa no restore** (FAVORAVEL + retenção, lote 0/1000) e **COMMIT sem resposta no caso de crédito** (`COMMIT_INDETERMINADO` → `APLICADO`).
- **D-HML-5, prova integrada** (`recuperacao-pagamentos.postgres.test.ts`): favorável com retenção e **reserva pendente**; o operador decide (`resolverBloqueio`):
  - **LIBERAR:** lote 700 disponível; a reserva encerra consumindo 100 e o resto volta (disponível 900, consumido 100);
  - **CANCELAR:** cancelado 700 e perda definitiva; o que volta da reserva é cancelado (cancelado 900).
  - Em ambos, a retenção sai e a releitura seguinte é SEM_EFEITO.
- **P3 — timeout, investigado com diagnóstico.** Três rodadas completas, mais duas e mais duas, com o cluster descartável registrando consultas acima de 3 s e esperas por trava acima de 1 s (`log_min_duration_statement`, `log_lock_waits`, `deadlock_timeout`), e o log guardado antes de remover o cluster.
  - Nenhuma reprodução do timeout.
  - Nenhuma espera longa por trava. Houve uma única espera, de 1,2 s, no catálogo `pg_database` durante um `CREATE DATABASE` da receita.
  - **Latências locais em comandos simples:** `DROP DATABASE` de 5–13 s, um `INSERT` de usuário de 7 s, um `BEGIN` de migration de 31 s. O log do servidor dessa rodada não foi preservado; os números vêm da leitura feita na hora.
  - ~~Conclusão: stall de I/O do disco local~~ — **retificado na rodada 5:** duração não separa disco de CPU, escalonamento, antivírus ou outra pausa, e a falta de espera longa nas rodadas novas não explica o episódio antigo. O que se sustenta: não reproduzido, com latências locais altas e sem espera longa por trava registrada. A causa é desconhecida (ver a rodada 5). A recomendação de `fsync = off` e `synchronous_commit = off` não foi aplicada.

**Prova:** PG descartável (mesma autorização; clusters criados e removidos, porta 55498 livre), com diagnóstico de lentidão e trava ligado: duas rodadas completas das três suítes, 19/19 cada (prefixos com dados e contraexemplos em 13 modelos, trajetória S0 → S2 no P0a, modos em 5, pagamentos com a D-HML-5 integrada), sem timeout e sem espera longa por trava. Mutantes numa cópia isolada com cluster próprio (removidos): 5/5 mortos (projeção na forma, comparação na forma da base, máscara do instante na unidade e na S0 → S2, comprovante da aplicação), controle 19/19. Unidade, eslint e tsc limpos; CI local 32/32 (static 4020).

## HB-3 — rodada de correção 4 (revisão da rodada 3: REPROVADO, 1 P2 e 1 P3; feito, 28/10/2026)

O 3b e o achado do instante estão FECHADOS; o HB-4 também.

- **P2 — estados estáveis da §3.3.1 nas combinações aplicáveis.**
  - A suíte de pagamentos (`recuperacao-pagamentos.postgres.test.ts`) roda no 097 **e em cada prefixo P0a…P11 e no PH do staging**: 14 modelos.
  - Cada teste declara o que precisa (créditos da 095, encerramentos da 089, textos da 097) e é **pulado com o motivo** onde o prefixo não tem.
  - Um teste da guarda impede que ela pule em falso: onde o objeto existe, o teste roda; no 097 nada é pulado.
  - Os estados de assinatura rodam em todos os prefixos; os de créditos, do P7 em diante.
- **P2 — crédito correto × incorreto e liberação com a fila** (`recuperacao-prefixos.postgres.test.ts`): novo teste em cada prefixo e código admitido, pelo pacote entregue.
  - Desde o P7:
    - **crédito correto** → `RECONCILIADA`, não bloqueia;
    - **crédito com estorno não tratado** → `PROPOSTA`. Com a candidata, "nenhuma ação" bloqueia (`COM_EFEITO_NORMAL`); aplicado, a liberação passa.
  - **Fila:**
    - OK → `LIBERADA`, sem exigências;
    - **interrompida** (o resto certo) → `LIBERADA` com as três exigências pós-reabertura (`REATIVAR_FILA`, `NOVA_LEITURA_FILA_CODIGO_0`, `CONFIRMAR_ENTREGA`);
    - **desabilitada, ausente, com evento faltando, ou interrompida e desabilitada** → `BLOQUEADA` (`FILA:…`).
- **P3 — timeout: instrumentação e prova.**
  - `lib/comercial/postgres-descartavel.ts` ganhou um diagnóstico **opcional**, ligado por `KIDMAIS_DIAGNOSTICO_PG=1`. Numa consulta cancelada por timeout (57014), ele registra o SQL e, por uma segunda conexão curta, as sessões (estado, evento de espera, tempo em transação e na consulta) e as travas não concedidas.
  - Provado com um timeout provocado: `pg_sleep(1)` com `statement_timeout` de 200 ms → `DIAGNOSTICO_PG_TIMEOUT` com a sessão em `ClientRead` e nenhuma trava pendente, e o código 57014.
  - Mais duas rodadas completas com o diagnóstico ligado, sem reprodução.
  - O episódio original continua sem causa comprovada. ~~A próxima ocorrência fica registrada com a causa.~~ Retificado na rodada 5: a fotografia é tirada depois do cancelamento. Ela ajuda a descartar trava pendente, mas não determina a causa.
- **P3 — §11 do plano retificada:** o crédito pago e já vencido na recuperação vai para `REVISAO`, sem lote, carteira, expiração nem notificação (decisão anterior de Felipe). O código não mudou.

**Prova:** PG descartável (mesma autorização; clusters criados e removidos, porta 55498 livre), com a instrumentação ligada: timeout provocado → DIAGNOSTICO_PG_TIMEOUT e 57014; duas rodadas completas no clone, 32/32 cada (pagamentos em 14 modelos, com os testes pulados só onde falta a 095 ou a 089; prefixos com a liberação nova; modos), sem nenhum timeout (o único cancelamento no log do servidor é o provocado). Mutantes numa cópia isolada com cluster próprio (removidos): 3/3 mortos (fila recusada aceita, interrompida sem as exigências, guarda que pula sempre), controle PASS. A primeira bateria teve o controle FALHO por um erro meu no teste da guarda ($1 perdido no escape do shell): corrigido e repetida. Unidade, eslint e tsc limpos; CI local 32/32 (static 4020; rodado antes da correção de uma linha no teste PG, que não entra no CI).

### HB-3 — revisão da rodada 4

Revisão da rodada 4 (Astra, 28/10/2026): **APROVADO COM RESSALVAS**. O P2 (§3.3.1, liberação, fila) está FECHADO; sem P1 nem P2 novo. Ficam três P3:

- **P3 (regressão) — diagnóstico sem prazo** (`lib/comercial/postgres-descartavel.ts:59`): conectar, consultar e encerrar a segunda conexão não têm limite; se a coleta travar, o erro original pode não ser relançado. Pedido: prazo total limitado, encerramento limitado e relançamento garantido.
- **P3 (parcial) — causa do timeout:** a fotografia depois do cancelamento não determina a causa. Pedido: retirar a promessa de que a próxima ocorrência revelará a causa, qualificar a atribuição a disco (IMPLEMENTACAO.md:615–616 e 641), vincular as evidências às rodadas; opcionalmente capturar a atividade durante a consulta (PID e tempo), ou registrar causa desconhecida com risco residual aceito.
- **P3 (parcial) — documental:** `PLANO_RECUPERACAO_PAGAMENTOS_B14_20261027.md:191` ainda prevê EXPIRACAO para o crédito nascido vencido; remover ou delimitar.

## HB-3 — rodada de correção 5 (os três P3 da revisão da rodada 4; feito, 28/10/2026)

- **P3 (regressão) — diagnóstico com prazo.** O diagnóstico saiu para um módulo puro, `lib/comercial/diagnostico-timeout.ts`, que não usa o driver. `postgres-descartavel.ts` só fornece a segunda conexão, já com `connectionTimeoutMillis` e `query_timeout`.
  - A coleta (conectar e as duas consultas) tem prazo total (`PRAZO_DIAGNOSTICO_MS` = 5 s). Esgotado o prazo, registra `DIAGNOSTICO_PG_TIMEOUT_SEM_FOTOGRAFIA`.
  - O encerramento tem prazo próprio (1 s). Esgotado, a conexão é destruída e registra `DIAGNOSTICO_PG_ENCERRAMENTO_ESGOTADO`.
  - O erro **original** (o mesmo objeto) sempre é relançado, no máximo 6 s depois. Nenhuma falha da coleta o substitui: nem `abrir`, nem `connect`, nem `query`, nem `end` síncrono ou assíncrono.
  - Testes de unidade (`diagnostico-timeout.test.ts`, 6), com um cliente simulado que nunca responde: no `connect`, na consulta, e em tudo inclusive o `end`. Também cobrem falhas síncronas, a fotografia completa e o caso fora do 57014, em que nada é aberto e o resultado passa intacto.
- **P3 (parcial) — causa do timeout: desconhecida, com as evidências ligadas às rodadas.**
  - **Episódio original** (rodada 2 do HB-3, 28/10, 09:46):
    - teste `P2-2: conferir-caso localiza o evento…` (`recuperacao-modos.postgres.test.ts:368`), 32,9 s, SQLSTATE `57014`;
    - pilha em `registrarEvento` (`lib/assinatura/sincronizacao.ts:185`, `INSERT … ON CONFLICT DO NOTHING` em `cobranca_eventos`), dentro de `emTx` (`:43`), chamado em `:370`;
    - preservados: SQLSTATE, pilha e teste. **Não preservados:** o log do servidor (não havia diagnóstico ligado e o cluster foi removido), o SQL exato, as sessões e as travas, e um hash da árvore só daquele instante (era a árvore de trabalho da rodada 2 do HB-3).
  - **Rodada 3:** o log do cliente foi preservado. O log do servidor com as latências de 5–31 s **não foi preservado**: o arquivo foi sobrescrito pela rodada 4.
  - **Rodada 4** (12:54–13:12), com o log do servidor preservado:
    - nenhum 57014 além do provocado;
    - quatro esperas por `RowExclusiveLock` no catálogo `pg_database` (classe 1262), de 2,0, 3,7, 7,2 e 4,6 s, durante `CREATE/DROP DATABASE` da receita;
    - 73 comandos acima de 3 s, 14 deles acima de 10 s; o maior, um `CREATE DATABASE … TEMPLATE`, levou 33,7 s.
    - Fora das suítes, sem `statement_timeout`.
  - **Evidências** (fora do clone): `D:/glass/KidMais Manager/ambientes-locais/b14-evidencias-timeout-20261028/`, com `SHA256SUMS`.

    | Arquivo | SHA-256 (início) |
    |---|---|
    | `r2-episodio-original-cliente.log` | `cf2955a9…` |
    | `r3-diagnostico-cliente.log` | `2983dc57…` |
    | `r4-rodada-1-cliente.log` | `121e8b90…` |
    | `r4-rodada-2-cliente.log` | `4d7a992d…` |
    | `r4-servidor-postgres.log` | `498a3523…` |
    | `r5-rodada-1-cliente.log` | `0fe45a09…` |
    | `r5-servidor-postgres.log` | `946b7657…` |
    | `b14-pg-diagnostico.sh` | `041c0215…` |
  - **Hipóteses não excluídas:**
    - espera por trava de outra conexão do mesmo processo (o pool da ferramenta), por exemplo uma transação aberta segurando uma linha referenciada;
    - pausa do ambiente local (disco, CPU, antivírus).
    - Nenhuma está comprovada, e não há atribuição a disco.
  - **Captura durante a consulta** (opcional na revisão): não foi feita. Se o timeout reaparecer, a fotografia com prazo registra sessões e travas logo depois do cancelamento. Isso pode mostrar um bloqueador ainda presente, mas não garante a causa.
  - **Risco residual:** um timeout intermitente na suíte local derruba a rodada: falha intermitente da suíte, de causa desconhecida (o diagnóstico não demonstrou que seja falsa). Não altera o código de produção nem o resultado de nenhum teste que passa. **D-HML-6 ACEITA por Felipe em 28/10/2026:** risco residual aceito, com a causa desconhecida. Se o timeout reaparecer, a rodada é repetida e a fotografia é guardada com as evidências.
- **P3 (parcial) — documental:** `PLANO_RECUPERACAO_PAGAMENTOS_B14_20261027.md:191` deixou de prever `EXPIRACAO` para o crédito nascido vencido. Agora remete à §11: `REVISAO`, sem lote, lançamento nem expiração.

**Prova:** unidade 8/8 (6 novos do diagnóstico + 2 da guarda), tsc e eslint limpos. Mutantes do diagnóstico numa cópia isolada (removida), contando falhas e cancelamentos: 5/5 mortos (coleta sem prazo, encerramento sem prazo, encerramento sem destruir, erro original engolido, falha do diagnóstico no lugar do original), controle PASS. A primeira contagem só lia "fail" e deu 2 vivos falsos: o teste que trava sai como "cancelled". CI local 32/32 (static 4026). PG descartável (mesma autorização; cluster criado e removido, porta 55498 livre), com o módulo novo ligado: timeout provocado → DIAGNOSTICO_PG_TIMEOUT e 57014 pela conexão real; uma rodada completa das três suítes, 32/32, sem timeout (o único cancelamento no log do servidor é o provocado; 9 comandos acima de 3 s, o maior 26,5 s; uma espera por trava de catálogo).

### HB-3 — revisão da rodada 5

Revisão da rodada 5 (Astra, 28/10/2026): **APROVADO COM RESSALVAS**. Sem P1/P2 novo. Causa do timeout fechada como risco aceito (D-HML-6), não como causa descoberta; residual documental (plano :184/:191) fechado. Fica:

- **P3 — evento `error` da segunda conexão sem tratador** (`lib/comercial/postgres-descartavel.ts:54`): no `pg` 8.23.0 uma falha do socket depois de conectar rejeita as consultas e também emite `error` no cliente; sem listener, o evento escapa como exceção fora dos `try/catch` e pode impedir que o chamador receba o erro original. Reproduzido pelo Astra com stream simulado, sem banco. Pedido: tratar `error` durante todo o ciclo de vida da conexão, inclusive o encerramento, com teste sem banco para erro/desconexão depois de conectar e durante a coleta.
- **Ajuste de texto** (IMPLEMENTACAO.md:689): trocar "falso vermelho" por "falha intermitente da suíte, de causa desconhecida".
- Observação: os 6 s são orçamento de espera, não limite absoluto sob bloqueio do event loop.

Conferido pelo Astra: identidade, hashes, árvore, manifesto de evidências, unidade 8/8, tsc, eslint, `git diff --check`. Não reexecutados: PostgreSQL, mutantes, CI.

## HB-3 — rodada de correção 6 (o P3 da revisão da rodada 5; feito, 28/10/2026)

- **P3 — evento `error` da conexão de diagnóstico.** `ClienteDiagnostico` passou a exigir `on("error", …)`. O módulo registra o ouvinte logo depois de abrir a conexão, antes do `connect`, e nunca o remove: cobre a coleta, o encerramento e o que o socket emitir depois. O evento vira a linha `DIAGNOSTICO_PG_CONEXAO_ERRO`; o erro original continua sendo relançado. O `pg.Client` real atende o contrato (tsc).
  - Testes sem banco (`diagnostico-timeout.test.ts`), com um cliente falso que é um `EventEmitter` (como o `pg.Client`: `emit("error")` sem ouvinte lança) e captura de exceções soltas no processo:
    - queda do socket depois de conectar, durante a coleta: o `error` emitido fora da cadeia de promessas é tratado, a consulta rejeitada e o erro original relançado;
    - `error` emitido no encerramento e outro depois do relançamento: nenhum escapa, os dois ficam registrados.
- **Texto (linha 689):** "falso vermelho" trocado por "falha intermitente da suíte, de causa desconhecida".

**Prova:** unidade 8/8 no arquivo do diagnóstico (2 novos), tsc e eslint limpos. Mutantes numa cópia isolada (removida), contando falhas e cancelamentos: 7/7 mortos (os 5 da rodada 5 + sem ouvinte de error + ouvinte removido depois do encerramento), controle PASS. CI local 32/32 (static 4028). PG descartável (mesma autorização; cluster criado e removido, porta 55498 livre): timeout provocado → DIAGNOSTICO_PG_TIMEOUT e 57014 pela conexão real; uma rodada completa das três suítes, 32/32, sem timeout.

### HB-3 — revisão da rodada 6

Revisão da rodada 6 (Astra, 28/10/2026): **APROVADO**, sem achado P1/P2/P3. O P3 do evento `error` está fechado: o ouvinte é instalado antes do `connect()`, sem janela assíncrona depois de `abrir()`, e permanece depois do encerramento. O Astra reproduziu com o `pg` 8.23.0 real e stream simulado (erro do socket na coleta, fechamento inesperado, erro na destruição, emissão tardia): nada escapou e o mesmo erro original foi relançado. A linha 689 está adequada. **Com isso o HB-3 está FECHADO** (causa do timeout fechada como risco aceito, D-HML-6). Limites da revisão: PostgreSQL, CI e mutantes não reexecutados; revisão integral do B-14 não refeita. Continuam abertos HB-5 (Node 22.23.2), HB-6 (variáveis PG* do staging) e a autorização da homologação H1–H9.

## HB-5 — Node 22.23.2 exercitado (feito, 28/10/2026)

Antes, toda a validação local rodou em Node 24.20.0. O exercício no runtime de destino achou dois defeitos, ambos corrigidos:

- **Relógio do diagnóstico com `unref` (`lib/comercial/diagnostico-timeout.ts`).** No Node 22.23.2, com uma conexão travada sem handle próprio, o event loop esvaziava antes de o prazo vencer e os testes ficavam "cancelled" ("Promise resolution is still pending but the event loop has already resolved"); no runtime real isso significaria não relançar o erro original. O relógio deixou de ser `unref`: mantém o loop vivo só até o fim da espera limitada (5 s + 1 s).
- **PATH da PTY no teste do bloco Shell (`scripts/bloco-shell-recuperacao-b14.test.cjs`).** O PATH estava fixo em `C:\Program Files\nodejs` (Node 24), e o bloco recusa runtime diferente de `process.version` (`RUNTIME_NODE_DIVERGENTE`, código 4). Agora a PTY usa o diretório de `process.execPath`, o mesmo node que roda o teste. Só o teste mudou; a guarda do bloco continua igual.

**Prova:** Node 22.23.2 portátil oficial (zip 1177b413…, igual ao SHASUMS256 de nodejs.org; baixado com autorização de Felipe, usado só pelo PATH, sem instalar). No Node 22: CI local 32/32; PG descartável (mesma autorização; cluster criado e removido, porta 55498 livre): timeout provocado → DIAGNOSTICO_PG_TIMEOUT e 57014, rodada completa das três suítes 32/32. No Node 24.20.0, com as mesmas correções: CI 32/32 (static 4028). Unidade do diagnóstico 8/8 nos dois runtimes; tsc e eslint limpos; mutantes numa cópia isolada (removida): 7/7 mortos nos dois runtimes, controle PASS, e o mutante que devolve o `unref` morre no Node 22 (sobrevive no 24, que não reproduz o defeito). Evidências: `ambientes-locais/b14-evidencias-timeout-20261028/r7-*` (CI 22/24, cliente e servidor da rodada PG 22), manifesto SHA256SUMS 82286336….

Limite: é o Node 22.23.2 no Windows local, não o Linux do Render; a conferência da ENTREGA-CONFERIR no próprio staging continua no roteiro da homologação. Abertos: HB-6 (variáveis PG* do staging) e a autorização da homologação H1–H9.

## Próximos incrementos (pendentes)

1. ~~Entrada `scripts/recuperacao-pagamentos-producao.cjs`~~ — feita no incremento 4 (acima).
2. ~~Árvore mínima (empacotador) e blocos de Shell (padrão B-4/B-5), com PTY real~~ — feito no incremento 5 (acima).
3. Mais testes em PostgreSQL descartável (prefixos reais P0a…P11 lidos do schema, contraexemplos da §3.3).
4. Mutantes avaliados pela fotografia; homologação em staging/sandbox (autorização própria); `docs/RECUPERACAO_PAGAMENTOS_B14.md` (procedimento operacional).

## Revisão independente — incremento 5, correção 1 (28/10/2026)

**Veredito: REPROVADO.** Revisão local, sem correção de código, commit, conexão a banco ou serviço externo. Os defeitos abaixo são lacunas remanescentes; não foi demonstrada regressão funcional nova causada pela rodada.

### Identidade e validação própria

HEAD eb1af4262b8c18261626354541107f112d5e5e73, branch codex/recuperacao-pagamentos-b14-20261027; 50 entradas no status (17 modificadas, 33 novas). Hash acumulado ANTES deste registro: 6df830a662adb0de708a735bbe35c6fdd0acf16160da42ba65eca8a432621171. Os seis SHA-256 do handoff conferiram. Árvore conferida: 5847b1d11f6512b1a6b9d3d41d3765c5fb6925de9d247599d7841a21861da9eb, 45 arquivos, 611037 bytes; runtime declarado Node 22.23.2, pg 8.23.0, zod 4.5.4.

Entrada 10/10; blocos 5/5, incluindo PTY real MSYS2. A primeira tentativa no sandbox encontrou EPERM em temporários/junções; a entrada passou ao usar temporário permitido e os blocos passaram fora do sandbox com ambiente sanitizado. Não repetir a falha ambiental como defeito da candidata. Não reexecutados PostgreSQL, CI 28/28 nem os sete mutantes do autor.

### Fechamento dos seis itens

| Item original | Estado | Evidência |
|---|---|---|
| P1 — query muda o alvo | PARCIAL | scripts/recuperacao-pagamentos-producao.cjs:128–133 elimina connectionString e recusa query além de sslmode. O vetor de produção foi fechado; permanecem os dois P2 abaixo. |
| P2 — E0 bloqueado | FECHADO | scripts/bloco-shell-recuperacao-b14.cjs:185; a equivalência é informativa só no E0. A entrada ainda valida codigoNoAr e modoAdmitido antes de conectar (entrada:247–253; lib/assinatura/recuperacao-execucao.ts:97–118). |
| P3 — fecho por regex | PARCIAL | scripts/arvore-recuperacao-b14.cjs:49–70 resolve o contraexemplo original e dinâmicos diretos; carregadores indiretos continuam invisíveis. |
| P3 — oráculo da PTY | FECHADO | scripts/bloco-shell-recuperacao-b14.test.cjs:281–284 exige ausência de e/u e embrulhos[0] === true. |
| Observação LIMPEZA (P3) | FECHADO | scripts/bloco-shell-recuperacao-b14.cjs:170 exige SIM literal; testes :204–214 verificam recusa e execução. |
| Observação localização/runtime (P3) | FECHADO | seção anterior, linha 370: localização dentro da raiz, fora de scripts/lib e runtime externo explicitados. |

### Achados remanescentes

**P2-R1-1 — credenciais e opções ainda vêm do ambiente** — scripts/recuperacao-pagamentos-producao.cjs:132–133. URL sem usuário/senha é aceita e gera strings vazias; pg 8.23.0 usa fallback por valor truthy (node_modules/pg/lib/connection-parameters.js:9–23). Prova offline com new Client(conexao), sem connect: PGUSER/PGPASSWORD sintéticos foram herdados. PGOPTIONS também foi herdado mesmo com destino explícito, resultando em options=-c search_path=outro,public. O alvo de produção preservou host, porta 5432 e TLS, mas não a identidade de sessão nem o schema de resolução. Há SQL não qualificado (recuperacao-modos.ts:86–93, 411) enquanto os marcadores verificam public; se houver tabelas homônimas, essa opção pode desviar a execução para outro schema. Não foi executado SQL para essa prova. Exigir credenciais explícitas válidas e recusar/neutralizar PG* não admitidos antes de criar o Client; options vazio não basta, pois o fallback é por truthiness. Testar também PGPASSFILE/fallback de senha e outros parâmetros de sessão, não apenas host/port.

**P2-R1-2 — porta zero aceita diverge do destino efetivo no descartável** — scripts/recuperacao-pagamentos-producao.cjs:110 e 123. Prova offline: URL postgresql://127.0.0.1:0/db, alvo db@127.0.0.1:0, nome descartável db e sandbox são aceitos. Com PGPORT=5433, new Client(conexao).connectionParameters.port é 5433, embora validarAlvo retorne 0. Sem PGPORT, o fallback é 5432. Host e database permanecem fixos, mas pode atingir outro cluster local com banco homônimo. Produção/staging não aceitam porta zero por comparação exata; não confundir com reaparecimento do bypass remoto original. Exigir porta inteira entre 1 e 65535, e comparar configuração efetiva em teste com PG* divergentes.

**P3-R1-3 — AST ignora formas indiretas de dependência** — scripts/arvore-recuperacao-b14.cjs:61. especificadores retorna [] para const r=require; r('./omitido.cjs') e module.require('./omitido.cjs'); createRequire retorna apenas node:module, omitindo o módulo carregado. import.meta.resolve também é ignorado, embora sozinho resolva, não execute módulo. Assim a alegação de fecho/lista fechada não cobre essas formas. Recusar sintaxes não suportadas ou resolver os casos suportados, com testes. Não encontrei essas formas nos arquivos atuais da árvore; é uma limitação do gerador, não evidência de arquivo faltante nesta entrega.

### Pontos de atenção sem novo bloqueante

- Caminho da URL: database é o pathname decodificado e validado por lista fechada. /db/extra e /db%3Fhost=x foram recusados com ALVO_INVALIDO. Sem connectionString, pg não reinterpreta esse caminho; não há evidência de bypass por pathname. PGHOST divergente não vence o host não vazio.
- E0: ausência de RENDER_GIT_COMMIT recusa com 4. Um Manual Build com SHA arbitrário passa pela desigualdade do bloco, mas codigoNoAr devolve null e a entrada recusa antes de criar Client. A prova offline da matriz confirmou desconhecido recusado e antigo admitido em P0a. Fixar o SHA antigo completo no bloco/entrada e testar o caminho ponta a ponta com Asaas sintético ligado melhora precisão; atualmente a entrada aceita o prefixo 00d3019a. Não tratar a guarda isolada do bloco como bypass operacional demonstrado.
- PTY: se a sentinela observar u, a asserção falha; sem bracketed paste na primeira colagem, a segunda asserção falha. O harness cria ambiente limpo e não injeta set -u herdado; prova o cenário limpo, não preservação de opções arbitrárias. O bind muda bracketed paste no shell do operador, conforme desenho documentado.

Próximo passo: corrigir P2-R1-1/P2-R1-2, completar ou restringir o contrato do AST e submeter nova revisão. Homologação e publicação permanecem pendentes de autorização própria. Este acréscimo documental muda o hash acumulado e o hash deste documento; os cinco scripts revisados e a árvore executável permanecem iguais.

## Revisão independente — incremento 5, correção 2 (28/10/2026)

**Veredito: APROVADO COM RESSALVAS para esta entrega local.** Os dois P2 estão fechados; P3-R1-3 continua parcial. Nenhum P1/P2 novo ou regressão funcional na árvore atual foi demonstrado. Não significa aprovação irrestrita do gerador para fontes futuras, homologação ou autorização de publicação. Código não alterado; somente parecer/documentação.

### Identidade e validação própria

- HEAD `eb1af4262b8c18261626354541107f112d5e5e73`, branch `codex/recuperacao-pagamentos-b14-20261027`, 50 entradas no status. Os seis hashes de arquivos do pedido conferiram antes desta documentação.
- Hash acumulado antes deste parecer: `7675d54526c68e5dfef95abd5def39dd68dd9a5af634d27d41bcae0ae4a499f2`, reproduzido com bytes de `git diff` e dos não rastreados, na ordem do status, excluindo PLANO_RECUPERACAO.
- Árvore `5ca4db2b647a848c3bbbcc57dce4169685015f3f72cd68ef84799114ad3b6cec`: 45 arquivos, 612315 bytes; runtime declarado Node 22.23.2, pg 8.23.0, zod 4.5.4.
- Reexecução independente: entrada 11/11 e blocos 5/5, incluindo PTY real, nenhum pulado. Runtime efetivamente usado nesta revisão: **Node 24.20.0**, não 22.23.2. Os testes adaptam a exigência de Node do bloco ao executável do teste; portanto esse resultado não substitui validação do runtime de destino.
- Primeira tentativa no sandbox: 12/16, quatro EPERM de junções/renomeação, sem falha de asserção funcional. Mesmas suítes repetidas fora do sandbox, com autorização automática, passaram 16/16. Ambiente do processo de teste sem PG*, NODE_PG_FORCE_NATIVE, NODE_OPTIONS e variáveis de aplicação/banco herdadas.
- Provas adicionais offline preservadas em `D:/glass/KidMais Manager/revisao-b14-i5-r2-20261028/provas.cjs` e `resultados.json`: fixture mínima de carregamento e pgpass inteiramente sintético, com abertura de socket bloqueada. Nenhum banco ou serviço externo acessado. PG descartável, CI completo, ESLint e oito mutantes informados pelo autor não foram reexecutados nesta revisão.

### Classificação dos três remanescentes

**P2-R1-1 — FECHADO quanto ao defeito P2.** `scripts/recuperacao-pagamentos-producao.cjs:104,120,142–143,258,267`: recusa PG* mesmo vazia e NODE_PG_FORCE_NATIVE no env recebido e no process.env antes de criar Client; usuário obrigatório e senha obrigatória fora do local; configuração por campos explícitos, sem connectionString. Isso fecha herança de identidade e PGOPTIONS em production/staging. `defaults.user` de USER/USERNAME não substitui usuário não vazio. Senha explícita não nula também evita pgpass fora do local. A exceção local é tratada abaixo, sem reabrir o P2 de produção.

**P2-R1-2 — FECHADO.** `scripts/recuperacao-pagamentos-producao.cjs:119`: porta inteira em 1..65535 antes da confirmação do alvo. Porta zero não alcança o Client; teste passou para recusa de zero e porta efetiva 55498.

**P3-R1-3 — PARCIAL, P3 remanescente.** `scripts/arvore-recuperacao-b14.cjs:64–70`: os exemplos literais apresentados na rodada são recusados, mas a permissão de PropertyAccess sobre require é ampla (não limitada a main/resolve/cache), e os nomes entre colchetes são StringLiteral, não Identifier. Reproduções que carregam de fato `scripts/x.cjs` (resultado 42) mas cuja árvore entregue omite esse arquivo:

```js
module['require']('./x.cjs')
require('node:module')['createRequire'](__filename)('./x.cjs')
require.call(null, './x.cjs')
```

`especificadores` retorna respectivamente `[]`, `['node:module']` e `[]`; `arvore(fixture)` contém somente entrada e package.json. `import.meta['resolve']('./x.cjs')` também passa (resolve, não carrega sozinho). Não foi encontrada ocorrência dessas formas nos 45 arquivos atuais. Logo, limitação real do gerador para evolução futura, sem prova de arquivo ausente nesta entrega. Restringir propriedades de require às exceções declaradas; tratar ElementAccess com nomes literais equivalentes e recusar carregadores computados não determináveis, com testes que verifiquem o fecho da fixture. Alternativamente, explicitar o contrato sintático limitado e manter revisão manual da árvore; não anunciar recusa geral de carregadores indiretos.

### Ressalvas e decisões pedidas

**P3-R2-1 — afirmação sobre senha local é ampla demais.** `scripts/recuperacao-pagamentos-producao.cjs:140–145`: senha vazia vira null em pg; `node_modules/pg/lib/client.js:295–300` então consulta pgpass se houver pedido de autenticação. Mesmo sem PGPASSFILE ou qualquer PG*, o arquivo padrão vem de APPDATA/postgresql/pgpass.conf no Windows ou HOME/.pgpass no Unix (`node_modules/pgpass/lib/helper.js:58–61`). Prova offline chamou `_getPassword` com arquivo sintético e herdou a senha, sem connect. No cluster trust informado não há solicitação de senha, portanto isso não demonstra falha nesse ensaio nem em production/staging (senha obrigatória). Corrigir comentário/documentação e, se o contrato local exigir ausência absoluta de fallback, fornecer uma senha/função explicitamente controlada e testar essa propriedade.

**Recusar qualquer PG* é aceitável como fail-closed.** Pode impedir a operação se o Web Shell tiver qualquer chave desse prefixo, inclusive inócua; isso é incompatibilidade explícita, não conexão silenciosa com sessão diferente. Não consultei o Render e não afirmo que seu ambiente passa. Prefiro manter a recusa ampla nesta ferramenta excepcional: uma lista fechada das chaves de connection-parameters.js/index.js é mais frágil e não contempla sozinha pgpass (PGPASSFILE e caminhos padrão). Não remover variáveis do serviço nem neutralizá-las silenciosamente. Preparação operacional deve verificar presença sem expor valores e tratar eventual incompatibilidade em escopo autorizado.

**Falsos positivos por nome são aceitáveis neste gerador restrito.** `arvore-recuperacao-b14.cjs:60–64` também recusa um identificador inocente como `const createRequire = 3`. Isso afeta fontes futuras, não a árvore atual, que passa. Restringir só a PropertyAccess/Call perderia imports, desestruturação e captura de funções; reduzir falsos positivos corretamente exige analisar vínculos e usos, além de ElementAccess. Não é necessário relaxar essa guarda para aprovar a entrega atual.

Próximos passos: completar/documentar o alcance do AST e corrigir a afirmação de ausência de fallback local; conservar gates operacionais anteriores e validar o runtime fixado antes de homologação autorizada. Este parecer altera somente o hash documental/acumulado, não os cinco scripts nem a árvore executável.

## Revisão independente — PH, mudança de base e P3 do incremento 5 (28/10/2026)

**APROVADO COM RESSALVAS para este delta LOCAL.** Nenhum P1/P2 ou regressão funcional demonstrada. Não encerra o incremento 6, a homologação ou os gates HB-3/HB-4/HB-5/HB-6. Sem correção de código, commit, banco ou acesso externo nesta revisão.

### Classificação e evidência

| Item | Estado | Evidência |
| --- | --- | --- |
| PH restrito a sandbox | FECHADO (implementação local) | baseline.ts:54–61 exige sandbox literalmente, padrão producao; entrada :124–132 deriva ambiente do alvo exato, :262 compara com provedor, :264 passa ambiente ao prefixo, :284 aos marcadores e :293 aos modos. recuperacao-modos.ts:184–185 e seus cinco chamadores propagam o ambiente. |
| Base PH reaproveitada em production | FECHADO | recuperacao-baseline.ts:114–115 recusa PH mesmo com hash correto e schema atual P11. Prova própria das 31 máscaras: sandbox aceita; padrão/production recusam; base PH selada recusa em production. P11 ↔ PH é equivalência deliberada apenas em sandbox. |
| Mudança de base/clone | FECHADO | HEAD db8d083bc663c9bb09df630ea7dac302dd3cc557, branch pedida, autocrlf=false. 51 entradas antigas preservadas; única entrada nova: teste de neutras. 3.144 arquivos rastreados não modificados comparados byte a byte com HEAD, zero diferenças. Sobreposição entre delta antigo e mudança de base só ci.yml/selecao; acréscimos antigos e novos preservados. |
| P3-R1-3, AST por colchetes/call/apply/bind | FECHADO no escopo do achado | arvore-recuperacao-b14.cjs:69–86 recusa chaves perigosas, bases sensíveis com chave dinâmica e require fora de chamada direta/propriedades permitidas. Casos adversariais em bloco-shell-recuperacao-b14.test.cjs:81–90 passaram. Não é garantia contra toda metaprogramação JavaScript possível. |
| P3-R2-1, comentário pgpass local | FECHADO | recuperacao-pagamentos-producao.cjs:140–144 distingue trust local, consulta ao pgpass se o servidor pedir senha e credencial obrigatória fora do local. Comentário correto; não promete eliminar fallback local. |
| Neutralidade atual / guarda de regressão futura | FECHADO para os cinco SQL fixados e a árvore atual; PARCIAL como prova automática geral | Leitura dos SQL e corpos de função, hashes fixados e testes positivos; ressalva P3-PH-1 abaixo. |

### Achados não bloqueantes

- **P3-PH-1 — guarda de FK não cobre id fora da primeira atribuição.** scripts/recuperacao-neutras-b14.test.cjs:60 usa SET\s+id e perde, por exemplo, UPDATE empresas SET nome = $1, id = $2 WHERE id = $3. Prova própria offline: injetar esse texto como um arquivo adicional no retorno de arvore, sem alterar arquivos nem executar SQL, deixa passar os dois testes de neutralidade, apesar das FKs da 105 para empresas(id). Melhorar a identificação das atribuições (incluindo aliases/identificadores entre aspas) e adicionar controle negativo para id depois de outra coluna; até lá, exigir revisão manual da árvore. Não existe esse UPDATE/DELETE de empresas ou usuarios_administrativos na árvore atual, portanto não é uma regressão funcional presente.
- **P3-PH-2 — modelo 103 não é o staging descrito.** scripts/regressao-v1-selecao.cjs:232 e este documento:432 chamam P11+102/103 de “staging de hoje”, mas o pedido registra também a 105 aplicada. As provas 103 e 106 são úteis, porém não comprovam a combinação exata P11+102+103+105 sem 104/106. Corrigir a descrição e, no gate de homologação, registrar/testar o conjunto efetivamente conferido no destino. A ausência dessa combinação não invalida a restrição de ambiente nem demonstra defeito de recuperação.

### Neutralidade: alcance real

O scanner por regex sozinho **não constitui prova geral de SQL**: mantém corpos $$ (e $f$), mas remove strings; SQL dinâmico, chamadas indiretas por funções/gatilhos de outras migrations, nomes qualificados/entre aspas e construções não reconhecidas exigem análise adicional. Os SHA fixados impedem que uma alteração nas cinco migrations passe silenciosamente, mas não congelam futuras alterações da árvore de execução.

Nos arquivos atuais, a leitura confirma: 102 altera salões e suas filhas; seus gatilhos atualizam/validam esse domínio. 104 troca o hash de revisão operacional e adiciona o gatilho de imutabilidade em fechamento_revisoes; o B-14 não chama essa função nem escreve nessas tabelas. 106 lê/trava salões e valida preferências em fechamentos; essas operações não são alcançadas pela recuperação. 105 cria o domínio OAuth. Não foi encontrado EXECUTE de SQL dinâmico nos corpos relevantes. A 103 insere SERVICOS em adicional_categorias, fora do domínio lido/escrito pela árvore.

FK não é literalmente “nenhum gatilho na tabela pai”: PostgreSQL instala gatilhos de integridade referencial. O argumento aceitável é que a recuperação não apaga empresas/usuarios_administrativos nem muda suas chaves referenciadas, não que a FK seja inexistente ou sem efeito sob qualquer carga. A 102 tem inclusive FK de uma coluna adicionada à tabela já existente agenda_saloes; “só tabela NOVA” é uma simplificação do comentário do teste. Nada disso implica alcançar o domínio de pagamentos pela árvore atual; concorrência/carga continua sendo matéria de homologação.

103 sem marcador é aceitável neste contrato: não é requisito funcional da recuperação e a declaração vem do CONFERIR B-5, como outras migrations sem marcador. Presença de objeto é checagem complementar, não prova de integridade completa ou de aplicação atômica. Production mantém o comportamento anterior: PH declarado recusa; a entrada não detecta neutras omitidas em production porque não consulta seus marcadores. Portanto “PH nunca em production” descreve a classificação de schema declarado, não descoberta autônoma de todo SQL instalado.

As 31 impressões podem permanecer. Não há razão funcional encontrada para fixar só o subconjunto atual do staging, desde que cada migration seja íntegra e conferida pelo B-5. A lista não valida dependências: por exemplo, 106 exige 102 no próprio SQL. Conjunto parcial/inconsistente não se torna válido só porque seu hash pertence ao PH. O inventário da homologação deve registrar a impressão exata; equivalência PH/P11 não substitui esse registro.

### Validação própria e limites

- 12/12 hashes de arquivos do pedido conferidos antes desta anotação; acumulado e5d420bdcef739fa7310b5132b0d1260d35db5e5e05c9bf96f7f6dcdb334538a reproduzido com os mesmos bytes de git diff, cabeçalhos e arquivos novos, excluindo o plano.
- Árvore antiga bd65d27395342e0ad1b428d34e5371f8c922117b2541f888120e5890f6722713. Árvore nova 54e7bb853763f5c8fa806224f5ba55d7e4053e9fb8ac475ce0b9ad8daa755d10, 45 arquivos. Só quatro arquivos executáveis diferem: baseline, execucao, modos e entrada, todos do PH. A comparação sustenta preservação do resultado; não pretende reproduzir a história do git apply --3way.
- **44/44**, zero pulados: baseline 10, execução 16, neutras 2, entrada 11, blocos 5 (inclui PTY real). Node **24.20.0**, não o runtime alvo 22.23.2. Log: D:/glass/KidMais Manager/revisao-b14-ph-20261028/testes-bash-correto.txt.
- A tentativa inicial teve EPERM de sandbox; fora dele, o alias WSL bash não abriu caminhos Windows. Repetição com Git Bash explícito passou. Falhas ambientais, não achados no delta.
- Prova adicional própria: 31/31 máscaras e bases PH; controle negativo sintético do scanner descrito em P3-PH-1. git diff --check limpo.
- PG, oito mutantes e CI 32/32 são resultados informados pelo implementador, **não reexecutados nesta revisão**. Nenhum cluster criado, nenhum banco acessado, nenhuma homologação/publicação efetuada.

Próximos passos: tratar P3-PH-1/P3-PH-2; concluir os gates do incremento 6, runtime alvo e preparação operacional. A anotação altera o hash acumulado documental; não altera a árvore executável aprovada.

## Revisão independente — P3 do PH e HB-3/HB-4 (28/10/2026)

**REPROVADO para encerrar HB-3/HB-4 e avançar H0.** Os dois P3 anteriores estão fechados, assim como a correção focal da disputa PERDIDA. Permanecem lacunas de cobertura e erros do procedimento. Revisão exclusivamente local, sem correção de código, commit, banco, rede externa, homologação ou publicação.

### Identidade e validação própria

Antes deste registro: HEAD `db8d083bc663c9bb09df630ea7dac302dd3cc557`, 56 entradas de status; acumulado `e1241333ee7151a5b09a09218e120135b20f59c3010ce3cefeee94f6e9c901f0`; 12/12 hashes fornecidos conferidos. Árvore `1fbf001190477ce605542a4bab8f9edea441f3cfd7b3c0fc530f02cfb1cecb5a`, 45 arquivos, 616123 bytes.

Reviewer: **41/41 testes sem banco**, nenhum pulado, Node 24.20.0: neutras, seleção estática, baseline, gravação só com mudança, execução e base de validade. Ambiente de teste sem DATABASE_URL/PG*/opt-in de PostgreSQL. `git diff --check` limpo. Duas provas adicionais de fluxo executam o módulo real `pagamento.ts` transpilado, com executor SQL e ledger simulados; distinguem comportamento original de mutante, sem conexão. Não equivalem à prova PostgreSQL. Evidências em `D:/glass/KidMais Manager/revisao-b14-hb34-20261028/`: `provas.cjs`, `resultados.json`, `hashes.json`, `testes.log`.

PG 19/19, baterias de mutantes, CI 32/32, tsc e eslint são resultados informados pelo implementador e não reexecutados nesta revisão. Os registros documentais desta revisão alteram o acumulado, não a árvore executável.

### Classificação solicitada

| Item | Estado | Evidência e limite |
| --- | --- | --- |
| P3-PH-1 | FECHADO | `scripts/recuperacao-neutras-b14.test.cjs:67`: SET com id em posição posterior, qualificação, aspas e tupla; controles positivos/negativos passam. Fechamento do contraexemplo e recorte sintático solicitado, não certificação de parser SQL geral. |
| P3-PH-2 | FECHADO | Receita `:128` fixa PH = P11 + 102/103/105, sem 098/104; seleção `:235` inclui 097/103/105/106/PH. Descrição do modelo 103 corrigida. |
| Matriz por prefixo | PARCIAL | Conjuntos, porta e execução vazia existem; `recuperacao-prefixos.postgres.test.ts:158,181,200` não cobre os casos com dados em cada combinação (§11 item 2). P2-HB-1. |
| §3.3.1 | PARCIAL | Segunda execução com fotografia e contagem real de UPDATE é uma boa prova nos estados exercitados. Falta transição combinada de estorno parcial/status: P2-HB-2. Não fechar a classe por esses cenários isolados. |
| Correção de pagamento.ts para PERDIDA | FECHADO | `lib/creditos/pagamento.ts:180`: SET e guarda usam o mesmo CASE para ABERTA/PERDIDA. Preserva diagnóstico na perda já reconhecida; NENHUMA/FAVORAVEL continuam recebendo ESTORNO_SEM_PEDIDO. Não altera cancelamento, exposição ou perda definitiva. Sem regressão demonstrada neste delta. |
| Mutantes e equivalentes | PARCIAL | Snapshot confirmado isoladamente é redundância válida no caminho normal, com proposta desfeita. O mutante da disputa ABERTA não é equivalente: P2-HB-3. Resultados de morte históricos não foram reexecutados. |
| Procedimento | PARCIAL | Documento existe e a matriz de admissão corresponde à função, mas RESTORE, códigos e efeito observável precisam das correções P2-HB-4/5 e P3-HB-1. |

### Achados

**P2-HB-1 — Domínio vazio não fecha a matriz com dados.** `lib/assinatura/recuperacao-prefixos.postgres.test.ts:158` (também `:181,200`). Os modos admitidos de aplicar/conferir/liberar recebem arquivos inexistentes e apenas passam da porta. JANELA usa listas vazias; RESTORE exercita drenagem e inventário diretamente nos módulos do checkout, não esses caminhos completos do pacote entregue. O digest vazio não exercita serviços, proposta, escrita autorizada nem descoberta de colunas ausentes. A §11:493 exige combinação × caso com fotografia e alterações exatas. Acrescentar, por combinação admitida e com o pacote entregue:
- P0a/P1 e P2–P4 com antigo: assinatura com período maior, oferta/Fundador e decisão de encerramento perdida (respeitando ausência da 089 em P0a), inventário/aplicação/conferência e liberação com prova do cron antigo; JANELA só onde admitida.
- P4+ candidata: assinatura/evento com efeito e sem efeito, nenhuma ação bloqueada, T1/T2 igual e divergente, efeito operacional diferente e COMMIT indeterminado; P4→P5 cobre a entrada da campanha 090.
- P7+ créditos: estorno >90 dias sem evento, parcial com status pago, crédito correto/divergente, pedido sem vínculo e cobrança não canônica, crédito vencido e localização natural após COMMIT incerto (inclusive carteira WALLE).
- P8/P9: contratação/comprovante e devolução/arrependimento conforme as tabelas passam a existir; P10/P11/PH repetem os casos aplicáveis. Comparação de base S0→S2 com dados e invalidação da liberação após aplicação também precisam de prova.
Não se exige inventar crédito antes da 095; a ausência deve ser coberta pela recusa/ramificação correspondente. Os casos não admitidos permanecem testes de recusa.

**P2-HB-2 — Outro ramo ainda converge em duas execuções.** `lib/creditos/pagamento.ts:304`; teste que não o alcança em `lib/assinatura/recuperacao-pagamentos.postgres.test.ts:546`. Cobrança creditada localmente em CONFIRMED, agora RECEIVED com um estorno parcial DONE ainda não tratado: a primeira execução grava estornado/retencao e retorna antes do switch; a segunda registra RECEIVED. Prova offline: primeira mantém CONFIRMED, segunda faz UPDATE de status. O teste atual começa já em RECEIVED e muda só refunds. O mesmo retorno antecipado pode adiar a resolução de disputa se a leitura trouxer parcial e mudança da disputa juntos. Incluir o cenário combinado em PG, exigir segunda execução SEM_EFEITO/contagem de observação e fazer a primeira execução convergir. O retorno antecipado já existe em HEAD: achado preexistente exposto pelo fechamento da §3.3.1, não regressão introduzida pelo CASE novo.

**P2-HB-3 — O mutante de disputa ABERTA não é equivalente.** `docs/RECUPERACAO_PAGAMENTOS_B14_IMPLEMENTACAO.md:509`, `lib/creditos/pagamento.ts:189`. O argumento olha disponível/bloqueio, mas ignora `exposicao_centavos`. Cenário alcançável: reservar parte do lote, abrir disputa, depois concluir a reserva consumindo parte enquanto a disputa continua ABERTA (`lib/creditos/ledger.ts:166,187`). A releitura original pula a atualização; sem a guarda ela recalcula exposição a partir do consumo novo. Prova offline com preço 10000, lote 100 e consumo 20: original mantém exposição 0, mutante grava 2000. O encerramento da reserva não atualiza exposição da cobrança. Portanto não rotular equivalente nem aceitar a sobrevivência por disponível zero. Acrescentar teste PG pelo fluxo real de reserva e fixar o resultado de domínio desejado; se atualizar exposição for o correto, o suposto mutante revela melhoria/defeito preexistente, não algo a matar cegamente. Com entrada completamente imóvel a mutação é redundante, mas isso não é equivalência no domínio inteiro.

**P2-HB-4 — RESTORE é ordenado antes da barreira/drenagem exigida.** `docs/RECUPERACAO_PAGAMENTOS_B14.md:71`: o passo 1 já manda restaurar; reinício/drenagem ficam em 3/4. A §5 do plano (`:383`) exige barreira B-16 e drenagem antes de restaurar ou inventariar: manutenção não mata callback after já iniciado. O PASS da ferramenta só cobre a parte SQL, não substitui metadados das instâncias nem revalidação da B-16. R precisa ser registrado antes do reinício. Reescrever a sequência com as três provas, antes do restore, export novo/VSC e revalidações necessárias. Além disso, o passo 9 (`:79`) manda FILA + CONFERIR para todos: com antigo em P2–P4 JANELA é recusada, e o bloco CONFERIR exige equivalência de lib com candidata mesmo em P0a/P1. Aplicar a bifurcação da §5: candidata → conferir desde Tf; antigo → próxima conferência do cron antigo. Não recomendar desligar manutenção apenas pelo PASS da drenagem.

**P2-HB-5 — Código 1 não garante que só o registrado foi gravado.** `docs/RECUPERACAO_PAGAMENTOS_B14.md:60`. JANELA confirma por caso (`lib/assinatura/recuperacao-modos.ts:232`): um erro posterior pode sair pelo catch da entrada (`scripts/recuperacao-pagamentos-producao.cjs:306`), sem a lista de aplicações anteriores. COMMIT_INDETERMINADO também é código 1 e pode ter confirmado; falha de gravação da evidência é tolerada. Retirar a garantia e separar recusa prévia de interrupção após início: preservar evidências, conferir estado e tratar COMMIT desconhecido pelo procedimento específico, sem inferir ausência de efeitos pelo código/registro. A explicação de COMMIT abaixo da tabela é correta, mas contradiz sua garantia geral. Para código 4, restringir “nada executado” à operação de banco/provedor que não iniciou: entrega/limpeza podem ter efeitos parciais no disco.

**P3-HB-1 — Efeito observável de atualizada_em está descrito ao contrário.** `docs/RECUPERACAO_PAGAMENTOS_B14.md:101`. Cada leitura canônica executa UPDATE de conferida_em (`pagamento.ts:291`), e o gatilho `database/migrations/20261022_095_ia_creditos.sql:439` renova atualizada_em em todo UPDATE. A fila das cobranças continua ordenando por essa coluna (`lib/desenvolvedor/creditos.ts:59`). Portanto ela não representa exclusivamente última mudança real e a posição pode mudar em releitura sem efeito; isso é a exceção de observação já tolerada pelo plano. Distinguir atualizado_em do pedido, cursores e atualizada_em da cobrança. Não mudar a migration para fazer o texto parecer verdadeiro.

**P3-HB-2 — Explicação da ordem dos modelos omite a 099.** `scripts/regressao-v1-postgres-receita.cjs:112`. O runbook põe 099 antes de 090/094/095/096/097; a receita numérica põe 099 depois de 097. Não diferem somente as posições da 090/091. Não foi demonstrada incompatibilidade do schema final: 099 atua em convites, 090 em campanha/Fundador, 091 em documentos e os conjuntos dos modelos estão corretos. Isso permite aceitar o teste como construção do schema final, não como ensaio da trajetória de promoção com dados. Corrigir o comentário e explicitar esse limite; para afirmar equivalência de execução do runbook, comparar a sequência real com massa representativa e resultados, ou executar a ordem real.

### Equivalência do snapshot e próximos passos

`emSnapshotDesfeito` abre a transação em `recuperacao-modos.ts:324`; `proporCaso` sempre desfaz seu SAVEPOINT em `recuperacao-caso.ts:100`. As demais consultas do inventário são leituras; a escrita do arquivo vem depois da transação. Logo COMMIT externo isolado não confirma os efeitos normais das propostas. A afirmação é aceita nesse caminho com limpeza bem-sucedida; não prova resistência à quebra conjunta das duas barreiras, nem converte falha do rollback em sucesso. O mutante duplo e o mutante só do savepoint são relevantes; suas mortes são evidência reportada pelo autor, não repetida aqui.

Próximo: corrigir o procedimento; completar a matriz com dados e os cenários combinados; resolver a expectativa de exposição após reserva consumida; submeter o delta à revisão. HB-3/HB-4 não estão encerrados. HB-5 (runtime 22.23.2), HB-6 (PG* do staging), homologação e publicação continuam pendentes, com autorizações próprias. Nenhum P1 novo ou regressão funcional causada especificamente pela correção PERDIDA foi demonstrado.

## Revisão independente — HB-3/HB-4, correção 1 (28/10/2026)

**REPROVADO para encerrar HB-3/HB-4 e avançar H0.** Três P2 permanecem parciais; dois P2 e os dois P3 originais estão fechados. Há um residual P3 documental (código 4). Nenhum P1 identificado. Revisão local; código preservado, sem commit, banco ou acesso externo.

### Identidade e validação própria

HEAD db8d083bc663c9bb09df630ea7dac302dd3cc557, branch codex/recuperacao-pagamentos-b14-20261028, core.autocrlf=false, 56 entradas. Antes desta anotação, acumulado 034f934ab4b99a52e7ad7c962c9a6fafc4c9337c58fc36026d3b9bee2d432864 reproduzido; 9/9 hashes fornecidos conferidos. Árvore 12f6904c7877407ac6ee3757343a0e7d2a2f9cabf0842d7aafc5c850923d56b4, 45 arquivos, 618051 bytes.

Reviewer: 46/46 testes sem banco, zero falhas/pulados (execução, caso, efeitos, baseline, gravação só com mudança, seleção). Node 24.20.0, não o runtime alvo 22.23.2. Ambiente dos testes sem DATABASE_URL/PG*/opt-in de PostgreSQL. git diff --check limpo. Quatro cenários adicionais do módulo real pagamento.ts transpilado com SQL e ledger simulados; não são prova PostgreSQL nem de saldos/gatilhos. Evidências: D:/glass/KidMais Manager/revisao-b14-hb34-r1-20261028/{hashes.json,testes.log,provas.cjs,resultados.json}.

As 19 execuções PG, 7 mutantes, CI 32/32, eslint e tsc são resultados informados pelo implementador, não reexecutados nesta revisão. Não criado cluster nem acessado kidmais_manager, staging ou production. O registro documental muda o acumulado, não a árvore executável.

### Os sete achados anteriores

| Achado | Estado | Evidência |
| --- | --- | --- |
| P2-HB-1 — matriz sem dados | PARCIAL | recuperacao-prefixos.postgres.test.ts:299 agora cobre cancelamento e crédito perdido por prefixo, mas não a matriz de contraexemplos solicitada; caminhos com dados usam imports do checkout (:13), não a entrada do pacote. Detalhes abaixo. |
| P2-HB-2 — convergência em dois passos | PARCIAL | pagamento.ts:305 corrige status CONFIRMED→RECEIVED; teste PG :750 e prova offline confirmam o recorte. O retorno :309 ainda adia abertura/resolução da disputa quando há parcial novo. |
| P2-HB-3 — exposição de disputa ABERTA | FECHADO | pagamento.ts:190–196 separa bloqueio na abertura da atualização monotônica de exposição; teste PG :765 usa reserva real, consumo e estabilidade. D-HML-4 registrada como aceita. Prova offline própria confirma exposição 0→2000 e releitura sem escrita comercial. |
| P2-HB-4 — ordem RESTORE e reabertura | PARCIAL | Procedimento :70–100 corrige B-16, R, três provas, restore e bifurcação antiga/candidata. A tabela :14 ainda manda restore antes da DRENAGEM. |
| P2-HB-5 — garantia indevida do código 1 | FECHADO | Procedimento :60,65–67 reconhece gravações anteriores, evidência possivelmente ausente e COMMIT sem resposta; exige conferir antes de repetir. Ressalva de código 4 separada abaixo. |
| P3-HB-1 — fila/atualizada_em | FECHADO | Procedimento :121–126 distingue canônica, extra e cursor do pedido, coerente com UPDATE conferida_em e gatilho da 095. |
| P3-HB-2 — ordem da 099 | FECHADO | Receita :113–127 e :223–240 executa os modelos P0a…P11 na ordem do runbook; PH mantém ordem numérica. Isso não prova a promoção com dados entre migrations, mas fecha a divergência da receita apontada. |

### P2-HB-1 residual — a cobertura ainda não fecha §11

Local: lib/assinatura/recuperacao-prefixos.postgres.test.ts:299 (imports :13; comparação :383–387). A massa adicionada é útil: deixa de ser uma matriz vazia e já encontrou um defeito real. Porém, uma assinatura cancelada e um crédito recém-pago não exercitam todos os contraexemplos aplicáveis de docs/PLANO_RECUPERACAO_PAGAMENTOS_B14_20261027.md:493–514 e da revisão anterior.

Ainda falta transportar para as combinações aplicáveis, com dados: período local maior e oferta/Fundador perdido; devolução/arrependimento perdido; estorno >90 dias sem evento; parcial com status pago e transições combinadas; crédito correto versus saldo/estorno incorreto; pedido sem vínculo e cobrança não canônica; crédito vencido; base S0→S2; nenhuma ação bloqueando liberação; aplicação depois de Tf; mudança apenas de auditoria/notificação entre T1/T2. Alguns têm testes nas suítes 097/modos, o que não é ausência total de cobertura, mas não fecha combinação × caso. Não exigir créditos antes da 095.

A prova dita COMMIT incerto nesta matriz executa um COMMIT normal e depois consulta a execução correta/aleatória (:390–392): é prova de atribuição, não injeção de resposta perdida; não cobre aqui NAO_APLICADO. A comparação de efeitos retira toda auditoria e não compara chave/antes, então não demonstra o conjunto exato integral solicitado. Preservar a auditoria de domínio na comparação e excluir apenas o comprovante adicional, de forma nominal. Usar a árvore entregue também nos fluxos com dados; atualmente só as portas/cenários vazios usam a entrada extraída. O after tardio continua exigindo a prova de reinício/metadados da homologação, não é provado por um dublê SQL.

### P2-HB-2 residual — parcial ainda interrompe a transição da disputa

Local: lib/creditos/pagamento.ts:309 (resolução favorável :316–324). Cenário concreto: pedido creditado, disputa local ABERTA, provedor retorna RECEIVED com refunds DONE ainda não tratado. Primeira execução grava status/estorno/retenção e retorna REVISAO, mantendo ABERTA. Segunda execução, com a MESMA leitura remota, chega ao switch, desbloqueia o remanescente pelo caminho normal e marca FAVORAVEL. Portanto ainda há efeito comercial na segunda leitura. O caso inverso, nova CHARGEBACK_REQUESTED com parcial novo, adia ABERTA/exposição para a segunda leitura.

Prova própria offline: cenário pago simples tem escritas comerciais vazias na segunda leitura; resolução combinada tem FAVORAVEL na segunda; abertura combinada tem exposição na segunda; terceira fica estável. A sonda simula ledger, logo não certifica o saldo liberado nem afirma um defeito novo de dinheiro: a conclusão comprovada é a transição adiada. Corrigir o fluxo composto e provar em PG fotografia, retenção e ledger desde a primeira leitura. Não basta retirar o return sem verificar a convivência de retenção e disputa. Este caminho já existia antes do delta; foi apontado na revisão anterior e impede fechar §3.3.1, não é regressão causada pelo novo UPDATE de status.

### P2-HB-4 residual — duas sequências contraditórias

Local: docs/RECUPERACAO_PAGAMENTOS_B14.md:14. A tabela ainda diz manutenção → restore → export → VSC → DRENAGEM. A §5 agora está correta, mas um operador que seguir o resumo continua restaurando antes de drenar. Corrigir a tabela ou substituir a sequência por referência obrigatória à §5. A ressalva da :71 trata a tabela do plano, não corrige esta sequência explícita do próprio procedimento. Pós-reabertura com cron antigo e as três exigências da exceção interrupted estão fechados.

### P3-R1-1 — código 4 ainda promete “nada executado”

Local: docs/RECUPERACAO_PAGAMENTOS_B14.md:63. Residual da observação anterior: ENTREGA pode copiar arquivos antes de falhar com 4, e LIMPEZA pode remover parte dos arquivos antes de REMOCAO_FALHOU/4 (scripts/bloco-shell-recuperacao-b14.cjs:153,172,178). Restringir a garantia à operação de banco/provedor não iniciada por recusa prévia; não prometer ausência de efeitos no disco para todo bloco.

### Achados novos 2a e 2b e efeito de D-HML-4

**2a — máscara do instante: ACEITO no contrato atual, sem P1/P2 novo.** recuperacao-execucao.ts:248–254 preserva as pré-condições locais/remotas completas, o valor anterior, tabela/chave/operação, nomes de colunas e null versus preenchido. recuperacao-caso.ts:82 captura o hash da fotografia anterior e cada leitura remota; as datas existentes não são mascaradas na fotografia. Assim uma alteração real dessas entradas continua divergente mesmo se o novo cancelada_em estiver mascarado. Só o valor depois das três colunas da lista doInstante é ignorado nessa comparação. aplicarCaso (:124–127) continua comparando o hash integral depois de regravar os valores aprovados. Não encontrei caminho atual em que a máscara esconda mudança real de leitura. A garantia depende de manter essa lista restrita a valores do relógio: não generalizar para datas comerciais recebidas de fonte não capturada. Os testes próprios de execução/caso/efeitos passaram.

**2b — um caso por empresa com novo inventário: ACEITO operacionalmente para RESTORE assistido.** recuperacao-caso.ts:82 e procedimento :89. A dependência no agregado é conservadora e protege os efeitos compartilhados (assinatura, carteira, auditoria). Uma pré-condição restrita ao id do caso não seria substituição segura sem mapear todas as dependências. A massa prova recusa da proposta velha e aplicação após inventário novo. Há custo de tempo/cota e nova aprovação por hash; durante contenção ele é aceitável para este procedimento. Não tentar aplicar deliberadamente o segundo caso velho: inventariar antes. Para escala maior, medir duração e considerar otimização separada, preservando dependências e limites.

**D-HML-4:** atualizar exposição não lança crédito, bloqueio ou desbloqueio; o bloqueio continua na abertura. ledger.ts:187–195 encaminha saldo devolvido pela reserva para bloqueado/perda conforme o estado. Aumento da exposição é efeito não tolerado por semEfeito e deve bloquear a liberação até ser aplicado e relido; com consumo imóvel, converge. Não identifiquei efeito colateral novo de ledger causado por esse UPDATE. GREATEST conserva o máximo histórico, inclusive após FAVORAVEL (comportamento de resolução já existente); não interpretar a coluna como saldo líquido de perda atual. Permanece a ressalva independente da composição parcial/disputa acima. A confirmação integral dos saldos nos cenários combinados pede PG.

Próximos: completar matriz e pacote com dados, corrigir convergência composta, alinhar resumo RESTORE e qualificar código 4; nova revisão. HB-3/HB-4 não encerrados. HB-5/HB-6, homologação e publicação permanecem pendentes e exigem suas autorizações.


## Revisão independente — HB-3/HB-4, correção 2 (28/10/2026)

**REPROVADO para encerrar HB-3/HB-4 / H0.** Dois P2 ativos: regressão da comparação da base entre prefixos e cobertura/oráculo ainda parciais. Um P3 de validação (timeout sem causa determinada). Nenhum P1 identificado. HB-4 corrigido no escopo desta rodada; HB-3 permanece aberto. Revisão local, sem correção de código, commit, banco ou operação externa.

### Identidade e validação própria

Antes deste registro: HEAD db8d083bc663c9bb09df630ea7dac302dd3cc557; branch codex/recuperacao-pagamentos-b14-20261028; core.autocrlf=false; 56 entradas; 12/12 hashes fornecidos iguais. Acumulado 8869985bb27946075d17ed516e4067b80ad06f069725a2e30f2f102bbb460172 reproduzido pela concatenação dos mesmos bytes de git diff e arquivos não rastreados (excluído PLANO_RECUPERACAO). Árvore 1220e80835cd19a2daff3ae7e4322cbdbb11b2f44d2d9a2e5dc9b34c24a2af24, 45 arquivos, 620163 bytes.

Reviewer: **47/47 testes sem banco**, zero pulados/falhas, de baseline, execução, caso, efeitos e gravação só com mudança; duas sondas adicionais reproduzíveis. Node 24.20.0, não o alvo 22.23.2. Processo de testes sem DATABASE_URL/PG*/opt-in de PostgreSQL. git diff --check limpo antes do registro. Evidências: D:/glass/KidMais Manager/revisao-b14-hb34-r2-20261028/ (hashes.json, testes.log, prova-baseline.mjs/.json, prova-oraculo.cjs/.json).

PG 13/13, pagamentos, controle 19/19, 18/19 no clone, repetições 5/5, mutantes 5/5, CI, eslint e tsc são resultados **informados pelo implementador**, não reexecutados nesta revisão. Nenhum cluster criado, nenhuma consulta a kidmais_manager/staging/production. Registro documental muda o acumulado, não a árvore executável.

### Classificação solicitada

| Item | Prioridade | Estado | Evidência |
| --- | --- | --- | --- |
| Rodada 1: parcial × disputa (P2-HB-2) | P2 | FECHADO no fluxo apontado | pagamento.ts:313,328–332 não retorna antes da disputa composta e consulta a retenção já gravada; testes PG :797,813,830 verificam convergência, saldos, retenção e exposição. PG foi lido, não repetido pelo reviewer. |
| Rodada 1: cobertura por combinação/pacote (P2-HB-1) | P2 | PARCIAL | Imports do pacote :305 e COMMIT sem resposta :327 são avanços reais. Ainda faltam casos/combinações e comparação integral; detalhes abaixo. |
| Rodada 1: tabela do procedimento (P2-HB-4) | P2 | FECHADO | RECUPERACAO_PAGAMENTOS_B14.md:14 coloca barreira, R/instâncias, reinício e prova da drenagem antes do restore; inclui inventário novo entre casos da empresa. |
| Rodada 1: código 4 (P3-R1-1) | P3 | FECHADO | Procedimento :63 restringe ausência de execução à entrada/banco/Asaas, reconhece efeitos parciais no disco e explica retomada. |
| Novo 3a: NAO_APLICADO com instante recalculado | P2 | FECHADO no contrato atual | recuperacao-modos.ts:492 usa assinaturaDaProposta; recuperacao-execucao.ts:248–254 preserva pré-condições completas e valores anteriores, mascarando apenas depois de colunas doInstante. Teste do pacote :390–396 injeta COMMIT desfeito. |
| Novo 3b: hash entre schemas | P2 | PARCIAL; regressão aberta | recuperacao-baseline.ts:163 elimina o falso positivo de crescimento do schema, mas também deixa passar mudança comercial real. A sonda abaixo reproduz o falso negativo. |

P2-HB-3 (exposição), P2-HB-5 (código 1), P3-HB-1 (fila) e P3-HB-2 (ordem 099), já fechados na rodada 1, não foram reabertos por esta revisão.

### P2-R2-1 — Mudança comercial desaparece na comparação entre prefixos

Local: lib/assinatura/recuperacao-baseline.ts:163; efeito em lib/assinatura/recuperacao-modos.ts:263–265. A §3.5 do plano exige detectar hash diferente; retirar toda comparação quando muda a impressão não distingue mudança estrutural esperada de alteração comercial. Os indicadores são contagens, não valores: uma cobrança problemática pode continuar sendo uma, com um estorno muito maior.

Prova própria sem banco, com dados sintéticos e as funções reais classificar, itemDaBase, hashComparavel e compararComBase: mesmo pedido CREDITADO, mesma cobrança RECEIVED, estorno remoto DONE sobe de 1000 para 8000 centavos e muda o efeito proposto de estornado_centavos. Classe PROPOSTA nos dois lados; indicadores iguais; nenhum prazo cruzado; hash comparável diferente. **P7→P7: HASH_DIFERENTE. P7→P8: agravados vazio.** Como o pedido já existia em P7, não é novoSemComparacao. O filtro naBase exclui a pendência da JANELA; com o restante completo, pode terminar com código 0. A sonda prova o comparador e a classificação, não uma execução PostgreSQL integral do modo.

A regressão é introduzida por 3b. O teste recuperacao-baseline.test.ts:137 apenas fixa a dispensa de hash; não separa crescimento estrutural de mudança real. A trajetória positiva :561 também não tem controle negativo comercial.

Correção pedida: comparação comercial estável entre versões (projeção/mapeamento explícito dos campos/efeitos comuns, com tratamento das adições esperadas) preservando a base original. Manter positivo S0→S2 sem agravamento indevido e acrescentar negativos com mudança de valor, leitura remota e efeito operacional. Não basta ampliar contadores nem aceitar qualquer hash diferente entre prefixos.

### P2-HB-1 residual — Matriz e oráculo ainda não fecham a §11

Local principal: lib/assinatura/recuperacao-prefixos.postgres.test.ts:342; também :492,403,426,518,561.

- **Oráculo continua incompleto:** efeitosVisiveis remove TODA auditoria e compara somente tabela/operação/valores depois, sem chave ou antes. A correção solicitada na rodada 1 não entrou. Sonda extraindo e transpilando o helper real demonstrou que uma cobrança de chave c1 trocada por c2, com antes 0 trocado por 999, mais INSERT de auditoria indevida, passa na mesma comparação. Isso é fragilidade da prova, não demonstração de que o serviço efetivamente grava esses efeitos errados. Comparar o conjunto integral normalizado, removendo apenas o comprovante adicional nominal, e validar o próprio oráculo com controles negativos.
- **Combinação não equivale a modelo:** o teste de contraexemplos :492 usa find e escolhe apenas um código admitido por prefixo. O teste RESTORE anterior percorre ambos; este precisa também percorrer cada combinação aplicável.
- **Transições parciais/disputa e estados estáveis:** novos testes estão na suíte pagamentos, selecionada apenas no modelo 097 (scripts/regressao-v1-selecao.cjs:228), não na matriz do pacote desde P7. Não são exigíveis antes da 095.
- **COMMIT com crédito:** a perda de resposta por combinação está injetada no caso EMPRESA. O crédito em :423 usa COMMIT normal. Falta transportar os casos WALLE/carteira nova, vínculos simbólicos e crédito vencido/expiração para as combinações pertinentes.
- **Crédito vencido em :524:** o inventário prova recusa SERVICO:CREDITO_VENCIDO_NA_RECUPERACAO, não a aplicação assistida com lote/carteira/expiração/notificação exigida pela §11. Asserções de classe/recusa são úteis, mas não substituem a fotografia dos efeitos.
- **Outros negativos remanescentes por combinação:** NENHUMA com efeito bloqueando liberação (o teste atual decide APLICAR), mudança exclusivamente de auditoria/notificação entre T1/T2, crédito correto versus saldo/estorno incorreto. A trajetória com dados S0→S2 foi adicionada, mas requer o negativo de 3b acima.

Os imports de modosDoPacote fecham o defeito de usar módulos do checkout nos novos fluxos com dados. As fixtures podem continuar no checkout. Não se confunde isso com prova de toda a entrada CLI, cujas portas já têm cobertura própria. A drenagem real por reinício continua pertencendo à homologação, como previsto no plano.

### D-HML-5 — Retenção e saída operacional

A decisão é coerente no cenário revisto: FAVORAVEL resolve a disputa; não resolve a retenção independente de estorno parcial. Não encontrei crédito necessariamente preso sem saída. lib/creditos/operacao.ts:95–113 aceita a retenção, permite LIBERAR por desbloquear ou CANCELAR por cancelarBloqueado, limpa a retenção, registra perda definitiva quando apropriado e audita. ledger.ts:120 considera retenção ao tratar reservas; :236 faz o desbloqueio por lançamento. Portanto não há necessidade de reabrir a disputa para decidir o parcial.

Os novos testes confirmam o saldo bloqueado, mas não executam o caminho completo FAVORAVEL+retenção → decisão LIBERAR/CANCELAR → releitura, nem a devolução de reserva pendente nessa composição. Acrescentar essas provas como complemento da matriz; não atribuo um novo defeito funcional sem demonstração. Decisão anterior de perda/devolução e lote vencido devem continuar respeitados; não interpretar LIBERAR como garantia de disponibilizar créditos já cancelados/expirados.

### Fixture com replica — alcance da evidência

lib/assinatura/recuperacao-prefixos.postgres.test.ts:462–463 usa SET LOCAL dentro da transação da fixture; inventário/proposta não rodam dentro desse bloco. Não encontrei desativação persistente de gatilhos no código lido. Logo isso não invalida, por si só, a prova posterior de recusa/descoberta.

Mas não prova que a fixture seria produzida pelo fluxo normal com todos os gatilhos: além de datas, :478 muda estado de Fundador. Em :518 só pedido.criado_em/creditado_em recuam; lote/lançamentos mantêm a cronologia recente. O teste demonstra enumeração de pedido marcado como antigo, não integridade temporal de um crédito de 100 dias, expiração histórica ou preservação dos gatilhos durante a construção. Declarar o limite, verificar retorno de session_replication_role e invariantes relevantes, e usar massa histórica coerente para alegações de validade/ledger. Esta limitação integra a cobertura P2; não é um novo defeito do produto.

### P3-R2-1 — Timeout intermitente ainda sem diagnóstico

Local: docs/RECUPERACAO_PAGAMENTOS_B14_IMPLEMENTACAO.md:592; teste lib/assinatura/recuperacao-modos.postgres.test.ts:368; limite configurado em lib/comercial/postgres-descartavel.ts:40.

**ABERTO como ressalva de validação**, sem evidência suficiente para classificar defeito funcional P2. Uma conexão elimina algumas hipóteses de bloqueio entre clientes do teste, mas não prova carga da máquina. Duas repetições 5/5 e controle isolado 19/19 reduzem a suspeita de determinismo; não transformam a execução 18/19 em PASS nem identificam a causa.

Antes de declarar HB-3 integralmente validado, preservar consulta/stack/SQLSTATE do timeout, conferir se o controle corresponde à mesma árvore e repetir a rodada completa com diagnóstico de duração/esperas. Se recorrer, capturar pg_stat_activity/pg_blocking_pids e plano da consulta no descartável autorizado. Não aumentar o timeout para simplesmente esconder a falha. Não é necessário bloquear a análise das correções focais já fechadas por causa desse evento.

Próximos: corrigir comparação entre schemas, completar matriz e oráculo, investigar a validação intermitente e submeter nova revisão. HB-5/HB-6, homologação, merge e publicação continuam pendentes, cada qual com seu gate/autorização.



## Revisão independente — HB-3/HB-4, correção 3 (28/10/2026)

**REPROVADO para encerrar HB-3 / H0.** O P2 de comparação comercial entre prefixos está fechado no escopo da cadeia admitida; o P2 de cobertura permanece parcial. Timeout: P3 parcial, sem defeito funcional demonstrado. HB-4 permanece fechado. Nenhum P1 ou regressão funcional nova demonstrada nesta rodada.

## Identidade e validação própria

Clone `D:/glass/KidMais Manager/kidmais-manager-recuperacao-pagamentos-b14-20261028`; branch `codex/recuperacao-pagamentos-b14-20261028`; HEAD `db8d083bc663c9bb09df630ea7dac302dd3cc557`; autocrlf=false. Antes deste registro: 56 entradas, 12/12 hashes conferidos, acumulado `32dc5f5e533038f38ae57cd4b76269afd43aa12b62b885cad5ed0ba3cf717e97`. Reconstituição byte a byte em Node do algoritmo fornecido, com diff Git e arquivos novos na ordem do status; resultado idêntico. Árvore `27eae3afd205b43a1e2dd48068eff813ef51f16bf7c318177fc78e0adf3b77a2`, 45 arquivos, 622765 bytes.

Reviewer: **38/38 testes sem banco**, zero pulados, baseline/efeitos/execução, Node 24.20.0; `git diff --check` limpo. Sondas próprias em `provas.mjs` e `resultados.json`: backfill comercial detectado; coluna nova ignorada; remoto alterado detectado; máscara muda somente o valor posterior do instante e preserva mudança na fotografia anterior. Oráculo REAL extraído/transpilado: detecta chave errada, valor anterior errado e auditoria adicional; recusa comprovante ausente, duplicado ou de outro caso. Sem carregar a suíte PG nessas sondas.

PG 19/19, sete rodadas diagnósticas, mutantes 5/5, CI 32/32, eslint e tsc são resultados informados pelo implementador, não reexecutados nesta revisão. Logs brutos do diagnóstico não foram apresentados com caminho verificável no pedido/documentação; não foram auditados. Nenhum cluster criado, banco acessado, código corrigido, commit ou operação externa. O registro documental altera o acumulado, não a árvore executável.

## Classificação dos quatro itens

| Item | Prioridade | Estado | Evidência |
| --- | --- | --- | --- |
| 3b: mudança comercial perdida entre schemas | P2 | FECHADO no escopo atual | `lib/assinatura/recuperacao-baseline.ts:221–232` projeta local/efeitos e mantém remoto; `:169` compara hash em qualquer prefixo. `lib/assinatura/recuperacao-modos.ts:262` usa a forma da base. Contraexemplo 1000→8000 e coluna ausente cobertos na unidade; sondas próprias confirmam backfill/remoto. |
| Matriz e efeitos incompletos | P2 | PARCIAL | Oráculo e iteração por código fechados (`recuperacao-prefixos.postgres.test.ts:342,348,520`). Residual de cobertura abaixo. |
| Timeout sem diagnóstico | P3 | PARCIAL | `docs/RECUPERACAO_PAGAMENTOS_B14_IMPLEMENTACAO.md:612–616`: instrumentação e repetições melhoram a evidência, mas não determinam causa do episódio original. |
| Novo 2: instante do cancelamento causa agravamento artificial | P2 | FECHADO | `recuperacao-baseline.ts:227–230` mascara somente `depois` não nulo das colunas doInstante. Unidade passa; valores anteriores/remoto continuam sensíveis. Trajetória PG positiva está em `recuperacao-prefixos.postgres.test.ts:631`, lida, não repetida. |

## P2-R3-1 — Cobertura ainda não fecha cada combinação da §11

Local principal: `scripts/regressao-v1-selecao.cjs:228`; complemento: `lib/assinatura/recuperacao-prefixos.postgres.test.ts:513`.

As correções são reais: efeitos completos incluem auditoria/chave/antes; comprovante é separado nominalmente e contado; os contraexemplos percorrem cada código admitido; mudança só operacional, NENHUMA e crédito com COMMIT perdido foram acrescentados. Não reabrir esses subitens.

Ainda faltam, nas combinações aplicáveis:

- A idempotência da §3.3.1 continua na suíte pagamentos, selecionada somente no modelo 097: `recuperacao-pagamentos.postgres.test.ts:210,543,572,606,674,687,721`. A suíte de prefixos não repete esses estados estáveis com fotografia/controle desde P7 para créditos e nos prefixos pertinentes para assinatura. Um crédito aplicado seguido de liberação não cobre PENDING, OVERDUE, PERDIDA, REVISAO, ENCERRADO e seus controles.
- Crédito correto com somente conferida_em versus saldo/estorno incorreto bloqueando a liberação, exigido em `PLANO_RECUPERACAO_PAGAMENTOS_B14_20261027.md:507,513`, não ganhou par positivo/negativo por combinação. O teste de coerência com fotografia adulterada permanece em pagamentos `:398`.
- A fila da suíte de prefixos é invariavelmente válida (`:81`): faltam, por combinação, fila recusada por motivo diferente de interrupted e interrupted com reativação/nova leitura/confirmação, exigidos na §11 `:518`. Os testes unitários de fila não substituem esse percurso de liberação.

O caso crédito com COMMIT gravado `:599–622` fecha o transporte do caminho APLICADO com efeitos completos. NAO_APLICADO/DIVERGENTE estão exercitados na matriz para EMPRESA `:414–432`; ampliar também os negativos de crédito é útil, mas não é necessário inventar uma exigência de produto diferente para reconhecer o avanço.

D-HML-5 integrada `recuperacao-pagamentos.postgres.test.ts:853–881` fecha a prova focal solicitada: LIBERAR/CANCELAR, reserva 300 consumindo 100, saldo final 900 disponível ou 900 cancelado e releitura SEM_EFEITO. Continua no 097, não substitui a matriz por prefixo.

Correção: completar os três grupos acima no pacote por combinação aplicável, com controles positivos/negativos e fotografia, ou obter revisão explícita do contrato de cobertura. Não declarar HB-3 integral enquanto a §11 vigente exige mais do que o runner seleciona.

## Projeção, semântica e E0

Backfill que modifica valor de uma coluna projetada altera o hash, inclusive no mesmo prefixo. As exceções são as colunas de observação já deliberadamente toleradas; o instante posterior do efeito é mascarado, mas o valor local anterior permanece comparado. Mudar o significado de uma coluna conservando nome/valor não é detectável por esse hash: a forma registra nomes, não tipos, constraints, corpo de funções ou significado comercial. Não foi identificada tal reutilização na cadeia atual; não classifico a hipótese de uma migration futura como bug atual. A admissão de novas migrations exige revisão semântica e mapeamento explícito quando necessário, além do controle de integridade do B-5.

Colunas/tabelas novas são intencionalmente excluídas da comparação com a base antiga; isso não é prova geral de neutralidade de toda adição. Novos tipos de crédito têm a regra novosSemComparacao. Não generalizar a garantia para novas migrations ou alterações arbitrárias em campos excluídos.

E0: `recuperacao-modos.ts:184–188` lê information_schema.columns da lista fechada public pela mesma conexão de domínio. Não depende dos arquivos do deploy antigo nem requer ferramenta extra do Shell. Uma conta que consegue a fotografia por SELECT das tabelas também deve ter visibilidade das respectivas colunas; não foi demonstrado problema de permissão neste caminho. O catálogo é lido depois das fotografias (`:254`), fora do snapshot da enumeração: a operação pressupõe ausência de DDL concorrente durante a selagem. O runbook deve preservar E0 antes das migrations. Validar completude da forma contra as tabelas fotografadas e manter snapshot/checagem de schema seria endurecimento útil, não um bypass comprovado no roteiro atual. Compatibilidade de Node 22.23.2 e ensaio real do Shell permanecem HB-5/homologação; esta revisão offline não os certifica.

## P3-R3-1 — Diagnóstico não prova causa de I/O

Local: `docs/RECUPERACAO_PAGAMENTOS_B14_IMPLEMENTACAO.md:615–616`.

Durations de DROP/INSERT/BEGIN mostram latência, não isolam disco de CPU, escalonamento, antivírus ou outras pausas. log_lock_waits cobre esperas de locks que ele registra, não todo tipo de espera; ausência de espera longa nas novas rodadas não explica o timeout antigo que não voltou a acontecer. A conclusão defensável é: não reproduzido, com latências locais relevantes e sem espera longa de lock observada nessas repetições; I/O é hipótese. Não é prova de falha funcional P2.

Para fechar o residual: vincular logs/saídas e identidade da árvore às rodadas; preservar SQLSTATE/stack/consulta original se disponíveis e declarar explicitamente sua ausência se não; corrigir a atribuição causal. Se reaparecer, capturar atividade/bloqueadores e wait events durante a ocorrência. Não é preciso reproduzir indefinidamente para aceitar risco residual, mas essa aceitação não deve ser registrada como causa comprovada. Não alterei timeout, fsync ou synchronous_commit.

## P3-R3-2 — §11 ainda descreve o crédito vencido superado por decisão

Local: `docs/PLANO_RECUPERACAO_PAGAMENTOS_B14_20261027.md:503,516` (também `:191`).

A decisão de Felipe de 27/10 já está documentada em `RECUPERACAO_PAGAMENTOS_B14_IMPLEMENTACAO.md:80` e implementada em `lib/creditos/pagamento.ts:120–132`: REVISAO sem lote/notificação, sem crédito automático posterior. O teste da rodada 3 `recuperacao-prefixos.postgres.test.ts:567–577` aplica e fotografa esse comportamento correto. Retifico a cobrança literal do parecer anterior por lote/EXPIRACAO no vencido: esses efeitos não devem ser reintroduzidos para satisfazer texto antigo. Atualizar o plano para a decisão já tomada, mantendo prova de ausência de lote/notificação e persistência da revisão; isto é incoerência documental, não regressão do serviço.

Próximos: fechar o residual da matriz, ajustar os dois pontos documentais de precisão e submeter nova revisão. HB-4 e os fechamentos anteriores permanecem; HB-5/HB-6, homologação e publicação continuam pendentes e exigem seus próprios gates.


### B-14 — revisão independente HB-5 (28/10/2026)

**APROVADO: HB-5 fechado LOCALMENTE; sem novo P1/P2/P3.** Identidade, acumulado 5424c0d0…, cinco hashes de arquivos, árvore 27eae3af… (45 arquivos/622765 bytes), ZIP do Node e manifesto (14/14) conferidos antes deste registro. Node 22.23.2: reviewer 13/13 (8 diagnóstico + 5 Shell, incluindo PTY real e recusa do runtime divergente); Node 24.20.0: diagnóstico 8/8. Sonda independente de timers 7/7 em cada runtime, zero timers pendentes após relançamento. Recolocar unref em cópia isolada: Node 22 pass 1/cancelled 7, saída 1; Node 24 pass 8, saída 0. Remoção de unref e PATH por process.execPath aceitos.

CI completo e PG não reexecutados: logs conferidos registram CI 32/32 nos dois runtimes e PG 32 arquivos no Node 22. Saída específica DIAGNOSTICO_PG_TIMEOUT + 57014 da sonda provocada não está nos logs r7 apresentados; permanece relato do autor (o timeout aparece no servidor). Os sete mutantes anteriores, tsc e eslint não reexecutados. Não há fotografia autenticada da rodada 6 para certificar exclusividade histórica do delta; arquivos atuais e mudança descrita revisados. Primeiro ensaio de Shell bloqueado por EPERM de junction no sandbox, repetição autorizada passou.

Windows local não certifica Linux/Render: HB-6 e ENTREGA-CONFERIR no staging pendentes, H1–H9 não autorizado. Sem banco, secrets, commit ou operação externa. Parecer e provas: [revisao-b14-hb5-20261028/PARECER.md](<D:/glass/KidMais Manager/revisao-b14-hb5-20261028/PARECER.md>). Registro documental altera o acumulado, não a árvore executável. Próximo: HB-6 mediante escopo/autorização próprios e gate de homologação.

## B-23 — bases antigas em lista fechada (LOCAL, 30/10/2026)

Origem: revisão da rodada 17 do plano de promoção (R17-F2, P2). Production passou de `00d3019a` (#232) para `4ef9adb6` (#274, painel) em 30/10. Com o antigo fixo em `00d3019a`, `codigoNoAr(4ef9adb6…, C)` dava `null`, e a entrada recusava todos os modos, menos a fila, com `CODIGO_NO_AR_DESCONHECIDO` (`scripts/recuperacao-pagamentos-producao.cjs:263-266`). Ou seja, o B-14 não servia para a production que existe hoje.

**Mudança:**
- **Lista fechada:** `CODIGO_ANTIGO = '00d3019a'` (prefixo) passa a ser `CODIGOS_ANTIGOS` (lista congelada, **SHA completo**) em `lib/assinatura/recuperacao-execucao.ts`: `00d3019ade199ce609eab296050e07f4b379e87b` (#232) e `4ef9adb6830f0816f8a2f2ae0c98e16b8357db61` (#274). `codigoNoAr` aceita a candidata exata ou um item da lista. O prefixo sozinho deixou de bastar: outro SHA com o mesmo prefixo é recusado, e por isso o critério ficou mais estrito.
- **O que não muda:** a matriz de modos (`modoAdmitido`), a semântica de ANTIGO (exceção expressa, prova do cron antigo `7ce0916f`, D-B14-18), os blocos de Shell e a árvore entregue (só `recuperacao-execucao.ts` muda dentro dela).

**Prova de cada base** (regra para entradas futuras):
- **Diff:** o diff desde `00d3019a` não toca `lib/`, `app/api/`, `database/`, `scripts/assinatura-*` nem a entrada do cron.
- **`4ef9adb6`:** `git diff --name-only 00d3019ade199ce609eab296050e07f4b379e87b 4ef9adb6830f0816f8a2f2ae0c98e16b8357db61` = `components/admin/AdminShell.tsx`, `components/admin/LogoEmpresa.tsx`, `components/admin/shell.module.css`, `public/assets/iafest/logotipo-painel.png`, `public/assets/iafest/simbolo-painel.png`, `scripts/painel-multi-ui.cjs`, `scripts/painel-reauth-ui.cjs` e `scripts/painel-troca-sessao-ui.cjs`. Nenhum caminho de cobrança, webhook, migration ou cron.
- **Cron de production:** continua em `7ce0916f`, e a #274 não o publicou.

**Regra de processo:** depois de congelar a candidata, uma promoção seletiva para production muda a base antiga. Ela exige uma entrada nova nesta lista, com a prova, PR e revisão, antes de qualquer janela. Sem isso, o B-14 recusa com `CODIGO_NO_AR_DESCONHECIDO` (fail-closed).

**Recongelamento (revisão B23-F2):** a lista está em `recuperacao-execucao.ts`, dentro da árvore entregue. Uma entrada nova muda a candidata `C`, o hash da árvore e os hashes dos arquivos que os blocos fixam (`--candidata`, `ARVORE_OK`, `SHA256SUMS`). Não é possível manter o SHA de `C`, a árvore anterior e a lista nova ao mesmo tempo. Sequência obrigatória:
1. interromper a preparação ou a janela em curso;
2. refazer a prova da base nova (B-23) e a composição candidata × production (§2.7 do plano);
3. integrar a entrada por PR revisada;
4. recongelar `C` no novo SHA;
5. regenerar blocos e manifestos e atualizar as evidências e autorizações vinculadas ao SHA novo;
6. repetir os gates afetados antes do E0.

Nunca reutilizar blocos da `C` anterior nem trocar a `--candidata` de um bloco para a guarda passar. Uma ferramenta entregue separada de `C` exigiria contrato próprio, definido e revisado.

**Limite:** a lista recusa código desconhecido nos modos que dependem da matriz, antes de conectar ao PG. Ela não impede uma promoção seletiva, não confere PR nem revisão, e não vincula a prova a cada entrada (lista e teste podem mudar juntos). A prevenção operacional é do processo de promoção e da trava de deploy (B-22, D-OP-5). O B-23 não é trava de deploy.

**Testes:**
- `recuperacao-execucao.test.ts`: as duas bases aceitas, com maiúsculas e espaços; a lista congelada; o prefixo sozinho recusado para as duas; a candidata vence quando coincide.
- `recuperacao-prefixos.postgres.test.ts`: o ramo ANTIGO usa a base vigente `4ef9adb6`.
- `bloco-shell-recuperacao-b14.test.cjs`: o CONFERIR-E0 roda com `4ef9adb6` (antes, um SHA com prefixo `00d3019a` e zeros). Esse teste encerra em `ASAAS_DESLIGADO`, antes da classificação: prova a árvore e a guarda do Shell, não o aceite da base.
- `recuperacao-pagamentos-producao.test.cjs` (revisão B23-F1): o CLI, sem banco, com o `pg` trocado por um dublê que lança ao criar o Client. Cada base exata (também em maiúsculas e com espaços) chega ao Client. Um SHA desconhecido, o mesmo prefixo com sufixo falso ou a falta de `RENDER_GIT_COMMIT` recusam com `CODIGO_NO_AR_DESCONHECIDO`, sem Client. A candidata exata em P0a cai em `MODO_NAO_ADMITIDO`.
