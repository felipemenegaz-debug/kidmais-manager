# Validação no navegador — biblioteca de mensagens prontas (063)

**Situação:** EXECUTADA em 04/10/2026 no HEAD `930121d`, com autorização do Felipe para V1, V2, V3, V3c, V3H e V4 (docs/OPERACAO_AGENTES.md). Resultado em "Resultado". Nada em staging, produção, Render, Gupshup ou no banco local real `kidmais_manager`. A demonstração (55498/3040/3041) não foi usada, parada nem alterada.

## Objetivo

Validar na tela real, com o endpoint real `/api/admin/atendimento/prontas` e um banco sintético próprio:

- cadastrar, editar, favoritar e arquivar mensagens prontas;
- preparar o link individual de fechamento para cada situação de vínculo;
- trocar de contato enquanto o rascunho de outro contato ainda não voltou (retorno atrasado);
- tudo em desktop, celular (375×812) e só pelo teclado.

A suíte PostgreSQL já provou as regras do banco e do serviço (docs/VALIDACAO_063_E_ENCERRAMENTO.md, PASS em `ba6d47c`). Aqui a prova é da tela, da rota e da sessão de verdade.

## Alvo

| Item | Valor |
| --- | --- |
| Código | worktree `C:\Users\Glass\.codex\worktrees\0997\kidmais-candidata-whatsapp`, HEAD anotado em V0, árvore limpa (o código é o de `1e40264`; os commits seguintes são só docs) |
| Banco | cluster NOVO `127.0.0.1:55502`, base `C:\Users\Glass\AppData\Local\Temp\kidmais-val-prontas-AAAAMMDD-xxxxxx` (caminho exclusivo informado na autorização), identidade `kidmais_descartavel`, locale C, `kidmais.val_id` próprio, banco `kidmais_pacotes_v1_descartavel` |
| Autorização da porta | `KIDMAIS_DESCARTAVEL_PORTA=55502` e `KIDMAIS_DESCARTAVEL_AUTORIZACAO=127.0.0.1:55502/kidmais_pacotes_v1_descartavel` (regra literal do conector; sem mudança de código) |
| Tela | `next dev` na porta 3050, ligado só em 127.0.0.1, origem `http://localhost:3050` (V3) ou `https://localhost:3050` (V3H) |
| Build | `.next-festa-dev` na worktree: recusado se já existir; apagado só se esta execução o criou |
| Navegador | navegador embutido do app (aba própria); a demonstração fica em outra origem e não é aberta |

**Por que porta e base próprias:** a demonstração usa 55498 com o modelo 062, **sem** a 063. Aplicar a 063 nela alteraria a demonstração; por isso esta validação tem cluster, porta, build e processo próprios.

**Protegidos (nunca usados nem removidos; retrato antes de V1 e depois de V4):** `kidmais-demo-atendimento-20261004-4b6271` (vivo: conferido por existência, `postmaster.pid`, portas e identidade do servidor, só leitura), `kidmais-pg-demo-atendimento`, `kidmais-pg-063`, `kidmais-pg-060` (hash da listagem).

**Ambiente do Next:** não herda nada de quem chama. Só as essenciais do sistema e as variáveis explícitas do script (V0 lista todas). Não há chave de IA, de Gupshup ou de cron, nem worker ou simulador: **nada pode ser enviado**. O roteiro não clica em "Enviar resposta"; V3c confere `saidas_total = 0` no banco.

## Dados sintéticos (V2)

- Modelo 062 (com a 060), 063 aplicada pelo próprio arquivo da migration e postcheck oficial.
- **Empresa A** (validação), com login do representante e do atendente. As senhas são aleatórias e ficam em `.local-ux/val-prontas/estado/credenciais-locais.json`, fora do Git. Nunca são impressas e são apagadas em V4.
- **Empresa B** (isolamento) e uma pronta de A no ambiente `production`. Nenhuma das duas pode aparecer na tela.
- Configuração do atendimento ativa, gravada pelo serviço real.
- Cinco conversas criadas pelo serviço real de recepção, sem resposta automática.
- Clientes e contratações montados pelas regras do banco (mesma fixture do passo 6b da suíte 063).

| Contato | Situação | Link individual esperado |
| --- | --- | --- |
| 0101 | um cliente de A, cadastrado sem o 55, com **um** contrato aguardando; a empresa B tem um cliente com o mesmo telefone e contrato aguardando | V3 (http): aviso de origem https, que é a última regra e só aparece depois de achar o cliente e o contrato únicos. V3H (https): **preenchido** com `https://localhost:3050/contrato/<contrato de A>` e nunca o de B |
| 0102 | nenhum cliente | aviso "Nenhum cliente desta empresa" |
| 0103 | um cliente com **dois** contratos aguardando | aviso "mais de um contrato aguardando" |
| 0104 | contrato ainda em elaboração | aviso "não tem contrato aguardando a assinatura" |
| 0105 | dois clientes de A com o mesmo telefone (com e sem 55) | aviso "Mais de um cliente" |

## Operações (scripts em `.local-ux/val-prontas/`, fora do Git; SHA-256 em `MANIFESTO.txt`)

Todos os comandos: `powershell -NoProfile -ExecutionPolicy Bypass -File .local-ux\val-prontas\vp.ps1 -Acao <ação>`.

| # | Ação | Efeito | Verificação | Parada |
| --- | --- | --- | --- | --- |
| V0 | `verificar [-Base <caminho>]` | Nenhum (só leitura) | portas 55502/3050 livres, demo informada, build ausente, sem `.env*`, protegidos existentes, base aceita, ambiente listado | qualquer divergência |
| V1 | `subir -Base <caminho>` | retrato "antes"; cria a base, `initdb` (locale C, trust só em 127.0.0.1), marca + `kidmais.val_id`, `pg_ctl start` sem pipe | identidade exata do servidor (cluster, endereço, porta, usuário, 0 `kidmais_manager`, diretório, id) | base recusada, porta ocupada, identidade divergente |
| V2 | `preparar` | modelo 062 → `kidmais_pacotes_v1_descartavel`; 063 + postcheck; dados sintéticos | postcheck sem erro; 0 saídas; arquivos de estado gravados | identidade/porta divergente; falha → V4 |
| V3 | `iniciar` | `next dev` (3050, http) com ambiente explícito; guarda `next-env.d.ts`/`tsconfig.json` | porta 3050 escutando com o processo registrado | build existente, árvore suja, porta ocupada; falha limpa só o que iniciou |
| V3c | `conferir` | Nenhum (sessão `default_transaction_read_only`, só SELECT) | prontas, favoritas, conversas, mensagens por estado e `saidas_total = 0` | — |
| V3H (opcional) | `parar` e depois `iniciar -Https` | para só o Next; sobe de novo em https com certificado autoassinado **desta execução** (openssl do Git; 1 dia; não instalado em nenhum repositório de confiança) | login e link 0101 preenchido | o navegador embutido não permitir prosseguir no aviso do certificado: registrar como não executado |
| V4 | `encerrar` | para o Next (identidade conferida), devolve os arquivos gerados, apaga o build criado e a chave/certificado; para o cluster pelo próprio diretório; remove **só** a base; apaga credenciais e dados; retrato "depois" | portas 55502/3050 livres, base ausente, build ausente, árvore limpa, protegidos e demo idênticos | qualquer divergência: para sem remover |

**Remoção em V4:** a base precisa estar registrada e conferir com o próprio marcador; o caminho resolvido precisa ser exatamente o registrado; não pode haver link/junção na base, em ancestral nem dentro dela; o `postgresql.conf` precisa ter a marca e o id; a porta precisa estar livre e não pode haver `postmaster.pid`. A base de um protegido é recusada. Se houver divergência, nada é removido.

**V3H e o aviso do navegador:** em http o link individual nunca é preenchido, porque o produto exige origem https. Para ver o caso **preenchido** na tela, a origem precisa ser https, e o navegador vai avisar que o certificado é autoassinado. Prosseguir nesse aviso, só para `https://localhost:3050`, faz parte da autorização de V3H. Sem V3H, o preenchido continua provado pela suíte PostgreSQL (passo 6b), e a tela prova os outros quatro avisos e o de origem.

## Roteiro no navegador

Credenciais lidas do arquivo local e digitadas só no login de `localhost:3050` (aplicação local, valores sintéticos); nunca aparecem em relatório. "R" = representante, "T" = atendente.

| Caso | Passos | Esperado |
| --- | --- | --- |
| B1 Abertura | login R; abrir Atendimento | 5 conversas (finais 0101–0105); biblioteca vazia; "Somente da outra empresa" e "Somente de producao" ausentes (também na busca) |
| B2 Cadastrar | Gerenciar: "Boas-vindas" (texto); "Tabela de preços" (link `https://example.test/tabela`, atalho Tabela de preços); "Contrato para assinar" (link individual, atalho "Disponibilidade / fechamento") | os três aparecem; atalhos primeiro. Recusas: link `http://…` (só https); segundo item ativo no mesmo atalho ("Já existe uma mensagem ativa neste atalho…"); título repetido ("Já existe uma mensagem pronta com este título.") — nada gravado |
| B3 Editar | editar o texto de "Boas-vindas"; editar o mesmo item em duas abas e salvar nas duas | a primeira salva; a segunda recebe "A mensagem pronta mudou. Atualize a lista antes de continuar." e não sobrescreve |
| B4 Favoritar | ★ em "Boas-vindas"; filtro só favoritas; recarregar | `aria-pressed` muda; filtro mostra só ela; persiste após recarregar |
| B5 Arquivar | arquivar "Tabela de preços"; cadastrar outra com o mesmo atalho | some da lista e do atalho; o atalho fica livre e o novo cadastro é aceito |
| B6 Link individual | em cada conversa, escolher "Contrato para assinar" | conforme a tabela de dados; nenhum texto com `/contrato/` em http; a resposta da rota não traz o telefone (conferido no corpo da resposta) |
| B7 Colocar na resposta | assumir 0102; preparar "Boas-vindas"; "Colocar na resposta"; digitar algo e preparar de novo | o campo recebe o rascunho; com texto, o botão vira "Substituir a resposta"; **não** enviar |
| B8 Retorno atrasado | instalar `atraso.js` (entrega da resposta real segurada por 4 s, só para 0101). (a) Em 0101, escolher "Contrato para assinar" e, antes de 4 s, abrir 0102. (b) Em 0101, escolher e ir para 0102 e voltar para 0101 antes de 4 s; depois escolher de novo | (a) quando a resposta chega (status 200, registro com a URL na entrega), 0102 não mostra prévia nem aviso de 0101 e não fica "ocupada"; em 0102 o rascunho próprio aparece normalmente. (b) a resposta antiga é descartada; o novo pedido mostra a prévia certa de 0101 |
| B9 Atendente | sair; login T | sem "Gerenciar"; vê as prontas de A; favoritas próprias (não as de R); rascunho funciona |
| B10 Isolamento | busca "Somente" em R e T | nada de B nem de `production` |

**Desktop:** B1–B10 completos.

**Celular** (`resize_window` mobile, recarregar):
- B1, B2 (um cadastro), B4, B6 (0101 e 0102) e B8(a);
- sem rolagem horizontal (`scrollWidth ≤ innerWidth`);
- painel e botões alcançáveis.

**Teclado** (desktop, só teclas):
- abrir a biblioteca e percorrer atalhos e itens com Tab/Shift+Tab;
- preparar com Enter e editar a prévia;
- "Colocar na resposta" com Enter;
- ★ com Espaço (`aria-pressed`);
- cadastrar e arquivar pelo formulário, enviando com Enter;
- foco visível e ordem lógica, sem armadilha de foco.

## Evidência

- Transcrições de V1–V4 em `.local-ux/val-prontas/estado/logs/`, com o HEAD.
- `protegidos-antes.txt` e `protegidos-depois.txt`.
- `conferencia-*.txt` (V3c).
- Resultado por caso e por modo em `estado/resultado-<HEAD>.md`, com:
  - o texto da tela lido pelo navegador;
  - os atributos ARIA;
  - o status e o corpo das respostas da rota;
  - o registro do `atraso.js`.
- Hashes registrados ao final; o resultado é anotado aqui, ligado ao HEAD.

**Verificação offline** (`teste-offline.ps1`, log `teste-offline.log`): 42/42.
- Base nova: recusa sem caminho, relativo, com `..`, protegida, fora da pasta-mãe, nome fora do padrão, já existente, pasta-mãe junção; aceita o caminho correto; recusa os protegidos reais.
- Registro × marcador.
- Remoção: para com porta ocupada, `postmaster.pid`, conf sem id ou marca, junção dentro, base junção, ancestral junção ou base protegida. Remove só a base, com pasta-mãe e vizinho intactos, e também a base sem `data`.
- Retrato dos protegidos.
- Sintaxe dos scripts.
- Ambiente do Next: sem chaves de IA, Gupshup ou cron, e só 127.0.0.1:55502.
- Portas da demonstração só lidas.
- `conferir` só leitura e `parar` sem tocar o cluster.
- `preparar.mjs`: guardas, nenhuma senha impressa, sintaxe.
- `atraso.js`: 5 casos no Node.
- `verificar` real sem efeito.

As importações do preparo foram conferidas sem conexão (`teste-importacoes.log`).

## Resultado (04/10/2026, HEAD `930121d`)

O detalhe por caso, com textos, ARIA, respostas da rota e registros do atraso, está em `.local-ux/val-prontas/estado/resultado-930121d.md` (fora do Git). Os hashes estão em `EVIDENCIAS-930121d.txt`.

| Caso | Desktop | Celular | Teclado |
| --- | --- | --- | --- |
| B1 abertura | ok | ok | ok |
| B2 cadastrar + recusas (http, atalho, título) | ok | ok (1 cadastro) | ok (cadastro só pelo teclado) |
| B3 editar + conflito de versão (2 abas) | ok | — | — |
| B4 favoritar (persiste) | ok | ok | ok (Espaço → `aria-pressed`) |
| B5 arquivar + atalho liberado | ok | — | ok |
| B6 link individual (http: 5 avisos certos; sem telefone nem `/contrato/`) | ok | ok (0101, 0102) | — |
| B6 em https (V3H) | **na tela: não executado** (o navegador embutido não abre o certificado autoassinado). Pela rota real em https, com TLS verificado contra o certificado da execução: **0101 PREENCHIDO** com o contrato de A, nunca o de B; 0102–0105 com os avisos | | |
| B7 colocar na resposta | ok | — | ok |
| B8 retorno atrasado A→B e A→B→A (contato aberto lido na entrega + captura) | ok | ok (A→B) | — |
| B9 atendente (sem gerenciar; 403 em salvar/arquivar; favoritas próprias) | ok | — | — |
| B10 isolamento (B e `production` nunca aparecem) | ok | ok | — |

**Celular:** nenhuma rolagem horizontal; nenhum controle fora da tela; alvos com 24 px ou mais.

**Teclado:** ordem lógica e contorno de foco de 2 px em todos os controles. Ao abrir uma conversa, o foco vai ao título.

**Achados de teclado** (para correção futura, fora desta entrega):
1. ao preparar uma prévia, o foco cai no `BODY`, porque o botão fica desabilitado durante o pedido;
2. depois de "Nova mensagem pronta", o Tab pula o formulário;
3. depois de salvar ou arquivar, o foco volta ao `BODY`.

**Desvio durante a execução.** No modo teclado, o foco estava em "Colocar na resposta", e não na prévia. O texto digitado foi para o campo de resposta e o Enter seguinte caiu em "Enviar resposta". Resultado: **uma** saída `PENDENTE` na conversa sintética 0102, sem `provedor_id`.

Não havia worker, simulador, credencial de Gupshup nem segredo de cron, e os logs dos dois Next têm 0 chamadas a `processar`/`gupshup`. **Nada foi transmitido.** A linha foi apagada junto com a base em V4. Na retomada, o teclado foi exercitado só sem conversa aberta, ou seja, sem campo de resposta na tela.

**V4 e a guarda.** A primeira tentativa parou sem remover nada: a marca acentuada do `postgresql.conf` tinha sido gravada em ANSI pelo `Add-Content` do PS 5.1, e a guarda procurava em UTF-8. Correção:
- a guarda passou a aceitar a marca **exata** em ANSI ou em UTF-8;
- o `subir` passou a gravar em UTF-8;
- o teste offline ganhou 2 casos.

Com isso, `guardas.ps1`, `vp.ps1` e `teste-offline.ps1` mudaram em relação ao manifesto autorizado; os hashes antigos e os novos estão no `MANIFESTO.txt`. A segunda tentativa removeu **somente** a base `kidmais-val-prontas-20261004-7c3e91`.

**Limpeza:**
- portas 55502 e 3050 livres;
- base e build ausentes;
- worktree limpa;
- nenhum processo da validação;
- credenciais, dados sintéticos e chave/certificado apagados;
- protegidos e demonstração idênticos antes e depois.
