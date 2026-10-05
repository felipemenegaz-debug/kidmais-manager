# Validação da identificação do contato (nome e número) — PostgreSQL e navegador

**Situação:** EXECUTADA em 04/10/2026 (15:11–15:20) no HEAD `78ed9d8`, com autorização do Felipe para as duas rodadas; resultado ao final. Antes: preparada; as duas rodadas precisavam de autorização explícita do Felipe (docs/OPERACAO_AGENTES.md). Nada em staging, produção, Render ou Gupshup, nem no banco local real `kidmais_manager`. A demo (parada) e os diretórios protegidos não são tocados.

Contexto: [IDENTIFICACAO_CONTATO_ATENDIMENTO.md](IDENTIFICACAO_CONTATO_ATENDIMENTO.md). Numeração coordenada: **064** prontas e **065** nome de perfil; a 063 é do painel.

## Rodada 1 — PostgreSQL descartável

Scripts em `.local-ux/pg-identificacao/`, fora do Git; os hashes estão em `.local-ux/pg-identificacao/MANIFESTO.txt`. São os mesmos da rodada 063 (`.local-ux/pg-063/`), que já foi executada, com estas mudanças:
- diretório;
- marca **ASCII** `# Validacao identificacao 065 (descartavel)`, para evitar a armadilha de codificação do PS 5.1;
- suítes-alvo;
- protegidos.

| Item | Valor |
| --- | --- |
| Diretório de dados | `C:\Users\Glass\AppData\Local\Temp\kidmais-pg-identificacao\data` (precisa **não existir** antes de O1) |
| Endereço | `127.0.0.1:55500`, só loopback; autorização literal `KIDMAIS_DESCARTAVEL_PORTA=55500` e `KIDMAIS_DESCARTAVEL_AUTORIZACAO=127.0.0.1:55500/kidmais_pacotes_v1_descartavel` |
| Identidade exigida | `kidmais_descartavel\|127.0.0.1\|55500\|kidmais_descartavel\|postgres\|0\|C\|60\|<diretório>` |
| Protegidos no O4 | base da demo (`…-4b6271`), `kidmais-pg-demo-atendimento`, `kidmais-pg-063`, `kidmais-pg-060`, `D:\glass\KidMais Manager\ambientes-locais\pg-painel-multi-codex-20261004` (outra sessão) |

| # | Comando | O que roda |
| --- | --- | --- |
| O0 | `bash .local-ux/pg-identificacao/o0.sh` | Só leitura: porta, diretório, HEAD, árvore limpa, sem `PG*`/`DATABASE_URL` |
| O1 | `bash .local-ux/pg-identificacao/o1.sh` | `initdb` + marca + `pg_ctl start`; confere a identidade |
| O2a | `bash .local-ux/pg-identificacao/o2.sh alvo` | `migration-060`, **`migration-064`** (prontas, ex-063), **`migration-065`** (nome de perfil) e `encerrar-concorrencia` |
| O2b | `bash .local-ux/pg-identificacao/o2.sh completa` | Todas as suítes PostgreSQL |
| O4 | `powershell -NoProfile -ExecutionPolicy Bypass -File .local-ux\pg-identificacao\o4.ps1` | Para pelo próprio diretório e remove **só** o alvo; recusa link/junção no alvo, dentro dele e em ancestrais; recusa protegidos |

**O que a suíte 065 comprova:**

| Tema | Comprovação |
| --- | --- |
| Ausência da migration | Tela com número completo e cadastro, nome de perfil nulo e sem erro; o nome recebido é ignorado |
| Nomes antigos e novos | Saneado; replay antigo não sobrescreve; ausente não apaga; o mais novo vence |
| Ambiguidade | Dois clientes da empresa no mesmo número (com e sem 55): só a quantidade, nenhum nome |
| Isolamento | Cliente de outra empresa não conta; conversa de outra empresa e de outro ambiente não aparecem; usuário só de outra empresa e vínculo não ativo são **recusados** (fixtures obrigatórias) |
| Rollback | Recusado com nomes; com descarte remove só as colunas; a tela segue sem cache; reaplicável |

**Teste offline do O4** (`teste-o4.ps1`): 15/15, incluindo a pasta da rodada 063 como protegida.

## Rodada 2 — navegador (desktop, celular e teclado)

Scripts em `.local-ux/val-prontas/`, fora do Git; os hashes estão em `MANIFESTO.txt`. É o mesmo procedimento já executado nas rodadas `930121d` e `4b58b08`, com três mudanças:
- `preparar.mjs` aplica a **064** (e não a 065) e semeia os contatos 0106 e 0107 e as conversas de isolamento;
- nova ação **`aplicar-065`** (V2b) com `aplicar-065.mjs`;
- a conferência (V3c) mostra a presença da coluna 065 e as conversas por escopo.

| Item | Valor |
| --- | --- |
| Base | `C:\Users\Glass\AppData\Local\Temp\kidmais-val-prontas-20261004-ba6eac` (não existe) |
| Banco | `127.0.0.1:55502`, banco `kidmais_pacotes_v1_descartavel` |
| Tela | `http://localhost:3050`, sem HTTPS |
| Regras | Nenhuma conversa é assumida, então o campo de resposta e o "Enviar" ficam desabilitados, conferido antes de cada tecla; a V3c precisa dar `saidas_total = 0` |

**Dados sintéticos:**

| Contato | Cadastro | Perfil (depois da V2b) |
| --- | --- | --- |
| 0101 | 1 cliente | "Aninha 🎈", diferente do cadastro |
| 0102 | nenhum | "Perfil enviado antes da 065" (deve ser **ignorado**); depois "Bruna Perfil Nova" (novo), "Bruna Perfil Antiga" (replay antigo, **não** pode vencer) e um evento sem nome (não apaga) |
| 0103, 0104 | 1 cliente | — |
| 0105 | **2 clientes** (com e sem 55) | "Perfil do 0105" |
| 0106 | 1 cliente com **nome longo** (154 caracteres) | perfil de **80** caracteres, com acento e emoji |
| 0107 | nenhum | nenhum |
| `…0199` (empresa B) e `…0198` (A em `production`) | B tem cliente | "PERFIL DA OUTRA EMPRESA" e "PERFIL DE OUTRO AMBIENTE" — **nunca** podem aparecer |

**Operações:** V0 → V1 (`subir -Base …-ba6eac`) → V2 (`preparar`) → V3 (`iniciar`) → **V3c** (coluna ausente) → **V2b** (`aplicar-065`, com o Next rodando) → **V3c** → V4 (`encerrar`).

**Casos:**

| Caso | Quando | O que é conferido |
| --- | --- | --- |
| I1 sem a 065 | depois de V3 | Títulos: 0101/0103/0104/0106 com o nome cadastrado; 0102 e 0107 com o número; 0105 com o número e o aviso "Vários cadastros com este número", sem nenhum nome cadastrado na tela; perfil "Não informado pelo WhatsApp"; nenhum erro na tela nem no log |
| I2 aplicação sem reinício | V2b | Recarregar a página (sem reiniciar o Next) passa a mostrar os perfis |
| I3 nomes antigos e novos | depois da V2b | 0102 com o título "Bruna Perfil Nova (nome no WhatsApp, não verificado)", nunca "Antiga" nem "enviado antes da 065"; 0101 com o título do cadastro e o perfil "Aninha 🎈" na linha própria; 0105 com o título do perfil, o aviso e nenhum nome cadastrado; 0107 com o número |
| I4 isolamento | depois da V2b | Página **e** JSON da rota `/api/admin/atendimento` sem "PERFIL DA OUTRA EMPRESA", "PERFIL DE OUTRO AMBIENTE", `…0199` e `…0198`; a V3c mostra que essas conversas existem no banco |
| I5 layout desktop | 0106 | Cartão, título e quadro quebram linha; `scrollWidth ≤ clientWidth` na página, na lista e no painel; captura |
| I6 layout celular 375×812 | 0106 e 0105 | Sem rolagem horizontal; título abaixo do menu (topo ≥ 54 px); quadro em uma coluna; capturas |
| I7 teclado | lista → conversa | O nome acessível do cartão traz título + número; Enter abre e foca o título longo, com contorno; ordem lógica |
| I8 atendente | login do atendente | A mesma identificação; ele não vê o cadastro de mensagens prontas |

**Teste offline** (`teste-offline.ps1`): 51/51 na rodada `78ed9d8` (53/53 depois das correções das fixtures), incluindo as verificações estáticas da V2b, do preparo, da conferência e do `vp.ps1`.

## Resultado (04/10/2026, HEAD `78ed9d8`)

Os detalhes ficam fora do Git: `.local-ux/val-prontas/estado/resultado-identificacao-78ed9d8.md`, com hashes em `EVIDENCIAS-identificacao-78ed9d8.txt` e, da rodada 1, em `.local-ux/pg-identificacao/EVIDENCIAS-78ed9d8.txt`.

**Rodada 1 — PostgreSQL, 127.0.0.1:55500:**
- O1 com identidade exata.
- **O2a PASS 4/4** (060, 064, 065, concorrência; nenhuma pulada).
- **O2b PASS 39/39**.
- O4 removeu só o alvo.
- Protegidos idênticos, inclusive o cluster da outra sessão.

**Rodada 2 — navegador, 55502 / http://localhost:3050:**
- V1/V2 ok, com a 065 **ausente**.
- V3c: coluna ausente, `saidas_total = 0`.
- **V2b** aplicou a 065 com o Next rodando.
- V3c: coluna presente, `saidas_total = 0`; Next sem chamadas de envio, erros nem 5xx.
- V4 removeu só a base `…-ba6eac`; protegidos e demo parada idênticos.

| Caso | Resultado |
| --- | --- |
| I1 sem a 065 | ok: números, cadastro único, aviso de vários cadastros sem nomes, perfil "não informado", nome enviado antes da 065 ignorado |
| I2 sem reinício | ok |
| I3 nomes antigos e novos | ok: "Bruna Perfil Nova" vence; antigo e anterior à 065 nunca aparecem; perfil separado do cadastro |
| I4 isolamento | ok na página e no JSON da rota: só A/staging (1 empresa); B e production existem no banco e não aparecem |
| I5 layout desktop | ok: nada transborda; título longo quebra (captura) |
| I6 celular 375×812 | ok: título a 72 px (menu até 54); uma coluna; sem rolagem horizontal (capturas) |
| I7 teclado | ok: cartões com título + número; Enter foca o título longo com contorno (captura) |
| I8 atendente | ok |

**Observações, sem bloqueio:**
1. No celular, o menu fixo cobre o início do botão "Voltar às conversas", acima do título.
2. O texto final de `preparar.mjs` está desatualizado.
3. O perfil longo de teste ficou com 79 caracteres (o emoji ocupa duas unidades UTF-16).

**Tratamento das observações (local, sem banco; 04/10/2026):**
1. **Botão sob o menu:** corrigido em `9145e1d`. Até 760px, o título que vem depois do botão para a 120 px (54 do menu + 14 de folga + 44 do botão + 8 de margem). O teste `components/admin/atendimento/layout-celular.test.ts` confere essa conta a partir do CSS do menu e da tela, e falha com o CSS anterior. A regra está no CSS do build. **A conferência visual no navegador não foi refeita**: exige uma base sintética nova e autorização.
2. **Resumo de `preparar.mjs`:** agora lê as contagens do banco em vez de números fixos. O esperado é:
   - 7 conversas de A em staging + 2 de isolamento;
   - 5 contratações, das quais 4 aguardam o cliente.

   Essas consultas ainda não rodaram contra um banco.
3. **Perfil longo:** cortado com `Array.from`, fica com 80 caracteres. Uma guarda recusa rodar se não der 80.

Hashes novos na seção 6 de `.local-ux/val-prontas/MANIFESTO.txt`, **não autorizados** para execução. Teste offline: 53/53.
