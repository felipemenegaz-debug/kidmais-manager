# Marketing do KidMais Manager — implementação e validação LOCAIS (14–15/10/2026)

Goal: `Kidmais-Manager-Second-Brain/02 - Kidmais Manager SaaS/07 - Roadmap/Goal Marketing local para Opus.md`.
Escopo: **somente local**. Nada foi publicado, enviado, provisionado, cobrado ou aplicado fora do cluster PostgreSQL
descartável autorizado. Sem push, PR, merge, deploy, DNS real ou mensagem real.

- Worktree: `D:/glass/KidMais Manager/kidmais-manager-marketing-20261014`
- Branch: `codex/marketing-local-20261014` (sem commit; diff não commitado aguardando pedido)
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
| Revisão independente | **Não realizada** (nenhum revisor independente disponível nesta execução); pacote para revisão abaixo |

Teste simulado valida lógica e contrato; **não** comprova funcionamento de provedor real.

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
  proxy externo — ver “Execução de 15/10/2026”).

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
- Preferências de contato: autorização (caixa desmarcada por padrão no formulário do site, ou registro da equipe com
  confirmação), descadastro imediato (cancela o agendado), reativação só com novo pedido registrado; histórico append-only.
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
| Recurso `MARKETING` nos mesmos planos do orçamento online (profissional, premium) | Provisório; R$ 99/149/249 seguem hipóteses não aprovadas e nada mudou em planos/cobrança. |
| RBAC: capacidades por membership (083), Gestão com todas | Mesmo desenho das capacidades de Festa (056); sem novo sistema de autorização. |
| Unidade aceita = da empresa e não DESATIVADO | As unidades nascem SUSPENSO (D03); mesma regra das mensagens prontas (082). Agenda por unidade cai para a da empresa quando a unidade não tem agenda. |
| Proxy de domínio desligado por padrão | Deploy sem configuração nunca desvia o painel. |
| Remoção de imagem vale na hora, inclusive no site publicado | Privacidade antes de estética. |
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
| `database/migrations/20261014_084_marketing_automacoes.sql` | regras, execuções, eventos, preferências (+ histórico), tarefas, caixa de saída simulada |
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
  com `X-Forwarded-Host` forjado) = 404. Remoção pela tela → `/`, `sitemap.xml` e `/c/<código>` 404 na hora.
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
simulados). **Não publicadas**: sem commit, push, PR, staging ou produção. Revisão independente **não realizada**.
