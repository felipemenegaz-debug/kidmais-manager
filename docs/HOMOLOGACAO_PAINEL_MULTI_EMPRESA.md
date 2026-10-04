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
6. Homologar explicitamente a seleção: conta existente Gestão em uma empresa e Equipe na outra, escolha inicial, alternância, Clientes/Contratos/Financeiro/Agenda, segunda aba, tentativa de id de outra empresa e API de Gestão negada em Equipe. Conferir sessão selecionada invalidada ao suspender/revogar e sessão da outra empresa preservada.
7. Com e-mail real desligado, o teste ponta a ponta de recebimento de convite e recuperação em staging permanece **pendente**. Nesta etapa, validar os avisos de não enviado/indisponibilidade e os fluxos com fixtures apenas onde autorizado. Não expor tokens pela UI nem habilitar provedor `arquivo` em Render para contornar essa pendência.
8. Encerrar com SHA, tree, deploy ID, health, logs sanitizados, cenários aprovados/pendentes e plano de retirada da concessão/fixtures. A entrega real de e-mails exige decisão de provedor, credencial configurada sem exposição e homologação própria antes de ser declarada operacional.
