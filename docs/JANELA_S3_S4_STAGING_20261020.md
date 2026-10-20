# Janela S3 + S4 em staging — roteiro atualizado (20/10/2026)

Este roteiro atualiza o Bloco 2 de [RODADA_FINAL_LANCAMENTO_20261013.md](RODADA_FINAL_LANCAMENTO_20261013.md) para o estado de 20/10.

- **S3:** cadastro público real.
- **S4:** pagamento e renovação no sandbox do Asaas.

**Estado: PREPARADO, NÃO EXECUTADO.** A execução depende de autorização explícita de Felipe, porque grava no banco de staging e no Asaas sandbox e envia e-mails.

## O que mudou desde 13/10 (conferido em 20/10)

| Item | Situação |
|---|---|
| Código no ar em staging | `73618a2` (`dep-dbbj6l4s728c738kgvo0`). Inclui os executores e as PRs #187–#192. |
| Preços | 197/397/697, tabela `2026-10-20` (#189). O executor S4 já usa esses valores; seus testes passam 20/20. |
| Script S3 | Igual ao embutido em `evidencias/s3-staging-comandos-20261013.txt` (sha256 `4958e0bf…`). Os comandos S3-A/B/C valem sem mudança. |
| Banco de staging | `dpg-daidko3m8hqs73ce4jt0-a` / `kidmais_staging_1z91`, igual ao alvo fixado nos scripts. Depois da rotação de 14/10, mudou só o usuário (`kidmais_staging_app_v4`). |
| Rodada S4 | **A rodada 3 nunca foi executada.** O teste de "nada reaproveitado" falhava só porque este roteiro de 13/10 cita a flag. Ele passou a ser exceção explícita, como o pacote consolidado; a mudança está só no teste, e o executor não mudou. O executor também recusa rodar se encontrar estado anterior no disco (`RODADA_EXISTENTE_S1`). |
| Envs de site já no staging | `SITE_ATENDIMENTO_EMAIL=contato@demerzellabs.com.br`, `SITE_PRECOS_PUBLICADOS=true`, razão social, CNPJ e endereço. |
| Produção | Não é tocada por esta janela. |

## Passos

Os passos são os mesmos de 13/10, com as diferenças marcadas.

| # | Quem | Passo | Esperado / parada |
|---|---|---|---|
| W0 | Felipe, no Shell do staging | `cd /opt/render/project/src && node scripts/configuracao-homologacao-staging.cjs --conferir-restauracao` | `RESTAURADA`; caso contrário, parar. |
| W1 | Agente, pela API do Render, **com autorização**; ou Felipe, no painel | Uma única gravação com quatro chaves: `CADASTRO_PUBLICO_ATIVO=true`, `USUARIOS_CRIACAO_DIRETA=desativada`, `ASSINATURA_PLANOS_ATIVOS=true`, `COTACAO_PUBLICA_POR_EMPRESA=true`. Antes, conferir que a ponta da `staging` é a mesma do deploy no ar, porque gravar env faz deploy da ponta. | Um deploy até LIVE. |
| W2 | Felipe, no Shell | Comando **S3-A** | `PRONTO_PARA_CADASTRO`. Com `CADASTRO_RECUSARIA_503`, parar: há bloqueio global no staging, e o reparo de 20/10 foi só em produção. |
| W3 | Felipe, no navegador | Cadastro em `/cadastro` com `felipemenegaz+s3a@gmail.com`. Depois: e-mail, confirmação e empresa com CNPJ `82.654.321/0001-74`. | O e-mail chega e o teste de 15 dias começa. |
| W4 | Felipe, em aba anônima | Fazer o cadastro com `+s3b` e tentar o mesmo CNPJ. | Mensagem neutra, sem dados da empresa. |
| W5 | Felipe, no Shell | Comando **S3-B** | `S3_PASS` |
| W6 | Felipe, no Shell | S4 com `--pagamento-renovacao-rodada-3-autorizada` (comando completo em `RODADA_FINAL_LANCAMENTO_20261013.md`, W6). **Iniciar antes das 20h BRT.** A rodada leva cerca de 30 minutos. | Aprovado: Essencial mensal, Profissional anual, Premium mensal e renovação R0–R6. |
| W7 | Agente, pela API, **com autorização**; ou Felipe, no painel | Remover as quatro chaves numa única gravação. | Um deploy até LIVE. |
| W8 | Felipe, no Shell | Comando **S3-C** e depois `--conferir-restauracao` | `RESTAURADO` e `RESTAURADA` |

**Interrupção do S4:** usar `--encerrar-pagamento-renovacao-rodada-3-autorizada` e depois W7–W8.

**Efeitos permanentes no staging:**
- a empresa `TESTE S3`;
- as contas `+s3a` e `+s3b`;
- três vagas Fundador de staging confirmadas.

## Riscos conhecidos

- **Bloqueio global no staging (W2).** Se houver, a janela para antes de qualquer cadastro. O reparo correspondente seria uma operação nova, com autorização própria.
- **E-mail.** O S3-A exige `EMAIL_PROVIDER=resend` e o remetente `nao-responda@notificacoes.kidmaisfestas.com`. A entrega real foi provada em 13/10 (E0) e não foi repetida.
- **Mudança de env faz deploy da ponta da `staging`.** Se outra sessão mergear algo entre W1 e W7, esse código entra no ar. Conferir a ponta antes de cada gravação.

## Execução — 20/10/2026 (autorizada por Felipe; W1/W7 pelo agente, Shell/navegador por Felipe)

| Passo | Horário (UTC) | Resultado |
|---|---|---|
| W0 | antes de 09:54 | `RESTAURADA`, sem divergências |
| W1 | 09:54 → live 10:04 | 4 chaves por uma gravação na API; `dep-dbbjke8u01pc73e11ck0` em `73618a2` |
| W2 (1ª) | — | `CANDIDATA_DIVERGENTE`: o S3 fixava a candidata de 13/10 (`e819772`). Sem efeito. Corrigido: `SHA` do S3 = `73618a2`, comandos regenerados pelo gerador oficial, teste 4/4 |
| W2 | ~10:05 | `PRONTO_PARA_CADASTRO`; bloqueios globais futuros 0; Kidmais 1 empresa / 0 assinaturas |
| W3 | — | conta `+s3a` + empresa `TESTE S3` (CNPJ `82.654.321/0001-74`) criadas |
| W4 | — | `+s3b` + mesmo CNPJ → mensagem neutra ("Este CNPJ já está cadastrado… Nenhum dado da empresa é exibido aqui"), pedido de acesso registrado |
| W5 | — | **`S3_PASS`**: 1 empresa ATIVA, TESTE, 15 dias vigentes, 1 Gestão, sem provedor, 0 contratações; Kidmais intacta |
| W6 | 10:28:51 | **S4 parou no PRECHECK: Asaas sandbox `listar clientes` HTTP 401** (chave `ASAAS_API_KEY` do staging recusada). Encerramento: nada criado (fixtures, assinaturas, webhook); campanha Fundador antes = depois (2 confirmadas, 3 ocupadas). Arquivo de estado `pagamento-renovacao-rodada-3.json` ficou no disco |
| W7 | 10:32 → live 10:42 | Felipe removeu as 4 chaves no painel ("Save only"); agente conferiu a ponta (`73618a2`) e disparou `dep-dbbk68jrjlhs73ehousg` |
| W8 | depois de 10:42 | S3-C `RESTAURADO` (presentes: nenhuma); `--conferir-restauracao` `RESTAURADA`, sem divergências |

**S3: APROVADO. S4: NÃO EXECUTADO** (bloqueado pela chave do Asaas sandbox). Efeitos permanentes no staging: empresa `TESTE S3` (em teste), contas `+s3a`/`+s3b` e o pedido de acesso da `+s3b`. Nenhuma vaga Fundador mudou.

### Próxima tentativa do S4 (decisão de Felipe: arquivar o estado e repetir a rodada 3)

1. Felipe gera uma chave nova no Asaas **sandbox** e grava `ASAAS_API_KEY` direto no Render (nunca no chat); conferir também o token do webhook.
2. Nova janela: W0 → W1 (só `ASSINATURA_PLANOS_ATIVOS` e `COTACAO_PUBLICA_POR_EMPRESA` bastam para o S4) → arquivar o estado, provado vazio:
   `cd /opt/render/project/src/data/homologacao-planos-cotacao-20261010 && mv pagamento-renovacao-rodada-3.json pagamento-renovacao-rodada-3.precheck-401-20261020.json`
   → W6 → W7 → W8. Antes das 20h BRT.
