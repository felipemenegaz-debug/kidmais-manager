# Candidata LOCAL r36 — correção localizada sobre a candidata r35 (08/10/2026)

Tudo é local. Não houve push, merge remoto, deploy, migration remota nem SQL em banco persistente.

**Preservados:**
- a candidata r35 (`whatsapp/candidata-walle-r35-20261007`, `88c2cb2`) e a avaliação original dela;
- a IA real candidata r35 × h36 (execução `muz4tbsa`, 08/10) e a medição em regras do h36;
- a PR #80 (`a9e2d55`), a fase B (`1f938d2`), as demos, o Painel, staging e produção.

O estado dos bancos de staging e de produção é **"estado não verificado"**.

## 1. Branch e base

`whatsapp/candidata-walle-r36-20261008` (worktree `kidmais-candidata-r36`), criada de `88c2cb2` (staging `9dd7d89` +
produto r35 + documento + lacre do h36). Migrations, numeração (060, 065, 073–075) e arquivos de staging: iguais à r35.

## 2. O que a IA real × h36 mostrou e o que mudou

Leitura das 80 respostas inteiras. O relatório de comparação mostrava só os 700 primeiros caracteres; as saídas
gravadas estavam completas.

| Caso | Na IA real | Causa | Correção |
|---|---|---|---|
| aa04 (crítica, reconhecimento) | "se vcs fizerem o completa … por 4 mil, eu fecho hoje" → PERGUNTAR, sem negociação | O modelo leu `[agenda, pacotes, preço, negociação]` e as regras acrescentaram a contratação. Eram 5 intenções, e o limite de 4 cortou justamente a negociação | `limitar`: pessoa, contrato particular, contratação, negociação e item de fora nunca saem pelo limite; o corte vale só para assunto comercial |
| aa63 (crítica, violação) | "que horas os convidados podem chegar?" → cláusula 8 inteira + a entrada | "horário do almoço" lido como cláusula de horários | A cláusula de horários (ou a lista geral) vista só pelo modelo não entra quando a mensagem pergunta só a entrada. Com prorrogação, término, saída, multa ou "até que horas", ela continua |
| aa33 (encaminhamento desnecessário) | prorrogação + entrada → "Essa informação eu não tenho cadastrada" + equipe | A entrada lida como pergunta frequente sem cadastro | Pergunta de entrada não vira "informação não cadastrada"; outra pergunta sem cadastro na mesma mensagem continua indo para a equipe |
| aa49 (sem falha na régua) | capacidade → cláusulas 3 e 4 inteiras | Cláusula de convidados vista só pelo modelo | A capacidade é respondida pelo pacote; aumento, excedente, criança ou cortesia na mensagem mantêm a cláusula |
| Corte de resposta | nenhuma saída real passou de 4.000 caracteres nos 796 resultados gravados | O resolvedor fatiava o texto em 4.000, e o avaliador gravava `resposta` com só 700 | O resolvedor parte em mais de uma mensagem, entre parágrafos ou frases, sem descartar texto. O avaliador grava a resposta inteira. Nova categoria crítica na régua: `RESPOSTA_CORTADA` |
| aa69 (comercial, IA) | "Anotei a correção: tema Encanto (antes tema Moana)." | Erro da régua: só isentava "Anotei o tema “X”." | Isenção estendida, com teste e mutação. No modo regras a resposta foi o menu: lá a falha é real e continua |

## 3. Reprodução sem rede

A reprodução usa as interpretações gravadas em `interpretacoes-ia-gravadas-20261008.json`.

Para aa04, aa29, aa33, aa49 e aa63, a leitura é refeita com ordem, tema e trecho. O resultado gravado não guarda esses
dados.

**Com essas leituras, o código da candidata r35 reproduz o resultado gravado:**
- aa04 e aa63 críticas;
- aa33 desnecessário;
- aa49 com as cláusulas 3 e 4.

**Na r36:** 0 críticas, 0 desnecessários e 0 pendências comerciais. Fica em
`interpretacoes-gravadas.test.mjs`.

**Testes da rodada 36 (`walle.test.ts`):**
- aa04 nas 24 ordens possíveis da leitura do modelo, com paráfrases;
- pessoa acima do limite;
- contraexemplos do limite;
- entrada (aa63, paráfrases), prorrogação + entrada (aa33), término/multa + entrada (a cláusula continua);
- entrada + pergunta sem cadastro (continua com a equipe);
- capacidade (aa49), com contraexemplos de aumento e de criança;
- partição de mensagens longas, inclusive no resolvedor.

## 4. Limites conhecidos (não resolvidos aqui)

No **modo regras**, o h36 continua com as mesmas 5 críticas da candidata r35:
- aa29 (pausa);
- aa56 e aa57 (contratação por continuação);
- aa32 (oferta condicional "caso aceitem 2.800");
- aa08 (instrução atribuída à gerente).

Esta correção é localizada na IA e não as altera. O modo regras é o caminho sem modelo, portanto **não há liberação do
canal com essas falhas conhecidas**.

## 5. Gates, congelamento e holdout

Os gates rodam no SHA integrado. Depois, um holdout novo (h37), escrito por subagente independente, é lacrado antes de
ser lido.

O registro dos resultados fica na branch de ferramentas e na de evidências: um documento novo nesta branch mudaria o
SHA medido.
