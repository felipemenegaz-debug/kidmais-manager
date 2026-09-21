# Correção da edição de V2 antes do aceite do cliente

## Problema e escopo

O caminho anterior de `operarContrato(editar_festa)` encaminhava a revisão inicial a `editarFechamentoAdministrativo`. Esse serviço protege o fechamento inteiro quando encontra qualquer assinatura histórica. Assim, a assinatura Kidmais preservada na V1 encerrada impedia salvar V2.

A proteção da edição direta do fechamento permanece. A nova revisão passa por uma autorização específica da versão, sob os locks de fechamento, contrato, fluxo e versão:

- versão pertence ao contrato e corresponde à edição selecionada;
- ponteiro de preparação aponta para essa versão;
- versão `ATIVA`, edição `EM_ELABORACAO`;
- nenhuma assinatura da própria versão, independentemente das assinaturas anteriores;
- revisão otimista corresponde à enviada pelo operador; contrato cancelado continua recusado.

## Persistência e formalização

Antes da primeira formalização, a proposta fica em `contrato_edicoes.dados_fonte.revisaoInicial` e no snapshot da V2. Esse campo JSON já existe: **não há migration**. O cálculo comercial é compartilhado com a edição administrativa, mas não persiste fechamento, adicionais reais ou aprovação do fechamento durante o salvamento da proposta.

Reabrir a edição lê os dados propostos. Observações documentais não sobrescrevem as alterações materiais. As diferenças são calculadas contra a versão de origem. Motivo e autor são auditados. Uma substituição posterior por V3 copia a proposta sem alterar provas da V1/V2.

Na dupla assinatura, a mesma transação revalida o destino, confere a base do fechamento, aplica os dados propostos e segue a formalização 019. Falha de agenda ou auditoria desfaz assinatura, documentos novos, promoção e Festa juntos. Não há promoção durante o salvamento.

Contratos já formalizados continuam usando a preparação operacional 014, preservando Festa, ocupação vigente e mecanismos existentes de proteção provisória de destino. Nenhuma alteração nas migrations 014/019 ou no financeiro. Pagamentos e recebimentos realizados permanecem intactos.

Correções cadastrais feitas na proposta inicial ficam no contrato; o formulário informa que o cadastro CRM não é alterado nesse caminho. Os demais caminhos mantêm o comportamento anterior.

## Homologação física

Banco exclusivamente local `kidmais_smoke_patch_final_test`, PostgreSQL 18.6, host `127.0.0.1`, porta `55439`, usuário `smoke_patch_test`, schema 001–019 (incluindo 006a). O runner não carrega dotenv, não cria bancos e não aplica migrations. Recusa conexão sem autorização explícita ou fora desse destino. Confere a identidade no servidor antes dos fixtures.

Com o ambiente descartável já preparado e a variável `FESTA_019_TEST_URL` apontando exclusivamente para ele:

```text
node scripts/contrato-revisao-inicial.integration.mjs --authorize-disposable
```

Foram aprovados **24 cenários físicos**, cobrindo:

- V1 com assinatura Kidmais e V1 com dupla assinatura;
- edição separada de convidados, pacote, data/horário, adicionais e buffet;
- reabertura, diferenças V1/V2 e salvamento documental;
- snapshots, PDFs, comprovantes e assinaturas antigas preservados;
- fechamento/Festa vigentes e fatos financeiros preservados ao salvar;
- recusa de versões assinadas, congeladas, encerradas ou fora da preparação;
- retries sem versões duplicadas;
- conflito ao salvar e conflito surgido depois do PDF;
- rollback após salvar a versão e rollback após iniciar a formalização;
- nova assinatura Kidmais obrigatória;
- duas transações simultâneas de aceite com uma única Festa;
- destino proposto aplicado somente após a dupla assinatura;
- substituição sucessiva V2 → V3, com revogação do acesso anterior.

Os valores de identidade usados na homologação são sintéticos, com sender local injetado; não há envio externo nem alteração de provider/secret persistido.

## Regressão e limites

- Testes de editabilidade: `lib/contratos/services/revisao-inicial.test.ts`.
- Regressões de revisão pré/pós-assinatura, fila, lixeira, Festa 019 e origem administrativa.
- `npm run production:test`.
- `npm run check:v1:static` (testes, lint, TypeScript e build).
- `npm run build`.
- `git diff --check`.

A homologação não verifica production, Render ou entrega real de OTP. Depois que novas propostas isoladas forem gravadas, não se deve retornar ao código anterior presumindo que ele compreende esse formato: ele não possui o caminho de edição/promoção da proposta inicial. Planejar eventual rollback de código levando as propostas pendentes em conta.

## Resultado final desta validação

**GO para commit**, sem commit, push ou deploy nesta execução.

- 24 cenários físicos aprovados.
- 143 testes direcionados aprovados (incluem os 16 novos testes de editabilidade).
- 30 testes de production readiness aprovados.
- 325 testes na suíte estática; lint, TypeScript e build aprovados.
- Build separado aprovado; `git diff --check` aprovado.
- 14 indicadores de integridade zerados e postcheck oficial 019 aprovado.
- Instância descartável encerrada após os testes.

### Arquivos do patch

- `app/api/admin/contratos/versoes/[versaoId]/edicao/route.ts`
- `components/admin/EdicaoFesta.tsx`
- `lib/contratos/services/administrativo.service.ts`
- `lib/contratos/services/contrato-publico.service.ts`
- `lib/contratos/services/fluxo-publico.ts`
- `lib/contratos/services/revisao-inicial.ts`
- `lib/contratos/services/revisao-inicial.test.ts`
- `lib/contratos/services/revisao-pre-assinatura.test.ts`
- `lib/contratos/services/revisao-pos-assinatura.test.ts`
- `lib/fechamentos/services/edicao-administrativa.service.ts`
- `scripts/contrato-revisao-inicial.integration.mjs`
- `docs/VALIDACAO_REVISAO_V2.md`
