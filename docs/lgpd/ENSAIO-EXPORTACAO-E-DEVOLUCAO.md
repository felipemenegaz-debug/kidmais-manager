# Ensaio: exportação completa manual e devolução proporcional do anual

**Estado (03/11/2026): roteiro LOCAL, não executado.** Nada aqui foi rodado em staging, em produção ou no Asaas. Quem executa: Felipe Menegaz (Demerzel Labs). Etapas marcadas **"a definir com autorização"** exigem autorização explícita de Felipe para o ambiente e a ação, conforme `docs/OPERACAO_AGENTES.md`.

Objetivo: provar, antes de prometer a um cliente real, que a Demerzel Labs cumpre duas promessas dos textos:
- **(a)** "A exportação completa dos demais dados (festas, aniversariantes, financeiro e conversas) pode ser pedida pelo canal oficial e é entregue em até 15 dias" (Termos, "Seus dados e a exportação");
- **(b)** encerramento antecipado do anual "com devolução proporcional aos dias não utilizados, calculada sobre o valor efetivamente pago", processada "em até 5 dias úteis pelo meio de pagamento original": cartão e Pix voltam ao cartão ou à conta que pagou; no boleto, ou se o estorno pelo meio original não for possível, pedem-se os dados bancários da empresa (Termos, "Cancelamento e devolução").

Índice: [INDICE.md](INDICE.md).

## Regras do ensaio

- Só **empresas de teste com dados sintéticos**. Nenhum dado de cliente real.
- E-mails só para caixas de teste da própria equipe. Nenhuma mensagem real a terceiros.
- Asaas só em **sandbox**, com chaves de sandbox.
- Toda cópia gerada entra em `Registro de copias e eliminacoes LGPD` (classe F) e sai em até 90 dias ([BACKUPS-E-COPIAS.md](BACKUPS-E-COPIAS.md)).
- Evidência sem dados pessoais. Resultado em uma nota do vault `Ensaio exportacao e devolucao LGPD` (a criar), com link nos índices do vault.

## (a) Exportação completa manual, isolada por empresa

### Preparação

| Passo | O que fazer | Onde |
|---|---|---|
| A1 | Escolher o ambiente do ensaio: staging ou PostgreSQL descartável local com dados sintéticos | **a definir com autorização** (staging) |
| A2 | Criar duas empresas de teste: **Empresa A** (a exportar) e **Empresa B** (controle). Cada uma com Gestão própria | painel do desenvolvedor do ambiente escolhido |
| A3 | Em cada empresa, cadastrar ao menos um item de cada categoria: cliente, responsável, festa, aniversariante, convidado, contrato com PDF, conta a receber e pagamento, convite, conversa de WhatsApp sintética, observação de saúde sintética | telas do sistema |
| A4 | Marcar os textos livres com um marcador único por empresa: `MARCADOR-A-<data>` e `MARCADOR-B-<data>` | campos de observação e nomes sintéticos |
| A5 | Anotar, por categoria, a quantidade esperada de registros da Empresa A | nota do ensaio |

### Execução (relógio de 15 dias)

| Passo | O que fazer | Critério |
|---|---|---|
| A6 | A Gestão da Empresa A envia o pedido de exportação completa ao canal oficial, de uma caixa de teste. Anotar data e hora: **D0** | pedido recebido no canal oficial |
| A7 | Responder com confirmação de recebimento, protocolo e prazo (D0 + 15 dias) | resposta no mesmo dia |
| A8 | Conferir que quem pediu é Gestão ativa da Empresa A (ficha da empresa → membros) | pedido de pessoa sem papel de Gestão é recusado |
| A9 | Pela tela Assinatura da Empresa A, baixar "Clientes (CSV)" e "Contas a receber (CSV)" | arquivos gerados pela tela |
| A10 | Baixar o PDF de cada contrato da Empresa A | um PDF por contrato |
| A11 | Extrair as demais categorias (festas, aniversariantes, convidados, financeiro, conversas, convites), sempre filtradas pela Empresa A | **a definir com autorização**: leitura somente leitura filtrada por empresa ou uso do pacote ZIP verificável (branch local de 21/10, não publicada). Em produção, sempre com autorização própria e anotação em `Registro de acessos de suporte LGPD` |
| A12 | Guardar tudo numa pasta de trabalho datada, fora do Git e do vault | pasta registrada como classe F em `Registro de copias e eliminacoes LGPD` |
| A13 | Montar um manifesto: arquivo, categoria, número de linhas e SHA-256 de cada arquivo (PowerShell: `Get-FileHash <arquivo> -Algorithm SHA256`) | manifesto com todos os arquivos |
| A14 | **Prova de isolamento:** buscar `MARCADOR-B` em todos os arquivos (PowerShell: `Select-String -Path <pasta>\* -Pattern 'MARCADOR-B' -SimpleMatch`) | **zero** ocorrências |
| A15 | Conferir as quantidades por categoria contra A5 | todas iguais |
| A16 | Entregar à Gestão da Empresa A, só ao e-mail cadastrado, por link com prazo de expiração ou arquivo compactado com senha enviada por outro meio. Nunca por WhatsApp | entrega até **D0 + 15 dias** |
| A17 | Após a confirmação de recebimento pela empresa, apagar a pasta de trabalho e registrar a eliminação | cópia ELIMINADA no registro; nunca além de 90 dias |

### Variações obrigatórias

- **Empresa em somente leitura** e **empresa suspensa**: repetir A6–A16 com a Empresa A nesses estados. A exportação não pode ser negada (Termos, "Seus dados e a exportação" e "Uso adequado e suspensão").
- **Falta de novo aceite**: a exportação não pode depender do reaceite (Termos, "Alterações destes Termos").

### Critérios de aprovação de (a)

- [ ] Entrega em até 15 dias de D0 (meta do ensaio: até 5 dias úteis, para folga).
- [ ] Zero dados da Empresa B (A14).
- [ ] Quantidades conferem (A15).
- [ ] Manifesto com SHA-256 de todos os arquivos (A13).
- [ ] Entrega só ao e-mail cadastrado da Gestão (A16).
- [ ] Cópia registrada e eliminada (A12, A17).
- [ ] Funciona em somente leitura e em suspensão.
- [ ] Tempo de trabalho de Felipe anotado (para saber se 15 dias é folgado).

### Evidência de (a)

Na nota `Ensaio exportacao e devolucao LGPD`: ambiente, D0, data da entrega, dias corridos, manifesto sem conteúdo (arquivo, linhas, SHA-256), resultado de A14 e A15, estados testados, tempo gasto. A cópia fica em `Registro de copias e eliminacoes LGPD`.

## (b) Devolução proporcional do anual no sandbox do Asaas

### O que os textos prometem

| Situação | Devolução | Prazo e meio |
|---|---|---|
| **Arrependimento**: primeiros 7 dias da primeira ativação paga, inclusive CNPJ, mensal ou anual | **Integral** do valor pago | Restituição e comunicação ao intermediador **imediatas** |
| **Anual**, depois dos 7 dias, encerramento antecipado pedido pelo canal oficial | **Proporcional aos dias não utilizados, sobre o valor efetivamente pago**. Não se recalcula pelo preço mensal. O desconto Fundador não é cobrado de volta | Processamento iniciado em **até 5 dias úteis**, pelo **meio de pagamento original** via Asaas. **Cartão e Pix: estorno à origem. Boleto, ou estorno recusado: pedir os dados bancários da empresa** |
| **Mensal**, depois dos 7 dias | Sem devolução; acesso até o fim do ciclo pago | — |

Depois do encerramento: 60 dias de somente leitura, com exportação ([CALENDARIO-DE-ELIMINACOES.md](CALENDARIO-DE-ELIMINACOES.md)).

### Cálculo exemplificado

Convenções do código (`lib/assinatura/devolucao-calculo.ts`, regra `L1-20261021`):
- datas no fuso de Brasília;
- ciclo anual = do vencimento da cobrança paga até o mesmo dia do ano seguinte (365 ou 366 dias);
- **dias utilizados** = do início do ciclo até o dia do pedido, **sem contar o dia do pedido**;
- **devolução** = valor pago × dias não utilizados ÷ dias do ciclo, em centavos, arredondado ao centavo mais próximo (meio centavo para cima, a favor do cliente);
- dias úteis = segunda a sexta, sem feriados (o prazo fica mais curto, nunca mais longo).

Exemplo 1 — Profissional anual, pago R$ 3.970,00, ciclo de 365 dias, pedido quando já foram usados 100 dias:
- dias não utilizados = 365 − 100 = **265**;
- 397.000 centavos × 265 ÷ 365 = 288.232,88 centavos;
- arredondado: **R$ 2.882,33**.

Exemplo 2 — o mesmo plano com Fundador (40%), pago R$ 2.382,00:
- 238.200 × 265 ÷ 365 = 172.939,73 centavos → **R$ 1.729,40**;
- o desconto Fundador **não** é cobrado de volta.

Exemplo 3 — arrependimento no 2º dia da primeira ativação paga, pago R$ 3.970,00: devolução **integral, R$ 3.970,00**, imediata.

Conferência: usado + devolvido nunca passa do valor pago.

### Preparação

| Passo | O que fazer | Onde |
|---|---|---|
| B1 | Ambiente com a migration 089 aplicada e o Asaas em **sandbox** | **a definir com autorização** (staging) |
| B2 | Criar três empresas de teste: **C** (anual, cartão de teste), **D** (anual, Pix de teste) e **E** (arrependimento) | painel do desenvolvedor |
| B3 | Contratar o plano anual em cada uma e confirmar o pagamento no sandbox | tela de contratação + painel sandbox do Asaas |
| B4 | Anotar, por empresa: valor pago, data de início do ciclo e meio de pagamento | nota do ensaio |

### Execução

| Passo | O que fazer | Critério |
|---|---|---|
| B5 | Empresa E, dentro dos 7 dias: pedir arrependimento pelo canal oficial (e, onde a tela existir, pela tela Assinatura) | protocolo emitido; devolução integral; acesso pago encerrado na hora; 60 dias de somente leitura |
| B6 | Empresa E: processar o estorno integral no sandbox | estorno iniciado **no mesmo dia** do pedido |
| B7 | Empresas C e D, depois dos 7 dias: pedir encerramento antecipado pelo canal oficial. Anotar data e hora: **P0** | protocolo com data e hora devolvido na resposta |
| B8 | Calcular à mão o valor esperado (fórmula acima) com as datas reais de B4 e P0 | valor anotado antes de olhar o sistema |
| B9 | Onde a tela existir, ver o valor oferecido em "Ver opções" | igual ao de B8, centavo a centavo |
| B10 | Encerrar o acesso pago na data combinada | somente leitura e exportação disponíveis |
| B11 | Empresa C (cartão): estornar no painel sandbox o **valor exato** de B8, como estorno parcial | estorno iniciado em até 5 dias úteis de P0 |
| B12 | Empresa D (Pix): processar o estorno à conta de origem (API com a flag ligada no sandbox, ou painel do Asaas com a flag desligada), sem pedir dados bancários | estorno à origem iniciado em até 5 dias úteis de P0 |
| B13 | Registrar no pedido a conclusão do estorno com a referência do Asaas | pedido marcado como concluído, com referência |
| B14 | Conferir que a sincronização não reabre o período nem alarma por causa da cobrança devolvida | assinatura continua encerrada |
| B15 | Conferir os e-mails de confirmação na caixa de teste | e-mail com protocolo, data e valor |

### Critérios de aprovação de (b)

- [ ] Arrependimento: integral e imediato (B5–B6).
- [ ] Anual: valor da tela = cálculo manual, centavo a centavo (B8–B9).
- [ ] Devolução sobre o valor pago; Fundador não cobrado de volta.
- [ ] Estorno iniciado em até 5 dias úteis de P0, pelo meio original (B11–B12).
- [ ] Pix: estorno à conta de origem, sem dados bancários (B12). Boleto: dados bancários pedidos.
- [ ] Protocolo com data e hora em todos os pedidos.
- [ ] Período não reaberto pela sincronização (B14).
- [ ] Somente leitura e exportação disponíveis depois do encerramento.

### Evidência de (b)

Na nota `Ensaio exportacao e devolucao LGPD`: ambiente, empresas de teste por id, valor pago, início do ciclo, P0, dias utilizados e não utilizados, valor calculado, valor da tela, referência do estorno no sandbox, data do início do processamento, dias úteis decorridos. Sem dados bancários (no sandbox, usar só dados fictícios e não anotá-los).

## Ponto em aberto

Decisão de Felipe em 03/11/2026: o texto segue o código. `lib/assinatura/devolucao.ts` estorna cartão e Pix pelo Asaas à origem quando `ASSINATURA_ESTORNO_ATIVO` está ligada; com a flag desligada (padrão), Felipe faz o mesmo estorno à origem no painel do Asaas. Só o boleto, ou um estorno recusado, leva ao pedido de dados bancários. Os Termos (rodada 5.1) dizem isso.

Em produção, o caminho real (canal oficial, Asaas de produção, leitura de dados da empresa) fica **a definir com autorização**.
