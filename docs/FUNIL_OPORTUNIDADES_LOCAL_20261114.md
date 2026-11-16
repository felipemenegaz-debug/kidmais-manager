# Funil de oportunidades — implementação local (14/11/2026)

Estado atual: correções dos **P2-1, P2-2, P3-3 e P3-4 da R1 implementadas LOCALMENTE**, aguardando a rodada 2 (última da classe A). A reprovação da R1 permanece como registro histórico; esta correção não constitui aprovação independente. Base `2133d398f02f519170b443b5702c6b23b9da41b7`, branch `codex/funil-oportunidades-20261114`. Nenhum commit, push, PR, merge, deploy, acesso aos serviços/bancos reais ou envio real nesta correção. A reconferência remota citada nas validações originais pertence à implementação anterior, não foi repetida nesta rodada.

Correção atual e provas: [registro da rodada](evidencias/funil-r2-20261114/VALIDACAO.md). [Prompt pronto da última revisão](PEDIDO_ASTRA_FUNIL_20261114_R2.md). As seções de validação original abaixo preservam o histórico da primeira implementação.

Especificação: nota aprovada `Funil de oportunidades proposta 20261114.md`, no Obsidian. A aprovação do topo incorpora responsável, resumo por e-mail e sugestão após 14 dias; prevalece sobre o trecho histórico da proposta que excluía e-mail. A fila recebeu durante a tarefa a decisão de priorizar Área da família antes do Funil: esta entrega permanece local e atrás dela para a integração.

## Entrega

- `/admin/oportunidades`, item próprio de Operação: quatro colunas derivadas dos estados persistidos, quantidades e valores, lista de hoje/atrasadas, filtro por responsável, alerta sem ação, sugestão de perda sem encerramento automático e contadores do mês.
- Ações manuais: Ligar, WhatsApp, Enviar proposta, Visita e Cobrar, data, responsável e observação opcional. Índices parciais permitem uma ação pendente por alvo. Trocar a ação preserva a anterior; concluir só acontece junto de outra ação ou de perda, na mesma transação. ID esperado impede sobrescrever uma alteração concorrente.
- Perda exige motivo fixo e grava observação opcional/data. Contato sem cliente é vinculado/criado pelo mecanismo de deduplicação já existente antes de registrar o histórico. O descarte antigo e o cancelamento contratual antes da formalização também exigem a classificação.
- Negociação com contrato não assinado repete as proteções do fluxo existente: Gestão, `FESTA_CORRIGIR`, ausência de assinatura do cliente, versão vigente, Festa e pagamento; preparação aberta é cancelada pelo serviço existente. Contrato assinado continua no cancelamento de contrato/Festa. A ação de perda do funil recusa estados de Sinal e qualquer assinatura/financeiro incompatível.
- A ação do contato acompanha a negociação na criação/vinculação pelos serviços alterados. A vinculação explícita seleciona somente aquele contato; na criação sem contato vinculado, a ação mais recente identifica o contato convertido, que recebe `fechamento_id` e status CONVERTIDO. Outros contatos sem vínculo do mesmo cliente continuam independentes. A negociação define o responsável após a conversão (herda o da ação apenas se estiver sem responsável), com registro dos responsáveis anterior/final no histórico. Nenhum cartão é arrastável.
- Histórico por `registrarEventoHistorico`: agendamento/substituição, conclusão, conversão da ação e perda.
- Marketing recebeu bloco de perdas agrupadas por motivo e origem e conversão de cada etapa. Contagem sem denominador aparece como “Sem base”.
- “Em contratação” da Central de Festas agora é link para Oportunidades; os cartões no perfil do cliente continuam existindo.

## Banco e segurança

Migration candidata **122**, nova, com precheck/postcheck/down, incluída no inventário e no modelo descartável. Na abertura e no encerramento, staging continuava em `2133d398`; PRs abertas #383 e #389 não contêm SQL novo. A busca dos clones na abertura não encontrou 122; a frente Área da família anunciou 123 depois. Isso é uma conferência datada, não uma reserva global: repetir antes de integrar/aplicar.

Decisão (duas linhas): `oportunidades_acoes` separa tarefa comercial manual do ciclo de automações, sem tornar `execucao_id` opcional nem mudar seus invariantes.
Preserva as ações encerradas e usa unicidade parcial por contato/negociação para manter somente o próximo passo pendente.

As demais estruturas são `oportunidades_marcos` (primeira observação de cada etapa real) e `oportunidades_resumos` (fotografia/idempotência técnica do e-mail). Colunas de perda nas duas entidades e responsável no contato; negociação reutiliza `usuario_responsavel_id`. Leituras e escritas filtram o tenant comprovado; gatilho rejeita ação vinculada a contato/negociação de outra empresa e responsável sem membership ativa. Ações e marcos entram na exportação por empresa; o controle técnico dos e-mails fica explicitamente fora do pacote.

Permissões e plano do Marketing foram reutilizados: visualizar exige `MARKETING_VISUALIZAR`, escrever exige `MARKETING_CAMPANHAS_EDITAR`; Gestão continua sujeita ao tenant. A tela não amplia o acesso de Equipe aos contatos protegidos. Responsáveis selecionáveis também precisam de acesso ao Marketing. Cancelamento de negociação exige Gestão; com contrato, exige ainda a capacidade do cancelamento existente.

## Sem inventar passado

- A etapa atual é derivada do estado, sem coluna editável de etapa.
- A instalação registra somente a etapa atualmente comprovada; mudanças futuras registram os novos marcos. Não presume que uma negociação importada passou por todas as etapas anteriores.
- Conversões de negociação: entradas observadas na etapa de origem dentro do período, acompanhadas até a consulta. Só conta o destino observado depois da origem; etapas puladas não são inventadas. Contato → proposta usa vínculo explícito ou negociação posterior do mesmo cliente/empresa.
- `confirmada_em` é gravada quando o estado muda para `CONFIRMADO`. Confirmações antigas sem data conhecida são mostradas separadamente e não atribuídas a um mês arbitrário.
- Perdas históricas sem classificação não recebem motivo inventado. O relatório inclui as perdas registradas com data/motivo a partir desta entrega.

## Resumo diário por e-mail

Chave `OPORTUNIDADES_RESUMO_EMAIL=true`; ausente/desligada não consulta nem envia. Transporte é `criarEnviarEmail`, já existente. Endpoint POST `/api/integracoes/oportunidades/resumo` exige `OPORTUNIDADES_RESUMO_SECRET` próprio (32+ caracteres) em `x-kidmais-worker-secret`.

Entrada para um agendador diário: `node scripts/oportunidades-resumo-diario.mjs`, com a mesma chave e `OPORTUNIDADES_RESUMO_URL` apontando para esse endpoint. O script exige HTTPS fora de loopback, recusa redirecionamento e não abre rede com a chave desligada. **Nenhum agendador, segredo ou variável real foi configurado.**

A fotografia fica persistida antes do envio e a chave é empresa/usuário/dia em São Paulo. Tenant, usuário, plano, permissão e ações atribuídas são revalidados antes de enviar; fotografia obsoleta é suprimida. O mesmo conteúdo usa a mesma chave do provedor. Falha do transporte fica `FALHOU`, sem repetição automática naquele dia; conferir o provedor antes de decidir qualquer reenvio, pois aceitação pode ser incerta. Não há WhatsApp real nem lembrete por WhatsApp.

## Aplicadores preparados, não executados remotamente

- `scripts/migration-122-comum.cjs` e adaptadores `migration-122-staging.cjs` / `migration-122-production.cjs`.
- Sem argumentos: plano offline, verificando os três hashes em `migration-122-hashes.json`.
- `--conferir-122`: conexão no alvo fixo do adaptador e checks em READ ONLY.
- `--aplicar-122-autorizado --backup <registro>`: exige alvo/TLS/identidade/disco do padrão existente, backup e marcador exclusivo; precheck → corpo → postcheck → COMMIT → reconferência. Nunca executa down.
- Código de saída 0 sucesso; 1 recusa anterior ao marcador; 2 falha registrada. COMMIT incerto é `INDETERMINADO`: preservar marcador/saída e reconciliar; não repetir por tentativa.
- Implantação futura precisa coordenar banco/código: os fluxos antigos de descarte e cancelamento antes da formalização também usam a 122. O down recusa quando existe evidência nas estruturas/colunas novas. Reversão operacional preserva o histórico; não apaga dados comerciais.

O genérico atual de production tem lista fechada para outras migrations; portanto não foi estendido para esta entrega. Os adaptadores novos reutilizam as guardas de conexão existentes.

## Validações executadas

Runtime observado: Node 24.20.0 e npm 11.19.0; o package.json declara Node 22.23.2, e o npm avisou essa diferença. Esta rodada não reproduziu as provas no Node 22.23.2.

Todos os comandos de aplicação/teste foram iniciados com `env -u DATABASE_URL -u KIDMAIS_HOMOLOGACAO_DATABASE_URL`; a demo monta o ambiente filho por lista explícita, injeta exclusivamente a conexão sintética e confere a identidade do servidor. Não foram lidos `.env*` reais.

1. `npm run check:v1:static` **completo, versão final**: 5.015/5.015 testes unitários, 103/103 do harness staging sem rede/banco, ESLint sem erros (4 avisos existentes), TypeScript, build e leitura do worker PDF aprovado. [Log](evidencias/funil-20261114/static-completo.log).
2. `check:v1:postgres`, selecionando a suíte `lib/oportunidades/funil.postgres.test.ts` no modelo 122: a receita construiu o schema com pre/postchecks; suíte aprovada, nenhuma ordem fora do padrão na guarda de escritores e nenhuma falha no encerramento. **Não foi executada a suíte PostgreSQL inteira do repositório.** [Log](evidencias/funil-20261114/postgres-runner.log).
3. Provas PG: A/B não veem nem alteram oportunidade/ação/motivo um do outro; responsável de B recusado em A; papel global não contorna concessão na empresa; FK/gatilho contra vínculo cruzado; unicidade de ação; conflito de ID esperado; conclusão sem próxima ação recusada; perda sem motivo recusada; eventos de histórico; sugestão de 14 dias; mudanças de etapa e confirmação mensal; assinatura real bloqueia a perda; contrato ainda sem assinatura pode ser cancelado com motivo; transferência da ação e supressão do cartão convertido; e-mail injetado simulado com isolamento e idempotência diária.
4. Aplicadores: plano offline/hashes e recusa de alvo local antes da conexão. Aplicadores de staging/production não conectaram a ambientes remotos; o SQL novo foi validado pela receita sintética.
5. Navegador real em `localhost:3794`: login fictício, criar “Família Girassol (teste)”, agendar ligação, “Feito” com WhatsApp seguinte, registrar “Preço”, conferir 1 perda no relatório. Desktop e 390 px; capturas só do conteúdo da demo. [Funil](evidencias/funil-20261114/01-funil.jpg), [perda](evidencias/funil-20261114/02-perda.jpg), [relatório](evidencias/funil-20261114/03-relatorio.jpg), [celular](evidencias/funil-20261114/04-celular.jpg).

Cluster PostgreSQL 18 exclusivamente em `E:/kidmais-pg-descartavel/funil-oportunidades`, porta **55814**. Servidor da demo encerrado e cluster apagado após guardar evidência. Nenhuma porta 5432/5433 usada. [Ambiente da demo](evidencias/funil-20261114/demo-ambiente.json).

## Falhas encontradas e tratadas

- Porta inicial 55714 ocupada: não tocada; cluster desta tarefa iniciado em 55814.
- CRLF do clone fez o postcheck antigo da 116 e checksums de assets falharem. Conteúdo local convertido para LF, sem delta semântico fora dos arquivos da tarefa; `core.autocrlf=input` somente neste clone.
- Testes antigos pressupunham a aba de cartões na Central e não conheciam a nova dependência da lista de motivos; contratos de teste atualizados. O carregador de testes passou a informar `fileName` ao TypeScript para não interpretar genéricos de `.ts` como JSX ao carregar os serviços reais.
- Consulta inicial de destinatários usava DISTINCT com ORDER BY de outro tipo; corrigida. Pasta do marcador de production passou a respeitar o sufixo `-producao` exigido pelo helper.
- Duas rodadas estáticas iniciais falharam durante a implementação; as rodadas completas posteriores e a final passaram.
- O navegador integrado teve timeouts de criação/navegação e a sessão de desenvolvimento foi refeita após atualização do código; a recarga completa estabilizou a conferência. O fluxo funcional foi observado e capturado. Não foi alterada autenticação para contornar isso.

Não há falha obrigatória de validação em aberto. Revisão independente classe A continua pendente. Não foram executados testes de carga, matriz completa de planos/unidades, mutantes, agendador real ou entrega real de e-mail. Não se declara homologação/publicação.

## Integração com a outra frente

O clone `kidmais-manager-marketing-simplificacoes-20261114` foi apenas lido e preservado. Sobreposição comunicada antes de implementar: `lib/admin/navegacao.ts` e teste, `lib/marketing/contatos.ts`, `lib/fechamentos/services/fechamento.service.ts`, `components/admin/marketing/MarketingOrigens.tsx`, `MarketingVisao.tsx` e seleção de testes. A transferência da próxima ação deve ser conservada ao integrar a conversão automática dos contatos da outra frente. A maior parte da interface, consultas e relatório do funil está em arquivos novos para reduzir conflitos.

## Próximos passos

Revisão do Astra com todos os achados de uma vez, no máximo duas rodadas; somente P1/P2 reproduzíveis bloqueiam. P3 vira pendência. Depois, integração local com as simplificações/Área da família conforme a fila. Commit, PR, migrations em ambientes reais, deploy e ativação/agendamento de e-mail dependem de instrução específica posterior de Felipe.

Limpeza final e manifesto de arquivos são registrados nas evidências e na nota do vault. Reabrir após a limpeza exige `npm ci` e build; o código, Git e provas são preservados.

## Limpeza concluída

Limpeza concluída: servidor localhost:3794 encerrado (porta livre), cluster E:/kidmais-pg-descartavel/funil-oportunidades parado/apagado, node_modules e os dois builds removidos pela rotina oficial (0,74 + 0,29 = 1,03 GB em dependências/builds, além do cluster). Credencial sintética removida. Código, Git, scripts de reprodução e relatórios/capturas preservados; npm ci/build serão necessários para retomar.

## Correção extra autorizada por Felipe — P2-R2-1 — 14/11/2026

Após a reprovação da R2, Felipe autorizou explicitamente uma única correção/revisão extra restrita à herança de origem/campanha e regressões em conversão/atribuição. Estado: corrigido e validado LOCALMENTE pelo implementador; revisão independente extra pendente. Os pareceres anteriores permanecem históricos, sem aprovação implícita.

O bloco existente de vínculo/herança de contatos.ts foi extraído para lib/marketing/conversao.ts:7; o caminho manual (contatos.ts:315) e o Funil (oportunidades/conversao.ts:25) usam a mesma implementação e transação. A repetição do mesmo vínculo retorna sucesso, sem duplicar atribuição; outro vínculo segue recusado. Atribuições anteriores são preservadas. O módulo homônimo da frente de simplificações, ausente neste clone até aqui, exige reconciliação na futura integração; não foi importada aquela frente.

Provas: dois casos PostgreSQL (cliente novo/recorrente) falharam antes por origem ausente e passaram depois; verificam campanha/origem, contato convertido, ação/responsável, repetição e painelMarketing real. Suíte inteira do funil e Marketing selecionado: 44 testes/subtestes PG finais aprovados em cinco arquivos; 26 unitários selecionados aprovados. Static completo: 5.017 testes + 103 harness, lint (0 erros/4 avisos existentes), TypeScript, build e worker PDF PASS. Não foi executada toda a suíte PG do repositório. Runtime Node24.20.0/npm11.19.0; Node22 declarado não repetido.

Falhas intermediárias: fixture inicial com campo errado, seleção por prefixo recusada, expectativa legada409 incompatível com a nova regra; corrigidas e reexecutadas. Guarda de escritores registrou avisos nos testes Marketing modelo086, anteriores à114. Logs mantidos, inclusive a execução combinada que falhou antes da atualização do teste legado; repetição Marketing A passou9/9. Não há falha obrigatória final.

PG18 exclusivamente descartável em E:/kidmais-pg-descartavel/funil-oportunidades, porta55814, parado e apagado. Comandos com env -u DATABASE_URL -u KIDMAIS_HOMOLOGACAO_DATABASE_URL. Sem navegador nesta correção; fixtures chamam o gancho real, não o formulário completo. Sem commit/push/PR, ambiente real ou envio. Migrations/rota de resumo preservadas.

Provas e hashes novos: docs/evidencias/funil-extra-20261114; pacote R2 preservado como fotografia histórica. Pedido da revisão restrita: docs/PEDIDO_ASTRA_FUNIL_EXTRA_20261114.md. Área da família permanece antes do Funil.

Limpeza desta correção concluída pela rotina oficial: node_modules/.next removidos (0,73 GB); cluster já apagado. A primeira simulação não conseguiu listar processos no sandbox; repetição autorizada com acesso à listagem passou. Código, Git, evidências e vault preservados.
