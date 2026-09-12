# Pagamentos — Engenharia: relatório de encerramento para aprovação

> Registro histórico da primeira passagem. O resultado atualizado está em [Segunda passagem de validação](<D:/glass/KidMais Manager/kidmais-manager/README_SEGUNDA_VALIDACAO_PAGAMENTOS.md>), concluída em 09/09/2026, incluindo correções adicionais e revisão dos 18 arquivos.

Revisão realizada em 08/09/2026 sobre a pasta física `D:\glass\KidMais Manager\kidmais-manager` e PostgreSQL local. Recomendo aprovar o núcleo de engenharia no escopo local validado, com os limites abaixo registrados. Isto não libera a API administrativa para produção. Festa não foi iniciada.

## Inspeção e preservação

Foram revisados serviços, repositórios, modelos, erros e rotas de Pagamentos; os pontos de integração com Fechamento, assinatura/versionamento de Contrato e Disponibilidade; registros de auditoria e histórico; migrations, postcheck 011 e scripts relacionados. A documentação de Route Handlers instalada com Next.js foi consultada.

Banco confirmado fisicamente: `kidmais_manager`, PostgreSQL **18.6**, porta **5432**. As sete tabelas, 51 constraints nomeadas, 15 índices explícitos e quatro triggers da migration 011 estão presentes. O catálogo também inclui sete primary keys e índices gerados por constraints: 58 constraints sem contar NOT NULL, 27 índices totais. Essa diferença é de critério de contagem, não uma divergência da migration.

Nenhuma migration foi criada ou reaplicada. `schema_mvp_kidmais.sql` e migrations existentes foram preservados. Não houve backfill. A pasta não possui um repositório Git acessível; não há diff ou commit Git desta etapa.

| Caso físico | Estado final conferido |
|---|---|
| Pagamento `f9207fe7-ed6d-4149-a148-8143eedbd6bb` / Fechamento `61423a50-5f14-4fc6-9453-e23c5bf2810e` | Contratado 8.990; recebido 8.990; estornado 500; líquido 8.490; saldo 500; PARCIALMENTE_PAGO; reserva e Fechamento CONFIRMADOS; quitado_em preservado; um comprovante. |
| Pagamento `59dcf33b-8da1-4cae-9d4d-1f3f3dd95b31` / Fechamento `5cd47a40-4e43-4805-982a-c1ca1c28a303` | Contratado 9.290; zero recebimentos; V1 SUBSTITUIDO e parcela CANCELADA; V2 ATIVO, CARTAO/PARCELADO, provedor CIELO, duas parcelas de 4.645 PENDENTES; reserva PENDENTE. |

A troca de plano antiga do segundo caso possui auditoria, mas **não possui evento no histórico do cliente**. A correção vale para as próximas substituições. Não foi inserido evento retroativo.

Os testes de escrita criam cliente, fechamento, contrato e versão sintéticos dentro de transações revertidas. Somente as referências de configuração/preço são lidas de um fechamento existente. Nenhum cliente ou aniversariante foi preenchido artificialmente em registros antigos. Um teste concorrente utiliza um recebimento real confirmado apenas para SELECT e locks, sem alterar seu conteúdo. Hashes e contagens de 14 tabelas são comparados antes/depois dos testes, sem imprimir dados pessoais; todos permaneceram iguais.

## Problemas corrigidos

1. **Histórico incompleto:** substituições de plano e conflitos de agenda passam a registrar histórico além de auditoria. Recebimentos pendentes e estornos solicitados também ficam auditáveis, com eventos distintos da confirmação financeira.
2. **Idempotência:** recebimentos e estornos são reutilizados por chave normalizada ou pelo par provedor/referência. Valores, vínculos e alocações divergentes são rejeitados; chave e referência não podem apontar para operações diferentes. Não se sobrescrevem os identificadores originais. Violações dos índices únicos financeiros em corridas recebem HTTP 409, sem expor SQL.
3. **Concorrência:** operações financeiras adotam Fechamento → Pagamento → Recebimento. A criação rejeita contrato ainda não assinado antes de segurar Fechamento, para evitar a inversão com assinatura em andamento. Bloqueios administrativos também adquirem o lock transacional de agenda por data.
4. **Limites de recebimento:** alocações são verificadas no registro e novamente na confirmação. Recebimento pendente não permite confirmar valor acima do saldo; a soma das alocações é conferida novamente. Parcelas de planos substituídos/cancelados são rejeitadas.
5. **Estorno solicitado:** pode ser confirmado pela mesma chave/referência, sem duplicar o estorno. SOLICITADO e CONFIRMADO comprometem o limite estornável; somente CONFIRMADO altera totais financeiros. Saldo estornável zero retorna ESTORNO_INVALIDO, sem passar pela validação de valor positivo. A solicitação exige chave ou referência para permitir confirmação posterior.
6. **Comprovantes:** o mesmo recebimento/hash reutiliza o registro e retorna HTTP 200; não duplica auditoria nem sobrescreve o localizador original. Divergência de tamanho/MIME e vínculo com outro pagamento são rejeitados. Nenhum arquivo é gravado no PostgreSQL.
7. **Planos e estados:** qualquer recebimento registrado bloqueia substituição, inclusive RECUSADO/CANCELADO. Novos recebimentos exigem versão contratual corrente assinada e Fechamento compatível. Estorno não reabre pagamento CANCELADO nem cancela reserva confirmada.
8. **Valores e entrada HTTP:** valores respeitam numeric(12,2), rejeitando subcentavos, não finitos e excesso de capacidade. Saldos usam centavos para evitar resíduos de ponto flutuante. Ano zero e datas inexistentes são rejeitados. Booleanos não são convertidos em dinheiro. Erros de validação das rotas usam no-store.

## Evidências de testes

| Validação | Resultado |
|---|---|
| Disponibilidade | 5/5 testes unitários |
| Contrato | 12/12 testes unitários, incluindo snapshot, valor aprovado, documentos e tokens |
| Pagamentos | 27/27 testes unitários |
| Engenharia com PostgreSQL | 22 cenários aprovados |
| HTTP com PostgreSQL | 31 requisições aprovadas |
| Concorrência com conexões PostgreSQL distintas | 4 cenários aprovados |
| PricingService / Fechamento | 10 cenários aprovados, incluindo PADRAO/NOBRE |
| TypeScript | Sem erros |
| ESLint dos arquivos de código/testes alterados | Sem erros |
| Build Next.js | Aprovado |
| Preservação física | Hashes/contagens antes e depois iguais |

Os 22 cenários incluem criação explícita/idempotente; contrato não assinado; versão divergente; estados incompatíveis; constraints de status/duplicação; histórico da troca; alocações inválidas; todos os estados de recebimento bloqueando plano; confirmação posterior acima do saldo; idempotência por chave/provedor; resposta 409 a unicidade; fluxo parcial → reserva → quitação → estorno; solicitação e confirmação de estorno; pagamento cancelado; comprovantes; conflito de agenda com estorno posterior; sobreposição e bordas adjacentes.

Os testes HTTP abrem uma porta efêmera em loopback e invocam os **handlers Next reais** com NextRequest/NextResponse, serviços e banco reais. O transporte de teste é um servidor Node dedicado para manter rollback; não é o servidor completo `next dev`. Cobrem GET, criação, recebimentos, estornos, planos, comprovantes, JSON inválido, campos extras, UUIDs, 200/201/400/404/409/503, no-store e bloqueio administrativo em produção. O build valida a montagem das rotas pelo Next.

Nos quatro testes concorrentes, `pg_blocking_pids` comprova a espera da segunda conexão. Foram verificados chave global, referência global, confirmação de agenda e ordem dos locks da confirmação. A primeira transação é revertida; a segunda prossegue e também é revertida. Os testes não realizam dois commits concorrentes duráveis. Conflito contra reserva já confirmada é coberto dentro da transação de integração.

## Como repetir

Executar na raiz, com `.env.local` configurado:

```powershell
npm.cmd run check:pagamentos:db
npm.cmd run test:disponibilidade
npm.cmd run test:contrato
npm.cmd run test:pagamentos
npm.cmd run test:pagamentos:integration
npx.cmd tsc -p tsconfig.json --noEmit
npx.cmd eslint lib/pagamentos lib/http/pagamentos-api.ts lib/disponibilidade/repositories/disponibilidade.repository.ts app/api/admin/pagamentos scripts/pagamentos*.cjs
npm.cmd run build
node --env-file=.env.local -r ./scripts/pagamentos-test-support.cjs -e 'require("./scripts/pricing-service.integration.ts")'
```

O comando antigo `node --env-file=.env.local scripts/pagamentos.integration.cjs` agora encaminha para o teste com fixtures sintéticas. Os scripts de integração devem rodar sequencialmente, sem usuários gravando simultaneamente na mesma base: a comparação global de hashes detecta também alterações legítimas externas durante o teste.

## Arquivos alterados ou adicionados

| Arquivos | Finalidade |
|---|---|
| [pagamento.service.ts](</D:/glass/KidMais Manager/kidmais-manager/lib/pagamentos/services/pagamento.service.ts>) | Invariantes, transações, histórico, estornos e comprovantes |
| [pagamento.repository.ts](</D:/glass/KidMais Manager/kidmais-manager/lib/pagamentos/repositories/pagamento.repository.ts>) | Busca por referência/hash, limite de estornos, existência de recebimentos |
| [financeiro-core.ts](</D:/glass/KidMais Manager/kidmais-manager/lib/pagamentos/services/financeiro-core.ts>) e [testes](</D:/glass/KidMais Manager/kidmais-manager/lib/pagamentos/services/financeiro-core.test.ts>) | Limites monetários, centavos, datas e casos-limite |
| [idempotencia.ts](</D:/glass/KidMais Manager/kidmais-manager/lib/pagamentos/services/idempotencia.ts>) | Comparação de identidade financeira/provedor |
| [pagamentos-api.ts](</D:/glass/KidMais Manager/kidmais-manager/lib/http/pagamentos-api.ts>) | Tratamento de unicidade concorrente |
| [schemas.ts](</D:/glass/KidMais Manager/kidmais-manager/app/api/admin/pagamentos/schemas.ts>) | Valores HTTP sem coerção de booleanos |
| Rotas [recebimentos](</D:/glass/KidMais Manager/kidmais-manager/app/api/admin/pagamentos/[pagamentoId]/recebimentos/route.ts>), [estornos](</D:/glass/KidMais Manager/kidmais-manager/app/api/admin/pagamentos/[pagamentoId]/estornos/route.ts>), [plano](</D:/glass/KidMais Manager/kidmais-manager/app/api/admin/pagamentos/[pagamentoId]/plano/route.ts>), [comprovantes](</D:/glass/KidMais Manager/kidmais-manager/app/api/admin/pagamentos/[pagamentoId]/comprovantes/route.ts>) | Validação, no-store e retorno de comprovante reutilizado |
| [disponibilidade.repository.ts](</D:/glass/KidMais Manager/kidmais-manager/lib/disponibilidade/repositories/disponibilidade.repository.ts>) | Serialização dos bloqueios administrativos com reservas |
| [pagamentos-inspecao.cjs](</D:/glass/KidMais Manager/kidmais-manager/scripts/pagamentos-inspecao.cjs>) | Verificação física somente leitura |
| [pagamentos-test-support.cjs](</D:/glass/KidMais Manager/kidmais-manager/scripts/pagamentos-test-support.cjs>) | Fixtures, carregamento TypeScript, rollback e hashes |
| [pagamentos-engenharia.integration.cjs](</D:/glass/KidMais Manager/kidmais-manager/scripts/pagamentos-engenharia.integration.cjs>) | Cenários de domínio e repositórios |
| [pagamentos-http.integration.cjs](</D:/glass/KidMais Manager/kidmais-manager/scripts/pagamentos-http.integration.cjs>) | Requisições HTTP |
| [pagamentos-concorrencia.integration.cjs](</D:/glass/KidMais Manager/kidmais-manager/scripts/pagamentos-concorrencia.integration.cjs>) | Espera e liberação de locks entre conexões |
| [pagamentos.integration.cjs](</D:/glass/KidMais Manager/kidmais-manager/scripts/pagamentos.integration.cjs>) | Alias seguro do runner antigo |
| [package.json](</D:/glass/KidMais Manager/kidmais-manager/package.json>) e este relatório | Comandos reproduzíveis e documentação |

## Limites e riscos conhecidos

- A API administrativa continua bloqueada em produção até autenticação/autorização reais. Não há webhook público: um adapter futuro precisa autenticar assinatura do provedor, validar o evento e sempre fornecer uma identidade idempotente estável. `metadataProvedor` não é prova de pagamento.
- PIX e Cielo continuam desacoplados; nenhuma integração de cobrança, estorno externo, webhook ou storage cloud foi adicionada. Comprovantes guardam somente metadados: o adapter futuro deve verificar bytes, hash, permissões e armazenamento durável. O núcleo não valida a existência física do arquivo e não trata TEMP como storage final.
- Conflito fica registrado para tratamento posterior. Estorno é possível e foi testado; remarcação e resolução administrativa do conflito não são uma nova API desta etapa. Cancelamento coordenado entre domínios permanece fora do escopo.
- Estornos SOLICITADOS comprometem limite até confirmação; transições operacionais para FALHOU/CANCELADO ainda precisam de um fluxo autorizado antes da integração com adquirentes.
- Não foram executados testes de carga, queda de processo, dois commits concorrentes duráveis, assinatura OTP concorrente completa ou navegação visual. A suíte de CRM/Identidade ponta a ponta não foi integralmente reexecutada; os acessos à auditoria/histórico foram exercitados com cliente sintético. Não foi observada regressão nos cenários executados.
- O lint geral já apresentava erros fora de Pagamentos (Clientes, Fechamento, Festas e arquivos gerados em `.tmp`) e avisos em Clientes/Comercial. Eles não foram corrigidos nesta etapa. O Node ainda emite aviso de package sem tipo para os testes TypeScript; isso não impede sua execução.
- Invariantes entre tabelas são responsabilidade dos serviços transacionais. Escritas SQL externas que contornem o domínio podem produzir estados que as constraints individuais não cobrem. Migrations não foram modificadas para introduzir triggers de domínio.

**Parecer:** o núcleo de Pagamentos — Engenharia está apto à aprovação neste escopo local. A liberação para produção deve aguardar autenticação, adapters e homologação operacional dos fluxos futuros. Não iniciar Festa sem a aprovação do resultado desta etapa.
