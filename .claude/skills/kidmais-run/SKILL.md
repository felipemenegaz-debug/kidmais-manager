---
name: kidmais-run
description: Sobe o Kidmais Manager localmente (Next.js + PostgreSQL) para ver uma mudança funcionando no navegador, com as variáveis de ambiente certas e sem tocar produção. Use quando pedirem para rodar, abrir, testar no navegador ou tirar screenshot do app.
---

# Rodar o app localmente

Esta versão do Next.js tem mudanças incompatíveis: leia `node_modules/next/dist/docs/` antes de mexer em configuração (AGENTS.md).

## Pré-requisitos

1. Node 22 (o CI usa 22) e `npm ci`.
2. PostgreSQL **local** com o schema aplicado (`schema_mvp_kidmais.sql` + `database/migrations/` em ordem). Nunca use a `DATABASE_URL` de produção.
3. `.env.local` (o agente não edita `.env*`; peça ao usuário). Variáveis usadas, por nome (valores em `ENV_PRODUCAO_EXEMPLO.txt` como referência de formato):
   - `DATABASE_URL`, `DATABASE_SSL=false` para local;
   - `ADMIN_AUTH_ORIGIN=http://localhost:3000` (em dev é o padrão), `ADMIN_AUTH_SECRET`;
   - `IDENTIDADE_OTP_PEPPER`, `IDENTIDADE_OTP_PROVIDER` (use o provedor de desenvolvimento, nunca o WhatsApp real);
   - flags de desenvolvimento: `CRM_API_DEV_ENABLED`, `CONTRATO_ACEITE_DEV_ENABLED`, `FESTA_ENABLED`.

## Subir

```bash
npm run dev            # http://localhost:3000
curl -s localhost:3000/api/health
```

Rode em segundo plano e espere o health responder antes de abrir páginas.

## Navegar

- Fluxo principal: `/clientes` → `/disponibilidade` → `/fechamento` → `/contrato` → pagamentos → `/festas`; área administrativa em `/admin`.
- Login admin exige usuário administrativo no banco local; peça ao usuário para criá-lo com o script de provisionamento (o mod `kidmais-guard` não deixa o agente executá-lo).
- Para tela sem banco, prefira `npm run check:v1:ui` (respostas simuladas, porta 3027).
- Screenshots: Playwright com Chromium já instalado (`PLAYWRIGHT_BROWSERS_PATH`); salve em `.local-*/` (ignorado pelo git).

## Ao terminar

Pare o servidor e diga o que foi visto (rota, ação, resultado), com screenshot quando for UI.
