# PR nova — texto final (não publicada)

> **SUPERADO em 11/10/2026** por `docs/PR_WHATSAPP_WALLE_INTEGRA_20261011.md` (staging `b5a6a86` integrado; migrations
> renumeradas para 080/081/082; privacidade D1–D4). Mantido como histórico: números e gates abaixo são da época.

- **Base:** `staging`
- **Head:** `whatsapp/walle-r47-renumera-20261010` (a partir de `c9213868`, que segue preservada; migrations do atendimento
  renumeradas e staging `235b082` integrado)
- **SHA candidato:** o SHA exato e os gates ficam no relatório de gates da correção (fora do diff: um documento não registra o
  próprio SHA); `aeedb19` e `5b428a7` preservados.

> Push permanece fora do escopo. Leia os bloqueadores do relatório final de gates.
>
> **Numeração (10/10):** o staging criou `20261010_076_cpf_por_empresa` e `20261010_077_regras_pagamento_empresa`. As
> migrations desta PR que colidiam foram renumeradas: **076 → 077a** (mensagens prontas) e **077 → 077b** (mídia das
> prontas); a **078** (Wall-e) não colidia e foi mantida. Staging `235b082` integrado. Números livres não são reserva:
> reconferir imediatamente antes do push.
>
> Staging `138910a` foi integrado localmente sem conflitos. Gates anteriores abaixo são históricos; os gates novos usam o SHA final.

## Título

`feat(whatsapp): atendimento WhatsApp com Wall-e (r47) — migrations 060, 065, 077a, 077b e 078 (esta PR não as aplica), canal desligado`

## Descrição

### Resumo
Atendimento WhatsApp pelo canal Gupshup, com o assistente **Wall-e** respondendo só pelas fontes oficiais da empresa.

Inclui:
- webhook durável com receptor único;
- fila e worker sem reenvio automático;
- tela Admin › Atendimento;
- biblioteca de mensagens prontas com foto, vídeo e PDF;
- passagem à equipe com motivo.

**Nada é ativado por esta PR:**
- canal desligado por padrão;
- esta PR não aplica migrations (o estado do banco de staging não foi verificado nesta entrega);
- nenhuma variável de ambiente alterada.

**Propõe substituir o conteúdo da PR #80**. A #80 permanece intacta; seu fechamento exige decisão posterior. A 064 da #80 colide com a `064_reimportacao` do staging. Esta PR contém todo o conteúdo dela e o da fase B.

### Cobertura da PR #80 e da fase B
- **PR #80 (`a9e2d55`, 59 commits):**
  - 84 arquivos: 31 idênticos, 51 evoluídos, 2 renomeados, 0 ausentes;
  - todos os 191 nomes de teste e os 17 códigos de erro presentes.
- **Login:** o "mostrar senha" do login fica na versão que o staging já tem.
- **Fase B (`1f938d2`, não publicada):** os 30 arquivos estão incluídos como 077b (antes 077, originalmente 066), com todos
  os 127 nomes de teste.

### Migrations desta entrega: 060, 065, 077a, 077b e 078

- **Esta entrega não aplica migrations.** Cada aplicação exige autorização explícita própria.
- **Estado do banco de staging: não verificado.** Os arquivos na branch não dizem o que está aplicado no banco; nesta
  entrega não houve leitura do banco (nem E2a, nem leitura remota).
- **O E2a antigo é histórico.** O E2a de 04/10 ("aplicar 060/064/065") não autoriza aplicação atual: a 064 da #80 virou a
  076 e depois a 077a, o staging andou e a lista mudou. Só um E2a novo e datado, contra o commit final, define o que falta.
- **Migrations a aplicar:** somente as desta entrega (060, 065, 077a, 077b e 078) que esse E2a novo mostrar ausentes —
  nunca um intervalo ("060–078" incluiria migrations que não são desta PR).
- **Números livres não são reserva.** 076–078 estavam livres na leitura de 05:20Z (`cf1b9e7`); às 08:44Z o staging
  (`57d0e71`) já usava 076 e 077. Não há mecanismo de reserva de números no repositório (só o inventário explícito de
  `check-migrations.mjs` e comentários de coordenação); o primeiro a publicar no staging fica com o número. 077a/077b/078
  estão livres na leitura de 09:03Z (`5a626ea`) — isso não os reserva: reconferir antes do push e antes de aplicar.

| Migration | Conteúdo | Relação com a #80 / fase B |
|---|---|---|
| `20261001_060_whatsapp_atendimento` | conversas, mensagens, configuração, status, auditoria | idêntica à #80 |
| `20261004_065_whatsapp_nome_perfil` | nome de perfil da conversa | igual à #80, exceto comentários |
| `20261009_077a_whatsapp_mensagens_prontas` | biblioteca de mensagens prontas e favoritas | era a 064 da #80 (depois 070, 073 e 076); só o número mudou |
| `20261009_077b_whatsapp_prontas_midia` | foto e vídeo nas prontas e no envio | era a 066 da fase B (depois 071, 074 e 077); só o número mudou |
| `20261009_078_wall_e_atendimento` | arquivos próprios e PDF, estados e finalidade das prontas, memória e passagem do Wall-e | nova |

**Renumeração (correspondência):**

| Conteúdo | origem (#80 / fase B / Wall-e) | 1ª renumeração | 07/10 | 09/10 | **10/10 (atual)** |
|---|---|---|---|---|---|
| mensagens prontas | 064 | 070 | 073 | 076 | **077a** |
| mídia das prontas | 066 | 071 | 074 | 077 | **077b** |
| Wall-e | 067 | 072 | 075 | 078 | **078** (mantida) |

- Origem e 1ª renumeração conforme o histórico registrado em `check-migrations.mjs`; de 07/10 a 10/10 conforme o git
  desta linhagem (073 → 076 → 077a; 074 → 077 → 077b; 075 → 078).

- 09/10: o staging ocupou 073, 074, 074a e 075. 10/10: o staging ocupou 076 (`cpf_por_empresa`) e 077
  (`regras_pagamento_empresa`).
- A 078 não colidia e foi mantida: 077a/077b seguem o padrão de sufixo do projeto (006a, 055a–d, 074a) e deixam a 078
  depois das duas de que ela depende, no inventário e na ordem de nome.
- Flags de rollback: `kidmais.rollback_076_descartar_prontas` → `kidmais.rollback_077a_descartar_prontas`;
  `kidmais.rollback_077_descartar_midias`/`_descartar_prontas_midia` → `kidmais.rollback_077b_*`; as da 078 não mudam.
- Evidências históricas (relatórios e logs anteriores) mantêm os números da época; esta tabela é a correspondência.

**Coexistência:**
- nenhuma das cinco altera objeto ou dado do staging;
- com a 076 (CPF por empresa) e a 077 (regras de pagamento) do staging, nas duas ordens: postchecks dos dois lados; cada
  down do atendimento preserva objetos e dados sintéticos delas; os downs delas falham fechado com dados e, sem eles, não
  tocam o atendimento (suíte `coexistencia-cpf-pagamento`);
- o inventário do staging em `5a626ea` não registrava a própria 076/077 (8 testes de `production.test.mjs` falham nesse
  SHA); esta PR as registra;
- há 14 chaves estrangeiras das tabelas novas para `empresas`, `usuarios_administrativos` e `estabelecimentos`, sem cascata;
- inventário em `scripts/production/check-migrations.mjs`.

**Ordem de rollback:** 078 → 077b → 077a → 065 → 060. Os downs são destrutivos com dados e exigem `SET LOCAL kidmais.rollback_0xx_*`. Fora de ordem, eles recusam antes de alterar qualquer coisa.

### Provas (locais, cluster PostgreSQL descartável, sem rede)

| Prova | Resultado em `aeedb19` |
|---|---|
| Unitárias (atendimento, Wall-e, avaliação, produção, arquitetura, webhook) | 660/660 |
| `check:v1:static` (também é o build do Render) | PASS (2.705 + 103) |
| `check:v1:postgres` | 64 arquivos, 375 testes, 0 falhas |
| Comportamento × candidata avaliada `f3c78bb` | 3.990 mensagens, 0 diferenças (inclui as leituras gravadas da IA real) |
| IA real r47 × h47 (em `f3c78bb`, catálogo sintético) | 0 críticas, 29/29 |

**Rollback:**
- o código do staging roda com o schema novo: 48 suítes PASS, e o schema fora do atendimento é idêntico;
- os downs na ordem devolvem o schema exato;
- fora de ordem, os downs recusam sem alterar nada, com tabelas vazias, com uma 078 parcial e com dados sintéticos e todas as decisões de descarte ligadas (suíte `rollback-ordem`).

**Isolamento:**
- empresa vinda só do servidor;
- Tenant Context e RBAC existentes, sem alteração;
- FKs compostas por empresa e ambiente;
- turno do resumo pelo escopo da empresa e da unidade (`resumo-turno`).

**Fila:**
- entrada vence em 15 min e vai à equipe sem resposta (`fila-validade`);
- com a IA global desligada, a entrada nasce com a equipe e nada é respondido depois de religar, mesmo sem ciclo do worker;
- a resposta manual é preservada;
- PARAR e pausa continuam valendo (`protecoes-finais`);
- **pedido de pausa reconhecido pelas regras vence o limite diário e todos os caminhos fixos** (correção P1, abaixo;
  suíte `pausa-limite`);
- **limite diário esgotado: equipe em silêncio**, sem modelo nem texto fixo, sem classificar o pedido (M1, abaixo; suíte
  `limite-silencio`).

**Modo regras (`WHATSAPP_ATENDIMENTO_WALLE_ENTENDIMENTO=regras`):** nenhum caminho chama o modelo (Wall-e, fase B, sem a 078), mesmo com orçamento válido (`protecoes-finais`, `porta-regras`, `composicao-ia`).

**Limites das provas:**
- dados sintéticos;
- transporte e modelo simulados;
- rollback provado só com tabelas vazias e dados sintéticos;
- não mede lock em volume;
- não prova restauração de backup;
- a IA real não foi repetida neste SHA (vale por equivalência).

### O que esta PR não faz
- Não liga o canal: recepção, envio e receptor desligados; staging exige lista de contatos.
- Não aplica migrations.
- Não muda RBAC, Tenant Context, `lib/saas`, `lib/autenticacao`, `lib/http`, `lib/identidade`, nem o parser e a correlação da Gupshup.
- Não muda o processo de start do Render.

### Pendências fora desta PR
- Homologação em staging: deploy manual autorizado; E2a novo e datado; aplicação, com autorização própria, backup e
  restauração comprovada, só das migrations desta entrega (060, 065, 077a, 077b, 078) que o E2a novo mostrar ausentes;
  roteiro U1–U10 e P1–P8 (H9a2: limite diário em silêncio).
- Canal real bloqueado:
  - autenticação e Partner API da Gupshup (chamado #277630);
  - E0 (receptor único) e E3 (OTP público funcional);
  - dados reais da Kidmais.
- Antes do modo IA (D1–D4):
  - máscara de dados pessoais incompleta;
  - sem retenção nem exclusão;
  - arquivos públicos sem revogação;
  - histórico enviado ao modelo na fase B.
- Produção: só depois da homologação, por promoção separada.

### Rollback
1. Desligar: Wall-e na tela, chave global da IA, flags do canal, worker ou assinatura do webhook.
2. Voltar o código mantendo as migrations (provado).
3. Downs só como último recurso, na ordem e com autorização.



## Correção P1 — pausa × limite diário (revisão da candidata final)

**Causa confirmada** (reprodução na candidata `5b428a7`, PostgreSQL descartável, transporte simulado): o limite diário era
verificado no worker antes do tratamento da pausa; esgotado, `encaminharSemModelo` enviava o texto fixo de encaminhamento
sem gravar `contexto.semAutomatico`, e a recepção só marcava a pausa quando a mensagem não era automática. O mesmo valia
para a fase B (Wall-e desligado: saía o texto de atendente) e para a falha do Wall-e (texto fixo). Em todos, "Devolver ao
Wall-e" continuava permitido.

**Correção** (reconhecimento determinístico existente, sem modelo):
- recepção: pedido de pausa (opt-out ambíguo) nunca entra na fila automática; a conversa vai à equipe com o resumo de
  pausa (o mesmo do resolvedor: PARAR_A_CONFIRMAR, com RECLAMACAO se houver irritação) e a marca persistente;
- worker: barreira antes do limite e de qualquer caminho fixo, para entradas já enfileiradas.

**Prova:** suíte `pausa-limite` (L1 limite esgotado + pausa; L2 silêncio; L3 fase B; L4 falha do Wall-e; L5 controle de
mensagem comum; L6 controle de PARAR inequívoco; L7 pausa já enfileirada) **falha na `5b428a7`** e passa na correção; marca,
recusa da retomada, mensagem posterior, reabertura e atendimento humano conferidos.

**Diferenças intencionais:** pausas reconhecidas pelas regras não passam mais pelo Wall-e/modelo (136 das 3.750 mensagens
dos corpora; o motivo do resumo é o mesmo nas 136); no resumo, turno, pacote e unidade ficam sem nome (data, convidados e
tema vêm da memória); a marca tem origem `RECEPCAO`; `fila-validade` V3/D3 passam a esperar a captura na recepção. A
equivalência com a r47 (simulação do resolvedor) continua 3.990/0, porque a mudança está na recepção e no worker.

## M1 — limite diário esgotado em silêncio (revisão da correção P1)

**Lacuna:** uma pausa que só o modelo reconhece (paráfrase fora das regras, como a do W22) chegava ao limite diário antes
do Wall-e e recebia o texto fixo de encaminhamento, sem marca. **Correção:** com o limite esgotado, **qualquer** mensagem
vai para a equipe em silêncio — sem modelo, sem Wall-e e sem o texto fixo. Nada é classificado: o resumo traz o motivo
`LIMITE_DIARIO` (nunca uma pausa) e nenhuma marca de pausa é inventada; marcas e memória já gravadas ficam como estão.
**Prova:** suíte `limite-silencio` (S1 limite + paráfrase do W22; S2 a mesma paráfrase sem limite, reconhecida pelo Wall-e;
S3 pausa determinística; S4 mensagem comum com a memória preservada; S5 PARAR inequívoco; S6 marca existente com
mensagem nova, encerramento, reabertura e resposta da equipe; S7 pausa já enfileirada) — **falha em `e66f727`** (S1: saiu
o texto fixo) e passa na correção.

**Diferença intencional:** mensagem comum com o limite esgotado não recebe mais o texto fixo de encaminhamento (antes
recebia); os testes que esperavam o texto (unitário do worker, `migration-060` 8d, `pausa-limite` L5) foram ajustados e
comentados. Uma paráfrase de pausa não reconhecida pelas regras, com o limite esgotado, fica com a equipe **sem** marca
de pausa (não foi classificada): "Devolver ao Wall-e" continua possível nesse caso, e a equipe decide.

**Rastreabilidade (B5):** toda marca `contexto.semAutomatico` registra a origem — `RECEPCAO`, `FILA` (barreira do worker),
`WALLE` (silêncio do Wall-e), `ENTRADA_VENCIDA` ou `AUTOMACAO_DESLIGADA`.

**Limitação sem a migration 078 (B1):** sem a 078 não há onde gravar a marca nem o resumo (`contexto`/`passagem` vêm da
078). Uma pausa vai para a equipe sem nada enviado, mas **não fica persistida**: "Devolver ao Wall-e" não é recusado e uma
reabertura posterior pode voltar a ser automática. O limite diário em silêncio também não grava resumo sem a 078. Por isso
o atendimento automático só deve ser ligado com a 078 aplicada (as cinco migrations desta entrega — 060, 065, 077a, 077b e
078 — entram juntas, na ordem, conforme o E2a novo).

## Atualização da entrega final

A integração local incorporou `staging` em `138910a8cc80a1d43a68e84f6c6e166a4f790f09`, sem conflitos. O SHA exato e os gates desta entrega serão registrados em `.local-ux/final/RESUMO.md`, fora do diff, após congelar este documento. Os resultados acima pertencem à candidata anterior e não substituem os gates novos.

- Migrations desta entrega: 060, 065, 077a, 077b e 078 (antes 076/077/078; ver a correspondência). Esta entrega não aplica migrations; estado do banco de staging não
  verificado; o E2a antigo é histórico e não autoriza aplicação atual.
- Migrations 077a/077b/078: conferência de disponibilidade não constitui reserva entre sessões; não existe mecanismo de
  reserva no repositório.
- Textos do limite diário (revisão de `62497b1`): a tela de configuração, o roteiro de homologação (H9a2), a ativação em
  staging e o quadro de respostas iniciais agora dizem que o limite esgotado vai para a equipe em silêncio, sem mensagem
  fixa; comentários de `core.ts` e `worker.ts` alinhados.
- D2/D3 bloqueiam o uso de dados pessoais reais tanto em staging quanto em produção. Até sua correção, homologação somente com contatos e arquivos de teste controlados, sem dados de clientes ou imagens de crianças.
- D1/D4 bloqueiam o modo IA com dados reais. O modo regras impede chamadas ao provedor em todos os caminhos.
- Bloqueio do S11 mantido; status da sessão Painel não foi verificado nesta tarefa.
- Achado P1 (pausa × limite diário) e M1 (limite em silêncio) corrigidos nesta branch; B2 (comentário da barreira), B3
  (registro dos códigos de saída) e B5 (origem da marca) tratados; B1 documentado acima; demais achados LOW/INFO seguem
  registrados.
- Staging `cf1b9e7` (lido no GitHub às 05:20Z) integrado sem conflito em `whatsapp/walle-r47-integra-cf1b9e7-20261010`;
  conferidos AdminShell (permissão `financeiroCompleto` + ícone do Atendimento), navegação (Atendimento em Operação; o
  filtro de plano só esconde contas a pagar, fluxo e relatórios) e regras de arquitetura (composition roots do WhatsApp e
  barreira de plano convivem). O Atendimento não depende de plano nesta PR.
- **Colisão de migrations resolvida (10/10):** 076 → 077a e 077 → 077b; 078 mantida. Staging `5a626ea` (relido às
  09:03Z) e depois `235b082` (09:09Z; só homologação, sem migration) integrados sem conflito; a 076/077 do staging registradas no inventário; coexistência com CPF por empresa e
  regras de pagamento provada (`coexistencia-cpf-pagamento`). O atendimento não usa CPF nem regras de pagamento: a busca
  por contato (`buscarClientesPorContatoExato`) e o preço do Wall-e (`calcularResumoComercial`) não mudaram; desconto no
  Pix continua sendo negociação, passada à equipe.
- Sem push, merge remoto, deploy, migrations persistentes ou envio real.