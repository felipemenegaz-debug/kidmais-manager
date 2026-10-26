# Renovação Fundador agendada (B-9): implementação local (25/10/2026)

**Estado: IMPLEMENTADO LOCAL, sem commit. A rodada 1 foi REPROVADA (três P2) e a rodada 2 também (P2-N1 e P3-T1); a rodada 3 de correções aguarda nova revisão.** Clone `kidmais-manager-renovacao-agendada-20261025`, branch `codex/renovacao-agendada-20261025`, sobre staging `54598a92`.
- Nenhum cron, variável, deploy, push ou execução remota.
- **Aguarda revisão independente.**

**Base:**
- plano `docs/PLANO_RENOVACAO_AGENDADA_B9_20261025.md`, rev. 3.1, APROVADO COM RESSALVAS;
- decisões de Felipe D-B9-1 a D-B9-5, de 25/10:
  - cron próprio, de hora em hora;
  - modo agendado sem revisão nem suspensão;
  - remetente do produto, sem cópia;
  - aviso entre 33 e 30 dias antes.

## O que mudou

### Rotina (`lib/assinatura/renovacao-fundador.ts`)

**Janela de aviso (D-B9-5):**
- `AVISO_ANTECIPADO_DIAS = 3` e `inicioJanelaAviso(pdr)` = `pdr − 33`, aplicados **nos dois pontos**: o retorno antecipado do registro `PENDENTE` e o caminho sem aviso enviado.
- A janela perdida continua sendo `hoje > pdr − 30`.
- Vale também para a ferramenta restrita, porque é a regra comercial.
- Os Termos já dizem "aviso de pelo menos 30 dias", então não há mudança de documento legal.

**`modoAgendado` (D-B9-3), opcional em `DepsRenovacao`:**
- `REVISAO_EXISTENTE` logo depois de `ler`, antes de vigência, rede ou escrita;
- revisão direta da identidade inicial → `ALERTA_IDENTIDADE_DIVERGENTE`;
- `PRIMEIRO_PAGAMENTO_DIVERGENTE` → alerta, sem suspensão;
- helper `revisao` → `ALERTA_<motivo>`, sem gravar e sem suspender;
- confirmação final separada em identidade e situação: identidade divergente → alerta com estado preservado; inativa ou removida com identidade conferida → `CANCELADA`.

**Sem `modoAgendado`** (ferramenta restrita e executável manual): o comportamento anterior continua igual, salvo a janela.

### Execução agendada (`lib/assinatura/renovacao-agendada.ts`, novo)

- **Classificação de todos os resultados (§2.5):**
  - OK;
  - simulação: só em `simular`;
  - pendente: 0 na primeira vez;
  - **intenção repetida**: entrou em `AVISANDO`/`APLICANDO` e saiu igual → 2;
  - alerta;
  - desconhecido → 2.
- **Uma única aquisição da trava por empresa** envolve a leitura do estado de entrada, o processamento e a leitura de saída. A rotina recebe um `travar` que só executa o trabalho, sem segunda aquisição.
- **`precoRemoto` pela releitura (§2.6):** assinatura `REGULAR`/`FUNDADOR`/`DIVERGENTE`/`NAO_LIDA`, contagem das parcelas da renovação e `confirmado`. Leitura que não é conclusiva → alerta (`PRECO_NAO_LIDO`).
- **`avisosNaJanela` (§2.7):** conta registros sem `avisoEnviadoEm` (não o estado ≠ `AVISADA`) entre −33 e −30. No último dia, o valor é alerta (`AVISO_PENDENTE_ULTIMO_DIA`).
- **Paradas (§2.2):**
  - `EXECUCAO_SOBREPOSTA` (0);
  - `TRAVA_PERDIDA`, quando a trava some ou a conexão cai antes da próxima empresa (2);
  - `LIMITE_EXECUCAO`, 30 min para **iniciar** empresas (2);
  - `INTERROMPIDA` (1).
- **Relatório sanitizado:** id interno da empresa, códigos e contagens.

### Entrada do cron (`scripts/assinatura-renovacao-cron.cjs`, novo)

**`planejar(env, argv, agora)`, sem conectar:**
- `KIDMAIS_DEPLOY_ENV` precisa ser `staging` ou `production`;
- `KIDMAIS_RENOVACAO_MODO` = `aguardando` (null, sem exigir alvo), `simular` ou `aplicar`;
- staging com alvo e sandbox exatos;
- production com o alvo de produção (`alvoDeProducao` da reconciliação);
- `aplicar` exige `EMAIL_PROVIDER=resend`;
- **production só aplica a partir de `KIDMAIS_RENOVACAO_PRODUCAO_DESDE`** (data de Brasília). Antes dela, ou com a data ausente ou inválida, o modo é rebaixado para `simular`;
- `--empresas` e `--agora` só em staging; `--agora` exige `--empresas`.

**`executarCron(cfg, f)`, com dependências injetáveis:**
- pool e **conexão dedicada** da trava global (`pg_try_advisory_lock(hashtext('kidmais:renovacao-cron'))`, de sessão, liberada no `finally` e ao fechar a conexão);
- identidade e TLS das duas conexões conferidos;
- seleção global (`empresasParaRenovacao`) e, com `--empresas`, a **interseção**: fora dela → `NAO_ELEGIVEL`;
- **guarda de fixture reutilizada** (`conferirAgoraSomenteFixtures` + `ehFixtureHomologacao`) antes de qualquer processamento;
- simulação com o provedor protegido (`provedorDaExecucao`).

**`main`:**
- Asaas do ambiente esperado e Resend configurado em `aplicar`;
- SIGTERM liga a interrupção, em melhor esforço;
- JSON sanitizado com `rebaixadoParaSimular`;
- código 0, 1 ou 2.

### Outras mudanças

- **Tela:** "O aviso será enviado por e-mail com pelo menos 30 dias de antecedência." (era "30 dias antes").
- **CI:** `scripts/assinatura-renovacao-cron.test.cjs` foi incluído no passo do `ci.yml` que já roda `assinatura-cron.test.cjs`. O check estático só coleta `*.test.ts`.
- **Seleção PostgreSQL:** `lib/assinatura/renovacao-agendada.postgres.test.ts` no modelo 097.
- **Cron da reconciliação e `package.json`:** intocados. Há teste que garante que a entrada nova não é chamada por eles.

## Testes

**Sem mutação, no clone de trabalho:**
- **Rotina** (`lib/assinatura/renovacao-fundador.test.ts`): 30/30, sendo 11 novos.
  - Modo agendado: `REVISAO` existente sem rede; identidade divergente na linha 97 e na confirmação final (com `APLICANDO` preservado); inativa comprovada vira `CANCELADA`; o caso da revisão (próximo vencimento inválido depois do aviso) sem revisão nem suspensão; parcela `RECEIVED` depois do PUT; primeiro pagamento divergente sem suspensão; a ferramenta restrita mantém o comportamento anterior.
  - Janela: −34, −33, −31, −30 e −29, com registro `PENDENTE` preexistente e sem registro; falha às 23h50 do −33 e retentativa às 00h10 do −32 com a mesma chave; 23 h − 1 ms, 23 h e 23 h + 1 ms; meia-noite do −30 dá `ENVIO_INCERTO` em `AVISANDO` e, no −29, alerta.
- **Execução agendada** (`lib/assinatura/renovacao-agendada.test.ts`): 8/8. Cobre a tabela completa de classificação, a releitura de preço (retomada com assinatura regular e parcela Fundador; `NAO_LIDA`), a trava única por empresa, o contador por `avisoEnviadoEm` com `APLICANDO`/`REGULAR` no −30, a sobreposição, a trava perdida (falsa e por exceção), o limite, a interrupção, `NAO_ELEGIVEL` e o relatório sanitizado.
- **Entrada** (`scripts/assinatura-renovacao-cron.test.cjs`, no passo do `ci.yml`): 6/6. Cobre as recusas do `planejar`, o rebaixamento de production (inclusive 23h30 da véspera), os argumentos de homologação e a **guarda de fixture com alvo remoto** (banco falso).
- **PostgreSQL descartável** (`lib/assinatura/renovacao-agendada.postgres.test.ts`, modelo 097, repositório real, entrada real em **processo filho**): 7/7.
  1. Seleção global (só Fundador confirmado) e interseção com o filtro; simulação sem nenhuma escrita.
  2. Fluxo aplicar: registro, −34 aguarda, −33 avisa uma vez, última parcela, preço regular.
  3. Sobreposição com a trava presa em outra sessão.
  4. `pg_terminate_backend` da conexão da trava no meio: `TRAVA_PERDIDA` sem iniciar a segunda empresa.
  5. Interrupção entre empresas.
  6. Resend indisponível (0), repetição (2 por intenção pendente) e resposta perdida com reenvio pela mesma chave.
  7. **SIGKILL real** durante o envio e durante o PUT: a trava cai com a conexão, e a retomada pela releitura chega a `REGULAR` sem repetir o PUT da assinatura.
- **Bateria PostgreSQL completa:** 148 arquivos e 851/863, com 11 pulados de propósito e 1 falha: `lib/agenda/aplicador-098.postgres.test.ts`.
  - É um teste de concorrência sensível a tempo ("aplicador esperando o lock da 098"), sem relação com o B-9, e rodou junto com um `npm ci` paralelo.
  - **Reexecutado sozinho: PASS.** As suítes afetadas (benefício, 090, 096, comercial e a nova) passaram.
- **CI local:** os 24 passos com saída 0. Check estático 3619/3619 com lint, TypeScript e build; o passo do cron tem 61/61, com o teste novo incluído.

**Mutantes em cópia isolada** (`mutacao-renovacao-agendada-20261025`: clone LF, `npm ci` e commit de base local e descartável; clone de trabalho intocado). Controle positivo antes e depois com saída 0, e cópia limpa ao fim. **19/19 detectados:**
- M01, linha 97 grava `REVISAO`: unit;
- M02, helper grava ou suspende: unit;
- M03, linha 178 vira `CANCELADA`: unit;
- M04, `REVISAO_EXISTENTE` depois da rede: unit;
- M05, janela só nas linhas 128–131: unit;
- M06, abertura em −34: unit;
- M07, perda só em −28: unit;
- M08, suspensão no primeiro pagamento: unit;
- M09, sem trava global: PG (sobreposição e demais);
- M10, trava em conexão do pool: PG;
- M11, continua depois de perder a trava: unit e PG 4;
- M12, `aguardando` conecta: unit;
- M13, production aplica antes da data: unit;
- M14, aplicar sem e-mail: unit;
- M15, `--agora` sem guarda de fixture: unit;
- M16, desconhecido sai 0: unit;
- M17, intenção repetida sai 0: unit;
- M18, preço não lido como confirmado: unit;
- M19, contador pelo estado: unit.

**Controle M20** (linha inofensiva): sobreviveu, como esperado.

## Limitações

- **SIGTERM no Windows:** um `kill('SIGTERM')` termina o processo sem passar pelo tratador, então a interrupção foi testada pela flag que o tratador liga (caso 5). O SIGTERM do Linux no Render não foi exercitado localmente. O SIGKILL foi testado de verdade, em processo filho (caso 7).
- **Perda da trava:** testada terminando a conexão dedicada no servidor (`pg_terminate_backend`), não por falha de rede.
- **Guarda de fixture com alvo remoto:** testada com banco falso. No PostgreSQL local a guarda não se aplica, por desenho.
- **Provedor e e-mail falsos:** não houve chamada ao Asaas nem ao Resend. A homologação em sandbox pela entrada nova é o passo 2 da implantação de staging, que depende de autorização.
- **Contagem exata de repetição:** fora do escopo (§6 do plano). O critério implementado é "intenção que persiste".
- **087 (e-mails de cobrança):** a integração pelo webhook fica para quando as duas frentes se encontrarem.

## Rodada 2: correções da revisão independente (26/10/2026)

**A revisão da implementação foi REPROVADA, com três P2 no executor**, reproduzidos pelo revisor com dependências falsas. Todos os três foram corrigidos em `lib/assinatura/renovacao-agendada.ts`:
- **P2-1, exceção depois do PUT:** a falha de `processar` é capturada **dentro** da trava por empresa, e as releituras de estado e de preço acontecem antes de liberá-la. Com o PUT feito e a resposta perdida, o relatório mostra `ERRO_REPROCESSAVEL`, `estadoSaida: APLICANDO` e `precoRemoto` relido.
- **P2-2, `REVISAO_EXISTENTE` com rede:** o executor não chama `relerPreco` para esse resultado. A execução inteira fica sem rede para o registro, `precoRemoto: null`.
- **P2-3, releitura descartada sem alerta:** coleção nova `emAndamento` no relatório, com empresa, estados e `precoRemoto` de quem já avisou (`AVISADA`, `APLICANDO`, `REGULAR`…) e não está em alerta. Ela não vira alerta.

**Endurecimentos sugeridos na revisão:**
- `aindaMinha` confere a **chave exata** da trava global (`objsubid = 1` e `(classid << 32) | objid = hashtext(chave)`), não só "alguma trava da sessão";
- teste da verificação da trava **antes da primeira empresa**;
- caso 4 do PostgreSQL sincronizado pela marca `NO_PROCESSO`, sem a espera fixa de 1,5 s;
- contratação cancelada na seleção global (caso 1);
- o filho conta as leituras do provedor por assinatura (caso 9).

### Resultados reais da rodada 2

- **Execução agendada:** 12/12, com 4 novos: P2-1 (releitura dentro da trava depois da exceção), P2-2 (zero chamadas ao provedor), P2-3 (`emAndamento` com código 0) e a trava perdida antes da primeira empresa. **Rotina:** 30/30. **Entrada:** 6/6.
- **PostgreSQL da suíte nova:** 9/9 no clone de trabalho (`b9-p2-rodada1`). Os dois casos novos são 8 (PUT com resposta perdida, relido) e 9 (`REVISAO` com aviso enviado, sem nenhuma leitura do provedor). A seleção ganhou a contratação cancelada, e o caso 2 confere `emAndamento`.
- **Mutantes** (cópia isolada, base `2710cba6` sincronizada com o trabalho: 20 arquivos com sha256 iguais):
  - controle positivo **antes**: unit 0, PG 0;
  - **23/23 detectados**: M01–M19, já da rodada 1, mais M21 (P2-1), M22 (P2-2), M23 (P2-3) e M24 (trava não conferida antes da primeira empresa);
  - **M25** (ignorar a chave exata) **sobreviveu**: é endurecimento, e os cenários só têm essa trava na sessão dedicada. É uma limitação declarada;
  - **M20** (controle inofensivo) sobreviveu, como esperado;
  - **Controle depois:** unit 0. O **PG falhou uma vez**: no caso 4, o processo filho não conectou ao cluster em 10 s ("timeout expired") com a máquina lenta (caso 2 em 7,6 s, caso 6 em 8,9 s). A cópia estava limpa e na base. **Repetido duas vezes na mesma cópia: 9/9 e 9/9, saída 0.** Os logs são `final-pg.log`, `final-pg-repeticao-1.log` e `final-pg-repeticao-2.log`.
- **CI local:** os 24 passos com saída 0; check estático 3623/3623.
- **Bateria PostgreSQL completa:** **148 arquivos, 854/865, 0 falhas, 11 pulados de propósito; saída 0** (`b9-r2-completa`), rodada sozinha, sem carga paralela. O `aplicador-098`, que falhara por tempo na rodada 1, passou nesta.

### Limitações da rodada 2

- O caso 4 depende de conectar em até 10 s (o `connectionTimeoutMillis` do executor). Sob carga pesada, ele falhou uma vez pelo tempo de conexão, não pela lógica.
- O M25 sobrevive: falta um cenário com outra trava de aviso na mesma sessão dedicada, que não existe no código.
- Continuam valendo as limitações da rodada 1 (veja a seção "Limitações"), com estas precisões do revisor:
  - o filho chama `executarCron`, não `main`, então o tratador real de SIGTERM não é exercitado;
  - no Windows, `kill('SIGKILL')` prova o encerramento abrupto, não a semântica de sinais do Linux;
  - o e-mail falso registra tentativas e chaves; não prova a deduplicação nem a entrega do Resend.

## Rodada 3: correções da revisão da rodada 2 (26/10/2026)

**A revisão da rodada 2 foi REPROVADA, com P2-N1 e P3-T1:**
- **P2-N1, corrigido** (`lib/assinatura/renovacao-agendada.ts`): uma falha na releitura do banco depois de um resultado normal liga `estadoNaoLido`, e o item vira **alerta `ESTADO_NAO_LIDO`, código 2**. O resultado original e o estado de entrada são preservados, o estado de saída fica `ILEGIVEL` e não há `precoRemoto` (nada é inventado). Uma falha de processamento continua `ERRO_REPROCESSAVEL`, com motivo próprio.
- **P3-T1, coberto:** a consulta da chave exata virou a constante exportada `SQL_TRAVA_MINHA` (`scripts/assinatura-renovacao-cron.cjs`). O caso PostgreSQL 10 prende **outra** trava de sessão e confere: só a outra → 0; as duas → 1; perdida a nossa com a outra ainda presa → 0; chave de sinal oposto → 0.

### Resultados reais da rodada 3

- **Unitários:** execução 13/13 (P2-N1 com `AGUARDANDO_CONFIRMACAO_PRECO`/`APLICANDO`, `AGUARDANDO_ULTIMA_PARCELA`/`AVISADA` e `AGUARDANDO_AVISO`/`PENDENTE`, mais o controle de falha de processamento seguida de falha na releitura); rotina 30/30; entrada 6/6. No total, 49/49.
- **PostgreSQL da suíte nova:** 10/10 (`b9-r3-pg`).
- **Mutantes** (cópia isolada, base `7564d3ee` sincronizada: 20 arquivos com sha256 iguais; `mutantes-b9-r3/`):
  - controle positivo **antes**: unit 0, PG 0;
  - **25/25 detectados**: M01–M19, M21–M24, **M25** (chave exata ignorada: PG caso 10) e **M26** (P2-N1 sem o alerta: unit, já no caso `AGUARDANDO_CONFIRMACAO_PRECO` com entrada `APLICANDO`);
  - o controle "falha de processamento e depois falha da releitura" é alerta com ou sem o M26, porque já é `ERRO_REPROCESSAVEL`, então não é ele que distingue o mutante;
  - **M20** (controle inofensivo) sobreviveu;
  - **controle positivo depois**: unit 0, PG 0.
- **CI local:** os 24 passos com saída 0; check estático 3624/3624 (`ci-local-b9-r3`).
- **Bateria PostgreSQL completa** (`b9-r3-completa`, rodada **sozinha**, sem carga paralela): **148 arquivos, 854/866, 1 FALHA, 11 pulados; saída 1.**
  - A falha é `lib/agenda/aplicador-098.postgres.test.ts`: "precheck do aplicador visto; terminou antes com: null". O teste sonda o `pg_stat_activity` por cerca de 400 × 10 ms à espera do PRECHECK do aplicador e falha quando o aplicador demora mais do que isso para chegar lá.
  - O B-9 não altera nenhum arquivo da agenda, da 098 nem desse teste.
  - **Reexecutado sozinho logo depois: PASS** (`b9-r3-aplicador098`).
  - **Histórico deste teste nas baterias do B-9:** rodada 1 falhou (com `npm ci` paralelo) e passou sozinho; rodada 2 passou na bateria; rodada 3 falhou na bateria sozinha e passou sozinho.
  - A causa exata não foi provada. É um teste sensível a tempo, e **a bateria completa desta rodada não está verde**.

### Limitações da rodada 3

- A bateria completa da rodada 3 tem 1 falha intermitente fora do escopo do B-9 (acima). Ela não é declarada verde.
- O caso 10 testa a expressão com travas reais na mesma sessão. Uma falha de rede na conexão dedicada continua testada só por `pg_terminate_backend`.
- Continuam valendo as limitações das rodadas 1 e 2.

## Implantação

Não iniciada. Segue a §4 do plano: PR → homologação no Shell de staging com fixture → cron em `aguardando` → `simular` → `aplicar`; production depois da promoção e da data do B-5. Cada passo exige autorização própria.
