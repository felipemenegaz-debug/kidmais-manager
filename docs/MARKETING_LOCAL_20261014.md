# Marketing do KidMais Manager — implementação e validação LOCAIS (14–15/10/2026)

> **Renumeração em 18/10/2026 (preparação para staging):** a 083 já é da conexão WhatsApp por empresa
> (`20261016_083_whatsapp_conexao_empresa`, em staging). As migrations do Marketing passaram a ser **084** (base, antes 083)
> e **085** (automações, antes 084): `database/migrations/20261018_084_marketing_base.sql` e `20261018_085_marketing_automacoes.sql`,
> com prechecks, postchecks, rollbacks, funções `kidmais084_*`/`kidmais085_*` e mensagens acompanhando. As referências a 083/084
> neste documento são **históricas** (anteriores à renumeração). Mapa completo: `docs/MARKETING_PREPARACAO_STAGING_20261018.md`.

Goal: `Kidmais-Manager-Second-Brain/02 - Kidmais Manager SaaS/07 - Roadmap/Goal Marketing local para Opus.md`.
Escopo: **somente local**. Nada foi publicado, enviado, provisionado, cobrado ou aplicado fora do cluster PostgreSQL
descartável autorizado. Sem push, PR, merge, deploy, DNS real ou mensagem real.

- Worktree: `D:/glass/KidMais Manager/kidmais-manager-marketing-20261014`
- Branch: `codex/marketing-local-20261014`, commit **local** `bc379ad` (sem push), **REPROVADO** na revisão Codex de
  15/10/2026 (R1–R4, `revisao-marketing-bc379ad-codex-20261015/PARECER.md`).
- Correções R1–R4: worktree `kidmais-manager-marketing-r1r4-20261015`, branch
  `codex/marketing-correcoes-r1-r4-20261015`, novo commit local sobre `bc379ad` (sem amend, sem push) — ver “Correções
  R1–R4 (15/10/2026)”. Commit `64fcd09` **APROVADO** pela revisão independente de 15/10/2026 para encerrar o goal
  local (`revisao-marketing-64fcd09-parecer-20261015/PARECER.md`, observações não bloqueantes O1–O6).
- Observações O1/O2/O6 (e O5): novo commit local sobre `64fcd09` na mesma branch (sem amend, sem push) — ver
  “Observações O1/O2/O6 da revisão de 64fcd09” no fim. Esse commit, `f917f98`, foi **REPROVADO** por F1 na revisão de
  15/10/2026 (`revisao-marketing-f917f98-parecer-20261015/PARECER.md`).
- Correção F1: worktree `kidmais-manager-marketing-f1-20261015`, branch `codex/marketing-correcao-f1-20261015`, commit
  local `2c5aa43` sobre `f917f98` — **APROVADO** para encerrar o goal local de F1
  (`revisao-marketing-2c5aa43-parecer-20261015/PARECER.md`), com N1/P3 documental não bloqueante, tratada em “Estado
  consolidado e errata N1” logo abaixo. Ver também “Correção F1 da revisão de f917f98” no fim.
- Base: `origin/staging` local em `eb6ca81` (merge da PR #164), lida do clone `kidmais-manager-github` sem fetch
  (pode estar defasada em relação ao GitHub; nenhum fetch/pull foi autorizado nesta execução).
- Migrations novas: `083` (base de Marketing) e `084` (automações). Escolha local provisória de número, não reserva
  coordenada: conferir colisão com outras branches antes de qualquer integração.

## Situação (classificação exigida pelo goal)

| Condição | Situação |
|---|---|
| Entrega A implementada local | **Sim** |
| Entrega A validada local | **Sim** — unitários, suítes PostgreSQL descartáveis (evidências 1–6), check estático e UI local (ver “Validações”) |
| Entrega B implementada local | **Sim** |
| Entrega B validada local | **Sim** — unitários e suíte PostgreSQL descartável (evidência 7, inclusive concorrência com 2 conexões) e UI local |
| Integrações reais (DNS/HTTPS público, provedor de domínio, WhatsApp real) | **Fora do escopo — não realizadas** |
| Publicação externa / staging / produção | **Fora do escopo — não realizadas** |
| Revisão independente | `bc379ad` **REPROVADO** (R1–R4); `64fcd09` **APROVADO** para encerrar o goal local (O1–O6 não bloqueantes); `f917f98` (O1/O2/O5/O6) **REPROVADO** (F1); `2c5aa43` (F1) **APROVADO** para encerrar o goal local de F1, N1/P3 documental não bloqueante — ver “Estado consolidado e errata N1” |

Teste simulado valida lógica e contrato; **não** comprova funcionamento de provedor real.

## Estado consolidado e errata N1 (atualização de 15/10/2026, após a revisão de 2c5aa43)

As seções mais abaixo foram escritas em cada entrega e registram o estado **daquele momento** (por exemplo, “revisão
pendente”). Ficam como histórico, com notas de atualização; esta seção é o estado atual.

| Commit (local, sem push) | Conteúdo | Revisão independente | Parecer |
|---|---|---|---|
| `bc379ad` | Entregas A e B, migrations 083/084 | **REPROVADO** (histórico): R1–R4 | `revisao-marketing-bc379ad-codex-20261015/PARECER.md` |
| `64fcd09` | Correções R1–R4 | **APROVADO** local, com observações não bloqueantes O1–O6 | `revisao-marketing-64fcd09-parecer-20261015/PARECER.md` |
| `f917f98` | Observações O1/O2/O5/O6 | **REPROVADO** (histórico): F1 | `revisao-marketing-f917f98-parecer-20261015/PARECER.md` |
| `2c5aa43` | Correção F1 | **APROVADO** para encerrar o goal local de F1; N1/P3 documental não bloqueante | `revisao-marketing-2c5aa43-parecer-20261015/PARECER.md` |

Esta errata é um commit **documental** local posterior a `2c5aa43`. Ele não recebeu revisão independente própria: a
aprovação acima refere-se ao commit `2c5aa43`.

**Errata N1 — prazo de espera pela trava.** A seção da correção F1 afirmava que “uma trava não obtida em 30 s falha a
transação”. Isso não é garantido pelo código entregue:

- `SET statement_timeout = '30s'` é configurado **só pelo harness PostgreSQL descartável**
  (`lib/comercial/postgres-descartavel.ts`, em `conectarDescartavel`); vale para as suítes de teste.
- A transação pública do formulário (`app/api/publico/marketing/[slug]/contato/route.ts` → `withTransaction` em
  `lib/db/postgres.ts`) abre `BEGIN`, executa e faz `COMMIT`/`ROLLBACK`; não define `statement_timeout` nem
  `lock_timeout` no código examinado.
- Fora do harness, o prazo de uma consulta bloqueada depende da configuração da conexão, da role ou do servidor, que
  **não foi verificada**.
- `connectionTimeoutMillis` e `idleTimeoutMillis` do pool limitam a obtenção de conexão e a ociosidade; **não** são
  prazo máximo de uma consulta já em execução esperando trava.
- Portanto, não há promessa de que uma espera da aplicação falhe automaticamente em 30 segundos. Uma garantia
  operacional de prazo seria requisito separado (definir e testar no caminho público, com autorização própria); nada
  foi alterado em runtime por esta errata. A espera longa não restaura autorização revogada (F1 continua corrigido).

O LEIA-ME do pacote `revisao-marketing-2c5aa43-20261015` repete a afirmação antiga e **não foi alterado** (pacote
entregue); esta errata e o resumo `revisao-marketing-doc-n1-*` a substituem.

**Quem validou o quê em `2c5aa43`.**

- **Revisor (executou):**
  - 52/52 testes sem banco do Marketing;
  - TypeScript e ESLint;
  - conferência do manifesto e reprodução do patch;
  - comparação da árvore declarada como testada com a árvore do commit.
- **Implementador (executou; o revisor só leu os logs, sem reexecutar):**
  - suíte PostgreSQL F1 antes e depois;
  - `check:v1:postgres` completo (98 arquivos);
  - `check:v1:static` com build.
- **Contagens F1:**
  - “9/9” = 1 teste pai + 8 subtestes;
  - “7 de 9” no antes = o teste pai + 6 subtestes com falha (2 subtestes passaram).
  - Não são nove cenários independentes.
- **Comparação de árvores:**
  - confirma que código, testes e schema do commit são iguais aos da árvore declarada, com diferença apenas documental;
  - **não** equivale a atestação independente de que a execução anterior usou aquela árvore.

**Pendências fora do goal local (não resolvidas aqui, não são bloqueios novos):**

- O3: a API devolve números completos.
- O4: descadastro concorrente a uma execução já em ENVIANDO. O motor revalida sem trava no envio, que é da mesma classe.
- Decisões comerciais: planos com `MARKETING`, preço, cache de imagens de 300 s, opt-in com código/OTP e texto LGPD.
- Reconciliação da 084 (editada no lugar) e dos números 083/084 com o histórico real de migrations, antes de
  qualquer integração.

Nada foi publicado: sem push, PR, staging, produção, DNS, provedores ou mensagens reais.

## O que foi entregue

### Entrega A — Marketing
- **Menu principal → Marketing**: Visão geral, Campanhas, Origens dos contatos, Site e SEO, Automações, Permissões
  (`lib/admin/navegacao.ts`, `components/admin/AdminShell.tsx`). Aparece com o recurso `MARKETING` no plano e alguma
  capacidade de Marketing na empresa (Gestão tem todas).
- **Origem dos contatos** (`lib/marketing/origens.ts`, `atribuicao.ts`):
  - separa origem de aquisição, canal de atendimento, campanha e método (CAPTURADO, INFORMADO, HERDADO, DESCONHECIDO);
  - opções padrão (Google, Instagram, Facebook, Indicação, Já era cliente, Passou em frente, Outro, Não informado) +
    personalizadas por empresa; `DESCONHECIDA` não é opção: é ausência de evidência;
  - append-only: correção desativa a vigente e grava outra com `substitui_id` e motivo;
  - primeira origem do cliente = primeira atribuição dele; cada negociação tem a sua; contrato herda da negociação
    pelo vínculo existente (`contratos.fechamento_id`), sem coluna nova;
  - **origem manual é básico do CRM** (qualquer membership, sem plano): painel “Origem” no perfil do cliente e em cada
    negociação em contratação (`components/admin/marketing/OrigemPainel.tsx`).
- **Contatos captados** (`lib/marketing/contatos.ts`): o pedido de orçamento NÃO é negociação (fechamento exige data,
  pacote e preço); a equipe vincula o contato ao cliente e à negociação, e a negociação herda a origem do contato.
  Deduplicação do CRM reaproveitada (mesmo telefone — com ou sem DDI 55 — ou e-mail; ambíguo vira possível duplicidade),
  sem revelar nada a quem enviou.
- **Campanhas** (`lib/marketing/campanhas.ts`): criar, editar, pausar, reativar, arquivar; período, unidade, canal,
  objetivo, orçamento opcional, `utm_source`/`utm_medium` e identificador estável (`kc`) imutável. Link rastreável
  `/s/<site>/c/<código>` registra o clique e leva ao site com UTM.
- **Painel** (`lib/marketing/metricas.ts`): cliques (link e WhatsApp separados), contatos, negociações, contratos,
  cancelamentos, receita contratada, receita recebida e conversão, por campanha/origem, com filtros de período e unidade;
  sem base = “indisponível”. Sugestão de datas vagas lida da agenda (somente leitura).
- **Site público por unidade** (`lib/marketing/site/*`, `app/s/[slug]`, `components/marketing/site/*`): modelo
  responsivo único (identidade, galeria, apresentação, estrutura, pacotes com preço opcional, localização, contato,
  formulário), rascunho pré-preenchido pelo cadastro aplicado, prévia administrativa (noindex, formulário inerte),
  publicação em versões imutáveis, despublicação. Texto do usuário sempre como texto (sem HTML); cores só `#rrggbb`;
  links só http(s); imagens reprocessadas para WebP (sem EXIF/GPS), privadas até serem citadas na versão publicada.
- **SEO**: título, descrição, canonical único, Open Graph, `robots`, JSON-LD `LocalBusiness` escapado,
  `/s/<site>/sitemap.xml` só com a página publicada e indexável; `robots.txt` por domínio.
- **Domínio personalizado (provedor SIMULADO)** (`lib/marketing/dominios/*`, `proxy.ts`, `app/sd/[host]`): solicitar,
  instruções DNS (TXT de verificação + A para raiz / CNAME para subdomínio), simular DNS, verificar, ativar, tornar
  principal, remover; www como apelido que redireciona. Host exclusivo entre empresas; hosts da plataforma reservados;
  domínio simulado nunca é indexável nem canonical e só é servido com `MARKETING_DOMINIO_SIMULADO_SERVIR=true`.
  `/sd/<host>` é destino interno: o proxy recusa pedido direto a `/sd/...` em qualquer Host e as rotas conferem que o
  Host recebido é o mesmo do caminho (sem cabeçalho interno injetado: ele se perde quando o Next trata a reescrita como
  proxy externo — ver “Execução de 15/10/2026”). **Fronteira de confiança (corrigido em 15/10):** vale o `Host`;
  `X-Forwarded-Host` **não é ignorado** — é lido como *fallback* quando o `Host` não normaliza (caso do ambiente local,
  em que a reescrita vira nova requisição com Host de servidor) e, ainda assim, precisa ser igual ao host do caminho
  (`viaDominioConfirmada` em `site/rotas-publicas.ts`; coberto em `rotas.test.ts`). A defesa principal continua sendo o
  proxy recusar `/sd/...` direto. Atrás de proxy reverso real, quem garante o `Host` é a borda: rever na homologação.

### Entrega B — Automações (`lib/marketing/automacoes/*`)
- Regras pré-definidas (sem construtor genérico): **Retomar proposta parada**, **Pós-festa**, **Oportunidade de
  recompra** (tarefa interna ou mensagem) e **Datas vagas** (só sugestão revisável).
- Cada regra: gatilho e condições fixos no código; espera, janela de horário, fuso, fim de semana, limite de frequência
  por cliente, tentativas máximas, ação, status, histórico; texto com marcadores `{{nome}}`, `{{buffet}}`,
  `{{data_festa}}`, obrigatório informar “PARAR”, revisão humana obrigatória antes de ativar mensagens, nome do modelo
  aprovado no provedor exigido.
- Execução: planejamento idempotente (chave regra/ação/alvo/ciclo), agendamento persistente, posse com prazo +
  `FOR UPDATE SKIP LOCKED`, trava por cliente para a frequência, revalidação imediatamente antes de agir (regra ativa,
  alvo ainda elegível no mesmo ciclo, janela, autorização, descadastro, “não contatar” do atendimento, frequência),
  estados AGENDADA → PROCESSANDO → ENVIANDO → ACEITA → ENTREGUE | FALHOU | INCERTA, além de TAREFA_CRIADA, SUPRIMIDA e
  CANCELADA; INCERTA nunca é reenviada sozinha; FALHOU pode ser re-agendada por pessoa; retorno de status com HMAC.
- Preferências de contato (**refeitas na correção R1**): autorização **por destino normalizado** em
  `marketing_contato_autorizacoes` (PENDENTE → CONFIRMADA | REVOGADA, evidência, quem/quando), caixa desmarcada por
  padrão no formulário do site; o formulário só confirma o número quando ele já está no cadastro do cliente, senão fica
  PENDENTE para a equipe; o CRM nunca é sobrescrito; a equipe só autoriza número do cadastro. Descadastro do cliente
  inteiro prevalece, revoga as vivas e cancela o agendado; reativação não restaura autorizações; histórico append-only.
- Aptidão da empresa (**correção R2**, `automacoes/aptidao.ts`): empresa ATIVA, recurso `MARKETING` no plano e acesso
  comercial COMPLETO, conferidos no planejamento e imediatamente antes de agir (inclusive reservada, recuperada ou em
  nova tentativa). Inapta = CANCELADA com motivo `EMPRESA_INAPTA: …`; falha de leitura = volta à fila sem agir.
- Interrupção: pausar regra (cancela pendentes), “Parar tudo” da empresa e interruptor global
  `MARKETING_AUTOMACOES_ENABLED`.
- Transporte: **apenas SIMULADO** (caixa de saída `marketing_transporte_simulado`, destinatário mascarado). Qualquer
  outro valor de `MARKETING_TRANSPORTE` recusa (`TRANSPORTE_NAO_CONFIGURADO`). Ganchos de simulação por número sintético:
  final 0000 = recusado, 1111 = indisponível, 9999 = sem confirmação.
- Processador local: `scripts/marketing-automacoes-worker.mjs` (só aceita localhost/127.0.0.1) →
  `POST /api/integracoes/marketing/automacoes/processar` (segredo próprio). Botão “Processar agora (local)” na tela.

## Decisões

| Decisão | Motivo |
|---|---|
| Contato captado ≠ negociação | `fechamentos` exige data, pacote, preço e agenda; inventar valores criaria negociação falsa. |
| Atribuição de toque único pela origem vigente da negociação | Evita somar receita a várias campanhas; regra simples e explicada na tela. |
| Atribuição é associação, não causa | O painel não mostra ROI; orçamento aparece só como informado. |
| Campanha só pelo `kc` válido da mesma empresa; UTM solta só informativa | Navegador nunca escolhe tenant nem campanha de outra empresa. |
| Campanha pausada continua atribuindo; arquivada não | O link já divulgado é evidência factual; arquivar é o desligamento explícito. |
| Recurso `MARKETING` nos mesmos planos do orçamento online (profissional, premium) | **Provisório e alterado no código**: `RECURSOS_POR_PLANO.MARKETING` foi acrescentado a `lib/assinatura/recursos-plano.ts` (profissional, premium). Escolha comercial pendente de Felipe; preços R$ 99/149/249 seguem hipóteses não aprovadas. Cobrança, preços e catálogo de planos não foram alterados. |
| RBAC: capacidades por membership (083), Gestão com todas | Mesmo desenho das capacidades de Festa (056); sem novo sistema de autorização. |
| Unidade aceita = da empresa e não DESATIVADO | As unidades nascem SUSPENSO (D03); mesma regra das mensagens prontas (082). Agenda por unidade cai para a da empresa quando a unidade não tem agenda. |
| Proxy de domínio desligado por padrão | Deploy sem configuração nunca desvia o painel. |
| Remoção de imagem vale na hora **no servidor**, inclusive no site publicado | Privacidade antes de estética. **Qualificado em 15/10:** a imagem pública sai com `Cache-Control: public, max-age=300`; cópias já guardadas por navegador/CDN podem ser reaproveitadas por até 5 min. Sem purga neste escopo. Decisão pendente: manter 300 s ou exigir revalidação (`no-cache`/`no-store`). |
| Endereço do site imutável após a 1ª publicação | Links divulgados não quebram. |
| Transporte e provedor de domínio só simulados | Escopo local; integração real é fase futura com autorização. |

## Permissões

| Ação | Quem |
|---|---|
| Origem manual de cliente/negociação | Qualquer membership ativa (básico do CRM, sem plano) |
| Opções de origem (lista) | Gestão |
| Ver painel, campanhas, contatos, site | `MARKETING_VISUALIZAR` (ou qualquer outra capacidade de Marketing) |
| Campanhas e contatos (escrita) | `MARKETING_CAMPANHAS_EDITAR` |
| Rascunho e imagens do site | `MARKETING_SITE_EDITAR` |
| Publicar/despublicar | `MARKETING_SITE_PUBLICAR` |
| Domínio | `MARKETING_DOMINIO_CONFIGURAR` |
| Automações e preferências | `MARKETING_AUTOMACOES_GERIR` |
| Conceder/revogar capacidades | Gestão (`/admin/marketing/permissoes`) |

Toda API administrativa de Marketing passa por `exigirApiAdminCrmDisponivel` (sessão, CSRF, paywall), transação de
tenant com a empresa da sessão, plano `MARKETING` (exceto origem manual) e capacidade (`lib/marketing/http.ts`).

## Variáveis de ambiente (só nomes)

`MARKETING_SITES_PUBLICOS`, `MARKETING_DOMINIOS_PERSONALIZADOS`, `MARKETING_DOMINIO_SIMULADO_SERVIR`,
`MARKETING_HOSTS_PLATAFORMA`, `MARKETING_DOMINIO_PROVEDOR` (só `simulado`), `MARKETING_DOMINIO_ALVO_CNAME`,
`MARKETING_DOMINIO_ALVO_IP`, `MARKETING_AUTOMACOES_ENABLED`, `MARKETING_TRANSPORTE` (só `simulado`),
`MARKETING_AUTOMACOES_WORKER_SECRET`, `MARKETING_AUTOMACOES_WORKER_URL` (worker), `MARKETING_SIMULADO_CALLBACK_SECRET`;
reaproveitadas: `SITE_URL`, `ADMIN_AUTH_ORIGIN`, `CONVITES_PUBLIC_ORIGIN`. Padrão de todas as chaves de liga: desligado.

## Migrations

| Arquivo | Conteúdo |
|---|---|
| `database/migrations/20261014_083_marketing_base.sql` | capacidades, opções de origem, sites/versões/imagens, domínios + DNS simulado, campanhas, contatos, atribuições, eventos de clique; gatilhos de tenant e append-only |
| `database/migrations/20261014_084_marketing_automacoes.sql` | regras, execuções, eventos, preferências (descadastro + histórico), autorizações por destino (`marketing_contato_autorizacoes`, R1), tarefas, caixa de saída simulada. **Editada no lugar na correção R1** (a 084 nunca foi aplicada fora de cluster descartável já apagado); o número 084 não mudou. |
| `database/checks/20261014_08{3,4}_{precheck,postcheck}.sql` | somente leitura |
| `database/rollback/20261014_08{3,4}_*_down.sql` | só para banco descartável; recusam com dados |

Inventário: `scripts/production/check-migrations.mjs` e `production.test.mjs` (083/084 exigem autorização explícita);
modelo `084` em `scripts/regressao-v1-postgres-receita.cjs`; suítes declaradas em `scripts/regressao-v1-selecao.cjs`.
**Nenhuma migration foi aplicada fora do cluster descartável.**

## Rollback

1. Operacional (recomendado): desligar `MARKETING_SITES_PUBLICOS`, `MARKETING_DOMINIOS_PERSONALIZADOS` e
   `MARKETING_AUTOMACOES_ENABLED` e voltar o código. O schema é aditivo e pode ficar (nada do código anterior o lê).
2. Schema: `084` down antes do `083` down; ambos **recusam** enquanto houver contato, atribuição, versão publicada,
   evento, execução, tarefa, preferência ou envio simulado. Rollback nunca apaga contatos nem evidências de envio.

## Observabilidade

Histórico por execução (`marketing_automacao_eventos`), por preferência (`marketing_contato_preferencias_eventos`), por
atribuição (cadeia `substitui_id`) e no CRM (`eventos_historico_cliente`: CONTATO_MARKETING_*). Logs com código fixo,
sem telefone, mensagem ou segredo. Cliques sem IP nem dado pessoal.

## Validações (comandos e resultados)

Ver a seção “Execução de 15/10/2026” no fim deste arquivo (resultados reais, com contagens).

## Limites conhecidos

- Limitador do formulário público é em memória por instância (como os demais públicos); sem captcha (honeypot +
  limite + idempotência).
- Sem a origem por WhatsApp automática: só haverá quando a integração receber identificador confiável; clique no botão
  é evento separado e não vira contato.
- Painel: receita recebida usa recebimentos confirmados − estornos confirmados − devoluções concluídas no período.
  Receita contratada (correção R3): contrato sem valor legível (pagamento, snapshot) não vira zero — linha e total
  mostram “indisponível” quando nenhum valor é conhecido, ou “subtotal; N sem valor” (PARCIAL).
- Consentimento (R1): opt-in simples (caixa no formulário ou registro da equipe com evidência); sem confirmação por
  código/OTP no número. Número pedido que não está no cadastro fica PENDENTE até a equipe atualizar o cadastro e
  confirmar. Texto da caixa e política LGPD continuam no checklist futuro.
- Número que sai do cadastro (O1): as autorizações vivas desse número são revogadas pelo banco na mesma transação
  (`NUMERO_SAIU_DO_CADASTRO`); se o número voltar, precisa de nova autorização. Evidência de confirmação (quando, quem,
  como) é gravada uma vez e congelada, inclusive na revogação (O2).
- Acesso comercial SOMENTE_LEITURA ou BLOQUEADO (teste encerrado, atraso) cancela as automações pendentes da empresa
  (R2); quando a assinatura é regularizada elas não são recriadas para o mesmo ciclo (a chave já existe): só um novo
  ciclo do alvo gera nova execução. Comportamento escolhido para não disparar um acúmulo de mensagens atrasadas.
- Pacotes com preço “a partir de” dependem de tabela publicada de hoje; sem ela, o pacote é publicado sem preço (aviso).
- Domínio: sem reverificação periódica automática (proteção contra DNS pendurado é a reverificação manual que desativa).
- Contratações listadas no CRM mostram a origem só no perfil do cliente (lista “em contratação”).
- Automações fazem cada regra por unidade; regra de empresa e de unidade são independentes.

## Checklist futuro — homologação externa e deploy (NÃO executado)

1. Revisão independente do diff (critérios abaixo) e decisão sobre números 083/084 frente a outras branches.
2. Autorização de Felipe para aplicar 083/084 em staging (backup, precheck, migration, postcheck), deploy manual e smoke.
3. Decidir planos que incluem `MARKETING` e preço (hipóteses R$ 99/149/249 não aprovadas).
4. Domínio real: adaptador do provedor (ex.: domínios personalizados do Render — 2/15/25 domínios inclusos por plano
   Hobby/Pro/Scale, US$ 0,25/mês por excedente, TLS automático, CAA para `letsencrypt.org`/`pki.goog`, remover AAAA,
   raiz↔www automático, conforme https://render.com/docs/custom-domains consultado em 15/10/2026), testes de contrato
   com o provedor, reverificação periódica e alarme de DNS pendurado. Compra/renovação do domínio continuam com o cliente.
5. WhatsApp real: adaptador do provedor com modelos aprovados, janela de 24 h, callbacks reais assinados, números
   reais só com autorização própria; manter o simulado nos testes.
6. Política de privacidade/LGPD para formulário e consentimento; texto da caixa de autorização revisado.
7. Ligar `MARKETING_SITES_PUBLICOS` etc. só no ambiente autorizado; monitorar 404/429 do formulário.

## Critérios para revisão independente

Tenant em toda consulta/escrita; nenhuma entrada do navegador escolhe empresa/unidade/campanha de outra empresa;
rascunho e imagem privada nunca servidos; canonical/sitemap; domínio simulado nunca “ativo real”; atribuição
append-only e sem dupla contagem; idempotência e concorrência do motor; nenhuma rede nos transportes; mensagens sem
autorização ou descadastradas nunca saem; rollback não apaga contatos/evidências.

## Execução de 15/10/2026 (resultados reais)

Ambiente: cluster PostgreSQL 18 descartável `127.0.0.1:55545` (`cluster_name=kidmais_descartavel`, autorizado por Felipe
nesta execução, só dados sintéticos), migrations `001→084` aplicadas **somente nele**; `next dev` local apontado só para
ele. Scripts fora do repositório: `ambientes-locais/pg-marketing-20261014.cjs` (preparar/provar/executar/encerrar/limpar)
e `ambientes-locais/marketing-ui-20261014.cjs` (seed sintético: empresas A “Buffet Alegria (sintético)” e B “Buffet
Brincar (sintético)”, Gestão A, Equipe A sem concessão, Gestão B, cliente recorrente e negociação parada). Ao final o
cluster foi **encerrado e apagado** (`existeDepois:false`); credenciais e lançador locais apagados; relatórios mantidos em
`ambientes-locais/pg-descartavel-marketing-20261014-relatorios`, capturas em `ambientes-locais/marketing-ui-20261014-evidencias`.

### Comandos e resultados

| Verificação | Resultado |
|---|---|
| `check:v1:postgres` com `KIDMAIS_POSTGRES_SOMENTE` = 3 suítes de Marketing (runner oficial, cada uma no modelo declarado) | **PASS** 3/3 arquivos, rodado 3 vezes (a última depois da correção do domínio): `migration-083-084` [082], `marketing-a` [084] 9/9, `automacoes-b` [084] incl. concorrência com 2 conexões |
| `check:v1:static` (unitários de todo o repositório + guardas) | **PASS** — 3059/3059 unitários, smoke 103/103, lint (0 erros), TypeScript e build; rodado de novo após a correção do domínio |
| Unitários de Marketing + navegação + Contratações | 45/45 (2 suítes PostgreSQL puladas fora do runner, como esperado) |
| `tsc --noEmit` | 0 erros |
| ESLint | 0 erros; 1 aviso preexistente fora do escopo (`lib/inteligencia/skills/catalogo.ts`) |
| `next build` | OK |
| smoke | 103/103 |
| `scripts/production/production.test.mjs` | 37/37 |

Evidências do goal: 1 (atribuição até contrato sem dupla contagem), 2 (isolamento A×B com ids diretos), 3 (sem UTM =
desconhecida; recorrente mantém 1ª origem), 4 (cliques e formulário idempotente), 5 (rascunho não vaza; versões;
sitemap; despublicado = 404), 6 (domínio) e 7 (automações: idempotência, janela, consentimento/descadastro, frequência,
concorrência, INCERTA sem reenvio, callback HMAC) — todas nas suítes PostgreSQL acima.

### UI local (desktop e celular 375 px)

- Login como Gestão A → Marketing › Visão geral com cartões e “indisponível” quando sem base.
- Site e SEO: criar → preencher → salvar → prévia (script digitado aparece como texto; formulário inerte; aviso “não é a
  página publicada”) → publicar (aviso de pacote sem preço legível na tabela de hoje).
- Campanha “Instagram Novembro” → link `/s/<site>/c/<código>` → página com canonical sem UTM, `robots` coerente e JSON-LD
  `LocalBusiness` → formulário com autorização → “Pedido enviado!” → em Origens: “Instagram · Instagram Novembro
  (capturada pelo link)”.
- Automação “Retomar proposta parada” como tarefa interna: agendada para a próxima janela (00:00 SP), “Processar agora
  (local)” → tarefa criada para a cliente sintética. Transporte exibido como SIMULADO.
- Domínio `festas.alegria-sintetico.test`: pendente → DNS simulado → verificar → “Ativo (simulado)”. Com
  `Host: festas.alegria-sintetico.test:3491`: `/` 200 (noindex, canonical = endereço da plataforma), `robots.txt`
  “Disallow: /”, `sitemap.xml` 200 vazio, `/c/<código>` 302 com UTM, `/whatsapp` 302; `/admin`, `/api/admin/...` e
  `/sd/...` = 404. Host desconhecido: `/` 404 e `robots.txt` 200 “Disallow: /”. `/sd/...` direto na plataforma (inclusive
  com `X-Forwarded-Host` forjado) = 404. Remoção pela tela → `/`, `sitemap.xml` e `/c/<código>` 404 na hora (no
  servidor; respostas públicas com `max-age=300` já guardadas fora dele podem durar até 5 min).
- Celular (375 px): Visão geral, Origens (cartões) e site público sem rolagem horizontal; botão primário branco sobre a
  cor da marca.
- Permissões pela API com sessão real (credenciais sintéticas lidas de arquivo local, nunca impressas): Equipe A sem
  concessão → menu Marketing oculto (`recursos.marketing=false`) e 403 em resumo, campanhas, contatos, site, domínios,
  automações e permissões (a lista de opções de origem segue disponível: origem manual é básico do CRM); Gestão B → 200
  sem nenhum dado de A; Gestão A → 200. A tela da Equipe não foi aberta no navegador (coberta pela sessão + teste de
  navegação).

### Defeitos encontrados na validação e corrigidos

| Defeito | Correção |
|---|---|
| Telefone com e sem DDI 55 não deduplicava | `variantesTelefone` em `lib/marketing/contatos.ts` |
| Salvar rascunho de site de outra empresa devolvia 400 (não 404) | posse conferida antes (`site/servico.ts`) |
| Ação de execução de automação de outra empresa devolvia 200 vazio | 404 (`api/admin/marketing/automacoes`) |
| Carregador de testes não resolvia `index.ts` de pasta | `lib/acessos/teste-carregador.ts` |
| Botão primário do site com texto escuro (especificidade de `.pagina a`) | `site-publico.module.css` |
| Domínio ativo respondia 404: o cabeçalho interno da reescrita não chegava às rotas | conferência pelo Host recebido + bloqueio de `/sd/...` direto no proxy (`hosts.ts`, `rotas-publicas.ts`, `proxy.ts`); testes novos em `hosts.test.ts` e `rotas.test.ts` |

### Lições do ambiente local

- `ADMIN_AUTH_ORIGIN` precisa ser `http://localhost:<porta>`: em dev o Next normaliza `127.0.0.1` para `localhost` na URL
  da requisição e a origem administrativa segura não confere.
- Pelo mesmo motivo, `next dev --hostname 127.0.0.1` faz o Next tratar **toda** reescrita do `proxy.ts` como proxy
  externo (nova requisição HTTP com Host `localhost`, sem os cabeçalhos alterados). Usar `--hostname localhost`. Em
  produção (`next start` sem hostname) a reescrita é interna.
- Os arquivos de `lib/convites/acervo/` ficam com CRLF neste checkout (`core.autocrlf=true`) e quebram o checksum do
  check estático; converter para LF só para rodar e restaurar com `git checkout -- lib/convites/acervo/` (preexistente).
- A guarda F1 (`lib/autenticacao/plataforma.test.ts`) só permite `INSERT INTO usuarios_administrativos` em
  `lib/autenticacao/usuarios.ts`: o harness de Marketing não cria identidade; cada suíte cria a sua.

### Classificação final

A e B: **implementadas local** e **validadas local** (dados sintéticos, cluster descartável, transporte e provedor
simulados) na execução de 14–15/10. Depois disso: commit local `bc379ad` (sem push) e revisão independente Codex
**REPROVADA** (R1–R4) — ver a seção seguinte. **Não publicadas**: sem push, PR, staging ou produção.

## Correções R1–R4 (15/10/2026)

Goal: `Kidmais-Manager-Second-Brain/02 - Kidmais Manager SaaS/07 - Roadmap/Goal Correcao Marketing local R1 R4.md`.
Parecer: `revisao-marketing-bc379ad-codex-20261015/PARECER.md` (preservado). Novo commit local sobre `bc379ad` na
branch `codex/marketing-correcoes-r1-r4-20261015` (sem amend, sem push). **Nova revisão independente pendente** na data da entrega. Atualização de 15/10: `64fcd09`
**APROVADO** — ver “Estado consolidado e errata N1”.

| Achado | Correção | Testes |
|---|---|---|
| **R1 (alta)** consentimento não estava ligado ao número informado: e-mail reaproveitava cadastro com WhatsApp A, formulário trazia B e A ficava elegível | Autorização por **destino normalizado** (`marketing_contato_autorizacoes`, 084): formulário só confirma número que já está no cadastro; senão PENDENTE para a equipe; CRM nunca sobrescrito; equipe só autoriza número do cadastro; motor envia **só** a destino CONFIRMADO ainda presente no cadastro (`SEM_AUTORIZACAO_DESTINO`); descadastro prevalece e revoga; evento ENVIANDO guarda `autorizacaoId` | 7 unitários; PG: e-mail reaproveitado, telefone ≠ WhatsApp, 55, cliente novo, caixa desmarcada, descadastro anterior, troca de número, confirmação da equipe, isolamento A×B pela rota (404) e pelo banco; destino real gravado por transporte simulado espião |
| **R2** worker processava pendente de empresa inativa / sem `MARKETING` / com acesso restrito | `automacoes/aptidao.ts` (status ATIVA + recurso do plano + acesso COMPLETO) no planejamento e em `decidir` após a trava, também para reservada/recuperada/nova tentativa; inapta → CANCELADA `EMPRESA_INAPTA: <motivo>`; falha de leitura → volta à fila (+15 min) sem agir | 3 unitários; PG: suspensa após planejar (worker global, outra empresa segue), plano Essencial confirmado (guardas reais 068/074a), teste encerrado, pendência já reservada; sem tarefa nem caixa simulada |
| **R3** contrato sem valor virava R$ 0 e total “completo” | `situacaoReceita`: COMPLETA / PARCIAL / INDISPONIVEL; `receitaContratadaCentavos` = `null` quando nada é conhecido; `contratosSemValor` por linha e no total; tela mostra “indisponível (N sem valor)” ou “R$ X (subtotal; N sem valor)” | 1 unitário (5 casos); PG: só desconhecido, zero real, misto, nenhum |
| **R4** planejamento repetia os mesmos 500 alvos | Exclusão pela **chave completa** (regra:ação:alvo:ciclo) **antes** do `LIMIT`, desempate por id; revalidação sem a exclusão; simulação com limite próprio | 1 unitário; PG: 501 alvos empatados → 500 + 1 + 0, ordem determinística, primeiros continuam elegíveis, terminal não recriado, novo ciclo, outra regra, pós-festa e recompra por lote, concorrência com 2 conexões (501 exatos) |

Documentação corrigida: X-Forwarded-Host (fallback, não “ignorado”), cache de 300 s das imagens públicas, estado do
commit, planos provisórios (mapa de recursos alterado; preços/cobrança não). A 084 foi **editada no lugar** (nunca
aplicada fora de cluster descartável); números 083/084 não mudaram.

Defeito achado na validação de UI desta rodada (já existia em `bc379ad`): os seletores de cliente de Preferências e de
Origens liam só o formato direto da busca do CRM; com termo a API devolve `{ cliente, … }` e nenhum resultado
aparecia. Corrigido com `clientesDaBusca` (`lib/marketing/apresentacao.ts`) + teste. Também: valor do cartão de KPI
quebrava no meio do número (“R$ 5.200,0 / 0”); agora a fonte acompanha a largura do cartão e só quebra em espaço.

### Execução das correções (15/10/2026, resultados reais)

Ambiente: **novo** cluster PostgreSQL 18 descartável `127.0.0.1:55546` (`cluster_name=kidmais_descartavel`), autorizado
especificamente por Felipe nesta execução (a autorização do cluster 55545 não foi reaproveitada). Script
`ambientes-locais/pg-marketing-r1r4-20261015.cjs` (derivado do anterior; prova de identidade antes de cada ação).
Migrations `001→084` (084 corrigida) aplicadas **somente nele**. Ao final: **encerrado e apagado** (`existeDepois:false`,
porta livre); credenciais e lançador da UI apagados; relatórios em
`ambientes-locais/pg-descartavel-marketing-r1r4-20261015-relatorios`, capturas em
`ambientes-locais/marketing-ui-r1r4-20261015-evidencias`.

| Verificação | Resultado |
|---|---|
| Regressões R1–R4 sem banco (`correcoes-r1-r4.test.ts`) no código **antigo** (`bc379ad`) | **0/13** — todas falham (prova de que pegam os defeitos) |
| As mesmas no código corrigido | **13/13** |
| `correcoes-r1-r4.postgres.test.ts` [084] | **17/17** (R1 5 casos, R2 4, R3, R4 3 + concorrência). As **duas** primeiras execuções (logs 04-43 e 04-44) revelaram **3** fixtures de teste erradas: a 1ª, contratação que nasce EM_ABERTO e status AGUARDANDO_APROVACAO sem valor negociado; a 2ª, `provedor` obrigatório da assinatura paga — corrigidas no teste, sem mudar produto (contagem alinhada em O6, ver o fim) |
| `check:v1:postgres` completo (runner oficial, cada suíte no modelo declarado) | **PASS 96/96 arquivos**, incl. `migration-083-084` [082], `marketing-a` [084], `automacoes-b` [084] e `correcoes-r1-r4` [084] |
| `check:v1:static` (depois das correções de UI) | **PASS** — 3072/3072 unitários, smoke 103/103, lint 0 erros (1 aviso preexistente em `lib/inteligencia/skills/catalogo.ts`), TypeScript e build |
| `scripts/production/production.test.mjs` | 37/37 |
| `tsc --noEmit`, ESLint nos arquivos alterados, `git diff --check` | limpos |
| UI local (`next dev --hostname localhost --port 3492`, Gestão A sintética, desktop 1366 px e celular 375 px) | R3: cartão “R$ 5.200,00 — subtotal conhecido; 1 contrato(s) sem valor”, linha Instagram “R$ 5.200,00 (subtotal; 1 sem valor)”, conversão “indisponível”. R1: cliente com e-mail reaproveitado mostra “•••• 1003 · pendente de confirmação (formulário do site) · número fora do cadastro atual” e oferece só “Autorizar •••• 1002” (número do cadastro); nenhum número completo na tela; sem rolagem horizontal |

Seed da UI: os dois contratos de R3 foram inseridos com `session_replication_role = replica` (gatilhos de fluxo de
contrato 013/014/019 desligados só nessa transação, no banco sintético) — serve à tela, não prova o fluxo de contrato.
Observação de ambiente: havia outro processo local (servidor de prévia do Codex) escutando em `127.0.0.1:3492`; o
`next dev` desta rodada escutou em `[::1]:3492` e as capturas mostram o app semeado. Esse processo não foi tocado.

**Não validado / pendente (na data da entrega; a revisão de `64fcd09` ocorreu depois e APROVOU):** revisão
independente do delta (nova rodada da Astra/Codex); decisões comerciais (planos com
`MARKETING`, preço); cache das imagens (300 s ou revalidação); opt-in com confirmação por código no número (fora deste
escopo). Integrações reais, staging e produção continuam fora do escopo.

## Observações O1/O2/O6 da revisão de 64fcd09 (15/10/2026)

Parecer: `revisao-marketing-64fcd09-parecer-20261015/PARECER.md` (APROVADO para encerrar o goal local; O1–O6 não
bloqueantes). Novo commit local sobre `64fcd09` na branch `codex/marketing-correcoes-r1-r4-20261015` (sem amend, sem
push, sem PR). A 084 foi novamente **editada no lugar** (nunca aplicada fora de cluster descartável já apagado).
**Revisão independente deste commit pendente** na data da entrega. Atualização: `f917f98` foi **REPROVADO** por F1
(`revisao-marketing-f917f98-parecer-20261015/PARECER.md`).

| Observação | Decisão / correção | Testes |
|---|---|---|
| **O1** autorização CONFIRMADA voltava a valer se o número saísse do cadastro e depois voltasse | **Decisão de Felipe (15/10/2026): revogar ao sair.** Gatilho `marketing_aut_numero_saiu` (AFTER UPDATE OF whatsapp, telefone ON `clientes`) → `kidmais084_numero_saiu_do_cadastro()`: autorização viva (pendente ou confirmada) de número que estava no cadastro e saiu vira REVOGADA (`NUMERO_SAIU_DO_CADASTRO: …`, `revogada_por` nulo, evidência de confirmação preservada) na mesma transação — cobre tela, importação, mescla e SQL direto. Troca de campo (WhatsApp ↔ telefone) ou só de formatação não revoga; pendente de número que nunca esteve no cadastro não é afetada; outro cliente/empresa com o mesmo número não é afetado. Se o número voltar, precisa de nova autorização (equipe ou formulário). Normalização SQL `kidmais084_destino(text)` igual a `normalizarDestino`. Down remove gatilho e funções | PG `correcoes-o1-o2` (5 casos, inclusive o cenário do parecer pelo repositório real do CRM e por SQL direto, e paridade da normalização em 13 entradas); `correcoes-r1-r4` “troca de número” agora espera a revogação (`SEM_AUTORIZACAO`) |
| **O2** gatilho deixava mudar `confirmada_em/confirmada_por/confirmacao`; `marketing_aut_confirmada` aceitava REVOGADA sem evidência | `kidmais084_autorizacao_controle`: evidências só são gravadas na passagem PENDENTE → CONFIRMADA; em qualquer outra transição (inclusive revogação) ficam congeladas. `marketing_aut_confirmada`: evidência tudo-ou-nada (data ⇔ registro; quem só com data), PENDENTE sem nenhuma, CONFIRMADA com data e registro; REVOGADA mantém o que tinha (vinda de CONFIRMADA continua com data e registro; vinda de PENDENTE sem nenhum). `marketing_aut_revogada` também exige `revogada_por` nulo fora de REVOGADA | PG `correcoes-o1-o2` (3 casos: restrição por estado, CONFIRMADA → REVOGADA sem apagar/trocar quando/quem/como, PENDENTE → REVOGADA sem confirmação fabricada e descadastro preservando evidência); `migration-083-084` com as novas recusas |
| **O5** postcheck conferia 4 de 10 restrições da autorização | Postcheck da 084 confere as 10 restrições + `marketing_aut_contato_fk`, o gatilho novo, a definição vigente de `marketing_aut_confirmada`/`_revogada` e do gatilho de controle, e a normalização (5 entradas); precheck e verificação de reaplicação também conhecem as funções/gatilho novos | executado nos modelos 084 e na suíte da migration |
| **O6** contagem de fixtures divergente (doc: “1ª execução revelou 3”; LEIA-ME do pacote `revisao-marketing-64fcd09-20261015`: 2) | Texto corrigido acima: **duas** execuções falharam (04-43 e 04-44) e revelaram **três** fixtures (EM_ABERTO e valor negociado na 1ª; `provedor` na 2ª). O LEIA-ME do pacote já entregue lista só duas (omite o valor negociado) e **não foi alterado**; esta é a contagem correta | conferido nos logs 04-43/04-44 do pacote |

Fora deste recorte (decisões de privacidade e transporte real, mantidas como pendentes): **O3** a API
`GET /api/admin/marketing/automacoes?clienteId=` devolve os números completos (a tela mascara); **O4** descadastro
concorrente com execução já em ENVIANDO (revalidar dentro da posse ou `FOR SHARE` em `clientes` antes de transporte
real).

### Execução O1/O2 (15/10/2026, resultados reais)

Ambiente: **novo** cluster PostgreSQL 18 descartável `127.0.0.1:55547` (`cluster_name=kidmais_descartavel`,
`tem_real:false`), autorizado especificamente por Felipe nesta execução (55545/55546 não reaproveitados). Script
`ambientes-locais/pg-marketing-o1o2-20261015.cjs` (derivado do anterior; prova de identidade antes de cada ação).
“Antes” = export de `64fcd09` (`git archive`) com só as suítes novas copiadas por cima, em
`ambientes-locais/marketing-o1o2-antes-64fcd09` (`node_modules` por junção, só leitura). Relatórios em
`ambientes-locais/pg-descartavel-marketing-o1o2-20261015-relatorios`.

| Verificação | Resultado |
|---|---|
| **Antes** (`64fcd09` + suítes novas): `correcoes-o1-o2` [084] e `migration-083-084` [082] | **FALHA 2/2 arquivos** — O1: a autorização não é revogada quando o número sai e volta a valer; normalização SQL inexistente; O2: restrição aceita evidência incoerente e o gatilho aceita apagar/trocar a evidência na revogação (prova de que os testes pegam as observações) |
| **Depois**, as 5 suítes do Marketing (`correcoes-o1-o2`, `correcoes-r1-r4`, `marketing-a`, `automacoes-b` [084]; `migration-083-084` [082]) | **PASS 5/5 arquivos** — O1/O2 10/10 (2 testes, 8 casos), R1–R4 17/17, migration 1/1, Entrega A 9/9, Entrega B 9/9 |
| `check:v1:postgres` completo (runner oficial, cada suíte no modelo declarado) | **PASS 97/97 arquivos** (96 anteriores + `correcoes-o1-o2`) |
| `check:v1:static` | **PASS** — 3072/3072 unitários, smoke 103/103, lint 0 erros (1 aviso preexistente), TypeScript e build. 1ª tentativa: 3071/3072 por ambiente — `core.autocrlf=true` converteu os 3 SVG de `lib/convites/acervo` para CRLF na worktree e o checksum de `acervo.test.ts` diverge; os blobs commitados batem. Os 3 arquivos foram reescritos com os bytes do HEAD só para a execução e depois devolvidos com `git checkout` (nenhuma mudança deles no commit) |
| Unitários do Marketing sem banco (8 arquivos), `regressao-v1-estatica.test.cjs`, `production.test.mjs` | 51/51, 7/7, 37/37 |
| `tsc --noEmit --incremental false`, ESLint nos arquivos alterados, `git diff --check` | limpos |

Ao final: cluster **encerrado e apagado** (`existeDepois:false`), export “antes” removido (junção desfeita antes, sem tocar
no `node_modules` real). Autorização e mapa dos logs em `AUTORIZACAO.txt` nos relatórios. Nada publicado: sem push,
PR, staging, produção ou mensagem real. UI não reexecutada (nenhuma mudança de tela; o motivo
`NUMERO_SAIU_DO_CADASTRO: …` aparece na lista de autorizações como os demais motivos de revogação).

## Correção F1 da revisão de f917f98 (15/10/2026)

Parecer: `revisao-marketing-f917f98-parecer-20261015/PARECER.md` (f917f98 **REPROVADO**, preservado). Goal: nota
`Goal Correcao Marketing local F1` no vault. Worktree própria `kidmais-manager-marketing-f1-20261015`, branch
`codex/marketing-correcao-f1-20261015`, novo commit local sobre `f917f98` (sem amend, sem push). **Revisão
independente pendente** na data da entrega.
Atualização: `2c5aa43` **APROVADO** para encerrar o goal local de F1
(`revisao-marketing-2c5aa43-parecer-20261015/PARECER.md`); N1/P3 documental tratada em “Estado consolidado e errata N1”.

**Defeito (F1).** O formulário do site lia o cadastro sem trava, decidia CONFIRMADA e só depois inseria a autorização.
Se outra transação trocasse o número (A→B) entre a leitura e o INSERT — ou entre o INSERT e o COMMIT —, o gatilho
`marketing_aut_numero_saiu` não enxergava a autorização (ainda inexistente ou não confirmada) e não a revogava; quando
o cadastro voltava a A, a autorização anterior à saída voltava a permitir envio. A FK de autorizações/contatos para
`clientes` só toma `FOR KEY SHARE`, que não conflita com UPDATE de telefone/WhatsApp: nada serializava os dois caminhos.

**Protocolo (sem mudança de schema).** O ponto de coordenação é a linha do cliente:

| Caminho | Trava | Quando |
|---|---|---|
| Formulário (`registrarAutorizacaoDoFormulario` → `travarCadastroDoCliente`) | `SELECT … FROM clientes … FOR NO KEY UPDATE` | antes de ler descadastro e números; mantida até o COMMIT (cobre leitura→INSERT e INSERT→COMMIT) |
| Equipe (`alterarPreferencia`) | `FOR UPDATE` (já existia) | antes de ler descadastro e números |
| Edição de telefone/WhatsApp (tela, importação, mescla, SQL) | trava de linha do próprio UPDATE | o gatilho O1 roda depois, em instrução nova (READ COMMITTED), e enxerga o que foi confirmado antes de a linha ser liberada |

Ordem única: `clientes` (linha) → `marketing_contato_preferencias` → `marketing_contato_autorizacoes`. Se o formulário
pega a linha primeiro, a edição espera, e o gatilho revoga a autorização recém-confirmada. Se a edição pega primeiro,
o formulário espera e lê o cadastro já alterado (número fora do cadastro → PENDENTE, como no fluxo sequencial). Dois
formulários, ou formulário × equipe, no mesmo cliente ficam serializados (sem duas vivas, sem deadlock). O mesmo
protocolo fecha a variante com descadastro concorrente: a autorização do formulário não sobrevive ao descadastro nem volta
na reativação. Não há retry nem espera por tempo no protocolo. *Errata N1 (15/10/2026):* esta frase dizia que “uma trava não obtida
em 30 s falha a transação”. Isso vale **só no harness PostgreSQL descartável** (`SET statement_timeout = '30s'` em
`lib/comercial/postgres-descartavel.ts`). A transação pública do formulário não define timeout; fora do harness, o
prazo depende da configuração da conexão, da role ou do servidor, que não foi verificada. Ver “Estado consolidado e
errata N1”.

Fora do recorte (inalterados): O3 e O4. O motor revalida a elegibilidade sem trava no momento do envio (janela de
milissegundos entre a decisão e o transporte, a mesma classe de O4).

### Execução F1 (15/10/2026, resultados reais)

Ambiente: **novo** cluster PostgreSQL 18 descartável `127.0.0.1:55548` (`kidmais_descartavel`, `tem_real:false`),
autorizado especificamente por Felipe nesta execução (55545–55547 não reaproveitados); script
`ambientes-locais/pg-marketing-f1-20261015.cjs`. “Antes” = export de `f917f98` (`git archive`) com só os testes novos
por cima. Relatórios em `ambientes-locais/pg-descartavel-marketing-f1-20261015-relatorios`. Árvore de código testada
(índice temporário com as mudanças, antes desta seção do doc): `2c0d6df1f1e2f75cffd25f7bd83cef675d19514e`.

| Verificação | Resultado | Log |
|---|---|---|
| `correcao-f1.test.ts` (forma do protocolo, sem banco) em `f917f98` / depois | **0/1** / **1/1** | `unitario-f1-ANTES-f917f98.log`, `unitario-f1-DEPOIS.log` |
| `correcao-f1.postgres.test.ts` [084], **antes** (`f917f98`) | **FALHA**: 7 de 9 (o teste pai + 6 subtestes; 2 subtestes passaram) — leitura→INSERT, INSERT→COMMIT, ordem inversa e descadastro terminam com a autorização obsoleta CONFIRMADA (asserções funcionais); controle positivo falha porque a autorização antiga já valia antes da nova; o servidor registra **nenhuma** espera (`CONCLUIDA`). Nenhum `TEMPO_DO_TESTE` | `2026-10-15T11-23-32-418Z-check-v1-postgres.log` |
| A mesma, **depois** | **PASS 9/9** (o teste pai + 8 subtestes); cada espera observada no servidor (`wait_event_type = Lock`) e `pg_blocking_pids` = a sessão que segura a linha | `2026-10-15T11-23-17-568Z-check-v1-postgres.log` |
| `check:v1:postgres` completo (inclui as 6 suítes do Marketing) | **PASS 98/98 arquivos** | `2026-10-15T11-23-51-348Z-check-v1-postgres.log` |
| `check:v1:static` | **PASS** — 3073/3073 unitários, smoke 103/103, lint 0 erros (1 aviso preexistente), TypeScript, build (SVG de `lib/convites/acervo` convertidos para LF só durante a execução e restaurados) | `check-v1-static.log` |
| `production.test.mjs`; `tsc --noEmit --incremental false`; ESLint dos alterados | 37/37; limpos | — |

No “antes”, o caso “formulário × formulário” falha na asserção de protocolo (sem espera), não por duplicidade: a chave
única já impedia duas autorizações vivas. Ao final: cluster **encerrado e apagado** (`existeDepois:false`), export
“antes” removido (junção desfeita antes, sem tocar no `node_modules` real). Sem UI (nenhuma mudança de tela).
