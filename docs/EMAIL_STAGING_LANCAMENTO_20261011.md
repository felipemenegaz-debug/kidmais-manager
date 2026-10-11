# E0 — Configurar e provar o transporte de email em staging

Status: preparado, nao executado. Etapa anterior ao teste de cadastro completo; nao substitui S3 nem S4.

## Estado confirmado somente leitura

- Workspace My Workspace, `tea-daidbj95efls73d2bcf0`.
- Web `srv-daif418ae00c73e8k2gg`, branch staging, auto-deploy OFF.
- `origin/staging` e LIVE `5386a4df36b8b8b7cb649bc15d17e48e6b853b90`, confirmado por GitHub e Render em 11/10/2026; deploy `dep-db5kk17avr4c73950kq0`.
- Painel Environment com 69 chaves e nenhum grupo ligado. Lidos apenas nomes de chaves, sem clicar Show secret ou Copy value.
- Ausentes: EMAIL_PROVIDER, EMAIL_REMETENTE, RESEND_API_KEY, CADASTRO_PUBLICO_ATIVO, SITE_URL, SITE_PRECOS_PUBLICADOS, ASSINATURA_PLANOS_ATIVOS, COTACAO_PUBLICA_POR_EMPRESA.
- Presentes: ASAAS_AMBIENTE, ASAAS_API_KEY, ASAAS_WEBHOOK_TOKEN. Presenca nao comprova valor nem funcionamento; nao foram lidos.
- Dominio Resend `notificacoes.kidmaisfestas.com` ja verificado, conforme evidencia anterior do lancamento.

## Operacao concreta para aprovar

1. Revalidar branch/SHA/LIVE e auto-deploy OFF. Qualquer movimento ou deploy concorrente → parar antes de salvar configuracao.
2. Adicionar somente ao web de staging:
   - EMAIL_PROVIDER = `resend`
   - EMAIL_REMETENTE = `Kidmais Manager <nao-responda@notificacoes.kidmaisfestas.com>`
   - RESEND_API_KEY = chave que Felipe cadastra diretamente no painel, nunca no chat/Git. Nao copiar chave de producao nem retirar credencial protegida local por conveniencia.
3. Salvar sem deploy pelo painel; conferir que apenas estas tres chaves foram adicionadas. Felipe pode inserir a chave e salvar; o agente nao le seu valor.
4. Um deploy manual do mesmo SHA `5386a4d`, sem push ou alteracao de codigo. Revalidar origin/staging antes; se mudar, parar. Se algum save ja iniciar deploy, acompanhar esse unico deploy, sem duplicar.
5. LIVE e health 200; uma sessao Shell de staging de ate **5 minutos**, com possivel cobranca por duracao, para o comando autossuficiente em `docs/evidencias/email-staging-comando-codex-20261011.txt`. Usa o transporte TypeScript do produto na candidata LIVE; nao exige publicar o script.
6. Enviar **uma** mensagem a `felipemenegaz@gmail.com`, assunto `[TESTE] Kidmais Manager: e-mail de staging`, sem link/token/senha, com chave de idempotencia exclusiva e intencao gravada antes do envio.
7. O provedor deve devolver id externo. `ACEITO_PROVEDOR_ENTREGA_PENDENTE` nao prova recebimento: pedir confirmacao de Felipe ou conferir evento Delivered do Resend para esse id, sem abrir outras mensagens.
8. Fechar Shell, registrar evidencia sanitizada. Manter as tres variaveis configuradas no web de staging para o teste seguinte; as flags publicas/cobranca continuam desligadas. Nenhuma alteracao no cron ou producao.

## Guardas, efeitos e recuperacao

- Alvo fixo staging, SHA fixo, remetente fixo, chave com formato valido, disco montado e flags de abertura desligadas antes do envio.
- Nao le/escreve banco, nao cria usuario/empresa, nao envia cadastro, nao aceita termos, nao cria ou paga cobranca, nao consome vaga Fundador.
- Escreve script em pasta /tmp exclusiva e registro 0600 no disco de staging, `data/lancamento-email-20261011/teste-envio.json`. Registro exclusivo impede replay.
- Credencial usada somente no transporte de email do produto; valor nunca impresso. Erros genericos, sem mensagem bruta de provedor ou corpo/link em logs.
- Se a resposta se perder, registrar ENVIO_INCERTO e parar, sem novo envio. Importacao/falha antes de enviar deixa intencao gravada e tambem impede repeticao.
- Se configurar ou entregar falhar, reverter somente as tres chaves adicionadas (estado anterior: ausentes) e redeployar o mesmo SHA, um unico deploy de restauracao. Nao apagar registro, mensagem ou arquivos de evidencia. Rever tentativa antes de autorizar outra.
- Custos: minutos normais de build do plano, duracao do Shell e um envio conforme a conta Resend; nenhum recurso novo.

## Validacao local

Seis testes cobrem alvo/flags, envio unico, falha sem retentativa, recusa de replay, transporte TypeScript real com rede simulada e integridade/sintaxe do comando preparado. TypeScript, ESLint e build de producao (61 paginas) passaram. Nenhum envio externo foi feito. Evidencia do painel, com valores ocultos: `evidencias/email-staging-configuracao-20261011.png`.

## Pendencias apos E0

Ainda falta o fluxo real cadastro → confirmacao → empresa → teste de 15 dias, e os pagamentos sandbox dos planos. E0 comprova apenas transporte/entrega pelo remetente verificado, sem conta ou cobranca.

Qualquer mudanca de SHA, origem, destinatario, flags ou numero de envios exige pacote atualizado. Autorizacao para E0 nao autoriza S3/S4 nem publicacao em producao.
