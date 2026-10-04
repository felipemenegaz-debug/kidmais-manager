# Painel do desenvolvedor — proposta (04/10/2026)

Branch `feat/painel-desenvolvedor-20261004`, worktree `kidmais-manager-painel-dev`, base `origin/staging` 904b451.
Sem commit, push, banco ou e-mail real até autorização.

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

## Modelo de dados — migration 063 (com rollback, pre/postcheck e inventário)

1. `plataforma_desenvolvedores(usuario_id PK, concedido_em, concedido_por, motivo, revogado_em, revogado_por)` — sem DELETE.
2. `plataforma_interessadas(id, nome, nome_empresarial, documento_fiscal (só dígitos, CPF/CNPJ), responsavel_nome, email, telefone, status NOVA|EM_CONTATO|PROPOSTA|CONVERTIDA|DESCARTADA, observacoes, empresa_id, criado_por, criado_em, atualizado_em, revisao)` — únicos parciais por documento e por e-mail entre as não descartadas; conversão só por provisionamento.
3. `plataforma_empresas_cadastro(empresa_id PK, nome_empresarial, documento_fiscal, responsavel_nome, email, telefone, observacoes, interessada_id, implantacao AGUARDANDO_PRIMEIRO_ACESSO|EM_CONFIGURACAO|CONCLUIDA, ...)` — dados comerciais fora de `empresas` (cujo guard fica intacto, exceto o item 6).
4. `convites_acesso(id, empresa_id, email, papel, token_hash UNIQUE, status PENDENTE|ACEITO|CANCELADO, expira_em, envios, ultimo_envio_em, criado_por, aceito_em, aceito_usuario_id, cancelado_em, cancelado_por)` — um pendente por (empresa, e-mail); "expirado" é derivado de `expira_em`.
5. `recuperacoes_senha(id, usuario_id, token_hash UNIQUE, origem PUBLICA|PAINEL, solicitado_por, criado_em, expira_em, usado_em, invalidado_em, tentativas)`.
6. Guards novos `kidmais_063_guard_empresas` (acrescenta SUSPENSA→ATIVA) e `kidmais_063_guard_memberships` (status novo SUSPENSA: ATIVA↔SUSPENSA, SUSPENSA→REVOGADA). Funções da 044/045 preservadas para o rollback, como já é o padrão.

## Comportamentos definidos no servidor

- **Interessada** não cria empresa, usuário nem acesso. **Provisionar** (confirmação explícita): cria empresa (PROVISIONAMENTO→ATIVA), cadastro administrativo, marca a interessada CONVERTIDA e cria o convite do responsável; nenhum usuário é criado até o aceite.
- **Suspender empresa**: empresa SUSPENSA (dados preservados). `provarTenant` já recusa toda requisição da empresa na hora; além disso as sessões de quem não tem outro acesso ativo são revogadas. Usuários com outras empresas continuam nelas. Reativar devolve ATIVA.
- **Desativar vínculo**: membership SUSPENSA (só aquela empresa); reativar volta a ATIVA. Protege a última Gestão. Sessões do usuário são revogadas apenas se ele ficar sem nenhum acesso ativo.
- **Convite**: token de 32 bytes (só o hash no banco), validade 7 dias, reenvio com intervalo mínimo e limite, cancelamento. Aceite: e-mail novo define nome e senha (identidade com papel global neutro); e-mail existente confirma com a senha atual. Sempre cria/ativa só a membership da empresa do convite.
- **Recuperação**: token de uso único, 30 min, novo pedido invalida os anteriores, intervalo mínimo entre pedidos, limite por IP e por e-mail, resposta pública idêntica exista ou não a conta. O desenvolvedor só dispara o pedido; não vê link nem senha.
- **Troca de senha**: senha atual + nova + confirmação, política do projeto, mesmo hash; revoga todas as sessões (inclusive de outros dispositivos) e emite sessão nova para o dispositivo atual.
- **Auditoria**: ator, horário, empresa, ação, resultado e campos alterados (lista branca). Nunca senha, hash, token, link ou documento. Recusas de autorização do painel também são auditadas.
- **E-mail**: porta `lib/email` com provedores `desativado` (padrão), `arquivo` (somente local/teste, grava em pasta temporária, nunca envia) e um provedor HTTP real configurável. Sem provedor configurado, convite e recuperação respondem "envio não configurado" e não ficam pendentes.

## Decisões pendentes (Felipe)

- **D1** Provedor real de e-mail e remetente (proposta: Resend via HTTP, `EMAIL_PROVIDER=resend`, `EMAIL_REMETENTE`). Até lá fica `desativado` em staging.
- **D2** Abrir reativação (empresa SUSPENSA→ATIVA e vínculo SUSPENSA) muda a decisão "sem reativação" das 044/045.
- **D3** Concessão de desenvolvedor só por CLI; primeira concessão (conta do Felipe) em staging exige autorização própria.
- **D4** Políticas de sessão acima (troca de senha e suspensão).
- **D5** "Em implantação" = empresa ATIVA com implantação não concluída (o responsável consegue entrar e configurar), e não PROVISIONAMENTO.
- **D6** Autorização para rodar a 063 e os testes Postgres/E2E no cluster descartável 127.0.0.1:55498.
- **D7** O menu Configurações do Admin decide pela identidade global, não pela membership: o responsável de uma empresa nova (identidade neutra) teria as APIs de Gestão mas não veria o menu. Corrigir nesta entrega?

---

## Implementação (padrões adotados enquanto D1–D7 não forem decididas)

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

## Rollback

- **Código**: a 063 é aditiva fora dos dois guards; voltar o código anterior funciona com a 063 aplicada (as tabelas novas ficam sem uso; vínculo SUSPENSA aparece como inativo).
- **Schema**: `database/rollback/20261004_063_painel_desenvolvedor_down.sql` só para desfazer ANTES do uso — recusa com vínculo SUSPENSO ou qualquer registro nas tabelas novas; nunca apaga dado.
- **Concessão**: `node scripts/admin-provision.cjs desenvolvedor` → `revogar` (efeito imediato em toda requisição).
