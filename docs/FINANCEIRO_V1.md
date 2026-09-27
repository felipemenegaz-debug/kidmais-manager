# Financeiro V1

Módulo gerencial. Não é contabilidade fiscal, DRE, NFS-e nem cobrança externa.

## Fonte de verdade

Contas a receber continuam em `pagamento_parcelas`, `pagamento_recebimentos` e `pagamento_recebimento_alocacoes`. O financeiro só lê esse caminho e registra a baixa pelo serviço de pagamentos já existente. A rota repassa o token da sessão administrativa (`tokenAdmin`). A prova do tenant, a baixa, a alocação e a auditoria acontecem no mesmo `withTenantTransaction`: membership ativa, empresa ativa e o vínculo da parcela são revalidados nessa transação e os locks seguem até o `COMMIT`. O serviço de pagamento aceita o executor dessa transação; a rota antiga de recebimento, sem executor, continua abrindo a própria. Se a auditoria falhar, ou se a membership for revogada ou a empresa suspensa antes do commit, a baixa inteira desfaz. Uma baixa já confirmada, reenviada com a mesma chave e o mesmo payload, devolve o resultado anterior e não grava segunda auditoria. A chave é consultada antes do saldo. O payload comparado é valor, parcela, forma, taxa, data e observação. A mesma chave com outro payload, na mesma empresa, é recusada. Empresas diferentes podem usar a mesma string: o escopo é empresa, tipo de operação e chave. Uma empresa não lê nem altera a operação da outra.

Contas a pagar, categorias, recorrência e saídas ficam nas tabelas da migration `20260927_052_financeiro_gerencial`. Não há segunda tabela de recebíveis.

## Status

Vencido não é gravado. Receber: vencimento anterior a hoje, saldo positivo e parcela não cancelada. Pagar: mesma regra sobre o saldo da conta. Cancelado e reembolsado seguem o estado persistido do pagamento ou `cancelado_em` da conta. O valor de reembolso não é calculado nesta versão.

## Caixa e competência

O fluxo de caixa usa o valor líquido do recebimento confirmado (bruto menos a taxa já conhecida) e o valor pago da saída. O saldo inicial do período é esse caixa realizado antes da data inicial. Entradas e saídas do período somam só o realizado. O saldo final é inicial + entradas − saídas. Linhas previstas aparecem na tabela e não movem o saldo. Competência na conta a pagar é opcional e fica disponível para uma DRE futura.

Saldo previsto, compartilhado pelo Dashboard e pela visão financeira, usa o mês calendário corrente:

recebido no mês + a receber em aberto − a pagar em aberto.

A visão financeira e o Dashboard Geral são posição atual: A receber total e A pagar total, sem filtro de período. Relatórios recebem `{ inicio, fim }`. Faturamento, ticket médio, pacote mais vendido, receita por pacote e margem por festa usam a data do evento. Recebido, formas e taxas usam a data do recebimento. A receber no período, a pagar no período e inadimplência no período usam o vencimento dentro do intervalo. Parcelas canceladas não entram no contratado nem no faturamento. O total em aberto e o saldo do período não compartilham o mesmo rótulo.

Margem estimada da festa = valor contratado das parcelas não canceladas − valor das despesas vinculadas não canceladas, inclusive as que ainda estão em aberto. Resultado de caixa = recebimentos líquidos realizados − despesas já pagas. O líquido é o mesmo do fluxo: bruto menos a taxa. Não é lucro contábil.

## Recorrência

Conta mensal materializa 12 ocorrências (`HORIZONTE_RECORRENCIA_MESES`). A tela deixa isso explícito. A chave da criação é única por empresa e impede uma segunda série no reenvio. A unicidade `(recorrencia_id, vencimento)` impede duplicar o mesmo mês. `estenderRecorrencia` completa meses seguintes até o teto de 24, sem recriar os que já existem. Não há geração infinita nem cron.

## Contas a pagar

A categoria precisa pertencer à mesma empresa, também na edição. A chave de idempotência da saída é única por empresa, não global. Cancelar uma conta que já tem pagamento é recusado: o estorno vem antes, e o pagamento realizado permanece no resultado.

## Tenant, permissão e concorrência

Toda rota usa a sessão administrativa já existente e `withTenantTransaction`. O `empresaId` do cliente é ignorado na escrita. Pacote sem empresa fica fora da leitura.

A baixa de parcela chama `registrarRecebimentoPagamento` com a sessão administrativa, a chave de idempotência e o executor da transação do tenant. A saída procura a chave da empresa antes de travar a conta e comparar o saldo. Chave nova segue para o `FOR UPDATE` e para o saldo.

RBAC V1 reutiliza a membership administrativa comprovada. Não há papel financeiro novo. Uma capability futura pode separar consulta, baixa e relatórios sem mudar o modelo de dados.

## Fora desta versão

Cielo, Asaas, Stripe, Open Finance, webhook, PIX, boleto e cartão reais, NFS-e, DRE completa, folha, conciliação bancária e WhatsApp de cobrança. A forma de cartão vira `CARTAO` no recebimento de contrato; boleto vira `OUTRO`. Nenhum PAN ou CVV é armazenado.

## Rollback

`database/rollback/20260927_052_financeiro_gerencial_down.sql` trava contas, saídas e auditoria, e recusa a queda se qualquer uma tiver linha. Com as tabelas vazias, remove categorias, recorrências, contas, saídas e auditoria. Não altera parcelas nem recebimentos de contrato. Não apaga auditoria já confirmada.

## Staging e produção

Esta versão ainda não sobe para staging. O Render de produção já acompanhou o branch de staging; um push nesse branch pode publicar produção se o auto-deploy continuar ligado. Nesta rodada não há deploy, merge nem migration em staging ou produção.
