# Convites — geração sem resultado: chamada única, recuperação e fila do operador (18/10/2026)

## O que muda para quem usa

- **Buffet e cliente** acompanham o pedido original.
  - Clique duplo, recarga, outra aba, queda de conexão ou timeout **não enviam outra geração paga**.
  - Quando o resultado não foi confirmado, a tela mostra só: *"Estamos verificando sua geração. Você não precisa tentar novamente."*
  - A festa fica protegida contra nova cobrança até a verificação.
- **O cartão "Revisar geração sem resultado" saiu do editor**, junto com as decisões financeiras e a ação `recuperar` da API do convite. Uma chamada a `recuperar` hoje responde 400 (comando inválido).
- **O operador da plataforma** (concessão de desenvolvedor) tem a fila **Painel do desenvolvedor → Gerações de convites** (`/desenvolvedor/convites`), com:
  - classe da falha e evidência sanitizada;
  - identificadores para o suporte do provedor;
  - decisão "cobrança confirmada" ou "sem cobrança", com evidência obrigatória, senha confirmada há no máximo 5 minutos e auditoria do painel;
  - **"Concluir com a imagem recebida"**, quando a imagem paga ficou retida: reprocessa sem chamar o provedor e mantém o crédito;
  - histórico de decisões anteriores e do que foi tratado automaticamente.

## Limites documentados do provedor

Conferidos em 18/10/2026, na documentação oficial da OpenAI, sem nenhuma chamada à API.

| Capacidade | Images API (`/v1/images/generations` e `/edits`, modelos `gpt-image-2.5-flare`/`-sunburst`) |
|---|---|
| Idempotência | **Não existe** `Idempotency-Key`. O `X-Client-Request-Id` (até 512 ASCII) só ajuda o suporte a verificar *se e quando* recebeu o pedido. |
| Consultar status ou recuperar a imagem depois | **Não existe** (só `generations`/`edits`; a resposta não tem `id`; não há `retrieve`). O `x-request-id` serve só para troubleshooting. |
| Cobrança por requisição | **Não existe**. `usage/images` é agregado por minuto e `costs` por dia, por projeto, chave, modelo ou origem. |
| `moderation_blocked` | Documentado com `moderation_details`, mas **sem menção a cobrança**. A orientação é não repetir sem mudar o pedido. |
| Timeout | **Não documentado** se o pedido segue sendo processado ou cobrado. |
| Assíncrono com recuperação | Só o **Batch API** (janela de 24 h, `custom_id`) aceita estes modelos. `background:true` com a ferramenta `image_generation` do Responses **não está documentado em conjunto**. |
| Retries | Os SDKs oficiais repetem 2× por padrão. **Este código não usa SDK**: usa `fetch` direto, sem nenhuma repetição. |

Fontes:
- developers.openai.com/api/reference/overview
- developers.openai.com/api/reference/resources/images
- developers.openai.com/api/docs/guides/image-generation
- developers.openai.com/api/docs/guides/error-codes
- developers.openai.com/api/docs/guides/batch
- developers.openai.com/api/docs/guides/background
- os métodos de uso e custos da Admin API

**Consequência:** nenhuma resposta perdida pode ser recuperada no provedor, e nenhuma cobrança pode ser conferida por requisição. Modelo, endpoint e moderação **não mudaram**.

## Como funciona

A proteção existente foi mantida, sem um segundo fluxo:
- a chave do pedido é o id da geração;
- reserva, créditos e orçamento ficam numa transação;
- há no máximo uma `RESERVADA` por festa.

A migration **084** acrescenta as etapas duráveis e o marcador `etapas_registradas`.

O marcador vale `false` para linhas existentes e para o código anterior, e o código novo grava `true`. Só gerações com o marcador podem ser enviadas por este código ou devolvidas automaticamente. Uma reserva antiga, ou de uma instância anterior ainda ativa durante o deploy, não tem `enviado_em` mesmo tendo chamado o provedor: ela **nunca** é devolvida automaticamente e, depois de 10 min, vai para o operador (`legado_sem_registro`).

1. **Antes do envio**, `enviado_em` é gravado e confirmado. Sem esse registro, a chamada não sai. Uma segunda tentativa de envio na mesma geração é recusada. O cabeçalho `X-Client-Request-Id` leva a chave.
2. **Ao receber uma resposta 2xx**, os bytes da imagem (não o corpo inteiro) são guardados em `resultado_pendente`, junto com `recebido_em` e o uso, **antes** do processamento local.
3. **Ao gravar a arte**, a geração passa para `CONCLUIDA` e a imagem pendente é apagada. Se a gravação falha, ela é repetida localmente até 3 vezes, **nunca** a chamada paga. Se ainda falhar, a próxima leitura conclui com a imagem guardada.
4. **Classificação da falha** pela etapa comprovada:

| Classe | Prova | Efeito |
|---|---|---|
| `PRE_ENVIO` | `enviado_em` nunca gravado | **Automático:** `NAO_ENVIADA` e devolução única de festa, cliente, mês e dia. Tela: "Não foi possível iniciar… nenhum crédito foi usado". |
| `RESPOSTA_PROVEDOR` | Resposta HTTP de erro do provedor (inclui `moderation_blocked`) | `INCERTA`, reserva mantida, fila do operador |
| `DESCONHECIDA` | Enviado, sem resposta conclusiva (timeout, rede, corpo inválido, processo reiniciado) | `INCERTA`, reserva mantida, fila do operador |
| `ARMAZENAMENTO` | Imagem recebida, mas o processamento ou a gravação local falhou | Gravação falhou e a imagem está guardada: **automático**, conclui na próxima leitura depois de 30 s. Processamento falhou: `INCERTA` com a imagem retida; o operador pode concluir com ela ou decidir a cobrança. |
| `DEVOLUCAO_FALHOU` | Não enviada, mas a devolução automática não fechou (contadores divergentes) | `INCERTA` (savepoint desfaz a devolução parcial); fila do operador, em vez de travar a festa |

5. **Reconciliação sem provedor.** Roda dentro da transação que já trava o convite (consulta, situação, nova geração e fila do operador):
   - `RESERVADA` do código novo sem envio há mais de 2 min → `NAO_ENVIADA` + devolução (ou `DEVOLUCAO_FALHOU`);
   - `RESERVADA` sem o marcador (código anterior) há mais de 10 min → `INCERTA` (`legado_sem_registro`), sem devolução;
   - enviada há mais de 10 min sem resposta registrada → `INCERTA` (`DESCONHECIDA`);
   - imagem guardada há mais de 30 s → arte.

   A devolução trava a carteira antes do orçamento do dia e do consumo do mês, na mesma ordem da reserva, para não haver deadlock entre elas. Não há execução agendada: a reconciliação roda quando alguém abre o convite ou a fila do operador.

   Uma falha de banco aqui é adiada (savepoint) e não impede a leitura.
6. **Editor:**
   - guarda a chave do pedido na aba (`sessionStorage`, só a chave e um resumo; nunca prompt ou foto);
   - em conexão perdida ou resposta indefinida, acompanha a **mesma** geração por `GET ?geracao=<chave>` (leitura leve, sem imagens);
   - outra aba que tenta gerar enquanto há uma em andamento recebe essa geração para acompanhar.

**Decisões que nunca são automáticas:**
- devolver por timeout, por tempo decorrido, por `moderation_blocked` ou por "No usage data";
- confirmar cobrança sem evidência.

## Verificações locais

Todas com provedor simulado e dados sintéticos, sem rede.

- `lib/convites/service.test.cjs` (59):
  - clique duplo e chaves concorrentes;
  - outra aba e recarga;
  - queda antes e depois do envio;
  - banco indisponível ao marcar o envio;
  - segundo envio recusado;
  - imagem guardada com gravação falhando;
  - persistência sem imagem;
  - imagem inválida;
  - reinício com as 4 situações;
  - operador: decisões concorrentes, virada UTC e permissões;
  - reserva sem o marcador, devolução que não fecha, conclusão com a imagem retida e ordem das travas.
- `lib/convites/recuperacao.test.cjs` (4) e `lib/desenvolvedor/convites-geracoes.test.cjs` (6): concessão, senha recente, auditoria e erros.
- `lib/convites/imagem-openai.test.ts`: extração e reprocessamento pelo mesmo caminho.
- `scripts/migration-084-staging.test.cjs` (6).
- `scripts/migration-084-production.test.cjs` (16): trava de alvo, TLS, hashes, plano, leitura sem escrita, marcador anti-repetição que preserva as etapas numa falha.
- `scripts/convites-postgres.cjs`, PostgreSQL 18 descartável, 073/074/079/084 (38 verificações):
  - travas e constraints reais;
  - a reconciliação segurando a linha enquanto o marcador espera (nada sai);
  - devolução e reserva da mesma empresa em paralelo, sem deadlock;
  - fila do operador com o módulo real.
- `scripts/convites-geracao-pendente-ui.cjs`: navegador com APIs simuladas, telas do buffet, cliente e operador.

## Dependência e ordem para publicar

1. **Migration 084 antes do código.** Ela é aditiva, e o código anterior funciona com ela aplicada.

   **Em staging**, use `scripts/migration-084-staging.cjs`:
   - `--conferir-084`: somente leitura;
   - `--aplicar-084-autorizado`: exige autorização própria e backup operacional.

   **Em produção**, use `scripts/migration-084-production.cjs` no Web Shell do web de produção (aplicada em 18/10/2026):
   - sem argumentos: mostra o plano, sem conexão;
   - `--conferir-084`: só leitura (identidade TLS/rede privada, 073/079, precheck ou postcheck); não grava nada;
   - `--aplicar-084-autorizado`: exige autorização própria; uma tentativa só (marcador `data/convites-geracao-pendente-producao-20261018/migration-084.json`);
   - em `FALHA`: **não repetir**. Ler o marcador (as etapas concluídas ficam registradas) e rodar `--conferir-084`: `JA_APLICADA_POSTCHECK_PASS` indica que a DDL foi confirmada.
   - `estadosIguais: false` é só informativo: o app pode concluir uma geração entre as leituras, e a 084 não tem DML.
2. Deploy do código.
3. **Rollback:**
   - código: voltar ao deploy anterior; a 084 pode ficar aplicada;
   - 084: `database/rollback/20261018_084_convite_geracao_pendencias_down.sql`, que só funciona **antes** de qualquer geração do código novo (com marcador ou etapa).

Nenhuma geração existente é alterada: a `2c911441…` continua `INCERTA` e aparece na fila como "anterior à classificação".
