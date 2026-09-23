# RLS e contexto — proposta sem policies executáveis

[ADRs002/004/009/010](../adr/README.md) são os contratos aprovados. Este texto descreve predicados e privilégios candidatos, não implementa RLS/SET/função/role. RLS reforça filtros e integridade; autorização por ação/projeção continua obrigatória.

1C-B1: M da [prova de migratabilidade](SAAS-MIGRATABILITY-PROOF.md) e X da [disposição de segurança](SAAS-LEGACY-SECURITY-DISPOSITION.md) são mecanismos distintos; nenhum permite bypass permanente/autorização por GUC. Runtime não assume migrator nem fabrica lote. Exceções terminam antes do commit. OPEN03 tem desenho fechado para aprovação, não execução certificada; nenhum registro empresarial sem escopo atravessa S6/G4.

## Contrato lógico transaction-local

| Nome conceitual | Conteúdo / validação obrigatória |
| --- | --- |
| app.empresa_id | UUID E validado contra vínculo da identidade/prova; obrigatório em toda operação tenant-owned |
| app.estabelecimento_id | UUID U da E, autorizado; uma unidade por mutação; ausente somente em ação legitimamente empresarial/default |
| app.principal_tipo | ADMIN, SERVICO ou PUBLICO; variante tipada, nunca substituída por usuário NULL |
| app.principal_id | Identidade autenticada de usuário, serviço ou identificador de prova; não campo livre que autoriza |
| app.membership_id | Obrigatório no ADMIN, ativo da mesma E e usuário; ausente nas outras variantes, que têm autorização própria |
| app.acao | Código Core com granularidade de escopo; coincide com o endpoint e grants permitidos |
| app.prova_id | Obrigatório em PUBLICO; vínculo limitado a finalidade/recurso/E/U; não libera CRM completo |
| app.correlation_id | UUID request/execução para rastreabilidade; nunca autorização |

Valores são transportados na conexão da transação, não variáveis globais do processo nem settings persistentes do pool. Principal administrativo é autenticado na superfície de identidade; descoberta restrita devolve somente vínculos próprios. A transação revalida membership/grants e fixa o contexto antes de qualquer consulta operacional. Encerramento COMMIT/ROLLBACK não deixa contexto para o próximo uso. D10 permanece pendente sobre ordenação contra revogação concorrente: presença de contexto não congela permissão indefinidamente nem prova resultado da corrida. [SET LOCAL no PostgreSQL18](https://www.postgresql.org/docs/18/sql-set.html).

GUCs customizados não são credenciais: runtime capaz de executar SQL arbitrário pode tentar forjá-los. Usá-los como fronteira contra omissão de filtro requer sessão/prova validada e acesso restrito; não alegar proteção contra comprometimento integral da credencial. Predicados devem confrontar E/U/principal/membership/ação com bindings confiáveis. Mecanismo concreto de instalação/validação de contexto é gate de implementação; nenhum endpoint aceita contexto pronto do browser.

## Predicados candidatos por categoria

USING significa elegibilidade da linha existente; WITH CHECK significa elegibilidade da linha nova/resultante. Todas as vias são fail-closed em ausência, formato inválido, expiração ou incoerência do contexto. Aprovação de contexto não permite mover E/U/id de uma linha existente.

| Categoria / superfícies | Contexto e USING conceitual | WITH CHECK conceitual | Role/FORCE e operações especiais |
| --- | --- | --- | --- |
| GLOBAL/CORE: usuários/sessões/limites | Role de identidade acessa somente operações mínimas de login/sessão própria e bucket autorizado; membership comum não lê diretório global | Somente rotinas de identidade/provisionamento explícitas; usuário não altera seu papel/custo/limites por API | Sem SELECT geral para runtime operacional; RLS/ FORCE candidato para usuários/sessões sob rotinas restritas; limites preferir sem grants diretos e rotina mínima. Job não varre identidades |
| CORE: auditoria_seguranca_core | Role de segurança com finalidade/ação específica e autoria comprovada; nenhuma leitura/busca de pessoa/localizador por membership de tenant | Emissão nativa tipada; extração somente X; autoria humana global/serviço obrigatória quando conhecida, sem payload, tenant desconhecido ou dados operacionais | FORCE candidato; ACL sem grants ao runtime comercial, owner separado, purge por retenção finita versionada e FK de autoria RESTRICT. G-X/G-ACCESS antes de publicação; log de acesso mínimo sem recursão |
| Control plane: empresas/unidades/memberships/grants | Descoberta somente vínculos do principal comprovado; empresa E permitida; administração de grants requer ação específica | Mesma E, U válida, delegação autorizada; inserção de nova empresa não passa pelo runtime comum | Runtime administrativo sem owner; FORCE candidato. Provisionamento plataforma tem superfície própria, sem SELECT operacional. G4 controla ativação do segundo tenant |
| EMPRESA: CRM e filhos | E igual ao contexto **e** permissão empresarial para ação/projeção OU vínculo/fluxo D11c com U autorizada e acesso mínimo | E invariável; cliente/pais mesma E; ação e fundamento autorizados; unidade não cria vínculo para abrir diretório | FORCE candidato. RLS seleciona linhas, não resolve minimização de colunas; proibir SELECT irrestrito às roles de unidade e expor projeções/rotinas limitadas revisadas |
| EMPRESA: eventos_historico_cliente/auditoria | E igual e ação de leitura; origem operacional requer U de origem concedida; origem empresarial exige permissão empresarial | Envelope coincide com ação/recurso; negação registra candidato não verificado sem lookup alheio | FORCE candidato; append-only, leitura de auditoria é ação separada. Pré-auth usa canal Core. VínculoCRM de A1 não abre históricoA2 |
| EMPRESA: WhatsApp e onboarding | E e ação autorizadas; credencial não retorna por consulta comum; tentativa própria/direito operacional pertinente | Conexão/associações/unidades/member/sessão mesma E e principal; state/TTL/status consistentes | FORCE candidato; provider credentials apenas superfície de envio autorizada; callback autenticado/finalidade limitada |
| ESTABELECIMENTO: 41 tabelas | E igual, U pertence a E, grant U e ação/recurso; no público, prova valida recurso/finalidade/versão | E/U iguais ao contexto, pais da mesma unidade/empresa e invariantes do agregado; nenhuma troca de escopo por UPDATE | FORCE candidato nas 41; INSERT/UPDATE/DELETE não escapam por policy permissiva. Históricos só INSERT conforme domínio; cópias/export/blob igualmente escopados |
| CONFIGURAÇÃO: default/override | E igual; default permitido conforme ação empresarial ou consumo pela publicação de U; override somente U autorizada; publicação efetiva da U | Default só ação empresarial; override só sua U; publicação valida conjunto e fonte; não editar versão já publicada | FORCE candidato nas10,publicações/vínculos; runtime consumidor sem DML de autoria. Unit reader só publicação efetiva necessária, não todo catálogo administrativo |
| Jobs/webhooks/fluxos públicos | Principal de serviço/prova tem binding de E/U/ação/recurso previamente validado e revalidado no consumo | Mesmo escopo permitido e idempotência local; retry não aceita tenant trocado; webhook resolve conexão e associação legítimas | Role de job mínima e sem bypass; público sem grants de listagem/admin. Ausência de runner atual não autoriza novo serviço nesta fase |

FORCE é candidato justificado para não depender do comportamento habitual de owner; runtime/workers continuam proibidos de ser owner/superuser/BYPASSRLS, assumir esses papéis ou alterar policies. RLS não cobre TRUNCATE; negar esse privilégio. Evitar combinação OR acidental de policies que torne o predicado de tenant opcional; compor escopo obrigatório como barreira e permissões por ação dentro dela. FKs/uniques não substituem policies e podem revelar existência via erros, que precisam de resposta uniforme. [RLS PostgreSQL18](https://www.postgresql.org/docs/18/ddl-rowsecurity.html).

## Bootstrap sem circularidade e CRM sem diretório

Superfície de identidade confirma sessão/token; superfície de descoberta autorizada recebe prova da identidade já confirmada e retorna vínculos do próprio principal. Não recebe apenas usuario_id/empresa_id alegados. Ela usa grants próprios restritos sobre relações de controle, não SELECT global de negócio. Policies operacionais podem consumir esse contexto após revalidação; não fazer membership depender recursivamente de uma consulta na própria membership via mesma policy.

Se uma função SECURITY DEFINER for necessária, usar owner dedicado sem login, privilégios específicos sobre controle, search_path fixo seguro, objetos qualificados, argumentos fechados e EXECUTE limitado. Não conceder BYPASSRLS genérico, não usar o owner de todos os agregados. Reavaliar cada definer contra RLS/FORCE efetivos; não presumir que execução privilegiada ignore ou satisfaça policies. Uma falha nesse desenho bloqueia implementação, sem liberar consulta global como fallback.

Resolver cliente exclusivo de U2 para fluxo legítimo em U1 pode anteceder a criação do vínculoCRM de U1. Rotina específica valida fundamento do titular/concessão empresarial e limita projeção/ação; não pode ser chamada livremente com CPF/ID. Auditoria de tentativa sem fundamento não consulta U2 para confirmar existência. API de CRM completo é separada da resolução e da leitura operacional. Testar corpos, contagens, tempos/erros observáveis e resultados mascarados, não somente ausência de linhas.

## Privilégios e prova futura

Owner sem login; migrator somente deploy autorizado; runtime e worker com grants por objeto/ação. PUBLIC não recebe EXECUTE indiscriminado. Inventariar as107 funções do baseline, triggers, views, sequences, default privileges e locks: assinatura compatível não garante que lookup interno tenha E/U. Funções019 e locks por data devem ganhar fronteira de unidade na implementação, preservando exclusão dentro da unidade. Não resolvido nesta fase.

Relatórios multiunidade exigem ação de consolidação e conjunto de unidades autorizado derivado do servidor; não usar U NULL como todas. Podem executar consultas por U ou superfície consolidada com predicado explícito por grant. Valores vindos de lista do cliente são apenas candidatos. Suspensão permite somente ações de retenção/leitura histórica explicitamente autorizadas, sem bypass geral.

Provas G1/G3 propostas: T01–T16 com roles reais; A/B,A1/A2/B1; FK cruzada mesmo com filtro esquecido; null parcial; GUC adulterado/ausente; token expirado; query direta de unidade não expõe todas as colunas CRM; member de usuário diferente; OAuth/state replay; pool após erro/rollback; UPDATE tenta mover escopo; funções/views/listas/exports/PDF/JSON e erros; concorrência D10 após decisão; novas unidadesD03. Nada disso foi executado na 1C-A.
