# Simplificação de UX — Festa

Rodada de 11/09/2026. Implementação e testes de escrita restritos ao clone. A liberação para o banco real continua pendente de autorização.

## Principais mudanças

- Central como agenda: Hoje, Próximas, Pendências e Histórico, com mensagens para listas vazias.
- Linguagem comum, botões grandes, contraste, foco visível e adaptação a desktop, tablet e celular.
- Uma ação principal por estágio; confirmação de avanços sensíveis com explicação das pendências.
- Checklist com conclusão rápida, áreas opcionais, responsável e prazo. Motivo somente nas ações sensíveis.
- Contagens, confirmação final e correções guiadas; nenhuma contagem ou cobrança fabricada.
- Pedidos de hora extra e adicionais sem confundir registro, aprovação, execução e cobrança.
- Alteração de convidados contratados encaminhada à criação de nova versão pelo fluxo existente. A quantidade solicitada é informada na justificativa; os detalhes são conferidos e editados na tela da contratação. Contratos assinados continuam preservados.
- Histórico legível, resumo financeiro e comparação da contratação anterior com a atual.
- Problemas urgentes abertos também aparecem em “O que falta fazer”.
- Conflitos preservam o rascunho e exigem consultar a informação atual antes de reenviar.
- Administração de acessos em Configurações → Usuários e acessos. Códigos granulares ficam apenas no painel avançado de suporte.

## Arquivos desta rodada

Criados:

- `app/admin/configuracoes/acessos/page.tsx`
- `components/festas/FestaAcessos.tsx`
- `components/festas/festa.module.css`
- `lib/festas/perfis.ts`
- `lib/festas/ux.ts`
- `lib/festas/perfis.test.ts`
- `scripts/festa-016-perfis.integration.cjs`
- `RELATORIO_FESTA_SIMPLIFICACAO_UX.md`

Alterados:

- `components/festas/FestaConsole.tsx` — interface operacional.
- `components/admin/AdminShell.tsx` — link de configurações visível ao representante.
- `lib/festas/service.ts` — presets transacionais/auditados e informações de leitura para a interface.
- `app/api/admin/festas/route.ts` — consulta/aplicação dos presets.
- `scripts/festa-016-browser.cjs` — testes dos novos fluxos e perfis.
- `scripts/festa-016-qualidade.cjs` — inclusão dos novos arquivos no lint.

## Mapeamento de acesso

Gestão aplica as 11 capacidades existentes:

`FESTA_CONSULTAR`, `FESTA_CRIAR`, `FESTA_OPERAR`, `FESTA_DECIDIR_SOLICITACAO`, `FESTA_CONFIRMAR_CONTAGEM_FINAL`, `FESTA_ENCERRAR`, `FESTA_CONCLUIR`, `FESTA_AUTORIZAR_EXCECAO`, `FESTA_CORRIGIR`, `FESTA_REABRIR`, `FESTA_CONFIGURAR_AREAS`.

Equipe aplica cinco:

`FESTA_CONSULTAR`, `FESTA_OPERAR`, `FESTA_CONFIRMAR_CONTAGEM_FINAL`, `FESTA_ENCERRAR`, `FESTA_CONCLUIR`.

Não foram criados papéis globais. Somente REPRESENTANTE_AUTORIZADO administra esses acessos. Alteração do próprio perfil exige confirmação explícita. Aplicação e revogação do conjunto são atômicas e auditadas; repetir o mesmo conjunto não duplica concessões.

## Validação

- 133 testes unitários: aprovados.
- Integração principal Festa: 17 verificações aprovadas.
- Integração dos perfis: aprovada, incluindo rollback integral diante de falha na auditoria, repetição, autoconcessão, operação normal e restrições de autoridade.
- Revisão de Festa, patch anterior e contagem final A/B/C/D: aprovados.
- Atomicidade e concorrência PostgreSQL das correções de contagem: aprovadas.
- Integração Contrato/Kidmais/OTP e alteração da contratação: aprovada.
- Regressões de PricingService, Identidade/CRM, Fechamento, Contrato, PIX e Pagamentos, incluindo crédito, devolução, movimentos, HTTP e concorrência: aprovadas.
- Navegador real: Gestão, Equipe e usuário sem acesso; áreas, contagem final explícita, pedidos, exceção, conclusão normal, correção, reabertura e conflito entre dois usuários. Aprovado em desktop, tablet e celular, sem erro JavaScript e sem rolagem horizontal.
- TypeScript, lint direcionado e build limpo: aprovados. O build usa cópia sem cache anterior; precisou de acesso às fontes do Google.
- Permanece o aviso preexistente do Node sobre detecção de módulos TypeScript; ele não impediu os testes.

Evidências em `.local-festa/results/`: `browser.json`, `perfis.json`, `regressions.json`, `quality.json`, `clean-build.json`, `ux-preservation.json` e capturas `festa-desktop.png`, `festa-tablet.png`, `festa-mobile.png`.

## Preservação

Migration 016 byte a byte igual. SHA-256:

`3479cd1b39e23617e71ef65af693b47a156e5915fad603534bed81d05665418d`

Migrations 012/013/014/015 e `schema_mvp_kidmais.sql` preservados. Nenhuma mudança estrutural, backfill ou escrita no banco real por esta rodada. A proteção de ambiente permanece ativa, e a consulta física confirmou que o banco real continua sem a 016.

A comparação estrita com o checkpoint antigo identificou diferenças nas três tabelas de autenticação: auditoria, sessões e limites. Há dois logins às 01:06 e 01:09 de 11/09, anteriores à implementação deste patch. As outras 49 tabelas coincidem integralmente com o checkpoint; removendo apenas esses dois novos eventos da comparação, a auditoria histórica também coincide. Não se tentou apagar ou “corrigir” esses registros.

Aguardando aprovação para qualquer próximo passo.
