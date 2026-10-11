# Evidência — disponibilidade do pacote por empresa, homologação local (11/10/2026)

Pacote: [HOMOLOGACAO_DISPONIBILIDADE_EMPRESA_20261010.md](../HOMOLOGACAO_DISPONIBILIDADE_EMPRESA_20261010.md). Candidata autorizada:
`7bca9037138cf120a9f683ade4452bf187b0bd6d` (código `5ba3534`). Autorização de Felipe: B0–B6, cluster local novo, dados sintéticos,
navegação pelos botões da interface; sem chamadas externas, envio de pedidos, operações remotas, push ou deploy; registrar falha de
botão sem contornar a navegação.

**Resultado: PASS — V1–V7 aprovados em desktop e celular, com uma falha intermitente registrada (V1, 1ª tentativa).**

## Pré-condições
HEAD `7bca903`; só `docs/` depois de `5ba3534`; árvore limpa; sem `.env*`, `DATABASE_URL`, `PG*`; portas 55481/3481 livres; plano
`confere: true`. `KIDMAIS_HOMOLOGACAO_DATABASE_URL` (valor não lido) removida do ambiente de todos os comandos.

## Passos
| Passo | Resultado |
|---|---|
| B0 | `.local-navegador` → `.local-navegador-execucao-be1b612` (1 arquivo, intacto) |
| B1 | cluster novo `.local-navegador-pg-958100e0f89e4469830bc41379717788`: `CRIADO`, `INICIADO` (127.0.0.1:55481), `CONFERE`, bancos `[]` |
| B2 | seed `PASS` em `kidmais_navegador_disponibilidade_20261010`; schema até a 078 (impressão `ba47d7bf…22c1`); `diasPocket`: Profissional `[1..7]`, Premium `[1..5]`; legado 7/62; nenhuma senha/CPF no console |
| B3 | `127.0.0.1:3481`, Asaas `DESLIGADO(CHAVE_FORA_DO_SANDBOX)`, `consultaCepExterna: false` |
| B4 | checklist abaixo — navegador embutido; desktop 1280×800 e celular 375×812 (emulados) |
| B5 | pós-conferência `--catalogo` `CONFERE`, `vinculosEntreEmpresas: 0` (kidmais 7/62, premium 2/4, profissional 2/5, essencial 0/0) |
| B6 | servidor encerrado (árvore do lançador), cluster `PARADO`, portas livres, `next-env.d.ts` restaurado, aba fechada; 17 pastas `.local-*` preservadas |

Caminho de todos os itens de tela: endereço inicial de **disponibilidade** aberto na barra → mês/dia/período/horário por clique →
botão “Continuar para escolher o pacote” → “Selecionar” → “Continuar”. Nenhum endereço de `/fechamento?…` foi digitado; nenhuma
navegação por script (JavaScript só leu texto). Retornos para a disponibilidade só pelo link “Alterar data ou horário”.

## Checklist
| # | Resultado | D | C |
|---|---|---|---|
| V1 | Profissional, **sáb 14/11 almoço**: Pocket avança para Convidados, sem aviso; Valor = cotação do servidor **R$ 1.500,00** (celular sem rolagem horizontal) | PASS (2ª tentativa — ver falha) | PASS |
| V2 | Profissional, **dom 15/11 noite**: avança para Convidados (dia ISO 7) | PASS | — |
| V3 | Premium, **sáb 14/11 almoço**: fica na etapa Pacote com “Este pacote não está disponível neste dia e período, conforme a configuração do buffet.”; nenhuma menção à Kidmais na página | PASS | PASS |
| V4 | Premium, **qua 18/11 almoço**: avança até Valor **R$ 2.300,00** | PASS | — |
| V5 | Legado `/disponibilidade` → `/fechamento`: Kidmais Pocket sáb almoço recusado (“Este pacote não está disponível para a data e período escolhidos.”, regra legada); Festa Compacta sáb noite “A Festa Compacta não está disponível aos sábados no segundo período.”; Kidmais Pocket qua almoço avança para Convidados | PASS | PASS |
| V6 | APIs: Profissional 14 regras (dias 1–7, `DISPONIVEL`); Premium 10 (dias 1–5, almoço e noite); sem empresa: 7 pacotes, nenhum com `disponibilidade` | PASS | — |
| V7 | A partir do V3, “Alterar data ou horário” leva a `/b/nav-premium/disponibilidade` (cabeçalho do Premium, não da Kidmais); qua 18/11 → Pocket → Convidados | PASS | PASS |

Envio de pedido: **nenhum** — log do servidor: `POST /api/fechamentos` 0×; `POST /api/fechamentos/cotacao` 3× (V4, V1 desktop, V1
celular). Chamadas externas no log (ViaCEP, fontes, Asaas): 0.

## Falha registrada — botão “Continuar para escolher o pacote” (V1, 1ª tentativa, desktop)

- Em `/b/nav-profissional/disponibilidade`, com sábado 14/11 11:00–15:00 selecionado, o clique no botão **não levou à etapa Pacote**:
  a página permaneceu em `/disponibilidade` por mais de 24 s, com o indicador do `next dev` “Rendering…”.
- O clique chegou ao aplicativo: o servidor registrou `GET /b/nav-profissional/fechamento?origem=DISPONIBILIDADE&data=2026-11-14…`
  `200` e a requisição RSC do navegador terminou `200 OK`; nenhum erro no console; documento `visible` e com foco.
- **Não contornado**: o endereço não foi aberto diretamente. Os itens seguintes seguiram pelo mesmo botão: legado (V5) e Premium
  (V3/V4/V7) avançaram normalmente; **a 2ª tentativa do V1, pelo mesmo caminho, avançou** e o item passou. Todas as demais transições
  desta execução, em desktop e celular, avançaram.
- Na execução anterior (`be1b612`), o mesmo botão também não avançou na 1ª ida a `/b/nav-profissional/fechamento` — lá o endereço foi
  aberto diretamente (antes desta regra).
- Leitura: falha **intermitente na primeira transição para a rota dinâmica `/b/[empresa]/fechamento` após o servidor de
  desenvolvimento subir** (compilação sob demanda do `next dev`; a primeira carga da disponibilidade levou 23 s). Não reproduzida
  depois de compilada. **Não comprovado** se ocorre com `next build`/`next start`: verificar em staging (pacote próprio) antes de
  descartar. Classificação: pendência a observar, não bloqueante para esta correção (o resultado do V1 foi obtido pelo botão).
- Observação do ambiente: com o painel do navegador oculto, o primeiro clique logo após carregar uma página às vezes não é aplicado
  (ex.: “Próximo mês”); repetido sobre a posição visível do botão, funcionou. Interação do agente, não do aplicativo.

## Limitação (do pacote, confirmada)
O calendário interno do assistente não aparece no fluxo público (a etapa de data é pulada com a data pré-selecionada); o calendário
público de disponibilidade não considera o pacote — no Premium o sábado aparece disponível e a recusa vem na etapa Pacote (V3), com o
caminho de volta do V7.
