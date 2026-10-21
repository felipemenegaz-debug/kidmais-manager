# Convites com IA — aviso, autorização do responsável e registro (21/10/2026)

**Estado: LOCAL.** Implementado e validado só localmente (testes com dependências simuladas e PostgreSQL descartável).
Nada foi publicado: sem push, PR, deploy, alteração de env, Render ou banco remoto, e nenhuma chamada real à OpenAI ou
ao Gemini. A migration 088 **não foi aplicada** em staging nem em produção.

Origem: parecer da Astra de 21/10/2026 (`pacote-revisao-juridica-astra-20261020/10-PARECER-ASTRA-20261021.md`, ponto
urgente 1, L5, L6 e matriz) e decisão de Felipe (`11-DECISOES-FELIPE-20261021.md`): **manter os Convites com IA ligados**
em produção, contra a recomendação de suspender, e implementar com prioridade o aviso no momento da geração, o
consentimento específico do responsável, o controle separado da foto, o registro da autorização e o nome do provedor
real, sem fallback silencioso.

Base: `staging` em `44167269910224a44569a59e9676e938c22feb4d`; branch `codex/convites-ia-consentimento-20261021`.

## 1. Fluxo antes desta mudança

| Etapa | Como era |
|---|---|
| Telas | Editor do buffet `/admin/festas/[festaId]/convite` (capacidade `FESTA_OPERAR`) e editor do cliente `/convites/criar#<token>` (link do contratante); mesmo componente `components/convites/ConviteEditor.tsx`. |
| Rotas | `GET/POST /api/admin/convites?festaId=` e `GET/POST /api/convites/cliente` (Bearer do link) → `lib/convites/service.ts` (`consultar`, `comandar`, `gerar`). |
| Provedor | Um só, escolhido pelo servidor: `CONVITES_IA_PROVIDER` (`openai` ou `gemini`; sem valor = Gemini). `lib/convites/imagem.ts` despacha para a Images API da OpenAI (`gpt-image-2.5-flare`, ou `gpt-image-2.5-sunburst` no convite completo) ou para a Interactions API do Gemini (`gemini-nano-banana-2.1`). Não havia fallback entre provedores nem retentativa paga. |
| O que era enviado | **Arte simples**: o pedido livre digitado e até duas imagens da galeria da festa como referência (inclusive uploads, que podem ser fotos da criança). **Convite completo** (só OpenAI): o pedido, os dados do rascunho da festa (nome, idade, data, horário, local, endereço, mensagem), a foto opcional (reencodada no servidor, não salva) e a referência fixa do estilo. Cabeçalho `X-Client-Request-Id` = id da geração. |
| Onde a imagem fica | `convite_artes.imagem` (WebP, PostgreSQL do Kidmais); durante a geração, `convite_geracoes.resultado_pendente`; publicada pela rota pública do convite quando o convite é publicado. |
| Aviso e consentimento | Nenhum aviso com o provedor. Só uma caixa para a foto com texto fixo "à OpenAI" ("Tenho autorização para enviar esta foto à OpenAI…"), sem registro. O evento `IA_RESERVADA` guardava apenas `foto: true/false`. |

## 2. Fluxo depois

1. **Aviso no momento da geração, com o provedor real.** `consultar` devolve `autorizacaoIA` com os textos montados para
   o provedor configurado no servidor (`OpenAI` ou `Google (Gemini)`), a versão e os hashes do texto. O painel
   "Antes de gerar com IA · <provedor>" aparece acima do botão de gerar, com link para o Aviso de privacidade.
2. **Autorização específica, separada do aceite geral.** Formulário com nome do responsável legal, vínculo com a criança,
   caixa (desmarcada) do consentimento e **outra caixa desmarcada para a fotografia**. No editor do buffet também "Como
   o responsável autorizou" (presencial, WhatsApp, e-mail, telefone, outro). Sem documento.
3. **Registro.** `POST {acao:'autorizar_ia', versao, provedor, textoHash, responsavelNome, vinculo, meio?, declaracao:true, foto}`.
   O servidor confere provedor = provedor atual, versão = versão atual e hash = hash do texto atual (para o operador e
   a escolha da foto) e grava em `convite_ia_autorizacoes`. Uma nova autorização encerra a anterior (`SUBSTITUIDA`).
4. **Servidor recusa sem autorização.** `gerar` só reserva créditos se houver autorização não revogada daquele convite
   (festa/criança), daquela empresa, para o **provedor que será chamado** e com o texto da **versão atual**; senão
   responde 403 antes de qualquer reserva ou envio. Foto **e** imagens da galeria como referência exigem
   `foto_autorizada`; sem ela, a geração com imagens é recusada (não há envio silencioso sem a foto nem com ela).
5. **Provedor exibido = provedor chamado.** O adaptador recebe o provedor autorizado e recusa se a configuração mudou
   (`gerarImagem(..., provedorAutorizado)`); o envio só sai para o host do provedor autorizado (`destinoDoProvedor`),
   verificado antes do marcador de envio da 084 — outro destino vira `NAO_ENVIADA` com crédito devolvido. Não existe
   fallback entre provedores; uma falha do provedor autorizado segue a recuperação da 084 (verificação), nunca outro provedor.
6. **Revogação para usos futuros.** `POST {acao:'revogar_autorizacao_ia'}` (buffet com consulta ou cliente; funciona
   também em acesso comercial somente leitura). O marcador de envio da 084 passou a exigir a autorização da reserva
   ainda não revogada: revogar entre a reserva e o envio impede o envio (crédito devolvido). Artes já geradas continuam
   na galeria até serem excluídas.
7. **Alternativa sem IA visível.** No painel: "Prefere não usar IA? … Usar arte própria, sem IA", que abre o envio de
   arte própria; o convite também pode ser publicado com o visual padrão.
8. **Ordem de deploy invertida não quebra o editor.** Sem a tabela 088, a consulta da autorização falha num savepoint,
   o editor abre com "autorização indisponível" e a geração continua falhando fechada.

Auditoria (`convite_eventos`): `AUTORIZACAO_IA_REGISTRADA {autorizacao, provedor, versao, foto}`,
`AUTORIZACAO_IA_REVOGADA {autorizacao}` e `IA_RESERVADA` com `autorizacao` e `provedor`. Nenhum evento, log ou resposta
de consulta leva o nome do responsável, o prompt ou a foto.

## 3. Textos — versão `convites-ia-20261021.1`

Fonte única: `lib/convites/consentimento-textos.ts`. Hash = sha-256 de
`JSON.stringify([versao, operador, provedor, aviso, consentimento, foto|null])`. Mudar qualquer texto exige nova versão;
autorizações da versão anterior deixam de valer e a tela pede nova autorização ("precisaRenovar").

**Aviso (texto da Astra; só o provedor varia):**

> Para criar este convite com IA, enviaremos à OpenAI os dados selecionados da festa, que podem incluir nome e idade da criança e informações do evento. A fotografia só será enviada se você autorizar separadamente. A imagem gerada será armazenada no Kidmais e poderá conter esses dados. Consulte as condições de tratamento e retenção antes de continuar.

Com Gemini: "enviaremos ao Google (Gemini) …".

**Consentimento — responsável no link (texto literal da Astra):**

> Declaro ser responsável legal pela criança e autorizo especificamente o uso dos dados selecionados para gerar este convite por IA, nas condições informadas. Sei que posso escolher uma alternativa sem IA e revogar esta autorização para usos futuros.

**Foto — responsável no link (Astra + nome do provedor entre parênteses):**

> Autorizo também o envio desta fotografia ao provedor indicado (OpenAI) para gerar a arte.

**Funcionário do buffet (adaptação para registrar a autorização dada pelo responsável — conferir com o jurídico):**

> Registro que o responsável legal identificado abaixo declarou ser responsável pela criança e autorizou especificamente o uso dos dados selecionados para gerar este convite por IA, nas condições informadas. Ele foi informado de que pode escolher uma alternativa sem IA e revogar esta autorização para usos futuros.

> O responsável autorizou também o envio desta fotografia ao provedor indicado (OpenAI) para gerar a arte.

Complementos exibidos (fora do hash): "Sem a autorização da fotografia, nenhuma foto nem imagem da festa usada como
referência é enviada ao provedor." e "Prefere não usar IA? Use uma arte própria ou o visual padrão do convite: nada é
enviado a provedores de IA."

## 4. Tabela `convite_ia_autorizacoes` (migration 088)

Arquivos: `database/migrations/20261021_088_convite_ia_autorizacoes.sql`, `database/checks/20261021_088_precheck.sql`,
`database/checks/20261021_088_postcheck.sql`, `database/rollback/20261021_088_convite_ia_autorizacoes_down.sql`.
Número: a 087 é do trabalho local de e-mails de cobrança (`kidmais-manager-emails-cobranca-20261019`, não integrado);
088 era o próximo livre na leitura de 21/10 — número livre numa leitura não é reserva.

| Coluna | Conteúdo |
|---|---|
| `id`, `criado_em` | identificador e data/hora do registro |
| `empresa_id`, `convite_id`, `festa_id` | empresa e criança/evento; FK composta `(convite_id, empresa_id) → convites(id, empresa_id)` e gatilho que confere festa e empresa |
| `finalidade` | fixa `CONVITE_IA` |
| `provedor` | `openai` ou `gemini` (o real no momento do registro) |
| `texto_versao`, `texto_hash` | versão e sha-256 do texto exibido |
| `operador_tipo`, `operador_usuario_id`, `operador_cliente_id` | quem operou: funcionário do buffet (com vínculo ativo na empresa, conferido pelo gatilho) ou o cliente do convite |
| `responsavel_nome`, `responsavel_vinculo` | identificação mínima informada pelo operador (sem documento) |
| `meio` | `PROPRIO_RESPONSAVEL` (cliente) ou como o buffet recebeu a autorização |
| `declaracao_responsavel` | sempre `true` (CHECK) |
| `foto_autorizada` | manifestação sobre a foto (sim/não) |
| `revogada_em`, `revogada_por`, `revogacao_motivo` | revogação (`REVOGADA`) ou substituição (`SUBSTITUIDA`); gravadas uma vez |

Regras no banco: no máximo uma não revogada por convite (índice único parcial); registro imutável exceto a revogação
(gatilho); coerência operador × meio; DELETE **não** é bloqueado (a eliminação segue a política de retenção — a Astra
alertou que gatilho que impede qualquer exclusão não é justificativa de retenção). O repositório não usa RLS nem GRANTs
em nenhuma migration; o isolamento segue o padrão existente (chave composta, gatilho de vínculo e serviço filtrando pela
empresa comprovada da sessão). Rollback: recusado se houver qualquer autorização (evidência); sem dados, remove tabela e função.

## 5. Validação local (21/10/2026)

- `node --test lib/convites/service.test.cjs` — 74/74 (63 anteriores + 11 da 088): sem autorização → recusa sem reserva
  nem envio; autorização de outro provedor, versão antiga ou hash adulterado → recusa; consulta com o provedor real e sem
  o nome do responsável; registro com todos os campos e substituição; registro recusa provedor/versão/hash divergentes e
  meio informado pelo cliente; sem foto autorizada, foto e referências não saem e a geração sem imagens segue com 0
  imagens; provedor exibido = chamado (OpenAI e Gemini) e destino divergente recusado antes do marcador; falha do
  provedor autorizado = uma chamada, sem outro provedor; revogação (inclusive entre reserva e envio) e revogação em
  acesso somente leitura; isolamento por empresa; sigilo em logs e eventos; tabela ausente → editor abre, IA bloqueada.
- `node --test lib/convites/recuperacao.test.cjs lib/desenvolvedor/convites-geracoes.test.cjs` — 10/10.
- `lib/convites/consentimento.test.ts` (3) e `lib/convites/migration-088.test.ts` (3), no `check:v1:static`.
- PostgreSQL 18 descartável (cluster `kidmais_descartavel` em 127.0.0.1:55588, pasta temporária removida ao fim),
  `lib/convites/autorizacoes-088.postgres.test.ts` sobre o modelo 086: precheck, aplicação, postcheck, reaplicação
  recusada; registro pelo serviço real; isolamento A×B (gatilho e FK composta, inclusive com o gatilho desabilitado);
  constraints; uma vigente; substituição; imutabilidade; revogação; SQL real do marcador de envio condicionado à
  autorização; rollback recusado com dados e rollback sem dados (desfeito). Também `recuperacao.postgres.test.ts` (079)
  e `composicao-convites-085-086.postgres.test.ts` (086) — PASS.
- Interface: `scripts/convites-autorizacao-ia-ui.cjs` (Playwright, `next start` local, respostas sintéticas, nenhuma API
  real) — PASS em 1365 px e 375 px: aviso com "OpenAI", botão de gerar desabilitado sem autorização, caixas de
  consentimento e foto desmarcadas, corpo do registro conferido (hash do texto sem foto, sem meio), botão habilitado
  depois, revogação volta a bloquear, alternativa sem IA abre a arte própria, sem rolagem horizontal nem erro de página.
  Só o editor do cliente foi exercitado no navegador; o do buffet (com "Como o responsável autorizou") só por testes.
- `npx tsc --noEmit` limpo; ESLint dos arquivos alterados limpo; `npm run production:test` 37/37;
  `npm run check:v1:static` PASS (3232 testes + 103 do harness, lint, TypeScript, build).

## 6. Como aplicar em staging e produção (NÃO executado; cada passo com autorização própria de Felipe)

Ordem obrigatória por ambiente: **088 antes do código** (o código novo exige a tabela para gerar; sem ela o editor abre
com a IA bloqueada).

1. Revalidar por leitura o serviço Render do ambiente (branch, auto-deploy) e o estado das migrations (083–086 em
   staging e produção; a 087, se integrada antes, entra na ordem numérica).
2. Backup/export do banco do ambiente (padrão das janelas anteriores) e anotar o horário.
3. Precheck `database/checks/20261021_088_precheck.sql` (somente leitura) — esperado `088 precheck OK`.
4. Aplicar `database/migrations/20261021_088_convite_ia_autorizacoes.sql` numa única tentativa (transação própria).
5. Postcheck `database/checks/20261021_088_postcheck.sql` — esperado `088 postcheck OK` e `autorizacoes = 0`.
6. Merge do PR em `staging` (CI verde), deploy manual autorizado, smoke: editor abre; botão de gerar desabilitado sem
   autorização; registrar autorização com festa sintética; gerar **somente** se a geração real também estiver
   autorizada; revogar. Produção: PR para `production`, mesmos passos.
7. Rollback: primeiro voltar o código; depois `database/rollback/20261021_088_convite_ia_autorizacoes_down.sql`, que
   recusa se já houver autorizações (preservar a evidência e corrigir para frente).

Efeito em produção ao publicar: toda festa passa a pedir a autorização antes da próxima geração (sem backfill). Não há
aplicador dedicado (como os da 084/085/086); se Felipe quiser o mesmo rito, criar um antes da janela.

## 7. Pendências que dependem de Felipe e do jurídico

- **Contrato e DPA dos provedores**: entidade contratada, serviço/projeto, modelo, região, treinamento, retenção de
  logs de abuso (OpenAI: até 30 dias, com exceções), arquivos e mecanismo de transferência internacional (L5, L7, L8,
  ponto urgente 3). `store:false` (Gemini) não prova retenção zero.
- **Gemini e menores**: os termos atuais vedam dados pessoais nos serviços não pagos e restringem clientes de API
  direcionados a menores ou provavelmente acessados por eles; pagar a API não resolve a segunda restrição. Enquanto não
  houver conferência, preferir `CONVITES_IA_PROVIDER=openai` (o convite completo já só existe com OpenAI). Esta
  mudança só garante que o nome exibido e autorizado é o do provedor chamado.
- **Redação**: conferir com a Astra a adaptação do texto do buffet, o parêntese com o provedor no texto da foto e a
  extensão "imagens da galeria" à autorização da foto. Qualquer mudança gera nova versão.
- **Avaliação do melhor interesse** da criança e documentação da base legal (consentimento específico) pelo buffet
  controlador; a matriz de L6 precisa da parte do buffet.
- **Retenção** das autorizações (e da revogação) — não decidida; o banco não impede exclusão. Sugestão a decidir: guardar
  enquanto houver arte gerada e pelo prazo de defesa aplicável, e eliminar com a festa.
- **Aviso de privacidade (L5)** e lista de prestadores (L7) ainda são minuta; o texto exibido remete a eles.
- **Divulgação pública** da arte (convite publicado) não é coberta por esta autorização; a Astra pede separar geração,
  uso da foto e eventual divulgação pública (matriz de L6). Avaliar uma confirmação própria ao publicar.
- **Funcionário do buffet**: a caixa "tenho autorização" não prova a autorização; o registro guarda nome, vínculo e
  meio, mas a obtenção efetiva (ex.: mensagem do responsável) fica com o buffet. Sem exigência de documento.
- Revisão independente desta entrega e autorização para PR/merge/deploy e para a 088 em cada ambiente.
