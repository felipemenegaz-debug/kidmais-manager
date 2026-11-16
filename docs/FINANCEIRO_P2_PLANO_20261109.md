# Financeiro P2 — plano de execução — 09/11/2026

Base: `origin/staging` **cbf84e01** (P1 #364 incluída). Clone `kidmais-manager-financeiro-p2-20261109`, branch `codex/financeiro-p2-20261109`. Contrato: plano rev. 3.2 (`PLANEJAMENTO_FINANCEIRO_BASICO_AVANCADO_20261106.md`, seções C.2, C.2.1, C.2.2, E, E.2 e F), com as decisões D-FIN-1 a 13 e o complemento de D-FIN-7 de 07/11. Este documento não muda o contrato. Ele diz em que ordem, com que schema e com que provas a P2 será feita.

Felipe pediu para seguir com a P2 em 09/11/2026. Nada aqui autoriza aplicar migration em banco real, rodar PostgreSQL descartável, fazer commit, push, PR, merge ou deploy. Cada uma dessas ações precisa de pedido próprio.

## 1. O que a P2 entrega

| Parte | Hoje (lido no código) | Depois da P2 |
|---|---|---|
| Entrada manual parcial | `mapearManual` (`lib/financeiro/servico.ts:265`) lê 0% ou 100% pelo `recebido_em`. R$ 100 de R$ 300 viram 0 ou 300 | Liquidações por movimento; recebido = soma dos movimentos; status parcial |
| Reversão de pagamento de despesa | `financeiro_saidas` só soma; não há como desfazer um pagamento lançado errado sem apagar | Reversão ligada à saída, auditada; pago líquido das reversões em conta, caixa e resultado por festa; custo e margem contratual não mudam (C.4, D-FIN-6) |
| Status parcial de despesa | Pagamento parcial já existe (várias saídas); falta conferir rótulo e saldo na tela | "Parcialmente paga" com saldo, igual em lista, festa e resumo |
| Abertura de saldo | `saldoCaixaAte` (`servico.ts:1344`) soma tudo desde o início, inclusive histórico importado; `fluxoCaixa` mostra saldo inicial e final sempre | Saldo absoluto só com abertura confirmada (D-FIN-9). Sem abertura: movimento do período e `null` com motivo, nunca zero. Revisões, prévia, `versaoEsperada`, conferência de pendências (C.2.2) |
| UI | Sem ação de liquidar avulsa, reverter pagamento ou abrir saldo | Ações nas telas existentes, sem redesenho; Equipe usa liquidação e reversão; abertura e conferência só a Gestão |

Fora: P3 (gates e liberação do básico), P4 (projeção), P5 (séries), P6 (homologação). Preços, descontos, vitrine e assinaturas não são tocados.

## 2. Migrations (aditivas, numeração conferida em 09/11)

Staging vai até a 118. A 119 está reservada pela troca de empresa (vault, `Troca de empresa PR proprio plano 20261108.md`). Nenhuma branch remota nem clone local usa 120 ou acima. Conferir de novo antes do commit.

**120 — movimentos manuais e reversões**
- `financeiro_entradas_liquidacoes`: `id`, `empresa_id`, `entrada_id` (FK composta com empresa), `valor numeric(12,2) > 0`, `taxa numeric(12,2) >= 0 AND taxa <= valor`, `recebido_em date`, `forma`, `observacao`, `chave_idempotencia` única por empresa, `criado_por`, `criado_em`. Índice `(empresa_id, recebido_em)`.
- `financeiro_saidas_reversoes`: `id`, `empresa_id`, `saida_id` (FK composta com empresa), `valor > 0`, `revertido_em date`, `motivo text NOT NULL`, `chave_idempotencia` única por empresa, `criado_por`, `criado_em`. Índice `(empresa_id, revertido_em)`. A soma das reversões de uma saída não passa do valor da saída: guarda no serviço sob trava da conta, sem gatilho novo.
- Chaves únicas compostas `(id, empresa_id)` nas tabelas de origem, se ainda não existirem, para as FKs compostas.
- Nenhum backfill. Nenhuma alteração da 052.

**121 — abertura**
- `financeiro_aberturas`: revisões só por acréscimo. `id`, `empresa_id`, `versao int` (única por empresa), `data_base date`, `saldo numeric(12,2)` (pode ser negativo), `justificativa text NOT NULL`, `conjunto_conferido_hash`, `substitui_id`, `chave_idempotencia` única por empresa, `criado_por`, `criado_em`. Vigente = maior versão da empresa.
- `financeiro_abertura_conferencias`: `id`, `empresa_id`, `abertura_id`, `origem_tipo` (RECEBIMENTO, ENTRADA_MANUAL, LIQUIDACAO_MANUAL, SAIDA, REVERSAO_SAIDA, ESTORNO, DEVOLUCAO), `origem_id`, `atributos_hash`, `modo` (PREVIA ou CONFERIDO), `sequencia`, `chave_idempotencia`, `criado_por`, `criado_em`. Histórico só por acréscimo: única por `(abertura_id, origem_tipo, origem_id, sequencia)` e por `(empresa_id, chave_idempotencia)`; PREVIA só na sequência 1; vale a conferência de maior sequência da origem (reconferir depois de H1 → H2 acrescenta a seguinte, calculada pelo escritor sob trava da revisão). Correção da revisão R1 de 09/11.
- Down só sem dados, como a guarda da 052.
- Manifestos de exportação, fixtures de schema e conferidor de colunas atualizados junto.

## 3. Duas fases (E.2)

**Fase A — leitor.** Schema 120 e 121 aplicados, código que entende tudo o que B grava, nenhum escritor novo exposto.
- `mapearManual`: recebido = soma das liquidações; sem liquidação e com `recebido_em`, a linha legada vale como uma liquidação de `valor − taxa` naquela data (o que existe hoje continua igual).
- Pago da conta = saídas − reversões, em `mapearPagar`, `despesasPagasPorFesta`, `pagoNoPeriodo`, `fluxoCaixa` e `relatorio`. Reversão entra no caixa na data `revertido_em`.
- Caixa realizado e liquido manual por movimento, deduplicando por origem.
- Saldo por C.2.1: `saldoInicialCentavos` e `saldoFinalCentavos` passam a `number | null`, com `motivoSaldo` (`SEM_ABERTURA`, `ANTERIOR_A_ABERTURA`, `ATRAVESSA_ABERTURA`). Sem abertura, a resposta traz `movimentoPeriodoCentavos`. Pendências da conferência derivadas na leitura, com o aviso "A conferir: N movimentos, R$ X" em tela, Dashboard e Copiloto.
- DTO com versão explícita (`x-kidmais-financeiro-versao` 3) e campos antigos preservados, exceto o saldo absoluto sem abertura, que deixa de existir por estar errado. Tela atual aceita `null` (mostra "—" e o motivo); gráfico de saldo some sem abertura.
- MCP, IA, CSV e exportação usam o mesmo leitor.

**Fase B — escritor.** Rotas, serviço e telas:
- `POST /api/admin/financeiro/contas-receber/[entradaId]/liquidacoes` (parcial ou total, idempotente, recusa acima do saldo e data futura por `hojeBrasilia()`).
- `POST /api/admin/financeiro/contas-pagar/[contaId]/saidas/[saidaId]/reversoes` (idempotente, motivo obrigatório, não passa do valor da saída).
- `GET /api/admin/financeiro/abertura` (vigente, prévia e pendências) e `POST` (confirmar ou corrigir com `versaoEsperada`, resumo do conjunto, 409 com nova prévia se mudou); `POST .../abertura/conferencias` (individual ou lote, com versão da revisão e atributos vistos).
- Guarda por operação lida no servidor, cobrindo API e IA (E.2, gate 3). Desligar a escrita não esconde dados nem exportação.
- Papéis (D-FIN-7 e complemento de 07/11): Equipe liquida e reverte; abertura e conferência só a Gestão; somente leitura recusa tudo.

A fase B só vai para um ambiente depois que A estiver lá e conferida (gate 1). Versão mínima segura de retorno = commit de A.

## 4. Ordem de trabalho e provas

1. Caracterização: testes do comportamento atual de `mapearManual`, `mapearPagar`, `fluxoCaixa` e `saldoCaixaAte`, antes de mudar.
2. Migrations 120 e 121, com checks em `database/checks`, rollback guardado e manifesto de exportação.
3. Fase A, com unitários puros para C.2.1 (as cinco linhas), parcial manual, reversão e os casos numéricos da rev. 2 (sem abertura R$ 1.000 de movimento e nenhum saldo; com abertura de R$ 8.000, R$ 9.000; conta de R$ 300 com R$ 100 pagos = parcial com R$ 200; exemplo de C.2.2 fechando em centavos).
4. Fase B, com unitários de rota (papéis, idempotência, 409, data futura, outro tenant).
5. `tsc`, eslint, `check:v1:static`, build e os 21 passos do `ci.yml`.
6. Revisão do Astra.
7. PostgreSQL descartável nos modelos 062 e 114 com as migrations novas (concorrência real: duas liquidações, reversão × pagamento, conferência × troca de revisão). **Só com "Sim, rodar PostgreSQL".**
8. Commit, PR, merge e deploy da fase A; conferência em staging; depois o mesmo para B. Cada passo com pedido próprio.

## 5. Riscos conhecidos

- O saldo absoluto some de staging e production para quem não tem abertura. É a regra decidida (D-FIN-9), mas muda o que o cliente vê hoje. A tela precisa explicar e convidar à abertura.
- Exportação: tabelas novas entram no pacote; conferir contagens e colunas.
- Production só tem até a 105 (sem 090–098, 100–104, 106+). A promoção da P2 para production depende de 120 e 121 aplicadas lá, e de a production ter o que elas referenciam. Conferir antes de propor.
- Cancelamento depois da regularização da 015 continua como limitação documentada da P1.
