# PR nova — texto proposto (não publicada)

- **Base:** `staging`.
- **Head proposto:** `whatsapp/walle-integra-b5a6a86-20261011`, a partir de `89759885`.
  - `89759885` fica preservado, assim como a branch `whatsapp/walle-r47-renumera-20261010` e a PR #80.
  - O staging `b5a6a86` está integrado.
- **SHA e gates:** ficam fora do diff, no relatório de evidências (`evidencias-integra-b5a6a86/RESUMO.md`). Um documento
  não registra o próprio SHA.

> Publicação, push, merge, deploy, migrations persistentes, mudança de variáveis e envio real estão **fora** desta
> entrega. Cada um exige autorização própria. Leia os bloqueadores no fim.

## Título

`feat(whatsapp): atendimento WhatsApp com Wall-e (r47) e privacidade D1–D4 — migrations 060, 065, 080, 081 e 082 (esta PR não as aplica), canal desligado`

## Descrição

### Resumo

Atendimento WhatsApp pelo canal Gupshup. O assistente **Wall-e** responde só pelas fontes oficiais da empresa. A PR inclui:

- webhook durável com receptor único;
- fila e worker sem reenvio automático;
- tela Admin › Atendimento;
- biblioteca de mensagens prontas com foto, vídeo e PDF;
- passagem para a equipe, com motivo.

Agora inclui também a privacidade D1–D4:

- minimização antes de toda chamada ao modelo;
- histórico da fase B protegido;
- exclusão e retenção verificáveis;
- revogação, troca de link e expiração de arquivos.

**Nada é ativado por esta PR.**

- O canal fica desligado por padrão.
- Nenhuma migration é aplicada.
- Nenhuma variável de ambiente é alterada.
- A retenção não tem prazo padrão.

**Substitui o conteúdo da PR #80**, que permanece intacta; fechá-la exige uma decisão posterior. Esta PR contém todo o
conteúdo da #80 e da fase B (a cobertura está registrada em `PR_WALLE_R47_FINAL.md`, histórico).

### Migrations: 060, 065, 080, 081 e 082

| Migration | Conteúdo | Numeração anterior |
|---|---|---|
| `20261001_060_whatsapp_atendimento` | conversas, mensagens, configuração, status, auditoria | idêntica à da #80 |
| `20261004_065_whatsapp_nome_perfil` | nome de perfil da conversa | a mesma da #80 (só comentários mudaram) |
| `20261011_080_whatsapp_mensagens_prontas` | biblioteca de mensagens prontas e favoritas | 064 → 070 → 073 → 076 → 077a |
| `20261011_081_whatsapp_prontas_midia` | foto e vídeo nas prontas e no envio | 066 → 071 → 074 → 077 → 077b |
| `20261011_082_wall_e_atendimento` | arquivos próprios e PDF, estados e finalidade das prontas, memória e passagem do Wall-e; **agora com D2/D3**: revogação, troca de link e expiração dos arquivos e registro de privacidade | 067 → 072 → 075 → 078 |

**Por que 080–082 (11/10):**

- O staging criou e **aplicou no banco de staging** (por evidências datadas) a `20261010_078_catalogo_buffet_por_empresa`
  e a `20261011_079_convite_recuperacao_manual`.
- A 078 do Wall-e colidia com a do staging.
- A 077a e a 077b ficariam, na ordem de nome, antes de migrations já aplicadas.
- Com 080–082 e o prefixo 20261011, o atendimento fica depois de todas as migrations do inventário, tanto na lista
  quanto na ordem de nome.

**Números livres não são reserva.** 080–082 são uma escolha local e provisória. Não existe mecanismo de reserva entre
sessões: reconfirmar antes do push e antes de aplicar.

**Ordem de aplicação real.** No banco de staging, 061–079 já estão aplicadas (076–079 por evidências, nunca por leitura
desta entrega). Por isso a 060 e a 065 entrariam **depois** delas: estarem livres não prova que funcionem assim. A
suíte `ordem-staging-real` (modelo `079-sem-atendimento` + modelo `082`) prova:

- a aplicação 060 → 065 → 080 → 081 → 082 sobre 061…079, com o postcheck oficial de cada uma;
- o schema e os dados fora do atendimento ficam idênticos a cada passo;
- o schema final é **idêntico** ao montado na ordem do inventário;
- os downs da 078 e da 079 rodam e voltam com o atendimento presente, sem tocá-lo, e a 078 recusa quando há catálogo
  de outra empresa;
- o rollback nas **duas** ordens (082 → 081 → 080 → 065 → 060) preserva schema e dados das outras tabelas e devolve
  exatamente o schema de partida.

Não foi provado o caso misto em que a 060 já estivesse aplicada no staging e a 065 não. Só um E2a novo e datado diz
qual é o estado real.

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
o registro de privacidade (com a mesma decisão explícita).

### Privacidade (D1–D4)

A matriz completa está em `docs/PRIVACIDADE_ATENDIMENTO_D1_D4.md`.

- **D1:**
  - CPF/CNPJ com separadores, telefone com ou sem DDD, e-mail por extenso, CEP, endereço, data de nascimento e nome em
    frase de identificação são ocultados antes de toda chamada ao modelo;
  - dado de saúde nunca vai ao modelo: o Wall-e usa as regras, e a fase B passa para a equipe;
  - o resumo gravado (`ultimaMensagem`) fica minimizado.
- **D4:** cada entrada do histórico da fase B recebe as mesmas proteções, antes do JSON.
- **D2:**
  - exclusão a pedido, só pela gestão. Remove mensagens, status, nome de perfil, memória, passagem e pendentes; adia
    quando há tarefa em andamento;
  - retenção sem prazo padrão;
  - registro sem conteúdo nem contato;
  - contato com PARAR fica só com o número e a marca.
- **D3:**
  - revogar apaga o conteúdo e troca o link (irreversível; o banco garante), arquiva as prontas e cancela a fila;
  - também há troca de link e expiração;
  - arquivo revogado, vencido ou de empresa inativa não é servido nem enviado.
- **Limites reais:** cópias já baixadas pelo provedor ou pelo cliente não são apagadas; um nome solto no meio da frase
  ainda pode chegar ao modelo no modo IA.
- **Decisões pendentes:** R1–R6 (prazo de retenção, PARAR, quem exclui, expiração padrão, tela, modo IA).

### Provas (locais, cluster PostgreSQL descartável, sem rede)

Os números do SHA final estão no relatório de evidências. As provas são:

- unitárias do atendimento, do Wall-e, da produção e da arquitetura;
- `check:v1:static`;
- `check:v1:postgres` completo;
- equivalência com a r47 (`f3c78bb`, 3.990 mensagens, incluindo as leituras gravadas da IA real);
- efeito da guarda de saúde nas leituras gravadas;
- controles negativos das suítes novas.

**Limites das provas:**

- dados sintéticos;
- transporte e modelo simulados;
- não mede travas em volume;
- não prova a restauração de backup;
- a IA real não foi repetida (vale por equivalência).

### O que esta PR não faz

- Não liga o canal: recepção, envio e receptor ficam desligados, e staging exige lista de contatos.
- Não aplica migrations e não muda o processo de start do Render.
- Não muda RBAC, Tenant Context, `lib/saas`, `lib/autenticacao`, `lib/http`, `lib/identidade` (OTP), o parser nem a
  correlação da Gupshup.

### Bloqueadores

- **Homologação em staging:**
  - E2a novo;
  - backup com restauração comprovada;
  - aplicação autorizada só do que estiver ausente;
  - deploy manual autorizado;
  - roteiro U/P, mais os itens novos de privacidade (exclusão, revogação, troca de link, expiração).
- **S11 do Painel** sem E1–E6 comprovados: o bloqueio continua.
- **Canal real:** E0 (receptor único) e E3 (OTP).
  - A configuração efetiva de e-mail, WhatsApp e IA no web de staging precisa ser esclarecida. A presença de nomes de
    variáveis não comprova que o canal esteja ativo.
  - Autenticação e Partner API da Gupshup ainda pendentes.
- **Dados reais:** só depois das decisões R1–R6.
- **Produção:** só depois da homologação, por promoção separada.

### Rollback

1. Desligar: Wall-e na tela, chave global da IA, flags do canal, worker ou assinatura do webhook.
2. Voltar o código mantendo as migrations (provado).
3. Downs só como último recurso, na ordem e com autorização.
