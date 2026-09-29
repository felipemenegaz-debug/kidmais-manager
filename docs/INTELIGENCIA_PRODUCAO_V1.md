# Kidmais Intelligence — Production V1

Evolução da [fundação V1](INTELIGENCIA_V1.md). Tudo aqui é **desligado por padrão** e falha fechado.
Nenhuma migration criada por este Master Goal (055a–d, 056, 057) foi aplicada em ambiente real (só em
PostgreSQL descartável). Nenhuma chave de API foi usada e
nenhum documento real foi enviado a provedor externo. Os gates humanos pendentes estão no fim deste documento.

Estado das migrations anteriores (fora deste Master Goal): **053 e 054 aplicadas em staging**, com
backfill imediato e postcheck da 054 aprovados; **produção não recebeu a 053 nem a 054**.

**Garantia do Human Gate:** nenhuma MUTAÇÃO DE NEGÓCIO CONFIRMÁVEL (cadastro, preço, situação, cliente,
contrato histórico) é executada antes do Human Gate. Escritas técnicas acontecem antes, de propósito e
no tenant comprovado: rascunho do Human Gate, documento e original enviados, extração, evidências,
rascunho de importação, reserva e uso de modelo, trace.

## AI FOUNDATION BASELINE

| Campo | Valor |
|---|---|
| Status | **GO** para congelamento (auditoria independente: GO — ROLLBACK 057) |
| Data | 2026-09-29 |
| Branch | `feature/ai-master-v1` |
| HEAD base | `ef1e289` (Merge PR #12 — feature/ai-demo-v1) |
| PRs | 9, um commit local por PR, na ordem do manifesto: CORE → UX → FECHAMENTO → JEV → ACTIONS → DOCUMENT → IMPORT → ACESSO → TOOLING ([IA_MANIFESTO_PRS.md](IA_MANIFESTO_PRS.md)) |
| Migrations | 053 e 054 (já na base; aplicadas em staging, **não** em produção); 055a–d, 056 e 057 (neste congelamento; **não aplicadas** em nenhum ambiente real) |
| Gates (Node 22.23.2) | `check:v1:static` 1225/1225 (lint, tsc, build); `check:v1:postgres` 24/24 suítes, 138 testes, 0 deadlocks (PostgreSQL 18.6 descartável, locale C); `check:ia:prs` 10 estágios; `test:inteligencia` 34/34; `test:ia-demo` 23/23; produção 37/37; `git diff --check` |

Escopo congelado (detalhes nas seções indicadas):

- **Tenant Context** (seção 8): sessão → `provarTenant` (usuário, empresa e membership travados) → posse do recurso
  com a empresa comprovada no WHERE → ação → `revalidarTenant`, no mesmo tx; cross-tenant e inexistente = mesmo 404.
- **Membership e papel por empresa** (056, seção 17): identidade global; `memberships.papel` é a autoridade de empresa.
- **Platform Authority separada** (F1, seção 17): tabela PDF, WhatsApp e desativação de identidade; nenhuma rota de
  tenant cria, eleva ou altera o papel global.
- **Capabilities por membership**: Festa (`festa_membership_capacidades`, 056) e assinatura empresarial
  `CONTRATO_ASSINAR_EMPRESA` (`empresa_membership_capacidades`, 057), conferida na aplicação e no COMMIT.
- **Human Gate** (seção 5), **replay/idempotência** (seções 5 e 17: chave por empresa e pagamento), **orçamento
  fail-closed** com reserva por período (seção 6), **documentos/importação** (seção 7), **pagamentos** (seções 8 e
  17), **Festa** (seção 17).
- **Gates PostgreSQL, rollback e concorrência** (seção 16 e 17): receita canônica do schema vazio; down de 055a–d,
  056 e 057 com recusa quando perderia informação; down da 057 decide sob `ACCESS EXCLUSIVE` (corrida provada nas
  duas ordens); corridas C1–C3, estorno e Human Gate em PostgreSQL real.
- **Isolamento cross-tenant**: testes unitários e PostgreSQL reais para contratos, pagamentos, Festa, áreas,
  capabilities, contas e assinatura.
- **Fora da Foundation:** a fase JEV (além do classificador auxiliar desligado por flag, seção 14) e Demerzel **não
  foram iniciadas**.

Os gates pré-produção seguem pendentes (seção 13) e não bloqueiam o congelamento.

## 1. Arquitetura e PRs separáveis

```
UI (drawer, cards, telas)                        app/api/admin/inteligencia/*  (composition roots)
  → AI Gateway / Orquestrador                     lib/inteligencia/gateway.ts, conversa.ts
  → Policy (READ / SUGGEST / CONFIRM / DENY)      lib/inteligencia/politica.ts
  → Tenant Context (provarTenant / revalidar)     lib/saas/provar-tenant.ts  (existente; B3 acrescentou papelAtual lido sob trava)
  → Intenção (regras; modelo só como fallback)    lib/inteligencia/intencao.ts
  → Model Router (OpenAI / DeepSeek / fake)       lib/inteligencia/modelos/*
  → Tool Registry (leitura) + extensões           lib/inteligencia/ferramentas.ts, extensoes.ts
  → Portas de domínio → Domain Services           festas, clientes, pacotes, financeiro, importação
  → PostgreSQL
```

Cinco features, cada uma num PR (manifesto em [IA_MANIFESTO_PRS.md](IA_MANIFESTO_PRS.md) e
`scripts/ia-prs-manifesto.json`):

| PR | Conteúdo | Depende de |
|---|---|---|
| UX | navegação, dashboard, Resumo/PDF (H9); Tenant Context de contratos e pagamentos com autorização e escrita atômicas (A1, B2, C1–C3); `provar-tenant.ts` com `papelAtual` = papel da membership (B3/056); membership por empresa na administração de contas, capacidades e áreas de Festa (E1/056) | CORE (dublês de teste do gateway) |
| FECHAMENTO | etapa de adicionais do fechamento (regras oficiais, rota admin com Tenant Context, estados da etapa) | — |
| CORE | leituras, conversa, Model Router, orçamento com reserva por período (H6/A5), 055a, `RegistroExtensoes` | — |
| JEV | classificador auxiliar (seção 14) | CORE |
| ACTIONS | Human Gate, ações de Pacote (H3/A2), `/operacoes`, 055b; rotas de configuração comercial com gestão verificada no tenant (`exigirGestaoNoTenant`) | UX (papelAtual), CORE |
| DOCUMENT | upload limitado (H7/B1), PDF isolado em Worker (A1), extração, validação (H4/H5/A3/A4), 055c | CORE |
| IMPORT | rascunho de importação, match, plano, Import Engine, telas, 055d | CORE, ACTIONS, DOCUMENT |
| ACESSO | preparação do acesso público automatizado | — |
| TOOLING | docs, skills (registro + lint), manifesto e check de composição | — |

O CORE não importa nenhuma feature. A conversa recebe um `ModuloAcoes` opcional por dependência
(`lib/inteligencia/extensoes.ts`); ações entram pela lista `CHAVE_ACOES` de um `RegistroExtensoes`
montado em `app/api/admin/inteligencia/extensoes.ts`, o único ponto de encontro, com **uma linha
marcada `// @pr:X` por feature**. Sem feature registrada, a IA responde só leituras e “ainda não” às ações.

`npm run check:ia:prs` prova isso com estados intermediários reais: extrai o commit base, copia só os
arquivos de cada estágio (lista em `scripts/ia-prs-manifesto.json`: CORE; FECHAMENTO; CORE+UX; CORE+JEV;
UX+CORE+ACTIONS; CORE+DOCUMENT; …; tudo), remove as linhas marcadas das features ausentes e roda `tsc` e
os testes unitários.

Regras que os testes de arquitetura (`lib/inteligencia/arquitetura.test.ts`) protegem contra regressão:

- `lib/inteligencia` não tem SQL, driver, `process.env` nem import fora de uma lista fechada; o modelo
  nunca recebe `DbExecutor`, tenant ou ferramenta executável.
- `lib/ia-persistencia` tem o SQL das tabelas `ia_*` e importa da IA **só tipos**.
- Cada composition root liga os serviços de domínio reais da própria feature.
- **B2:** CORE não importa feature; feature só importa CORE e features anteriores
  (CORE → JEV → ACTIONS → DOCUMENT → IMPORT); a única exceção é a linha marcada em `extensoes.ts`.
- O Core não importa a IA. As flags só são lidas em `lib/inteligencia/flags.ts`.

## 2. Feature flags (`lib/inteligencia/flags.ts`)

| Variável | Libera |
|---|---|
| `INTELIGENCIA_ENABLED` | chave-mestra; `atencao_hoje` (V1) depende só dela |
| `AI_READ_ENABLED` | novas leituras e perguntas em texto livre (`/conversa`) |
| `AI_ADMIN_ACTIONS_ENABLED` | ações CONFIRM de cadastro (pacotes) |
| `AI_CONTRACT_IMPORT_ENABLED` | upload, extração e importação histórica |
| `AI_TENANT_ALLOWLIST` | opcional; uuid separados por vírgula; inválida ⇒ nenhuma empresa |
| `AI_DOCUMENT_EXTERNAL_PROVIDER_ALLOWED` | documento real pode ir a provedor externo (gate humano) |
| `AI_JEV_ENABLED` | classificador auxiliar JEV na conversa (exige a chave-mestra) |
| `AI_FALLBACK_ENABLED` | troca de provedor numa falha de modelo (nunca na extração de contrato) |

Só `"true"` liga (ausente, vazio, `TRUE`, `1` = desligado). Flag não é fronteira de PR: a separação é de código (seção 1).

## 3. Rotas

| Rota | Feature | Faz |
|---|---|---|
| `POST /api/admin/inteligencia` | CORE | leitura por `{ capacidade, parametros }` (V1, compatível) |
| `POST /api/admin/inteligencia/conversa` | CORE | texto livre → leitura, rascunho sob Human Gate ou “ainda não” |
| `POST /api/admin/inteligencia/operacoes` | ACTIONS | Human Gate: `{ operacaoId, versao, payloadHash, decisao }` — único caminho que executa mutação de negócio |
| `POST /api/admin/inteligencia/documentos` | DOCUMENT | upload multipart limitado → documento, extração e revisão estruturada |
| `POST /api/admin/inteligencia/importacoes` | IMPORT | estado, abrir (por `documentoId`), ler, **consultar** (somente leitura, por `documentoId`), revisar, cliente, preparar, descartar |
| `GET /api/admin/contratos/resumo-contratacao` | UX | dados do Resumo/PDF com Tenant Context |
| `GET /api/admin/fechamentos/adicionais` | FECHAMENTO | adicionais elegíveis do pacote, na empresa comprovada (seção 15) |

Nenhuma rota aceita empresa, usuário ou papel no corpo. `?empresaId=` só escolhe entre memberships ativas.

## 4. Capacidades READ

| Capacidade | Ferramenta | Serviço de domínio | Observação |
|---|---|---|---|
| `atencao_hoje` | `atencao_hoje` | `listarRecebiveis` | V1 preservada |
| `analisar_recebiveis` | `financeiro.recebiveis.resumir` | `listarRecebiveis` | aging por faixa |
| `analisar_pagamentos` | `financeiro.pagamentos.analisar` | `recebidoNoPeriodo` | mesmo intervalo do mês anterior |
| `contratos_pendentes` | `contratos.pendentes.listar` | `contratosAguardandoAssinatura` (leitura) | predicado do Dashboard |
| `agenda_do_dia` | `festas.agenda.dia` | `agendaDoTenant` (leitura) | predicado do Dashboard |
| `resumir_contrato` | `contratos.resumir` | `resumoContratoDoTenant` (leitura) | snapshot, sem recálculo |
| `resumir_cliente` | `clientes.resumir` | `obterClienteBase` | sem CPF/contato/endereço na resposta |
| `resumir_festa` / `pendencias_da_festa` / `festa_em_risco` | `festas.*` | `consultarFestas` | exige FESTA_CONSULTAR; roda fora da transação do gateway |

Toda resposta separa **fato**, **cálculo** e **ausência de dados**, com evidências e link para a tela de origem.

## 5. Human Gate (`lib/inteligencia/acoes/`)

Rascunho `COLETANDO` → pergunta só o que falta → preview `AGUARDANDO_CONFIRMACAO` com `versao`,
`payloadHash` e `expiraEm` → clique → numa única transação: prova do tenant, rascunho travado
(`FOR UPDATE`) por empresa **e** usuário, replay idempotente, estado/expiração/versão/hash, RBAC e flag
**de agora**, schema e pré-condições de domínio de novo, serviço de domínio, `EXECUTADA` por
compare-and-set. Qualquer falha desfaz tudo. Texto nunca confirma.

- **Autoridade atual (B3):** o papel usado no Human Gate é o **persistido**, lido por `provarTenant` com a
  linha do usuário travada (`FOR UPDATE`) na mesma transação da execução — nunca o papel carregado com a
  sessão. Troca concorrente de papel espera o commit; não há janela entre autorizar e executar.
- **Cancelar (B4)** vale em `COLETANDO` e `AGUARDANDO_CONFIRMACAO`, com a mesma autoridade da confirmação
  (dono, tenant, Policy + RBAC atuais, flag e allowlist) e a `versao`/`payloadHash` que o operador está
  vendo (`""` em `COLETANDO`). Payload antigo não cancela versão nova (409 `CONFIRMACAO_DESATUALIZADA`);
  repetir o mesmo cancelamento válido devolve 200. Rascunho cancelado não volta a coletar.
  Na tela (C4), o resultado do clique substitui a mensagem atual do rascunho — preview **ou** coleta: depois
  de `CANCELADA` o drawer não mostra mais o rascunho ativo e a próxima frase vira pergunta nova.
- **Replay** (clique duplo, retry) devolve o resultado gravado sem executar de novo, mas só depois de
  tenant, dono, Tool Registry/classe, Policy + RBAC, flag e allowlist **de agora**.

### Ações de Pacote (H3): o preview mostra todo efeito persistido

| Pedido | Pacote ainda não usado | Pacote já usado |
|---|---|---|
| criar | `salvarPacoteComercial` com disponibilidade/buffet/itens vazios (nada a preservar) | — |
| nome, descrição, duração, convidados | `editarPacoteNaoUtilizado` (só essas colunas) | `criarRevisaoPacoteAdmin` (copia todo o agregado, inclusive regras de disponibilidade futuras, e o preço) |
| preço (faixa única) | `gravarFaixasPacote` (nova versão publicada da tabela; outros pacotes mantêm preço) | recusado: “use a tela Pacotes” |
| ativar / desativar | `alterarSituacaoPacoteAdmin` | idem |

Editar **nunca** passa por `salvarPacoteComercial`, que regrava disponibilidade, buffet e itens a partir do
retrato recebido (o painel só traz regras vigentes; regras futuras seriam desativadas). O preview lista
cada campo antes → depois (inclusive descrição), o que não muda, “Dias e horários: não são alterados”
(ou “copiados para a nova revisão”), e a nova versão da tabela de preços quando houver.
Pacote com mais de uma faixa de preço: recusado com orientação para a tela.

**A2 — situação preservada:** a revisão de pacote já usado pela IA chama `criarRevisaoPacoteAdmin` com
`preservarSituacao: true` (a tela continua ativando ao revisar, como antes). O preview mostra
“Ativo/Desativado (não muda)”, e a execução confere o resultado: se a situação mudou, a transação inteira é
desfeita (`EFEITO_NAO_PREVISTO`, 409). Pacote desativado nunca é reativado por uma edição de descrição.

Buffet é **DENY**: catálogo global, e a rota do catálogo recusa escrita por membership.

## 6. Model Router e orçamento (H6)

- Provedores `OPENAI` e `DEEPSEEK` (Chat Completions; `json_schema` estrito / `json_object`; sem `tools`).
  `FAKE` só em testes. Sem chave ou modelo para o tier, só regras.
- Timeout, retry limitado, circuit breaker. Fallback para outro provedor **fail-closed**: só com
  `AI_FALLBACK_ENABLED=true`, e nunca para extração de contrato.
- Cada workload confere o próprio tier: sem modelo ECONOMY a conversa fica nas regras, e a extração
  (STANDARD) continua disponível se houver modelo para ela.
- **RESERVA → chamada → RECONCILIAÇÃO**, por tentativa:
  - antes da rede reserva-se o teto estimado (entrada ≤ 1 token por byte UTF-8 das mensagens **e do
    schema** + `estimativa` conservadora: 512 tokens fixos, 16 por mensagem, 6000 por imagem —
    configurável em `AI_BUDGET_JSON.estimativa`; saída = `maxTokensSaida`);
  - **A5 — período fixo:** dia e mês (America/Sao_Paulo) são gravados na reserva (`periodo_dia`,
    `periodo_mes`, imutáveis). Reconciliação depois da meia-noite conta no período da reserva, nunca no
    novo; limite diário e mensal leem pelo período;
  - **reserva órfã:** reserva aberta há mais de 15 min (processo morreu entre reservar e reconciliar) vira
    `ORFA` antes da próxima reserva da empresa; continua contando como consumo e só sai por reconciliação
    tardia (`RECONCILIADA`/`USO_DESCONHECIDO`), nunca por liberação;
  - a reserva é atômica (`pg_advisory_xact_lock` por empresa + conferência + INSERT na mesma transação):
    consumo real + reservas abertas + nova reserva ≤ limite, ou a chamada não sai;
  - provedor sem `usage`, timeout, rede, 5xx ⇒ **USO DESCONHECIDO**: tokens `NULL` (nunca zero) e a
    reserva continua contando; só recusa comprovada antes do processamento (4xx, sem chave) libera;
  - falha ao persistir uso vira alerta `USO_NAO_REGISTRADO` (sem PII) e a reserva aberta segue contando;
  - moedas nunca se somam: limite de custo exige `moeda` no `AI_BUDGET_JSON` igual à da `AI_PRICING_JSON`;
    custo em outra moeda conta como desconhecido (recusa).
- **Orçamento obrigatório (A5/B1):** sem **teto aplicável** à operação atual, nenhuma chamada de modelo
  (`ORCAMENTO`); a IA segue só com regras. Recusa: `AI_BUDGET_JSON` ausente, inválido, `null`, `{}`,
  `{"porEmpresa":{}}`, limite só de outra capacidade, limite com valor não utilizável, teto de custo sem
  preço/moeda. Teto aplicável = `porEmpresa` (vale para todas as capacidades) e/ou `porCapacidade` da
  capacidade atual; os dois valem juntos. Não há teto por unidade/estabelecimento na arquitetura atual.
  Registro em memória e PostgreSQL recusam reserva sem teto válido (mesma regra, antes de qualquer transação).
- Sem a 055a com orçamento configurado: chamadas recusadas (fail closed).

## 7. Documentos (DOCUMENT) e importação histórica (IMPORT)

- **Upload (H7):** a rota não confia em `Content-Length` nem usa `formData()`; lê o stream contando bytes
  e cancela no primeiro byte acima do teto (arquivo + 64 KiB); limita partes, cabeçalho por parte e
  campos simples; aceita exatamente um arquivo `arquivo`; no máximo 2 uploads simultâneos por processo (429).
- **Upload lento (B1):** prazo total de leitura (60 s), ociosidade entre pedaços (10 s) e o `AbortSignal`
  do pedido. Cliente que envia devagar recebe `LEITURA_LENTA` (408); cliente que desiste,
  `ENVIO_CANCELADO`; o stream é cancelado e a vaga de upload liberada em todos os casos.
- **PDF hostil:** `lib/importacao-contrato/pdf-texto.ts` com orçamento de trabalho, prazo e
  cancelamento; ranges de CMap só com inteiros seguros, ordem, amplitude e total limitados; Unicode
  inválido vira aviso; nunca lança.
  - **A1:** o `ToUnicode` é lido por um lexer linear (máquina de estados, sem regex), com limites de
    bytes, tokens, blocos, dígitos e itens de array; bloco sem fim, hex sem `>` e array sem `]` viram
    aviso. Os regex de dicionário têm quantificadores limitados e dicionário gigante é truncado com aviso.
  - **Isolamento:** em produção o PDF é lido num `worker_threads` (`pdf-isolado.ts` + `pdf-worker.ts`)
    com heap limitado (256 MB) e prazo **duro** (prazo + 1 s): passou do prazo, o pedido cancelou ou o
    worker falhou ⇒ `terminate()` e resultado vazio com aviso. O processo principal nunca fica preso.
- **Sem normalização silenciosa (H4):** cada campo guarda BRUTO, NORMALIZADO e VALIDAÇÃO
  (`VALIDO`, `INVALIDO`, `AMBIGUO`, `NAO_REPRESENTAVEL`, `PRECISA_REVISAO`). Negativo, decimal ambíguo,
  minutos ≥ 60, texto extra ou mais de um número nunca viram um valor parecido. Valor recusado não é
  “confirmado”: é corrigido ou removido explicitamente. Conflito entre campos exige “o contrato histórico
  contém este valor divergente” — diferente de aceitar uma conversão (digitar o valor). Toda correção
  revalida todos os campos; confirmação cai se o valor ou o conflito mudar. Parcela inválida continua
  visível como pendência. O plano revalida tudo e só fica pronto sem perda silenciosa.
- **Evidência tipada (H5):** dinheiro por igualdade numérica completa; CPF e telefone canônicos; data
  pelo parser; número por token inteiro; texto como frase delimitada. “100” não é provado por “1000”.
- **A3 — captura bruta:** a extração captura o trecho com sinal e escala (`-30 convidados`,
  `R$ -100,00`, `menos 50`, `30 mil`, `2k`) e o validador decide; nada é descartado antes da validação.
  Inteiro só aceita unidade conhecida (convidados, pessoas, crianças, anos, unidades): `30 mil` não vira 30.
- **A4 — localizador de evidência:** a evidência guarda página e posições (`inicio`, `fim`) no texto da
  página e só confere com fronteiras válidas: “Ana” não é provada por “Mariana”, “30” não é provado por
  “-30”, “100” não por “1000” nem por “100,50”, CPF parcial não prova CPF. Parcela exige valor **e** data.
- DOCUMENT devolve a revisão estruturada e a registra na extração; IMPORT abre a importação a partir da
  extração registrada (`acao: "abrir"`, `documentoId`). Documento de outra empresa ou inexistente: 404 igual.
- **Previsto ≠ pago**; histórico não é recalculado; festa não é criada (sem serviço de domínio).
- **Estados terminais:** documento `RECEBIDO` → resultado da extração (`EXTRAIDO`, `PRECISA_REVISAO`,
  `FALHOU`), que é final. Importação `EM_REVISAO` → `IMPORTADA` (com cliente e resultado) ou `DESCARTADA`
  (sem); encerrada não muda. Um documento tem no máximo uma importação ativa (aberta ou importada): depois
  de descartar, enviar o mesmo arquivo (mesmo documento pelo sha256) abre uma nova; importada nunca é
  reaberta nem reimportada. A confirmação vive no Human Gate (não há estado intermediário na importação).
- **Consulta (A6):** toda importação devolvida traz `situacao` (`EM_ANDAMENTO`, `CONCLUIDA`,
  `CANCELADA`) e, quando concluída, `resultado` mínimo (cliente, ação, pendências, data, destino — sem
  snapshot nem CPF). `acao: "consultar"` por `documentoId` (B5: resposta só com `id`, `documentoId`, `versao`,
  `status`, `situacao` e `resultado` — nunca extração, CPF ou snapshot) é somente leitura: ativa, senão a última
  descartada; sem importação, `FALHOU` (extração falhou) ou `NAO_INICIADA`. Outra empresa ou inexistente:
  404 igual. Confirmação que falha é desfeita inteira (a importação segue `EM_ANDAMENTO`; o motivo fica no trace).

## 8. Tenant Context das rotas administrativas de contrato e pagamentos (H9, A1, B2, C1–C3)

Posse = empresa gravada no fechamento **e** empresa do pacote iguais à empresa comprovada, na própria
consulta (`contrato-tenant.ts`, `exportacao-tenant.ts`, `resumo-tenant.ts`). Pagamento: pagamento →
versão → contrato → fechamento/pacote da empresa. Outra empresa, legado e inexistente ⇒ o mesmo 404; sem
tenant comprovado ⇒ 403, sem consulta do recurso. RBAC dos serviços é o mesmo de antes; o papel usado é o
**atual** (`papelAtual` de `provarTenant`).

**Atomicidade (C2).** Nas rotas que escrevem — Pagamentos, financeiro por contrato e geração de contrato —
prova do tenant (usuário ativo, empresa ativa, membership ativa, papel atual, com as linhas travadas
`FOR UPDATE`), prova de posse, travas do domínio e a escrita rodam na **mesma transação**
(`executarComPosseNoTenant` → serviço com `executor`), com `revalidarTenant` antes do commit. Revogação
ou suspensão concorrente espera o commit; percebida na revalidação, desfaz a escrita. Ordem de travas:
usuário → empresas → membership → recurso (a mesma de todo fluxo de tenant). O corpo da requisição (JSON
ou arquivo) é lido antes de abrir a transação.

| Rota | Situação anterior | Agora |
|---|---|---|
| `GET /api/admin/contratos/resumo-contratacao` | já provava o tenant (H9) | painel e financeiro lidos na transação da prova (D1) |
| `POST /api/admin/contratos/versoes/[versaoId]` | já provava (`operarContrato` → `contratoDoTenant`, na transação da ação) | inalterada |
| `GET /api/admin/contratos/versoes/[versaoId]/edicao` | já provava (`versaoDoTenant`) | inalterada |
| `GET /api/admin/contratos/pdf`, `/resumo` (por `fechamentoId`), `/documentos/[documentoId]` | **vulneráveis**: qualquer admin lia PDF/comprovante de outra empresa pelo id | corrigidas (A1); dados adquiridos na transação da prova e PDF montado depois do commit (D1) |
| `GET /api/admin/contratos/painel` (lista e detalhe `?contratoId=`) | **vulnerável**: lista global e detalhe de qualquer empresa | corrigida (B2): lista filtrada no SQL; detalhe lido na transação da prova (D1) |
| `GET/POST /api/admin/contratos/[contratoId]/financeiro/…` (painel, histórico, tratamentos, cronograma, devoluções, **comprovantes de devolução**) | **vulnerável**: leitura, download e ações de outra empresa | corrigida (B2); leitura, download e ações na transação da prova (C2) |
| `GET /api/admin/contratos?fechamentoId=` | **vulnerável**: contrato e versão (snapshot com dados pessoais) de outra empresa | corrigida (B2); leitura na transação da prova (D1) |
| `POST /api/admin/contratos` (gerar contrato) | **vulnerável**: gerava contrato para fechamento de outra empresa | corrigida (B2); geração na transação da prova (C2) |
| `GET /api/admin/pagamentos?fechamentoId=` | **vulnerável: leitura** do pagamento (plano, parcelas, recebimentos) de outra empresa | corrigida (C1): posse do fechamento e leitura na mesma transação |
| `POST /api/admin/pagamentos` | **vulnerável**: criava pagamento para fechamento de outra empresa | corrigida (C1/C2) |
| `POST /api/admin/pagamentos/[pagamentoId]/{comprovantes,estornos,plano,recebimentos}` | **vulneráveis**: escrita em pagamento de outra empresa | corrigidas (C1/C2); recebimento, parcela e alocação precisam ser do pagamento provado (estorno passou a conferir parcela → plano → pagamento) |
| Devolução com `beneficiarioClienteId` | **vulnerável**: aceitava cliente de outra empresa (só FK global) | corrigida (C3): cliente da mesma empresa do fechamento do contrato |

`/api/admin/financeiro/*` já usava `withTenantTransaction` e não foi alterado.

**Leituras sensíveis na transação da prova (D1 — P1 resolvido).** Detalhe do `/painel`,
`GET /api/admin/contratos?fechamentoId=`, `/pdf`, `/resumo` e `/resumo-contratacao` usam o mesmo
`executarComPosseNoTenant` (em `posse-tenant.ts`): provarTenant → papel atual → posse → **todas** as consultas
com o mesmo `tx` (`detalheAdministrativo(id, tx)`, `obterContratoPorFechamento(id, tx)`,
`consultarPainelFinanceiro(id, tx)`, `adquirirPdfContratoAdmin`/`adquirirResumoContratoAdmin`) → revalidarTenant
→ commit. O PDF é montado **depois** do commit, só em memória (`renderizarPdfContratoAdmin`,
`renderizarResumoContratoAdmin`, `materializarDocumento`), sem consulta e sem transação aberta. O helper não
atômico (`exigirPosseNoTenant`) foi removido. `/documentos/[id]` já lia no tx da prova. Provas: unitárias
(tx fechado recusa consulta na renderização; ordem adquirir → commit → renderizar; revogação vista na
revalidação descarta os dados) e PostgreSQL real no `gates-c2` (leitura própria; outra empresa ⇒ 404;
membership revogada/empresa suspensa antes ⇒ 403; papel atual lido do banco; revogação e troca de papel
concorrentes **esperam** o commit da leitura, e a leitura espera a revogação já em curso e é recusada;
nenhum uso do pool durante a renderização).

**Lock do recebimento no estorno (D2 — P2 resolvido).** A trava é
`bloquearRecebimentoDoPagamento(recebimentoId, pagamentoId, tx)`:
`WHERE id = $1 AND pagamento_id = $2 ... FOR UPDATE`, depois de travar o pagamento já provado no tenant.
Recebimento de outro pagamento (inclusive de outra empresa) não casa o WHERE e nunca recebe `FOR UPDATE`;
inexistente, de outro pagamento e não confirmado respondem o mesmo `ESTORNO_INVALIDO` (409). Prova real: com
os recebimentos alheios travados por outra conexão e `lock_timeout` de 2 s, o estorno responde na hora (sem
`55P03`); o recebimento próprio espera a trava escopada. Com o lock antigo por id o mesmo teste falha com
`55P03` (verificado).

A tela e o PDF do Resumo leem por `GET /api/admin/contratos/resumo-contratacao`: sessão → Tenant
Context → contrato da empresa comprovada → painel e financeiro. Outra empresa, legado e inexistente
respondem o mesmo 404; a empresa do contrato nunca é aceita do pedido como prova.

## 9. Prompt injection

Intenção por regras primeiro; classificador por modelo só escolhe num enum fechado; nenhuma chamada
leva ferramentas; saída passa por schema estrito; confirmar exige o clique com `operacaoId` + `versao` +
`payloadHash`. Testes adversariais: `acoes/human-gate.test.ts`, `documentos/upload.test.ts`,
`importacao/revisao.test.ts`, `importacao-contrato/extracao.test.ts`, `importacao-contrato/pdf-hostil.test.ts`.

## 10. Observabilidade e privacidade

- Trace `[Kidmais Inteligência]` sem texto do operador, PII, valores, prompt ou resposta do modelo.
  Conversa e extração registram provedor, modelo, tokens e custo estimado somados (parcela desconhecida
  ou moedas diferentes ⇒ `null`, nunca zero), `chamadasModelo` e `fallbackProvedor` (troca de
  provedor). `fallback` é outra coisa: resposta degradada com mensagem segura.
- Alerta `[Kidmais IA alerta]` quando o uso não é persistido.
- Views `ia_uso_diario` (por período da reserva e moeda, com chamadas de uso desconhecido) e
  `ia_operacoes_resumo`.
- Documento real só vai a provedor externo com `AI_DOCUMENT_EXTERNAL_PROVIDER_ALLOWED=true`.

### Retenção (estado atual; prazos exigem decisão humana)

Nada é apagado automaticamente. As tabelas `ia_*` recusam `DELETE` por gatilho, e o rollback recusa
descartar dados sem decisão explícita. Os prazos abaixo são **propostas** para a decisão do responsável
(LGPD: finalidade, minimização, pedido de eliminação do titular), não configuração ativa.

| Dado | Onde | Contém PII? | Hoje | Proposta a decidir |
|---|---|---|---|---|
| Trace | stdout (logs do Render) | não (ids e metadados) | retenção dos logs da plataforma | manter a da plataforma |
| Reserva e uso de modelo | `ia_orcamento_reservas`, `ia_uso_modelo` | não | indefinido (insert-only) | 13 meses (orçamento e custo) |
| Rascunho do Human Gate | `ia_operacoes` | payload de cadastro (nome/preço de pacote; importação só por id) | indefinido; expirado continua como histórico | 90 dias após encerrar/expirar |
| Original do documento | `ia_documento_originais` (bytea privado) | **sim** (contrato: CPF, contatos, dados de criança) | indefinido, imutável | definir prazo + procedimento de eliminação por titular |
| Extração e evidências | `ia_extracoes.resultado`, `ia_evidencias.trecho` (≤ 300 caracteres) | **sim** | indefinido, imutável | mesmo prazo do original |
| Rascunho de importação | `ia_importacoes.dados` | **sim** (campos extraídos) | indefinido; descartada fica como histórico | mesmo prazo do original |
| Provedor externo | fora do Kidmais | **sim**, se autorizado | não enviado (flag desligada) | registrar provedor, região e retenção antes de ligar |

Eliminar ou expurgar exige migration/procedimento próprio (os gatilhos recusam `DELETE`), autorização
explícita e registro em auditoria de negócio. Nenhum desses procedimentos foi escrito nesta entrega.

## 11. Migrations 055a–d (NÃO aplicadas)

| Migration | PR | Objetos |
|---|---|---|
| `20260928_055a_inteligencia_uso.sql` | CORE | `ia_orcamento_reservas`, `ia_uso_modelo` (tokens NULL = desconhecido), `ia_uso_diario`, `kidmais_055_somente_insercao` |
| `20260928_055b_inteligencia_operacoes.sql` | ACTIONS | `ia_operacoes`, `ia_operacoes_resumo` |
| `20260928_055c_inteligencia_documentos.sql` | DOCUMENT | `ia_documentos`, `ia_documento_originais`, `ia_extracoes`, `ia_evidencias` (exige 055a) |
| `20260928_055d_inteligencia_importacoes.sql` | IMPORT | `ia_importacoes` (exige 055c) |

Cada uma tem `database/checks/..._postcheck.sql`, `..._rollback_precheck.sql`,
`..._rollback_postcheck.sql` (somente leitura) e `database/rollback/..._down.sql`.

Invariantes no banco (além dos testes):

- 055a: período da reserva imutável; `ORFA` só sai para `RECONCILIADA`/`USO_DESCONHECIDO`.
- 055c: original extraído é do **mesmo documento** (FK composta `original_id, documento_id, empresa_id`);
  `concluido_em ≥ iniciado_em`; `provedor` e `modelo` juntos; estado final do documento não muda.
- 055d: extração revisada é do **mesmo documento** (FK composta); `IMPORTADA` ⇔ resultado e cliente;
  só `EM_REVISAO` muda e a versão só avança; índice único parcial de importação ativa por documento.

## 12. Rollback (H8)

Ordem: **055d → 055c → 055b → 055a**. Procedimento, cada passo com autorização explícita:

1. **Flags:** desligar `AI_CONTRACT_IMPORT_ENABLED`, `AI_ADMIN_ACTIONS_ENABLED` e, para a 055a,
   `INTELIGENCIA_ENABLED` (efeito imediato, sem migration).
2. **Drenar:** aguardar o maior entre o TTL de confirmação (`AI_CONFIRMACAO_TTL_SEGUNDOS`, máx. 1 h) e o
   timeout de modelo (`AI_MODEL_TIMEOUT_MS`, máx. 120 s) para não haver rascunho válido nem reserva aberta.
3. **Precheck:** `..._rollback_precheck.sql` (somente leitura) e registrar os números.
4. **Down:** `..._down.sql` — uma transação; `lock_timeout` de 5 s (se a aplicação ainda segura as tabelas,
   aborta em vez de enfileirar); `LOCK TABLE ... ACCESS EXCLUSIVE` **antes** de conferir; reconferência sob
   a trava; `DROP` só depois. Qualquer condição insegura aborta tudo (fail closed).
   - 055d recusa qualquer importação; 055c recusa qualquer documento (retenção exige decisão humana);
     055b recusa operação executada ou rascunho válido; 055a recusa reserva aberta e exige
     `SET LOCAL kidmais.rollback_055a_descartar_uso = 'sim'` para descartar histórico de uso **e** de
     reservas.
5. **Verificação:** `..._rollback_postcheck.sql` (objetos removidos, Core intacto).

Harness PostgreSQL (B2): `lib/ia-persistencia/migration-055.postgres.test.ts` — opt-in só com
`KIDMAIS_POSTGRES_DESCARTAVEL=kidmais_pacotes_v1_descartavel`; usa os scripts reais (up, verificação,
down), ciclo a→d / d→a, corrida com o rollback primeiro e com a escrita primeiro para importações,
documentos, operações executadas, rascunhos válidos e reservas abertas, `ROLLBACK` explícito depois de
cada recusa esperada, descarte por `SET LOCAL`, e comparação de contagem/md5 das tabelas do Core antes e
depois. Executado no PostgreSQL descartável pela receita canônica (seção 16), dentro do
`check:v1:postgres`; nunca em staging/produção.

## 13. Gates humanos pendentes

1. Harness PostgreSQL da 055: executado no descartável (seção 16); clone/staging seguem pendentes.
2. Aplicar 055a–d, 056 e 057 (clone → staging → produção), cada uma com autorização explícita; a 056 aborta se
   houver área de Festa sem empresa única (precheck lista a contagem).
3. Configurar chaves e modelos (OpenAI/DeepSeek) no Render — alteração de env pode disparar deploy.
4. Preencher `AI_PRICING_JSON` a partir das páginas oficiais e definir `AI_BUDGET_JSON` (com `moeda`).
5. Autorizar envio de documento real a provedor externo, depois de registrar provedor, região e retenção.
6. Decisão do Core sobre catálogo de Buffet por empresa (hoje DENY).
7. Serviço de domínio para criar festa/fechamento de contrato histórico.
8. Merge e deploy, PR a PR, na ordem do manifesto.
9. **PR-C (fechamento público):** decidir e autorizar o Tenant Context público (seção 15).
10. Decidir os prazos de retenção (seção 10) e o procedimento de eliminação por titular.
11. Skills Demerzel A.I.: informar repositório e commit de origem para a revisão
    ([SEGURANCA_SKILLS.md](SEGURANCA_SKILLS.md)).
12. ~~Assinatura pela empresa~~ — **decidido e implementado (057):** autoridade empresarial por membership +
    capability `CONTRATO_ASSINAR_EMPRESA`; a 057 aborta se a validação de contrato em produção diferir da 013.
13. Antes de produção: revisar as identidades com papel global `REPRESENTANTE_AUTORIZADO` — todas têm autoridade
    de plataforma (tabela PDF, WhatsApp).
14. OTP real e validações **diferidas** de assinatura/formalização no COMMIT: exercitar em staging (as suítes
    PostgreSQL rodam em transação não confirmada, exceto a regra de assinatura da 057, disparada na hora).
15. Referência do PSP: oráculo residual de existência (sim/não) para quem já conhece uma referência (seção 17).
16. Membership REVOGADA é terminal (043/045): readmitir quem saiu da empresa exige decisão e migration futuras.
17. Scripts de integração fora dos gates (`scripts/festa-016-*.cjs` e os `*.integration.cjs` financeiros) usam banco
    legado e não fazem parte da regressão; revisar antes de reutilizar.

## 14. JEV — classificador auxiliar

`lib/inteligencia/jev/` (feature JEV, flag `AI_JEV_ENABLED`). JEV **não** é Model Router, Policy, Human
Gate nem autoridade de tenant/RBAC. Não recebe tenant, sessão, banco nem ferramenta; só os dados da tarefa.

- Contrato `JevClassification`: `intent`, `completeness`, `missingFields`, `priority`,
  `needsHumanReview`, `reasonCodes` (+ `fila`, `capacidade`, `categoriaSugerida` opcionais), schema
  fechado por tarefa. Fora do schema, da tarefa pedida, do prazo (500 ms) ou com erro ⇒ `null`.
- **V1 ativa:** completude de festa/cadastro (campos faltando, nunca preenche), triagem de mensagem
  (`ORCAMENTO`, `REAGENDAMENTO`, `PAGAMENTO`, `RECLAMACAO`, `DUVIDA`, `OUTRO`, com fila), avaliação
  pós-festa (sentimento; negativa, mista, nota que contradiz o texto ou instrução embutida ⇒ revisão humana).
- **V2 preparada:** prioridade operacional por fatores visíveis; categoria de lançamento financeiro
  (só categoria existente). **V3 preparada:** sugestão de rota (regra, leitura, modelo, humano).
- **Na conversa:** regras → JEV → modelo. JEV só pode sugerir uma **leitura** do catálogo já filtrado por
  papel, flags e módulos (limite de 800 ms). Sugestão de ação é ignorada — JEV nunca abre rascunho nem
  causa CONFIRM. Rota `HUMANO` vira “precisa de uma pessoa da equipe”. Desligado, indisponível ou lento: a
  conversa segue igual a antes.
- Trace próprio só com tarefa, resultado, códigos e duração (sem texto).

## 15. Fechamento: “Quer adicionar algo à festa?” (bug de staging)

**Causa raiz:** desde o PR-A (commit `d93955e`) as rotas públicas de catálogo do fechamento
(`/api/fechamentos/adicionais|catalogo|pacotes`) respondem `CATALOGO_PUBLICO_INDETERMINADO` e
`buscarPacoteAtivoPorCodigo` recusa sempre: sem Tenant Context público, não há empresa comprovada para
escolher catálogo e preço. A etapa não tratava a recusa: ficava sem adicionais e deixava aparecer o
conteúdo da próxima etapa.

**Corrigido nesta entrega:**

- Regras oficiais em `lib/comercial/adicionais-elegiveis.ts`: Lembrancinha inclusa em Mini Festa,
  Completa e Premium (adicional em Pocket, Compacta e Essencial); Empratado premium incluso só no
  Premium; item de buffet incluso no pacote nunca aparece como adicional pago; adicional sem preço não aparece.
- `adicionaisDoPacoteNoTenant`: pacote vigente e ativo da empresa comprovada, tabela de preços publicada
  e vigente da própria empresa, adicionais da empresa. Testado com empresas A e B.
- Admin: `GET /api/admin/fechamentos/adicionais` (sessão → Tenant Context) alimenta o wizard do admin.
- Etapa pública: estados explícitos (carregando / erro com “Tentar novamente” / pronto); só mostra cartões,
  totais e observações quando os adicionais carregaram, e não avança sem eles.

**Não corrigido (depende de decisão):** a rota pública continua fail-closed, e criar fechamento (público
ou admin) continua bloqueado pelo PR-A. Reabrir exige o **PR-C**: configuração pública confiável por
empresa (ex.: domínio/slug → empresa verificada no servidor) e criação de fechamento com Tenant Context.
Não foi reaberto aqui para não relaxar o isolamento.

## 16. PostgreSQL descartável: receita canônica, classes de teste e inventário (D3/D4)

**Receita oficial** (`scripts/regressao-v1-postgres-receita.cjs`, chamada pelo `check:v1:postgres`):

1. Cluster PostgreSQL 18 **descartável**, só em `127.0.0.1`, usuário `kidmais_descartavel`, com
   `cluster_name = 'kidmais_descartavel'` no `postgresql.conf`. Nunca o banco real, staging ou produção.
   Inicializado com `initdb --locale-provider=builtin --builtin-locale=C.UTF-8 --locale=C` (`lc_messages = C`):
   as suítes de corrida conferem a mensagem de *lock timeout* em inglês e falham com mensagens localizadas.
2. Porta: a padrão das suítes ou outra com `KIDMAIS_DESCARTAVEL_PORTA` **e**
   `KIDMAIS_DESCARTAVEL_AUTORIZACAO=127.0.0.1:<porta>/kidmais_pacotes_v1_descartavel` (a mesma regra de
   `lib/comercial/alvo-descartavel.ts`). Opt-in: `KIDMAIS_POSTGRES_DESCARTAVEL=kidmais_pacotes_v1_descartavel`.
   `DATABASE_URL` e `PG*` nunca escolhem o destino (o runner as remove do ambiente das suítes).
3. Antes de qualquer escrita a receita confere `cluster_name`, endereço, porta, usuário e banco, e recusa
   o cluster se existir `kidmais_manager`. Só cria/remove os bancos da sua lista.
4. Recria, **do schema vazio**, um modelo por estado, aplicando as migrations do inventário oficial
   (`approvedFiles`) em ordem, com os checks exigidos por ele (prechecks antes; backfill da 054 e postchecks
   depois). Única fixture: a identidade administrativa que a 046 exige — usuário **sintético** com o e-mail
   declarado na própria 046, papel `REPRESENTANTE_AUTORIZADO`, `senha_hash` aleatório (não autentica).
5. `npm run check:v1:postgres`: uma suíte por processo; antes de cada uma, os bancos de trabalho
   (`kidmais_pacotes_v1_descartavel` e, se declarado, `kidmais_pacotes_v1_rollback`) são removidos e
   clonados do modelo declarado. Suíte que não termina em 15 min ou que deixa conexão aberta **falha**.

**Classes de teste.** Produto parte do estado **atual** (001→054 + 056 + 057; 055a–d ficam fora porque exigem
autorização — as suítes da 055 instalam e removem a 055 elas mesmas). Teste de migration declara o estado
histórico que testa e aplica/desfaz a própria migration. Declaração em `ESTADO_POSTGRES`
(`scripts/regressao-v1-selecao.cjs`); suíte sem declaração é recusada.

| Estado | Conteúdo | Suítes |
|---|---|---|
| `atual` | 001→054 + 056 + 057 | catálogo UX, hg4-escopo, rounds 4/5, supersessão 048, baixa, financeiro, 055, inteligência, gates-c2, estorno completo, Festa, migrations 056 e 057 (regra real de assinatura, down/reaplicação), hg8-catálogo/empresa/membership/provisionar/tenant; subtestes de produto da remediação |
| `053` | 001→053 | migration 054 (aplica a 054; alvo `KIDMAIS_054_*` dado pelo runner) |
| `052` | 001→052 | integridade 053 (instala a 053, roda o down oficial no fim) |
| `045-sem-040` | 001→045 sem a 040, sem identidade | hg6 (046 → depois a 040, como no histórico validado) |
| `042-sem-040` | 001→042 sem a 040 | hg8-estrutura (043 e o down com Foundation vazia) |
| `039` | 001→039 | remediação 036–042 (+ banco `atual` para os subtestes de serviço) |

**Suítes que falhavam e tratamento** (A: fixture sem o schema atual; B: migration precisando de estado
anterior; C: bloco duplicado no estado errado; D: defeito de produto — nenhum encontrado):

| Suíte | Classe | Tratamento |
|---|---|---|
| baixa, financeiro, round4, round5, supersessão 048, hg8-catálogo | A | fechamento com `empresa_id` do próprio pacote; cliente com a empresa dona (054) |
| hg4-escopo, hg8-catálogo, hg8-membership, hg8-provisionar, hg8-tenant | A | invariante pré-046 (“7 legados, sem Kidmais”) trocada pela linha de base canônica (`LINHA_DE_BASE_ATUAL`): conferida no início e intacta no fim |
| hg6-kidmais, hg8-estrutura | B | estados `045-sem-040` e `042-sem-040` |
| remediação de pacotes | B + A | migrations no `039`; subtestes de serviço (revisão, composição, publicação) no banco `atual`, com `try/catch` que desfaz a transação |
| integridade 053 | B + C | estado `052`; a leitura da empresa do fechamento pelo repositório (coluna da 054) foi para a suíte da 054 |
| runner da 053 | defeito do teste | conexões e fixtures dentro do `try`; fechamento em paralelo com cancelamento de consulta presa; limpeza só do que existe; a falha original não é mascarada |

**Inventário de produção (D4)** — `scripts/production/check-migrations.mjs`: lista explícita de 001 a 057,
agora com 026–028, 048–054 e 055a–d (sem a 020, que é de outro ramo). Checks exigidos por migration a partir da 013:
`_precheck`/`_postcheck`; exceções revisadas: 049–051 têm o precheck embutido (`DO … RAISE`) e nenhum check
externo; a 052 usa o sufixo `financeiro`; a 054 exige também o `backfill_imediato`; 055a–d têm o precheck
embutido e o `_postcheck` externo. `*_down.sql` nunca é migration: só o `999_crm_core_down` legado é
ignorado; qualquer outro arquivo (inclusive um rollback copiado para `migrations/`) bloqueia com
`MIGRATION_BASELINE_REVIEW_REQUIRED`. O inventário nunca afirma aplicação (`appliedState: unknown`) e marca
055a–d, 056 e 057 como `requiresExplicitAuthorization` / `055A_D_NOT_APPLIED_REQUIRE_EXPLICIT_AUTHORIZATION` /
`056_NOT_APPLIED_REQUIRES_EXPLICIT_AUTHORIZATION` / `057_NOT_APPLIED_REQUIRES_EXPLICIT_AUTHORIZATION`. A 056 e a 057
exigem os respectivos `_precheck.sql` e `_postcheck.sql`.

## 17. Festa, idempotência financeira e estorno completo (E1–E4)

**Modelo de acesso (decisão de produto, 056).** `usuarios_administrativos` é a **identidade global** (um
e-mail, uma identidade). Todo acesso a uma empresa é uma **membership** (`usuario + empresa`), que é a
autoridade: `memberships.papel` é o papel **naquela** empresa (`provarTenant` devolve `papelAtual` da
membership travada). Capacidades de Festa vivem em `festa_membership_capacidades` (membership + empresa, FK
composta, imutável: concede/revoga uma vez); `festa_usuario_capacidades` (global, 016) fica congelada por
trigger e só serve ao backfill. `festa_areas` ganha `empresa_id` (NOT NULL) e `estabelecimento_id` opcional
(FK composta com a empresa; a unidade só é aceita se for da empresa e é imutável); o nome é único por empresa.
Triggers da 056 recusam tarefa/pendência com área de outra empresa ou responsável sem membership ATIVA na
empresa da Festa.

**Administração de contas (`/api/admin/configuracoes/usuarios`, Festa → Acessos).** Tudo no Tenant Context da
empresa comprovada, com gestão = papel da membership: lista só as memberships não revogadas da empresa; criar
com e-mail existente só cria a membership desta empresa (sem duplicar nem alterar a identidade; membership
ATIVA existente é resposta idempotente; REVOGADA responde 409); e-mail novo cria identidade + membership ATIVA
na mesma transação; papel e capacidades mudam só a membership desta empresa; "Remover desta empresa" revoga a
membership desta empresa (e as concessões dela), sem tocar sessões, identidade nem outras empresas; a última
Gestão da empresa não sai. **Desativar a identidade é ação de PLATAFORMA**: a rota de tenant responde 403
`ACAO_DE_PLATAFORMA`.

**Festa com Tenant Context (E1).** `comandarFesta`, `consultarFestas`, capacidades/perfis e áreas seguem
sessão → `provarTenant` (papel da membership) → capacidade da membership → posse da Festa com `fe.empresa_id`
da empresa comprovada no WHERE → travas (contrato → festa) → ação → `revalidarTenant`, no mesmo tx. Outra
empresa e inexistente respondem o mesmo 404; o financeiro da Festa é lido no tx da prova; a lista de usuários
e o responsável de tarefa/pendência exigem membership ATIVA na empresa. Rotas de configuração comercial,
financeiro do contrato, assinatura e cancelamento usam o papel da membership (não o global).

**Rollback da 056.** O down recusa quando perderia informação: papel por empresa diferente do papel da
identidade, concessão/revogação feita por empresa depois da 056, nomes de área repetidos entre empresas ou
área com unidade. Sem isso, desfaz inteiro e a estrutura da Festa volta à assinatura da 016.

**Autoridade de plataforma (F1).** `usuarios_administrativos.papel` deixou de ser autoridade de empresa. Não existe
Platform Admin separado: a autoridade de plataforma é o papel legado da identidade (`REPRESENTANTE_AUTORIZADO`),
centralizada em `lib/autenticacao/plataforma.ts` e concedida só pelo provisionamento do operador
(`scripts/admin-provision.cjs`, terminal local). A criação por empresa grava a identidade com o papel neutro
(`ADMINISTRATIVO`) e o papel pedido só na membership; nenhuma rota de tenant escreve o papel global (teste de
arquitetura). Classificação das rotas que liam o papel global:

| Uso | Classe | Tratamento |
|---|---|---|
| Tabela PDF pública (`/configuracoes/tabela-pacotes`, POST) | A — documento único da instalação | `temAutoridadeDePlataforma` |
| WhatsApp/Meta (consulta, iniciar, concluir onboarding) | A — conexão única da instalação | `temAutoridadeDePlataforma` + reautenticação |
| Desativar identidade (`desativarUsuarioAdministrativo`) | A | não exposta a rota de tenant |
| IA: catálogo, Human Gate (iniciar, responder, confirmar, cancelar) | B | papel da membership comprovada |
| Assinatura em nome da empresa (aplicação e restrição diferida da 013, via 057) | B | Gestão + capability `CONTRATO_ASSINAR_EMPRESA` da membership |
| Fechamento administrativo, financeiro (devolução e demais ações), evento de Festa | B | papel da membership; sem ele, recusa |
| Upload/leitura/importação da IA (pré-checagem) | C | aceitam os dois papéis; não distinguem autoridade (teste de revalidação) |

**Anti-enumeração na criação por e-mail (F2).** Senha validada e hash calculado antes de saber se o e-mail existe;
e-mail novo, de outra empresa ou de identidade inativa recebem a mesma resposta (`associado`, `membershipId`,
e-mail informado, papel e situação desta membership, `reutilizado` só para membership já ativa NESTA empresa),
sem id, nome, situação ou vínculos da identidade. Identidade inativa ganha a membership, continua inativa e sem
acesso. A listagem de contas, os perfis de Festa e a escolha de responsável usam a situação da membership desta
empresa, não a da identidade (que só barra o login, na prova de tenant). Colisão concorrente do
mesmo e-mail responde a mensagem genérica de conflito.

**Assinatura em nome da empresa (057, Gate 12).** Autoridade EMPRESARIAL: tenant → membership ATIVA → Gestão nesta
empresa → capability `CONTRATO_ASSINAR_EMPRESA` (`empresa_membership_capacidades`, mesmo modelo da 056: FK composta
empresa + membership, concede/revoga uma vez) → contrato da empresa (fechamento e pacote dela, empresa ATIVA) →
assinatura. A aplicação confere no tx do tenant; o banco confere o mesmo no COMMIT
(`kidmais_057_pode_assinar_pela_empresa`), trocando na validação da 013 só a exigência do papel global — o corpo
da função é gerado do texto da 013 e o precheck recusa aplicar se a função em produção for diferente. O papel
global não assina e a capability não dá plataforma (tabela PDF, WhatsApp). Backfill determinístico: recebe a
capability quem já assinava por aquela empresa (Gestão ATIVA + papel global `REPRESENTANTE_AUTORIZADO`);
ninguém ganha nem perde na aplicação. Assinaturas existentes não são revalidadas (a validação é só do INSERT).
Gestão concede/retira em Festa → Acessos (a própria inclusive, para a empresa não ficar sem quem assine);
rebaixar para Equipe ou remover da empresa revoga. Down: recusa se houver concessão/revogação feita depois da
057; senão volta exatamente à 013. A decisão é tomada SOB `ACCESS EXCLUSIVE` na tabela de capability, na mesma
transação do rollback: concessão/revogação aberta faz o down esperar e, se confirmada, ser recusado; escrita que
chega depois da trava espera e falha com a tabela removida (corrida provada em PostgreSQL real, nas duas ordens).
O down da 056 recusa enquanto a 057 estiver aplicada.

**Resíduos conhecidos.** Membership REVOGADA é terminal (043/045): readmitir quem saiu exige decisão e
migration futuras.
Membros da empresa veem nome e e-mail uns dos outros (inclusive de conta já existente, depois de associada).
A pré-checagem de leitura da IA usa o papel da sessão, mas todas as leituras aceitam os dois papéis.
Scripts de integração fora dos gates (`scripts/festa-016-*.cjs`) ainda descrevem a 016.

**Idempotência de recebimento/estorno (E2).** A chave do cliente é gravada como
`v2:sha256(operação, empresa, pagamento, chave)` pela rota (que tem o tenant e o pagamento provados); as
consultas por chave e por referência exigem o pagamento provado no WHERE. Mesma chave em outra empresa ou
outro pagamento é outra chave; o oráculo "já utilizada em outro Pagamento" saiu. Chave legada (antes do
escopo) só é consultada dentro do mesmo pagamento. Referência de provedor externo mantém a unicidade global
provedor + referência (identificador real do PSP), com consulta escopada; colisão responde a mensagem
genérica de operação duplicada. Sem migration.

**Referência do PSP (F4).** Unicidade global provedor + referência mantida (identificador atribuído pelo
provedor). Consultas por referência escopadas ao pagamento provado; colisões respondem sempre a mesma mensagem
genérica (`OPERACAO_FINANCEIRA_DUPLICADA`) ou erro genérico, sem id, valor, pagamento ou empresa. A checagem
estorno × devolução (`validarEstornoComDevolucoes`), que respondia "já registrada como devolução" para
referência de QUALQUER empresa, passou à mesma resposta genérica. Resta um oráculo de existência (sim/não) para
quem já conhece uma referência do provedor: gate pré-produção, sem migration.

**`confirmarRecebimentoPagamento` (E3/F3).** Recebe o `pagamentoId` provado e o executor do tenant, obrigatório no
tipo (`ContextoPagamentoNoTenant`) e na execução (`exigirExecutorDoTenant`): sem ele recusa antes de qualquer
consulta e nunca abre transação própria. Trava o recebimento com o pagamento no WHERE; não é exposto por rota.

**Pré-produção (E4).** `lib/pagamentos/estorno-completo.postgres.test.ts` percorre pelas rotas reais
recebimento → estorno → auditoria/evento → replay → payload divergente → mesma chave em outra empresa →
cross-tenant → falha injetada (rollback), e o PDF revisado/persistido (bytes íntegros, zero consulta depois do
commit). `lib/festas/tenant-festa.postgres.test.ts` cria a Festa sobre a formalização da 019 (documento
revisado, edição CONCLUIDA, assinaturas KIDMAIS e CLIENTE). Ambas rodam numa transação externa não confirmada:
as validações **diferidas** de assinatura/formalização no COMMIT e o fluxo real de OTP continuam gate
pré-produção (staging).
