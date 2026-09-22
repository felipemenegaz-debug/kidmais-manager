# ADR-002 — Empresa com múltiplos estabelecimentos

Status: Aprovado
Data: 2026-09-21

## Contexto
Uma mesma empresa pode operar várias casas/unidades com regras próprias.

## Decisão
Adotar relação Empresa 1:N Estabelecimentos.

## Consequências
- cada unidade pode ter agenda, pacotes, preços, buffet e contratos próprios;
- dados operacionais precisam identificar estabelecimento;
- relatórios podem consolidar unidades dentro da mesma empresa;
- permissões devem considerar unidades autorizadas.
