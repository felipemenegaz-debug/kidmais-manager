# Contratos importados — integração ao Core e agenda por empresa (etapa 2)

Base: `origin/staging` em `6ee59c9` (merge da PR #90). Branch local: `feat/contratos-importados-integracao-20261002`.
Migrations novas: **061** (integração) e **062** (agenda por empresa e unidade). A 060 é da PR #80 (WhatsApp).

**Nada foi publicado nem commitado, e nenhum banco real foi tocado.** Em 03/10/2026, com autorização do Felipe, as
migrations e as suítes PostgreSQL rodaram **só** no cluster sintético `pg-descartavel-061` (127.0.0.1:55498), que foi
encerrado e removido depois (seção 10). A homologação não começou.

## 1. Situação

| Item | Estado |
|---|---|
| Integração de contrato histórico (festa, agenda, contas a receber, caixa) | Implementada localmente; atrás de `CONTRACT_IMPORT_INTEGRATION_ENABLED=false` |
| Agenda separada por **empresa** (062) | Implementada localmente; ainda **não** isola dados antigos sem escopo (seção 5) |
| Agenda separada por **unidade** | Implementada localmente pela **D6 = opção A** (seção 4): só unidade habilitada explicitamente |
| Integração disponível | Só com 061 **e** 062 aplicadas **e** a flag ligada |
| Testes com mocks | Executados (seção 11) |
| Testes com banco real | **35/35 execuções aprovadas** no cluster sintético (seção 11) |
| Homologação | Não iniciada |

**Não anunciar isolamento completo da agenda.** Enquanto houver os registros da seção 5, horários continuam
indisponíveis para todas as empresas (sem revelar quem ocupa).

Decisões do Felipe em vigor:

- Administrativo e Representante autorizado podem conferir.
- Contratos cancelados ficam consultáveis, sem integração operacional.
- Estornos históricos não são inventados.
- D1 (unidade é o recurso exclusivo), D2 (Unidade principal só por reparo explícito), D3 (dono de bloqueio só por
  decisão explícita) e D4 (agenda pública pelo contexto do servidor).
- D5: turnos por empresa ou unidade, preservando os horários já contratados.
- D6 = **opção A** (03/10/2026): habilitação explícita e auditada da unidade para agenda.

## 2. Fluxo e telas da integração

- **Importação** (`/admin/contratos/importar`), em etapas:
  1. Enviar o arquivo.
  2. Dados do contrato e cliente. O registro da importação **não anuncia sucesso**: a tela diz "Falta integrar ao
     sistema".
  3. Festa e agenda:
     - situação do contrato (cancelado ou não comprovado não avança);
     - unidade (só aparece se houver unidade elegível; hoje, nenhuma);
     - pacote de referência, data, horário e convidados.

     Valor diferente do documento é **correção de leitura** e exige motivo. Valor ausente no documento é
     **complemento**.
  4. Pagamentos:
     - situação: nada pago, parte paga, pago integralmente ou "ainda não conferi";
     - parcela recebida exige data efetiva e forma;
     - "à vista", "entrada" ou "30%" no documento **não comprovam pagamento**;
     - a soma é conferida em centavos.
  5. Revisão final. O resumo vem do servidor, e a confirmação exige a declaração de conferência do original em papel
     e **o mesmo hash** do resumo exibido.
- **Importação já existente:** botão "Integrar ao sistema", sem reenviar o arquivo. Não há backfill.
- **Depois da integração:**
  - o contrato mostra "Contrato histórico — assinado em papel";
  - pagamentos "não conferidos" viram a pendência "Conferir pagamentos";
  - links antigos `?importacaoId=` levam ao contrato integrado;
  - a projeção da etapa 1 some.
- **Edição posterior:** pelos serviços do Core. Remarcar ou revisar gera nova versão com assinatura da Kidmais e OTP
  do cliente.

## 3. Agenda por empresa (062): regras

O recurso de agenda é a **unidade**, quando houver unidade elegível; senão, a **empresa inteira**. Duas ocupações
conflitam no mesmo dia, com horários sobrepostos, no mesmo recurso:

```
kidmais062_mesmo_recurso(e1,u1,e2,u2) = (e1 IS NULL OR e2 IS NULL OR e1=e2) AND (u1 IS NULL OR u2 IS NULL OR u1=u2)
```

| Dado | Alcance |
|---|---|
| Contratação com empresa | Só a própria empresa (e a unidade, se houver) |
| Contratação **sem empresa** (legado) | **Todas as empresas** (seção 5) |
| Bloqueio com empresa | Só a empresa (e a unidade, se houver) |
| Bloqueio **sem empresa** (todos os existentes) | **Todas as empresas** até a decisão D3 (seção 5) |
| Revisão/remarcação | Herda empresa e unidade da contratação |

**O que a 062 muda:**

- Colunas de escopo em `fechamentos`, `bloqueios_agenda` e `configuracao_agenda`.
- `kidmais062_ocupacoes_escopo`.
- Quatro corpos substituídos com as **mesmas mensagens e gatilhos**: `kidmais019_validar_destino`,
  `kidmais019_validar_contrato`, `kidmais_proteger_bloqueio_revisao` e `kidmais_validar_agenda_revisao`.

**O que não muda:**

- `kidmais019_ocupa`, `kidmais019_formalizacao` (061) e `kidmais_ocupacoes_operacionais` (061) ficam intactas.
- Lock: o namespace por data (`kidmais:agenda:<data>`) é mantido. Ele é mais grosso que o recurso: empresas
  diferentes na mesma data **esperam** uma pela outra, mas nunca recebem erro de agenda por isso.

**Turnos (D5):** a ordem é unidade → empresa → modelos globais, sem misturar níveis. As linhas existentes viram modelos
globais, e os horários já contratados ficam preservados.

Usar turno próprio de empresa exige republicar as regras comerciais que apontam para os turnos. A validação comercial
aceita turnos globais e da própria empresa.

**Unidade da contratação:**

- em contratação NOVA sem unidade informada, preenchida pelo banco só quando a empresa tem exatamente **uma unidade
  habilitada** (código anterior continua funcionando);
- contratação EXISTENTE só recebe unidade por decisão explícita por registro (seção 5), nunca por "a empresa só tem
  uma unidade";
- imutável depois de definida (trocar de unidade é uma nova contratação);
- o vínculo da integração precisa ter a mesma unidade da contratação.

## 4. Unidade na agenda: D6 = opção A (habilitação explícita)

**Por que não usar o status da unidade:** pela 043, todo estabelecimento nasce `SUSPENSO`, o status é imutável e
`ATIVO` está fechado (D03), sem coluna de motivo. `SUSPENSO` não distingue "ainda não aberta" de "suspensa por
motivo administrativo". Por isso o status **nunca** concede agenda.

**Regra única** (banco e servidor usam a mesma função, `kidmais062_unidade_agendavel`): a unidade é elegível quando
**todas** as condições valem:

- é da empresa e não está `DESATIVADO`;
- a empresa está `ATIVA`;
- existe **habilitação vigente** em `agenda_062_unidades_habilitacao`.

**Quem habilita e revoga:** o Representante autorizado (Gestão, 056) com membership ATIVA **nesta** empresa, sempre
com motivo (5 a 1000 caracteres).

- Servidor: `lib/disponibilidade/unidades-agenda.ts` e a rota `/api/admin/disponibilidade/unidades` (Tenant Context;
  o corpo só escolhe a unidade da própria empresa).
- Banco: a guarda confere de novo o operador, o papel gravado, a unidade e a empresa.
- Auditoria na mesma transação: `AGENDA_UNIDADE_HABILITADA` / `AGENDA_UNIDADE_REVOGADA`, com o motivo.
- Tela: seção "Unidades na agenda" no painel de Disponibilidade.
- **Nenhuma unidade existente é habilitada** pela migration nem por reparo.

**Histórico imutável:**

- no máximo uma habilitação vigente por unidade (índice único parcial);
- a única alteração permitida é a revogação, uma vez;
- habilitar de novo cria outra linha;
- `DELETE` e `TRUNCATE` são recusados;
- a guarda faz parte da estrutura e continua valendo num rollback suave.

**Suspensão administrativa = revogação (com motivo). Efeitos:**

| Situação | Depois da revogação |
|---|---|
| Reservas já gravadas na unidade | **Preservadas**: continuam na unidade e continuam ocupando o horário (ninguém mais reserva por cima) |
| Nova contratação, ou atribuir a unidade a uma contratação | Recusada |
| Proposta antiga (ainda não ocupa) passar a `CONFIRMADO` ou ser formalizada (troca da versão vigente; `validar_destino` da assinatura) | Recusada: seria reserva nova na unidade |
| Alterar data ou horário de reserva da unidade (edição, remarcação, revisão com novo destino, **aquisição do hold** de destino preparado antes da revogação) | Recusada, até habilitar de novo ou fazer nova contratação em unidade habilitada |
| Correção sem mudança de agenda (tema, observações, buffet etc.), revisão no mesmo horário, operações financeiras (conferência, recebimento) e cancelamento nativo | Permitidas (cancelamento provado no banco: libera o horário; a unidade segue revogada) |
| Bloqueio ou turno na unidade | Criar, reativar, mudar data/horário ou mover para a unidade: recusado. Desativar ou corrigir a descrição: permitido |
| Revogação concorrente com uma contratação na unidade | Ordem única de locks (abaixo): a revogação espera quem está gravando e vale para tudo que vier depois |

**Ordem única de locks da agenda:** empresa → unidade → habilitação → duplicidade (só a integração, uma por empresa:
`kidmais:importacao-duplicidade:<empresa>`) → data (`kidmais:agenda:<data>`) → contratação.

- Quem grava na unidade (`kidmais062_travar_habilitacao`, chamada pelos gatilhos e pela integração antes da data)
  pede `FOR SHARE` na empresa, na unidade e na habilitação vigente. Locks compartilhados não conflitam entre si.
- Habilitar/revogar travam a empresa (`FOR SHARE`) e a unidade (`FOR NO KEY UPDATE`) antes de tocar a habilitação, e
  depois não esperam por data nem por contratação. `FOR NO KEY UPDATE` não conflita com o `KEY SHARE` do FK: a
  versão anterior usava `FOR UPDATE`, que fechava ciclo com o FK da reserva (deadlock confirmado na revisão).
- Mudança de status de empresa ou unidade (`UPDATE`) também conflita com o `FOR SHARE` e fica serializada.
- Caminhos nativos que travam a data antes da unidade (formalização) não formam ciclo: os locks de unidade de quem
  grava são compartilhados e não entram na fila atrás de uma revogação em espera. Provas preparadas no PostgreSQL:
  seção 16.

A resposta da revogação informa quantas reservas futuras foram preservadas.

## 5. Dados antigos sem escopo (pendência operacional)

A 062 não atribui escopo a nada existente (sem backfill). Depois dela, **continuam bloqueando todas as empresas**:

1. **Contratações sem `empresa_id`** que ocupam agenda, inclusive com destino de remarcação.
   - São o legado anterior à 054 cujo pacote não tinha empresa.
   - **D7 — contratações legadas sem empresa:** continuam bloqueando o horário para **todas** as empresas e unidades
     (regra `kidmais062_mesmo_recurso`: empresa nula conflita com qualquer recurso). É o alcance conservador de antes
     da 062: nenhum horário é liberado por suposição. A disponibilidade mostra só "indisponível", sem identificar
     cliente, evento ou empresa. Elas aparecem nominalmente na consulta 2 do levantamento.
   - **Sem reparo automático:** nenhuma migration, reparo ou código atribui empresa a contratação existente (teste
     estático). Uma resolução futura exigirá decisão registrada por contratação e autorização própria; não faz parte
     desta entrega.
2. **Bloqueios ativos sem `empresa_id`:** todos os existentes antes da 062 e os criados enquanto a 062 estiver
   removida.
   - Resolução D3: registrar o dono em `agenda_062_bloqueios_resolucao` (quem decidiu e motivo).
   - Depois, rodar `database/repairs/20261002_062_bloqueios_propriedade.sql`, que trava se faltar decisão para
     qualquer bloqueio.
   - O levantamento mostra as empresas do autor do bloqueio só como **indício**.
   - Pelo painel, a própria empresa libera um bloqueio sem dono quando é a dona plausível (autor com vínculo nela, ou
     nenhuma outra empresa ATIVA/SUSPENSA): a decisão vai para `agenda_062_bloqueios_resolucao` e o registro fica
     atribuído e inativo. Quando o bloqueio pode ser de outra empresa, a decisão continua com a plataforma.

3. **Unidade de contratação existente (D2):** decisão por contratação em `agenda_062_fechamentos_resolucao`
   (unidade, quem decidiu, motivo); aplicada por `database/repairs/20261002_062_fechamentos_unidade.sql`, que trava
   se a unidade não estiver habilitada, se a contratação for de outra empresa ou já tiver outra unidade. O reparo
   "Unidade principal" só cria a unidade (SUSPENSO, não habilitada) para empresa sem nenhuma; não atribui nada.

Também ficam com alcance de **empresa inteira** (isoladas entre empresas; dentro da empresa, valem para todas as
unidades até a decisão D2):

- contratações de empresa sem unidade (todas as anteriores à 062 e as de empresas sem unidade habilitada);
- bloqueios da empresa sem unidade.

**Como acompanhar:** `database/repairs/20261002_062_levantamento_agenda.sql` (somente leitura). As consultas "2. GLOBAL"
e "3. GLOBAL" listam nominalmente o que ainda bloqueia todas as empresas. Enquanto devolverem linhas, o isolamento não
está completo. A consulta 3 usa **o mesmo predicado** que trava o reparo de bloqueios (ativo, sem dono, de hoje em
diante); bloqueios passados sem dono aparecem só como contagem (consulta 7). A consulta 6 lista as decisões D2.

A API devolve só "disponível / indisponível". Não expõe evento, cliente, motivo ou dono.

## 6. Disponibilidade pública (D4)

- O contexto vem **só do servidor**: `AGENDA_PUBLICA_EMPRESA_ID` e, opcionalmente, `AGENDA_PUBLICA_UNIDADE_ID`.
  Nenhum parâmetro do navegador escolhe empresa ou unidade.
- **Com a 062:**
  - sem contexto: `503 AGENDA_PUBLICA_NAO_CONFIGURADA`, e a tela pública mostra que a consulta está indisponível;
  - contexto inválido (empresa inativa, UUID malformado ou unidade não elegível): `503 AGENDA_PUBLICA_INDISPONIVEL`;
  - a consulta nunca cai na agenda de todas as empresas.
- **Sem a 062:** comportamento anterior (agenda global), porque o schema ainda não tem escopo.
- O fechamento público já está fechado pelo catálogo público sem tenant (`CATALOGO_PUBLICO_INDETERMINADO`). A
  revalidação de horário dele usa o mesmo contexto.
- Resposta pública: só datas, turnos e "disponível/indisponível". Não inclui eventos, clientes nem bloqueios de ninguém.
  - Ressalva: os registros globais da seção 5 aparecem como "indisponível" para todos.
  - O arquivo comercial legado `data/disponibilidade.json` (exceções e descontos por pacote) continua global; não é
    agenda nem dado de outra empresa.

## 7. Integração (061): regras principais

**Evento histórico:** `kidmais019_ocupa` não muda.

- A isenção vale só na detecção de conflito, por meio de `kidmais061_historico_passado`.
- Ela vale apenas para evento já realizado na data da integração **e** no exato slot integrado.
- Qualquer remarcação, mesmo só de horário, volta a ocupar e a ser validada.

**Formalização:**

- só a versão 1 com `CONFERENCIA_PAPEL`, vínculo, hash do original e nenhuma assinatura dispensa OTP;
- uma versão 2 "em papel" é recusada;
- a versão digital seguinte segue o fluxo nativo da 057.

**Financeiro:**

- toda escrita usa o `tx` da integração, inclusive `registrarRecebimentoPagamento` com `executor`;
- reconciliação em centavos;
- o plano obedece às regras do plano nativo (`validarPlanoPagamento`: 1 a 60 parcelas, soma exata, primeira parcela
  confirma a reserva, vencimentos até a data da festa); fora delas, bloqueia com o motivo (pode ficar "não conferido");
- "não conferido" fica sem obrigação e vira pendência;
- a conferência posterior só vale enquanto a versão conferida é a **vigente**, sem revisão aberta, sem cancelamento e
  sem obrigação nativa já criada; o gatilho da 061 confere vigente/revisão/cancelamento no banco.

**Vencimento depois da festa (exceção histórica):** contrato nativo segue a regra nativa (vencimentos até a festa),
sem mudança. No contrato histórico, uma parcela que vence depois da festa só é aceita quando consta do contrato original
e o operador confirma explicitamente ("Vence depois da festa: consta do contrato original", por parcela). As demais
regras do plano continuam valendo; o vencimento nunca é alterado automaticamente. A exceção fica registrada na decisão
do vínculo e do financeiro e na auditoria `EXCECAO_HISTORICA_VENCIMENTO_APOS_FESTA`; o gatilho da 061 recusa parcela
posterior à festa sem a confirmação gravada para a mesma parcela e o mesmo vencimento.

A exceção vale **só para as parcelas do plano histórico comprovado** (versão 1 do pagamento criado pela integração,
com a confirmação gravada para aquele número e aquele vencimento). Plano substituto, parcela nova ou parcela alterada
não herdam a exceção, mesmo repetindo número e vencimento. Em edição financeira posterior (versão revisada em PIX
parcelado), a parcela histórica preservada sem mudança é aceita pelo serviço **e pelo gatilho financeiro diferido**:
a 061 troca uma única condição de `kidmais_015_validar` (015) — `AND NOT kidmais061_excecao_historica(parcela,
vencimento)` — com o mesmo critério do serviço; precheck exige o corpo exato da 015, o rollback o restaura byte a byte
e o postcheck confere o da 061. Sem essa troca o serviço aceitava e o commit falhava ("Item incompatível com
cronograma"), defeito encontrado pelo cenário PostgreSQL [R5].

**Revisão de contrato histórico no horário original (fora dos turnos atuais) — decisão de 04/10/2026:** a revisão
pode ser aberta e alterada sem mudar empresa, unidade, data ou horário do evento histórico, mesmo quando o slot
original não é um dos candidatos do turno. Nada é recalculado nem deslocado. Regra (`horarioHistoricoPreservado` em
`revisao-operacional.service.ts`): contrato de origem `IMPORTACAO_HISTORICA` cujo destino da revisão é **exatamente** a
reserva vigente — mesma data, início, fim (portanto, mesma duração) e turno; empresa e unidade não mudam na revisão.
Nesse caso a revalidação confere o **intervalo exato** contra as outras reservas confirmadas e bloqueios do mesmo
recurso (`intervaloSemConflito`, mesmas fontes da disponibilidade, excluída a própria contratação) e o hold é auditado
com `horarioHistoricoPreservado: true`. Qualquer mudança de destino — data, início, fim/duração ou turno — segue a regra
nativa (candidato oficial disponível). Preço, elegibilidade e limite de convidados do pacote continuam calculados antes
e sem exceção (a capacidade é do pacote; a ocupação da agenda é por intervalo no recurso). Contrato nativo: sem mudança.

**Pagamentos depois de uma revisão do contrato (caminho oficial):**

| Situação | Caminho |
|---|---|
| Versão conferida (v1) vigente, sem revisão aberta | "Conferir pagamentos" do contrato histórico (registra os recebimentos com as datas reais) |
| Revisão aberta | Concluir ou cancelar a revisão; até lá o Financeiro só informa |
| Revisão concluída (v2 vigente) | Financeiro do contrato → "Criar plano financeiro" na versão **vigente** (valores revisados, regra nativa do plano); depois "Registrar recebimento" com a data real de cada pagamento já feito |
| Já há obrigação financeira | Financeiro do contrato (fluxo nativo de sempre) |

A conferência da v1 depois da revisão continua recusada (não cria obrigação na versão antiga). Para o contrato
histórico revisado, a criação nativa do plano aceita o fechamento `CONFIRMADO` (a reserva já vigente) e mantém a
reserva confirmada; contrato nativo continua exigindo o fechamento com contrato assinado.

**Edições posteriores do financeiro:** a parcela histórica confirmada (mesma parcela, mesmo vencimento) é preservada
sem mudança forçada: não gera pendência `CRONOGRAMA_DATA` e o cronograma consolidado a aceita; parcela nova ou com
vencimento alterado segue a regra da versão vigente.

**Caminho financeiro nas telas:** com obrigação já existente, a tela do contrato e a da importação levam ao
Financeiro do contrato; "Conferir pagamentos" só aparece enquanto a versão conferida é a vigente e não há obrigação.

**Assinado em papel nas telas:** página pública do contrato (status "Assinado em papel", sem aba de contrato
eletrônico, sem aceite e sem comprovante; PDF e assinatura recusados com `CONTRATO_ASSINADO_EM_PAPEL`), resumo da
contratação (tela e PDF), aba Documentos do contrato, leitura "resumir contrato" da IA (não aponta "falta
assinatura") e texto da Central de Festas. Nenhum comprovante é gerado.

**Autenticação recente:** confirmar a integração e conferir pagamentos exigem senha confirmada nos últimos 5 minutos
(mesmo mecanismo nativo da assinatura Kidmais: `reautenticar` em `/api/admin/autenticacao`). A tela pede a senha no
passo final; a senha nunca vai para a rota de integração. Repetição de pedido já gravado não exige (não escreve).

**Possível duplicidade (reescaneamento, data divergente):** nada é unido nem recusado por semelhança. Os candidatos
aparecem na revisão e integrar exige "É outro contrato" **com motivo**, gravado no vínculo e na auditoria
`POSSIVEL_DUPLICIDADE_DESCARTADA` (com data, alcance e sinais de cada candidato). Busca, sempre só na empresa
comprovada e só em contratações ativas:

| Alcance | Critério |
|---|---|
| Mesmo dia da festa decidida | pelo menos um sinal: mesmo cliente, mesmo contato (CPF ou telefone/WhatsApp de **outro** cadastro), mesmo aniversariante (nome normalizado), mesmo valor contratado vigente ou mesmo documento original |
| Outra data — mesmo documento | o mesmo arquivo original (sha256) já integrado, em qualquer data |
| Outra data — data do documento | a data **lida no documento**, quando o operador decidiu outra, com pelo menos um sinal pessoal ou de valor |
| Outra data — dia/mês trocados | a data decidida com dia e mês invertidos (leitura DD/MM × MM/DD), com pelo menos um sinal |
| Outra data — próxima | até 90 dias da data decidida, com pelo menos **dois** sinais entre {cliente ou contato, aniversariante, valor} |

A detecção é serializada **por empresa** (`kidmais:importacao-duplicidade:<empresa>`; a busca alcança outras datas,
então a chave não pode ser a data): a confirmação trava, reconsulta os candidatos com o mesmo critério da simulação e,
se apareceu um novo (confirmado por outro operador, em qualquer data), volta para revisão (`RESUMO_DESATUALIZADO`).
Os candidatos entram no hash da revisão: a decisão "É outro contrato" vale só para os candidatos revisados.

**Limites que permanecem (documentados, sem bloqueio automático):**
- Scan com data divergente **além de 90 dias** que não seja a data lida no documento nem dia/mês trocados, sem o mesmo
  arquivo, não aparece — a conferência humana da data continua sendo a defesa nesse caso.
- Na janela de 90 dias, um único sinal não basta (ex.: o mesmo cliente com outra festa no mês seguinte não aparece);
  dois sinais aparecem mesmo quando é outro contrato legítimo (irmãos, mesmo pacote) — exige só a decisão explícita.
- A festa do ano seguinte do mesmo aniversariante fica fora da proximidade (por desenho).
- Empresas diferentes nunca se veem (isolamento por tenant), mesmo com o mesmo papel.
- Confirmações de contratos históricos da mesma empresa ficam em fila (lock curto, por transação); empresas diferentes
  não se esperam. Fluxos nativos não usam esse lock.
- **Duplicidade concorrente entre fechamento nativo e importação histórica (não serializada):** só a integração usa a
  trava de duplicidade. Um fechamento nativo criado ao mesmo tempo, ainda não commitado, para o mesmo cliente em outra
  data ou outro horário não é visto pela confirmação da importação (e o fluxo nativo não procura importações). O mesmo
  horário no mesmo recurso continua protegido pela agenda; depois do commit, uma nova importação vê o fechamento nativo
  como candidato. Não demonstrado em teste; restrição operacional.

**Idempotência (contrato da API):**

- `UNIQUE(importacao_id)` com lock da importação;
- a mesma chave com o mesmo conteúdo (resumo) devolve o resultado gravado, sem escrever;
- a **mesma chave com outro conteúdo** recebe 409 `IDEMPOTENCIA_CONFLITANTE`;
- outra chave com o mesmo conteúdo (duas abas) devolve o gravado; outra chave com outro conteúdo, 409
  `IMPORTACAO_JA_INTEGRADA`;
- a mesma regra vale para o financeiro.

**Erros do banco na rota:** unidade não habilitada → 409 `UNIDADE_NAO_HABILITADA`; versão conferida não vigente → 409
`VERSAO_NAO_VIGENTE`; FK (`23503`) → 409 `REFERENCIA_INVALIDA`; demais `23514`/`P0001` → 409 sem detalhe interno.
IP da auditoria segue nulo como no restante do Admin (`contextoCrmDaRequest`): não há proxy confiável declarado.

## 8. Compatibilidade código × schema

| Código \ schema | 057 (hoje) | 061 | 062 | 062 removida (suave) |
|---|---|---|---|---|
| Anterior a esta entrega | Hoje | **Festa e assinatura pública 503** (fingerprint estrito da 019) | **503** | **503** |
| Esta entrega | Como hoje; agenda global; integração indisponível | Agenda global; integração indisponível | Isolamento por empresa; integração conforme a flag; pública exige contexto | Agenda global; integração indisponível |

**Por caminho (código novo):**

| Caminho | Como funciona em 057 / 061 / 062 | Evidência local (mocks/estática) | Banco real |
|---|---|---|---|
| Assinatura pública e Festa | `validarAmbienteFesta` aceita os conjuntos completos 019, 061 ou 062, nunca mistura; `kidmais019_validar_destino` mantém a assinatura | `migration-061.test.ts` e `migration-062.test.ts` (conjuntos e hashes) | `agenda-062` etapas 0/1/2; `tenant-festa` em `atual`, `061` e `062` |
| Fechamento | Grava `estabelecimento_id` só quando informado, e só há unidade com a 062 e unidade elegível; o gatilho valida | `administrativo.test.ts`; teste estático de detecção | `agenda-062` (gravação em cada etapa) |
| Pagamentos (confirmação) | `verificarConflitoAgendaParaConfirmacao` escolhe o SQL pela detecção; com a 062, o escopo vem da própria contratação | `escopo.test.ts` | `agenda-062`; `estorno-completo` em `atual`, `061` e `062` |
| Disponibilidade admin e pública, revisão, edição, IA | Escopo opcional; sem a 062, consultas anteriores; ausência de escopo = global conservador (exceto a pública com a 062, que recusa) | `escopo.test.ts` (10 cenários); `migration-062.test.ts` exige detecção em todas as funções do repositório | `agenda-062` |

**Mudança visível:** o painel de Disponibilidade passou a exigir a prova de tenant (`withTenantTransaction`).
Administrador sem membership na empresa perde acesso ao painel. Isso precisa ser confirmado na homologação.

`CONTRACT_IMPORT_INTEGRATION_ENABLED` **não protege os módulos nativos**. Ela só controla a API de integração. Os
módulos nativos ficam protegidos pela ordem "código antes", pelos fingerprints por conjunto e pelos prechecks.

## 9. Publicação e recuperação

### Plano de staging (cada linha é uma operação separada; nenhuma está autorizada por esta PR)

Produção fica fora deste plano. Ela repete a mesma ordem depois da homologação, com autorizações próprias.

| # | Operação | Tipo | Autorização necessária | Pré-condição / verificação |
|---|---|---|---|---|
| S1 | Revisão independente da PR (nova rodada, sobre estas correções) | Revisão | Nenhuma operação remota | PR atualizada; CI verde |
| S2 | Resolver a coordenação com a #80 (inventário por união, 060 antes de 061/062) e rodar **na árvore final mesclada** o `check:v1:static` e a receita PostgreSQL completa (seção 16) no cluster sintético | Local + banco sintético | Autorização do cluster sintético | Merge resolvido localmente; 0 falhas; relatório arquivado |
| S3 | Ler no Render a branch e o auto-deploy do serviço de staging | Leitura de infraestrutura | Leitura do Render | Merge em `staging` não dispara deploy sozinho |
| S4 | Merge da PR em `staging` | Escrita no GitHub | Merge | S1–S3; árvore igual à testada em S2 |
| S5 | Repetir S3 imediatamente antes do deploy | Leitura de infraestrutura | Leitura do Render | Configuração não mudou desde S3 |
| S6 | Configurar `AGENDA_PUBLICA_EMPRESA_ID` (e, se for o caso, `AGENDA_PUBLICA_UNIDADE_ID`) **antes** das migrations | Env | Alteração de env em staging | Sem a 062 o valor é ignorado; com a 062, sem ele a agenda pública fica indisponível |
| S7 | Deploy **manual** do código em staging, flag desligada | Deploy | Deploy de staging | Todas as instâncias novas; health ok; Festa, assinatura pública, fechamento, pagamentos e disponibilidade como antes (schema 057) |
| S8 | Conferir o estado do schema de staging: 055c/055d e 057 aplicadas (exigidas pelos prechecks), inventário igual ao do repositório | SQL de leitura | Leitura no banco de staging | Precheck 061/062 em modo leitura sem erro |
| S9 | **Backup recente** de staging (snapshot do Render ou `pg_dump` lógico) e confirmação do PITR disponível; anotar o instante | Backup | Backup/leitura de configuração do Postgres de staging | Backup concluído e verificável antes de S11 |
| S10 | **Ensaio de restauração e de duração** num clone: restaurar o backup de S9, aplicar 061 + 062 medindo cada passo, rodar postchecks e levantamento, e o rollback da 062 (suave) e da 061 | Banco (clone) | Criar o clone, restaurar e aplicar migrations nele | Restauração comprovada; duração medida decide a janela de S11 |
| S11 | Janela de manutenção: aviso, precheck → 061 → postcheck, depois precheck → 062 → postcheck | Migration | Migration em staging (061 e 062) | S7–S10; `lock_timeout` 5 s; falha = repetir ou parar |
| S12 | Verificação pós-migration: Festa (conjunto 062), assinatura pública, fechamento, pagamentos, disponibilidade | Regressão **com escrita de teste** em staging | Testes com escrita em staging | Sem 503; dados de teste identificados e removíveis |
| S13 | Levantamento de agenda (somente leitura) | SQL de leitura | Leitura no banco de staging | Lista o legado global e os candidatos D2/D3 |
| S14 | Decisões D2 (unidade de cada contratação) e D3 (dono de cada bloqueio) | Decisão de produto | Felipe | Resultado de S13 |
| S15 | Unidade principal, se alguma empresa ativa não tiver unidade | SQL de escrita | Reparo de dados em staging | Cria só a unidade (SUSPENSO, não habilitada) |
| S16 | Habilitar as unidades que vão receber agenda | Ação no app (Representante autorizado, com motivo) | Felipe escolhe; se for o agente, autorização para escrita via app | Antes dos reparos que atribuem unidade |
| S17 | Gravar decisões D2/D3 e rodar os reparos de unidade das contratações e de bloqueios, **com as escritas de agenda pausadas** (aviso; sem contratação, remarcação, bloqueio, assinatura, pagamento que confirme reserva ou integração durante a execução) | SQL de escrita | Reparo de dados em staging + pausa operacional | Os reparos travam se faltar decisão ou unidade habilitada; simulação antes. Travam unidades e todas as datas afetadas em ordem antes de alterar, o que reduz esperas cruzadas mas não exclui deadlock com escrita concorrente (o UPDATE trava a linha); `lock_timeout` só limita a espera. Abortou (40P01/55P03) = nada aplicado; repetir dentro da pausa |
| S18 | Contratações legadas sem empresa (D7) | Nenhuma operação | — | Continuam bloqueando todas as empresas; sem reparo automático; resolução futura só com decisão por contratação e autorização própria |
| S19 | Ligar `CONTRACT_IMPORT_INTEGRATION_ENABLED` | Env + restart/redeploy | Alteração de env em staging | Só depois de S12–S17 |
| S20 | Homologação (seção 13), com dados de teste | Testes com escrita em staging | Homologação | Duas unidades, conflito na mesma unidade, revogação, duplicidade, reautenticação e integração |
| S21 | Recuperação, se necessária (tabela abaixo) | Varia | Autorização específica de cada ação | Nunca voltar ao código anterior com 061/062 aplicadas; restauração do backup de S9 só por decisão explícita |

Riscos da janela S6: durante cada transação, as escritas e parte das leituras em `fechamentos`, `contrato_versoes`,
`festas` (061), `bloqueios_agenda`, `configuracao_agenda`, `estabelecimentos`, `contrato_importacoes` e
`fechamento_revisoes` (062) esperam. Na prática, Festa, fechamento, pagamentos e disponibilidade param nesse
intervalo.

**A duração não foi medida em volume real.** O cluster sintético aplicou o inventário inteiro a partir do schema vazio,
o que não representa o volume de produção. Use S10 para medir.

**Recuperação:**

| Situação | O que fazer | Condições |
|---|---|---|
| Só o código publicado | Voltar o código é seguro | Schema intacto |
| 061 aplicada, sem integração | Rollback da 061 (restaura 019/057 byte a byte); depois o código anterior pode voltar | Recusa se houver qualquer integração **ou se a 062 estiver aplicada** (rollback da 062 antes; o suave basta) |
| 061 com integrações | Desligar a flag. Integrados continuam no Core. Correção forward | Rollback recusa |
| 062 aplicada | Rollback da 062: devolve a agenda global (código novo detecta e volta às consultas anteriores; integração fica indisponível) | Ver abaixo |
| Qualquer momento | **Nunca** voltar ao código anterior com 061/062 aplicadas | Festa e assinatura pública 503 |

O rollback da 062 (`database/rollback/20261002_062_agenda_empresa_unidade_down.sql`):

- **Recusa se houver turno ativo por empresa ou unidade.** Sem a 062, esse turno entraria na agenda de todas as
  empresas. É preciso desativá-lo por decisão explícita antes.
- **Recusa se houver duas reservas simultâneas em recursos diferentes** (empresas diferentes no mesmo horário, de
  qualquer data). Com a agenda global elas passariam a conflitar, e qualquer alteração nessas contratações seria
  recusada pelos gatilhos. Nesse caso **não há volta para a agenda global**; a correção é forward. Isso inclui duas
  **unidades habilitadas** da mesma empresa reservadas no mesmo horário. A recusa foi provada no cluster sintético.
- **Recusa se houver bloqueio ativo com dono (empresa/unidade) no horário de reserva de outro recurso.** Sem a 062 todo
  bloqueio volta a ser global e passaria a conflitar com essa reserva. Desativar o bloqueio por decisão explícita ou
  corrigir para frente.
- **É suave** quando há escopo gravado (contratação com unidade, bloqueio ou turno com empresa, resolução de dono,
  habilitação de unidade): remove só as regras e preserva colunas, dados e o histórico de habilitação **com a guarda**
  (sem as regras, nenhuma habilitação nova nem revogação passa). A 062 pode ser reaplicada e reaproveita a estrutura
  (20 peças, incluindo `agenda_062_fechamentos_resolucao`).
  Provado no cluster sintético.
- **É completo** quando não há escopo gravado: o schema volta a ser igual ao da 061.
- Depois da 062, bloqueios e contratações gravam empresa imediatamente, então na prática só o rollback suave
  costuma estar disponível.
- Para voltar ao código anterior depois de um rollback suave, é preciso também o rollback da 061, que exige não haver
  integração.

## 10. PostgreSQL descartável — execução autorizada em 03/10/2026

**Alvo autorizado:**

| Item | Valor |
|---|---|
| Cluster | `D:\glass\KidMais Manager\ambientes-locais\pg-descartavel-061` (criado novo e **removido** no fim) |
| Host e porta | `127.0.0.1:55498` |
| Papel e `cluster_name` | `kidmais_descartavel` |
| Binários | `C:\Program Files\PostgreSQL\18\bin` (PostgreSQL 18.6) |
| Não acessados | porta 5432, banco `kidmais_manager`, `perfil-v1-revisao`, staging e produção |
| Relatórios (preservados) | `D:\glass\KidMais Manager\ambientes-locais\pg-descartavel-061-relatorios` |

**Bancos sintéticos:**

- os 8 modelos (`kidmais_v1_modelo_atual`, `_053`, `_052`, `_039`, `_042_sem_040`, `_045_sem_040`, `_061`,
  `_062`);
- `kidmais_pacotes_v1_descartavel` e `kidmais_pacotes_v1_rollback`;
- o banco de manutenção `postgres`.

**Orquestrador:** `scripts/pg-descartavel-061.cjs`, com as ações `preparar`, `provar`, `executar`, `encerrar` e
`limpar`. Ele exige `KIDMAIS_CLUSTER_061_AUTORIZACAO="<diretório>|127.0.0.1:55498|kidmais_descartavel"` literal.

**Guardas:**

1. **Conexão explícita:** todo cliente (receita, `conectarDescartavel`, `conectar054`, `gates-c2`, orquestrador) recebe
   host, porta, usuário e banco explícitos, e nenhuma senha é carregada. O cluster usa `trust` só em 127.0.0.1; se o
   servidor pedir senha, a conexão falha (`senhaRecusada`).
2. **Porta 55498 sem `PG*`:** o runner remove do próprio processo e de cada suíte `DATABASE_URL` e **toda** variável
   `PG*` (inclusive `PGOPTIONS`, `PGSERVICE`, `PGSERVICEFILE`, `PGPASSFILE` e `PGSSL*`). Depois repassa
   `KIDMAIS_DESCARTAVEL_PORTA=55498` com a autorização literal `127.0.0.1:55498/kidmais_pacotes_v1_descartavel`
   (`ambienteDaSuite`). A porta nunca vem de `PGPORT`. Sem `KIDMAIS_DESCARTAVEL_PORTA`, os conectores usam a porta
   padrão fixa do código (`PORTA_PADRAO` = 55498, `lib/comercial/alvo-descartavel.ts`); qualquer outra porta exige a
   autorização literal `127.0.0.1:<porta>/kidmais_pacotes_v1_descartavel`. Os conectores recusam processo com
   configuração herdada. A autorização do orquestrador (`KIDMAIS_CLUSTER_061_AUTORIZACAO`) é conferida a cada execução:
   não fica gravada nem vale para outra sessão.
3. **Identidade que aborta:** a prova confere `cluster_name`, endereço, porta, usuário, `data_directory` igual ao
   diretório autorizado, versão 18 e ausência de `kidmais_manager`. Qualquer divergência interrompe; no `preparar`,
   antes, para o servidor que ele mesmo subiu.
4. **Pré-condições:** se o diretório já existir ou a porta estiver ocupada (conexão ou bind em 127.0.0.1 e 0.0.0.0),
   o orquestrador para. Ele não reutiliza nem encerra outro servidor.
5. **Limpeza validada:** antes de remover, confere:
   - caminho absoluto exato;
   - `realpath` do diretório e do pai sem redirecionamento, e nenhum junction/symlink dentro;
   - `postgresql.conf` do cluster sintético;
   - `PG_VERSION` presente e sem `postmaster.pid`;
   - `pg_ctl status` = 3 e porta sem servidor.
6. **Relatórios fora do diretório removido:** log do servidor, saída das suítes, identidade, encerramento e limpeza.

**Execução (03/10/2026, 06:17–06:29):**

| Passo | Resultado |
|---|---|
| `preparar` | Diretório inexistente e porta livre conferidos; `initdb` e start ok. O primeiro `preparar` travou no Windows (o `postgres` herdava os pipes do `spawnSync`): corrigido com `stdio: "ignore"` (log em arquivo), e a identidade foi provada em seguida com `provar` |
| `provar` | `kidmais_descartavel`, 127.0.0.1, 55498, `data_directory` = diretório autorizado, versão 180006, sem `kidmais_manager` |
| Rodada 1 (todas) | 33/35. Falharam as duas suítes novas, por defeitos de **teste** (abaixo) |
| Rodadas 2 e 3 (só as que falharam) | 061: 11/11; 062: 13/13 depois da última correção |
| **Rodada final (todas, modelos recriados)** | **35/35** |
| Revisão antes da PR (só a suíte afetada, cluster recriado e removido de novo) | `agenda-062` 14/14 com o subteste novo da unidade revogada. O primeiro envio falhou porque o teste mudou `convidados` sem `convidados_faturados` (violou uma restrição já existente); o teste foi corrigido para uma correção coerente (tema) |
| `encerrar` | `pg_ctl status` 3, sem `postmaster.pid`, porta 55498 sem socket |
| `limpar` | Diretório removido (`existeDepois: false`); relatórios preservados; `perfil-v1-revisao` intocado |

**Falhas corrigidas (no teste, sem afrouxar asserção):**

- **`SET CONSTRAINTS ALL IMMEDIATE` durava o resto da transação.** Isso antecipava guardas de sequências com vários
  comandos (ledger 015: "Sequência sem evento"; vínculo 061: "fechamento histórico exige vínculo"), que no produto
  rodam cada uma na própria transação. Agora `validarAgora` dispara as verificações pendentes e devolve cada
  restrição ao modo padrão; ele recusa nomes de restrição ambíguos.
- **Subteste que falhava deixava a transação abortada para o próximo.** Agora há `beforeEach` com `ROLLBACK`.
- **O substituto do "código anterior" estava errado.** O postcheck da 019 também confere a linha de base da 016. Agora
  o teste usa o fingerprint estrito da 019, **idêntico** ao `estrutura-019.ts` publicado (HEAD), conferido byte a byte.
- **"Mesmo conteúdo com outra chave" usava hash fabricado.** Agora o teste reenvia o `resumoHash` revisado, e foi
  acrescentada a recusa de conteúdo diferente (`IMPORTACAO_JA_INTEGRADA`).

**Repetir (exige nova autorização):**

```
node scripts/pg-descartavel-061.cjs preparar
node scripts/pg-descartavel-061.cjs executar
node scripts/pg-descartavel-061.cjs encerrar
node scripts/pg-descartavel-061.cjs limpar
```

Para repetir suítes específicas, use `KIDMAIS_POSTGRES_SOMENTE` com os caminhos exatos.

## 11. Evidências

**Mocks, estática e locais:**

| Validação | Resultado |
|---|---|
| `npm run check:v1:static` (worker de PDF, testes unitários, harness de staging, ESLint, `tsc`, `next build`) | **Aprovado** em 03/10/2026: 1767/1767 unitários, 103/103 harness, `tsc` e build ok; lint com 1 aviso preexistente (`lib/inteligencia/skills/catalogo.ts`) |
| `escopo.test.ts`, `migration-062.test.ts`, `migration-061.test.ts`, testes da integração | Aprovados |
| `production.test.mjs` | 37/37; e 37/37 na árvore simulada 060 + 061 + 062 |
| `scripts/importacao-revisao.ui.cjs` (Edge headless, APIs simuladas) | **10/10** em 03/10/2026, incluindo "Integrar ao sistema" |

**Banco real (cluster sintético, 03/10/2026): 35/35 execuções aprovadas** (31 arquivos; `tenant-festa` e
`estorno-completo` em `atual`, `061` e `062`). Relatório:
`ambientes-locais\pg-descartavel-061-relatorios\2026-10-03T09-27-15-736Z-check-v1-postgres.log`.

- Os modelos `061` e `062` foram construídos do schema vazio com precheck, migration e postcheck reais.
- `agenda-062` (14 subtestes):
  - etapas 0/1/2 com o código novo; o código anterior valida antes da 061 e é recusado a partir dela;
  - D6: nenhuma habilitação automática; só o representante habilita;
  - **duas unidades habilitadas da mesma empresa no mesmo horário: aprovadas;**
  - **conflito na mesma unidade: recusado pelo serviço e pelo banco;**
  - **unidade não habilitada: recusada;**
  - revogação: reservas preservadas; novas contratações, remarcação, bloqueio e turno recusados; histórico imutável;
  - unidade revogada ainda aceita correção sem mudar horário, conferência financeira e cancelamento nativos;
  - revogação concorrente;
  - isolamento por empresa e bloqueios por alcance;
  - concorrência entre fluxo nativo e importação;
  - rollback suave e reaplicação; o rollback recusa reservas simultâneas;
  - remarcação histórica;
  - rollback no meio e repetição sem duplicar recebimentos.
- `integracao (061+062)` (11 subtestes): financeiro parcial, integral e não conferido; datas históricas e centavos;
  formalização; vínculo forjado; concorrência; isolamento; falha no meio.
- Nativas aprovadas: Festa, estorno, pagamentos (gates C1–C3), financeiro, 054–059, comercial e SaaS.

**Homologação:** não iniciada.

## 12. Coordenação com a 060 (WhatsApp, PR #80) e com a #84

- A 060 só cria tabelas `whatsapp_atendimento_*`. Não há dependência de schema com a 061 ou a 062.
- Conflitos entre #80 e esta PR (4 arquivos):
  - três criados por esta PR, só de inventário: `scripts/production/check-migrations.mjs` e
    `scripts/production/production.test.mjs` (união, 060 antes de 061 e 062; simulado 37/37) e
    `scripts/regressao-v1-selecao.cjs` (manter a suíte 060 **e** a linha `estorno-completo` com `tambem`);
  - um preexistente entre a #80 e `staging`, não causado por esta PR: `lib/inteligencia/arquitetura.test.ts`.
- #84: nenhum conflito novo; os dela (`conversa.ts`, `aceite-operacional.test.ts`) já existem contra `staging`. Ao
  resolver `aceite-operacional.test.ts`, manter o parâmetro `empresaId` da porta `horarios`.
- A árvore final mesclada precisa repetir `check:v1:static` e a receita PostgreSQL (plano, S2).

## 13. Roteiro de homologação (depois da 062, da configuração pública e da flag)

1. **Agenda:**
   - o Representante habilita duas unidades; as duas recebem festa no mesmo horário; a mesma unidade conflita;
   - revogar uma unidade mantém as reservas dela e bloqueia novas contratações e remarcações;
   - empresa A ocupa um horário; empresa B vê o mesmo horário livre;
   - a agenda pública sem contexto mostra indisponibilidade;
   - com contexto, vê só a própria empresa;
   - o levantamento lista o que ainda é global.
2. **Painel de Disponibilidade:**
   - administradores com membership acessam;
   - bloqueio sem dono aparece como anterior à separação por empresa e pode ser liberado pela empresa dona plausível
     (ver item 2 acima); quando pode ser de outra empresa, só a plataforma decide;
   - bloqueio novo pertence à empresa.
3. **Importação nova (evento futuro, parte paga):**
   - "Falta integrar" aparece depois do registro;
   - "à vista" não marca pagamento;
   - soma divergente bloqueia;
   - depois de integrar: festa, horário ocupado só na empresa, parcela a receber e recebimento no caixa na data real.
4. **Evento passado:** vai ao Histórico sem ocupar a agenda. Remarcado, volta a ocupar e é validado.
5. **"Não conferido":** vira pendência; repetir a conferência não duplica.
6. **Regressão nativa:**
   - fechamento admin e público (o público segue fechado pelo catálogo);
   - assinatura pública, festa automática, recebimento e estorno;
   - revisão e remarcação.
7. **Desligar a flag:** a integração fica indisponível e os integrados continuam no Core.

## 14. Contratos já importados

Não há backfill. Com a flag ligada, para cada contrato:

1. Abrir o contrato importado.
2. Conferir o original.
3. Clicar em "Integrar ao sistema".

Pagamentos que não puderem ser conferidos agora ficam como "Ainda não conferi".

## 15. Limitações

- **Unidades:** só recebem agenda depois da habilitação explícita pelo Representante; nenhuma vem habilitada.
- **Dados da seção 5:** continuam globais até a resolução.
- O Core não tem destino financeiro (conta ou caixa). A forma de pagamento fica em cada recebimento.
- `assinado_em` do contrato integrado é o instante da conferência. A tela deixa claro que é conferência em papel.
- Fechamento público continua fechado pelo catálogo público sem tenant.
- Revisões futuras exigem cadastro completo do cliente e do aniversariante.

## 16. Correções das revisões independentes (R2 a R5) e receita PostgreSQL para aprovação

Situação: correções **locais**, sem commit, push ou operação remota. **Receita executada em 04/10/2026** no cluster
sintético autorizado, na árvore local atual (não mesclada com a #80) — resultados em "Execução de 04/10/2026" abaixo.

**Isolamento dos testes:** execução local comum (`node --test` direto, globs) não conecta: o conector
(`lib/comercial/postgres-descartavel.ts`) exige opt-in explícito (`KIDMAIS_POSTGRES_DESCARTAVEL=kidmais_pacotes_v1_descartavel`),
porta explícita e a autorização literal, **antes** de abrir socket — variáveis herdadas (`DATABASE_URL`, `PG*`,
`KIDMAIS_HOMOLOGACAO_DATABASE_URL`) não substituem o opt-in e não há porta padrão. Depois de conectar, confere banco,
endereço 127.0.0.1, porta, papel e `cluster_name` antes de qualquer outro SQL. Suítes com cliente próprio só o criam
depois do conector guardado (teste estático em `alvo-descartavel.test.ts`).

**Cenários PostgreSQL preparados:**

| Suíte | Cenário | Prova |
|---|---|---|
| agenda-062 | [R2] rollback da 061 com a 062 aplicada | recusado antes de remover qualquer coisa |
| agenda-062 | [R2] revogação fecha as outras portas | confirmar/formalizar proposta antiga, hold, reativar/mudar bloqueio, criar turno: recusados; reserva preservada segue |
| agenda-062 | [R2] ordem de locks | 3 interleavings com 2 e 3 conexões, espera observada em `pg_stat_activity`; critério: nenhum 40P01 |
| agenda-062 | [R2] reparos por decisão | D2 só decididos e com unidade habilitada; D3 com o mesmo predicado do levantamento |
| agenda-062 | [R2] rollback da 062 | bloqueio com dono sobre reserva de outro recurso recusa; depois do suave, a 061 só recusa por integração |
| agenda-062 / integracao | [R2] idempotência | mesma chave com outro conteúdo = `IDEMPOTENCIA_CONFLITANTE` |
| integracao | [R2] conferência posterior | serviço e gatilho recusam a versão antiga |
| integracao | [R2] reescaneamento | candidato entre clientes; sem decisão não integra; com motivo integra e audita |
| integracao | [R2] autenticação recente | 403, nada gravado |
| integracao | [R3] exceção histórica no banco | sem confirmação, confirmação negada ou de outro vencimento: recusado; confirmação certa: aceita, vencimento intacto |
| integracao | [R3] caminho oficial depois da revisão | na v1: `CONFERENCIA_HISTORICA_PENDENTE`; com a v2 vigente: obrigação na v2 com o valor revisado, reserva confirmada, fechamento CONFIRMADO, recebimento com data passada |
| integracao | [R5] página pública e resumo PDF da versão **persistida** (N1) | snapshot gravado pela importação, sem endereço e sem enriquecimento: PDF gerado com "Não informado"; contexto PAPEL, sem aceite, sem documento eletrônico lido |
| integracao | [R5] duplicidade concorrente (N2) | dois scans distintos em duas conexões (evento passado; futuro em slots diferentes): o segundo espera o lock de duplicidade (observado em `pg_stat_activity`), recebe `RESUMO_DESATUALIZADO` com o primeiro contrato; sem decisão não integra; com "É outro contrato" e motivo integra e audita `POSSIVEL_DUPLICIDADE_DESCARTADA` |
| integracao | [R6] horário histórico fora dos turnos: revisão sem mudança de destino e correção sem mudança de horário | contrato integrado em 14:00–18:00 (turno TURNO_1, não candidato — precondição conferida); revisão nativa aberta, edição de convidados com revisão comercial, assinaturas nativas, `validarAgora`; destino intacto e hold auditado como preservado; mudança só do fim (duração) recusada; segunda revisão (tema) sem mudança de horário |
| integracao | [R6] horário histórico: remarcação válida e com conflito | conflito no horário oficial recusado; horário histórico em outra data recusado (exceção não vale para destino novo); recusas não alteram a reserva; remarcação para horário oficial livre aplicada pelas assinaturas nativas e horário original liberado |
| integracao | [R6] horário preservado: própria transação e commit | bloqueio legado plantado na própria transação (não commitado) faz a revisão no horário histórico ser recusada; sem ele, aceita; o banco recusa bloqueio novo sobre a reserva vigente pela regra geral da 062 ("Bloqueio conflita com contratação vigente"), com ou sem revisão. O gatilho do hold da revisão (`kidmais_validar_agenda_revisao`, que confere o intervalo no commit) não foi exercitado especificamente por este cenário |
| agenda-062 | [R6] trava de duplicidade por empresa | mesma empresa, unidades e datas diferentes: B espera a trava da empresa (observado), a revogação da unidade de B espera B; A commita, B volta para revisão com o contrato de A, a revogação conclui e a unidade revogada não integra; outra empresa (outra data) confirma sem esperar; nenhum 40P01 |
| integracao | [R6] busca complementar de duplicados | data lida no documento (decidida 130 dias depois) e data próxima (7 dias, dois sinais) aparecem e exigem decisão; com motivo integra e audita data/alcance; nada é unido; festa do ano seguinte e outra empresa não aparecem |
| integracao | [R6] corrida com datas divergentes | terceiro caso da corrida [R5]: scans em datas a 7 dias; o segundo espera o lock por empresa e volta para revisão com o primeiro |
| integracao | [R5] revisão e assinaturas **nativas** + edição financeira real (N4, R4-2, N3) | `nova_versao` → `editar_festa` → PDF/revisão/assinatura Kidmais/liberação → assinatura do cliente pelo fluxo público (OTP capturado) com `validarAgora`; v2 vigente; pendência sem `CRONOGRAMA_DATA`; `resolverAlteracao` preservando a parcela histórica aceita; vencimento alterado e parcela nova pós-festa recusados; parcela de plano substituto com mesmo número e vencimento fora da exceção |
| agenda-062 | [R5] formalização nativa em unidade revogada (N5) | proposta gerada por `gerarContrato`, assinada pela Kidmais; unidade revogada; assinatura do cliente (UPDATE real de `contrato_fluxos`) recusada, nada formalizado; unidade reabilitada: mesma proposta formaliza, passa nas diferidas e ocupa |

### Receita (cenários [R6] — executada em 04/10/2026, ver "Execução R6" abaixo)

Os cenários até [R5] rodaram em 04/10/2026 ("Execução R5" abaixo). Os cenários **[R6]** (tabela acima) estão escritos e
**não executados**. Risco declarado: os cenários do horário histórico usam o turno semeado TURNO_1 e acrescentam ao
catálogo do cenário a categoria PADRAO como regra mais recente desse turno e a elegibilidade do pacote; podem exigir
ajuste de **fixture** na primeira execução — registrado com justificativa, sem afrouxar asserções. A corrida [R6]
**commita** dados sintéticos de uma empresa nova (como a corrida [R5]); o cluster é descartado no fim.

**Alvo (idêntico ao autorizado em 04/10/2026, cluster novo):**

| Item | Valor |
|---|---|
| Diretório do cluster (criado novo, removido no fim) | `D:\glass\KidMais Manager\ambientes-locais\pg-descartavel-061` |
| Relatórios (preservados, fora do diretório) | `D:\glass\KidMais Manager\ambientes-locais\pg-descartavel-061-relatorios` |
| Binários | `C:\Program Files\PostgreSQL\18\bin` (PostgreSQL 18) |
| Host / porta | `127.0.0.1` / `55498` (bind só em 127.0.0.1; autenticação `trust` só local) |
| Papel e `cluster_name` | `kidmais_descartavel` |
| Bancos sintéticos | modelos `kidmais_v1_modelo_atual`, `_053`, `_052`, `_039`, `_042_sem_040`, `_045_sem_040`, `_061`, `_062`; `kidmais_pacotes_v1_descartavel`; `kidmais_pacotes_v1_rollback`; manutenção `postgres` |
| Nunca acessados | porta 5432, `kidmais_manager`, `perfil-v1-revisao`, staging, produção; nenhum dado real restaurado |
| Worktree | `D:\glass\KidMais Manager\kidmais-manager-importados-integracao` (árvore local atual, não mesclada) |

**Ambiente do processo (PowerShell, na worktree):**

```
Remove-Item Env:DATABASE_URL, Env:KIDMAIS_HOMOLOGACAO_DATABASE_URL -ErrorAction SilentlyContinue
Get-ChildItem Env: | Where-Object Name -like 'PG*' | ForEach-Object { Remove-Item "Env:$($_.Name)" }
$env:KIDMAIS_CLUSTER_061_AUTORIZACAO = 'D:\glass\KidMais Manager\ambientes-locais\pg-descartavel-061|127.0.0.1:55498|kidmais_descartavel'
```

(O opt-in `KIDMAIS_POSTGRES_DESCARTAVEL`, a porta e a autorização literal de cada suíte são definidos pelo
orquestrador só para o processo filho; não ficam no ambiente do usuário.)

**Comandos, efeitos e limpeza:**

| # | Comando | Efeito | Para se |
|---|---|---|---|
| 1 | `node scripts/pg-descartavel-061.cjs preparar` | confere que o diretório **não existe** e a porta está livre (127.0.0.1 e 0.0.0.0); `initdb` com papel `kidmais_descartavel`, `cluster_name`, `listen_addresses=127.0.0.1`, porta 55498; inicia o servidor (log em arquivo); prova a identidade | diretório existe, porta ocupada ou identidade divergente (para o servidor que ele mesmo subiu) |
| 2 | `node scripts/pg-descartavel-061.cjs provar` | confere `cluster_name`, endereço, porta, papel, `data_directory` = diretório autorizado, versão 18 e ausência de `kidmais_manager`; grava `identidade-*.json` nos relatórios | qualquer divergência |
| 3 | `$env:KIDMAIS_POSTGRES_SOMENTE='lib/disponibilidade/agenda-062.postgres.test.ts,lib/contratos/integracao-importados/integracao.postgres.test.ts'; node scripts/pg-descartavel-061.cjs executar` | rodada focada nas duas suítes afetadas; cria os bancos sintéticos necessários a partir do schema vazio (inventário real de migrations, 061 e 062 com precheck/postcheck) | primeira falha registrada no relatório |
| 4 | `Remove-Item Env:KIDMAIS_POSTGRES_SOMENTE; node scripts/pg-descartavel-061.cjs executar` | rodada completa (todas as suítes, modelos recriados) | — (relatório completo) |
| 5 | `node scripts/pg-descartavel-061.cjs encerrar` | `pg_ctl stop`; confere status 3, sem `postmaster.pid`, porta sem socket | servidor não para |
| 6 | `node scripts/pg-descartavel-061.cjs limpar` | remove **só** o diretório do cluster depois de validar caminho absoluto exato, `realpath` sem junction/symlink, `postgresql.conf` do cluster sintético, `PG_VERSION`, sem `postmaster.pid`, porta livre; preserva os relatórios | qualquer validação falha (nada é removido) |

**Critério de aprovação:** 0 falhas nas duas rodadas; nenhum `40P01` nos cenários de ordem de locks (só então a
hipótese de ausência de deadlock passa a comprovada **para os cenários testados**); nenhuma asserção afrouxada — falha
de teste é corrigida no teste com justificativa registrada, falha de produto volta para correção local e nova revisão.

**Depois:** repetir 1–6 na árvore final mesclada com a #80 (plano, S2), com autorização própria e validação separada; atualizar a matriz.

### Execução de 04/10/2026 (autorizada; árvore local atual, não mesclada)

| Passo | Resultado |
|---|---|
| `preparar` / `provar` | Diretório inexistente e porta livre conferidos; identidade: `kidmais_descartavel`, 127.0.0.1:55498, `data_directory` = diretório autorizado, PostgreSQL 180006, sem `kidmais_manager` |
| Rodada focada 1 | 061: 13/17; 062: 11/19. Causas: (1) **defeito de produto** — o gerador da 061 emitia `DO $ BEGIN` (edição com `String.replace` trocou `$$` por `$`), rollback da 061 com erro de sintaxe; três falhas seguintes eram cascata (rollback suave da 062 já aplicado); (2) **produto** — contrato histórico na v1 recebia o erro de condição comercial antes da orientação "Conferir pagamentos"; (3) **coerência** — candidatos D2 do levantamento só listavam contratações que já ocupam, o reparo aceita qualquer não cancelada; (4) **teste** — reescaneamento mudava o horário sem o motivo exigido; (5) **teste** — leitura do PID na mesma conexão bloqueada (espera do próprio teste até o `lock_timeout`; nenhum `40P01`) |
| Correções | gerador da 061 corrigido e regenerado + teste estático de delimitadores `$tag$` pareados (comprovado: falha com o defeito, passa corrigido); decisão histórica antes da validação do plano; mesmo predicado de candidatos D2 no levantamento e no reparo (+ estático); motivos de correção no teste; PIDs lidos antes da corrida. Nenhuma asserção afrouxada |
| Rodada focada 2 | **061: 17/17; 062: 19/19** |
| Regressão completa | **35/35 execuções (35 arquivos, cada um no estado declarado), 205/205 testes, 0 falhas** |
| Deadlock | 0 ocorrências de `40P01`/"deadlock detected" nos três relatórios e no `server.log` |
| `encerrar` / `limpar` | `pg_ctl` status 3, sem `postmaster.pid`, porta livre; diretório removido (`existeDepois: false`); relatórios preservados |

Relatórios: `ambientes-locais\pg-descartavel-061-relatorios\2026-10-04T01-34-12-796Z-check-v1-postgres.log` (rodada 1),
`…T01-38-07-066Z-…` (focada 2) e `…T01-38-41-971Z-…` (completa).

**Ausência de deadlock — comprovada só para os cenários testados:** (1) reserva com a habilitação travada × revogação
(padrão do deadlock anterior), (2) revogação primeiro × reserva, (3) data travada antes × reserva × revogação (três
conexões). Não comprovada para outras combinações (ex.: mudança de status de empresa/unidade concorrente, reparos
concorrentes com reservas, várias datas na mesma transação).

### Execução R5 de 04/10/2026 (autorizada; árvore local atual, não mesclada)

| Passo | Resultado |
|---|---|
| `preparar` / `provar` | diretório inexistente e porta livre; identidade `kidmais_descartavel`, 127.0.0.1:55498, `data_directory` autorizado, PostgreSQL 180006, sem `kidmais_manager` |
| Rodada focada 1 | 061: 18/20; 062: 18/20 — os dois cenários nativos falharam no **fixture** (`catalogoNativo`) |
| Ajustes de fixture (sem afrouxar asserção) | (1) tabela publicada só com `publicada_em`, como o caminho real (a 035 exige tabela inativa); (2) escopo comercial declarado (047) igual ao único preço do cenário; (3) evento do N4 num horário candidato do turno (limitação da revisão nativa acima); (4) elegibilidade comercial do pacote no turno; (5) pedidos financeiros com o saldo novo calculado por `posicaoEconomica` (parcela histórica + complemento antes da festa) e base negociada R$ 6.000 para haver complemento; (6) `substituido_em` ao marcar plano substituído |
| **Defeito de produto** | gatilho financeiro diferido da 015 recusava no commit a parcela histórica preservada (PIX depois da festa) — o serviço aceitava. Corrigido na 061 (seção "Vencimento depois da festa"), com precheck/rollback/postcheck gerados e testes estáticos novos |
| Asserções reforçadas | N3: planos criados pela resolução nativa (versão > 1) fora da exceção; função do banco `kidmais061_excecao_historica` com o mesmo resultado do serviço |
| Rodada focada final | **061: 20/20; 062: 20/20** |
| Regressão completa | **35/35 execuções (35 arquivos, cada um no estado declarado), 209/209 testes, 0 falhas** |
| Deadlock | 0 `ERROR: deadlock detected`/`40P01` nos relatórios e no `server.log` (as ocorrências do texto são o aviso dos reparos registrado junto com o SQL) |
| `encerrar` / `limpar` | `pg_ctl` status 3, sem `postmaster.pid`, porta livre; diretório removido (`existeDepois: false`); relatórios preservados |

Relatórios: `ambientes-locais\pg-descartavel-061-relatorios\2026-10-04T02-14-08-045Z-check-v1-postgres.log` (focada 1),
`…T02-25-10-607Z-…` (focada final) e `…T02-25-46-059Z-…` (completa).

**Ausência de deadlock — comprovada só para os cenários testados:** os três de 04/10 (reserva × revogação) e,
nesta rodada, duas confirmações de scans distintos do mesmo dia (evento passado; futuro em slots diferentes).

### Execução R6 de 04/10/2026 (autorizada; árvore local atual, não mesclada)

| Passo | Resultado |
|---|---|
| `preparar` / `provar` | diretório inexistente e porta livre; identidade `kidmais_descartavel`, 127.0.0.1:55498, diretório autorizado, PostgreSQL 180006, sem `kidmais_manager` |
| Rodada focada 1 | 061: 20/24 (3 cenários do horário histórico + 1 subteste pai); 062: 21/21. Causa única: **fixture** — a nova regra de categoria do turno semeado sobrepunha a vigência aberta da 006 |
| Ajuste de fixture | `catalogoNoTurno` encerra a vigência aberta anterior na véspera antes de gravar a nova (como o cadastro). Nenhuma asserção alterada |
| Defeitos de produto | nenhum nesta rodada |
| Rodada focada final | **061: 24/24; 062: 21/21** |
| Regressão completa | **35/35 execuções, 214/214 testes, 0 falhas** |
| Deadlock | 0 `ERROR: deadlock detected`/`40P01` nos relatórios e no `server.log` |
| `encerrar` / `limpar` | `pg_ctl` status 3, sem `postmaster.pid`, porta livre; diretório removido; relatórios preservados |

Relatórios: `…\2026-10-04T02-57-03-970Z-check-v1-postgres.log` (focada 1), `…T02-57-56-536Z-…` (focada final),
`…T02-58-30-241Z-…` (completa).

**Ausência de deadlock — só nos cenários executados:** os três de reserva × revogação (04/10, R4/R5), as corridas de
scans distintos (mesmo dia/passado, slots diferentes, datas divergentes) e, nesta rodada, a corrida com duas unidades e
datas diferentes da mesma empresa com revogação no meio. Não comprovada para outras combinações (ex.: revogação da
unidade de quem já segura a trava da empresa, várias confirmações em fila com revogações sucessivas).

**Pendências conhecidas:**
- Contratações legadas sem empresa (D7): bloqueio global definido; resolução futura fora desta entrega.
- Repetir a receita na árvore final mesclada com a #80 (S2), com autorização própria.
