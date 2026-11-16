# Revisão local da F1 — Minha festa — 14/11/2026

**REPROVADA.** Revisor: Codex. Base `2133d398f02f519170b443b5702c6b23b9da41b7`, branch `codex/area-familia-20261114`, alterações não commitadas. Nenhuma correção de implementação, commit, push, chamada a serviço real ou migration em banco real nesta revisão.

Escopo: decisões aprovadas e Modelo/Resultado da F1 na nota `Area da familia proposta 20261114`. Mantidos os desvios declarados: APIs sob o path do cookie; documento atual do cliente; CPF opcional por HMAC do segundo responsável; ausência de gatilho em festas por causa da assinatura 016; tabelas fora da exportação; aviso ao e-mail antigo adiado. Não são motivos de reprovação.

## Achados consolidados

### AF-R1 — P1 — OTP do contato antigo continua abrindo sessão após troca

Referências: `database/migrations/20261114_123_area_familia.sql:384-409`; `lib/area-familia/acesso.ts:174-217`.

Os gatilhos de alteração de contato revogam sessões existentes, mas não invalidam as validações PENDENTE. `confirmarEntrada` não vincula a prova à versão do contato para o qual o código foi enviado. Reproduzido no PostgreSQL real sintético, com gatilhos ligados: gerar link, iniciar entrada e capturar OTP simulado, mudar o WhatsApp, confirmar com o OTP antigo e ler a nova sessão. Tanto contratante quanto segundo responsável obtêm sessão válida com lembrar (até 30 dias). O antigo destinatário pode recuperar acesso depois de a equipe atualizar o contato, durante a validade de dez minutos do código.

Correção esperada: invalidar as provas pendentes na troca de contato e serializar emissão/consumo com essa troca. Cobrir a sequência reproduzida e concorrência com duas conexões; apenas revogar sessões já existentes não fecha essa janela. O aviso adiado ao e-mail antigo não resolve nem justifica esta falha.

### AF-R2 — P2 — Comparação do CNPJ descarta letras

Referências: `lib/area-familia/tokens.ts:23-24`; `lib/area-familia/acesso.ts:62-66`.

`documentoConfere` normaliza CNPJ alfanumérico, mas reutiliza `hashDocumentoPessoa`, que remove tudo que não é dígito. Reproduzido com cliente PJ válido de teste: cadastro `12ABC34501DE35`, entrada `123450135`, resultado `ok: true` e emissão do desafio. Documentos diferentes podem produzir o mesmo HMAC, enfraquecendo a primeira prova de identidade. O OTP permanece obrigatório; não foi observado acesso sem OTP.

Correção esperada: preservar letras em maiúsculas na representação canônica do CNPJ e testar documento correto, documento sem letras e troca de letras. Manter a normalização de CPF e seu armazenamento por HMAC.

### AF-R3 — P2 — Consulta do painel não exige Gestão

Referências: `app/api/admin/festas/[festaId]/area-familia/route.ts:35-42`; `components/festas/FestaConsole.tsx:99`.

O GET comprova tenant, mas não chama `exigirGestaoNoTenant`; o cartão também é montado para não gestores, ocultando apenas os botões de ação. Pelo requisito desta revisão (painel só Gestão), operadores podem consultar responsáveis, validade de links e aparelhos conectados indevidamente. Reproduzido executando o handler real transpilado com autenticação/tenant simulados como OPERADOR: HTTP 200 e chamada ao resumo, zero chamadas à guarda de Gestão. O POST possui a guarda correta; não foi demonstrado vazamento entre empresas.

Correção esperada: aplicar a guarda na consulta dentro da transação comprovada e restringir a renderização do cartão. Testar GET e POST por papel.

### AF-R4 — P3 — Postcheck aprova ausência do check de finalidade

Referência: `database/checks/20261114_123_postcheck.sql:16-17`.

A subconsulta retorna NULL se `validacoes_identidade_cliente_finalidade_check` não existe; `NULL NOT LIKE ...` não entra no IF. Reproduzido removendo a constraint dentro de uma transação no descartável e executando o corpo do postcheck: aprovado. Transação revertida em seguida. A migration íntegra cria a constraint corretamente.

Correção recomendada: exigir a existência na relação/schema corretos e recusar resultado nulo; ampliar a conferência aos checks recriados da 010. Não bloqueia isoladamente.

## Validações e limites da evidência

- Git: HEAD/base e branch conferidos; diff rastreado e arquivos novos lidos; `git diff --check` sem erros.
- Unitários da área: 9/9 PASS.
- PostgreSQL 18.6 descartável próprio: loopback 127.0.0.1:55839, papel e cluster `kidmais_descartavel`; identidade validada pelo harness. Suíte original: 10/10 PASS, sem conexões pendentes.
- Montagem inicial falhou no postcheck preexistente da 116 por CRLF. Repetição bem-sucedida com normalização CRLF → LF apenas em memória na leitura dos SQL pelo harness, sem regravar o código candidato.
- Reproduções adicionais: três cenários PG confirmados (duas trocas de contato e CNPJ); handler GET com dependências simuladas confirmou AF-R3. Os testes de reprodução afirmam a presença da falha, portanto PASS nesses testes significa defeito confirmado.
- Postcheck íntegro PASS; rollback sem uso PASS; precheck após rollback PASS; reaplicação da 123 e postcheck PASS. AF-R4 confirmado separadamente em transação revertida.
- Leitura confirmou checks de consumo com AREA_FAMILIA/CONFIRMADA proibida, vínculo diferido da prova à sessão, imutabilidade em UPDATE de sessão e UPDATE/DELETE de eventos, revogações, predicado de acesso, prazos de 12 h/30 dias, fim do dia pós-festa em America/Sao_Paulo, atributos do cookie, limites fora da transação e fallback restrito a 42P01. Nenhum novo achado sobre esses pontos além dos listados.
- Sem P0 identificado. Não repetidos build, lint, tsc, suíte estática inteira ou mutantes; resultados anteriores são do implementador. Não executado navegador/TLS; o ciclo real do cookie continua sem essa prova.

Evidências preservadas em `D:/glass/KidMais Manager/ambientes-locais/revisao-af-20261114/`: `pg-suite-lf.log`, `reproducoes.log`, `revisao-local.postgres.test.ts`, `get-painel.cjs`, `get-painel.log`, `schema.cjs`, `schema.log`, `runner.cjs`. A reprodução PG reutiliza a fixture da suíte original e deve ser posicionada temporariamente no mesmo diretório da suíte para resolver imports. Cópia temporária removida do clone após a rodada; cluster parado e removido, preservando evidências. Dependências e `.next` preexistentes preservados.

Próximo: corrigir AF-R1–AF-R3 localmente, acrescentar as regressões e retornar para a segunda rodada restrita às correções. AF-R4 pode acompanhar como ajuste não bloqueante. Nenhuma autorização operacional decorre deste parecer.

## Rodada 2 — revisão do delta, 14/11/2026

**APROVADA**, com uma pendência P3 de integração do teste. Revisor: Codex (não atribuir este parecer a outro modelo). Mesma base e branch da rodada 1, sem commit. AF-R1, AF-R2, AF-R3 e AF-R4 fechados; nenhum P0/P1/P2 identificado no delta solicitado. A reprovação acima permanece como histórico da rodada 1.

### Fechamento dos achados

- AF-R1 (P1): função de cancelamento chamada antes da derrubada de sessões; emissão trava pessoa e cliente; HMAC vincula código ao cliente, destino e vencimento. Trocas sequenciais dos dois responsáveis, defesa sem gatilho e concorrência de emissão/consumo passaram no PostgreSQL sintético. Na confirmação, a troca espera a validação e revoga a sessão após o COMMIT. A prova concorrente fornecida exercita o contratante; o segundo responsável tem prova sequencial e revisão da trava de pessoa.
- AF-R2 (P2): canonização preserva letras maiúsculas; CNPJ correto mascarado/minúsculo aceita, sem letras ou com letras trocadas recusa. CPF mantém normalização de máscara.
- AF-R3 (P2): GET chama a guarda de Gestão dentro da transação de tenant, antes do resumo; cartão condicionado a Gestão. GET/POST por papel passaram executando handler real com dependências simuladas.
- AF-R4 (P3): oito CHECKs qualificados por relação/tipo/validação, definição NULL recusada e função exigida. Provas negativas independentes passaram; rollback remove a função nova e reaplicação passa.

### AF-R2-OBS1 — P3 — executor canônico reprova o teste concorrente

Referência: `lib/area-familia/area-familia.postgres.test.ts:509-522` (especialmente chamada de emissão em autocommit na linha 520).

O runner `scripts/regressao-v1-postgres.cjs`, selecionando somente a suíte da área, executou 13/13 testes com sucesso, mas seu resultado final foi FALHA por quatro ocorrências da guarda de ordem: duas LINHA sem configuração e duas LINHA fora de transação. O detector classifica os SELECTs que fazem JOIN em tabelas da agenda e FOR UPDATE OF p/v como LINHA, embora os alvos explícitos das travas sejam da área. Além disso, duas chamadas auxiliares do teste concorrente usam autocommit, fora do contrato transacional declarado pelos serviços. Não foi demonstrada regressão funcional ou de autorização por isso; é uma pendência da integração da prova com o harness. Ajustar o teste/protocolo e tratar a classificação por alvos de trava de forma justificada, sem desabilitar globalmente a guarda. Os 13/13 não devem ser apresentados como aprovação integral do runner canônico.

### Validações independentes e limites

- HEAD `2133d398f02f519170b443b5702c6b23b9da41b7`, branch `codex/area-familia-20261114`; diff-check sem erros. Revisão focada nos arquivos/correções declarados, sem reabrir a F1 inteira.
- Unitários 11/11 e rota 4/4 PASS.
- PostgreSQL 18 descartável próprio em 127.0.0.1:55843, cluster/papel kidmais_descartavel: 13/13 PASS, zero conexões pendentes; resultado agregado do runner FALHA conforme P3 acima. SQL normalizado CRLF→LF só em memória, incluindo a 116.
- Postcheck íntegro PASS; cada um dos oito CHECKs removido, finalidade NOT VALID e função ausente recusados. Rollback no modelo vazio, precheck, reaplicação e postcheck PASS.
- Mutantes N1–N9/M1–M11, smoke, static completo, lint, tsc, build e PDF não repetidos: resultados relatados pelo implementador, não certificados de novo nesta rodada. Navegador/TLS segue sem validação.
- Tentativas iniciais de conexão local foram impedidas pelo sandbox/ciclo do processo; execução local autorizada fora do sandbox concluiu as provas. Nenhum banco real ou serviço externo acessado.
- Evidências: `D:/glass/KidMais Manager/ambientes-locais/revisao-af-r2-20261114/` (runner, pg-suite.log, schema.cjs, schema.log, pg.log). Cluster parado e pgdata removido após conferência do caminho; nenhuma dependência/build criado. Script de limpeza recusou inventário de processos no sandbox, sem remover nada; dependências e build preexistentes preservados.

Próximo: organizador registrar o P3, sem terceira rodada por ele. Este aceite local não autoriza commit, push, PR, deploy nem banco real. Código candidato não foi corrigido pelo revisor.
