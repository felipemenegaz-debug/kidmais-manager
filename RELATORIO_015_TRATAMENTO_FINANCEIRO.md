# Migration 015 — Tratamento financeiro de alterações contratuais

Data: 10/09/2026. Implementação e implantação concluídas na pasta atual do Kidmais Manager.

## Resultado da implantação

- Pasta principal: `D:\glass\KidMais Manager\kidmais-manager`.
- Desenvolvimento e testes ocorreram primeiro em `.tmp\implementacao-015`, com bancos clonados.
- Migration aplicada: `database/migrations/20260910_015_tratamento_financeiro.sql`.
- Precheck e postcheck: aprovados no clone e no banco real `kidmais_manager`.
- Banco real: passou de 40 para 52 tabelas. As 12 tabelas novas continuam vazias ao término da conferência.
- Os registros das 40 tabelas anteriores permaneceram idênticos aos do checkpoint, conferidos por quantidade e SHA-256 da representação ordenada de todas as linhas, incluindo BYTEA.
- Nenhuma pendência financeira real foi resolvida automaticamente. Nenhum recebimento, estorno ou devolução de teste foi registrado no banco real.
- Migrations 012, 013 e 014 e `schema_mvp_kidmais.sql`: hashes preservados.
- 14 baterias finais aprovadas; TypeScript, lint direcionado e build limpo de produção com webpack aprovados.
- Sistema iniciado em `http://localhost:3000`. Login respondeu HTTP 200; API financeira sem sessão respondeu HTTP 401.

## Problema original e solução

A promoção de uma nova versão contratual já podia sinalizar uma pendência, mas faltava reconhecer explicitamente seu efeito financeiro sem reescrever a obrigação original. O plano legado, sozinho, também não representava um cronograma que reunisse parcelas preservadas, reprogramadas e adicionais.

A implementação mantém a obrigação original vinculada à versão que a criou. Cada regularização registra um ajuste vinculado à versão contratual reconhecida, congela suas bases financeiras e produz um cronograma consolidado. Planejamento, reconhecimento de obrigação, recebimento e devolução são atos distintos.

Não há novo desconto em Pagamentos. Os valores das versões assinadas são a referência contratual.

## Regras implementadas

### Posição econômica

Os cálculos novos usam centavos inteiros com BigInt:

```text
Obrigação consolidada = obrigação original + ajustes reconhecidos
Recebido líquido = recebimentos confirmados − estornos confirmados − devoluções concluídas
Saldo a receber = máximo(obrigação consolidada − recebido líquido, 0)
Crédito total = máximo(recebido líquido − obrigação consolidada, 0)
Crédito disponível = crédito total − reservas ativas de devolução
```

O aproveitamento de crédito na mesma contratação não subtrai novamente os recebimentos que o originaram. Devolução pendente reserva crédito; apenas a conclusão representa saída econômica.

### Pendências e tentativas

- Uma tentativa cancelada permanece histórica com estado `CANCELADA`.
- Se o efeito financeiro continuar sem tratamento, a situação geral permanece `PENDENTE`.
- É possível abrir nova tentativa; cancelar não resolve nem apaga a alteração.
- Uma versão vigente posterior pode superar uma tentativa anterior sem reconhecer financeiramente versões intermediárias por acidente.
- Delta zero pode exigir tratamento por condição de pagamento, troca de contratante ou alteração de data que afete o cronograma PIX. Sem impacto financeiro, não se cria pendência.
- Simulação e confirmação conferem a posição financeira. Mudanças concorrentes impedem confirmar uma posição obsoleta.

### Cronograma consolidado

- Após a primeira regularização, `pagamento_cronogramas` e `pagamento_cronograma_itens` são a fonte canônica da programação.
- O cronograma reúne parcelas preservadas, reprogramadas e complementares.
- `plano_id` é opcional e identifica somente um plano eventualmente criado para novas parcelas.
- Preservar todas as parcelas necessárias não cria plano artificial.
- Plano legado e cronograma não são somados como duas cobranças.
- A soma dos saldos dos itens vigentes precisa coincidir exatamente com o saldo econômico a receber.
- Parcelas preservadas mantêm identidade e vencimento. Reprogramação cria uma nova programação, sem reescrever movimentos históricos.

### Recebimentos, estornos e devoluções

- Enquanto existir alteração não regularizada, recebimentos respeitam a capacidade da obrigação já reconhecida.
- Dinheiro recebido fora do sistema pode ser registrado com sua data real depois da regularização necessária.
- Troca de contratante exige decisão explícita sobre aproveitamento; não troca a autoria histórica dos recebimentos.
- **Devolver ao pagador anterior somente é permitido quando existe crédito disponível.** Não se permite uma devolução que reabra saldo a receber.
- **Estorno que reabre saldo fora do cronograma exige reprogramação explícita na mesma transação.** Sem ela, a operação inteira é recusada. Nenhum vencimento é criado automaticamente.
- Solicitação de devolução reserva crédito e suas origens; cancelamento permitido libera a reserva.
- Conclusão exige data efetiva, meio e comprovante ou justificativa de ausência de comprovante.
- Comprovantes de devolução usam BYTEA, tamanho e hash; PDF, JPEG ou PNG, até 10 MiB.

### Autorização, auditoria e concorrência

- Foram reutilizados autenticação local, sessões, CSRF e papéis existentes.
- `ADMINISTRATIVO` e `REPRESENTANTE_AUTORIZADO` podem tratar pendências, reprogramar, decidir crédito, solicitar e cancelar devolução pendente.
- **Somente `REPRESENTANTE_AUTORIZADO` conclui devolução.** A API também impõe a restrição.
- A sessão real é conferida dentro da transação. Novos eventos preservam contexto de autoria e identificação da operação.
- Idempotência reconhece UUIDs equivalentes em maiúsculas/minúsculas, reutiliza a operação original e rejeita intenção divergente.
- Locks e validações diferidas protegem reconhecimento, cronograma, capacidade de recebimento, crédito reservado e conclusão concorrente de devoluções.
- `pagamento_eventos` registra fatos novos. A linha do tempo também consulta recebimentos, estornos e auditoria anteriores, sem fabricar eventos retroativos da 015.

## Estrutura física e rollback

Não foi feita alteração nas migrations aplicadas 012/013/014, nem no schema legado. A 015 acrescenta:

| Tabela | Finalidade |
|---|---|
| `pagamento_gestoes` | Coordenação financeira da contratação e sequência de eventos |
| `pagamento_tratamentos` | Tentativas de tratamento de uma pendência |
| `pagamento_eventos` | Fatos novos, autoria, idempotência e posições anterior/posterior |
| `pagamento_ajustes_contratuais` | Reconhecimento encadeado de alterações e versão de referência |
| `pagamento_cronogramas` | Cabeçalho e encadeamento de cronogramas consolidados |
| `pagamento_cronograma_itens` | Parcelas integrantes, origens e bases de saldo |
| `pagamento_movimentos_contextos` | Contexto contratual/econômico dos movimentos novos |
| `pagamento_credito_reservas` | Crédito reservado, liberado ou consumido por devolução |
| `pagamento_devolucoes` | Solicitação, cancelamento e confirmação de saída financeira |
| `pagamento_devolucao_alocacoes` | Origem do valor devolvido nos recebimentos existentes |
| `pagamento_devolucao_comprovantes` | Evidências em BYTEA e metadados |
| `pagamento_ajuste_bases` | Bases financeiras congeladas de cada ajuste |

Além das FKs e constraints das tabelas novas, foram acrescentadas proteções sobre estruturas financeiras existentes: seis tabelas recebem proteção de histórico e cinco participam da validação diferida de movimentos. Os vínculos de sessão contextual não criam dependência permanente da retenção da sessão.

Arquivos de controle:

- `database/checks/20260910_015_precheck.sql`.
- `database/checks/20260910_015_postcheck.sql`.
- `database/rollback/20260910_015_tratamento_financeiro_down.sql`.

O teste isolado aplicou, desfez e reaplicou a 015, preservando as tabelas anteriores. Também confirmou que o rollback **recusa execução quando qualquer tabela nova já contém registros**. Não usa `CASCADE` para apagar fatos financeiros.

Um rollback operacional precisa ser coordenado com o retorno do código anterior e o servidor parado. Não foi executado rollback no banco real. Não há comando de migration pendente para o usuário executar.

Checkpoints preservados:

- Inicial: `.backups\pre-015-1789039217558` — fontes, manifesto e dump anterior ao bloco.
- Imediatamente anterior à implantação: `.backups\implantacao-015-1789049785758` — fontes substituídas, dump e fingerprints.
- O acabamento posterior do campo monetário também preservou os dois arquivos substituídos na subpasta `acabamento` desse segundo checkpoint.

## Arquivos criados — 30

| Arquivo | Motivo |
|---|---|
| `app/api/admin/contratos/[contratoId]/financeiro/[[...acao]]/route.ts` | Consulta e comandos administrativos financeiros autenticados |
| `components/admin/FinanceiroContrato.tsx` | Painel, tratamento em quatro etapas, cronograma, movimentos e devoluções |
| `components/admin/financeiro.module.css` | Apresentação desktop/mobile do painel |
| `database/checks/20260910_015_precheck.sql` | Verificação anterior à migration |
| `database/checks/20260910_015_postcheck.sql` | Verificação da estrutura e proteções instaladas |
| `database/migrations/20260910_015_tratamento_financeiro.sql` | Estruturas e proteções físicas do bloco |
| `database/rollback/20260910_015_tratamento_financeiro_down.sql` | Rollback protegido contra perda de fatos |
| `lib/http/cronograma-financeiro-schema.ts` | Validação HTTP do pedido de reprogramação explícita |
| `lib/pagamentos/repositories/alteracao-financeira.repository.ts` | Leitura consistente de posição, versões e programação |
| `lib/pagamentos/services/alteracao-financeira-core.ts` | Cálculo exato e validações de posição/parcelas |
| `lib/pagamentos/services/alteracao-financeira-core.test.ts` | Testes unitários das regras novas |
| `lib/pagamentos/services/alteracao-financeira.models.ts` | Contratos de dados dos novos comandos |
| `lib/pagamentos/services/alteracao-financeira.service.ts` | Tentativas, simulação, resolução e idempotência |
| `lib/pagamentos/services/cronograma.service.ts` | Preservação, composição e reprogramação de parcelas |
| `lib/pagamentos/services/devolucao.service.ts` | Crédito reservado, devoluções e provas |
| `lib/pagamentos/services/financeiro-consulta.service.ts` | Painel e linha do tempo unificada |
| `lib/pagamentos/services/movimentos-consolidados.ts` | Integração transacional de movimentos e cronograma |
| `lib/pagamentos/services/pendencias-financeiras.service.ts` | Detecção e superação de pendências por versão |
| `scripts/alteracao-financeira.integration.cjs` | Regularização do cenário existente em clone |
| `scripts/casos-financeiros-015.integration.cjs` | Matriz de 16 casos financeiros e estorno com reprogramação |
| `scripts/credito-devolucao-015.integration.cjs` | Crédito, reserva, papéis, devolução e reaproveitamento |
| `scripts/financeiro-015-test-support.cjs` | Fixtures financeiras isoladas |
| `scripts/financeiro-fluxo-015.integration.cjs` | Ciclo assinado completo e concorrência real |
| `scripts/financeiro-http-015.integration.cjs` | Contratos HTTP, CSRF e idempotência |
| `scripts/financeiro-ui-015.cjs` | Operações no navegador e precisão visual do campo monetário |
| `scripts/migration-015.integration.cjs` | Aplicação, rollback, reaplicação e imutabilidade |
| `scripts/movimentos-015.integration.cjs` | Recebimentos/estornos após consolidação |
| `scripts/qualidade-015.cjs` | Inventário de diferenças, TypeScript, lint e build |
| `scripts/regressoes-015.cjs` | Unitários e regressões de Pricing/Identidade/CRM/Fechamento |
| `scripts/validacao-015.cjs` | Restauração de clones e execução sequencial das baterias |

## Arquivos alterados — 13

| Arquivo | Alteração necessária |
|---|---|
| `app/api/admin/pagamentos/[pagamentoId]/estornos/route.ts` | Sessão real e reprogramação explícita junto ao estorno |
| `app/api/admin/pagamentos/[pagamentoId]/recebimentos/route.ts` | Contexto autenticado para movimentos novos |
| `components/admin/ContratoAdmin.tsx` | Inclusão do painel financeiro e limpeza do contrato anterior durante troca de seleção |
| `lib/contratos/services/fluxo-publico.ts` | Integração da detecção financeira na promoção, preservando assinatura e OTP |
| `lib/http/pagamentos-api.ts` | Tradução dos erros novos para respostas HTTP |
| `lib/pagamentos/services/errors.ts` | Erro explícito para programação consolidada |
| `lib/pagamentos/services/models.ts` | Contexto de sessão e campos compatíveis de programação/reprogramação |
| `lib/pagamentos/services/pagamento.service.ts` | Fonte canônica, capacidade reconhecida, eventos, estornos e preservação histórica |
| `scripts/pagamentos-concorrencia.integration.cjs` | Sessões reais distintas nos testes de concorrência |
| `scripts/pagamentos-test-support.cjs` | Contexto autenticado compatível com 015 nas fixtures |
| `scripts/revisao-operacional.integration.cjs` | Inclusão do ciclo financeiro depois do fluxo real de assinaturas |
| `scripts/revisao-operacional.navegador.cjs` | Inclusão dos testes do painel financeiro |
| `tsconfig.json` | Target ES2020 necessário aos cálculos BigInt |

Os 43 arquivos de implementação e validação acima permanecem necessários. O inventário com hashes finais está em `.tmp/015-implantacao.json`.

Este relatório e os scripts operacionais em `.tmp` são artefatos adicionais de execução/documentação: `checkpoint-015.cjs`, `implantar-015.cjs` e `finalizar-015.cjs`, além dos manifestos, logs, screenshots e diretórios de teste/backup. Não são migrations adicionais nem módulos funcionais.

## Testes e regressões

Última bateria completa: clone `kidmais_015_1789050237795`. Seus testes de assinatura e navegador usam um clone adicional criado pelo runner de revisão operacional. Todos os 14 runners terminaram com código zero.

| Bateria | Resultado |
|---|---|
| Migration 015 | Precheck, aplicação, postcheck, rollback, reaplicação e recusa de rollback com fatos: aprovados |
| Matriz financeira | 16 cenários aprovados |
| Crédito/devolução | Redução, reserva, limites, cancelamento, ADM/REP, saída efetiva e crédito sem dupla subtração: aprovados |
| HTTP financeiro novo | 20 requisições aprovadas |
| Regularização do caso existente em clone | Tentativa cancelada, aumento parcial, cronograma misto, idempotência e provas intactas: aprovados |
| Movimentos consolidados | Recebimento, parcela preservada, estorno, eventos e rollback: aprovados |
| Pagamentos — engenharia | 24 cenários aprovados |
| Pagamentos — HTTP existente | 35 requisições aprovadas |
| Pagamentos — concorrência existente | 5 cenários aprovados |
| Condição de pagamento/PIX | 19 cenários aprovados |
| Unitários e regressões de serviços | 114 testes unitários aprovados; PricingService, IdentityRepository, IdentityService e Identidade/CRM/Fechamento aprovados |
| Autenticação/Contrato | Sessões, CSRF, papéis, assinatura Kidmais, OTP, promoção, provas, logout e cookies HTTPS: aprovados |
| Revisão operacional e financeiro | Edição pós-assinatura, remarcação, concorrência e ciclo completo: aprovados |
| Navegador | Contrato/UI, financeiro desktop/mobile, simulação/confirmação, recebimento/estorno, devolução e comprovante BYTEA: aprovados, sem erros de página |

Regressões monetárias mantidas: base R$ 9.290,00 → PIX à vista R$ 8.361,00; PIX parcelado R$ 9.011,30; cartão R$ 9.290,00. A criação explícita de Pagamentos continua consumindo o valor contratual, sem recalcular desconto.

O ciclo completo testado inclui Fechamento, V1 assinada e paga, nova versão reduzida, assinatura Kidmais, aceite OTP, promoção, tratamento financeiro explícito, crédito, reserva, devolução, versões adicionais e novas regularizações. Assinar/promover não cria recebimento nem resolve automaticamente a pendência.

As fixtures sintéticas de cálculo exercitam as constraints financeiras com rollback. O fluxo completo separado usa as assinaturas reais do sistema e valida as constraints do ciclo contratual, evitando depender somente de fixtures simplificadas.

### Concorrência

As sete disputas novas foram verificadas com conexões PostgreSQL distintas e observação de bloqueio físico:

1. Mesma solicitação de devolução: um fato e repetição idempotente.
2. Duas reservas concorrentes do mesmo crédito: apenas a permitida persiste.
3. Reserva confirmada contra estorno: o crédito reservado fica protegido.
4. Rollback da reserva: libera a operação concorrente, sem reserva fantasma.
5. Duas conclusões de devolução: uma única saída financeira.
6. Duas resoluções com chaves distintas: um único reconhecimento do adicional.
7. Recebimento aguardando resolução: utiliza o cronograma reconhecido após o commit.

Também passaram cinco cenários concorrentes de Pagamentos e onze disputas existentes de revisão/remarcação/Disponibilidade, incluindo bloqueio administrativo contra revisão, promoção contra cancelamento e recuperação após rollback.

### Qualidade e correções durante a validação

- TypeScript: `node node_modules/typescript/bin/tsc --noEmit --incremental false` — aprovado.
- Lint: ESLint direcionado a todos os arquivos TS/TSX/CJS alterados ou criados — aprovado.
- Build: `node node_modules/next/dist/bin/next build --webpack`, com `.next` renovado — aprovado.
- O navegador identificou uma instabilidade ao trocar o contrato selecionado e um nome acessível inadequado no seletor de movimentos. Ambos foram corrigidos e a bateria repetida.
- O campo de parcela nova agora restaura explicitamente o último valor aceito quando recebe um valor inválido; o navegador testou `0,001` e confirmou que esse texto não permanece como valor aceito.
- Houve falha interna `WasmHash` ao reutilizar cache webpack neste ambiente. Builds limpos passaram. Os caches anteriores foram movidos para `.tmp` e preservados; não houve alteração em Next/webpack para contornar a falha. O build padrão Turbopack de `npm run build` não foi a modalidade usada nesta validação.

Evidências: `.tmp/implementacao-015/.tmp/015-bateria-resultados.json`, `015-qualidade.json`, `regressoes-015.json`, `navegador-revisao.json` e logs ao lado desses arquivos. Screenshots: `financeiro-015-cronograma.png`, `financeiro-015-mobile.png` e `financeiro-015-devolucao.png` na mesma pasta.

## Impactos e limites

- **Contrato:** dois arquivos funcionais alterados, para painel e detecção financeira na promoção. Templates, PDFs existentes, snapshot, provas e mecanismo de assinatura não foram alterados.
- **Pagamentos:** leitura consolidada e novos comandos financeiros; a obrigação original e os movimentos anteriores permanecem históricos.
- **Fechamento, CRM e Disponibilidade:** nenhum arquivo funcional desses módulos foi alterado; suas integrações e disputas relevantes foram testadas.
- **Autenticação:** nenhum novo papel ou sistema de autenticação; reutilização das sessões existentes.
- **Edição pós-assinatura/remarcação:** permanecem no fluxo existente. O efeito financeiro é reconhecido separadamente.
- **Festa:** nenhum trabalho iniciado neste módulo.
- Crédito restrito à mesma contratação; transferência para outra contratação está fora do bloco.
- O sistema registra a confirmação de uma devolução realizada; não executa transferência bancária nem confirma movimentação junto ao banco.
- Recebimento pendente exige tratamento/confirmacão antes de reorganização que conflite com ele.
- O formulário de estorno oferece reprogramação explícita do saldo inteiro em uma parcela. A API suporta o pedido estruturado; composições posteriores podem usar a ação de reprogramar cronograma.
- A identificação histórica de pagador/contexto não equivale a uma verificação de identidade bancária externa.
- Os dois casos anteriores continuam no banco real. A implantação não os regularizou.

## Passo a passo manual no navegador

### Abrir o sistema

O servidor foi deixado iniciado. Abra o navegador e digite exatamente:

```text
http://localhost:3000/admin/login
```

Entre com seu usuário administrativo já existente. Não é necessário executar bootstrap, configurar nova credencial PostgreSQL ou reaplicar migration.

Se o servidor tiver sido encerrado:

1. Abra o VS Code com a pasta do projeto.
2. No menu superior, clique em **Terminal → New Terminal**.
3. Confira que o terminal é PowerShell.
4. Cole no terminal, uma linha por vez, pressionando Enter:

```powershell
Set-Location -LiteralPath 'D:\glass\KidMais Manager\kidmais-manager'
npm run dev -- --hostname localhost --port 3000
```

5. Espere a mensagem `Ready` e mantenha esse terminal aberto.
6. Abra novamente a URL de login acima. Os comandos são para o terminal; não devem ser colados no `.env.local`.

### Consultar o caso V1/V2 existente

1. Após entrar, abra `http://localhost:3000/admin/contratos`.
2. No campo **Contrato**, selecione o caso com V1 de R$ 8.990,00 e V2 de R$ 13.131,00.
3. Localize **Financeiro da contratação**.
4. Antes de qualquer tratamento, confira versão vigente V2 e versão reconhecida financeiramente V1.
5. A obrigação original deve continuar R$ 8.990,00. No estado encontrado no banco, há R$ 8.990,00 recebidos e R$ 500,00 estornados: líquido R$ 8.490,00 e saldo reconhecido R$ 500,00.
6. A V2 ainda depende de regularização financeira. O adicional é R$ 4.141,00; depois de reconhecido, o saldo esperado, sem novos movimentos, é R$ 4.641,00.
7. Alterne o seletor **Versão contratual** entre V1 e V2 e consulte as provas históricas. Consultar não regulariza nem cria movimentos.

### Cancelar uma tentativa e confirmar que a alteração continua pendente

Os passos seguintes gravam atos financeiros explícitos quando confirmados. Para conservar o caso real exatamente como está, encerre o teste na consulta ou faça a operação em um ambiente de teste.

1. Clique em **Abrir tratamento da alteração**.
2. Confira a etapa 1 e clique em **Continuar**.
3. Preencha **Justificativa e autorização** com o motivo real do cancelamento da tentativa.
4. Clique em **Cancelar tentativa**.
5. Confira a tentativa como cancelada e a alteração ainda pendente, com opção de abrir novo tratamento.

### Regularizar a alteração

1. Clique em **Abrir tratamento da alteração**, ou **Retomar tratamento** se já houver tentativa aberta.
2. Etapa 1: confira obrigação reconhecida, valor vigente, recebido líquido e impactos. Clique em **Continuar**.
3. Etapa 2: escolha o tratamento do saldo. Para manter parcelas existentes e criar apenas o complemento, use **Preservar parcelas e complementar**.
4. Escolha a decisão de crédito aplicável. Havendo troca de contratante, preencha sua decisão explícita. Descreva **Justificativa e autorização**.
5. Clique em **Continuar**.
6. Etapa 3: confira cada valor e vencimento. Parcelas preservadas não são editadas. Para reprogramar, use **Remover da proposta** e **Adicionar parcela**, informando o novo valor e vencimento.
7. Digite valores sem separador de milhar: por exemplo, `4141,00`. Confira o total proposto. Em PIX, respeite a data limite da festa.
8. Clique em **Continuar** e depois **Validar simulação**.
9. Confira obrigação, saldo e crédito apresentados. Somente então clique em **Confirmar tratamento financeiro**.
10. Espere **Tratamento confirmado. Nenhum recebimento foi criado.** Confira o cronograma consolidado e a versão reconhecida.

### Registrar um recebimento ou estorno

1. Para dinheiro efetivamente recebido, clique em **Registrar recebimento**.
2. Selecione **Parcela a receber**, informe valor, descrição, meio e data/hora reais.
3. Clique em **Confirmar movimento financeiro** e confira a atualização do saldo.
4. Para corrigir um lançamento, clique em **Estornar recebimento**, escolha **Origem do estorno**, valor e descrição.
5. Se o estorno reabrir saldo fora do cronograma, marque **Reprogramar explicitamente todo o saldo após este estorno em uma parcela** e informe o vencimento acordado.
6. Confirme a operação. Estorno e reprogramação são confirmados juntos; em caso de recusa, nenhum deles deve persistir parcialmente.

### Solicitar e concluir devolução de crédito

Use uma contratação que tenha crédito disponível após redução regularizada. O caso de aumento V1 R$ 8.990,00 → V2 R$ 13.131,00 não possui crédito no estado encontrado.

1. Confira **Crédito disponível** e clique em **Solicitar devolução de crédito**.
2. Informe valor, beneficiário e motivo; confira as origens apresentadas.
3. Clique em **Confirmar solicitação usando as origens acima, em ordem**.
4. Confira a devolução pendente e o crédito reservado. Nesse ponto ainda não existe saída econômica.
5. Anexe **Comprovante (PDF, JPEG ou PNG)** quando disponível.
6. Com usuário `REPRESENTANTE_AUTORIZADO`, clique em **Registrar saída financeira efetivada**.
7. Informe data/hora reais, meio, observação e justificativa caso não exista comprovante.
8. Somente após a saída efetiva, clique em **Confirmo que a saída financeira ocorreu**.
9. Confira a devolução concluída, o valor devolvido e a liberação/consumo da reserva correspondente.
10. Um usuário `ADMINISTRATIVO` pode solicitar/cancelar pendência permitida, mas não deve conseguir concluir a devolução.

## Etapas manuais pendentes

Não há migration, backfill, bootstrap ou comando de implantação pendente. A etapa restante é a avaliação funcional pelo usuário. Os testes automatizados de escrita foram executados em clones; não rode runners de integração avulsos apontando para o banco real.

Para reproduzir a bateria completa isolada, opcionalmente, execute no PowerShell:

```powershell
Set-Location -LiteralPath 'D:\glass\KidMais Manager\kidmais-manager\.tmp\implementacao-015'
$baterias015 = @(
  'migration-015.integration.cjs'
  'casos-financeiros-015.integration.cjs'
  'credito-devolucao-015.integration.cjs'
  'financeiro-http-015.integration.cjs'
  'alteracao-financeira.integration.cjs'
  'movimentos-015.integration.cjs'
  'pagamentos-engenharia.integration.cjs'
  'pagamentos-http.integration.cjs'
  'pagamentos-concorrencia.integration.cjs'
  'condicao-pagamento.integration.cjs'
  'regressoes-015.cjs'
  'admin-contrato.integration.cjs'
  'revisao-operacional.integration.cjs'
  'revisao-operacional.navegador.cjs'
)
node --env-file=.env.local scripts/validacao-015.cjs @baterias015
```

Esse runner exige a cópia isolada e uma conexão de clone, restaura outro banco do checkpoint e conserva o resultado para inspeção. Os caminhos locais de PostgreSQL e Playwright utilizados nos testes correspondem ao computador atual.

## Preservação confirmada

**012/013/014, schema legado, contratos assinados, PDFs/BYTEA, snapshots, assinaturas, recebimentos históricos, estornos históricos, comprovantes e valores históricos das obrigações permaneceram intactos.** A comprovação da implantação está em `.tmp/015-implantacao.json`. Não houve backfill nem início de outro módulo.
