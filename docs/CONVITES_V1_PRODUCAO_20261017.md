# Convites V1 — candidata de produção (17/10/2026)

Estado: **candidata validada localmente; publicação depende da migration 079 em produção (autorização própria) antes do deploy.**

## Estado lido antes da preparação (17/10, somente leitura)

| Item | Valor |
|---|---|
| Produção web | `srv-dak77m2d0e5s73b8rkkg`, branch `production`, auto-deploy OFF, LIVE `4af8b38` (PR #149), deploy `dep-db49tpu7bikc73e2l4lg` (09/10) |
| Staging web | `srv-daif418ae00c73e8k2gg`, LIVE `2879336` (PR #170), auto-deploy OFF |
| Cron | só existe o de staging (`crn-db493i142hec73ahmoe0`); produção não tem cron — nada a publicar nele |
| Health de produção | `ok`, database/festa/otp `ready` |
| Convites em produção | **ligado** (rota pública responde 404 do serviço, não 503) |
| Schema de produção | P0 de 11/10 (`diagnostico-lancamento-production.cjs`): faltam 074a–079; 073/074 presentes. Nenhum registro posterior de migration em produção |

## Escopo

Base: `origin/production` (`4af8b38`). Entram somente os arquivos de Convites da V1 de staging (`58477ea`, PR #163) e as correções de convites posteriores à promoção de 09/10 que a V1 já continha (#150–#153, bloqueio após falha incerta, recuperação manual 079, arte própria como fundo completo):

- `components/convites/**`, `lib/convites/**` (incluindo `referencias/` privadas e `acervo/`), `public/convites/modelos/*`, `public/dicionarios/pt-BR/*`;
- migration 079 com precheck, postcheck e rollback (hashes idênticos aos aplicados em staging);
- inventário de produção (`scripts/production/check-migrations.mjs`) com **apenas** a 079 acrescentada; receita PostgreSQL com o estado `079`;
- CI: passo do teste de exportação da arte completa;
- `scripts/migration-079-production.cjs` (+ teste): aplicador manual de produção;
- harness `scripts/convites-postgres.cjs` atualizado para as dependências da V1 (`estilos`, provedor completo sintético) e dois cenários do convite completo.

Fora: `lib/acessos/convites.ts` (convites de acesso de usuários e limites de plano/074a), 074a–078, site/assinatura, WhatsApp, laboratório (proxy, fixtures, limite ilimitado, servidor local), aplicador da 079 de staging.

Diferença de `lib/convites`, `components/convites`, `public/convites`, `public/dicionarios` e rotas `app/**/convite*` para a V1 de staging: **nenhuma**.

## Dependência de schema: 079 antes do deploy

O `consultar` do buffet lê `resolucao_*` e a recuperação usa `reserva_microusd`: sem a 079, abrir o editor do buffet falharia em produção (o módulo hoje está ligado). A 079 é aditiva (colunas com default/nulas, CHECK ampliado, índice parcial), em transação única com `lock_timeout` 5 s, e **o código atual `4af8b38` é compatível com ela** (insere sem as colunas novas; estados antigos continuam válidos). Ordem segura:

1. `--conferir-079` (somente leitura) → `PRONTA_PARA_APLICAR`;
2. `--aplicar-079-autorizado` → `APLICADA_POSTCHECK_PASS`;
3. merge do PR em `production` e deploy manual do web.

Antes do deploy o servidor ainda roda `4af8b38`, que não tem o aplicador. No Web Shell do `srv-dak77m2d0e5s73b8rkkg`, baixar do commit aprovado (repositório público) o aplicador e os 3 SQL para `/tmp/c079` com a mesma estrutura de pastas, conferir os SHA-256 publicados no PR e executar com o `pg` já instalado no serviço (`NODE_PATH=/opt/render/project/src/node_modules`). O aplicador lê os SQL relativos à própria pasta e confere os hashes de novo. O roteiro exato, com o SHA, está no PR.

Trava: `RENDER=true`, `RENDER_SERVICE_ID`, `KIDMAIS_DEPLOY_ENV=production`, `DATABASE_SSL=true` com certificado verificado, host `dpg-dak750gae00c73fudmg0-a`, banco `kidmais_production`, sem parâmetros na URL; identidade e TLS conferidos no servidor; 073/074 exigidas; vestígio parcial da 079 para antes de escrever. Marcador exclusivo em `/opt/render/project/src/data/convites-v1-producao-20261017/migration-079.json` impede repetição automática (falha ou resposta perdida → revisar por `--conferir-079`, nunca repetir às cegas).

## Validação local (sem chamadas pagas, sem banco real)

| Gate | Resultado |
|---|---|
| `check:v1:static` (unitários, ESLint, TypeScript) | 2140/2142 na 1ª rodada; as 2 falhas eram registro: suíte 079 sem estado na receita (corrigido) e checksum do acervo por CRLF do checkout Windows (blobs versionados conferidos: iguais ao manifesto; CI Linux não é afetado) |
| `next build` | OK |
| Aplicador 079 (unitário) | 9/9 |
| Ensaio real do aplicador (PG 18 descartável, cadeia de produção até a 074) | PASS: conferir → aplicar → reconferir → reaplicar só postcheck → rollback → recusa de estado parcial → reaplicar |
| Suíte `lib/convites/recuperacao.postgres.test.ts` (cadeia até a 079) | 1/1 |
| Harness PostgreSQL do serviço (`testar-convites-postgres.ps1`) | 21/21: 073/074/079, recuperação (cobrada, sem cobrança, concorrência, permissão/tenant), famílias, trigger de empresa, último crédito concorrente, idempotência, limite individual, timeout sem nova chamada, teto diário, publicação/RSVP/cancelamento, convite completo (uma chamada, dados oficiais, persistência, repetição e chave alterada) e conflito antes da reserva |
| `convites-editor-v1-ui.cjs` (Chrome, API simulada, `next start` local) | buffet e cliente OK: layout, galeria 9/6, teclado, corretor, conflito, foto+autorização, salvar antes de gerar, duplo clique = 1 geração, download 1024×1536, recarga, 1440/390 px; convite antigo "Arte completa" abre e salva sem mudar o modo |
| `convites-biblioteca-ui.cjs` | obsoleto desde a V1 (procura o botão "Bases neutras", removido por `MOLDURAS_NO_EDITOR = false`); igual em staging `58477ea`, fora do CI |

Limites: tenant/paywall/provedor simulados nos harnesses; nenhuma geração real; homologação autenticada em staging continua pendente (smoke logado do PR #163).

## Ativação da IA (não alterada)

O deploy publica o código; a IA continua como a configuração de produção mandar. O convite completo só aparece com `CONVITES_IA_ENABLED=true`, `CONVITES_IA_PROVIDER=openai`, chave OpenAI, `CONVITES_IA_TETO_DIARIO_MICROUSD ≥ 300000` e franquia em `convite_carteiras`. O plano de 09/10 manteve `CONVITES_IA_ENABLED=false` em produção; os valores atuais não foram lidos. Ativar é alteração de env com autorização própria.

## Rollback

- **Código:** voltar ao deploy `dep-db49tpu7bikc73e2l4lg` (`4af8b38`) é compatível com a 079 aplicada. **Mas** o `conteudoSchema` de `4af8b38` é estrito: convites salvos/publicados pela V1 com `visual.posicao` ficariam com o link público indisponível. Antes de um rollback, conferir por leitura autorizada se há convites com `visual.posicao`; preferir correção à frente.
- **079:** `database/rollback/20261011_079_convite_recuperacao_manual_down.sql` só com autorização própria; recusa sozinho quando já há decisões de recuperação gravadas. Com a V1 no ar, remover a 079 quebra o editor: reverter o código antes.
