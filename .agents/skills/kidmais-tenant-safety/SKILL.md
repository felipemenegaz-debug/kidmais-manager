---
name: kidmais-tenant-safety
description: Revisa ou orienta mudanças multi-tenant do Kidmais envolvendo empresa_id, estabelecimento_id, autenticação, autorização, consultas, jobs, exports ou dados sensíveis.
---

# Segurança multi-tenant

Leia `docs/02-ARQUITETURA-SAAS.md`, `docs/04-SEGURANCA-E-AUDITORIA.md` e os documentos em `docs/arquitetura/` relevantes.

- Resolva usuário, `empresa_id` e estabelecimentos autorizados no backend; nunca confie apenas em IDs enviados pelo cliente.
- Verifique escopo de tenant em cada leitura, mutação, associação, job, cache, export e log.
- Quando houver `estabelecimento_id`, valide que pertence à mesma empresa e está autorizado para o usuário.
- Inclua testes negativos de IDOR e acesso cross-tenant/cross-estabelecimento, além do caminho autorizado.
- Trate ausência de contexto, joins ambíguos ou consultas sem escopo como bloqueadores de segurança.
- Reporte evidências, impacto, testes e rollback; não acesse produção, banco real, Render ou secrets.
