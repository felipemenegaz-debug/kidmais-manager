# Atendimento WhatsApp — roteiro de homologação em staging

Preparado em 04/10/2026. **Nada deste roteiro foi executado.** Evidências locais: código do WhatsApp validado em `a55aed8`; base integrada e tela validadas em `918b0a1`, local (ver o handoff). Ele detalha o que provar na janela de homologação. As etapas operacionais (E0–E8, com alvo, efeito e recuperação) estão em [WHATSAPP_ATIVACAO_STAGING.md](WHATSAPP_ATIVACAO_STAGING.md), e cada uma exige autorização própria ([OPERACAO_AGENTES.md](OPERACAO_AGENTES.md)).

## Pré-condições (bloqueantes)

1. **Autenticação Gupshup comprovada.** Resposta ao chamado #277630: mecanismo suportado e acesso ao app `KidmaisManager`. Não enfraquecer o webhook nem alterar assinaturas para contornar.
2. **Receptor exclusivo (E0).** Assinaturas do app e variáveis de produção, por leitura autorizada, sem outro receptor com resposta automática.
3. **OTP preservado (E3).** Depois do deploy, o login com OTP funciona em staging e o webhook continua 204 para os status de OTP.
4. **Autorizações e janela:**
   - destinatário de teste autorizado (D2), o único na lista de permitidos;
   - worker na máquina do Felipe, só na janela;
   - textos iniciais aprovados ([WHATSAPP_RESPOSTAS_INICIAIS.md](WHATSAPP_RESPOSTAS_INICIAIS.md)) ou decisão de homologar com os atuais;
   - teto de orçamento de staging definido.

## Cenários

**Legenda:**
- **Evidência local:** já provado sem provedor real (testes com mocks e PostgreSQL descartável), no commit indicado.
- **Verificação real:** o que só o Gupshup real comprova, ainda pendente.

| # | Cenário | Evidência local (commit) | Verificação real pendente | Como observar | Etapa |
| --- | --- | --- | --- | --- | --- |
| H0 | OTP preservado | `webhook.test.ts`; transporte separado do OTP (`a55aed8`) | Login com OTP em staging depois do deploy; status de OTP com 204 | Login real com o usuário de teste; log sanitizado do webhook | E3 |
| H1 | Canal desligado só registra metadados | `webhook.test.ts`; recepção desligada sem empresa ou receptor (`a55aed8`) | Mensagem do número de teste não gravada com `RECEIVE_ENABLED` desligado | Log `[Gupshup webhook]` sem conteúdo; tela sem conversa | E5 |
| H2 | Autenticação e recepção | Cabeçalho exigido; sem cabeçalho = 401; deduplicação no PostgreSQL passo 3 (`a55aed8`) | Evento real com o cabeçalho da assinatura é aceito. Retry do Gupshup não duplica. Número fora da lista é confirmado sem gravar | Tela: conversa "Aguardando atendente" ou "IA atendendo"; contagem de mensagens | E6 |
| H3 | Resposta publicada e status | Envio 2xx; status antes do retorno (PostgreSQL 7); correlação `gsId ?? id` (`a55aed8`) | Envio real devolve 2xx com `messageId`. A mensagem vai de SUBMETIDA a ENTREGUE pelo `delivered`/`read` real | Tela: "Enviada ao provedor" e depois "Entregue" | E7 |
| H4 | Qualificação | `core.test.ts` (data inválida, passada, ano ausente) (`a55aed8`) | Texto real recebido no aparelho; a final diz que a data não está reservada | Aparelho de teste e tela | E7 |
| H5 | Tomada humana | PostgreSQL 5 (assumir durante a geração); envio humano exige assumir (`a55aed8`) | Assumir enquanto a IA gera não envia resposta automática; a resposta humana chega | Tela e aparelho | E7 |
| H6 | PARAR | PostgreSQL 6a (`a55aed8`) | Nada mais é enviado; a tela bloqueia as ações | Tela e aparelho | E7 |
| H7 | Mídia | `core.test.ts` (sem modelo) (`a55aed8`) | Imagem vai para a equipe sem chamar o modelo | Tela: "Conteúdo sem texto"; trace sem chamada | E7 |
| H8 | Vazão | Lote e dois workers em paralelo no PostgreSQL 4 (`a55aed8`) | Rajada de 10 mensagens: uma resposta por rajada; medir o tempo até cada resposta | Horários na tela | E7 |
| H9a | Orçamento | PostgreSQL 8b (modelo indisponível) e 8d (limite) (`a55aed8`) | Teto baixo de staging: o contato recebe o texto fixo e a conversa vai para a equipe | Tela; trace de recusa de orçamento | E7 |
| H9b | Resposta publicada revogada | PostgreSQL 8f; unitários (`a55aed8`) | Corrigir ou remover uma resposta com a saída pendente: o texto antigo não sai | Tela: "Não enviada", com a explicação | E7 |
| H9c | Worker interrompido | PostgreSQL 8 (`a55aed8`); worker externo (`worker-externo.test.ts`) | Parar o worker mais de 10 min: a conversa vai para a equipe e nada é reenviado | Tela: "Aguardando atendente"; estados FALHOU/INCERTO | E7 |
| H9d | Timeout do provedor | `transporte.test.ts`, `worker.test.ts` (`a55aed8`) | **Não forçar no Gupshup real.** Fica só a evidência local | — | — |
| H10 | Janela de 24 h | PostgreSQL 6b (`a55aed8`) | Ao vivo só se houver tempo para a expiração real; senão fica a evidência local | Tela: motivo "janela de 24 horas expirou" | E7 |
| H11 | Encerramento | — | Flags desligadas, worker parado, lista vazia, assinatura de staging removida ou desligada; assinaturas anteriores iguais às de E0 | Tela tudo desligado; painel Gupshup | E8 |
| UX | Tela em celular, desktop e teclado | QA Playwright com APIs simuladas: fila contada nas conversas carregadas, explicação de saídas não entregues, motivos de bloqueio (`918b0a1`) | Conferência visual do Felipe com dados reais de teste | Celular e desktop | E7 |

**Interrupção imediata:**
- envio a número fora da lista;
- mensagem de cliente real gravada;
- texto fora das respostas publicadas ou dos fixos aprovados;
- erro de isolamento;
- resposta automática vinda de outro ambiente;
- falha do OTP.

Nesses casos: desligar as flags, parar o worker, remover a assinatura de staging e registrar.

## Evidência a registrar

Sanitizada: sem telefone completo, sem conteúdo de cliente e sem segredos.

Por cenário:
- horário (UTC);
- commit implantado;
- resultado (OK, falhou ou não executado);
- estado na tela;
- código HTTP do webhook;
- trace e estado das mensagens.

O registro vai num documento datado, ligado ao commit implantado. "Homologado com Gupshup real" só vale para os cenários executados com sucesso.
