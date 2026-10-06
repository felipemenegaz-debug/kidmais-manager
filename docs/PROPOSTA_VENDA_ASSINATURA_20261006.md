# Proposta — cadastro público e venda do KidMais Manager por assinatura

Data: 06/10/2026. Documento para decisão. **Nada foi implementado**: nenhum banco, conta, flag, serviço, branch remota ou deploy foi alterado.

Base lida (revalidada por `git ls-remote` em 06/10/2026):

| Branch | SHA | Observação |
|---|---|---|
| `staging` | `8c71673` | Base desta análise. 35 commits à frente de `production`, 0 atrás |
| `production` | `51b1a68` | Não contém a conclusão do painel (#104) nem a 064 |
| `main` | `9765965` | Defasada; não usada |

Convenções: **[F]** fato lido no código ou em fonte oficial; **[E]** estimativa ou hipótese; **[?]** dúvida a confirmar. Caminhos relativos à raiz do repositório.

---

## 0. Resumo executivo

- **Hoje não existe nada de cobrança SaaS** [F]: não há plano, teste, vencimento, gateway, webhook de pagamento nem tarefa agendada. Também não há cadastro público (`app/admin/login/page.tsx:44`: "Não há cadastro público").
- **A base de identidade e isolamento é boa e reaproveitável** [F]: sessão em banco com token em hash (`lib/autenticacao/service.ts:24-44,97-105`); várias empresas por usuário com empresa ativa na sessão (`lib/autenticacao/empresa-ativa.ts:7-28`); prova de tenant em toda API de empresa (`lib/saas/provar-tenant.ts:79-139`); convites com token em hash, uso único, 7 dias, e reaproveitamento da conta existente mediante senha (`lib/acessos/convites.ts:205-267`); ciclo de empresa com suspensão/reativação auditadas (migration 063).
- **Não abriria o cadastro hoje.** Há bloqueios concretos que precisam ser resolvidos antes. São independentes de cobrança:
  1. A Gestão de qualquer empresa associa uma conta existente por e-mail sem aceite, e cria conta com senha escolhida por ela para um e-mail que ainda não existe (`lib/autenticacao/usuarios.ts:187-253`, em especial `:203-214`). Com cadastro público, isso permite ocupar o e-mail de outra pessoa.
  2. Há recursos **da instalação inteira** acessíveis a membros de empresa: ajustes de pacote e desconto gravados em `data/disponibilidade.json` (`app/api/admin/disponibilidade/route.ts:123-141,383-435`), agenda e catálogo públicos de uma única empresa por variável de ambiente (`lib/disponibilidade/escopo.ts:87-115`), WhatsApp com credencial e conexão sem empresa (`20260912_018_whatsapp_onboarding.sql:17-40`). Uma empresa nova não pode alterar nem herdar nada disso.
  3. Envio de e-mail desligado (`lib/acessos/email.ts:49-65`, decisão D1 pendente) e recuperação de senha desativada em produção (`lib/acessos/disponibilidade.ts:5-8`). Sem isso não há confirmação de e-mail nem recuperação.
  4. A 063 está em staging, mas não em produção [F/?] (ver §1.9).
- **Recomendação de produto** [E]: lançar com **plano único, mensal e anual, por empresa (uma unidade)**, teste de **30 dias sem cartão controlado pelo nosso sistema**, aprovação manual da representação antes de qualquer ação com terceiros, e **Asaas como candidata principal** (Pix Automático, boleto, cartão e NFS-e nativa), com Stripe como alternativa se só cartão bastar. Validar ambas em sandbox antes de decidir.

---

## 1. Diagnóstico do estado atual

### 1.1 Rotas e autenticação

| Tema | Estado | Referência |
|---|---|---|
| Guarda global (middleware/proxy) | **Não existe** | nenhum `middleware.ts`/`proxy.ts` |
| Páginas `/admin/*` | Guarda **só no cliente** (`AdminShell` chama `/api/admin/autenticacao` e redireciona) | `components/admin/AdminShell.tsx:45-59` |
| APIs `/api/admin/*` | Sessão + origem + CSRF em mutações | `lib/http/admin-crm-api.ts:31-46` |
| Páginas/APIs `/desenvolvedor` | Guarda no servidor; sem concessão → 404 | `lib/desenvolvedor/pagina.ts:15-45`, `lib/desenvolvedor/http.ts:18-43` |
| Sessão | 32 bytes, SHA-256 no banco, 8 h absoluta, 30 min de inatividade, invalida após troca de senha | `lib/autenticacao/service.ts:24-44,97-105` |
| Cookies | `__Host-kidmais_admin` + CSRF, httpOnly, secure, lax | `lib/http/admin-crm-api.ts:22`; `app/api/admin/autenticacao/route.ts:82-83` |
| Senha | scrypt N=131072, 8–128 caracteres | `lib/autenticacao/senha.ts:11,21-23` |
| Limite de tentativas | IP 30/5 min; e-mail 5/15 min | `lib/autenticacao/service.ts:51-53` |
| Limite por IP | Só confia no IP com `RENDER=true` | `lib/acessos/http.ts:21-27` |
| Confirmação de e-mail | **Não existe** (só implícita no token do convite) | `lib/acessos/convites.ts:205-267` |
| Cadastro público | **Não existe** | `app/admin/login/page.tsx:44` |
| Recuperação de senha | Implementada, atrás de `RECUPERACAO_SENHA_ATIVA=true` + e-mail configurado; token 30 min, uso único | `lib/acessos/disponibilidade.ts:5-8`, `lib/acessos/recuperacao.ts:13-27` |
| E-mail | Resend via `fetch`; padrão `desativado` | `lib/acessos/email.ts:9-13,49-65,82-86` |
| OTP | Só para cliente final por CPF (Gupshup/Meta), não para login | `lib/identidade/services/identity.service.ts:263-330`; `render.yaml:50-51` (disabled em staging) |

### 1.2 Convites

- Só o desenvolvedor cria convites (`lib/desenvolvedor/empresas.ts:274`, `lib/desenvolvedor/vinculos.ts:58`). A Gestão da empresa **não convida**: cria contas diretamente (§1.3).
- Token 32 bytes em hash, link com o token no fragmento `#t=` (`lib/acessos/email.ts:110-112`), 7 dias, uso único, reenvio invalida o anterior, um pendente por empresa+e-mail (`lib/acessos/convites.ts:25-27,105-135`; `063:305,322,342,344`).
- E-mail com conta: **reaproveita a identidade e exige a senha atual** (`lib/acessos/convites.ts:226-235`). E-mail sem conta: cria identidade com papel global neutro (`:237-242`). E-mail único em `lower(btrim(email))` (`013:18`).
- **Este é o modelo certo para o caso "mesma pessoa em várias empresas"** e para a pendência registrada em `PENDENCIA-RESPONSAVEL-POR-CNPJ-20261006.txt`.

### 1.3 Usuários, empresas e vínculos

- `empresas`: `PROVISIONAMENTO | ATIVA | SUSPENSA | DESATIVADA` (`20260926_031_empresas_comercial.sql:31`); transições no guard da 063 (`063:446-452`); `DESATIVADA` terminal; sem exclusão física (`063:428-430`). **Não tem coluna de CNPJ.**
- `memberships`: `UNIQUE(empresa_id, usuario_id)` (`043:128`); `PENDENTE | ATIVA | SUSPENSA | REVOGADA` (`063:499-500`); papel por empresa (`056:40-43`).
- Papéis (`lib/autenticacao/papeis.ts:5-11`): `REPRESENTANTE_AUTORIZADO` = "Gestão"; `ADMINISTRATIVO` = "Equipe". **O nome técnico "representante autorizado" é nível de acesso, não representação legal** — o novo modelo deve evitar confundir os dois.
- Várias empresas por usuário: **suportado** (`lib/autenticacao/contexto.ts:24-26`; `lib/saas/provar-tenant.ts:79-139`; trigger que revoga sessões quando empresa/vínculo deixa de ser ATIVA, `063:53-71`).
- **Risco**: `associarUsuarioNaEmpresa` (`lib/autenticacao/usuarios.ts:187-253`) vincula conta existente sem aceite (`:203-214`) e cria identidade com senha definida por terceiros. Aceitável enquanto só a Kidmais opera; **inaceitável com cadastro público**.
- Responsável/sócio/representante: só `plataforma_empresas_cadastro.responsavel_nome` em texto livre (`063:219`). Sócio/QSA/proprietário como entidade: **não existe**.
- CNPJ único: **parcial**. Único em `plataforma_empresas_cadastro.documento_fiscal` (`063:247`) e em interessadas não descartadas (`063:169-170`), ambos aceitando CPF ou CNPJ; `perfil_empresas.cnpj` só tem CHECK de formato (`027:22,34`).
- Consulta de CNPJ: **só DV/sintaxe**, inclusive alfanumérico; o código declara que não consulta titularidade (`lib/cadastro/cnpj.ts:1-50`, `:6`).

### 1.4 Provisionamento, perfil e unidades

- Provisionamento real **só pelo desenvolvedor**, com reautenticação ≤ 5 min e `confirmar=true` (`lib/desenvolvedor/empresas.ts:246-294`). Cria empresa já `ATIVA`, cadastro com implantação `AGUARDANDO_PRIMEIRO_ACESSO`, converte a interessada e cria convite de Gestão. Não cria membership, estabelecimento nem perfil.
- Perfil criado pela Gestão após o aceite (`lib/perfil/criacao.ts:141-208`): uma `perfil_unidades` `<codigo>-principal`, quatro capacidades ao criador.
- **Limite V1 de uma unidade** (`lib/perfil/cadastro-service.ts:167,180`) — cobrança por unidade não faz sentido no lançamento.
- `estabelecimentos` nascem SUSPENSOS e ATIVO está fechado por trigger (`043:70-85`); nenhum código cria estabelecimento (só o reparo `database/repairs/20261002_062_unidade_principal.sql:26`). `provarEstabelecimento` é usado só pela IA.
- `lib/saas/provisionar-tenant.ts` não é chamado por nenhuma rota (só testes/scripts).

### 1.5 Implantação e suspensão

- Implantação: `AGUARDANDO_PRIMEIRO_ACESSO | EM_CONFIGURACAO | CONCLUIDA` (`063:242`); `CONCLUIDA` exige Gestão ativa e perfil criado e aplicado (`lib/desenvolvedor/implantacao.ts:157-193`). **Só informativa**, não bloqueia nada.
- Suspensão manual pelo painel com reautenticação, motivo e código digitado (`lib/desenvolvedor/empresas.ts:424-451`), aplicada no servidor por `provarTenant` (`lib/saas/provar-tenant.ts:106-117`, 403 `TENANT_NAO_COMPROVADO`).
- **Problema para o paywall**: suspender hoje derruba sessões e impede até o login útil na empresa. Para teste vencido ou inadimplência, o cliente precisa continuar entrando para pagar e exportar. Logo, a situação comercial **não deve reusar `SUSPENSA`**.

### 1.6 Limites de IA, mensagens e armazenamento

| Recurso | Medição por empresa | Limite | Referência |
|---|---|---|---|
| IA | **Sim**: tokens e custo estimado, reserva atômica antes da chamada | Igual para todas via `AI_BUDGET_JSON` (exemplo: US$ 2/dia, US$ 30/mês por empresa); liberação por `AI_TENANT_ALLOWLIST`; flags de IA `false` no exemplo de produção | `20260928_055a_inteligencia_uso.sql:28-100`; `lib/ia-persistencia/uso.ts:52-121`; `lib/inteligencia/modelos/orcamento.ts:8-13,113`; `lib/inteligencia/flags.ts:44-53` |
| WhatsApp/OTP | **Não** | Credencial única da instalação; `whatsapp_conexoes` sem `empresa_id` | `lib/identidade/delivery/gupshup.sender.ts:102,120-128`; `018:17-40` |
| E-mail | **Não** | Só limites de convite/recuperação | `lib/acessos/recuperacao.ts:24-27` |
| Armazenamento | **Não** | PDFs e anexos em `bytea` no banco (25 MB por original de IA, 10 MB por anexo); disco Render de 1 GB para PDF público e JSON global | `013:63`; `015:130-131`; `055c:65-75`; `render.yaml:13-16`; `lib/catalogo/documento-publico.ts:7-14` |

### 1.7 Pagamentos existentes

`lib/pagamentos` e `lib/financeiro` tratam **dos pagamentos das festas** (clientes do buffet). Gateways reais estão fora da V1 (`docs/FINANCEIRO_V1.md:47`). "Assinatura" no código é **assinatura de contrato** (`013:105`, `057`). Reaproveitável: padrões de idempotência (`011:314,352`; `013:114-117`; `052:28-32`; `lib/financeiro/idempotencia.ts:4-7`), auditoria (`lib/desenvolvedor/auditoria.ts:12-71`) e o leitor de webhook do Gupshup (corpo limitado, comparação em tempo constante — `lib/integracoes/gupshup/webhook.ts:5-66`), que porém **não guarda nem deduplica eventos**.

### 1.8 Superfícies públicas e tarefas agendadas

| Superfície | Confere empresa ATIVA? | Referência |
|---|---|---|
| Agenda pública | Sim, mas **uma empresa por deploy** (`AGENDA_PUBLICA_EMPRESA_ID`) | `lib/disponibilidade/escopo.ts:87-115` |
| Fechamento público (POST) | Sim; catálogo, pacotes e tabela PDF **não** (globais) | `app/api/fechamentos/route.ts:120`; `documentos_publicos` sem `empresa_id` |
| Contrato do cliente (ver, aceitar, PDF, OTP) | **Não** | `lib/contratos/services/contrato-publico.service.ts` (nenhuma menção a empresa) |
| Assinatura pela empresa | Sim (banco) | `057:94` |
| Tarefas agendadas | **Não existem** | `render.yaml` sem cron |

### 1.9 Estado das migrations [F/?]

- 063: cabeçalho diz "NÃO APLICADA" (`063:4`, desatualizado); `docs/PAINEL_DESENVOLVEDOR_CONCLUSAO_20261005.md:7-8` registra aplicação em staging em 05/10/2026. Produção: não aplicada pelos documentos; `docs/SENHA_PRODUCAO_20261005.md:17-19` trata `recuperacoes_senha` como não confirmada.
- 064: não aplicada.
- **Não verifiquei nos bancos** (fora do escopo autorizado). Confirmar por leitura autorizada antes de qualquer planejamento de cutover.

### 1.10 Riscos de abrir publicamente fluxos hoje exclusivos do desenvolvedor

1. **Provisionamento**: reaproveitar a lógica, nunca a rota. O cadastro público deve ter serviço próprio, sem `rotaDesenvolvedor`, sem `confirmar`, e criar a identidade com papel global neutro (`PAPEL_GLOBAL_NEUTRO`, `lib/autenticacao/plataforma.ts:16`). Papel global `REPRESENTANTE_AUTORIZADO` concede autoridade de plataforma (PDF público, WhatsApp/Meta — `lib/autenticacao/plataforma.ts:13-20`) e **nunca** pode nascer de cadastro.
2. **Recursos globais** (§0, item 2): ajustes de pacote/desconto em JSON global, PDF da tabela, catálogo público, WhatsApp, agenda pública por env. Precisam ser cercados para "somente a empresa Kidmais / autoridade de plataforma" ou tornados por empresa antes do lançamento.
3. **Rotas sem prova de tenant explícita na rota**: `configuracoes/tabela-pacotes` (protegida por autoridade de plataforma), `configuracoes/whatsapp/*`, `contratos/versoes/[versaoId]` (prova no serviço, `lib/contratos/services/administrativo.service.ts:133-139`), `inteligencia/*` (prova nas dependências). Fazer auditoria rota a rota antes de abrir.
4. **Isolamento só na aplicação** (sem RLS; FKs compostas e triggers ajudam). Aceitável, mas cada rota nova tem de usar `withTenantTransaction`.
5. **Abuso de cadastro** (contas e e-mails em massa, custo de IA/e-mail): limite por IP depende de `RENDER=true`; não há proteção anti-robô.

---

## 2. Fluxo recomendado

```
Site (preços, termos, privacidade)
  → Escolha do plano (mensal/anual; só registra a intenção)
  → Conta: nome, e-mail, senha, aceite de termos
  → Confirmação de e-mail (token de uso único)
  → Empresa: CNPJ (DV), razão social, nome fantasia, cidade, telefone
       ├ CNPJ já cadastrado → "Solicitar acesso" (avisa a Gestão atual; nenhum dado da empresa é revelado)
       └ CNPJ novo → empresa ATIVA + Gestão do próprio usuário + teste de 30 dias
  → Declaração de representação (sou sócio / tenho autorização de …) + documento opcional
       └ Aprovação manual pela plataforma (separada da validação do CNPJ)
  → Implantação guiada: perfil e unidade → pacotes/tabela → modelo de contrato → 1º cliente e 1ª festa
       └ "Primeiro resultado útil": 1ª festa com contrato gerado (ou outro marco decidido)
  → Teste: avisos no app D-7, D-3, D-1 (e por e-mail quando houver tarefa agendada)
  → Assinatura: checkout do provedor → webhook confirmado → acesso completo
       (voltar do checkout NÃO libera nada; a tela mostra "processando" até o servidor confirmar)
  → Renovação automática / falha de cobrança → prazo de regularização → somente leitura
  → Cancelamento ao fim do período; reativação sem perda de dados
```

Usuário existente cadastrando a segunda empresa: o mesmo fluxo, a partir de "Nova empresa" no seletor de empresas, exige reautenticação recente (padrão já usado no perfil) e não cria nova identidade. Cada CNPJ tem seu próprio teste e sua própria assinatura.

Responsável diferente do sócio: quem se cadastra é o **responsável pela conta** (Gestão). A representação legal é declarada e aprovada à parte; ser Gestão não comprova representação, e a aprovação da representação não concede acesso a ninguém.

---

## 3. Itens para lançamento e etapas posteriores

L = lançamento · P = próxima etapa · D = dispensável agora

| Item | Problema resolvido | Classe |
|---|---|---|
| Vincular conta existente só por convite e aceite (substituir `usuarios.ts:203-214`) | Ocupação de e-mail alheio e vínculo sem consentimento | **L** |
| Cercar recursos globais (JSON de pacotes/descontos, PDF/tabela, catálogo público, WhatsApp, agenda pública) | Empresa nova alterando ou vendo dados da instalação | **L** |
| E-mail transacional (D1) com domínio verificado + recuperação de senha ativa | Confirmação de conta e recuperação | **L** |
| Cadastro público + confirmação de e-mail | Entrada sem a equipe | **L** |
| CNPJ: DV + unicidade + "solicitar acesso" | Duplicidade e uso de CNPJ de terceiro | **L** |
| Representação declarada + aprovação manual auditada | Responsável ≠ sócio; fraude com CNPJ alheio | **L** |
| Ações com terceiros (enviar contrato ao cliente, links públicos, mensagens) só com representação aprovada | Contratos emitidos em nome de empresa sem autorização | **L** (decisão D6) |
| Situação comercial separada + bloqueio no servidor (páginas e APIs) | Paywall que não depende do navegador | **L** |
| Teste de 30 dias, um por CNPJ, extensão manual com motivo | Teste e abuso | **L** |
| Checkout hospedado + webhook verificado + reconciliação | Cobrança segura | **L** |
| Tela "Assinatura" no app (plano, próxima cobrança, faturas, cancelar ao fim do período) | Autoatendimento mesmo em provedor sem portal | **L** |
| Aviso de fim de teste dentro do app | Surpresa no bloqueio | **L** |
| Somente leitura após teste/inadimplência, com exportação básica (CSV de clientes, festas, financeiro; PDFs de contratos) | Dados presos; cancelamento justo | **L** |
| Página de preços, termos de uso, política de privacidade, acordo de tratamento de dados (operador), política de cancelamento | Transparência e LGPD (§4.4) | **L** |
| Checklist de implantação + "primeiro resultado útil" (reaproveitar `implantacao.ts`) | Ativação no teste | **L** (versão simples) |
| Canal de suporte na implantação (WhatsApp/e-mail da Kidmais, sem automação) | Buffets travados na configuração | **L** |
| Painel: plano, situação, datas, extensão auditada, exceção com prazo | Operação comercial | **L** |
| Convite da equipe pela Gestão (em vez de criação direta) | Equipe por empresa com consentimento | **L** (consequência do 1º item) |
| Transferência de responsável (convite ao novo + aceite + rebaixamento do anterior) | Saída do responsável; pendência registrada | **L** pelo painel; **P** pela própria empresa |
| Avisos de fim de teste e de falha por e-mail (tarefa agendada) | Lembrete fora do app | **P** (o provedor já envia os de cobrança) |
| Métricas de funil no painel | Avaliar teste e conversão | **P** (no lançamento, consulta SQL de leitura) |
| Proteção anti-robô no cadastro | Contas em massa | **P**, antecipar se houver abuso |
| Consulta de CNPJ em base pública (situação cadastral, QSA) | Apoio à aprovação; não substitui a aprovação | **P** |
| Demonstração com dados fictícios em tenant separado | Ver o produto antes de configurar | **P** (`app/preview-ux` já mostra vitrine; tenant demo exigiria provisionamento) |
| Agenda/fechamento públicos por empresa (domínio ou slug) | Site do buffet com datas | **P** — hoje é uma empresa por deploy; vender isso exige roteamento novo |
| Níveis de plano, adicionais de IA/mensagens | Monetizar uso | **P** (WhatsApp não é por empresa; IA desligada) |
| Cobrança por unidade | Redes de buffet | **D** (limite V1 de uma unidade) |
| Exportação completa estruturada (API/backup) | Portabilidade ampla | **D** agora |
| Mudança de plano com pró-rata | Upgrade | **D** com plano único (mensal ↔ anual na renovação) |

---

## 4. Teste grátis, planos e cobrança

### 4.1 15 × 30 dias (hipótese comercial, sem taxas inventadas)

| | 15 dias | 30 dias |
|---|---|---|
| Configuração (pacotes, tabela, modelo de contrato, perfil) | Ocupa boa parte do prazo | Cabe com folga |
| Ciclo do buffet | Pode não ter nenhuma festa nem fechamento no período | Cobre um mês de vendas e um fechamento financeiro |
| Urgência | Maior | Menor; compensar com marcos e avisos |
| Custo do teste ocioso | Menor | Maior, mas limitado se IA e mensagens ficarem com teto baixo |

**Recomendação [E]**: 30 dias sem cartão, como hipótese, revisada após as primeiras coortes com as métricas do §4.6. A implantação hoje é assistida; 15 dias só faria sentido com implantação autoatendida madura.

### 4.2 Regras do teste (alternativas e recomendação)

| Tema | Alternativas | Recomendação |
|---|---|---|
| Início | (a) criação da empresa; (b) aprovação da representação; (c) primeiro resultado útil | **(a)**, simples e previsível; extensão manual cobre atrasos na aprovação |
| Unicidade | por CNPJ; por e-mail; por pessoa | **Por CNPJ** (raiz + filial? decisão D4). Pessoa e e-mail não limitam |
| Exceções | reabrir teste; estender | **Extensão** pelo painel, com motivo, prazo e auditoria; nunca um segundo teste automático |
| Funcionalidades | tudo; tudo com tetos | **Tudo do plano**, com tetos de custo (IA por `AI_BUDGET_JSON`/allowlist; ações com terceiros só após aprovação) |
| Fim sem pagamento | bloqueio total; somente leitura | **Somente leitura por 60 dias** [E] com exportação e botão de assinar; depois bloqueio de acesso com dados retidos pelo prazo da política (D8); **nunca exclusão automática** sem política aprovada |
| Prevenção de abuso | cartão obrigatório; consulta CNPJ; limites | CNPJ único + e-mail confirmado + limite por IP + aprovação para ações com terceiros. Sem cartão obrigatório |

### 4.3 Planos e dados que faltam para precificar

Plano único no lançamento, por empresa (uma unidade), mensal e anual com desconto. **Não proponho preço**: faltam

- custo de infraestrutura por empresa (Render starter, banco, crescimento de `bytea`) [?];
- custo de IA por empresa — o 055a já mede: levantar o uso real da Kidmais [?];
- custo de e-mail e, no futuro, WhatsApp por empresa [?];
- horas de suporte por implantação [?];
- tarifas do provedor (§5) e tributos da entidade vendedora (regime, ISS, NFS-e) [?];
- preços de concorrentes para buffets e meta de margem/retorno [?];
- limite do Pix de R$ 3.000 na Stripe, que afeta o anual (§5) [F].

### 4.4 Requisitos legais sustentados por fonte (precisam de avaliação jurídica para SaaS B2B)

- **CDC art. 2º**: consumidor inclui pessoa jurídica "destinatário final"; se o buffet é consumidor é avaliação caso a caso. **CDC art. 49**: 7 dias de arrependimento na contratação fora do estabelecimento. <https://www.planalto.gov.br/ccivil_03/leis/l8078compilado.htm>
- **Decreto 7.962/2013** (contratação eletrônica de consumo): identificação (nome empresarial, CNPJ, endereço), preço e condições em destaque, resumo do contrato antes de contratar, confirmação imediata, atendimento eletrônico inclusive para cancelamento, meio claro de arrependimento. <https://www.planalto.gov.br/ccivil_03/_ato2011-2014/2013/decreto/d7962.htm>
- **Decreto 11.034/2022 (SAC)**: alcance limitado a serviços regulados pelo Executivo federal; em princípio não se aplica, mas é boa prática cancelar pelo mesmo meio, com efeito imediato e comprovante. <https://www.planalto.gov.br/ccivil_03/_ato2019-2022/2022/decreto/D11034.htm>
- **LGPD**: a Kidmais é **operadora** dos dados dos clientes do buffet (arts. 5º VI–VII, 37, 39, 42 §1º I, 46) e **controladora** dos dados dos assinantes. Faltam acordo de tratamento de dados e lista de suboperadores (provedor de pagamento, e-mail, IA, hospedagem). <https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709compilado.htm>; Resolução CD/ANPD 15/2024 (incidentes: 3 dias úteis) <https://www.gov.br/anpd/pt-br/assuntos/noticias/anpd-aprova-o-regulamento-de-comunicacao-de-incidente-de-seguranca>.

### 4.5 Separação de estados e paywall

Cinco eixos independentes, nenhum derivado do navegador:

| Eixo | Onde | Valores |
|---|---|---|
| Situação da empresa (plataforma) | `empresas.status` (existe) | ATIVA, SUSPENSA (fraude/ordem administrativa), DESATIVADA |
| Verificação do CNPJ | novo, no cadastro | DV válido; consulta externa (P) com data e fonte |
| Representação | nova tabela por empresa e pessoa | DECLARADA, APROVADA, RECUSADA, REVOGADA; evidência; quem aprovou |
| Implantação | `plataforma_empresas_cadastro` (existe) | sem mudança |
| Assinatura | nova tabela | TESTE, ATIVA, EM_ATRASO, CANCELADA_FIM_PERIODO, ENCERRADA; datas de teste/período; ids do provedor |
| Exceção comercial | nova tabela | tipo, motivo, válida até, quem concedeu |
| Permissões | `memberships` + capacidades (existe) | sem mudança |

**Acesso comercial derivado** (função única no servidor, calculada pela data do banco, sem depender de tarefa agendada): `COMPLETO` | `SOMENTE_LEITURA` | `BLOQUEADO`.

- Aplicado junto de `provarTenant`/`withTenantTransaction`: métodos de escrita recusados com código próprio (ex.: 402 `ASSINATURA_NECESSARIA`) em `SOMENTE_LEITURA`; leitura recusada em `BLOQUEADO`; lista explícita de rotas sempre permitidas (assinatura, exportação, perfil/senha, sair).
- Páginas `/admin`: hoje a guarda é só no cliente — acrescentar verificação no servidor (layout de servidor ou `proxy`) para exibir o estado, sem depender dela para segurança (a API é a barreira).
- `SUSPENSA` continua sendo decisão administrativa; teste vencido ou atraso **não** suspendem a empresa nem derrubam sessões.

**Efeitos sobre compromissos existentes** (política proposta, decisão D7):

| Superfície | Teste vencido / atraso |
|---|---|
| Contratos já enviados ao cliente final | Continuam acessíveis para ver, baixar e **concluir a assinatura do cliente** (o prejudicado seria o cliente do buffet) |
| Novos contratos, novos envios, novas festas | Bloqueados |
| Agenda pública | Não se aplica a empresas novas (uma empresa por deploy); Kidmais fora do paywall |
| Tarefas agendadas / integrações | Não existem hoje; futuras devem consultar o acesso comercial |
| Empresa `SUSPENSA` (administrativa) | Hoje o contrato público não confere a empresa — decidir se suspensão administrativa também preserva contratos enviados |

---

## 5. Provedores (fontes oficiais lidas em 06/10/2026)

| | Stripe (BR) | Asaas | Pagar.me | Mercado Pago | Efí |
|---|---|---|---|---|---|
| Assinatura nativa no cartão | Sim | Sim | Sim | Sim (`preapproval`) | Sim |
| Pix por fatura | Sim, "por convite", até R$ 3.000 | Sim | Não na recorrência | [?] | Sim |
| **Pix Automático** | **Não** para conta BR | **Sim** (Jornada 3, modo `SUBSCRIPTION`) | Não | [?] | Sim (nós criamos cada cobrança) |
| Boleto recorrente | Sim | Sim | Sim | [?] | Sim |
| Checkout hospedado | Sim | Sim, recorrente **só cartão** | Sim | [?] | Link de assinatura |
| Portal do assinante | **Sim** | [?] | [?] | [?] | [?] |
| Teste sem cartão | Nativo | Controlado por nós (1ª cobrança em +30 dias) [E] | [?] | Plano exige cartão | `trial_days` só cartão |
| NFS-e | Não encontrada | **Nativa**, automática por assinatura | [?] | [?] | Não (só fórum) |
| Autenticação do webhook | HMAC-SHA256 | Token fixo em header | v5 [?] | HMAC-SHA256 | mTLS (Pix) / token |
| Ordem dos eventos | Sem garantia | Opção sequencial | [?] | [?] | Garantida (Cobranças) |
| Tarifas publicadas | Cartão 3,99% + R$ 0,39; boleto R$ 3,45; **+0,7% Billing** | Cartão 2,99% + R$ 0,49; boleto/Pix R$ 1,99; NFS-e R$ 0,49 | Cartão 4,19%; Pix 0,99% | [?] (página 403) | Cartão 3,49%; Pix Automático R$ 3,50 |

Fontes: <https://stripe.com/br/pricing>, <https://docs.stripe.com/payments/pix>, <https://docs.stripe.com/payments/pix/pix-automatico>, <https://docs.stripe.com/billing/subscriptions/trials/free-trials>, <https://docs.stripe.com/customer-management>, <https://docs.stripe.com/webhooks>; <https://www.asaas.com/precos-e-taxas>, <https://docs.asaas.com/reference/criar-nova-assinatura>, <https://docs.asaas.com/docs/pix-automatico>, <https://docs.asaas.com/docs/emitir-notas-fiscais-automaticamente-para-assinaturas>, <https://docs.asaas.com/docs/sobre-os-webhooks>; <https://pagar.me/precos>, <https://docs.pagar.me/reference/criar-plano-1>, <https://docs.pagar.me/docs/checkout_pagarme_skill_subscription.md>; <https://www.mercadopago.com.br/developers/pt/docs/subscriptions/overview>; <https://sejaefi.com.br/tarifas>, <https://dev.efipay.com.br/docs/api-cobrancas/assinatura>, <https://dev.efipay.com.br/en/docs/api-pix/pix-automatico/>.

**Pix Automático (BCB)**: obrigatório para PSPs pagadores desde 16/06/2025; **facultativo para o recebedor** (por isso há gateways sem suporte); o recebedor precisa ser **PJ com CNPJ ativo há pelo menos 6 meses**. <https://www.bcb.gov.br/content/estabilidadefinanceira/pix/pix-automatico-FAQ-participantes.pdf>; <https://normativos.bcb.gov.br/Votos/BCB/202568/Voto_do_BC_68_2025.pdf>.

**Leitura [E]**: como o teste e o paywall ficam no nosso sistema de qualquer forma, o teste nativo da Stripe pesa pouco. Para buffets brasileiros, Pix Automático, boleto e NFS-e nativa pesam mais → **Asaas** é a candidata principal. Contrapartidas: sem portal confirmado (construímos a tela "Assinatura"), webhook com token fixo (tratar o evento como aviso e **reconsultar o estado na API** antes de mudar qualquer coisa), checkout recorrente só cartão. **Stripe** é a alternativa se cartão bastar e a NFS-e ficar com emissor separado (+0,7% de Billing). Não confirmado: retentativas de cartão e pró-rata na Asaas, portal de Asaas/Pagar.me/MP/Efí, tarifa do Pix Automático na Asaas.

**Desenho de webhook (qualquer provedor)**: verificar autenticidade em tempo constante → gravar o evento bruto em tabela com `UNIQUE(provedor, evento_id)` → responder 200 rápido → processar idempotente: reconsultar assinatura/cobrança no provedor, aplicar transição só se avançar o estado (evento antigo não reverte) → auditar. Reconciliação diária comparando assinaturas ativas com o provedor (exige tarefa agendada no Render — custo novo).

---

## 6. Painel do desenvolvedor — controles comerciais

Faltam: plano e situação da assinatura; datas de teste, período e renovação; uso (custo de IA do 055a, contagem de usuários, volume de documentos); pagamentos e falhas (espelho dos eventos, link para o provedor); **extensão de teste** com motivo, prazo e auditoria; **exceção comercial** com prazo (ex.: cortesia, parceiro); aprovação/recusa/revogação de representação com evidência; histórico de alterações (reusar `auditarPainel`, `lib/desenvolvedor/auditoria.ts:52-71`); métricas de funil.

Regra: toda ação comercial altera **somente** os eixos comerciais da empresa alvo. Nenhuma concede `plataforma_desenvolvedores`, papel global, membership em outra empresa ou leitura de dados de negócio da empresa.

---

## 7. Decisões para Felipe

| # | Decisão | Recomendação |
|---|---|---|
| D1 | Provedor de e-mail transacional e domínio remetente (pendente do painel) | Resend, já integrado |
| D2 | Entidade vendedora (CNPJ, regime, ISS, NFS-e) e se tem 6 meses de CNPJ (Pix Automático) | — |
| D3 | Provedor de cobrança | Asaas e Stripe em sandbox; decidir após o teste |
| D4 | Unicidade do teste: CNPJ completo ou raiz (matriz/filial); aceitar CPF/MEI? | CNPJ completo; só CNPJ |
| D5 | Duração e início do teste | 30 dias a partir da criação da empresa |
| D6 | O que exige representação aprovada | Envio de contratos e links ao cliente final; mensagens |
| D7 | Política para contratos já enviados quando o teste vence ou a cobrança falha | Cliente final conclui; empresa não cria novos |
| D8 | Prazos: regularização após falha, somente leitura, retenção após encerramento | 7 dias / 60 dias / definir com advogado |
| D9 | Escopo do lançamento: só o Manager interno ou também agenda/fechamento públicos por empresa | Só o Manager |
| D10 | IA e WhatsApp no plano de lançamento | IA com teto por empresa; WhatsApp fora |
| D11 | Revisão jurídica: termos, privacidade, acordo de tratamento, CDC/Decreto 7.962 | Antes de publicar |

---

## 8. Plano técnico (entregas pequenas e verificáveis)

Cada entrega em clone e branch próprios a partir de `staging`, com migration separada quando houver, testes no PostgreSQL descartável e autorização explícita para aplicar migrations e publicar.

| # | Entrega | Conteúdo | Verificação |
|---|---|---|---|
| E0 | Pré-requisitos operacionais | Confirmar por leitura autorizada o estado da 063/064; cutover de produção já planejado; D1 configurado; recuperação de senha ativa | Smoke de convite e recuperação com caixa real |
| E1 | Consentimento no vínculo | Gestão passa a **convidar**; conta existente só entra por aceite com senha; remover criação de identidade com senha de terceiro | Testes: e-mail existente não é vinculado sem aceite; e-mail novo não recebe senha definida por terceiro |
| E2 | Cercar recursos globais | Pacotes/descontos em JSON, PDF/tabela, catálogo público, WhatsApp: só autoridade de plataforma ou empresa Kidmais; auditoria rota a rota | Teste: Gestão de empresa nova recebe 403 em cada um |
| E3 | Modelo comercial (migration) | CNPJ único por empresa, assinatura, representação, exceção, eventos de cobrança; função de acesso comercial | Testes de CHECK/transições; acesso derivado por data |
| E4 | Paywall no servidor | Verificação junto de `withTenantTransaction`; rotas sempre permitidas; estado no layout de servidor | Matriz rota × estado (COMPLETO/LEITURA/BLOQUEADO); isolamento entre empresas |
| E5 | Painel comercial | Ver e alterar eixos comerciais; extensão/exceção com motivo; aprovação de representação | Auditoria gravada; nenhuma concessão de plataforma |
| E6 | Cadastro público | Conta, confirmação de e-mail, empresa, CNPJ duplicado → solicitar acesso, segunda empresa | Testes de duplicidade, enumeração, limite por IP |
| E7 | Implantação guiada | Checklist sobre `implantacao.ts`; marco de primeiro resultado útil | Teste com empresa nova até CONCLUIDA |
| E8 | Cobrança (sandbox) | Checkout, webhook, eventos, reconsulta, tela "Assinatura", cancelamento ao fim do período | Testes de evento duplicado, fora de ordem, assinatura inválida, retorno do checkout sem webhook |
| E9 | Exportação básica e somente leitura | CSV e PDFs; mensagens de estado | Exportação só da própria empresa |
| E10 | Páginas legais e de preço | Conteúdo revisado (D11) | Revisão |
| E11 | Lembretes e reconciliação | Tarefa agendada no Render | Execução idempotente |

Ordem: E0 → E1 → E2 (pré-requisitos de segurança, valem mesmo sem venda) → E3 → E4 → E5 → E6 → E7 → E8 → E9/E10 → lançamento → E11.

---

## 9. Critérios de aceite e testes

**Multiempresa e identidade**
- Usuário com empresas A e B: estado comercial de A não afeta B; seleção de empresa continua revalidada no servidor.
- Cadastro com e-mail existente não cria conta duplicada; segunda empresa só com reautenticação.
- Gestão de A não vincula, não vê e não altera contas de B; convite exige aceite.
- CNPJ já cadastrado: resposta não revela dados da empresa existente; solicitação de acesso avisa a Gestão atual.
- Troca de responsável: novo aceita convite; anterior perde Gestão; auditoria registra.
- Nenhum fluxo público concede `plataforma_desenvolvedores` ou papel global `REPRESENTANTE_AUTORIZADO`.

**Teste e expiração**
- No dia 31 a escrita é recusada no servidor sem tarefa agendada (cálculo pela data do banco); leitura, exportação e assinatura continuam.
- Extensão do teste exige motivo, fica auditada e não reabre teste para outro CNPJ.
- Contrato enviado antes do vencimento continua assinável pelo cliente final (se D7 aprovado).
- Sessões não são derrubadas por vencimento do teste.

**Pagamentos**
- Retornar do checkout sem webhook não libera acesso.
- Mesmo evento entregue duas vezes → um único efeito.
- Eventos fora de ordem (ex.: "pago" depois de "cancelado") → estado final igual ao do provedor após reconsulta.
- Webhook com assinatura/token inválido → 401 e nada gravado além do registro de recusa.
- Falha de cartão → EM_ATRASO; após o prazo D8 → SOMENTE_LEITURA; pagamento posterior → COMPLETO sem perda de dados.
- Cancelamento → acesso até o fim do período pago; depois SOMENTE_LEITURA.
- Reconciliação corrige divergência entre banco e provedor e audita.

**Regressão**: `npm run check:v1:static`, `npx tsc --noEmit`, ESLint, build, `lib/desenvolvedor/painel-063.postgres.test.ts` e novos testes no PostgreSQL descartável.

---

## 10. Custos e dependências

| Item | Tipo | Situação |
|---|---|---|
| Tarifas dos provedores (§5) | [F] | Publicadas; podem variar por negociação |
| +0,7% Stripe Billing | [F] | Só se Stripe |
| NFS-e Asaas R$ 0,49/nota | [F] | Só se Asaas |
| Pix Automático exige CNPJ ≥ 6 meses | [F] | Depende de D2 |
| E-mail (Resend) | [?] | Plano e volume não levantados |
| Tarefa agendada no Render (lembretes, reconciliação) | [?] | Custo do plano não levantado |
| Armazenamento em `bytea` e disco de 1 GB com uma instância | [F] / [E] | Limita escala; armazenamento externo será necessário com muitas empresas |
| Custo de IA por empresa | [?] | Medível pelo 055a |
| Revisão jurídica | [?] | Necessária (D11) |
| Horas de suporte por implantação | [?] | Sem dado |
| Proteção anti-robô | [?] | Só se houver abuso |

---

## 11. Recomendação final

**Menor conjunto para vender com segurança**: E0, E1, E2 (pré-requisitos), E3, E4, E5, E6, E8 com **um** provedor, E9 básico e E10. Ou seja: cadastro com e-mail confirmado, CNPJ único, representação aprovada manualmente antes de ações com terceiros, teste de 30 dias sem cartão controlado no servidor, plano único mensal/anual, checkout hospedado com webhook verificado e reconciliado, tela de assinatura no app, somente leitura com exportação ao fim, e painel com extensão e exceções auditadas. Agenda pública por empresa, WhatsApp, níveis de plano e demonstração ficam para depois.

**Decisões necessárias para iniciar** (as demais podem esperar até E8):
1. D1 — provedor de e-mail e domínio (bloqueia E0 e E6).
2. D2 — entidade vendedora e situação fiscal (bloqueia a escolha do provedor e a NFS-e).
3. D6/D7 — o que exige representação aprovada e o que acontece com contratos já enviados.
4. D9/D10 — escopo do lançamento (só o Manager; IA com teto; sem WhatsApp).
5. Autorização para iniciar E1 e E2, que corrigem riscos existentes independentemente da venda.
