# RELATÓRIO FESTA 016 — REVISÃO TÉCNICA FINAL

> **Documento histórico.** O responsável do projeto informou em 11/09/2026 que a Migration 016 foi aplicada e homologada no banco real. Essa informação ainda não foi reconfirmada por esta candidata. Não use as instruções antigas deste relatório para reaplicar ou reverter a migration; qualquer acesso ao banco real exige aprovação explícita.

Atualizado em 11/09/2026. Implementação e validação em clones. Aplicação no banco real continua pendente de autorização.

## 1. Ativação em produção

`lib/festas/service.ts::ambienteFesta()` delega a `validarAmbienteFesta`, em `lib/festas/ambiente.ts`.

O módulo exige `FESTA_ENABLED=true`, com esse valor exato. Flag ausente ou diferente recusa o acesso com HTTP 503 e mensagem segura, antes de consultar o catálogo. Não há dependência do nome físico do banco.

Com a flag habilitada, uma consulta somente de leitura compara a assinatura da estrutura física com a instalação final validada da 016. Verifica as nove tabelas, colunas/tipos/defaults/nulabilidade, constraints e sua validação, índices, triggers habilitados e definições das funções. Inclui as seis colunas novas de Fechamento/revisão e as três funções existentes substituídas pela migration. Nome do banco, OIDs, proprietários e dados não integram a assinatura. Falha de consulta ou divergência produz HTTP 503 sem revelar detalhes internos. Nenhum acesso cria ou repara estrutura.

Assinatura do catálogo validado: `d723f81def59be627132230aa6de2e00b0b509d48f20b0e0701afd7eb99650d7`.

A flag foi configurada explicitamente em `.local-festa/manual.env` e `.local-festa/clone.env`; o gerador de ambientes também a inclui. `.env.local` do banco real não foi habilitado. As guardas de nomes dos scripts destrutivos de teste continuam restritas aos clones registrados; elas não são usadas como critério de acesso do módulo em produção.

Teste físico em `kidmais_release_1789127476342`, fora do padrão antigo: consulta autenticada aprovada com flag e estrutura válidas; flag desabilitada recusada; tabela ausente, coluna ausente, trigger desabilitado, constraint ausente, função incompatível e tipo incorreto recusados. Danos simulados e dados desse teste foram revertidos por transação.

Implantação futura: instalar a versão compatível e executar a migration/checks no destino autorizado; só então habilitar a flag e reiniciar a aplicação. Isso não foi executado no banco real. A assinatura é deliberadamente estrita: futuras mudanças de estrutura exigem revalidação e atualização controlada desse contrato. Portabilidade foi comprovada entre nomes de banco no PostgreSQL 18 local; não foi alegado teste em provedor cloud.

## 2. Migration e rollback reais

Migration: `database/migrations/20260911_016_festa.sql`.

SHA-256 final: **3843802812F7A970F8824F3836EEF592BF3B565D1721A4ED33C75E5B620774A2**.

Rollback único existente: **`database/rollback/20260911_016_festa_down.sql`**. O diretório é `rollback`, no singular. Não foi criado outro rollback. Migration e rollback permaneceram byte a byte iguais ao checkpoint desta revisão.

O rollback obtém locks exclusivos, recusa qualquer dado nas nove tabelas, auditoria de origem Festa ou escolhas preenchidas nas seis novas colunas. Remove as nove tabelas, seus índices/constraints/triggers e as quatro funções `festa016_*`; restaura as três funções anteriores; remove as seis colunas de Fechamento/revisão. Tudo ocorre em uma transação.

As definições anteriores foram comparadas integralmente por `pg_get_functiondef`, antes da aplicação e após o rollback. Igualdade exata confirmada para:

| Função | SHA-256 da definição serializada como JSON |
| --- | --- |
| kidmais_hash_revisao_operacional | 8f6fde05d88e21faa9757ab13fa0e33dbae4ffee8e918830fc6b41c9146034da |
| kidmais_proteger_fechamento_em_revisao | 790abf3d49e3cc7a7d0da508efb05e66d783590792563861b9a4e2bf464869e5 |
| kidmais_validar_revisao_operacional | 8b5d8cdb5cdd40e82b1a23657eeefd5c8d1defbf04a12c9e4afff10ba43b3685 |

## 3. Ciclo físico comprovado

Checkpoint de arquivos desta revisão: `.backups/preproducao-1789127121563`.

Clone estrutural: `kidmais_016_1789127372077`, restaurado do dump anterior à 016. Sequência executada:

1. Captura dos dados das 52 tabelas anteriores, estrutura integral pública e funções anteriores.
2. Precheck aprovado.
3. Aplicação da 016 aprovada: 61 tabelas, nove novas vazias, seis novas colunas nulas, sem backfill.
4. Postcheck aprovado e dados anteriores preservados.
5. Rollback aprovado.
6. Estrutura integral, funções e dados comparados com checkpoint: igualdade exata.
7. Novo precheck, reaplicação e postcheck aprovados.
8. Rollback com dados de Festa recusado; rollback com escolhas preenchidas recusado. Fixtures desses bloqueios revertidas.

Hash da estrutura integral do checkpoint restaurado: `33e520e4243980fe83c9befad901c558651fba1b940dd88ec706cb2de0bfef1f`.

Evidências: `.local-festa/results/migration.json` e `structural-checkpoint.json`. A comparação cobre tabelas/sequências/views, colunas, defaults, constraints, índices, triggers e funções públicas, além dos hashes de dados.

## 4. Arquitetura atual

A Central possui Hoje, Próximas, Pendências e Histórico; este último diferencia Realizadas e Canceladas. Os rótulos PROXIMA, HOJE, REALIZADA, CANCELADA e REMOVIDA são derivados da data/horário em São Paulo, da fonte contratual e da invalidação operacional. Consultar não grava fatos de realização.

A tela da Festa contém Visão geral, Buffet, Checklist e Histórico. O cabeçalho prioriza contratante, aniversariante/idade e pacote. O resumo completo usa ficha com rótulo/valor no desktop e agrupamento responsivo no celular.

| Tabela | Responsabilidade e proteções |
| --- | --- |
| festas | Vínculo com contrato e versão de criação, revisão para concorrência, criação idempotente, invalidação auditada; índice único parcial permite uma Festa ativa por contrato. |
| festa_areas | Áreas opcionais, sem seed; o núcleo funciona sem cadastro de áreas. |
| festa_usuario_capacidades | Concessões e revogações, unicidade de capacidade ativa e identidade administrativa. |
| festa_buffet | Escolhas operacionais por Festa; uma linha por Festa, vínculo/versionamento e proteção de exclusão. |
| festa_tarefas | Checklist ANTES/DEPOIS, prioridade, responsável/prazo opcionais e estados PENDENTE, CONCLUIDA, NAO_SE_APLICA. |
| festa_pendencias | Pendências próprias CLIENTE/OPERACIONAL, responsáveis e resolução; financeiro e contrato permanecem nas fontes externas. |
| festa_contagens_convidados | Observações opcionais append-only, correções encadeadas e sem ramificação concorrente. |
| festa_solicitacoes | Registros de hora extra/adicionais e encaminhamento ao contrato/financeiro, com correção preservada. |
| festa_eventos | Histórico operacional append-only com antes/depois, usuário, snapshot de identidade, request/idempotência e instante do fato. |

A auditoria genérica existente é reutilizada atomicamente com os eventos. Não há seed de Festas, áreas, usuários ou capacidades.

### Acesso

Gestão reúne FESTA_CONSULTAR, FESTA_CRIAR, FESTA_OPERAR, FESTA_CORRIGIR e FESTA_CONFIGURAR_AREAS. Equipe reúne FESTA_CONSULTAR e FESTA_OPERAR. REPRESENTANTE_AUTORIZADO administra a concessão/revogação com autenticação e auditoria; alteração do próprio acesso exige confirmação explícita. O papel não concede automaticamente capacidades operacionais e cargo não autoriza ações.

### Contratação, Buffet e registros

Criação explícita/idempotente exige versão vigente concluída e provas de assinatura Kidmais e aceite OTP do cliente. Assinar contrato não cria Festa nem Pagamento automaticamente.

A versão vigente assinada continua como fonte contratual. Uma revisão em preparação não altera a Festa; a promoção após as assinaturas passa a ser exibida na mesma Festa, preservando registros vinculados às versões anteriores. Remarcação usa esse fluxo de revisão existente.

Buffet apresenta escolhas herdadas do snapshot e complementação operacional. Salgados, doces, bolo e bebidas compõem a base. Lembrancinha, empratado e bombom respeitam pacote e adicionais formalmente contratados. Os três campos nullable `buffet_lembrancinha`, `buffet_empratado`, `buffet_bombom` são acrescentados tanto a `fechamentos` quanto a `fechamento_revisoes`, com limite de tamanho, sem default inventado ou backfill. As três funções contratuais da 016 incluem essas escolhas na revisão e em suas proteções. Mudança comercial continua em Contrato; preferências não fabricam direitos, valores ou cobranças.

A quantidade de presentes é opcional. A última observação válida é usada; correção preserva o instante da observação corrigida e só pode continuar a ponta da cadeia. Sem observação, presentes e excedentes não são inventados. Registros de convidados, hora extra, adicionais e observações podem ser informados posteriormente. Tratamento financeiro continua exclusivamente em Pagamentos.

### Invalidação e cancelamento

Festa criada por engano pode ser invalidada conforme as verificações de ausência de atividade operacional. Fica fora das listas normais, mantém prova/auditoria e permite nova criação; não cancela contrato.

Cancelamento comercial é formalizado pela fonte contratual na operação autenticada existente. Festa reflete CANCELADA, preserva histórico/documentos/valores e deixa de exigir tarefas futuras. Evidência de realização, como presença ou hora extra, impede esse cancelamento enquanto não houver correção explícita compatível. Não cria devolução, estorno ou crédito.

### Navegação e histórico

Ver contrato consulta o contrato/versão corretos. Ver pagamentos leva ao Financeiro com scroll/foco depois do carregamento. Editar contratação abre Alterações; retorno à Festa aceita apenas rota interna validada. O histórico apresenta descrição humana suportada pelos dados, autor e data/hora sem segundos na apresentação comum. Não expõe JSON ou comandos internos.

## 5. Arquivos desta revisão técnica

Criados:

- `lib/festas/ambiente.ts`: gate por flag e instalação validada.
- `lib/festas/estrutura-016.ts`: consulta de catálogo e assinatura estrutural esperada.
- `lib/festas/ambiente.test.ts`: testes unitários do gate.
- `scripts/festa-016-ambiente.integration.cjs`: clone de nome diferente, acesso autenticado e danos estruturais revertidos.
- `scripts/festa-016-preproducao-preservacao.cjs`: conferência exclusivamente de leitura do banco real e arquivos protegidos.

Alterados:

- `lib/festas/service.ts`: substitui a dependência do nome físico pelo gate.
- `scripts/festa-016-prepare-environments.cjs`: flag explícita nos novos ambientes isolados.
- `scripts/migration-016.integration.cjs`: comparação integral da estrutura e hashes das funções no rollback.
- `scripts/festa-016.integration.cjs`: seleção determinística do cenário Festa Completa; não depende do primeiro contrato acumulado no clone.
- `scripts/festa-016-browser.cjs`: seletor do nome do contratante restrito ao cabeçalho, pois o nome também existe legitimamente no resumo.
- `.local-festa/manual.env` e `.local-festa/clone.env`: somente inclusão de FESTA_ENABLED=true; credenciais não são documentadas aqui.
- `RELATORIO_FESTA_016.md`: substituição do relatório obsoleto por esta descrição atual.

Evidências, logs e snapshots de teste foram gerados em `.local-festa`. Não houve alteração funcional de interface, financeira, contratual ou de domínio nesta revisão.

## 6. Testes e resultados

| Bateria | Resultado |
| --- | --- |
| Unitários de todo o projeto, incluindo Festa, gate, Buffet, perfis, apresentação, Contrato e Pagamentos | 143 aprovados; zero falhas ou ignorados. |
| Ambiente de produção em clone de nome diferente | Consulta autenticada aprovada, flag desligada e seis estruturas inválidas recusadas. |
| Migration016 | Precheck/apply/postcheck/rollback/comparação integral/reapply/postcheck aprovados; rollback protegido aprovado. |
| Integração Festa | 13 grupos aprovados: consulta derivada, perfis, contagens, registros tardios, invalidação/idempotência/recriação, cancelamento, provas, atomicidade e HTTP/CSRF. |
| Vigência Contrato/Festa | V1 preservada, V2 visível somente após assinatura Kidmais + OTP/promoção, remarcação na mesma Festa, comando antigo recusado, nenhum Pagamento criado. |
| Buffet Premium | Herança, três escolhas adicionais, snapshot, override, idempotência, revisão/hash e preservação financeira/documental aprovados. |
| Concorrência de contagem | Segundo corretor bloqueado, uma correção direta, continuidade somente pela ponta da cadeia. |
| Concorrência de invalidação/criação | Criação duplicada impedida, invalidação versus inclusão de pendência protegida, recriação e uma ativa aprovadas. |
| Regressões | 16 baterias aprovadas: unitários; PricingService; Identidade repositório/serviço/Fechamento; Pagamentos engenharia/HTTP/concorrência; condição de pagamento; financeiro HTTP/fluxo; crédito/devolução; casos financeiros; movimentos; revisão operacional; autenticação/Contrato. Incluem concorrência de Disponibilidade. |
| TypeScript | Aprovado; também typegen + TypeScript em cópia limpa. |
| Lint | Aprovado nos módulos e scripts envolvidos; reexecutado nos últimos scripts ajustados. |
| Build | Aprovado em cópia limpa com webpack. A primeira tentativa falhou exclusivamente no download de Google Fonts bloqueado pelo sandbox; repetição autorizada com rede passou. |
| Navegador com login/API reais no clone automatizado | Desktop/tablet/celular aprovados: perfis, Central, Buffet, Checklist, cancelamento, invalidação/recriação, histórico, conflito com rascunho preservado e navegação. Zero erros JavaScript. |
| Navegador no clone manual3017 | Seis verificações aprovadas em desktop e celular: contrato correto, Financeiro visível, Alterações visível, retorno, histórico humano e horário amigável. Inclui restauração tardia de scroll e respeito à interação do usuário. Dados lidos em READ ONLY e respostas/sessão visuais simuladas nesse teste específico. |

Os testes mutantes usaram exclusivamente clones automatizados. O clone manual foi consultado em transação de leitura; seu servidor foi reiniciado para carregar a flag explícita. PostgreSQL não foi reiniciado.

Evidências principais: `regressions.json`, `unitarios.log`, `simplificacao-integration.json`, `vigencia.json`, `buffet-integration.json`, `ambiente-producao.json`, `browser.json`, `clean-build.json` e `preproducao-preservacao.json`, em `.local-festa/results`; navegação em `.local-festa/ux-final/resultado-manual.json`. Capturas desktop/tablet/mobile foram geradas e inspecionadas.

## 7. Preservação e limite desta entrega

O banco real `kidmais_manager` foi acessado apenas para SELECT em transação READ ONLY, com `default_transaction_read_only=on`. A conferência física confirmou ausência de todas as tabelas Festa, das seis colunas Buffet novas e das funções festa016; as três funções contratuais continuam nas definições anteriores à 016.

O backup pré-016 foi usado como checkpoint do ciclo estrutural no clone. Ele não representa todos os registros atuais do banco real: existem registros posteriores, incluindo auditoria. Por isso não se declara igualdade de dados atuais com aquele backup antigo. Os hashes atuais das 52 tabelas foram capturados e comparados entre duas leituras desta validação final.

Migrations012/013/014/015 e `schema_mvp_kidmais.sql` foram comparados ao manifesto protegido. Migration016 e seu rollback foram comparados byte a byte ao checkpoint desta revisão e permanecem intactos. Nenhuma migration, DDL, DML ou backfill foi executada no banco real. A aplicação real da 016 não está feita nem autorizada por esta entrega.
