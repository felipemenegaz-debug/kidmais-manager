# Multi-tenant

## Decisão
O Kidmais Manager evoluirá para arquitetura multi-tenant.

## Princípios
- tenant = Empresa;
- isolamento é requisito de segurança;
- autorização deve acontecer no backend;
- contexto do tenant deve ser propagado de forma confiável;
- testes cross-tenant são obrigatórios;
- identificadores fornecidos pelo cliente nunca substituem autorização;
- observabilidade deve permitir análise por tenant sem expor dados de outro.

## Banco
Avaliar defesa em profundidade com Row Level Security no PostgreSQL após desenho definitivo do modelo.
