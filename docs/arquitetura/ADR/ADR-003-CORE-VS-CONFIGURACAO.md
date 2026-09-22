# ADR-003 — Separação entre Core e Configuração

Status: Aprovado
Data: 2026-09-21

## Contexto
Regras específicas da Kidmais não podem impedir adoção por outras empresas, mas permitir configuração irrestrita pode comprometer integridade.

## Decisão
Separar regras em dois grupos.

### Core
Segurança, auditoria, integridade, versionamento e invariantes.

### Configuração
Pacotes, buffet, horários, preços, contratos-modelo, pagamentos, identidade e demais parâmetros comerciais/operacionais.

## Consequências
- productização sem fork por cliente;
- maior self-service;
- menor dependência do desenvolvedor;
- regras críticas continuam protegidas.
