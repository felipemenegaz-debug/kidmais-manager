# Proposta da Migration 014 — preparação operacional pós-assinatura

Status: desenho para aprovação do DDL, com correção da regra de reserva solicitada após a aprovação conceitual, em 09/09/2026. **Não é migration executável nem autorização para implementação.** Nesta etapa foi feita somente inspeção de leitura e criado este documento. Não foram criados arquivos SQL, alterados código funcional, dados, migrations anteriores ou schema de referência.

## 1. Decisão proposta e fonte de verdade

Manter V1 assinada/vigente e o Fechamento operacional atual. Criar uma preparação tipada em Fechamento, vinculada à V2 e à V1 que lhe deu origem. Contrato documenta essa preparação; não se torna proprietário de pacote, agenda, convidados, buffet ou negociação.

São propostas **duas tabelas novas**, `fechamento_revisoes` e `fechamento_revisao_adicionais`. A própria revisão é dona da pré-reserva; não criar uma terceira tabela cadastral nem usar `bloqueios_agenda` como depósito de reservas de contratos. Bloqueio administrativo e pré-reserva têm donos e ciclos diferentes, mas compartilham a mesma serialização da agenda.

| Informação | Fonte de verdade |
|---|---|
| Operação vigente | `fechamentos` e `fechamento_adicionais` |
| Operação proposta | As duas novas tabelas |
| Cadastro compartilhado | CRM: clientes, aniversariantes e responsáveis |
| Condição proposta e decisão comercial da revisão | Preparação tipada + histórico de `aprovacoes_negociacao` vinculado à revisão exata |
| Documento e conteúdo contratual aceito | Snapshot/hash da versão, PDF BYTEA e provas imutáveis existentes |
| Qual versão é vigente | `contrato_fluxos.versao_vigente_id`, coerente com `contratos` |
| Obrigação financeira original | Versão assinada referenciada pelo Pagamento existente |
| Diferença financeira não resolvida | `contrato_pendencias_financeiras` existente |
| Ocupação da agenda | União explícita descrita na seção 7, sem copiar a agenda para JSON |

A iniciativa pode ser administrativa. Não exigir solicitação prévia do cliente. O acabamento aprovado, inclusive atalhos 110/130/140 e edição pré-assinatura, permanece.

## 2. Inspeção física efetivamente realizada

Banco local `kidmais_manager`, PostgreSQL **18.6**, Windows. Inspeção em transação **REPEATABLE READ, READ ONLY**, encerrada com rollback, sem DDL/DML. Foram consultados catálogo físico, tipos completos via `format_type`, defaults, nulabilidade, constraints e triggers, além de contagens e hashes de linhas completas.

Comparação com `.backups/acabamento-1788998049484/dados.json` e `catalogo.json`, usando a mesma serialização do verificador aprovado: **38 tabelas, nenhuma diferença de dados; colunas/defaults/constraints/triggers iguais ao checkpoint**. Uma primeira comparação experimental usou outra serialização de JSON; ela foi descartada e refeita com o algoritmo original. Não houve alteração de dados entre as comparações.

| Tabela atual | Linhas |
|---|---:|
| adicionais | 31 |
| aniversariantes | 1 |
| aprovacoes_negociacao | 3 |
| auditoria | 24 |
| bloqueios_agenda | 7 |
| clientes | 2 |
| configuracao_agenda | 2 |
| contrato_assinaturas | 0 |
| contrato_documentos | 2 |
| contrato_edicoes | 1 |
| contrato_fluxos | 1 |
| contrato_pendencias_financeiras | 0 |
| contrato_versoes | 4 |
| contratos | 3 |
| eventos_historico_cliente | 27 |
| fechamento_adicionais | 1 |
| fechamentos | 9 |
| limites_autenticacao | 1 |
| mesclagens_clientes | 0 |
| pacotes | 7 |
| pagamento_comprovantes | 1 |
| pagamento_estornos | 1 |
| pagamento_parcelas | 5 |
| pagamento_planos | 3 |
| pagamento_recebimento_alocacoes | 3 |
| pagamento_recebimentos | 3 |
| pagamentos | 2 |
| possiveis_duplicidades_cliente | 1 |
| precos_adicional | 66 |
| precos_pacote | 69 |
| regras_categoria_horario | 14 |
| regras_desconto_pacote | 16 |
| regras_disponibilidade_pacote | 98 |
| responsaveis_adicionais | 0 |
| sessoes_administrativas | 1 |
| tabelas_preco | 1 |
| usuarios_administrativos | 1 |
| validacoes_identidade_cliente | 15 |

Fechamentos atuais: 3 `AGUARDANDO_APROVACAO`, 4 `AGUARDANDO_CONTRATO`, 1 `AGUARDANDO_PAGAMENTO`, 1 `CONFIRMADO`. Portanto, **assinatura e ocupação confirmada não são sinônimos no sistema atual**.

Constatações relevantes:

- A consulta de ocupações lê somente Fechamentos `CONFIRMADO`; não existe preparação operacional física.
- A confirmação de reserva adquire `pg_advisory_xact_lock(hashtextextended('kidmais:agenda:' || dataISO, 0))` e verifica bloqueios ativos e outros Fechamentos confirmados.
- `criarBloqueioAgenda` usa esse mesmo lock, mas insere o bloqueio sem verificar preparações — que ainda não existem. As rotinas de desativação não adquirem esse lock atualmente.
- Pagamentos organiza a escrita como Fechamento → Pagamento → lock da data. Contrato também bloqueia Fechamento antes das entidades contratuais.
- O índice `contrato_versoes_em_preparacao_uk` permite uma versão `ATIVA` por contrato.
- `kidmais_preservar_edicao_contrato` **já permite** `ASSINADA_KIDMAIS → CANCELADA` e `AGUARDANDO_CLIENTE → CANCELADA`. Não é necessário substituir essa função para inventar tais transições.
- `kidmais_validar_fluxo_contrato` já exige coerência entre cancelamento da edição e `contrato_versoes.status='CANCELADA'`. V1 `ASSINADA` é imutável.
- Auditoria já bloqueia UPDATE/DELETE. Provas, documentos e pendências financeiras também têm proteção de imutabilidade.
- Aprovações atuais não têm FK para preparação nem revisão otimista: essa associação é parte do delta proposto.

## 3. Estrutura completa de `fechamento_revisoes`

Convenções: **NN** = NOT NULL; **N** = aceita NULL; “sem” = sem DEFAULT. Todos os timestamps são `timestamptz`. Valores monetários armazenados em `numeric(12,2)`, como no domínio atual; entrada com fração de centavo é rejeitada **antes** da conversão para esse tipo, pois o PostgreSQL pode arredondá-la. Não usar tolerância monetária.

### 3.1 Identificação, ciclo, integridade e autoria

| Coluna | Tipo | Null | Default | Finalidade |
|---|---|---|---|---|
| id | uuid | NN | gen_random_uuid() | PK e dono estável da reserva |
| fechamento_id | uuid | NN | sem | Fechamento operacional |
| contrato_id | uuid | NN | sem | Viabiliza FKs compostas de pertencimento |
| contrato_versao_id | uuid | NN | sem | V2, exclusiva desta preparação |
| versao_base_id | uuid | NN | sem | V1 vigente ao iniciar; imutável |
| estado | varchar(20) | NN | 'EM_ELABORACAO' | Quatro estados, sem duplicar estados documentais |
| revisao | integer | NN | 1 | Controle otimista do conteúdo preparado |
| motivo | text | NN | sem | Justificativa da revisão; mudanças posteriores auditadas |
| origem | varchar(30) | NN | 'ATENDIMENTO_KIDMAIS' | Único valor permitido neste bloco |
| chave_criacao | uuid | NN | sem | Idempotência da solicitação inicial |
| fonte_base_hash | char(64) | NN | sem | SHA-256 canônico do estado operacional base |
| conteudo_hash | char(64) | NN | sem | SHA-256 do conteúdo tipado + adicionais ordenados |
| hold_destino_adquirido_em | timestamptz | N | sem | Aquisição validada do hold do destino atual, somente após reserva vigente CONFIRMADA |
| revisao_comercial_aprovada | integer | N | sem | Número exato aprovado |
| aprovacao_negociacao_id | uuid | N | sem | Decisão positiva específica; não decisão da V1 |
| aprovado_comercial_por_usuario_id | uuid | N | sem | Administrador real |
| aprovado_comercial_em | timestamptz | N | sem | Instante da decisão |
| congelado_snapshot_hash | char(64) | N | sem | Snapshot contratual que documenta esta preparação |
| congelado_documento_id | uuid | N | sem | PDF exato assinado pela Kidmais |
| congelado_em | timestamptz | N | sem | Congelamento, preservado no cancelamento |
| congelado_por_usuario_id | uuid | N | sem | Representante signatário |
| aplicado_em | timestamptz | N | sem | Aplicação após aceite cliente |
| cancelado_em | timestamptz | N | sem | Cancelamento explícito |
| cancelado_por_usuario_id | uuid | N | sem | Administrador que cancelou |
| motivo_cancelamento | text | N | sem | Obrigatório ao cancelar |
| criado_por_usuario_id | uuid | NN | sem | Autor administrativo real |
| atualizado_por_usuario_id | uuid | NN | sem | Último editor administrativo; não forjar ator cliente |
| criado_em | timestamptz | NN | now() | Criação |
| atualizado_em | timestamptz | NN | now() | Última transição/edição |

Não há `expira_em`, senha, token ou hash de sessão. O hold depende conjuntamente de revisão aberta, Fechamento CONFIRMADO e aquisição validada indicada por `hold_destino_adquirido_em`. O campo não confirma reserva financeira. É necessário distinguir uma revisão inicialmente sem reserva cujo destino pode ter sido ocupado antes do primeiro pagamento. O aceite cliente é identificado pela prova já existente em `contrato_assinaturas`; não é atribuído artificialmente ao último administrador.

### 3.2 Operação preparada

| Coluna | Tipo | Null | Default |
|---|---|---|---|
| cliente_id | uuid | NN | sem |
| responsavel_adicional_id | uuid | N | sem |
| aniversariante_id | uuid | N | sem |
| idade_aniversariante_evento | smallint | N | sem |
| tema_festa | text | N | sem |
| data_evento | date | NN | sem |
| horario_inicio | time without time zone | NN | sem |
| horario_fim | time without time zone | NN | sem |
| configuracao_agenda_id | uuid | NN | sem |
| pacote_id | uuid | NN | sem |
| tabela_preco_id | uuid | NN | sem |
| preco_pacote_id | uuid | NN | sem |
| regra_desconto_pacote_id | uuid | N | sem |
| categoria_horario | varchar(20) | NN | sem |
| categoria_preco_aplicada | varchar(20) | NN | sem |
| convidados | smallint | NN | sem |
| convidados_faturados | smallint | NN | sem |
| valor_pacote_base | numeric(12,2) | NN | sem |
| desconto_percentual | numeric(5,2) | NN | 0 |
| valor_desconto_pacote | numeric(12,2) | NN | 0 |
| valor_pacote_aplicado | numeric(12,2) | NN | sem |
| valor_adicionais | numeric(12,2) | NN | 0 |
| valor_tabela | numeric(12,2) | NN | sem |
| valor_negociado | numeric(12,2) | N | sem |
| valor_aprovado | numeric(12,2) | N | sem |
| motivo_negociacao | text | N | sem |
| observacoes_negociacao | text | N | sem |
| forma_pagamento_pretendida | varchar(30) | N | sem |
| condicao_pagamento | jsonb | N | sem |
| alteracoes_pacote | text | N | sem |
| observacoes_cliente | text | N | sem |
| observacoes_equipe | text | N | sem |
| usuario_responsavel_id | uuid | N | sem |
| buffet_status | varchar(20) | NN | 'PENDENTE' |
| buffet_salgados | text | N | sem |
| buffet_bebidas | text | N | sem |
| buffet_doces | text | N | sem |
| buffet_bolo | text | N | sem |
| buffet_outros | text | N | sem |

Período é `configuracao_agenda_id`, como no Fechamento atual; não criar uma coluna textual concorrente `periodo`. Início/fim são a seleção concreta, validados contra a configuração e sua tolerância. Categoria de horário/preço é a classificação comercial calculada, não outra fonte do período.

Não copiar `status`, `origem_fechamento`, `iniciado_por_usuario_id`, `iniciado_em`, `criado_em` originais: pertencem à contratação vigente. Estado da preparação não pode virar status financeiro. A preparação tem sua própria autoria e datas. `usuario_responsavel_id` é designação administrativa operacional e, para novas revisões, deve referenciar usuário administrativo real.

`condicao_pagamento` reutiliza a estrutura comercial natural da 012 (schemaVersao, forma, pretendida/aprovada, revisaoStatus e dados comerciais admitidos pelo parser). Não conterá cadastro, agenda, buffet, adicionais ou uma cópia genérica do Fechamento. Nome/endereço/email do CRM não serão duplicados na preparação: entram no snapshot contratual ao congelar.

### 3.3 PK, UNIQUE e FKs

PK `fechamento_revisoes_pkey(id)`.

UNIQUEs:

- `fechamento_revisoes_versao_uk(contrato_versao_id)`.
- `fechamento_revisoes_criacao_uk(chave_criacao)`.
- `fechamento_revisoes_id_fechamento_uk(id, fechamento_id)`, alvo da FK das decisões.
- Índice único parcial `fechamento_revisoes_aberta_uk(fechamento_id)` com predicado **`estado IN ('EM_ELABORACAO','CONGELADA')`**. Não incluir APLICADA/CANCELADA.

`contratos.fechamento_id` já é UNIQUE. Logo uma preparação aberta por Fechamento também significa uma por Contrato; não duplicar índice parcial equivalente por contrato.

Todas as novas FKs terão **ON UPDATE RESTRICT / ON DELETE RESTRICT**, sem CASCADE/SET NULL:

| Colunas de origem | Destino |
|---|---|
| fechamento_id, contrato_id | contratos(fechamento_id, id), novo UNIQUE de suporte |
| contrato_id, contrato_versao_id | contrato_versoes(contrato_id, id), UNIQUE já existente |
| contrato_id, versao_base_id | contrato_versoes(contrato_id, id) |
| contrato_versao_id | contrato_edicoes(contrato_versao_id), DEFERRABLE INITIALLY DEFERRED |
| cliente_id | clientes(id) |
| aniversariante_id | aniversariantes(id) |
| responsavel_adicional_id | responsaveis_adicionais(id) |
| configuracao_agenda_id | configuracao_agenda(id) |
| pacote_id | pacotes(id) |
| tabela_preco_id | tabelas_preco(id) |
| preco_pacote_id | precos_pacote(id) |
| regra_desconto_pacote_id | regras_desconto_pacote(id) |
| Cada campo *_por_usuario_id; usuario_responsavel_id | usuarios_administrativos(id) |
| contrato_versao_id, congelado_documento_id | contrato_documentos(contrato_versao_id, id) |
| aprovacao_negociacao_id, id | aprovacoes_negociacao(id, fechamento_revisao_id), novo UNIQUE; DEFERRABLE INITIALLY DEFERRED |

A FK via Contrato já assegura a existência do Fechamento por sua FK atual. Não acrescentar uma FK redundante simples apenas para repetir a mesma relação. Trigger diferido verifica também base vigente, V2 derivada dela, edição correspondente e número de versão crescente.

### 3.4 CHECKs propostos

Nomes físicos terão prefixo `fr_`; grupos abaixo são os contratos completos de validação:

- `fr_estado_ck`: enum de quatro estados; `fr_revisao_ck`: revisao > 0.
- `fr_origem_ck`: origem = ATENDIMENTO_KIDMAIS; `fr_motivo_ck`: btrim(motivo) <> ''; `fr_versoes_ck`: versao_base_id <> contrato_versao_id.
- `fr_hashes_ck`: fonte_base_hash/conteudo_hash e congelado_snapshot_hash quando presente combinam `^[0-9a-f]{64}$`.
- `fr_horario_ck`: horario_fim > horario_inicio; não há evento atravessando meia-noite nesta modelagem atual.
- `fr_convidados_ck`: convidados > 0 e convidados_faturados >= convidados. Limites comerciais de cada pacote ficam no Pricing, não em CHECK fixo de 150 que invalidaria outros pacotes.
- `fr_categorias_ck`: categoria_horario em PADRAO/NOBRE; categoria_preco_aplicada em GERAL/PADRAO/NOBRE.
- `fr_valores_ck`: base, aplicado e tabela > 0; adicionais/desconto >= 0; desconto <= base; percentual entre 0 e 100; negociado/aprovado, se presentes, > 0; aprovado exige negociado. Reproduz a semântica atual de aprovação da base negociada.
- `fr_somas_ck`: valor_pacote_aplicado = valor_pacote_base − valor_desconto_pacote e valor_tabela = valor_pacote_aplicado + valor_adicionais. Soma dos filhos é validada por trigger diferido.
- `fr_idade_ck`: NULL ou 0..120; `fr_buffet_ck`: PENDENTE/DEFINIDO.
- `fr_forma_ck`: NULL ou PIX_AVISTA/PIX_PARCELADO/CARTAO_CIELO.
- `fr_condicao_ck`: NULL ou objeto JSON schemaVersao=1, forma igual ao campo tipado e revisaoStatus em PENDENTE/APROVADA/DISPENSADA/RECUSADA, com COALESCE(...,false) para não aceitar chave ausente por resultado SQL NULL. Estrutura das parcelas comerciais validada pelo parser existente; não são parcelas financeiras.
- `fr_aprovacao_ck`: os quatro campos de aprovação (revisão, decisão, usuário, instante) todos NULL ou todos presentes; quando presentes, revisao_comercial_aprovada = revisao. Decisão e conteúdo exatos também serão conferidos pelo trigger.
- `fr_congelamento_ck`: snapshot/documento/instante/usuário todos NULL ou todos presentes. EM_ELABORACAO exige todos NULL; CONGELADA/APLICADA exigem todos presentes; CANCELADA permite o conjunto preservado ou todo NULL.
- `fr_fim_ck`: aplicado_em presente somente em APLICADA; cancelado_em/cancelado_por_usuario_id/motivo_cancelamento todos presentes somente em CANCELADA; motivo não vazio. APLICADA nunca cancelada por esta operação.
- `fr_datas_ck`: atualizado_em >= criado_em; aprovação/congelamento/aplicação/cancelamento não anteriores à criação; aplicação não anterior ao congelamento. Aprovação não posterior ao congelamento quando ambos presentes. O hold pode ser adquirido depois do congelamento, sem alterar o conteúdo.
- `fr_hold_data_ck`: hold_destino_adquirido_em NULL ou >= criado_em. Trigger valida sua aquisição contra Fechamento CONFIRMADO e agenda; em terminal o instante fica preservado como histórico, sem produzir ocupação.

## 4. `fechamento_revisao_adicionais`

| Coluna | Tipo | Null | Default |
|---|---|---|---|
| id | uuid | NN | gen_random_uuid() |
| fechamento_revisao_id | uuid | NN | sem |
| adicional_id | uuid | NN | sem |
| preco_adicional_id | uuid | NN | sem |
| nome_aplicado | text | NN | sem |
| unidade_cobranca_aplicada | varchar(20) | NN | sem |
| quantidade | numeric(12,3) | NN | 1 |
| valor_unitario_aplicado | numeric(12,2) | NN | sem |
| valor_total | numeric(12,2) | NN | sem |
| observacoes | text | N | sem |
| criado_em | timestamptz | NN | now() |
| atualizado_em | timestamptz | NN | now() |

PK em id. UNIQUE `fra_item_uk(fechamento_revisao_id, adicional_id)`. FKs RESTRICT para revisão(id), adicionais(id), precos_adicional(id). Não fazer CASCADE DELETE: revisão e histórico não podem desaparecer.

CHECKs `fra_nome_ck` (nome não vazio), `fra_quantidade_ck` (> 0), `fra_valores_ck` (unitário/total >= 0), `fra_unidade_ck` (VALOR_FIXO/CONVIDADO/UNIDADE/CENTO/HORA/PACOTE/METRO), `fra_datas_ck` (atualizado >= criado). Total deve corresponder ao cálculo oficial por unidade e quantidade; não impor fórmula ingênua quantidade × unitário se a unidade comercial exigir conversão. Essa coerência é validada com o resultado do Pricing e hash da preparação.

Filhos só podem ser inseridos/alterados/removidos em EM_ELABORACAO. Toda mudança exige bloqueio prévio do pai, incremento único de sua revisão, invalidação da aprovação/revisão documental e auditoria com conjunto antes/depois. Não permitir transferir um filho de revisão. Após congelamento, nenhuma mutação; após cancelamento, preservar os filhos.

## 5. Alterações em tabelas existentes e índices

### 5.1 Delta de colunas e constraints

1. `contratos`: acrescentar somente UNIQUE `contratos_fechamento_id_id_uk(fechamento_id,id)`. Nenhuma coluna/dado alterado.
2. `aprovacoes_negociacao`: acrescentar quatro colunas **NULL, sem DEFAULT**:

| Coluna | Tipo | Significado |
|---|---|---|
| fechamento_revisao_id | uuid | Preparação a que pertence a decisão |
| fechamento_revisao_numero | integer | Número imutável avaliado |
| fechamento_revisao_hash | char(64) | Hash exato do conteúdo avaliado |
| chave_decisao | uuid | Repetição segura da decisão administrativa |

CHECK `an_revisao_ck`: quatro campos todos NULL (histórico/fluxo atual) ou todos presentes; número > 0; hash hexadecimal de 64 caracteres; aprovado_por_usuario_id obrigatório para decisão de revisão. FK composta `(fechamento_revisao_id,fechamento_id)` → revisão `(id,fechamento_id)`, RESTRICT. UNIQUE `(id,fechamento_revisao_id)` para a referência reversa. Índice único parcial em chave_decisao WHERE chave_decisao IS NOT NULL. Não FK para o contador mutável revisao: decisões antigas continuam existindo quando a preparação evolui.

As três aprovações existentes continuam com novos campos NULL; não associar retrospectivamente a V1/V2 por inferência. Os CHECKs da 012 ficam intactos.

As consultas comerciais também precisarão distinguir o vínculo: uma consulta de “última aprovação do Fechamento” não poderá escolher a aprovação de uma V2 aberta. Fluxo original consulta decisões sem vínculo de preparação; fluxo preparado consulta o id/número/hash da própria revisão. Depois da aplicação, a condição vigente é a copiada para Fechamento, com rastreabilidade da decisão pela revisão aplicada. A listagem histórica pode mostrar todas, identificando a versão, sem usá-las indistintamente para autorizar V1.

3. `fechamentos`, `fechamento_adicionais`, `bloqueios_agenda`: **nenhuma coluna nova**. Acrescentar somente os triggers de proteção/agenda descritos abaixo.
4. `contrato_edicoes`, `contrato_fluxos`, `contrato_versoes`, `contrato_assinaturas`: nenhuma coluna nova. Acrescentar validações diferidas complementares para revisões operacionais. Funções/triggers da 013 permanecem; não substituir suas regras de prova/sessão.
5. Demais tabelas: nenhuma alteração estrutural. Auditoria e pendências existentes serão usadas durante operações futuras, não populadas pela migration.

### 5.2 Índices adicionais das tabelas novas

Além dos índices automáticos das PKs/UNIQUEs:

- `fr_historico_idx(fechamento_id, criado_em DESC)`.
- `fr_agenda_aberta_idx(data_evento, horario_inicio, horario_fim)` WHERE estado IN ('EM_ELABORACAO','CONGELADA') AND hold_destino_adquirido_em IS NOT NULL.
- Não criar `fr_aplicada_idx`: revisão aplicada não é fonte de ocupação. A reserva vigente vem do Fechamento CONFIRMADO.
- `fr_base_idx(versao_base_id)`.
- Índices simples em cliente_id, aniversariante_id, responsavel_adicional_id, configuracao_agenda_id, pacote_id, tabela_preco_id, preco_pacote_id, regra_desconto_pacote_id, usuario_responsavel_id, aprovacao_negociacao_id, congelado_documento_id e cada coluna de autoria, com nomes `fr_<coluna>_idx`. Facilitam FK e inspeção, sem novos UNIQUEs de negócio.
- `fra_adicional_idx(adicional_id)` e `fra_preco_idx(preco_adicional_id)`; o UNIQUE dos filhos já cobre buscas pelo pai.
- `an_revisao_hist_idx(fechamento_revisao_id, fechamento_revisao_numero, criado_em)` WHERE fechamento_revisao_id IS NOT NULL.

Não propor EXCLUDE/GiST ou outra extensão de agenda: a proteção entre tabelas continuará no protocolo de locks já usado. Um UNIQUE em data/início não seria suficiente para intervalos sobrepostos.

## 6. Estados e integridade documental

| Preparação | Edição contratual compatível | Pode editar operação? | Reserva |
|---|---|---|---|
| EM_ELABORACAO | EM_ELABORACAO | Sim, com revisão otimista | Base somente se CONFIRMADA; destino somente com hold adquirido |
| CONGELADA | ASSINADA_KIDMAIS ou AGUARDANDO_CLIENTE | Não | Mesma regra; assinatura não cria reserva |
| APLICADA | CONCLUIDA; V2 ASSINADA | Não | Nova data ocupa somente se Fechamento CONFIRMADO |
| CANCELADA | CANCELADA; V2 CANCELADA | Não | Destino provisório liberado |

Transições permitidas: EM_ELABORACAO → CONGELADA ou CANCELADA; CONGELADA → APLICADA ou CANCELADA. Terminais imutáveis inclusive DELETE. Não há descongelamento nem retorno à edição depois da assinatura Kidmais.

`fonte_base_hash` cobre campos operacionais contratados do Fechamento e seus adicionais, com IDs, data/horário, pacote/preços, negociação/condição, buffet e observações; não inclui status financeiro, atualizado_em, sessão, recebimentos nem valores cadastrais compartilhados. Inclui a referência/hash imutável da V1. Assim, um recebimento legítimo durante V2 não torna a base falsa. Troca operacional externa enquanto a revisão está aberta é recusada.

`conteudo_hash` cobre todos os campos operacionais preparados e adicionais em ordem determinística, com versão explícita da projeção canônica no algoritmo. Exclui contador, metadados de aprovação/autoria/transição, hold_destino_adquirido_em e o próprio hash para evitar autorreferência. A revisão otimista é validada separadamente. Strings/UUIDs/números/data/hora têm representação canônica comum entre aplicação e verificador SQL; testes com vetores fixos são obrigatórios.

Snapshot contratual futuro identifica revisão operacional por **id + número + conteudo_hash + versao_base_id**. Essa referência é documental, não um substituto JSON dos campos tipados. `congelado_snapshot_hash` e `congelado_documento_id` apontam para o mesmo snapshot/PDF da assinatura. Correção CRM antes da assinatura invalida revisão de PDF e requer gerar/revisar novamente; depois, o documento congelado permanece histórico.

Não herdar assinatura, OTP, comprovante, revisão de documento nem aprovação exata da V1. Mesmo uma V2 sem diferença de preço exige revisão comercial documental própria prevista na 013.

## 7. Agenda: propriedade, consultas e locks

### 7.1 V1 já confirmada — regra central solicitada

V1 de 12/09/2026, 17–21h, continua em `fechamentos`, CONFIRMADO. Revisão propõe 19/09/2026, 17–21h. A abertura/reserva ocorre em uma única transação; só responder sucesso após commit. Durante EM_ELABORACAO e CONGELADA, as duas datas estão ocupadas. Não existe TTL, tarefa de limpeza ou expiração automática.

A reserva de destino é a tupla `(revisao.id, data_evento, horario_inicio, horario_fim)` de uma revisão aberta coerente com `contrato_fluxos`, com aquisição registrada em `hold_destino_adquirido_em` e Fechamento CONFIRMADO. Mudanças de conteúdo exigem revisão otimista; o hold pertence à revisão operacional, sem depender de sua aprovação comercial. Não permitir apagar o marcador arbitrariamente. Mudar a proposta de 19 para 26 troca o hold e seu instante de aquisição dentro da mesma transação, preservando 12. Se 26 está indisponível, rollback mantém proposta/hold anteriores de 19. Mudanças sem alteração do slot preservam o instante.

### 7.2 Regra oficial: assinatura sem reserva confirmada

**Reserva depende de disponibilidade, contrato e primeiro pagamento qualificante.** Abrir, congelar ou promover V2 não substitui essa regra.

**Caso A — V1 CONFIRMADA:** manter a reserva vigente de 12/09, 17–21h, e adquirir, sob lock e validação, hold de remarcação para 19/09, 17–21h. Em EM_ELABORACAO/CONGELADA ambas ficam protegidas. Cancelamento libera somente o hold de 19; aplicação transfere a operação/reserva para 19, libera 12 e mantém Fechamento CONFIRMADO, sem inventar alteração financeira.

**Caso B — V1 ASSINADA e AGUARDANDO_PAGAMENTO:** abrir V2 não ocupa 12 nem adquire hold para 19. A preparação guarda o destino proposto, com `hold_destino_adquirido_em=NULL`. Consultar/revalidar disponibilidade ao propor ou alterar a agenda, gerar/revisar o documento, assinar pela Kidmais, liberar ao cliente e concluir. Consultas não garantem a data: nas operações transacionais relevantes, adquirir o lock e reler conflitos. Se houver conflito, informar e impedir avançar com destino indisponível; não tomar a reserva de terceiro. A data-base não é reservada nem precisa ser adquirida para permitir propor outra data disponível.

**V2 concluída sem primeiro pagamento:** copiar nova data para Fechamento e promover V2; preservar AGUARDANDO_PAGAMENTO ou outro estado apropriado já existente, sem CONFIRMADO artificial. Nenhuma ocupação nasce da revisão aplicada. Primeiro pagamento qualificante posterior usa a data operacional **vigente atual**, bloqueia a agenda e revalida bloqueios/ocupações; somente confirma conforme a regra existente. Conflito de agenda não apaga recebimento legítimo nem confirma a reserva.

**Primeiro pagamento durante V2 aberta:** serializar pelo Fechamento e pelas datas em ordem crescente. Confirmar a data ainda vigente da V1 se a regra atual permitir. Não confirmar o destino preparado no lugar dela. Depois dessa confirmação, tentar adquirir o hold do destino, com nova leitura de conflitos sob os mesmos locks e exclusão apenas da própria contratação.

- Destino livre: registrar aquisição do hold e auditá-la; V1 fica CONFIRMADA e destino provisoriamente protegido.
- Destino já ocupado/bloqueado: manter recebimento e confirmação legítima da V1; marcador continua NULL, destino continua sem proteção. Auditar/informar conflito da proposta. Não derivar hold automaticamente apenas de `fechamentos.status='CONFIRMADO'`, pois isso tomaria a data de terceiro.
- A revisão continua íntegra, mas não pode avançar para assinatura/liberação/aplicação sem resolver o conflito e adquirir o hold necessário. Em EM_ELABORACAO pode escolher outro destino; em CONGELADA não alterar conteúdo/PDF: aguardar disponibilidade e readquirir o mesmo destino ou cancelar e criar nova revisão.
- Essa tentativa trata conflito de disponibilidade como resultado de negócio, não como erro SQL que aborte o recebimento. Falhas técnicas mantêm o tratamento transacional normal. Repetição do pagamento não perde nem duplica hold/auditoria; aquisição pendente também pode ser tentada por operação administrativa explícita.

Aquisição posterior do hold é metadado operacional auditado; não altera contador/hash do conteúdo, aprovação, PDF ou prova. Em CONGELADA admite-se somente NULL → instante validado para o mesmo slot; não se permite editar dados congelados. Em APLICADA/CANCELADA o instante fica imutável e deixa de gerar hold. Não há expiração automática.

**UI administrativa:** usar distintamente `RESERVA CONFIRMADA` para ocupação vigente confirmada; `DATA PROPOSTA — AINDA NÃO RESERVADA` quando não há hold (com alerta de conflito quando cabível); `DATA PROVISORIAMENTE PROTEGIDA DURANTE REMARCAÇÃO` somente para hold efetivamente adquirido. Não anunciar ao operador ou cliente reserva garantida por assinatura, preparação ou promoção sem a confirmação qualificante.

### 7.3 Fonte única das consultas de ocupação

Propor função relacional **`kidmais_ocupacoes_operacionais(inicio date, fim date)`**, retornando `fechamento_id uuid, revisao_id uuid nullable, origem text, data date, horario_inicio time, horario_fim time`. Sem gravação. Sua união é:

1. `fechamentos.status='CONFIRMADO'`: agenda vigente atual, origem CONFIRMADA.
2. Destino tipado de revisão EM_ELABORACAO/CONGELADA com `hold_destino_adquirido_em IS NOT NULL`, Fechamento **CONFIRMADO** e vínculo coerente com V2 em preparação e V1 vigente: origem REVISAO_DESTINO, um hold provisório, não outra reserva financeira confirmada.

Preparação de Fechamento ainda sem reserva confirmada não retorna como ocupação, independentemente de assinatura Kidmais/cliente. Revisão com destino em conflito e hold não adquirido também não retorna esse destino. A administração pode listá-la separadamente como proposta não reservada; não passá-la ao cálculo de horários ocupados.

Não criar origem REVISAO_BASE: a base protegida já vem exclusivamente do Fechamento CONFIRMADO. **Não criar REVISAO_VIGENTE**: APLICADA/CANCELADA nunca geram hold/ocupação por si. Depois da promoção, a nova data só aparece na parcela CONFIRMADA se Fechamento continuar CONFIRMADO. Assinatura não é fonte alternativa de confirmação.

Filtrar datas em todas as parcelas da união. Sobreposição: mesmo dia, início existente < fim candidato e fim existente > início candidato. Intervalos adjacentes são permitidos. Bloqueio de dia inteiro ou com horários ausentes cobre o dia inteiro, preservando a defesa atual.

Consultas públicas de data/período e agenda administrativa usam essa função + bloqueios ativos. Mostrar provisório na administração sem expor dados pessoais ao público. Não descartar preparações assinadas pela Kidmais.

Validação de gravação usa exatamente a mesma fonte. Exclusão do próprio dono somente após validar no servidor a relação revisão ↔ Fechamento ↔ contrato; não confiar em UUID de exclusão enviado pelo cliente. Na confirmação de pagamento da própria V1, pode excluir as ocupações pertencentes à mesma contratação, mas não reservas de terceiros. No bloqueio administrativo **não há exclusão de contratante**: rejeitar sobreposição com a base CONFIRMADA de uma revisão aberta ou seu hold adquirido, inclusive bloqueio de dia inteiro. Proposta ainda sem reserva/hold não impede outro dono ou bloqueio administrativo de ocupar a data.

Manter a semântica atual de bloqueios em datas de Fechamentos confirmados sem revisão; não alterar retrospectivamente sete bloqueios existentes. A nova regra obrigatória é não permitir criar/reativar/mover bloqueio por cima de base CONFIRMADA/hold adquirido de revisão aberta; proposta sem reserva não produz essa proteção. Bloqueios anteriores são respeitados na aquisição da reserva, não apagados/desativados para fazê-la caber.

### 7.4 Protocolo de escrita e concorrência

Manter o namespace **`kidmais:agenda:YYYY-MM-DD`**, hashtextextended com semente 0, lock transacional. Não inventar namespace `revisao` que deixaria duas agendas independentes.

Ordem para operações contratuais: Fechamento FOR UPDATE → Contrato/fluxo → versões/edições em ordem estável → revisão → cadastros necessários em ordem estável → Pagamento(s) se realmente houver necessidade de lock → advisory locks de **todas as datas envolvidas, distintas e crescentes**. Não adquirir um novo lock de linha de outra contratação depois dos locks da agenda. Verificação de conflitos de outros donos usa SELECT, não FOR UPDATE. Pagamentos mantém Fechamento → Pagamento → agenda.

Criar revisão bloqueia Fechamento antes de inserir o pai. Editar filhos bloqueia Fechamento e pai antes dos filhos. Mudança de destino bloqueia base + destino antigo + destino novo. Aplicar/cancelar bloqueia base + destino atual. Primeiro pagamento com revisão aberta identifica/bloqueia essa revisão após Fechamento e antes de Pagamento; adquire base e destino juntos em ordem crescente antes de validar a confirmação, sem adquirir primeiro a base e só depois descobrir uma data de destino anterior. Preserva a ordem Fechamento → Pagamento → agenda, acrescentando o contexto de revisão antes de Pagamento. Operação administrativa de bloqueio toma seu registro, se existente, e as datas antiga/nova em ordem, sem bloquear Fechamentos depois disso. Desativação passa a participar do mesmo protocolo.

Usar READ COMMITTED para operações de escrita da agenda: depois de obter lock que tenha esperado outra transação, fazer a consulta de conflito em **novo comando SQL**, com snapshot atualizado. Não depender de uma leitura de disponibilidade feita antes do lock. Uma implementação que faça tudo em um SELECT com snapshot antigo, ou use REPEATABLE READ e reutilize leitura anterior à espera, não atende esta proposta. Locks em triggers são defesa adicional; não substituem essa sequência do serviço. Testar bloqueio real entre duas conexões, não apenas Promise.all de chamadas sem barreira.

Índice parcial resolve duas revisões da mesma contratação. Lock por data + consulta atualizada resolve sobreposição entre contratações. Limite/timeout de lock retorna erro recuperável sem liberar recurso anterior. Repetição integral pode ser feita para deadlock/serialização com chave idempotente; nunca repetir somente a metade final da promoção.

## 8. Funções SQL e triggers previstos

Somente especificação de contratos de funções; nenhum corpo SQL criado nesta etapa. Funções de trigger retornam trigger, LANGUAGE plpgsql, SECURITY INVOKER e referências de schema explícitas. Não usar GUC/flag do cliente como autorização para furar imutabilidade. Usuário PostgreSQL superuser continua fora da fronteira de proteção da aplicação; a autorização administrativa é conferida no serviço/transação, como na 013.

| Função proposta | Comportamento obrigatório |
|---|---|
| kidmais_ocupacoes_operacionais(date,date) | Função relacional de leitura definida em 7.3; não adquire locks e não promete reserva por consultar |
| kidmais_lock_datas_revisao(date[]) | Adquire os advisory locks existentes em ordem ISO crescente, sem duplicação; usada no comando anterior à leitura de conflitos |
| kidmais_hash_revisao_operacional(uuid) | Recalcula hash da projeção canônica tipada e filhos ordenados; não usa metadados mutáveis |
| kidmais_preservar_revisao_operacional() | BEFORE UPDATE/DELETE no pai; impede exclusão, alteração de identidade/base/chave/criação, transição inválida e mutação de conteúdo congelado/terminal; em edição exige contador anterior+1 quando conteúdo muda; permite aquisição auditada do hold congelado sem mudar conteúdo/prova, conforme 7.2 |
| kidmais_preservar_adicional_revisao() | BEFORE INSERT/UPDATE/DELETE nos filhos; verifica pai editável, proíbe transferência; exige protocolo de bloqueio do pai |
| kidmais_validar_revisao_operacional() | Constraint trigger diferido: FKs lógicas, estado/fluxo/versões, hash, soma filhos, aprovação exata, PDF/prova, base íntegra e aplicação coerente; consulta estado final e não estado intermediário do evento |
| kidmais_proteger_fechamento_em_revisao() | Constraint trigger diferido no Fechamento e filhos vigentes: com revisão aberta, projeção operacional deve continuar igual ao hash-base; exceção somente se estado final APLICADA e conteúdo vigente igual ao preparado, com V2 assinada/promovida |
| kidmais_validar_agenda_revisao() | Valida aquisição/movimento do hold somente com Fechamento CONFIRMADO e destino livre; aplica caso A ou B conforme 7.2, sem transformar proposta em ocupação; confirmação da base não exige hold se destino estiver em conflito, e esse conflito não aborta recebimento legítimo |
| kidmais_proteger_bloqueio_revisao() | BEFORE INSERT/UPDATE em bloqueios: valida ativação/mudança contra base CONFIRMADA/hold adquirido de revisão aberta e usa mesmas datas; desativação serializada, sem desfazer revisão |
| kidmais_preservar_aprovacao_revisao() | BEFORE UPDATE/DELETE em aprovações: impede mutação de qualquer decisão vinculada à revisão, inclusive tentativa de limpar o vínculo; decisões antigas sem vínculo seguem comportamento atual |

Reutilizar `kidmais_set_atualizado_em()` em pai/filhos editáveis. O bloqueio de terminal não é contornado por timestamp automático. Auditoria usa função/repositório atual, sem nova tabela.

Instalação dos triggers novos:

- `fr_preservar_trg`: pai BEFORE UPDATE/DELETE; `fr_atualizado_trg`: pai BEFORE UPDATE.
- `fra_preservar_trg`: filhos BEFORE INSERT/UPDATE/DELETE; `fra_atualizado_trg`: filhos BEFORE UPDATE.
- `fr_validar_trg`: pai AFTER INSERT/UPDATE; `fra_validar_trg`: filhos AFTER INSERT/UPDATE/DELETE; ambos CONSTRAINT, DEFERRABLE INITIALLY DEFERRED.
- `fr_edicao_validar_trg`, `fr_fluxo_validar_trg`, `fr_versao_validar_trg`, `fr_assinatura_validar_trg`: respectivamente edição/fluxo/versão AFTER INSERT/UPDATE e assinatura AFTER INSERT; constraint triggers diferidos, complementares à 013. Se não há revisão associada, preservar fluxo legado; para nova V2 operacional, exigir vínculo antes do commit.
- `fr_fechamento_proteger_trg`: fechamentos AFTER UPDATE; `fr_adicionais_proteger_trg`: adicionais vigentes AFTER INSERT/UPDATE/DELETE; constraint triggers diferidos.
- `fr_agenda_validar_trg`: pai AFTER INSERT/UPDATE, constraint trigger diferido; `fr_confirmacao_agenda_trg`: Fechamento AFTER INSERT/UPDATE, diferido, verifica nova confirmação/mudança de slot contra revisões. Não escanear/rejeitar ocupações legadas não alteradas.
- `fr_bloqueio_proteger_trg`: bloqueios BEFORE INSERT/UPDATE; `fr_aprovacao_preservar_trg`: aprovações BEFORE UPDATE/DELETE; `fr_aprovacao_validar_trg`: aprovações AFTER INSERT, constraint trigger diferido para vínculo/número/hash/autor válidos.

O validador final exige: base pertence ao mesmo contrato e era vigente; edição.origem_versao_id = versao_base_id; V2 corresponde ao ponteiro de preparação enquanto aberta; APLICADA coincide com promoção e aceite cliente; CANCELADA não é ponteiro de preparação. Para revisões históricas APLICADA que deixaram de ser vigentes por V3, não exigir que permaneçam vigentes eternamente: a exigência de promoção vale **na transição de aplicação**; integridade posterior preserva vínculo/provas imutáveis. Mesmo cuidado para não revalidar uma sessão operacional expirada em assinaturas antigas.

Mudanças dos catálogos/CRM após congelamento não reescrevem preço ou snapshot. Verificação final não exige refazer Pricing com a tabela de hoje: exige o cálculo congelado íntegro, referências existentes e os requisitos operacionais de agenda/cadastro ainda válidos. Mudança de regra que impossibilite prestar o serviço gera conflito explícito, nunca novo preço silencioso.

## 9. Cadastro, comercial, pacote e buffet

### 9.1 Correção do mesmo cadastro

Nome/telefone/endereço/email do mesmo cliente continuam tratados pelo serviço CRM, auditados imediatamente. V1 conserva seu snapshot. V2 em elaboração deve atualizar sua documentação a partir do CRM e perder a marca de PDF revisado. Não alterar CPF por edição simples; manter resolução de identidade/duplicidade do domínio.

Após assinatura Kidmais, correção compartilhada do CRM não altera o PDF. Para aceitar, validar identidade canônica e CPF do signatário do snapshot congelado. Correções não identitárias posteriores não invalidam assinatura por comparação indiscriminada de todo cadastro; mudança material de identidade/vínculo impede aceite e exige cancelar/refazer V2. Não usar atualizado_em genérico do CRM como motivo para invalidar para sempre uma proposta assinada.

### 9.2 Troca de contratante, responsável ou aniversariante

Operação administrativa específica seleciona cliente canônico ativo, validado pelo domínio CRM. Grava **cliente_id proposto** na revisão, nunca no Fechamento vigente durante elaboração. CPF não é digitado como substituição irrestrita de FK. Responsável adicional deve existir, estar ativo e pertencer ao cliente proposto. Selecioná-lo não o transforma automaticamente em contratante apto a assinar; se a pessoa será a parte contratante, usar a operação de troca de cliente e sua identidade validada.

Aniversariante proposto deve pertencer ao cliente proposto e estar ativo; idade/data de nascimento coerentes com evento. Não reparentear silenciosamente a criança compartilhada para satisfazer uma FK. Se necessário, criar/relacionar cadastro por operação CRM própria e auditada antes de selecioná-lo. Correção de nome/nascimento da mesma criança é correção cadastral, preservando V1 histórica.

FK garante existência; pertencimento, atividade e identidade exigem serviço e validação transacional. V2 pública autoriza o **cliente do snapshot da V2**. O serviço atual já consulta CPF/cliente do snapshot, e isso deve ser preservado/testado. Não autorizar novo contratante pelo cliente ainda vinculado ao Fechamento V1. V1 segue documento histórico da parte original; a seleção de versão pública não deve expor V2 ao antigo contratante por um link genérico. OTP consumido fica ligado à versão exata, nunca herdado.

### 9.3 Cálculo e aprovação

Pricing calcula sobre preparação e seus filhos. Troca de pacote recalcula elegibilidade, mínimo/máximo, convidados faturados, preços, adicionais e classificação da data/período. Itens incluídos/combos não podem ser cobrados de novo. Ao trocar pacote, buffet volta a PENDENTE e seleções incompatíveis são limpas **na preparação**, com antes/depois; equipe redefine as escolhas válidas. A data e o pacote da V1 não mudam nesse processo.

Base comercial aprovada é valor_aprovado da negociação, quando há negociação; caso contrário, valor_tabela. Desconto da forma de pagamento é calculado uma vez pelo serviço atual e congelado no snapshot. Não reinterpretar desconto_percentual de pacote como desconto PIX.

| Forma | Desconto da forma | Base 9.290,00 → contrato |
|---|---:|---:|
| PIX_AVISTA | 10% | 8.361,00 |
| PIX_PARCELADO | 3% | 9.011,30 |
| CARTAO_CIELO | 0% | 9.290,00 |

Proposta PIX parcelado não cria parcela financeira. Negociação/PIX parcelado exige decisão comercial explícita. A aprovação gera **nova linha** em aprovacoes_negociacao vinculada a id/número/hash preparados; não altera nenhuma aprovação V1. Antes da assinatura, registrar também a revisão comercial da edição contratual exigida na 013. Para condições sem negociação, a revisão administrativa pode registrar confirmação positiva da base de tabela; isso não significa desconto negociado nem recebimento.

Qualquer mudança de conteúdo preparado incrementa revisao e limpa os quatro campos de aprovação atual, além de invalidar documento revisado. Decisões históricas continuam intactas. Aprovar não muda conteudo_hash nem contador se não alterar proposta; corrigir valor exige primeiro nova revisão do conteúdo e depois decisão sobre ela. Recusa cria decisão negativa, deixa preparação editável e preserva a reserva até cancelamento explícito; não expira por recusa comercial.

Se a decisão modificar `condicao_pagamento.revisaoStatus`, a condição aprovada ou algum valor tipado, isso é alteração de conteúdo: formar o conteúdo final, incrementar uma vez a revisão, calcular seu hash e inserir a decisão ligada a esse resultado na mesma transação. Não aprovar o hash anterior e depois mudar o JSON por fora. Repetição da chave de decisão devolve o resultado original sem incrementar novamente.

## 10. Operações transacionais completas

### Abrir/editar

Autenticar administrador real/CSRF; bloquear contexto; validar base V1 assinada, motivo, revisão otimista e ausência de outra preparação; criar V2/edição/fluxo e preparação no mesmo commit. Inicializar conteúdo a partir da operação vigente, não fazer backfill de todas as versões. Manter base CONFIRMADA e adquirir hold do destino somente conforme o caso A da seção 7; no caso B apenas propor/revalidar, sem reserva. Nenhuma reserva é anunciada antes de persistir a revisão válida.

Retificação documental iniciada após a implantação também pode ter preparação operacional igual à base, sem diferença de preço. Não abrir V2 documental paralela para contornar a unicidade. Preparações documentais legadas preexistentes não recebem dados inventados pela migration: conversão deverá ser operação explícita e validada antes de ganhar edição operacional; se já congeladas, preservá-las e cancelar/recriar mediante ação administrativa.

### Assinar pela Kidmais

Conferir sessão real, usuário REPRESENTANTE_AUTORIZADO, CSRF e reautenticação dentro dos cinco minutos atuais dentro da transação. Conferir aprovação exata, fonte-base, soma/hash dos itens, PDF revisado e revisão contratual. Gravar prova atual da 013 e preencher referência do congelamento, estado CONGELADA. V1 continua vigente; destino protegido somente no caso CONFIRMADO com hold adquirido. Sem confirmação financeira, revalidar disponibilidade sem criar hold. Nenhuma sessão ganha FK permanente; prova continua append-only e PDF BYTEA.

### Aceitar pelo cliente/aplicar/promover

1. Validar acesso/OTP e versão exata; bloquear Fechamento e demais entidades na ordem definida.
2. Revalidar estado CONGELADA, base vigente, fonte-base, conteúdo/itens, decisão comercial, PDF/hash/revisão, vínculo/identidade das partes e assinatura Kidmais.
3. Obter locks de base/destino e reler disponibilidade. Se Fechamento estiver CONFIRMADO, validar propriedade do hold ou adquiri-lo após resolver pendência, antes de aplicar. Se estiver sem reserva confirmada, revalidar destino sem adquirir hold nem confirmar reserva. Reserva própria não é conflito; terceiros/bloqueios impedem concluir. Reavaliar a situação atual sob lock, pois pagamento pode ter ocorrido durante V2.
4. Consumir OTP e gravar aceite/prova do cliente para o mesmo PDF/snapshot. Alterar somente V2, nunca assinatura de V1.
5. Copiar os campos operacionais aprovados para Fechamento e substituir seus adicionais vigentes pelo conjunto preparado, preservando histórico integral no snapshot V1 e auditoria antes/depois. Os filhos da preparação ficam congelados como história.
6. Não copiar status/origem/data de criação da preparação para Fechamento. Manter CONFIRMADO ou AGUARDANDO_PAGAMENTO e as demais situações compatíveis existentes. Alteração contratual não significa novo recebimento.
7. Marcar preparação APLICADA, edição CONCLUIDA, versão V2 ASSINADA, promover ponteiros do fluxo/contrato. Se Fechamento CONFIRMADO, a consulta transfere a ocupação vigente para o destino no mesmo commit em que encerra o hold e libera a base, sem janela livre. Sem confirmação financeira, nem base nem destino geram ocupação pela promoção; apenas a data operacional muda.
8. Comparar nova condição contratual com a **obrigação original do Pagamento**, e registrar pendência financeira idempotente quando cabível, incluindo diferença de devedor/condição quando material. Não apenas diferença de total; comparar a condição financeira efetiva, sem gerar pendência por timestamp ou metadado de revisão.
9. Registrar auditoria de aplicação, agenda e promoção. Executar validações diferidas e commit.

Qualquer falha, inclusive ao criar pendência/auditoria ou no trigger diferido, faz rollback de **todo o aceite/aplicação/promoção**: OTP não fica consumido pela tentativa abortada, não sobra assinatura cliente, V1 permanece vigente, preparação CONGELADA conserva a situação de reserva anterior: hold já adquirido permanece; proposta sem hold não ganha ocupação pelo rollback. Não enviar confirmação externa antes do commit.

### Cancelar V2

Operação administrativa explícita com motivo e sessão válida. Admitir EM_ELABORACAO ou CONGELADA antes da conclusão. Bloquear contexto/datas; revisão CANCELADA + edição CANCELADA + V2 CANCELADA + limpar somente ponteiro em preparação. Não cancelar contrato lógico nem tocar versao_vigente_id. Preservar todos os hashes, filhos, documentos e assinaturas Kidmais existentes. Estado V2 CANCELADA libera o índice ATIVA para próxima versão.

Liberação do destino resulta da transição atômica, sem DELETE de bloqueio administrativo e sem atualização de sessão/prova. Cancelar V2 assinada pela Kidmais é cancelamento da proposta, não apagamento da assinatura. Cancelamento concorrente com aceite: vencedor do bloqueio conclui; perdedor observa terminal e não executa metade de sua operação.

## 11. Pagamentos e os dois casos reais

Inspeção confirmou:

| Pagamento | Versão da obrigação original | Total | Situação |
|---|---|---:|---|
| 59dcf33b-8da1-4cae-9d4d-1f3f3dd95b31 | d978c4d4-8bfb-4ea9-bb5c-d5cea43b8142 | 9.290,00 | AGUARDANDO_PAGAMENTO |
| f9207fe7-ed6d-4149-a148-8143eedbd6bb | 50f0f652-ce70-4695-bbfa-be3f43a38164 | 8.990,00 | PARCIALMENTE_PAGO |

Essas duas linhas e todos os seus planos/parcelas/recebimentos/alocações/estornos/comprovantes permanecem iguais. A migration não recalcula nenhum saldo, não reatribui pagamento a V2 e não cria pendência para registros antigos.

Durante elaboração, operações normais autorizadas de recebimento podem continuar na obrigação original; “intacto durante V2” significa que **a revisão não altera** o financeiro, não que bloqueará recebimentos legítimos. Recebimento que confirma a reserva da V1 durante uma revisão usa a mesma agenda e exclui somente a própria contratação. O destino só ganha hold após aquisição validada, conforme 7.2; conflito no destino não desfaz recebimento nem confirmação legítima da base.

Na aplicação, reutilizar `contrato_pendencias_financeiras`, UNIQUE existente `(pagamento_id,versao_nova_id)`. Preservar o vínculo do pagamento original, mesmo quando a versão anterior imediatamente vigente já for V2/V3. As diferenças devem informar obrigação original e nova condição. Proibir segundo Pagamento para o mesmo contrato com obrigação existente. Sem pagamento anterior, criação posterior permanece explícita e usa a versão vigente assinada, com soma exata do plano e sem recalcular desconto.

Troca de contratante não transfere automaticamente a dívida do Pagamento original. Registrar pendência quando houver impacto sobre a obrigação; resolução financeira e eventual transferência/renegociação exigem bloco posterior. Não implementar cobrança da diferença, abatimento, estorno ou ajuste de plano nesta etapa futura de revisão operacional.

## 12. Auditoria e idempotência

Reutilizar auditoria append-only. Eventos: REVISAO_OPERACIONAL_CRIADA, ALTERADA, COMERCIAL_APROVADA/RECUSADA, RESERVA_REVISAO_ADQUIRIDA/MOVIDA, CONGELADA, CANCELADA, APLICADA e VERSAO_PROMOVIDA. Cada evento contém revisão id/número, contrato/V1/V2, motivo, antes/depois, hashes, conjunto de adicionais e datas quando pertinente, request_id, IP confiável/user-agent disponíveis. Não incluir senha/token/CSRF.

Administrador: ator_tipo USUARIO e usuario_id obtido da sessão real. Aceite cliente: ator e validação do cliente, com vínculo à prova; não inventar usuário administrativo. Criação/troca cadastral também gera auditoria no CRM. Todos os eventos pertencem à mesma transação da operação correspondente.

- Criar: chave_criacao única, mesma chave/mesmo autor/base/pedido retorna revisão existente; conteúdo diferente → conflito. Não reabrir CANCELADA por repetição. Comparar pedido original pelo evento imutável de criação, não pelo conteúdo atual já editado.
- Editar: expectedRevision obrigatório; UPDATE condicional. Repetição sem mudança pode retornar estado atual; edição obsoleta diferente → 409, sem sobrescrever. Não prometer replay histórico de resposta para todas as edições; garantir ausência de segunda mutação. Request_id documenta tentativas/eventos efetivos.
- Decidir: chave_decisao única e comparação de id/número/hash/decisão/autor; repetir igual devolve decisão existente, diferente → conflito.
- Assinar/aceitar: preservar chaves idempotentes da 013 e OTP consumido pela versão correta; UUIDs normalizados para comparação.
- Aplicar novamente APLICADA com os mesmos identificadores retorna resultado já concluído, sem nova pendência/auditoria/aplicação. Cancelar novamente CANCELADA com mesma intenção retorna resultado; cancelar APLICADA é conflito. Repetição com identificadores incompatíveis nunca reutiliza resultado de outro dono.

## 13. Delta final da futura Migration 014

1. Precheck do físico atual/compatibilidade; transação de DDL com lock_timeout e falha integral.
2. Duas tabelas novas com colunas, PKs, CHECKs, FKs, índices e proteções acima.
3. UNIQUE composto de suporte em contratos.
4. Quatro colunas opcionais e constraints/índices de associação em aprovacoes_negociacao; trigger preserva decisões futuras vinculadas.
5. Funções de leitura/locks/hash/validação e triggers complementares em Fechamento, agenda e contratos.
6. **Nenhum INSERT/UPDATE/DELETE de dados de negócio. ZERO backfill.** Tabelas novas vazias; novas colunas das três aprovações existentes NULL; nenhuma revisão/assinatura/reserva/pendência criada.
7. Postcheck; commit somente se a estrutura esperada estiver presente.

### Ajustes físicos desta correção documental

O desenho continua com duas tabelas novas e os mesmos vínculos comerciais/contratuais. Acrescentar à futura `fechamento_revisoes` somente `hold_destino_adquirido_em timestamptz NULL`, sem DEFAULT, com CHECK de data e validação transacional. O marcador distingue hold adquirido de destino apenas proposto, especialmente quando o primeiro pagamento ocorre durante V2 e encontra o destino ocupado. Não é um status financeiro nem uma terceira tabela.

Remover o índice proposto `fr_aplicada_idx`, pois revisão aplicada não mantém ocupação. Restringir `fr_agenda_aberta_idx` aos holds adquiridos. Ajustar as funções/triggers já previstos para os casos A/B, aquisição posterior auditada mesmo em CONGELADA, ausência de ocupação de APLICADA e conflito de destino que não impede confirmação legítima da base. Não criar função alternativa de confirmação por assinatura. O restante do delta fica preservado; nada deste DDL foi criado/executado.

Antes/depois: **38 → 40 tabelas**. Dados das 38 tabelas atuais preservados; em aprovacoes_negociacao a projeção antiga é idêntica, mas o JSON da linha inteira passará a incluir quatro NULLs — comparar projeção das colunas anteriores, não exigir hash idêntico de schemas diferentes.

Migration 012: arquivo e constraints existentes intactos; reutilizar suas formas/descontos/condição. Migration 013: arquivo, oito tabelas, BYTEA, sessão histórica sem FK, scrypt, CSRF e provas imutáveis intactos; adicionar somente validações de associação operacional, sem enfraquecer as validações existentes. `schema_mvp_kidmais.sql` não será alterado.

## 14. Precheck, postcheck e rollback

### Precheck previsto, antes de criar/aplicar qualquer SQL

- Nova autorização explícita do DDL corrigido; regra oficial de confirmação financeira da seção 7.2 preservada.
- Reinspecionar banco físico imediatamente antes da implementação/aplicação; não presumir que o estado de 09/09 ainda é atual.
- Preservar novo checkpoint de fontes e pg_dump; validar restauração em banco isolado. Nunca usar os dois casos reais como massa descartável.
- Conferir ausência de objetos 014 conflitantes, definições exatas da 012/013, índices/constraints citados, BYTEA e inexistência de FK assinatura→sessão.
- Inventariar fluxos vigentes/preparações documentais atuais, referências órfãs, inconsistências de snapshot e operações administrativas em andamento; não corrigir registros automaticamente.
- Verificar unicidades já existentes e capacidade das novas FKs/índices; conjunto de aprovações legado admite novos NULLs.
- Validar plano de corte de aplicação: todos os gravadores de agenda precisam respeitar a união/protocolo novo antes de habilitar revisão operacional. Não deixar código antigo confirmar reserva ignorando hold.
- Testar a migration futura e seu down em cópia restaurada, com definições catalogadas antes/depois. Não executar testes destrutivos no banco real.

### Postcheck previsto

- Confirmar 40 tabelas e todas as colunas/tipos/defaults/null/constraints/índices/triggers/funções, inclusive DEFERRABLEs.
- Contagens das duas novas tabelas = 0; quatro campos novos das aprovações antigas NULL; nenhuma criação de registro financeiro, reserva, prova, sessão ou usuário.
- Comparar as 38 projeções antigas e hashes BYTEA com checkpoint; contar casos reais e respectivos filhos.
- Testar rejeição de estado/vínculo/hash inválidos e rollback de transições em clone, inclusive efeitos de triggers diferidos.
- Conferir arquivos 012/013/schema e configuração de autenticação byte a byte.
- Habilitar funcionalidade somente após código completo, integração de todos os gravadores de agenda e regressões aprovadas. Aplicar estrutura isoladamente não autoriza UI parcial de remarcação.

### Rollback antes de uso

Down futuro somente após comprovar tabelas novas vazias e ausência de aprovações vinculadas/auditoria/documentos de revisão 014. Desabilitar entrada de operações e aguardar transações; restaurar aplicação compatível. Em transação, retirar triggers complementares, FKs circulares de aprovação/revisão, índices/constraints novos, colunas novas opcionais, tabelas filhas/pai e funções novas em ordem de dependência; retirar UNIQUE de suporte em contratos por último. **Sem DROP CASCADE**, sem remover objeto da 012/013 e sem desabilitar provas/auditoria imutáveis.

Como nenhuma função da 013 é substituída neste desenho, rollback não precisa reconstruí-la de memória. Confirmar catálogo igual ao pré-014 e dados antigos preservados; timeout/erro aborta down inteiro.

### Rollback depois de uso

**Não é seguro executar down destrutivo.** Mesmo uma revisão CANCELADA já pode conter prova e histórico permanente. APLICADA pode ter alterado operação/contratante/agenda e gerado pendência; apagá-la retiraria suporte documental e histórico operacional. Holds de revisões ainda abertas também não podem desaparecer por rollback estrutural.

Depois do primeiro uso: parar novas revisões pela aplicação sem desativar consulta/proteção das existentes; preservar tabelas/provas e concluir/cancelar somente por operações autorizadas. Preferir correção adiante. Restaurar backup completo exigiria autorização específica, análise de perda de operações posteriores e tratamento conjunto de banco/fontes; não será um rollback automático. Voltar somente o frontend/backend antigo pode ignorar reservas e também é proibido enquanto existirem proteções 014.

## 15. Plano de testes obrigatório antes de liberar

Estes testes **ainda não foram implementados/executados para a 014**: a etapa atual é documental. Executá-los futuramente em clone do checkpoint, com fixtures independentes e sem remover registros reais.

| Cenário | Resultado exigido |
|---|---|
| V1 CONFIRMADA 12/09 17–21; proposta 19/09 17–21 | Ambas protegidas durante EM_ELABORACAO e CONGELADA |
| Nova contratação tenta 19/09 protegido por hold de V1 CONFIRMADA | Não confirma reserva; recebimento legítimo, se existente, segue política atual de conflito, sem ser apagado |
| Cancelar V2 de V1 CONFIRMADA antes/depois assinatura Kidmais | Hold de 19 liberado; 12/V1/pagamento intactos; PDF e prova preservados |
| Cliente aceita V2 de V1 CONFIRMADA | 12 liberada, 19 CONFIRMADA, Fechamento continua CONFIRMADO; operação e ponteiros coerentes no mesmo commit, sem alteração financeira inventada |
| Trocar proposta 19→26 e 26 ocupada | Falha mantém reserva de 19 e operação de 12 |
| Duas revisões de V1s CONFIRMADAS para 19 | Uma adquire hold; outra espera e rejeita conflito após commit da vencedora |
| Duas remarcações do mesmo contrato | Uma revisão aberta; índice/expectedRevision impedem segunda |
| Bloqueio administrativo × revisão, nas duas ordens | Um espera; não coexistem bloqueio novo e hold incompatível |
| Bloqueio dia inteiro, reativação, mudança de dia e desativação | Mesmo protocolo; intervalos adjacentes continuam permitidos |
| Primeiro pagamento durante V2 aberta, destino disponível | Confirma V1 na data ainda vigente; adquire hold do destino após validar; sem falso conflito consigo, sem alteração do conteúdo/PDF nem deadlock |
| Primeiro pagamento durante V2 aberta, destino ocupado por terceiro/bloqueio | Recebimento e confirmação legítima de V1 preservados; destino sem hold, conflito auditado; não rouba data nem permite aplicação enquanto não resolvido |
| Primeiro pagamento durante V2 CONGELADA | Mesmos resultados de disponibilidade/conflito; só metadado do hold pode mudar; PDF/provas/contador/hash permanecem iguais |
| Aceite × cancelamento; edição × congelamento | Um vence; o outro observa estado final sem mutação parcial |
| V1 ASSINADA + AGUARDANDO_PAGAMENTO abre/congela V2 | Nenhuma ocupação da base ou hold do destino; marcador NULL; UI informa DATA PROPOSTA — AINDA NÃO RESERVADA |
| V2 concluída sem primeiro pagamento | Nova data operacional, estado financeiro/reserva apropriado preservado; não retorna ocupação por APLICADA; nenhuma confirmação artificial |
| Primeiro pagamento qualificante após promoção V2 | Usa nova data vigente, lock e revalidação; confirma somente se livre; pagamento continua ligado à obrigação original |
| Primeiro pagamento após V2 com nova data ocupada | Detecta conflito; não confirma/rouba data; preserva recebimento conforme política existente |
| Destino de V2 ainda sem reserva confirmado por terceiro entre proposta e conclusão | Terceiro pode reservar; revalidação de V2 detecta conflito e impede concluir; não cria hold retroativo |
| V1 sem confirmação e base já ocupada por terceiro, novo destino livre | Não adquirir/tomar base; permitir proposta de outro destino disponível sem hold; manter situação de V1 |
| Bloqueio administrativo sobre destino apenas proposto, sem reserva | Permitido conforme validações normais; proposta não gera bloqueio artificial e deve detectar conflito na revalidação |
| Cancelar V2 ainda sem confirmação/hold | Nenhuma data de terceiro liberada, nenhuma confirmação criada; situação V1 preservada |
| UI e função de ocupações | Distinguir RESERVA CONFIRMADA, DATA PROPOSTA — AINDA NÃO RESERVADA e DATA PROVISORIAMENTE PROTEGIDA DURANTE REMARCAÇÃO; só confirmadas/holds adquiridos bloqueiam agenda |
| Upgrade e convidados 110/130/140/manual | Pricing da proposta correto; vigente inalterado; limites do pacote respeitados |
| Adicionais, combos incluídos e buffet | Sem cobrança duplicada; reset/reseleção de buffet só na preparação |
| Três formas de pagamento, base 9.290 | 8.361,00 / 9.011,30 / 9.290,00; sem desconto duplo |
| Fração de centavo, plano divergente | Entrada rejeitada; soma financeira exata, sem epsilon |
| Nova negociação/aprovação seguida de edição | Aprovação exata invalidada; histórico V1 e decisões anteriores intactos |
| CRM mesma pessoa | Atualização imediata auditada; V1/PDF congelado preservados; V2 pré-assinatura exige nova revisão documental |
| Troca contratante/responsável/criança | FK/pertencimento/atividade/identidade corretos; vínculos vigentes só mudam na aplicação |
| Cliente antigo tenta assinar V2 do novo cliente | Acesso/OTP rejeitado; V1 continua histórico da parte original |
| V2 criada a partir de V1 | Não herda assinatura/prova/OTP/aprovação documental |
| Modificação de filho após congelamento | Rejeitada pelo banco e API |
| Corrupção simulada de hash/base/fluxo/reserva/PDF | Conclusão rejeitada; rollback preserva V1 e preparação |
| Falha ao inserir pendência/auditoria/commit diferido | Nenhuma assinatura cliente/OTP consumido/promoção parcial |
| Dois Pagamentos reais e filhos, em clone | Projeções antigas preservadas durante revisão; só pendência nova cabível após aplicação |
| Nova V3 sobre V2 aplicada | Revisão histórica preservada, uma aberta, ocupação transferida sem exigir V2 vigente para sempre |
| Idempotência criação/decisão/assinatura/aplicação/cancelamento | Uma mutação efetiva; UUID case normalizado; payload incompatível rejeitado |
| Auditoria | Eventos completos com ator real, antes/depois, motivo e request_id, sem segredos |
| Migration up/down sem uso; down depois de uso | Reversão limpa sem uso; bloqueio explícito do down destrutivo após uso |

Regressões completas previstas: Fechamento (público e administrativo), PricingService, condição PIX da 012, Contrato/autenticação da 013, Pagamentos unitário/engenharia/HTTP/concorrência, Disponibilidade, Identidade/CRM, acabamento/browser desktop e mobile, testes integrados de novo fluxo, TypeScript, lint direcionado e build. Nas concorrências usar conexões distintas, barreiras e as duas ordens de commit; repetir com espera real do advisory lock e timeout controlado.

## 16. Arquivos previstos para implementação posterior

Lista de planejamento, **nenhum destes foi modificado por esta proposta**. Caminhos abaixo são relativos à raiz `D:\glass\KidMais Manager\kidmais-manager`.

| Arquivo/grupo | Trabalho futuro |
|---|---|
| database/migrations/*_014_revisao_operacional.sql e down correspondente | Somente depois de autorização; estrutura especificada |
| lib/fechamentos/repositories/revisao.repository.ts (novo) | Pai/filhos, bloqueios, expectedRevision e consultas tipadas |
| lib/fechamentos/repositories/models.ts e index.ts | Tipos e exports da preparação |
| lib/fechamentos/services/revisao-operacional.service.ts (novo) | Criar, editar, congelar, aplicar e cancelar no domínio Fechamento |
| lib/fechamentos/services/revisao-operacional-schema.ts (novo) | Parser estrito, operações cadastrais, dinheiro exato |
| lib/fechamentos/services/edicao-administrativa.service.ts e edicao-administrativa-schema.ts | Compartilhar cálculo/validações sem retirar proteção pré-assinatura |
| lib/fechamentos/repositories/edicao.repository.ts e fechamento.repository.ts | Aplicação atômica do preparado; histórico comercial separado |
| lib/comercial/services/pricing.service.ts e condicao-pagamento.ts | Reutilização do cálculo; alterar somente se necessário para aceitar fonte preparada, sem mudar descontos |
| lib/disponibilidade/repositories/disponibilidade.repository.ts e models.ts | União de ocupações, exclusão autenticada do próprio dono, bloqueios e locks |
| lib/disponibilidade/services/availability.service.ts e models.ts | Agenda provisória nas consultas públicas/admin |
| lib/contratos/services/administrativo.service.ts | Orquestração da preparação, revisão comercial, PDF, congelamento/cancelamento |
| lib/contratos/services/contrato.service.ts, snapshot-core.ts e alteracoes.ts | Projeção documental da fonte preparada e referência id/revisão/hash |
| lib/contratos/services/fluxo-publico.ts e contrato-publico.service.ts | Aceite/aplicação/promoção/pendência numa transação; identidade por versão |
| lib/contratos/repositories/contrato.repository.ts e models.ts | Tipos/consultas da relação com preparação |
| lib/clientes/services/cliente.service.ts e aniversariante.service.ts | Reutilizar correções; validar vínculos e operações de troca pelo domínio |
| lib/identidade/services/identity.service.ts | Revisar escopo OTP por versão/novo contratante; mudança só se testes demonstrarem necessidade |
| lib/pagamentos/services/pagamento.service.ts | Integrar conflito de reserva com preparação e manter obrigação original; não recalcular total/plano |
| app/api/admin/fechamentos/[fechamentoId]/revisoes/route.ts (novo) e subrota por revisão | Endpoints próprios da preparação, separados da revisão comercial já existente |
| app/api/admin/contratos/versoes/[versaoId]/route.ts e edicao/route.ts | Ações coerentes com preparação e estados |
| app/api/admin/disponibilidade/route.ts | Bloqueio administrativo respeita hold e informa conflito |
| components/admin/ContratoAdmin.tsx, EdicaoFesta.tsx e admin.module.css | Diferenciar vigente/proposto, reserva, congelamento e cancelamento explícito |
| scripts/revisao-operacional*.cjs (novos) | Integração, HTTP, concorrência, navegador e verificação física em clone |
| scripts/admin-contrato.integration.cjs, acabamento*.cjs, validacao-funcional-013.cjs | Expandir regressões sem perder cenários aprovados |
| Relatório futuro da 014 | Resultados físicos/testes/limites e roteiro manual detalhado |

Sem arquivo de Festa. Sem modificação das migrations 012/013 ou `schema_mvp_kidmais.sql`. Sem alteração financeira automática. Uma autorização futura da estrutura não dispensa implementar/testar o fluxo inteiro antes de habilitar remarcação.

## 17. Entrega desta etapa e ponto de parada

Entregue: desenho físico completo, inspeção atual, reserva sem expiração, integração dos locks, estados, cadastro/comercial, assinatura/aplicação/cancelamento, auditoria, impactos, precheck/postcheck/rollback e plano de testes/arquivos.

**Único arquivo criado nesta etapa: este documento.** A Migration 014 não foi criada nem aplicada. Nenhum teste do novo fluxo foi anunciado como aprovado; a validação funcional permanece futura. A seção 7.2 foi corrigida conforme a regra oficial: assinatura/revisão/promoção sem pagamento qualificante não criam confirmação nem ocupação permanente. Aguardar autorização antes de implementar qualquer parte.
