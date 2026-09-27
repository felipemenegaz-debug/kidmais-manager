# Financeiro V1

Módulo gerencial. Não é contabilidade fiscal, DRE, NFS-e nem cobrança externa.

## Fonte de verdade

Contas a receber continuam em `pagamento_parcelas`, `pagamento_recebimentos` e `pagamento_recebimento_alocacoes`. O financeiro só lê esse caminho e registra a baixa pelo serviço de pagamentos já existente, depois de provar que a parcela pertence à empresa da sessão.

Contas a pagar, categorias, recorrência e saídas ficam nas tabelas da migration `20260927_052_financeiro_gerencial`. Não há segunda tabela de recebíveis.

## Status

Vencido não é gravado. Receber: vencimento anterior a hoje, saldo positivo e parcela não cancelada. Pagar: mesma regra sobre o saldo da conta. Cancelado e reembolsado seguem o estado persistido do pagamento ou `cancelado_em` da conta. O valor de reembolso não é calculado nesta versão.

## Caixa e competência

O fluxo de caixa usa a data do recebimento confirmado, a data de pagamento da saída e o vencimento do que ainda está em aberto. Competência na conta a pagar é opcional e fica disponível para uma DRE futura.

Saldo previsto, compartilhado pelo Dashboard e pela visão financeira:

recebido no mês + a receber − a pagar.

Margem estimada da festa = recebido das parcelas da festa − despesas pagas vinculadas. Não é lucro contábil.

## Recorrência

Conta mensal materializa 12 ocorrências (`HORIZONTE_RECORRENCIA_MESES`). A unicidade `(recorrencia_id, vencimento)` impede duplicar o mesmo mês. Não há geração infinita nem cron.

## Tenant, permissão e concorrência

Toda rota usa a sessão administrativa já existente e `withTenantTransaction`. O `empresaId` do cliente é ignorado na escrita. Pacote sem empresa fica fora da leitura.

A baixa de parcela chama `registrarRecebimentoPagamento` fora da transação de tenant, com chave de idempotência. A saída trava a conta com `FOR UPDATE` antes de comparar o saldo. A chave de idempotência da saída é única.

RBAC V1 reutiliza a membership administrativa comprovada. Não há papel financeiro novo. Uma capability futura pode separar consulta, baixa e relatórios sem mudar o modelo de dados.

## Fora desta versão

Cielo, Asaas, Stripe, Open Finance, webhook, PIX, boleto e cartão reais, NFS-e, DRE completa, folha, conciliação bancária e WhatsApp de cobrança. A forma de cartão vira `CARTAO` no recebimento de contrato; boleto vira `OUTRO`. Nenhum PAN ou CVV é armazenado.

## Rollback

`database/rollback/20260927_052_financeiro_gerencial_down.sql` recusa a queda se existir conta ou saída. Com as tabelas vazias, remove categorias, recorrências, contas, saídas e auditoria. Não altera parcelas nem recebimentos de contrato.
