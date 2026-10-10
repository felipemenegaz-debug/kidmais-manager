# Financeiro completo por plano — Etapa 3 (10/10/2026)

Implementação local da barreira de servidor para contas a pagar, fluxo de caixa e relatórios, conforme a [matriz dos planos](MATRIZ_RECURSOS_PLANOS_20261010.md). Não houve consulta ou escrita em banco, mudança de ambiente nem deploy.

## Regra

- Matriz única em `lib/assinatura/recursos-plano.ts`: `FINANCEIRO_COMPLETO` = Profissional e Premium. Pix e contas a receber são de todos os planos.
- Só o contrato **confirmado** atual restringe (`planoConfirmado`, mesma leitura que limita vagas). Teste de 15 dias, legado, empresa isenta (Kidmais incluída) e schema 074 ausente mantêm o recurso.
- Plano desconhecido falha fechado: 503 `PLANOS_NAO_DISPONIVEIS`; nunca concede recurso pago.
- Empresa sempre a do tenant comprovado pela sessão; nenhum plano/empresa vindo do navegador.
- Nenhum dado é apagado; exportação continua com contas a pagar.

## Caminhos cobertos

| Caminho | Essencial |
|---|---|
| `GET/POST /api/admin/financeiro/contas-pagar` | 403 `RECURSO_FORA_DO_PLANO` |
| `GET /api/admin/financeiro/fluxo-caixa` e `/relatorios` | 403 |
| `POST /api/admin/festas/[id]/financeiro` (despesa) | 403 |
| `GET /api/admin/festas/[id]/financeiro` | só recebimentos; custos/margem/caixa nulos, sem ler contas a pagar |
| `GET /api/admin/dashboard` e `/api/admin/financeiro` | sem contas a pagar (não lidas nem materializadas) |
| Atenção hoje (IA) | já usava só recebíveis |
| IA `criar_conta_pagar` | recusada na revisão e na execução |
| IA `onde_encontrar` contas a pagar | explica que não faz parte do plano, sem link |
| IA `analisar_pagamentos` | evidência aponta para contas a receber |
| Menu (`/api/admin/autenticacao` → `recursos.financeiroCompleto`) | esconde Contas a pagar, Fluxo de caixa e Relatórios |

Menu e telas são conveniência; a barreira é o servidor.

## Evidências locais

| Validação | Resultado |
|---|---|
| Testes novos (`recursos-plano`, navegação, `recursos-plano-ia`): matriz, isolamento entre empresas, serviço sem tocar `financeiro_contas_pagar`, cobertura estática de todas as rotas que chamam os serviços do financeiro completo | 11/11 |
| `npm run test:inteligencia` | 457/457 |
| Todos os testes unitários sem banco (258 arquivos) | 2188/2188 |
| Testes unitários do `check:v1:static` | 2189/2189 |
| Harness staging (mocks) | 103/103 no caminho real |
| ESLint `.` | 0 erros (1 aviso preexistente em `lib/inteligencia/skills/catalogo.ts`) |
| TypeScript, build, worker de PDF (check e asset) | aprovados |

`*.postgres.test.ts` não executados (exigem banco isolado autorizado). Harness staging falha só quando executado via unidade `subst` (checagem de import por caminho); no caminho real passa.

## Render conferido antes do push (leitura de metadados, workspace `tea-daidbj95efls73d2bcf0`)

| Serviço | Branch | Auto-deploy |
|---|---|---|
| `kidmais-manager-staging` `srv-daif418ae00c73e8k2gg` | staging | OFF |
| `kidmais-assinatura-reconciliar-staging` `crn-db493i142hec73ahmoe0` | staging | OFF |
| `kidmais-manager-production` `srv-dak77m2d0e5s73b8rkkg` | production | OFF |

Push em `staging` não dispara deploy pela configuração lida. Nenhum deploy realizado.

## Pendências

- Homologação em staging com empresas sintéticas Essencial, Profissional e isenta (pacote a preparar junto da cotação por empresa).
- Horário nobre no Essencial e cotação pública por empresa seguem pendentes de definição/homologação.

Recuperação: reverter o commit desta etapa restaura o comportamento anterior; não há migration nem dado alterado.
