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

## Rotação de segredos de aplicação

1. Gerar o valor novo fora de qualquer chat (gerenciador de senhas ou `openssl rand -base64 48` no terminal local).
2. Render → serviço → Environment → editar a variável → salvar (redeploy).
3. Conferir health e o fluxo que usa o segredo.
4. Registrar sem o valor.

## Production

Mesmo procedimento, em janela autorizada, com rollback de código disponível e sem mudar migrations junto.
