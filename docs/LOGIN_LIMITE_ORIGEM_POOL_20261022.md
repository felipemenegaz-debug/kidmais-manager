# Login: limite por origem real e pool do PostgreSQL (22/10/2026)

Estado: a primeira versão está **mergeada em staging** (PR #208, merge `9e096a7`). O **G1 em staging reprovou** a regra do último valor (22/10, 11:45 UTC). A correção da regra (penúltimo valor conferido com `CF-Connecting-IP`) foi **REPROVADA na revisão independente de 22/10** (2 P2 + 1 P3, sem P1). A rodada 3 (`dd697b2`) também foi **REPROVADA** (2 P2 novos + 1 P3, sem P1), a rodada 4 (`931f669`) também (2 P2, sem P1), e a rodada 5 (`2ddac7b`) também (1 P2 + 1 P3, sem P1). As correções da rodada 6 estão **LOCAIS, em commit** na branch `codex/login-origem-penultimo-20261022` sobre `origin/staging` `9e096a7`, e aguardam nova revisão e o novo G1 (seções "Rodada 3" a "Rodada 6"). Nada de push, PR, deploy, env ou banco real nesta rodada.

Origem: achados X-1, X-2 e X-3 da revisão de 22/10/2026 (`ambientes-locais/revisao-exportacao-blocos-20261022/PARECER.md`).

Diretriz de Felipe (22/10/2026): "coloque o limite bem alto de pessoas ao mesmo tempo. Não quero que o usuário tenha que esperar." Uso legítimo nunca é bloqueado, mesmo em pico e com muita gente da mesma empresa na mesma rede. A proteção fica concentrada em quem erra a senha repetidamente.

## O que estava errado

- **X-1.** A rota `app/api/admin/autenticacao/route.ts` chamava `loginAdmin(..., ip = null, ...)`. O serviço trocava `null` pela chave única `ORIGEM_NAO_VERIFICADA`. Resultado: 30 tentativas a cada 300 s valiam para a aplicação inteira, contando sucesso e falha. A 31ª pessoa recebia 429 por 300 s. O `FOR UPDATE` nessa linha única, mantido durante o scrypt, ainda serializava todos os logins.
- **X-2.** O pool tinha `max` 10 e espera de 5 s. Cada login segurava uma conexão durante o scrypt, inclusive na fila do semáforo de 2 scrypts. Com 0,5 CPU, o pool esgotava.
- **X-3.** `fail()` devolvia 500 genérico sem log. O controle positivo desta tarefa reproduziu a causa provável: com a base, 35 de 50 logins simultâneos terminaram em `timeout exceeded when trying to connect` (pool esgotado).

## Decisão: IP confiável no Render (revista depois do G1)

Fonte única: `lib/http/origem-cliente.ts` (`origemConfiavel`). `lib/acessos/http.ts` (`ipDaRequisicao`) delega para ela, então a regra vale para o login, convites, recuperação, cadastro, webhook do Asaas e o limite público em memória.

- **Regra atual:** no Render **com a borda confirmada** (`ORIGEM_CLIENTE_BORDA=render-cloudflare-sobrescreve`, ver "Rodada 3"), o cliente é o **penúltimo** valor do `X-Forwarded-For`. Ele só vale se:
  - o XFF não tiver elemento vazio e o **último** valor (salto da infraestrutura) for um IP público válido;
  - for um endereço público válido;
  - coincidir com `CF-Connecting-IP`;
  - coincidir também com `True-Client-IP`, quando esse cabeçalho vier.
- Em qualquer outro caso (menos de 2 valores, divergência, cabeçalho ausente ou inválido, penúltimo não público), a origem é `null`. Nunca vira o último valor nem uma chave global.
- **Por que o penúltimo:** o G1 mostrou o formato real, `[valores do cliente (forjáveis)…, IP do cliente, salto público da infraestrutura]`. A borda (Cloudflare) acrescenta o IP de quem conectou nela, e depois mais um salto público entra no fim. Esse último valor é compartilhado por muitos clientes. Com a regra anterior (o último), o limite de 300 falhas por IP virava um limite comum a todos.
- **Por que conferir com `CF-Connecting-IP`:** a borda grava nele o mesmo IP que acrescenta ao XFF. O penúltimo valor sozinho seria forjável se alguém chegasse ao balanceador do Render sem passar pela borda (o cliente escreveria o penúltimo e o balanceador acrescentaria o último). Exigir que os dois coincidam reduz esse caminho, e qualquer divergência dá `null`.
- **Por que não `True-Client-IP` sozinho:** a Cloudflare só garante esse cabeçalho com uma transformação gerenciada ligada ("sem ela, o valor pode ser forjado"). O Render não documenta nenhum dos dois cabeçalhos. E um cabeçalho isolado não tem com o que ser conferido. Quando ele vem, precisa concordar.
- **Diagnóstico de posição, sem endereço** (`formatoDaOrigem`/`registrarFormatoDaOrigem`): no primeiro login de cada processo, e em todo login cuja origem é recusada no Render, o log recebe uma linha `[origem] …` com estes campos:
  - `valoresNoEncaminhamento`;
  - a classe do `penultimo` e do `ultimo` (`publico`, `nao-publico`, `invalido` ou `ausente`);
  - a **posição contada do fim** (1 = último) em que `cfConnectingIp` e `trueClientIp` aparecem na lista (ou `ausente`, `invalido`, `fora-da-lista`);
  - `aceito`.
- **Esperado no novo G1:** `valoresNoEncaminhamento` 3 (com a forja) ou 2, `penultimo: "publico"`, `cfConnectingIp: 2`, `trueClientIp: 2` e `aceito: true`.
- IPv6 é agrupado por **/64** na chave do limite de login. Grafias diferentes do mesmo IPv6 entre o XFF e o `CF-Connecting-IP` não são canonizadas: dão recusa, o lado seguro.
- **Falsificação testada:**
  - XFF com o IP da empresa no começo → a chave é o IP real (penúltimo);
  - `CF-Connecting-IP` ou `True-Client-IP` forjados para outra empresa → `null`;
  - lista de 2 valores sem salto (como no acesso direto ao balanceador) → recusa sem conferência.
  - Testes em `lib/http/origem-cliente.test.ts`, `lib/acessos/acessos.test.ts` e na suíte PG.
- **Dependência:** a sessão "Convites e recuperação: scrypt fora da transação" (clone `kidmais-manager-acessos-scrypt-20261022`) usa a mesma `ipDaRequisicao`. Esta correção não muda a assinatura da função, só a regra. Para evitar conflito, integrar esta branch antes, ou rebasear aquela sobre ela. As duas mexem em `lib/http/origem-cliente.ts` e nos testes de `lib/acessos/acessos.test.ts`.

### Regra anterior (v1, mergeada na #208): o último valor

A primeira versão usava o **último** valor do XFF, desde que público. O argumento era que a borda e o balanceador só acrescentam valores. O G1 provou que o último valor é um salto de infraestrutura. Essa regra, também usada antes por convites, recuperação e cadastro, **não deve ir para produção**.

## Novo desenho do login (`lib/autenticacao/service.ts`)

O login passa a ter três fases. Nenhuma conexão fica presa durante o scrypt.

1. **Limites**, numa transação curta (milissegundos):
   - origem: reserva uma vaga de falha (`reservarOrigem`);
   - conta: consome 1 tentativa (`consumirLimite`, sem mudança).
2. **Senha:** uma leitura simples devolve a conexão ao pool, e então roda o scrypt (`conferirSenha`, N=131072, **sem mudança**). Uma conta inexistente confere contra um hash vazio, com o mesmo custo.
3. **Resultado**, noutra transação curta, que **não toca a origem**:
   - falha → auditoria de recusa;
   - sucesso → a conta é relida com `FOR UPDATE` (se a senha mudou ou a conta foi desativada durante o scrypt, a tentativa vale como recusada), o limite da conta é zerado e a sessão é criada.
4. **Acerto da origem**, num `UPDATE` avulso, depois do resultado: a falha é confirmada (no teto, bloqueia a origem pela janela inteira) ou a vaga é devolvida no acerto. Num erro inesperado, a vaga é devolvida num `finally`. Se o acerto falhar, a vaga expira com a janela.
- Por que avulso: na primeira versão, o acerto ficava dentro da transação da sessão. Com 50 acertos do mesmo IP, essas transações se enfileiravam na linha do IP segurando conexões, e sob carga o pool estourava. Avulso, a linha do IP fica travada só durante um comando. Também não existe ciclo de travas: a fase 1 trava origem → conta, e a fase 3 trava usuário → conta.
- O `FOR UPDATE` global deixou de existir. Restam travas por IP e por conta, só nas transações curtas.
- O IP confiável agora vai também para `sessoes_administrativas.ip` e para a auditoria do login (antes ia `null`). É dado pessoal, guardado por segurança, como já acontecia nos fluxos de convite e recuperação.

### Números

| Limite | Regra | Justificativa |
|---|---|---|
| Conta (IDENTIFICADOR) | 5 tentativas / 900 s, zerado no sucesso | Inalterado. É a proteção principal de cada conta. |
| Origem (IP ou /64) | **300 falhas** / 900 s; no teto, bloqueio de 900 s. Sucesso **não conta**. | Uma empresa com 50 pessoas no mesmo NAT, cada uma errando até o limite da própria conta, soma 250 falhas antes de cada conta se travar sozinha. Logins certos não contam. Folga ampla, portanto, para qualquer uso legítimo. Para quem ataca, 300 tentativas a cada 15 min (~0,33/s) é bem abaixo do que o scrypt aceitaria (2 em paralelo), e cada conta continua limitada a 5. |
| Sem IP confiável | **nenhum** limite de origem | Nada de chave global. Fica o limite por conta. O semáforo de 2 scrypts limita a CPU. No Render isso só ocorre com topologia inesperada, que o diagnóstico registra. |

- A vaga é **reservada antes do scrypt** para que uma rajada simultânea não ultrapasse o teto (provado: com o contador em 295, 20 falhas simultâneas → exatamente 5 conferidas e 15 com 429). No sucesso, a reserva é devolvida.
- O sucesso **não zera** a origem. Quem tivesse uma conta válida poderia limpar o próprio IP entre as tentativas.
- **Corrida da CHECK de datas (achado nesta tarefa, também no `consumirLimite` compartilhado):** o gatilho grava `atualizado_em = now()`, a hora de início da transação. Uma transação que começou antes de outra abrir a janela, mas trava a linha depois, gravava `atualizado_em < janela_iniciada_em` e caía na CHECK `limites_autenticacao_datas_check` (500). A serialização global escondia isso. Correção sem migration: no caminho sem reinício, `janela_iniciada_em = LEAST(janela_iniciada_em, now())` (o início recua milissegundos), e a devolução e a falha comparam `janela_iniciada_em <= início da reserva`. Como `consumirLimite` é compartilhado, a correção vale também para convite, recuperação, cadastro e webhook.
- A namespace nova (`login-falhas`) faz o login ignorar as linhas antigas, inclusive a global `ORIGEM|ORIGEM_NAO_VERIFICADA`. Não há migration: a tabela `limites_autenticacao` é a mesma.

## Pool (`lib/db/postgres.ts`)

- Padrão `max` **30**, espera **10 s** (antes 5 s), ociosa 30 s. O `max` tem teto de 40 no código, e um valor inválido no ambiente cai no padrão (`opcoesDoPool`).
- Conta das conexões. Os dois Postgres do Render estão no plano `0.1c-256mb` (lido só em metadados em 22/10). Nesse plano o limite é de ~100 conexões, com algumas reservadas ao superusuário (tutorial "connection limits" do Render). No deploy sem interrupção, a instância antiga e a nova coexistem: 2 × 30 = 60. Sobram ~35 para os crons (3 conexões cada), migrations, psql e o monitoramento do Render.
- **Atenção: no Render vale a variável de ambiente.** `render.yaml` (staging) e o env de produção definem `DATABASE_POOL_MAX=10` e `DATABASE_CONNECTION_TIMEOUT_MS=5000`. O `render.yaml` local (staging) passou a 20/10000 — 20 primeiro, por decisão de Felipe em 22/10 (gate G2), antes de considerar 30 —, mas **nada foi aplicado**. Trocar o env nos serviços exige autorização de Felipe e reinicia o serviço.
- **O pool não substitui CPU.** Com a CPU saturada (0,5 CPU, scrypt de ~128 MiB e CPU alta), mais conexões só mudam a espera de lugar, do pool para o processador. A correção do login tira o scrypt de dentro da conexão, e isso resolve o esgotamento causado pelo login. A latência com 40–50 pessoas ativas continua dependendo da CPU. O upgrade do plano é decisão separada de Felipe.

## Logs do 500 (X-3)

`fail()` passa a registrar a causa de qualquer 500 no log, nunca na resposta. A linha `[autenticacao] falha não tratada {...}` traz nome, código do driver e mensagem curta, com e-mails trocados por `<email>`. JSON inválido no corpo agora responde 400, não 500.

## Outros usos de `ORIGEM_NAO_VERIFICADA` (histórico — substituídos na rodada 3)

> A tabela abaixo descreve o estado ANTES da rodada 3. A revisão de 22/10 mostrou que esse fallback continuava produzindo limite global. Ele foi removido de todos os fluxos; ver "Rodada 3".

Esses fluxos recebem `ctx.ip` de `ipDaRequisicao`. No Render, o IP é conhecido, e cada IP tem a própria chave. A chave global só aparece fora do Render ou com topologia inesperada, e nesse caso a regra (sem origem confiável → `null`) equivale ao comportamento anterior, em que uma chave de salto já era compartilhada por todos. **Com a regra v1 (último valor), esses fluxos usavam em staging o salto da infraestrutura como chave, compartilhada por todos. A regra do penúltimo corrige isso também para eles.**

| Fluxo | Regra de origem | Observação |
|---|---|---|
| `lib/acessos/convites.ts` (consultar/aceitar) | 30 / 900 s | O aceite roda scrypt dentro da transação com a linha de origem travada (por IP). Volume baixo. |
| `lib/acessos/recuperacao.ts` (pedido / redefinir) | 10 / 3600 s; 10 / 900 s | Envia e-mail. Sem IP, a chave global funciona como teto contra envio em massa. O redefinir roda scrypt dentro da transação. |
| `lib/cadastro/publico.ts` | 10 / 3600 s; 30 / 900 s | Envia e-mail de confirmação; mesmo raciocínio. |
| `lib/assinatura/webhook-asaas.ts` | 300 / 60 s; recusas 10 / 600 s | Webhook vindo dos servidores do Asaas. |
| `lib/http/limite-publico.ts` (memória) | 120/min etc. | Sem IP, todos dividem o balde. |

**Follow-up sugerido (fora deste escopo):** levar o mesmo desenho aos fluxos de convite e recuperação, ou seja, scrypt fora da transação e, sem IP, um teto global alto em vez do limite por IP. Hoje esses fluxos não bloqueiam o uso diário, porque têm IP no Render e volume baixo.

## Validação local (22/10/2026)

- Unitários: `lib/http/origem-cliente.test.ts` (origem, falsificação, salto interno, IPv6/64, diagnóstico sem endereço, causa do 500, pool, rota passando o IP) + `lib/acessos/acessos.test.ts` + `lib/autenticacao/*.test.ts`: **53/53**.
- PostgreSQL descartável (`lib/autenticacao/login-origem.postgres.test.ts`, modelos `atual` e `063`, cluster próprio em 127.0.0.1:55871, removido ao final). Pool **real** de 10 conexões e espera de 10 s. **7/7 nos dois modelos, em 2 rodadas seguidas sobre a árvore final** (`execucao-v5-*.log`):
  1. 50 logins simultâneos do mesmo IP com a senha certa → 50 OK, nenhum 429, contador da origem 0; repetido → 50 OK. Prova direta (AsyncLocalStorage): **0 transações abertas daquele login no instante do scrypt, nos 50**;
  2. duas origens independentes → contagens separadas (6 e 3), e um login certo não muda nada;
  3. IP abusivo com cabeçalho forjado para parecer a empresa → teto exato sob rajada (5 conferidas, 15 com 429) e bloqueio com `Retry-After` > 800 s; as **mesmas contas** da empresa entram pelo IP dela, e outro IP entra;
  4. IP ausente → 40 falhas e 50 logins certos, nenhuma linha de origem criada e nenhum 429 global; o limite da conta continua (5 falhas → 429 mesmo com a senha certa);
  5. janela nova sob concorrência (3 IPs novos × 25 falhas simultâneas; 3 contas novas × 8) → contagem exata (25; 5×401 + 3×429), sem 500;
  6. determinístico: uma transação que começou antes de outra abrir a janela consegue consumir;
  7. limite por conta sob IP → as colegas e o IP não são afetados.
- **Controles positivos:**
  - suíte com o `service.ts` da base → falha com `{"429":20,"OK":30}` (o X-1: a 31ª pessoa é bloqueada). Numa rodada anterior, com o pool de 3, falhou com 35 `timeout exceeded when trying to connect`;
  - mutante sem o `LEAST` do `consumirLimite` → o teste determinístico cai na CHECK `limites_autenticacao_datas_check`;
  - mutante sem os dois `LEAST` → a suíte cai na mesma CHECK sob concorrência.
- Histórico honesto: duas rodadas intermediárias falharam e motivaram as duas correções acima (acerto avulso da origem e `LEAST`). A prova "pool pequeno estoura" foi trocada pela medição direta, porque dependia da carga da máquina.
- `npx tsc --noEmit`, ESLint dos arquivos tocados e `git diff --check`: limpos. `npm run check:v1:static` na árvore final: **PASS** (3272/3272 + 103/103; o único aviso de lint é preexistente, em `lib/inteligencia/skills/catalogo.ts`). No clone novo, com `core.autocrlf=true`, o teste de checksums do acervo de Convites falha porque os SVGs saem com CRLF. Isso não tem relação com este delta: regrave-os com `rm lib/convites/acervo/*.svg && git -c core.autocrlf=false checkout -- lib/convites/acervo/`.

## Riscos e rollback

- Se o Render mudar a topologia (outro salto, ou `CF-Connecting-IP` fora da posição 2), a origem passa a ser `null`. O login segue só com o limite por conta, sem bloqueio global. Sinal no log: `aceito: false` e a posição do `cfConnectingIp`. Ação: rever a regra com a linha de diagnóstico.
- Risco residual (antes da rodada 3): uma requisição que chegue ao balanceador do Render sem passar pela borda e forje o XFF e o `CF-Connecting-IP` de forma coerente escolhe a chave. Na rodada 3 isso passou a depender da prova operacional: sem `ORIGEM_CLIENTE_BORDA`, nenhum cabeçalho vale.
- Rollback: reverter o commit. Não há migration nem dado novo além das linhas da namespace `login-falhas`, que expiram sozinhas.

## Revisão independente — 22/10/2026

**APROVADO para PR/staging**; produção condicionada aos gates abaixo.
- **Validações:** unitários 25/25; PG 7/7 nos modelos `atual` e `063` (4 execuções); `check:v1:static` PASS; mutação 9/10.
- **Gate G1 (P2):** a regra "último X-Forwarded-For" não está verificada no Render. Em 2021 a equipe do Render disse que o cliente vem **primeiro**. Se o último valor puder ser forjado, um atacante escapa do limite por IP ou tranca o IP de uma empresa por 15 min. Antes de produção, em staging: fazer um login com `X-Forwarded-For: 203.0.113.9` forjado e conferir na linha `[origem]` o seguinte: ≥2 valores, `ultimo: "publico"` e `trueClientIp`/`cfConnectingIp: "igual-ao-ultimo"`. A frase acima "Até lá, o login segue protegido" não vale se a regra estiver errada.
- **Gate G2 (P2):** o Postgres `0.1c-256mb` tem 0,1 CPU e 256 MB. Antes de usar 30 em produção, subir o env primeiro para 20 em staging e medir conexões, CPU e memória do banco.
- **P3:**
  - a reconferência do hash na fase 3 não tem teste (o mutante sobreviveu);
  - o controle da suíte PG falhou uma vez sob carga, então é sensível a tempo;
  - `acertarOrigem` engole erros sem log;
  - o IP gravado em sessões e na auditoria precisa constar do aviso de privacidade e da política de retenção.

Parecer: `../ambientes-locais/revisao-p3-login-20261022/PARECER.md`.

## G1 em staging: REPROVADO (22/10/2026, 11:45 UTC) → regra do penúltimo

- O G1 foi autorizado por Felipe e executado por outra sessão: uma tentativa só, com conta inexistente, senha errada e XFF forjado `203.0.113.9` → 401. Deploy `dep-dbcv7l5g…`, merge `9e096a7`.
- Linha do log: `[origem] formato {"render":true,"valoresNoEncaminhamento":3,"ultimo":"publico","trueClientIp":"outra-posicao","cfConnectingIp":"outra-posicao"}`.
- Leitura: a forja não controla a chave, mas o último valor é um salto público de infraestrutura, e o IP real é o anterior.
- **Correção local** (branch `codex/login-origem-penultimo-20261022`, sem commit): regra do penúltimo conferido (seção de decisão acima), diagnóstico de posição sem endereço, testes de 3 valores (forjado, cliente, salto), 2 valores sem forja, divergência com `CF-Connecting-IP`, `True-Client-IP` discordante, penúltimo não público e IPv6. A suíte PG `login-origem` passou a montar o cabeçalho no formato do G1.
- **Próximo G1:** repetir a mesma tentativa única depois do deploy autorizado. Esperado: `penultimo: "publico"`, `cfConnectingIp: 2`, `trueClientIp: 2` e `aceito: true`.
- Parecer da revisão e resultado do G1: `../ambientes-locais/revisao-p3-login-20261022/PARECER.md`.

## Rodada 3 — correções da revisão de 22/10/2026 (REPROVADO, sem P1)

Parecer: `../ambientes-locais/revisao-ip-penultimo-20261022/PARECER.md`. Evidências desta rodada: `../ambientes-locais/revisao-ip-correcao-20261022/`.

### P2 — fallback global (`ORIGEM_NAO_VERIFICADA`) → limite por fluxo/identificador

Origem `null` não vira mais uma chave única com o teto de um IP em nenhum fluxo:

| Fluxo | Com IP confiável | Sem IP confiável (antes: chave global com o teto de um IP) |
|---|---|---|
| Convite (consultar/aceitar) | 30 / 900 s por IP (IPv6 por /64) | 30 / 900 s **por link** (hash do token; token malformado tem chave própria) |
| Recuperação — pedido | 10 / 3600 s por IP | teto global **alto**, 300 / 3600 s, só contra envio em massa; o limite por e-mail (3/h) continua |
| Recuperação — redefinir | 10 / 900 s por IP | 10 / 900 s **por link** |
| Cadastro — pedido | 10 / 3600 s por IP | teto global alto, 300 / 3600 s; limite por e-mail continua |
| Cadastro — confirmar | 30 / 900 s por IP | 30 / 900 s **por link** |
| Webhook do Asaas | 300 / 60 s por IP; registro de recusas 10 / 600 s | baldes **separados por resultado do token** (válido × inválido, 3000 / 60 s cada); registro de recusas 10 / 600 s. Uma enxurrada com token errado não trava as entregas autênticas |
| Limite público em memória (cotação, fechamento, agenda, identidade) e formulário do site | 120/min, 10/h, 20/h por IP; PEDIDO também 60/h por empresa | balde **por endereço de empresa** (chave comum só quando não há empresa) com teto **10×**; PEDIDO mantém 60/h por empresa |

- `lib/acessos/limite-origem.ts` é **idêntico** ao do clone `kidmais-manager-acessos-scrypt-20261022` (mesmo `consumirOrigem`, mesmas namespaces `<fluxo>-sem-origem`, mesmos tetos de 300). As chamadas em convites/recuperação/cadastro foram escritas como lá, para a integração não divergir. Ao integrar aquele clone, **manter a regra de origem desta branch** (o clone ainda seleciona o último XFF).
- Os tetos globais altos (recuperação/cadastro 300/h, identidade 200/h sem empresa) continuam sendo uma chave comum, mas com teto muito acima do de um IP: protegem contra envio em massa e enumeração, e não travam o uso normal. Isso é declarado, não escondido.
- Testes: `lib/acessos/limite-origem.test.ts` (duas origens recusadas por fluxo; tetos preservados), `lib/http/limite-publico.test.ts` (duas origens recusadas × duas empresas; reprodução da revisão com o `limitarPublico` real), `lib/assinatura/webhook-asaas.test.ts` (400 recusas sem origem e a entrega autêntica segue 200).

### P2 — a igualdade dos cabeçalhos não autentica a borda → confirmação operacional obrigatória

- `origemConfiavel` só aceita cabeçalhos com `RENDER=true` **e** `ORIGEM_CLIENTE_BORDA=render-cloudflare-sobrescreve` no ambiente do processo. Sem isso, a origem é `null` em todo pedido (e os fluxos usam a tabela acima). A confirmação vem do ambiente, nunca de cabeçalho.
- Motivo: uma regra baseada só em cabeçalhos não distingue a lista legítima `[cliente, salto]` com CF = cliente da forja coerente `[forjado, salto]` com CF = forjado, feita por quem chega ao balanceador sem passar por uma borda que sobrescreve o CF. A confirmação declara a garantia operacional; ela **só pode ser ligada depois do G1-A abaixo**, com autorização de Felipe.
- **Garantia operacional ainda NÃO comprovada.** Não se sabe se existe entrada alternativa no Render (nada foi testado remotamente nesta rodada). Até o G1-A, staging e produção ficam sem limite por IP depois do deploy desta versão; o limite por conta e os limites por fluxo continuam.
- O diagnóstico ganhou `bordaConfirmada` e `vazios`, e uma **marca de diagnóstico** opcional (`x-kidmais-diagnostico`, só `[A-Za-z0-9-]{8,64}`): quando válida, força a linha `[origem]` e entra nela como `marca`, para correlacionar o pedido com a linha, sem endereço. Marca inválida é ignorada.

### P3 — estrutura do XFF

- Elementos vazios **não são mais compactados**: `a, ,b`, `a,,b`, vírgula no começo ou no fim → `null` (o diagnóstico conta `vazios` e classifica a posição como `vazio`).
- O **último** valor precisa ser IP público válido (lixo, privado, documentação, `IP:porta` → `null`). Os valores à esquerda do penúltimo vêm do cliente e continuam livres; espaços ao redor dos valores continuam aceitos.
- Validação sintática não é autenticação: a autenticação da borda é o item anterior.

### Validação local (rodada 3, 22/10/2026)

Evidências em `../ambientes-locais/revisao-ip-correcao-20261022/`.

- **Unitários focados** (acessos, autenticação, cadastro, http, webhook do Asaas): 193/193.
- **PostgreSQL descartável próprio** (cluster novo em 127.0.0.1:55943, papel `kidmais_descartavel`, sem herdar URL de banco; harness `pg-ip-correcao.cjs`):
  - rodada 1: `login-origem` **7/7 em `atual` e 7/7 em `063`**, mais `cadastro-069` [063], `painel-063` [063] e `cobranca-e8` [atual, 075], todos PASS (`execucao-1.log`);
  - rodada 2, sobre a árvore final: `login-origem` 7/7 em `atual` e em `063` (`execucao-2.log`);
  - depois: cluster encerrado (`pg_ctl status` 3, sem `postmaster.pid`) e diretório removido (`relatorios-pg/*encerramento.json`, `*limpeza.json`).
- **Mutantes** (cópia isolada, checkout intocado; `mutantes.cjs`/`mutantes.json`): **14/14 mortos por asserção**, controles 50/50 antes e depois. Os pontos mutados foram:
  - borda só com `RENDER`;
  - vazios compactados;
  - vazio aceito;
  - último salto sem validação;
  - limite público com chave global, com o teto de um IP e sem a empresa;
  - teto global igual ao de um IP;
  - identificador virando chave única;
  - convite de volta ao fallback;
  - webhook com balde único e com o teto de um IP;
  - marca sem validação;
  - marca que não força a linha.
- **`npm run check:v1:static`**: **PASS único** do comando completo (3299/3299 unitários, 103/103 mocks, lint sem erros com o aviso preexistente `FinalidadeSkill`, TypeScript, build e leitura de PDF no asset; saída 0; `check-v1-static.log`).
- Nada remoto: sem push, PR, Render, deploy, env ou banco real; `.env.local` não lido.

### Novo G1 (só depois de deploy e autorização de Felipe; nada disto foi executado)

Pré-condições: commit aprovado implantado em staging por PR/deploy autorizados, e o commit realmente implantado identificado pelo deploy (id do deploy e commit). `ORIGEM_CLIENTE_BORDA` **ainda desligada**. Conta sintética **inexistente**, senha errada, uma tentativa por passo. Cada passo usa uma marca nova (`x-kidmais-diagnostico: g1-<nonce>`), e a linha do log é localizada pela marca.

**G1-A — entrada alternativa (com a confirmação desligada; todo login recusado no Render gera linha):**

0. **Inventário das entradas** antes de testar: o endereço padrão do serviço; todo domínio próprio, alias e domínio legado ainda ligado; o ingresso direto que o Render documenta, com `Host`/SNI corretos; e os caminhos IPv4 e IPv6 que existirem. Fonte: o painel e a documentação do Render no dia. Não inventar IP e não varrer.
1. Em cada entrada do inventário: `X-Forwarded-For: 8.8.8.8, 1.1.1.1`, `CF-Connecting-IP: 1.1.1.1`, `True-Client-IP: 1.1.1.1`. Esperado: 401 (sem 429/500), correlacionado pela marca, e a linha mostrando `render:true`, `bordaConfirmada:false`, `aceito:false`, `vazios:0`, **`valoresNoEncaminhamento:4`** e **`cfConnectingIp:2`** (o CF foi sobrescrito com o IP real de quem testou, que fica no penúltimo lugar). Se aparecer `valoresNoEncaminhamento:3` com `cfConnectingIp:2`, o CF forjado atravessou: **reprovado, não ligar a confirmação**. `trueClientIp:3` (forjado não sobrescrito) é registrado: com a confirmação ligada ele só causa recusa, que é o lado seguro.
2. Uma entrada só conta como fechada com evidência de recusa no ingresso (resposta do provedor que não chega ao serviço). Timeout isolado, falha de DNS/TLS ou teste incompleto são **INCONCLUSIVOS** e não liberam a env. Qualquer `valoresNoEncaminhamento:3` com `cfConnectingIp:2` reprova.
3. **Rede privada (premissa, não prova):** o G1-A não cobre a rede privada do Render. Antes de ligar a env, verificar quem alcança o listener do serviço web (serviços e crons do workspace) e se algum deles repassa cabeçalhos de usuários (proxy ou forwarder). Se algum repassar, ele precisa remover ou sobrescrever XFF/CF/TCI, ou a env fica desligada. Registrar a justificativa.
- A marca tem teto de 10 linhas por minuto por processo (rodada 4). Espaçar os passos e usar uma marca nova por passo.

**G1-B — regra positiva (depois do G1-A aprovado e da troca de env autorizada, que reinicia o serviço):**

4. `X-Forwarded-For: 203.0.113.9` forjado, sem CF/TCI enviados. Esperado: 401 (sem 429/500) e a linha `[origem] formato` com a marca: `render:true`, `bordaConfirmada:true`, `valoresNoEncaminhamento:3`, `vazios:0`, `penultimo:"publico"`, `ultimo:"publico"`, `cfConnectingIp:2`, `trueClientIp:2` **ou** `"ausente"`, `aceito:true`. Nenhum endereço na linha.
5. Negativos (uma tentativa cada): XFF com vírgula vazia (`203.0.113.9, ,8.8.8.8`) → linha com `vazios:1`, `aceito:false`, 401. Nenhum pedido de terceiros recebe 429 por causa disso (não há chave global).
6. `cfConnectingIp:2, aceito:true` sozinho **não** aprova: só vale junto com o G1-A aprovado.

Rollback do G1: desligar `ORIGEM_CLIENTE_BORDA` (volta a origem `null` com limites por fluxo), ou reverter o commit.

## Rodada 4 — correções da revisão da rodada 3 (REPROVADO, sem P1)

Parecer: `../ambientes-locais/revisao-ip-r3-independente-20261022/PARECER.md`. A borda (trava local) e a estrutura ficaram fechadas localmente; o fallback ficou parcial por dois P2 novos e um P3.

### P2-R3-1 — códigos de empresa inventados enchiam o limitador público

- O limitador não usa mais o texto bruto de `?empresa=`. A chave da empresa é **canônica** (`chaveDaEmpresaPublica`):
  - código já resolvido pelo servidor → `empresa:<id>`;
  - código inexistente, inválido ou ainda não visto → **um** balde comum, `empresa-nao-confirmada` (com o teto do grupo, 10× sem origem);
  - sem código → endereço padrão.
- `lib/http/empresas-publicas.ts` guarda só os códigos que `escopoCotacaoPublica` resolveu (empresa ATIVA, com orçamento online), associados ao id. Capacidade fixa de 5.000, sai o menos recente. A página `/b/<código>` passa pelo mesmo resolvedor, então o cliente legítimo confirma a empresa ao abrir a página, antes das APIs.
- Os baldes por IP e os demais (empresa/sem origem, conjunto limitado) ficam em **mapas separados**. Nenhum esgota o outro.
- O formulário do site resolve o site antes do limite e conta pelo `siteId`. Slug inventado dá 404 sem criar balde (a mesma leitura já acontece, sem limite, na página pública do site).
- **Residual declarado:** sem origem, um código ainda não visto neste processo divide o balde `empresa-nao-confirmada` com os inventados. Abrir a página da empresa confirma o código e o tira desse balde.

### P2-R3-2 — pedidos inelegíveis gastavam a cota global de e-mail

- **Recuperação:** sem IP, nada global antes do pedido.
  - A proteção preliminar é o limite do próprio e-mail (3/h).
  - A cota global de 300 envios/h só é reservada quando o pedido vai abrir (conta ativa e sem pedido recente), na mesma transação, com a conta travada.
  - Com IP, o limite por IP continua primeiro.
  - A resposta pública segue indistinguível.
- **Cadastro:** a cota global de envios só é consumida depois do limite do e-mail. Todo pedido que passa desse limite gera um envio (confirmação ou aviso de conta existente).
- Uma falha de envio consome a cota. É o lado conservador para o provedor de e-mail.

### P3-R3-3 — a marca pública forçava uma linha por pedido

- Teto fixo por processo de 10 linhas forçadas por minuto (`MARCAS_POR_JANELA`/`JANELA_MARCAS_MS`). É um contador, sem guardar marcas.
- Acima do teto, a marca é ignorada e vale a amostragem normal. As origens recusadas continuam sendo registradas, como antes.

### Validação local (rodada 4, 22–23/10/2026)

Evidências em `../ambientes-locais/revisao-ip-correcao-20261022/` (`execucao-r4-*.log`, `mutantes.*`, `check-v1-static-r4.log`).

- **Unitários focados** (acessos, autenticação, cadastro, http, webhook, cotação pública, rotas de marketing): 215/215, mais 8/8 no limitador depois do teste de ordem do formulário. Inclui a reprodução da revisão: 20.000 códigos inventados sem origem → a empresa confirmada e uma origem confiável nova seguem em IDENTIDADE, LEITURA e PEDIDO; 300 repetições sem envio → a conta ativa de B recebe o link; o 301º envio elegível é recusado; 1.000 marcas → 10 linhas.
- **PostgreSQL descartável próprio** (127.0.0.1:55943, cluster novo a cada subida, sem herdar URL de banco):
  - `r4-1`: login-origem 7/7 em `atual` e em `063`, mais cobranca-e8 [atual, 075], cadastro-069, fixture-atualizacao-staging [078], painel-063 e marketing-a [086], todos PASS;
  - `r4-2`: login-origem `atual` PASS, mas **`063` FALHOU** em "sem IP confiável" com 10/50 `timeout exceeded when trying to connect` (pool real de 10, espera de 10 s; testes levaram 22–24 s contra 15 s). A CPU da máquina estava em 84% por processos de fora. Esta rodada não toca login nem pool, e a suíte já era registrada como sensível a tempo. Registrado como falha, não omitido;
  - `r4-3` (cluster novo): login-origem 7/7 em `atual` e em `063`;
  - clusters encerrados (`pg_ctl status` 3) e removidos.
- **Mutantes**: **21/21 mortos por asserção** (os 14 da rodada 3 + 7 novos: texto bruto de `?empresa=`, código não confirmado com balde próprio, resolução sem confirmar, cota antes da elegibilidade na recuperação, cota antes do limite do e-mail no cadastro, marca sem teto, slug bruto no formulário); controles 66/66 antes e depois.
- **`npm run check:v1:static`**: **PASS único**, saída 0 (3304/3304 unitários, 103/103 mocks, lint sem erros com o aviso preexistente `FinalidadeSkill`, TypeScript, build e PDF).
- Nada remoto; `.env.local` não lido.

## Rodada 5 — correções da revisão da rodada 4 (REPROVADO, sem P1)

Parecer: `../ambientes-locais/revisao-ip-r4-independente-20261023/PARECER.md`. P2-R3-2 (cota de e-mail) e P3-R3-3 (marca) foram **fechados** localmente.

### P2-R4-1 — empresa legítima fora do registro era cobrada como desconhecida

- Antes, o registro só conhecia códigos confirmados por visita à página ou às APIs. Depois de reinício/deploy ou de saída do registro, uma página já aberta chamava a API, e a empresa caía no balde comum, possivelmente saturado.
- Agora `idDaEmpresaPublica` (`lib/http/empresas-publicas.ts`) é chamada **antes** de cobrar um código fora do registro:
  - formato inválido → desconhecido, sem consulta;
  - código fora do registro → espera a carga em curso, ou dispara uma carga de **todos** os códigos de empresas ATIVAS (uma consulta, até 20.000 linhas);
  - no máximo uma carga a cada 30 s; uma enxurrada de códigos inventados custa uma consulta por intervalo, nenhuma por código;
  - falha da carga → desconhecido, sem lançar (a rota recusa do mesmo jeito).
- Com isso, `limitarPublico` ficou **assíncrono**. As 9 rotas e as 2 chamadas de `rotas-publicas.ts` passaram a usar `await`. A ordem "limite antes de qualquer leitura" está preservada e testada.
- Com origem confiável, `PEDIDO_EMPRESA` também usa o id: empresas legítimas não dividem mais o teto das não confirmadas.
- **Residual declarado:** uma empresa criada depois da última carga, durante os ≤30 s seguintes, ainda conta como desconhecida.

### P2-R4-2 — o formulário lia e validava o corpo antes do limite

- Nova ordem: resolver o site → limite por `site:<siteId>` → recusar `content-length` acima de 16.000 sem ler → ler e validar o corpo.
- Acima do limite, o corpo não é lido nem validado: 429 com zero leituras, coberto por teste.

### Validação local (rodada 5, 23/10/2026)

Evidências em `../ambientes-locais/revisao-ip-correcao-20261022/` (`execucao-r5-*.log`, `carga-empresas-sql.json`, `mutantes.*`, `check-v1-static-r5.log`).

- **Unitários focados** (acessos, autenticação, cadastro, http, webhook, cotação pública, rotas públicas de pacotes/adicionais/disponibilidade/CPF, marketing): **249/249**. Cenários incluídos:
  - processo recém-iniciado com o balde comum saturado por 20.000 códigos: a empresa legítima nunca vista passa em IDENTIDADE, LEITURA e PEDIDO, e 21.420 códigos desconhecidos custaram **uma** carga;
  - saída do registro por capacidade, com volta pela carga depois do intervalo;
  - formato inválido nunca consulta;
  - falha da carga não lança;
  - formulário: 429 e 413 com **zero** leituras do corpo.
- **PostgreSQL descartável próprio** (127.0.0.1:55943, cluster novo):
  - `r5-1`: login-origem 7/7 em `atual` e em `063`, mais cobranca-e8 [atual, 075], cadastro-069, fixture-atualizacao-staging [078], painel-063 e marketing-a [086], todos PASS;
  - consulta da carga (o SQL exato do código, em transação somente leitura) válida nos modelos `atual`, `063` e `086` (`carga-empresas-sql.json`);
  - `r5-2`: login-origem 7/7 em `atual` e em `063`;
  - cluster encerrado (`pg_ctl status` 3) e removido.
- **Mutantes**: **26/26 mortos por asserção** (os 21 anteriores + 5 novos: código desconhecido sem carga, carga sem intervalo, formato não conferido antes da consulta, formulário sem corte pelo tamanho declarado, corpo lido antes do limite); controles 75/75 antes e depois.
- **`npm run check:v1:static`**: **PASS único**, saída 0 (3306/3306, 103/103, lint sem erros com o aviso preexistente `FinalidadeSkill`, TypeScript, build e PDF).
- Nada remoto; `.env.local` não lido.

## Rodada 6 — correções da revisão da rodada 5 (REPROVADO, sem P1)

Parecer: `../ambientes-locais/revisao-ip-r5-2ddac7b-local-b/PARECER.md`. Os dois P2 da rodada 4 foram **fechados** nos cenários originais.

### P2-R5-1 — capacidades incompatíveis entre o registro e o limitador

- Antes: o registro admitia 20.000 empresas, mas o limitador guardava cada contador (três grupos + teto de PEDIDO por empresa) como chave solta num mapa de 50.000. Cerca de 16.667 empresas ativas na mesma janela enchiam o mapa, e a seguinte recebia 429 em tudo.
- Agora os contadores de cada **entidade canônica** (empresa, site, endereço padrão, não confirmadas) ficam **juntos numa entrada**.
  - O número de entradas é derivado do registro: `MAXIMO_ENTIDADES = 2 × 20.000 + 64`. O dobro cobre a troca de empresas no registro durante uma janela, que só acontece acima do teto dele.
  - Cheio de entradas vigentes, só a entrada **nova** é recusada; as existentes mantêm as cotas. Entradas vencidas saem antes.
  - O mapa por IP continua separado e com o teto anterior (20.000).
- Teste: 20.000 empresas usando IDENTIDADE, LEITURA, PEDIDO e o teto de PEDIDO. A seguinte passa nos três grupos e em PEDIDO com IP confiável novo; ocupam-se 20.003 entradas, e o teto de 60 PEDIDO por empresa continua valendo.

### P3-R5-2 — teto da carga de empresas

- A carga continua limitada a 20.000 códigos, sempre o mesmo prefixo por ordem de código.
- Quando volta cheia, isso fica marcado (`estadoDaCarga().noTeto`) e é avisado **uma vez por processo** no log, sem dado de empresa.
- As empresas além do teto só entram pelo resolvedor e, até lá, contam como desconhecidas. Rever o teto antes de passar de 20.000 empresas ativas.

### Validação local (rodada 6, 23/10/2026)

Evidências em `../ambientes-locais/revisao-ip-correcao-20261022/` (`execucao-r6-*.log`, `mutantes.*`, `check-v1-static-r6.log`).

- **Unitários focados**: **252/252**. Inclui o registro cheio (20.000 empresas, a seguinte passa nos três grupos e em PEDIDO com IP novo), o limite de entradas derivado do registro (cheio de vigentes: só a nova é recusada; vencidas saem) e a carga no teto avisada uma vez sem dado de empresa.
- **PostgreSQL descartável próprio** (127.0.0.1:55943, cluster novo):
  - `r6-1`: login-origem 7/7 em `atual` e em `063`, mais marketing-a [086] e fixture-atualizacao-staging [078];
  - `r6-2`: login-origem 7/7 em `atual` e em `063`;
  - cluster encerrado (`pg_ctl status` 3) e removido.
- **Mutantes**: **29/29 mortos por asserção** (os 26 anteriores, com o M7 ajustado ao novo código, + contador por entrada sem agrupar, entradas sem folga sobre o registro, teto da carga não detectado); controles 78/78.
- **`npm run check:v1:static`**: **PASS único**, saída 0 (3309/3309, 103/103, lint sem erros com o aviso preexistente `FinalidadeSkill`, TypeScript, build e PDF).
- Nada remoto; `.env.local` não lido.
