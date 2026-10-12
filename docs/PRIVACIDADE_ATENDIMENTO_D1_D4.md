# Privacidade do Atendimento WhatsApp — D1 a D4

Registrado em 11/10/2026. Trabalho só local: dados sintéticos e bancos descartáveis. Nada foi aplicado, implantado
ou enviado.

D1–D4 foram definidos na revisão da integração r47 (`CORRECOES_INTEGRACAO_WALLE_R47_20261009.md` §4, branch de
evidências):

- **D1:** a máscara aplicada antes do modelo é incompleta.
- **D2:** não há retenção nem exclusão.
- **D3:** os arquivos ficam públicos por token, sem expiração nem revogação.
- **D4:** a fase B envia o histórico de 24 h ao modelo.

**Enquanto não houver decisão sobre os itens da §3, o uso continua só com dados sintéticos e contatos controlados**,
inclusive em staging.

## 1. Matriz

| Item | Requisito | Implementação | Teste | Evidência |
|---|---|---|---|---|
| D1 | Minimização antes de **toda** chamada ao modelo | `ocultarDadosPessoais` (`lib/whatsapp/atendimento/core.ts`), usada pelas duas portas (Wall-e: `walle/porta.ts`; fase B: `entradaFaseB` + `interpretarMensagem`) e reforçada pela barreira do roteador (`lib/inteligencia/texto-modelo.ts`, inalterada) | `core.test.ts`, "D1: máscara cobre …" | unitárias do gate final |
| D1 | Documento com espaços, traços ou barras; CNPJ | regex de CPF e de CNPJ por separador | idem | idem |
| D1 | Telefone com e sem DDD, +55, 9 separado; e-mail por extenso; CEP; endereço com número (rua/avenida e quadras de Brasília); data de nascimento; nome em frase de identificação | `PADROES_PESSOAIS` (core.ts) | idem (17 casos que somem e 7 que precisam ficar: data e quantidade da festa, preço, tema, pergunta de endereço, frase comum) | idem |
| D1 | Dado de saúde nunca vai ao modelo | `dadoDeSaude` (core.ts). Na porta do Wall-e, o modelo não é chamado e a mensagem é entendida pelas regras (a alergia segue para a equipe pelo resolvedor). No worker da fase B, a mensagem é encaminhada à equipe sem modelo | `core.test.ts` ("D1: dado de saúde…"), `porta-regras.test.ts` (saúde fora do modo regras: nenhuma chamada nova), `service.test.ts` (guarda estática do worker) | idem |
| D1 | O nome do contato, o nome de perfil e o cadastro nunca vão ao modelo | já era assim; mantido | `service.test.ts` (sem nome_perfil, cliente_nome nem cadastro no worker) | idem |
| D4 | Histórico da fase B com as mesmas proteções | `entradaFaseB` (core.ts): cada entrada é minimizada **antes** do JSON (o CPF logo após "\n" escapava), tem no máximo 500 caracteres, e uma entrada com saúde vira marcador | `core.test.ts` ("D4: …") | idem |
| D2 | Campos derivados minimizados | `trechoParaRegistro` em `passagem.ultimaMensagem` (resolver e registros de bloqueio e pausa) | `core.test.ts`, `walle.test.ts` (rodada 18) | idem |
| D2 | Exclusão verificável a pedido | `excluirConversaAPedido` (`privacidade.ts`): só a gestão, só na empresa comprovada. Rota `POST /api/admin/atendimento` com `acao: excluir_dados` e `confirmacao: EXCLUIR` | `privacidade.postgres.test.ts` P1 | PG do gate final |
| D2 | Inclui campos derivados e tarefas pendentes | Uma transação sob a trava da conversa: mensagens, status do provedor, nome de perfil, memória (`contexto`), passagem e interesse saem; pendentes saem junto; PROCESSANDO/ENVIANDO ou linha travada pelo worker adia (nada apagado) | P1, P3 | idem |
| D2 | Registro sem dado pessoal | `whatsapp_atendimento_privacidade` (082): ids, contagens, autor e prazo; sem contato nem texto | P1 (o registro não contém o número nem o CPF sintético) | idem |
| D2 | Retenção | `aplicarRetencao`, chamada a cada ciclo do worker, para todas as empresas do ambiente. **Sem prazo padrão**: `WHATSAPP_ATENDIMENTO_RETENCAO_DIAS` (1–3650) liga; ausente ou inválido não apaga nada | P4 (ausente, vazio, "abc", 0 e 99999 não apagam; 30 apaga só o inativo, de todas as empresas) | idem |
| D2 | Isolamento | Outra empresa recebe "não encontrado"; a conversa de outra empresa com o mesmo número fica idêntica | P1 | idem |
| D3 | Revogação | `revogarArquivo`: conteúdo apagado e link trocado (irreversível, garantido pelo gatilho `whatsapp_arquivos_controle` da 082). As prontas que usam o arquivo são arquivadas e as saídas na fila, canceladas. Recusa com envio em andamento | P5 | idem |
| D3 | Troca de link e expiração | `trocarLinkArquivo` (o link antigo deixa de servir), `definirExpiracaoArquivo` (expira_em). Rota `PATCH /api/admin/atendimento/arquivos` | P6, P7 | idem |
| D3 | Revogado, vencido ou de empresa inativa não é servido nem enviado | `ARQUIVO_DISPONIVEL_SQL` (arquivos.ts) na rota pública, no worker e nas listagens | P5, P7 (worker cancela a saída), P8 (empresa suspensa) | idem |
| D3 | Isolamento | Revogação e troca só na empresa comprovada (outra empresa: "não encontrado"); a FK do arquivo inclui empresa, ambiente e tipo (082) | P5 | idem |
| D3 | O banco impede atalhos | O gatilho recusa DELETE, a restauração de revogado, a troca de conteúdo sem revogação e a troca de token sem registro | P5, P6, `migration-082.postgres.test.ts` | idem |

## 2. Limites reais

- **Cópias de terceiros.** A revogação e a exclusão **não** apagam:
  - o que o provedor (Gupshup/Meta) já baixou ou guardou;
  - a mídia e as mensagens no aparelho do cliente;
  - backups do banco já feitos.

  O link revogado deixa de servir de imediato. Uma cópia já baixada não pode ser recolhida.
- **Provedor.** A mensagem enviada continua no WhatsApp do cliente e nos registros do provedor, conforme a política
  deles. Excluir aqui não pede exclusão no provedor.
- **Nomes.** Um nome solto no meio da frase ("festa da Ana") não é reconhecível por regra sem apagar também temas
  ("festa da Frozen"). Mitigação: o contato, o nome de perfil e o cadastro nunca vão ao modelo; nomes em frases de
  identificação são ocultados. No modo IA, um nome solto pode chegar ao modelo.
- **Falsos positivos de saúde.** Palavras como "glúten" e "remédio" fazem a mensagem ser entendida só pelas regras.
  Isso tira qualidade de algumas respostas, mas não muda a segurança.
- **Auditoria.** A linha de auditoria da ação (assumir, encerrar, enviar) fica, sem o vínculo com a conversa excluída.
- **Retenção.** Roda só no ciclo do worker (com o atendimento ligado). O prazo conta pela última entrada e pela última
  atualização da conversa.

## 3. Decisões de produto pendentes

Nada disto foi escolhido silenciosamente.

| # | Decisão | Estado no código |
|---|---|---|
| R1 | **Prazo de retenção** das conversas (dias sem atividade) em staging e em produção | Sem padrão: nada é apagado até a variável ser definida |
| R2 | Contato que pediu PARAR: guardar só o número e a marca depois da exclusão? (base legal do `nao_contatar`) | Implementado como "guarda o número e a marca"; confirmar |
| R3 | Quem pode excluir a pedido: só a gestão (representante) ou também a equipe? É preciso reautenticação? | Só a gestão, com confirmação digitada; sem reautenticação |
| R4 | Expiração padrão dos arquivos da biblioteca | Sem padrão (nunca expira até alguém definir) |
| R5 | Tela para excluir conversa e revogar/trocar o link de arquivo | Só a API; a tela fica para uma entrega própria de UX |
| R6 | Modo IA com dados reais, aceitando o limite dos nomes soltos (§2), ou modo regras | Modo regras disponível (`WHATSAPP_ATENDIMENTO_WALLE_ENTENDIMENTO=regras`) |
