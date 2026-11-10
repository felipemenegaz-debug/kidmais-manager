# Franquias de IA por plano — F1 (03/11/2026)

Estado: **LOCAL**, sem commit, sem PR, sem deploy. Migration 116 **não aplicada** em staging nem em produção.
Plano de origem: vault, `07 - Roadmap/Plano franquias de IA por plano 20261102.md` (rev. 4.1, APROVADO COM RESSALVAS pelo
Astra; P2 fechada na 4.1; D-FR-1..12 decididas por Felipe em 03/11/2026).

## O que a F1 entrega

- **Migration 116** (`database/migrations/20261103_116_franquias_ciclo.sql`), só acréscimos:
  - `ia_credito_franquias_ciclo`: uma linha por lote de franquia reconhecido pelo motor por plano (ADOCAO ou
    RECONHECIMENTO), 1:1 com o lote, só inserção (gatilho recusa UPDATE/DELETE);
  - `ia_credito_franquia_pendencias`: intenção de reconhecer, gravada na mesma transação em que a sincronização troca a
    contratação atual;
  - `ia_credito_notificacoes.tipo` ganha `FRANQUIA_80` e `FRANQUIA_100`.
  - precheck, postcheck e rollback em `database/checks/20261103_116_*` e `database/rollback/20261103_116_*_down.sql`.
    O rollback recusa sem efeito se já houver franquia reconhecida ou aviso de uso.
- **Regra pura** (`lib/creditos/franquias-regra.ts`): tabela versionada `2026-11-03` (CONVITES 10/15/30; WHATSAPP
  0/0/300; COPILOTO 100/300/1000), devido reconstruído do histórico do ciclo, chaves `FRANQUIA:<AAAA-MM>[:R<n>]`, marcos 80/100.
- **Motor** (`lib/creditos/franquias.ts`): `reconhecerFranquia` (só CONVITES nesta fase), pendências e avisos de uso.
- **Ligações**:
  - `lib/creditos/manutencao.ts`: com a flag desligada ou sem a 116, o worker segue o caminho legado
    (`concederFranquiaConvites`); `SEM_LIMITE` (teste, isenta, sem contratação confirmada) também volta ao legado;
  - `lib/assinatura/sincronizacao.ts`: registra a pendência (em SAVEPOINT; sem a 116, nada) quando a contratação muda;
  - `scripts/creditos-manutencao.cjs`: com a flag ligada, processa as pendências antes da manutenção diária;
  - `lib/exportacao/entidades.ts`: `creditos/franquias` exportado (migração 116); pendências fora (técnicas).
- **Flag** `CREDITOS_FRANQUIA_PLANO_ATIVO` (desligada por padrão; só o texto `true` liga).

## Provas locais (cluster descartável próprio, porta 55742, PostgreSQL 18)

- Unitários: `lib/creditos/franquias-regra.test.ts` 12/12 (os sete exemplos de novembro/2026, limites, chaves e marcos);
  `lib/creditos/creditos.test.ts` 15/15 (flag nova).
- PG `lib/creditos/franquias-116.postgres.test.ts` (modelo 112) 10/10:
  1. sem a 116, código compatível; 2. pre/post/reaplicação/rollback vazio/reaplicação; 3. flag desligada = legado;
  4. SEM_CORTE, MES_DO_CORTE, SEM_LIMITE (teste e isenta), HISTORICO_DIVERGENTE, ACESSO_NAO_COMPLETO;
  5. recorrente, upgrade (complemento `:R2`), ida e volta, adoção do lote legado, repetição sem efeito, só inserção;
  6. conflito de chave = erro (pendência `CHAVE_EM_CONFLITO`); 7. corrida real de três sessões com espera observada;
  8. pendência gravada pela sincronização real (`sincronizarEmpresa`) e processada; 9. avisos 80/100; 10. rollback recusado.
- Suítes PG vizinhas no mesmo cluster: créditos 095 e aplicador 095, sincronização E8 (cobrança e contratação),
  Fundador, recuperação B-14 (modos, pagamentos, prefixos), renovação agendada e arrependimento 097 — **45/45 arquivos**.
  Fundador falhou uma vez por falso positivo PRÉ-EXISTENTE do teste (o detector de documento vazado casa 11 dígitos
  seguidos dentro de um UUID aleatório, ex.: `…-61354390382c`); repetida, 6/6. Não relacionado à F1.
- **Não rodadas:** `exportacao.postgres` e `exportacao-adversarial.postgres` (modelo 098): a receita do modelo 098 aborta
  no RETRATO na própria base staging `da286212` (defeito conhecido desde #300/087). A entrada `creditos/franquias` no
  inventário da exportação fica sem prova PG até o 098 ser corrigido.
- **Mutantes** (clone LF isolado `kidmais-manager-franquias-f1-mut-20261103`, `npm ci` próprio): 20 de 20 mortos, controle
  verde. D2 (rollback sem a recusa por franquia) **sobreviveu** na 1ª rodada — o cenário 10 aceitava qualquer recusa e os
  avisos do cenário 9 mascaravam; o teste passou a exigir a mensagem de cada guarda (e o cenário 2 prova a guarda dos
  avisos sozinha), e D2/D3 morreram.
- Desvio declarado do plano (§4.5, M-A): o plano previa "outbox `FRANQUIA_RECONHECER` na fila que a F1 escolher"; a F1
  escolheu uma tabela própria (`ia_credito_franquia_pendencias`, PK empresa+contratação), sem misturar com outra fila.
- **CI local** (todos os 54 passos de `.github/workflows/ci.yml`, exceto `npm ci`): verde. `check:v1:static` 4229/4229 +
  103/103, build OK (uma tentativa caiu por erro interno do Turbopack na fonte Google, "queries have exactly one entry";
  limpo o `.next`, passou), lint 0 erros (3 avisos antigos em arquivos fora da F1); `production:test` 37/37.
  Ajustes que a F1 exigiu: inventário fixo de produção com a 116 (e 116 na lista de autorização explícita), banco
  simulado de `ofertas.test.ts` com o SAVEPOINT da pendência, teste das flags com `franquiaPlano`.
- Achado da própria suíte: o postcheck comparava todas as linhas de `pg_constraint`, e o PG 18 registra NOT NULL como
  `contype = 'n'`; o postcheck agora ignora esse tipo (vale para qualquer versão).

## Rodada 2 (03/11/2026) — correções da revisão r1 do Astra (REPROVADO: 0 P1, 4 P2, 3 P3)

- **P2-1 deadlock — ordem global de travas: `empresas` (KEY SHARE) → carteira → `empresa_assinaturas` (FOR SHARE).**
  - O ciclo da r1: a manutenção segurava a assinatura (FOR SHARE) e o INSERT do aviso pedia KEY SHARE na empresa (FK das
    notificações); a sincronização segura a empresa (FOR UPDATE) e espera a assinatura.
  - A primeira correção desta rodada (empresa travada DEPOIS da carteira) abria outro ciclo: a geração de convites
    (`lib/convites/service.ts`) trava a empresa FOR UPDATE e só depois a carteira (reserva). A ordem final segue a do resto do
    sistema: **empresa primeiro**. `travarEmpresaAntesDaCarteira` é o primeiro comando de `manutencaoEmpresa` (com ou sem
    a flag: só trava, não grava) e de `reconhecerFranquia` (chamado também pela fila de pendências).
  - **Desvio do texto do plano** (§4.2 "Ordem de travas: carteira → empresa_assinaturas"): passa a ser empresa → carteira →
    assinatura.
  - Provas PG com código real e gatilhos ativos: 18 (manutenção primeiro, parada no aviso com carteira e assinatura nas
    mãos; a sincronização real espera já na empresa), 19 (sincronização real primeiro, segurando a empresa; a manutenção
    espera na empresa sem tocar a carteira), 20 (geração de convites: empresa FOR UPDATE → reserva na carteira).
  - **Risco pré-existente, fora da F1:** o pagamento de créditos avulsos trava a carteira e insere `PAGAMENTO_CONFIRMADO`
    (FK → KEY SHARE na empresa); a geração de convites faz empresa → carteira. As duas podem formar o mesmo ciclo. Não
    alterado aqui.
- **P2-2 avisos (§4.6):** `base = direito do ciclo + Σ(disponível + reservado) dos outros lotes válidos + consumo do ciclo
  nesses lotes`; `uso = consumo dos lotes da franquia do ciclo + consumo do ciclo nos outros lotes`. Lote vencido (ainda
  não expirado pelo worker), bloqueado, cancelado e expirado não contam. Prova 16: franquia 30 + cortesia 20 (60% sem
  aviso → 80% → 100%); vencido fora da base; cortesia que vence antes do fim do mês consumida primeiro (80% só com a fórmula
  nova).
- **P2-3 B-14:** `ia_credito_franquia_pendencias` (chave empresa:contratação; `criada_em`/`processada_em` instantes) e
  `ia_credito_franquias_ciclo` (chave recurso:ciclo:chave; `id`/`criado_em` gerados; `lote_id` vira símbolo do lote) entram
  em `TABELAS` e `FILTROS`. Unitário: pendência nova é INSERT e nunca `semEfeito`. Prova 21: proposta (T1 desfeita) e
  aplicação (T2) com o mesmo efeito, `efeitosPresentes` verdadeiro, repetição sem pendência nova, instante anterior ao
  início da aplicação = divergente.
  - **Coordenação:** `PREFIXOS` do B-14 (`recuperacao-baseline.ts`) não conhece a 116. Com a 116 aplicada, `prefixoDoSchema`
    não reconhece o schema e o B-14 recusa os modos de janela/restore (fica só `--fila`, falha fechada). Aplicar a 116 depois
    da janela do B-14, ou acrescentar um prefixo P12 numa entrega do B-14.
- **P2-4 postcheck:** a trilha (`ia_credito_franquias_ciclo`) continua tendo de estar vazia (flag desligada); pendências
  são aceitas só se legítimas: não processadas, sem tentativa nem motivo, de contratação CONFIRMADA da mesma empresa.
- **P3-5 mutantes:** executor novo `ambientes-locais/franquias-f1-mutantes-r2-20261103.cjs`: controle verde obrigatório;
  cada mutante declara os testes que devem falhar; MORTO só com código ≠ 0 e um desses testes falho; `null` = INFRA; falha
  em outro teste = FALHA_INESPERADA; log por mutante; um JSON por execução, nunca sobrescrito (execução filtrada = parcial).
  - **Bateria completa** `2026-11-03T14-33-32-094Z` (clone LF isolado ressincronizado com os 23 arquivos da rodada 2):
    controle verde (unitário 12/12, PG 21/21); **37 MORTOS** pelos testes declarados, 0 INFRA, 0 FALHA_INESPERADA, 0
    âncora inválida. Novos: H1/H2 (histórico), U1 (ciclo em UTC), F10 (trava DEPOIS da leitura), F11 (sem a trava da
    empresa), F12 (empresa depois da carteira), A1–A3 (fórmula dos avisos), P1 (sem ROLLBACK TO SAVEPOINT), B1/B2 (B-14),
    Q1–Q3/Q5/Q6 (postcheck).
  - **1 sobrevivente, equivalente:** Q4 (postcheck sem a marca de NOT VALID) — o `pg_get_constraintdef` já escreve
    `NOT VALID` na definição. A marca redundante saiu do postcheck e o Q4 saiu da bateria; reexecução parcial
    `2026-11-03T14-50-08-651Z` dos mutantes do postcheck (Q1–Q3, Q5, Q6) com o postcheck final: 5/5 mortos, controle verde.
- **P3-6 histórico gravado:** cada segmento leva `contratacaoId` e `confirmadaEm` (UTC, microssegundos), inclusive o inicial
  (contratação vigente no início do ciclo; `null` só quando não há). Prova 11.
- **P3-7 postcheck:** compara com literais as colunas (tipo, NOT NULL pelo `pg_attribute`, default), as constraints pela
  definição (`pg_get_constraintdef`, que já termina em `NOT VALID` quando a constraint não foi validada), os índices, o gatilho (`pg_get_triggerdef` + habilitado) e o
  corpo da função do gatilho. Prova 17 recusa cada divergência (NOT NULL removido/acrescentado, CHECK NOT VALID, UNIQUE com
  outras colunas, gatilho só UPDATE, gatilho desligado, função trocada) e cada pendência não legítima.
- **Provas que faltavam:** 11 (exemplos do §4.2 com valores literais por tamanho do mês: 28/29/30/31 dias), 12 (último
  minuto do mês em São Paulo — já o mês seguinte em UTC — conta; o fim exato não), 13 (plano desconhecido: `PlanoIlegivel`,
  nada gravado), 14 (falha do INSERT no SAVEPOINT da pendência: `false` e a transação segue com a escrita anterior), 15
  (falha ao gravar a trilha desfaz lote, CREDITO e saldo).
- Ajuste extra: a base dos avisos usa `disponível + reservado` dos outros lotes (a fórmula inicial desta rodada contava
  bloqueado e cancelado como saldo).

- **Regressão da rodada 2:** PG `franquias-116` 21/21; suítes vizinhas de créditos/assinatura/convites: 31 arquivos em 68
  execuções (variantes de modelo), 67 verdes de primeira; `renovacao-agendada [097]` falhou 2 testes por tempo (SIGKILL e
  PUT com resposta perdida) e passou repetida 2× (4/4 variantes cada), sem acoplamento com créditos; `avulsos-099` não
  roda (modelo 098 aborta no RETRATO, defeito conhecido). CI local 54/54 passos (static, lint, tsc, build, `production:test`).

## Rodada 3 (03/11/2026) — correções da revisão r2 do Astra (REPROVADO: 0 P1, 1 P2, 1 P3)

- **P2 — KEY SHARE não fechava o ciclo com a reconciliação da contratação.** A reconciliação trava a empresa FOR NO KEY
  UPDATE (compatível com KEY SHARE), depois a assinatura FOR UPDATE, e promove a empresa a FOR UPDATE (gatilho 074a no
  VINCULADA; `sincronizarEmpresa` depois do CONCILIADA). Com KEY SHARE a manutenção entrava junto, travava a carteira e
  esperava a assinatura → deadlock na promoção.
  - **Correção:** a primeira trava da manutenção e de `reconhecerFranquia` passa a **FOR SHARE** na empresa
    (`travarEmpresaAntesDaCarteira`). Conflita com FOR UPDATE e com FOR NO KEY UPDATE (a manutenção espera a reconciliação
    inteira, sem nada nas mãos) e continua compatível com KEY SHARE (o marcador de exclusão gravado na transação
    independente e as FKs de notificações/pagamento passam). Nada da manutenção promove a empresa (não escreve em
    `empresa_assinaturas` nem nas tabelas 074a), então duas manutenções da mesma empresa só se enfileiram na carteira.
    Ordem global: empresas (FOR SHARE) → carteira → empresa_assinaturas (FOR SHARE).
  - **Auditoria de quem trava a assinatura** (todas as escritas/travas de `empresa_assinaturas` em `lib/`): checkout,
    cancelamento, devolução (pedido), arrependimento, ofertas, sincronização e as operações do painel
    (`operarComercial`: estender teste, continuidade, recuperar vínculo) travam a empresa FOR UPDATE antes; a reconciliação,
    FOR NO KEY UPDATE antes; a liberação de intenção trava a assinatura sem a empresa, mas não escreve nela (só KEY SHARE
    pela FK da auditoria: compatível). **Dois caminhos escreviam na assinatura sem travar a empresa antes** (assinatura →
    gatilho 068 → empresa FOR UPDATE, o inverso da sincronização — ciclo pré-existente com ela e possível com a manutenção):
    - devolução D1 (resultado da remoção no provedor gravado depois do pedido) → extraído para
      `gravarResultadoCancelamento`, que trava a empresa antes quando vai marcar a assinatura;
    - B-14 `regravarDoInstante` → trava as empresas (ordem por id) antes dos UPDATEs.
  - Provas PG com código real e gatilhos ativos:
    - **22** reconciliação REAL (`processarEvento` → `reconciliarContratacao` → `sincronizarEmpresa`), duplicata sem
      pagamento: a reconciliação para na listagem do provedor com empresa e assinatura nas mãos; a manutenção espera **na
      empresa, sem a carteira**; liberada, a reconciliação grava o marcador na **transação independente**, exclui, fecha o
      marcador (`REMOCAO_CONFIRMADA`) e promove a empresa pela sincronização: `PROCESSADO/CONCILIADA`, manutenção sem erro;
    - **23** reconciliação REAL VINCULADA (vínculo antigo desconhecido, uma ativa): promoção pelo **gatilho 074a**;
      `PROCESSADO/VINCULADA`, assinatura ATIVA/PREMIUM, manutenção sem erro;
    - **24** devolução D1 e B-14 regravar com a empresa segura em FOR SHARE: cada uma espera a empresa e a assinatura continua
      livre (`FOR SHARE NOWAIT` de uma terceira sessão passa).
  - Não prova ausência global de deadlock (o Astra observou o mesmo nas corridas 18–20): cobre os ciclos conhecidos com
    código real e declara a auditoria acima.
- **P3 — redação dos lotes "fora" da base.** O filtro dos outros lotes é só liberação e vencimento; o lote nunca é excluído
  por bloqueio ou cancelamento: saldo = disponível + reservado (bloqueado, cancelado e expirado não são saldo), e o consumo
  **do ciclo** num lote válido continua na base e no uso. Comentário de `franquias.ts` reescrito com o exemplo do Astra;
  `usoDaFranquia` devolve direito/uso/base (os avisos usam o mesmo cálculo). Prova **25** com literais (franquia 30, 22
  consumidos; outro lote de 100 com 10 consumidos no ciclo):
  - nada fora do saldo: uso 32, base 130;
  - **90 cancelados** (exemplo do Astra): uso 32, base 40 → `FRANQUIA_80` (excluir o lote inteiro daria 22/30 ≈ 73%);
  - 50 bloqueados: uso 32, base 80;
  - reserva em aberto de 20: disponível 70 + reservado 20 = saldo 90; uso 32, base 130 (reserva não é uso);
  - franquia de ciclo anterior ainda vigente (50; 15 consumidos no mês passado, 5 neste): uso 27, base 65 (os 15 do mês
    passado ficam fora).
- **B-14 (coordenação aceita pelo Astra):** com a 116 aplicada, os modos fora de `--fila` ficam indisponíveis até uma entrega
  dedicada de compatibilidade (prefixo novo nos `PREFIXOS`). Aplicar a 116 depois da janela não habilita janelas futuras.
- **Pagamento × geração de convites:** confirmado pelo Astra como P2 **pré-existente, fora da F1** — precisa de correção
  própria e corrida determinística. Não alterado aqui.
- **Mutantes** (executor `ambientes-locais/franquias-f1-mutantes-r3-20261103.cjs`, clone LF isolado ressincronizado): 44/44 mortos (controle verde; diagnóstico K1 sem a asserção da carteira = 40P01 em 22 e 23).
  Novos: K1 (empresa em KEY SHARE, o modo da r2 — mata 22 e 23), O1/O2 (D1 e B-14 sem a trava da empresa — 24), A4–A7
  (bloqueado como saldo, lote com bloqueio/cancelamento excluído inteiro, reserva fora do saldo, consumo de ciclos
  anteriores — 25); F11/F12 passam a declarar também 22 e 23.
- **Regressão da rodada 3:** PG `franquias-116` 25/25; suítes vizinhas 31 arquivos/68 execuções verdes de primeira; unitários de assinatura/créditos 412/412; CI local 54/54.

## Revisão do Astra da rodada 3 — APROVADA (04/11/2026)

**APROVADO: 0 P1, 0 P2, 0 P3 novos.** O P2 e o P3 da r2 estão fechados no escopo revisado.

- **P2:** a manutenção espera em FOR SHARE antes de pegar a carteira, então não avança junto com o FOR NO KEY UPDATE da reconciliação e o ciclo some. Os testes 22 e 23 exercitam os dois ramos reais, inclusive o marcador independente e a promoção pelo gatilho. D1 e B-14 travam a empresa antes da assinatura, e o teste 24 confere.
- **P3:** comentário, cálculo e literais do teste 25 coerentes (32/40 = 80%).
- **Auditoria:** nenhum outro escritor de `empresa_assinaturas`, `assinatura_contratacoes`, `assinatura_fundadores` ou `assinatura_isencoes` exige correção. Painel, checkout e sincronização conferidos. `liberarIntencaoCriacao` é compatível.
- **Conflito novo aceito:** FOR SHARE também espera os UPDATEs comuns da empresa (NO KEY UPDATE implícito). A serialização aumenta, mas não aparece ciclo novo. A única aquisição explícita de FOR NO KEY UPDATE em `empresas` é a da reconciliação; edição de nome/status já trava em FOR UPDATE.
- **Evidências conferidas:** PG 25/25, mutantes 44/44, vizinhas 68, CI 54/54. Os 5 arquivos centrais batem com o clone dos mutantes (CRLF/LF normalizado). O Astra não reexecutou as suítes nem aplicou migrations.
- **Limitações mantidas:** a ausência global de deadlock não está demonstrada; a compatibilidade futura do B-14 está pendente; pagamento × geração de convites é P2 pré-existente fora da F1.

Situação: **APROVADA, LOCAL, sem commit/PR, 116 não aplicada.** O próximo passo depende de autorização do Felipe: commit + PR para staging (merge e deploy autorizados à parte), depois o aplicador da 116.

## Pendente antes de staging

- **Aplicador da 116** (padrão `scripts/migration-112-*` + bloco shell) — **adiado**, não existe ainda.
- ~~Revisão do Astra desta F1~~ — APROVADA na r3 (04/11).
- Ordem prevista: código compatível publicado → precheck → autorização → 116 → postcheck → flag continua desligada →
  decisão de ligar.

## Riscos declarados

- ~~A fotografia do B-14 não inclui as tabelas novas~~ — corrigido na rodada 2 (P2-3). Continua a coordenação dos
  `PREFIXOS` do B-14 (acima).
- Plano desconhecido na contratação vigente é erro (`PlanoIlegivel`), não inferência: a pendência fica aberta com
  `PLANO_ILEGIVEL` e o worker registra a falha.
- Risco pré-existente fora da F1 (confirmado pelo Astra na revisão r2 como P2 próprio): pagamento de créditos (carteira →
  empresa pela FK do aviso) × geração de convites (empresa → carteira). Precisa de correção e corrida determinística próprias.
- Corridas cobrem os ciclos conhecidos (sincronização, convites, reconciliação, D1, B-14), não provam ausência global de
  deadlock.
