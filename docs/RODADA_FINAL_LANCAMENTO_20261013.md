# Rodada final do lançamento — o que falta, pronto para executar (13/10/2026)

Complementa [LANCAMENTO_VENDA_20261011.md](LANCAMENTO_VENDA_20261011.md). Tudo abaixo está **preparado e testado localmente**; nada
foi executado em staging ou produção depois do E0. Cada bloco remoto pede autorização de Felipe antes de começar. Quem executa:
**F** = Felipe (painel do Render, Shell, navegador logado, Asaas, e-mail); **A** = agente (leitura Render MCP, git, conferências).

## Já concluído

| Item | Evidência |
|---|---|
| Validação local completa (PostgreSQL, concorrência, navegador) | [lancamento-venda-codex](evidencias/lancamento-venda-codex-20261011.md) |
| P0 e P0b em produção (somente leitura): faltam 074a–079; 5 bloqueios globais da Kidmais; nenhuma cópia na 078 | [P0](evidencias/diagnostico-production-codex-20261011.md), [P0b](evidencias/preflight-production-codex-20261011.md) |
| Backup custom de produção conferido (11/10; vale 24 h — refazer no dia da virada) | [backup](evidencias/backup-production-codex-20261011.md) |
| E0 — e-mail real de staging entregue (13/10, `e819772`) | [E0](evidencias/email-staging-execucao-20261011.md) |
| Ensaio local do reparo + 6 migrations, refeito em 13/10 com a regra robusta às datas | `.local-descartavel-pg-80c3a00aedce47ffaaf08b96219e88dc/ensaio-lancamento.json` (Git ignora) |

## Ferramentas novas (commit `7c78609`)

| Ferramenta | O que faz | Testes |
|---|---|---|
| `database/repairs/20261011_lancamento_bloqueios_kidmais.sql` | Agora robusto à data de hoje: recusa se houver global futuro **fora** dos cinco; os cinco precisam estar intactos, com qualquer data (o de 15/10/2026 não trava mais a virada) | ensaio local PASS |
| `scripts/reparo-bloqueios-production.cjs` | Executor do reparo: backup conferido, alvo/TLS, flags desligadas, marcador exclusivo | 3/3 |
| `scripts/cutover-lancamento-production.cjs` + [comando](evidencias/cutover-production-comando-20261013.txt) | Leva ao Shell de produção o aplicador, o manifesto, os 18 SQL e o reparo (SHA-256 de cada um), aplica 074a→079 em ordem, para na primeira falha, depois o reparo | 4/4 + ensaio a seco fora do repositório |
| `scripts/s3-cadastro-staging.cjs` + [comandos](evidencias/s3-staging-comandos-20261013.txt) | S3 somente leitura: antes (janela e bloqueios), depois (empresa do CNPJ sintético), restaurado | 4/4 |
| Rodapé do site | Sem “a definir” com a configuração aprovada: WhatsApp/horário/encarregado só aparecem se configurados; canal de dados = e-mail aprovado | site 8/8 |
| Termos e privacidade (`2026-10-13-minuta`) | Prazos 7/60, renovação, cancelamento e canal aprovados preenchidos; continua **minuta** | 6/6 |

Validação do conjunto: `tsc` 0; ESLint 0 erros; estática 2402/2402; scripts 228/228; `next build` OK.

## Bloco 1 — publicar a candidata em staging (A, com autorização)

1. A: `git fetch`; conferir `origin/staging` = `e819772` (se mudou: integrar e reapresentar). Render: auto-deploy OFF, sem deploy em andamento.
2. A: `git push origin <SHA da candidata>:staging` (fast-forward, sem force) e `trigger_deploy` do mesmo SHA; LIVE + health 200 + `/conheca` 200.
3. A: reapontar `s3-cadastro-staging.cjs` e `email-staging-lancamento.cjs` para o SHA novo e regerar os comandos (`node scripts/preparar-comando-s3-staging.cjs`), commit local.

## Bloco 2 — janela de staging: S3 (cadastro real) + S4 (pagamentos sandbox) juntos

Uma gravação de configuração, um deploy; no fim, uma restauração, um deploy. Antes das 20h (BRT). Sem outros testes em staging.

| # | Quem | Passo | Esperado / parada |
|---|---|---|---|
| W0 | F (Shell staging) | `cd /opt/render/project/src && node scripts/configuracao-homologacao-staging.cjs --conferir-restauracao` | `RESTAURADA`; senão parar |
| W1 | F (painel staging → Environment) | Adicionar **quatro** chaves: `CADASTRO_PUBLICO_ATIVO=true`, `USUARIOS_CRIACAO_DIRETA=desativada`, `ASSINATURA_PLANOS_ATIVOS=true`, `COTACAO_PUBLICA_POR_EMPRESA=true` → **Save, rebuild and deploy** | A acompanha um único deploy até LIVE |
| W2 | F (Shell) | Comando **S3-A** do arquivo de comandos | `PRONTO_PARA_CADASTRO`; `CADASTRO_RECUSARIA_503` → parar (bloqueio global em staging) |
| W3 | F (navegador) | `https://kidmais-manager-staging.onrender.com/cadastro`: conta com **`felipemenegaz+s3a@gmail.com`** e senha sua → abrir o link do e-mail recebido → entrar → cadastrar empresa com CNPJ **`82.654.321/0001-74`**, razão social `TESTE S3 Homologação Ltda`, nome fantasia `TESTE S3` → ver o teste de 15 dias | e-mail chega; empresa criada; teste de 15 dias |
| W4 | F (navegador, aba anônima) | Segunda conta **`felipemenegaz+s3b@gmail.com`** → confirmar → tentar o **mesmo** CNPJ | mensagem neutra (“Este CNPJ já está cadastrado…”), sem dado da empresa |
| W5 | F (Shell) | Comando **S3-B** | `S3_PASS` (1 empresa, ATIVA, teste de 15 dias vigente, 1 Gestão, sem provedor/contratação; Kidmais intacta) |
| W6 | F (Shell) | S4 — pacote [HOMOLOGACAO_PAGAMENTO_RENOVACAO_STAGING_20261010](HOMOLOGACAO_PAGAMENTO_RENOVACAO_STAGING_20261010.md) passo P3 (executor já no ar, sem push): `cd /opt/render/project/src && nohup node --experimental-strip-types scripts/homologacao-pagamento-renovacao-staging.cjs --pagamento-renovacao-rodada-3-autorizada > data/homologacao-planos-cotacao-20261010/pagamento-renovacao-saida.log 2>&1 < /dev/null &` e, ao terminar, `cat` do log | aprovado (Essencial mensal, Profissional anual, Premium mensal, renovação R0–R6) |
| W7 | F (painel) | Remover as **quatro** chaves → **Save, rebuild and deploy** | A acompanha o deploy |
| W8 | F (Shell) | Comando **S3-C** e `--conferir-restauracao` | `RESTAURADO` e `RESTAURADA` |

Interrupção do S4: `--encerrar-pagamento-renovacao-rodada-3-autorizada` (ver pacote), depois W7–W8. Efeitos permanentes em staging:
a empresa `TESTE S3` (em teste, depois somente leitura), duas contas `+s3a/+s3b`, três vagas Fundador de staging confirmadas (S4).

## Bloco 3 — virada de produção (depois do Bloco 2 PASS e dos dados da seção final)

| # | Quem | Passo | Esperado / parada |
|---|---|---|---|
| P1 | F | Backup do dia: painel Recovery (anotar hora PITR) + Shell de produção com [o comando do backup](evidencias/backup-production-comando-codex-20261011.txt) | `BACKUP_CUSTOM_CONFERIDO_SEM_RESTORE` + caminho do registro |
| P2 | F (Shell produção, ≤ 10 min) | [Comando da virada](evidencias/cutover-production-comando-20261013.txt), trocando `REGISTRO_BACKUP` pelo caminho do P1. **Pausar edição do catálogo do buffet e da agenda até P4** | `CUTOVER_BANCO_PASS` (074a…079 + reparo). `PARADO` → não repetir; conferir por leitura |
| P3 | A + F | PR `staging` → `production`; conferir auto-deploy OFF; merge | `production` = SHA da candidata |
| P4 | F/A | Deploy manual do SHA; health 200; P0 de novo (`node scripts/diagnostico-lancamento-production.cjs --diagnostico-somente-leitura`) | `ausentes: []`, `bloqueiosGlobaisAtivosFuturos: 0`, Kidmais `empresas 1`, sem assinatura/contratação |
| P5 | F (painel produção) | Variáveis, **uma etapa por vez** com smoke: (1) `EMAIL_PROVIDER=resend`, `EMAIL_REMETENTE=Kidmais Manager <nao-responda@notificacoes.kidmaisfestas.com>`, `RESEND_API_KEY` (chave de produção); (2) `USUARIOS_CRIACAO_DIRETA=desativada`; (3) `ASSINATURA_REGULARIZACAO_DIAS=7`, `ASSINATURA_SOMENTE_LEITURA_DIAS=60`; (4) `ASAAS_AMBIENTE=producao`, `ASAAS_API_KEY` (`$aact_prod_…`), `ASAAS_WEBHOOK_TOKEN` + webhook no Asaas em `https://manager.kidmaisfestas.com/api/integracoes/asaas/webhook`; (5) `SITE_URL`, `SITE_RAZAO_SOCIAL`, `SITE_CNPJ`, `SITE_ENDERECO`, `SITE_ATENDIMENTO_EMAIL` ([valores aprovados](CONFIGURACAO_VENDA_APROVADA_20261011.json)); (6) `SITE_PRECOS_PUBLICADOS=true`; (7) `ASSINATURA_PLANOS_ATIVOS=true` | cada etapa: health 200 e a tela correspondente |
| P6 | F (Render → New Cron Job) | Conferência diária: repositório, branch `production`, comando `node scripts/assinatura-cron.cjs`, agenda `0 9 * * *` (06:00 BRT); variáveis `KIDMAIS_DEPLOY_ENV=production`, `KIDMAIS_RECONCILIAR_MODO=conferir`, `KIDMAIS_RECONCILIAR_DATABASE_URL` (URL **interna** do banco de produção), `KIDMAIS_RECONCILIAR_ALVO=kidmais_production@dpg-dak750gae00c73fudmg0-a:5432`, `KIDMAIS_RECONCILIAR_SCHEMA_VALIDADO=074-075`, `DATABASE_SSL` igual ao web, `ASAAS_AMBIENTE/ASAAS_API_KEY/ASAAS_WEBHOOK_TOKEN` iguais ao web; notificação de falha ligada. “Trigger run” uma vez | saída 0, `kidmais.violada: false` |
| P7 | F | **Por último:** `CADASTRO_PUBLICO_ATIVO=true` | `/cadastro` abre |
| P8 | F | Primeira venda assistida (Essencial mensal, cobrança real), webhook confirma, nota emitida no Asaas; conferência do dia seguinte com saída 0 | PASS |

Recuperação: variáveis em ordem inversa (cadastro primeiro); código → redeploy anterior; banco → nunca DOWN com dados (correção para
frente); P2 interrompido → marcadores impedem repetição, conferir por leitura antes de qualquer passo.

## Dados que só Felipe pode fornecer (bloqueiam o Bloco 3)

1. **Asaas de produção:** conta do CNPJ vendedor ativa; chave `$aact_prod_…` e token de webhook novos, digitados por você no
   Render; **configuração fiscal da NFS-e no Asaas** (código de serviço, regime, alíquota — não inferidos) e a **razão social fiscal
   exata** (o site usa “Kidmais Festas”).
2. **Resend de produção:** chave própria de produção (domínio `notificacoes.kidmaisfestas.com` já verificado).
3. **Textos legais:** revisar a minuta `2026-10-13` e decidir as cinco lacunas — devolução de valores, prazo de retenção depois do
   encerramento, acordo de tratamento de dados com os clientes, lista de suboperadores e encarregado (ou canal) de dados. Com a
   revisão aprovada, a versão final sai com `minuta: false`.
4. **Opcional:** WhatsApp e horário de atendimento (`SITE_ATENDIMENTO_WHATSAPP`, `SITE_ATENDIMENTO_HORARIO`) e encarregado de dados
   (`SITE_ENCARREGADO_DADOS`). Vazios, não aparecem no rodapé; a linha legal mostra “Privacidade e dados pessoais: felipemenegaz@gmail.com”
   (canal aprovado), sem nomear encarregado. O WhatsApp também liga os botões “Falar com a equipe” e “Quero ser fundador”.

## Autorizações, em ordem

Bloco 1 (push + deploy em staging) → Bloco 2 (janela W0–W8) → P1 → P2 → P3–P4 → P5 (por etapa) → P6 → P7 → P8.
