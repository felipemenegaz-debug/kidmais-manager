# Revisão independente classe A — Funil de oportunidades

Revise somente LOCAL, sem corrigir silenciosamente, commit, push, PR, staging ou production.

Checkout: `D:/glass/KidMais Manager/kidmais-manager-funil-oportunidades-20261114`, branch `codex/funil-oportunidades-20261114`, base `2133d398f02f519170b443b5702c6b23b9da41b7`. O diff está sem commit; **inclua os arquivos novos não rastreados**, além de `git diff`. O manifesto está em `docs/evidencias/funil-20261114/manifesto.json`.

Leia AGENTS/CLAUDE e `docs/OPERACAO_AGENTES.md`, a proposta aprovada no vault (`Funil de oportunidades proposta 20261114.md`) e `docs/FUNIL_OPORTUNIDADES_LOCAL_20261114.md`. A Área da família está antes do Funil na fila; isso não autoriza integrar ou publicar nenhum dos dois.

Focos: isolamento A/B e permissões; concorrência/ID esperado e ação única; perda obrigatória nos três caminhos; assinatura/financeiro impedindo cancelamento indevido; histórico; transferência do próximo passo; estados derivados; verdade temporal dos contadores e conversões; fotografia/idempotência/permissões do e-mail; migration 122, checks, exportação, aplicadores e preservação de marcador/COMMIT incerto. Considere os pontos compartilhados com `kidmais-manager-marketing-simplificacoes-20261114`, que foi preservado.

Provas do implementador: check estático inteiro aprovado (5.015 + 103 testes, lint 0 erros, tsc, build, worker PDF), receita PostgreSQL e suíte do funil no modelo 122 aprovadas; navegador real com dados fictícios e capturas desktop/390 px. Não houve e-mail real nem acesso a ambiente real. Limites e falhas intermediárias constam do relatório; mutantes e matriz completa de planos/unidades não foram executados.

Caso reproduza os testes, remova as variáveis herdadas `DATABASE_URL` e `KIDMAIS_HOMOLOGACAO_DATABASE_URL`. Use exclusivamente PostgreSQL descartável novo em `E:/kidmais-pg-descartavel/funil-oportunidades`, porta livre diferente de 5432/5433, identidade `kidmais_descartavel`, dados sintéticos e transportes falsos. O cluster da implementação foi apagado. Consulte a política e tenha autorização específica vigente para criá-lo; preparar a revisão não autoriza banco real. Não execute os adaptadores remotos.

Entregue todos os achados de uma vez, com prioridade, arquivo/linha, reprodução, comportamento esperado/observado e consequência. Só P1 e P2 reproduzíveis bloqueiam; P3 vai para pendências. Máximo de duas rodadas conforme a classe A; na terceira, parar e levar a Felipe. Declare testes próprios e limitações, sem tratar os logs do implementador como sua própria execução. Atualize a nota pertinente e o relato de cinco linhas ao finalizar. Limpe somente os artefatos que criar, preservando evidências.
