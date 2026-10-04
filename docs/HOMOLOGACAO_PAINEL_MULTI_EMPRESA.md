# Seleção de empresa e homologação do painel

Revisão de 04/10/2026 sobre `2b6702a`. Destino: PR #95, base `staging`.
Esta entrega não autoriza merge, migration em staging, concessão real nem deploy.

## Contexto e segurança

- A 063 ainda não publicada ganha `sessoes_administrativas.empresa_ativa_id` e gatilhos que revogam as sessões selecionadas quando empresa ou membership deixa de estar ATIVA. Sessions de outra empresa ficam intactas. Reativação não restaura uma seleção encerrada.
- Escolha explícita por POST autenticado, origem e CSRF. Prova e revalidação usam as mesmas travas de tenant dos serviços. Token/CSRF rotacionam sem estender expiração ou o marco da autenticação. Login com uma empresa pode escolher automaticamente; duas empresas exigem seleção.
- O contexto retornado pelo servidor governa menu e páginas. Parâmetro `empresaId` divergente é recusado. Cada operação de negócio revalida membership e papel.
- Troca por navegação completa: estados, URLs de entidades, conversas, rascunhos e Router Cache da empresa anterior são descartados. Sinal entre abas sem dados de negócio, com revalidação no foco e a cada 15 s. Pedidos do helper carregam a sessão da página e não devolvem resultados depois de uma mudança de contexto.
- Cadastro/logo do Perfil comprovam o tenant antes de resolver sua associação ao cadastro legado; perfil ausente/ambíguo retorna 409. Não se cria um Perfil/unidade automaticamente para uma nova contratante.
- Reautenticação do painel compara `autenticado_em` com `consultado_em`, ambos do PostgreSQL. Janela inclusiva de 300.000 ms; futuro e dados inválidos recusados. Trocar empresa não reinicia essa janela.
- Leitura de sessão permanece compatível com schema pré-063 (`to_jsonb`); seleção explícita não instalada retorna 409. Rollback do schema recusa se a seleção já foi usada, além das proteções anteriores. Retornar código não restaura sessões revogadas.

## Renovação de sessão e trocas durante operações (rodada 4, sobre `c0158d4`)

- **Defeito corrigido.** Reautenticar (e trocar a própria senha) emite uma sessão nova; o cliente tratava qualquer `sessaoId` novo como troca de contexto e mandava para o dashboard, então o "confirme a senha e continue" do painel e o "reautenticar e aplicar" do Perfil não concluíam.
- **Renovação comprovada.** A resposta da reautenticação (`POST /api/admin/autenticacao`, `acao: reautenticar`) e da troca de senha devolvem `renovacao: { anterior, atual }`, emitida pelo servidor para a sessão que fez o pedido; a empresa ativa é copiada para a sessão nova. O cliente (`lib/http/contexto-empresa-cliente.ts`) só aceita a troca quando: a renovação foi iniciada por esta página, `anterior` é exatamente a sessão que a página tinha, a sessão lida em seguida é `atual` e a empresa continua a mesma. Qualquer outra troca de sessão — inclusive na mesma empresa — continua descartando a página. Login e seleção explícita de empresa não devolvem renovação.
- **Senha incorreta** mantém sessão, empresa, tela, diálogo/rascunho e formulário (nenhum descarte).
- **Troca de empresa/sessão ou suspensão durante uma operação** (`adminFetch`): nunca repete uma requisição; descarta a página (navegação completa) e deixa um aviso com o resultado real — mudou antes do envio ou o servidor recusou pelo contexto antigo (409): "Nada foi alterado/enviado"; escrita respondida com sucesso e contexto trocado depois: "concluída antes da mudança… confira o resultado"; escrita com 5xx ou sem resposta (conexão): "Resultado incerto… nada é reenviado automaticamente". A reautenticação só repete a operação após a recusa `REAUTENTICACAO`, que acontece antes de qualquer escrita.
- **Suspensão da empresa selecionada exige novo login**, mesmo com outra membership ativa (a sessão selecionada é revogada pela 063; as outras empresas continuam acessíveis após entrar de novo).
- **Perfil ausente** continua limitação explícita de implantação: contratante nova não ganha Perfil/unidade automaticamente; a tela responde 409.
- **Regressão encontrada e corrigida (pré-063).** A regressão PostgreSQL completa mostrou que, no `c0158d4`, quem tinha duas empresas e pedia `empresaId` explícito era recusado também nos schemas SEM a 063 (atual/061/062), onde a seleção nem existe — perdendo todo o acesso entre o deploy do código e a migration. Agora `consultarSessao` distingue "seleção não instalada" (pré-063: regra legada, o `empresaId` escolhe entre as memberships ativas) de "nenhuma empresa selecionada" (com a 063: a seleção explícita vale e o `empresaId` divergente é recusado). O teste `tenant-festa` passou a selecionar a empresa da sessão no estado 063, como a interface faz.

Evidências desta rodada (cluster sintético exclusivo em `127.0.0.1:55503`, diretório `ambientes-locais/pg-descartavel-painel-063-r4`; porta, diretório, `cluster_name` e processo conferidos e registrados antes da primeira conexão; identidade provada sem `kidmais_manager`; removido ao final):

| Verificação | Resultado |
|---|---|
| `painel-063.postgres.test.ts` (inclui renovação comprovada no servidor) | 21/21 |
| `scripts/painel-reauth-ui.cjs` — Painel: senha incorreta mantém sessão/empresa/diálogo/tela; correta conclui uma vez (403 REAUTENTICACAO → 200, 1 auditoria), sem recarregar | Passou |
| Perfil: senha incorreta preserva rascunho, formulário e motivo; correta aplica uma vez (1 `PERFIL_CADASTRO_APLICADO`), sem recarregar | Passou |
| Troca de empresa antes do processamento: "Nada foi alterado", tela descartada, 1 envio, nenhum rascunho salvo | Passou |
| Troca depois da escrita e antes da resposta: "concluída antes da mudança", tela descartada, executada uma vez | Passou |
| Suspensão durante a escrita com resposta perdida: "Resultado incerto", 1 envio; sessão encerrada → login | Passou |
| `scripts/painel-multi-ui.cjs` (regressão da seleção multiempresa) | Passou |
| Testes unitários do cliente (`lib/http/contexto-empresa.test.ts`) | 11/11 |
| `tenant-festa` nos estados atual/061/062/063 + `hg8-tenant` (atual/063) + suíte da 063 | 7 execuções, 79/79 |
| Regressão PostgreSQL completa (`check:v1:postgres`, todos os modelos) | PASS: 38 execuções, 258/258 (antes da correção pré-063: 8 falhas em `tenant-festa`) |
| Estática (`check:v1:static`: testes, ESLint, tsc, build) · `production:test` · `otp-staging` | PASS: 1882 + 103 · 37/37 · 3/3 |

Os dois testes de interface foram reexecutados com o código final (depois da correção pré-063) e passaram. O cluster da rodada foi parado e removido (`pg_ctl status` 3, diretório inexistente); relatórios em `ambientes-locais/pg-descartavel-painel-063-r4-relatorios`. E-mail real desligado em todas as execuções.

Reprodução: como abaixo, depois `node --experimental-strip-types scripts/painel-reauth-ui.cjs` (porta web 3138 livre; Playwright por `KIDMAIS_PLAYWRIGHT_MODULE`). O teste envelhece só sessões sintéticas para passar da janela de 5 min e intercepta a consulta de CEP (nada sai da máquina).

## Falha na confirmação da sessão depois da operação (rodada 5)

- **Defeito corrigido.** Se a leitura da sessão feita logo após a resposta falhasse (rede, HTTP não-2xx ou corpo inválido), `adminFetch` entregava a resposta ao componente sem confirmar que a empresa/sessão continuavam as mesmas — por exemplo, dados da empresa anterior depois de uma troca em outra aba.
- **Agora** nenhuma resposta chega ao componente sem a confirmação. Falha na confirmação = contexto desconhecido: a tela é descartada (navegação completa) com aviso.
  - Leitura: "Não foi possível confirmar a empresa ativa depois da leitura. Os dados recebidos foram descartados por segurança."
  - Escrita já respondida com sucesso: continua **concluída** ("A operação foi concluída, mas não foi possível confirmar a empresa ativa em seguida…") — não vira "resultado incerto" só porque a confirmação falhou.
  - Escrita com 5xx: resultado incerto; recusa (4xx): não concluída; escrita com resposta perdida: continua incerta.
  - Falha na confirmação ANTES do envio: nada é enviado nem entregue (só a mensagem de erro).
  - Nada é reenviado automaticamente em nenhum caso.

| Verificação (cluster sintético exclusivo em `127.0.0.1:55503`, diretório `ambientes-locais/pg-descartavel-painel-063-r5`, destino conferido e registrado antes de conectar, removido ao final) | Resultado |
|---|---|
| Unitários do cliente (`lib/http/contexto-empresa.test.ts`): GET com falha por rede/HTTP 500/corpo inválido; escrita confirmada, 5xx, 4xx e perdida com falha; falha antes do envio | 16/16 |
| Interface, cenário 6: o GET do Perfil responde com dados da Alfa, a empresa é trocada e toda confirmação falha → dados nunca entregues ao formulário (detector no navegador; controle positivo no carregamento normal), tela descartada com o aviso de leitura | Passou |
| Interface, cenário 7: escrita confirmada + troca + falha na confirmação → aviso "concluída…", sem "incerto", 1 envio, executada uma vez | Passou |
| O mesmo teste contra o `admin-fetch.ts` anterior (`660c216`) | Falhou no cenário 6 (sem descarte), como esperado |
| Demais cenários de `painel-reauth-ui.cjs` e `painel-multi-ui.cjs` | Passaram |
| `painel-063.postgres.test.ts` | 21/21 |

Esta rodada só alterou o cliente (`lib/http/admin-fetch.ts`) e testes; a regressão PostgreSQL completa de `660c216` (258/258) segue válida para o servidor.

## Evidências locais

PostgreSQL 18, cluster sintético criado exclusivamente em `127.0.0.1:55501`, com `cluster_name=kidmais_descartavel`, papel `kidmais_descartavel`, diretório `ambientes-locais/pg-painel-multi-codex-20261004`. Porta e diretório livres antes da criação; a receita confere endereço, porta, usuário, cluster e ausência do banco real antes de escrever. O PostgreSQL de outra sessão na porta 55498 não foi utilizado.

Suíte `lib/desenvolvedor/painel-063.postgres.test.ts`: 20/20. Inclui rollback/reaplicação, convites, papéis, suspensão e senha da entrega anterior; nesta revisão também seleção persistida, prazo preservado, sessão antiga/pedido em voo recusados, parâmetro de outra empresa, escolha sem membership, suspensão da seleção e preservação de outra sessão.

`scripts/painel-multi-ui.cjs`: teste completo em Chrome isolado, aplicação Next real e banco sintético. E-mail real `desativado`; o convite é uma fixture local, com token apenas em memória. Nenhum envio real foi feito.

| Cenário pela interface | Resultado |
|---|---|
| Conta existente em Alfa aceita convite para Beta usando a senha atual | Passou; mesma identidade, nova membership |
| Escolhe Alfa, Gestão; Clientes só mostra Cliente exclusivo Alfa UI | Passou |
| Escolhe Beta, Equipe; só cliente de Beta e sem Usuários e acessos no menu | Passou |
| API de Usuários em Beta e query pedindo Alfa enquanto Beta está ativa | 403 |
| Segunda aba com Alfa ao trocar a primeira para Beta | Reiniciada, sem dados anteriores |
| Sessão/token anterior e cabeçalho de contexto antigo | 401 e 409 |
| POST de escolha sem CSRF | 403 |
| Volta para Alfa | Cliente/permissões de Alfa, nenhum cliente de Beta |
| Suspende Alfa, reativa, faz login novamente | Seleção antiga invalidada; escolha explícita novamente |
| Revoga membership em Beta | Sessão selecionada invalidada |

Artefatos locais em `.local-painel-multi-ui`: `resultado.json`, `alfa-gestao.png`, `beta-equipe.png`. Logs de execução em `.local-multi-*.log`. Arquivos não versionados; nenhum token/senha vai no relatório de resultado. O runner encerra navegador e servidor Next ao terminar. Cluster sintético fica parado ao final da revisão.

Testes dos limites do relógio: agora, 299.999 ms, 300.000 ms aceitos; 300.001 ms, futuro de 1 ms/90 s/3 min, carimbo inválido e ausência de relógio comum recusados. A fonte PostgreSQL funciona independentemente do relógio da aplicação. CI no SHA final da PR deve confirmar testes estáticos, lint, TypeScript, build, `production:test` e `otp-staging`; o E2E/PG é opt-in local e não é atribuído ao job estático do GitHub.

Reprodução: criar e provar um cluster sintético novo; preencher `KIDMAIS_POSTGRES_DESCARTAVEL=kidmais_pacotes_v1_descartavel`, `KIDMAIS_DESCARTAVEL_PORTA` e `KIDMAIS_DESCARTAVEL_AUTORIZACAO=127.0.0.1:<porta>/kidmais_pacotes_v1_descartavel`. Rodar o runner com `KIDMAIS_POSTGRES_SOMENTE=lib/desenvolvedor/painel-063.postgres.test.ts` para construir o modelo 063; depois `node --experimental-strip-types scripts/painel-multi-ui.cjs`, com Playwright instalado/disponível por `KIDMAIS_PLAYWRIGHT_MODULE` e Chrome disponível. O E2E restaura **só o banco de trabalho sintético** do runner; exige porta 3137 livre e não carrega `.env`.

## Plano concreto de staging — execução ainda pendente

1. Obter autorização para merge da #95, aplicação da 063 em staging, concessão temporária de teste e deploy. Revalidar SHA final/head/base, CI, diff completo da 063 revisada, serviço `srv-daif418ae00c73e8k2gg`, branch `staging`, auto-deploy e fila. Se o escopo/head mudar, revisar antes de agir.
2. Confirmar banco de staging por identidade, preparar export e recuperação conforme o plano operacional. Registrar os hashes da migration, precheck e postcheck que serão usados. Não reaproveitar a cópia anterior da 063.
3. Merge no SHA aprovado. Com auto-deploy desligado, aplicar a 063 autorizada, após seu precheck; exigir postcheck completo. Não criar concessões pela migration. Só então publicar manualmente o commit de merge e confirmar SHA/tree, deploy, health e logs sanitizados.
4. Manter `EMAIL_PROVIDER=desativado`. Conceder temporariamente o painel apenas à conta sintética de homologação pelo CLI autorizado. Usar duas empresas de teste identificadas e dados fictícios; nenhuma concessão a usuário real nesta etapa.
5. Homologar o painel e os roteiros da documentação: acesso negado, interessada sem efeitos, provisionamento, menu por papel, própria senha e reautenticação (0, limite de 5 min e excedido), suspensão/reativação e auditoria.
6. Homologar explicitamente a seleção: conta existente Gestão em uma empresa e Equipe na outra, escolha inicial, alternância, Clientes/Contratos/Financeiro/Agenda, segunda aba, tentativa de id de outra empresa e API de Gestão negada em Equipe. Conferir sessão selecionada invalidada ao suspender/revogar e sessão da outra empresa preservada. Registrar que a suspensão da empresa selecionada exige novo login, mesmo com outra membership ativa.
6a. Homologar a reautenticação depois de 5 min: no painel (alterar papel) e no Perfil da empresa (reautenticar e aplicar) — senha incorreta mantém tela, sessão, empresa e rascunho; senha correta conclui uma única vez, sem recarregar. Homologar a troca de empresa em outra aba durante uma edição: a tela é descartada com aviso e nada é reenviado. O Perfil só pode ser homologado em empresa que já tenha Perfil (contratante nova: limitação de implantação, 409 esperado).
7. Com e-mail real desligado, o teste ponta a ponta de recebimento de convite e recuperação em staging permanece **pendente**. Nesta etapa, validar os avisos de não enviado/indisponibilidade e os fluxos com fixtures apenas onde autorizado. Não expor tokens pela UI nem habilitar provedor `arquivo` em Render para contornar essa pendência.
8. Encerrar com SHA, tree, deploy ID, health, logs sanitizados, cenários aprovados/pendentes e plano de retirada da concessão/fixtures. A entrega real de e-mails exige decisão de provedor, credencial configurada sem exposição e homologação própria antes de ser declarada operacional.
