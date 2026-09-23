# ADR-004 — Isolamento de dados em camadas

## Status

ACCEPTED — SaaS/ADR-004, direção D01/D06/D08 aprovada na 1B-C1. RLS não está presente no baseline e não é implementada nesta fase; policies e FKs concretas pertencem à 1C.

## Contexto

A [matriz V1](../OWNERSHIP-V1-63.md) inclui PII, contratos, pagamentos e credenciais. FKs V1 relacionam IDs globais. As [funções 019](../../../database/migrations/20260915_019_festa_formalizacao.sql) e locks de agenda também refletem um único contexto operacional.

## Problema

Filtros esquecidos vazam leituras; FKs por ID isolado aceitam referências semanticamente erradas; RLS isoladamente não define domínio ou protege todos os acessos.

## Drivers

Defesa em profundidade; falhar fechado; integridade comprovável; desempenho; preservação dos fluxos V1.

## Decisão

Combinar query scoping obrigatório, constraints de escopo, FKs tenant-aware, índices adequados, privilégios mínimos e RLS no PostgreSQL/schema compartilhados aprovados. Tenant-owned exige empresa válida e inequívoca ao final do backfill; preferir chaves diretas, com exceção formal D08 para históricos protegidos. Candidatas estruturais: (empresa_id, estabelecimento_id) valida unidade da empresa; (empresa_id, cliente_id) valida CRM da mesma empresa; (empresa_id, estabelecimento_id, parent_id) valida pais operacionais da mesma unidade. FKs compostas não substituem invariantes do agregado. Não exigir unidade artificial em CRM empresa-owned. Cada categoria tenant-owned deverá ter proteção RLS adequada, inclusive acesso mediado por sidecar excepcional; descoberta de controle segue o contrato restrito do ADR-002. A 1C definirá e justificará cada policy/categoria. Segundo tenant permanece bloqueado até comprovação; banco por empresa não é fallback da arquitetura inicial.

## Alternativas consideradas

Filtros apenas na aplicação não satisfazem o requisito. FKs compostas isoladas protegem associações, mas não leituras. RLS isolada não substitui autorização por ação e unidade. Banco por empresa não foi escolhido em D01.

## Consequências positivas

Uma associação cross-tenant falha mesmo se houver bug na aplicação; políticas de leitura acrescentam uma barreira independente ao predicado da consulta.

## Consequências negativas/trade-offs

Mais índices e FKs custam escrita/armazenamento; joins de policy e revogação concorrente exigem análise. Toda função, view, trigger, relatório e pool precisa revisão.

## Invariantes

I01–I04 e I10. Unicidade comercial é por escopo pertinente: por exemplo, CPF/códigos/idempotência não podem permitir enumeração entre empresas. Exceções globais precisam classificação explícita.

## Implicações de segurança

Na proposta RLS, ausência/incoerência do contexto nega leitura/escrita; políticas cobrem leitura e validação de novas linhas. Owner normalmente bypassa RLS; superuser/BYPASSRLS também, e TRUNCATE não é protegido por RLS. Runtime não terá esses poderes. FKs/uniques podem revelar existência via erro, então resposta externa deve ser uniforme. Ver [PostgreSQL 18 RLS](https://www.postgresql.org/docs/18/ddl-rowsecurity.html). Contexto configurável pelo próprio runtime não protege contra SQL arbitrário após comprometimento dessa credencial.

## Implicações para migrations

Desenhar referências compostas e regras de nulabilidade antes do DDL. Não permitir FK composta parcialmente nula contornar integridade obrigatória. D04 não obriga que default da empresa tenha unidade: referência da operação à configuração efetiva precisa comprovar mesma empresa, aplicabilidade à unidade e identidade/versão usada. A 1C escolherá representação que preserve essas condições; não impor indiscriminadamente FK tripla à linha de default nem aceitar somente validação opcional no serviço. Sidecar D08 exige cobertura obrigatória, atomicidade, integridade e policies próprias. Avaliar índices, uniques e exclusões por escopo. Locks/ocupações incorporam unidade e ordem determinística sem enfraquecer concorrência dentro dela.

## Implicações para testes

T01–T04/T08/T11: consultas sem predicado sob role runtime continuam limitadas ao escopo autorizado pela defesa de banco; sem contexto válido, negam acesso tenant-owned. FKs rejeitam pais de B; batch/upsert/joins/exports e policies de INSERT/UPDATE testados; benchmark e concorrência por unidade.

## Rollout

Expandir contexto e chaves → backfill → validar constraints → policies e roles → ensaio A/B. Nunca ligar segundo tenant antes de todas as superfícies serem cobertas.

## Critérios de aceite

Catálogo completo de relações/policies e exceções revisado; zero acesso cruzado com IDs existentes; nenhuma rota usa bypass; plano de índices/locks medido em ambiente isolado.

## Questões em aberto

D01/D06 fechadas como direção; avaliar FORCE ROW LEVEL SECURITY por categoria, policies, FKs e índices na 1C. Isso é detalhamento técnico, não licença para reabrir topologia, dispensar tenant scope ou adiar provas até depois do onboarding. D11c CLOSED delimita as policies de visibilidade CRM; D10 continua aberta para revogação concorrente; ver [índice](README.md).
