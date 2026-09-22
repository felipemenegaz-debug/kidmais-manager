<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Kidmais Manager SaaS — Regras permanentes

- `docs/` é a fonte oficial das regras funcionais, arquiteturais, operacionais e de segurança. Leia os documentos relevantes antes de propor ou implementar mudanças.
- Nunca acesse ou altere produção sem autorização explícita do usuário para a ação específica.
- Nunca execute migrations de produção automaticamente.
- Nunca use o banco real da Kidmais para testes do SaaS; use somente ambientes isolados e dados sintéticos autorizados.
- Isolamento por tenant é requisito obrigatório e deve ser imposto no backend.
- Toda alteração multi-tenant deve considerar `empresa_id` e, quando aplicável, `estabelecimento_id`, inclusive em autorização, consultas, mutações, jobs, exports e testes.
- Preserve a compatibilidade da V1 enquanto a migração SaaS estiver em andamento.
- Antes de concluir, revise o diff e execute os testes pertinentes ao risco e ao escopo da mudança.
- Ao entregar uma mudança, reporte riscos, testes executados e estratégia de rollback.
- Não faça push ou merge automaticamente.
