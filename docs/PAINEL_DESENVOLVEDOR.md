# Painel do desenvolvedor (04/10/2026)

Branch `feat/painel-desenvolvedor-20261004` (base `origin/staging` 904b451), PR #95 para `staging`.
Migration 063 **não aplicada em staging nem em production**; validada só em cluster descartável sintético. Envio real de e-mail desligado (D1 pendente): convites e recuperação **não são declarados operacionais** sem validação de entrega.

## Estado atual (investigado)

- Identidade global `usuarios_administrativos` (papel global `ADMINISTRATIVO` | `REPRESENTANTE_AUTORIZADO`, hash scrypt em `lib/autenticacao/senha.ts`, política 8–128 caracteres).
- Sessão `sessoes_administrativas`: token SHA-256, 8 h absolutas, 30 min de inatividade; `consultarSessao` já invalida sessões com `autenticado_em < senha_alterada_em`.
- Acesso a empresa = `memberships` (papel por empresa desde a 056). Ciclo pela 045: PENDENTE→ATIVA|REVOGADA, ATIVA→REVOGADA; REVOGADA é terminal e ocupa o par (empresa, usuário).
- `empresas` pela 044: PROVISIONAMENTO→ATIVA|DESATIVADA, ATIVA→SUSPENSA|DESATIVADA, SUSPENSA→DESATIVADA. **Sem reativação.**
- `provarTenant` só aceita membership ATIVA em empresa ATIVA, travando usuário→empresa→membership em cada requisição.
- Autoridade de plataforma hoje = papel global `REPRESENTANTE_AUTORIZADO` (`lib/autenticacao/plataforma.ts`). O mesmo papel é o de Gestão das empresas legadas, então **não distingue desenvolvedor de proprietário**.
- Não existem: troca de senha no app, recuperação de senha, convites, envio de e-mail, cadastro de interessadas, página de perfil do usuário.
- Auditoria: `auditoria` imutável (`registrarAuditoria`), sem coluna de empresa (vai no jsonb).

## Extensão mínima de permissões

Tabela nova `plataforma_desenvolvedores` (concessão por usuário, revogável, nunca apagada). Concessão e revogação **somente pelo CLI** `scripts/admin-provision.cjs desenvolvedor` (o app não tem rota que escreva nela — teste estático garante). Papel de empresa e papel global continuam como estão: ser Gestão/proprietário de qualquer empresa não concede o painel.

Guarda única `exigirDesenvolvedor` (sessão válida + concessão ativa + identidade ativa, consultados no banco a cada requisição) em todas as APIs `/api/desenvolvedor/*` e no layout de servidor de `/desenvolvedor` (sem concessão → 404, sem sessão → login). Operações de efeito (provisionar, suspender/reativar, papel, desativar vínculo) exigem reautenticação recente (5 min, padrão já usado em Perfil).

## Telas

| Rota | Conteúdo |
|---|---|
| `/desenvolvedor` | Resumo: interessadas por status; contratantes em implantação, ativas e suspensas; aguardando primeiro acesso; convites pendentes; atividades administrativas recentes (só metadados). |
| `/desenvolvedor/interessadas` | Lista com busca e filtros, cadastro, detalhes, edição, histórico de status, aviso de duplicidade, "Provisionar como contratante" (confirmação com dados e efeitos). |
| `/desenvolvedor/empresas` | Contratantes com busca e filtro por situação/implantação. |
| `/desenvolvedor/empresas/[id]` | Ficha (cabeçalho fixo com a empresa administrada): dados administrativos, implantação, suspender/reativar, usuários e vínculos, convites, recuperação de senha, atividade da empresa. |
| `/admin/perfil` | Troca da própria senha (todo usuário autenticado). |
| `/acesso/convite`, `/acesso/recuperar`, `/acesso/redefinir` | Públicas: aceitar convite, pedir recuperação (resposta neutra), definir nova senha. |

## Checklist de implantação e alertas (07/10/2026)

Ver [PAINEL_ALERTAS_IMPLANTACAO_20261007.md](PAINEL_ALERTAS_IMPLANTACAO_20261007.md).

## Modelo de dados — migration 063 (com rollback, pre/postcheck e inventário)

1. `plataforma_desenvolvedores(id PK, usuario_id, concedido_em, concedido_por, motivo, revogado_em, revogado_por, motivo_revogacao)` — no máximo uma concessão ativa por usuário (índice parcial `kidmais_063_dev_ativo_uk`); sem DELETE; nova concessão = nova linha. Concessão e revogação só por `node scripts/admin-provision.cjs desenvolvedor` (auditadas, `origem = CLI_PROVISIONAMENTO`).
2. `plataforma_interessadas(id, nome, nome_empresarial, documento_fiscal (só dígitos, CPF/CNPJ), responsavel_nome, email, telefone, status NOVA|EM_CONTATO|PROPOSTA|CONVERTIDA|DESCARTADA, observacoes, empresa_id, criado_por, criado_em, atualizado_em, revisao)` — únicos parciais por documento e por e-mail entre as não descartadas; conversão só por provisionamento.
3. `plataforma_empresas_cadastro(empresa_id PK, nome_empresarial, documento_fiscal, responsavel_nome, email, telefone, observacoes, interessada_id, implantacao AGUARDANDO_PRIMEIRO_ACESSO|EM_CONFIGURACAO|CONCLUIDA, ...)` — dados comerciais fora de `empresas` (cujo guard fica intacto, exceto o item 6).
4. `convites_acesso(id, empresa_id, email, papel, token_hash UNIQUE, status PENDENTE|ACEITO|CANCELADO, expira_em, envios, ultimo_envio_em, criado_por, aceito_em, aceito_usuario_id, cancelado_em, cancelado_por)` — um pendente por (empresa, e-mail); "expirado" é derivado de `expira_em`.
5. `recuperacoes_senha(id, usuario_id, token_hash UNIQUE, origem PUBLICA|PAINEL, solicitado_por, criado_em, expira_em, usado_em, invalidado_em, tentativas)`.
6. Guards novos `kidmais_063_guard_empresas` (acrescenta SUSPENSA→ATIVA) e `kidmais_063_guard_memberships` (status novo SUSPENSA: ATIVA↔SUSPENSA, SUSPENSA→REVOGADA). Funções da 044/045 preservadas para o rollback, como já é o padrão.

## Comportamentos definidos no servidor

- **Interessada** não cria empresa, usuário nem acesso. **Provisionar** (confirmação explícita): cria empresa (PROVISIONAMENTO→ATIVA), cadastro administrativo, marca a interessada CONVERTIDA e cria o convite do responsável; nenhum usuário é criado até o aceite.
- **Suspender empresa**: empresa SUSPENSA (dados preservados). `provarTenant` recusa seu acesso; a 063 também revoga as sessões que selecionaram essa empresa. Sessões selecionadas em outra empresa permanecem válidas. **A sessão que estava com a empresa suspensa selecionada é encerrada e exige novo login, mesmo que a pessoa tenha outra membership ativa** (o acesso às outras empresas é preservado: basta entrar de novo e escolher). Quem fica sem nenhum acesso ativo continua sujeito à política de encerramento D4. Reativar devolve ATIVA, mas não restaura sessões ou escolhas revogadas.
- **Desativar vínculo**: membership SUSPENSA (só aquela empresa); reativar volta a ATIVA. Protege a última Gestão. Sessões que selecionaram aquele vínculo são revogadas; outras empresas ficam intactas. Revogação terminal também invalida a seleção.
- **Convite**: token de 32 bytes (só o hash no banco), validade 7 dias, reenvio com intervalo mínimo e limite, cancelamento. Aceite: e-mail novo define nome e senha (identidade com papel global neutro); e-mail existente confirma com a senha atual. Sempre cria/ativa só a membership da empresa do convite.
- **Recuperação**: token de uso único, 30 min, novo pedido invalida os anteriores, intervalo mínimo entre pedidos, limite por IP e por e-mail, resposta pública idêntica exista ou não a conta. O desenvolvedor só dispara o pedido; não vê link nem senha.
- **Troca de senha**: senha atual + nova + confirmação, política do projeto, mesmo hash; revoga todas as sessões (inclusive de outros dispositivos) e emite sessão nova para o dispositivo atual.
- **Auditoria**: ator, horário, empresa, ação, resultado e campos alterados (lista branca). Nunca senha, hash, token, link ou documento. Recusas de autorização do painel também são auditadas.
- **E-mail**: porta `lib/acessos/email.ts` com provedores `desativado` (padrão), `arquivo` (somente local/teste, grava em pasta, nunca envia; recusado em deploy) e um provedor HTTP real (D1). Sem envio, o convite fica registrado como "não enviado" (reenvio possível) e o pedido de recuperação é invalidado; a tela mostra o resultado real.
- **Custo do hash (revisado)**: redefinição pública, aceite de convite e troca de senha só calculam o scrypt (N=131072, ~128 MB) DEPOIS do limite de tentativas e de token/senha válidos. Token falso, excesso de tentativas ou senha atual errada nunca custam um scrypt de senha nova (testado).
- **Reautenticação**: janela inclusiva de 5 min. `autenticado_em` e `consultado_em` vêm do mesmo relógio PostgreSQL (`clock_timestamp`); o painel não consulta `Date.now` para autorizar. Carimbo futuro, inválido ou ausência do relógio comum recusam a operação. A tolerância de dois minutos foi removida.

## Decisões (Felipe, 04/10/2026)

| | Decisão | Situação |
|---|---|---|
| D1 | Provedor real de e-mail e remetente | **Pendente.** Envio real desligado; convites e recuperação não operacionais sem validação de entrega |
| D2 | Reativação | Adotada: empresa SUSPENSA→ATIVA e vínculo SUSPENSA→ATIVA, só pelo painel (concessão de desenvolvedor). Empresa DESATIVADA e vínculo REVOGADO continuam terminais (guard + serviço; testado). Sem concessão, nem as rotas novas nem as legadas reativam (testado) |
| D3 | Concessão de desenvolvedor | Adotada: somente por CLI |
| D4 | Sessões | Adotada: troca de senha encerra as outras sessões (o dispositivo da troca recebe sessão nova); suspensão preserva os acessos válidos a outras empresas, mas a sessão com a empresa suspensa selecionada exige novo login |
| D5 | Implantação | Adotada: estado separado da situação da empresa (`plataforma_empresas_cadastro.implantacao`) |
| D6 | Testes em cluster descartável | Executados em cluster sintético próprio (a porta 55498 estava ocupada por outro PostgreSQL, não tocado; ver Evidências) |
| D7 | Menu Configurações | Adotada nesta PR (ver abaixo) |

### D7 — menu pelo papel na empresa

`GET /api/admin/autenticacao` devolve o contexto da sessão persistida, sem permitir escolher por query string. O seletor "Empresa ativa" usa `POST` com origem/CSRF, prova o vínculo ATIVA na empresa ATIVA e rotaciona token/CSRF, sem estender o login ou renovar a reautenticação. A 063 inclui `sessoes_administrativas.empresa_ativa_id`. Sem escolha, apenas uma membership ativa admite seleção automática; múltiplas empresas exigem escolha antes de montar as páginas de negócio. Menu, APIs e serviços usam essa escolha, sempre revalidada no banco. Um `empresaId` divergente não troca o contexto por fora do seletor. Gestão/Equipe vem da membership atual, plataforma da identidade e painel da concessão própria.

A troca faz navegação completa para Dashboard: descarta estados React, conversas, rascunhos, caches de navegação e URLs de registros da empresa anterior. O sinal entre abas contém só um horário; foco e consulta periódica revalidam o contexto. `adminFetch` vincula os pedidos à sessão da página e confere o contexto antes de devolver resultados; pedidos com a sessão anterior são recusados. Suspensão ou revogação encerra a sessão selecionada (também por rotas legadas), exigindo login/seleção novos. Os endpoints de cadastro/logo do Perfil agora provam o tenant e resolvem o UUID legado unicamente para aquela empresa; perfil ausente ou ambíguo retorna 409, sem usar o perfil de outra empresa.

---

## Implementação

### Arquivos

| Área | Arquivos |
|---|---|
| Migration | `database/migrations/20261004_063_painel_desenvolvedor.sql`, `database/rollback/..._down.sql`, `database/checks/20261004_063_{precheck,postcheck}.sql`; inventário em `scripts/production/check-migrations.mjs` (+ testes); modelo `063` em `scripts/regressao-v1-postgres-receita.cjs` |
| Concessão | `scripts/admin-provision.cjs desenvolvedor` (conceder/revogar, interativo, `CONFIRMAR`, auditado como `CLI_PROVISIONAMENTO`) |
| Autorização | `lib/desenvolvedor/autorizacao.ts` (concessão, reautenticação, sessões ao perder acesso), `lib/desenvolvedor/http.ts` (guarda de toda rota), `lib/desenvolvedor/pagina.ts` (guarda de servidor de toda página) |
| Painel | `lib/desenvolvedor/{interessadas,empresas,vinculos,resumo,auditoria}.ts`; rotas `app/api/desenvolvedor/**`; páginas `app/desenvolvedor/**`; telas `components/desenvolvedor/*` |
| Acessos | `lib/acessos/{convites,recuperacao,senha-propria,email,validacao,erros,http}.ts`; rotas `app/api/acesso/{convite,recuperacao,redefinir}`, `app/api/admin/perfil/senha`; páginas `app/acesso/{convite,recuperar,redefinir}`, `app/admin/perfil` |
| Ajustes | `lib/autenticacao/service.ts` (limite reutilizável, criação/revogação de sessão extraídas sem mudar o login), `lib/autenticacao/usuarios.ts` (helpers exportados; vínculo SUSPENSA não é reaberto pela empresa; criação de identidade única `inserirIdentidadeNeutra`), login com "Esqueci minha senha" e retorno seguro, link "Meu perfil e senha" no Admin, `noindex` em `/desenvolvedor` e `/acesso` |

### Variáveis de ambiente novas (nenhuma alterada por esta entrega)

| Nome | Uso |
|---|---|
| `EMAIL_PROVIDER` | `desativado` (padrão) · `arquivo` (só local/teste) · `resend` (D1) |
| `EMAIL_ARQUIVO_DIR` | pasta absoluta do provedor `arquivo` |
| `EMAIL_REMETENTE`, `RESEND_API_KEY` | provedor real (D1) — segredo; nunca exibido |

Links de convite e recuperação usam `ADMIN_AUTH_ORIGIN` e levam o token no fragmento (`#t=`).

### Garantias verificadas por teste

- Rotas `/api/desenvolvedor/*`: todas passam por `rotaDesenvolvedor` (sessão + CSRF/origem + concessão no banco; sem concessão = 404 auditado). Páginas: cada `page.tsx` chama `exigirDesenvolvedorNaPagina`. Serviços: todos conferem a concessão travada dentro da transação.
- Papel global, papel de empresa e ser proprietário não abrem o painel (teste de rota e Postgres).
- Nenhum código da aplicação escreve `plataforma_desenvolvedores`.
- SQL de vínculo/convite/recuperação sempre filtrado pela empresa informada; ids de outra empresa → 404.
- Auditoria sanitizada (lista branca + remoção de chaves sensíveis + documento mascarado); varredura no Postgres sem senha, token, hash nem link.

## Evidências (04/10/2026)

**Destino.** A porta 127.0.0.1:55498 estava ocupada por outro PostgreSQL (PID 45140, dados em `%TEMP%kidmais-demo-atendimento-20261004-4b6271`), que não foi conectado, reutilizado nem parado. Com autorização do Felipe, um cluster sintético exclusivo foi criado em **127.0.0.1:55499**, diretório `D:glassKidMais Managerambientes-locaispg-descartavel-painel-063` (orquestrador da tarefa derivado de `scripts/pg-descartavel-061.cjs`, fora do repositório). Antes da primeira conexão foram conferidos e registrados porta, diretório, `cluster_name` e processo (PID 56092, `postgres.exe -D …pg-descartavel-painel-063 -p 55499`); a prova de identidade confirmou endereço, porta, papel, diretório, PostgreSQL 18 e ausência de `kidmais_manager`. Ao final o cluster foi parado (`pg_ctl status` 3) e o diretório removido; os relatórios ficaram em `ambientes-locaispg-descartavel-painel-063-relatorios`. As travas de destino das suítes foram mantidas (opt-in, porta e autorização literal `127.0.0.1:55499/kidmais_pacotes_v1_descartavel`, identidade do servidor). Nenhum banco real acessado; nenhum e-mail enviado (provedor `arquivo` em pasta local).

**PostgreSQL.**
- `lib/desenvolvedor/painel-063.postgres.test.ts` (modelo 063 recriado do schema vazio): **18/18** — rollback em banco sem uso + precheck + reaplicação + postcheck; CLI de concessão; autorização (proprietário sem concessão = 404 em todo serviço); interessada sem efeitos; provisionamento; convites (conta nova e existente, uso único, senha errada auditada); isolamento entre empresas; desativação/reativação de vínculo com sessões; suspensão/reativação com sessões; troca de senha; recuperação (resposta neutra, intervalo, uso único, expiração); envio indisponível; varredura de segredos na auditoria; D2 (sem concessão não reativa por rota nova nem legada; DESATIVADA e REVOGADA terminais); D7; rollback recusado após uso.
- Regressão PostgreSQL completa (`check:v1:postgres`, todos os modelos, incluindo `hg8-tenant` e `tenant-festa` também no estado 063): **PASS — 38 execuções de suíte, 255/255 testes**.

**E2E** (`next dev` local apontando só para `kidmais_e2e_painel` no mesmo cluster, criado do modelo 063; duas empresas: "Buffet Alfa E2E" pré-existente e "Festa Beta E2E" provisionada pela tela):
1. Proprietário da Alfa (Gestão por membership, identidade neutra) sem concessão: `/desenvolvedor` → 404; `/api/desenvolvedor/resumo` e reativar empresa/vínculo pela rota nova → 404; recusas auditadas. Menu (D7): Configurações da empresa visíveis, sem WhatsApp/PDF; rodapé "Gestão · Buffet Alfa E2E".
2. Desenvolvedor: resumo; interessada cadastrada pela tela (sem empresa/usuário/acesso); situação "Em contato"; provisionamento com prévia dos efeitos e confirmação; convite gravado pelo provedor local.
3. Convite (conta nova) pela página pública: token removido da barra; conta criada com papel global neutro e Gestão só na Beta; reuso do link → 410; implantação passou a "Em configuração". Responsável da Beta: contexto Gestão na Beta; usuários da Alfa → 403; painel → 404.
4. Troca de senha em `/admin/perfil` com uma segunda sessão aberta: senha atual errada recusada; com a correta, a outra sessão foi encerrada e o navegador seguiu logado; senha antiga → 401, nova → 200.
5. Convite para conta existente (proprietário da Alfa na Beta como Equipe): senha errada → recusa genérica; correta → vínculo criado sem conta nova. Com duas empresas e sem escolha, `selecaoNecessaria`; na Beta, Equipe (usuários → 403, dashboard → 200).
6. Desativar vínculo do proprietário só na Beta: continua logado, Beta → 403, Alfa → 200, menu volta a "Gestão · Buffet Alfa E2E". D2 pelas rotas legadas (Gestão da Beta): reabrir → 409, papel/assinatura → 404, rota nova → 404.
7. Suspender a Beta (motivo + código): 1 pessoa desconectada (a responsável, sem outra empresa); o proprietário segue com a Alfa; a responsável ainda autentica mas não acessa a empresa (403). Reativar empresa e vínculo pela ficha.
8. Recuperação pública: mesma resposta (202) para e-mail inexistente, existente e repetido; uma única mensagem gerada; redefinição pela página pública encerrou a sessão aberta; senha antiga → 401, nova → 200; reuso → 410. Pelo painel: o desenvolvedor não vê link nem senha (destino mascarado); repetição imediata → "aguarde N segundos".
9. Reautenticação após 5 min: diálogo exigido; senha errada → "Senha incorreta." no diálogo; correta → operação concluída.
10. Auditoria do banco E2E: 62 registros, 9 segredos procurados (senhas e tokens) → **0 ocorrências**; nenhum registro do painel sem ator ou resultado.

**Defeitos achados e corrigidos na rodada anterior.** (a) A comparação de relógios diferentes recebeu uma tolerância provisória; ela foi substituída pela comparação no relógio PostgreSQL, mantendo cinco minutos e recusando futuro. (b) Senha errada no diálogo de reautenticação levava ao login (401 tratado como sessão encerrada no cliente) → o diálogo mostra "Senha incorreta" e a sessão segue (E2E anterior). (c) Custo do hash antes do limite na redefinição pública, no aceite de convite e na troca de senha → scrypt só depois do limite e de token/senha válidos (testado).

**Limitações conhecidas.** D1 pendente (sem validação de entrega real). **Perfil ausente — resolvido em 05/10/2026** (ver [PAINEL_DESENVOLVEDOR_CONCLUSAO_20261005.md](PAINEL_DESENVOLVEDOR_CONCLUSAO_20261005.md)): a contratante recém-provisionada continua sem Perfil automático, mas a própria Gestão da empresa cria a estrutura mínima em Configurações → Perfil da empresa; a ficha do painel mostra as pendências de implantação e a conclusão é validada no servidor. Em 06/10/2026 (revisão Astra) a Gestão passou a poder assumir a administração de um Perfil existente sem administrador elegível (Configurações → Perfil da empresa → "Assumir a administração do perfil", também para quem já tem só a consulta), e a saída da sessão ganhou prazo, resultado explícito e aviso verdadeiro quando o servidor não confirma (§10 do mesmo documento). O módulo Festas respondeu 503 no E2E anterior (trava de ambiente pré-existente, sem relação com esta PR). Evidências da seleção e plano concreto de staging em `docs/HOMOLOGACAO_PAINEL_MULTI_EMPRESA.md`.

## Roteiro de homologação (staging, após autorização da 063 e do deploy)

Pré-requisitos: 063 aplicada com precheck/postcheck; código publicado; `EMAIL_PROVIDER` definido conforme D1 (com `desativado`, conferir os avisos de "não enviado"); concessão de desenvolvedor para a conta de teste via `node scripts/admin-provision.cjs desenvolvedor`.

1. **Acesso negado**: com uma conta Gestão de empresa (sem concessão), abrir `/desenvolvedor` → 404; `GET /api/desenvolvedor/resumo` → 404. Conferir `PAINEL_ACESSO_RECUSADO` na auditoria.
2. **Resumo**: com a conta concedida, `/desenvolvedor` mostra contagens, empresas em implantação, convites pendentes e atividades (sem contratos, documentos ou pagamentos).
3. **Interessada**: cadastrar; tentar o mesmo e-mail (bloqueia) e o mesmo telefone (pede confirmação); mudar situação; descartar com motivo; reabrir. Conferir que nenhuma empresa/usuário foi criado.
4. **Provisionar**: a partir da interessada, revisar efeitos, confirmar (pede senha se a última confirmação tiver mais de 5 min). Ver resultado real do envio. Empresa aparece "Em implantação / Aguardando primeiro acesso".
5. **Convite (conta nova)**: abrir o link recebido, criar nome e senha, entrar. A empresa passa a "Em configuração". Reabrir o mesmo link → inválido.
6. **Convite (conta existente)**: convidar um e-mail que já tem conta; aceitar com a senha atual; conferir que a outra empresa da pessoa segue intacta.
7. **Reenvio/cancelamento**: reenviar (link anterior deixa de valer; intervalo mínimo de 60 s); cancelar.
8. **Vínculos**: tornar Gestão/Equipe; desativar (motivo; última Gestão protegida); conferir que a pessoa perde só esta empresa; reativar.
9. **Suspensão**: suspender (motivo + código); a empresa some para seus usuários na hora; quem só tinha esta empresa é desconectado; dados preservados; reativar.
10. **Troca de senha**: em `/admin/perfil`, com duas sessões abertas, trocar a senha → a outra sessão cai, a atual continua; senha atual errada recusada.
11. **Recuperação**: em `/acesso/recuperar` com e-mail inexistente e existente (mesma resposta); usar o link (uso único, 30 min); pedir pelo painel (o desenvolvedor não vê link nem senha); repetição em menos de 2 min recusada.
12. **Auditoria**: conferir os registros das etapas acima (ator, empresa, ação, resultado) sem senha, token ou link.
13. **Menu por empresa (D7)**: o responsável da empresa nova (conta criada pelo convite) vê "Gestão · <empresa>" e as configurações da empresa; uma conta Equipe não vê; WhatsApp e PDF de Pacotes só aparecem para a autoridade de plataforma. Chamar diretamente uma API de configuração sem Gestão na empresa → 403.
14. **Reativação restrita (D2)**: com conta sem concessão, tentar reativar vínculo/empresa pelas rotas do painel → 404; pela tela Usuários e acessos da empresa, um vínculo desativado não é reaberto (mensagem de bloqueio). Empresa desativada e vínculo removido não voltam.
15. **E-mail (D1 pendente)**: com `EMAIL_PROVIDER` desativado, convites aparecem como "não enviado" e a recuperação pelo painel informa a falha. Não declarar convite/recuperação operacionais até validar a entrega com o provedor escolhido.

## Rollback

- **Código**: a 063 é aditiva fora dos dois guards; voltar o código anterior funciona com a 063 aplicada (as tabelas novas ficam sem uso; vínculo SUSPENSA aparece como inativo).
- **Schema**: `database/rollback/20261004_063_painel_desenvolvedor_down.sql` só para desfazer ANTES do uso — recusa com vínculo SUSPENSO, seleção de empresa já utilizada ou qualquer registro nas tabelas novas; nunca apaga dado.
- **Concessão**: `node scripts/admin-provision.cjs desenvolvedor` → `revogar` (efeito imediato em toda requisição).
