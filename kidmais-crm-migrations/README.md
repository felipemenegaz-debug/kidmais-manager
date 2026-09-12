# Kidmais Manager — Clientes / CRM — Migrations PostgreSQL

Data-base desta revisão: 2026-09-07.

## Ordem

1. `20260907_001_crm_extensions.sql`
2. `20260907_002_crm_people.sql`
3. `20260907_003_crm_history_audit.sql`
4. `20260907_004_crm_duplicates_merge.sql`
5. `20260907_005_disponibilidade_base.sql`

Rollback integral de desenvolvimento/teste:

- `20260907_999_crm_core_down.sql`

## Escopo

Estas migrations implementam apenas a fundação do módulo Clientes / CRM definida para esta etapa:

- Cliente canônico;
- Aniversariantes;
- Responsáveis adicionais;
- busca/alerta para duplicidade;
- histórico funcional;
- auditoria técnica append-only;
- central de possíveis duplicidades;
- registro permanente de mesclagens;
- configuração operacional dos dois turnos de Disponibilidade;
- bloqueios administrativos de agenda persistidos em PostgreSQL.

Não conectam telas e ainda não implementam:

- camada de acesso ao banco;
- API/serviços;
- autenticação/autorização;
- OTP/validação pública;
- integração real com Festa confirmada (a tabela `festas` ainda pertence a etapa futura);
- persistência das regras comerciais por pacote (aguarda a tabela `pacotes`).

## Decisões técnicas

- PostgreSQL nativo, sem acoplamento prematuro a ORM.
- IDs UUID via `gen_random_uuid()`.
- timestamps com timezone (`timestamptz`).
- `pg_trgm` para similaridade de nomes.
- CPF único apenas entre registros canônicos (`status <> 'MESCLADO'`).
- telefone e WhatsApp podem coincidir: geram alerta, não constraint de unicidade.
- Cliente, Aniversariante e Responsável não possuem hard delete como fluxo do MVP.
- auditoria é imutável no banco.
- mesclagem não é executada automaticamente por trigger; será um serviço transacional explícito na etapa de API/serviços.

## Usuários internos

Campos `*_usuario_id` já são `uuid`, mas propositalmente ainda não possuem FK para `usuarios` nesta migration. A tabela/contrato definitivo de usuários será fechado na etapa de autenticação/permissões. Isso permite preparar a rastreabilidade sem antecipar a implementação de autenticação.

Quando `usuarios` estiver consolidada, uma migration posterior adicionará as FKs `ON DELETE RESTRICT` correspondentes.

## Normalização esperada na futura camada de acesso/serviço

Antes de persistir:

- CPF: somente dígitos, 11 caracteres, com validação de dígitos verificadores na aplicação;
- telefone/WhatsApp: somente dígitos, preferencialmente incluindo código do país;
- CEP: somente dígitos, 8 caracteres;
- UF: duas letras maiúsculas;
- e-mail: trim e validação de formato na aplicação.

O banco também aplica checks básicos de formato para impedir dados claramente inválidos.

## Mesclagem

A migration cria a estrutura necessária, mas não cria uma função SQL que mescla registros automaticamente. Na etapa de API/serviços, `mergeClientes()` deverá executar uma única transação com lock dos dois Clientes, revinculação de Aniversariantes/Responsáveis/Fechamentos/Festas/histórico, marcação do secundário como `MESCLADO`, criação de `mesclagens_clientes` e gravação de histórico/auditoria.
