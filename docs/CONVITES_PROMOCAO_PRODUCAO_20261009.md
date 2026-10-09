# Convites — candidata de produção

Preparada em 09/10/2026. Estado: **código validado; operação de produção aguarda autorização e conferência do schema**.

## Candidata e escopo

- Base de produção: `27f6902617a48f18bb60364c4af6fb51c107de1f`, mesma versão do deploy live consultado `dep-db3lg4om7kps73f5vlk0`.
- Branch de revisão: `codex/convites-producao-20261009`, destino proposto `production`.
- Código de convites extraído da versão homologada `3ca3c526d2673b3b135b4d3276e22ef1b248a49d`, com teste integrado e registro de aceite de `cdae01f`.
- Inclui editor do buffet/cliente, biblioteca de 12 opções, foto/upload, PNG, publicação, página pública temática, RSVP, famílias, links individuais, cotas e proteções do adaptador de IA.
- Inclui migrations 073/074, seus prechecks/postchecks, inventário operacional e testes. Corrigido o registro da 074 no inventário; as afirmações sobre aplicação permanecem `unknown`.
- Exclui a frente de site/assinatura de staging e as migrations 074a/075. O adaptador de IA entra no código, mas a proposta de liberação é exclusivamente o fluxo gratuito.

## Evidências

O usuário confirmou o piloto real em staging. A candidata sobre a base de produção passou em 2.111 testes unitários gerais, 103 testes do harness com mocks, lint sem erros, TypeScript, build Next.js, verificação do worker PDF, 37 testes operacionais e fluxo integrado de navegador com três sessões independentes e APIs simuladas.

O inventário de migrations local passou e reconhece a 074; isso não comprova aplicação no banco remoto. A primeira checagem TypeScript encontrou tipos de rotas antigos da outra branch; regeneração por `next typegen` e build concluíram com sucesso.

Metadados consultados: produção usa branch `production`, auto-deploy OFF, start `npm start`, workspace `tea-daidbj95efls73d2bcf0`, serviço `srv-dak77m2d0e5s73b8rkkg`, URL `https://kidmais-manager-production.onrender.com`. Health somente GET passou com banco/Festa/OTP prontos. Não houve consulta SQL, backup, migration, alteração de env ou deploy de produção nesta preparação.

Logs locais ignorados: `.local-convites-qa/promocao-static.log`, `promocao-build.log` e `promocao-operacional.log`. Os testes de serviço/UI usam dados fictícios e não comprovam locks ou persistência remotos. Os ensaios de schema/migrations já realizados em staging estão documentados em `CONVITES_V1_20261008.md` e `CONVITES_FAMILIAS_074.md`.

## Operação proposta para aprovação

Alvo: exclusivamente o serviço de produção acima e seu banco remoto esperado `kidmais_production`. Confirmar nome, host, SSL e identidade antes de acessar; não usar bancos locais ou staging como destino.

1. Revalidar branch, auto-deploy, SHA live e candidata aprovada. Confirmar a origem HTTPS efetivamente usada pelo Manager antes de fixar `CONVITES_PUBLIC_ORIGIN`.
2. Conferir configuração por nomes/presença sem revelar secrets. Conferir schema por consultas estruturais somente leitura: dependências da 073, eventual aplicação anterior de 073/074, prechecks/postchecks adequados ao estado encontrado. Aplicação parcial, divergência ou dependência ausente interrompe a operação; não reaplicar por suposição.
3. Criar backup custom completo recente no disco persistente, com permissões restritas, SHA-256 e inventário legível. Registrar que conferir inventário não equivale a restaurar o backup. Não copiar dados de clientes para logs ou conversa.
4. Se ausentes e com prechecks aprovados, aplicar 073 e depois 074 nas respectivas transações; respeitar timeouts de lock, executar postchecks e conferir resultado após COMMIT. A 073 cria nove tabelas; a 074 cria uma tabela e coluna/constraints/índice de famílias. Sem backfill de contratos, sem créditos automáticos, sem apagar registros existentes.
5. Integrar o PR revisado em `production`, mantendo convites desativados até schema e código compatíveis. Disparar deploy manual e acompanhar build/live/SHA e health.
6. Habilitar `CONVITES_ENABLED=true`, definir `CONVITES_PUBLIC_ORIGIN` com a origem confirmada e manter `CONVITES_IA_ENABLED=false`. Conferir `FESTA_ENABLED=true`. Alteração de env pode iniciar novo deploy; acompanhar a versão efetivamente live e evitar deploy duplicado.
7. Conferir health, acesso administrativo e controles públicos por leitura. Nenhuma geração paga, mensagem real ou dados de teste no banco de produção fazem parte da operação proposta. Registrar evidências de aplicação, flags e versão.

## Recuperação

Antes de COMMIT de cada migration, falha implica rollback da transação em andamento. Se a 073 concluir e a 074 falhar, manter o módulo desligado e investigar o estado parcial entre etapas.

Após COMMIT, preservar tabelas e dados. Em falha de ativação, desabilitar `CONVITES_ENABLED` e manter `CONVITES_IA_ENABLED=false`, acompanhando o deploy correspondente. Se necessário, retornar ao SHA live anterior registrado, somente dentro da autorização operacional. Não executar DROP ou restore geral automaticamente; isso exige plano e autorização próprios.

## Autorização pendente

O aceite do piloto de staging não autoriza a operação de produção. A política `docs/OPERACAO_AGENTES.md` exige autorização explícita para deploy, alterações de env e migrations de produção. A aprovação solicitada cobre conferência estrutural, backup, aplicação condicional de 073/074, integração da candidata, deploy e ativação do fluxo gratuito conforme o procedimento acima. Qualquer efeito fora desse escopo exige revisão.
