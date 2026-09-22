# Festas

## Objetivo
Representar e gerenciar o evento efetivamente contratado e em execução.

## Regra estrutural
A criação da Festa não ocorre no simples envio/conclusão do fechamento.

A Festa deve ser criada somente quando:
- contrato estiver assinado pela Kidmais; e
- contrato estiver assinado pelo cliente.

## Regras
- festas devem aparecer nas visões administrativas corretas conforme status/data;
- transição de fechamento/contrato para festa deve ser determinística;
- vínculos com cliente, estabelecimento, contrato e pagamentos devem ser preservados;
- histórico deve ser auditável.

## SaaS
Toda Festa deve estar associada à empresa e ao estabelecimento corretos.
