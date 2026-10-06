---
name: kidmais-tenant-safety
description: Revisão read-only de isolamento entre empresas (tenants) e estabelecimentos no Kidmais Manager. Use ao criar ou alterar rotas em app/api, repositories em lib/*/repositories, queries SQL, autenticação, autorização, dados pessoais, contratos ou pagamentos, e em toda tarefa da fundação SaaS (empresa_id, estabelecimento_id, permissões).
---

# Tenant / Security review

Base: `docs/arquitetura/MULTI-TENANT.md`, `MULTI-ESTABELECIMENTO.md`, `PERMISSOES.md`, `docs/04-SEGURANCA-E-AUDITORIA.md`, ADR-001 e ADR-002.

Esta revisão é **read-only**: aponte achados concretos com arquivo:linha; não corrija durante a revisão.

## Estado atual (V1)

A V1 é single-tenant: ainda não existe `empresa_id`/`estabelecimento_id`. As rotas admin chamam `exigirApiAdminCrmDisponivel(request)` de `lib/http/admin-crm-api.ts`, que valida a sessão (`sessoes_administrativas`) e, em métodos que não são GET/HEAD, também a origem (`ADMIN_AUTH_ORIGIN`) e o header `x-csrf-token`. `contextoCrmDaRequest(request)` entrega `usuarioId` e `requestId` para auditoria. O banco é acessado por `db()` de `lib/db/postgres.ts` com SQL parametrizado. Código novo deve nascer pronto para o escopo de tenant, sem esperar a migration.

## Checklist por rota (`app/api/**/route.ts`)

1. A rota admin chama `await exigirApiAdminCrmDisponivel(request)` como **primeira** coisa do handler, antes de ler o corpo ou tocar o banco? Rota admin sem essa chamada é achado ALTO.
2. Responde com `Cache-Control: no-store` (helper `noStore` das rotas existentes)?
3. Entrada validada com `zod` `.strict()`; IDs como `z.string().uuid()`?
4. O ID vindo da URL/corpo é usado só para **localizar** o registro, nunca para **autorizar**? (IDs de outro tenant nunca autorizam acesso.)
5. A resposta de erro não vaza existência de registro de outro escopo (404 igual para "não existe" e "não é seu").
6. Rotas públicas (`app/api/contratos/[contratoId]`, `identidade/*`, `fechamentos`) dependem de token/OTP com escopo, expiração e uso único quando aplicável?

## Checklist por query/repository

1. Toda query de dado operacional filtra pelo escopo (hoje: o vínculo com o cliente/fechamento/contrato; no SaaS: `empresa_id` e, quando aplicável, `estabelecimento_id`).
2. JOINs não "escapam" do escopo (um JOIN por ID sem repetir o filtro de escopo é achado).
3. `UPDATE`/`DELETE` incluem o escopo no `WHERE`, não só o ID.
4. Agregações e relatórios nunca cruzam tenants; consolidação só dentro da mesma empresa.
5. Nada de interpolar texto do usuário em SQL; só parâmetros `$1, $2…`.
6. Ação administrativa sensível grava em `auditoria`.

## Dados pessoais e segredos

- CPF, telefone, e-mail e endereço não vão para logs nem mensagens de erro.
- Segredos só via `process.env`; nada de token, pepper ou senha no código ou nos testes.
- OTP: `IDENTIDADE_OTP_PEPPER` nunca reaproveitado entre ambientes.

## Teste cross-tenant (obrigatório no SaaS)

Para cada recurso novo, peça ou escreva o teste: usuário da Empresa A tenta ler, alterar e listar dado da Empresa B pela API e recebe recusa; o dado de B permanece intacto.

## Formato da resposta

```
[ALTO|MÉDIO|BAIXO] arquivo:linha — problema
  Cenário: requisição/entrada concreta → efeito indevido
  Correção sugerida: …
```
Termine com "Sem achados" quando for o caso, dizendo o que foi verificado.
