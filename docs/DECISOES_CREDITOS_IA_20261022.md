# Decisões dos créditos de IA — 22/10/2026

**Origem:** Felipe pediu ao agente, em 22/10/2026, para "definir da melhor forma" cinco pontos pendentes do plano
(`docs/PLANO_PACOTES_CREDITOS.md`). As definições abaixo são **decisões de Felipe por delegação**, com base na
recomendação do agente. Os pontos jurídicos e fiscais continuam **dependentes do parecer** do jurídico (Astra) e do
contador: até lá, o catálogo segue com `aprovacao: null` e a venda em produção fica tecnicamente bloqueada
(`lib/creditos/config.ts`). Nada aqui autoriza publicação, sandbox, staging ou produção.

## D1. Preços, franquias e validade

**Pacotes do piloto (só Convites):**

| Pacote | Gerações | Preço | Situação |
|---|---:|---:|---|
| Convites 10 | 10 | R$ 59,00 | entra no piloto |
| Convites 30 | 30 | R$ 159,00 | entra no piloto |
| Convites 100 | 100 | R$ 499,00 | **fora do piloto** até 60 dias de uso real observado |
| Wall-e (todos) | — | — | **nenhum pacote** até a liberação jurídica do atendimento |

Por que assim: pacotes pequenos e médios limitam a exposição na garantia com uso (D2) e no custo ainda não medido; o
grande fica para depois, quando houver dados de uso e de devoluções (como o próprio plano sugere).

**Condição para abrir a venda (gate de preço):** medir o custo real pelo `usage` do provedor em pelo menos 30 gerações
de cada modalidade (arte `medium` e convite completo `xhigh`) e manter **margem de contribuição ≥ 35%** depois de impostos,
tarifa do Asaas por meio e reserva de risco, com câmbio do dia. Se o p95 do convite completo passar de US$ 0,30, reprecificar
os pacotes novos antes de abrir (nunca reduzir créditos já vendidos).

**Validade:** 12 meses a partir da liberação do lote (como implementado); avisos 30 e 7 dias antes (implementado);
indisponibilidade imputável à plataforma prorroga o vencimento pelo mesmo período (o banco só permite prorrogar).
Consumo pelo menor vencimento, franquia/cortesia antes do pago no empate (implementado).

**Franquia mensal:**
- Na migração de cada empresa (corte), **preservar o direito atual**: o limite mensal já configurado em
  `convite_carteiras` continua valendo (implementado).
- Franquia padrão por plano, a partir do mês seguinte ao corte: Essencial **5**, Profissional **15**, Premium **30**
  gerações por mês civil de São Paulo, **sem acumular**. Quando a empresa já tiver limite legado maior, vale o maior
  (nunca reduzir direito existente). Primeira ativação ou upgrade no meio do mês: proporcional aos dias restantes,
  arredondado para cima; upgrade só concede a diferença; downgrade só no mês seguinte; reativação não dá segunda franquia.
- Wall-e: sem franquia enquanto indisponível.
- **Implementação pendente:** a franquia por plano e a proporcionalidade ainda não estão no código (hoje: só o limite legado).

**Catálogo:** a aprovação de venda exige uma **nova versão** do catálogo no código (ex.: `PILOTO-20261022`, só Convites 10
e 30), com o registro desta decisão em `aprovacao`, depois do gate de preço e do parecer jurídico sobre os termos; só então
`CREDITOS_CATALOGO_APROVADO` pode repetir essa versão em produção. A versão atual (`PROPOSTA-20261022-DEMO`) continua de
demonstração.

## D2. Garantia de 7 dias por compra, mesmo com uso

**Decidido: manter.** Devolução **integral** do valor pago em até 7 dias da liberação de cada pacote, **inclusive CNPJ e
mesmo com uso**, sem taxa e sem cobrar o consumo (como implementado). Gerações já entregues ficam com o cliente; o saldo
restante do pacote é cancelado na hora.

Salvaguardas:
- No piloto, `CREDITOS_ESTORNO_ATIVO` fica **desligada**: toda devolução vai para a fila manual e o estorno é feito no
  painel do Asaas dentro do prazo do arrependimento (alarme CRÍTICO em 1 h, D4).
- A partir da **3ª devolução por garantia da mesma empresa em 12 meses**, revisão manual antes do estorno — **nunca**
  negativa automática do direito legal. (A regra de revisão ainda não está no código; no piloto todas são manuais.)
- Excluir o pacote de 100 do piloto (D1) limita o custo de abuso.

Depende do jurídico: texto da garantia, marco dos 7 dias (liberação do lote) e convivência com o CDC art. 49 e o Decreto
7.962/2013 para pessoa jurídica.

## D3. Pagamento que chega depois do vencimento

**Decidido: sempre honrar a fotografia do pedido.** Pagamento confirmado de pedido `AGUARDANDO_PAGAMENTO` ou `VENCIDO` libera
os créditos da oferta registrada no pedido, com validade contada **da confirmação** (como implementado), mesmo que o
catálogo tenha mudado.

Pagamento de cobrança **cancelada** (pedido `ENCERRADO`) ou valor divergente: vai para **revisão**, e o cliente escolhe entre
receber os créditos do pedido ou a **devolução integral** em até 5 dias úteis. O dinheiro nunca fica retido sem crédito.
**Lacuna de código:** a reconciliação não revisita pedidos `ENCERRADO`; um pagamento numa cobrança cancelada (raro no Asaas)
só apareceria pelo webhook e hoje terminaria como "já concluído". Corrigir antes do sandbox.

## D4. Alerta CRÍTICO na conferência diária

**Decidido: aprovar a extensão** (implementada em `scripts/assinatura-reconciliar.cjs`). Alarmam em **toda** conferência de
produção até a resolução, em vez dos dias 0/1/3/7/semanais:
1. pagamento confirmado sem crédito;
2. pagamento duplicado;
3. arrependimento de pacote não processado 1 h depois do pedido;
4. divergência entre extrato, lotes e carteira.

Os demais itens dos créditos seguem a regra por idade da D-C4. Responsável: **Felipe**. **Substituto: não definido** —
pendência de pessoa, necessária antes de abrir a venda (o arrependimento exige ação no mesmo dia).

## D5. Jurídico e contador

**Decidido: enviar** o pacote `D:/glass/KidMais Manager/pacote-revisao-creditos-juridico-contador-20261022/` (preparado pelo
agente; o **envio é de Felipe**, que tem o canal com a Astra e com o contador). A venda só abre com os dois pareceres e com
o gate de preço da D1.

## Situação

| Ponto | Decisão | Código | Bloqueia a venda? |
|---|---|---|---|
| D1 preços/validade | piloto Convites 10/30; validade 12 meses | catálogo de demonstração (nova versão na aprovação) | sim: gate de preço + jurídico |
| D1 franquia | legado preservado; 5/15/30 por plano depois | só o legado | não para o piloto com empresas migradas |
| D2 garantia | integral com uso; fila manual no piloto | implementada (sem a regra da 3ª) | sim: jurídico |
| D3 pagamento tardio | honrar a fotografia; cancelada → revisão | parcial (lacuna `ENCERRADO`) | sim: corrigir a lacuna |
| D4 CRÍTICO | aprovado | implementado | sim: substituto de Felipe |
| D5 pareceres | enviar | — | sim |
