# Credenciais: revisão e procedimento de rotação (07/10/2026)

**Nada foi rotacionado.** Rotação em production exige autorização própria de Felipe. Este documento lista o que existe
(só nomes), o que já foi exposto e o passo a passo concreto. Nunca colar valores de segredo em chat, issue ou arquivo.

## Exposição conhecida

| Credencial | Onde vazou | Risco | Recomendação |
|---|---|---|---|
| Usuário/senha do banco de **staging** (`dpg-daidko3m8hqs73ce4jt0-a`, banco `kidmais_staging_1z91`) | colada num chat de sessão anterior | quem tiver o texto acessa o banco de staging de onde a allowlist de IP permitir (hoje: IPs do PC de Felipe, segundo a memória operacional) | **rotacionar** (procedimento abaixo); decisão de Felipe |

Não foi encontrada outra exposição nesta revisão (lida a política e os documentos do repositório; nenhum arquivo de
segredo foi aberto).

## Inventário (nomes, por ambiente)

| Grupo | Variáveis | Efeito da troca |
|---|---|---|
| Banco | `DATABASE_URL` (+ `DATABASE_SSL*`) | reinício do serviço; ver rotação de usuário abaixo |
| Sessão e limites | `ADMIN_AUTH_SECRET` | as chaves de limite (HMAC) mudam: limites recomeçam; sessões não dependem dele (token só em SHA-256) |
| OTP do cliente final | `IDENTIDADE_OTP_PEPPER` | desafios OTP abertos deixam de valer (10 min) |
| Gupshup | `GUPSHUP_API_KEY`, `GUPSHUP_WEBHOOK_SECRET` | trocar também no painel do Gupshup |
| WhatsApp/Meta | `WHATSAPP_CLOUD_ACCESS_TOKEN`, `WHATSAPP_CREDENTIAL_ENCRYPTION_KEY` (+ versão), `META_APP_SECRET` | a chave de criptografia exige recriptografar credenciais guardadas: **não trocar sem plano próprio** |
| IA | chaves dos provedores de modelo | nenhuma persistência depende delas |
| E-mail (futuro) | `RESEND_API_KEY` | trocar no Resend e no Render |
| Cobrança (futuro, PR de Asaas) | `ASAAS_API_KEY`, `ASAAS_WEBHOOK_TOKEN` | trocar o token também no webhook cadastrado no Asaas |

## Rotação do usuário do banco (Render Postgres) — sem parada

Fonte: <https://render.com/docs/postgresql-credentials> ("Credential Rotation (Zero-Downtime)").

1. Render Dashboard → banco de **staging** → Info → **Credentials** → **+ New default credential** (o novo usuário vira
   o *default*).
2. No serviço `kidmais-manager-staging` → Environment: atualizar `DATABASE_URL` com a URL **interna** do novo usuário
   (copiar do Dashboard direto para o campo; não passar por chat). Isso redeploya o serviço — exige autorização.
3. Conferir o deploy: health `ready`; login; uma leitura e uma escrita sintética autorizada.
4. Atualizar os scripts locais que pedem a URL (eles pedem mascarada no terminal; nada salvo).
5. Monitorar conexões do usuário antigo até zerar (aba de métricas/conexões do banco, ou consulta de leitura em
   `pg_stat_activity` filtrando `usename`).
6. **Excluir o usuário antigo** (lixeira ao lado dele em Credentials). O Render não exclui o usuário *default* atual —
   por isso o passo 1 vem antes.
7. Registrar: data, quem fez, novo usuário (nome), deploy ID.

Particularidade deste projeto: as migrations rodam com o usuário **efetivo** dono das tabelas
(`kidmais_staging_user`/`kidmais_production_user`) e a aplicação conecta com um usuário de sessão (`*_app_v*`).
Confirmar no passo 3 que o usuário novo tem as mesmas permissões efetivas (o diagnóstico v7 imprime
`usuario_sessao`/`usuario_efetivo` e os donos das tabelas) **antes** do passo 6.

### Consumidores fora do serviço web (atualizado em 20/10/2026)

A credencial do banco e a chave do Asaas também ficam em **cópias** fora do web. Cada rotação precisa atualizar essas
cópias **antes do passo 6** (excluir o usuário antigo), com um "Trigger run" para conferir.

| Ambiente | Serviço | Cópias | Situação |
|---|---|---|---|
| staging | cron `kidmais-assinatura-reconciliar-staging` (`crn-db493i142hec73ahmoe0`) | `KIDMAIS_RECONCILIAR_DATABASE_URL` (URL interna do banco de staging); `ASAAS_API_KEY`/`ASAAS_WEBHOOK_TOKEN` (sandbox) | existe |
| production | cron `kidmais-assinatura-reconciliar-production` ([CRON_ASSINATURA_PRODUCAO_20261020.md](CRON_ASSINATURA_PRODUCAO_20261020.md)) | `KIDMAIS_RECONCILIAR_DATABASE_URL` (mesmo valor da `DATABASE_URL` do web); `ASAAS_API_KEY`/`ASAAS_WEBHOOK_TOKEN` (produção) | proposto; só tem cópias em `conferir` (C2). Em `aguardando` não há o que atualizar |

> **Bloqueio em production (B-27, 07/11/2026).** Em production, separe a credencial do banco da cobrança. O passo extra de chave ou token do Asaas não se aplica, e a coluna de cópias da tabela acima não autoriza instalar `ASAAS_API_KEY` ou `ASAAS_WEBHOOK_TOKEN` no web ou no cron. O fluxo abaixo de acompanhar o build e fazer "Trigger run", e o "Trigger run" citado no início desta seção, não valem para cron suspenso pela D-VZ-6.
>
> Trocar a cópia do banco num cron suspenso é alteração ordinária de env. Só Felipe a executa, com autorização específica para esse alvo e R3 PASS antes de gravar; R3 ausente, inconclusivo ou reprovado bloqueia a gravação. Além disso, é preciso prova prévia de que o mecanismo de gravação preserva a suspensão e a drenagem, sem iniciar execução e sem adiantar E8a ou E8b. Se a troca alterar a barreira, aplica-se o R1. A RC segue o próprio rito e exige vínculo com a falha. A evidência local de "Save only" é do serviço web, não de cron suspenso; este documento não estabelece esse comportamento. Conferir a suspensão e a ausência de execução antes e depois da gravação. Com mecanismo incerto, parar antes de gravar. Se a troca for adiada e a credencial antiga revogada, registrar a cópia como obsoleta e pendente para a retomada autorizada, que também fará a conferência funcional.
>
> Antes de rotacionar, inventariar os consumidores da credencial por alvo: o manifesto `infra/render-assinatura-avisos-cron-production.yaml` também define `KIDMAIS_RECONCILIAR_DATABASE_URL`, e não se pode presumir que os dois crons usem o mesmo usuário. A linha de staging e os passos de staging seguem como estão.
>
> Vale enquanto a dívida D-COBRANCA-LIVE estiver aberta, com qualquer dado no ambiente, chamado de "teste" ou não; a reabertura técnica da promoção não libera este caminho. Para sair do bloqueio é preciso o fechamento formal da dívida, a entrega própria de abertura da L2, R3 PASS imediatamente antes e autorização própria de Felipe para cada ativação. Com a dívida aberta, cada deploy, env, E9, E10 ou promoção seletiva ordinários em production exige R3 PASS antes da mudança; a única exceção é a recuperação contida (RC, §9.2.5).
>
> Referência: [plano de promoção, rodada 34, §9.2.6](PLANO_PROMOCAO_PRODUCTION_20261025.md#926-d-cobranca-live-gate-de-ativação); o plano é local e ainda não está versionado neste repositório. Esta nota não autoriza nada, não afirma estado atual de serviço ou variável e, nos passos de production sujeitos à dívida, prevalece sobre o texto abaixo. Não trata de staging nem de sandbox.

**Passo extra na rotação do banco** (entre os passos 3 e 5): cron → Environment → atualizar `KIDMAIS_RECONCILIAR_DATABASE_URL`
com a mesma URL interna nova (direto do Dashboard, sem chat) → acompanhar o build → "Trigger run" → saída 0. Uma cópia
esquecida faz o cron falhar todo dia (código 1, autenticação) depois que o usuário antigo for excluído.

**Passo extra na rotação da chave ou do token do Asaas:** atualizar as duas variáveis também no cron → "Trigger run"
→ saída 0.

## Rotação de segredos de aplicação

1. Gerar o valor novo fora de qualquer chat (gerenciador de senhas ou `openssl rand -base64 48` no terminal local).
2. Render → serviço → Environment → editar a variável → salvar (redeploy).
3. Conferir health e o fluxo que usa o segredo.
4. Registrar sem o valor.

## Production

> **Bloqueio em production (B-27, 07/11/2026).** "Mesmo procedimento" não inclui instalar credencial de cobrança nem executar cron suspenso. Vale a condição da seção de consumidores fora do serviço web: autorização para o alvo, R3 PASS antes de gravar e prova prévia do mecanismo, ou parada antes de gravar. Vale enquanto a dívida D-COBRANCA-LIVE estiver aberta, com qualquer dado no ambiente. As condições de saída e a regra do R3 para mudanças ordinárias estão na nota completa da B-27 neste documento. Esta nota não autoriza nada, prevalece sobre o trecho abaixo em production e não trata de staging nem de sandbox.

Mesmo procedimento, em janela autorizada, com rollback de código disponível e sem mudar migrations junto.
