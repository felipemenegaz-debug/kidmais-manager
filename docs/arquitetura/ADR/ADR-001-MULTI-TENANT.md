# ADR-001 — Arquitetura multi-tenant

Status: Aprovado
Data: 2026-09-21

## Contexto
O Kidmais Manager foi criado inicialmente para a Kidmais, mas será productizado como SaaS para múltiplas empresas.

## Decisão
Cada empresa será um tenant isolado.

## Consequências
- dados precisam de escopo de tenant;
- autorização passa a considerar empresa;
- testes cross-tenant tornam-se obrigatórios;
- configurações específicas não devem permanecer globais.
