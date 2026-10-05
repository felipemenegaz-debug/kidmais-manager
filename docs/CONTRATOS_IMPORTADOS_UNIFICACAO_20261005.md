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
