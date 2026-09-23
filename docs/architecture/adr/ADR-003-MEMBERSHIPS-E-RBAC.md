# ADR-003 — Memberships e RBAC

## Status

PARTIALLY ACCEPTED — SaaS/ADR-003, 1B-C1. Identidade administrativa global e autorização por memberships/grants explícitos aprovadas. D03 e D10 permanecem OPEN DECISION, ambas MUST_DECIDE_BEFORE_FIRST_TENANT.

## Contexto

A V1 distingue ADMINISTRATIVO e REPRESENTANTE_AUTORIZADO e possui [capacidades de Festa](../../../lib/festas/service.ts), sem empresa/unidade. [Permissões oficiais](../../arquitetura/PERMISSOES.md) exigem autorização no backend e menor privilégio.

## Problema

Um papel global da V1 não define em quais empresas/unidades a pessoa pode operar nem quais ações pode delegar.

## Drivers

Menor privilégio; revogação efetiva; acesso a uma/várias unidades; preservação de autoria contratual; concessão auditável.

## Decisão

Uma identidade administrativa global representa o usuário uma vez na plataforma; membership na empresa e grants de ação/escopo são separados dessa identidade. Membership ativa é condição necessária para acesso administrativo tenant-owned. Grants suportam uma ou várias unidades da mesma empresa e negação é padrão. Nenhuma unidade futura ganha acesso implicitamente. Catálogo de ações pertence ao Core; representação de papéis/grants será detalhada na 1C, sem nome de papel usado como bypass. Uma pessoa pode ter memberships diferentes em empresas diferentes; nenhum papel se propaga entre elas. REPRESENTANTE_AUTORIZADO não vira administrador SaaS automaticamente.

## Alternativas consideradas

Um usuário por empresa reduz compartilhamento de identidade, mas duplica credenciais e complica navegação. Papéis globais únicos não expressam unidade. Permissões arbitrárias por linha aumentam complexidade sem necessidade comprovada. Recomenda-se iniciar com RBAC e escopos explícitos.

## Consequências positivas

Revogar uma membership não apaga a identidade histórica; capacidades existentes podem ser mapeadas sem ganhar poder implícito.

## Consequências negativas/trade-offs

Exige catálogo de ações, tela/fluxo de concessão e invalidação de caches; suporte e administradores também precisam escopo explícito.

## Invariantes

I05/I06/I10. Membership de empresa A não concede nada em B. Grant para A1 não autoriza A2. Delegação não permite conceder poderes acima da autoridade do concedente.

## Implicações de segurança

Admin de plataforma opera metadados da plataforma; acesso de suporte à operação requer autorização temporária, motivo e auditoria, a desenhar separadamente. Membership revogada deve negar novas operações; uma mutação já em andamento precisa revalidar autorização ou usar coordenação que determine ordenação segura de revogação/commit. Tokens antigos não preservam grants revogados.

## Implicações para migrations

Novas relações de membership/grant validam empresa/unidade coerentes. Preservar usuario_id e autoria V1. D07 fixa uma empresa e uma unidade inicial; mapear cada capacidade Festa V1 e cada papel ativo para concessões explicitamente revisadas nesse contexto, nunca para unidades futuras ou outras empresas. A cardinalidade inicial não aprova automaticamente todos os grants. Preservar revogações/histórico e testar paridade V1; não fabricar memberships históricas. Não converter todos os usuários em admins globais.

## Implicações para testes

T05/T06/T12: revogação, usuário desativado, papel reduzido, grant de outra unidade, alteração concorrente, escalada por payload e por delegação.

## Rollout

Inventariar capacidades V1; criar mapeamento aprovado para a Kidmais; validar paridade e negações; somente depois abrir múltiplas empresas.

## Critérios de aceite

Cada ação sensível mapeada a permissão e escopo; matriz usuário/empresa/unidade testada; revogação tem semântica documentada e teste concorrente.

## Questões em aberto

D02 fechada: identidade administrativa global. OPEN DECISION D03 — MUST_DECIDE_BEFORE_FIRST_TENANT: semântica de unidades futuras; até aprovação, somente unidades explicitamente concedidas. OPEN DECISION D10 — MUST_DECIDE_BEFORE_FIRST_TENANT: ordenação entre revogação e transações concorrentes. D11c CLOSED: visibilidade CRM mínima por vínculo/fluxo autorizado, sem diretório empresarial nem acesso retroativo a operações de outra unidade; [política aprovada](ADR-005-OWNERSHIP-DOS-DOMINIOS.md). Membership empresarial isolada não concede leitura completa ou escrita irrestrita.
