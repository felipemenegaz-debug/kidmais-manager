# Sugestão inicial de PIX parcelado — V1

Disponível no POST administrativo `/api/admin/pagamentos`, com autenticação e CSRF existentes. Não altera a substituição de planos, o cronograma consolidado nem a forma comercial de cartão. Não executa cobrança nem registra recebimento.

## Solicitar e confirmar

O plano explícito com `parcelas` mantém o comportamento anterior. Para receber uma sugestão, omitir `parcelas` e enviar:

```json
{
  "fechamentoId": "UUID_DO_FECHAMENTO",
  "plano": {
    "meioPagamento": "PIX",
    "modalidade": "PARCELADO",
    "entrada": "2000.00",
    "valorParcela": "3000.00"
  }
}
```

`entrada`, `valorParcela` e `quantidadeParcelas` são opcionais. Quantidade significa parcelas do saldo, além da entrada. Sem entrada, zero é usado; os campos não são preenchidos implicitamente a partir de uma pretensão comercial antiga.

A resposta contém `data.sugestao`: total final, entrada, saldo, quantidade, quantidade máxima viável, valor mínimo aproximado por parcela, cronograma completo, pedido original, motivo de contraproposta, data de referência e hash. Toda sugestão tem `exigeConfirmacao: true`; não cria obrigação, plano ou parcelas.

- HTTP 200: pretensão viável ou geração sem pretensão.
- HTTP 422 / `CONDICAO_PIX_INVIAVEL`: pretensão incompatível, acompanhada de contraproposta viável para revisão.
- HTTP 422 / `SUGESTAO_PIX_INVALIDA`: dados inválidos ou ausência de solução, como Festa passada ou entrada superior ao contrato.

Após conferir, reenviar o mesmo pedido, acrescentando a `plano`:

```json
"confirmacao": {
  "dataReferencia": "DATA_RECEBIDA_NA_SUGESTAO",
  "hash": "HASH_RECEBIDO_NA_SUGESTAO"
}
```

Isso confirma expressamente também uma contraproposta. O servidor recalcula tudo e compara o hash ligado à versão assinada, pedido, data e resultado. Se a data de criação, contrato ou pedido mudou, exige nova conferência (409). Nenhum valor calculado enviado pelo consumidor é confiado. O hash identifica a sugestão, não substitui autenticação administrativa.

Criação confirmada: HTTP 201. Repetição da mesma confirmação: HTTP 200 com `reutilizado: true`, inclusive em outro dia, se o plano persistido ainda corresponder. A auditoria/histórico de criação inclui a referência da aprovação. Uma condição diferente não substitui silenciosamente um plano existente.

## Calendário e matemática

- Referência: data da criação em `America/Sao_Paulo`, definida pelo servidor. A entrada vence nesse dia; o saldo começa um mês depois.
- Datas mensais ancoradas no dia original, ajustadas ao último dia de cada mês quando necessário. Não deslocar por finais de semana ou feriados.
- Somente vencimentos até a Festa. Se não houver data mensal disponível, admitir uma única parcela do saldo na própria Festa. Não adicionar uma parcela residual na Festa quando já houver datas mensais disponíveis.
- Total: `snapshot.comercial.valorFinalContrato` da versão assinada PIX parcelado, já com desconto de 3%. Não aplicar desconto novamente. A entrada é subtraída uma vez para calcular o saldo programado, mas não é tratada como recebida.
- Valor pretendido: quantidade = teto(saldo / valor). Manter o valor nas primeiras parcelas; a última fecha o saldo. Se houver quantidade junto, ela deve ser igual à quantidade assim calculada.
- Quantidade informada: dividir o saldo em centavos inteiros; distribuir o resto, um centavo por parcela, começando pelas primeiras.
- Sem valor/quantidade: usar o máximo de datas disponíveis. Limite existente de 60 lançamentos, incluindo entrada; também limitar a quantidade aos centavos disponíveis para não gerar valores zero.
- Pedido inviável: oferecer o máximo viável e valor mínimo por parcela arredondado para cima, junto da distribuição exata. Não persistir até confirmação.
- Entrada integral: só há o lançamento da entrada. Se houver somente um lançamento no plano, sua modalidade financeira é `AVISTA`, conforme o modelo existente; a forma comercial do contrato permanece `PIX_PARCELADO`, com 3% de desconto.

Antes da gravação, todo plano calculado passa pelo mesmo validador de valores, soma, reserva e limite de vencimento do plano explícito. O fluxo de alteração financeira existente permanece separado.
