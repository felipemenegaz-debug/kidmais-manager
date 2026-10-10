# Homologação local das etapas Buffet → Conclusão e do fluxo legado da Kidmais (10/10/2026)

**Status: PRONTO PARA APROVAÇÃO, NÃO EXECUTADO.** Nenhum cluster, banco, servidor ou navegador foi iniciado na preparação. Nada em
staging, produção, Render, Asaas, e-mail real, WhatsApp, ViaCEP ou banco real (`kidmais_manager`). Sem push nem deploy.

- **Código: `72b86598c964cc31bac834f4dd58fca63eac456f`**. Este pacote está no commit seguinte, que altera só `docs/`; o SHA desse commit é o da aprovação.
  `git diff --name-only 72b86598c964cc31bac834f4dd58fca63eac456f HEAD` deve listar só `docs/`. Qualquer outra diferença: parar.
- Base: candidata anterior `27d9a11` (N14–N16 PASS). Branch local `claude/kidmais-manager-sales-site-9b9a2d`, não enviada.
- Procedimento, guardas e lista de variáveis do servidor: [pacote do navegador](NAVEGADOR_LOCAL_20261010.md) §2–§7, com as mudanças de §2 abaixo.

## 1. Correções de produto nesta candidata

| Etapa | Antes | Agora |
|---|---|---|
| 3 Buffet | Campos livres “Lembrancinha/Empratado/Bombom” apareciam para qualquer empresa cujo pacote usasse os códigos `mini/completa/premium` (regra do cardápio da Kidmais) | Só no endereço da Kidmais (`marca.kidmais`) |
| 4 Personalização | “A Festa Premium inclui 4 bombons…” para qualquer empresa com o código `premium`; tabela fixa de tamanho de mesas (“Pequena: até 50…”) com qualquer adicional MESA; falha de preço dizia “Fale com a equipe Kidmais.” | Os dois textos só na Kidmais; a mensagem usa a redação da marca (“equipe do buffet” nos demais) |
| 2 Convidados | Tela por empresa aceitava até 500 (sem máximo cadastrado) e qualquer valor ≤ máximo do pacote; o servidor recusa acima de 150 para todas as empresas → “Dados inválidos” no envio | Mesmo teto do servidor (`LIMITE_CONVIDADOS_PEDIDO_ONLINE` = 150, conferido contra `comercial-schema`), mensagem neutra “O pedido online aceita até 150 convidados. Para mais, fale com o buffet.” A regra do servidor não mudou (decisão comercial pendente, §8) |
| 6 Seus dados | O CEP com 8 dígitos sempre chamava o ViaCEP pelo servidor | Inalterado por padrão. `CONSULTA_CEP_EXTERNA=desligada` faz a rota responder “serviço indisponível” **antes** da chamada externa; a tela já aceita o endereço manual nesse caso. Só o servidor local usa a chave |

Fluxo legado (`/fechamento`, marca Kidmais): nenhum texto, regra ou contato mudou; os testes comparam com o comportamento anterior.

## 2. Ferramentas locais (seed e servidor)

**Seed** (`scripts/navegador-local-seed.cjs`), só pelos serviços de domínio, num banco descartável novo:

| Empresa | Pocket | Buffet (categorias globais, escolhas) | Adicional (preço) | Regras de pagamento | Contato |
|---|---|---|---|---|---|
| `nav-profissional` | R$ 1.500,00 (20–30) | Salgados 3, Doces 2 | “Painel sintético Profissional” R$ 250,00 | PIX 5% / 2%, “Cartão Profissional”, sem −15% | (11) 90000-0001, e-mail, site |
| `nav-premium` | R$ 2.300,00 (20–30) | Massa do bolo 1 | “Pula-pula sintético Premium” R$ 400,00 | neutras (0%/0%, “Cartão de crédito”) | nenhum |
| `kidmais` (legado) | empresa e 7 pacotes **criados pela migration 046** (o seed nunca a insere) | composição da 022 | 3 adicionais da empresa com preço (R$ 120/180/240) | 077 (10%/3%, Cielo, −15%) | `CONTATO_KIDMAIS` fixo |

Kidmais: preços sintéticos publicados para os 6 pacotes sem Pizza Party (R$ 4.000 + R$ 500 por posição, mínimo do pacote até 150; uma
tabela sucessora por transação, regra 048). Pizza Party continua “sob consulta” (não avança no fluxo online).

A conferência do seed passa a exigir, pelos mesmos serviços do servidor: preço, composição, adicionais e regras **diferentes** entre
Profissional e Premium; 6 pacotes da `kidmais` com preço. Clientes sintéticos A e B (CPF com dígitos válidos gerado por execução,
`@example.invalid`, WhatsApp `11 90000-01xx`, CEP 01001-000 digitado) vão **só** para `.local-navegador/credenciais.json` (ignorado
pelo Git); nunca são impressos nem repetidos no chat.

**Servidor** (`scripts/navegador-local-servidor.cjs`): lista fechada com dois nomes novos (45 explícitas):
- `AGENDA_PUBLICA_EMPRESA_ID` = id da `kidmais` **lido em transação somente leitura** do banco descartável antes de montar o ambiente
  (UUID conferido; `AGENDA_PUBLICA_UNIDADE_ID` continua recusado);
- `CONSULTA_CEP_EXTERNA=desligada`, exigida pela autoverificação e conferida pelo código real (`consultaCepExternaLigada` = false).

## 3. Efeitos de cada envio de pedido (definidos antes da execução)

Envio = botão “Enviar para conferência” na etapa Pagamento, **somente no desktop**, **um por endereço** (3 no total): Profissional
(cliente A), Premium (cliente A, mesmo CPF), legado Kidmais (cliente B). No celular a navegação para no Resumo (sem envio).

Grava, numa única transação, no banco descartável `kidmais_navegador_etapas_20261010` (e em nenhum outro lugar):

| Tabela | O que | Reversível? |
|---|---|---|
| `clientes` | novo cliente na empresa do endereço (`empresa_id` = empresa do pacote; o corpo do pedido não escolhe empresa). No Premium, o CPF já usado no Profissional **não** é revelado: a consulta responde cliente novo e, com a 076 (CPF único por empresa), o servidor cria outro cliente na empresa Premium com o mesmo CPF, sem vínculo com o do Profissional (antes da 076 nasceria sem CPF) | não (só INATIVO) |
| `aniversariantes`, `possiveis_duplicidades_cliente`, `eventos_historico_cliente`, `auditoria` | aniversariante, verificação de duplicidade, histórico e auditoria com IP/agente | não (append-only) |
| `fechamentos` | pedido `origem_fechamento='CLIENTE'`, status `AGUARDANDO_CONTRATO` (PIX à vista, valor de tabela) ou `AGUARDANDO_APROVACAO` (PIX parcelado/valor diferente); protocolo `KM-…` | só por status (revisão comercial/cancelamento) |
| `fechamento_adicionais`, `fechamento_pacote_snapshots`, `_composicao`, `_itens_especificos`, `fechamento_buffet_snapshots/escolhas` | adicionais, retrato imutável do pacote e escolhas do buffet | não (gatilhos de imutabilidade) |
| `aprovacoes_negociacao` | só se a revisão comercial for necessária | — |

**Não acontece:** reserva ou bloqueio de data (a agenda só ocupa com festa `CONFIRMADO`/contrato formalizado); e-mail, WhatsApp, Gupshup,
Resend ou qualquer integração (não há outbox no envio; `EMAIL_PROVIDER=arquivo`, OTP `console`); chamada ao ViaCEP; cobrança Asaas
(desligado). Escolher **PIX à vista** em todos os envios (status `AGUARDANDO_CONTRATO`, sem revisão comercial).

Remoção: somente apagando o cluster inteiro (C6, autorização própria). Nenhum serviço apaga pedido ou cliente.

## 4. Pré-condições e pastas

0. **Leitura:** `HEAD` = SHA aprovado; só `docs/` depois de `72b86598c964cc31bac834f4dd58fca63eac456f`; árvore limpa; nenhum `.env*`; nenhuma `DATABASE_URL`/`PG*`/
   `ASSINATURA_*_DIAS`; portas 55481 e 3481 livres. Offline: `node --test scripts/navegador-local-seed.test.cjs scripts/navegador-local-servidor.test.cjs`
   (15 + 9), `node scripts/navegador-local-seed.cjs --plano` (`confere: true`), `node scripts/navegador-local-servidor.cjs --plano` (`OK`,
   `consultaCepExterna: false`), `node --experimental-strip-types --test components/fechamento/pacotes-tela.test.ts lib/fechamentos/marca-publica.test.ts`.
1. **E0 — renomear** a pasta das credenciais da execução N14–N16: `Rename-Item .local-navegador .local-navegador-execucao-121d49c`
   (não apagar; continua ignorada). Clusters e pastas anteriores intocados; C6 não autorizado.

## 5. Passos (cada um exige aprovação; PowerShell na raiz)

| Passo | Comando | Esperado |
|---|---|---|
| E1 cluster | `$env:KIDMAIS_PG_BIN='C:/Program Files/PostgreSQL/18/bin'`; `node scripts/cluster-descartavel-postgres.cjs criar --cluster kidmais_navegador --criar-autorizado`; `iniciar --pasta <pasta> --iniciar-autorizado`; `conferir --pasta <pasta>` | pasta nova, `INICIADO`, `CONFERE`, bancos `[]` |
| E2 seed | `$env:KIDMAIS_NAVEGADOR_AUTORIZACAO='127.0.0.1:55481/kidmais_navegador_etapas_20261010'; node scripts/navegador-local-seed.cjs --seed-navegador-autorizado` | `PASS`; conferência com `isolamento` (Profissional ≠ Premium) e `legado.pacotesComPreco = 6`; nenhuma senha/CPF no console |
| E3 servidor | mesma variável; `node scripts/navegador-local-servidor.cjs --iniciar-autorizado` | `INICIANDO`, Asaas `DESLIGADO(CHAVE_FORA_DO_SANDBOX)`, `consultaCepExterna: false`, fontes locais |
| E4 navegador | painel em `http://localhost:3481`, **sem sessão**; checklist §6 em desktop e celular (375×812) | — |
| E5 pós-conferência (leitura) | `conferir --pasta <pasta> --banco kidmais_navegador_etapas_20261010`; mesma variável de autorização; `node scripts/navegador-local-posconferencia.cjs` (`BEGIN READ ONLY`, só contagens e status) | `resultado: CONFERE` (§7) |
| E6 encerrar | parar o servidor; `node scripts/cluster-descartavel-postgres.cjs parar --pasta <pasta> --parar-autorizado`; `git checkout -- next-env.d.ts` se o `next dev` o regenerar | portas livres; pastas preservadas |

## 6. Checklist (D = desktop 1018 px; C = celular 375×812)

Em todas as páginas: recursos só de `localhost:3481`; sem rolagem horizontal no celular. Dados digitados vêm de `clientesSinteticos`
do arquivo de credenciais, só em `localhost`.

**Profissional — `/b/nav-profissional/disponibilidade` → `/fechamento`**

| # | Etapa | Esperado | D | C |
|---|---|---|---|---|
| E-P1 | Pacote | só “Pocket sintético · A partir de R$ 1.500,00” | ✓ | ✓ |
| E-P2 | Convidados | 25 aceito; 31 → limite do pacote; nada de “Kidmais”/150 | ✓ | ✓ |
| E-P3 | Buffet | só Salgados (escolher 3) e Doces (2); **sem** Massa do bolo, sem campos Lembrancinha/Empratado/Bombom | ✓ | ✓ |
| E-P4 | Personalização | só “Painel sintético Profissional” R$ 250,00; **sem** “Pula-pula”, sem tabela de mesas, sem adicionais da Kidmais; escolher o painel | ✓ | ✓ |
| E-P5 | Valor | preço do servidor (R$ 1.500,00 + R$ 250,00); PIX à vista 5%, parcelado 2%; cartão “Cartão Profissional”; **sem** Cielo e sem −15% | ✓ | ✓ |
| E-P6 | Seus dados | CPF do cliente A → cliente novo (sem código); CEP digitado → aviso para preencher manualmente; preencher endereço | ✓ | ✓ |
| E-P7 | Resumo | todos os dados acima; nenhum dado de outra empresa; rodapé com o contato do Profissional | ✓ | ✓ (para aqui) |
| E-P8 | Pagamento + envio | PIX à vista; **enviar** (§3) → tela de conclusão com protocolo `KM-…`, “Fale com Buffet Sintético Profissional” e contatos dele; **sem** botão/WhatsApp da Kidmais | ✓ | — |

**Premium — `/b/nav-premium/…`**

| # | Etapa | Esperado | D | C |
|---|---|---|---|---|
| E-R1 | Pacote/Convidados | só “Pocket sintético · A partir de R$ 2.300,00”; 25 aceito | ✓ | ✓ |
| E-R2 | Buffet | só Massa do bolo (1); **sem** Salgados/Doces | ✓ | ✓ |
| E-R3 | Personalização | só “Pula-pula sintético Premium” R$ 400,00; **sem** “Painel … Profissional” | ✓ | ✓ |
| E-R4 | Valor | R$ 2.300,00 + adicional; regras neutras: sem desconto PIX (“Sem desconto automático”), “Cartão de crédito”; sem Cielo/−15% | ✓ | ✓ |
| E-R5 | Seus dados | **o mesmo CPF do cliente A** → tratado como cliente novo, sem revelar nome/contato do Profissional | ✓ | ✓ |
| E-R6 | Resumo / envio | sem contato (Premium não tem); enviar no desktop → protocolo; conclusão sem contato de nenhuma empresa | ✓ | Resumo |

**Legado Kidmais — `/disponibilidade` → `/fechamento`**

| # | Etapa | Esperado | D | C |
|---|---|---|---|---|
| E-K1 | Marca | logo Kidmais, rodapé “Kidmais • (61) 99340-5359 · www.kidmaisfestas.com”, PDF dos pacotes | ✓ | ✓ |
| E-K2 | Pacote | os 7 cartões do catálogo com selos e horários; preços “A partir de” da tabela publicada (R$ 4.000…6.500); **sem** “Pocket sintético”; Pizza Party sob consulta não avança | ✓ | ✓ |
| E-K3 | Buffet/Personalização | composição da 022 do pacote escolhido; campos Lembrancinha/Empratado/Bombom conforme o pacote; adicionais da Kidmais com preço; sem itens/adicionais do Profissional/Premium | ✓ | ✓ |
| E-K4 | Valor | regras legadas: PIX 10%/3%, “Cartão é processado pela Cielo”, −15% em dia útil quando aplicável | ✓ | ✓ |
| E-K5 | Seus dados/Resumo/envio | CPF do cliente B → novo; enviar no desktop → protocolo; conclusão com “Falar com a Kidmais no WhatsApp” | ✓ | Resumo |

**Isolamento pelas APIs (desktop, leitura, sem sessão)** — no console da página, só `GET`:

| # | Chamada | Esperado |
|---|---|---|
| E-I1 | `/api/fechamentos/pacotes?empresa=nav-profissional` / `nav-premium` / sem `empresa` | só o Pocket de cada uma (1.500 / 2.300); legado = 7 pacotes da Kidmais, nenhum “sintético” |
| E-I2 | `/api/fechamentos/catalogo?pacote=POCKET&empresa=nav-premium` | só Massa do bolo |
| E-I3 | `/api/fechamentos/pacotes?empresa=nav-essencial` e `?empresa=nav-inexistente` | 404 iguais |

Critério de parada: qualquer pacote, preço, item, adicional, regra, contato ou cliente de outra empresa num endereço; recurso fora de
`localhost:3481`; seed ≠ `PASS`; envio com status ≠ previsto; qualquer diferença de SHA. Parar, encerrar processos e reportar.

## 7. Pós-conferência (somente leitura, E5)

`BEGIN READ ONLY` no banco da execução: por empresa (`nav-profissional`, `nav-premium`, `kidmais`) exatamente 1 `fechamentos` com
`origem_fechamento='CLIENTE'` e status `AGUARDANDO_CONTRATO`; 1 cliente novo por empresa; o CPF do cliente A em dois registros distintos (Profissional e
Premium, `empresa_id` diferentes), sem referência cruzada; nenhum pedido em `nav-essencial`; nenhuma festa `CONFIRMADO`; `.local-navegador/emails` vazio. Log do servidor: só
`POST /api/fechamentos` (3×) e `/api/fechamentos/cotacao` como escrita/cálculo; nenhuma chamada a `viacep.com.br`.

## 8. Falhas preexistentes de `scripts/` — revisão e classificação

Todas falhavam igualmente em `8586a53` (conferido antes). Nenhuma indica regressão de produto; nenhuma bloqueia a liberação. As
cinco de navegador/serviço foram **atualizadas nesta candidata e passam**; as duas ferramentas manuais de banco não são testes de CI.

| Teste | Causa | Classificação | Ação |
|---|---|---|---|
| `credito-natural.service` | fixture sem `contrato`/`pagamento`, exigidos pela guarda de cancelamento de `simularPosicao` (`3912ac2`, 20/09) | teste desatualizado; produto correto | fixture completada → PASS |
| `credito-projetado-ui` (+ `financeiro-acabamento-ui.cjs`) | fixtures sem `cobranca` (`3912ac2`) e sem `contexto` de empresa (056); `contratoId` não-UUID (`178c1de`); abas do contrato (`6f354e7`); versão em preparação `RASCUNHO` em vez de `ATIVA` (`ebbb226`); mock de fontes sem `@font-face` no modo webpack | teste desatualizado | atualizado → PASS. Também deixa de copiar as pastas `.local-*` para `.tmp/` |
| `festa-navegacao-ui` | `playwright` fora de `node_modules` | ambiente | com `PLAYWRIGHT_MODULE` local → PASS (sem mudança) |
| `lixeira-interacao` | mock sem `contexto` (056), logo do perfil e contratos importados (`727325d`) | teste desatualizado | mock completado → PASS |
| `ux-contratos-perfil` | atalho do CRM agora `/clientes?acao=fechamento` (`6647e0d`); agenda administrativa com `dias` (`8fa23d5`); reautenticação com renovação de sessão (`5b1aaaa`); leitura do Pix da empresa (`6ec2c0b`); dia 15 fixo do mês seguinte | teste desatualizado | atualizado (quarta-feira a partir do dia 15) → PASS |
| `festa-016-reparo-encoding` | exige `.local-festa/environments.json` e `DATABASE_URL` de clone registrado | ferramenta manual de banco | não executar fora do clone; para antes de conectar |
| `festa-navegacao-manual` | exige `--festa-id` e `DATABASE_URL` de clone manual | ferramenta manual de banco | idem |

Rodar os testes de navegador **em série** (`node --test --test-concurrency=1 …`): em paralelo, vários `next dev` compilando ao mesmo tempo estouram o tempo de `page.goto` (visto uma vez em `ux-contratos-perfil`; em série, 5/5). Os testes de navegador também precisam de `PLAYWRIGHT_MODULE` (hoje o Playwright 1.62.1 do runtime local) e de
`NEXT_FONT_GOOGLE_MOCKED_RESPONSES` apontando para o mock: sem o mock, o `next dev` desses testes busca fontes no Google.

## 9. Validação local (código `72b86598c964cc31bac834f4dd58fca63eac456f`)

| Verificação | Resultado |
|---|---|
| Testes unitários sem banco (`check:v1:static`) | 2259/2259 (antes 2256; +3 em `pacotes-tela.test.ts`) |
| Testes de `scripts/` (todos, menos as 2 ferramentas manuais de banco) | 274/275 no lote paralelo: a única falha foi `page.goto` com tempo esgotado em `ux-contratos-perfil` (vários `next dev` compilando juntos); os 5 testes atualizados em série: 5/5 |
| Seed, servidor e pós-conferência do navegador | 15 + 9 + 2 = 26/26 |
| Harness de staging (mocks) / verificação de produção | 103/103 / 37/37 |
| Planos offline (seed, concorrência) e servidor `--plano` | `confere: true` / `confere: true` / `OK` (`consultaCepExterna: false`) |
| TypeScript, worker de PDF, `next build` com fontes locais (61 páginas) | aprovados |
| ESLint | 0 erros (1 aviso preexistente) |
| `git diff --check` | limpo |

Nenhuma variável de banco no ambiente durante a validação (0). A seed nova **não** foi executada contra banco: ela roda no passo E2, com aprovação.

> **Execução de 10/10/2026:** E0–E6 concluídos, checklist PASS em desktop e celular, 3 envios, pós-conferência `CONFERE` —
> ver [evidência](evidencias/homologacao-cotacao-etapas-20261010.md). O catálogo global do buffet e o cliente existente com OTP
> foram registrados por Felipe como **pendências para produção** ([pacote consolidado](PACOTE_CONSOLIDADO_20261010.md)).

## 10. Riscos e decisões pendentes

- **Catálogo do buffet é global** (`buffet_categorias`/`buffet_itens` sem `empresa_id`, por desenho da 050): o isolamento é por pacote
  (cada empresa escolhe categorias), mas os **nomes dos itens** são compartilhados — item criado por uma empresa numa categoria aparece
  para todas que usam a categoria. Decisão de produto antes da produção multiempresa.
- **Teto de 150 convidados no servidor** vale para todas as empresas (`comercial-schema`). A tela agora o respeita; ampliar por empresa é
  decisão comercial.
- Código interno `CARTAO_CIELO` gravado como forma de pagamento para todas as empresas (o rótulo exibido é o da empresa); prefixo de
  protocolo `KM-` é da plataforma.
- O caminho de **cliente existente** (OTP) não fecha localmente: com `IDENTIDADE_OTP_PROVIDER=console` o código não é exibido. Coberto
  por testes de serviço; validar em staging com pacote próprio.
- Cópias deixadas pelo teste `credito-projetado-ui` em `.tmp/` (ignoradas pelo Git): a de 10/10 11:31 contém cópia das pastas `.local-*`
  da época; remoção depende de autorização.
