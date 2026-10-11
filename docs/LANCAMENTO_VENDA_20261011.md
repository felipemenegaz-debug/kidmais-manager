# Lançamento da venda — bloqueadores, candidata única, rodada final de staging e publicação em produção (11/10/2026)

**Status:** PREPARADO (local). Nenhuma operação remota executada. Cada passo remoto abaixo exige autorização específica de Felipe.

**Congelamento:** a partir desta data, nenhuma funcionalidade nova entra na candidata. Só correções de bloqueadores desta lista,
testes e documentos. Tudo o que é “Em breve” continua desligado e marcado como tal.

**Princípios mantidos:** Kidmais Festas continua gratuita; nada é anunciado como disponível sem estar ligado e comprovado; produção só
muda com autorização explícita por ação; dados sintéticos em toda homologação.

## 1. Estado de partida (leitura em 11/10, 06:19–07:00Z)

| Item | Evidência |
|---|---|
| Produção | Render `srv-dak77m2d0e5s73b8rkkg` LIVE `dep-db49tpu7bikc73e2l4lg` = `4af8b38` (PR #149, convites), 09/10; `/api/health` 200; branch `production` = `4af8b38` |
| Staging | `origin/staging` = `b95494f` (convites + 079); LIVE `dep-db5iero473hc73b9pi4g` |
| Distância | 124 commits de staging fora de produção (074a–079); 8 commits só em produção (promoção isolada de convites, 68 arquivos, inclusive o inventário de migrations) |
| Schema de produção | **incerto**: último registro verificado 001→018 (15/09, `HANDOFF_V1_PRODUCAO.md:305-316`); 066–069 “relatado” por Felipe em 07/10 (`HOMOLOGACAO_VENDA_STAGING_20261007.md:14,27`, saídas brutas ausentes); 063/064 “estado a confirmar” (`ROTEIRO_VENDA_HOMOLOGACAO_PUBLICACAO_20261007.md:32`); 073/074 provável, não registrado. Pela política, incerteza de migration = **NO-GO** até o diagnóstico P0 |
| Último veredito | “NO-GO para ativação comercial” (`HOMOLOGACAO_VENDA_STAGING_20261007.md:252`); motivos ainda abertos estão na §2 |

## 2. Bloqueadores reais para vender

Critério de entrada: sem o item, ou não se cobra de verdade, ou se vende algo falso, ou se expõe a Kidmais/outra empresa, ou se viola
obrigação legal. Tipo: **C** = código (corrigido nesta candidata), **F** = entrada/decisão de Felipe, **R** = operação remota com
autorização, **T** = teste/homologação.

| # | Bloqueador | Tipo | Evidência | Critério de aceite | Situação |
|---|---|---|---|---|---|
| B1 | Asaas só aceitava sandbox: impossível cobrar de verdade | C | `lib/assinatura/asaas.ts` (antes: `ambiente !== 'sandbox'` → desligado); `ofertas.ts:17` | `producao` aceito **só** com `KIDMAIS_DEPLOY_ENV=production`, chave `$aact_prod_`, URL `api.asaas.com`; sandbox recusado no serviço de produção; testes | **Corrigido** em `723150b` (testes 36/36 + 145/145 dos scripts de staging) |
| B2 | Conta Asaas de produção, chave, token e webhook de produção | F + R | `COBRANCA_ASAAS_SANDBOX_20261007.md:178-185` | Felipe cria/valida a conta (CNPJ vendedor), gera chave `$aact_prod_` e token exclusivos; webhook registrado para `https://<domínio>/api/integracoes/asaas/webhook`; nada reaproveitado do sandbox | Aberto |
| B3 | Vitrine anunciava como disponível o que não está (orçamento online, assinatura por WhatsApp, Wall-e, convite, unidade extra; “4 papéis”; exportação; âncora com itens Em breve; Fundador divergente do servidor; horário nobre excluído do Essencial sem barreira) | C | auditoria de 11/10 (`components/site/secoes.tsx`, `lib/site/catalogo.ts`, `lib/assinatura/recursos-plano.ts`) | toda menção dependente tem selo “Em breve”; âncora some enquanto houver item Em breve; textos iguais ao produto; descrição de busca sem recurso indisponível; testes | **Corrigido** em `723150b` (site 7/7) |
| B4 | Migrations 074, 074a, 075, 076, 077, 078 (e 079 se a promoção a levar) ausentes em produção — 078 é **isolamento do catálogo do buffet** entre empresas | R | `PACOTE_CONSOLIDADO_20261010.md:68-69`; `ATUALIZACAO_STAGING_20261011.md:24` | P0 lista o aplicado; cada pendente com precheck/migration/postcheck PASS em produção, backup antes; 078 com lista de cópias aprovada | Aberto (aplicadores de produção a preparar depois de P0) |
| B5 | Textos legais em minuta com `[A DEFINIR]` (termos, privacidade, tratamento de dados, cancelamento) | F + C | `CADASTRO_PUBLICO_E6_20261007.md:55-58`; `lib/cadastro/cadastro.test.ts` exige `minuta: true` hoje | Felipe entrega os textos revisados; nova versão/hash em `lib/cadastro/documentos-legais.ts`; `minuta: false`; sem `[A DEFINIR]` | Aberto (aguarda texto) |
| B6 | Identificação da empresa vendedora e atendimento no site (`SITE_RAZAO_SOCIAL`, `SITE_CNPJ`, `SITE_ENDERECO`, `SITE_ATENDIMENTO_*`, `SITE_ENCARREGADO_DADOS`, `SITE_URL`) | F + R | `SITE_VENDA_20261008.md:73-87` (“não publicar production com os campos legais/de atendimento vazios”) | rodapé sem “a definir”; canais respondem; `SITE_URL` = origem canônica | Aberto |
| B7 | Emissão fiscal (NFS-e) e entidade vendedora | F | `ROTEIRO_VENDA_HOMOLOGACAO_PUBLICACAO_20261007.md:84`; `COBRANCA_ASAAS_SANDBOX_20261007.md:181` | Felipe define o CNPJ vendedor e como emite a nota (no Asaas ou fora dele) antes da primeira cobrança real | Aberto |
| B8 | E-mail transacional de produção (cadastro devolve 503 sem ele; confirmação de e-mail nunca provada com e-mail real) | F + R + T | `CADASTRO_PUBLICO_E6_20261007.md:49,85`; `EMAIL_TRANSACIONAL_D1_20261007.md:26-35` | domínio verificado (SPF, DKIM, DMARC) e chave exclusiva de produção; em staging, cadastro com e-mail real → confirmação → empresa → teste de 15 dias (S3) | Aberto |
| B9 | Cadastro público podia abrir com bloqueio de agenda antigo sem empresa (trava a agenda de todas as empresas) | C + R | `RECURSOS_GLOBAIS_E2_20261006.md` (“o cadastro público (E6) deve recusar ser ligado enquanto houver algum”) — não implementado | cadastro recusa 503 enquanto existir bloqueio global ativo futuro (código); P0 conta 0 em produção ou a plataforma atribui/libera | **Código corrigido** em `723150b` (unitário 6/6; caso PostgreSQL na rodada L); contagem em produção aberta |
| B10 | Kidmais gratuita com evidência em produção | R | `CONCLUSAO_INTEGRACAO_20261009.md:64-80` (isenção não aplicada; ID não confirmado por CNPJ); código: sem linha em `empresa_assinaturas` → `COMPLETO/SEM_COBRANCA` e sem oferta (`lib/assinatura/acesso.ts:64-66`, `ofertas.ts:79`) | P0/P5 (leitura): exatamente uma empresa `codigo='kidmais'` ATIVA, **sem** linha em `empresa_assinaturas`, sem contratação; smoke da Gestão Kidmais sem oferta de plano. Felipe confirma o ID | Aberto (leitura) |
| B11 | Pagamento de plano além do Essencial mensal nunca comprovado (anual, Profissional, Premium; barreira do financeiro no staging) | T | `HOMOLOGACAO_PAGAMENTO_RENOVACAO_STAGING_20261010.md:6` (“PRONTO PARA APROVAÇÃO, NÃO EXECUTADO”); rodada 5 só Essencial mensal (`ENSAIO_ASSINATURA_RODADA5_20261009.md:34`) | em staging (sandbox): Profissional anual e Premium mensal pagos → acesso liberado, valor correto, webhook idempotente; Essencial recebe 403 no financeiro completo (S4) | Aberto |
| B12 | Política de inadimplência e retenção (7 dias para regularizar, 60 em leitura) são hipóteses | F | `ROTEIRO_VENDA:89`; `PAYWALL_E4_20261007.md:51` | Felipe aprova os prazos (ou outros) e eles entram nos termos (B5) e nas variáveis `ASSINATURA_*_DIAS` | Aberto |
| B13 | Concorrência física das vagas de usuário (limites 3/10 do plano) não reexecutada após a correção do gerador | T | `PACOTE_CONSOLIDADO_20261010.md:62`; `MATRIZ_RECURSOS_PLANOS_20261010.md:51` | C1–C5 PASS em PostgreSQL local descartável (L3) | Aberto |
| B14 | Telas de cadastro, teste, assinatura e bloqueio nunca percorridas em navegador após a correção | T | `PACOTE_CONSOLIDADO_20261010.md:62`; `HOMOLOGACAO_PLANOS_COTACAO_STAGING_20261010.md:138` | navegador local (L4) e staging (S3–S5), desktop e celular, só cliques | Aberto |
| B15 | Promoção para produção precisa reconciliar `production` (8 commits de convites isolados) com a candidata | R | §1; inventário divergente (`scripts/production/check-migrations.mjs`) | candidata contém `origin/staging` e `origin/production`; inventário com 079; regressão; fast-forward possível nas duas branches | Aberto — a integração local foi **recusada pela ferramenta** nesta sessão; exige autorização explícita (F-I) |

## 3. Adiáveis (não impedem vender; não anunciados como disponíveis)

| Item | Por que adiável | Prazo / gatilho |
|---|---|---|
| Reconciliação periódica Asaas em produção (`scripts/assinatura-reconciliar.cjs` recusa produção) | webhook é o caminho principal; Asaas reenvia | **até 30 dias após a primeira venda** (antes da 1ª renovação mensal); até lá, conferência diária manual no painel Asaas e no painel do desenvolvedor |
| Rotina de renovação Fundador (aviso de 30 dias) | primeiro aviso cai ~11 meses após a primeira venda Fundador | antes do 11º mês |
| Webhook de devolução/reclamação do Resend (G3) | entrega funciona sem ele | após o domínio verificado |
| Isenção formal da Kidmais (`assinatura_isencoes`) | sem linha de assinatura a Kidmais já é gratuita e não recebe oferta (B10) | logo após o ID confirmado; operação auditada própria |
| Orçamento online por empresa (`/b/<código>`), frente F, OTP do cliente existente (S7) | “Em breve” no site; chave `COTACAO_PUBLICA_POR_EMPRESA` desligada | rodada própria |
| Assinatura do contrato por código no WhatsApp para novas empresas | “Em breve”; vira disponível com prova de entrega (contratos assinados por OTP em produção) | decisão D-OTP |
| Troca de plano (upgrade/downgrade) | feita pelo atendimento no lançamento | — |
| Unidade extra, Wall-e, convite da festa, IA (importação/copiloto), cartão nas parcelas, Pix Automático | “Em breve” | — |
| Revogação de período após estorno/chargeback; anti-robô no cadastro; exportação em lote de contratos; seletor de pacotes com nomes da Kidmais no painel; regra de pagamento padrão 0% | lacunas conhecidas sem efeito na cobrança correta | backlog |
| Rotação da credencial de staging exposta em 07/10 | staging, sem dado real | recomendado antes da rodada S |

## 4. Candidata única

| Commit | Conteúdo |
|---|---|
| `723150b` | B1 (Asaas produção pareado), B3 (vitrine honesta), B9 (trava E2 no cadastro) |
| `e84f1d6`, `391da0f` | F-L e script de fixtures (infra de teste; não entram no caminho crítico) |
| base `d19f78b` | publicado em staging em 11/10 (078 aplicada em staging) |

Validações offline em `723150b`: `tsc --noEmit` 0; ESLint 0; estática completa **2285/2285**; testes dos scripts de staging/produção
**145/145**; site 7/7; cadastro 6/6; Asaas/ofertas/webhook 36/36; **`next build` OK** (mock de fontes).

Ainda falta para a candidata final (F-I, local, com autorização): integrar `origin/staging` (`b95494f`: 079 e correções de convites) e
`origin/production` (`4af8b38`), revisar conflitos (inventário de migrations, `production.test.mjs`, arquivos de convites), repetir as
validações e apresentar o SHA. A partir dele, nenhuma rodada fragmentada: L → S → P sobre o mesmo SHA.

## 5. Rodada final local (L) — mesma candidata, cluster novo, dados sintéticos

| # | Passo | Aceite |
|---|---|---|
| L0 | Pré-condições (HEAD = SHA; árvore limpa; sem `.env*`/`DATABASE_URL`/`PG*`; `env -u KIDMAIS_HOMOLOGACAO_DATABASE_URL`; 55498 livre) | — |
| L1 | Cluster descartável novo (`cluster-descartavel-postgres.cjs criar/iniciar/conferir`) | `CONFERE` |
| L2 | Suítes PostgreSQL: cadastro-069 (com o caso E2), assinatura/cobrança-e8/contratação-e8/cobrança-068, Frente L (6), F-L (modelo 078), convites (079) | todas PASS |
| L3 | Concorrência física de vagas C1–C5 (B13) | PASS |
| L4 | Navegador local (build de produção): `/conheca` e `/planos` com selos corretos e sem âncora; cadastro → teste → tela de assinatura (sandbox falso) → leitura/bloqueio; desktop e 375×812 (B14) | PASS, só cliques |
| L5 | Parar cluster, preservar pastas, encerrar processos | `PARADO` |

## 6. Rodada final de staging (S) — sobre o SHA aprovado em L

| # | Passo | Aceite |
|---|---|---|
| S0 | Leitura: `origin/staging` = base esperada; Render (branch, auto-deploy OFF, LIVE); health 200; smoke GET | divergência → parar |
| S1 | Felipe confere backup/PITR | horário registrado |
| S2 | Push sem force; `trigger_deploy`; `RENDER_GIT_COMMIT` = SHA (Shell de Felipe) | LIVE |
| S3 | **Cadastro com e-mail real** (B8): chaves de cadastro/e-mail ligadas na janela; conta → confirmação pelo e-mail recebido → empresa sintética → teste de 15 dias; CNPJ repetido → resposta neutra; bloqueio global presente → 503 (B9) | PASS |
| S4 | **Pagamentos em sandbox** (B11), pelo pacote `HOMOLOGACAO_PAGAMENTO_RENOVACAO_STAGING_20261010.md` (parte de pagamento): Profissional anual e Premium mensal; Essencial com 403 no financeiro completo; webhook repetido idempotente | PASS |
| S5 | Vitrine em staging (`SITE_PRECOS_PUBLICADOS=true` na janela): selos, preços 197/347/597, Fundador 118,20, sem âncora; nenhum item indisponível sem selo | PASS |
| S6 | Pareamento Asaas: com `ASAAS_AMBIENTE=producao` em staging → cobrança **desligada** (`AMBIENTE_DIVERGENTE`) — leitura de `/api/admin/assinatura` ou health, sem chamada ao Asaas | PASS |
| S7 | Encerramento: fixtures desativadas; variáveis restauradas (S8 do pacote anterior) e conferidas no Shell (`RESTAURADA`) | staging como antes |
| S8 | Evidência sanitizada | commit local de docs |

## 7. Pacote de publicação em produção (P) — só depois de L e S PASS

| # | Passo | Quem | Aceite / parada |
|---|---|---|---|
| P0 | **Diagnóstico somente leitura** (Shell de produção de Felipe, `READ ONLY`, ≤ 5 min): migrations aplicadas (074…079 por presença de objetos), `empresas codigo='kidmais'` (1, ATIVA) sem `empresa_assinaturas`, bloqueios de agenda globais ativos futuros (contagem), nomes de variáveis presentes (sem valores) | Felipe (comando preparado pelo agente) | incerteza → NO-GO |
| P1 | Backup custom com SHA-256 no disco + PITR conferido | Felipe | registro |
| P2 | Aplicadores de produção das migrations pendentes (preparados depois de P0, com hash fixado, precheck/postcheck, uma transação por migration, 078 com lista de cópias para aprovação) | agente (local) → Felipe autoriza | revisão |
| P3 | PR candidata → `production`; revisão; merge **sem** deploy automático (conferir auto-deploy OFF) | Felipe | `production` = SHA |
| P4 | Migrations na ordem (Shell de Felipe), cada uma PASS | Felipe | falha → parar, correção para frente |
| P5 | Deploy manual do SHA; health 200; smoke; `RENDER_GIT_COMMIT`; B10 (Kidmais sem oferta, acesso completo) | agente + Felipe | PASS |
| P6 | Variáveis na ordem (uma por vez, cada uma com smoke): e-mail (domínio verificado, chave de produção) → `USUARIOS_CRIACAO_DIRETA=desativada` → `ASSINATURA_*` (prazos aprovados em B12) → `ASAAS_AMBIENTE=producao` + chave + token (webhook registrado) → `SITE_*` (B6) → `SITE_PRECOS_PUBLICADOS=true` → `ASSINATURA_PLANOS_ATIVOS=true` → **`CADASTRO_PUBLICO_ATIVO=true` por último**. `COTACAO_PUBLICA_POR_EMPRESA` **continua desligada** | Felipe (painel) | cada etapa com smoke; falha → desfaz na ordem inversa |
| P7 | **Primeira venda assistida**: uma empresa real (ou de Felipe) assina o Essencial mensal com cobrança real de valor mínimo previsto; webhook confirma; acesso liberado; nota emitida conforme B7; estorno conforme política se for teste | Felipe | PASS |
| P8 | Atestação JSON (`scripts/production/README.md`, ≤ 24 h, SHA atual) e GO/NO-GO | agente + Felipe | GO não autoriza nada além do já aprovado |

**Recuperação:** código → redeploy do deploy anterior; variáveis → remover na ordem inversa (cadastro primeiro); migrations → nunca DOWN
com dados (correção para frente); cobrança → cancelar assinatura no Asaas e estornar pelo painel. A Kidmais não depende de nenhuma
dessas chaves: com todas desligadas, o produto volta ao estado atual.

## 8. Entradas e decisões de Felipe (sem elas não há venda)

1. **B2** conta Asaas de produção (CNPJ vendedor), chave e token novos; **B7** nota fiscal.
2. **B5** textos legais finais; **B12** prazos de inadimplência e retenção.
3. **B6** razão social, CNPJ, endereço, e-mail, WhatsApp, horário e encarregado de dados; domínio/`SITE_URL` do site de venda.
4. **B8** domínio de e-mail verificado no Resend e chave de produção.
5. **B10** confirmar que a empresa `kidmais` em produção é a Kidmais Festas (ID lido em P0).
6. Confirmar a redação do Fundador (desconto automático para as 20 primeiras assinaturas; pedido de opinião, sem exigir depoimento)
   e se a “implantação assistida grátis no anual” já tem equipe para ser cumprida (senão, sai da vitrine).
7. **D-OTP** (opcional): autorizar uma leitura que comprove a entrega do código por WhatsApp em produção para tirar o “Em breve” da
   assinatura do contrato.

## 9. Autorizações remotas, em ordem

F-I (integração local de `origin/staging` e `origin/production` — recusada pela ferramenta sem autorização) → L1–L5 (local) → S0–S8
(staging) → P0 (leitura em produção) → P1–P8 (cada passo com autorização própria). Nenhuma autorização é reaproveitada entre passos.
