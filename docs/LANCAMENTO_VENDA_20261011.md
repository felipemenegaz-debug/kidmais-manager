# Lançamento da venda — candidata única, testes finais e publicação em produção (11/10/2026)

**Status:** validação local concluída, com limites de cobertura descritos na evidência Codex. Somente metadados remotos consultados; sem escrita remota. Respeitar autorizações vigentes de Felipe e confirmar alterações de alvo/escopo antes de executar.

Atualização Codex: [evidência local](evidencias/lancamento-venda-codex-20261011.md) e [valores aprovados](CONFIGURACAO_VENDA_APROVADA_20261011.json). PostgreSQL: 14 suítes/100 testes (12 aprovadas na primeira rodada; duas corrigidas e repetidas). Concorrência: 9 grupos. Vitrine em build de produção: 6 telas; cadastro e assinatura em desenvolvimento: 8 grupos. Os testes locais não substituem S3/S4 de e-mail real e pagamento sandbox.

## 0. Escopo mínimo de lançamento (congelado)

Entra: venda dos planos Essencial, Profissional e Premium (mensal e anual, Fundador) com cobrança real pelo Asaas; cadastro público
com teste de 15 dias; site de venda honesto; conferência diária de pagamentos desde a primeira venda; Kidmais gratuita com prova.

Não entra (continua “Em breve” e desligado): orçamento online por empresa (`/b/<código>`), assinatura do contrato por código no
WhatsApp para novas empresas, Wall-e, convite da festa, IA (importação e copiloto), cartão nas parcelas, unidade extra, troca de plano
pelo sistema, Pix Automático. Nenhuma funcionalidade nova entra na candidata.

Decisões comerciais preservadas (Felipe, 09/10): Essencial R$ 197, Profissional R$ 347, Premium R$ 597; anual = 10× o mensal;
Fundador 40% por 12 meses, 20 vagas; teste de 15 dias sem cartão; plano escolhido ao assinar; Kidmais Festas permanentemente gratuita.

## 1. Candidata

| Item | Valor |
|---|---|
| **SHA da candidata** | ponta de docs deste pacote (só `docs/` depois do commit de ferramentas/testes `aafd7b57554c89b35501f9867456a39dc8aeb5b4`; aplicação idêntica à base `fa591aa`) |
| Contém | `origin/staging` `b95494f` e `origin/production` `4af8b38` como ancestrais (fast-forward possível nas duas, sem force) |
| Integração staging | 1 conflito (modelos da receita PostgreSQL): mantidos 078 e 079 |
| Integração production | 13 conflitos do módulo de convites promovido isoladamente: 9 arquivos de production idênticos a versões anteriores de staging (mantida a evolução de staging); inventário de migrations de production = subconjunto anterior (mantido o completo até a 079); licença só com diferença de espaços; parágrafo exclusivo de production preservado em `docs/CONVITES_V1_20261008.md`. Conferência automática: nenhum arquivo de production ausente; toda versão de production fora do histórico foi revisada à mão |
| Diferença para staging (código) | 25 arquivos, todos do escopo: Asaas produção, vitrine, trava E2, conferência de pagamentos, gratuidade da Kidmais, P0, F-L |

### O que a candidata corrige (sem funcionalidade nova)

| # | Correção | Commit | Provas offline |
|---|---|---|---|
| B1 | Asaas `producao` (api.asaas.com, chave `$aact_prod_`) **pareado** com `KIDMAIS_DEPLOY_ENV=production`; sandbox recusado em produção e produção recusada fora dela | `723150b` | `asaas.test.ts`, `ofertas.test.ts` |
| B3 | Vitrine: tudo que depende de recurso indisponível com selo “Em breve”; contrato separado da assinatura; horário nobre em todos os planos (sem barreira no servidor); unidade extra Em breve; âncora só com itens disponíveis; exportação e papéis como no produto; Fundador conforme o servidor (automático para as 20 primeiras assinaturas, com o pedido de opinião e depoimento mantido); descrição de busca sem recurso indisponível | `723150b` + `799cda0` | `site.test.ts` 7/7 |
| B9 | Cadastro público recusa (503) enquanto houver bloqueio de agenda antigo sem empresa | `723150b` | `cadastro.test.ts`; caso PostgreSQL em `cadastro-069` |
| B16 | **Conferência de pagamentos em produção desde a 1ª venda**: `scripts/assinatura-cron.cjs` modo `conferir` → `assinatura-reconciliar.cjs` em simulação (nada é gravado; `--aplicar` recusado em produção antes de conectar), alvo exato, provedor de produção, TLS do serviço. Evento de pagamento não concluído ou empresa cujo estado mudaria ⇒ saída 2 (o cron falha e o Render avisa). Correção: reenvio do webhook no painel Asaas ou pacote autorizado | `a31f569` | `assinatura-cron.test.cjs`, `assinatura-reconciliar.test.cjs` |
| B17 | **Gratuidade da Kidmais comprovada**: (a) suíte PostgreSQL com as chaves de produção ligadas — acesso COMPLETO, nenhuma oferta, checkout recusado (`EMPRESA_SEM_COBRANCA`), recursos e vagas sem limite, controle negativo; (b) prova de que só o cadastro público cria assinatura, e só para empresa nova; (c) a conferência diária verifica o invariante (uma `kidmais` ATIVA, sem assinatura, contratação ou vaga Fundador) e reprova com saída 2 se violado | `a31f569` | `kidmais-gratuidade.postgres.test.ts` (rodada L) |
| P0 | Diagnóstico de produção somente leitura (`scripts/diagnostico-lancamento-production.cjs`): migrations 062–079 por objeto, invariante da Kidmais e seu ID, bloqueios globais, presença (nunca valor) das variáveis do lançamento | `a31f569` | `diagnostico-lancamento-production.test.cjs` 5/5 |

Validações offline da candidata integrada: `tsc --noEmit` 0; ESLint 0 erros (1 aviso antigo de staging em
`lib/inteligencia/skills/catalogo.ts`); estática completa **2285/2285**; scripts de staging/produção/convites **212/212**;
`next build` OK.

## 2. Bloqueadores — situação

| # | Bloqueador | Situação | Aceite |
|---|---|---|---|
| B1 | Cobrança real impossível | **corrigido** (código) | S6 + P6 |
| B2 | Conta, chave, token e webhook Asaas de produção | **dado ausente** (§6) | webhook registrado; P0 mostra as variáveis presentes |
| B3 | Vitrine anunciava indisponível | **corrigido** | L4 + S5 |
| B4 | Migrations 074a–079 em produção (078 = isolamento do catálogo) | operação P4 | P0 antes/depois; postchecks PASS |
| B5 | Textos legais em minuta | **dado ausente** (§6) | `minuta: false`, sem `[A DEFINIR]`, nova versão/hash |
| B6 | Identificação e atendimento no site | **dado ausente** (§6) | rodapé sem “a definir” |
| B7 | Nota fiscal / entidade vendedora | **Asaas escolhido**; dados fiscais da conta não verificados (§6) | emissão comprovada antes de P7 |
| B8 | E-mail de produção; confirmação nunca provada com e-mail real | **dado ausente** + teste S3 | S3 PASS |
| B9 | Cadastro com bloqueio global | **corrigido** (código); contagem em P0 | P0 = 0 |
| B10/B17 | Kidmais gratuita com prova | **corrigido** (prova em código + diária); confirmação do ID em P0 | L2 + P0 + P5 + conferência diária |
| B11 | Planos além do Essencial mensal sem pagamento comprovado | teste S4 | S4 PASS |
| B12 | Prazos de inadimplência e retenção | **7/60 aprovados**; retenção ainda pendente (§6) | prazos nos termos e em `ASSINATURA_*_DIAS` |
| B13 | Concorrência física de vagas | teste L3 | PASS |
| B14 | Telas em navegador | testes L4, S3–S5 | PASS |
| B15 | Reconciliar `production` | **resolvido** (§1) | fast-forward em P3 |
| B16 | Conferência de pagamentos desde a 1ª venda | **corrigido** (código); cron em P6 | execução manual PASS antes de P7 e diária |

## 3. Rodada final local (L) — sobre o SHA da candidata

| # | Passo | Aceite |
|---|---|---|
| L0 | HEAD = SHA; árvore limpa; sem `.env*`/`DATABASE_URL`/`PG*`; `env -u KIDMAIS_HOMOLOGACAO_DATABASE_URL`; 55498 livre | — |
| L1 | Cluster descartável novo (`cluster-descartavel-postgres.cjs criar/iniciar/conferir`) | `CONFERE` |
| L2 | Suítes PostgreSQL: `kidmais-gratuidade` (079), `cadastro-069` (com E2), `assinatura`, `cobranca-e8`, `contratacao-e8`, `cobranca-068`, `convites/recuperacao` (079), `fixture-atualizacao-staging` (078) e as 6 da Frente L | todas PASS |
| L3 | Concorrência de vagas C1–C5 | PASS |
| L4 | Navegador (build de produção, só cliques): `/conheca` e `/planos` com selos e sem âncora; cadastro → teste → tela de assinatura (provedor falso) → leitura/bloqueio; desktop e 375×812 | PASS |
| L5 | Parar cluster, preservar pastas, encerrar processos | `PARADO` |

## 4. Rodada final de staging (S) — mesmo SHA

| # | Passo | Aceite |
|---|---|---|
| S0 | Leitura: `origin/staging` = `b95494f`; Render (branch, auto-deploy OFF, LIVE `b95494f`); health; smoke GET; Shell (Felipe): `RENDER_GIT_COMMIT`, `--conferir-restauracao` | divergência → parar |
| S1 | Felipe confere backup/PITR | horário |
| S2 | Push fast-forward sem force; deploy; `RENDER_GIT_COMMIT` = SHA | LIVE |
| S3 | Cadastro com **e-mail real** (domínio de B8): conta → confirmação → empresa sintética → teste de 15 dias; CNPJ repetido → resposta neutra | PASS |
| S4 | Pagamentos sandbox (parte de pagamento de `HOMOLOGACAO_PAGAMENTO_RENOVACAO_STAGING_20261010.md`): Profissional anual e Premium mensal; Essencial 403 no financeiro completo; webhook repetido idempotente | PASS |
| S5 | Vitrine (`SITE_PRECOS_PUBLICADOS=true` na janela): selos, 197/347/597, Fundador 118,20, sem âncora | PASS |
| S6 | Pareamento: `/api/admin/assinatura` mostra cobrança disponível com sandbox; reconciliação de staging em simulação (Shell) com `kidmais.violada = false` | PASS |
| S7 | Encerramento: fixtures desativadas; chaves restauradas; `--conferir-restauracao` = `RESTAURADA` | staging como antes |
| S8 | Evidência sanitizada | commit local |

## 5. Publicação em produção (P) — só com L e S PASS

| # | Passo | Quem | Aceite / parada |
|---|---|---|---|
| P0 | **Antes de promover/deployar:** comando autossuficiente e com SHA-256 em `docs/evidencias/diagnostico-production-comando-codex-20261011.txt`. Executar somente no Shell de `srv-dak77m2d0e5s73b8rkkg`, ≤ 5 min. Cria arquivo temporário em `/tmp`, usa o `pg` já instalado e transação somente leitura. Não requer publicar a candidata para descobrir o schema. | operador autorizado | migrations ausentes listadas; `kidmais.empresas = 1`, sem assinatura; ID mostrado; bloqueios globais; variáveis presentes |
| P1 | Backup custom com SHA-256 no disco + PITR conferido | Felipe | registro |
| P2 | Aplicadores de produção das migrations que P0 mostrar ausentes (hash fixado, precheck/migration/postcheck por transação; 078 com lista de cópias para aprovação) | agente (local) | revisão de Felipe |
| P3 | PR candidata → `production` (fast-forward); auto-deploy OFF conferido; merge | Felipe | `production` = SHA |
| P4 | Migrations na ordem, cada uma PASS | Felipe (Shell) | falha → parar; correção para frente |
| P5 | Deploy manual; health 200; smoke; `RENDER_GIT_COMMIT`; P0 de novo: nada ausente, Kidmais íntegra | agente + Felipe | PASS |
| P6 | Variáveis, uma etapa por vez com smoke: e-mail → `USUARIOS_CRIACAO_DIRETA=desativada` → `ASSINATURA_*_DIAS` (B12) → `ASAAS_AMBIENTE=producao` + chave + token (webhook registrado) → `SITE_*` (B6) → `SITE_PRECOS_PUBLICADOS=true` → `ASSINATURA_PLANOS_ATIVOS=true`. **Cron de conferência** (novo cron Render, mesma branch, comando `node scripts/assinatura-cron.cjs`, diário): `KIDMAIS_DEPLOY_ENV=production`, `KIDMAIS_RECONCILIAR_MODO=conferir`, `KIDMAIS_RECONCILIAR_DATABASE_URL` (interna) + `KIDMAIS_RECONCILIAR_ALVO=kidmais_production@dpg-dak750gae00c73fudmg0-a:5432`, `KIDMAIS_RECONCILIAR_SCHEMA_VALIDADO=074-075`, `DATABASE_SSL` igual ao web, `ASAAS_*` iguais ao web; notificação de falha do Render ligada. Uma execução manual → saída 0, `kidmais.violada = false`. **`CADASTRO_PUBLICO_ATIVO=true` por último.** `COTACAO_PUBLICA_POR_EMPRESA` continua desligada | Felipe (painel) | falha → desfazer na ordem inversa |
| P7 | Primeira venda assistida: Essencial mensal com cobrança real; webhook confirma; acesso liberado; nota conforme B7; conferência do dia seguinte com saída 0 | Felipe | PASS |
| P8 | Atestação JSON (`scripts/production/README.md`, ≤ 24 h, SHA atual) e GO/NO-GO | agente + Felipe | GO não autoriza nada além do aprovado |

**Recuperação:** código → redeploy anterior; variáveis → remover na ordem inversa (cadastro primeiro); migrations → nunca DOWN com
dados; cobrança → cancelar no Asaas e estornar pelo painel. Com as chaves desligadas, a Kidmais e o produto voltam ao estado atual.

## 6. Dados realmente ausentes (só Felipe pode fornecer)

1. **Asaas de produção:** conta ativa do CNPJ vendedor; chave `$aact_prod_…` e token de webhook (32–255 caracteres) novos, cadastrados
   por Felipe direto no painel do Render (nunca no chat); confirmação de que o webhook pode ser registrado no domínio de produção.
2. **Nota fiscal:** Felipe escolheu Asaas. Configurar dados fiscais reais da Kidmais Festas na conta; comprovar emissão antes da primeira venda. Não atribuir automaticamente serviço, alíquota ou regime fiscal.
3. **Textos legais finais:** termos de uso, privacidade, tratamento de dados e cancelamento revisados (substituem a minuta).
4. **Prazos:** Felipe aprovou preparar 7 dias para regularizar e 60 em somente leitura. Retenção após encerramento ainda não foi definida; 60 dias não autorizam exclusão de dados.
5. **Identificação e atendimento:** aprovados nome informado Kidmais Festas, CNPJ 20.119.900/0001-60, endereço SCRN 704/705 bloco D loja 12, Asa Norte, Brasília - DF, CEP 70730-640; suporte e privacidade `felipemenegaz@gmail.com`; vitrine `https://manager.kidmaisfestas.com/conheca` (`SITE_URL` é a origem sem `/conheca`). Confirmar razão social fiscal exata e contatos adicionais se oferecidos; não nomear encarregado automaticamente.
6. **E-mail de produção:** Gmail foi informado como remetente, mas o Resend exige domínio próprio verificado. Proposta ainda não aplicada: `Kidmais Manager <nao-responda@kidmaisfestas.com>`. Conferir domínio no Resend e DNS; manter Gmail como contato. Fonte: https://resend.com/docs/dashboard/domains/introduction.
7. **Kidmais:** confirmar, quando P0 mostrar o ID, que a empresa `kidmais` de produção é a Kidmais Festas.

## 7. Adiáveis (sem anúncio)

Rotina de renovação Fundador (antes do 11º mês); webhook de devolução do Resend; isenção formal da Kidmais em `assinatura_isencoes`
(reforço; a gratuidade já está comprovada e monitorada); orçamento online por empresa, frente F e OTP do cliente existente; prova de
entrega do código por WhatsApp para tirar o “Em breve” da assinatura; troca de plano pelo sistema; unidade extra, Wall-e, convite, IA,
cartão, Pix Automático; revogação após estorno; anti-robô; exportação em lote; rotação da credencial de staging exposta em 07/10.

## 8. Autorizações, em ordem

L1–L5 (local) → S0–S8 (staging) → P0 (leitura em produção) → P1 → P2 (revisão) → P3 → P4 → P5 → P6 (por etapa) → P7 → P8.
