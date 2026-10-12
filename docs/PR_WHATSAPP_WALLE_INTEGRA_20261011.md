# PR nova — texto proposto (não publicada)

- **Base:** `staging`.
- **Head proposto:** `whatsapp/walle-decoracao-revisao4-20261012`: a candidata revisada `aa04387` (revisões
  independentes de `8b2c55d`, `69dc301`, `5699dfc` e `aa04387`) com o staging `f2122b1` integrado (PRs #160 e #161;
  relido por `ls-remote` em 12/10/2026) e a correção do teste manual de 12/10 (decoração inclusa × segunda mesa temática
  adicional) e as correções das revisões de `6281e35` (A1, M1 e aviso do link) e de `1a0ef17` (correspondência explícita
  do item e várias referências na mesma mensagem), de `8336a56` (complementos preservados e igualdade exata, sem
  prefixo) e de `d590845` (quantidade e características como requisitos conjuntos), sobre `78e19a6`. As candidatas anteriores, as branches e as evidências ficam preservadas, assim
  como `89759885`, a branch `whatsapp/walle-r47-renumera-20261010` e a PR #80 (`a9e2d55`).
- **SHA e gates:** ficam fora do diff, no relatório de evidências (`evidencias-decoracao-revisao4-20261012/RESUMO.md`; os
  anteriores, `evidencias-decoracao-revisao3-20261012/`, `evidencias-decoracao-revisao2-20261012/`, `evidencias-decoracao-revisao-20261012/`, `evidencias-decoracao-20261012/` e
  `evidencias-integra-f2122b1-20261012/`, ficam preservados).
  Um documento não registra o próprio SHA.

> Publicação, push, merge, deploy, migrations persistentes, mudança de variáveis e envio real estão **fora** desta
> entrega. Cada um exige autorização própria. Leia os bloqueadores no fim.

## Título

`feat(whatsapp): atendimento WhatsApp com Wall-e (r47), privacidade D1–D4 e retenção serializada — migrations 060, 065, 080, 081 e 082 (esta PR não as aplica), canal desligado`

## Descrição

### Resumo

Atendimento WhatsApp pelo canal Gupshup. O assistente **Wall-e** responde só pelas fontes oficiais da empresa. A PR inclui:

- webhook durável com receptor único;
- fila e worker sem reenvio automático;
- tela Admin › Atendimento;
- biblioteca de mensagens prontas com foto, vídeo e PDF;
- passagem para a equipe, com motivo.

Agora inclui também medidas de privacidade para D1–D4 (**não concluídos**; ver os limites e as decisões abaixo):

- normalização e minimização antes de toda chamada ao modelo, na mensagem atual e em cada entrada do histórico;
- modo **regras por padrão** (o modelo só com configuração explícita);
- exclusão a pedido, controles mínimos (PARAR, pausa, equipe) separados do conteúdo e bloqueio de reentrega;
- retenção por empresa, sem prazo padrão, numa rotina própria com registro de execução;
- revogação, troca de link, expiração e reativação explícita de arquivos;
- tela mínima Admin › Atendimento › Privacidade, com reautenticação.

Correção do teste manual de 12/10/2026 ("A decoração está inclusa? Quanto custa uma segunda mesa temática?"):

- sem pacote escolhido, a pergunta de custo/inclusão da decoração lê as composições de todos os pacotes; o que é igual
  em todos é dito uma vez, o que muda é dito por pacote;
- a mesa principal (inclusa) é separada da segunda mesa (adicional) pela QUANTIDADE ("segunda", "outra", "mais uma",
  "a mais"); o pedido é lido como tokens com posição e todo token não interpretado é qualificador ("maior", "XL",
  "dupla"), inclusive complementos com preposição ("de vidro", "com LED"), salvo contexto ("do pacote Premium", "de 50
  convidados"); só responde o item cadastrado cujas características são EXATAMENTE as pedidas, depois de normalização
  explícita (caixa, acento e plural por regra; tokens com dígito inteiros: "XL2" ≠ "XL"), sem prefixo, truncamento ou
  alias presumido; quantidade e características são requisitos CONJUNTOS ("segunda mesa de vidro" só casa com o item
  "a mais" de vidro; a inclusão da principal não comprova outra unidade; outra unidade do próprio adicional só sem
  unidade inclusa do tipo); pedido simples só casa com a unidade simples; sem correspondência única (nenhuma ou
  ambígua), a lacuna é dita e vai à equipe, sem afirmar inclusão nem consultar ou informar o preço de outro item;
- cada ocorrência de item na mensagem é um pedido próprio (posição, quantidade, modificadores e a pergunta da própria
  oração): "a mesa temática está inclusa? quanto custa uma segunda mesa temática?" responde as duas; a resposta só é
  deduplicada depois de resolver os pedidos;
- "em todos os pacotes" só com todos os pacotes conferidos; composição ausente ou com falha e lista de pacotes
  indisponível viram lacuna dita e encaminhada (a resposta fica nos pacotes conferidos);
- o valor do adicional vem só da tabela de preços vigente (`precos_adicional`); sem valor cadastrado, a equipe confirma;
  com faixas por número de convidados e sem o número, só ele é pedido;
- "quanto custa a segunda mesa?" não dispara a tabela da festa; item que nenhum pacote cadastra continua com a equipe;
- todo envio e reenvio do link público traz "O envio deste link não reserva a data." uma vez por resposta; proteções
  (contratação passada à equipe, negociação, pagamento, alergia, pedido de pessoa) continuam sem link.

**Nada é ativado por esta PR.**

- O canal fica desligado por padrão.
- Nenhuma migration é aplicada.
- Nenhuma variável de ambiente é alterada.
- A retenção não tem prazo padrão nem agendamento.
- O Wall-e entende por regras, salvo configuração explícita do modelo.

**Substitui o conteúdo da PR #80**, que permanece intacta; fechá-la exige uma decisão posterior. Esta PR contém todo o
conteúdo da #80 e da fase B (a cobertura está registrada em `PR_WALLE_R47_FINAL.md`, histórico).

### Migrations: 060, 065, 080, 081 e 082

| Migration | Conteúdo | Numeração anterior |
|---|---|---|
| `20261001_060_whatsapp_atendimento` | conversas, mensagens, configuração, status, auditoria | idêntica à da #80 |
| `20261004_065_whatsapp_nome_perfil` | nome de perfil da conversa | a mesma da #80 (só comentários mudaram) |
| `20261011_080_whatsapp_mensagens_prontas` | biblioteca de mensagens prontas e favoritas | 064 → 070 → 073 → 076 → 077a |
| `20261011_081_whatsapp_prontas_midia` | foto e vídeo nas prontas e no envio | 066 → 071 → 074 → 077 → 077b |
| `20261011_082_wall_e_atendimento` | arquivos próprios e PDF, estados e finalidade das prontas, memória e passagem do Wall-e; **com D2/D3**: revogação, troca de link, expiração e reativação dos arquivos, registro de privacidade, controles mínimos de contato, hashes de eventos excluídos, configuração e execuções da retenção, motivo do cancelamento | 067 → 072 → 075 → 078 |

**Por que 080–082 (11/10):**

- O staging criou a `20261010_078_catalogo_buffet_por_empresa` (aplicada no banco de staging, com evidência datada) e a
  `20261011_079_convite_recuperacao_manual` (**sem evidência datada de aplicação neste repositório**).
- A 078 do Wall-e colidia com a do staging.
- A 077a e a 077b ficariam, na ordem de nome, antes de migrations já aplicadas.
- Com 080–082 e o prefixo 20261011, o atendimento fica depois de todas as migrations do inventário, tanto na lista
  quanto na ordem de nome.

**Números livres não são reserva.** 080–082 são uma escolha local e provisória. Conferência de 12/10/2026 05:14Z:
livres no staging remoto `f2122b1` (última migration: 079) e nas PRs abertas #162, #144 e #128 (nenhuma migration) e
#80 (060/064/065, numeração antiga que esta PR substitui). **Não existe registro de reserva entre sessões** no
repositório nem nos documentos: livre não é reservado. Reconfirmar antes do push e antes de aplicar.

**Ordem de aplicação real — premissa, não fato.** Supõe-se que o banco de staging tenha 061–079 (076–078 com evidência
datada; a 079 sem evidência datada; nada lido por esta entrega). Se for assim, a 060 e a 065 entrariam **depois**
delas: estarem livres não prova que funcionem assim. A suíte `ordem-staging-real` (modelo `079-sem-atendimento` +
modelo `082`) prova:

- a aplicação 060 → 065 → 080 → 081 → 082 sobre 061…079, com o postcheck oficial de cada uma;
- o schema e os dados fora do atendimento ficam idênticos a cada passo;
- o schema final é **idêntico** ao montado na ordem do inventário;
- os downs da 078 e da 079 rodam e voltam com o atendimento presente, sem tocá-lo, e a 078 recusa quando há catálogo
  de outra empresa;
- o rollback nas **duas** ordens (082 → 081 → 080 → 065 → 060) preserva schema e dados das outras tabelas e devolve
  exatamente o schema de partida.

**Estado misto (060 presente, 065 ausente):** agora provado por `estado-misto` (modelo `079-sem-065`): 065 → 080 →
081 → 082 aplicam com os postchecks; schema e dados fora do atendimento ficam idênticos; o schema final é idêntico ao da
ordem do inventário; o rollback volta exatamente à base. Só um E2a novo e datado diz qual estado é o real.

**Estado do banco de staging: não verificado nesta entrega.** O E2a antigo (04/10) é histórico. Aplicar só as
migrations desta entrega que um E2a novo mostrar ausentes, nunca um intervalo.

**Coexistência com 076–079 do staging:**

- CPF por empresa e regras de pagamento: `coexistencia-cpf-pagamento`.
- Catálogo do buffet por empresa e recuperação de convites: `ordem-staging-real`.
- O Wall-e no catálogo por empresa: `walle/catalogo-por-empresa`. Cada empresa só vê o próprio buffet; uma categoria de
  outra empresa é recusada pelo serviço e pelo gatilho da 078.
- As suítes da 079 do staging rodam também sem 060/065 (`tambem: 079-sem-atendimento`).

**Ordem de rollback:** 082 → 081 → 080 → 065 → 060. Os downs são destrutivos com dados e exigem
`SET LOCAL kidmais.rollback_0xx_*`. Fora de ordem, recusam antes de alterar qualquer coisa. O down da 082 também remove
o registro de privacidade, os controles de contato, os hashes e a retenção, e recusa sem a decisão explícita
`kidmais.rollback_082_descartar` quando há esses dados (provado com registros e arquivo revogado: `privacidade` P10).

### Privacidade (D1–D4) — medidas, não conclusão

A matriz completa, a cobertura medida e os limites estão em `docs/PRIVACIDADE_ATENDIMENTO_D1_D4.md`.

- **D1/D4:**
  - o texto é normalizado (NFKC, invisíveis removidos) antes de qualquer análise;
  - CPF/CNPJ, telefone, e-mail, CEP, endereço, data de nascimento e nome em frase de identificação são ocultados
    antes de toda chamada ao modelo;
  - dado sensível (saúde, alergia, deficiência, religião, origem, orientação, genética) nunca vai ao modelo: na mensagem
    atual o Wall-e usa as regras e a fase B passa à equipe; no histórico a entrada vira marcador;
  - campos derivados (`ultimaMensagem`) e o tema devolvido pelo modelo não copiam dado sensível nem nome;
  - **cobertura medida num corpus independente: 104/128 (81,3%), 6/72 falsos positivos**. Há lacunas: o modo IA
    continua bloqueado com dado real (padrão regras).
- **D2:**
  - exclusão a pedido só pela Gestão da empresa ativa (não a piloto), com senha confirmada há ≤ 5 min; adia com tarefa
    em andamento;
  - PARAR, pausa e conversa com a equipe sobrevivem em controles mínimos, separados do conteúdo; a conversa nova herda;
  - reentrega do provedor não recria o que foi excluído (hash do id, por empresa e provedor);
  - retenção por empresa, sem prazo padrão, numa rotina independente das chaves do canal e da IA, por conversa, com
    erros observáveis e registro da execução; precisa de agendamento externo;
  - registro sem conteúdo nem contato.
- **D3:**
  - revogar apaga o conteúdo e troca o link, arquiva as prontas e cancela a fila **e as irmãs do grupo** com motivo;
  - troca de link, expiração (`agora` ou data; data inválida = 400) e reativação só explícita, com link novo;
  - arquivo indisponível não é servido, não é escolhido pelo Wall-e e não é enviado (nem manualmente); rota com
    `no-store`;
  - corrida revogação × envio provada; **ponto sem volta** em `ENVIANDO`: sem cancelamento retroativo;
  - o banco garante pela aplicação, não contra o dono do banco: a revogação é lógica (o conteúdo some das páginas só
    depois do `VACUUM`, e dos backups só quando vencem; `TRUNCATE`, `DISABLE TRIGGER`, `session_replication_role` e o
    down da 082 contornam o gatilho).
- **Limites reais:** cópias já baixadas pelo provedor, pelo cliente ou em backups não são apagadas; nomes soltos ainda
  passam pelo detector; falsos positivos tiram qualidade.
- **Decisões pendentes:** R1–R9 (prazo de retenção, controles mínimos, quem exclui, expiração padrão, revisão da tela,
  modo IA, prazos técnicos, agendamento, titular de empresa sem assinatura ou suspensa).
- **Correções da revisão de 5699dfc** (§7): retenção serializada com a configuração vigente (ordem empresa →
  configuração → conversa), posse da rotina por arrendamento renovado com cerca, falha assíncrona do provedor trata o
  grupo incompleto (callback antes ou depois do retorno do POST), falhas da própria empresa visíveis na tela.
- **Correções da revisão de 69dc301** (`PRIVACIDADE_ATENDIMENTO_D1_D4.md` §6): modelo só com a chave da decisão R6
  (falha fechada); retenção reconfere a atividade sob a trava, roda uma vez por vez e com espera limitada; recepção não
  grava evento além da janela de reentrega; grupo texto + PDF cancela o resto com motivo quando uma parte falha (sem
  atomicidade no provedor); busca do titular pelo número; segredo próprio da retenção.

### Webhook compartilhado com o OTP

O receptor `lib/integracoes/gupshup/webhook.ts` e a rota `app/api/integracoes/gupshup/webhook/route.ts` são
**compartilhados** com o OTP/identidade. Esta PR muda os dois: um parâmetro opcional (`persistEvent`) que a rota só
passa com a recepção do atendimento ligada. `lib/integracoes/gupshup/webhook-otp-preservado.test.ts` prova que, sem
ele, o comportamento é o do staging (ACK 204, log sanitizado, nada persistido; handshake aceito; status sem segredo
recusado) e que, com ele, uma falha da persistência devolve 503 só para eventos de mensagem/status. O OTP envia pela API
e confere o código no banco: esse 503 não bloqueia login, mas atrasa o registro do status. `lib/identidade` não muda.

### Provas (locais, cluster PostgreSQL descartável, sem rede)

Os números do SHA final estão no relatório de evidências. As provas são:

- unitárias do atendimento, do Wall-e, da tela, da produção, da arquitetura, do webhook/OTP e da identidade;
- `check:v1:static`;
- `check:v1:postgres` completo, incluindo `privacidade` (P1–P10), `revogacao-envio` (C1–C4, travas confirmadas em
  `pg_stat_activity`), `revisao-correcoes` e `revisao2-correcoes` (retenção × configuração nas duas ordens, posse
  por arrendamento com processo morto, callbacks antes/depois do retorno do POST), `postcheck-082` (o verificador
  recusa uma 082 antiga ou adulterada), `preco-adicional` (modalidade e preço do adicional pela tabela vigente,
  faixas, isolamento por empresa), `estado-misto` e `ordem-staging-real`;
- matriz independente de correspondência (`correspondencia-matriz.test.ts`, 5.400 + 540 casos contra as invariantes de
  preço, inclusão, ausência de correspondência e cobertura);
- equivalência com a r47 (`f3c78bb`, 3.990 mensagens, incluindo as leituras gravadas da IA real) e, com decoração
  cadastrada na fixture, cada diferença classificada no relatório (aviso do link ou decoração, com o texto das duas
  versões);
- efeito da guarda de dado sensível nas leituras gravadas;
- cobertura do detector num corpus independente;
- controles negativos: cada proteção nova é desfeita numa cópia descartável e o teste correspondente precisa falhar.

**Limites das provas:**

- dados sintéticos;
- transporte e modelo simulados;
- não mede travas em volume;
- não prova a restauração de backup;
- a IA real não foi repetida (vale por equivalência);
- a cobertura do detector vale para o corpus medido, não para qualquer texto.

### O que esta PR não faz

- Não liga o canal: recepção, envio e receptor ficam desligados, e staging exige lista de contatos.
- Não aplica migrations e não muda o processo de start do Render.
- Não muda RBAC, Tenant Context, `lib/saas`, `lib/autenticacao`, `lib/http`, `lib/identidade` (OTP), o parser nem a
  correlação da Gupshup. **Muda** o receptor e a rota do webhook, compartilhados com o OTP (seção acima).

### Bloqueadores

- **Homologação em staging:**
  - E2a novo;
  - backup com restauração comprovada;
  - aplicação autorizada só do que estiver ausente;
  - deploy manual autorizado;
  - roteiro U/P, mais os itens novos de privacidade (exclusão, controles herdados, reentrega, retenção agendada,
    revogação, troca de link, expiração, reativação, corrida com envio).
- **S11 do Painel** sem E1–E6 comprovados: o bloqueio continua.
- **Canal real:** E0 (receptor único) e E3 (OTP).
  - A configuração efetiva de e-mail, WhatsApp e IA no web de staging precisa ser esclarecida. A presença de nomes de
    variáveis não comprova que o canal esteja ativo.
  - Autenticação e Partner API da Gupshup ainda pendentes.
- **Dados reais:** bloqueados também em staging até as decisões R1–R9; o modo IA, enquanto a cobertura do detector
  tiver lacunas relevantes (R6).
- **082 revisada antes de qualquer aplicação:** um banco que já tivesse uma versão antiga da 082 exige plano explícito de
  evolução (reaplicar não é presumido permitido); o postcheck recusa essa diferença.
- **Retenção sem agendamento** (R8) e **paywall × privacidade** (R9) em aberto; CI e revisão da PR remota pendentes.
- **Produção:** só depois da homologação, por promoção separada.

### Rollback

1. Desligar: Wall-e na tela, chave global da IA, flags do canal, worker ou assinatura do webhook.
2. Voltar o código mantendo as migrations (provado).
3. Downs só como último recurso, na ordem e com autorização.
