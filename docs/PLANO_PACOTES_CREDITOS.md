# Plano de pacotes de créditos — Convites e Wall-e

Data: 22/10/2026. **PROPOSTA para decisão de Felipe; nenhuma implementação ou homologação nesta entrega.**

## 1. Escopo, base e evidências

Entrega exclusivamente documental. Clone novo `kidmais-manager-plano-creditos-20261022`, criado de objetos locais de `kidmais-manager-capacidade-20261022`; `core.autocrlf=false` definido antes do checkout. Branch `codex/plano-pacotes-creditos-20261022`, base da referência local de staging `3bb7b4b286cc0844757a8be4eb502140ae1f0550` (#201). Não houve fetch: essa é a base local identificada, não uma certificação do HEAD remoto atual. Antes da implementação, atualizar staging mediante escopo autorizado e rever este mapa. AGENTS.md, CLAUDE.md e docs/OPERACAO_AGENTES.md lidos. Não houve consulta a Render, bancos, contas Asaas ou credenciais.

Referências abaixo são `arquivo:linha` nessa base, salvo indicação explícita de outro clone. As linhas são âncoras para leitura, não comprovação de publicação:

| Tema | Evidência e conclusão |
|---|---|
| Carteira atual | `database/migrations/20261008_073_convites.sql:6`; `lib/convites/service.ts:123`: limite mensal em `convite_carteiras`, consumo em `convite_consumos`; ausência de linha resulta em limite zero. É franquia menos uso, não carteira de compras. |
| Reserva | `lib/convites/service.ts:528`, `:563`, `:568`: trava, validação de cotas, teto `CONVITES_IA_TETO_DIARIO_MICROUSD` e reserva fixa de 300.000 µUS$; isso não mede a fatura real da OpenAI. Recuperação conserva reservas incertas (`:278`, `:319`). |
| Tela | `components/convites/ConviteEditor.tsx:369`, `:376`, `:426`: já mostra saldo e permite limites por festa/cliente. `lib/convites/service.ts:212` restringe essas cotas à Gestão. Inspeção de Convites não encontrou compra nem concessão de saldo empresarial pela tela. Não confundir com ajustar limites da festa. |
| Unidade atual | O editor informa uma geração = um crédito, inclusive convite completo (`ConviteEditor.tsx:369`). Upload, modelos e download não gastam créditos. |
| Autorização | `database/migrations/20261021_088_convite_ia_autorizacoes.sql:1`; `lib/convites/service.ts:544`: exige autorização vigente e confirmação específica das imagens. Compra não substitui esses controles. |
| Modelos de imagem | `lib/convites/imagem.ts:5`, `:86`, `:87`, `:128`: OpenAI `gpt-image-2.5-flare` (arte medium 768×1024) e `gpt-image-2.5-sunburst` (completo xhigh 1024×1536). Não precificar como GPT Image 1 nem presumir custo igual por saída. |
| Wall-e | `lib/whatsapp/atendimento/configuracao.ts:26`, `:35`, `:43`: modo regras por padrão; modelo exige autorização R6 e demais gates. `lib/inteligencia/modelos/orcamento.ts:6` reserva/reconcilia orçamento; `lib/inteligencia/modelos/precos.ts:9`, `:30` lê `AI_PRICING_JSON`; custo desconhecido não é zero. |
| Estado de produção | Variáveis `WHATSAPP_ATENDIMENTO_*` ausentes e suspensão jurídica são informações fornecidas por Felipe. Código confirma comportamento fechado na ausência; **não confirma configuração remota atual**, que não foi consultada. |
| Preços da assinatura | `lib/assinatura/planos-comerciais.ts:9`: anual = 10 mensalidades, Fundador 40% por 12 meses/20 vagas; `:14`: R$ 197/397/697. Não alterar nem aplicar desconto Fundador automaticamente a pacotes. |
| Asaas | `lib/assinatura/asaas.ts:256`, `:291`, `:314`: consulta cobrança, cria cliente e assinatura. Compra avulsa exige extensão própria; não usar assinatura como pacote. `lib/assinatura/webhook-asaas.ts:1`: autenticação, inbox `cobranca_eventos`, deduplicação e reconsulta do provedor. |
| Reconciliação | `scripts/assinatura-reconciliar.cjs:26`, `:291`, `:367`: D-C4 na conferência de produção, avisos por idade e códigos de saída. Não transformar conferência de produção em escrita implícita. |
| Cancelamento L1 | **Fora desta base**: clone `kidmais-manager-devolucao-20261021`, HEAD observado `326895eaef59eb926e34397220df333cdf754b4e`; `lib/assinatura/devolucao.ts:2`, `:50`, `:226`; `database/migrations/20261021_089_assinatura_encerramentos.sql:30`, `:90`. Há protocolo, encerramento e `ASSINATURA_ESTORNO_ATIVO`; integração deve ser coordenada, não presumida. |
| Exportação | `lib/exportacao/entidades.ts:4`, `:266`, `:273`: inventário e exclusões atuais (inclusive carteiras internas). `lib/exportacao/pacote.ts:298` recusa tabelas não classificadas; `lib/exportacao/exportacao.test.ts:102` recusa também classificação órfã. |
| Site | `lib/site/catalogo.ts:80`: “Condições a definir” refere-se a copiloto/importação, não especificamente aos dois produtos deste plano. Não substituir a oferta de outros recursos por inferência. |

A 088 está nesta base; a 089 foi examinada no clone acima; a 087 está reservada para e-mails de cobrança conforme registro local. Busca de arquivos `_090_`, `_091_` e aplicadores 090/091 no workspace não encontrou ocupação. **090 é candidato ao próximo número livre, não reserva global**. Rever clones, branches, SQL, checks, rollback e aplicadores antes de congelar e antes de aplicar. Não criar migration nesta tarefa.

## 2. Produto proposto

### Unidades e franquias

Manter **1 crédito de Convites = 1 geração concluída de arte ou convite completo**, preservando a unidade já comunicada. Nova tentativa solicitada após sucesso consome novamente; falha comprovada sem resultado não cobra o cliente. Reservas incertas ficam visíveis como “em verificação”, não são liberadas só pelo tempo. Custo desperdiçado por falha do fornecedor fica no orçamento da plataforma, mesmo quando o crédito do cliente é devolvido.

Para **Wall-e**, propor 1 crédito = **1.000 µUS$ de custo calculado de inferência** (US$ 0,001), com saldo interno inteiro em µUS$. Não vender número garantido de mensagens: cada interação pode ter várias chamadas, entrada/cache/saída e modelos distintos. Mostrar saldo e consumo com explicação acessível; cobrança fracionária sem arredondar cada chamada para um crédito inteiro. Preços e versão da tabela de custo congelados por chamada. Custos de Meta/Gupshup, mensagens e outros serviços não estão incluídos neste crédito de IA e precisam de oferta separada.

Carteiras não intercambiáveis; sem conversão em dinheiro, transferência entre empresas ou recarga automática. Reembolso contratual continua permitido. Não introduzir “moeda universal” que também alcance copiloto/importação.

**Sugestão de franquia, não direito atual nem preço aprovado:**

| Plano | Convites por mês | Wall-e por mês, somente após liberação |
|---|---:|---:|
| Essencial (R$ 197) | 5 | 1.000 créditos = US$ 1 de inferência |
| Profissional (R$ 397) | 15 | 3.000 = US$ 3 |
| Premium (R$ 697) | 30 | 6.000 = US$ 6 |

Propor mês civil de São Paulo, compatível com consumo atual; assinatura ativa na concessão, unicidade empresa/recurso/mês. Anual recebe mensalmente, não todo o saldo no pagamento. Para primeira ativação ou upgrade no meio do mês, conceder proporcional aos dias restantes (arredondar gerações para cima); upgrade só dá diferença, downgrade só no mês seguinte, reativar não dá segunda franquia. Validar comercialmente essas regras antes de codificar. Sem acumular franquia não usada; mostrar data de renovação. Não conceder Wall-e enquanto indisponível, nem anunciar franquia utilizável antes da liberação.

Pacote pago: proposta de **12 meses a partir da liberação**, carregado entre meses até vencer; indisponibilidade imputável à plataforma prorroga prazo ou permite devolução. Avisos 30 e 7 dias antes. Validade depende de validação jurídica, sem perda silenciosa. Consumir primeiro lotes de menor vencimento, priorizando franquia/cortesia em empate; congelar a alocação dos lotes na reserva para permitir devolução correta. Cortesia piloto: 10 gerações e, futuramente, US$ 2 de Wall-e por 60 dias, concessão por operador autorizado da plataforma, motivo, protocolo, teto de campanha e idempotência. Gestão do buffet não pode fabricar saldo. Cortesia não gera valor a devolver e não contorna gates jurídicos.

No encerramento da assinatura, separar seus valores dos pacotes. Preservar L1: garantia integral nos 7 dias da primeira ativação paga inclusive CNPJ; mensal até fim do ciclo; anual proporcional aos dias não usados sobre valor pago, sem recuperar Fundador. **Proposta adicional para pacotes:** devolver saldo pago ainda não consumido ao encerrar efetivamente o acesso, pelo preço unitário original do lote, sem taxa punitiva; não deixar saldo inutilizável por 60 dias de somente leitura. Cancelar só a renovação mantém uso até fim do ciclo. Franquia/cortesia não são reembolsáveis em dinheiro. Falha de serviço e cobrança indevida têm tratamento próprio, sem limitação por essa regra. Jurídico deve decidir relação de contrato acessório e marco da validade.

## 3. Pacotes e formação do preço — sugestões para Felipe

Referência pública consultada em 22/10/2026: [OpenAI API Pricing](https://developers.openai.com/api/docs/pricing). Para os modelos de imagem usados pelo código, tabela **Standard**: US$ 5 por milhão de tokens de texto de entrada, US$ 8 de imagem de entrada, US$ 30 de imagem de saída; cache tem tarifa própria. Não usar desconto Batch para chamadas síncronas. Tokens e referências variam: não há custo fixo comprovado por geração nesta análise.

Fórmula de custo de imagem: `(texto×5 + imagemEntrada×8 + imagemSaida×30)/1.000.000`, separando cache para não contar duas vezes. Exemplo **sintético**, não medição: 1.000/1.000/8.000 tokens → US$ 0,253. O custo real deve vir do usage de cada operação e ser confrontado com cobrança do fornecedor. Nenhuma chamada foi executada aqui.

Hipóteses de cálculo comercial: US$ 0,30 por geração (orçamento provisório, **não teto técnico provado**), câmbio de planejamento R$ 6/US$ (não cotação) e reserva de risco de 25%; custo orçado = R$ 2,25/geração ou R$ 7,50/US$ de Wall-e. Sem medição p95/p99 de arte, completo xhigh, imagens de referência, falhas e retries, **não aprovar tabela para venda**. Se xhigh ultrapassar isso, reajustar novos pacotes ou repropor unidades antes da oferta; nunca reduzir retroativamente os créditos vendidos.

| Recurso/pacote | Quantidade | Preço sugerido | Custo orçado acima | Margem sobre esse custo* |
|---|---:|---:|---:|---:|
| Convites pequeno | 10 gerações | R$ 59 | R$ 22,50 | 61,9% |
| Convites médio | 30 gerações | R$ 159 | R$ 67,50 | 57,5% |
| Convites grande | 100 gerações | R$ 499 | R$ 225 | 54,9% |
| Wall-e pequeno | 5.000 créditos / US$ 5 | R$ 99 | R$ 37,50 | 62,1% |
| Wall-e médio | 15.000 / US$ 15 | R$ 269 | R$ 112,50 | 58,2% |
| Wall-e grande | 50.000 / US$ 50 | R$ 849 | R$ 375 | 55,8% |

*`(preço − custo orçado)/preço`, não markup nem lucro líquido. Retirar tarifas reais Asaas por meio, impostos, suporte, armazenamento, fraude/estornos e falhas antes da decisão. Fórmula de piso: `P >= (custoInferencia + custoFixoPagamento + suporte + perdaEsperada)/(1 − imposto% − tarifaVariavel% − margemAlvo%)`. Exemplo de sensibilidade, parâmetros fictícios: pacote R$ 59 com 10% tributos, 5% tarifa, R$ 2 fixos e R$ 5 suporte deixa R$ 20,65 (35%); se custo de inferência dobrar, contribuição fica negativa em R$ 1,85. Não são taxas contratadas.

Custos das franquias também saem da margem da assinatura: nas hipóteses acima, 5/15/30 gerações mais US$ 1/3/6 dão R$ 18,75/56,25/112,50 por mês. Avaliar anual, Fundador e custos do SaaS conjuntamente. Oferecer primeiro pequenos/médios para piloto; grande só após observar uso e devoluções. Versionar catálogo em centavos, unidades, recurso, validade e termos; pedidos preservam fotografia da oferta.

## 4. Compra, confirmação e devolução

1. Gestão abre **Assinatura → Créditos de IA** ou atalho no saldo do editor. Backend comprova empresa e papel, assinatura apta, recurso liberado e limites; nunca aceita preço, empresa ou saldo do navegador como autoridade.
2. Escolhe pacote e Pix/cartão/boleto; vê total, quantidade, validade, condições, ausência de renovação automática e política de reembolso. Reautenticação com senha, rate limit, CSRF/origem, resumo e confirmação explícita. Aceite guarda versão/hash dos termos, não senha.
3. Transação local cria pedido e protocolo `KM-AAAAMMDD-XXXXXXXX`, chave idempotente e snapshot. Mesma chave + mesmo payload retorna pedido; mesma chave + payload diferente = conflito. Não abrir transação de banco durante HTTP externo.
4. Criar cobrança **avulsa** e devolver fatura hospedada pelo Asaas; Pix pode mostrar QR/copia-e-cola, boleto link e vencimento, cartão fica na página do provedor. Não receber PAN/CVV nem reutilizar silenciosamente cartão da assinatura. Homologar essa experiência, inclusive retorno e acessibilidade.
5. Tela mostra “Aguardando confirmação do pagamento”. Retorno do navegador, comprovante e criação da cobrança não liberam saldo. Webhook autenticado registra evento; processador reconsulta Asaas; reconciliação diária cobre perda de evento e queda do processo.
6. Confirmar ID, conta/ambiente, customer, externalReference, BRL/valor esperado e estado permitido. Política proposta: `CONFIRMED` ou `RECEIVED` libera uma única vez; `AUTHORIZED` e aprovação de análise de risco isolada não liberam. `RECEIVED` depois de `CONFIRMED` não credita de novo. Valor divergente, dinheiro/manual ou cobrança sem vínculo ficam em revisão. Pagamento tardio de pedido vencido exige política: se oferta ainda pode ser honrada, liberar com validade desde agora; senão devolver, sem reter pagamento perdido.
7. Em uma transação, gravar confirmação, criar lote e lançamento de crédito, atualizar saldo e emitir protocolo. Notificação via outbox deduplicada; falha de e-mail não desfaz pagamento. E-mails da 087 são dependência a integrar ou substituir por adaptador já disponível, não presumir publicação.

**Arrependimento:** [CDC, art. 49](https://www.planalto.gov.br/ccivil_03/leis/l8078compilado.htm) prevê sete dias e devolução imediata; [Decreto 7.962/2013, art. 5](https://www.planalto.gov.br/ccivil_03/_ato2011-2014/2013/decreto/d7962.htm) exige meio eficaz, confirmação e comunicação ao intermediador. Propor garantia contratual de sete dias **por compra de pacote**, inclusive CNPJ, desde disponibilização, preservando marco legal mais favorável. É ampliação proposta; a L1 atual da assinatura trata primeira ativação.

Dentro dessa janela, sugerir **devolução integral inclusive se houve uso**, sem exigir renúncia por começar a geração. O custo usado vira perda da plataforma; nunca saldo negativo nem cobrança automática do consumo. Bloquear só saldo remanescente do lote e novas reservas desse lote, concluir ou resolver reservas já enviadas sem reabrir crédito. Não retirar artes já entregues. Abuso exige revisão, sem negar automaticamente direito legal. Fora da janela, sugerir devolução proporcional do não utilizado, ao cancelar pacote/assinatura; defeito e cobrança indevida tratados à parte. Valor máximo = pago menos devoluções confirmadas e comprometidas; arredondamento ao centavo, última devolução absorve resto.

Pedido de devolução pela mesma tela, com senha, resumo e protocolo; atendimento também deve aceitar solicitações quando login estiver inacessível. Registrar solicitação, congelar lotes e criar obrigação de devolução atomicamente. Estados `SOLICITADO → EM_CURSO → CONCLUIDO`, ou `SEM_CONFIRMACAO/REVISAO_MANUAL`. Timeout depois de POST não autoriza repetir estorno; reconsultar e encaminhar caso incerto. Pix/cartão automáticos somente com flag própria; boleto manual com comprovação, sem prometer endpoint incompatível. Arrependimento: acionamento imediato e alarme prioritário; ordinário: iniciar em até 5 dias úteis como L1, informando o prazo bancário. Flag desligada exige fila atendida, não supressão do direito.

Chargeback bloqueia remanescente daquele lote e abre disputa; parcela já usada vira exposição financeira em registro separado, nunca débito impossível na carteira. Evento favorável posterior só recompõe o remanescente devido se a disputa foi resolvida e não houve devolução final. Uma transição de estado genérica não pode recreditar todo o pedido.

## 5. Asaas, reconciliação e fiscal

Documentação oficial consultada em 22/10/2026; chamadas abaixo são **contrato planejado**, não foram executadas:

| Operação | Endpoint e referência |
|---|---|
| Criar avulsa | `POST /v3/payments`: customer, billingType, value, dueDate, description e externalReference; [criar cobrança](https://docs.asaas.com/reference/criar-nova-cobranca). Sem subscription/parcelamento no MVP. |
| Recuperar | `GET /v3/payments/{id}` (já usado no cliente local); `GET /v3/payments?externalReference=...`, paginado: [listar cobranças](https://docs.asaas.com/reference/listar-cobrancas). |
| Estornar | `POST /v3/payments/{id}/refund`, Pix/cartão: [estornar cobrança](https://docs.asaas.com/reference/estornar-cobranca). Taxas podem não retornar e saldo insuficiente pode impedir o processamento; reservar caixa da plataforma. |
| Eventos | [Eventos de cobrança](https://docs.asaas.com/docs/webhook-para-cobrancas): pagamento, estorno parcial/total/em andamento/negado e chargeback. Reconsulta e estado financeiro acumulado prevalecem sobre ordem de chegada. |
| Ensaio | Base `https://api-sandbox.asaas.com/v3`; [confirmar pagamento em sandbox](https://docs.asaas.com/reference/confirmar-pagamento): `POST /sandbox/payment/{id}/confirm`, exclusivamente simulado. |
| NFS-e | `POST /v3/invoices`: [agendar nota fiscal](https://docs.asaas.com/reference/agendar-nota-fiscal); agendamento não é autorização fiscal. |

`externalReference = km:<ambiente>:creditos:<pedidoUUID>`; sem nome/CPF/e-mail. É correlação, **não garantia de unicidade/idempotência do Asaas**. Estado local `CRIACAO_EM_CURSO` impede duas chamadas simultâneas. Timeout: `CRIACAO_INCERTA`, consulta paginada pela referência; 1 vínculo compatível recupera, mais de 1 gera incidente, 0 não prova ausência imediata. Não repetir POST automaticamente enquanto incerto; operador/reconciliador resolve após janela e evidências. Definir estratégia operacional para pagamento em cobrança duplicada: um crédito por pedido; excedente devolvido, jamais descartado.

Separar dispatcher por tipo de pedido; avulsa não pode entrar no sincronizador que ativa/renova assinatura. Reutilizar autenticação/inbox do webhook, identificadores e serviço de consulta; adicionar vínculo durável ao pedido. Guardar escopo de conta e ambiente para não casar IDs sandbox/produção. Resposta 200 apenas após inbox durável; `after` é otimização, não garantia de entrega.

Estender reconciliação diária com pedidos sem cobrança conhecida, pagos sem crédito, inbox pendente, saldo/ledger/lotes divergentes, reservas órfãs, pagamentos duplicados/tardios, estorno incerto/negado/parcial, disputa, expiração e NFS-e com falha. Paginar completamente, checkpoint e limite de trabalho; lista truncada gera erro, não “tudo reconciliado”. Usar mesmo serviço idempotente de webhook. Concessão mensal/expiração têm worker próprio idempotente, não dependem de evento Asaas mensal em plano anual.

**D-C4 proposta:** acrescentar tipos `PEDIDO_CREDITOS`, `DEVOLUCAO_CREDITOS`, `RESERVA_CREDITOS`, `DIVERGENCIA_CARTEIRA`, `DOCUMENTO_FISCAL` e códigos estáveis. Idade desde primeira divergência persistida, não resetar a cada cron. Preservar avisos no dia 0, 1, 3, 7 e múltiplos de 7 depois disso; fora da janela mostrar pendentes conhecidos. Erro de execução, ausência de idade, paginação incompleta, dinheiro pago sem crédito e arrependimento vencido devem alarmar imediatamente em toda conferência até resolução (extensão crítica explícita, sujeita à aprovação de Felipe). Preservar separação simulação/aplicação e o modo produção somente conferência do script existente; eventual worker de escrita de créditos em produção exige autorização própria. Conferência diária não substitui processamento rápido de pagamentos ou fila de arrependimento. Alerta operacional sem payload pessoal, responsável Felipe e substituto a definir.

**Contador:** decidir natureza do pacote pré-pago, momento de reconhecimento/emissão (venda ou utilização), código municipal/serviço, ISS e demais tributos, regime do CNPJ novo, descontos, expiração, documentos de devolução e retenção fiscal. Não emitir duas notas pela venda e pelo consumo. Se emissão ocorrer no uso, usar alocação de lotes para rastreio sem duplicar valor. NFS-e ligada a pedido/cobrança, status próprio e eventos `INVOICE_AUTHORIZED/INVOICE_ERROR`; falha fiscal não reaplica créditos. Disponibilidade e credenciais municipais precisam de ensaio específico; sandbox de pagamento não prova emissão municipal real.

## 6. Modelo de dados proposto — migration 090, se ainda livre

Reais BRL em centavos inteiros; consumo em unidades inteiras por recurso (Convites: geração; Wall-e: µUS$). Sem float monetário. Valores/tetos compatíveis com bigint no banco e serialização segura no TypeScript. Cada registro de negócio tem `empresa_id`; chaves compostas impedem apontar lote/pedido de outra empresa. Schema é proposta, não SQL pronto.

| Tabela | Conteúdo/invariantes | Exportação proposta |
|---|---|---|
| `ia_credito_carteiras` | UNIQUE(empresa_id,recurso); saldo contabilizado, reservado, bloqueado; CHECK todos >= 0 e reservado+bloqueado <= saldo; versão de migração. Projeção reconciliável. | Incluir saldo, recurso, datas; filtro direto empresa. |
| `ia_credito_lotes` | Origem FRANQUIA/COMPRA/CORTESIA/LEGADO, quantidade, preço pago alocado, vencimento, ciclo, pedido opcional; disponível/reservado/bloqueado e consumido. Oferta original imutável. | Incluir origem, quantidade, vencimento e valores; excluir motivos internos de risco. |
| `ia_credito_lancamentos` | Append-only: CREDITO, RESERVA, LIBERACAO, CONSUMO, BLOQUEIO, DESBLOQUEIO, EXPIRACAO, REVERSAO; vetores de variação do saldo/reserva/bloqueio, lote, operação e origem. UNIQUE(empresa,recurso,operacao,tipo,lote). Proibir UPDATE/DELETE/TRUNCATE pelo papel de runtime e trigger. Correção por compensação. | Incluir extrato e protocolo; excluir chaves internas de deduplicação e identificador pessoal do operador (usar papel/ator pseudônimo). |
| `ia_credito_reservas` | Operação única por empresa/recurso, máximo previsto, custo final, versão de pricing, datas originais, estado, identificador da geração/chamada; timeout não libera por si. | Incluir estado, quantidades e horários; excluir fingerprints/payloads internos. |
| `ia_credito_reserva_lotes` | Alocação reserva↔lote, FKs compostas com empresa, quantidades; trava consumo/estorno concorrente. | Incluir rastreio de quantidades, com filtro empresa. |
| `ia_credito_pedidos` | Oferta/termos imutáveis, quantidade, validade, preço, chave e hash idempotentes, protocolo UNIQUE, estado. UNIQUE(empresa,chave). | Incluir oferta, valor, situação e protocolo; excluir chave/hash interno e referência de autenticação. |
| `ia_credito_cobrancas` | Pedido, conta/ambiente/provedor/payment_id, referência externa, valor e estado; UNIQUE(conta,ambiente,payment_id); uma cobrança canônica por pedido, extras registrados para resolução. | Incluir pagamento e devolução legíveis; excluir metadados técnicos de conta e URLs com token. |
| `ia_credito_devolucoes` | Pedido/cobrança, protocolo, motivo tipado, cálculo imutável, quantidades canceladas, valor, estado no provedor, tentativas e resolução; soma não excede valor pago. | Incluir cálculo, valor, prazo e resultado; excluir controles operacionais. |
| `ia_credito_notificacoes` | Outbox, tipo, pedido/protocolo, dedupe, tentativas/próxima execução, sem corpo com PII. | FORA_DO_ESCOPO: controle de entrega; estado útil já no pedido. |

Catálogo versionado no código inicialmente (não criar tabela sem necessidade). Reutilizar `cobranca_eventos` como inbox; garantir classificação explícita de colunas eventualmente adicionadas. Se for necessária tabela fiscal própria, incluí-la na mesma revisão do inventário antes de criar; não deixar schema implícito.

Fonte de verdade = lançamentos mais lotes e estados de operação; saldo materializado é projeção atualizada na mesma transação. Consumo/reserva usam trava de carteira e lotes em ordem determinística, atualização condicional e CHECK. Constraints não substituem recomputação independente diária. Não armazenar prompts, imagens, nomes de crianças, telefone, documento ou payload completo do Asaas nesse domínio.

**Transição do legado:** não somar ilimitadamente carteira antiga e nova. Com vendas fechadas, reconciliar gerações pendentes, congelar momento de corte por empresa, bloquear novas gerações brevemente; fotografia do limite/usado do mês e concessões conhecidas. Criar lote LEGADO de `max(0,limite − usado)` com chave única por empresa/mês/corte, preservando reservas pendentes sem recrédito. Conferir duplicidade e contagens. Após corte, um único motor autoriza débito; `convite_carteiras/consumos` viram compatibilidade/relatório ou projeção, nunca segunda autoridade. Limites de festa e cliente continuam sendo barreiras independentes. Empresa sem linha continua sem direito até concessão explícita; não dar franquia retroativa sem decisão. Registrar conciliação exportável. Corte e recomposição exigem autorização de dados própria, não execução automática no deploy.

**Exportação:** incluir todas as tabelas acima em `lib/exportacao/entidades.ts`, atualizar `colunas-esperadas.json` e receita PG com novo modelo; conferir também integração 089. Alterar classificação de carteira antiga somente se necessário e com motivo; exclusão atual de controle interno não justifica ocultar extrato de compra. Provar filtro e FKs para duas empresas e teste negativo de tabela não classificada. Código com inventário compatível deve chegar antes da migration; ausência das tabelas precisa continuar suportada pelo exportador.

**Retenção proposta, sujeita ao jurídico/contador:** pedidos, extrato, devoluções e fiscal por prazo fiscal/prescricional aplicável (hipótese inicial 5 anos com marco a confirmar); reservas detalhadas e diagnóstico operacional 90 dias após resolução, preservando resumo financeiro auditável; outbox 30 dias depois de entrega, estatística agregada depois. Autorizações da 088 seguem política própria e não são copiadas para o ledger. Não prometer anonimato: IDs internos ainda podem ser dados pessoais pseudonimizados. Imutabilidade operacional não equivale a retenção eterna: expurgo/anonimização ao término exige processo privilegiado documentado, sem runtime poder apagar trilha; litígio retém somente necessário. Revisar Aviso, backups e exercício de direitos em conjunto.

## 7. Segurança, consumo e limites

Fluxo atômico: autenticar → validar tenant/papel/recurso/autorização → reservar saldo e orçamento → commit → fornecedor → persistir resultado → liquidar reserva. Usar geração/chamada como chave estável. Concorrência deve seguir uma ordem única de locks também em devolução, expiração e recuperação; revisar a ordem atual convite → carteira → orçamento → consumo antes de acrescentar tabelas.

Wall-e deve reservar máximo calculado de todas as chamadas previstas e respeitar limite de saída, entrada e passos; reavaliar antes de cada chamada adicional. Debitar uso apurado e liberar excesso. Sem pricing/usage confiável, manter reserva e parar futuras chamadas automáticas até resolução, sem inventar custo zero. Se custo real exceder máximo reservado, carteira nunca negativa: a plataforma absorve diferença, registra divergência e suspende configuração até corrigir estimador. Registrar custo real separado do débito comercial. Não habilitar modelos novos sem tarifa, limite e validação.

Limites iniciais **sugeridos**: 2 gerações simultâneas/empresa (1 por convite), 20 gerações/hora; 60 chamadas de Wall-e/hora/empresa, 5/minuto/contato e limite de passos por interação; 5 criações de pedido/hora/Gestão e 10/empresa, no máximo 3 pendentes. Limite inicial de compra R$ 1.000/dia/empresa, com revisão para ampliação. Usar janela persistente para múltiplas instâncias; não impor esses limites à recepção autenticada de webhooks válidos.

Teto operacional por empresa/recurso sugerido: Convites US$ 5/dia e US$ 30/mês; Wall-e US$ 2/dia e US$ 30/mês, sempre incluindo reservas em aberto. Tetos só mudam por operador autorizado e evidência de capacidade/margem; compra não os eleva. Preservar teto global Convites e adicionar teto global Wall-e; ausência de configuração válida fecha consumo pago. Não vender pacote que o cliente não consiga usar no prazo sob esses limites. Avisos ao atingir 80%/95%; no teto, parar somente a IA e oferecer fluxo sem IA/humano. Saldo não autoriza reativação jurídica do atendimento.

Auditoria com protocolo, tipo, recurso, quantidade, horário, resultado e identidade interna mínima; sem nomes, CPF, cartão, contatos, prompts ou fotos. URLs de fatura devem ser protegidas por autorização e não ir a logs. Validar payload/hash, origem da confirmação e escopo de conta; fraude ou chargeback não autoriza bloquear indistintamente outras empresas. Operador de cortesia usa permissão distinta de Gestão, motivo e auditoria; concessões grandes exigem aprovação humana adicional conforme política futura.

## 8. Interface e minutas legais

Reutilizar visual existente. Na área Assinatura, abas/sessões **Saldo**, **Comprar** e **Histórico** com recurso, franquia, extras, reservado, vencimentos e comprovante/protocolo. Editor mostra disponível para a festa, saldo empresarial e razão de bloqueio separadamente; botão de compra só Gestão. Operacional e cliente da festa podem ver limite pertinente, sem detalhes de faturamento. Baixo saldo: aviso em 20% e ao zerar, deduplicado por lote/ciclo, com alternativa gratuita; evitar mensagens de compra para responsáveis convidados. Wall-e indisponível não tem CTA de compra.

Textos propostos: “Cada geração concluída de arte ou convite completo usa 1 crédito. Uploads e downloads não gastam créditos.”; “Pagamento em confirmação. Os créditos serão liberados após confirmação do Asaas.”; “Há créditos reservados em uma geração em verificação.”; “Seu saldo continua disponível, mas o limite de segurança foi atingido. Tente após a renovação do limite ou fale com o suporte.” Não prometer liberação instantânea de boleto.

Revisar, **sem editar nesta entrega**, `pacote-revisao-juridica-astra-20261020/v2/01-TERMOS-DE-USO-2026-10-22-minuta.md:51` (L1) e `02-AVISO-DE-PRIVACIDADE-2026-10-22-minuta6.md:131` (retenção fiscal), além das seções de IA e prestadores.

Minuta de acréscimo aos Termos, condicionada à aprovação: “Os pacotes são compras avulsas para o recurso indicado, sem renovação automática. A oferta informa quantidade, unidade, preço e validade. A liberação depende da confirmação do pagamento. Créditos não substituem autorizações de uso de dados e imagens nem afastam limites de segurança. Na garantia de sete dias de cada pacote, inclusive para CNPJ, devolveremos integralmente o valor pago, mesmo com utilização. Depois, o saldo pago não utilizado poderá ser devolvido pelo valor proporcional original, conforme as condições informadas. Direitos legais por arrependimento, falha e cobrança indevida são preservados.” Acrescentar validade aprovada, marco inicial, prazo ordinário, distinção entre franquia/cortesia e saldo pago, e destino no encerramento L1. Evitar publicar essa promessa antes de operação suportá-la.

Minuta para Aviso: “Registramos pedidos, pagamentos, consumo de créditos e devoluções para executar o contrato, cumprir obrigações aplicáveis e prevenir fraude. O Asaas processa pagamentos. O registro financeiro de créditos não contém o conteúdo das conversas, fotos ou prompts; esses tratamentos são descritos nas seções dos respectivos recursos.” Especificar categorias, bases legais por finalidade, destinatários, retenção e direitos após revisão; consentimento de imagem da 088 permanece separado do aceite comercial. Não atribuir ao Asaas toda responsabilidade nem prometer retenção zero pela OpenAI. Manter marcadores de controle não implementado até evidência de publicação.

## 9. Flags, dependências e ordem de publicação futura

Flags **novas propostas**, server-side e false por padrão: `CREDITOS_CATALOGO_ATIVO`, `CREDITOS_COMPRA_ATIVA`, `CREDITOS_CONVITES_CONSUMO_ATIVO`, `CREDITOS_WALLE_CONSUMO_ATIVO`, `CREDITOS_ESTORNO_ATIVO`. Diferenciar disponibilidade de compra e processamento de obrigações já assumidas: desligar compra não desliga webhook, reconciliação, consulta de histórico ou devolução. Manter modo explícito do motor legado para empresas sem corte; não fazer fallback para saldo legado depois de saldo novo se esgotar.

| Estado | Comportamento esperado |
|---|---|
| Código novo sem schema 090 | Flags off, caminhos existentes funcionam; compra/novas rotas recusam com 503 tratado sem consultar tabela inexistente. Exportação permanece válida. |
| Schema novo, flags off | Sem ofertas ou novas cobranças; nenhum consumo/concessão inesperado. Schema aditivo tolerado. |
| Staging + sandbox | Host sandbox obrigatório, credenciais exclusivas, dados sintéticos, flags só após migration/corte autorizados; testar ambos os recursos com fornecedor de IA dublê. |
| Produção ainda sem CNPJ/conta | Código e schema podem ser publicados mediante autorização própria, mas flags de venda/consumo novo off; nenhum uso de conta sandbox em produção. |
| Produção pronta | Aprovação comercial/jurídica/fiscal, CNPJ e conta validados, configurações por nomes conferidas sem imprimir secrets, sandbox aprovado, piloto e limites explícitos. Wall-e continua off até gate jurídico independente. |

Sequência: (1) decidir oferta/jurídico; (2) implementar local, adaptar inventário e compatibilidade, integrar dependências 087/089 e código da 088; (3) revisão independente e testes; (4) autorização de publicação **do código com flags off**; (5) regenerar blocos da árvore implantada, CONFERIR → backup/PITR registrado → APLICAR autorizado → CONFERIR; (6) pós-conferência exportação; (7) corte de carteira e flags em staging com sandbox, autorizados; (8) homologar; (9) produzir pacote de promoção desligada; (10) abrir venda só com gates resolvidos. Este plano não autoriza nenhuma dessas escritas externas.

Aplicadores futuros `scripts/migration-090-{comum,staging,production}.cjs`, `scripts/bloco-shell-090.cjs`, migration/precheck/postcheck/rollback seguem 088 e 089. Referências: `scripts/bloco-shell-088.cjs:2` nesta base; `scripts/bloco-shell-089.cjs:2` no clone de devoluções. Conferir serviço, ambiente, host/banco permitido, TLS, permissões, hashes, backup e marcador anti-repetição; transação e lock_timeout; sem aplicação automática no startup. Bloco ASCII <=32 KB, guarda de serviço, subshell, sha256 dos arquivos implantados e código de saída. Ctrl-C pode impedir linha final: ausência significa parar e verificar, não repetir. Testar PTY real, incluindo falhas e interrupção.

Rollback preferencial: desligar venda/novos consumos, drenar operações e manter processador de pagamentos/devoluções. Depois do corte não voltar ao consumidor legado nem excluir ledger. Rollback de schema só se nenhuma operação/lote existir e com autorização própria; alteração aditiva deve permitir manter código compatível até correção. Nunca perder obrigação financeira em rollback.

## 10. Testes, esforço e critérios de aceite

Estimativa de engenharia para uma pessoa familiarizada com o projeto, sem prazo de contador/CNPJ/jurídico ou esperas de aprovação:

| Etapa | Esforço | Entrega verificável |
|---|---:|---|
| Decisões, medição e catálogo | 2–3 dias úteis | Custos por modalidade, simulação de margem, políticas aprovadas |
| Ledger, lotes, corte e exportação | 4–6 dias | Migration/aplicadores, invariantes PG e extrato por tenant |
| Asaas avulso, inbox e reconciliação | 4–6 dias | Idempotência e recuperação de resultados incertos |
| UI, senha, devolução e notificações | 3–5 dias | Fluxos completos desktop/mobile, protocolo e fila operacional |
| Consumo Convites | 2–3 dias | Integração preserva autorização 088, cotas e recuperação |
| Wall-e, após gates técnicos | 3–5 dias | Todas as chamadas medidas/reservadas, fallback sem IA |
| Regressão, sandbox, revisão e operação | 4–6 dias | Evidências e plano de promoção desligada |
| Total | **22–34 dias úteis** | Cerca de 5–7 semanas de engenharia; reservar contingência de 20% |

Wall-e pode ficar para etapa posterior; disponibilidade jurídica não bloqueia construção e ensaio sintético do domínio comum. Ensaiar sandbox antes do CNPJ novo, sem prometer que isso aprova conta de produção.

**Unitários:** aritmética inteira, margens, versões de oferta, virada de mês/ano e fuso, proporcionalidade, precedência de lotes, expiração, garantia por compra, limites de devolução e centavos; estados repetidos/fora de ordem; flags; desconhecimento de custo; pedido adulterado; senha/role/tenant; idempotência de outbox, concessão e consumo. Não testar só mock que repete a própria implementação.

**PostgreSQL descartável autorizado:** aplicar modelo com 087/088/089 conforme composição e 090, pre/postcheck e compatibilidade sem 090; duas conexões reais competem pelo último crédito, compra, concessão, expiração e devolução durante geração. Provar espera por locks e invariantes; não usar sleeps como prova. Mesmo evento em duas instâncias gera um crédito. Tenant B deve ter lotes, compras e reservas elegíveis durante testes de A, com fotografia íntegra antes/depois. Mutação de FK/filtro/unique deve falhar no teste correspondente. Testar crashes entre fases e recuperação após reinício. Exportação: completude, colunas, duas empresas, tabela sem classificação, saldo verificável; rollback recusa carteira com movimento.

**Playwright local:** Gestão compra três meios; outro papel não compra nem acessa pedido alheio; senha errada, duplo clique, refresh, aba concorrente, expiração de sessão, preço alterado e retorno falso; saldo só aparece depois da confirmação dublê; erro/timeout e retomada; reembolso integral com uso, proporcional, boleto manual e protocolo; 375px/desktop, teclado, foco e leitores; consentimento/foto por geração continua obrigatório; compra não desbloqueia Wall-e; flag off e schema ausente são tratados.

**Sandbox autorizado em staging:** clientes e contatos sintéticos; criar Pix/cartão/boleto e confirmar com mecanismos de teste oficiais; webhook real autenticado, evento repetido, perda/replay controlado, cartão recusado/análise de risco, cobrança vencida paga depois, estorno integral/parcial, saldo insuficiente e resultado incerto. Conferir fatura hospedada, contagens, valor, saldo, ledger, reconciliação e D-C4. Chargeback não disponível no sandbox deve ser simulado em dublê e marcado como limitação, jamais alegar prova real. NFS-e tem aceite separado do contador. Não enviar conversas/imagens reais à IA nesse ensaio.

Antes de aceitar código: unitários pertinentes, TypeScript, ESLint, build, suítes PG/E2E, PTY, ensaio sandbox e revisão independente; ler docs locais do Next.js 16 em `node_modules/next/dist/docs/` ao implementar rotas/after/cache. Nesta tarefa não há node_modules instalado nem código Next alterado, logo essa leitura técnica e os testes de implementação são futuros.

**Critérios de GO:** decisão escrita de oferta e jurídico; custos reais/margem compatíveis; nenhum saldo negativo/duplicado; nenhum cross-tenant; pagamentos e devoluções recuperáveis; exportação completa; operação consegue cumprir prazos; testes da matriz flags/schema aprovados. Produção off pode avançar sem CNPJ pronto, com autorização de deploy; venda on exige CNPJ/Asaas/fiscal e piloto próprios. Wall-e on exige aprovação jurídica própria, independentemente de saldo ou sucesso no sandbox.

## 11. Decisões pendentes e riscos

Felipe precisa decidir: unidades/franquias; preços e margem mínima; validade de 12 meses; garantia por pacote mesmo com uso; devolução ordinária de saldo; proporcionalidade no mês inicial; cortesias; tetos e venda de pacote grande; disponibilidade de emissão fiscal; quem atende fila e substitui Felipe; sequência de integração da 089/087; qual base atualizada será implementada. Aprovação deste documento não aprova automaticamente essas sugestões nem habilita integração externa.

Perguntas ao jurídico: aplicação do CDC a cada caso B2B sem reduzir garantia contratual; marco dos sete dias e devolução com consumo; validade e prorrogação por indisponibilidade; efeito acessório do cancelamento da assinatura; tratamento de fraude sem obstáculo ao arrependimento; retenção e prova do aceite; descrição de créditos de custo sem aparência de saldo financeiro; bases legais e transferência internacional; evidências contratuais/DPA da OpenAI e melhor interesse de crianças; suficiência da autorização 088 e da confirmação de foto/galeria. Conferir compatibilidade com L1 e Aviso minuta6 sem apagar pendências já registradas.

Riscos principais: custo xhigh maior que reserva atual; câmbio/tarifas/impostos; perda em garantia após uso e chargeback; duplicidade de cobrança por timeout; eventos tardios reabrindo crédito ou assinatura; duas autoridades de saldo no corte; indisponibilidade por expiração/teto sem texto claro; inventário da exportação desatualizado; migration com número ocupado; falta de responsável por reembolso imediato. Mitigações estão nas seções de preço, estados, corte, exportação, gates e operação. Nenhuma exige assumir que produção já está pronta.

## 12. Estado da entrega

Somente este plano é alteração do repositório. Validação documental: evidências de código, fontes públicas oficiais, revisão de referências e `git diff --check`. Nenhum teste de produto, PG, Playwright, sandbox, migration ou deploy executado. Registro correspondente no Obsidian e índice Roadmap; commit local com identidade noreply solicitada. Sem push ou PR. Próximo passo: decisões de Felipe e revisão jurídica/técnica do plano antes de autorizar implementação.
