# ADR-010 — Roles e segurança PostgreSQL

## Status

ACCEPTED — SaaS/ADR-010, direção de menor privilégio D06 aprovada na 1B-C1. Papéis conceituais; nomes/grants executáveis e provisionamento D12c serão definidos nas fases próprias.

## Contexto

As roles B5B pertencem ao descartável e seu fingerprint. Elas não são roles de produção nem um modelo de autorização SaaS. [ADR-004](ADR-004-ISOLAMENTO-DE-DADOS.md) recomenda defesa de banco para o modelo compartilhado.

## Problema

Owner ou credencial de migration no runtime permite alterar schema/policies e compromete a defesa por RLS; jobs também podem contornar isolamento se usarem privilégios amplos.

## Drivers

Least privilege; segregação de funções; contexto obrigatório; auditabilidade; recuperação controlada; compatibilidade de funções legadas.

## Decisão

Separar owner sem login de serviço; migration role usada apenas no fluxo autorizado de deploy; runtime role sem ownership/DDL/BYPASSRLS/superuser; papéis de jobs por necessidade, igualmente sujeitos a contexto. Runtime não recebe TRUNCATE, criação de objetos em schemas de negócio, troca para owner/migrator nem EXECUTE indiscriminado. Grants de tabelas, sequences e funções são inventariados por ação; defaults de privilégios também entram na revisão. Identidades de serviço não são memberships humanas disfarçadas. A futura matriz de roles será própria, sem reutilizar automaticamente kidmais_b5b_owner/kidmais_b5b_sanitizer.

## Alternativas consideradas

Uma role única simplifica operação, mas mistura deploy e tráfego. Uma role por tenant aumenta gestão e não elimina bugs de associação; pode ser alternativa em isolamento físico. Grant genérico de todas as funções mantém portas de escrita invisíveis.

## Consequências positivas

Reduz caminhos de bypass; distingue responsabilidade de deploy e operação; permite testes de privilégio real.

## Consequências negativas/trade-offs

Provisionamento e rotação requerem processos próprios; funções V1 podem depender de permissões mais amplas e precisar revisão cuidadosa antes da restrição.

## Invariantes

Runtime e workers não podem assumir roles privilegiadas. Ausência de contexto nega acesso a tabelas tenant-owned. Direitos globais de plataforma não equivalem a leitura operacional.

## Implicações de segurança

Revisar SECURITY DEFINER, owner, search_path, argumentos, EXECUTE e efeito de todas as funções/views/triggers; preferir invoker quando suficiente. Se necessário, definer terá superfície mínima, resolução segura e autorização explícita; não é permissão para descoberta global. Avaliar FORCE ROW LEVEL SECURITY por categoria na 1C; não muda a proibição de owner/superuser/BYPASSRLS no runtime/workers. A superfície restrita de bootstrap do ADR-002 tem grants próprios a desenhar, sem circularidade com contexto operacional nem bypass genérico. Falhas de pool não reutilizam contexto anterior. Ver [RLS PostgreSQL 18](https://www.postgresql.org/docs/18/ddl-rowsecurity.html).

## Implicações para migrations

Provisionamento de roles/ACLs precede ativação de policies. Mudanças de grants exigem inventário de consumidores e pre/postchecks; ownership e default privileges precisam constar da evidência. Não copiar grants da referência B5B por coincidência de nomes. Credenciais/segredos não entram em migrations ou ADRs.

## Implicações para testes

T08/T11: role runtime tenta DDL/TRUNCATE/SET ROLE privilegiado e falha; policies com contexto ausente/adulterado; funções não autorizadas; workers sem escopo; pool reaproveitado; grants mínimos suficientes para fluxo V1 autorizado.

## Rollout

Projetar matriz de privilégios em isolado, executar regressão com a role real de runtime, revisar definer/default grants, então promover junto com policies. Plano break-glass deve ser separado do caminho normal, autorizado e auditado.

## Critérios de aceite

Inventário de privilégios fechado; nenhuma role de tráfego bypassa políticas; funções privilegiadas justificadas; testes usam roles não-owner; pool/contexto e erros têm evidência.

## Questões em aberto

D06 fechada como direção. Policies, parâmetros transaction-local, FORCE por categoria e tratamento da ameaça de SQL arbitrário serão detalhados/testados na 1C/implementação. D12c — MUST_DECIDE_BEFORE_FIRST_TENANT: provisionamento/rotação/operação sem alterar a estrutura aprovada; provisionar privilégios de teste antes de G3. D10 continua aberta; role de banco não substitui a semântica de revogação de membership.
