# Candidata LOCAL r37 — seleção de assunto e fonte por significado (08/10/2026)

Tudo é local. Não houve push, merge remoto, deploy, migration remota nem SQL em banco persistente.

**Preservados:**
- a r36 (`whatsapp/candidata-walle-r36-20261008`, lacre `b738364`) e as evidências dela;
- a medição em regras do h37 e a IA real r36 × h37 (execução `muzac1wv`, válida, 65/65 chamadas);
- a r35, a PR #80 (`a9e2d55`), a fase B (`1f938d2`), as demos, o Painel, staging e produção.

O estado dos bancos de staging e de produção é **"estado não verificado"**.

## 1. Branch e base

`whatsapp/candidata-walle-r37-20261008` (worktree `kidmais-candidata-r37`), criada de `b738364`. Migrations, numeração
(060, 065, 073–075) e arquivos de staging: iguais à r36.

## 2. O que a IA real r36 × h37 mostrou

| | Regras | IA |
|---|---|---|
| Críticas | 1 (aa39, R) | **2 (aa36, aa69, V)** |
| Comerciais | 24/28 | 22/28 |
| Encaminhamentos desnecessários | 2 | 5 |

- **aa36 e aa69 (IA):** a pergunta era duração ("quantas horas de festa?") ou chegada ("que horas o pessoal pode começar a
  chegar?"). O modelo marcou CONTRATO/HORARIOS, e a cláusula 8 entrou inteira, com prorrogação e multa.
- **aa57 (IA, a régua não acusou):** "aguenta 130 convidados?" recebeu as cláusulas 3 e 4 inteiras.
- **aa38 (IA):** "o rapaz do atendimento falou que tinha vaga, continua livre? … meia horinha a mais, quanto paga?". O
  contrato próprio só do modelo não foi afastado porque a triagem do JEV leu "quanto paga" como pagamento.
- **aa61 (IA):** "nossa reserva pra festa é uns 4 mil" foi lido como festa reservada. A passagem gerou a cascata
  aa62–aa64.
- **Regras:**
  - aa39: "vcs fariam … por 5 mil?" não foi para a equipe como negociação;
  - aa34: "a lista aumentar" ficou sem fonte;
  - aa38: "uma meia horinha a mais" não reconhecida;
  - aa68: troca de tema com "kkk" recebeu o menu;
  - aa69: só anotou o período, sem dizer o horário de entrada;
  - aa53: "sim, ficou ótimo" recebeu o menu;
  - aa79: cardápio dispensado reenviado, também na IA.

## 3. O que mudou (por significado)

**Seleção da cláusula vista só pelo modelo** (`revalidarEntendimento`). A marca CONTRATO não basta:
- **Horários (cláusula 8):** só quando a pergunta trata de prorrogar, hora a mais, terminar, sair, "até que horas",
  tolerância, multa, começar mais cedo ou adiantar. A duração vem do pacote; a entrada, dos períodos cadastrados.
- **Convidados e cortesia (cláusulas 3 e 4):** só com aumento, excedente, criança, cortesia ou quem conta como pagante.
  A capacidade ("cabe", "comporta", "aguenta", "suporta", "acomoda") vem do pacote.
- **Lista geral:** só quando a pergunta pede condição, contrato ou regra.

**Regras:**
- **Entrada dos convidados:** reconhecida por quem chega ("o pessoal", "a galera", "a família", "as visitas") e por como
  se pergunta ("a partir de quando", "horário de chegada").
- **Perguntas legítimas de horário:** "quanto custa uma hora a mais", "tem tolerância se passar do horário", "começar mais
  cedo", "dá pra estender mais uma?", "até que horas podemos ficar?". "O premium tem uma hora a mais que o completa?"
  continua sendo comparação de pacotes.
- **Negociação:**
  - pergunta de aceite ao valor com dados no meio ("vcs fariam o completa … por 5 mil?", "dá pra fazer … por 2.800?");
  - "caso/se aceitem/toparem" + valor;
  - o valor precisa ser dinheiro.
- **Contrato:** "a lista aumentar", "incluir mais convidados".
- **Troca de tema** com interjeição ("mudou de ideia kkk agora quer Frozen").
- **Confirmação com avaliação:** "sim, ficou ótimo", "gostei", "amei".
- **Cardápio dispensado:** não volta. Com pergunta de item, o item é respondido sem o cardápio inteiro nem o PDF (h14
  g26).
- **Do h36 em regras, com o mesmo significado:**
  - aa29: pausa sem "parar" ("segura as mensagens por enquanto"), em silêncio, com a marca;
  - aa56 e aa57: "fecha pra mim o da noite";
  - aa08: "a gerente me disse que pra mim a taxa de mudança de data sai de graça";
  - aa32: "caso aceitem 2.800".

**Política de combinação** (documentada no código):
- **Novo critério RESERVA_FINANCEIRA.** "Nossa reserva pra festa é uns 4 mil" é orçamento e afasta só o contrato próprio
  visto pelo modelo.
  - Nunca vale com data reservada, festa marcada, contrato, pagamento ou pedido de condição no resto do texto.
  - A resposta leva a frase de proteção.
- **`juntarSinais`:** o "pagamento" da triagem do JEV não vale no preço de uma condição ("quanto paga a meia hora a
  mais?").
  - Só quando as regras locais não marcam pagamento.
  - Só sem boleto, parcela, sinal, pix ou "minha festa" na mensagem.
  - Mesmo padrão da r26 para a reclamação preventiva.

## 4. Régua: mudança de classificação (justificada à parte)

As medições originais não mudam: os arquivos gravados continuam como estão, e o comparador lê a régua da versão que
gerou cada um.

**Única mudança:** duas verificações novas, **não críticas**, no detector `irrelevante`. Os dois defeitos foram achados
na leitura e nenhuma categoria os pegava:
1. **"cláusula de convidados sem condição pedida":** cláusula 3 ou 4 citada quando o rótulo não pede CONTRATO nem
   CONTRATO_PROPRIO.
2. **"cardápio/tabela dispensado reenviado":** o cliente dispensa o material e ele é mandado de novo.

**Calibração em 803 resultados gravados:**
- nenhuma crítica e nenhuma comercial mudam;
- os irrelevantes novos são, todos, defeitos reais:
  - IA h37 aa57 e IA h36 aa49;
  - h4 v18 e h7 y22 (cláusula 4 numa pergunta de capacidade);
  - h7 y45 (cláusula numa tentativa de instrução);
  - h14 g26 (PDF do cardápio dispensado reenviado, presente até a r36);
  - h37 aa79.

Testes e mutações novos.

A régua da entrada (`ENTRADA_REGUA`) já reconhecia "que horas … chegar" e não mudou.

## 5. Reprodução sem rede

- **Interpretações gravadas da IA r36 × h37:** em `interpretacoes-ia-gravadas-20261008.json`.
  - Leitura refeita (tema e trecho) em aa34, aa36, aa38, aa57, aa61 e aa69.
  - No código da r36, reproduz o resultado gravado.
  - Na r37: 0 críticas, 0 desnecessários, 0 pendências comerciais e 0 irrelevantes.
- **h36 e h37 entram na regressão em regras** (0 críticas, 0 pendências).

## 6. Limites conhecidos

- **"A festa vai até que horas?"** ainda fica sem fonte. O período responde, mas a regra não reconhece essa forma. Falha
  anterior, não tratada aqui.
- **h37 e h36 foram lidos:** são regressão, não medição. A medição desta versão é o holdout novo, lacrado depois do
  congelamento.

## 7. Gates, congelamento e holdout

Os gates rodam no SHA integrado. Depois, um holdout novo (h38), escrito por subagente independente, é lacrado antes de
ser lido.

O registro fica na branch de ferramentas e na de evidências.
