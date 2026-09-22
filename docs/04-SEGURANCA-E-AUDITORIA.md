# 04 — Segurança e Auditoria

## Princípios
- menor privilégio;
- isolamento por tenant;
- autorização no backend;
- auditabilidade de ações sensíveis;
- preservação de documentos assinados;
- backups e restauração testáveis;
- segregação entre staging e production.

## Controles já relevantes para V1
- health/readiness;
- PostgreSQL;
- staging e production;
- backup/PITR;
- rollback;
- regras de auditoria;
- OTP transacional;
- procedimentos de produção.

## Requisitos SaaS
- toda request deve resolver usuário, empresa e estabelecimentos autorizados;
- IDs de outros tenants nunca autorizam acesso;
- ações administrativas relevantes devem gerar trilha;
- secrets não devem estar no código;
- permissões devem ser explícitas;
- logs não devem expor dados sensíveis desnecessários;
- testes cross-tenant devem fazer parte da regressão.

## Evolução planejada
- RBAC formal;
- rate limiting;
- gestão de sessão;
- políticas de retenção;
- incident response;
- 2FA administrativo;
- SSO/OIDC/SAML quando comercialmente necessário;
- avaliação de Row Level Security no PostgreSQL como defesa adicional.

## Regra de contratos
Documento assinado é imutável. Correções posteriores geram nova versão, aditivo ou retificação, preservando histórico, motivo, data e responsável.
