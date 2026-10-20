# Evidência — pacotes locais de concorrência e navegador (10/10/2026)

Autorização de Felipe: pacotes locais de concorrência e navegador para a candidata `23a203ac34c831cd8fe662503768f468aad9d5a2`, PostgreSQL descartável em 55480/55481 e servidor em `localhost:3481`; só dados sintéticos; sem banco real, Render ou serviços externos; parar os processos e **preservar** clusters e evidências (sem remover as pastas). Pacote 3, push e staging não autorizados.

## Pré-condições (as duas frentes)

`HEAD` = candidata; `git diff --name-only 6acdb60 HEAD` só `docs/`; árvore limpa; nenhum `.env*`; nenhuma `DATABASE_URL`/`PG*`/`ASSINATURA_*_DIAS` no ambiente; PostgreSQL 18.6 em `C:/Program Files/PostgreSQL/18/bin`; portas 55480, 55481 e 3481 livres; planos offline `confere: true` (79 migrations, impressão `8a9a97477eac…3cfb`); testes offline 18/18 (navegador).

## Concorrência (C1–C5; C6 não executado por decisão de Felipe)

| Passo | Resultado |
|---|---|
| C1 criar | `.local-concorrencia-pg-5611eee035c1436c8966306858497f3d` |
| C2 iniciar | `INICIADO`, `127.0.0.1:55480` |
| C3 conferir | `CONFERE`, versão 180006, `cluster_name kidmais_concorrencia`, bancos `[]` |
| C4 executor | **exit 2 — `INCOMPLETO`**: schema aplicado (79 migrations / 201 arquivos, impressão conferida), falha no grupo `a` antes de qualquer verificação: `ERR_OUT_OF_RANGE` (`readUIntBE` com 7 bytes; o máximo é 6) no gerador de documento sintético das fixtures |
| C4b conferir | `CONFERE`, só o banco `kidmais_concorrencia_vagas_20261010` |
| C5 parar | `PARADO` |

Parada pelo critério do pacote (S2). Nenhuma matriz foi avaliada; nada a concluir sobre concorrência. A pasta (cluster parado, `resultado.json`, `progresso.log`, logs do servidor) está preservada para revisão.

## Navegador (0, A1, A2; A3 e A4 não executados)

| Passo | Resultado |
|---|---|
| A1 criar/iniciar/conferir | `.local-navegador-pg-5d5bd5cb8ca44e97b0d91f0ee6152239`, `127.0.0.1:55481`, `CONFERE`, bancos `[]` |
| A2 seed | **exit 2 — `INCOMPLETO`** na etapa `fixtures`: mesmo `ERR_OUT_OF_RANGE` (gerador de documento sintético). Schema aplicado (79/201, impressão conferida). **Nenhuma credencial gravada** (`.local-navegador/` não existe) |
| conferir + parar | só o banco `kidmais_navegador_20261010`; `PARADO` |
| A3 servidor / A4 navegador | **não executados**: o `next dev` buscaria fontes em `fonts.googleapis.com` (`next/font/google`, exceção registrada no §7 do pacote), serviço externo não autorizado; e o seed não concluiu |

Pasta preservada (cluster parado, `seed-resultado.json`, `seed-progresso.log`, logs).

## Correção preparada (não executada; exige nova aprovação)

- Gerador de documento sintético com 6 bytes nos dois scripts (`scripts/concorrencia-vagas-isolado.cjs`, `scripts/navegador-local-seed.cjs`); testes de regressão.
- Fontes sem rede: `scripts/navegador-local-fontes-mock.cjs` (objeto literal com as 5 URLs exatas das fontes do app, CSS sem fonte remota) e `NEXT_FONT_GOOGLE_MOCKED_RESPONSES` na lista fechada de variáveis do servidor, exigida pela autoverificação. Teste confere as chaves contra `getFontAxes`/`getGoogleFontsUrl` do próprio Next. Comprovado localmente: `next build` com o mock compila e gera as 61 páginas (uma URL ausente falha com `url not found`, o que aconteceu com a primeira versão do mock — nenhuma chamada externa ocorreu).
- Para a nova execução: os clusters atuais têm banco parcial; o pacote exige cluster novo (sem bancos). Remover as pastas atuais depende de autorização (C6/limpeza) ou usar novas pastas, mantendo as atuais.

---

# Segunda execução — candidata `936ef67128d8ce9a85fc24cd262d8428606a73e5` (código `4337aa4`)

Autorização de Felipe: C1–C5 e A1–A4, clusters novos, sem chamadas externas (inclusive ViaCEP), sem banco real, Render, push ou deploy; sem C6; preservar clusters anteriores; encerrar processos.

Pré-condições: HEAD = candidata; só `docs/` após `4337aa4`; árvore limpa; sem `.env*`/`PG*`; portas livres; planos offline `confere: true` (79/201, `8a9a9747…3cfb`) e servidor `OK`; testes offline 46/46.

## Concorrência — PASS (`.local-concorrencia-pg-a9e159a1388d44f8b836804aa04626de`)

C1–C3 ok (bancos `[]`); **C4 exit 0, `resultado: PASS`** em 6 s; C4b só o banco da execução; C5 `PARADO`; C6 não executado.

| Grupo | Resultado |
|---|---|
| a | duas conexões na última vaga do Essencial (3): uma reserva, a outra `LIMITE_USUARIOS_PLANO` após a trava; rajada de 6 |
| b | aceite troca reserva por pessoa ativa sem aumentar a ocupação; aceite duplicado simultâneo não cria outro vínculo |
| c | convite cancelado/vencido libera a vaga; reenvio de vencido disputa vaga nova (duas ordens); reenvio válido não ocupa outra |
| d | falha após a reserva (criação e aceite) desfaz tudo por rollback |
| e | empresa acima da cota mantém vínculos e sessões, mas não convida |
| f | Profissional (10) com duas conexões na última vaga; Premium sem teto; isenta, teste e sem assinatura livres |
| g | duas conexões na 20ª vaga Fundador: uma reserva, a outra `FUNDADOR_AGUARDANDO`; teto 20 nunca excedido |
| h | liberação `RESERVADA → LIBERADA` só com contratação `CANCELADA` e cobrança comprovadamente removida; `CONFIRMADA` nunca volta |
| z | consistência final: contagens, vínculos únicos, nenhum acesso perdido, teto Fundador, postchecks 074a/075 |

## Navegador (`.local-navegador-pg-a7ebb11386c7402d989f6202af84ecff`)

- A1 ok; **A2 seed PASS** (6 empresas, 8 contas; conferência: Essencial 3/3, financeiro completo só fora do Essencial, expirada `BLOQUEADO`, cotação 404/200/200, oferta Fundador 11820, renovação Premium `PENDENTE` 59700 em 10/10/2027). Nenhuma senha no resultado (conferido: 0 ocorrências).
- A3: servidor em `127.0.0.1:3481`, Asaas `DESLIGADO(CHAVE_FORA_DO_SANDBOX)`, e-mail em arquivo, OTP console, fontes pelo mock local. **Recursos carregados só de `localhost:3481`** (conferido nas páginas administrativas e públicas). Campo de CEP não usado (sem ViaCEP).
- A4: checklist desktop (1062–1020 px) e celular (375×812). Credenciais sintéticas digitadas só em `localhost:3481`; duas sessões abertas por Felipe no próprio painel (N01 e N12).

| # | Desktop | Celular | Observação |
|---|---|---|---|
| N01 | PASS | PASS | painel sem seletor; menu móvel abre |
| N02 | PASS | PASS | “Credenciais inválidas.”; 1 tentativa errada por viewport, contas diferentes |
| N03 | PASS | PASS | “Escolha a empresa que deseja acessar.”; troca Profissional → Teste |
| N04 | **PARCIAL** | **PARCIAL** | API: Fundador ativo, 11820/20820/35820 (regulares 19700/34700/59700). Tela não mostra a oferta porque a cobrança está indisponível (`cobranca.disponivel=false`, Asaas desligado de propósito) — comportamento do produto; expectativa do pacote não considerava isso |
| N05 | PASS | PASS | “2 pessoa(s)… 1 convite(s)… 3 de 3 vagas ocupadas.”; sem oferta nem aviso |
| N06 | PASS | PASS | “Após o Fundador, a partir de 10/10/2027, o valor será R$ 597,00/mês. O aviso será enviado por e-mail 30 dias antes.”; “Sem limite de usuários.” |
| N07 | PASS | PASS | “Sem cobrança”; acesso completo; sem ação de assinar |
| N08 | PASS | PASS | só “Contas a receber” no menu; APIs 403 `RECURSO_FORA_DO_PLANO` |
| N09 | PASS | PASS | três páginas com a recusa do plano, sem dados |
| N10 | PASS | PASS (Profissional) | Profissional, Premium e isenta: quatro itens e APIs 200 |
| N11 | PASS | PASS | “O plano atingiu o limite de pessoas…”; nenhum e-mail gerado |
| N12 | PASS | PASS | Equipe; sem ações de Gestão |
| N13 | PASS | PASS | “Acesso suspenso até a assinatura… Nada foi apagado.” (texto difere do pacote); APIs 402 `ASSINATURA_NECESSARIA`; assinatura acessível |
| N14 | **FALHA** | idem | título, ícone neutro e nome corretos, sem logo; calendário com horários (16/10, 10:30/11:00/11:30). **Na etapa de pacote aparecem os pacotes da Kidmais** (Mini Festa Kidmais R$ 5.100, Festa Compacta/Essencial/Completa/Premium, Pizza Party Scienza) além do “Pocket sintético”, selecionáveis, com textos “da Kidmais” |
| N15 | dados PASS | PASS | Premium: título, ícone, nome; API com só o Pocket (a mesma tela de pacote é afetada pelo defeito do N14) |
| N16 | PASS | PASS | três 404 com o mesmo texto visível e título |
| N17 | PASS | PASS | sessão encerrada; API 401 |

### Defeito de produto encontrado (bloqueia a cotação por empresa em produção)

- `components/fechamento/FechamentoWizard.tsx` (≈ linha 1378) renderiza sempre `PACOTES_FECHAMENTO_V1` (`components/fechamento/data.ts`), o catálogo fixo da Kidmais, em qualquer `/b/<código>`. A API pública da empresa devolve só o pacote dela; o vazamento é da tela. As rodadas de staging conferiam a API, não a tela.
- ~~Contato da Kidmais sem guarda~~ — **revisado: incorreto.** Os usos de `CONTATO_KIDMAIS` já estavam atrás de `marca.kidmais` ou `!empresa`; o problema real era a empresa ficar sem contato próprio.
- **Corrigido no código `412654a`**; repetição de N14–N16 em [pacote próprio](../NAVEGADOR_LOCAL_N14_N16_20261010.md), aguardando aprovação.

## Encerramento

Servidor parado (tarefa encerrada); cluster de navegador `PARADO`; portas 55480, 55481 e 3481 livres. Preservados: `.local-concorrencia-pg-5611…`, `.local-concorrencia-pg-a9e1…`, `.local-navegador-pg-5d5b…`, `.local-navegador-pg-a7eb…` e `.local-navegador/` (credenciais sintéticas e e-mails locais; nenhum e-mail gerado). Nenhuma remoção (C6) feita.

---

# Terceira execução — repetição N14–N16, candidata `121d49c918b164b1f18fb784a6924504a2622f86` (código `412654a`)

Autorização de Felipe: B0–B5 do [pacote N14–N16](../NAVEGADOR_LOCAL_N14_N16_20261010.md); pastas anteriores preservadas; banco local sintético novo; desktop e celular; sem chamadas externas, envio de pedido, banco real, Render, push ou deploy.

Pré-condições: HEAD = candidata; só `docs/` após `412654a`; árvore limpa; sem `.env*`/`PG*`; portas 55481/3481 livres; testes offline 21/21 (seed/servidor) e 14/14 (tela/marca); planos `confere: true` (`8a9a9747…3cfb`) e servidor `OK`.

| Passo | Resultado |
|---|---|
| B0 | `.local-navegador/` → `.local-navegador-execucao-936ef67/` (renomeada, ignorada pelo Git, conteúdo intacto) |
| B1 | `.local-navegador-pg-52f7eaa3874c4104871fe7b949daa2c3`, `INICIADO` em `127.0.0.1:55481`, `CONFERE`, bancos `[]` (a primeira tentativa de `criar` foi recusada antes de agir por falta de `KIDMAIS_PG_BIN`) |
| B2 | seed `PASS` em `kidmais_navegador_n14_20261010` (79/201, impressão conferida); conferência anterior + `contatoPublico`: `nav-profissional` [whatsapp, email, site], `nav-premium` `null`; nenhuma senha na saída |
| B3 | servidor `127.0.0.1:3481`, Asaas `DESLIGADO(CHAVE_FORA_DO_SANDBOX)`, fontes pelo mock local |
| B4 | checklist abaixo, sem sessão (nenhuma credencial digitada) |
| B5 | servidor parado (porta 3481 livre); `parar` sem a flag foi recusado sem efeito e repetido com `--parar-autorizado` → `PARADO`; 55481 livre; `next-env.d.ts` regenerado pelo `next dev` restaurado |

| # | Desktop (1018 px) | Celular (375×812) | Observação |
|---|---|---|---|
| N14a | PASS | PASS | um único cartão “Pocket sintético · A partir de R$ 1.500,00 · Descrição não cadastrada.”, sem selo/horário; nenhuma ocorrência de Kidmais, Scienza, Mini Festa, Festa Compacta/Essencial/Completa/Premium, Pizza Party, “Mais escolhida”, R$ 5.100/6.490, (61) 99340-5359, “Segunda a quinta” |
| N14b | PASS | PASS | Mínimo 20, Limite 30, “Composição não cadastrada.”, “Duração não cadastrada.”, sem observação/sob consulta. Com data pré-escolhida a etapa seguinte é Convidados (o calendário fica na tela de disponibilidade, N14e) |
| N14c | PASS | PASS | 31 → “Pocket sintético atende até 30 convidados neste pacote.” (e a cotação do servidor recusa); 19 → “possui mínimo de 20 pagantes.”; sem “Kidmais”/150 |
| N14d | PASS | PASS | rodapé: “Buffet Sintético Profissional (TESTE navegador) · WhatsApp (11) 90000-0001 · E-mail · Site”, links `wa.me/5511900000001`, `mailto:`, `https://profissional.example.invalid/`; sem contato da Kidmais; no celular sem rolagem horizontal |
| N14e | PASS | PASS | disponibilidade: título “Orçamento da festa”, ícone `/icone-orcamento.svg`, nome da empresa, sem logo; 16/10 com 10:30/11:00/11:30 |
| N15 | PASS | PASS | Premium: mesmo pacote e regras; **nenhum link de contato** e sem rodapé de contato; sem Kidmais |
| N16 | PASS | PASS | as três: 404, texto “Página não encontrada · Este endereço não existe ou não está disponível para a sua conta.”, título inicial “Página não encontrada — Kidmais Manager” e final “Orçamento da festa” — idênticos entre si |

Recursos carregados só de `localhost:3481` em todas as páginas. Requisições ao servidor: só leituras (`/api/disponibilidade`, `/api/fechamentos/pacotes|catalogo|adicionais`) e `POST /api/fechamentos/cotacao` (cálculo, sem gravação); nenhum envio de pedido; 0 e-mails gerados.

Observação fora do escopo do defeito: a página 404 mostra a marca da plataforma (“Kidmais Manager”), igual nas três URLs e igual à execução anterior; não revela empresa nem plano.

Encerramento: servidor e cluster parados; portas livres. Preservados: `.local-concorrencia-pg-5611…`, `.local-concorrencia-pg-a9e1…`, `.local-navegador-pg-5d5b…`, `.local-navegador-pg-a7eb…`, `.local-navegador-pg-52f7…` (com `seed-n14-console.txt` e `servidor-n14.log`), `.local-navegador-execucao-936ef67/` e a nova `.local-navegador/`. Nenhuma remoção (C6).
