# Fase 1D-A — desenho da migration SaaS Foundation 020

Status: **DDL estático em revisão**, sem execução, aplicação ou bootstrap. Base: `saas/foundation` em `7c9556de2457c1682220390ea16fe462d4357167`. O baseline V1 pós-019 continua com 63 tabelas, sem ledger e sem RLS. Esta é uma divisão inicial da S1 do [plano de slices](schema/SAAS-MIGRATION-SLICES.md), não a implementação de toda a S1.

Fontes normativas: [ADRs 001–010](adr/README.md), [ownership V1](OWNERSHIP-V1-63.md), [mapa D12a](SAAS-CONFIG-AUTHORITY-MAP.md), [invariantes e gates](SAAS-VALIDACAO-E-GATES.md), [pacote 1C congelado](schema/README.md) e [baseline pós-019](../baseline/V1-POST-019.md) com seu [manifesto](../../database/baseline/v1-post-019.manifest.json). A direção D01/D02/D06/D07 é preservada; D03 e D10 permanecem MUST_DECIDE_BEFORE_FIRST_TENANT. Nenhum teste físico ou checagem de catálogo foi executado nesta fase.

## Fronteira e ordem

Criar exatamente quatro tabelas novas e vazias, nesta ordem: `empresas`, `estabelecimentos`, `memberships`, `membership_estabelecimentos`. O candidato `empresa_memberships` da solicitação foi refinado para o nome físico `memberships` já usado no [blueprint 1C congelado](schema/SAAS-SCHEMA-BLUEPRINT.md) e nas FKs futuras da matriz. É o mesmo vínculo usuário–empresa, sem mudança de ownership ou semântica. Não acrescentar `empresa_id`/`estabelecimento_id` a nenhuma das 63 tabelas V1. A FK da nova membership apenas *referencia* a PK existente de `usuarios_administrativos`; não altera essa tabela nem torna sua identidade tenant-owned.

`autorizacao_acoes`, permissões de ação, eventos de auditoria e demais entidades do blueprint 1C ficam para slices próprias. O vínculo à unidade **não** é uma permissão de ação. Não criar coluna `papel` que interprete `usuarios_administrativos.papel` como autorização SaaS. Não criar roles, policies RLS, função de descoberta, grants de runtime, seeds, empresa/unidade Kidmais, memberships ou concessões. As quatro relações permanecem sem uso operacional até canal de auditoria, autorização/delegação e privilégios controlados serem implementados e ensaiados em slice futura. A fundação isoladamente não libera nem o segundo tenant nem um reader SaaS.

## Tipos e colunas

IDs técnicos usam `uuid DEFAULT gen_random_uuid()`: [001](../../database/migrations/20260907_001_crm_extensions.sql) instala `pgcrypto`, e [013](../../database/migrations/20260909_013_autenticacao_contrato.sql) já usa esse padrão de PK. Nenhuma PK/empresa/unidade recebe valor fixo Kidmais. Instantes usam `timestamptz`, com `criado_em`/`atualizado_em DEFAULT now()` como na V1. `vigente_desde` é explícito para vínculo/concessão; nenhum `status` tem DEFAULT que ative acesso. `id`, `codigo` e relações de ownership são imutáveis depois da inserção.

| Tabela | Coluna | Tipo / nulabilidade / default | Semântica |
| --- | --- | --- | --- |
| empresas | id | uuid PK NN, `gen_random_uuid()` | Identidade interna estável |
| empresas | codigo | text NN | Identificador público estável, único na plataforma; nunca credencial |
| empresas | nome | text NN | Nome de apresentação, mutável sem reinterpretar histórico |
| empresas | status | text NN | PROVISIONAMENTO, ATIVA, SUSPENSA ou DESATIVADA |
| empresas | criado_em, atualizado_em | timestamptz NN, `now()` | Instantes de criação/última alteração |
| empresas | desativado_em | timestamptz NULL | Preenchido somente na desativação |
| estabelecimentos | id | uuid PK NN, `gen_random_uuid()` | Identidade interna estável |
| estabelecimentos | empresa_id | uuid NN | Empresa proprietária única e imutável |
| estabelecimentos | codigo, nome | text NN | Código local à empresa; nome de apresentação |
| estabelecimentos | status | text NN | ATIVO, SUSPENSO ou DESATIVADO |
| estabelecimentos | criado_em, atualizado_em | timestamptz NN, `now()` | Instantes de criação/última alteração |
| estabelecimentos | desativado_em | timestamptz NULL | Preenchido somente na desativação |
| memberships | id | uuid PK NN, `gen_random_uuid()` | Identidade durável da relação usuário–empresa |
| memberships | empresa_id, usuario_id | uuid NN, cada um | Empresa do vínculo e identidade global existente |
| memberships | status | text NN | PENDENTE, ATIVA, SUSPENSA ou REVOGADA |
| memberships | vigente_desde | timestamptz NN, explícito | Início de elegibilidade, sujeito a status |
| memberships | vigente_ate, revogado_em | timestamptz NULL | Término programado e revogação explícita |
| memberships | criado_em, atualizado_em | timestamptz NN, `now()` | Instantes do vínculo |
| memberships | revisao | bigint NN, `1` | Versão positiva da autorização; não resolve D10 |
| membership_estabelecimentos | id | uuid PK NN, `gen_random_uuid()` | Identidade durável da concessão à unidade |
| membership_estabelecimentos | empresa_id, estabelecimento_id, membership_id | uuid NN, cada um | Escopo e dois pais que devem concordar em empresa |
| membership_estabelecimentos | status | text NN | ATIVA, SUSPENSA ou REVOGADA |
| membership_estabelecimentos | vigente_desde | timestamptz NN, explícito | Início de elegibilidade, não ação autorizada |
| membership_estabelecimentos | vigente_ate, revogado_em | timestamptz NULL | Término e revogação |
| membership_estabelecimentos | criado_em, atualizado_em | timestamptz NN, `now()` | Instantes da concessão |

Não acrescentar plano, faturamento, CNPJ, endereço, contato, marca, configuração comercial ou segredo às quatro tabelas. `razao_social` e `identificador_fiscal`, opcionais no blueprint 1C, não são necessários para a integridade desta slice; podem ser acrescentados depois sem atribuição automática. Não criar identidade global opcional de clientes (D11b).

## Chaves, checks e índices

| Tabela | Integridade obrigatória | Índices necessários na 020 |
| --- | --- | --- |
| empresas | PK(id); UNIQUE(codigo) global | PK e UNIQUE já cobrem os acessos desta slice |
| estabelecimentos | PK(id); FK(empresa_id)→empresas(id) ON UPDATE RESTRICT ON DELETE RESTRICT; UNIQUE(empresa_id,id) para futuras FKs; UNIQUE(empresa_id,codigo) | Índices implícitos de PK e uniques; índice de FK `empresa_id` já coberto pelo prefixo dos dois uniques |
| memberships | PK(id); FK(empresa_id)→empresas(id); FK(usuario_id)→usuarios_administrativos(id); UNIQUE(empresa_id,id); UNIQUE(empresa_id,usuario_id); UNIQUE(empresa_id,id,usuario_id) para futuro onboarding | Índice `(usuario_id,empresa_id,status)`, conforme o blueprint 1C congelado; os uniques cobrem FK/lookup por empresa. Não criar variante `(usuario_id,status,empresa_id)` |
| membership_estabelecimentos | PK(id); FK(empresa_id,membership_id)→memberships(empresa_id,id); FK(empresa_id,estabelecimento_id)→estabelecimentos(empresa_id,id); UNIQUE(empresa_id,estabelecimento_id,membership_id); UNIQUE(empresa_id,estabelecimento_id,id) para referências futuras | Índice `(empresa_id,membership_id,estabelecimento_id)` para FK/lookup da membership; UNIQUE com prefixo `(empresa_id,estabelecimento_id)` cobre a outra FK |

Todas as FKs acima são obrigatórias, com todas as colunas NN e `ON UPDATE RESTRICT ON DELETE RESTRICT`, sem cascata. A dupla FK composta do último registro é a prova de mesmo tenant: se membership pertence a A e unidade a B, nenhum único `empresa_id` satisfaz ambas. Vale em INSERT e UPDATE; FK simples a dois UUIDs não oferece essa propriedade. `UNIQUE(empresa_id,id)` é redundante como unicidade lógica perante a PK global, mas necessário como alvo nominal de FK composta. `UNIQUE(empresa_id,id,usuario_id)` prepara a referência tipada do onboarding futuro. O mesmo usuário pode ter uma membership em A e outra em B; não criar UNIQUE global de `usuario_id`.

Usar nomes determinísticos da família `saas020_<tabela>_<objetivo>_{fk,uk,ck,idx,trg}` (abreviar sem colisão de 63 bytes). O precheck deve reservar o conjunto final explícito de nomes revisado com o DDL, inclusive cinco funções candidatas `saas020_guard_empresas`, `saas020_guard_estabelecimentos`, `saas020_guard_memberships`, `saas020_guard_membership_estabelecimentos` e `saas020_bloquear_truncate`. Os quatro guards de linha e os quatro triggers `BEFORE TRUNCATE` são parte da 020; nenhuma função/trigger V1 é substituída.

Checks declarativos:

- `codigo` de empresa/unidade em forma canônica ASCII minúscula, 3–64 caracteres, inicial letra, restante letras/dígitos/hífen e final alfanumérico; UNIQUE direto é suficiente sem índice de expressão ou collation dependente de locale. `nome` após trim não é vazio e tem até 160 caracteres. Código não é reutilizado após desativação.
- `status` em cada conjunto fechado acima; `desativado_em IS NOT NULL` **se e somente se** o status é DESATIVADA/DESATIVADO; quando presente, instante não anterior a `criado_em`.
- Para memberships/grants, `vigente_ate` quando presente é posterior a `vigente_desde`; `revogado_em` quando presente não antecede `criado_em`, mas **pode anteceder `vigente_desde` futuro** para cancelar concessão programada antes de começar. `status = REVOGADA` **se e somente se** `revogado_em IS NOT NULL`; `revisao > 0` na membership. ATIVA com vigência ainda não iniciada ou já vencida não autoriza: o predicado futuro exige status e relógio.
- `atualizado_em >= criado_em`. Geração/atualização do instante deve ser feita pelo guard da própria nova tabela; nenhum cliente pode reescrever autoria de criação para contornar checks. `desativado_em` e `revogado_em` iniciam nulos. Ao entrar em DESATIVADA/DESATIVADO, o guard atribui `desativado_em`; ao entrar em REVOGADA, atribui `revogado_em`. Em ambos, usa o relógio do banco (`clock_timestamp()`) e recusa timestamp proposto pelo caller ou alteração posterior desse instante.

FK/UNIQUE/CHECK não tornam PK, código, `empresa_id`, `usuario_id`, `membership_id` ou `estabelecimento_id` imutáveis quando uma linha ainda não tem filhos. A 020 deve instalar guards `BEFORE INSERT OR UPDATE OR DELETE` nas quatro tabelas: INSERT só admite estado não operacional inicial (`PROVISIONAMENTO`, `SUSPENSO`, `PENDENTE`, `SUSPENSA`, respectivamente); DELETE sempre recusado; UPDATE não muda identidade/ownership/código/`criado_em` e atualiza `atualizado_em`. Um guard `BEFORE TRUNCATE` em cada tabela recusa a via que ignora trigger por linha. Os guards são invoker, usam nomes de objetos qualificados, sem SQL dinâmico e sem EXECUTE para runtime/PUBLIC; não são função de autorização nem dispensam ACL/RLS futuros.

Transições permitidas pela 020: empresa `PROVISIONAMENTO→DESATIVADA`, `ATIVA→SUSPENSA/DESATIVADA`, `SUSPENSA→DESATIVADA`; unidade `ATIVO→SUSPENSO/DESATIVADO`, `SUSPENSO→DESATIVADO`; membership `PENDENTE→REVOGADA`, `ATIVA→SUSPENSA/REVOGADA`, `SUSPENSA→REVOGADA`; grant `ATIVA→SUSPENSA/REVOGADA`, `SUSPENSA→REVOGADA`. Essas listas incluem caminhos de estados futuros, mas **nenhuma linha criada pela 020 alcança ATIVA/ATIVO**: não há ativação inicial nesta slice. Estado terminal desativado/revogado não retorna a ativo na 020. Atualização sem troca de status só pode ajustar vigência para restringir, nunca ampliar; na revogação/desativação, o guard atribui o timestamp do banco no instante da transição, que pode anteceder `vigente_desde` futuro no caso de revogação. O guard de membership calcula `revisao = OLD.revisao + 1` em qualquer alteração de status/vigência/revogação, rejeita revisão enviada pelo caller e verifica overflow; não o usa para decidir D10. A **ativação inicial**, reativação e ampliação exigirão alteração controlada do guard e fluxo futuro auditado/delegado com revisão explícita de grants filhos, preservando a mesma linha durável e histórico de eventos. Nenhuma dessas transições é executada agora; a 020 permanece vazia e sem DML de runtime.

## Lifecycle e acesso futuro

- Empresa: PROVISIONAMENTO ainda não opera; ATIVA somente após gate de ativação; SUSPENSA nega novas operações; DESATIVADA mantém código, vínculo e história. Nenhum estado altera a empresa de uma unidade.
- Unidade: ATIVO só dentro de empresa autorizada/ativa; SUSPENSO/DESATIVADO não concedem acesso; criar A2 não produz concessão para A2.
- Membership: PENDENTE não concede, ATIVA é condição necessária, SUSPENSA/REVOGADA negam novas operações. Usuário global também precisa estar ativo; login e `papel` V1 não conferem escopo. Uma única linha `(empresa_id,usuario_id)` perdura; reativação futura usa evento auditado e revisão sem recriar autoria.
- Grant de unidade: vínculo explícito A→A1 ou A→A2. ATIVA é apenas condição de unidade, não permissão para uma ação. Acesso futuro requer também membership/empresa/unidade ativas, vigência, ação e contexto confiáveis, revalidados conforme ADR-002/003. D03 não permite wildcard nem unidades futuras implícitas. D10 continua em aberto para ordenação revogação/commit.

Até existirem canal de auditoria, concessão de ações, delegação controlada e consumidores tenant-aware, nenhuma role de tráfego pode receber SELECT/DML nas novas relações. Não expor descoberta global temporária. Todas as quatro são candidatas a RLS de control plane numa slice posterior; a superfície de descoberta deve consultar apenas vínculos do principal autenticado, com ACL/owner restritos e sem circularidade. Esta migration não cria policy, `ENABLE/FORCE RLS` ou tenant context.

## Precheck futuro, sem ledger fictício

Antes da 020, no ambiente **separadamente autorizado**, exigir:

1. `server_version_num` de `180006` a `189999` (mesmo major 18 e não anterior à referência 18.6), funções/extensões requeridas por UUID disponíveis; não usar `IF NOT EXISTS` para ocultar estado parcial. Revisar essa janela se a política de versão do ambiente futuro mudar; esta fase não consultou servidor.
2. Linhagem versionada 001–019 do [manifesto](../../database/baseline/v1-post-019.manifest.json), inclusive 006+006a composta e objetos finais de 019; catálogo público V1 esperado de 63 tabelas, funções/índices/constraints críticos e `usuarios_administrativos.id uuid` PK íntegros. Sem ledger, declarar equivalência estrutural delimitada, nunca identidade byte a byte do SQL historicamente aplicado. Diferenças de owner/ACL da referência descartável não são baseline de produção.
3. Nenhuma das quatro tabelas, nomes de constraints/índices, funções/guards/triggers 020 ou outra migration 020 presente. Recusar objetos parciais/colisão e estado desconhecido.
4. Decisão 1D-B1-R1: como não existe nome de role canônica de owner provisionado/versionado para a 020, o próprio executor autorizado da migration conserva ownership nesta slice schema-only. Ele não pode ser role runtime/worker nem ser assumível por elas. Exigir inventário explícito dessas roles, conferir seus privilégios efetivos e default privileges do executor **antes** do CREATE; abortar se não houver caminho transacional seguro para impedir acesso de runtime/PUBLIC. Não criar role, não copiar roles B5B e não usar `postgres` como modelo de runtime. O ownership nominal e a completude do inventário de roles são gates ambientais da B2; a direção de owner sem login separado do ADR-010 permanece para slices futuras.
5. Janela/lock_timeout/statement_timeout e caminho transacional ensaiados em ambiente isolado: criação de FK para `usuarios_administrativos` pode tomar lock mesmo sem dados novos. Não prometer zero downtime.

## Postcheck futuro

Na mesma transação da criação, manter o executor autorizado como owner das quatro tabelas, índices subordinados e cinco funções, sem `ALTER OWNER` para uma role não decidida. Remover qualquer EXECUTE/ACL que alcance runtime/worker/PUBLIC, especialmente o EXECUTE implícito de funções, **antes do commit**. Nenhuma role de tráfego recebe GRANT na 020. Falha de REVOKE ou da verificação estrutural/de acesso intra-transação reverte toda a 020. Não há janela de publicação parcial de objetos não commitados. Confirmar o owner nominal/segregação no ambiente autorizado B2 antes de executar; migrator-owner desta slice não autoriza runtime a usar sua credencial.

Confirmar exatamente quatro novas tabelas, suas colunas/tipos/NN/defaults, PKs, FKs compostas e ações RESTRICT, uniques, checks, índices, funções/guards/triggers e validade das constraints. Com precheck de 63 tabelas públicas, o total esperado após a 020 é 67. Conferir owner e privilégios **efetivos**, inclusive herança de roles/default privileges: runtime/worker/PUBLIC sem leitura/escrita/DDL/TRUNCATE/assunção de owner/migrator; `relacl NULL` não prova negação. Confirmar quatro tabelas com zero linhas, zero seeds, zero policies/RLS e nenhuma função de descoberta/grant de ação. Comparar projeção dos 63 objetos V1 com o snapshot imediatamente anterior, sem alteração de estrutura ou linhas; a **única nova dependência inbound intencional** é a FK da nova `memberships.usuario_id` para `usuarios_administrativos.id`, que deve ser allowlisted quando o inventário inclui `pg_depend`/referências de constraints. Não exigir que o fingerprint total incluindo owners da referência descartável seja idêntico ao ambiente. Falha em qualquer resultado impede aceitação.

## Rollback e recuperação

Rollback estrutural posterior, nunca automático: confirmar operacionalmente que nenhum build/fluxo consumidor depende da 020, pois o catálogo não prova isso. Iniciar transação, adquirir locks exclusivos nas quatro tabelas em ordem determinística filhos→pais e mantê-los até o fim; então testar emptiness, dependências e definições sob os locks, para não haver corrida entre precheck e DROP. Recusar se qualquer tabela tiver linha, existir FK/view/trigger/função externa, schema consumidor, policy, grant novo ou outra slice dependente, ou se definições diferirem das instaladas pela 020. Não usar `CASCADE`, DELETE, TRUNCATE ou desabilitar guards para “limpar”. Com pré-condições satisfeitas, remover apenas objetos da 020 em ordem filhos→pais e funções/índices remanescentes, na mesma transação, seguido de postcheck que preserve intactas as 63 tabelas V1. Se dados/dependências já existirem, manter schema e fazer correção compatível/forward-fix. A 020 vazia permite reversão; nenhuma garantia de rollback destrutivo após bootstrap.

## Plano de testes da implementação futura

Em PostgreSQL 18 descartável, com dados **sintéticos** e role de teste não-owner explicitamente autorizada: A/B; A1 em A e B1 em B; usuário U com membership em A e B. Inserir vínculo estrutural A→A1 no estado inicial SUSPENSA deve passar; isso **não comprova um grant efetivo**. A→B1 deve falhar **pelo banco**, em INSERT e UPDATE, inclusive tentativa com NULL parcial. Código de unidade igual em A/B deve passar; duplicata em A e código de empresa global duplicado devem falhar. Membership duplicada em A deve falhar mesmo revogada; A/B para o mesmo usuário deve passar. Testar status/datas/revisão inválidos, ativação indevida no INSERT ou UPDATE a partir dos estados iniciais, timestamp de revogação/desativação enviado pelo caller, ampliação de vigência no UPDATE, revogação antes de `vigente_desde` futuro, transição de identidade/ownership/código, DELETE de folha, TRUNCATE, criação de A2 sem vínculo e ausência de reativação implícita. Repetir com role runtime sem privilégios: qualquer acesso deve falhar; verificar grants/owner herdados, funções e default privileges. Conferir quatro tabelas vazias antes de fixtures, 63 V1 inalteradas e nenhuma policy/RLS após migration; rollback limpo passa e com uma linha/dependência falha. Testes de contexto, RBAC completo, concorrência D10, D03, G-P/G-M/G-X e paridade D12b pertencem às slices correspondentes, não são resultados desta 020.

## Número, arquivos futuros e riscos

O próximo identificador lógico é **020** depois de 019; 006a já pertence à cadeia legada. Convenção proposta: `YYYYMMDD_020_saas_foundation`, mantendo pasta histórica e deixando a finalidade SaaS explícita. Se implementada com a data deste desenho, arquivos candidatos:

- `database/migrations/20260923_020_saas_foundation.sql`;
- `database/checks/20260923_020_saas_foundation_precheck.sql`;
- `database/checks/20260923_020_saas_foundation_postcheck.sql`;
- `database/rollback/20260923_020_saas_foundation_down.sql`;
- `scripts/saas-foundation-020.test.cjs` (teste estático offline; fixtures sintéticas e teste físico somente na B2 autorizada).

Esses nomes foram adotados na implementação estática 1D-B1; nenhum artefato foi executado nesta fase. O número lógico 020 é estável. A 020 depende do baseline pós-019, da identidade global 013 e do UUID de 001. D12c exige confirmação ambiental do executor-owner, segregação e ACL antes da B2; D03/D10 não bloqueiam criação vazia, mas bloqueiam prova final de autorização/segundo tenant. OPEN_1C-02 (P/M) e OPEN_1C-03 (X) não são exercitados por esta slice. D12b/K10 segue P0 para rollout, sem efeito sobre o DDL vazio.

Riscos: P0 grant cross-company, owner/runtime privilegiado ou ativação antes de RBAC/RLS; P1 reparenting/DELETE sem guard, reativação de grant antigo, rollback após uso e locks na FK para usuário V1; P2 índices extras e custo de descoberta futura. Mitigar com dupla FK, guards/ACL, gate de uso, ensaio e recusa de rollback. Nenhum risco é declarado resolvido por apenas escrever a migration.
