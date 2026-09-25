# Revisão — migration 026, estrutura do Perfil da Empresa

Data: 25/09/2026. Status: arquivos redigidos, sem execução. As migrations 026, 027 e 028 continuam não executadas. O código de autorização, cadastro e a tela `/admin/configuracoes/perfil-empresa` existem na branch `feat/v1-perfil-empresa-autorizacao`, mas o recurso não está disponível para uso enquanto essas migrations e o provisionamento inicial não forem autorizados e aplicados. A 028 corrige o CHECK da revisão aplicada (`motivo IS NOT NULL`) e acrescenta quem aplicou; ela não reescreve 026 nem 027. Testes com doubles não comprovam execução de SQL nem concorrência no PostgreSQL.

Referência de desenho lida no worktree da proposta, commit `9bed49b`: `docs/modulos/PERFIL-EMPRESA-V1-PROPOSTA-TECNICA.md`, seção 3.1. Esta entrega não altera essa proposta.

Redigir estes arquivos não autoriza aplicá-los em banco nenhum, inclusive descartável, staging, produção ou `kidmais_manager`.

## Arquivos

- `database/migrations/20260925_026_perfil_empresa_estrutura.sql`
- `database/checks/20260925_026_precheck.sql`
- `database/checks/20260925_026_postcheck.sql`

A última migration em `origin/staging` é `20260923_025_extras_unitarios_pizza.sql`. Não há `020`; a sequência usada pelo repositório pula para `021`. Esta entrega usa `026`, datada de 25/09/2026. Não há tabela `empresas`, `unidades` ou `perfil_empresa_*` na base. `unidade_cobranca` é coluna comercial, não esta unidade.

Nomes físicos: `perfil_empresas`, `perfil_unidades`, `perfil_empresa_concessoes`. Capacidades de linha: `PERFIL_CONSULTAR`, `PERFIL_EDITAR_RASCUNHO`, `PERFIL_APLICAR`, `PERFIL_ADMINISTRAR_CONCESSOES`.

## O que a estrutura faz

Três tabelas nascem vazias. A unidade referencia a empresa. A concessão referencia a empresa e o usuário, além de quem concedeu e quem revogou. As FKs usam `ON DELETE RESTRICT` e `ON UPDATE RESTRICT`. O índice único parcial é `(empresa_id, usuario_id, capacidade) WHERE revogado_em IS NULL`. Os `CHECK`s olham só a própria linha: lista de capacidades, motivo, referência da autorização e a revogação.

Correção posterior ao commit `820157a`: no ramo em que `revogado_por` e `revogado_em` estão preenchidos, o `CHECK` exige `motivo_revogacao IS NOT NULL` e texto com pelo menos três caracteres. A alternativa dos três campos nulos permanece. Só `length(btrim(motivo_revogacao)) >= 3` não basta: `btrim` de nulo produz nulo, a comparação fica desconhecida e o `CHECK` aceita o resultado.

Não há índice de singleton. Não há `INSERT`, seed, concessão, revisão cadastral, BYTEA, trigger de autorização, API ou UI. `usuarios_administrativos` não é alterado. A imutabilidade do código estável não tem trigger nesta etapa.

## Postcheck inicial

`database/checks/20260925_026_postcheck.sql`, e o bloco no fim da migration, conferem zero linhas só na instalação. Depois que o provisionamento criar a empresa, a unidade e as concessões, essa verificação deixa de valer. Reexecutá-la falharia de propósito e não seria regressão. A conferência posterior é outra e não faz parte deste arquivo.

O postcheck também pede, no schema `public`, as colunas essenciais, as três chaves primárias em `id`, as cinco FKs com tabela e coluna de referência e ações `RESTRICT` (`confdeltype` e `confupdtype` iguais a `r`), os seis `CHECK`s esperados — inclusive `motivo_revogacao IS NOT NULL` no de revogação — e o índice único parcial `perfil_empresa_concessao_ativa_uk` válido na tabela `perfil_empresa_concessoes`, nas colunas `empresa_id`, `usuario_id` e `capacidade`, com predicado `(revogado_em IS NULL)`. Precheck e postcheck qualificam as relações com `public`.

## Limites registrados

1. Nenhuma concessão poderá ocorrer antes da implementação das proteções nos serviços de usuários. Na branch `feat/v1-perfil-empresa-autorizacao`, `desativarUsuarioAdministrativo` e o `atualizar` de `scripts/admin-provision.cjs` passam a usar a trava por empresa e a recusar a última administradora elegível. Esta migration continua sem execução e não deve ser seguida de `INSERT` em `perfil_empresa_concessoes`.
2. O provisionamento precisará de trava estável antes da criação da primeira empresa. Esta migration não cria a empresa, não escolhe conta e não instala essa trava.
3. As permissões atuais de preços permanecem como estão. Publicar a tabela continua exigindo `REPRESENTANTE_AUTORIZADO` em `app/api/admin/configuracoes/tabela-pacotes/route.ts`. Isso não concede o Perfil da Empresa.
4. Análise estática não comprova execução ou concorrência em PostgreSQL. O teste que lê os arquivos não abre conexão e não prova FK, índice parcial, forma devolvida por `pg_get_constraintdef` nem corrida entre sessões. A cobertura que recusa omitir `motivo_revogacao IS NOT NULL` só olha o texto da migration. Ela não substitui o teste futuro no PostgreSQL, que ainda precisa mostrar a rejeição de uma revogação preenchida sem motivo e a aceitação dos três campos nulos.
