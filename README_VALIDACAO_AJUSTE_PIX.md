# Ajuste comercial PIX — implementação e validação final

Data: 09/09/2026. Pasta fonte: `D:\glass\KidMais Manager\kidmais-manager`. Banco físico: `kidmais_manager`, PostgreSQL 18.6, porta 5432.

**Resultado:** ajuste concluído no escopo local, aguardando aprovação do usuário. A Migration 012, autorizada explicitamente, foi aplicada uma única vez. Na retomada houve somente inspeção, acabamento e testes; nenhuma outra migration ou alteração estrutural. Festa não foi iniciada.

## Causa original

`components/fechamento/calculos.ts` aplicava desconto apenas ao PIX à vista. PIX parcelado retornava zero, e a tela exibia “Sem desconto automático”. O cálculo do snapshot contratual usava somente `valorAprovado ?? valorTabela`, sem o desconto da forma de pagamento, inclusive o desconto de 10% mostrado na interface.

O Fechamento persistia apenas a forma pretendida, sem condição estruturada de parcelamento. A aprovação existente registrava negociação de valor; o CHECK de AGUARDANDO_APROVACAO exigia valor_negociado. Assim, uma revisão apenas de parcelamento, mantendo o preço de tabela, não tinha representação adequada. A ampliação comercial e, depois, a migration foram autorizadas separadamente.

## Migration 012: estrutura física antes e depois

Arquivo: `database/migrations/20260909_012_condicao_pagamento.sql`. Não foi reaplicado durante a validação final.

| Objeto | Antes | Depois confirmado no catálogo físico |
|---|---|---|
| `fechamentos.condicao_pagamento` | Inexistente | JSONB, permite NULL, sem DEFAULT |
| `aprovacoes_negociacao.condicao_pagamento` | Inexistente | JSONB, permite NULL, sem DEFAULT |
| `fechamentos_condicao_pagamento_check` | Inexistente | NULL ou objeto com schemaVersao numérico 1, forma igual à coluna forma_pagamento_pretendida e revisaoStatus em PENDENTE/APROVADA/DISPENSADA/RECUSADA; COALESCE rejeita dados obrigatórios ausentes |
| `aprovacoes_condicao_pagamento_check` | Inexistente | NULL ou objeto com schemaVersao numérico 1; COALESCE rejeita versão ausente |
| `fechamentos_status_negociacao_check` | AGUARDANDO_APROVACAO exigia valor_negociado não nulo | Mantém a condição original e admite também documento de PIX_PARCELADO com revisão PENDENTE |

Os três CHECKs estão com `convalidated = true`. `fechamentos_aprovado_exige_negociacao_check` e `aprovacoes_negociacao_decisao_valor_check` continuam presentes e validados, com suas regras anteriores. Não foram alterados índices, triggers, tabelas de preços ou objetos de Pagamentos. A migration inclui comentários nas duas colunas, transação e lock_timeout de cinco segundos.

As colunas não têm valor padrão, preenchimento automático ou UPDATE de dados. Na reinspeção: **oito Fechamentos e dois registros de aprovação, todos com condicao_pagamento NULL**. Nenhum documento foi inventado para registros antigos. Os documentos novos dos testes foram revertidos.

A aplicação original comparou contagens e hashes dos dados anteriores, desconsiderando apenas a coluna recém-adicionada, e confirmou igualdade. As suítes desta validação voltaram a verificar fingerprints antes/depois e rollback. Essa evidência cobre as operações executadas nesta sessão; não depende de um diff Git, pois a pasta não possui repositório Git acessível.

## Rollback da Migration 012

O rollback não foi executado. Erro antes do COMMIT original teria revertido o DDL integralmente.

Antes de existirem documentos novos, é possível retornar o código à versão anterior, restaurar o CHECK original e remover somente os dois CHECKs novos e as duas colunas. O roteiro abaixo é documental e exige autorização específica antes de execução:

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM fechamentos WHERE condicao_pagamento IS NOT NULL)
     OR EXISTS (SELECT 1 FROM aprovacoes_negociacao WHERE condicao_pagamento IS NOT NULL)
  THEN
    RAISE EXCEPTION 'Há dados comerciais novos: rollback exige preservação e tratamento explícito';
  END IF;
END $$;
ALTER TABLE fechamentos DROP CONSTRAINT fechamentos_status_negociacao_check;
ALTER TABLE fechamentos ADD CONSTRAINT fechamentos_status_negociacao_check
  CHECK (status <> 'AGUARDANDO_APROVACAO' OR valor_negociado IS NOT NULL);
ALTER TABLE fechamentos DROP CONSTRAINT fechamentos_condicao_pagamento_check;
ALTER TABLE aprovacoes_negociacao DROP CONSTRAINT aprovacoes_condicao_pagamento_check;
ALTER TABLE fechamentos DROP COLUMN condicao_pagamento;
ALTER TABLE aprovacoes_negociacao DROP COLUMN condicao_pagamento;
COMMIT;
```

Depois de haver propostas/aprovações novas, não executar DROP: perderia dados comerciais e o CHECK antigo pode rejeitar pendências de condição sem negociação de preço. Nesse cenário, preferir correção adiante ou elaborar rollback com preservação dos documentos e tratamento autorizado dos estados. Nunca apagar ou reescrever snapshots contratuais para viabilizar rollback.

## Regra de cálculo

Primeiro resolve-se a base comercial válida: **valorAprovado, quando presente, senão valorTabela**. Valor negociado ainda não aprovado não se torna valor contratual. Sobre essa base, aplica-se a regra da forma escolhida:

| Forma | Base | Desconto | Valor do desconto | Final contratual |
|---|---:|---:|---:|---:|
| PIX à vista | R$ 9.290,00 | 10% | R$ 929,00 | **R$ 8.361,00** |
| PIX parcelado | R$ 9.290,00 | 3% | R$ 278,70 | **R$ 9.011,30** |
| Cartão | R$ 9.290,00 | 0% | R$ 0,00 | **R$ 9.290,00** |

A base é convertida para centavos após validação estrita. O total é `floor((baseCentavos * (100 - percentual) + 50) / 100)`, com arredondamento comercial ao centavo. O desconto monetário é a diferença entre base e total, preservando a igualdade exata. O produto inteiro permanece dentro do limite seguro no domínio numeric(12,2).

Entradas com subcentavos, booleanos, não finitos, valores fora do domínio ou strings monetárias com precisão extra são rejeitadas antes da conversão que poderia esconder casas decimais. O parser público da base também deixou de arredondar entradas inválidas. Não se alteraram preços PADRAO/NOBRE nem a regra de desconto comercial do pacote.

## Proposta, aprovação e transições

O JSON do Fechamento usa schemaVersao 1, forma, pretendida, aprovada e revisaoStatus. Os dados da condição são `entradaCentavos`, `parcelaCentavos` e `quantidadeParcelas`; os campos não preenchidos ficam nulos. Entrada zero é aceita; parcela, quando informada, precisa ser positiva; quantidade precisa ser inteiro positivo seguro.

- O público envia somente `condicaoPixPretendida`, com entrada, valorParcela e quantidadeParcelas opcionais. Não precisa preencher todos nem fazer a proposta somar o contrato. Campos de aprovação enviados pelo público são rejeitados.
- Novos PIX parcelados exigem revisão mesmo com base igual à tabela. Sem negociação de preço, não se inventam valor_negociado ou valor_aprovado no Fechamento.
- PIX à vista/cartão sem negociação preservam a liberação existente para AGUARDANDO_CONTRATO; o documento registra revisão DISPENSADA. Se houver negociação, aguardam revisão do valor.
- A revisão administrativa mostra a intenção e campos separados para o que foi aprovado. Não copia automaticamente a intenção para a aprovação. No PIX parcelado, aprovar exige ao menos um dado da condição acordada, além do motivo; todos os campos não são obrigatórios.
- Quando há negociação de preço, a base aprovada deve ser informada explicitamente. Revisão somente de condição não pode alterar silenciosamente o preço de tabela.
- A decisão cria novo registro em aprovacoes_negociacao, mantendo o registro pendente histórico. Guarda proposta, condição aprovada, identificação da solicitação, hash da decisão e, na aprovação, base/desconto/total. Também gera auditoria e evento no histórico do cliente.
- Aprovação avança para AGUARDANDO_CONTRATO; recusa para RECUSADO. A operação bloqueia o Fechamento em transação, verifica estado e ausência de Contrato. Repetição equivalente reutiliza a decisão; repetição divergente retorna conflito.

## Contrato, snapshot e separação de Pagamentos

Novos Fechamentos identificados pelo documento comercial levam ao snapshot: forma pretendida, base antes do desconto, percentual, desconto monetário, valorFinalContrato, proposta e condição aprovada. O Resumo da Contratação apresenta esses dados com rótulos distintos. O Contrato Oficial continua usando valorFinalContrato e as cláusulas já existentes; não foi alterado seu texto jurídico.

Registros legados com condicao_pagamento NULL mantêm a resolução anterior. Não são convertidos silenciosamente ao novo fluxo nem revisados por esta tela. Nenhum snapshot ou versão antiga foi regravado. Regeração equivalente continua idempotente; versão assinada continua protegida.

| Invariante conferida | Evidência |
|---|---|
| Fechamento não cria Pagamento | Contagem financeira igual antes/depois da criação pública |
| Proposta não cria plano/parcela financeira | Contagens de pagamentos, planos, parcelas e recebimentos iguais |
| Aprovação não representa recebimento | Mesmas contagens após decisão; nenhum lançamento financeiro |
| Contrato assinado não cria Pagamento automaticamente | Contagens iguais após assinatura pelos serviços reais |
| Pagamentos não recalcula desconto | Código de Pagamentos intacto; recebe 9.011,30 da versão assinada |
| Plano deve somar exatamente o snapshot assinado | Plano de 9.290,00 rejeitado; duas parcelas de 4.505,65 aceitas |
| Preferência não confirma reserva | Fechamento aguarda revisão/contrato; confirmação continua no núcleo financeiro existente |

O ciclo completo foi executado com fixtures sintéticas: Fechamento público → proposta → aprovação pelo handler administrativo → geração contratual → desafio OTP → confirmação do código → assinatura real pelo serviço → criação explícita de Pagamentos. Somente o transporte de envio do OTP foi simulado; não houve mensagem externa. O teste anterior que marcava a fixture assinada via UPDATE foi substituído por essa jornada de serviços reais.

## Revisão dos 26 arquivos da implementação

Todos os **26 arquivos precisam permanecer** para entregar o fluxo, sua persistência e validação. Nenhum foi revertido. Os caminhos são relativos à pasta fonte informada no início. A proposta e este relatório são documentação adicional, fora dos 26 arquivos de implementação.

| # | Arquivo | Motivo para permanecer / revisão |
|---|---|---|
| 1 | `database/migrations/20260909_012_condicao_pagamento.sql` | Registro da mudança autorizada e já aplicada; preservado sem reaplicação ou edição na retomada |
| 2 | `lib/comercial/condicao-pagamento.ts` | Tipos e cálculo compartilhado; validação estrita e aritmética em centavos |
| 3 | `lib/comercial/condicao-pagamento.test.ts` | 22 testes dos três valores, precedência, arredondamento, legado e entradas inválidas |
| 4 | `lib/fechamentos/repositories/models.ts` | Representa os dois documentos JSON sem tornar o novo campo obrigatório para legado |
| 5 | `lib/fechamentos/repositories/fechamento.repository.ts` | Persiste/lê documentos e registra estado da decisão sem inventar negociação de preço |
| 6 | `lib/fechamentos/services/models.ts` | Contrato de entrada da condição pretendida |
| 7 | `lib/fechamentos/services/fechamento.service.ts` | Valida proposta/base e exige revisão de novos PIX parcelados |
| 8 | `lib/fechamentos/services/fechamento-publico.service.ts` | Encaminha proposta dentro da transação de identidade/CRM existente |
| 9 | `lib/fechamentos/services/errors.ts` | Erros específicos de revisão e Fechamento ausente |
| 10 | `lib/fechamentos/services/revisao-comercial.service.ts` | Aprovação/recusa transacionais, separação da proposta, idempotência, auditoria e histórico |
| 11 | `lib/http/condicao-pagamento-schema.ts` | Validação HTTP sem coerção de booleanos ou perda de precisão |
| 12 | `app/api/fechamentos/route.ts` | Recebe somente intenção; rejeita aprovação pública e subcentavos na base; devolve condição persistida |
| 13 | `app/api/admin/fechamentos/[fechamentoId]/revisao/route.ts` | GET/POST da revisão, validação, no-store e bloqueio administrativo em produção |
| 14 | `app/admin/fechamentos/[fechamentoId]/revisao/page.tsx` | Página de revisão do Fechamento específico |
| 15 | `components/admin/RevisaoComercial.tsx` | Conferência, decisão e geração explícita do Contrato; acabamento da prévia monetária e link para Resumo |
| 16 | `components/admin/RevisaoComercial.module.css` | Apresentação e adaptação da tela de revisão |
| 17 | `components/fechamento/types.ts` | Campos opcionais do formulário público |
| 18 | `components/fechamento/calculos.ts` | Cards usam a regra comercial compartilhada com arredondamento em centavos |
| 19 | `components/fechamento/FechamentoWizard.tsx` | Card 3%, proposta parcial, envio/validação; acabamento do limite da base e texto de reserva |
| 20 | `lib/contratos/services/snapshot-core.ts` | Precedência da base seguida de desconto somente no novo fluxo, preservando legado |
| 21 | `lib/contratos/services/contrato.service.ts` | Bloqueia condição pendente/recusada e monta os novos campos do snapshot |
| 22 | `lib/contratos/repositories/models.ts` | Campos opcionais do snapshot, compatíveis com versões antigas |
| 23 | `lib/contratos/documento/formatters.ts` | Formatação explícita de entrada, parcela e quantidade |
| 24 | `lib/contratos/documento/template-v1.ts` | Resumo exibe base/desconto e diferencia condição pretendida/aprovada; conteúdo legado preservado |
| 25 | `scripts/condicao-pagamento.integration.cjs` | 18 cenários, incluindo assinatura real, handlers, saldo do plano, preservação e espera física do lock; ampliado na retomada |
| 26 | `package.json` | Dois comandos reproduzíveis para os testes do ajuste |

Os scripts `contrato-bloco1-verificacao.sql` e `contrato-bloco2-verificacao.sql` já existiam e não foram alterados nesta implementação. Não fazem parte dos 26. A comparação de hashes dos arquivos previamente existentes confirmou ausência de mudanças em Pagamentos, Disponibilidade, Clientes/CRM, migrations anteriores e schema_mvp_kidmais.sql.

## Testes finais e resultados

| Bateria | Resultado final |
|---|---|
| Nova regra comercial | 22/22 unitários |
| Novo fluxo com PostgreSQL | 18 cenários: 17 de domínio/integração/handlers e 1 de lock físico |
| HTTP do novo fluxo | 13 chamadas de handlers dentro da suíte: aprovação 201, consulta, replay 200, produção 503, precisão/no-store, criação pública e sete payloads públicos inválidos |
| Contrato | 12/12 unitários |
| Pagamentos | 30/30 unitários |
| Pagamentos/PostgreSQL | 24 cenários de engenharia |
| HTTP de Pagamentos | 35 requisições |
| Concorrência de Pagamentos | 5 cenários |
| Disponibilidade | 5/5 unitários |
| PricingService | 10 cenários, inclusive PADRAO/NOBRE e adicionais |
| Identidade repository | 8 verificações funcionais e rollback |
| Identidade service | 9 verificações funcionais e rollback |
| Identidade/CRM/Fechamento | 4 verificações funcionais e rollback |
| TypeScript | Aprovado, sem erros |
| Lint direcionado | Aprovado, sem erros |
| Build Next.js | Aprovado, incluindo página e rota da revisão |
| Inspeção física e preservação | Aprovadas |

Comandos executados novamente ao final:

```powershell
npm.cmd run test:comercial:pagamento
npm.cmd run test:comercial:pagamento:integration
npm.cmd run test:disponibilidade
npm.cmd run test:contrato
npm.cmd run test:pagamentos
npm.cmd run test:pagamentos:integration
node --env-file=.env.local -r ./scripts/pagamentos-test-support.cjs -e 'require("./scripts/pricing-service.integration.ts")'
node --env-file=.env.local -r ./scripts/pagamentos-test-support.cjs -e 'require("./scripts/identidade-repository.integration.ts")'
node --env-file=.env.local -r ./scripts/pagamentos-test-support.cjs -e 'require("./scripts/identidade-service.integration.ts")'
node --env-file=.env.local -r ./scripts/pagamentos-test-support.cjs -e 'require("./scripts/identidade-fechamento.integration.ts")'
npx.cmd tsc -p tsconfig.json --noEmit
npx.cmd eslint lib/comercial/condicao-pagamento.ts lib/comercial/condicao-pagamento.test.ts lib/fechamentos lib/http/condicao-pagamento-schema.ts lib/contratos/services/snapshot-core.ts lib/contratos/services/contrato.service.ts lib/contratos/repositories/models.ts lib/contratos/documento/formatters.ts lib/contratos/documento/template-v1.ts app/api/fechamentos app/api/admin/fechamentos app/admin/fechamentos components/admin/RevisaoComercial.tsx components/fechamento/calculos.ts components/fechamento/types.ts components/fechamento/FechamentoWizard.tsx scripts/condicao-pagamento.integration.cjs
npm.cmd run build
npm.cmd run check:pagamentos:db
```

Os dois casos reais foram reconferidos: pagamento f9207fe7-ed6d-4149-a148-8143eedbd6bb continua com total 8.990,00, estorno 500,00, saldo 500,00, reserva confirmada e quitado_em histórico; pagamento 59dcf33b-8da1-4cae-9d4d-1f3f3dd95b31 continua com 9.290,00, V1 substituído, V2 de duas parcelas pendentes de 4.645,00 e nenhum recebimento. As contagens permanecem dois pagamentos, três planos, cinco parcelas, três recebimentos, três alocações, um estorno e um comprovante.

## Verificação visual executada

A etapa 8 foi aberta no Next local pelo navegador integrado, com base de 9.290,00. Foram observados os três cards com 8.361,00 / 9.011,30 / 9.290,00, selecionado PIX parcelado e preenchido somente valor da parcela com 500,25. Entrada e quantidade permaneceram em branco. Os campos e textos foram conferidos por árvore de acessibilidade e screenshot. O formulário visual não foi enviado; não criou cadastro ou Fechamento.

## Passo a passo exato para teste manual

### Preparação local

1. Na pasta fonte, execute `npm.cmd run dev` se não houver servidor ativo. Use `http://localhost:3000`. A sessão já encontrou servidor existente nessa porta; não é necessário iniciar uma segunda instância.
2. O ambiente local conferido já possui `CRM_API_DEV_ENABLED=true`, `CONTRATO_ACEITE_DEV_ENABLED=true`, `IDENTIDADE_OTP_PROVIDER=console` e pepper de identidade configurado. Não exponha o pepper. Use desenvolvimento; em build de produção as APIs administrativas permanecem bloqueadas.
3. Use um **novo Fechamento de teste**, não os dois casos reais anteriores. A submissão manual persiste dados; somente as suítes automatizadas executam rollback automático.

### Cliente: proposta e três valores

4. Abra `http://localhost:3000/disponibilidade`, selecione data/horário livres e siga para Fechamento. Não use `?contexto=ADMIN`: a entrada interna antiga ainda depende da autenticação da equipe.
5. Para repetir a data utilizada na conferência visual, a URL é `http://localhost:3000/fechamento?origem=DISPONIBILIDADE&data=2026-10-10&periodo=almoco&ajuste=0&inicio=11:00&fim=15:00`. Ela revalida o horário; se a agenda tiver mudado, escolha outro horário pela Disponibilidade.
6. Escolha **Festa Completa**, avance, selecione **50** convidados, mantenha **Prefiro definir depois** no buffet e avance sem adicionais.
7. Em **Confirme o valor combinado**, informe **9.290,00**. Esse é o valor base, antes do desconto da forma. A tabela pode mostrar 8.990,00 neste exemplo; isso gera negociação e exigirá base aprovada explicitamente pela Kidmais.
8. Complete seus dados de teste. CPF novo abre cadastro; CPF existente exige o fluxo de identificação atual. Preencha contato, e-mail, endereço e aniversariante; avance pelo Resumo.
9. Em **Etapa 8 — Como pretende pagar?**, confira PIX à vista **10% / R$ 8.361,00**, PIX parcelado **3% / R$ 9.011,30** e Cartão **Cielo / R$ 9.290,00**.
10. Selecione PIX parcelado. Em **Condição pretendida**, preencha apenas **Valor da parcela = 500,25**. Deixe Entrada e Quantidade em branco para validar proposta parcial. Não é necessário que a proposta feche a soma contratual.
11. Abra as ferramentas do navegador (F12), aba **Network/Rede**, antes de clicar **Enviar para conferência**. Na resposta do POST `/api/fechamentos`, copie `fechamentoId` completo. Confira `status = AGUARDANDO_APROVACAO` e `comercial.condicaoPagamento.pretendida.parcelaCentavos = 50025`. O campo `aprovada` deve ser null.

### Kidmais: revisão e Contrato

12. Abra `http://localhost:3000/admin/fechamentos/FECHAMENTO_ID/revisao`, substituindo FECHAMENTO_ID pelo identificador copiado.
13. Confira a proposta. Se houver **Base comercial aprovada, antes do desconto**, informe **9290,00**. Em **Condição aprovada**, informe **Entrada = 0**, **Valor da parcela = 4505,65**, **Quantidade = 2**. Isso é uma escolha explícita de teste; não é cópia automática da proposta.
14. Preencha um motivo, marque **Conferi o valor e as condições com o cliente** e clique **Aprovar condição**. Confira AGUARDANDO_CONTRATO, intenção original de 500,25 e condição aprovada separada. O total deve ser **R$ 9.011,30**.
15. Clique **Gerar contrato**. A mensagem informa o valor final; clique **Abrir Resumo da Contratação**. Confira base, desconto e as duas condições com seus rótulos.
16. Abra `http://localhost:3000/api/admin/contratos?fechamentoId=FECHAMENTO_ID`. Copie `data.contrato.id`; confira no JSON `data.versao.snapshot.comercial.valorFinalContrato = 9011.3` e `valorBaseComercial = 9290`.

### Cliente: assinatura explícita

17. Abra `http://localhost:3000/contrato/CONTRATO_ID`, substituindo CONTRATO_ID. Informe o mesmo CPF, escolha o contato e clique **Enviar código**.
18. No modo local console, o código aparece no terminal do Next na linha `[Kidmais Identidade][OTP DEV]`. Use o código dessa solicitação; não é enviado por WhatsApp real nesse modo. Informe os seis dígitos e confirme.
19. Confira o Resumo e abra o **Contrato Oficial**. No registro de teste, marque a caixa de leitura/aceite e clique **Aceitar e assinar eletronicamente**. O estado esperado do Fechamento é CONTRATO_ASSINADO; assinatura ainda não cria Pagamento.

### Operação: criar Pagamentos explicitamente

20. Abra `http://localhost:3000/api/admin/pagamentos?fechamentoId=FECHAMENTO_ID`. Antes da criação deve retornar ausência de Pagamento. Não existe uma nova tela de plano financeiro nesta entrega.
21. No Console das ferramentas do navegador, em uma página de localhost:3000, execute a chamada explícita abaixo **somente para o novo Fechamento de teste já assinado**. Substitua o ID e ajuste vencimentos se necessário:

```javascript
const resposta = await fetch('/api/admin/pagamentos', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    fechamentoId: 'COLE_O_FECHAMENTO_ID_DE_TESTE',
    plano: {
      meioPagamento: 'PIX', modalidade: 'PARCELADO',
      parcelas: [
        { valor: 4505.65, vencimento: '2026-09-20', confirmaReserva: true },
        { valor: 4505.65, vencimento: '2026-10-01' }
      ]
    }
  })
});
console.log(resposta.status, await resposta.json());
```

22. Espere HTTP 201 e total contratado **9011.3**, com parcelas somando **9011.3**. A criação registra o plano, não um recebimento. O Fechamento fica AGUARDANDO_PAGAMENTO. Nenhum desconto deve ser aplicado outra vez.
23. Para testar recusa, use outro Fechamento novo e escolha **Recusar** na revisão. Para testar subcentavos sem persistir, use a suíte automatizada; a tela pública também rejeita uma parcela como `500,251` antes do envio. Não reutilize versões assinadas para mudar a condição.

## Limites conhecidos e impactos

- Fechamento e Contrato receberam alterações funcionais; CRM recebe novos eventos de histórico/auditoria, mas seu código não mudou. Pagamentos e Disponibilidade não tiveram código alterado.
- A aprovação administrativa continua restrita ao modo de desenvolvimento existente; autenticação real de equipe, gateways PIX/Cielo, webhook e storage não fazem parte desta entrega.
- A regra nova identifica novos Fechamentos pelo documento comercial. Fechamentos legados com campo NULL continuam no comportamento anterior; não há conversão silenciosa nem ferramenta de migração de casos antigos.
- A condição comercial aprovada pode ser parcial. Não é um cronograma financeiro definitivo, não cria parcelas e não impõe por si só que o plano posterior reproduza entrada/quantidade sugeridas. A soma do plano posterior é validada contra o total assinado.
- A recusa é terminal neste fluxo implementado. Reabertura, nova proposta em registro recusado e mudança de condição após geração do Contrato não foram acrescentadas.
- Os novos testes HTTP invocam handlers Next reais, com NextRequest/NextResponse e PostgreSQL; não passam todos pelo servidor Next completo. O navegador verificou a etapa pública, sem submissão; a revisão/assinatura foi exercitada pelos serviços/handlers, não por cliques ponta a ponta.
- Os testes concorrentes comprovam espera física e retomada após rollback. O novo teste de revisão consulta e bloqueia um registro legado sem alterá-lo; comprova lock e revalidação, não dois commits simultâneos de aprovação. Não houve teste de carga ou queda de processo.
- A validação detalhada do JSON é responsabilidade dos serviços. Os CHECKs não substituem todas as invariantes do domínio para escritas SQL externas.
- Há avisos do Node sobre testes TS sem tipo de package e de pg sobre consultas concorrentes no mesmo cliente do harness. Não impediram os testes. O lint direcionado passou; não se declara o lint global do projeto corrigido.

**Encerramento:** nenhuma outra migration, backfill, alteração de schema ou início de Festa. Implementação e validação encerradas nesta entrega; aguardar aprovação do usuário.
