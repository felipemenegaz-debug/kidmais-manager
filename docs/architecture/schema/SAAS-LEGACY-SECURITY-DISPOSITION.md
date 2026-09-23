# Fase 1C-B1 — autoridade e tratamento do legado sem tenant

## Status e decisão técnica

**OPEN_1C-03 = DESIGN_CLOSED — desenho proposto para aprovação antes das migrations.** A B1 resolve a representação/autoridade que faltava na B0, sem afirmar execução ou aprovar automaticamente DDL. A combinação escolhida é: Core nativo para autenticação; histórico derivável permanece tenant-aware; evidência mínima de segurança comprovadamente global usa a entidade já proposta auditoria_seguranca_core; efêmeros elegíveis são revogados e eliminados sob retenção. Registros duráveis ambíguos bloqueiam o lote/cutover.

**OPEN_1C-02 = DESIGN_CLOSED_EXECUTION_GATE.** P/M da [prova B0](SAAS-MIGRATABILITY-PROOF.md) continuam válidos: P deve ser ensaiado antes da primeira expansão S2 que altere linhas H16; M antes do primeiro backfill protegido da família em S5, ou antes de qualquer escrita equivalente antecipada. Não reabrir estrutura por faltar ensaio; contradição demonstrada no ensaio reabre apenas o desenho afetado. Nenhuma prova física foi executada.

A exceção de segregação/retenção **X**, definida aqui, não está autorizada pelo protocolo M nem pelo guard003 atual. É parte explícita desta proposta para aprovação: nenhum DELETE será executado sem aprovação de execução específica, política e ensaio. Preservação de documentos assinados, provas consumidas e histórico empresarial não é relaxada. D03/D10/D12b/D12c e G4 continuam com seus gates próprios.

## 1. Evidência e superfícies reais

Fontes: migrations001–019 e projeção [63 tabelas](../../../scripts/sanitize-v1-post-019/expected-schema.json); [ADR007](../adr/ADR-007-MIGRACAO-KIDMAIS-INICIAL.md), [ADR009](../adr/ADR-009-AUDITORIA-E-IDENTIDADE.md); runtime lido como texto, sem imports/execução. Ausência de registro em arquivo não prova ausência no banco.

| Superfície | Finalidade/lifecycle e vínculos V1 | E/U disponíveis ou deriváveis | Sobrevivência, prova e destino |
| --- | --- | --- | --- |
| validacoes_identidade_cliente | Desafio, recuperação, prova temporária e consumo. cliente_id obrigatório; finalidade/expirações; consumo por fechamento OU versão; assinatura pode referenciar | Não tem E/U físicos. E pelo cliente; U pelo consumidor/recurso/origem comprovada, não pelo cliente sozinho | Consumida/referenciada sobrevive íntegra tenant-owned. Ativa insegura revoga. Não consumida sem referência pode ser eliminada após retenção; retenção individual necessária com U desconhecida = revisão, não Core |
| sessoes_administrativas | Identidade global; hash token/CSRF, expiração, inatividade, revogação; FK usuário. UUID histórico em assinatura/WhatsApp deliberadamente sem FK | Não precisa de E/U de ownership. Membership é outra relação | CORE_SECURITY. Sessão incompatível com nova autorização revoga. Retenção finita; não transportar token/hash para evidência Core. Assinatura antiga não é reautenticada |
| limites_autenticacao | Buckets HMAC de identificador/origem; janela/bloqueio; sem pai tenant | Global de pré-auth, não inferir E de e-mail/IP | CORE_SECURITY transitório; não criar histórico individual de buckets. Eliminação após janela/retencão aprovada sem zerar bloqueio ainda necessário |
| whatsapp_onboarding_tentativas | INICIADA/VALIDANDO e terminais; state_hash, usuário/sessão histórica, conexão opcional; guard018 protege identidade/transições/terminal | E somente por contexto comprovado ou conexão atribuída; usuário/ambiente não bastam. U não é obrigatório para ownership empresarial; candidatos futuros tipados | Ativa sem E invalida e reinicia em contexto novo. Terminal atribuível fica E-owned; terminal não atribuível não vira Core automaticamente. Retenção ou revisão conforme regra |
| whatsapp_conexoes | Configuração/desconexão, IDs externos e credencial cifrada; guard018 impede DELETE e mutação arbitrária | Posse/proveniência comprovam E; associações U são escolha explícita, não deduzidas do criador | TENANT_OPERATIONAL quando comprovada. Sem posse/origem: desabilitar uso e MANUAL_REVIEW; não arquivar ciphertext em Core. Nenhum emissor/consumidor dessas tabelas localizado em app/lib |
| auditoria | Append-only003; cliente opcional, entidade polimórfica, JSON/IP/UA/autoria | Core comprovável por produtor de autenticação global; empresarial por cliente OU recurso (inclui Festa sem cliente_id) | Classificar por evento. Tenant derivável permanece nesta autoridade. Somente segurança global comprovada e minimizável é elegível a X |
| eventos_historico_cliente | Timeline; cliente_id obrigatório, cliente_origem opcional, entidade/metadata | E pelo(s) cliente(s); U por recurso/origem quando evento operacional | DERIVABLE_TENANT_HISTORY; não é pré-auth por padrão. Origem operacional incerta bloqueia; não exportar para Core |
| usuarios_administrativos | Identidade/senha/papel global e autoria | Core, sem ownership E; memberships autorizam | CORE_SECURITY; não copiar credenciais para histórico nem apagar identidade referenciada em provas |
| contrato_assinaturas/documentos/versões | Provas contratuais, PDFs/hashes e referências consumidas | E/U pelo contrato/fechamento | Exclusão de X; DERIVABLE_TENANT_HISTORY ou MANUAL_REVIEW se caminhos divergem |
| capabilities de contrato/cookies/entrega OTP | Superfícies runtime de autorização/entrega, não novas tabelas V1 | Recurso/finalidade e contexto validado precisam delimitar uso | REVOKE_ON_CUTOVER para autorização legada incompatível; nenhum token/cookie/URL assinada vai para Core histórico |

### Evidência runtime discriminante

- [Autenticação administrativa](../../../lib/autenticacao/service.ts): login recusado (linha67), login/reautenticação (83), logout (94) emitem auditoria sem cliente, de identidade/sessão global. consulta de sessão verifica revogação/expiração/atividade (21–31); buckets usam HMAC (33–54). Nomes de variáveis no código não foram lidos do ambiente.
- [Identidade service](../../../lib/identidade/services/identity.service.ts): desafio nasce para cliente canônico (277–325). [Repository](../../../lib/identidade/repositories/identidade.repository.ts): prova confirmada exige validade e ausência de consumo (198–214); consumo por fechamento/versão (266–312); lookup por token para idempotência também existe (180–195). Revogação precisa impedir **todos** esses caminhos, não só a tela de OTP.
- [Auditoria repository](../../../lib/clientes/repositories/auditoria.repository.ts) aceita cliente opcional e payload, mas não prova que evento sem cliente seja global. [Festa service](../../../lib/festas/service.ts) emite auditoria sem cliente, com recurso Festa: essa linha continua atribuível ao agregado.
- [Histórico CRM](../../../lib/clientes/repositories/historico.repository.ts) exige cliente. [Contrato público](../../../lib/contratos/services/contrato-publico.service.ts) preserva histórico e auditoria da assinatura. A FK de assinatura→validação e validação→consumidor impedem classificar uma prova consumida como lixo efêmero.
- WhatsApp: [018](../../../database/migrations/20260912_018_whatsapp_onboarding.sql) contém as duas tabelas, state e guards, mas nenhuma referência às tabelas foi localizada em app/lib. Isso é lacuna de produtor/proveniência, não autorização de Core. Sender OTP existente não comprova o bridge018.
- [Capability contratual](../../../lib/contratos/services/acesso-token.ts): token HMAC stateless v1 vincula contrato/versão/validação e expiração, mas não E/U; verificador local não consulta revogação da prova. [Cookie admin](../../../lib/http/admin-crm-api.ts) transporta a sessão. Invalidar somente o OTP não prova invalidação de toda capability emitida. O corte futuro deve recusar explicitamente a versão legada incompatível em todos os consumidores e exigir reemissão contextual; prova consumida permanece intacta. Não depender só do TTL, nem propor rotação de segredo compartilhado como atalho.

## 2. Categorias e precedência

| Classificação | Regra objetiva |
| --- | --- |
| TENANT_OPERATIONAL | Estado necessário a fluxo atual, E e U quando pertinente comprovados, autorização atual válida |
| CORE_SECURITY | Identidade/sessão/limite ou evento de segurança genuinamente global; não contém autorização operacional implícita |
| REVOKE_ON_CUTOVER | Estado ainda utilizável sem contexto SaaS seguro, ou impossível provar compatibilidade da autorização antiga; ação obrigatória anterior ao destino histórico |
| HISTORICAL_CORE_EVIDENCE | Evidência mínima de evento global comprovado, sem vínculo operacional/tenant e com necessidade de retenção finita aprovada |
| DERIVABLE_TENANT_HISTORY | Fato/registro histórico com E e U exigidos derivados de caminhos concordantes; permanece autoridade tenant-aware |
| RETENTION_DELETE | Registro sem referência/prova durável, sem hold, com prazo/necessidade de retenção encerrados segundo política aprovada; exclusão via X ou rotina nativa apropriada |
| MANUAL_REVIEW | Origem contraditória, unidade necessária não comprovada, produtor desconhecido, referência semântica incerta, conteúdo que não pode ser minimizado ou política ausente; bloqueia a linha/lote afetado |

REVOKE_ON_CUTOVER é ação sobre credencial/estado, não destino de histórico. Após revogar, reclassificar em história atribuída, evidência Core elegível, eliminação ou revisão. E conhecido tem precedência: **falta de U não é falta de tenant**. Não existe tenant UNKNOWN, empresa artificial nem transferência automática para Core por cliente_id NULL.

## 3. Alternativas físicas

| Alternativa | Integridade/autoridade e privacidade | Rollout/RLS/retenção | Decisão |
| --- | --- | --- | --- |
| A — tabela histórica Core dedicada | Pode isolar dados, mas outro arquivo duplica estrutura/autoridade e incentiva cópia integral | Exige grants/retention próprios e resolução do original | Não necessária: finalidade já coberta pela entidade proposta de segurança |
| B — canal/tabela Core de segurança tipado | Uma representação mínima autoritativa para segurança global; separa emissão nova de extração histórica sem payload genérico | Role própria, sem leitura por memberships; prazo finito por evento; purge controlado | Escolhida para eventos globais comprovados, reutilizando auditoria_seguranca_core |
| C — sidecar histórico | Mantém original e correlação, mas sozinho não remove E NULL nem neutraliza credenciais | Cobertura reversa e acesso a ambos aumentam risco; pode duplicar autoridade | Rejeitado como solução do OPEN03; D08 continua exceção específica para outro problema |
| D — revogação + retenção na origem | Adequada às sessões/buckets Core nativos; revogação não resolve NN de tabela operacional | Não migra PII desnecessária; purge por política | Escolhida para Core nativo; apenas transitória para linhas operacionais sem escopo |
| E — combinação por categoria | Mantém cada fato em uma autoridade, exporta só evento global mínimo e elimina origem elegível | X transacional + gates negativos; retenção/anonimização sem backdoor | **Escolhida: B+D, com manutenção tenant-aware e eliminação estritamente elegível** |

A direção não cria uma nova tabela de arquivo. auditoria_seguranca_core é uma **nova entidade SaaS já proposta na1C-A**, fora das63 V1; aqui sua necessidade/conteúdo são delimitados. Escolha técnica B1 não é criação/aprovação automática do DDL ou autorização de descartar dados.

## 4. Conteúdo mínimo de auditoria_seguranca_core

Substitui a ideia genérica de JSON/usuário indiscriminadamente opcional no blueprint. Não é réplica da auditoria V1; preserva autoria comprovada obrigatória conforme ADR009, sem copiar cadastro pessoal.

| Campo proposto | Tipo/nulabilidade | Necessidade e restrição |
| --- | --- | --- |
| id | uuid PK NN | Identidade própria do evento mínimo, sem ser token ou UUID operacional |
| ocorrido_em | timestamptz NN | Instante original comprovado; não inventar se ausente |
| registrado_em | timestamptz NN | Instante da emissão nova ou extração, distinto do original |
| modalidade | text NN | NATIVO ou EXTRAIDO_V1, check fechado |
| tipo_evento, resultado, origem_codigo | text NN | Códigos allowlist; significado conhecido. Resultado só derivado de contrato de emissão validado, nunca texto livre inventado |
| ator_categoria | text NN | SISTEMA/IDENTIDADE_ADMIN_GLOBAL/NAO_IDENTIFICADO conforme evidência; não perder ator conhecido por minimização |
| usuario_id | uuid condicional | Obrigatório para IDENTIDADE_ADMIN_GLOBAL conhecido; referência global comprovada a usuarios_administrativos, FK RESTRICT, sem cascata. Não copiar nome/e-mail; não expor lookup a tenant |
| principal_servico_codigo | text condicional | Obrigatório para SISTEMA: principal técnico de serviço em catálogo Core versionado/allowlist e com proveniência comprovada; não derivar apenas de usuario_id NULL nem inventar instância histórica |
| motivo_codigo | text opcional | Código controlado, não justificativa original livre |
| correlacao_id | uuid opcional | Só request/correlation técnico comprovadamente não secreto e necessário; nunca sessão, cliente, entidade alvo ou token |
| lote_extracao_id | uuid condicional | Obrigatório em EXTRAIDO_V1; identifica certificado técnico, não acesso ao original |
| origem_registro_codigo, localizador_pseudonimo, localizador_versao | text, bytea, text condicionais | Em extração: tipo de origem + pseudônimo técnico para idempotência. Nunca PK de cliente/CPF/e-mail/OTP/token/payload |
| regra_classificacao_versao, politica_retencao_versao | text NN | Versões imutáveis de artefatos Core revisados; nada escolhido pelo caller |
| reter_ate | timestamptz NN | Prazo finito calculado da ocorrência original pela política; não reinicia na extração |

Checks/índices propostos: enumerações e combinações de modalidade; autoria XOR humano/serviço, campos de autoria ausentes somente para NAO_IDENTIFICADO comprovado; localizador somente para extraído; UNIQUE(origem_registro_codigo,localizador_versao,localizador_pseudonimo) para impedir reextração enquanto existir; índice(reter_ate,id) para purge e (ocorrido_em,tipo_evento) para investigação autorizada. Tabela não tem empresa/U para representar “desconhecido”: é explicitamente Core e só aceita o domínio global comprovado.

ADMIN_LOGIN/REAUTENTICACAO/LOGOUT exigem conservar usuario_id conhecido; falta/divergência impede X. ADMIN_LOGIN_RECUSADO é emitido como SISTEMA: a origem deve comprovar o principal do serviço de autenticação, sem inventar o humano que tentou login; se não comprovável, MANUAL_REVIEW. NAO_IDENTIFICADO só é válido quando o contrato original realmente não tinha ator identificável, nunca para apagar um ator conhecido. Referências ao usuário Core só podem ser investigadas pela role de segurança com finalidade auditada, não por tenants. Se a política exigir eliminar a identidade indispensável antes do fim da evidência, resolver o conflito em MANUAL_REVIEW; não substituir por evento sem autoria. RETENTION_DELETE após prazo elimina o evento elegível por inteiro. Nenhum novo diretório de pessoas é criado.

Pseudônimo proposto: HMAC de namespace da origem + UUID **da linha-fonte** + versão, com chave dedicada inacessível a runtime/tenant, somente se necessária à idempotência. Não usar hash público de PII/segredo, nem chamar pseudônimo de anonimização. Artefato/versão de chave é requisito operacional D12c; nenhuma chave é criada/lida aqui. Estabilidade por campanha/retry; rotação não permite reextração por trocar namespace. Apagar localizador com sua evidência/política, não reter índice eterno. Após purge, certificados fechados e barreira de cutover/restore impedem reimportar fontes antigas.

Não preservar: código/hash OTP, token/hash de acesso/CSRF/state, cookie/sessão ativa, senha, IP/UA por padrão, credencial cifrada, IDs Meta/número, documento/PDF, payload, snapshot, dados_antes/depois, justificativa livre ou FK a cliente/contrato/Festa. A referência de autoria global acima é a exceção necessária e restrita, não um índice de descoberta cross-tenant. Se a obrigação legítima exigir conteúdo fora desse mínimo, a linha **não** passa silenciosamente: MANUAL_REVIEW e especificação própria antes de executar.

## 5. Autoridade única e protocolo X

X é proposta explícita de migração de domínio/retenção, distinta de M (que só altera metadados). Para auditoria003/WhatsApp018, X exige exceção estreita ao guard de DELETE atual e revisão/aprovação dessa exceção; não fingir que append-only já permite remoção. Fora de X, append-only permanece. Documentos, assinaturas, provas consumidas, pagamentos, festas e auditoria empresarial estão excluídos da extração Core.

| Momento | Autoridade | Estado da origem |
| --- | --- | --- |
| Antes da transação | Registro V1 | Não pode ser usado como autorização após barreira de revogação; ainda é a única evidência original |
| Durante transação privada X | Origem; destino não publicado separadamente | Locks e escritores drenados; extração e remoção não se confirmam separadamente |
| Commit de extração | Core, **somente para a evidência mínima preservada** | Original removido; nenhuma cópia/tombstone operacional com E NULL ou credencial |
| Commit de RETENTION_DELETE | Nenhuma autoridade individual remanescente; só certificado técnico minimizado | Original removido após política; não alegar preservação integral |
| Rollback X | Origem permanece autoridade; destino não confirmado | Barreira de revogação/cutover continua; falha não reativa credencial nem libera tráfego |

A evidência reduzida **não é cópia forense integral**, não conserva todos os bytes/IDs da origem e não pode ser usada como prova de aceite/assinatura. Para campos mantidos, conservar valores/semântica e registrar regra de transformação; não produzir narrativa nova. Se preservação integral for exigida, X não é elegível: revisão, sem descarte.

### X: condições necessárias e ordem futura

1. Instalar barreira de cutover e consumidores tenant-aware; parar/drenar writers, callbacks e consumo legado. Revogação é etapa segura independente: se extração falhar, a autorização antiga continua inválida. Não depender de TTL que ainda não venceu.
2. Classificar por regras versionadas e mapa fechado de PKs aprovado. Provar domínio global por contrato de produtor, semântica e campos coerentes; nomes de ação/origem/cliente_id NULL sozinhos são insuficientes. Conferir todos os caminhos E/U, incoming FKs **e referências semânticas** em assinaturas, snapshots, eventos, callbacks e idempotência. Qualquer referência durável desconhecida bloqueia.
3. Validar retenção/necessidade/holds e campos mínimos antes de conceder X. Sem política finita ou com exigência de prova integral, falhar fechado. Nenhuma cascata, nenhuma eliminação de pai referenciado para “resolver” FK.
4. Em lote atômico, com isolamento/locks ensaiados, identidade de migrator segregada, mapa imutável e autorização por transação/PK/imagem esperada, extrair mínimo + certificado + remover **exatamente** os originais elegíveis. Para RETENTION_DELETE não produzir réplica individual; registrar contagens/classificação/regra de eliminação. Core não recebe direitos sobre dados empresariais.
5. Comparar conjuntos: toda PK elegível tem exatamente um destino aprovado (tenant mantido, Core extraído, eliminado); o que fica operacional tem E/U completos. Provar valores dos campos preservados, ausência de secrets e zero sobreposição origem/destino publicados. Não armazenar linha-fonte/payload em log, staging persistente, arquivo de erro ou certificado.
6. Drenar eventos diferidos, restaurar guards/ACLs e retirar autorização X **antes do commit**. Nenhuma execução normal adquire DELETE em auditoria/018; P/M continuam independentes. Falha/timeout/desconexão reverte X, não publica metade nem inicia tráfego.
7. Pós-commit: origem ausente, Core mínimo/único quando aplicável, lookup antigo/token/callback uniformemente negados; nenhum caminho de recriação por retry. Retomada depende de conferência externa de locks/guards/ACLs/gates. Commit incerto exige inspeção autorizada do certificado, não reexecução cega.
8. Após qualquer restore de backup anterior ao corte, manter aplicação fechada até reaplicar/verificar barreira de corte, revogações, classificação/purge elegíveis e compatibilidade. Backups têm retenção/acesso próprios; nunca usar restauração como mecanismo para reativar fonte/autoridade apagada. Não prometer eliminação instantânea de todas as cópias de backup.

O guard temporário X só aceita DELETE da PK/imagem OLD allowlisted nesta transação, após conferir o substituto Core exato campo a campo (ou a decisão RETENTION_DELETE aprovada). Nunca autoriza UPDATE/INSERT na origem, TRUNCATE, cascata, DISABLE TRIGGER geral ou role/GUC escolhida pelo runtime. Certificado técnico registra versão das regras, lote, partições/contagens e resultado, sem lista de pessoas/PKs de negócio nem imagem da fonte; a vinculação técnica restrita é o localizador mínimo descrito acima. Readers compatíveis não fazem UNION de duas autoridades; publicam somente o estado anterior ou posterior ao commit.

Se o contrato exato de retenção/minimização não for aprovado, essa é falha do **gate de execução X**, não licença para manter E NULL em G4. A estrutura do tratamento está definida; nenhuma população real foi classificada nesta fase.

## 6. Tratamento específico de identidade e integrações

### OTP/provas

- CONSUMIDA ou referenciada por assinatura/documento/fluxo: DERIVABLE_TENANT_HISTORY somente com cliente+consumidor E/U convergentes; manter prova, hashes e FK, sem reemitir. Divergência = MANUAL_REVIEW.
- PENDENTE/CONFIRMADA/vigente sem contexto SaaS comprovado: REVOKE_ON_CUTOVER; conferir expiração de código **e** de prova, status, consumo concorrente e lookup de idempotência. Utilizar transições permitidas ou mecanismo de cutover específico ensaiado; não inventar estado REVOGADA no enum V1. Recuperação pendente não é OTP consumido.
- Expirado/bloqueado/não consumido: tempo decorrido não comprova ausência de referências; verificar todos os consumidores. E é derivável do cliente, mas U pode faltar. Se sem referência/prova e retenção encerrada, RETENTION_DELETE; se precisa sobreviver e não tem U necessária, MANUAL_REVIEW. **Não transferir a Core por falta de U.**
- Novo estado SaaS: desafio/prova operacional recebe E/U/finalidade/recurso na emissão e consumo. Nenhuma prova V1 vigente sem escopo atravessa o corte; recriar autorização exige fluxo novo.
- Evidência administrativa do ato de revogação/purge pode ser evento técnico mínimo de lote, não cópia do OTP do cliente nem alegação de que seu histórico tornou-se global.

### WhatsApp

Tentativa com E comprovada permanece empresa-owned; U é associação/candidato explícito, não obrigatória para ownership E. INICIADA/VALIDANDO sem E segura é invalidada conforme018 e não pode ser retomada pelo callback/state antigo. Reinício exige contexto novo, state novo e rights revalidados.

Terminal sem E não é automaticamente pré-auth: como não há produtor018 runtime localizado, a regra padrão é MANUAL_REVIEW ou RETENTION_DELETE quando a política e ausência de dependência forem comprovadas. HISTORICAL_CORE_EVIDENCE só para evento de segurança global cuja proveniência e finalidade sejam comprovadas separadamente; não a linha da conexão.

Conexão com posse comprovada recebe E e associações U autorizadas. Sem posse/origem: suspender envio/uso, invalidar autorização utilizável conforme plano próprio e revisar; não copiar credencial/IDs externos para Core nem atribuir à Kidmais pelo ambiente. Disconexão/revogação externa exige autorização própria; não foi executada nem presumida aqui. Segredo antigo não pode sobreviver em fallback de processo habilitado no novo modelo.

### Sessões e limites

Sessão global pode continuar autenticando identidade se o build de cutover já exige memberships/grants/contexto novos em toda operação e não carrega autorização antiga incompatível. Se isso não estiver comprovado, revogar/reemitir sessões V1. Não adicionar E/U à sessão, não alterar o UUID histórico da assinatura e não exigir que a sessão de uma assinatura antiga esteja ativa.

Buckets de rate-limit permanecem CORE_SECURITY. Retenção/limpeza não migra identificadores para histórico nem abre janela de força bruta. Credenciais/capabilities legadas emitidas com autorização incompatível não são conservadas apenas porque a sessão é Core.

## 7. Regra normativa aplicável ao backfill

Pré-condição obrigatória independente do destino: neutralizar qualquer autorização legada incompatível antes do corte, inclusive capability stateless, callback e lookup idempotente; nenhuma regra de retenção autoriza uso. Depois aplicar as regras de destino em ordem, com evidências e resultado por PK; MANUAL_REVIEW é bloqueante, nunca escolha informal de tenant:

1. **Se** o registro é prova consumida, fato durável de negócio ou evidência referenciada por ele, **então** proibir X/RETENTION_DELETE automático; derivar todos os caminhos e manter história tenant-aware se convergentes, senão MANUAL_REVIEW. Identidade/sessão Core citada como autoria continua Core; não converter a sessão histórica em prova operacional nem exigir sua existência/ativação para validar assinatura antiga.
2. **Se** a superfície é identidade/sessão/bucket global nativa, **então** CORE_SECURITY; revogar autorização incompatível e aplicar retenção nativa, sem introduzir E.
3. **Se** qualquer contexto operacional/autorizado aponta para E, **então** tenant tem precedência. Exigir U quando o domínio pede; falta de U não autoriza Core. Guardar TENANT_OPERATIONAL ou DERIVABLE_TENANT_HISTORY; se impossível e registro não for efêmero eliminável, MANUAL_REVIEW.
4. **Se** o estado efêmero ainda é utilizável e não comprova contexto novo, **então** REVOKE_ON_CUTOVER antes de qualquer destino final. Revogação não elimina dependências/história nem resolve E/U.
5. **Se** contrato de emissão/proveniência comprova segurança global, não existe contexto/vínculo tenant, nem dependência durável, **e** retenção mínima individual é necessária, **então** HISTORICAL_CORE_EVIDENCE via X e mínimo allowlist.
6. **Se** não há referência/prova/hold e a política aprovada comprova fim da retenção, **então** RETENTION_DELETE pelo caminho autorizado (X quando guard exige). Nenhuma cópia individual por conveniência.
7. **Caso contrário**, MANUAL_REVIEW: interromper lote afetado e impedir fechamento do cutover. Não resolver por única unidade, ausência de cliente, ID de usuário, ambiente ou conteúdo livre.

Allowlist inicial de candidatos globais de auditoria: ADMIN_LOGIN_RECUSADO/AUTENTICACAO, ADMIN_LOGIN/ADMIN_REAUTENTICACAO/ADMIN_LOGOUT com SESSAO_ADMINISTRATIVA, origem ADMIN_AUTENTICACAO, cliente ausente e forma de payload conforme o produtor verificado. Essa combinação apenas seleciona **candidatos**; campos inesperados, recurso operacional, fonte não confiável ou evidência de tenant fazem a regra falhar. Evento FESTA sem cliente é exemplo negativo explícito. Não consultar recurso candidato cross-tenant para classificar uma negação.

## 8. Retenção, RLS e gates

Política versionada de retenção precisa definir finalidade, classes/campos permitidos, duração finita, data de referência, condição de purge, tratamento de hold e responsável. Não se inventa prazo jurídico em dias nesta fase. Regra sem prazo ou hold sem fundamento/data de revisão impede X/purge; não é aprovação de retenção indefinida. Havendo hold que exige conteúdo integral fora do mínimo, não extrair/minimizar até decisão específica. Prazo vence a partir do evento original; extração não renova a retenção.

Core histórico: sem grants SELECT/INSERT/UPDATE/DELETE às roles de tenant/runtime comercial, sem endpoint de busca por pessoa/telefone/token/PK de negócio para tenant, nem joins para descobrir outra empresa. Ingestão nativa por superfície Core restrita e tipada; extração só migrator/X; investigação da autoria comprovada apenas por ação de segurança e finalidade, auditada separadamente; purge por role de retenção específica. FORCE RLS candidato e policies fail-closed reforçam ACLs; owner/BYPASSRLS não é runtime. A própria auditoria de acesso deve ser mínima, sem recursão infinita de payload.

### Gates de execução

| Gate | Antes de quê? | Evidência obrigatória |
| --- | --- | --- |
| G-P | Primeiro ADD COLUMN S2 em adicionais H16, ou expansão equivalente | Projeção V1 byte-identical e regressão de hashes ocupados |
| G-M | Primeiro UPDATE de backfill protegido S5, ou escrita antecipada equivalente | Ensaios por família, autorização/lote, OLD/NEW e guards restaurados |
| G-X | Primeiro purge/extração ou cutover da família de segurança, antes de S6 | Aprovação específica da exceção/retention; classificador/proveniência; dependências; atomicidade/autoridade; minimização; revogação; restore |
| G-COVERAGE | NOT NULL final/S6 e depois G3/G4 | Zero linha tenant-owned obrigatória sem escopo; pendentes=0; nenhuma cópia operacional residual; Core somente global comprovado; nenhuma credencial legada incompatível utilizável |
| G-ACCESS | Antes de tornar Core acessível ou retomar tráfego | ACL/RLS/rotinas reais, negação de enumeração, D12c e build compatível/D12b |

Gates continuam futuros, não aprovados pela escrita deste documento. Linhas sem origem continuam bloqueando execução; isso não deixa uma alternativa física indefinida. A política dita precisamente conservar, revogar, extrair mínimo, eliminar ou recusar.

### Testes adversariais futuros mínimos

Tenant força origem ADMIN_AUTENTICACAO; auditoria FESTA sem cliente; OTP com E mas sem U; prova consumida/referenciada; código expirado mas prova válida; callback tardio; consumo concorrente ao revoke/delete; falso terminal; erro entre inserir destino e remover fonte; rollback/commit incerto/retry; tentativa de ler localizador; logs/erros/listas/exports; política vencida/ausente/hold; restore anterior ao corte. Em todos: mesma autoridade correta, outra empresa inalterada, zero credencial reativada, nenhum dado de negócio vazando para Core.

Autoria: humano conhecido sem usuario_id, SISTEMA sem principal comprovado, troca de ator conhecido por NAO_IDENTIFICADO e consulta da autoria por tenant devem ser negados. Não permitir que minimização elimine a autoria exigida pelo ADR009.

## 9. Contagem e alcance

As63 tabelas V1 permanecem63; ownership operacional final é preservado. Extração de subconjunto global comprovado não transforma auditoria/eventos/OTP inteiros em Core. Nenhum sidecar se tornou padrão, nenhuma tabela-arquivo foi acrescentada. A nova entidade auditoria_seguranca_core já estava no blueprint SaaS e não pertence à contagem V1.

Reversão desta entrega é apenas documental, preservando as fases anteriores. Futuro X é transacional antes de commit; depois de descarte autorizado, não prometer undo por restauração de uma credencial/payload eliminado. Correção posterior é forward-fix do mínimo, sem fabricar evidência integral. Nada aqui executa retenção, purge, revogação, SQL, migration, runtime ou acesso a banco.
