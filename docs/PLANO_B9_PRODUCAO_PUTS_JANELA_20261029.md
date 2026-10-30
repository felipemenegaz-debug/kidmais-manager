# B-9 para production: contagem de PUTs e janela de aviso perdida (plano rev. 5, 29/10/2026)

Estado: **PROPOSTA**. Nada implementado, nada aplicado, nada remoto.
Base: clone `kidmais-manager-b9-production-20261029`, staging `fc37e885`, branch local `codex/b9-production-20261029` (sem commit).

Histórico: rev. 1 (sha `14879eae…`) **REPROVADA** pelo Astra (relatório `revisao-plano-b9-production-20261029-astra/RELATORIO.md`): P1 F1 data × janela; P1 F2 índice parcial × `ON CONFLICT`; P2 F3 `substitui_id` mutável; P2 F4 envio incerto absorvido; P2 F5 suspensão e semântica dos contadores. A rev. 2 resolve os cinco (§5) e incorpora o inventário de leitores e os testes exigidos.
Rev. 2 (sha `4d38eaae…`) **REPROVADA** (relatório `revisao-plano-b9-production-20261029-astra-r2/RELATORIO.md`): P2 R2-F1 guarda de raiz × `criar` idempotente; P2 R2-F2 `capacidade109` incompleta; P3 R2-F3 seis métodos, não sete; P3 R2-F4 bateria. A rev. 3 resolve os quatro (§5.1).
Rev. 3 (sha `c73fdf05…`) **REPROVADA** (relatório `revisao-plano-b9-production-20261029-astra-r3/RELATORIO.md`): P2 R3-F1 contrato sem os CHECKs herdados da 075; P3 R3-F2 raízes concorrentes sem trava; P3 R3-F3 mutante de elegibilidade. A rev. 4 resolve os três (§5.2).
Rev. 4 (sha `06664c50…`) **REPROVADA** (relatório `revisao-plano-b9-production-20261029-astra-r4/RELATORIO.md`): P2 R4-F1 retrato dos gatilhos sem `WHEN`/`UPDATE OF`; P3 R4-F2 trava advisory não espera; P3 R4-F3 oráculo do UPDATE condicional. A rev. 5 resolve os três (§5.3).

Origem: decisões de Felipe de 29/10/2026 para production:
- **D-P5-5 = B.** Antes do `aplicar` em production, o relatório do cron conta os PUTs no Asaas por empresa, separando assinatura e parcelas.
- **Janela perdida.** O cliente recebe um aviso novo e o preço regular entra pelo menos 30 dias depois. Nunca há subida sem aviso.

Código atual: `lib/assinatura/renovacao-fundador.ts` (`processarRenovacao`), `renovacao-repositorio.ts`, `renovacao-agendada.ts` (`executarAgendada`), `scripts/assinatura-renovacao-cron.cjs`. Guarda: migration 075 (`kidmais_075_renovacao_guarda`).

---

## 1. Contagem de PUTs (D-P5-5 = B)

### 1.1 Hoje
`ProvedorRenovacao` (`asaas.ts:144`) tem **três** métodos que mutam o Asaas, todos PUT:
- `atualizarValorAssinatura`;
- `atualizarValorCobranca`;
- `suspenderGeracao` (PUT em `/subscriptions/…`, `asaas.ts:418`).

O modo agendado hoje só chama os dois primeiros. O caminho normal grava `APLICANDO` antes dos PUTs de preço. A exceção é o registro `REGULAR` com preço divergente: a 075 não tem `REGULAR → APLICANDO`, e o PUT sai sem intenção gravada. O relatório não conta PUT algum.

### 1.2 Opção escolhida: P-A (provedor instrumentado)
A rev. 1 já aprovava P-A; a rev. 2 fecha F5. O cron monta, **por empresa**, um provedor instrumentado assim:

```
instrumentado = contar( provedorDaExecucao(cliente, aplicar) )   // a contagem fica POR FORA do bloqueador de simulação
```

- **Lista fechada.** O objeto expõe **só os 6 métodos** de `ProvedorRenovacao`: as leituras `obterAssinatura`, `listarCobrancasDaAssinatura` e `obterCobranca`, e as mutações `atualizarValorAssinatura`, `atualizarValorCobranca` e `suspenderGeracao`. Qualquer outro método do cliente Asaas (criar e remover assinatura etc.) fica ausente, e chamá-lo dá `TypeError` → `ERRO_REPROCESSAVEL`.
- **Semântica dos números.** São **tentativas observadas** e **falhas observadas**: a contagem sobe antes de delegar, e `falhas` sobe se a chamada lançar. Não provam efeito remoto: um timeout pode ter sido aplicado e um bloqueio da simulação não chega à rede. A evidência do preço continua sendo a releitura (`precoRemoto`), separada.
- **Privacidade.** Nada de argumentos, respostas ou mensagem de exceção é guardado. Só inteiros.
- **Categorias:** `assinatura` (preço da assinatura), `parcelas`, `suspensao`, `falhas`, `foraDeAplicando`.

### 1.3 "Fora do caminho APLICANDO" pelo estado vigente
O booleano histórico da rev. 1 foi trocado pelo **estado persistido vigente**, observado assim:
- um repositório observado guarda `estadoVigente`, que começa no estado de entrada lido sob a trava;
- `estadoVigente` só muda depois que `marcar` **resolve**, ou seja, depois do COMMIT. Falha de commit não muda nada;
- toda chamada mutante com `estadoVigente !== 'APLICANDO'` incrementa `foraDeAplicando`. Assim, a retomada em `APLICANDO` depois de uma queda não alerta, e um caminho futuro que saia de `APLICANDO` e depois faça PUT alerta;
- os contadores são **criados por empresa dentro da trava daquela empresa** e nunca são compartilhados.

### 1.4 Relatório
- **Por item.** Todo `ItemAgendado` (alertas, `emAndamento` e `alertasInformativos` do script) leva `puts: { assinatura, parcelas, suspensao, falhas, foraDeAplicando }`, com zeros nas saídas antecipadas (SEM_FUNDADOR, AGUARDANDO_AVISO, REVISAO_EXISTENTE, trava não obtida).
- **`emAndamento`** passa a incluir também qualquer item sem alerta com tentativa > 0.
- **Totais no topo:** `putsTotais: { empresasComTentativa, assinatura, parcelas, suspensao, falhas, foraDeAplicando }`.
  - Somados de um mapa por empresa que é independente das listas, então não há dupla soma.
  - O mapa é preenchido no `finally` de cada empresa: sobrevive a exceção do processamento ou da releitura, a `TRAVA_PERDIDA`, `LIMITE_EXECUCAO` e `INTERROMPIDA`.
  - `empresasComTentativa` conta empresas distintas.
  - Os contadores vivem só na memória do processo. Não são auditoria durável: um SIGKILL ou uma queda do processo os perde (a evidência durável continua sendo a releitura do preço e o estado no banco).
  - Se a consulta que separa `alertasInformativos` (`assinatura-renovacao-cron.cjs:197`) falhar, o relatório sai com todos os alertas como reais e com as contagens já obtidas. A finalização nunca descarta `puts`.
- O relatório continua sem e-mail, valor, id do provedor ou `mensagem`.

### 1.5 Alertas novos (classe ALERTA, código 2)
| Motivo | Quando |
|---|---|
| `PUT_FORA_DE_APLICANDO` | `foraDeAplicando > 0` (§1.3). |
| `PUT_ASSINATURA_REPETIDO` | mais de 1 tentativa de preço da assinatura na mesma empresa e execução. |
| `PUT_SUSPENSAO_NO_AGENDADO` | qualquer tentativa de `suspenderGeracao` no modo agendado (hoje impossível; trava contra regressão). |
| `PUT_EM_SIMULACAO` | qualquer tentativa mutante em `simular`, mesmo bloqueada por `provedorDaExecucao`. |

O motivo mais específico já existente não é sobrescrito (`motivo ??=`, como hoje). `INTENCAO_PENDENTE_REPETIDA` pode coexistir legitimamente.

**D-PUT-1 (Felipe):** no registro `REGULAR` com preço divergente, (a) só alerta, como acima (recomendado: muda o mínimo), ou (b) o modo agendado deixa de fazer o PUT e devolve `ALERTA_PRECO_REGULAR_DIVERGENTE`?

---

## 2. Janela de aviso perdida

### 2.1 Restrições da 075
1. `contratacao_id UNIQUE`: um registro por contratação;
2. `primeira_data_regular` e `mensagem` imutáveis;
3. `CHECK aviso_enviado_em ≤ primeira_data_regular − 30` (BRT);
4. transições fechadas.

### 2.2 Opções
| | Avaliação |
|---|---|
| J-A, procedimento assistido sem código | Não recomendada como solução: aviso e PUT ficam fora do banco, sem a guarda da 075 e sem acompanhamento automático. O desconto só termina se o PUT manual posterior acontecer, e o alerta dispara de hora em hora até lá. |
| J-B, código sem migration | Inviável **dentro da máquina e das garantias da 075** (restrições 1 e 2). Um mecanismo paralelo na aplicação perderia essas garantias. |
| **J-C, migration 109 "renovação substituta" (recomendada)** | O registro com a janela perdida vira `SUBSTITUIDA` (terminal) e nasce o sucessor da mesma contratação, com data e mensagem novas. CHECK de prazo, imutabilidade e transições continuam valendo no sucessor. Pode ser automática no cron ou assistida (D-JP-1); o banco é o mesmo. |

### 2.3 Quem pode ser substituído (F4)
Só um registro **`PENDENTE` com `aviso_tentado_em IS NULL`** e janela vencida (`hoje_BRT > primeira_data_regular − 30`). Ou seja: nunca houve tentativa de envio.

Ficam **fora**, com o comportamento atual:
- **`AVISANDO`** (tentativa feita, resultado possivelmente incerto). O processador continua devolvendo `ALERTA_JANELA_AVISO_PERDIDA` ou `ALERTA_ENVIO_INCERTO_FORA_JANELA`, a chave anterior é preservada e não há reenvio com chave nova. Tratar esse caso pede reconciliação com o provedor de e-mail: decisão futura **D-JP-6**, fora deste escopo.
- **`REVISAO`**. O cron devolve `REVISAO_EXISTENTE` antes de qualquer ramo. O banco **não** permite `REVISAO → SUBSTITUIDA` nesta rodada.
- **Aviso enviado** (`AVISADA` em diante), inclusive o devolvido (`renovacao-entrega`).

Correção da rev. 1: a retentativa de `ENVIO_INCERTO` continua limitada a **23 h** desde a primeira tentativa (`renovacao-fundador.ts:156`). A folga de datas não amplia isso.

### 2.4 Data e janela do sucessor (F1)
- **Série de vencimentos.** Âncora `primeiro_vencimento`, ciclo da contratação, função nova `proximaDataDaSerie(ancora, ciclo, minimo)`:
  - mensal: `mesesDepois(ancora, k)`;
  - anual: `mesesDepois(ancora, 12k)`, em múltiplos de 12 a partir da âncora, sem reaproveitar a regra "âncora + 12" de `primeiraRenovacaoRegular`;
  - devolve o menor `k` com data ≥ `minimo`.
- **Data nova:** `proximaDataDaSerie(…, hoje_BRT + 33)`. O banco exige ≥ `hoje_BRT + 30` (§2.5).
- **Janela do sucessor:** `[data − 63, data − 30]`. A janela normal continua `[data − 33, data − 30]`. O critério é `substitui_id IS NOT NULL`; a constante `AVISO_SUBSTITUTO_DIAS = 63` fica ao lado de `AVISO_ANTECIPADO_DIAS`.
  - **Mensal.** Os vencimentos ficam no máximo 31 dias apart, então a data nova cai em `[hoje+33, hoje+63]`. Logo `hoje ∈ [data−63, data−30]`: **a janela está aberta no dia da substituição** e o aviso sai na mesma execução.
  - **Anual.** A data nova pode estar até ~13 meses à frente. O aviso **aguarda** a janela `[data−63, data−30]`, e o resultado da substituição deixa isso explícito (§2.6). Isso significa mais um ciclo com preço Fundador (D-JP-3).
- **Limites recalculados do sucessor.** `limiteAviso = data_nova − 30` e o início pela regra acima. Nunca do predecessor.
- **Retomada após queda.** O sucessor já está persistido. A próxima execução lê o registro vigente (o sucessor) e segue o fluxo normal com a janela do sucessor. Nenhum PUT de preço acontece antes de `aviso_enviado_em` (CHECK 075) e de `nextDueDate ≥ data_nova` (processador). O ensaio do PUT alinha o `nextDueDate` do provedor falso à data nova, e não a um "cronômetro de 30 dias".
- **Relógios.** As datas de negócio vêm de `agora` (injetável na homologação). A guarda do banco usa `clock_timestamp() AT TIME ZONE 'America/Sao_Paulo'`. O teste PG roda com datas coerentes com o relógio do banco e cobre a virada BRT.

### 2.5 Migration `20261029_109_renovacao_substituta.sql`
Muda o contrato da 075: **não é puramente aditiva** (F2, §3).

**Schema:**
- `ADD COLUMN substitui_id uuid NULL`;
- `UNIQUE (substitui_id)`: um sucessor por predecessor;
- FK composta `(empresa_id, contratacao_id, substitui_id)` → predecessor. Exige `UNIQUE (empresa_id, contratacao_id, id)` como alvo; o predecessor fica preso à mesma empresa e contratação já pela FK;
- estado `SUBSTITUIDA` no CHECK;
- `DROP CONSTRAINT` da `UNIQUE (contratacao_id)` e `CREATE UNIQUE INDEX assinatura_renovacoes_109_vigente_uq ON (contratacao_id) WHERE estado <> 'SUBSTITUIDA'`.

**Função `kidmais_109_renovacao_guarda`**, ligada aos **mesmos nomes de gatilho** (`assinatura_renovacoes_075_guarda`, `_075_truncate`) por `DROP TRIGGER` + `CREATE TRIGGER` na mesma transação. Todas as regras da 075, mais:
- **Imutáveis em UPDATE:** a lista da 075 **+ `substitui_id`**, em qualquer direção (NULL→valor, valor→NULL, valor→outro) (F3).
- **Transição nova:** só `PENDENTE → SUBSTITUIDA`, com `OLD.aviso_tentado_em IS NULL`, `OLD.aviso_enviado_em IS NULL` e `hoje_BRT > OLD.primeira_data_regular − 30`. Exige também `NEW` igual a `OLD` em todas as evidências (`aviso_*`, `preco_aplicado_em`): não se acrescenta evidência no mesmo UPDATE. `SUBSTITUIDA` é terminal, sem saída e sem volta a estado ativo.
- **INSERT com `substitui_id`** só se o predecessor:
  - está `SUBSTITUIDA`;
  - tem o mesmo `primeiro_vencimento`;
  - tem `primeira_data_regular` < a nova;
  - e a nova é ≥ `hoje_BRT + 30` (inclusivo; `+29` recusa).
  
  Continua nascendo `PENDENTE`, com a mesma checagem de Fundador vigente e empresa não isenta da 075.
- **INSERT sem `substitui_id`** (raiz) **recusado se já existe qualquer linha da contratação**. A cadeia é obrigatória e não há raiz paralela depois de uma substituição (F3).
- **DELETE e TRUNCATE:** recusados, como na 075.

**Sucessor obrigatório no COMMIT:** `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED AFTER UPDATE` exige que toda linha que virou `SUBSTITUIDA` tenha sucessor ao fim da transação. Assim não existe predecessor órfão, mesmo fora do repositório.

**Arquivos:**
- precheck: exige 075 íntegra e ausência de 109;
- postcheck gerado do contrato de integridade de `renovacao-schema.ts` (§2.6): os mesmos componentes da capacidade `'109'`, sem lista própria;
- rollback `…_109_…_down.sql`: **recusa se houver** linha `SUBSTITUIDA` ou `substitui_id` não nulo. Sem histórico, restaura a `UNIQUE (contratacao_id)`, a função e os gatilhos da 075 e remove a coluna;
- numeração: 101 reservada (contratos fase 3, local); 102–108 tomadas; **109 livre** em 29/10 nos clones irmãos e no staging `fc37e885`. Reconferir antes de congelar.

### 2.6 Código
**Repositório:**
- **`criar`** (F2 e R2-F1). Numa transação, depois do `SELECT … FROM empresas … FOR UPDATE` que já existe (mesma serialização por empresa da contratação):
  1. **ler primeiro** o vigente (`estado <> 'SUBSTITUIDA'`). Se existe, devolve-o **sem INSERT**. Assim a guarda de raiz da 109 nunca é acionada pelo caminho normal;
  2. se existe alguma linha da contratação mas nenhuma vigente (histórico sem vigente, que o gatilho diferido torna impossível na 109 íntegra), lança `HISTORICO_SEM_VIGENTE` e **não fabrica raiz**. O processador devolve `ALERTA_HISTORICO_SEM_VIGENTE`;
  3. só sem linha alguma: `INSERT … ON CONFLICT DO NOTHING`, sem alvo, e depois relê o vigente. A falta de alvo funciona com a `UNIQUE` da 075 e com o índice parcial da 109, e não referencia a coluna nova. O filtro `estado <> 'SUBSTITUIDA'` é comparação de texto, válida nos dois schemas.

  **Duas raízes concorrentes (R3-F2).** Separa-se segurança (nunca duas raízes) de idempotência (os dois chamadores recebem o vigente):
  - **Com a trava da empresa** (R4-F2): segurança, e idempotência **entre rodadas**, não na mesma rodada. Todo chamador de `criar` passa por `processarRenovacao`, que roda sob `deps.travar`:
    - o cron, pelo executor (`assinatura-renovacao-cron.cjs`, `travaPorEmpresa`);
    - o script manual (`assinatura-renovar.cjs:46`);
    - a ferramenta restrita (`assinatura-renovar-restrito.cjs:181`).
    
    `travaPorEmpresa` usa `pg_try_advisory_xact_lock` e **não espera**: com a trava ocupada, lança `CONTRATACAO_EM_ANDAMENTO` (`cobranca.ts:81–86`). Por isso o concorrente é **recusado antes de processar**: no cron vira `ERRO_REPROCESSAVEL` no executor (`renovacao-agendada.ts:153`), e a rodada seguinte lê o vigente pelo passo 1. Esta rodada não muda a trava para bloqueante.
  - **Chamadas diretas a `criar`**, sem a trava advisory: o `SELECT … FROM empresas … FOR UPDATE` do início de `criar` (`renovacao-repositorio.ts:38`) **espera**. A segunda chamada entra depois do COMMIT da primeira, cai no passo 1 e devolve o mesmo vigente.
  - **Sem nenhuma das duas serializações** (INSERTs diretos que contornam a trava advisory **e** a trava de linha), só a segurança é prometida, em dois interleavings:
    - **(a)** as duas guardas BEFORE INSERT rodam antes do primeiro COMMIT e nenhuma vê linha. A unicidade da contratação (075 integral ou índice parcial, as duas `PENDENTE`) arbitra; o `DO NOTHING` absorve a segunda, que relê a primeira;
    - **(b)** o primeiro COMMIT acontece antes da guarda da segunda. Na 109, a guarda recusa a raiz paralela com exceção, que o `DO NOTHING` não absorve. A transação da segunda faz ROLLBACK e `criar` lança. Não há recuperação automática: o processador devolve `ERRO_REPROCESSAVEL` e a próxima execução lê o vigente pelo passo 1.
  
  Na 075 a ordem (b) pode ocorrer, mas não há recusa de raiz pela guarda: a unicidade integral arbitra como em (a).

  **Três provas distintas, cada uma com a trava real e não com uma trava injetada:**
  1. **operacional:** dois processamentos simultâneos da mesma empresa com `travaPorEmpresa`. O segundo é recusado sem processar (`CONTRATACAO_EM_ANDAMENTO` → `ERRO_REPROCESSAVEL`), sem espera, e a rodada seguinte lê o vigente;
  2. **repositório:** duas chamadas diretas a `criar`. A espera é **observada** na trava de linha (`pg_locks` / `wait_event`), e as duas devolvem o mesmo vigente;
  3. **sem serialização:** INSERTs diretos nas ordens (a) e (b), na 075 e na 109. O teste aceita a recusa do perdedor em (b) na 109.
  
  A espera só é exigida onde ela existe (prova 2).
- **`ler`** e **`consultarRenovacao`:** mesmo filtro.
  - `lerRenovacoesOperacao` já seleciona só `REVISAO`/`AVISANDO`/`APLICANDO`: sem mudança.
  - `empresasParaRenovacao` lê contratações: sem mudança.
  - `renovacao-entrega` busca pelo id externo e só age em `AVISADA`. Sem filtro novo, mas com teste: evento tardio de um predecessor nunca atinge o sucessor (o predecessor nunca teve id externo, §2.3).
- **`capacidadeRenovacao(tx)`** (R2-F2). Fonte única: `lib/assinatura/renovacao-schema.ts` com o **contrato versionado de integridade**. É uma lista de componentes esperados, cada um com código, consulta ao catálogo e valor aprovado. Postcheck da 109, preflight e capacidade em tempo de execução usam a mesma lista; o postcheck SQL é gerado dela e um teste confere que não divergem.

  **Forma do contrato (R3-F1): retrato completo da tabela, comparado por igualdade de conjunto.** A rev. 3 enumerava componentes soltos; a rev. 4 lê do catálogo **todos** os objetos de `assinatura_renovacoes`. Cada versão aprovada (`'075'`, `'109'`) é um conjunto exato: nada pode faltar, sobrar ou divergir. As cinco famílias:
  1. **Colunas** (`pg_attribute`, sem as removidas): nome, tipo (`format_type`), `attnotnull` e default (`pg_get_expr`).
  2. **Constraints** (`pg_constraint`): `contype`, nome, `pg_get_constraintdef` e `convalidated = true`. O conjunto inclui **todas** as da 075 por definição:
     - PK;
     - FKs para `empresas`, `usuarios_administrativos` e `(empresa_id, contratacao_id)` → `assinatura_contratacoes`;
     - `primeira_data_regular > primeiro_vencimento`;
     - `aviso_dias = 30` (`:12`);
     - forma da `mensagem` com a chave de idempotência amarrada ao id (`:13–15`);
     - CHECK de estados;
     - formato de `ultimo_erro`;
     - **os cinco CHECKs de evidência e prazo** (`075:25–29`): aviso enviado exige tentativa e id externo; aviso ≤ data − `aviso_dias` em BRT; AVISADA/APLICANDO/REGULAR exigem aviso; REGULAR exige preço aplicado; preço aplicado depois do aviso;
     - a `UNIQUE (contratacao_id)` só na 075.
  3. **Índices** (`pg_index`): nome, `pg_get_indexdef` (colunas e predicado), `indisunique`, `indisvalid` e `indisready`.
  4. **Gatilhos** (`pg_trigger`, sem os internos), por **definição completa** (R4-F1): `pg_get_triggerdef(oid)` igual ao aprovado. A definição já inclui momento, nível, eventos, a lista de colunas de `UPDATE OF` (`tgattr`), a condição `WHEN` (`tgqual`), `DEFERRABLE`/`INITIALLY DEFERRED`, `FROM` e a função chamada. Além dela, campos explícitos que a definição não mostra ou que não podem depender só do texto:
     - `tgenabled = 'O'`;
     - **`tgqual IS NULL`** nas guardas (nenhuma condição `WHEN`);
     - **`tgattr` vazio** (nenhuma restrição `UPDATE OF`);
     - `tgfoid` → nome qualificado da função esperada;
     - presença de `tgconstraint` só no gatilho diferido do sucessor, conferida pela **identidade** da constraint referenciada (nome, tipo `t`, `condeferrable`, `condeferred`), nunca pelo OID.
     
     A precisão é a mesma nas duas versões; um gatilho da 075 que deixe de observar UPDATE é divergência.
     
     **Nenhum OID entra nos valores aprovados.** OIDs são locais ao banco; as consultas os resolvem para nomes antes de comparar.
  5. **Funções ligadas**: sha256 de `prosrc` normalizado (`\r\n` → `\n`), mais `prosecdef` e `proconfig` (o `search_path` fixo).

  **Conjunto comum e diferença.** `renovacao-schema.ts` define o **conjunto comum** (tudo da 075 que a 109 preserva: colunas, PK, FKs, os CHECKs de `aviso_dias`, mensagem, `ultimo_erro`, `primeira_data_regular` e os cinco de evidência e prazo, o índice `assinatura_renovacoes_pendentes_idx`, e os **nomes, momentos e eventos** dos dois gatilhos de guarda, de linha e de TRUNCATE, cuja função ligada muda de versão) e as **diferenças** explícitas:
  - 075 = comum + `UNIQUE (contratacao_id)` + CHECK de estados original + os dois gatilhos de guarda ligados a `kidmais_075_renovacao_guarda` (corpo 075);
  - 109 = comum + coluna `substitui_id`, `UNIQUE (substitui_id)`, `UNIQUE (empresa_id, contratacao_id, id)`, FK da cadeia, CHECK de estados com `SUBSTITUIDA`, índice `assinatura_renovacoes_109_vigente_uq`, gatilhos de guarda ligados a `kidmais_109_renovacao_guarda` (corpo 109) e o gatilho diferido do sucessor (corpo próprio).
  
  Os índices de suporte das PKs e UNIQUEs (o da PK, o da `UNIQUE (contratacao_id)` na 075, os das duas `UNIQUE` novas na 109) pertencem ao retrato de índices de cada versão e entram na diferença como consequência das constraints.

  Um teste confere que a diferença 075 → 109 é exatamente a desta lista, incluídos esses índices. O postcheck, o preflight e a capacidade usam os mesmos conjuntos.

  **Gate da conferência em real** (futuro, fora deste escopo):
  - production, ainda em 075, confere o conjunto **075**. Nunca se aplica a 109 só para obter um retrato;
  - a 109 só é conferida num catálogo em que ela já tenha sido aplicada com autorização;
  - a conferência em real **não aprova desvios**. Um desvio do contrato derivado das migrations é achado a analisar, nunca valor novo a fixar.

  Os valores aprovados (definições, `indexdef`, hashes) são **capturados de um PG descartável** em que a migration correspondente foi aplicada a partir dos arquivos do repositório, e fixados no código. Antes de congelar, são conferidos em leitura contra o catálogo real de staging e de production (gate futuro, risco CRLF e versão do PG no `pg_get_constraintdef`).

  **Classificação:**
  - igual ao conjunto da 109 → `'109'`;
  - igual ao conjunto da 075 → `'075'`;
  - **qualquer outro caso → `'INCOMPATIVEL'`**, com a lista dos objetos que faltam, sobram ou divergem (só nome do objeto e família, sem definições no relatório).

  Nenhuma consulta à coluna nova antes da classificação.

  **Garantia mínima para processar** = `'075'` ou `'109'`. Com `'INCOMPATIVEL'` não há garantia de que o CHECK do prazo do aviso, a imutabilidade e as transições estejam ativos. Por isso:
  - o cron **não processa empresa alguma**: sai com código 1, `execucao: 'SCHEMA_RENOVACAO_INCOMPATIVEL'` e os códigos dos componentes, sem envio, PUT ou escrita;
  - a ferramenta restrita e o script manual recusam do mesmo jeito;
  - o diagnóstico nunca vira `ALERTA_JANELA_AVISO_PERDIDA`, que fica reservado para a 075 íntegra.

  A capacidade é lida **uma vez por execução**, antes da primeira empresa, e entra em `DepsRenovacao.capacidade`.
- **`substituir(empresaId, predecessor, sucessor)`:** só com capacidade `'109'`, numa transação:
  1. `SELECT … FOR UPDATE` do predecessor;
  2. `UPDATE … SET estado='SUBSTITUIDA' WHERE id=$ AND estado='PENDENTE' AND aviso_tentado_em IS NULL`, conferindo `rowCount = 1`;
  3. `INSERT` do sucessor;
  4. COMMIT **antes** de qualquer envio.

  `rowCount ≠ 1` ou erro → ROLLBACK, resultado `ALERTA_SUBSTITUICAO_RECUSADA`, sem envio.

**`processarRenovacao`:** um ramo novo **antes** do `revisao('JANELA_AVISO_PERDIDA')` atual, só quando `modoAgendado && r.estado === 'PENDENTE' && !r.avisoTentadoEm && hoje > limiteAviso`:
- capacidade `'075'` → `ALERTA_JANELA_AVISO_PERDIDA` (como hoje). `'INCOMPATIVEL'` nunca chega aqui, porque a execução já parou antes;
- `simular` → `REAGENDARIA_AVISO`, sem escrita;
- destinatário inválido ou alterado → `ALERTA_REAGENDAMENTO_SEM_DESTINATARIO`, sem substituição;
- caso contrário: substituir, reler sob a mesma trava e seguir o fluxo normal **com o sucessor**. O resultado final é composto, e a substituição nunca some do resultado:

| Depois da substituição | Resultado | Classe |
|---|---|---|
| aviso enviado e `AVISADA` gravada | `AVISO_REAGENDADO` | ALERTA (`JANELA_PERDIDA_REAGENDADA`) |
| janela do sucessor ainda não aberta (anual) | `AVISO_REAGENDADO_AGUARDANDO` | ALERTA (`JANELA_PERDIDA_REAGENDADA`) |
| envio falhou ou incerto | `AVISO_REAGENDADO_ENVIO_INCERTO` | ALERTA |
| qualquer outro desfecho do fluxo | `AVISO_REAGENDADO_<resultado>` | ALERTA |

A substituição **não some nem diante de exceção**. O repositório observado (§1.3) marca `substituiu = true` quando `substituir` resolve (depois do COMMIT). Se o processamento lançar depois disso, o executor, cujo `catch` hoje troca tudo por `ERRO_REPROCESSAVEL` (`renovacao-agendada.ts:143–144`), devolve `AVISO_REAGENDADO_ERRO_REPROCESSAVEL`. `AVISO_REAGENDADO` simples só sai quando o desfecho final é `AVISADA` sem erro posterior; um erro específico posterior prevalece no sufixo.

A regra da janela do sucessor vale nos **três** pontos que hoje usam `inicioJanelaAviso`:
- o atalho de `PENDENTE` (`renovacao-fundador.ts:112`);
- o teste antes do envio (`:152`);
- a contagem `avisoNaJanela` do executor (`renovacao-agendada.ts:164`).

Para saber se o registro é sucessor, a leitura projeta `substitui_id IS NOT NULL` só com capacidade `'109'`; com `'075'`, é sempre falso.

Na execução seguinte, o sucessor segue a classificação normal. Se uma queda atravessar a janela inteira do sucessor, ele continua `PENDENTE` sem tentativa e pode ser substituído de novo, porque a cadeia admite várias substituições. `REAGENDARIA_AVISO` entra em `SO_SIMULACAO`: OK em `simular`, `RESULTADO_DESCONHECIDO` em `aplicar`.

**Fora do modo agendado** (ferramenta manual): sem mudança (`REVISAO` + suspensão). A operação assistida, se D-JP-1 = assistida, usa a mesma `travaPorEmpresa` (`cobranca.ts:81`), a releitura sob a trava e o mesmo `substituir`.

**Mensagem:** `mensagemRenovacao` com a data nova e id e chave de idempotência novos (`kidmais-renovacao/<id sucessor>`). Texto em D-JP-4.

---

## 3. Compatibilidade e cutover (F2)
| Código \ Schema | 075 | 109 |
|---|---|---|
| **antigo** (staging/production atuais) | OK (hoje) | **QUEBRA**: `ON CONFLICT (contratacao_id)` sem índice inferível; leitores com `rows[0]` ambíguo depois de haver histórico |
| **novo** | OK: comportamento atual; janela perdida só alerta | OK: substituição habilitada |

Ordem obrigatória em cada ambiente:
1. publicar o código novo em **todos** os consumidores (web, cron da renovação, cron da reconciliação e ferramentas manuais que rodam no Shell do web) e validar com a 075 (nenhuma mudança de comportamento). O roteiro futuro confere o commit de cada serviço e drena execuções antigas (nenhuma execução do cron com o commit anterior em andamento). Pausar o cron não substitui essa conferência;
2. aplicar a 109 numa janela própria, com o cron da renovação em `aguardando` ou suspenso durante a aplicação;
3. conferir a capacidade `'109'` e voltar ao modo anterior.

**Rollback:**
- código novo → antigo só com a 109 **ausente**;
- 109 → 075 só **sem histórico** (o down recusa).

Depois da primeira substituição, nem o down nem o código antigo voltam, e a saída é corrigir para frente. Isso fica declarado no aplicador da 109 (fora deste escopo).

---

## 4. Testes e provas (critérios de aceite)
**Unitários (sem banco):**
- `proximaDataDaSerie`:
  - mensal com candidata exatamente em hoje+33 e estritamente depois;
  - 31/jan → fev bissexto e não bissexto;
  - recuperação muito tardia (meses depois);
  - anual em múltiplos de 12.
- Janela do sucessor: aberta no mensal, aguardando no anual.
- `limiteAviso` do sucessor.
- Substituição só em `PENDENTE` sem tentativa.
- `AVISANDO` com tentativa < 23 h e ≥ 23 h, antes e depois do limite: sem substituição e sem chave nova.
- `REVISAO_EXISTENTE` preservado.
- Destinatário inválido ou alterado.
- `simular` sem escrita.
- Resultados compostos e classificação.
- Capacidade `075`, `109` e `INCOMPATIVEL`.
- Contador:
  - três métodos;
  - lista fechada;
  - contagem por fora do bloqueio de simulação;
  - falha antes e depois de delegar;
  - falha na parcela depois de sucesso na assinatura;
  - `estadoVigente` só depois do commit (falha de `marcar` não habilita);
  - retomada em `APLICANDO` sem alerta;
  - `REGULAR` com PUT → alerta;
  - suspensão → alerta;
  - sem mistura entre empresas;
  - totais com interrupção, trava perdida e exceção;
  - JSON serializado sem dados sensíveis, inclusive em `alertasInformativos`;
  - lista exata dos 6 métodos e ausência dos demais métodos do cliente Asaas (R2-F3);
  - duas tentativas de preço da assinatura → contador 2 e `PUT_ASSINATURA_REPETIDO` (R2-F4);
  - transição commitada `APLICANDO → REVISAO` (ou outro estado) seguida de tentativa mutante → `foraDeAplicando` incrementado (R2-F4);
  - falha da consulta de `alertasInformativos` no script → `puts` preservado na **serialização final** (JSON impresso), não só no objeto intermediário.
- `criar` (R2-F1), com 075 e com 109:
  - duas vezes antes de qualquer substituição, e de novo depois de uma e de duas substituições: devolve o mesmo vigente, sem exceção e sem linha nova;
  - histórico sem vigente → `HISTORICO_SEM_VIGENTE`, sem raiz nova.
- Resultados compostos: exceção depois do COMMIT de `substituir` e antes da releitura; falha ao marcar `AVISANDO` ou `AVISADA`; desfecho específico posterior ao envio → sufixo correto, nunca `AVISO_REAGENDADO` simples.
- Anual com a janela do sucessor **já aberta** (vencimento próximo) e **aguardando** (vencimento distante).

**PostgreSQL descartável:**
- **Matriz de compatibilidade:**
  - código novo × 075: criação inicial, criação idempotente, janela perdida só alerta;
  - código novo × 109: criação, idempotência com histórico, substituição;
  - código antigo × 109: falha documentada do `ON CONFLICT`;
  - 109 incompleta → `INCOMPATIVEL` (R2-F2), removendo ou adulterando **um componente por vez**, com os demais presentes: coluna de outro tipo; `UNIQUE(substitui_id)` ausente; FK composta ausente ou `NOT VALID`; CHECK de estados divergente; `UNIQUE (contratacao_id)` antiga ainda presente; índice não único, inválido ou com outro predicado; gatilho de guarda desabilitado, com outro evento ou ligado a outra função; gatilho do sucessor não diferido, só `DEFERRABLE INITIALLY IMMEDIATE` ou desabilitado; corpo de função divergente. Cada caso: cron com código 1 e `SCHEMA_RENOVACAO_INCOMPATIVEL` com o código do componente, zero substituição, envio, PUT ou escrita, e nunca rotulado como janela perdida;
  - **conjunto comum, nas duas versões** (R3-F1): com os objetos próprios de cada versão intactos, remover ou adulterar **um de cada vez**:
    - o CHECK do prazo do aviso (`075:26`);
    - `aviso_dias = 30` (CHECK e default);
    - o CHECK de aviso obrigatório em AVISADA/APLICANDO/REGULAR (`075:27`);
    - os outros três CHECKs de evidência (`075:25`, `:28`, `:29`);
    - a forma da `mensagem`;
    - o formato de `ultimo_erro`;
    - `primeira_data_regular > primeiro_vencimento`;
    - cada FK;
    - a PK;
    - o índice `pendentes`;
    - o gatilho de TRUNCATE;
    - o gatilho de guarda **sem o evento UPDATE**;
    - o gatilho de guarda recriado com **`WHEN (false)`**, mesmos eventos, nome e função (R4-F1);
    - o gatilho de guarda com **`UPDATE OF estado`** no lugar de `UPDATE` (R4-F1);
    - um CHECK recriado `NOT VALID`;
    - uma constraint a mais (sobra);
    - `search_path` da função alterado.
    
    Cada desvio: `INCOMPATIVEL` com o nome do objeto, código 1, zero processamento, escrita, envio ou PUT. A prova é o detector, não uma falha posterior do processador;
  - 075 íntegra: nenhuma consulta à coluna nova (log de consultas do PG descartável);
  - down sem histórico PASS;
  - down com cadeia recusa.
- **Integridade:**
  - as constraints e gatilhos da 075 (INSERT/UPDATE/DELETE/TRUNCATE) continuam válidos;
  - mensagem e `substitui_id` imutáveis;
  - mudança combinada de estado e evidência recusada;
  - predecessor de outra empresa ou contratação recusado;
  - raiz paralela recusada;
  - cadeia com 2 substituições;
  - índice parcial e `UNIQUE(substitui_id)` provados separadamente;
  - sucessor obrigatório no COMMIT (UPDATE solto recusado);
  - `hoje+30` aceito e `+29` recusado;
  - virada de dia BRT.
- **Concorrência** em duas conexões reais, com registro do bloqueio visto (`pg_locks` / `wait_event`): substituir × substituir, substituir × envio, substituir × webhook, raiz × raiz (as três provas de §2.6).
  - **Caminho operacional** (trava advisory real, `pg_try_advisory_xact_lock`): o concorrente é **recusado sem espera** (`CONTRATACAO_EM_ANDAMENTO`) antes de processar, e a rodada seguinte lê o vigente.
  - **Camada do repositório** (trava de linha do predecessor e da empresa): a **espera é observada**, e a segunda chamada relê o vigente depois do COMMIT da primeira.
  - O webhook usa a mesma chave advisory (`renovacao-entrega.ts:80`): também recusa sem esperar.
  - Cada par nas **duas ordens**. Envio primeiro: fica `AVISANDO`/`AVISADA` e a substituição é recusada. Substituição primeiro: o COMMIT acontece antes do envio, e o concorrente relê o vigente e envia pelo sucessor ou não envia.
  - No webhook, distinguir o evento inelegível ou antigo de uma confirmação válida do sucessor.
  - Em todos: o perdedor não envia, nunca há dois vigentes e não sobra predecessor órfão depois de ROLLBACK do INSERT.
- **Falhas:**
  - queda entre UPDATE e INSERT (ROLLBACK total);
  - depois do COMMIT e antes do envio (a próxima execução envia pelo sucessor);
  - depois do envio e antes de `AVISADA`;
  - chave de idempotência do sucessor reaproveitada na retentativa.
- **Cron completo** com provedor falso: janela perdida → sucessor → aviso → `nextDueDate` falso alinhado à data nova → PUT em `APLICANDO` com contagem, `foraDeAplicando = 0`.
- **Exportação, tela e webhook:** todas as gerações no pacote, só a vigente no DTO, evento antigo sem efeito no sucessor.
- **Retratos de colunas** da exportação (`colunas-esperadas*.json`, `fixture.postgres.test-apoio.ts`): retrato novo para a 109, preservando os ensaios de schemas antigos (base, 102, 108).

**Mutantes**, em cópia isolada (clone LF próprio + `npm ci`). Cada um deve morrer pelo motivo esperado:
- sem `hoje+30` no gatilho;
- transição a partir de `AVISANDO` ou `AVISADA`;
- `substitui_id` mutável;
- sem `UNIQUE(substitui_id)`;
- sem índice parcial;
- raiz paralela aceita;
- sem gatilho diferido;
- `ler`/`criar`/`consultarRenovacao` sem filtro;
- limite do aviso do predecessor;
- **elegibilidade** sem `aviso_tentado_em IS NULL` (R3-F3). Cenário isolado: **`PENDENTE` com `aviso_tentado_em` preenchido** e janela vencida. É representável na 075: um UPDATE que mantém `PENDENTE` pode preencher a tentativa, porque a guarda aceita `NEW.estado = OLD.estado` (`075:55`). Um mutante por camada:
  - **processador:** o teste exige zero chamadas a `substituir` (repositório espião), e o resultado continua `ALERTA_JANELA_AVISO_PERDIDA`;
  - **gatilho 109:** o teste tenta a transição `PENDENTE → SUBSTITUIDA` direto no PG e exige a recusa específica da regra da tentativa. O mutante roda com o retrato aprovado ajustado ao próprio mutante: a morte tem de vir da asserção, não do detector de schema. O cenário traz os demais requisitos e, quando a transição deveria passar (controle positivo sem tentativa), um sucessor válido na mesma transação, para que a guarda diferida do COMMIT não mascare a asserção;
  - **`substituir`** (UPDATE condicional) (R4-F3). Asserção na fronteira da consulta, dentro do repositório, **antes** da conversão para `ALERTA_SUBSTITUICAO_RECUSADA`:
    - **controle** (WHERE íntegro): o UPDATE resolve sem exceção, com `rowCount = 0`; o gatilho nem é alcançado;
    - **mutante** (sem `aviso_tentado_em IS NULL` no WHERE): o UPDATE seleciona a linha e o gatilho **lança** a recusa específica da tentativa, seguida de ROLLBACK. O mesmo teste falha no mutante porque espera "resolvido, sem exceção, `rowCount = 0`"; a mensagem do gatilho só atribui a morte à camada certa.
    
    Em ambos: nenhum INSERT de sucessor, envio ou efeito persistido.
  
  `AVISANDO` com janela vencida continua testado à parte, para a exclusão por estado;
- **idade** sem o limite de 23 h do envio (R2-F4): `AVISANDO` com tentativa ≥ 23 h **ainda dentro** da janela de calendário deve dar zero envio novo e `ALERTA_ENVIO_INCERTO_FORA_JANELA`;
- `criar` sem a leitura prévia do vigente (R2-F1);
- capacidade sem um dos componentes do contrato (um mutante por grupo: FK, `UNIQUE(substitui_id)`, predicado do índice, `tgenabled`, diferimento, hash do corpo) (R2-F2);
- substituição perdida no `catch` do executor;
- `PUT_ASSINATURA_REPETIDO` removido;
- `foraDeAplicando` pelo booleano histórico em vez do estado vigente;
- substituição em `simular`;
- data sem a folga;
- contador sem `suspenderGeracao`;
- contagem depois do bloqueador;
- `estadoVigente` antes do commit;
- contadores compartilhados entre empresas.

**Inventário de scripts a adaptar ou estender sem quebrar seus contratos históricos:**
- `assinatura-renovacao-preflight.cjs`: conferir `tgfoid`, índice, coluna e constraints da capacidade 109;
- `migrations-producao-20261019.cjs` (`:91`, `:210`): tratamento versionado da função;
- `assinatura-schema-completo.cjs` e `assinatura-interface-completa.cjs`: preservar os ensaios 075 e criar um ensaio 109 próprio;
- `homologacao-renovacao-staging.cjs:371` e `homologacao-pagamento-renovacao-staging.cjs:453`: separar registro vigente de histórico;
- `renovacao-agendada.postgres.test.ts` (`:88`, `:388`): seleção do vigente e asserção de cadeia;
- `diagnostico-lancamento-production.cjs`, `migration-090-comum.cjs`, `assinatura-staging-ensaio.cjs`: presença da tabela continua sendo só pré-requisito, nunca prova da 109.

---

## 5. Achados da rev. 1 e como foram resolvidos
| Achado | Resolução |
|---|---|
| F1 (P1) data × janela | Sucessor com janela `[data−63, data−30]`: mensal sempre aberta no dia; anual aguarda, com resultado explícito; limites recalculados; retomada pelo sucessor (§2.4, §2.6) |
| F2 (P1) índice parcial × `ON CONFLICT` | `ON CONFLICT DO NOTHING` sem alvo e filtro textual compatíveis com 075 e 109; matriz código × schema; cutover código → 109; rollback declarado (§2.6, §3) |
| F3 (P2) `substitui_id` mutável | Imutável em UPDATE; FK composta à mesma empresa e contratação; raiz paralela recusada; sucessor obrigatório por gatilho diferido (§2.5) |
| F4 (P2) envio incerto | Substituição só em `PENDENTE` sem `aviso_tentado_em`; `AVISANDO` e `REVISAO` ficam como hoje; 23 h corrigido; D-JP-6 futura (§2.3) |
| F5 (P2) suspensão e semântica | 3 métodos mutantes, lista fechada, contagem por fora do bloqueador, tentativas/falhas observadas, estado vigente pós-commit, alerta de suspensão (§1.2–§1.5) |

### 5.1 Achados da rev. 2
| Achado | Resolução |
|---|---|
| R2-F1 (P2) guarda de raiz × `criar` idempotente | `criar` lê o vigente antes e só insere sem linha alguma; histórico sem vigente → `HISTORICO_SEM_VIGENTE`, sem raiz nova; guarda de raiz mantida no banco (§2.6) |
| R2-F2 (P2) `capacidade109` incompleta | Contrato versionado único (`renovacao-schema.ts`) para postcheck, preflight e capacidade, com todos os componentes, incluindo validação, habilitação, eventos, diferimento e hash do corpo; `INCOMPATIVEL` para tudo no cron com código 1, nunca rotulado como janela perdida (§2.5, §2.6) |
| R2-F3 (P3) seis métodos | Lista corrigida e enumerada; teste da lista exata (§1.2, §4) |
| R2-F4 (P3) bateria | Mutantes de elegibilidade e de idade separados; repetição da assinatura; saída de `APLICANDO` seguida de PUT; serialização final; concorrência nas duas ordens (§4) |

Também foram incorporadas as observações das respostas da r2:
- a regra da janela do sucessor vale nos três pontos de uso;
- a substituição é preservada diante de exceção;
- os contadores não são auditoria durável;
- o cutover confere todos os consumidores;
- há anual nos dois casos (janela aberta e aguardando).

### 5.2 Achados da rev. 3
| Achado | Resolução |
|---|---|
| R3-F1 (P2) contrato sem os CHECKs herdados | Retrato completo da tabela (colunas, constraints validadas, índices, gatilhos com eventos, funções com `search_path`) por igualdade de conjunto; conjunto comum 075/109 + diferenças explícitas; mesma precisão nas duas versões; valores capturados de PG descartável e conferidos em real antes de congelar (§2.6, §4) |
| R3-F2 (P3) raízes sem trava | Segurança × idempotência separadas; interleavings (a) e (b) documentados; perdedor de (b) → `ERRO_REPROCESSAVEL` e leitura na próxima execução; testes aceitam a recusa (§2.6) |
| R3-F3 (P3) mutante de elegibilidade | Cenário `PENDENTE` com tentativa preenchida; um mutante por camada (processador, gatilho, UPDATE condicional) com oráculo próprio; `AVISANDO` à parte (§4) |

A capacidade lida uma vez por execução pressupõe o cutover controlado da §3 (sem DDL concorrente durante a execução). Não é monitoramento contínuo de DDL.

### 5.3 Achados da rev. 4
| Achado | Resolução |
|---|---|
| R4-F1 (P2) gatilhos sem `WHEN` e `UPDATE OF` | Gatilho comparado por `pg_get_triggerdef` completo, mais `tgqual IS NULL`, `tgattr` vazio, `tgenabled`, função e identidade da constraint (sem OID); bateria com `WHEN (false)` e `UPDATE OF estado` nas duas versões (§2.6, §4) |
| R4-F2 (P3) trava não espera | A trava advisory recusa sem esperar e a idempotência vale entre rodadas; chamadas diretas a `criar` esperam na trava de linha; três provas distintas com a trava real; espera exigida só onde existe (§2.6, §4) |
| R4-F3 (P3) oráculo do UPDATE | Controle: resolvido, sem exceção, `rowCount = 0`. Mutante: exceção da guarda e ROLLBACK, observados no repositório antes da conversão do resultado (§4) |

Também foram incorporados: índices de suporte das PKs e UNIQUEs no retrato; regra "sem OID nos valores aprovados"; gate em real (production confere 075, a 109 só onde aplicada com autorização, desvio nunca vira valor aprovado); sucessor válido no teste direto do gatilho.

## 6. Decisões para Felipe

**Estado (29/10/2026):** plano rev. 5 (sha `014e2794…`) **APROVADO pelo Astra** (relatório `revisao-plano-b9-production-20261029-astra-r5/RELATORIO.md`, sem achados). Felipe decidiu, todas pela opção recomendada: **D-PUT-1 = PUT + alerta**; **D-JP-1 = automática no cron**; **D-JP-2 = hoje+33**; **D-JP-3 = aceitar o anual**; **D-JP-4 = com frase de substituição**; **D-JP-5 = 109 aprovada**, com a ordem código → 109. Implementação local autorizada nesse escopo (sem commit, sem nada remoto).

- **D-PUT-1:** `REGULAR` com preço divergente: só alerta (recomendado) ou o cron deixa de fazer o PUT.
- **D-JP-1:** substituição automática no cron (recomendada: a regra já está decidida e cada ocorrência gera alerta) ou assistida pelo painel (mesmo banco, mesmo `substituir`).
- **D-JP-2:** data nova ≥ hoje+33 (recomendada; o banco exige ≥ hoje+30).
- **D-JP-3:** anual: aceitar mais um ciclo Fundador com aviso na janela de 63..30 dias (recomendado; o caso é raro e favorável ao cliente).
- **D-JP-4:** texto do aviso substituto: igual ao normal ou com uma frase de que substitui datas anteriores.
- **D-JP-5:** aprovar a migration 109 e a quebra de contrato com o código antigo (§3).
- **D-JP-6 (futura, fora do escopo):** janela perdida depois de tentativa incerta (`AVISANDO`): continua alerta com tratamento manual.

## 7. Fora do escopo
Deploy, cron, envio real, aplicação da 109 em banco real, aplicador e blocos de Shell da 109, commit, push e PR. Ferramenta manual sem mudança. `AVISANDO`/`REVISAO`/aviso devolvido continuam como alerta.

## 8. Implementação LOCAL (29/10/2026) — sem commit, nada remoto

Clone `kidmais-manager-b9-production-20261029`, base staging `fc37e885` (staging depois andou para `1183459c`, #268 contratos, sem sobreposição com estes arquivos). Manifesto: `ambientes-locais/MANIFESTO-b9-production-20261029.txt`.

**Código.**
- `renovacao-agendada.ts`: contagem por empresa (`instrumentarProvedor`, lista fechada dos 6 métodos; `observarRepositorio`, estado vigente pós-COMMIT), `puts` por item e `putsTotais`, alertas `PUT_FORA_DE_APLICANDO`/`PUT_ASSINATURA_REPETIDO`/`PUT_SUSPENSAO_NO_AGENDADO`/`PUT_EM_SIMULACAO`, `AVISO_REAGENDADO*` sempre alerta, substituição preservada no `catch`, janela do sucessor no `avisoNaJanela`.
- `renovacao-fundador.ts`: `SUBSTITUIDA`, `proximaDataDaSerie`, janela do sucessor 63..30 (`AVISO_SUBSTITUTO_DIAS`), ramo da janela perdida só no modo agendado, resultados compostos, frase de substituição no aviso (D-JP-4).
- `renovacao-repositorio.ts`: `criar` lê o vigente antes (`HISTORICO_SEM_VIGENTE` sem raiz nova), `ON CONFLICT DO NOTHING` sem alvo, filtro do vigente em `ler`/`consultarRenovacao`, `substituirRenovacao` (UPDATE condicional + INSERT na mesma transação), projeção de `substitui_id` só com a capacidade 109.
- `renovacao-schema.ts` + `renovacao-schema-retratos.ts`: contrato único (retrato completo por igualdade de conjunto); retratos capturados no PG descartável 18.6 por `scripts/capturar-retratos-renovacao.mjs`; postcheck gerado por `scripts/gerar-postcheck-109.mjs`.
- **Achado da implementação:** o deparse do catálogo depende do `search_path` da sessão (com `public` no caminho, `public.gen_random_uuid()` virava `gen_random_uuid()`). Isso daria INCOMPATIVEL falso em production. Correção: o retrato é sempre lido com `search_path = pg_catalog, pg_temp`, e o caminho da sessão é restaurado; o postcheck faz o mesmo. Há teste com três caminhos.
- Cron, script manual e ferramenta restrita: capacidade lida antes da primeira empresa; `INCOMPATIVEL` → código 1, nada processado. O preflight usa o mesmo contrato.
- Migration `20261029_109_renovacao_substituta.sql` + precheck + postcheck (gerado) + rollback (recusa com histórico); inventário (`check-migrations.mjs`, `production.test.mjs`) e modelo `109` na receita.

**Provas (todas locais).**
- Unitários da renovação: 117/117 (inclui `renovacao-substituta.test.ts` 11, `renovacao-agendada-puts.test.ts` 6, `renovacao-schema.test.ts` 4, cron 19, preflight 7).
- PG descartável (cluster próprio, porta 55763, criado e removido): 8/8 — `renovacao-109` [109], `renovacao-schema` [108 → 109], `renovacao-109-concorrencia` [109], `renovacao-agendada` [097 e 109, com o caso 12 de ponta a ponta], `campanha-090` [089], `contratacao-e8` [atual, 075].
- Mutantes em cópia isolada (clone LF próprio + `npm ci`, removida), controle PASS: 32 mutantes, 31 mortos pela asserção esperada. Exceções declaradas:
  - **M8** (sem `UNIQUE(substitui_id)`): morto só de forma incidental (o rollback ainda remove a constraint). Comportamento equivalente: a unicidade do vigente e a guarda já impedem dois sucessores. É defesa em profundidade, visível ao detector.
  - **D6** (retrato sem diferimento nem def do gatilho): morto pela asserção vizinha ("guarda sem UPDATE"), porque tirar a def também cega o evento. A morte específica pelo diferimento não ficou isolada.
- CI local (32 passos do `ci.yml`): 31 PASS na 1ª rodada. O passo 1 falhou em F1 (`plataforma.test.ts`: `INSERT INTO usuarios_administrativos` no apoio das suítes PG). Corrigido movendo o INSERT para as suítes. `check:v1:static` repetido: PASS (4054 + 103 testes, lint, TypeScript, build). `next-env.d.ts` restaurado.

**Não feito / pendente.**
- Commit, push, PR, aplicador e blocos de Shell da 109, aplicação em qualquer banco real e conferência dos retratos contra o catálogo real de staging e production (versão do PG, CRLF).
- O retrato novo da exportação (`colunas-esperadas`) para a 109 não foi criado: a suíte de exportação não roda no modelo 109. Fica para a etapa do aplicador.
- Revisão do Astra do código.

### 8.1 Revisão do código pelo Astra (29/10/2026): REPROVADO → correções LOCAIS

Relatório: `revisao-codigo-b9-production-20261029-astra/RELATORIO.md` (2 P2, 1 P3; 30/30 hashes conferidos).
- **F1 (P2), preflight saía 2 com o schema INCOMPATIVEL.** Agora `codigoDeSaida` devolve 1 para INCOMPATIVEL (como cron, manual e restrita), 2 para as outras pendências e 0 sem pendência. O teste executa o PROCESSO real com um `pg` falso carregado por `-r` (`scripts/assinatura-renovacao-preflight-pg-falso.test-apoio.cjs`), sem rede: 1, 0 e 2.
- **F3 (P3), HISTORICO_SEM_VIGENTE virava erro genérico.** `processarRenovacao` converte essa exceção de `criar` em `ALERTA_HISTORICO_SEM_VIGENTE`; qualquer outra exceção continua subindo. Há teste pelo processador e pelo executor real.
- **F2 (P2), matriz PG incompleta.** Acrescentado:
  - cadeia de 3 registros com a 2ª substituição REAL. O 1º elo é montado com `session_replication_role = replica` só na transação da fixture: relógio simulado declarado, guarda produtiva intacta. Sobre o último registro foram provados `criar` idempotente, `ler`, o DTO e a exportação com as três gerações e `substitui_id`;
  - fronteira BRT da regra hoje+30: a guarda tem uma única fonte de data, a expressão vira o dia às 03:00Z (instantes injetados) e o fuso da sessão (UTC e UTC+14) não muda a regra. A travessia real da meia-noite NÃO é executada, porque não se injeta relógio na guarda;
  - envio primeiro COM concorrência real (a substituição espera a intenção aberta e é recusada);
  - webhook real (`registrarFalhaEntrega`) × processamento nas duas ordens (OCUPADO / CONTRATACAO_EM_ANDAMENTO sem espera), evento desconhecido sem efeito e só o sucessor indo a REVISAO;
  - falha da consulta de `alertasInformativos` com o relatório final serializado preservando alertas e `putsTotais`;
  - exportação também no modelo 109 (`colunas-esperadas-109.json`, escolhida pela coluna `substitui_id`);
  - título e comentário do teste do repositório corrigidos (a 2ª substituição ali é recusada; a cadeia de 3 está no teste próprio).

**Provas da rodada.**
- Unitários e verificadores: 161/161.
- PG descartável (cluster 55763 recriado e removido): 12/12 — renovação 109 [8 testes], concorrência [8], detector [108→109], cron [097 e 109], exportação [098, 103, 108, 109], campanha 090 e e8.
- Mutantes do delta em cópia isolada: F1 e F3 mortos pela asserção esperada.
- CI local: 32/32 passos (`ambientes-locais/ci-b9p-r2-resumo.log`; os logs por passo `ci-b9p-passo-*.log` foram SOBRESCRITOS por esta rodada); `check:v1:static` 4055 + 103 testes, lint, TypeScript e build. `next-env.d.ts` restaurado.

Os mutantes da rodada anterior continuam valendo para o código não alterado; M8 e D6 seguem discriminados como na §8 (M8 equivalente; D6 morto por asserção vizinha, sem isolamento do diferimento).

### 8.2 Re-revisão do código (r2): APROVADO COM RESSALVAS → ressalva fechada LOCAL (rodada 3)

Relatório: `revisao-codigo-b9-production-20261029-astra-r2/RELATORIO.md`. F1 e F3 encerrados; F2 atendido; uma ressalva P3 (R2-F1): o teste da finalização serializava o retorno de `executarCron` (sem PUT), não o JSON IMPRESSO pelo CLI.
- **Correção:** teste `R2-F1` em `renovacao-109.postgres.test.ts`, que roda o `main` REAL do `scripts/assinatura-renovacao-cron.cjs` como processo filho com `-r lib/assinatura/renovacao-cron-cli.postgres.test-apoio.cjs`. O apoio usa `pg` real apontado ao PG descartável; só a prova de identidade responde como staging e a consulta de `alertasInformativos` falha de propósito. O `fetch` é um Asaas sandbox falso em memória e qualquer outra URL é recusada.
- **Cenário:** renovação REGULAR com o preço do provedor de volta ao Fundador, com PUT da assinatura fora de APLICANDO (D-PUT-1).
- **Conferido no stdout:** `PUT_FORA_DE_APLICANDO`, `puts` do item `{assinatura: 1, foraDeAplicando: 1}`, `putsTotais` com `empresasComTentativa: 1`, `alertasInformativos: []` e código de saída 2. Sem segredo, e-mail ou id do provedor no stdout.
- O teste anterior foi renomeado para o que ele prova (serialização do retorno, sem PUT).
- **Achado na correção:** o `Pool.query` do `pg` chama `connect` com callback; o apoio trata as duas formas.
- **Reforço pedido:** o teste da cadeia de 3 confere os vínculos DENTRO do CSV do pacote (raiz sem vínculo, S1 → raiz, S2 → S1).
- **Provas da rodada:**
  - PG descartável 12/12 (cluster 55763 recriado e removido);
  - mutante `R2F1-fallback-zera-contagens` (fallback que zera as contagens) morto pelo teste R2-F1, na cópia isolada;
  - CI local 32/32 (`ambientes-locais/ci-b9p-r3-resumo.log`, logs `ci-b9p-r3-passo-*.log`); `check:v1:static` PASS; `next-env.d.ts` restaurado.

### 8.3 Conferência da rodada 3: APROVADO

Relatório: `revisao-codigo-b9-production-20261029-astra-r3/RELATORIO.md`. R2-F1 encerrada; nenhuma regressão nova no escopo conferido; 35/35 hashes do manifesto r3 conferidos; evidências (CLI/stdout, vínculos no CSV, mutante, PG 12/12, CI 32/32) verificadas por leitura. Código LOCAL aprovado, sem commit. Próximos passos, cada um com autorização própria: commit/PR para staging; aplicador e blocos Shell da 109; conferência dos retratos contra os catálogos reais; reconfirmar 109 livre; cutover código → 109.
