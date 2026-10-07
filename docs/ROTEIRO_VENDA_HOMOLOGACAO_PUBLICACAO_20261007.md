# Venda do Kidmais Manager — roteiro de homologação e publicação (07/10/2026)

Nada aqui foi aplicado em staging ou production. Merges, deploys, migrations, e-mail real e pagamentos reais dependem
de autorização de Felipe, etapa por etapa (docs/OPERACAO_AGENTES.md).

## PRs (ordem de dependência)

| # | PR | Base | Migration | Depende de |
|---|---|---|---|---|
| 1 | #115 painel: checklist de implantação e alertas | `staging` | — | — |
| 2 | #110 E3 modelo comercial (já existia) | `staging` | 067 | — |
| 3 | #116 guarda da assinatura, teste por CNPJ, eventos | `staging` (contém #110) | 068 | #110 |
| 4 | #117 E4 paywall, tela Assinatura, exportação | #116 | — | #116 |
| 5 | #118 E5 painel comercial | #117 | — | #117 |
| 6 | #119 E6/E7 cadastro público e início guiado | #118 | 069 | #118 |
| 7 | #120 E8 cobrança Asaas (só sandbox) | #117 | — (usa 068) | #117 |
| 8 | esta PR (documentação operacional) | `staging` | — | — |

PRs empilhadas: o CI do GitHub roda só em PRs para `staging`/`main`; as evidências delas são os gates locais no SHA
exato (descritos em cada PR). Ao fazer merge de uma base, mudar a base da seguinte para `staging` e o CI roda.

Ordem de merge sugerida: #115 → #110 → #116 → #117 → #118 → #119 → #120 (a #120 e a #118 são irmãs sobre a #117; a segunda a entrar precisa de rebase). Depois de cada merge em `staging`,
aguardar CI verde no SHA de `staging`.

## Migrations por ambiente

Sempre: precheck → migration → postcheck, em janela autorizada, com backup antes; rollback só se o arquivo `_down`
aceitar (todos recusam com dados).

| Ordem | Migration | Staging | Production |
|---|---|---|---|
| — | 063, 064 | aplicadas | **estado a confirmar** (janela de 07/10 01:08–01:23 UTC sem registro; rodar o diagnóstico v7 somente leitura) |
| — | 066 (Pix) | conferir | não aplicada (fora da candidata de production) |
| 1 | 067 | — | — |
| 2 | 068 | — | — |
| 3 | 069 | — | — |

Sem a 067, o paywall e a tela Assinatura tratam toda empresa como "sem cobrança" (comportamento de hoje). Sem a 069,
o cadastro responde indisponível.

## Configuração (nomes; valores só no Render)

| Variável | Para | Padrão |
|---|---|---|
| `ASSINATURA_TESTE_DIAS` | duração do teste | 15 |
| `ASSINATURA_PRECO_MENSAL_CENTAVOS`, `ASSINATURA_PRECO_ANUAL_CENTAVOS` | preço por ciclo | ausente = "a definir", sem checkout |
| `CADASTRO_PUBLICO_ATIVO` | abrir o cadastro | desligado |
| `USUARIOS_CRIACAO_DIRETA=desativada` | pré-requisito do cadastro (E1) | criação direta ligada |
| `EMAIL_PROVIDER`, `RESEND_API_KEY`, `EMAIL_REMETENTE` | e-mail (D1) | desativado |
| `RECUPERACAO_SENHA_ATIVA` | recuperação pública | desligada |
| `ASAAS_AMBIENTE`, `ASAAS_API_KEY`, `ASAAS_WEBHOOK_TOKEN` | cobrança (só sandbox nesta entrega) | ausente = cobrança indisponível |

## Homologação em staging (depois dos merges e da 067/068/069 autorizadas)

1. Diagnóstico v7 de staging (leitura): 067/068/069 presentes, nada parcial.
2. Painel: resumo com alertas; ficha com checklist, situação comercial, representação.
3. Empresa sintética de teste (nunca a Kidmais): extensão de teste, cortesia, revogação — auditadas.
4. Paywall: empresa sintética com teste vencido → somente leitura (POST 402); exportação CSV; bloqueada → tela de suspensão.
5. E-mail: roteiro do `EMAIL_TRANSACIONAL_D1_20261007.md` com endereços `@resend.dev`.
6. Cadastro: `CADASTRO_PUBLICO_ATIVO=true` em staging; conta sintética `+teste`, CNPJ fictício com DV válido; CNPJ
   repetido; e-mail repetido; início guiado; celular.
7. Cobrança sandbox (#120, com chave e webhook do sandbox criados por Felipe): checkout, webhook do sandbox, pagamento simulado, atraso, cancelamento.
8. Kidmais real em staging: continua sem cobrança, nada muda; importação/IA da Kidmais como antes.
9. Desfazer o que for sintético (suspender empresas sintéticas; nunca apagar).

Scripts locais de evidência: `scripts/painel-implantacao-ui.cjs`, `scripts/assinatura-paywall-ui.cjs`,
`scripts/cadastro-publico-ui.cjs` e as suítes `*.postgres.test.ts` (PostgreSQL descartável).

## Publicação em production (depois de staging homologado)

1. Confirmar o estado real de production (diagnóstico v7).
2. Concessão de desenvolvedor de Felipe (se faltar): blocos `cutover/concessao-desenvolvedor-20261007/`
   (`VERIFICAR` somente leitura; `CONCEDER` usa a função oficial do CLI, auditada). Exige a 063.
3. Candidata = `staging` homologado; CI no SHA exato; janela com manutenção, export, 067→068→069, postchecks.
4. Deploy; health; Kidmais segue sem cobrança.
5. Só depois, e com decisões tomadas: e-mail real, cadastro aberto, preços, Asaas produção (autorização própria).

## Decisões comerciais e jurídicas pendentes

| # | Decisão | Estado no código |
|---|---|---|
| D1 | provedor e domínio de e-mail | Resend integrado; desligado |
| D2 | entidade vendedora, regime, NFS-e | nada implementado |
| D3 | provedor de cobrança | Asaas (sandbox) |
| D4 | teste por CNPJ completo ou raiz | completo |
| D5 | duração e início do teste | 15 dias configurável (proposta de 06/10 dizia 30), início na criação |
| D6/D7 | o que exige representação aprovada; contratos já enviados | representação registrada e decidida; nenhuma ação ainda depende dela; contrato público fora do paywall |
| D8 | regularização / somente leitura / retenção | 7 / 60 dias (hipótese); retenção a definir |
| — | preços, descontos, impostos, inadimplência | nada definido; preço só por configuração |
| D11 | termos, privacidade, DPA | minutas versionadas com `[A DEFINIR]` |

## Custos novos

Nenhum recurso pago criado. Potenciais: tarifas Asaas por cobrança (ver doc da cobrança), plano do Resend, tarefa
agendada no Render para reconciliação/lembretes (não criada), instância para PITR no ensaio de restauração (não criada).
