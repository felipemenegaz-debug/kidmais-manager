# Correções de smoke: lixeira e revisão antes do aceite

## Lixeira

O botão da primeira confirmação era desabilitado silenciosamente para motivo
menor que três caracteres. O painel também usava um layout horizontal de aviso,
sem o estilo de campo de formulário. Agora a tentativa inválida informa o motivo,
foca o campo e não chama a API. A segunda etapa mostra cliente, ação, motivo e
preservação do histórico. A API continua sendo chamada somente na confirmação
final, com a mesma chave em retry da mesma intenção.

## Contratos

- EM_ELABORACAO: edição da preparação corrente.
- ASSINADA_KIDMAIS / AGUARDANDO_CLIENTE: `substituir_preparacao`, motivo e chave
  obrigatórios. Encerra a preparação anterior como CANCELADA e cria uma versão
  em elaboração na mesma transação. Não apaga snapshot, PDF, prova ou assinatura.
- ASSINADO pelas duas partes: mantém `nova_versao` e a revisão operacional 014.
- Preparação congelada sobre contrato já vigente: cancela apenas a proposta,
  copia a operação e os adicionais para outra preparação e revalida o destino;
  preserva a vigência, Festa e ocupação efetiva. Falha aborta a transação.

Antes da primeira formalização não se cria fechamento_revisoes: essa estrutura
exige base ASSINADA e vínculo com a versão vigente. A nova versão documental usa
o fechamento ainda não formalizado, mantendo as validações da edição inicial.
Os estados e constraints das migrations existentes permitem esse fluxo; não há
migration nova nem alteração das migrations antigas.

O token de acesso público é assinado e vinculado à versão. A versão encerrada
deixa de aceitar leitura/aceite pelo carregador comum, mesmo com token/prova
anteriores, e orienta o cliente a consultar a revisão recente. Não se altera o
provider OTP nem se revogam indiscriminadamente provas de outras contratações.
Novo acesso exige liberação da nova versão após novo PDF/revisão/assinatura Kidmais.

Substituição e aceite bloqueiam fechamento e contrato antes de operar a versão.
Se o aceite vencer, a substituição da preparação é recusada; se a substituição
vencer, o acesso antigo é recusado. Retry da substituição recupera a versão criada
pela auditoria da mesma intenção, sem repetir a criação.

## Validação local

Testes de serviço: `lib/contratos/services/revisao-pre-assinatura.test.ts`, junto
das regressões de revisão pós-assinatura, lixeira, fila e Festa 019.

Interação real em navegador, usando build local e APIs inteiramente simuladas:

```text
node --test scripts/lixeira-interacao.test.mjs
```

Requer Playwright disponível no ambiente (ou PLAYWRIGHT_MODULE com seu caminho)
e Microsoft Edge instalado. Usa apenas localhost:3137, sem banco e sem imagens/logs
no repositório. Cobre desktop/celular, validação, duas etapas, cancelamento, falha,
retry com mesma chave, exclusão, lista ativa, lixeira, restauração e arquivamento.

Limite: não substitui ensaio de concorrência física e rollback em PostgreSQL
descartável autorizado. Nenhum acesso a production/banco real é necessário aqui.
