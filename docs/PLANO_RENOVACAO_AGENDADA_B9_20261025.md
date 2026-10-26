# Plano B-9 — renovação Fundador agendada (25/10/2026, revisão 3.1)

**Estado:** PLANO **APROVADO COM RESSALVAS** pela revisão independente (rev. 3, 25/10), pronto para implementação local. O P3 do contador e a orientação de trava única já estão incorporados nesta rev. 3.1. **Decisões D-B9-1 a D-B9-5 aceitas por Felipe em 25/10; implementado localmente, ver `docs/RENOVACAO_AGENDADA_B9_20261025.md`.** Antes desta aprovação, era PLANO para revisão. Nenhum código de agendamento foi escrito. Nenhum cron, variável, deploy ou execução remota.

**Histórico:**
- **Revisão 1 REPROVADA:**
  - P1: "simular antes" não impede revisão nem suspensão;
  - P2: janela de 23 h;
  - P2: homologação e reversão;
  - P3: arquivos da 087.
- **Revisão 2 REPROVADA:** a direção D-B9-1 a D-B9-5 foi aceita tecnicamente, mas o roteiro tinha cinco P2:
  - a janela ampliada não alcançava registro `PENDENTE` já existente;
  - escapavam a revisão direta (linha 97) e o `CANCELADA` por identidade divergente (linha 178);
  - a classificação estava incompleta e a detecção de repetição era imprecisa;
  - a homologação não tinha guarda de fixture nem prova da seleção global;
  - `precoParcial` não sobrevivia à retomada.
- **Esta revisão** fecha os cinco (§2.3 a §2.6), fixa a D-B9-4 sem cópia e incorpora as observações sobre meia-noite, trava, SIGTERM e retentativa.

**Origem:** pedido de Felipe em 25/10; item B-9 do plano de promoção de production (`PLANO_PROMOCAO_PRODUCTION_20261025.md`, §7.2). É área crítica (`CLAUDE.md` §19), porque envolve e-mail real e mudança de valor no Asaas.

## 1. Situação atual (código de staging `54598a92`)

`processarRenovacao` (`lib/assinatura/renovacao-fundador.ts`). As linhas abaixo citam esse arquivo.

**Aviso:**
- só no dia `primeiraDataRegular − 30`, em Brasília. Um registro `PENDENTE` sai antes da rede até esse dia (linha 95), e quem ainda não tem registro passa pelas linhas 128–131;
- intenção `AVISANDO` antes do envio; retentativa com a mesma chave enquanto não passam 23 h da **primeira** tentativa (`aviso_tentado_em` é gravado com `COALESCE`; linha 134).

**Escritas de `REVISAO`:**
- pelo helper `revisao(...)` (linhas 116–126, com suspensão condicional);
- **direta** na identidade divergente inicial (linha 97).

**Suspensão (`suspenderGeracao`):**
- no helper (linha 124);
- direta em `PRIMEIRO_PAGAMENTO_DIVERGENTE` (linhas 106–107).

**Escritas de `CANCELADA`:**
- empresa não vigente (linhas 89–91);
- assinatura removida ou inativa com identidade conferida (linhas 98–100 e 154);
- **identidade divergente na confirmação final (linha 178), depois de possíveis PUTs**.

**Simulação × aplicação:** a simulação para em `ENVIARIA_AVISO` (linha 136) e em `ATUALIZARIA_PRECO` (linha 165). A aplicação continua e pode chegar a revisão e suspensão.

**Guarda da 075:** `(aviso_enviado_em em Brasília)::date <= primeira_data_regular − 30`, com `aviso_dias = 30`. O aviso antecipado é aceito; um aviso aceito depois da meia-noite do dia −30 é recusado pelo banco.

**Chamadores:** só `scripts/assinatura-renovar.cjs` (sandbox e banco local), `scripts/assinatura-renovar-restrito.cjs` (manual, por lista, recusa production, `--agora` só para fixtures `ehFixtureHomologacao`: código `hml-` e nome começando por "TESTE ") e a homologação. Nenhum cron.

### 1.1 Prazo e condições herdadas do plano de promoção

- **Prazo:** o B-9 implantado e com a primeira execução real conferida antes da **menor `primeiraDataRegular` − 30 − 14 dias**, data do B-5 (E1) calculada por `primeiraRenovacaoRegular`.
- **Cobertura:** todas as concessões **confirmadas**.
- **Parada:** com datas ausentes ou prazo vencido, a promoção para.
- **Janelas já perdidas:** decisão de Felipe antes do `aplicar` em production. As alternativas são contato manual e manter o desconto ou cobrar o regular com aviso novo, sem alteração silenciosa.
- **Campanha 090:** bloqueada até o B-9 (D-COM-4).
- **Frequência:** o plano de promoção diz "diariamente". Este plano propõe **de hora em hora**; a harmonização é uma ação futura de quem mantém aquele plano.

## 2. Desenho

### 2.1 Entrada nova, em cron próprio (D-B9-1)

`scripts/assinatura-renovacao-cron.cjs`, num serviço de cron próprio por ambiente. A reconciliação fica intocada.

**`planejar(env, argv)`, sem conectar:**
- `KIDMAIS_DEPLOY_ENV` precisa ser `staging` ou `production`.
- `KIDMAIS_RENOVACAO_MODO`:
  - `aguardando`: sai 0 sem conectar;
  - `simular`: transações `READ ONLY`;
  - `aplicar`: dentro do contrato da §2.3.
- **Staging:** alvo fixo (`validarAlvo`, `kidmais_staging_1z91`, TLS) e Asaas em sandbox.
- **Production:**
  - `aplicar` exige `KIDMAIS_RENOVACAO_PRODUCAO_DESDE=<AAAA-MM-DD>`. Antes dessa data, ou com ela ausente, o modo vira `simular`;
  - alvo como no aplicador 089 de production: identidade no servidor e TLS.
- **E-mail:** em `aplicar`, o Resend precisa estar configurado. Sem isso, recusa com código 1.
- **Argumentos de homologação**, `--empresas=<uuid,…>` e `--agora=<ISO>`:
  - só em **staging**, só pelo Shell (nunca no comando do cron);
  - `--agora` **exige** `--empresas`;
  - com `--agora` e `aplicar`, toda empresa da lista precisa existir e passar em `ehFixtureHomologacao`. A mesma regra e a mesma função da ferramenta restrita (`ehFixtureHomologacao`, em `lib/assinatura/renovacao-operacao.ts`, e `conferirAgoraSomenteFixtures`) são **reutilizadas**, não copiadas.

### 2.2 Execução, trava e interrupção

**Trava de execução numa conexão dedicada:**
- aberta antes de tudo: `pg_try_advisory_lock(hashtext('kidmais:renovacao-cron'))` (trava de sessão);
- sem a trava, a execução sai com `EXECUCAO_SOBREPOSTA` e código 0;
- liberação com `pg_advisory_unlock` no `finally` e, em queda do processo, pelo fechamento da conexão.

**Perda da trava:**
- a conexão dedicada tem `on('error')` e `on('end')`. Antes de cada empresa, a execução confere que a trava continua desta sessão (`pg_locks` com `pid = pg_backend_pid()`, na própria conexão dedicada);
- se a conexão caiu ou a trava não aparece, a execução **não processa mais nenhuma empresa** e sai 2 com `TRAVA_PERDIDA`;
- uma empresa já em processamento termina sob a trava por empresa (`travaPorEmpresa`), que continua protegendo a concorrência por empresa.

**Seleção:**
- `empresasParaRenovacao` (contratações Fundador confirmadas);
- com `--empresas`, a lista processada é a **interseção** com essa seleção. Um uuid da lista fora da seleção é relatado como `NAO_ELEGIVEL` e não é processado. O filtro só restringe, nunca amplia.

**Interrupção e limite:**
- **SIGTERM**, em melhor esforço: não começa outra empresa, libera a trava e sai 1. Não há garantia de terminar a empresa em andamento: a retomada precisa suportar **interrupção abrupta** (§2.6).
- **Limite de 30 min:** é o limite para **começar** novas empresas, não um prazo máximo garantido. Ao estourar, a execução sai 2 com `LIMITE_EXECUCAO`.

### 2.3 Contrato do modo agendado (D-B9-3)

Uma opção nova em `DepsRenovacao`: `modoAgendado: boolean`. Com ela verdadeira:

1. **Logo depois de `repo.ler`**, antes de qualquer outro passo (vigência, provedor, escrita): se o registro está em `REVISAO`, a rotina devolve `REVISAO_EXISTENTE` sem escrita e sem rede.
2. **Toda escrita de `REVISAO` vira alerta sem escrita**, mantendo o estado anterior (`PENDENTE`, `AVISANDO`, `AVISADA` ou `APLICANDO`):
   - os retornos do helper `revisao(erro)`, devolvidos como `ALERTA_<erro>`;
   - a escrita **direta** da linha 97, que vira `ALERTA_IDENTIDADE_DIVERGENTE`.
3. **Nenhuma suspensão:** nem a direta (linhas 106–107, que vira `ALERTA_PRIMEIRO_PAGAMENTO_DIVERGENTE`) nem a do helper.
4. **`CANCELADA` só para cancelamento ou inatividade comprovados:**
   - empresa não vigente (linhas 89–91);
   - assinatura removida ou inativa **com identidade conferida** (linhas 98–100, 154 e a parte `deleted`/`status` da linha 178);
   - **identidade divergente na confirmação final (linha 178) vira `ALERTA_IDENTIDADE_DIVERGENTE`**, preservando o estado, e não `CANCELADA`. A condição da linha 178 é separada em duas: identidade × situação.

**Efeitos permitidos no modo agendado:**

| Efeito | Quando |
|---|---|
| Criar o registro | primeira passagem depois da confirmação, com o primeiro pagamento conferido |
| `AVISANDO` → envio → `AVISADA` | dentro da janela (§2.4), destinatário válido, retentativa em até 23 h da primeira tentativa |
| `APLICANDO` → PUT do valor → PUT das parcelas da renovação | depois do aviso, com a próxima parcela já na renovação; só parcelas `PENDING`/`OVERDUE` com o valor Fundador |
| `REGULAR` | assinatura e parcelas confirmadas pelo valor regular |
| `CANCELADA` | só nos casos comprovados do item 4 |

Os alertas **não desfazem** nenhum efeito anterior (PUT ou aviso já aceito). O que já aconteceu é relatado pela releitura (§2.6).

A ferramenta restrita continua com `modoAgendado: false`, o comportamento atual, nas mãos de quem decide.

### 2.4 Janela de aviso de vários dias (D-B9-5)

- **Abertura em −33**, aplicada **nos dois pontos**:
  - o retorno antecipado de registro `PENDENTE` (linha 95): `hoje < limiteAviso − 3` aguarda;
  - o caminho sem aviso enviado (linhas 128–131): `hoje < limiteAviso − 3` aguarda, e `hoje > limiteAviso` perde.
  - Uma constante única, `AVISO_ANTECIPADO_DIAS = 3`, serve aos dois pontos e é testada com registro **preexistente** e sem registro.
- **Retentativa:** estritamente abaixo de 23 h desde a **primeira** tentativa, com a mesma chave. O relógio não reinicia a cada dia nem a cada execução, e não há chave nova. Isso mantém a margem diante das 24 h de retenção do Resend.
- **Meia-noite do dia −30 continua sendo limite real.**
  - Um envio aceito depois da virada tem a gravação de `AVISADA` recusada pelo CHECK da 075, e a rotina devolve **`ENVIO_INCERTO` com o estado `AVISANDO`**. Esse é o resultado esperado e fixado em teste.
  - A execução seguinte (dia −29) devolve `ALERTA_JANELA_AVISO_PERDIDA`, sem escrita, e o caso vai para decisão humana. O aviso pode ter chegado, e o atendimento confere pelo id no Resend, se houver.
- **Empresa alcançada só no dia −30**, por exemplo confirmada tarde, não tem os dois dias de margem: tenta só nesse dia. Depois disso, alerta sem enviar.
- A guarda da 075 aceita a abertura em −33 sem migration. A antecedência continua de pelo menos 30 dias.

### 2.5 Classificação de todos os resultados

**Leitura do estado de entrada:** antes de cada empresa, lê-se o estado do registro (ou a ausência dele). Depois do processamento, lê-se o estado de saída. A leitura inicial, o processamento e a leitura final acontecem sob **uma única aquisição** da trava por empresa: a entrada não envolve a rotina numa segunda aquisição concorrente da mesma trava (a rotina recebe `travar` já resolvido, ou as leituras acontecem dentro do trabalho passado a ela).

| Classe | Resultados | Código de saída |
|---|---|---|
| OK | `AGUARDANDO_AVISO`, `AGUARDANDO_ULTIMA_PARCELA`, `REGULAR`, `CANCELADA`, `SEM_FUNDADOR` (deixou de ser elegível entre a listagem e o processamento), `EXECUCAO_SOBREPOSTA`, `NAO_ELEGIVEL` (só com `--empresas`) | 0 |
| Simulação | `ENVIARIA_AVISO`, `ATUALIZARIA_PRECO` (só em `simular`; em `aplicar`, um desses resultados é tratado como desconhecido) | 0 |
| Pendente, primeira vez | `ENVIO_INCERTO` ou `AGUARDANDO_CONFIRMACAO_PRECO` quando o estado de **entrada** não era `AVISANDO` nem `APLICANDO` | 0 |
| Pendente repetida | a empresa **entrou** com intenção pendente (`AVISANDO` ou `APLICANDO`) e **saiu** no mesmo estado, qualquer que seja o resultado | **2** (`INTENCAO_PENDENTE_REPETIDA`) |
| Alerta | todo `ALERTA_*`, `REVISAO_EXISTENTE`, `ERRO_REPROCESSAVEL`, `TRAVA_PERDIDA`, `LIMITE_EXECUCAO` | **2** |
| Desconhecido | qualquer resultado fora desta tabela | **2** (`RESULTADO_DESCONHECIDO`) |
| Recusa | configuração, alvo, modo, e-mail ou argumentos | 1, sem conectar |

- A regra "entrou com intenção pendente e saiu igual" **não afirma** que o mesmo resultado se repetiu. Ela afirma que uma intenção persiste por pelo menos duas execuções, por qualquer motivo, inclusive queda antes do PUT. É o critério de alerta.
- Contar a repetição exata de um resultado exigiria um marcador persistido, e isso fica fora do escopo.

### 2.6 Relatório de preço pela releitura (substitui `precoParcial`)

Para cada empresa com estado de saída `APLICANDO`, `AVISADA` ou alerta posterior ao aviso, o relatório traz `precoRemoto` pela **releitura** feita na mesma execução, depois do processamento. Nunca usa "PUT feito nesta execução".
- `assinatura`: `REGULAR`, `FUNDADOR`, `DIVERGENTE` ou `NAO_LIDA`;
- `parcelasDaRenovacao`: contagens `{ regulares, fundador, outras, naoLidas }`;
- `estadoPersistido`: o estado do registro.

O relatório distingue **efeito confirmado** (releitura conclusiva) de **resultado incerto** (leitura falhou ou foi parcial). `APLICANDO` sozinho não prova que o preço remoto mudou. Quando a releitura falha, o resultado é `NAO_LIDA` e entra como alerta.

Cobre também parcelas já alteradas antes de uma falha posterior: elas aparecem em `regulares` na releitura da execução seguinte.

O relatório JSON continua sanitizado: id interno da empresa, códigos e contagens, sem e-mail, valor ou id do provedor.

### 2.7 Detecção ainda no dia válido

- Execução **de hora em hora** (D-B9-2), com saída 2 no primeiro alerta: o Render notifica no mesmo dia.
- `avisosNaJanela`: empresas entre −33 e −30 **sem `avisoEnviadoEm`**, e não pelo estado ser diferente de `AVISADA`. Um registro que já enviou o aviso e avançou para `APLICANDO` ou `REGULAR` não conta. Qualquer valor > 0 no **último dia** (−30) é alerta (2).

### 2.8 Sobreposição com o trabalho dos e-mails de cobrança (087)

- O clone `kidmais-manager-emails-cobranca-20261019` altera `renovacao-entrega.ts`, `sincronizacao.ts` e `cobranca-padrao.ts`.
- O B-9 não depende dele.
- **Integração a testar quando os dois se encontrarem:** o webhook compartilhado, com a prioridade da renovação, a devolução do aviso e a disputa pela trava da contratação.

## 3. Testes (antes de qualquer publicação)

**`planejar`:**
- cada recusa antes de conectar;
- `aguardando` sem conexão;
- production antes da data rebaixada para `simular`;
- `--agora` sem `--empresas` recusado;
- argumentos de homologação fora de staging recusados;
- `--agora` com `aplicar` e empresa não fixture recusado, usando a função reutilizada.

**Modo agendado, com repositório, provedor e e-mail falsos:**
- `REVISAO` existente: retorno imediato, sem rede e sem escrita;
- **identidade divergente inicial (linha 97):** `ALERTA_IDENTIDADE_DIVERGENTE` e estado preservado;
- **identidade divergente na confirmação final (linha 178), depois dos PUTs:** alerta, **não** `CANCELADA`, estado `APLICANDO` preservado, e `precoRemoto` pela releitura;
- assinatura **inativa** com identidade conferida na linha 178: `CANCELADA`;
- o caso do revisor, `nextDueDate` inválido depois do aviso sem corrida: `AVISADA` preservado, alerta, nenhuma revisão e nenhuma suspensão;
- parcela que passa a `RECEIVED` entre a listagem e a releitura, depois do PUT da assinatura: alerta e nenhum PUT a mais;
- `PRIMEIRO_PAGAMENTO_DIVERGENTE` sem suspensão;
- `modoAgendado: false`: comportamento atual preservado.

**Janela e relógio:**
- **registro `PENDENTE` preexistente** e empresa **sem registro**, nos dias −34, −33, −31, −30 e −29;
- falha às 23h50 do dia −33 e retentativa às 00h10 do dia −32: reenvio com a mesma chave;
- retentativa a exatamente 23 h, a 23 h − 1 ms e a 23 h + 1 ms da primeira tentativa (o relógio não reinicia);
- **envio aceito depois da meia-noite do −30, com o repositório reproduzindo o CHECK da 075: `ENVIO_INCERTO` e `AVISANDO`**; no dia seguinte, `ALERTA_JANELA_AVISO_PERDIDA`;
- empresa confirmada só no dia −30: uma tentativa nesse dia e alerta depois.

**Contador `avisosNaJanela`:** registro com `avisoEnviadoEm` em `APLICANDO` e em `REGULAR` no dia −30 não conta e não gera alerta; registro em `AVISANDO` sem `avisoEnviadoEm` no −30 conta e gera alerta.

**Classificação:**
- cada linha da tabela da §2.5;
- `ENVIARIA_AVISO` em `aplicar` tratado como desconhecido;
- resultado inventado tratado como desconhecido;
- entrada `APLICANDO` com saída `APLICANDO`: 2;
- entrada `PENDENTE` com saída `AVISANDO` (`ENVIO_INCERTO`): 0.

**Releitura de preço:**
- assinatura regular com parcela ainda Fundador, sem PUT nesta execução (retomada depois de uma queda);
- parcelas já alteradas antes de uma falha;
- releitura que falha: `NAO_LIDA` e alerta.

**Execução** (PostgreSQL descartável com o repositório real 074a/075 e a entrada nova):
- **seleção global** com empresas elegíveis e inelegíveis (sem Fundador, Fundador reservado, contratação cancelada, outra empresa) e a interseção com `--empresas`, incluindo um uuid fora dela (`NAO_ELEGIVEL`);
- empresa confirmada sem registro;
- Resend indisponível;
- resposta aceita mas perdida;
- duas execuções sobrepostas;
- perda da conexão da trava no meio: `TRAVA_PERDIDA` e nenhuma empresa nova;
- SIGTERM entre empresas, durante o envio e durante o PUT;
- **encerramento forçado** (SIGKILL) durante o envio e durante o PUT, com a retomada na execução seguinte;
- limite de execução.

**Mutantes, em cópia isolada:**
- modo agendado que escreve `REVISAO` direto (linha 97);
- modo agendado que chama `revisao` ou suspende;
- linha 178 devolvendo `CANCELADA` com identidade divergente;
- `REVISAO_EXISTENTE` verificado só depois da rede;
- abertura da janela aplicada só nas linhas 128–131, sem a linha 95;
- janela abrindo em −34 ou perdendo em −31;
- sem trava global;
- trava em conexão do pool;
- continuar depois de perder a trava;
- `aguardando` conectando;
- production sem a data;
- envio sem e-mail configurado;
- `--agora` sem guarda de fixture;
- resultado desconhecido saindo 0;
- intenção pendente repetida saindo 0;
- `precoRemoto` a partir de "PUT nesta execução".

**Por fim:** CI local completo e revisão independente.

## 4. Implantação (cada passo com autorização própria)

### Staging

1. PR para staging com o B-9 e a D-B9-5, mais merge e deploy.
2. **Homologação da entrada nova em sandbox, antes de qualquer cron.** Pelo Shell do web de staging, com `--empresas` (só fixtures `ehFixtureHomologacao`) e `--agora`, primeiro em `simular` e depois em `aplicar`.
   - Casos: aviso (−33), retentativa, preço (data regular), um alerta forçado, a trava sobreposta e a interseção com um uuid fora da seleção.
   - **Fixture:** uma empresa nova de homologação (`hml-`, "TESTE …") com assinatura sandbox e Fundador confirmado. A `TESTE contratacao CPF - 20261025` só serve se passar na mesma regra; caso contrário, não é usada com `--agora`.
   - **A seleção global** (sem `--empresas`) é provada pelos testes PostgreSQL da §3 e, em staging, pela primeira execução `simular` do cron (passo 4).
3. Felipe cria o cron `kidmais-assinatura-renovacao-staging` (branch `staging`, `0 * * * *`) em `aguardando`, com as variáveis por **nome**: as da reconciliação mais as de e-mail.
4. `simular` por pelo menos um dia, com os logs conferidos.
5. `aplicar`.

### Production

Depois da promoção que leva o B-9 à branch `production`, com a data do B-5 e as condições do §1.1:
1. criar o cron em `aguardando`;
2. `simular`, com a saída conferida (inclusive `avisosNaJanela` e alertas);
3. `aplicar`, com `KIDMAIS_RENOVACAO_PRODUCAO_DESDE`, antes do prazo;
4. conferir a primeira execução real.

### Reversão

1. **Impedir as próximas execuções:** modo `aguardando`, ou suspender o cron no Render.
2. **Encerrar uma execução em curso:** cancelar a execução no Render. A entrada tenta sair entre empresas, mas **sem garantia**: o encerramento pode ser abrupto, e a trava cai com a conexão.
3. **Antes de retomar:**
   - uma execução em `simular`;
   - conferir os registros em `AVISANDO` (envio incerto: consultar o Resend pelo id, se houver) e em `APLICANDO` (`precoRemoto` do relatório e o Asaas);
   - decidir caso a caso.
- Avisos aceitos e PUTs feitos não são desfeitos automaticamente.

## 5. Decisões de Felipe

| # | Decisão | Proposta |
|---|---|---|
| D-B9-1 | Cron próprio da renovação | **Sim** |
| D-B9-2 | Frequência | **De hora em hora** nos dois ambientes (harmonizar o "diariamente" do plano de promoção) |
| D-B9-3 | O modo agendado nunca grava revisão nem suspende; `CANCELADA` só comprovado | **Sim** |
| D-B9-4 | Remetente e cópia do aviso | **Remetente do produto, sem cópia** (o atendimento acompanha pelos alertas e pela tela, não por cópia de e-mail) |
| D-B9-5 | Aviso entre 33 e 30 dias antes | **Sim** (antecedência mínima de 30 dias mantida) |

## 6. Fora deste plano

- Outras mudanças na regra de negócio.
- Contagem exata de repetição de um resultado, que exigiria um marcador persistido.
- E-mails de cobrança (087).
- Campanha 090.
- Cópia do comprovante por e-mail.
- Execução de qualquer passo remoto.
