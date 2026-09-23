# Configuração herdável — direção física aprovada

D04 permanece ACCEPTED: default E → override U, resolução determinística, versão efetiva preservada. **OPEN_1C-01 CLOSED na 1C-B0 por aprovação explícita do usuário**: versões tipadas por escopo + publicação efetiva por estabelecimento (A+C). Detalhes finais de tabelas/colunas/constraints continuam sujeitos a revisão antes do SQL; não há catálogo implementado.

## Alternativas

| Critério | A — linhas com scope explícito | B — base + override por campo | C — materialização efetiva por unidade |
| --- | --- | --- | --- |
| Integridade | FK por E simples; default U NULL exige prova adicional de aplicabilidade | FK de base boa, mas validar composição/campos/referências é mais complexo | FK operacional diretamente em publicação U; fechamento do grafo verificável |
| Histórico/versionamento | Bom se cada revisão ganha ID e versão publicada é imutável | Exige congelar base **e** patch/resolvedor; base mutável altera passado | Excelente para consumidores, valores efetivos imutáveis com proveniência |
| Queries | Resolver default/override e vigências em leitura | Joins/merge tipado por campo em cada resolução | Lookup direto da publicação selecionada |
| Simplicidade | Mais simples para autorar versões tipadas completas | Mais opções e estados ambíguos; exige operadores HERDAR/DEFINIR/LIMPAR | Mais relações/publicador, consumidor simples |
| Rollout V1 | Preserva IDs antigos como primeira revisão de default | Campos herdados precisam proveniência inexistente na V1 | Exige ponte da referência antiga à publicação inicial, sem reescrever snapshots |
| Custo | Mais versões, pouca duplicação de valores herdados | Menos repetição, mais lógica e auditoria por campo | Publicações e vínculos adicionais; custo de publicação e retenção |
| Limite | A isolada não comprova FK de aplicação à unidade | Merge JSON genérico não é aceitável | C isolada duplica defaults e perde autoria de herança se não guardar fontes |

**Recomendação A+C:** autoria tipada e versionada com escopo explícito; publicação resolve A uma vez e fixa vínculos tipados das versões efetivas para U. Não copiar cegamente todas as linhas a cada consulta nem recalcular uma publicação existente. Materialização lógica por referências a versões imutáveis evita copiar valores de defaults, mas conserva uma versão efetiva por unidade. B não é necessário inicialmente; overrides são versões completas de um item/relação, com origem explícita. Futuro override por campo exige novo contrato tipado e não merge recursivo genérico.

## Estruturas candidatas

1. As **dez tabelas V1** de configuração ganham E NN, `escopo` EMPRESA/ESTABELECIMENTO, U opcional somente para default, `identidade_config_id uuid`, `revisao bigint`, `estado_publicacao` RASCUNHO/PUBLICADA/RETIRADA e datas de vigência quando o domínio ainda não as tiver. O UUID existente continua sendo o ID da revisão inicial; novas revisões têm novo UUID. A identidade estável pode apontar para a própria primeira revisão via FK(E,identidade_config_id) na mesma tabela; identidade/empresa não mudam. UNIQUE(E,id) e UNIQUE(E,identidade_config_id,escopo,U,revisao), com NULL tratado como um único escopo default. Checks: E nunca NULL no final; default exige U NULL; override exige U NN e FK(E,U); revisão positiva. Não modificar valores de uma versão PUBLICADA, nem suas referências; RETIRADA impede uso novo, preserva leitura histórica.
2. `configuracao_publicacoes`: id UUID PK, E/U NN, numero bigint NN, `estado` RASCUNHO/PUBLICADA/ENCERRADA, `vigente_desde`, `vigente_ate` opcional, `publicada_em` opcional, `publicada_por_membership_id` opcional enquanto rascunho, criado_em NN. UNIQUE(E,U,id), UNIQUE(E,U,numero); FK(E,U), FK(E,membership_id) quando publicada; índice(E,U,estado,vigente_desde). Publicação é um conjunto coerente; intervalos efetivos da mesma unidade não podem se sobrepor. Escolha futura de exclusão/validação concorrente deve prover essa garantia; check de uma linha não basta.
3. **Dez tabelas de vínculo tipado**, uma por catálogo: `configuracao_agenda_aplicacoes`, `pacotes_aplicacoes`, `tabelas_preco_aplicacoes`, `regras_categoria_horario_aplicacoes`, `precos_pacote_aplicacoes`, `adicionais_aplicacoes`, `precos_adicional_aplicacoes`, `regras_disponibilidade_pacote_aplicacoes`, `regras_desconto_pacote_aplicacoes`, `festa_areas_aplicacoes`. Todas têm E/U/publicacao_id/config_id NN, identidade_config_id NN e criado_em NN. PK(E,U,publicacao_id,config_id); UNIQUE(E,U,publicacao_id,identidade_config_id). FK(E,U,publicacao_id)→publicações; FK(E,config_id)→tabela tipada; identidade deve corresponder à fonte. Essas relações existem para FKs reais, evitando `tipo/id` polimórfico sem integridade.

A FK(E,config_id) sozinha não distingue default de override de outra unidade da mesma empresa. Complemento **obrigatório de integridade de banco** na publicação: fonte é EMPRESA da mesma E ou ESTABELECIMENTO de E/U exatos; identidade confere; todos os pais comerciais resolvem versões presentes **na mesma publicação**; apenas uma revisão por identidade; vigências/faixas coerentes. Propor validador transacional de publicação, com locks por E/U e validação diferida na confirmação, incapaz de publicar parcialmente. Fontes PUBLICADAS/vínculos de publicação são imutáveis; qualquer alteração posterior que violasse a validação é proibida. Testar tentativa de inserir vínculo diretamente, trocar fonte/U ou modificar pai depois de publicar. Não deixar esse complemento apenas no serviço.

Para relações entre versões comerciais, acrescentar FKs(E,parent_id) aos pais tipados e validar fechamento da publicação. Se override de pacote substitui uma revisão que o preço ainda referencia, a publicação deve criar versão coerente do preço ou recusar; não remapear parent silenciosamente. Uma versão de regra/desconto com agenda opcional NULL é válida no domínio, mas nunca dispensa E nem autoriza outra unidade.

Essas 11 novas relações são a proposta detalhada para a direção A+C aprovada e não pertencem às 63 V1; aprovação da direção não sela automaticamente seus nomes/colunas. Sua necessidade decorre da aplicabilidade de default a várias unidades, FKs tipadas e preservação de história. Não são aprovadas tabelas genéricas de atributos livres. Numeração/identidade de publicação e quantidade final de índices serão medidas no protótipo futuro.

## Aplicação às dez configurações

| Tabela | Pais tipados por E | Identidade/unicidade comercial por revisão/escopo | Consumidor e preservação |
| --- | --- | --- | --- |
| configuracao_agenda | Nenhum | codigo; horários/passo/tolerância; código por E/escopo/U/revisão | fechamento/revisão referencia aplicação; data e horários materializados mantidos; bloqueios_agenda continua raiz U sem FK de configuração |
| pacotes | Nenhum | codigo; limites/duração; identidade estável separada da revisão | oferta/fechamento/contrato; conservar código/nome/valor no snapshot |
| tabelas_preco | Nenhum | codigo e vigência dentro da publicação; não permitir escolha ambígua | precos_pacote/precos_adicional e fechamento; versão publicada |
| regras_categoria_horario | configuracao_agenda_id | dia_semana,agenda,vigencia_inicio; antissobreposição com escopo | pricing/categoria aplicada congelada |
| precos_pacote | tabela_preco_id,pacote_id | categoria,faixa mínima/máxima da combinação; manter NULLS NOT DISTINCT para faixa aberta | fechamento preço efetivo + valores materializados |
| adicionais | Nenhum | codigo/categoria/unidade; identidade por E/escopo/revisão | item contratado mantém nome/unidade/quantidade/valor |
| precos_adicional | tabela_preco_id,adicional_id | faixa mínima/máxima; manter semântica de faixa aberta e antissobreposição | item contratado aponta revisão efetiva |
| regras_disponibilidade_pacote | pacote_id,configuracao_agenda_id | pacote,dia,agenda,vigência; 017 é dado Kidmais histórico | oferta/autorização de data; não confundir com ocupação factual |
| regras_desconto_pacote | pacote_id,configuracao_agenda_id opcional | pacote,dia,agenda opcional,codigo,vigência; geral/específica com precedência explícita | percentual/origem/valor aplicado não mudam |
| festa_areas | criado_por global é autoria, não pai de configuração | nome normalizado por escopo/revisão; identidade estável da área | tarefa/pendência aponta aplicação/versionamento; FK de área atual não basta |

Unique de código sem revisão pode existir em identidade lógica, mas não deve impedir publicar duas revisões históricas do mesmo item. Enquanto código está em tabela de revisão, o unique inclui identidade temporal/escopo; publicador garante uma identidade ativa por código normalizado no conjunto efetivo. Preservar proteção existente até substituição equivalente; simplesmente prefixar E e manter codigo global excluiria overrides/versões legítimos. Ver [inventário de uniques](SAAS-SCHEMA-63-MATRIX.md).

## Referências operacionais e legado

- Propor `configuracao_publicacao_id` nos roots que usam oferta/agenda, e na tarefa/pendência quando a área aplicada puder pertencer a publicação diferente daquela da contratação. Cada FK para config usa `(E,U,publicacao_id,config_id)`→vínculo tipado correspondente. Filhos que devem usar a mesma publicação do root expõem parent+publicacao em chave composta; não basta ter o mesmo E/U.
- Fechamento conserva FKs atuais/valores, contrato conserva snapshot/hash/PDF/versão, pagamento deriva valor contratado; Festa mantém snapshot operacional. Acrescentar referências efetivas sem reescrever os documentos históricos. Na raiz contratual, capturar publicação da revisão aprovada, não consultar "a atual" ao assinar.
- Publicação inicial Kidmais usa apenas configuração comprovada. Linhas herdadas conservam seus IDs; o mapa aplicado acrescenta referência E/U. Se catálogo atual não reproduz um valor histórico, snapshot/valor antigo continua sendo autoridade histórica: não associar falsa publicação. A falta deve ser explicitamente reconciliada; referência histórica opcional pode permanecer ausente com motivo tipado, nunca E/U ausentes. Novas operações após cutover exigem publicação obrigatória.
- `festa_areas` não tem nome histórico congelado em todos os consumidores V1. A revisão inicial registra o valor disponível no momento da migração, sem alegar que era o nome original. Tarefas novas fixam revisão; atribuição histórica não demonstrável exige revisão, sem fabricar fatos.
- Campos fora das dez tabelas (templates, buffet, identidade visual, condições de pagamento, JSON de overrides) estão no D12a. A primeira foundation não finge tê-los migrado. Futuras estruturas tipadas devem integrar o mesmo protocolo de publicação/versão antes de habilitar o respectivo módulo para segunda empresa; sem EAV/JSON genérico para burlar integridade. Segredos e grants nunca entram nesse catálogo.

## Provas pendentes após fechamento de OPEN_1C-01

A direção A+C está aprovada; revisar custo de 10 vínculos tipados, granularidade de publicação e colunas finais. Posteriormente provar: defaultE para U1/U2; overrideU1 sem alterarU2; publicação inválida sem pai/mesma identidade duplicada/intervalo concorrente; retirada sem mudar história; todos os consumidores com FK aplicada; duas transações publicando concorrentemente; rollback do ponteiro sem reescrever versão consumida. A [prova de migratabilidade](SAAS-MIGRATABILITY-PROOF.md) exige projeção histórica compatível antes de adicionar metadados em linhas incluídas por inteiro em hashes. O protótipo não é executado nesta fase.
