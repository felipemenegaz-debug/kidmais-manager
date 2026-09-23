# Fundação SaaS — evidência, invariantes e gates

Status: 1B-C2, D11c CLOSED e D12a CLOSED; decisões e pendências no [índice dos ADRs](adr/README.md). Nenhum BLOCKER_1C novo identificado; pacote aguarda revisão/aprovação, sem autorização de iniciar 1C. Testes abaixo são requisitos futuros, não resultados executados.

## Evidência do baseline e limites da análise

Ponto de partida: branch saas/foundation, HEAD congelado 78b07033719d4cc1c391ca677165704cc2925a48; harness 63c7383b3582e4c533d41d1893a0258a59743eae. Inventário de referência: 63 tabelas, 862 colunas, 1261 constraints, 288 índices, 828 triggers, 107 funções, duas sequences e três extensões. Fingerprint: 3b1066bc2bd546d589347561356490aaa19158026f31ea8893fd6c0db32d596e. Fontes: [manifesto](../../database/baseline/v1-post-019.manifest.json), [schema esperado](../../scripts/sanitize-v1-post-019/expected-schema.json), [baseline congelado](../baseline/V1-POST-019.md).

Isso é evidência versionada da referência, não inspeção nova de banco. Não há ledger de migrations nem RLS no baseline. 006+006a são linhagem legada composta; 019 tem equivalência física documentada, sem prova byte a byte do artefato historicamente aplicado. A política de nove catálogos preservados no [sanitizador](../baseline/V1-POST-019-SANITIZATION.md) não torna esses dados globais SaaS. Certificação com operação vazia não prova segurança de backfill de contratos/pagamentos/festas ocupados.

### Achados estáticos relevantes

| Evidência | Estado observado no código versionado | Implicação futura |
| --- | --- | --- |
| [Pool e transações](../../lib/db/postgres.ts) | Conexão reservada por transação, sem tenant context SaaS | Propagar contexto validado na mesma conexão; testar reutilização |
| [Autenticação](../../lib/autenticacao/service.ts) e [guard HTTP](../../lib/http/admin-crm-api.ts) | Sessão, usuário ativo, origem/CSRF e papéis V1; sem empresa/unidade | Autenticação existe; acrescentar membership e escopo, não descrevê-la como ausente |
| [CRM repository](../../lib/clientes/repositories/cliente.repository.ts) | Identificação/busca/merge globais | Escopar todas as consultas e unicidades; evitar correlação de CPF entre empresas |
| [Festas](../../lib/festas/service.ts) | Capacidades verificadas no backend, globais por usuário | Vincular concessões a empresa/unidade sem escalada automática |
| [Auditoria](../../lib/clientes/repositories/auditoria.repository.ts) | JSON de antes/depois sem envelope tenant SaaS | Contexto imutável e política de conteúdo; preservar evidência histórica |
| [Disponibilidade](../../app/api/admin/disponibilidade/route.ts) | Configuração também em arquivo, fora das 63 tabelas | Inventário D12 antes de declarar independência das unidades |
| [Migration 019](../../database/migrations/20260915_019_festa_formalizacao.sql) | Substitui funções da linhagem 014 e mantém invariantes de formalização/ocupação | Preservar invariantes; revisar locks globais, funções e consumidores |
| [Respostas HTTP](../../lib/http/api-response.ts) e [API pagamentos](../../lib/http/pagamentos-api.ts) | Caminhos com log bruto de erro | Revisar redação antes de multitenancy; não é prova de vazamento atual |

A reconciliação de artefatos 017–019 não trouxe automaticamente todo o runtime de staging. Exigir regressão de compatibilidade do runtime efetivamente promovido. Owners/grants da referência descartável não comprovam privilégios de nenhum ambiente operacional.

## Invariantes obrigatórias

- **I01:** toda linha tenant-owned tem empresa válida e inequívoca no estado alvo. Chaves diretas são preferidas; sidecar D08 excepcional exige cobertura obrigatória, integridade, atomicidade, escopo e policies adequadas. Nulabilidade temporária exige gate single-tenant e prazo; nunca autoriza NULL como acesso global.
- **I02:** estabelecimento pertence à mesma empresa da operação.
- **I03:** referências entre entidades tenant-owned não atravessam empresas, inclusive filhos, JSON, blobs e associações polimórficas. Referências à identidade global administrativa não concedem acesso; possível identidade global de cliente futura não compartilha CRM.
- **I04:** operação establishment-owned tem unidade válida da própria empresa; escopo de acesso também limita as unidades autorizadas.
- **I05:** IDs fornecidos pelo cliente não estabelecem autorização; principal/contexto/membership/recurso são verificados.
- **I06:** acesso administrativo a dados tenant-owned deriva de membership válida e permissão para ação/escopo; papel plataforma não concede leitura implícita. CRM único por empresa não é diretório para operadores de unidade: D11c exige vínculo/fluxo legítimo e mínimo necessário; resolução não concede leitura completa nem operações privadas de outra unidade.
- **I07:** jobs e operações de sistema possuem principal de serviço e tenant context explícitos; ausência nega execução.
- **I08:** eventos autorizados preservam empresa/unidade pertinente, ator/principal, origem e correlação. Negação usa contexto legítimo do solicitante e alvo minimizado não verificado, sem buscar/criar evento no tenant alvo. Sem contexto legítimo, canal pré-auth/plataforma separado.
- **I09:** default da empresa + override da unidade têm resolução determinística e identidade/referência/versionamento quando necessário. Mudança de preço/pacote/área/agenda/regra não reinterpreta histórico. Credenciais não são herdadas. Conexão WhatsApp é da empresa; cada associação à unidade valida a mesma empresa, sem 1:1 nem acesso futuro implícito.
- **I10:** segundo tenant somente após testes cross-tenant aprovados, evidência de defesa de banco e aprovação explícita de G4.

Preservar também PDFs, assinaturas, snapshots, hashes e fatos contratuais históricos. Backfill de metadados não autoriza reescrever esses conteúdos.

## Estratégia de testes futuros

Fixture exclusivamente sintética: empresas A/B; unidades A1/A2/B1; usuários com membership A, B, ambas, revogada e nenhuma; operadores por unidade e principal de job. Usar IDs reais da fixture de B em requisições autenticadas em A, além de IDs inválidos. Rodar API/serviço/repository/banco com role runtime real não-owner, incluindo pool compartilhado e concorrência.

| ID | Cenário | Evidência mínima de aprovação |
| --- | --- | --- |
| T01 | A não lê B | Listas, detalhes, busca, contagens, relatórios e exports não expõem linhas/PII/metadados de B |
| T02 | A não altera B | Mutação direta, batch, upsert, merge, cancelamento e filhos negados; estado de B inalterado |
| T03 | IDs válidos de outro tenant | UUIDs em path/body/query/JSON não ampliam escopo; idempotency keys e unicidades não colidem indevidamente |
| T04 | Unidade B1 na operação A | API nega; constraint rejeita bypass pela camada de dados; relações A1/A2 seguem regra explícita |
| T05 | Revogação/desativação/redução de grants | Novas operações negadas; caches/tokens não preservam acesso; corrida revogar/commit segue D10 |
| T06 | Uma/várias/todas as unidades | Só unidades concedidas; delegação sem escalada; nova unidade segue D03 |
| T07 | Jobs | Sem contexto, principal ou autorização falham fechado; retries/DLQ não trocam tenant |
| T08 | Bootstrap/RLS/contexto/pool | Descoberta mínima do principal/prova sem acesso operacional; sem contexto nega operação; conexão A→B, erro/rollback e reuso não carregam A; role real e funções respeitam políticas |
| T09 | APIs públicas e integrações | OTP/capability/PDF vinculados a finalidade/empresa/unidade/recurso na emissão e consumo; webhook autenticado; conexão empresa com uma/várias associações, zero cross-company, sem escolha arbitrária de unidade; OAuth/state sem troca/replay |
| T10 | Cache/export/arquivo | Chaves e storage isolados; link conhecido não autoriza; expiração/revogação conforme política |
| T11 | Integridade e privilégios | FKs/uniques/composite NULL testados; runtime não executa DDL/TRUNCATE/SET ROLE privilegiado; índices suportam queries reais |
| T12 | Auditoria e canais de erro | Sucesso com recurso autorizado; negação A→B versus ID inexistente sem descoberta privilegiada/diferença acessível a A; sem contexto usa canal separado; canários ausentes; negação não perdida no rollback |
| T13 | Configuração | Default/override/ausência/null válidos e referências efetivas íntegras; mudança de preço/pacote/área/agenda/regra não reinterpreta operação antiga, inclusive tarefa/pendência Festa após troca/retirada de override |
| T14 | Backfill ocupado | Uma empresa/unidade inicial; preservar IDs seguros, vínculos, autoria, valores, PDFs/hashes e invariantes 014/019; zero órfãos/escopos obrigatórios ausentes; sidecar excepcional com cobertura/atomicidade provadas; efêmeros sem palpite; interrupção/reexecução seguras |
| T15 | Regressão V1/rollout | Fluxos V1 preservados; grants Festa mapeados explicitamente; retirar/drain writers antigos, reconciliar, impedir novos registros obrigatórios sem escopo e remover reader global/tenant NULL antes de segundo tenant; rollback não amplia acesso |
| T16 | CRM empresarial com escopo de unidade D11c | Principal empresarial só age conforme permissão; operador A1 não descobre arbitrariamente cliente exclusivo de A2 por ID/CPF/telefone/e-mail; fluxo iniciado pelo titular ou fundamento operacional comprovado resolve o mesmo CRM, reutiliza só campos necessários/autorizados e cria relação A1 sem duplicação; nenhuma leitura retroativa de contratos/pagamentos/festas/fechamentos/histórico privado de A2; APIs resolução/CRM/operação distintas; tentativa sem fundamento, forjada ou repetida não enumera; auditoria minimizada e escopada |

Erros de autorização/constraint não devem revelar existência de registro de outra empresa. Testar mensagens e métricas acessíveis ao usuário, não somente ausência de linhas. “Zero resultados” isolado não comprova integridade nem ausência de escrita indireta.

## Gates e rollback

| Gate | Condição | Limite de avanço / rollback conceitual |
| --- | --- | --- |
| G0 — projeto | D11c/D12a CLOSED; matriz e inventário revisados, sem novo BLOCKER_1C | Entregáveis documentais preparados para aprovação do usuário; desenho 1C exige autorização separada, sem execução |
| G1 — isolado | Schema proposto, contexto, permissões e configuração exercitados com dados sintéticos | Falha descarta/reconstrói somente ambiente autorizado; sem impacto V1 |
| G2 — Kidmais única | Uma empresa/unidade inicial; D12b ensaiado, backfill verificável e regressão V1 | Sem segundo tenant; compatibilidade NULL exclusivamente transitória; retirar writers antigos e reconciliar antes de endurecer; rollback compatível preserva evidências |
| G3 — prova de isolamento | A/B e A1/A2/B1 em laboratório; T01–T16 pertinentes, roles/FKs/RLS no modelo compartilhado; D12c provisionado para prova; provas finais T05/T06 usam D10/D03 fechadas | Falha bloqueia onboarding; nenhuma leitura global V1/compatibilidade tenant NULL; constraints finais e escopo obrigatório completos |
| G4 — ativação autorizada | D03/D10 fechadas, D12b/D12c comprovadas, G3 aprovado, recuperação ensaiada e aprovação explícita | Backend bloqueia criação/ativação da segunda empresa operacional até aprovação. Após abertura, somente rollback tenant-aware/forward-fix; suspender tráfego se necessário |

Antes do backfill: contagens, atribuição de roots/filhos, órfãos e proteção de imutáveis. Depois: mesma população esperada, valores e evidências preservados, zero vínculos cruzados e configuração efetiva Kidmais equivalente. D03/D10 não são fechadas automaticamente por este checklist. Ensaios anteriores ao fechamento dessas decisões são provisórios: mudança de semântica invalida resultados afetados e exige repetição antes do aceite final G3/G4. Tenants sintéticos isolados de G3 não são onboarding externo. Validação de constraints/índices e custos de locks será planejada antes de janelas de rollout; nenhuma dessas ações está autorizada nesta fase.

## Riscos priorizados

São riscos de introduzir SaaS, não alegações de exploração comprovada na V1.

| Prioridade | Risco | Mitigação/gate |
| --- | --- | --- |
| P0 | Segundo tenant com queries/papéis globais; FK/filho cruzado; RLS bypass; contexto residual; capability/OTP sem vínculo | I01–I10; T01–T11; bloquear G4 |
| P0 | Runtime assina contrato sem produtor automático de Festa localizado, mas 019 exige Festa ativa e sua criação exige formalização | Conflito estático K10 no mapa D12a; bloqueia rollout até reconciliação/prova D12b, não nova decisão estrutural de produto |
| P1 | Operador de unidade enumera CRM empresarial ou resolução libera operações de outra unidade; área mutável reinterpreta tarefa antiga | D11c/T16 e D04/T13; inventário não é prova de isolamento |
| P1 | Backfill ocupado não coberto pela operação vazia; sidecar incompleto; atribuição indevida de efêmeros ou reescrita de prova | D07/D08; T14/T15; cardinalidade inicial aprovada não dispensa reconciliação |
| P1 | CPF/catálogos globais; herança ambígua; credenciais WhatsApp compartilhadas implicitamente | D04/D05/D11; T03/T09/T13 |
| P1 | Revogação concorrente; função/trigger sem tenant; locks de ocupação globais; erro/log com conteúdo sensível | D06/D10; T05/T08/T12/T15 |
| P1 | Fontes fora do banco omitidas; runtime não alinhado a 017–019; ACLs presumidas do descartável | D12a/b/c; inventário, compatibilidade e provisionamento têm gates diferentes |
| P2 | Crescimento de índices/RLS, contenção e custo de relatórios consolidados | Medir planos e carga sintética; orçamento de performance na 1C |
| P2 | Retenção/suporte, drift documental e fixture com datas fixas | D09; testes com relógio controlado e revisão periódica |

## D12a — inventário estrutural estático

**CLOSED na 1B-C2.** O [mapa estrutural completo](SAAS-CONFIG-AUTHORITY-MAP.md) substitui o levantamento preliminar: C01–C12 comercial/agenda/buffet; F01–F11 contratação/financeiro/Festa; S01–S14 identidade/integrações/plataforma. Cada linha identifica fonte→transformação→consumidor→efeito, autoridade atual/futura, escopo/versão, riscos e impactos. Inclui fontes auxiliares, histórico efetivamente preservado, hardcodes e conflitos K01–K10.

Explorer, migration-reviewer e tenant-security-reviewer contribuíram e revisaram estaticamente. Nenhum código de aplicação, banco, ambiente/secrets ou SQL foi executado. Completude estrutural não prova estado efetivo de ambiente externo. Não surgiu nova escolha humana BLOCKER_1C: precedência SaaS, isolamento, histórico e visibilidade já são delimitados por D04/D05/D06/D08/D11c. Incompatibilidades mapeadas não foram corrigidas nem consideradas aprovadas; exigem reconciliação e prova D12b antes do rollout, especialmente K10. Representação física permanece para a 1C autorizada separadamente.

## D12b / D12c e pendências de aprovação

D12b tem direção aprovada, mas não prova executada: compatibilidade nullable apenas single-tenant; escritores antigos retirados/drenados, reconciliação final, recusa de ausência de escopo obrigatório, constraints finais e reader global removido antes do segundo tenant. RLS fail-closed não pode ocultar silenciosamente dados ainda não migrados durante a transição; o plano de leitura transitória precisa de testes.

D12c trata provisionamento/rotação/operação e pode evoluir até antes do primeiro tenant externo sem alterar estrutura fundamental. Grants/roles necessários à prova devem existir antes de G3; papéis descartáveis B5B não são modelos de runtime.

D11c CLOSED conforme [política aprovada](adr/ADR-005-OWNERSHIP-DOS-DOMINIOS.md): CRM único empresarial, visibilidade mínima por vínculo/fluxo autorizado, resolução sem diretório e sem acesso retroativo a operações de outra unidade. D11b é CAN_DEFER: identidade global opcional do cliente, sem obrigatoriedade, sem mudança de PK/ownership CRM e sem lookup cross-company; só haverá reutilização futura pelo titular em fluxo próprio autorizado e auditado. D03/D10 continuam MUST_DECIDE_BEFORE_FIRST_TENANT.

## Complemento 1C-B1 — gates de migratabilidade e legado

O [pacote1C](schema/README.md) especifica OPEN_1C-02 como DESIGN_CLOSED_EXECUTION_GATE e OPEN_1C-03 como DESIGN_CLOSED, proposto para aprovação. Não substitui G0–G4, não fecha D03/D10/D12b e não aprova nova tabela ou descarte. [B1](schema/SAAS-LEGACY-SECURITY-DISPOSITION.md) delimita autoridade, retenção e exceção X, separada de M.

| Gate adicional | Momento obrigatório | Evidência futura |
| --- | --- | --- |
| G-P | Antes do primeiro ADD COLUMN S2 que afete H16 | Bytes da projeção histórica/hashes preservados em fixture ocupada |
| G-M | Antes do primeiro backfill protegido S5 ou escrita equivalente anterior | Autorização estreita, igualdade V1, falhas/rollback, guards/ACL restaurados |
| G-X | Antes de qualquer extração/purge/cutover da família em S5-X | Aprovação de exceção/retention/campos/irreversibilidade; produtor e dependências provados; um destino por PK; atomicidade/minimização/revogação/restore ensaiados |
| G-COVERAGE | Antes de S6/NOT NULL final e novamente G3/G4 | Pendentes=0, nenhuma linha obrigatória sem E/U, nenhuma credencial incompatível utilizável, nenhuma cópia indevida em Core ou origem operacional residual |
| G-ACCESS | Antes de publicar Core ou retomar tráfego | Roles/ACL/RLS/rotinas reais, Core sem diretório cross-tenant, D12c e build compatível/D12b |

Casos negativos obrigatórios: auditoria FESTA sem cliente; origem global forjada; OTP consumido/com E sem U/código expirado mas prova válida; callback tardio; consumo concorrente ao corte; retenção ausente/hold; erro entre destino e remoção; retry/commit incerto; restauração de backup anterior; tentativa de buscar pessoa/localizador em Core. Bloqueio/manual review é execução recusada, não atribuição a tenant fictício. X não muda prova contratual nem auditoria tenant por conveniência; campos descartados não têm rollback recuperável por down comum.

## Verificação desta entrega

A revisão presente é estática/documental: cobertura das 63 tabelas, estrutura dos dez ADRs, links, coerência com baseline e diff. Não equivale à execução de T01–T16. Nenhum acesso a banco, execução de migration, implementação de RLS/contexto ou alteração de runtime foi realizado. Reversão deste pacote é apenas documental; não há rollback de banco associado.
