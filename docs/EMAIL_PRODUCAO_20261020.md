# Prova de entrega de e-mail em produção — 20/10/2026 (V6 da abertura da venda)

**Status: PREPARADO E ENSAIADO LOCALMENTE, NÃO EXECUTADO.** Nada foi lido, configurado, conectado ou enviado em produção ou
staging nesta preparação. Nenhuma variável de ambiente foi criada ou alterada. Executar qualquer bloco, gravar variáveis ou
disparar deploy exige autorização própria de Felipe ([OPERACAO_AGENTES.md](OPERACAO_AGENTES.md)). Preparar e ensaiar não
autoriza enviar.

Equivalente de produção do E0 de staging ([EMAIL_STAGING_LANCAMENTO_20261011.md](EMAIL_STAGING_LANCAMENTO_20261011.md),
PASS em 13/10). A diferença é o formato: em vez do heredoc de node do E0, a prova usa blocos de Shell no padrão revisado de
18–20/10 (o mesmo do [reparo dos bloqueios](REPARO_BLOQUEIOS_PRODUCAO_20261020.md)).

| Peça | Arquivo |
|---|---|
| Executor (roda no Shell, a partir da pasta própria) | [`scripts/email-producao-20261020.cjs`](../scripts/email-producao-20261020.cjs) |
| Testes do executor | [`scripts/email-producao-20261020.test.cjs`](../scripts/email-producao-20261020.test.cjs) |
| Gerador dos blocos | [`scripts/bloco-shell-email-producao-20261020.cjs`](../scripts/bloco-shell-email-producao-20261020.cjs) |
| Testes dos blocos (bash e bash -i) | [`scripts/bloco-shell-email-producao-20261020.test.cjs`](../scripts/bloco-shell-email-producao-20261020.test.cjs) |
| CI | step "Prova de entrega de e-mail em produção (V6)" em `.github/workflows/ci.yml` |

## 1. O que a prova comprova (e o que não comprova)

- **Comprova:** o web de produção (`srv-dak77m2d0e5s73b8rkkg`) envia e-mail de verdade pelo **mesmo transporte do app**
  (`lib/acessos/email.ts` do deploy, conferido por sha256), pelo remetente verificado
  `nao-responda@notificacoes.kidmaisfestas.com`, com a chave de produção; e que o canal oficial
  `contato@demerzellabs.com.br` recebe mensagens (prova também o recebimento no endereço novo).
- **Não comprova:** cadastro, confirmação de conta, convite, recuperação de senha, cobrança ou qualquer fluxo com banco. Não
  lê nem grava o banco, não cria usuário ou empresa, não aceita termos, não cria cobrança, não consome vaga Fundador.
- `ACEITO_PROVEDOR_ENTREGA_PENDENTE` significa que o Resend **aceitou**; a entrega só fica provada quando Felipe vê a
  mensagem na caixa de `contato@` ou o evento **Delivered** desse id no Resend (§6).

## 2. Decisões desta peça

| # | Decisão | Motivo |
|---|---|---|
| D1 | Destinatário **fixo no código**: `contato@demerzellabs.com.br`. Nenhum parâmetro de destinatário (argumento extra = recusa). | Canal oficial; um envio a um endereço nosso não expõe terceiros. |
| D2 | **Envio único**, sem retentativa. Registro exclusivo (`wx`, 0600, pasta 0700) em `data/lancamento-email-producao-20261020/teste-envio.json` no **disco persistente**, gravado **antes** do envio. | Impede replay mesmo depois de deploys; qualquer resultado diferente de ACEITO trava a repetição até nova decisão. |
| D3 | Transporte conferido por **conteúdo** (sha256 de `lib/acessos/email.ts` `0ff9c138…363b` e `lib/acessos/erros.ts` `883b0944…74d2`, árvore `7ce0916`), e não pelo SHA do commit LIVE. | Gravar `EMAIL_PROVIDER`/`EMAIL_REMETENTE` dispara deploy; outro deploy legítimo (ex.: textos legais) mudaria o commit sem mudar o transporte. Se o transporte mudar, a prova recusa (`TRANSPORTE_DIVERGENTE`) e o pacote precisa ser regerado. O commit LIVE aparece na saída e no registro. |
| D4 | **Flags da venda desligadas** (`CADASTRO_PUBLICO_ATIVO`, `ASSINATURA_PLANOS_ATIVOS`, `RECUPERACAO_SENHA_ATIVA`): ausente, vazia ou `false`. Ligada (`true` em qualquer caixa) ou valor inesperado = **recusa** antes de tudo. | A prova não depende delas (o envio não passa por cadastro, planos ou recuperação). Mas o plano prevê a prova **antes** da abertura: flag ligada é divergência do estado revisado e significa que fluxos reais de e-mail já estão abertos ao público (§7). Parar e decidir é mais barato que provar num estado não revisado. Se Felipe decidir abrir a venda antes, regerar o pacote sem essa guarda. |
| D5 | `RESEND_API_KEY`: só **presença, tamanho e prefixo `re_`**; formato `re_` + 8–200 de `[A-Za-z0-9_-]`. Nunca o valor. | Política de segredos. A chave só vai no cabeçalho HTTP para `api.resend.com`, dentro do transporte do produto. |
| D6 | CONFERIR é **somente leitura**: não grava no disco persistente (nem cria a pasta do registro) e não envia. O próprio produto (`situacaoEmail`) precisa dizer `configurado: true`. | Permite conferir o ambiente quantas vezes for preciso antes do único ENVIAR. |
| D7 | Falha do transporte **não** é repetida: recusa HTTP do provedor vira `RECUSADO_PROVEDOR_NADA_ENVIADO_NAO_REPETIR`; falta de resposta/timeout/erro vira `FALHA_OU_ENVIO_INCERTO_NAO_REPETIR`; aceito sem id vira `ACEITO_SEM_IDENTIFICADOR_NAO_REPETIR`. | Timeout pode ter enviado; só uma decisão humana (com o painel do Resend) libera nova tentativa, com pacote novo. |

## 3. Pré-requisitos (fora do Shell)

1. **Chave (Felipe, no Resend):** criar uma API key **de produção** com permissão **Sending access** restrita ao domínio
   `notificacoes.kidmaisfestas.com` (não reutilizar a de staging; não "Full access"). Nome sugerido:
   `kidmais-manager-production-envio`. O domínio já está verificado no Resend (E0). O valor nunca passa pelo chat, Git ou
   agente.
2. **Gravar a chave (Felipe, no painel do Render):** web de produção `kidmais-manager-production`
   (`srv-dak77m2d0e5s73b8rkkg`) → Environment → adicionar `RESEND_API_KEY` → **Save only** (sem rebuild/deploy). O
   agente não clica em "Show secret"/"Copy value" nem lê o valor.
3. **Gravar provedor e remetente (Claude, com autorização específica de Felipe para env em produção):** pela integração
   Render, adicionar ao mesmo serviço `EMAIL_PROVIDER=resend` e
   `EMAIL_REMETENTE=Kidmais Manager <nao-responda@notificacoes.kidmaisfestas.com>`. **Isso dispara um deploy** do commit
   da branch `production` (hoje `7ce0916`) que já leva junto a chave salva no passo 2. Acompanhar esse único deploy até
   LIVE e health 200, sem duplicar.
   - **A partir deste LIVE, o e-mail transacional do app sai de verdade** (§7). A ordem 2 → 3 garante que o app não fica
     com `EMAIL_PROVIDER=resend` sem chave (aí ele só responde "não configurado", sem envio).
4. **Antes de colar:** confirmar por leitura (metadados Render) que o LIVE é o deploy do passo 3, sem deploy em andamento;
   que `KIDMAIS_DEPLOY_ENV=production` existe no web (já exigido pelo reparo de 20/10); e que as três flags da venda
   continuam ausentes. Qualquer divergência → parar e reapresentar.
5. **Pacote:** conferir sha256 e bytes dos blocos (§8) contra o `MANIFESTO.sha256` do pacote antes de colar.

## 4. Roteiro no Web Shell de produção

Uma sessão do Web Shell do `srv-dak77m2d0e5s73b8rkkg` (bash interativo), de até 5 minutos. Cada bloco é colado **inteiro,
uma vez**, seguido de Enter.

1. **CONFERIR** (`BLOCO-SHELL-EMAIL-PRODUCAO-20261020-CONFERIR.sh`). Esperado: `ARQUIVOS_OK 1`, uma linha JSON
   `{"resultado":"CONFERIDO_PRONTO_PARA_ENVIO", … "chave":{"presente":true,"tamanho":<n>,"prefixoRe":true},
   "flags":{… "desligada" …},"transporte":"CONFERIDO"}`, `SEM_REGISTRO …` e `CODIGO_SAIDA_BLOCO=0`. Qualquer outro
   código → parar, copiar a saída e não colar o ENVIAR.
2. **Autorização específica do envio** (Felipe), já com o CONFERIR = 0 na tela.
3. **ENVIAR** (`BLOCO-SHELL-EMAIL-PRODUCAO-20261020-ENVIAR.sh`) **uma vez**. Esperado: `JA_PRESENTE` (o executor já
   estava na pasta própria), `{"resultado":"ACEITO_PROVEDOR_ENTREGA_PENDENTE","provedor":"resend","idExterno":"<id>",
   "destinatario":"contato@demerzellabs.com.br", … "registroFinal":"GRAVADO" …}`, a listagem do registro com
   `-rw-------` e `CODIGO_SAIDA_BLOCO=0`. Copiar a saída (o `idExterno` não é segredo).
4. **LIMPEZA** (opcional; `BLOCO-SHELL-EMAIL-PRODUCAO-20261020-LIMPEZA.sh`): remove o executor da pasta própria e a pasta
   (`PASTA_REMOVIDA`, código 0). A pasta própria some de qualquer forma no próximo deploy. O registro anti-replay em
   `data/` **fica** (é o que impede a repetição).
5. Fechar o Shell. Confirmar o recebimento (§6) e registrar a evidência sanitizada (sem cabeçalhos nem chave).

Colagem: se aparecer o prompt `>` depois de colar, a colagem ficou incompleta → Ctrl-C (nunca colar por cima do `>`) e
colar o MESMO bloco. Ctrl-C durante o ENVIAR **depois** de `ARQUIVOS_OK` = estado incerto: não repetir; rodar o CONFERIR
(se ele disser código 3, a intenção foi gravada) e decidir pelo painel do Resend.

## 5. Códigos de saída

| `CODIGO_SAIDA_BLOCO` | Significado | O que fazer |
|---|---|---|
| 0 | CONFERIR: pronto para o envio. ENVIAR: `ACEITO_PROVEDOR_ENTREGA_PENDENTE` com id. LIMPEZA: concluída. | Seguir o roteiro. |
| 1 | Recusado **antes** de gravar ou enviar: serviço/ambiente (`SERVICO_RECUSADO`, `FORA_DO_RENDER`, `AMBIENTE_RECUSADO`), env (`EMAIL_PROVIDER_DIVERGENTE`, `EMAIL_REMETENTE_DIVERGENTE`, `RESEND_API_KEY_AUSENTE`, `RESEND_API_KEY_FORMATO`), flags (`FLAG_VENDA_LIGADA <flag>`, `FLAG_VENDA_VALOR_INESPERADO <flag>`), transporte (`TRANSPORTE_AUSENTE …`, `TRANSPORTE_DIVERGENTE …`, `TRANSPORTE_NAO_CARREGOU`, `EMAIL_NAO_CONFIGURADO_NO_PRODUTO`), disco (`DISCO_PERSISTENTE_AUSENTE`, `PASTA_REGISTRO_RECUSADA`). | Nada foi gravado nem enviado. Corrigir a causa (env, deploy) com autorização e recomeçar pelo CONFERIR. Transporte divergente = pacote novo. |
| 2 | Intenção gravada e o envio **falhou ou ficou incerto** (`RECUSADO_PROVEDOR_NADA_ENVIADO_NAO_REPETIR`, `FALHA_OU_ENVIO_INCERTO_NAO_REPETIR`, `ACEITO_SEM_IDENTIFICADOR_NAO_REPETIR`, `ERRO_INESPERADO`). | **Não repetir.** Conferir no painel do Resend (Emails/Logs) se houve envio para `contato@`. Nova tentativa só com decisão de Felipe e pacote novo (outra pasta de registro). |
| 3 | `REGISTRO_JA_EXISTE_REPLAY_RECUSADO`: a prova já foi tentada. | Nada enviado agora. Ler o registro anterior (situação, id) e decidir. |
| 4 | Recusa do **bloco** antes do executor (`DEPLOY_INACESSIVEL`, `FERRAMENTA_AUSENTE`, `CONTEUDO_DIVERGENTE`, `JA_EXISTE_DIFERENTE`, `GRAVACAO_FALHOU`, `DESTINO_INACESSIVEL`, `TEMPORARIO_FALHOU`). | Nada executado. Conferir o sha do bloco colado; não colar por cima. |
| outro / sem a linha | 127 (linha perdida), 130 (Ctrl-C), 143 (sinal), ou nenhuma linha `CODIGO_SAIDA_BLOCO` (colagem incompleta, shell errado = `SHELL_ERRADO_NAO_E_PRODUCAO`). | Parar e ler a saída. Para o ENVIAR, tratar como incerto (código 2). |

## 6. Como confirmar o recebimento

- **Caixa de `contato@demerzellabs.com.br`** (Felipe): mensagem "[TESTE] Kidmais Manager: prova de e-mail de producao", de
  `Kidmais Manager <nao-responda@notificacoes.kidmaisfestas.com>`, sem link, texto "Teste autorizado do transporte de
  e-mail do Kidmais Manager em PRODUCAO…". Conferir também a pasta de spam/lixo (se cair lá, registrar: indica ajuste de
  reputação/SPF/DKIM/DMARC antes da abertura).
- **ou** no Resend, o evento **Delivered** do `idExterno` impresso (Emails → buscar pelo id), sem abrir outras mensagens.
- Sem recebimento nem Delivered em 30 min: tratar como falha de entrega (Bounced/Complained/Suppressed no Resend) — não
  repetir automaticamente.

## 7. Levantamento: o que passa a enviar e-mail em produção com `EMAIL_PROVIDER=resend`

Lido no código de `7ce0916` (production). Todo envio passa por `criarEnviarEmail()` de `lib/acessos/email.ts`. Com
`EMAIL_PROVIDER` ausente (estado atual) o transporte responde `EMAIL_NAO_CONFIGURADO` e **nada sai**; ao configurar o
Resend, os fluxos abaixo **passam a enviar de verdade**.

| Fluxo | Onde | Quem dispara | Com as flags atuais (desligadas) |
|---|---|---|---|
| Convite de usuário pela empresa (Configurações → Usuários: convidar / reenviar convite) | `lib/acessos/convites-empresa.ts` (`convidarNaEmpresa`, `alterarConviteNaEmpresa`) via `app/api/admin/configuracoes/usuarios/route.ts` | Gestão de uma empresa ATIVA (hoje só a Kidmais), por clique | **LIGA.** Não há flag: cada convite/reenvio envia e-mail real com link (`ADMIN_AUTH_ORIGIN` + `#t=token`). Antes, o convite era criado e o envio falhava ("não configurado"). |
| Painel do desenvolvedor: provisionar contratante (convite de Gestão), convidar usuário, reenviar convite | `lib/desenvolvedor/empresas.ts` (`provisionarContratante`), `lib/desenvolvedor/vinculos.ts` (`convidarUsuario`, `reenviarConvite`) | Felipe/desenvolvedor, por clique (com reautenticação no provisionamento) | **LIGA.** A prévia passa a dizer "O e-mail do convite é enviado logo após a confirmação". |
| Painel do desenvolvedor: recuperação de senha de um usuário | `lib/desenvolvedor/vinculos.ts` (`solicitarRecuperacaoPeloPainel`) | Desenvolvedor, por clique | **LIGA** (não depende de `RECUPERACAO_SENHA_ATIVA`). |
| Recuperação pública de senha ("esqueci a senha") | `lib/acessos/recuperacao.ts` via `app/api/acesso/recuperacao/route.ts` | Qualquer visitante | **Continua desligada:** exige `RECUPERACAO_SENHA_ATIVA=true` **e** e-mail configurado (`lib/acessos/disponibilidade.ts`). |
| Cadastro público (confirmação de conta / "conta já existe") | `lib/cadastro/publico.ts` via `app/api/cadastro/route.ts` | Qualquer visitante | **Continua desligado:** exige `CADASTRO_PUBLICO_ATIVO=true`, criação direta desligada e e-mail configurado; e responde 503 enquanto houver bloqueio global de agenda. |
| Aviso de renovação Fundador | `lib/assinatura/renovacao-fundador.ts` | Só pelos scripts manuais `assinatura-renovar.cjs` (só banco local + e-mail em arquivo) e `assinatura-renovar-restrito.cjs` (recusa produção) | **Não liga.** Nenhuma rota, cron ou rotina do app chama `processarRenovacao`. |
| Cron de assinaturas (produção) | `scripts/assinatura-cron.cjs` | Agendamento | **Não envia e-mail** (só reconciliação/conferência; em produção só `conferir`). |
| Marketing, Convites de festa (IA), WhatsApp, OTP de identidade | `lib/marketing`, `lib/convites`, `lib/identidade` | — | **Não usam e-mail** (OTP vai por WhatsApp/Gupshup). |
| Cobrança Asaas | `lib/assinatura/asaas.ts` | — | O app não envia e-mail de cobrança; clientes são criados com `notificationDisabled: true` (o Asaas não notifica). |

**Nada dispara sozinho:** não há fila, cron ou `after()` que envie e-mail sem ação de alguém. Convites pendentes já
criados em produção **não** são reenviados automaticamente; só saem se alguém clicar em reenviar. O painel do
desenvolvedor e o resumo passam a mostrar "e-mail configurado" (`situacaoEmail`), e os alertas do painel deixam de
apontar e-mail não configurado; o alerta "Convite não enviado" passa a sugerir "Reenvie pela ficha" para convites criados
e nunca enviados (`lib/desenvolvedor/alertas.ts`). Antes de reenviar algum, conferir se o destinatário e o convite ainda
fazem sentido (o reenvio gera link novo e e-mail real).

## 8. Riscos e pontos para Felipe

1. **E-mail transacional real a partir do deploy do passo 3** (§7): qualquer convite criado/reenviado por quem tem
   Gestão na Kidmais, e as ações do painel do desenvolvedor, enviam e-mail real com link de acesso. Orientar a equipe;
   evitar testes com endereços de terceiros.
2. **Origem dos links:** os links de convite/recuperação usam `ADMIN_AUTH_ORIGIN`. O [handoff de produção](HANDOFF_V1_PRODUCAO.md)
   (histórico de 15/09) registra esse valor apontando para a URL `onrender.com`. Não foi lido nesta preparação. Antes de usar convites reais, conferir (por
   nome/valor não secreto, com autorização) se a origem é a pública desejada.
3. **Flags:** a prova recusa com qualquer flag da venda ligada (D4). Se a venda for aberta antes da prova, o CONFERIR
   dará código 1 (`FLAG_VENDA_LIGADA …`): decidir e regerar o pacote.
4. **Chave:** escopo mínimo (Sending access + domínio). Se o valor aparecer em chat, log ou print, revogar no Resend e
   criar outra (Save only de novo; não precisa regerar o pacote).
5. **Reputação/entrega:** primeira mensagem de produção para um endereço nosso; se cair em spam, tratar antes da abertura.
6. **Custo:** um envio na conta Resend, a duração do Shell e um deploy (passo 3); nenhum recurso novo.
7. **Transporte divergente:** se `lib/acessos/email.ts` ou `erros.ts` mudarem em produção antes da prova, o executor recusa
   (código 1). Regerar e revisar o pacote.

## 9. Rollback

- **Desligar o envio real:** remover `EMAIL_PROVIDER` do web de produção (o transporte volta a `desativado`; nada mais
  sai). Isso dispara um deploy do mesmo commit — exige autorização própria. Opcionalmente remover também
  `EMAIL_REMETENTE`. `RESEND_API_KEY` pode ficar (sem `EMAIL_PROVIDER=resend` ela não é usada) ou ser revogada no Resend.
- **Não apagar** o registro `data/lancamento-email-producao-20261020/teste-envio.json` (é a trava anti-replay e a
  evidência), nem mensagens ou logs do Resend.
- O executor não muda banco nem código: não há rollback de dados.

## 10. Blocos e validação local

Blocos gerados da árvore `7494087` (`node scripts/bloco-shell-email-producao-20261020.cjs TODOS 7494087 <pasta>`):

| Bloco | sha256 | bytes |
|---|---|---|
| `BLOCO-SHELL-EMAIL-PRODUCAO-20261020-CONFERIR.sh` | `8f77a397d84d1b3a5463b50bebc5ee0e4ae352c9375d1c056a02d55bdb3ad10f` | 9612 |
| `BLOCO-SHELL-EMAIL-PRODUCAO-20261020-ENVIAR.sh` | `7cdbb59c0399d544f716c12cb1869dc00306af91a1310f6f9e7585f1bbdd47ed` | 9743 |
| `BLOCO-SHELL-EMAIL-PRODUCAO-20261020-LIMPEZA.sh` | `9e9967a088c166e14dd707355fbb58f2c67977f24b383ecacdaa5b419fbdf3b3` | 2285 |

Executor transportado: `scripts/email-producao-20261020.cjs` sha256 (LF) `ba56b8ce526f7f6f65dbac23a6378280cca6d51ccdea847144f9d4df9007ce63`. Os bytes do gzip dependem do
SO/zlib do gerador (Windows, Node 24.20.0); o conteúdo transportado é conferido pelo sha do executor.

Validação local em 20/10/2026 (nenhum envio, rede bloqueada nos testes, nada em /opt):

- `node --test scripts/email-producao-20261020.test.cjs scripts/bloco-shell-email-producao-20261020.test.cjs`: **20/20**
  (12 do executor: guarda de alvo antes de ler disco, env ausente/inválida, flags, CONFERIR somente leitura, transporte e
  disco, envio único com intenção antes, sem parâmetro de destinatário, falha sem retentativa, replay, transporte
  TypeScript real com rede simulada, sigilo na CLI real; 8 dos blocos: estrutura/ASCII/≤ 32 KB, carga, guarda de serviço,
  execução com bash, recusas do bloco, **colagem com `bash -i`** (executada, não pulada) e colagem truncada, LIMPEZA, fixação byte a byte dos 3 blocos no mesmo gerador).
- `npx tsc --noEmit`: OK. ESLint dos 4 arquivos novos: OK. `npm run check:v1:static`: PASS (testes, lint, TypeScript e build).
