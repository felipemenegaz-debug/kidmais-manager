# Contratos importados — cadastro e operação no Core

## Correção

A importação já criava fechamento, contrato, versão e Festa, mas aceitava cliente sem CPF, e-mail ou endereço. A revisão reconstruía o documento pelo serviço nativo e falhava antes de abrir a edição. O cancelamento de contratos assinados ficava apenas no link para Festa.

- A conferência da importação agora apresenta o cadastro contratual completo e o aniversariante. O servidor valida os campos antes de integrar.
- A confirmação atualiza o CRM pelo serviço nativo e monta o snapshot pelo mesmo `carregarSnapshot` do fechamento. O documento original, preço, itens históricos e prova da assinatura em papel permanecem preservados.
- Forma contratada pode ser informada; condições fora das opções atuais continuam descritas no documento original. A importação não aplica os descontos comerciais atuais sobre o valor já contratado. Parcelas e recebimentos continuam no financeiro nativo, sujeitos à conferência explícita.
- O hash da conferência inclui o cadastro lido para recusar sobrescrita de edição concorrente.
- Importados anteriores com cadastro parcial podem abrir uma revisão em elaboração. Completar CPF ausente, contato, endereço e aniversariante ocorre no editor. Gerar/revisar/assinar o novo documento continua exigindo os dados completos. CPF existente não pode ser substituído e CPF duplicado é recusado.
- Correção cadastral ou de buffet sem mudança de pacote, convidados, adicionais, data, horário ou condição comercial preserva os preços históricos. Mudança comercial segue o cálculo e a aprovação usuais.
- “Cancelar contrato” abre confirmação na tela do contrato e chama a operação existente da Festa, com motivo, capacidade `FESTA_CORRIGIR`, versão, revisão e chave de idempotência. Não concede permissões nem estorna recebimentos automaticamente.

## Dados existentes e publicação

Não há migration ou atualização em lote. A versão assinada e os recebimentos anteriores não são reescritos. Os dados ausentes são completados pelo operador na revisão; a nova versão segue a formalização normal.

Preparado para PR com base em `staging`. Merge/deploy desta alteração dependem de autorização específica conforme [OPERACAO_AGENTES.md](OPERACAO_AGENTES.md). Produção não foi alterada.

## Verificação

Testes locais com fixtures sintéticas e mocks cobrem cadastro incompleto, atualização concorrente, CPF ausente/duplicado, revisão de importação antiga, preservação de valores e cancelamento com confirmação e retry. `npm run check:v1:static` aprovado: 1.904 testes unitários, 103 testes do harness com mocks, lint (somente aviso preexistente em `catalogo.ts`), TypeScript, build e leitura de PDF no asset de produção.

Não foram executadas operações em banco real. Após deploy autorizado, homologar importação completa e revisão/cancelamento usando registros sintéticos de staging, com autorização para os writes do teste. Validar que o documento original e recebimentos permanecem consultáveis.

Felipe informou que continuará levantando outras correções; elas devem ser registradas e tratadas em alterações separadas.

## Ajuste após a homologação manual da PR #102 — pendente de publicação

Felipe encontrou o erro “Não existe tabela de preço vigente para a data selecionada” ao abrir a edição de V2. A proteção do preço histórico já existia na gravação, mas o GET do editor consultava o catálogo de adicionais fora do tratamento de erros de precificação. A ausência de tabela abortava a resposta antes de entregar os campos cadastrais.

- O GET entrega o cadastro mesmo sem catálogo disponível, com `catalogo: null` e o erro de precificação separado. Falhas inesperadas continuam interrompendo a leitura; a prova de tenant permanece obrigatória.
- O editor aceita catálogo ausente, mostra os adicionais históricos preservados e permite a correção cadastral sem alterar valores. Mudanças comerciais continuam exigindo preço válido no servidor e na interface.
- O controle de cancelamento foi colocado junto a “Alterações da contratação”, com atalho no cabeçalho. A exibição foi testada com V2 em elaboração, editor aberto e consulta de V1. Motivo, confirmação e autorização no servidor permanecem obrigatórios.
- Validação local: `npm run check:v1:static` aprovado, com 1.908 testes unitários e 103 testes do harness com mocks, lint (aviso preexistente de `FinalidadeSkill`), TypeScript, build e verificação do PDF.

Branch local: `codex/corrigir-editor-importados-sem-tabela-20261005`. Sem push, merge, deploy, migration ou operação em banco real. Staging permanece congelado para S11/E1–E6; este ajuste exige liberação e publicação coordenada antes de novo teste na interface de staging. O recorte enviado não mostra o cabeçalho e não comprova ausência de vínculo Festa no contrato real; esse cenário não foi consultado no banco.

## Ajuste — contratante na conferência (decisão de Felipe, 05/10/2026)

Na homologação em staging, Felipe pediu que o passo "Festa e agenda" fosse simplificado:

- **Telefone sai da tela.** Confundia com o WhatsApp. O campo continua no cadastro do cliente: o valor já gravado é
  preservado, segue contando como contato e segue na detecção de duplicidade e no contrato oficial (`whatsapp ?? telefone`).
- **E-mail e endereço passam a ser opcionais na conferência histórica.** Obrigatórios: nome, CPF válido e um contato
  (WhatsApp, ou telefone já cadastrado). O endereço, se informado, precisa estar completo (logradouro, número, bairro,
  cidade e UF; CEP opcional) — nada parcial vai para o contrato. Isso substitui a regra registrada acima ("cadastro
  contratual completo") **apenas para a importação**: o fechamento nativo continua exigindo e-mail e endereço
  (`camposFaltantesParaContrato`), e gerar/revisar/assinar um novo documento a partir de uma revisão também.
- Para isso, o snapshot nativo montado na confirmação (`carregarSnapshot`) recebe `exigirCadastroCompleto: false`
  só nessa chamada; o contratante gravado vem do cadastro conferido (`montarSnapshotVersao`), como já era.
- `ContratoSnapshotV1.contratante.email` e `.endereco` passam a admitir `null` (só em contrato histórico); os
  documentos mostram "Não informado" nesses casos, e o endereço sem CEP omite o CEP.
- Visual: o bloco usa as mesmas classes dos demais campos do assistente (tokens do Admin), com seções "Identificação e
  contato" e "Endereço (opcional)"; a lista nativa dos selects usa a cor do card, como nas outras telas.
- Revisão adversarial da mudança: o telefone fixo também **não vai no payload** da conferência (`decisoesDoForm`),
  para um valor desatualizado da tela nunca sobrescrever o CRM; o servidor valida o cadastro já mesclado com o CRM
  (`telefone` opcional no schema). A tela mostra a mensagem do schema por campo, marca o input (`aria-invalid`) e só
  rotula como "(opcional)" o que de fato é opcional naquele estado (com endereço informado, logradouro, número,
  bairro, cidade e UF deixam de ser opcionais). A suíte PostgreSQL da integração foi alinhada à semântica
  `endereco: null`, mas não foi executada nesta entrega; seu cenário cria cliente sem CPF e já era bloqueado pela
  regra de CPF do PR #102 — pendência registrada para a próxima rodada autorizada do cluster descartável.
- Cliente novo (rascunho "criar cliente"): a fonte da simulação passa a ter a mesma forma que o repositório grava
  (CPF e telefones só dígitos, e-mail minúsculo, nome sem espaços nas pontas). Antes, a simulação usava os valores
  formatados do PDF e a confirmação relia o cliente já criado, o hash do resumo divergia e a confirmação caía em
  "dados mudaram" sem saída. Teste: `lib/contratos/integracao-importados/rascunho.test.ts`.
