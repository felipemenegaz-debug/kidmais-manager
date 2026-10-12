# Privacidade do Atendimento WhatsApp — D1 a D4

Registrado em 11/10/2026 e revisado em 12/10/2026, depois da revisão independente da candidata `8b2c55d`. Trabalho só
local: dados sintéticos e bancos descartáveis. Nada foi aplicado, implantado ou enviado.

D1–D4 foram definidos na revisão da integração r47 (`CORRECOES_INTEGRACAO_WALLE_R47_20261009.md` §4, branch de
evidências):

- **D1:** a máscara aplicada antes do modelo é incompleta.
- **D2:** não há retenção nem exclusão.
- **D3:** os arquivos ficam públicos por token, sem expiração nem revogação.
- **D4:** a fase B envia o histórico de 24 h ao modelo.

**D1–D4 NÃO estão concluídos.** Os testes passarem prova o que está escrito nas matrizes, não que o risco acabou. Há
lacunas medidas (§1, §4) e decisões de produto abertas (§5). **Enquanto isso, o uso continua só com dados sintéticos e
contatos controlados, inclusive em staging, e o modo IA continua bloqueado para dados reais.**

## 1. D1 e D4 — o que vai ao modelo

| Requisito | Implementação | Teste |
|---|---|---|
| Normalizar antes de analisar | `normalizarParaPrivacidade` (core.ts): NFKC e remoção de caracteres de formatação e invisíveis (`\p{Cf}`, `Default_Ignorable_Code_Point`, controles, exceto tab e quebras). Usada por `ocultarDadosPessoais` e por `dadoSensivel` | `privacidade-texto.test.ts` (dígitos de largura total, espaço zero, hífen suave, joiner) |
| Minimização antes de **toda** chamada ao modelo | `ocultarDadosPessoais`: CPF/CNPJ com separadores, telefone, e-mail por extenso, CEP, endereço, data de nascimento, nome em frase de identificação (inclui "sou", "me chamo", "mãe do/da", "o nome dele é"). Usada pela porta do Wall-e e pela fase B; a barreira do roteador (`lib/inteligencia/texto-modelo.ts`) continua | `core.test.ts`, `privacidade-texto.test.ts` |
| Dado sensível nunca vai ao modelo, na mensagem atual **e em cada entrada do histórico** | `dadoSensivel` (core.ts): saúde, alergia e restrição alimentar (a mesma regra `ALERGIA` do Wall-e, agora em `walle/alergia.ts`), deficiência e acessibilidade, religião, origem étnica, orientação sexual, dado genético, e siglas (APLV, TEA, TDAH, CID, PKU, HIV, PCD…). Mensagem atual sensível: o Wall-e usa só as regras; a fase B passa à equipe sem modelo. Entrada sensível no histórico: vira `[mensagem com dado sensível omitida]` (`entradaFaseB`) | `privacidade-texto.test.ts`, `porta-regras.test.ts`, `worker.test.ts` |
| Campos derivados sem cópia do dado sensível | `trechoParaRegistro` (`passagem.ultimaMensagem` e registros de bloqueio e pausa): mensagem sensível vira `[mensagem com dado sensível: ver o histórico]` | `privacidade-texto.test.ts` |
| Nome e texto devolvidos pelo modelo | `textoDoModeloSeguro` + regra do tema (`walle/entendimento.ts`): o tema do modelo só é aceito se não tiver dado sensível nem marcador de máscara e se aparecer no texto **já mascarado** enviado ao modelo. Um nome que o modelo "reconstruísse" não volta para a memória | `privacidade-texto.test.ts` |
| Modo padrão | `entendimentoSoRegras` (configuracao.ts): **regras por padrão**. O modelo só roda com `WHATSAPP_ATENDIMENTO_WALLE_ENTENDIMENTO=modelo`, que não deve ser ligado com dado real enquanto R6 estiver aberta | `composicao-ia.test.ts` |
| Contato, nome de perfil e cadastro | nunca vão ao modelo (mantido) | `service.test.ts` |

### Cobertura medida (não é garantia)

Um corpus **independente** de 200 mensagens sintéticas (`lib/whatsapp/atendimento/dados-teste/corpus-sensivel-independente.json`)
foi escrito e rotulado por um agente **sem acesso ao detector**. O detector não foi ajustado a ele depois da medição, para
que a próxima medição continue honesta. `privacidade-cobertura.test.ts` guarda a linha de base e falha só em regressão.

| Categoria | Detectadas |
|---|---|
| Alergia e restrição alimentar | 48/50 |
| Condição de saúde | 30/40 |
| Deficiência e acessibilidade | 13/18 |
| Religião e crença | 10/12 |
| Origem étnica e outros | 3/8 |
| **Total sensíveis** | **104/128 (81,3%)** |
| Falsos positivos (não sensíveis marcados) | 6/72 |

Ampliar a lista de palavras não fecha a lacuna: 24 das 128 frases sensíveis passaram, e outras formulações também
passarão. Por isso o modo IA continua bloqueado com dado real. Um aumento de cobertura precisa ser medido com um corpus
**novo** e independente, não com este.

Efeito nas decisões gravadas da IA real (h44, h45, h47, sem rede): 16 das 240 mensagens têm dado sensível e passam a ser
entendidas pelas regras; **0** decisões mudam (`int-saude-impacto.mjs`, relatório de evidências).

## 2. D2 — exclusão, controles mínimos, reentrega e retenção

| Requisito | Implementação | Teste |
|---|---|---|
| Exclusão a pedido | `excluirConversaAPedido` (privacidade.ts) pela tela **Admin › Atendimento › Privacidade** ou `POST /api/admin/atendimento/privacidade` (`acao: excluir_conversa`, `confirmacao: EXCLUIR`, motivo `PEDIDO_DO_TITULAR` ou `DECISAO_DA_EMPRESA`) | `privacidade.postgres.test.ts` P1, `privacidade-tela.test.ts` |
| Quem pode | Gestão (`REPRESENTANTE_AUTORIZADO`) da **empresa ativa da sessão**, comprovada pelo Tenant Context — **não** a empresa piloto do bot. Escritas pedem senha confirmada há no máximo 5 minutos (`ATENDIMENTO_REAUTENTICACAO`) | P1 (outra empresa, equipe e senha antiga recusadas), P6 (empresa que não é a piloto) |
| O que sai | numa transação sob a trava da conversa: mensagens (texto, mídia, fonte), status do provedor, nome de perfil, memória do Wall-e, passagem, interesse e a conversa; a auditoria fica sem o vínculo | P1 |
| Tarefa em andamento | PROCESSANDO/ENVIANDO ou linha travada pelo worker: `ATENDIMENTO_EXCLUSAO_ADIADA`, nada apagado | P4 |
| PARAR, pausa e equipe não se perdem | `whatsapp_atendimento_controles_contato` (082), **separada do conteúdo**: só empresa, ambiente, número e três marcas (`nao_contatar`, `sem_automatico`, `com_equipe`). A conversa nova do número herda as marcas na recepção: PARAR ⇒ encerrada e sem contato; pausa ⇒ equipe, sem automação e "Devolver ao Wall-e" recusado; equipe ⇒ equipe. A linha é consumida nessa hora. Contato comum não deixa controle | P2 |
| Reentrega não recria | O id de cada mensagem recebida vira SHA-256 em `whatsapp_atendimento_eventos_excluidos` (empresa + ambiente + provedor + hash; sem texto nem nome). A recepção descarta a reentrega desse id | P3 (mesmo id em outra empresa não é afetado; evento novo grava) |
| Registro sem dado pessoal | `whatsapp_atendimento_privacidade`: ids, contagens, autor, motivo, prazo e se manteve pausa/equipe; sem contato nem texto | P1 |
| Retenção | **Sem prazo padrão.** Cada empresa define o próprio prazo (1–3650 dias sem atividade) ou nenhum, na tela, com reautenticação. `executarRetencao` roda pela rota protegida `POST /api/integracoes/gupshup/atendimento/retencao` (segredo do worker, https) ou pelo script `scripts/whatsapp-atendimento-retencao.mjs`; **independente** das chaves do canal e da IA | P5 (sem prazo nada sai; só a empresa com prazo; leitura estática sem as chaves), `whatsapp-atendimento-retencao.test.mjs` |
| Por conversa, com erro observável | uma transação por conversa; a falha de uma é contada e registrada (só o código, ex.: `SQLSTATE_P0001`) e as demais seguem; cada execução fica em `whatsapp_atendimento_retencao_execucoes` (estado, contagens, erros) e a última aparece na tela; o script sai com código 1 em falha | P5 (falha injetada numa conversa) |
| Pendentes antigas | uma entrada pendente de conversa sem atividade além do prazo (≥ 1 dia) já não pode ser respondida (fora da janela de 24 h e do prazo de saída): sai com a conversa e é **contada** (`pendentes_removidas`), nunca em silêncio. Tarefa em processamento adia a conversa (contada) | P5 |
| Isolamento | outra empresa recebe "não encontrado"; a conversa de outra empresa com o mesmo número fica idêntica | P1 |

### Tratamento futuro dos dados mínimos guardados

- **Controles de contato** (número + marcas): ficam até uma conversa nova do número consumi-los. Um número que nunca
  volta deixa a linha indefinidamente. O prazo e a base legal dessa guarda são a decisão **R2** (§5); o código não
  escolhe prazo.
- **Hashes de deduplicação**: guardados por `RETENCAO_DEDUP_DIAS = 30` dias e apagados pela rotina de retenção mesmo
  sem prazo de conteúdo. É um **prazo técnico**, provisório, para cobrir reentregas do provedor; não guarda texto nem
  nome. Confirmar o valor é a decisão **R7**.
- **Registro de privacidade e execuções da retenção**: sem prazo de expurgo nesta entrega (R7).

## 3. D3 — arquivos da biblioteca

| Requisito | Implementação | Teste |
|---|---|---|
| Revogação | `revogarArquivo`: conteúdo apagado e link trocado; prontas que usam o arquivo arquivadas; saídas na fila **e as irmãs do mesmo grupo** ("segue o PDF") canceladas com motivo `ARQUIVO_REVOGADO`; o material sai da memória de envio do Wall-e e a conversa automática vai para a equipe | P7, `revogacao-envio.postgres.test.ts` C1, C4 |
| Troca de link | `trocarLinkArquivo`: o anterior deixa de servir na hora | P7 |
| Expiração | `definirExpiracaoArquivo`: `agora` (acesso e fila invalidados na hora, com o mesmo tratamento do grupo) ou data futura até 5 anos. Data passada ou inválida: `ATENDIMENTO_DATA_INVALIDA` (400). Arquivo já vencido não muda por aqui (`ATENDIMENTO_ARQUIVO_VENCIDO`) | P7 |
| Reativação | só por `reativarArquivo`, ação explícita, com link **novo** (o anterior nunca volta) e registro. O gatilho da 082 recusa reativar um vencido sem trocar o token | P7 |
| Indisponível não sai | `ARQUIVO_DISPONIVEL_SQL` (não revogado, não vencido, empresa ativa) na rota pública, no worker, na escolha do Wall-e (`prontasAutorizadas`) e no envio manual (`ATENDIMENTO_ARQUIVO_INDISPONIVEL`, recusado na hora) | P8, P9 |
| Grupo com arquivo indisponível no envio | o worker cancela a saída e o resto do grupo com motivo `ARQUIVO_INDISPONIVEL`, tira o material da memória de envio e chama a equipe. Nunca um "segue o PDF" sem o PDF, nunca cancelamento silencioso (o motivo aparece na conversa) | P9, `worker.test.ts` |
| Cache | rota pública com `Cache-Control: no-store, max-age=0` e `Pragma: no-cache`: navegador e proxy não guardam cópia que sobreviva à revogação | P7 |
| Isolamento | ações só na empresa ativa da sessão; outra empresa recebe "não encontrado"; empresa suspensa não serve arquivo | P7 |

### Corrida revogação × envio e ponto sem volta

Provada por `revogacao-envio.postgres.test.ts`, com a ordem imposta por travas e confirmada em `pg_stat_activity`:

- As ações de arquivo rodam no Tenant Context, que trava a empresa (`FOR UPDATE`). Toda transação do worker começa pela
  empresa (`FOR SHARE`). As duas se serializam ali. Depois, a revogação trava as conversas afetadas antes do arquivo,
  na mesma ordem do worker.
- **Revogação primeiro (C1):** o worker espera; a saída é cancelada com motivo; nada sai.
- **Envio primeiro (C2):** o worker segura a empresa e o arquivo até gravar `ENVIANDO`. **Esse é o ponto sem volta:**
  a partir dele a chamada ao provedor já começou. A revogação espera e recusa com `ATENDIMENTO_ENVIO_EM_ANDAMENTO`.
  Depois do resultado (`SUBMETIDA`), a revogação passa, mas **não há cancelamento retroativo**: a mensagem enviada não é
  recolhida. Se o provedor ainda não tiver baixado a mídia, o link revogado pode fazer a entrega falhar.
- **Grupo parcialmente enviado (C3):** o texto já saiu e o PDF está na fila: a revogação recusa e nada muda (cancelar
  só o PDF deixaria o cliente com "segue o PDF" e sem o PDF). A equipe decide.
- **Grupo inteiro na fila (C4):** as duas saídas são canceladas com motivo e a conversa vai para a equipe.

### O que o banco garante e o que não garante

O gatilho da 082 recusa, **pela aplicação**: apagar arquivo, desfazer revogação, trocar conteúdo sem revogar, trocar
token sem registro e reativar vencido sem link novo. A revogação é **lógica**:

- quem tem privilégio de dono do banco contorna o gatilho (`TRUNCATE`, `ALTER TABLE … DISABLE TRIGGER`,
  `SET session_replication_role = replica`), e o down da 082 remove tudo;
- o conteúdo apagado continua nas páginas do PostgreSQL até o `VACUUM` reaproveitá-las, e nos backups até eles vencerem.

## 4. Limites reais

- **Cópias de terceiros.** Revogação e exclusão **não** apagam o que o provedor (Gupshup/Meta) já baixou ou guardou, a
  mídia e as mensagens no aparelho do cliente, nem backups já feitos. Uma cópia baixada não pode ser recolhida, e
  excluir aqui não pede exclusão no provedor.
- **Detector incompleto.** 81,3% no corpus independente (§1). Nomes soltos no meio da frase ("festa da Ana") não são
  reconhecíveis por regra sem apagar temas ("festa da Frozen").
- **Falsos positivos.** 6/72: algumas mensagens comuns passam a ser entendidas só pelas regras. Perde qualidade, não
  segurança.
- **Retenção depende de agendamento externo.** A rotina não roda sozinha: alguém precisa agendar a chamada da rota (cron
  do Render ou equivalente). Sem agendamento, nada expira, mesmo com prazo definido. A tela mostra a última execução.
- **Auditoria.** A linha de auditoria da ação (assumir, encerrar, enviar) fica, sem o vínculo com a conversa excluída.

## 5. Decisões de produto pendentes

Nada disto foi escolhido silenciosamente. Nenhuma delas é uma "aceitação genérica de risco": cada uma pede uma escolha
concreta.

| # | Decisão | Estado no código |
|---|---|---|
| R1 | **Prazo de retenção** das conversas, por empresa, em staging e em produção | Sem padrão. Nada é apagado até a Gestão definir; prazo técnico só nos testes sintéticos |
| R2 | Controles mínimos depois da exclusão (número + PARAR/pausa/equipe): base legal e prazo de guarda | Guardados até uma conversa nova consumi-los; sem prazo |
| R3 | Quem exclui a pedido | Só a Gestão, com senha confirmada há ≤ 5 min e a palavra EXCLUIR |
| R4 | Expiração padrão dos arquivos | Sem padrão (nunca expira até alguém definir) |
| R5 | Tela | Tela mínima entregue (Admin › Atendimento › Privacidade). Revisão de UX e textos pela equipe de produto |
| R6 | Modo IA com dado real | **Bloqueado**: padrão regras; o modelo só com `WHATSAPP_ATENDIMENTO_WALLE_ENTENDIMENTO=modelo`. Exige decidir com a cobertura medida (§1) à vista |
| R7 | Prazos técnicos: hash de deduplicação (30 dias, provisório), registro de privacidade e execuções da retenção | 30 dias para o hash; registro e execuções sem expurgo |
| R8 | Agendamento da retenção (quem agenda, frequência, alerta de falha) | Rota e script prontos; nada agendado |
