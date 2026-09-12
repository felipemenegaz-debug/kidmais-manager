# Pagamentos — segunda passagem de validação

Data: 09/09/2026. Fonte: estado atual de `D:\glass\KidMais Manager\kidmais-manager` e PostgreSQL local. Continuação da revisão interrompida, sem reiniciar ou desfazer correções válidas. A segunda passagem está concluída no escopo de engenharia local descrito aqui. Nenhuma migration, backfill ou desenvolvimento de Festa foi realizado.

## Correções adicionais e reprodução

Os dois arquivos de teste alterados antes da interrupção, `financeiro-core.test.ts` e `idempotencia.test.ts`, foram relidos e executados antes da correção. O resultado foi **27 testes aprovados e três falhas**, reproduzindo os dois problemas:

1. UUIDs equivalentes com letras maiúsculas eram tratados como outra identidade financeira. A comparação agora normaliza exclusivamente UUIDs de pagamento, recebimento e parcela. Chaves de idempotência, provedor e referência não recebem conversão de caixa. A detecção de parcelas duplicadas também normaliza os UUIDs. Testes com UUIDs reais verificam repetição de recebimento/estorno e rejeição de alocações duplicadas com caixa diferente.
2. A tolerância de `1e-9` aceitava valores como `1.0000000001` e `0.0100000001`. A validação agora exige que o número seja exatamente representável pelo valor em centavos adotado pelo domínio, mantendo os limites de `numeric(12,2)`. A confirmação soma centavos inteiros, sem submeter resultados intermediários como `0.1 + 0.2` à validação de entrada. Na entrada HTTP, strings monetárias aceitam no máximo duas casas antes da conversão para Number, evitando que `10.0000000000000000001` vire silenciosamente 10.

Os testes unitários passaram a **30/30**. A integração confirma recebimentos de 0,10 + 0,20 + 0,29, total 0,59 e saldo 39,41, além de rejeitar subcentavos. Quatro novas requisições HTTP cobrem números e strings subcentavo e repetição com UUIDs em maiúsculas.

O teste concorrente de bloqueio administrativo foi ampliado: uma conexão segura o advisory lock da data e outra executa a criação pelo repositório de Disponibilidade. `pg_blocking_pids` comprova a espera; após rollback da primeira, a segunda prossegue e também é revertida. Isso valida a correção de Disponibilidade mantida da primeira passagem, sem nova alteração naquele código.

Não foi encontrado conflito estrutural entre essas correções e as regras fornecidas. Não houve reversão de correção válida nem necessidade de migration.

## ALTERAÇÕES DA PRIMEIRA PASSAGEM REVISADAS

O inventário anterior corresponde a **18 arquivos de código/scripts**, discriminados abaixo. `package.json` e o relatório anterior eram itens auxiliares e estão registrados separadamente para não ocultar arquivos. Os caminhos da tabela são relativos à pasta fonte indicada no início.

Cobertura: **U** = testes unitários de Pagamentos; **E** = engenharia com PostgreSQL; **H** = HTTP com handlers reais; **C** = concorrência com conexões distintas; **DB** = inspeção física somente leitura. Todas essas baterias foram executadas novamente. TypeScript, lint direcionado e build complementam a validação.

| # | Arquivo | Motivo da primeira alteração | Decisão da segunda passagem | Testes que cobrem a correção |
|---|---|---|---|---|
| 1 | `lib/pagamentos/services/pagamento.service.ts` | Invariantes, ordem de locks, limites financeiros, histórico, estornos e comprovantes | **Ajustada**: comparação de UUIDs duplicados e soma em centavos na confirmação; demais correções mantidas | E: ciclo financeiro, plano, saldo, idempotência, comprovantes e conflito; H; C; novos casos UUID/centavos |
| 2 | `lib/pagamentos/repositories/pagamento.repository.ts` | Consultas por referência/hash, existência de recebimentos e limite comprometido por estornos | **Mantida** | E: idempotência por referência, estorno solicitado, bloqueio de plano e comprovante; H; C |
| 3 | `lib/pagamentos/services/financeiro-core.ts` | Limites monetários, datas e cálculo em centavos | **Ajustada**: removida tolerância que aceitava frações de centavo | U: domínio monetário, datas e saldos; E/H: subcentavos e valores válidos |
| 4 | `lib/pagamentos/services/financeiro-core.test.ts` | Regressões de limites, datas e estados financeiros | **Ajustada e revisada após interrupção**: dois valores subcentavo adicionais | U: 25 testes deste arquivo, incluindo as duas falhas reproduzidas |
| 5 | `lib/pagamentos/services/idempotencia.ts` | Comparar vínculos, valores e alocações da identidade financeira | **Ajustada**: UUIDs equivalentes independentemente da caixa | U: cinco testes de idempotência; E/H: UUIDs reais e divergências |
| 6 | `lib/http/pagamentos-api.ts` | Traduzir unicidade financeira em HTTP 409 sem expor SQL | **Mantida** | E: tradução de violação de unicidade; H: respostas de conflito |
| 7 | `app/api/admin/pagamentos/schemas.ts` | Impedir coerção de booleanos em dinheiro | **Ajustada**: limitar casas decimais de strings antes da conversão | H: entradas inválidas, booleanos e string subcentavo; U/E: validação de domínio |
| 8 | `app/api/admin/pagamentos/[pagamentoId]/recebimentos/route.ts` | Validação e respostas sem cache | **Mantida** | H: recebimento, repetição, conflito, entradas inválidas e no-store |
| 9 | `app/api/admin/pagamentos/[pagamentoId]/estornos/route.ts` | Validação e respostas sem cache | **Mantida** | H: estorno, repetição, entradas inválidas e no-store; E: limites |
| 10 | `app/api/admin/pagamentos/[pagamentoId]/plano/route.ts` | Validação e respostas sem cache | **Mantida** | H: substituição e rejeições; E: versionamento e bloqueio após recebimento |
| 11 | `app/api/admin/pagamentos/[pagamentoId]/comprovantes/route.ts` | Retornar 200 ao reutilizar comprovante e manter validação/no-store | **Mantida** | H/E: reutilização, integridade e vínculo com outro pagamento |
| 12 | `lib/disponibilidade/repositories/disponibilidade.repository.ts` | Compartilhar lock por data entre bloqueio administrativo e reserva | **Mantida**, sem nova edição nesta passagem | C: novo teste de bloqueio administrativo; E: sobreposição/bordas; cinco unitários de Disponibilidade |
| 13 | `scripts/pagamentos-inspecao.cjs` | Conferir banco físico, objetos e casos reais sem escrita | **Mantida** | DB: sete tabelas, constraints, índices, triggers e dois casos reais |
| 14 | `scripts/pagamentos-test-support.cjs` | Fixtures sintéticas, carregamento TS, rollback e fingerprints | **Mantida** | E/H/C: execução real e igualdade de fingerprints antes/depois |
| 15 | `scripts/pagamentos-engenharia.integration.cjs` | Exercitar domínio e repositórios no PostgreSQL | **Ajustada**: dois cenários adicionais de UUID e centavos | E: 24 cenários aprovados |
| 16 | `scripts/pagamentos-http.integration.cjs` | Exercitar handlers por requisições HTTP e PostgreSQL | **Ajustada**: quatro requisições adicionais | H: 35 requisições aprovadas |
| 17 | `scripts/pagamentos-concorrencia.integration.cjs` | Demonstrar espera/liberação física dos locks e ordem consistente | **Ajustada**: criação de bloqueio administrativo concorrente | C: cinco cenários aprovados |
| 18 | `scripts/pagamentos.integration.cjs` | Substituir runner antigo por alias do runner seguro | **Mantida** | Revisão do encaminhamento; runner de destino executado nos 24 cenários E |

Itens complementares: os comandos de `package.json` foram mantidos e usados. `README_VALIDACAO_PAGAMENTOS.md` foi preservado como registro histórico, com aviso apontando para este relatório. `lib/pagamentos/services/idempotencia.test.ts`, anterior ao inventário dos 18, também foi revisado: a regressão de UUID acrescentada antes da interrupção foi confirmada e passou após a correção. Nenhum dos 18 arquivos foi revertido.

Nesta segunda passagem foram ajustados nove arquivos de código/testes: serviço, financeiro-core, idempotência, schemas, os dois testes unitários e os três runners de integração. A documentação foi atualizada separadamente.

## Regras confrontadas e impactos fora de Pagamentos

- **Contrato e Fechamento:** assinatura não cria pagamento automaticamente; criação explícita exige versão corrente assinada e estado compatível. Valor aprovado prevalece e snapshots permanecem preservados. Os testes de Contrato e preços passaram. Nenhum arquivo de código de Contrato ou Fechamento foi alterado nesta segunda passagem; o inventário da primeira também não contém alterações nesses módulos.
- **Plano:** substituição preserva versão antiga e parcelas canceladas, gera auditoria e histórico prospectivos e é bloqueada após qualquer recebimento, inclusive PENDENTE, RECUSADO e CANCELADO.
- **Recebimentos:** registro e confirmação verificam alocações, vínculo ao plano, soma e saldo. Repetições equivalentes não duplicam movimento; identidades divergentes são recusadas. A confirmação revalida saldo de recebimentos pendentes.
- **Reserva/Disponibilidade:** parcela qualificadora controla confirmação; agenda é verificada sob lock. Conflito preserva o dinheiro e registra reserva em CONFLITO, auditoria e histórico. Bordas adjacentes continuam permitidas. O único arquivo de outro módulo alterado na primeira passagem foi o repositório de Disponibilidade listado acima; foi mantido sem edição nesta segunda. O efeito externo é a espera transacional de operações na mesma data, sem tornar todo o dia indisponível por regra comercial.
- **Estornos:** SOLICITADO compromete limite estornável e CONFIRMADO altera o financeiro; confirmação posterior reutiliza identidade. Estorno não cancela reserva confirmada, não reabre pagamento CANCELADO e não apaga `quitado_em` histórico.
- **Comprovantes:** somente metadados; repetição conserva localizador original e não duplica auditoria; integridade e vínculos divergentes são rejeitados. Nenhuma integração de storage foi adicionada.
- **CRM:** nenhum arquivo de CRM/Clientes foi alterado. Há impacto funcional prospectivo nos eventos de histórico do cliente gerados por Pagamentos. As três suítes de Identidade, incluindo integração com CRM/Fechamento, passaram com rollback; transporte OTP simulado, sem mensagens reais.
- **Provedores:** não foi adicionada lógica específica de adquirente, cobrança externa ou webhook. Autorização administrativa de produção continua bloqueada conforme o estado atual do projeto.

## Banco físico e preservação dos casos reais

Inspeção final: PostgreSQL **18.6**, banco `kidmais_manager`, porta 5432. Migration 011: sete tabelas, **51 constraints nomeadas, 15 índices explícitos e quatro triggers** conferidos. Catálogo completo: 58 constraints sem NOT NULL e 27 índices, incluindo primary keys/índices gerados. Contagens finais: dois pagamentos, três planos, cinco parcelas, três recebimentos, três alocações, um estorno e um comprovante.

| Caso preservado | Estado final |
|---|---|
| `f9207fe7-ed6d-4149-a148-8143eedbd6bb` | Total/recebido 8.990,00; estorno 500,00; líquido 8.490,00; saldo 500,00; PARCIALMENTE_PAGO; reserva CONFIRMADA e Fechamento CONFIRMADO; `quitado_em` 2026-09-08T21:40:41.879Z preservado; um comprovante |
| `59dcf33b-8da1-4cae-9d4d-1f3f3dd95b31` | Total 9.290,00; sem recebimento; V1 PIX/AVISTA substituído e parcela cancelada; V2 CARTAO/PARCELADO/CIELO ativo, duas parcelas pendentes de 4.645,00; reserva PENDENTE |

A substituição antiga do segundo caso continua com auditoria e sem evento no histórico do cliente. Não foi feito backfill para preencher essa lacuna. O teste valida que novas substituições geram ambos.

As suítes de Pagamentos compararam hashes/contagens de 14 tabelas antes e depois e confirmaram igualdade. Fixtures de escrita são sintéticas e revertidas. O teste de ordem de locks usa registro real somente para leitura/lock. As suítes de identidade também finalizaram com rollback.

A comparação SHA-256 dos **75 arquivos monitorados** de Fechamento, Contrato, Clientes, Disponibilidade, migrations e schema não encontrou alteração nesta segunda passagem. `schema_mvp_kidmais.sql` não foi alterado. Nenhuma migration foi criada, alterada ou reaplicada. A pasta não dispõe de repositório Git acessível: o inventário histórico vem do relatório anterior e a preservação desta passagem foi conferida por hashes, não por diff Git.

## Resultado final das baterias

| Bateria | Resultado |
|---|---|
| Unitários Disponibilidade | 5/5 |
| Unitários Contrato | 12/12 |
| Unitários Pagamentos | 30/30 |
| Engenharia Pagamentos / PostgreSQL | 24 cenários |
| HTTP Pagamentos / PostgreSQL | 35 requisições |
| Concorrência PostgreSQL | 5 cenários |
| PricingService | 10 cenários |
| Identidade repository | 8 verificações funcionais + rollback |
| Identidade service | 9 verificações funcionais + rollback |
| Identidade/CRM/Fechamento | 4 verificações funcionais + rollback |
| TypeScript `--noEmit` | Aprovado |
| ESLint direcionado | Aprovado |
| Build Next.js | Aprovado |
| Inspeção física e preservação | Aprovadas |

Todos os comandos abaixo foram executados com sucesso após as correções:

```powershell
npm.cmd run test:disponibilidade
npm.cmd run test:contrato
npm.cmd run test:pagamentos
npm.cmd run test:pagamentos:integration
node --env-file=.env.local -r ./scripts/pagamentos-test-support.cjs -e 'require("./scripts/pricing-service.integration.ts")'
node --env-file=.env.local -r ./scripts/pagamentos-test-support.cjs -e 'require("./scripts/identidade-repository.integration.ts")'
node --env-file=.env.local -r ./scripts/pagamentos-test-support.cjs -e 'require("./scripts/identidade-service.integration.ts")'
node --env-file=.env.local -r ./scripts/pagamentos-test-support.cjs -e 'require("./scripts/identidade-fechamento.integration.ts")'
npx.cmd tsc -p tsconfig.json --noEmit
npx.cmd eslint lib/pagamentos lib/http/pagamentos-api.ts lib/disponibilidade/repositories/disponibilidade.repository.ts app/api/admin/pagamentos scripts/pagamentos*.cjs
npm.cmd run build
npm.cmd run check:pagamentos:db
```

## Limites e parecer

O HTTP usa servidor Node de loopback com NextRequest/NextResponse, handlers e PostgreSQL reais, não o transporte completo de `next dev`. O build validou a montagem das rotas. A concorrência comprova espera física e retomada após rollback; não executa dois commits concorrentes duráveis. Não foram realizados carga, falha de processo, assinatura OTP concorrente completa, navegação visual ou o script HTTP de consulta CPF dependente de servidor local. A privacidade da consulta CPF foi exercitada na suíte de serviço.

O lint direcionado passou; não se declara lint global aprovado, pois a primeira passagem registrou problemas fora do escopo. O aviso Node de package sem tipo nos testes TS permanece sem impedir a execução. A presença da rota preexistente de festas no build não representa desenvolvimento de Festa.

Continuam fora desta entrega autenticação/autorização administrativa de produção, adapters de provedores, validação de webhook, armazenamento durável de comprovantes e homologação operacional. Conflitos de agenda permanecem registrados para tratamento posterior; remarcação, cancelamento coordenado e transições operacionais de estornos para FALHOU/CANCELADO não foram adicionados. Escrita SQL que contorne os serviços não recebe todas as invariantes transacionais do domínio.

**Parecer final:** segunda passagem concluída, com os dois defeitos reproduzidos e corrigidos, correções anteriores preservadas e baterias relevantes aprovadas. O núcleo de Pagamentos está apto à aprovação no escopo local validado. Isso não equivale à liberação operacional para produção. Festa não foi iniciada.
