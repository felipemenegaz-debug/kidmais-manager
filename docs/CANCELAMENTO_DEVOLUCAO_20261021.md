# Cancelamento e devolução da assinatura (L1) — 21/10/2026

**Estado: LOCAL.** Branch `codex/devolucao-cancelamento-20261021`, base `staging` `2139966`. Sem push, PR, deploy, env,
banco remoto ou chamada ao Asaas (real ou sandbox). Migration **089** preparada e validada só em PostgreSQL descartável;
**não aplicada** em staging nem em produção. A flag `ASSINATURA_ESTORNO_ATIVO` não existe em nenhum ambiente (desligada).

**Rodada 2 (21/10/2026, revisão independente `revisao-devolucao-20261021/PARECER.md`):** P2-1 a P2-4 e os P3 tratados
nesta branch (§9). A vaga Fundador continua ocupada após o encerramento antecipado: **decisão pendente de Felipe**.

Fontes: parecer da Astra (`pacote-revisao-juridica-astra-20261020/10-PARECER-ASTRA-20261021.md`, L1 e ajuste 5),
decisões de Felipe (`11-DECISOES-FELIPE-20261021.md`) e item 7 de `v2/PLANO-PROCEDIMENTOS.md`.

## 1. Política implementada

| Situação | O que a Gestão pode fazer na tela Assinatura | Devolução | Acesso |
|---|---|---|---|
| Primeira ativação paga, até o fim do 7º dia (inclusive CNPJ), mensal ou anual | **Arrependimento em 7 dias** | **Integral** do valor pago, iniciada de imediato, sem desconto de taxas | Pago termina na hora; 60 dias de somente leitura |
| Mensal depois da garantia | **Cancelar ao fim do período** (já existia) | Nenhuma | Completo até o fim do ciclo pago |
| Anual depois da garantia | **Cancelar ao fim do período** ou **Encerrar antes com devolução proporcional** | Proporcional aos dias não utilizados, **sobre o valor efetivamente pago** (Fundador: o valor com desconto; nada é cobrado de volta), processamento iniciado em até **5 dias úteis** | No encerramento: pago termina na hora; 60 dias de somente leitura |

Todo pedido (inclusive o cancelamento ao fim do período) recebe **protocolo** na hora (`KM-AAAAMMDD-XXXXXXXX`), mostrado
na tela e enviado por e-mail à pessoa da Gestão que pediu (transporte do app, `lib/acessos/email.ts`). O arrependimento é
exercido pela mesma ferramenta da contratação (Decreto 7.962/2013). Só a Gestão, com senha confirmada há ≤ 5 minutos.
"O estorno antecipado encerra o período correspondente": o pedido e o encerramento (`ENCERRADA`, `encerrada_em = agora`)
são gravados na MESMA transação.

### Convenções do cálculo (`lib/assinatura/devolucao-calculo.ts`, função pura)

- Datas de calendário no fuso de Brasília (UTC−3 fixo, o mesmo de `provedor-estado.ts`).
- Ciclo anual = do vencimento da cobrança paga até o mesmo dia do ano seguinte (o fim de período que o produto já usa);
  29/02 → 28/02. Dias do ciclo: 365 ou 366.
- **Dias utilizados** = dias de calendário do início do ciclo até o dia do pedido, **sem contar o dia do pedido** (o acesso
  pago termina no momento do pedido; o dia em curso não é cobrado). Pedido antes do vencimento = 0.
- **Valor** = valor pago × dias não utilizados ÷ dias do ciclo, em centavos inteiros, **arredondado ao centavo mais
  próximo, meio centavo para cima** (a favor do cliente). Aritmética inteira (`floor((2·a + b) / (2·b))`).
- **Garantia**: o dia da ativação não conta (CC, art. 132); termina ao fim do 7º dia (ativação em 10/11 → até 17/11
  23:59:59 de Brasília). Data da ativação = a mais tardia entre a confirmação no provedor (`confirmedDate`/`paymentDate`)
  e a confirmação local da oferta (074a): o acesso pago começa na liberação, nunca antes.
- **Primeira ativação paga**: a cobrança é a única paga da assinatura, nenhuma oferta foi confirmada por outro pagamento e
  a empresa não tem pedido de devolução anterior. A garantia vale uma vez por empresa (índice único na 089).
- **Dias úteis**: segunda a sexta, sem feriados (o prazo fica mais curto, nunca mais longo).
- Regra gravada em cada pedido: `L1-20261021`.

### Exemplos numéricos (todos cobertos por `devolucao-calculo.test.ts`)

| Caso | Pago | Dias (utilizados / ciclo) | Devolução |
|---|---|---|---|
| Profissional anual, pedido no 100º dia | R$ 3.970,00 | 100 / 365 | 397000 × 265 ÷ 365 = 288232,88 → **R$ 2.882,33** |
| O mesmo com Fundador (40%) | R$ 2.382,00 | 100 / 365 | 238200 × 265 ÷ 365 = 172939,73 → **R$ 1.729,40** |
| Essencial anual, pedido no 8º dia (fora da garantia) | R$ 1.970,00 | 8 / 365 | 197000 × 357 ÷ 365 = **R$ 1.926,82** |
| Premium anual, último dia do ciclo | R$ 6.970,00 | 364 / 365 | 697000 × 1 ÷ 365 = 1909,59 → **R$ 19,10** |
| Profissional anual, 2º dia (garantia) | R$ 3.970,00 | — | **R$ 3.970,00** (integral) |
| Mensal, 10º dia | R$ 397,00 | — | sem devolução; acesso até o fim do ciclo |

A soma "usado + devolvido" nunca passa do pago (teste percorre todos os dias do ciclo para seis valores).

## 2. Mapa antes → depois

| Ponto | Antes (`2139966`) | Depois (local) |
|---|---|---|
| Tela Assinatura | Só "Cancelar ao fim do período…" (sem protocolo) | Cancelamento com protocolo; seção **Cancelamento e devolução** com a política, "Ver opções" (valores calculados pelo servidor), confirmação com senha, protocolo imediato e histórico de pedidos (`components/admin/AssinaturaEncerramento.tsx`) |
| Rotas | `POST /api/admin/assinatura/cancelamento` | Mesma rota, agora com `chave` (idempotência) e `protocolo` na resposta; nova `GET/POST /api/admin/assinatura/devolucao` (GET sem `?opcoes=1` não consulta o provedor) |
| `cancelarAssinatura` (`lib/assinatura/cobranca.ts`) | DELETE no Asaas + sincronização + auditoria | Idem + pedido `CANCELAMENTO_FIM_PERIODO` (também no resultado sem confirmação, com o protocolo na mensagem 503) + e-mail; repetição da mesma chave devolve o mesmo protocolo. Sem a 089: comportamento anterior |
| Devolução | Não existia; `PAYMENT_REFUNDED` só disparava reconsulta; "estorno é decisão manual da plataforma" | `lib/assinatura/devolucao.ts`: arrependimento e anual proporcional, fases A–E (abaixo) |
| Estados (067/068/074a) | `ENCERRADA` só vinha do provedor | `ENCERRADA` também pelo encerramento antecipado (transições ATIVA/CANCELADA_FIM_PERIODO → ENCERRADA já aceitas pela guarda; **nenhuma mudança na 067/068/074a**) |
| Registro | Só `auditoria` | Tabela `assinatura_encerramentos` (089) + auditoria `ASSINATURA_ENCERRADA_COM_DEVOLUCAO` (com protocolo) |
| Asaas (`lib/assinatura/asaas.ts`) | customers, subscriptions, payments GET/PUT | + `estornarCobranca` (`POST /payments/{id}/refund`, valor explícito) e `confirmedDate` |
| Sincronização (`sincronizacao.ts`) | Toda cobrança paga sustenta período | Cobrança com pedido de devolução **não** sustenta período (ver §4) |
| Fim do período | Vencimento da última paga + ciclo; "nunca encolhe" | Igual pela sincronização; o encerramento antecipado grava `periodo_atual_fim = encerrada_em = agora` e a sincronização mantém `ENCERRADA` |
| Fundador | Desconto por 12 meses; "não cobrado de volta" só no texto | Devolução sempre sobre o valor pago (com desconto); a vaga continua consumida (ver riscos) |

## 3. Fluxo do encerramento com devolução (`solicitarEncerramento`)

- **A.** Transação curta do tenant: Gestão, 089 instalada, repetição da mesma `chave` → devolve o pedido já registrado sem
  efeito novo.
- **B.** Provedor, só leitura: cobranças da assinatura (`GET /subscriptions/{id}/payments`).
- **C.** Transação curta do tenant, com a empresa e a assinatura travadas:
  - recalcula com o relógio do banco;
  - confere o valor que a tela mostrou (`valorEsperadoCentavos`; diferente → 409 `OFERTA_ALTERADA` com o valor novo,
    nada gravado);
  - grava o pedido (protocolo, valores, cálculo);
  - encerra o período (`ENCERRADA`);
  - audita.
- **D1.** Remove a renovação no Asaas (`DELETE /subscriptions/{id}`, uma tentativa): `CONFIRMADO`/`AUSENTE` → também
  `provedor_situacao = DELETED`; `RECUSADO`/`SEM_CONFIRMACAO` → fica no pedido para conferência manual. Nunca repete às cegas.
  Assinatura já removida (cancelada antes) → `JA_REMOVIDA`.
- **D2.** Só com `ASSINATURA_ESTORNO_ATIVO=true` **e** Pix ou cartão:
  - registro prévio `EM_CURSO` (sem ele, não chama);
  - `POST /payments/{id}/refund` com `value` explícito e a descrição `Kidmais Manager - devolucao <protocolo>`;
  - 200 → `SOLICITADO`; 4xx definitivo → `RECUSADO`; resposta perdida/5xx → `SEM_CONFIRMACAO`, nunca repetida;
  - boleto → sempre manual (o Asaas exige dados bancários do pagador).
- **E.** E-mail de confirmação (melhor esforço; falha não desfaz nada; situação gravada no pedido).

Sem a flag (padrão), o estorno fica `AGUARDANDO_MANUAL` (§5).

### Migration 089 — `assinatura_encerramentos`

- Aditiva: tabela nova, sem `ALTER` em nada existente.
- Precheck, postcheck e rollback: o rollback é recusado se houver pedidos e nunca reabre período.
- Imutáveis: protocolo, tipo, valores, cálculo, cobrança e datas.
- `cancelamento_provedor`: `PENDENTE` → `CONFIRMADO`/`AUSENTE`/`SEM_CONFIRMACAO`/`RECUSADO`. Os dois últimos ainda podem
  ir para `CONFIRMADO`/`AUSENTE`.
- `estorno_situacao`: `AGUARDANDO_MANUAL` → `EM_CURSO` (só com `estorno_modo = AUTOMATICO`) ou `CONCLUIDO`.
  - `EM_CURSO` → `SOLICITADO`, `SEM_CONFIRMACAO` ou `RECUSADO`.
  - `SOLICITADO`, `SEM_CONFIRMACAO` e `RECUSADO` → `CONCLUIDO`; `SEM_CONFIRMACAO` também → `SOLICITADO`.
  - `CONCLUIDO` é final e exige `estorno_referencia` (3–200 caracteres).
  - Nada volta a `EM_CURSO`, o que impede uma segunda chamada automática.
- Únicos: protocolo; (empresa, chave); uma devolução por cobrança; uma garantia de 7 dias por empresa.
- `DELETE`/`TRUNCATE` recusados.

**Ordem de publicação (como a 088):** o código funciona sem a 089 (cancelamento como antes, sem protocolo; seção de
devolução oculta). **Código primeiro** — já com os aplicadores `scripts/migration-089-{comum,staging,production}.cjs`,
os blocos `scripts/bloco-shell-089.cjs` e os três SQL na árvore implantada —, depois a 089 pelo Web Shell:
`--conferir-089` → autorização de Felipe → `--aplicar-089-autorizado --backup "<registro>"` → `--conferir-089`. O
aplicador confere o sha256 dos SQL (CRLF normalizado), 067/068/074a, estado ausente/completa/parcial, CREATE e
REFERENCES (`empresa_assinaturas`, `usuarios_administrativos`) como `current_user`, grava o marcador no disco
persistente e nunca roda o down. A migration também diz "código primeiro" (as duas ordens são compatíveis). Numeração: 087 e 088 tomadas. Na
leitura de 21/10/2026, nenhum clone local tinha 089; outro agente pode usá-la para exportação. Se colidir, renumerar
para 090 antes de qualquer aplicação.

## 4. Sincronização, webhook, reconciliação e D-C4 (sem alarme falso)

O estorno **parcial** mantém a cobrança `RECEIVED` no Asaas. Sem cuidado, a releitura:
- reabriria o período encerrado, se a assinatura continuasse ativa (ENCERRADA → ATIVA é transição permitida);
- ou chamaria `confirmarOfertaPaga` e divergiria;
- e cada caso viraria `MUDOU_ENCERRADA_PARA_ATIVA` ou erro na reconciliação diária, alarmando pela D-C4.

Por isso `sincronizarEmpresa` remove da lista as cobranças com pedido de devolução (`cobrancasDevolvidas`) antes de
`estadoDoProvedor`. A empresa encerrada continua ENCERRADA; só um pagamento **novo** a reativa.

A suíte PG prova, com `executarCiclo` da reconciliação (simulação) e `idadesDosEventos` da conferência de produção:
- 5 empresas `SEM_MUDANCA`, `divergente=false`, `incompleto=false`, `alarme.itens=[]` e `codigoDeSaida(…, true) = 0`;
- inclui uma empresa cuja assinatura **continuou ativa** no provedor (remoção sem confirmação).

**P2-1 (rodada 2):** na assinatura que teve devolução, também nenhuma cobrança com vencimento **menor ou igual** ao da
devolvida sustenta período (`cobrancaDevolvidaOuAnterior`, pelo `inicio_ciclo` do pedido). Caso coberto: anual no 2º
ano, proporcional sobre a renovação, remoção sem confirmação (assinatura ACTIVE) e webhook
`PAYMENT_PARTIALLY_REFUNDED` → continua ENCERRADA. Só um pagamento com vencimento posterior, ou de outra assinatura
(recontratação), reativa.

**P3-8 (rodada 2):** quando a releitura comprova a remoção (`deleted=true` lida por id), a sincronização marca como
`AUSENTE` os pedidos da empresa para aquela assinatura que ainda esperavam a remoção (`PENDENTE`/`SEM_CONFIRMACAO`/
`RECUSADO`). O pedido sem confirmação não fica mais parado: o webhook `SUBSCRIPTION_DELETED` ou a reconciliação o fecham.

**P2-3 (rodada 2) — fila na conferência de produção (D-C4):** `lerPendenciasEncerramento` (somente leitura, sem ids)
transforma cada pedido vencido num item da regra por idade:
- `DEVOLUCAO_PENDENTE`: estorno `AGUARDANDO_MANUAL`/`EM_CURSO`/`SEM_CONFIRMACAO`/`RECUSADO` depois do prazo
  (arrependimento: 1 h após o pedido; proporcional: fim do dia de `prazo_processamento`, Brasília);
- `RENOVACAO_NAO_REMOVIDA`: remoção `PENDENTE`/`SEM_CONFIRMACAO`/`RECUSADO` há mais de 1 h.

A idade conta do vencimento do prazo (dia 0 = `NOVO`, depois 1, 3, 7 e semanais; os demais dias em
`pendentesConhecidos`), e a contagem entra na conferência de `codigoDeSaida`. Em staging o relatório só conta
(`encerramentos`). Pedido recente (dentro do prazo) não alarma.

Os webhooks `PAYMENT_PARTIALLY_REFUNDED`/`PAYMENT_REFUNDED` são processados sem mudança. `PAYMENT_REFUND_IN_PROGRESS`
não está entre os eventos suportados e é concluído como `IGNORADO`, o que não gera alarme.

Controle negativo: sem o filtro, a mesma suíte falha (empresa reaberta).

O que fica para a pessoa, e não para o cron: assinatura com remoção `SEM_CONFIRMACAO`/`RECUSADO` continua gerando
cobrança no Asaas até ser removida no painel (§5). A reconciliação não alarma por isso. O alarme verdadeiro, se houver,
vem do pagamento novo.

## 5. Operação manual (Felipe) enquanto a flag estiver desligada

Fila (somente leitura, no banco do ambiente, com autorização de leitura):

```sql
SELECT protocolo, tipo, to_char(solicitado_em AT TIME ZONE 'America/Sao_Paulo', 'DD/MM/YYYY HH24:MI') AS pedido,
       prazo_processamento, valor_devolucao_centavos / 100.0 AS valor, forma_pagamento, cobranca_provedor_id,
       provedor_assinatura_id, cancelamento_provedor, estorno_situacao
  FROM assinatura_encerramentos
 WHERE estorno_situacao NOT IN ('NAO_SE_APLICA', 'CONCLUIDO') OR cancelamento_provedor IN ('PENDENTE', 'SEM_CONFIRMACAO', 'RECUSADO')
 ORDER BY prazo_processamento, solicitado_em;
```

Para cada linha:
1. **Prazo.**
   - Arrependimento: no mesmo dia; sem taxas para o cliente; comunicar o intermediador de imediato.
   - Anual proporcional: iniciar até `prazo_processamento` (5 dias úteis).
2. **Renovação.** `cancelamento_provedor` em `PENDENTE`/`SEM_CONFIRMACAO`/`RECUSADO`: no painel do Asaas, conferir a
   assinatura `provedor_assinatura_id` e removê-la se ainda ativa.
3. **Estorno.** No painel do Asaas, cobrança `cobranca_provedor_id` → Estornar → **valor exato** `valor` (parcial no
   anual), descrição `Kidmais Manager - devolucao <protocolo>`.
   - Pix: volta à conta de origem; parciais permitidas até o valor da cobrança.
   - Cartão: confirmado/recebido; até 10 dias úteis na fatura.
   - Boleto: o Asaas gera um link para o pagador informar os dados bancários; enviar ao cliente pelo e-mail do protocolo.
   - Saldo insuficiente na conta → o Asaas recusa (400): providenciar saldo antes.
   - Taxas da cobrança não voltam à conta, e o cliente recebe o valor cheio.
4. **Registro da conclusão**, com autorização de escrita no banco do ambiente. A guarda exige a referência e torna o
   registro final:

   ```sql
   UPDATE assinatura_encerramentos SET estorno_situacao = 'CONCLUIDO', estorno_referencia = 'Painel Asaas DD/MM: estorno <tipo> <id/comprovante>'
    WHERE protocolo = 'KM-…' AND estorno_situacao IN ('AGUARDANDO_MANUAL', 'EM_CURSO', 'SOLICITADO', 'SEM_CONFIRMACAO', 'RECUSADO');
   -- EM_CURSO = processo interrompido durante a chamada automática: conferir no painel ANTES (o estorno pode ter saído).
   -- remoção conferida no painel:
   UPDATE assinatura_encerramentos SET cancelamento_provedor = 'CONFIRMADO' WHERE protocolo = 'KM-…' AND cancelamento_provedor IN ('PENDENTE', 'SEM_CONFIRMACAO', 'RECUSADO');
   ```

5. **Cliente.** Responder pelo canal oficial, citando o protocolo, quando o crédito for confirmado.

Outros pedidos fora da tela (por e-mail) seguem o mesmo cálculo. Hoje eles não geram protocolo automático: usar a tela
pela Gestão, ou registrar no atendimento.

**Aviso interno (P2-3, rodada 2):** cada pedido (devolução ou cancelamento) envia na hora um e-mail ao canal da plataforma
(`SITE_ATENDIMENTO_EMAIL`, o mesmo endereço validado da tela de suporte), pelo transporte do app, só com protocolo, tipo,
valor, meio de pagamento, prazo e situação no provedor — sem nome da empresa, pessoa, e-mail, documento ou ids. Assunto
com `[AÇÃO HOJE]` no arrependimento e quando a renovação não foi removida. Situação gravada em
`aviso_interno_situacao` (`NAO_CONFIGURADO` sem o canal). A repetição do mesmo pedido não reenvia.

**Repetição do cancelamento (P2-2, rodada 2):** a mesma chave nunca "confirma" um cancelamento que não aconteceu.
Remoção já confirmada → devolve o protocolo e a situação gravada; ainda sem confirmação → nova tentativa efetiva
(outro `DELETE`, idempotente no Asaas) sobre o MESMO pedido, com 503 de novo se continuar incerta. A tela gera chave nova
depois de qualquer falha.

## 6. Ensaio futuro no sandbox (não executado; exige autorização)

Pré-condições:
- staging com a 089 aplicada e o código publicado;
- `ASAAS_AMBIENTE=sandbox`;
- primeiro `ASSINATURA_ESTORNO_ATIVO` ausente, depois `true`;
- e-mail de staging configurado.

Roteiro:
1. Empresa sintética anual paga por **Pix** no sandbox. Pedir o arrependimento no 1º dia. Conferir:
   - protocolo e encerramento;
   - `DELETE` da assinatura;
   - pedido `AGUARDANDO_MANUAL`;
   - estorno manual no painel e registro `CONCLUIDO`.
2. Com a flag ligada, outra empresa anual paga por Pix (ou cartão de teste). Mudar o vencimento no sandbox para simular
   dias usados, pedir o proporcional e conferir:
   - `SOLICITADO`;
   - `refunds[]` com o valor exato;
   - status da cobrança (o parcial deve continuar `RECEIVED`);
   - eventos `PAYMENT_PARTIALLY_REFUNDED`/`PAYMENT_REFUND_IN_PROGRESS` processados sem mudar a empresa.
3. Rodar a reconciliação em simulação e conferir `SEM_MUDANCA` e nenhum alarme.
4. Boleto: confirmar que nada é chamado e que o link `bankSlip/refund` é obtido manualmente.
5. Registrar:
   - prazos reais;
   - taxas;
   - comportamento de saldo insuficiente;
   - se o status da cobrança muda em estorno parcial de cartão.

   Ajustar este documento e os Termos.
6. **A conferir (P3-4/P3-5 da revisão):**
   - cobrança com juros, multa ou desconto padrão da conta: `value` × `originalValue` — o produto usa `value` como
     "valor efetivamente pago";
   - estornos parciais anteriores feitos no painel (`refunds[]` não é lido): o integral pode passar do estornável; o
     Asaas recusa e o pedido fica `RECUSADO` para tratamento manual;
   - janelas dos meios: Pix (cerca de 90 dias para devolução pela API) e cartão (prazo da adquirente); fora delas, a
     devolução vira transferência com dados bancários — incluir no procedimento manual.

## 7. Riscos e limitações conhecidos

- **Asaas sem ensaio.** O endpoint foi implementado pela documentação oficial lida em 21/10/2026 (`estornar-cobranca`,
  `estornar-boleto`, `estornos`, `webhook-para-cobrancas`), nunca chamado. A documentação não diz que status a cobrança
  assume após estorno parcial: o produto não depende disso, porque filtra pelo pedido. Manter a flag desligada até o
  ensaio.
- **Arrependimento com a flag desligada** depende de Felipe para a restituição "imediata". O texto da tela e do e-mail
  diz "iniciada de imediato"; a fila precisa ser olhada no mesmo dia.
- **Processo interrompido entre a fase C e a D1.** O pedido existe e a empresa está encerrada, mas a renovação continua
  ativa no Asaas (`cancelamento_provedor = PENDENTE`). Aparece na fila manual. A repetição da mesma chave não refaz a D1.
- **Renovação paga antecipadamente (P3-6).** Se a última cobrança paga tem vencimento futuro, ela vira a base: a
  devolução é o valor integral dela e os poucos dias restantes do ciclo atual não entram (levemente a menor).
- **Fase B fora da trava (P3-7).** Uma cobrança paga entre a leitura no provedor e a fase C (milissegundos) não entra
  no cálculo; o valor é conferido de novo na fase C só com as cobranças lidas na B.
- **Renovação com remoção RECUSADA pelo Asaas (4xx):** a assinatura continua ativa; o pedido fica `RECUSADO` e entra na
  conferência como `RENOVACAO_NAO_REMOVIDA` depois de 1 h (testado). Remover no painel e registrar `CONFIRMADO`.
- **Ctrl-C durante o bloco de Shell:** como na 088, a linha `CODIGO_SAIDA_BLOCO` pode não sair (PTY real); a regra do
  bloco é "ausência da linha = parar e ler".
- **Proporcional iniciado e ainda aberto (R2-P3-c).** Ex.: boleto, com o link de dados bancários já enviado ao cliente
  dentro do prazo, mas sem crédito. A guarda não tem estado manual de "iniciado" (`AGUARDANDO_MANUAL → SOLICITADO` não é
  aceito), então depois de `prazo_processamento` o pedido aparece como `DEVOLUCAO_PENDENTE` na conferência, mesmo já
  iniciado. O alarme segue a regra por idade (1, 3, 7 e semanal; nos outros dias em `pendentesConhecidos`), sem ruído
  diário. Até decidir um estado "iniciado" com referência, anotar o início no atendimento e concluir (`CONCLUIDO` com
  referência) quando o crédito sair.
- **`SOLICITADO` sem acompanhamento (R2-P3-d).** Com `ASSINATURA_ESTORNO_ATIVO=true`, o estorno aceito pelo Asaas fica
  `SOLICITADO`: não entra na conferência D-C4 nem é concluído automaticamente quando o Asaas marca o estorno como `DONE`.
  Com a flag desligada (padrão) o caso não ocorre. No ensaio com a flag ligada (§6), conferir os `refunds[]` e concluir à
  mão; acompanhamento automático (releitura da cobrança ou webhook) fica para antes de ligar a flag em produção.
- **Primeira ativação em clientes legados (plano `UNICO`).** Uma assinatura anterior trocada antes desta versão não é
  detectada se não houver contratação 074a nem pedido 089. Raro: só a empresa da Kidmais em produção hoje.
- **Vaga Fundador.** Continua consumida (CONFIRMADA) depois do encerramento antecipado. A 074a só libera vaga sem
  contratação confirmada. Mantido assim na rodada 2: **decisão pendente de Felipe** (a vaga volta ou não à campanha).
- **Feriados** não entram nos dias úteis: o prazo informado fica mais curto que o legal, o lado seguro.
- **E-mail.** A confirmação vai só para quem pediu, não para toda a Gestão (a plataforma recebe o aviso interno). Se o e-mail não estiver configurado no ambiente, a tela
  avisa para guardar o protocolo.
- **Sem tela de operação.** A conclusão é registrada por SQL autorizado; o aviso interno e a D-C4 avisam da fila. Um
  painel da plataforma para a fila fica para depois.
- **Textos legais.** Os marcadores `[CONTROLE AINDA NÃO IMPLEMENTADO: protocolo…/encerramento antecipado…]` dos Termos só
  saem quando esta versão e a 089 estiverem publicadas, e o estorno pelo Asaas, ensaiado.

## 8. Validação local (21/10/2026)

- Unitários:
  - `devolucao-calculo.test.ts`: 9;
  - `devolucao.test.ts`: 4;
  - `asaas.test.ts`: +2;
  - assinatura inteira: PASS.
- PostgreSQL descartável (cluster próprio 55641, modelo 086 + 089 pela suíte):
  - `lib/assinatura/devolucao-089.postgres.test.ts`: 6/6;
  - controle negativo do filtro: falha como esperado;
  - regressão de `assinatura`, `cobranca-068`, `cobranca-e8` (atual/075), `contratacao-e8` (atual/075),
    `transacao-com-prazo` (atual/075) e `kidmais-gratuidade` (079/079-sem-atendimento): 11/11 PASS.
- Playwright (`scripts/assinatura-devolucao-ui.cjs`): `next dev` local com Asaas dublê dentro do processo
  (`scripts/teste-asaas-duble.cjs`) e e-mail em arquivo.
- `npx tsc --noEmit`, ESLint e `npm run check:v1:static`.

Os resultados finais estão no registro do vault (nota "Cancelamento e devolucao local 20261021").

## 9. Rodada 2 — correções da revisão independente (21/10/2026)

| Achado | Correção | Prova |
|---|---|---|
| P2-1 renovação devolvida reabria a empresa | `cobrancaDevolvidaOuAnterior`: na assinatura com devolução, cobrança devolvida ou com vencimento ≤ ao dela não sustenta período | PG "P2-1" (2º ano + remoção incerta + webhook `PAYMENT_PARTIALLY_REFUNDED` → ENCERRADA; pagamento novo reativa); revisor R2; mutações M17/M19 |
| P2-2 repetição confirmava cancelamento inexistente | mesma chave: confirmado → situação real; incerto → novo `DELETE` sobre o mesmo pedido (503 de novo se incerto); tela troca a chave após falha | PG "P2-2"; revisor R3; E2E (503 → nova tentativa); M20 |
| P2-3 ninguém era avisado | aviso interno imediato (`SITE_ATENDIMENTO_EMAIL`, `aviso_interno_situacao`) + itens `DEVOLUCAO_PENDENTE`/`RENOVACAO_NAO_REMOVIDA` na conferência D-C4 | PG "P2-3", unitários de `assinatura-reconciliar.test.cjs`; E2E (e-mail interno sem dados do pagador); M21/M22 |
| P2-4 sem aplicador/blocos | `scripts/migration-089-{comum,staging,production}.cjs`, `scripts/bloco-shell-089.cjs`, testes e CI; ordem "código primeiro" alinhada na migration | `migration-089.test.cjs` 11/11, `bloco-shell-089.test.cjs` 10/10, `aplicador-089.postgres.test.ts` (SQL real), PTY real 9/10 (Ctrl-C sem linha de código, igual à 088) |
| P3 | guarda aceita `EM_CURSO → CONCLUIDO` (SQL do §5 inclui); M11/M12/M13 cobertas; aviso de garantia no formulário de cancelar; itens a conferir no sandbox (§6); renovação antecipada e fase B (§7); pedido sem confirmação fechado pela sincronização (`AUSENTE`) | PG "P2-2"/"P3-3"; E2E; M11–M13, M23, M24 |

Vaga Fundador após encerramento antecipado: mantida ocupada; **decisão pendente de Felipe**.

Validação da rodada 2: unitários de assinatura 181 + devolução; PG descartável (cluster 55641, removido) 14/14 —
suíte do autor, aplicadores 089, suíte do revisor R0–R9 (modelo 088, só local) e regressão de assinatura e da 088;
11 mutações mortas (M11–M13, M17–M24); Playwright PASS (inclui 503 → nova tentativa, aviso interno e aviso de garantia);
`tsc`, ESLint e `check:v1:static` PASS (3252 unitários, 103 do harness; 1 aviso de lint preexistente).
