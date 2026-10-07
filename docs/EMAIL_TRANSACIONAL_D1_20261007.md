# E-mail transacional (D1): preparação para entrega real (07/10/2026)

Estado: **e-mail real desligado** (`EMAIL_PROVIDER` ausente ou `desativado` em staging e production). Nada aqui liga o
envio; este documento é o roteiro para Felipe ligar quando decidir.

## Fluxos que dependem de e-mail

| Fluxo | Token | Validade | Uso | Limites | Resposta pública |
|---|---|---|---|---|---|
| Convite de acesso (`lib/acessos/convites.ts`) | 32 bytes, só o SHA-256 no banco, link com `#t=` | 7 dias | único; reenvio troca o token | reenvio ≥ 60 s e ≤ 10 envios; consulta/aceite 30/15 min por IP; senha de conta existente 5/15 min por e-mail | só quem tem o token vê empresa e e-mail |
| Recuperação de senha (`lib/acessos/recuperacao.ts`) | idem | 30 min | único; pedido novo invalida o anterior | 10/h por IP, 3/h por e-mail, intervalo de 2 min; redefinição 10/15 min por IP | **202 igual** para qualquer e-mail, processado depois da resposta |
| Confirmação de cadastro (`lib/cadastro/publico.ts`, PR #119) | idem | 24 h | único; pedido novo substitui o anterior | 10/h por IP, 3/h por e-mail | **202 igual**; e-mail com conta recebe só aviso para entrar |

Em todos: o token vai no **fragmento** (não aparece em log de servidor, proxy nem Referer); o link é removido da barra de
endereço ao abrir; **falha de envio invalida o pedido** (recuperação e cadastro) ou deixa o convite marcado "não enviado"
e auditado; a tela mostra o resultado real; nenhum log/auditoria guarda token, link, senha ou o corpo do e-mail.

Recuperação controlada quando o envio falha: o painel do desenvolvedor mostra alerta "Envio de e-mail indisponível" e
"Convite não enviado" (PR #115); depois de corrigir o provedor, **Reenviar** gera link novo (o antigo não vale).

## Provedor previsto: Resend (já integrado, `lib/acessos/email.ts`)

Variáveis (nomes): `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, `EMAIL_REMETENTE` (ex.: `Kidmais Manager <nao-responda@<subdominio>>`),
`ADMIN_AUTH_ORIGIN` (origem dos links). Recuperação pública só com `RECUPERACAO_SENHA_ATIVA=true`.

### Domínio remetente (ação de Felipe no painel do Resend e no DNS)

1. Usar **subdomínio dedicado** (ex.: `mail.kidmaisfestas.com` ou `notificacoes.kidmaisfestas.com`) — a documentação do
   Resend recomenda subdomínios para isolar a reputação (<https://resend.com/docs/dashboard/domains/introduction>).
2. Adicionar o domínio no Resend e criar **exatamente os registros DNS que o painel do Resend mostrar** (verificação,
   SPF e DKIM; MX de retorno quando pedido). Não copiar registros de outro lugar.
3. Publicar **DMARC** no domínio (começar com `p=none` e relatório, endurecer depois).
4. Esperar o status "Verified" no Resend.
5. Criar uma API key **só de envio**, uma por ambiente (staging ≠ production). Nunca colar a chave em chat; inserir
   direto na tela de Environment do serviço no Render.

### Homologação em staging (sem atingir pessoas reais)

1. Configurar no **staging** `EMAIL_PROVIDER=resend`, `RESEND_API_KEY` (chave de staging), `EMAIL_REMETENTE`.
   Isso altera env e reinicia o serviço: exige autorização de Felipe (política operacional).
2. Testar com os endereços de teste do Resend (<https://resend.com/docs/dashboard/emails/send-test-emails>):
   `delivered@resend.dev` (entrega), `bounced@resend.dev` (recusa 550), `complained@resend.dev` (spam). Ex.: convite pelo
   painel para `delivered+convite@resend.dev`; recuperação para conta sintética com e-mail `delivered+rec@resend.dev`.
3. Conferir: link chega com `#t=`; abre uma vez; segunda abertura recusa; expiração; bounce aparece como falha no Resend
   (o sistema não lê bounces — limitação conhecida).
4. Só então: um teste com a caixa real de Felipe.
5. Depois de validar: `USUARIOS_CRIACAO_DIRETA=desativada` (E1) e, se for abrir o cadastro, `CADASTRO_PUBLICO_ATIVO=true`.

### Production

Mesmo roteiro com chave e remetente de production, em janela autorizada. `RECUPERACAO_SENHA_ATIVA=true` só depois do
teste com a caixa real.

## Limitações conhecidas

- Sem processamento de bounce/complaint (webhook do Resend não integrado).
- Sem fila: o envio acontece na requisição (convite) ou logo depois da resposta (`after`). Queda do provedor = "não
  enviado", recuperável por reenvio.
- Sem proteção anti-robô além dos limites; avaliar CAPTCHA se houver abuso no cadastro.

## Custos

Plano e volume do Resend não levantados (decisão D1). Nenhuma conta foi criada.
