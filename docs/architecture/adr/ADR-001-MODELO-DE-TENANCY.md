# ADR-001 — Modelo de tenancy

## Status

ACCEPTED — direção estrutural aprovada pelo usuário na Fase 1B-C1 (2026-09-22), D01/D02. Identificador: SaaS/ADR-001. Aceite arquitetural não significa schema implementado ou autorização de rollout.

## Contexto

A [arquitetura oficial](../../02-ARQUITETURA-SAAS.md) define Empresa → Estabelecimentos → Configurações/Dados Operacionais. O [baseline congelado](../../baseline/V1-POST-019.md) é V1 global com 63 tabelas e nenhuma policy RLS.

## Problema

Transformar empresa em fronteira de isolamento e estabelecimento em fronteira operacional sem confundir identidade comercial, chave técnica e autorização.

## Drivers

Isolamento obrigatório; unidades independentes; preservação da V1; configurações por cliente; custo operacional verificável; possibilidade de evolução futura.

## Decisão

Empresa é o tenant, com identificador interno imutável e código próprio único na plataforma. Estabelecimento tem identificador interno, vínculo obrigatório com empresa e código único dentro dela. Códigos servem à descoberta/seleção e não são credenciais. A arquitetura inicial usa PostgreSQL compartilhado e schema compartilhado, empresa_id como dimensão tenant e estabelecimento_id como dimensão operacional quando aplicável. Aplicação, constraints/FKs e RLS compõem a defesa em camadas do [ADR-004](ADR-004-ISOLAMENTO-DE-DADOS.md). Não usar banco por empresa como alternativa inicial implícita. Dados comerciais Kidmais não são catálogo global da plataforma. Identidade administrativa global é separada de memberships/grants; identidade global não concede acesso global.

## Alternativas consideradas

Banco por empresa e schema por empresa foram considerados e não escolhidos para a arquitetura inicial. A decisão aprovada privilegia modelo compartilhado, assumindo a obrigação de isolamento comprovado e custos de operação mensuráveis. Eventual mudança futura de topologia exige outro ADR; não é fallback de segurança.

## Consequências positivas

A hierarquia tem uma única interpretação; códigos são previsíveis; consultas consolidadas permanecem dentro da empresa; o modelo suporta mais de uma unidade sem criar tenants artificiais.

## Consequências negativas/trade-offs

Banco compartilhado aumenta o impacto de falhas de autorização e disputa por recursos; um futuro tenant dedicado poderá exigir export/migração planejados.

## Invariantes

Aplicam-se I01–I10 do [gate SaaS](../SAAS-VALIDACAO-E-GATES.md). Identificadores/códigos não podem ser reutilizados de forma que reatribuam histórico. Transferir operação entre empresas não é atualização administrativa comum.

## Implicações de segurança

Usuários de plataforma não recebem leitura automática de dados operacionais. Empresa selecionada por cliente precisa ser validada contra autorização confiável. Ausência de escopo nega a operação.

## Implicações para migrations

A Fase 1C desenhará entidades estruturais, unicidade dos códigos e referências empresa/unidade. Não alterar PKs V1 por mera conveniência; acrescentar integridade de escopo preservando IDs sempre que seguro.

## Implicações para testes

T01/T02/T03/T04: empresas A/B e unidades A1/A2/B1; códigos iguais entre empresas quando permitido; colisão de código da empresa; tentativa de associação a outra empresa.

## Rollout

Primeiro adaptar a Kidmais sob feature gate e contexto explícito. Segundo tenant somente após G4 do gate SaaS, nunca apenas porque as novas tabelas existem.

## Critérios de aceite

Hierarquia e ownership coerentes nas 63 linhas da matriz; desenho 1C mantém a topologia compartilhada aprovada; nenhuma entrada operacional sem empresa e unidade válidas quando aplicável.

## Questões em aberto

D01/D02 fechadas. D07 fixa uma empresa Kidmais e um estabelecimento inicial. Tipos físicos de chaves, códigos concretos, capacidade e plano de recuperação serão detalhados/validados nas fases próprias; não foram inventados aqui. As OPEN DECISIONS transversais estão no [índice](README.md).
