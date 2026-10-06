---
name: kidmais-saas-fundacao
description: Roteiro da Fase 1 do roadmap (fundação SaaS / multiempresa) do Kidmais Manager - introduzir Empresa/Tenant e Estabelecimento, empresa_id/estabelecimento_id e autorização por escopo sem quebrar a V1 em produção. Use em tarefas de branch saas/*, diagnóstico multi-tenant, desenho de entidades Empresa/Estabelecimento ou migração de tabelas para escopo de tenant.
---

# Fundação SaaS (Fase 1 / 1A)

Base: `docs/02-ARQUITETURA-SAAS.md`, `docs/03-ROADMAP.md` (Fase 1 e 2), ADR-001/002/003, `docs/arquitetura/*`. Marco: **Empresa A e Empresa B operam sem acesso cruzado.**

## Regras de trabalho

- Trabalhe em branch `saas/*` (começando por `saas/foundation`); a V1 em produção recebe só correções (docs/07).
- Primeira tarefa (1A) é **diagnóstico sem alterar código**: mapa de entidades, tabelas, APIs, autenticação, riscos, migrations propostas, rollback e testes.
- Cada passo deve manter a Kidmais funcionando como "Empresa 1" com comportamento idêntico.

## Diagnóstico 1A — o que levantar

1. Todas as tabelas (`database/migrations/*`, `kidmais-crm-migrations/*`) classificadas: estrutural / escopo empresa / escopo estabelecimento / global da plataforma.
2. Para cada tabela operacional: caminho atual até o "dono" (cliente → fechamento → contrato → pagamento → festa) e onde `empresa_id`/`estabelecimento_id` deve morar (direto ou resolvível de forma inequívoca).
3. Todas as rotas `app/api/**` e o que cada uma lê/escreve; quais são públicas (token/OTP) e quais admin.
4. Sessão admin (`sessoes_administrativas`, `usuarios_administrativos`, `lib/autenticacao`) e como ela passará a carregar empresa e estabelecimentos autorizados.
5. Regras fixas em código que viram configuração (PIX 3%, foro, horários, preços — ADR-003), com arquivo:linha.
6. Arquivos fora do banco (`data/disponibilidade.json`) e como ganham escopo.

## Sequência de implementação sugerida

1. Tabelas `empresas` e `estabelecimentos` (id imutável, `codigo` único; código do estabelecimento único dentro da empresa), com a Kidmais semeada.
2. `empresa_id` (+ `estabelecimento_id` quando aplicável) nas tabelas operacionais: nullable → backfill para a Kidmais → `NOT NULL` + FK + índice. Uma migration por grupo, cada uma via `kidmais-safe-migration`.
3. Contexto de request: a sessão resolve usuário → empresa → estabelecimentos autorizados; `contextoCrmDaRequest` passa a carregar esse escopo e **todo** repository o recebe como parâmetro obrigatório (não opcional).
4. Queries filtram pelo escopo vindo da sessão, nunca de ID enviado pelo cliente.
5. Testes cross-tenant: seed com Empresa B fictícia; para cada rota, B não lê, não altera e não lista dados de A.
6. Avaliar Row Level Security no PostgreSQL como defesa adicional, depois do modelo estável.

## Revisões obrigatórias

`kidmais-tenant-safety` em toda rota/query alterada; `kidmais-safe-migration` em toda migration; `kidmais-doc-sync` (ADR novo para decisões de modelo de dados e permissão).
