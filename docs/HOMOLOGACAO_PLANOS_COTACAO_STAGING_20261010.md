# Homologação em staging — financeiro por plano e cotação por empresa (pacote preparado em 10/10/2026)

**Status: PREPARADO, NÃO EXECUTADO.** Este documento não autoriza deploy, mudança de env, SQL ou chamadas ao Asaas. Cada operação O1–O5 abaixo precisa de aprovação explícita de Felipe para o alvo indicado ([OPERACAO_AGENTES.md](OPERACAO_AGENTES.md)).

## O que será homologado

1. **Financeiro completo por plano** (commit `a17e6d6`, já em `staging`): Essencial recusado no servidor; Profissional, teste e isenta liberados; Pix e contas a receber em todos.
2. **Cotação pública por empresa** (commit candidato desta etapa): `/b/<empresas.codigo>/fechamento` e `/disponibilidade`, chave `COTACAO_PUBLICA_POR_EMPRESA`, plano `ORCAMENTO_ONLINE` (Profissional e Premium), situação comercial e isolamento. O endereço atual (`/fechamento`, `/disponibilidade`, empresa por `AGENDA_PUBLICA_EMPRESA_ID`) precisa continuar idêntico.

## Alvo exato

| Item | Valor |
|---|---|
| Workspace Render | `tea-daidbj95efls73d2bcf0` |
| Web staging | `kidmais-manager-staging` `srv-daif418ae00c73e8k2gg`, branch `staging`, auto-deploy OFF (conferido em 10/10/2026) |
| Cron staging | `crn-db493i142hec73ahmoe0` — **não** alterado nem reimplantado |
| Banco | `dpg-daidko3m8hqs73ce4jt0-a` / `kidmais_staging_1z91`, TLS |
| Asaas | ambiente `sandbox` |
| Produção | não tocada em nenhuma etapa |

Guardas do executor (mesmas do ensaio de 09/10, `scripts/assinatura-staging-ensaio.cjs` `alvo()`): `RENDER=true`, `RENDER_SERVICE_ID=srv-daif418ae00c73e8k2gg`, `KIDMAIS_DEPLOY_ENV=staging`, `ASAAS_AMBIENTE=sandbox`, host/banco/porta acima, `current_database()='kidmais_staging_1z91'`, sem parâmetros `ssl*` na URL. Qualquer divergência encerra antes de escrever.

## Fixtures (IDs reservados; nunca reutilizar em outra rodada)

Convenção do ensaio anterior: nome `TESTE Kidmais — planos/cotação staging 20261010`, e-mail `@example.invalid`, CNPJ sintético com dígitos válidos ≠ `20119900000160`, senha aleatória só em memória, nada apagado ao final.

| Fixture | Empresa | Usuário (Gestão) | `codigo` | Estado comercial | Como chega lá |
|---|---|---|---|---|---|
| F1 Essencial | `878a2c39-19e5-4d2a-82a7-223b893352c9` | `11e5006f-68d0-4182-9b12-da048b3f7db8` | `hml-planos-essencial` | contrato Essencial CONFIRMADO | checkout + confirmação sandbox (fluxo do ensaio) |
| F2 Profissional | `d1787a4c-aaeb-4eb6-99a1-9659feb3902f` | `4aa233ad-6c4f-41bb-ae7f-62996c1b5018` | `hml-planos-profissional` | contrato Profissional CONFIRMADO | idem, plano `profissional` |
| F3 Isenta | `6dfd58f1-91fa-4202-9ace-72d705390272` | `7ff5a408-d1da-4813-99a9-0ebd1cf7511e` | `hml-planos-isenta` | `assinatura_isencoes` (sem histórico de provedor) | SQL na transação da fixture |
| F4 Teste | `092c5201-91c1-446e-90e8-cea19831e749` | `9029758e-317b-4c4e-95c6-685ac990a956` | `hml-planos-teste` | `empresa_assinaturas` TESTE vigente (15 dias) | SQL na transação da fixture |

E-mails: `hml-planos-<8 primeiros hex do usuário>@example.invalid`. Nenhuma fixture recebe Fundador intencionalmente; se a oferta vier com Fundador (vaga ainda livre em staging), o executor **para antes do checkout** para não consumir vaga (critério de parada S4).

Catálogo mínimo, criado pelos serviços de domínio (padrão de `scripts/adicionais-ui.cjs`), só em F1, F2 e F4: pacote `POCKET` vigente, faixas publicadas (`gravarFaixasPacote`) e disponibilidade em todas as configurações de agenda ativas (`definirDisponibilidadePacoteAdmin`). Sem unidade cadastrada, a agenda usa o escopo da empresa inteira (`escopoDaEmpresa`). F3 fica sem catálogo (só financeiro). Lançamentos financeiros sintéticos: 1 conta a pagar em F2, F3 e F4, criada pela API da própria empresa, para verificar que ela continua visível; nenhuma em F1.

## Operações que exigem aprovação (enumeradas)

| # | Operação | Efeito | Duração/custo |
|---|---|---|---|
| O1 | Deploy manual em staging do commit candidato da branch `staging` (após push revisado) | build com `check:v1:static` e reinício do web staging; cron intocado | ~6 min; plano starter atual |
| O2 | Env staging (web): definir temporariamente `COTACAO_PUBLICA_POR_EMPRESA=true` e `ASSINATURA_PLANOS_ATIVOS=true` | habilita o endereço por empresa e a oferta de checkout; mudança de env reinicia/reimplanta o web | ~6 min por mudança |
| O3 | Executor no Web Shell do `srv-daif418ae00c73e8k2gg`: fixtures F1–F4, catálogo, 2 checkouts e 2 confirmações sandbox (F1, F2), webhook do sandbox reutilizado ou criado como no ensaio | escrita em `empresas`, `usuarios_administrativos`, `memberships`, `empresa_assinaturas`, `assinatura_contratacoes`, `assinatura_isencoes`, `pacotes`/faixas/disponibilidade e `financeiro_contas_pagar` **somente dos IDs acima**; 2 clientes/assinaturas fictícios no Asaas sandbox | ~25 min; sessão Shell cobrada por duração |
| O4 | Verificação HTTP e somente leitura (matriz abaixo) contra `https://kidmais-manager-staging.onrender.com` | sem escrita além dos pedidos de fechamento de F2/F4 marcados “sintético” | incluído em O3 |
| O5 | Encerramento: remover assinaturas sandbox, webhook só se criado pela rodada, desativar F1–F4 (usuário `ativo=false`, membership `REVOGADA`, empresa `DESATIVADA`), remover as duas variáveis de O2 e conferir ausência | staging volta à configuração anterior; dados sintéticos preservados como histórico | ~10 min |

## Matriz de aceite (O4)

Financeiro (sessão de cada fixture):

| Pedido | F1 Essencial | F2 Profissional | F3 Isenta | F4 Teste |
|---|---|---|---|---|
| `GET /api/admin/financeiro/contas-pagar` | 403 `RECURSO_FORA_DO_PLANO` | 200 com a conta sintética | 200 | 200 |
| `POST …/contas-pagar` (criar) | 403, nada gravado | 200 | 200 | 200 |
| `GET …/fluxo-caixa`, `…/relatorios` | 403 | 200 | 200 | 200 |
| `GET /api/admin/financeiro` | 200, `financeiroCompleto:false`, sem contas a pagar | `true` | `true` | `true` |
| `GET /api/admin/dashboard` | 200, `financeiroCompleto:false` | `true` | `true` | `true` |
| `GET /api/admin/financeiro/contas-receber` | 200 | 200 | 200 | 200 |
| `GET /api/admin/autenticacao` → `recursos.financeiroCompleto` | `false` | `true` | `true` | `true` |
| `GET …/contas-pagar?empresaId=<F2>` com sessão de F1 | recusado pelo Tenant Context (sem dado de F2) | — | — | — |

Cotação pública:

| Pedido | Esperado |
|---|---|
| Antes de O2: `/b/hml-planos-profissional/fechamento` e `/api/fechamentos/pacotes?empresa=hml-planos-profissional` | 404 `COTACAO_PUBLICA_INDISPONIVEL` |
| Com O2: `/b/hml-planos-profissional/fechamento`, `/disponibilidade` | 200 |
| `/api/fechamentos/pacotes?empresa=hml-planos-profissional` | 200, só o `POCKET` de F2 |
| `/api/fechamentos/pacotes?empresa=hml-planos-teste` | 200, só o catálogo de F4 |
| `…?empresa=hml-planos-essencial` (Essencial) | 404 idêntico ao de código inexistente |
| `…?empresa=hml-inexistente`, `…?empresa=HML_RUIM` | 404 idêntico |
| `/api/disponibilidade?inicio&fim&empresa=hml-planos-profissional` | 200, `comercial` vazio (sem ajustes legados da instalação) |
| `/api/fechamentos/tabela-pacotes?empresa=…` | 404 |
| `POST /api/fechamentos?empresa=hml-planos-profissional`, `NOVO_CLIENTE`, dados sintéticos | 201; fechamento com `empresa_id` = F2 |
| mesmo POST com `CLIENTE_EXISTENTE` | 409 `IDENTIDADE_NAO_DISPONIVEL` |
| Endereço atual da Kidmais em staging: `GET /api/fechamentos/pacotes`, `/api/disponibilidade?inicio&fim` (sem `empresa`) | mesma resposta de antes de O1 (hash comparado), sem POST |
| Contagem de `fechamentos`, `clientes`, `financeiro_contas_pagar` de empresas fora de F1–F4 | inalterada (hash agregado antes/depois, como no ensaio) |

## Critérios de parada

- S1 guarda de alvo/banco/TLS divergente, ou qualquer fixture/ID/e-mail/código já existente.
- S2 resultado divergente da matriz em F1 (vazamento de recurso pago) ou qualquer dado de outra empresa na resposta.
- S3 hash agregado de empresas fora das fixtures diferente.
- S4 oferta com Fundador para as fixtures, assinatura sandbox duplicada ou callback não processado em 3 min.
- S5 erro de build/health após O1 ou O2.

Em qualquer parada: executar O5 imediatamente, registrar evidência sanitizada e não repetir sem nova aprovação.

## Recuperação

- Código: `git revert` do commit candidato em `staging` e novo deploy autorizado; nenhuma migration envolvida.
- Env: remover `COTACAO_PUBLICA_POR_EMPRESA` e `ASSINATURA_PLANOS_ATIVOS` (O5); com a chave ausente, todo endereço por empresa volta a 404.
- Dados: fixtures desativadas, nunca apagadas; assinaturas sandbox removidas; Kidmais e demais empresas não são escritas.

## Antes de pedir a aprovação

- Escrever o executor `scripts/homologacao-planos-cotacao-staging.cjs` a partir deste roteiro, reaproveitando `alvo`, `documento`, `cookies` e `prepararWebhook` de `scripts/assinatura-staging-ensaio.cjs`, com flag única `--rodada-1-autorizada`, arquivo de estado no disco do serviço e limpeza no `finally`; testes offline das guardas e da matriz.
- Push revisado do commit candidato para `staging` (sem deploy).

## Limitações conhecidas (bloqueiam liberação comercial, não a homologação)

- Identificação de cliente existente (`/api/identidade/*`) e índice global de CPF não são por empresa: no endereço por empresa só há cadastro novo; um CPF já cadastrado em outra empresa pode ser recusado.
- O assistente de fechamento ainda exibe marca/textos da Kidmais (logo e frases); os contatos e o PDF da Kidmais já são ocultados no endereço de outra empresa. Falta a identidade pública por empresa (perfil).
- Empresa com mais de uma unidade não consegue enviar pelo endereço público (escolha de unidade ainda inexistente na tela).
- Endpoints públicos sem limite de taxa.
- Horário nobre por plano aguardando decisão.
