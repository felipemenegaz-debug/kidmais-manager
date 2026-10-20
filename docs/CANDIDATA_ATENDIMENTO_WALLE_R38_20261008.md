# Candidata LOCAL r38 — recusa com reclamação, tema, dispensa invertida e "outro horário" (08/10/2026)

Tudo é local. Não houve push, merge remoto, deploy, migration remota nem SQL em banco persistente.

**Preservados:**
- a r37 (`whatsapp/candidata-walle-r37-20261008`, lacre `e0dade4`) e a medição original do h38 em regras;
- a r36, a r35, a PR #80 (`a9e2d55`), a fase B (`1f938d2`), as demos, o Painel, staging e produção.

A IA real da r37 × h38 **não foi executada** (o livro de 08/10 não mudou).

O estado dos bancos de staging e de produção é **"estado não verificado"**.

## 1. Branch e base

`whatsapp/candidata-walle-r38-20261008` (worktree `kidmais-candidata-r38`), criada de `e0dade4`. Migrations e numeração:
iguais à r37.

## 2. O que mudou

**aa21 (prioridade).**
- **Antes:** "gente vcs são muito insistentes, toda semana isso, até quando? não quero receber mais nada de vcs" virava
  pausa, porque a reclamação sobre a insistência contava como "outro pedido".
- **Agora:** essas palavras ("são", "muito", "tão", "demais", "irritantes", "invasivos", "toda semana isso", "até
  quando") entram no vocabulário de desabafo. A recusa inequívoca vira **bloqueio definitivo**, com a reclamação
  registrada para a equipe (`registroDoBloqueio`) e nada enviado ao cliente.
- **Continuam como estavam:**
  - pausa temporária ("por ora não me mandem mais nada, mais pra frente eu procuro") — equipe em silêncio, com a marca;
  - recusa com pergunta de verdade ("… só antes me fala o endereço") — equipe em silêncio;
  - reclamação de assunto ("vcs são muito caros, até quando?") — equipe;
  - reclamação sem pedido de parar — não é pedido de parar.

**aa62 (e h35 aa67): troca de tema sem verbo de mudança.** "na verdade ela agora quer a Wandinha kkk", "pensando bem,
ela quer a Wandinha" e "agora ele prefere o Sonic" anotam o tema novo. Período e pacote ("agora ela quer o segundo
horário", "prefere a Completa") não viram tema.

**aa02: material dispensado em ordem invertida.** "o pdf do cardápio eu já tenho, não precisa mandar de novo" e "o
cardápio eu já salvei" não mandam o cardápio. O mesmo vale para a tabela. "O pdf do cardápio não abriu, manda de novo"
continua reenviando.

**aa78: "e no outro horário?" sem período na conversa.**
- Segue o assunto em andamento (preço ou agenda) e **pergunta o período** (e a data, se faltar).
- Não reenvia material e não manda o menu.
- Com o período conhecido, o outro horário continua calculado (rodada 34).

## 3. Régua: correção do aa03 (registrada à parte; medição original mantida)

**Conferência contra as fontes.**
- Mensagem: "no horário do almoço o pessoal pode entrar a partir de que horas? e até que horas dá pra ficar?".
- A resposta da r37 trouxe a cláusula 8 do modelo vigente (início e término obedecidos, prorrogação, multa por
  permanência) e "No primeiro horário (11h às 15h), a entrada dos convidados é a partir das 11h", pelos períodos
  cadastrados (PERIODOS_AGENDA).
- As duas partes da pergunta têm fonte. **É erro da régua.**

**Correção:**
- **"Até que horas … ficar / a festa / termina"** (e "tolerância", "mais cedo", "antecipar") passa a ser assunto de
  horários.
- **"O pessoal", "a galera", "a família", "as visitas"** passam a ser sujeitos da entrada.
- **Ganho de cobertura:** a dispensa invertida, achada na leitura do h38 aa02, entra no detector não crítico
  `irrelevante`.

**Calibração em 805 resultados** (r37 × r38): só o h38 muda.
- aa03 sai das críticas e das comerciais;
- aa02 passa a ser "cardápio dispensado reenviado".

A medição original (`candr37-e0dade4-holdout38-regras.json`) e o registro em `falsos-positivos-regua.json` ficam como
estão. Há testes e mutações novos.

## 4. Reprodução e regressão

- **h38 entra na regressão em regras** (0 críticas, 0 pendências; o h38 foi lido, então é regressão, não medição).
- **h35 aa67** sai das pendências não críticas: corrigido pela troca de tema.

## 5. Gates, congelamento e holdout

Os gates rodam no SHA integrado. Depois, o holdout 39 é escrito por subagente independente e lacrado antes de ser lido.

O registro fica na branch de ferramentas e na de evidências, esta com manifesto.
