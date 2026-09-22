# Pagamentos

## Objetivo
Registrar condições financeiras, entradas, parcelamentos e vencimentos de forma consistente.

## Regras oficiais Kidmais
- PIX parcelado aplica 3% de desconto;
- condição é direta com a Kidmais;
- parcelas e vencimentos devem ser definidos e quitados até a data da festa;
- sistema não deve aceitar combinações incoerentes entre entrada, parcela e quantidade de parcelas;
- saldo após entrada deve ser calculado;
- sistema deve sugerir/validar parcelamento viável;
- cliente pode informar condição pretendida;
- sugestão automática fica sujeita à conferência/aprovação da operação.

## SaaS
As regras específicas de desconto, entrada e parcelamento devem virar configuração por estabelecimento, mantendo no Core:
- consistência matemática;
- integridade dos lançamentos;
- auditoria;
- bloqueio de estados inválidos.
