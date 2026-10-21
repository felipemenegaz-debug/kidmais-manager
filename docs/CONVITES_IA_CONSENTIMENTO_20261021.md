# Convites com IA — aviso, autorização do responsável e registro (21/10/2026)

**Estado: LOCAL (rodada 2, após a revisão independente de `15aa937`).** Implementado e validado só localmente (testes com dependências simuladas e PostgreSQL descartável).
Esta implementação não fez push, deploy, alteração de env, Render ou banco remoto, nem chamada real à OpenAI ou ao
Gemini (a revisão independente cita a PR #199 com o commit `15aa937`; os commits da rodada 2 são locais). A migration
088 **não foi aplicada** em staging nem em produção.

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


## 2. Fluxo depois (rodada 2, após a revisão independente de `15aa937`)

1. **Aviso no momento da geração, com o provedor real.** `consultar` devolve `autorizacaoIA` com os textos montados para
   o provedor configurado no servidor (`OpenAI` ou `Google (Gemini)`), a versão e os hashes dos textos. O painel
   "Antes de gerar com IA · <provedor>" aparece acima do botão de gerar. O link "Condições no Aviso de privacidade"
   aponta para `/privacidade#inteligencia-artificial` (seção de IA, versão `2026-10-21-minuta5a`; ver §8).
2. **Autorização geral, separada do aceite geral.** Formulário com nome do responsável legal, vínculo com a criança e a
   caixa desmarcada do consentimento. No editor do buffet também "Como o responsável autorizou" (presencial, WhatsApp,
   e-mail, telefone, outro). Sem documento. Ela cobre os dados selecionados da festa e vale até a revogação.
3. **Fotografia e imagens da galeria: confirmação por geração (P2-3).** A caixa "Autorizo também o envio desta fotografia
   e das imagens da galeria selecionadas ao provedor indicado (OpenAI) para gerar esta arte." só aparece **depois** que
   uma foto (convite completo) ou imagem da galeria (arte simples) é escolhida, começa desmarcada, vale **só para aquela
   geração** e volta desmarcada depois do envio (uso único). O navegador manda
   `autorizacaoImagens: {versao, textoHash}`; o servidor confere versão e hash do texto do provedor atual e de quem
   opera, e grava no evento `IA_RESERVADA` da geração `imagens: {versao, textoHash, sha256: [...]}` com o sha-256 de
   cada imagem pessoal **efetivamente enviada** (foto normalizada e imagens da galeria; a referência fixa do estilo é um
   arquivo do servidor e fica identificada pelo id). Sem a confirmação, nenhuma imagem sai (403); confirmação sem
   imagem é recusada (400).
4. **Registro da autorização geral.** `POST {acao:'autorizar_ia', versao, provedor, textoHash, responsavelNome, vinculo,
   meio?, declaracao:true}`. O servidor confere provedor = provedor atual, versão = versão atual e hash = hash do texto
   atual (para o operador) e grava em `convite_ia_autorizacoes`. Uma nova autorização encerra a anterior
   (`SUBSTITUIDA`); revogação da anterior e criação da nova saem do mesmo relógio (`clock_timestamp()`), nessa ordem (P3-3).
5. **Servidor recusa sem autorização.** `gerar` só reserva créditos se houver autorização não revogada daquele convite
   (festa/criança), daquela empresa, para o **provedor que será chamado** e com o texto da **versão atual**; senão
   responde 403 antes de qualquer reserva ou envio.
6. **Provedor exibido = provedor chamado.** O adaptador recebe o provedor autorizado e recusa se a configuração mudou
   (`gerarImagem(..., provedorAutorizado)`); o envio só sai para o host do provedor autorizado (`destinoDoProvedor`),
   verificado antes do marcador de envio da 084 — outro destino vira `NAO_ENVIADA` com crédito devolvido. Não existe
   fallback entre provedores; uma falha do provedor autorizado segue a recuperação da 084 (verificação), nunca outro provedor.
7. **Revogação para usos futuros.** `POST {acao:'revogar_autorizacao_ia'}` (buffet com consulta ou cliente; funciona
   também em acesso comercial somente leitura). O marcador de envio da 084 exige a autorização da reserva ainda não
   revogada: revogar entre a reserva e o envio impede o envio (crédito devolvido). Limites documentados no §9.
8. **Alternativa sem IA visível.** "Prefere não usar IA? … Usar arte própria, sem IA" abre o envio de arte própria; o
   convite também pode ser publicado com o visual padrão.
9. **Código publicado antes da 088 (P3-1).** Sem a tabela, a consulta da autorização falha num savepoint e o editor abre
   com uma única mensagem: "A geração com IA está indisponível até a atualização do banco. Você pode seguir sem IA."
   (sem o aviso contraditório de "registre a autorização"). `gerar`, `autorizar_ia` e `revogar_autorizacao_ia`
   respondem **503 tratado** com essa mensagem (erro `42P01` da tabela mapeado para `ConviteError`), nunca 500 genérico.

Auditoria (`convite_eventos`): `AUTORIZACAO_IA_REGISTRADA {autorizacao, provedor, versao}`, `AUTORIZACAO_IA_REVOGADA
{autorizacao}` e `IA_RESERVADA {geracao, autorizacao, provedor, imagens?}`. Nenhum evento, log ou resposta de consulta
leva o nome do responsável, o prompt ou a imagem (só o sha-256 das imagens enviadas).

## 3. Textos — versão `convites-ia-20261021.2`

Fonte única: `lib/convites/consentimento-textos.ts`. Hash da autorização geral = sha-256 de
`JSON.stringify([versao, operador, provedor, aviso, consentimento])`; hash da confirmação das imagens = sha-256 de
`JSON.stringify([versao, operador, provedor, 'IMAGENS', foto])`. Mudar qualquer texto exige nova versão; autorizações da
versão anterior (inclusive a `.1`, que nunca foi aplicada fora do PostgreSQL descartável) deixam de valer e a tela pede
nova autorização ("precisaRenovar").

**Aviso (texto da Astra; só o provedor varia):**

> Para criar este convite com IA, enviaremos à OpenAI os dados selecionados da festa, que podem incluir nome e idade da criança e informações do evento. A fotografia só será enviada se você autorizar separadamente. A imagem gerada será armazenada no Kidmais e poderá conter esses dados. Consulte as condições de tratamento e retenção antes de continuar.

Com Gemini: "enviaremos ao Google (Gemini) …".

**Consentimento — responsável no link (texto literal da Astra):**

> Declaro ser responsável legal pela criança e autorizo especificamente o uso dos dados selecionados para gerar este convite por IA, nas condições informadas. Sei que posso escolher uma alternativa sem IA e revogar esta autorização para usos futuros.

**Fotografia e galeria — responsável no link (Astra + "e das imagens da galeria selecionadas", provedor e "esta arte"; por geração):**

> Autorizo também o envio desta fotografia e das imagens da galeria selecionadas ao provedor indicado (OpenAI) para gerar esta arte.

Nota exibida abaixo (fora do hash): "Esta confirmação vale só para esta geração e para as imagens selecionadas agora.
Sem ela, nenhuma foto nem imagem da galeria é enviada ao provedor."

**Funcionário do buffet (adaptação para registrar a autorização dada pelo responsável — conferir com o jurídico):**

> Registro que o responsável legal identificado abaixo declarou ser responsável pela criança e autorizou especificamente o uso dos dados selecionados para gerar este convite por IA, nas condições informadas. Ele foi informado de que pode escolher uma alternativa sem IA e revogar esta autorização para usos futuros.

> O responsável autorizou também o envio desta fotografia e das imagens da galeria selecionadas ao provedor indicado (OpenAI) para gerar esta arte.

Alternativa (fora do hash): "Prefere não usar IA? Use uma arte própria ou o visual padrão do convite: nada é enviado a
provedores de IA."

## 4. Tabela `convite_ia_autorizacoes` (migration 088)

Arquivos e sha-256 (conteúdo LF), fixados nos aplicadores:

| Arquivo | sha-256 |
|---|---|
| `database/checks/20261021_088_precheck.sql` | `cfc745da8a01eb85161def50b0cbfea046be80da084f9d4ad043d4952f53f99e` |
| `database/migrations/20261021_088_convite_ia_autorizacoes.sql` | `10b4d32685aeb58f7cca1ca358c44e4c35808cb42a28da6045f6865743e0fe91` |
| `database/checks/20261021_088_postcheck.sql` | `d1a4a9985d6ceed8f72cd877dde4a0c351d4a889f20f8895309c0124408c94d1` |
| `database/rollback/20261021_088_convite_ia_autorizacoes_down.sql` | (fora do aplicador; down manual, recusa com dados) |

Número: a 087 é do trabalho local de e-mails de cobrança (`kidmais-manager-emails-cobranca-20261019`, não integrado);
088 era o próximo livre na leitura de 21/10 — número livre numa leitura não é reserva. Se a 087 for aplicada depois da
088, o inventário segue a ordem por nome (087 < 088) e o estado aplicado fica fora de ordem: registrar isso na janela da 087.

| Coluna | Conteúdo |
|---|---|
| `id`, `criado_em` | identificador e data/hora do registro (`clock_timestamp()`) |
| `empresa_id`, `convite_id`, `festa_id` | empresa e criança/evento; FK composta `(convite_id, empresa_id) → convites(id, empresa_id)` e gatilho que confere festa e empresa |
| `finalidade` | fixa `CONVITE_IA` |
| `provedor` | `openai` ou `gemini` (o real no momento do registro) |
| `texto_versao`, `texto_hash` | versão e sha-256 do texto exibido |
| `operador_tipo`, `operador_usuario_id`, `operador_cliente_id` | quem operou: funcionário do buffet (com vínculo ativo na empresa, conferido pelo gatilho) ou o cliente do convite |
| `responsavel_nome`, `responsavel_vinculo` | identificação mínima informada pelo operador (sem documento) |
| `meio` | `PROPRIO_RESPONSAVEL` (cliente) ou como o buffet recebeu a autorização |
| `declaracao_responsavel` | sempre `true` (CHECK) |
| `revogada_em`, `revogada_por`, `revogacao_motivo` | revogação (`REVOGADA`) ou substituição (`SUBSTITUIDA`); gravadas uma vez |

A fotografia **não** é coluna da autorização geral (rodada 2): a confirmação é por geração e fica no evento
`IA_RESERVADA` (versão, hash do texto e sha-256 das imagens). Regras no banco: no máximo uma não revogada por convite
(índice único parcial); registro imutável exceto a revogação (gatilho); coerência operador × meio; DELETE **não** é
bloqueado (a eliminação segue a política de retenção — a Astra alertou que gatilho que impede qualquer exclusão não é
justificativa de retenção). O repositório não usa RLS nem GRANTs em nenhuma migration; o isolamento segue o padrão
existente (chave composta, gatilho de vínculo e serviço filtrando pela empresa comprovada da sessão). Rollback: recusado
se houver qualquer autorização (evidência); sem dados, remove tabela e função.

## 5. Aplicadores e blocos de Shell da 088 (P2-1)

Ordem decidida em 21/10/2026: **código primeiro, depois a 088.** O deploy leva o aplicador e os SQL na árvore; sem a
088 a geração com IA fica bloqueada (falha fechada, 503 tratado). Nada de colar SQL no Web Shell.

- `scripts/migration-088-comum.cjs` — núcleo: hashes fixados (CRLF normalizado), estado `ausente/completa/parcial`
  pelos 5 objetos da 088, dependências (073 com `UNIQUE (id, empresa_id)`, `memberships`), privilégios **CREATE** em
  `public` e **REFERENCES** em `convites/empresas/festas/clientes/usuarios_administrativos` (avaliados como
  `current_user`, quem executa o DDL; o `SET role` do Render aparece só como `papel_trocado`, sem nomes), conferência
  inteira em `BEGIN TRANSACTION READ ONLY` sem gravar nada (nem no disco), aplicação precheck (READ ONLY) → migration
  (transação do arquivo, `lock_timeout 5s`) → estado completo → postcheck (READ ONLY), contagens sem ids,
  `--backup "<registro>"` obrigatório, marcador exclusivo (`wx`) no disco persistente: qualquer tentativa anterior
  (concluída, falha ou perdida) impede repetição. Códigos: 0 plano/conferido/aplicado; 1 recusa antes de conectar;
  2 FALHA registrada; 3 conferência RECUSARIA. Nunca executa o down.
- `scripts/migration-088-staging.cjs` — alvo `srv-daif418ae00c73e8k2gg` / `dpg-daidko3m8hqs73ce4jt0-a` /
  `kidmais_staging_1z91`, TLS e identidade como `scripts/conexao-staging.cjs`; registro em
  `/opt/render/project/src/data/convites-ia-088-staging/migration-088.json`.
- `scripts/migration-088-production.cjs` — alvo `srv-dak77m2d0e5s73b8rkkg` / `dpg-dak750gae00c73fudmg0-a` /
  `kidmais_production`, TLS obrigatório (≥ 1.2) e identidade provada no servidor (banco, TLS/versão, endereço privado),
  como o aplicador da 084; registro em `/opt/render/project/src/data/convites-ia-088-producao/migration-088.json`.
- `scripts/bloco-shell-088.cjs <staging|production> <CONFERIR|APLICAR> <rotulo>` — bloco ASCII ≤ 32 KB no desenho
  revisado dos 085/086: `bind` antes da guarda, guarda `RENDER_SERVICE_ID` antes de ler arquivos, corpo em subshell,
  `CODIGO_SAIDA_BLOCO=<n>` (0–3 aplicador, 4 bloco), sha-256 de cada arquivo **implantado** (aplicador, núcleo,
  `conexao-staging.cjs` em staging e os 3 SQL) conferido antes de rodar; APLICAR exige `KIDMAIS_REGISTRO_BACKUP`
  definida antes de colar. O bloco não transporta nem grava arquivos (vêm no deploy).

Blocos gerados da árvore `dbb39f1` (`node scripts/bloco-shell-088.cjs <amb> <modo> dbb39f1`; regenerar da árvore
efetivamente implantada antes de colar, com o sha desse commit como rótulo):

| Bloco | sha-256 | bytes |
|---|---|---|
| `BLOCO-SHELL-088-STAGING-CONFERIR` | `edd5ace1e290cb37fc078a3eed103ec324fc3f61bddccc9a561736a1712bfdb3` | 2466 |
| `BLOCO-SHELL-088-STAGING-APLICAR` | `1fc3b7a6050e651a027afcb68eb9e7598b73870631c028778893a66cbc596d0e` | 2794 |
| `BLOCO-SHELL-088-PRODUCAO-CONFERIR` | `fd81fee77e3af98eb37bac7dd4a6c6f99866ba2e1c99371488a35bda5b246059` | 2382 |
| `BLOCO-SHELL-088-PRODUCAO-APLICAR` | `bf664a41d276f3ec95d77a3163de59be1b8cb5a733bffe525691ad6b3724510b` | 2710 |

Cópias locais em `D:/glass/KidMais Manager/ambientes-locais/blocos-088-dbb39f1/` (fora do repositório). A colagem foi
testada com `bash` e `bash -i` (pipe); a revisão própria deve repetir em PTY real (msys64 `script.exe`).

## 6. Validação local (21/10/2026, rodada 2)

- `node --test lib/convites/service.test.cjs` — 74/74. Da 088: sem autorização → 403 sem reserva nem envio;
  autorização de outro provedor, da versão `.1` ou adulterada → recusa e "precisaRenovar"; consulta com o provedor real
  e sem o nome; registro com todos os campos, substituição e `clock_timestamp()`; recusas do registro (provedor, versão,
  hash de outro texto, meio do cliente, `foto`, campos extras); **P2-3**: foto/galeria sem confirmação → 403, hash de
  outro operador/da autorização geral/versão antiga → 409, confirmação sem imagem → 400, com confirmação → envio e
  `imagens.sha256` da foto normalizada/da galeria no evento, uso único (a geração seguinte pede de novo); provedor exibido
  = chamado (OpenAI e Gemini), destino divergente recusado antes do marcador, falha do provedor = uma chamada só;
  revogação (inclusive entre reserva e envio) e em acesso somente leitura; isolamento por empresa; sigilo; **P3-1**: sem a
  088, editor abre com "indisponível" e gerar/autorizar/revogar respondem 503 tratado.
- `node --test lib/convites/recuperacao.test.cjs lib/desenvolvedor/convites-geracoes.test.cjs` — 10/10, agora
  independente de CRLF (P3-6, conferido também com o `service.ts` convertido para CRLF).
- `lib/convites/consentimento.test.ts` (5) e `lib/convites/migration-088.test.ts` (3); `lib/cadastro/cadastro.test.ts`
  com a versão `minuta5a`, a recusa da `minuta5` e a prova de que, sem os acréscimos da seção de IA, o hash volta ao da
  `minuta5` publicada (`06e7b9a5…`).
- `node --test scripts/migration-088.test.cjs` — 11/11 (trava de alvo dos dois ambientes, identidade, hashes, plano,
  privilégios, conferência sem escrita e sem disco, backup obrigatório, marcador, falha, códigos).
- `node --test scripts/bloco-shell-088.test.cjs` — 10/10 com bash e `bash -i` (colagem interativa, duas colagens na
  mesma sessão, outro serviço, arquivo divergente/ausente, backup ausente/inseguro, destino inacessível, aplicador real
  recusando antes de conectar).
- PostgreSQL 18 descartável (127.0.0.1:55588, removido ao fim): `autorizacoes-088.postgres.test.ts` (3/3, inclui a
  cronologia da substituição), `aplicador-088.postgres.test.ts` (aplicadores reais: conferência nos dois ambientes,
  papel sem CREATE/REFERENCES, vestígio parcial, **falha real por lock_timeout com tráfego simulado** desfeita por
  inteiro e sem repetição, aplicação, marcador, anti-repetição, nova conferência), `recuperacao.postgres.test.ts`
  (079 e 079-sem-atendimento) e `composicao-convites-085-086.postgres.test.ts` (086) — PASS.
- Interface: `scripts/convites-autorizacao-ia-ui.cjs` (Playwright, `next start` local, API sintética) — PASS em 1365 px e
  375 px: link para `#inteligencia-artificial`, sem autorização bloqueado, caixa da foto ausente antes de escolher imagem, registro sem foto, foto escolhida → confirmação desmarcada bloqueia → marcada envia `autorizacaoImagens` e volta desmarcada (uso único), revogação bloqueia, alternativa sem IA, banco sem a 088 com mensagem única; sem rolagem horizontal nem erro de página.
- `npx tsc --noEmit` limpo; ESLint dos alterados limpo; `npm run production:test` 37/37; `npm run check:v1:static` PASS (3235 testes + 103 do harness, lint com 1 aviso preexistente fora do escopo, TypeScript e build).

## 7. Roteiro por ambiente (NÃO executado; cada passo com autorização própria de Felipe)

Para **staging** e depois **produção** (produção só depois de staging homologado):

1. **Deploy do código** (PR/merge e deploy manual autorizados). Efeito imediato: a geração com IA fica bloqueada até a
   088 (o editor mostra "indisponível até a atualização do banco"); o restante do convite funciona.
2. **Backup/export** do banco e PITR anotados (id e horário).
3. Gerar os blocos da árvore implantada: `node scripts/bloco-shell-088.cjs <amb> CONFERIR <sha>` e `… APLICAR <sha>`;
   conferir sha-256 e bytes antes de colar.
4. **CONFERIR** no Web Shell do serviço → esperado `CODIGO_SAIDA_BLOCO=0` com `"resultado":"PRONTA_PARA_APLICAR"`
   (estado `ausente`, privilégios `true`, precheck PASS). `3` (RECUSARIA) ou `1`/`2`/`4` = parar e ler.
5. Autorização específica da 088 no ambiente. No mesmo shell: `export KIDMAIS_REGISTRO_BACKUP="<id e horário>"`.
6. **APLICAR** → esperado `CODIGO_SAIDA_BLOCO=0`, `APLICADA_POSTCHECK_PASS`, `autorizacoes: 0`. Falha = não repetir
   (o marcador impede); copiar a saída e revisar.
7. **CONFERIR** de novo → `JA_APLICADA_POSTCHECK_PASS`.
8. Smoke com festa sintética: editor abre, botão bloqueado sem autorização, registrar e revogar; gerar **somente** com
   autorização própria para chamada paga. Em produção, `check-migrations` (088 já está no inventário).
9. Rollback: primeiro voltar o código; depois o down manual, que recusa se já houver autorizações (preservar a evidência
   e corrigir para frente).

## 8. Aviso de privacidade `2026-10-21-minuta5a` (P2-2)

Nova versão mínima de `lib/cadastro/documentos-legais.ts`, ainda `minuta: true`; **só a seção "Recursos de inteligência
artificial" muda** (âncora `#inteligencia-artificial` em `components/cadastro/DocumentoLegal.tsx`). Acrescenta, do L5
da Astra: recursos de IA (atendimento, respostas, documentos, imagens e convites); dados enviados conforme recurso e
provedor; **OpenAI e, somente quando habilitado, o Google Gemini**, com o provedor informado no momento da geração;
convites com IA com nome e idade da criança, data, local e **endereço** do evento e **fotografia opcional** mediante as
autorizações (geral do responsável e confirmação própria da foto/galeria a cada geração); imagem armazenada que pode
identificar a criança; **filtros sem garantia de anonimização**; **resultados a revisar antes do uso**; alternativa sem IA
e revogação para usos futuros (editor ou canal de privacidade); ativação condicionada às condições contratuais. O
parágrafo `[A DEFINIR]` das condições do provedor continua (9 marcadores no total). Um teste prova que, sem os
acréscimos, o hash volta exatamente ao da `2026-10-20-minuta5` publicada (`06e7b9a5…`). A versão `minuta6` do clone de
textos v2 não colide e precisará incorporar esta seção. Confirmado pelo coordenador: produção usa
`CONVITES_IA_PROVIDER=openai`. Novos cadastros passam a aceitar a `minuta5a`; aceites anteriores não são regravados.

## 9. Limites documentados (P3)

- **P3-2 — revogação durante envio em curso:** o marcador de envio lê a autorização sem trava. Uma revogação confirmada
  antes do marcador impede o envio; uma revogação ainda não confirmada não interrompe um envio que já está saindo. É
  coerente com "revogar para usos futuros".
- **P3-4 — revogação depois que o link expira:** o responsável revoga pelo editor enquanto o link do convite é válido e a
  empresa está ativa; depois, pelo buffet (que revoga com acesso de consulta) ou pelo canal de privacidade
  `contato@demerzellabs.com.br`, citado no Aviso.
- **P3-5 — arte já enviada:** uma geração enviada antes da revogação ainda pode virar arte (reconciliação da 084 ou
  `concluirGeracaoComImagem` pelo operador), sem nova chamada ao provedor. A arte fica na galeria até ser excluída.
- **P3-7 — pendências declaradas:** divulgação pública da arte não coberta (matriz L6); retenção das autorizações não
  decidida; registro do buffet sem campo de referência da evidência (data/canal da mensagem); avaliação de melhor
  interesse pelo buffet.

## 10. Pendências que dependem de Felipe e do jurídico

- **Contrato e DPA dos provedores**: entidade contratada, serviço/projeto, modelo, região, treinamento, retenção de
  logs de abuso (OpenAI: até 30 dias, com exceções), arquivos e mecanismo de transferência internacional (L5, L7, L8,
  ponto urgente 3). `store:false` (Gemini) não prova retenção zero.
- **Gemini e menores**: os termos atuais vedam dados pessoais nos serviços não pagos e restringem clientes de API
  direcionados a menores ou provavelmente acessados por eles; pagar a API não resolve a segunda restrição. Produção usa
  `openai` (confirmado em 21/10); manter assim até a conferência.
- **Redação**: conferir com a Astra a adaptação do texto do buffet, a confirmação da foto por geração com "e das imagens
  da galeria selecionadas" e o acréscimo de L5 no Aviso (`minuta5a`). Qualquer mudança gera nova versão.
- **Avaliação do melhor interesse** da criança e documentação da base legal pelo buffet controlador.
- **Retenção** das autorizações e dos eventos com sha-256 das imagens — não decidida; o banco não impede exclusão.
- Revisão independente desta rodada; autorização para PR/merge/deploy e para a 088 em cada ambiente.
