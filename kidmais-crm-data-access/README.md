# Kidmais Manager — Clientes / CRM — Camada de acesso ao PostgreSQL

Data: 2026-09-07  
Referência funcional/UX: V8.8.

## O que esta etapa implementa

Esta entrega adiciona a camada de acesso ao banco do núcleo Clientes / CRM, sem conectar as telas e sem antecipar regras de API/autorização.

Estrutura:

```text
lib/
  db/
    contracts.ts
    postgres.ts
    errors.ts
  clientes/
    repositories/
      models.ts
      normalizers.ts
      mappers.ts
      cliente.repository.ts
      aniversariante.repository.ts
      responsavel.repository.ts
      historico.repository.ts
      auditoria.repository.ts
      duplicidade.repository.ts
      mesclagem.repository.ts
      index.ts

database/
  migrations/
    20260907_001_crm_extensions.sql
    20260907_002_crm_people.sql
    20260907_003_crm_history_audit.sql
    20260907_004_crm_duplicates_merge.sql
    20260907_999_crm_core_down.sql
```

## Driver PostgreSQL

A V8.8 é Next.js + TypeScript. O arquivo `prisma/schema.exemplo.prisma` existente é apenas um exemplo anterior e não representa o schema final do CRM. Para evitar acoplar a engenharia a um ORM antes da decisão arquitetural global, esta camada usa SQL PostgreSQL parametrizado por meio do driver `pg`.

No projeto real:

```bash
npm install pg
npm install -D @types/pg
```

Configure `.env.local` com base no `.env.example`.

## Responsabilidade desta camada

Repositories fazem somente persistência/consulta. Exemplos:

- `criarCliente()`
- `buscarClienteCanonicoPorCpf()`
- `buscarClientesPorContatoExato()`
- `buscarClientesPorNomeSemelhante()`
- `atualizarCliente()`
- `criar/listar/atualizar/desativar Aniversariante`
- `criar/listar/atualizar/desativar Responsável`
- `registrar/listar Histórico`
- `registrar/listar Auditoria`
- `registrar/listar possível duplicidade`

Não cabe ao repository decidir se uma ação é permitida. Exemplo: `atualizarCliente()` consegue persistir CPF, mas a próxima camada de serviço deverá verificar perfil Gestor/Administrador, exigir justificativa quando necessário e gravar auditoria.

## Transações

`lib/db/postgres.ts` fornece:

```ts
withTransaction(async (tx) => {
  // todas as operações recebem tx como customDb
});
```

Isso será usado na etapa de duplicidades/mesclagem para garantir `BEGIN/COMMIT/ROLLBACK` em uma única conexão.

## Importante sobre schema_mvp_kidmais.sql antigo

Existe no acervo do projeto um `schema_mvp_kidmais.sql` anterior que cria `clientes`, `aniversariantes` e `responsaveis_adicionais` com IDs BIGINT e regras antigas. Ele NÃO deve ser executado junto com estas migrations do CRM: as duas estruturas são incompatíveis para essas tabelas.

A partir desta engenharia, o núcleo CRM usa as migrations UUID `20260907_001` a `004` como referência física. O restante do schema global do Kidmais Manager deverá ser migrado/adaptado gradualmente para referenciar os UUIDs do CRM quando chegarmos às integrações.

## O que NÃO foi feito nesta etapa

- não removemos `clientesMock` das telas;
- não criamos endpoints de Clientes;
- não conectamos formulário/listagem/perfil;
- não implementamos autorização;
- não implementamos `mergeClientes()` completo;
- não integramos `fechamentos` e `festas`;
- não executamos migrations em banco de produção.

Esses pontos pertencem às próximas etapas previstas.

## Próxima etapa

**API / serviços**.

Nela serão implementadas validações e regras reais sobre os repositories, incluindo:

- tentativa de novo Cliente com CPF existente;
- alerta de telefone/WhatsApp repetido;
- sugestão de nomes semelhantes;
- atualização de CPF como ação crítica;
- criação automática de Histórico/Auditoria quando aplicável;
- contrato de erros para as rotas HTTP.
