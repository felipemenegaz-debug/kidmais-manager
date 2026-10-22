# Plano: CPF e nova campanha Fundador

Data: 22/10/2026. Estado original: **proposta técnica, sem implementação ou homologação**.

> **Atualização 22/10/2026: implementação LOCAL** na branch `codex/implementar-cpf-fundador-20261022` (clone
> `kidmais-manager-cpf-fundador-20261022`, base staging conhecida `326895e`). Migrations **090** (campanha) e **091**
> (documento CPF/CNPJ), aplicadores, blocos, testes e telas, com a campanha desligada e sem data e o CPF desligado.
> Nada publicado nem aplicado fora do PostgreSQL descartável. **D1–D5 decididas por Felipe em 22/10/2026** (recomendações
> do §3.2/§3.4/§4.2/§4.3, com validade de 7 dias). A data de abertura continua indefinida; campanha e CPF desligados. Implementação real, divergências deste plano, validações e lacunas estão em
> [CPF_FUNDADOR_IMPLEMENTACAO_20261022.md](CPF_FUNDADOR_IMPLEMENTACAO_20261022.md). O texto abaixo é preservado como
> proposta.

Decisão comercial recebida de Felipe: 40% por 12 meses para todos que assinarem nos primeiros 30 dias da abertura comercial; depois, mais 20 vagas por ordem de contratação. Pilotos que assinarem dentro da janela têm a condição garantida. CPF deve ser aceito no teste, assinatura e Fundador.

## 1. Proveniência, escopo e limites

Clone novo `kidmais-manager-plano-cpf-fundador-20261022`, criado por clone **local**, com `--no-checkout --no-hardlinks -c core.autocrlf=false`, antes do checkout. Branch `codex/plano-cpf-fundador-20261022`, base `326895eaef59eb926e34397220df333cdf754b4e`, referência `origin/staging` disponível no clone `kidmais-manager-piloto-20261022`. Não houve fetch: é a staging conhecida localmente, não comprovação da ponta atual do GitHub. O origin deste novo clone aponta ao clone local.

Lidos AGENTS.md, CLAUDE.md e docs/OPERACAO_AGENTES.md do checkout. O escopo legado de IA citado no CLAUDE não altera este pedido explícito de planejamento. Apenas este documento será versionado. Sem código de produto, SQL executado, dependências instaladas, push, PR, Render, Asaas ou banco real. Documentação Next.js não necessária nesta análise de domínio; na implementação de rotas/telas, ler os guias pertinentes de `node_modules/next/dist/docs/`.

O piloto foi lido separadamente no commit local `3348f80`; não está incorporado nesta base. A v2 jurídica e o parecer foram lidos em `../pacote-revisao-juridica-astra-20261020/`. Estado de produção e seis vagas de staging são informações recebidas/históricas, sem consulta remota nesta tarefa.

## 2. Estado confirmado no código

Referências abaixo são relativas à raiz e à base acima; linhas do piloto são explicitamente separadas.

| Evidência | Comportamento e impacto |
|---|---|
| `lib/assinatura/planos-comerciais.ts:10` | 40%, 12 meses, 20 vagas; alterar somente a constante não resolve. |
| `lib/assinatura/ofertas.ts:75`, `:82`, `:89`, `:123`, `:147` | Consulta conta todas as reservas não liberadas; contratação serializa com advisory lock e usa `generate_series(1,20)`. Oferta é persistida antes de pagar. |
| `lib/assinatura/ofertas.ts:168`, `:183` | Pagamento compatível confirma a oferta e a reserva; flag de venda não desliga reconciliação de contratos. |
| `database/migrations/20261009_074a_planos_comerciais.sql:47`, `:48`, `:68`, `:70` | Documento restrito a CNPJ; vaga obrigatória 1–20, índices únicos por vaga e documento não liberados. |
| Mesma 074a, `:152`, `:156`, `:165`, `:218`, `:240` | Beneficiário deve corresponder a documento_teste; identidade imutável; benefício termina 12 meses após confirmação (cálculo UTC); documento da assinatura e cliente vinculado ao provedor são protegidos. |
| `database/migrations/20261009_075_renovacao_fundador.sql:31` | Renovação depende de contratação/Fundador confirmados e desconto 40%, não de número da vaga. Preservar as demais guardas e evidências imutáveis. |
| `lib/assinatura/servico.ts:13`, `:15`, `:24`, `:34` | iniciarTeste aceita formato CNPJ, grava documento_teste e trata duplicidade. Sozinho verifica formato, não dígitos verificadores. |
| `database/migrations/20261007_068_cobranca_assinatura.sql:34` | CHECK de documento_teste também restringe CNPJ. |
| `lib/cadastro/publico.ts:230`, `:249`, `:285`, `:310` | Cadastro exige CNPJ válido, trava por documento, consulta cadastro/assinatura/perfil e chama iniciarTeste. Linhas sugeridas no pedido eram de outra revisão. |
| `lib/desenvolvedor/empresas.ts:222`, `:235`, `:299` e `lib/acessos/validacao.ts:15`, `:29` | Provisionamento administrativo já normaliza CPF/CNPJ, valida ambos os DVs de CPF e recusa repetidos; documento é opcional no provisionamento. |
| **Piloto 3348f80**, `lib/desenvolvedor/comercial.ts:73`, `:83`, `:92` | Iniciar teste de contratante provisionada exige CNPJ e recusa CPF expressamente. Não tratar como funcionalidade já integrada. |
| `lib/assinatura/cobranca.ts:113`, `:237`; `lib/assinatura/asaas.ts:132`, `:326` | Seleção atual usa documento do teste ou CNPJ administrativo e nome empresarial; adaptador já envia `cpfCnpj` a `/customers`. Aceitação efetiva de PF precisa de ensaio posterior. |
| `lib/assinatura/devolucao-calculo.ts:2`, `:7`, `:27` | L1 contempla garantia, anual proporcional sobre valor efetivamente pago, sem multa nem recuperar desconto. |
| `scripts/assinatura-cron.cjs:19`, `scripts/assinatura-reconciliar.cjs:278` | Conferência diária e referência D-C4; não mudar sua semântica de alarme. |
| `lib/exportacao/pacote.ts:298`, `lib/exportacao/entidades.ts:272` | Tabelas novas sem classificação interrompem exportação; fundadores está classificada como controle interno. |
| `components/site/Planos.tsx:26`, `:27`, `components/site/Site.tsx:36` | Vitrine anuncia 20 vagas e cadastro CNPJ; há FAQ relacionada em `components/site/secoes.tsx`. |

Contexto complementar: [preços](PRECOS_20261020.md), [renovação](RENOVACAO_FUNDADOR_20261009.md), [homologação Fundador](HOMOLOGACAO_FUNDADOR_STAGING_20261010.md) e [cancelamento/devolução](CANCELAMENTO_DEVOLUCAO_20261021.md). São evidências datadas: não reescrever histórico como se a regra nova estivesse publicada. A homologação de 10/10 descreve reservas sem pagamento e liberação comprovada (`:9`, `:74`, `:88`); não comprova isoladamente o estado atual das seis vagas informado no pedido.

## 3. Entrega B primeiro: campanha em duas fases

### 3.1 Fonte de verdade e calendário

Propor tabela `assinatura_campanhas` com identificador/versionamento, estado (RASCUNHO, ATIVA, ENCERRADA), data local de abertura, timezone `America/Sao_Paulo`, início/fim exclusivo em timestamptz, limite posterior 20, percentual 40, duração 12, regra de elegibilidade e registro de autorização. Env serve apenas como chave operacional, nunca como relógio ou data histórica da campanha. Flag isolada não preserva autoria e pode divergir entre web e worker.

Recomendação a aprovar: 30 **dias de calendário**, começando à meia-noite local da data D, intervalo `[D 00:00, D+30 00:00)`. A data exibida como “até DD/MM” é D+29, com “23h59, horário de Brasília”. Se a abertura for no meio do dia, Felipe precisa escolher essa convenção ou 30 dias a partir do horário exato; não misturar as duas. Exemplo apenas: D=01/11 implica até 30/11 e fase posterior em 01/12. Sem data definida, não anunciar prazo nem iniciar janela automaticamente no deploy.

Usar relógio do banco lido **depois** de obter as travas; não usar horário do navegador nem timestamp de início da transação para operação que esperou lock. Converter usando zona IANA, não offset fixo espalhado. Depois da primeira contratação, datas e versão são imutáveis; extensão exige nova decisão auditada e tratamento explícito de ofertas existentes.

### 3.2 O que significa assinar — decisão bloqueadora

Recomendação comercial/técnica: **contratação iniciada com oferta aceita e persistida**, autenticada, com documento válido e condições confirmadas pelo servidor, assegura elegibilidade; pagamento confirma o benefício e inicia os 12 meses conforme regra atual. Simples visita, cadastro ou clique sem persistência não assegura nada. Isso se ajusta ao snapshot de oferta atual e reduz perda por atraso de webhook.

Requer aprovação de Felipe e revisão do texto pela Astra: definir prazo de pagamento/validade da reserva, tratamento de boleto e falha do provedor. Não inventar um prazo na implementação. Oferta da janela paga depois dela mantém sua origem e não consome as 20 posteriores, se ainda válida. Após expiração, só liberar com prova de ausência/cancelamento de cobranças, nos critérios existentes; timeout/404 não comprovam ausência. Pagamento tardio de oferta já liberada segue para reconciliação, sem reprecificação ou cobrança complementar silenciosa.

Alternativa: pagamento confirmado dentro da janela. Nesse caso armazenar instante confiável do evento do provedor e o instante de recepção, definir precisão/fuso e pagamentos iniciados antes/pagos depois; webhook atrasado de pagamento anterior ao corte deve preservar direito. A escolha afeta reserva, pagamento, comunicação e ordem das 20 vagas; não liberar B sem uma única regra aprovada. Não usar chegada do webhook como substituto silencioso da data do pagamento.

### 3.3 Modelagem de concessão e concorrência

Manter `assinatura_fundadores` e suas FKs/histórico. Adicionar campanha_id, origem `LEGADO`, `JANELA_30_DIAS` ou `POS_JANELA`, instante de elegibilidade, versão da regra e validade da reserva (quando definida). `vaga` passa a nullable: obrigatoriamente nula na janela; 1–20 na fase posterior. Legados preservam seus números antigos e não consomem o novo lote. Índice de vaga único parcial por campanha e vaga apenas para POS_JANELA não liberada. Manter unicidade de benefício por empresa/documento, inclusive contra legado, para não conceder 12 meses adicionais a quem já é Fundador.

Contagem pública posterior: `20 - reservas POS_JANELA não liberadas`, distinguindo confirmadas e em confirmação. Confirmadas continuam ocupadas mesmo após cancelamento/estorno, conforme regra atual; reciclar benefício confirmado exigiria outra decisão. Janela aceita mais de 20 concessões sem alocar vaga. Não calcular disponibilidade subtraindo todos os fundadores históricos.

Atualizar constraints e gatilho 074a por migration nova, nunca editar migration aplicada. Validar fase, data e vinculação no banco, para INSERT direto não contornar teto/janela. Padronizar ordem de locks de todos os caminhos: empresa → assinatura → lock da campanha → reserva → contratação; revisar renovação, liberação e triggers para não introduzir ordem inversa. Relê fase/ocupação sob lock antes de alocar, com índice único como última defesa. Sem chamadas externas dentro da seção de alocação. Persistir intenção/idempotência antes da rede e reconciliar resposta perdida.

Consulta é indicativa; checkout sempre recalcula e exige nova confirmação se condição mudou. Mesmo pedido repetido retorna mesma oferta; dois pedidos simultâneos não ocupam duas vagas. Virada da janela não deve alterar oferta já persistida. Snapshot financeiro, desconto, catálogo e duração ficam preservados.

### 3.4 Reservas antigas, renovação e pilotos

Backfill conservador: todas as reservas anteriores viram LEGADO; conservar estado, IDs, documento, timestamps, pagamentos e valores. Não reaplicar confirmação nem reiniciar benefício. Não liberar confirmadas ou apagar reservas para “zerar” campanha. Pendentes legadas conservam oferta aceita; cancelamento/liberação segue prova existente. Aprovar explicitamente o tratamento de pendentes anteriores à abertura.

075 permanece: preço regular é o snapshot contratado; aviso 30 dias antes, datas e idempotência existentes. Testar origem JANELA/POS/LEGADO atravessando renovação mensal/anual. Os 30 dias comerciais são independentes dos 30 dias de aviso. Não mudar incidentalmente o cálculo UTC dos 12 meses da 074a.

Pilotos: a janela universal basta para a garantia solicitada; não criar whitelist que exclua alguém ou prorrogue prazo sem decisão. O piloto precisa conseguir contratar: integrar/revalidar separadamente o 3348f80 para criar a assinatura de teste e documento; isenção permanente não serve e bloqueia Fundador. Inventariar pilotos elegíveis para acompanhamento operacional, sem usá-los como lista restritiva de desconto. Não iniciar testes ou comunicar pilotos nesta tarefa. Caso Felipe queira garantia após o prazo, será exceção comercial nova, auditada e separada do lote de 20.

### 3.5 Site, assinatura e staging

Durante a janela: “Fundador para quem assinar até DD/MM: 40% por 12 meses”, com significado de assinar e validade claramente explicados. Depois: “Restam N vagas”, ou “Vagas em confirmação”/“Encerrado”. Antes de abertura: não exibir data fictícia. Site e `/admin/assinatura` usam a mesma consulta resumida, sem IDs ou documentos, com cache curto/invalidação na virada; disponibilidade final no checkout. Manter preço regular, promocional, ciclo e renovação visíveis. Atualizar FAQ, barras, cartões, retomar oferta e mensagens de disputa de vaga.

Staging: os seis usos relatados devem ser inventariados por origem/estado em operação futura autorizada. Preservar como LEGADO, sem consumir o lote novo; não presumir seis confirmados ou seis livres. Antes/depois conferir seis registros, FKs, valores, estados, encerramentos e renovação. Nada de TRUNCATE, reinserção ou estorno para limpar teste. Se houver necessidade de reclassificar fixtures, preparar operação específica com IDs conferidos e autorização; preferir testar as 20 vagas em campanha sintética no PG descartável. Staging terá data de campanha própria, não copiada automaticamente para produção.

## 4. Entrega A: CPF em toda a jornada

### 4.1 Validação e pontos de exigência

Extrair/reutilizar validador de `lib/acessos/validacao.ts` como domínio compartilhado: CPF com 11 dígitos, ambos os DVs, rejeição de sequência repetida; preservar CNPJ numérico e alfanumérico com DVs e política de placeholder atual. Aceitar máscara conhecida, rejeitar caracteres estranhos, normalizar antes de comparar; não remover letras indiscriminadamente. DV válido não prova titularidade nem representação.

| Entrada | Regra proposta |
|---|---|
| Conta pública (usuário/e-mail) | Não antecipar CPF antes da etapa de contratante. |
| Cadastro público da contratante | Escolher PF/PJ; CPF + nome civil na PF, CNPJ + razão social na PJ; nome comercial separado. Exigir documento válido antes de iniciar teste. Adaptar sócios/qualificação/representação à PF, sem inventar sócios para pessoa física. |
| Provisionamento pelo painel | Manter rascunho administrativo sem documento; exigir ao iniciar teste/contratar. Não permitir bypass por rota administrativa. |
| iniciarTeste, público e piloto | Validação compartilhada completa no servidor; snapshot imutável e bloqueio de segundo teste. |
| Checkout | Exigir documento e titular/nome adequados, comprovar coerência com identidade de cobrança; exibir mascarado. Não permitir troca oportunista para obter oferta. |
| Reserva Fundador | Exigir identidade validada persistida; backend deriva tipo/documento, nunca aceita elegibilidade do cliente. |

Mapear também formulários de Perfil, revisões, exportação e PDFs que usam `perfil_empresas.cnpj`; não gravar CPF em campo que ainda prometa CNPJ sem compatibilidade explícita. Inventariar todos os leitores/escritores antes de fechar migration A. Rotas antigas que recebem `cnpj` podem ter adaptação temporária versionada, mas nome de campo legado não deve autorizar CPF sem validar o novo contrato.

### 4.2 Schema, unicidade e abuso

Adicionar tipo `CPF|CNPJ` ao documento de teste, cadastro fiscal e beneficiário; backfill CNPJ nas assinaturas/reservas antigas, inferir cadastro administrativo somente quando validado. Ausentes/inválidos ou divergências exigem relatório e resolução, nunca documento fictício. Alterar CHECK 068 e 074a e guardas relacionadas; manter documento_teste e identidade histórica imutáveis. Tipo explícito facilita auditoria e evita inferência em cada consumidor, embora o comprimento já distinga os formatos atuais.

Unicidade de documento normalizado continua em banco, não só SELECT; revisar lock `kidmais:cnpj:` do cadastro para namespace fiscal compartilhado por todos os pontos de entrada. Chaves por tipo/documento e índices parciais devem preservar restrições existentes, sem permitir duplicidade CPF/CNPJ do mesmo texto normalizado. Cadastro/assinatura/perfil precisam de uma verificação coerente; corrida painel versus cadastro público deve terminar em um único tenant ou pedido de acesso, sem revelar dados do outro.

**Limite explícito:** documento válido não permite descobrir que um CPF controla determinado CNPJ. Recomendar vínculo declarado e verificado em atendimento para continuidade/benefício, com evidência mínima e decisão auditada. Não criar integração societária, coletar CPF de todos os sócios ou bloquear automaticamente por nome, telefone, IP ou e-mail. São no máximo sinais para revisão, com privacidade e falsos positivos avaliados.

Proposta anti-abuso a decidir: um teste e um benefício por operação econômica beneficiária, preservados na transformação CPF→CNPJ; empresas independentes de um mesmo sócio não são automaticamente fraude. Definir com Felipe se a unidade comercial é pessoa, estabelecimento ou grupo. A regra precisa ser comunicável e revisável. Para impedir reuso entre identidades **conhecidas**, propor registro de vínculo entre documentos e identidade beneficiária estável, com unicidade e histórico de concessões. Vínculo desconhecido permanece risco residual declarado, não promessa de bloqueio completo.

Se adotado, registro de vínculos terá acesso restrito, finalidade/retenção aprovadas, sem documento em logs. Fingerprint determinístico com chave protegida pode reduzir exposição em índices auxiliares; hash simples de CPF é enumerável e não anonimiza. Não acrescentar coleta sensível apenas para uma promoção.

### 4.3 CPF que passa a CNPJ

Fluxo assistido separado: confirmar titularidade/continuidade e eventual cessão contratual; manter empresa, benefício, data final, preço e histórico, sem novo teste ou 12 meses adicionais e sem consumir outra vaga. Documento_teste e documento_beneficiario permanecem snapshots históricos; identidade fiscal vigente tem versão própria e vínculo aos dois documentos para impedir reuso conhecido.

Não implementar como UPDATE direto: a 074a protege também cliente do provedor. Revisar se Asaas permite atualizar cpfCnpj no cliente existente e consequências fiscais, ou se exige cliente/assinatura nova; preparar transição idempotente sem duas cobranças, com aprovação e prova de encerramento/reconciliação. Bloquear autoatendimento dessa troca até existir fluxo validado. Se for outra pessoa jurídica sem continuidade comprovada, não transferir benefício automaticamente; submeter a decisão contratual. Casos de encerramento/estorno não reiniciam a garantia comercial ou o relógio do benefício.

### 4.4 Asaas, nota fiscal e telas

Adaptador já possui cpfCnpj; mudar seleção de dados em cobranca.ts para PF (nome civil, CPF) ou PJ (razão social, CNPJ), sem nome fantasia como titular fiscal. Testar idempotência por empresa, recuperação de cliente existente, conflito de documento, cobrança mensal/anual, webhook e estorno com mocks e depois sandbox autorizado.

O suporte efetivo a PF, alteração cadastral e emissão fiscal deve ser confirmado na documentação vigente e em sandbox na etapa de implementação. Esta tarefa não acessou Asaas nem fontes externas. Cobrança aceita não comprova NFS-e emitível. Perguntas ao contador: emissor legal e município competente; código do serviço, tributação/retenções, campos obrigatórios do tomador PF (inclusive endereço), momento de emissão, cancelamento/substituição da nota e devolução proporcional; diferença entre documento do contratante e do pagador. Não definir regime fiscal no plano nem coletar endereço sem necessidade confirmada.

Telas: seletor PF/PJ, rótulo e máscara corretos, nome civil/razão social, nome do buffet separado; mensagens de erro acessíveis, confirmação mascarada, revisão do Perfil e orientações de atendimento. Não substituir globalmente “CNPJ”: o CNPJ do fornecedor no rodapé continua necessário e não é o documento do cliente. Atualizar também o piloto local e os textos de acesso por documento já cadastrado.

## 5. Revisão jurídica a solicitar à Astra

Esta seção é **pauta de revisão**, não conclusão jurídica ou redação aprovada. Adotar no planejamento a premissa solicitada de proteção integral do consumidor PF; pedir à revisão competente a aplicação concreta e os requisitos. Base local: `10-PARECER-ASTRA-20261021.md` (L1, L4, L6) e v2 de 22/10 (Termos, Aviso minuta6, Acordo). Não foi feita pesquisa jurídica externa; não declarar conformidade legal validada.

1. Como qualificar o buffet PF e o próprio titular contratante nos Termos, sem exigir representação societária inexistente? Quais limites de capacidade/representação precisam ser verificados?
2. Quais informações prévias, resumo contratual, confirmação do aceite e comprovante devem acompanhar a contratação eletrônica PF? Como apresentar ciclo, renovação, desconto, prazo e preço regular sem ambiguidade?
3. Como assegurar arrependimento pela mesma ferramenta, protocolo e comunicação imediata ao intermediador? A garantia comercial de sete dias já implementada deve permanecer distinguida do direito legal, seus marcos e hipóteses?
4. A L1/089 e suas telas cobrem integralmente o procedimento necessário, inclusive falha de estorno e atendimento fora do horário? Não assumir que cálculo correto satisfaz prazo jurídico. Revisar cancelamento, arrependimento e anual proporcional sem recuperar desconto Fundador.
5. É adequada a definição proposta de “assinar”, validade da reserva, expiração, boleto e webhook atrasado? Qual tratamento das ofertas anteriores e das promessas feitas aos pilotos? Aprovar a comunicação antes de abrir campanha.
6. Quais bases, finalidades e retenções usar para CPF, dados da própria parte contratante, vínculos societários declarados e prevenção de abuso? Como atender acesso/correção/exclusão sem apagar obrigações/histórico necessários? Não presumir consentimento genérico como solução.
7. Que verificação mínima e contestação seriam proporcionais para vincular CPF e CNPJ? Pode-se limitar benefício por pessoa/operação? Como evitar discriminação e exposição de vínculos entre tenants?
8. Como formalizar continuidade/cessão CPF→CNPJ, responsabilidade e aceites, preservando direitos e cobranças anteriores? Quando pedir novo aceite e qual evidência conservar?
9. Ajustar v2: Termos de PF/PJ, Aviso (cadastro e compartilhamento com Asaas hoje citam CNPJ/razão social), Acordo (contratante PF pode continuar controladora de dados dos clientes). A titularidade dos próprios dados não elimina os papéis relativos aos dados de festas/crianças.
10. Quais pendências do parecer e placeholders impedem publicação definitiva? Reconciliar texto com L1 e exportação agora presentes nesta base: a v2 ainda contém avisos de controles não implementados, e precisa de conferência funcional, não remoção automática dos colchetes. Versionar conteúdo/hash e registrar aceite na jornada pública e no piloto provisionado, que não deve ganhar aceite presumido pelo administrador.

Enviar à Astra em etapa posterior autorizada; nenhum envio realizado. Validação fiscal cabe ao contador e revisão jurídica profissional permanece distinta do parecer orientativo.

## 6. Compatibilidade e operação

- **Cancelamento/devolução:** manter 089 e L1, valor efetivamente pago, sem cobrar desconto de volta. Novo campo de origem não muda cálculo nem cria reembolso automático; preservar guarda contra reativação após encerramento, idempotência e evidências.
- **D-C4:** estender conferência para campanha/origem incompatível, duplicidade e reserva expirada que exige revisão; não classificar todos os pendentes como erro nem corrigir dados na conferência. Manter alertas de devolução/renovação não removida, deduplicação diária e isenção da Kidmais. Nunca usar total >20 como alarme quando houver concessões da janela.
- **Exportação:** classificar cada tabela nova ANTES de aplicar migration. Configuração global de campanha como interna ou catálogo explicitamente permitido; concessões e vínculos com tratamento específico de privacidade/tenant, sem exportar documentos de outra empresa. Atualizar `entidades.ts`, inventário de colunas e testes de tabela desconhecida; não afrouxar guarda.
- **Relatórios:** separar legado, janela e pós-janela, reservas/confirmadas/liberadas, datas de corte e benefícios em renovação; contagem histórica nunca é disponibilidade. Não exibir CPF completo em métricas, relatórios gerenciais públicos, logs ou observabilidade.
- **Rollback:** antes de concessões novas, rollback estrutural só com precheck de ausência de dados incompatíveis. Depois de >20 concessões ou CPFs, código antigo não é rollback seguro; desligar novas adesões, manter leitura/reconciliação compatíveis e corrigir para frente. Não apagar benefícios para reverter schema.

## 7. Migrations e aplicadores propostos

Inventário local em 22/10: base contém 088 (autorização IA) e 089 (encerramentos); 087 fica reservada a e-mails de cobrança conforme pedido. Busca de nomes nas migrations/checks/rollback e aplicadores do workspace não encontrou 090–092. Isso não examina toda branch não materializada nem o servidor; **não é reserva global**. Propor próximo número **090 para B**, **091 para A**. Repetir conferência de colisões em refs/branches, clones e checks imediatamente antes da implementação/congelamento e antes de aplicar, com acesso remoto apenas quando autorizado.

| Pacote | Artefatos futuros, ainda não criados | Conteúdo |
|---|---|---|
| B / 090 | `database/migrations/20261022_090_campanha_fundador.sql`, checks 090 pre/post, rollback 090 | Campanha, origem, vaga nullable condicionada, índices/triggers, backfill LEGADO e proteção da janela/lote. Não semear data de abertura por suposição. |
| A / 091 | `database/migrations/20261022_091_documento_fiscal_assinatura.sql`, checks 091 pre/post, rollback 091 | Tipos e checks PF/PJ, identidade fiscal vigente/snapshots e vínculos se aprovados, compatibilidade de perfil após inventário dos consumidores. |
| Ambos | `scripts/migration-090-comum.cjs`, `-staging.cjs`, `-production.cjs`, `scripts/bloco-shell-090.cjs` e equivalentes 091, testes | Mesmo contrato operacional dos 088/089, com hashes próprios. Datas dos arquivos deverão refletir a implementação real. |

Prechecks: dependências 068/074a/075/089, privilégios, estrutura ausente/completa/parcial, documentos inválidos/duplicados, reservas/ofertas incompatíveis, provas agregadas de preservação. Postchecks: constraints/índices/guardas, backfill integral, zero mudança de valores/datas/FKs antigas, classificação exportável, lote posterior vazio no início e teto de 20. Recusar estado parcial, não “consertar” silenciosamente. SQL transacional com timeout, locks e preservação; histórico sem delete/truncate.

Padrão observado em `scripts/migration-089-comum.cjs` e `scripts/bloco-shell-089.cjs:3`: **código primeiro, migration depois**. Implementação futura deve suportar schema antigo: nova função indisponível sem schema completo, mantendo contratos existentes. Publicar código contendo SQL/aplicadores e exportação preparada com nova campanha/CPF desligados; depois autorização específica para conferir/aplicar migration; postcheck e smoke; só então configurar/ativar campanha ou CPF. A ordem não autoriza executar nenhuma etapa nesta tarefa.

Aplicadores: modo conferência READ ONLY, identidade do alvo/papel, hashes LF dos SQL, recusa de parcial, backup identificado para aplicar, marcador persistente contra repetição, saídas sanitizadas e códigos de retorno verificáveis. Blocos ASCII ≤32 KB, hashes da árvore implantada, guarda do serviço antes de arquivos, corpo em subshell, sem gravar/transportar SQL, preservação do shell do operador e `CODIGO_SAIDA_BLOCO`. Preservar aviso do `bind` fora da guarda e testes de colagem interativa/PTTY, falha de ferramenta/hash/backup/destino e trap sem mascarar saída. Consultar também 088, sem copiar hashes ou números dela.

## 8. Plano de validação, ordem e esforço

Nenhuma suíte de produto ou banco foi executada para este documento. Para implementações futuras, ambiente sintético isolado, sem carregar `.env.local`; execução em PG descartável/sandbox exige autorização e identificação do alvo conforme política.

| Camada | Casos e critério de aceite |
|---|---|
| Unitários | CPF com zeros iniciais, DVs inválidos/repetidos, máscaras/caracteres inválidos, CNPJ numérico/alfanumérico; mesmo normalizador em todos os caminhos. Calendário no início, último instante e fim exclusivo; mês/ano/bissexto; data ausente; preço e snapshot preservados. |
| PostgreSQL descartável | Migrar schema antigo com reservas legadas e seis fixtures, reaplicação/estado parcial/rollback recusado com dados novos; 21+ fundadores dentro da janela; após corte exatamente 20 reservas e 21ª sem desconto com confirmação explícita; concorrência real em duas conexões, espera observada e retomada sem duplicar. Inserções diretas devem obedecer constraints/triggers. |
| Corridas e pagamentos | Cadastro público versus painel para mesmo CPF; oferta repetida; liberação versus nova reserva; espera de lock atravessando corte; pagamento/webhook antes/depois e fora de ordem, evento duplicado, timeout e recuperação, 404 sem liberação indevida; timestamp aceito conforme decisão comercial. |
| Regressão comercial | Mensal/anual, três planos, legado/novas fases, renovação após 12 meses com aviso 30 dias, isenção Kidmais, piloto sem assinatura, CPF→CNPJ sem benefício/garantia/vaga duplicados; anual proporcional e arrependimento sem recuperar desconto; D-C4 sem alarmes falsos e com anomalias reais. |
| Exportação/segurança | Tabela desconhecida continua bloqueando; tabelas novas classificadas; CPF mascarado; isolamento de dois tenants e vínculos compartilhados; RBAC/CSRF/aceite/idempotência, logs sem documento e secrets. |
| Playwright local | Jornada pública PF/PJ, provisionamento + teste, ofertas e checkout mock, retomar e corte de campanha, prazo/vagas esgotadas, cancelamento/arrependimento/protocolo, mobile e acessibilidade dos campos/mensagens. Screenshots sanitizados. |
| Sandbox autorizado | Criar cliente PF sintético aceito pelo provedor, mensal/anual, pagamento confirmado, webhook atrasado, devolução/renovação, retomada após falha. Não confundir sandbox com Asaas real; plano separado de fixtures/limpeza e provas. NFS-e requer ensaio fiscal definido pelo contador. |
| Qualidade e operação | Unitários/PG/Playwright pertinentes, typecheck, ESLint, build, testes de aplicadores/blocos e diffs; validar Next local antes das alterações de UI. Revisão independente e gates operacionais antes de publicação. |

Ordem sugerida: (1) decisões de data/assinar/reserva e revisão das promessas; (2) B isolada, com preservação dos contratos existentes; (3) integração/revalidação do piloto em entrega própria; (4) A e identidade/Perfil/Asaas; (5) textos/aceites e homologação conjunta. B pode ser entregue sem A, mas se a abertura prometer CPF desde o primeiro dia, A e revisão jurídica/fiscal tornam-se gates da abertura. Não iniciar janela enquanto público prometido não puder contratar.

Estimativa de engenharia, não prazo garantido: decisões/inventário 1–2 dias; B com migration, UI, testes e aplicador 4–6 dias; integração piloto 0,5–1 dia; A básica CPF/PJ ponta a ponta 5–8 dias; continuidade fiscal e vínculos anti-abuso assistidos 3–5 dias adicionais; revisão/regressão conjunta 2–3 dias. Total aproximado 15,5–25 dias úteis de uma pessoa, dependendo de reaproveitamento e decisões; contador, jurídico, homologação externa e espera de autorização fora da estimativa. Vínculo societário automático não está incluído.

## 9. Decisões pendentes e riscos para Felipe

1. Data real de abertura e contagem por dias de calendário ou horário exato; quem autoriza/registre a ativação.
2. “Assinar” por oferta aceita ou pagamento, validade da reserva e pagamentos que atravessam o corte. Esta é a maior dependência de B.
3. Aprovar preservação LEGADO sem consumo das novas 20, inclusive reservas ainda pendentes; confirmar política de vagas confirmadas não recicláveis.
4. Aprovar janela universal suficiente para pilotos e integrar operação do piloto; eventual extensão individual é nova regra.
5. Definir unidade do benefício/teste e revisão de CPF que tem CNPJ ou é sócio: falso positivo pode excluir buffet legítimo; documento sozinho não resolve identidade econômica.
6. Aprovar fluxo assistido CPF→CNPJ, provas mínimas e responsabilidade contratual; não vender promessa de migração automática antes do ensaio no provedor.
7. Contador e Astra: campos PF, fiscal, direitos/aceites e versão dos textos. Placeholders e parecer orientativo não equivalem a aprovação final.
8. Revalidar ponta de staging, integração do piloto e colisões 090/091 quando autorizado. Este plano não confirma estado remoto.

Riscos principais: datas divergentes entre web/worker, estoque contado com legado/janela, descontos presos indefinidamente em ofertas, retry duplicando cliente/vaga, corrida de documentos, tentativa de alterar snapshots protegidos, exportação quebrada por tabela nova, CPF exposto e rollback para código incompatível. As medidas e testes acima tratam esses riscos; publicação depende de decisões e evidências futuras.

## 10. Validação desta entrega documental

Leitura local do código, SQL, aplicadores, documentos comerciais e pacote jurídico; conferência dos caminhos e referências; inventário local de números; revisão de conteúdo e `git diff --check`. Sem alegação de testes de produto, PG, Playwright ou sandbox aprovados. Commit solicitado usa `Felipe Menegaz <324788905+felipemenegaz-debug@users.noreply.github.com>`. Obsidian atualizado separadamente com estado de proposta, decisões, validação e próximos passos.

## 11. Implementação local de 22/10/2026 (resumo da PRIMEIRA rodada, superado em parte pelo §12 e pela revisão)

Detalhes em [CPF_FUNDADOR_IMPLEMENTACAO_20261022.md](CPF_FUNDADOR_IMPLEMENTACAO_20261022.md).

**Divergências em relação a este plano:**
- O tipo de documento não ganhou coluna: ele é derivado do formato normalizado, garantido por CHECK.
- [1ª rodada] O DV ficava como CHECK `NOT VALID`. A revisão mostrou que isso valeria em todo UPDATE de linha antiga; foi trocado por um gatilho só no INSERT.
- A janela aceita os dois modos de contagem (D2 pendente). A elegibilidade aceita os dois valores no dado, mas só
  `OFERTA_PERSISTIDA` tem implementação; com o outro valor, a contratação fica indisponível.
- A validade da oferta é registrada, mas não tem efeito automático (D3).
- Com a campanha ativada e a chave operacional desligada, a contratação fica indisponível, em vez de vender sem a
  condição prometida.
- Antes da ativação vale a regra anterior (`LEGADO`).

**Não implementado:**
- continuidade CPF → CNPJ (bloqueada);
- Perfil da empresa para pessoa física;
- textos legais;
- ensaio no sandbox.

## 12. Decisões de 22/10/2026 (segunda rodada)

Felipe decidiu:
- **D1:** oferta aceita e persistida pelo servidor.
- **D2:** 30 dias de calendário em America/Sao_Paulo.
- **D3:** validade de 7 dias corridos; paga depois do corte e dentro da validade mantém JANELA; vencida só libera com
  prova; pagamento tardio vai para reconciliação, sem cobrança complementar; o prazo é informado.
- **D4:** legado preservado, inclusive pendentes; confirmadas não são recicladas.
- **D5:** benefício por empresa e documento; vínculo CPF↔CNPJ declarado e conferido no atendimento; sócio não bloqueia;
  continuidade bloqueada no autoatendimento.
- **Data:** não definida.

Conferência item a item e provas: [CPF_FUNDADOR_IMPLEMENTACAO_20261022.md](CPF_FUNDADOR_IMPLEMENTACAO_20261022.md), §2.

O impedimento técnico do Perfil para PF foi corrigido. A identificação do PF nos documentos continua com a Astra.

## 13. Revisão independente e correções (22/10/2026)

O resultado foi REPROVADO: um bloqueante (DV da 091 por CHECK `NOT VALID`) e vários P2 (D3, preservação dos aplicadores,
prazo junto do link, docs). Todos foram corrigidos e testados localmente. Os P3 ficam registrados.

Detalhes: [CPF_FUNDADOR_IMPLEMENTACAO_20261022.md](CPF_FUNDADOR_IMPLEMENTACAO_20261022.md), "Terceira rodada".
