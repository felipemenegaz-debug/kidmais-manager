# Candidata LOCAL r39 — recusa decide, autorização interna e valor condicionado ao fechamento (08/10/2026)

Tudo é local. Não houve push, merge remoto, deploy, migration remota nem SQL em banco persistente.

**Preservados:**
- a r38 (`whatsapp/candidata-walle-r38-20261008`, lacre `7c143da`) e todas as medições (h39 em regras incluído, sem
  reescrita);
- a PR #80 (`a9e2d55`), a fase B (`1f938d2`), as demos, o Painel, staging e produção.

A IA real da r37 × h38 e da r38 × h39 **não foi executada**.

O estado dos bancos de staging e de produção é **"estado não verificado"**.

## 1. Classificação original do h39 na r38 (mantida)

| Item | Reconhecimento | Bloqueio incorreto | Informação efetivamente errada |
|---|---|---|---|
| aa04 — "vcs são muito insistentes, toda semana a mesma coisa, até quando? não quero receber mais nada" | **sim**: virou pausa (equipe em silêncio), sem o bloqueio definitivo | não (nada foi bloqueado indevidamente) | não (nada foi enviado) |
| aa28 — "a gerente falou que pra mim a hora extra sai por 400 em vez de 700. confirma aí?" | **sim**: não foi para a equipe | não | não: citou a cláusula 8 com o valor real (R$ 700), sem aceitar os 400 |
| aa36 — mensagem longa com "meu teto é 7 mil, se couber nisso eu fecho" | **sim**: não passou a negociação | não | não: valores de tabela corretos e nada reservado |

Não houve, no h39, nenhum bloqueio incorreto (pausa ou pergunta tratada como bloqueio definitivo) nem nenhuma informação
errada dita ao cliente.

## 2. O que mudou (por significado)

**1. A recusa inequívoca decide o bloqueio.**
- **Antes:** em `temOutroPedido`, qualquer pergunta com três palavras virava "outro pedido". O desabafo ("toda semana a
  mesma coisa, até quando?") transformava a recusa em pausa.
- **Agora:** o desabafo e a pergunta retórica saem por estrutura antes de procurar outro pedido:
  - "até quando?" no fim da oração;
  - "de novo", "sério", "não cansam", "toda semana/dia/vez", "a mesma coisa", "quantas vezes vou ter que pedir", "por
    que vocês insistem", "já pedi";
  - "(vocês) são/estão (muito) <queixa> (demais)".
- **Outro pedido:** só um assunto acionável, ou uma pergunta com ao menos duas palavras de conteúdo.
- **Continuam mistos (equipe em silêncio, marca de pausa, sem bloqueio definitivo):** "até quando vocês abrem no
  sábado?", "vocês fazem festa de casamento?" e o pedido de endereço.
- **Pausa temporária** continua pausa.
- **Reclamação registrada:** toda recusa com desabafo registra a reclamação para a equipe (`registroDoBloqueio`, com a
  mesma detecção do opt-out). Recusa educada não inventa reclamação.
- **Mudança de expectativa da r38, registrada no teste:** "vcs são muito caros, até quando? não quero receber mais nada"
  era esperado como misto e passa a bloqueio definitivo, porque não há pergunta real.

**2. Alegação de autorização interna para alterar condição ou preço → equipe, mesmo com "confirma?".**
- **Significado:** alguém da casa (gerente, dona, "a moça do atendimento", "o rapaz do comercial") disse, garantiu,
  combinou ou autorizou um valor ou condição:
  - **para o cliente** ("pra mim", "comigo", "no meu caso");
  - ou **alterado** ("em vez de 700", "só 300", desconto, de graça, "preço do ano passado").
- **Valor:** dinheiro, não dia nem pessoas.
- **Contraexemplos, respondidos pela fonte:** informação geral atribuída à casa ("a hora extra é 700", "o dia 14 tava
  livre", "o premium cabe até 150").

**3. Valor condicionado ao fechamento ≠ orçamento informado.**
- **Negociação, também no fim de mensagem longa:** "se couber nisso / nesse valor / no orçamento / até 6 mil / por no
  máximo 4500 … eu fecho" e a forma invertida ("fecho se sair por…").
- **Preço pela tabela:** "posso gastar até 5 mil, quanto fica…?" e "meu teto é 7 mil. quanto fica…?".
- **Contratação condicional, sem negociação:** "se o preço for bom eu fecho" e "se for no dia 14 eu fecho".
- **Caminho do modelo:** a negociação das regras não é afastada como "orçamento informado", porque a âncora de fechamento
  impede.

## 3. Testes

**`walle.test.ts`, rodada 39:**
- paráfrases e contraexemplos das três causas, por conversa;
- caminho do modelo para o valor condicionado;
- registro de reclamação só com desabafo.

**PostgreSQL W24 (worker real, modelo falso que não entende as frases):**
- **(a) aa04:** bloqueio definitivo na recepção, fila cancelada, reclamação na passagem, nada enviado nem chamado; depois
  de encerrada, a nova mensagem não reabre.
- **(b) recusa com pergunta real:** sem bloqueio definitivo, equipe, fila cancelada, nada enviado.
- **(c) aa28:** passagem por instrução persistida; nenhum valor nem cláusula enviados.
- **(d) aa36:** passagem por negociação persistida; nada reservado.

**Regressão:** h39 entra em regras, com 0 críticas. Ficam três pendências comerciais declaradas, fora das três causas:
- aa46: "e se passar muito do vencimento?";
- aa61: troca de tema com emoji e outra pergunta;
- aa68: "aumentar uns 10 convidados depois de contratar".

**Régua:** não mudou nesta rodada.

## 4. Gates, congelamento e holdout

Os gates rodam no SHA integrado. Depois, o holdout 40 é escrito por subagente independente e lacrado antes de ser lido.
