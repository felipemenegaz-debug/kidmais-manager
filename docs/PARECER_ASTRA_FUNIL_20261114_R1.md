# Parecer independente — Funil de oportunidades — rodada 1

Data: 14/11/2026. Revisor: Astra (agente independente da implementação). Classe A, somente LOCAL.

**Resultado: REPROVADO nesta rodada por dois P2 reproduzíveis. Nenhum P1 identificado. Dois P3 não bloqueantes.** Todos os achados desta rodada estão abaixo; não houve correção da implementação, commit, push, PR, merge, conexão remota ou banco real. Este parecer não autoriza publicação.

Base examinada: `2133d398f02f519170b443b5702c6b23b9da41b7`, branch `codex/funil-oportunidades-20261114`. Diff rastreado e arquivos novos incluídos; cobertura dos 45 itens do manifesto, incluindo SQL/checks/down, aplicadores, serviços, rotas, UI, testes e documentação. Conferência independente: **45/45 SHA-256 iguais** ao manifesto. As mudanças existentes não foram sobrescritas. Instruções do workspace/checkout, política operacional, proposta aprovada e fila vigente consultadas. Área da família permanece antes do Funil.

## Achados bloqueantes

### P2-1 — Um novo contato de cliente antigo desaparece do funil

Local principal: `lib/oportunidades/consultas.ts:9`. O bloqueio equivalente está em `lib/oportunidades/service.ts:38` (consulta de contato com qualquer negociação); a API nova vincula o cliente em `app/api/admin/oportunidades/route.ts:30` usando a identificação por telefone/e-mail existente.

Reprodução concreta: cliente A tem uma negociação CONFIRMADO iniciada em 01/01/2025. Em 14/11/2026, registrar novo contato para outra festa, usando seu telefone. O contato novo fica EM_ATENDIMENTO, `cliente_id=A`, `fechamento_id=NULL`. Consultar Oportunidades.

Esperado: o contato da nova oportunidade aparece até ser convertido/vinculado a uma negociação correspondente. Observado: zero cartões desse contato, porque o `NOT EXISTS` considera **qualquer** fechamento do cliente, mesmo antigo e encerrado. O fechamento CONFIRMADO também não aparece nas colunas abertas. Tentar agendar diretamente no contato é recusado pela mesma premissa no serviço. A conversão do relatório, ao contrário, já exige negociação posterior ao recebimento para o vínculo inferido.

Consequência: retorno de cliente desaparece imediatamente após cadastro; não se consegue trabalhar sua próxima ação/perda pela tela solicitada. Não é apenas duplicidade visual. A correção precisa alinhar leitura, mutação e herança com a identidade/temporalidade da oportunidade, preservando negociações de festas anteriores.

Prova própria `retorno-cliente`: executa o primeiro braço **extraído do SQL real**, retirando apenas casts PostgreSQL, no SQLite em memória. Resultado: um contato sem vínculo explícito, zero cartões. Não é prova PostgreSQL; a falha depende apenas de igualdade/EXISTS, sem diferença de dialeto relevante.

### P2-2 — A conversão transfere a ação, mas troca o responsável nos resultados mensais

Local principal: `lib/oportunidades/conversao.ts:15`. Consumidores inconsistentes: `lib/oportunidades/consultas.ts:17`, `:42` e `:46`.

Reprodução concreta: contato tem próxima ação atribuída ao vendedor B; criar/vincular negociação cujo `usuario_responsavel_id` é A (ou NULL). A herança transfere a ação para o fechamento. Sem reagendar a ação, registrar perda ou confirmar essa negociação e consultar os contadores com filtro de B.

Esperado: o responsável apresentado no cartão e usado no filtro continua coerente com a atribuição dos resultados, ou o produto distingue explicitamente responsável da negociação e executor da ação. Observado: enquanto aberta, a oportunidade aparece para B por `coalesce(p.responsavel_id,a.responsavel_id)`; a herança só muda contato/fechamento da ação e conserva `usuario_responsavel_id=A`. Depois da perda/fechamento, os contadores usam exclusivamente A (ou NULL): B recebe zero, A recebe um. O agendamento normal atualiza ambos, mas a herança não.

Consequência: vendas/perdas aparecem atribuídas a pessoa diferente da apresentada no funil, sem intervenção do usuário. Com responsável NULL, desaparecem de todos os filtros individuais.

Prova própria `responsavel-conversao`: executa `herdarAcoesDoContato` real, removendo somente tipos/imports e injetando executor/histórico falsos. Única escrita comercial observada: UPDATE da ação; responsável da ação B e da negociação A permanecem distintos. A consequência nos contadores é demonstrada pelos predicados SQL citados, não por execução PostgreSQL.

## Pendências não bloqueantes

### P3-1 — Usuário somente leitor recebe botões de edição que sempre falham

Local: `components/admin/oportunidades/Oportunidades.tsx:19`, `:24` e `:33`; contrato GET em `app/api/admin/oportunidades/route.ts:18` não devolve capacidades.

Reprodução: membership Equipe com apenas MARKETING_VISUALIZAR, plano habilitado. GET funciona; “Novo contato”, “Feito” e “Ação ou perda” são habilitados por `pronta`, sem capacidade de escrita. Preencher e enviar termina em 403 no POST, que exige MARKETING_CAMPANHAS_EDITAR. Esperado: ações indisponíveis/omitidas para leitura, antes de preencher. Consequência: trabalho perdido e interface enganosa; **a autorização do backend está preservada**. Prova por fluxo de código, sem navegador nesta revisão.

### P3-2 — Resumos de empresas diferentes não identificam a empresa ao destinatário

Local: `lib/oportunidades/resumo.ts:12–13`.

Reprodução: mesmo usuário tem ações atribuídas em duas empresas. São geradas mensagens separadas com chaves distintas por empresa, mas assunto/cabeçalho não contêm nome/identificador da empresa e o texto remete genericamente ao painel. Com nomes/tipos/datas iguais, os corpos são idênticos. Esperado: identificar a empresa e orientar a abertura no contexto correto. Consequência: aparência de duplicidade e risco operacional de procurar a ação na empresa errada. Não constitui vazamento cross-tenant: o destinatário precisa de acesso em cada empresa.

## Ordem 123 → 122: conclusão por camada

**Não é necessário trocar os números antes do PR para tornar a Área independente.** O número maior não exige os menores neste projeto. É necessário preservar e documentar a ordem real de integração/aplicação, e validar a candidata combinada depois da integração.

1. **Schema SQL:** a 123 atual do clone `kidmais-manager-area-familia-20261114` cria pessoas/links/sessões/eventos/limites e amplia `validacoes_identidade_cliente`. Seus pré-requisitos são estruturas anteriores, inclusive a 112; precheck e corpo não referenciam tabelas/colunas/funções da 122. A 122 tampouco depende da 123. Assim, por análise das dependências SQL, 123 pode ser aplicada sem 122. Não executei essas migrations nesta revisão.
2. **Inventário:** `scripts/production/check-migrations.mjs:278–294` valida pertencimento/unicidade na lista explícita `approvedFiles`; não exige sequência numérica contígua. O inventário atual da Área inclui 123, não inclui 122 e passou `inspectInventory` com **zero blockers** em prova própria. `latest` é o último nome ordenado, não versão aplicada no banco; `appliedState` permanece unknown.
3. **Receita:** `scripts/regressao-v1-postgres-receita.cjs:282–289` escolhe o **prefixo pela posição em approvedFiles**, não `id <= alvo`. A Área tem modelo 123 sem 122. Ao integrar Área primeiro, conservar append 123 → 122 faz o modelo 123 continuar sem 122 e o modelo 122 incluir ambas. Reordenar por número muda a composição dos modelos e exige rever testes; não basta resolver o conflito alfabeticamente. A prova registra ambos os arrays/prefixos sem criar banco.
4. **Aplicadores/ferramentas:** o aplicador dedicado 122 confere somente dependências/estado da própria 122, alvo, hashes, privilégios e marcador. Não recusa 123 já presente. Os aplicadores genéricos antigos têm lista fechada; não passam a executar 122/123 porque o inventário mudou. Não há aplicador dedicado 123 no checkout da Área inspecionado: sua futura operação ainda precisa de roteiro/ferramenta próprios e autorização. Nenhum adaptador remoto foi executado.
5. **Exportação:** `migracao:'122'` é metadado de entidade posterior/ausente, não uma condição “versão máxima >= 122”. A exportação lê tabelas reais, inclui ações/marcos por empresa e exclui o controle técnico dos resumos. A Área atual tem decisões explícitas para suas cinco tabelas novas em FORA_DO_ESCOPO. Na integração, preservar as decisões de **ambos** os inventários; se perder uma, a guarda de tabela desconhecida pode recusar o pacote. Nenhuma exigência numérica da exportação força renomear.

Manter 123 para Área e 122 para Funil é tecnicamente possível. Trocar números seria uma opção de organização, com atualização de SQL/checks/down/hashes/adaptadores/receita/documentação, não correção obrigatória desta revisão. Nenhuma integração foi realizada aqui.

## Endpoint de resumo: autoridade, isolamento e entrega

- POST `/api/integracoes/oportunidades/resumo` é um endpoint de worker: **quem possui o segredo dedicado válido pode acioná-lo para todas as empresas elegíveis**. Não exige sessão de usuário nem papel Gestão; isso é intencional no desenho. Sem segredo de 32+ caracteres ou com header incorreto retorna 401. Usa comparação de SHA-256 em tempo constante de `secretMatches`. Não aceita tenant/destinatário do corpo.
- Flag ausente/diferente de `true`: rota retorna 409 após autenticação, serviço não consulta nem envia e script diário não abre rede. Prova própria confirmou zero chamadas no serviço desligado. Nenhum segredo/agendador foi configurado.
- Candidatos vêm de ações em empresas ATIVA; `withTenantTransaction` comprova usuário ativo, empresa e membership, relê papel persistido, trava usuário/empresa/membership e revalida no fim. Plano MARKETING e capacidade VISUALIZAR são exigidos nas duas transações. Consultas usam empresa comprovada e responsável, não papel global fictício usado na estrutura de sessão do worker.
- Uma mesma caixa postal pode legitimamente receber um resumo **por empresa**: PK e chave de provedor são empresa/usuário/dia em São Paulo. Não se deve deduplicar entre tenants pelo e-mail. A ambiguidade visual está no P3-2, não na chave de idempotência.
- Fotografia persistida em uma transação; envio em outra sob lock da linha de resumo. Revalida e-mail, plano, permissões e conjunto dos IDs das ações. Mudança de ação/atribuição remove o ID elegível e torna a fotografia OBSOLETO. A checagem não compara todos os textos (por exemplo, renomear cliente conserva a fotografia); não considero isso bloqueante para uma fotografia diária.
- Duas execuções concorrentes não devem enviar duas vezes após commit normal: PK + locks do tenant/registro serializam o consumo. Prova própria com transações serializadas em memória deu um envio em duas invocações; **não é ensaio de concorrência PostgreSQL**.
- Transporte falhou: FALHOU fica persistido, sem retry automático naquele dia. Prova própria: uma tentativa em duas invocações. Isso pode perder o lembrete em falha transitória, mas corresponde ao contrato documentado de não reenviar com aceitação incerta.
- Crash/rollback após aceite: pode haver nova chamada ao transporte, com a mesma chave e conteúdo persistido. Prova própria simulou rollback após envio e mostrou duas chamadas idênticas. A proteção contra duas entregas depende da idempotência do provedor existente; **não há garantia de exactly-once no banco**, nem entrega real validada nesta rodada. O transporte existente passa Idempotency-Key ao Resend; não foi invocado nem pesquisado remotamente.
- O envio ocorre segurando a transação e locks de tenant; transporte possui timeout. Não houve prova de carga/latência. Nenhum novo achado P1/P2 do endpoint foi reproduzido nesta rodada.

## Demais verificações

Próxima ação: comparação do ID esperado sob trava do alvo, unicidade parcial de ação aberta, conclusão atômica com próxima ação/perda e validação de responsável. Perda: lista fixa, observação limitada, encerramento de ações e eventos; caminhos alterados de descarte e cancelamento pré-assinatura requerem motivo. Cancelamento do funil exige Gestão, recusa Sinal, trava contrato/fluxo e rejeita assinatura do cliente/Festa/financeiro; capacidade FESTA_CORRIGIR é mantida quando existe contrato. Histórico usa o repositório comum; conversão preserva ações encerradas e escolhe a mais recente. Nenhum bypass cross-tenant foi encontrado por leitura dos serviços e suas guardas. Isso não substitui prova PG independente de toda a matriz.

Etapas são derivadas; marcos não inventam passagens anteriores. Relatório acompanha entradas observadas até a consulta, com destino posterior à origem; confirmações antigas sem data ficam separadas. Os dois P2 acima são as inconsistências de oportunidade/responsável reproduzidas nesta rodada.

Migration/checks/down examinados: mudanças aditivas; índice parcial e gatilho de vínculo/tenant; rollback recusa evidência comercial. SQL revisado por hashes. Aplicador usa marcador exclusivo `wx`; prova com filesystem e Client falsos mostrou marcador anterior inalterado, saída 1 e nenhuma transação de escrita. Outra prova simulou desconexão no COMMIT: saída 2, INDETERMINADO preservado no marcador. Não houve escrita em disco de marcador operacional nem conexão.

## Provas próprias, limites e encerramento

Comando: `node docs/evidencias/astra-funil-r1/provas.cjs` — **PASS, 9 provas/grupos**, Node 24.20.0. [Código](evidencias/astra-funil-r1/provas.cjs) e [resultados](evidencias/astra-funil-r1/resultado.json). O script remove DATABASE_URL e KIDMAIS_HOMOLOGACAO_DATABASE_URL antes das cargas; só dados sintéticos. A primeira execução do harness falhou por import ESM de caminho Windows; corrigido para file URL no próprio harness, sem alteração da implementação; reexecução passou. `git diff --check` passou.

Não reinstalei dependências, não executei build/static integral, suíte PG ou navegador. Os logs e capturas do implementador foram considerados evidência dele, **não execução minha**. Não executei Node 22.23.2 declarado pelo projeto; runtime próprio foi 24.20.0. SQL portável em SQLite e executores falsos não validam gatilhos, locks, constraints ou planos PostgreSQL. A Área foi inspecionada somente para a questão de dependências/ordem, sem parecer de segurança de sua F1.

Limpeza: nenhuma dependência, build, servidor, cluster ou pasta temporária foi criada. Somente este parecer e provas/resultados preserváveis foram acrescentados; nada a remover. A regra/skill de limpeza foi consultada, sem aplicar remoção sobre artefatos alheios.

Próximo passo: corrigir P2-1/P2-2 localmente, acrescentar regressões pertinentes e reapresentar rodada 2 com novo manifesto. P3 pode ficar registrado como pendência. Vault/relato serão consolidados uma vez pelo agente pai, conforme coordenação; não foram duplicados nesta revisão.
