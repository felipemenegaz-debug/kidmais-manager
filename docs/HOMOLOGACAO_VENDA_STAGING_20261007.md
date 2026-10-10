# Venda do Kidmais — homologação real em staging (preparação, 07/10/2026)

Fluxo alvo: cadastro → confirmação de e-mail → empresa → teste grátis → assinatura → pagamento → acesso comercial,
homologado em **staging** com **Asaas sandbox real** e e-mail controlado. **Production não muda** nesta etapa (flags de
cadastro, cobrança e e-mail continuam ausentes lá).

Nada deste documento foi executado em staging. Cada escrita externa (merge, deploy, variável de ambiente, conta Resend,
conta/webhook Asaas, dados sintéticos e limpeza) depende da autorização consolidada da §9.

## 1. Estado real (leitura, 07/10/2026 ~11:15 UTC)

| Item | Estado |
|---|---|
| production | live `c7a3a73` (`dep-db31ilugekts73acqmh0`), tree `10b1206`; 063/064 + 066–069 (relatado); flags de cadastro, cobrança e e-mail **ausentes**; concessão de desenvolvedor de Felipe feita (ID `a5c4b38d-…`) |
| staging | live `755e5fe` (`dep-db301ebncjis73e0hhk0`, #123), tree `df5f4f6`; 066–069 aplicadas (S0/S2–S3); H1–H7 da candidata concluídos; **flags de cadastro, cobrança e e-mail não configuradas** (o painel mostra "Envio de e-mail indisponível"; valores não lidos) |
| staging × production | só 3 arquivos de teste diferem (`c947599`, mock da reautenticação) — ver §2.3 |
| Implementado (código) | cadastro com e-mail verificado (E6), empresa idempotente com teste por CNPJ (068/069), paywall (E4), tela Assinatura e exportação, painel comercial (E5), cobrança Asaas **só sandbox** (E8) com webhook autenticado, reconciliação e liberação manual |
| Provado até aqui | PostgreSQL descartável + provedor **falso** + e-mail em **arquivo**; navegador local. **Nunca** contra o Asaas sandbox real nem com e-mail real |
| Falta | homologação real (esta etapa), decisões comerciais (§8), código de produção do Asaas (recusado de propósito), NFS-e (D2), textos legais (D11) |

## 2. Rastreabilidade

### 2.1 Production (promoção de 07/10)

| Item | Estado |
|---|---|
| Migrations 066–069 | `APLICADA_E_CONFERIDA`, código 0 — **relatado por Felipe**; as saídas brutas estão na conversa Astra e serão anexadas a `cutover/promocao-production-20261007/REGISTRO-PROMOCAO-PRODUCTION-20261007.md` (esta sessão não tem acesso ao banco de production) |
| Concessão de desenvolvedor | `CONCEDIDA`, código 0, commit `c7a3a73`, ID `a5c4b38d-3525-43bd-9e9f-c20222be25c9` (relatado); **não repetir**; painel conferido (P7) |
| Export P2 | **ID e horário pendentes** (pedido a Felipe) |

### 2.2 Credencial de staging exposta — tarefa própria (não executada)

Procedimento em [ROTACAO_CREDENCIAIS_20261007.md](ROTACAO_CREDENCIAIS_20261007.md). Consumidores a atualizar quando o
usuário novo existir:

| Consumidor | Como recebe a URL | Ação |
|---|---|---|
| Serviço `kidmais-manager-staging` (`DATABASE_URL`) | variável do serviço | colar a URL **interna** nova direto no campo do Render (redeploy) |
| Scripts locais de Felipe (`homologacao-venda-066/scripts`, `homologacao-painel-063/scripts/comum-063.ps1`, `cutover/migracao-067-068-staging-20261007`, `cutover/migracao-069-staging-20261007`, `cutover/homologacao-candidata-staging-20261007/*.ps1`) | pedem a URL mascarada no terminal; nada salvo | nenhuma alteração de arquivo; usar a URL **externa** nova na próxima execução |
| Outras sessões/ferramentas | não deveriam ter a URL | conferir por `pg_stat_activity` (`usename` antigo) antes de excluir o usuário antigo |

Validação: health `ready`; login; leitura do diagnóstico; uma escrita sintética autorizada; usuário antigo sem conexões;
só então excluir o antigo. Registro sem valores. Ordem sugerida: **antes** de ligar e-mail/cobrança em staging (a
homologação gera dados de teste que não devem ficar acessíveis com a credencial vazada).

### 2.3 PR #126 (back-merge de production em staging)

`promote/production-20261007@c947599` → `staging`. Diferença real para `staging`: **3 arquivos de teste** (mock da
reautenticação na importação: `scripts/importacao-revisao.ui.cjs`, `scripts/integracao-importados-test-support.ts`,
`lib/integracao-importados/integracao.postgres.test.ts`); nenhum código de produção. CI verde no tree `10b1206`
(run 37602251387).

**Proposta:** fazer o merge da #126 em `staging` (merge commit) **antes** da candidata desta etapa. Efeito: tree de
`staging` = tree de production (`10b1206`), o teste visual da importação deixa de falhar em `staging`, nenhum deploy é
necessário (só testes). Alternativa: fechar a #126 e trazer `c947599` dentro da candidata. Não mergeada — decisão de
Felipe (item A1 da §9).

## 3. Revisão do onboarding

| Ponto | Situação | Evidência |
|---|---|---|
| Confirmação de e-mail | conta só nasce na confirmação; resposta igual para e-mail novo/existente, enviada antes do processamento | `cadastro-069.postgres.test.ts`, `cadastro-publico-ui.cjs` |
| Expiração e uso único | token de 32 bytes só em hash, no fragmento; 24 h; uso único com `FOR UPDATE`; pedido novo substitui o anterior; falha de envio invalida | idem (confirmação vencida, repetida e em corrida) |
| Duplicidade de conta | e-mail único; corrida "conta criada entre pedido e confirmação" recusa e pede login | idem |
| Duplicidade de CNPJ | trava por CNPJ + índices únicos; resposta neutra sem dados da empresa; pedido de acesso | idem (concorrência real em duas conexões) |
| **Retomada após falha** | **DEFEITO CORRIGIDO** (abaixo) | teste novo falha no código de `staging` e passa com a correção |
| Isolamento entre empresas | Gestão só na empresa criada; mesma pessoa com papéis distintos por empresa; papel global neutro | idem + `provarTenant` |
| Razão social/CNPJ × pessoa responsável × representação | três registros distintos: `plataforma_empresas_cadastro` (razão social, CNPJ), `memberships` (Gestão da pessoa), `empresa_representacoes` (`DECLARADA`, não muda acesso) + `empresa_socios` (declarados) | código + testes |
| Nome do responsável | **não é único** (nenhum índice em nome); a mesma pessoa representa empresas diferentes (índice só por empresa+pessoa) | teste novo "nome da pessoa não é único" + "mesma pessoa em vários CNPJs" |
| CNPJ × comprovação | a tela diz "Conferimos os dígitos do CNPJ. Isso não comprova a existência da empresa nem quem a representa."; representação fica `DECLARADA` até decisão da plataforma; nenhuma consulta governamental integrada | `app/cadastro/empresa/page.tsx`, `lib/cadastro/publico.ts` |

### Defeitos corrigidos nesta etapa

1. **Resposta perdida + página recarregada = "CNPJ já cadastrado" para a própria empresa.** A chave de idempotência
   nasce por carregamento da página; se a empresa era criada e a resposta se perdia, recarregar gerava chave nova e o
   servidor tratava o CNPJ (agora dele) como de terceiros: mensagem neutra **e pedido de acesso da pessoa à própria
   empresa**. Correção (`lib/cadastro/publico.ts`): antes do limite diário e da trava, se a mesma pessoa já criou a
   empresa desse CNPJ pelo cadastro **e mantém a Gestão ativa numa empresa ATIVA**, devolve a mesma empresa
   (`repetido: true`). Sem vínculo ativo, continua a resposta neutra (teste "retomada só para quem criou e mantém a Gestão").
   **Por que a retomada só devolve empresa da própria conta com Gestão ativa** — a consulta exige, na mesma linha:
   - `cadastros_empresas.usuario_id = <usuário da sessão>` e `documento = <CNPJ normalizado e com dígitos válidos>`: a
     linha só é gravada pelo próprio `cadastrarEmpresa`, na transação que cria a empresa, com o usuário **da sessão do
     servidor** (nunca do corpo da requisição); a tabela é só-inserção (gatilho da 069) e `empresa_id` é único — cada
     empresa tem exatamente um registro de quem a criou;
   - `memberships` da **mesma** pessoa e **mesma** empresa com `status = 'ATIVA'` e `papel = 'REPRESENTANTE_AUTORIZADO'`
     (Gestão) e `empresas.status = 'ATIVA'` — as mesmas condições de vínculo e empresa que `provarTenant` aplica a cada
     requisição do Admin. Vínculo revogado ou empresa suspensa → nada é devolvido e segue a resposta neutra.
   - Empresa criada por outra via (painel do desenvolvedor, perfil legado) não tem linha em `cadastros_empresas` → nunca
     é "retomada", mesmo que a pessoa tenha vínculo nela.
   - Concorrência da mesma conta (duas abas, chaves diferentes): a transação começa travando a linha da conta
     (`travarUsuariosNaOrdem`, `FOR UPDATE`); a segunda espera a primeira terminar e, em READ COMMITTED, a consulta já vê
     a empresa criada → as duas respostas devolvem a mesma empresa, nenhum pedido de acesso. Teste com duas conexões
     reais; falha no código de `staging`.
   - O que volta é só o id da própria empresa e o fim do teste; nada de terceiros.
2. **Botão preso em "Cadastrando…" quando a conexão cai.** O `fetch` rejeitado não era tratado. Agora mostra "A conexão
   falhou antes da resposta. Tente de novo…" e libera o botão; a mesma chave (ou a retomada do item 1) evita duplicidade.
3. **Conta confirmada sem empresa não tinha caminho claro de volta.** A tela "Sem empresa ativa" agora oferece
   "Cadastrar sua empresa" quando o cadastro está aberto (`components/admin/AdminShell.tsx`).

### Preparado enquanto as decisões não vêm

- `ASSINATURA_REGULARIZACAO_DIAS` (0–30, padrão proposto 7) e `ASSINATURA_SOMENTE_LEITURA_DIAS` (0–365, padrão proposto
  60) tornam configuráveis os prazos que eram constantes. **Continuam hipóteses**; sem variável o comportamento é o de
  hoje. Lidas só para empresa com assinatura (a Kidmais, sem cobrança, nunca depende delas). Em staging permitem provar
  teste → somente leitura → bloqueio → recuperação em dias, não em meses.

## 4. Recursos e configuração para staging

**Nenhum segredo passa por chat.** Valores são colados por Felipe direto no campo **Environment** do serviço
`kidmais-manager-staging` (Render → serviço → Environment → Add/Edit). Salvar as variáveis **redeploya** o serviço
(mesmo commit): fazer **uma única** gravação com todas as variáveis do bloco.

| Variável (staging) | Valor | Efeito | Custo | Reversão |
|---|---|---|---|---|
| `EMAIL_PROVIDER` | `resend` | convites, recuperação e confirmação de cadastro passam a enviar e-mail real a partir de staging | ver Resend abaixo | apagar (volta a `desativado`) |
| `RESEND_API_KEY` | **segredo** (chave só de envio, exclusiva de staging) | idem | — | apagar a variável e revogar a chave no Resend |
| `EMAIL_REMETENTE` | `Kidmais Manager (staging) <nao-responda@<subdominio verificado>>` | remetente | — | apagar |
| `USUARIOS_CRIACAO_DIRETA` | `desativada` | criação direta de usuário no Admin de staging some; equipe só por convite (pré-requisito do cadastro) | — | apagar (volta a ligada) |
| `CADASTRO_PUBLICO_ATIVO` | `true` | `/cadastro` de staging aberto a **qualquer pessoa que tenha a URL** (limites por IP/e-mail; sem CAPTCHA) | — | apagar (503 imediato após redeploy) |
| `ASSINATURA_TESTE_DIAS` | `1` durante o ensaio | empresas **novas** nascem com teste de 1 dia (gravado na criação; não muda as já criadas) | — | apagar (padrão 15) |
| `ASSINATURA_REGULARIZACAO_DIAS` / `ASSINATURA_SOMENTE_LEITURA_DIAS` | `1` / `1` durante o ensaio (exigem a candidata desta etapa) | prazos encurtados para **toda** empresa de staging com assinatura (só as sintéticas têm) | — | apagar (7/60) |
| `ASSINATURA_PRECO_MENSAL_CENTAVOS` / `ASSINATURA_PRECO_ANUAL_CENTAVOS` | valores **de teste** (ex.: `990` / `9900`), sem significado comercial | checkout mostra e aceita esses ciclos | nenhum (sandbox) | apagar (ciclo indisponível) |
| `ASAAS_AMBIENTE` | `sandbox` | liga a cobrança contra `https://api-sandbox.asaas.com/v3` (URL fixa no código) | nenhum (sandbox) | apagar (checkout e webhook 503) |
| `ASAAS_API_KEY` | **segredo** `$aact_hmlg_…` da conta sandbox | idem | — | apagar e revogar no sandbox |
| `ASAAS_WEBHOOK_TOKEN` | **segredo** aleatório 32–255 caracteres (gerado no terminal de Felipe, ex. `openssl rand -base64 48`) | webhook aceita só com esse token | — | apagar; desativar o webhook no sandbox |
| `RECUPERACAO_SENHA_ATIVA` | `true` (opcional) | "Esqueci minha senha" público em staging | — | apagar |

Os valores **não secretos** do ensaio estão em [homologacao/staging-venda-sintetica.env.exemplo](homologacao/staging-venda-sintetica.env.exemplo),
marcado como sintético e só de staging; `lib/assinatura/configuracao-homologacao.test.ts` confere que ele passa pelos
validadores da aplicação, que não contém segredo e que os valores diferem dos padrões propostos (que também não são
política aprovada).

### Recursos externos (feitos por Felipe nos painéis; esta sessão não cria contas)

| Recurso | Passos | Custo | Reversão |
|---|---|---|---|
| **Resend + subdomínio verificado** | Sem domínio verificado o Resend só envia de `onboarding@resend.dev` para o e-mail **da própria conta** (403 para qualquer outro destino) — insuficiente para testar duas contas e um CNPJ repetido. Criar conta, adicionar um subdomínio dedicado (ex. `mail.kidmaisfestas.com`), publicar **exatamente** os registros DNS mostrados pelo Resend (SPF/DKIM; DMARC `p=none`), aguardar "Verified", criar chave **só de envio** para staging | plano gratuito do Resend (cota diária/mensal limitada; confirmar na página de preços no dia); DNS sem custo | revogar a chave; remover o domínio e os registros DNS |
| **E-mail de teste controlado** | aliases `+` de uma caixa de Felipe (`<caixa>+kmh-a@…`, `+kmh-b`, `+kmh-c`) para ler e clicar os links; `bounced@resend.dev` para falha de entrega | — | — |
| **Asaas sandbox** | conta em `https://sandbox.asaas.com` com dados de teste da Kidmais (sem contato de terceiros: o sandbox pode enviar e-mail/SMS reais); chave `$aact_hmlg_…`; Integrações → Webhooks → URL `https://kidmais-manager-staging.onrender.com/api/integracoes/asaas/webhook`, token = `ASAAS_WEBHOOK_TOKEN`, eventos de cobrança e de assinatura | sem custo (sandbox; nenhuma cobrança real) | desativar o webhook; revogar a chave |

O webhook é público (fora de `/api/admin`, sem trava de origem administrativa) e autenticado pelo token; sem
`ASAAS_AMBIENTE=sandbox` responde 503.

## 5. Dados sintéticos

| Item | Valor | Observação |
|---|---|---|
| Pessoa A (Gestão, empresa 1) | "Ensaio KMH A", `<caixa>+kmh-a@…` | conta nova pelo cadastro |
| Pessoa B (Equipe, empresa 1) | `<caixa>+kmh-b@…` | por convite da Gestão |
| Pessoa C (Gestão, empresa 2) | mesmo nome da A ("Ensaio KMH A") | prova nome não único e isolamento |
| Empresa 1 / 2 | "ENSAIO KMH Buffet 1/2"; CNPJs sintéticos com dígitos válidos gerados no dia | **o CNPJ fica reservado para sempre** em staging (teste por CNPJ, 068); conferir antes que não existe |
| Pagamento | cartão fictício válido gerado para teste (aprovação) ou `5184019740373151` / `4916561358240741` (recusa), conforme a documentação oficial do Asaas em 08/10/2026; Pix/boleto pela confirmação simulada `POST /v3/sandbox/payment/{id}/confirm` | nunca cartão real |
| Marcadores | prefixo `ENSAIO KMH` no nome; referência externa no Asaas = id da empresa | facilitam a limpeza |

## 6. Roteiro de cenários (staging, depois da autorização)

Regra de parada: na **primeira divergência**, não fazer nova escrita; registrar estado (tela, evento, linha de
`cobranca_eventos`, painel do provedor) e a recuperação. Evidência marcada como **real** (staging + sandbox),
**local** (PostgreSQL descartável) ou **falso** (provedor simulado).

| # | Cenário | Como em staging | Esperado | Evidência |
|---|---|---|---|---|
| 1 | Cadastro e confirmação | A pede conta; link chega na caixa; abrir; abrir de novo | conta só após o clique; 2ª abertura "link inválido/usado"; e-mail repetido recebe aviso sem link | real |
| 2 | Expiração do link | — (24 h) | recusa | local (relógio) |
| 3 | Empresa e retomada | A cadastra empresa 1; recarrega e reenvia; C usa o CNPJ de 1 | uma empresa; A retoma; C recebe resposta neutra + pedido de acesso | real |
| 4 | Início do teste | após criar | aviso "Teste grátis até…" (1 dia) | real |
| 5 | Término do teste | dia seguinte (teste 1 dia) | somente leitura: GET 200, POST 402; exportação disponível | real |
| 6 | Bloqueio | dia seguinte (`SOMENTE_LEITURA_DIAS=1`) | dados 402; Assinatura, perfil e exportação abertos | real |
| 7 | Checkout | Gestão → Assinar (mensal) | 1 cliente e 1 assinatura no sandbox (referência = empresa); fatura hospedada | real |
| 8 | Clique duplo / duas abas | dois "Assinar" | 409 `CONTRATACAO_EM_ANDAMENTO` ou "Continuar pagamento" — **uma** assinatura no sandbox | real |
| 9 | Pagamento | cartão de teste / confirmação sandbox | webhook `PROCESSADO`; situação `ATIVA`; acesso completo volta (recuperação do bloqueio) | real |
| 10 | Webhook duplicado | reenviar o mesmo evento pelo log de webhooks do sandbox | 200; nenhum segundo registro/efeito | real |
| 11 | Webhook atrasado/fora de ordem | reenviar um evento antigo depois de um novo | estado = reconsulta do provedor; nada regride | real (reenvio manual) + falso |
| 12 | Token errado | requisição sem/ com token errado | 401, auditoria sem corpo | real |
| 13 | Timeout / resultado incerto | não provocável no sandbox sem alterar código | 503 incerto, intenção aberta, **nenhum 2º POST** | local + falso (16 cenários) |
| 14 | Reconciliação | painel → "Sincronizar com o provedor"; script de reconciliação em **simulação** contra staging (autorização própria) | estado igual ao sandbox; nada removido | real (painel) / real-simulação (script) |
| 15 | Liberação manual auditada | só existe com intenção aberta sem id (cenário 13) | recusas e auditoria `COBRANCA_INTENCAO_LIBERADA` | local |
| 16 | Cancelamento | Gestão cancela (senha recente) | `CANCELADA_FIM_PERIODO`; acesso completo até `periodo_atual_fim`; assinatura removida no sandbox | real |
| 17 | Atraso → somente leitura → bloqueio → recuperação | exige cobrança vencida de assinatura paga (próximo ciclo); o sandbox não antecipa | `EM_ATRASO`, regularização, leitura, bloqueio, pagamento devolve | local + falso (verificar no sandbox se é possível vencer uma cobrança; se não, fica local) |
| 18 | Exportação autorizada | Gestão exporta clientes e contas a receber; Equipe tenta | CSV para Gestão (auditado); Equipe recusada | real |
| 19 | Permissões | Gestão, Equipe (B), desenvolvedor | Equipe não vê contratar/cancelar; desenvolvedor sincroniza com senha recente, sem ganhar papel | real |
| 20 | Isolamento | C tenta ler/agir na empresa 1 (seleção e IDs da 1) | 403/404; nada vaza | real + local |
| 21 | Kidmais em staging | conferir Admin da Kidmais | continua "Sem cobrança", sem aviso | real |
| 22 | Desktop e celular | navegador da sessão (1440 e 390 px) | sem rolagem horizontal; fluxos utilizáveis | real |

Critério de "sem duplicidade de cobrança": no sandbox, por empresa sintética, **no máximo uma assinatura não removida**
e nenhuma cobrança paga em duplicidade; conferido no painel do sandbox e em `cobranca_eventos`.

## 7. Limpeza (depois do ensaio)

| Onde | Ação | Observação |
|---|---|---|
| Sandbox Asaas | cancelar pela aplicação (cenário 16) as assinaturas restantes; remover clientes sintéticos no painel do sandbox | isolado do real |
| Banco de staging | **não apagar**: suspender as empresas `ENSAIO KMH` pelo painel do desenvolvedor (auditado); revogar vínculos de B e C | a política proíbe delete; CNPJs e e-mails sintéticos ficam reservados |
| Variáveis de staging | apagar `ASSINATURA_TESTE_DIAS`, `ASSINATURA_REGULARIZACAO_DIAS`, `ASSINATURA_SOMENTE_LEITURA_DIAS`; decidir se cadastro/cobrança/e-mail ficam ligados em staging | uma gravação = um redeploy |
| Resend / sandbox | manter ou revogar chaves | — |

## 8. Decisões comerciais (uma pergunta)

Para ativar a venda, Felipe precisa decidir, de uma vez:

1. **Teste grátis**: duração (15 é proposta; a proposta de 06/10 citava 30) e se começa na criação da empresa (hoje).
2. **Cartão no teste**: sem cartão (implementado) ou cartão obrigatório para começar.
3. **Preços**: mensal e anual (com ou sem desconto), e impostos/NFS-e (D2: entidade vendedora e regime).
4. **Atraso**: dias de acesso completo para regularizar (hipótese 7), dias de somente leitura (hipótese 60), e o que acontece depois (bloqueio com dados retidos — retenção a definir, D8).
5. **Cancelamento**: acesso até o fim do período pago (implementado), sem reembolso proporcional? Estorno/chargeback revoga período já liberado?

Tudo isso já é configuração (`ASSINATURA_*`), exceto cartão obrigatório, NFS-e e regras de estorno (exigiriam código).

## 9. Autorização consolidada pedida para staging

| # | Ação | Alvo | Efeito |
|---|---|---|---|
| A1 | merge da #126 em `staging` (ou fechar) | GitHub | só testes |
| A2 | merge da PR desta etapa em `staging` depois do CI verde | GitHub | código da §3 |
| A3 | deploy manual de `staging` no SHA resultante | Render staging | rollback: redeploy de `dep-db301ebncjis73e0hhk0` (`755e5fe`) |
| A4 | Felipe cria Resend (subdomínio + DNS) e Asaas sandbox (chave + webhook) | painéis externos | §4 |
| A5 | Felipe grava as variáveis da §4 no Environment de staging (uma vez) | Render staging | redeploy do mesmo commit |
| A6 | executar os cenários da §6 com dados da §5, incluindo escritas pela aplicação e e-mails só para as caixas controladas | staging + sandbox | dados sintéticos |
| A7 | script de reconciliação em **simulação** contra o banco de staging (Felipe roda no PC dele) | banco de staging | só leitura efetiva (ROLLBACK por item) |
| A8 | limpeza da §7 | staging + sandbox | suspensões auditadas |

Fora do escopo: production (nenhuma variável, deploy ou migration), e-mail para terceiros, pagamento real, rotação da
credencial (tarefa própria, §2.2).

## 10. Ativação futura em production e rollback (não autorizado)

Pré-requisitos: §8 decidida; staging homologado (critérios abaixo); textos legais revisados (D11) com nova versão;
código de produção do Asaas (`ASAAS_AMBIENTE=producao`, URL `https://api.asaas.com/v3`, chave `$aact_prod_`) com revisão
própria; Resend com chave de production; webhook de production com token novo.

Ordem: (1) e-mail (`EMAIL_PROVIDER`, chave, remetente) + teste com a caixa de Felipe; (2) `USUARIOS_CRIACAO_DIRETA=desativada`;
(3) preços e prazos decididos; (4) cobrança de produção; (5) `CADASTRO_PUBLICO_ATIVO=true` por último. Cada passo é uma
gravação de env (redeploy) com health e smoke.

Rollback: apagar `CADASTRO_PUBLICO_ATIVO` (fecha o cadastro), depois `ASAAS_*` (checkout e webhook 503; assinaturas
existentes continuam no provedor e a reconciliação as relê quando religar), depois e-mail. Código: redeploy do deploy
anterior. Banco: nada a desfazer (migrations aditivas; nunca DOWN com dados). Empresas já criadas e em teste continuam
com acesso calculado pelas datas gravadas.

## 11. Critérios de conclusão da homologação

- fluxo completo da §6 executado com Asaas sandbox real e e-mail real controlado, com evidência classificada (real / local / falso);
- nenhuma duplicidade de cobrança nos cenários;
- permissões e isolamento preservados; Kidmais sem cobrança;
- recuperação operacional documentada (§6, §7 e [COBRANCA_ASAAS_SANDBOX_20261007.md](COBRANCA_ASAAS_SANDBOX_20261007.md));
- flags de production ausentes (conferir por diagnóstico somente leitura);
- candidata com SHA/tree e CI, pronta para Astra.

## 12. Parecer atual

**NO-GO para ativação comercial** hoje: homologação real não feita; decisões da §8 abertas; código de produção do Asaas
ausente por desenho; domínio de e-mail não verificado; textos legais em minuta. **GO para a etapa de staging** assim que
a §9 for autorizada.
