# Login: limite por origem real e pool do PostgreSQL (22/10/2026)

Estado: **implementação LOCAL**, sem commit, sem push, PR, deploy, env ou banco real. Branch `codex/login-limite-pool-20261022`, base `staging` `a102611`. Aguarda revisão independente.

Origem: achados X-1, X-2 e X-3 da revisão de 22/10/2026 (`ambientes-locais/revisao-exportacao-blocos-20261022/PARECER.md`).

Diretriz de Felipe (22/10/2026): "coloque o limite bem alto de pessoas ao mesmo tempo. Não quero que o usuário tenha que esperar." Uso legítimo nunca é bloqueado, mesmo em pico e com muita gente da mesma empresa na mesma rede. A proteção fica concentrada em quem erra a senha repetidamente.

## O que estava errado

- **X-1.** A rota `app/api/admin/autenticacao/route.ts` chamava `loginAdmin(..., ip = null, ...)`. O serviço trocava `null` pela chave única `ORIGEM_NAO_VERIFICADA`. Resultado: 30 tentativas a cada 300 s valiam para a aplicação inteira, contando sucesso e falha. A 31ª pessoa recebia 429 por 300 s. O `FOR UPDATE` nessa linha única, mantido durante o scrypt, ainda serializava todos os logins.
- **X-2.** O pool tinha `max` 10 e espera de 5 s. Cada login segurava uma conexão durante o scrypt, inclusive na fila do semáforo de 2 scrypts. Com 0,5 CPU, o pool esgotava.
- **X-3.** `fail()` devolvia 500 genérico sem log. O controle positivo desta tarefa reproduziu a causa provável: com a base, 35 de 50 logins simultâneos terminaram em `timeout exceeded when trying to connect` (pool esgotado).

## Decisão: IP confiável no Render

Fonte única: `lib/http/origem-cliente.ts` (`origemConfiavel`). `lib/acessos/http.ts` (`ipDaRequisicao`) delega para ela.

- No Render, a requisição passa pela borda (Cloudflare) e pelo balanceador do Render. Os dois **acrescentam** valores ao `X-Forwarded-For` e nenhum limpa o que o cliente mandou. Isso consta na documentação da Cloudflare ("append") e num teste de usuário publicado no fórum de feedback do Render em 03/2024. O começo da lista é, portanto, forjável. A origem confiável é o **último** valor, a mesma regra que o repositório já usava para convites, recuperação e cadastro.
- **Novo:** o último valor só vale se for um **endereço público**. Um endereço privado, de loopback, CGNAT ou reservado no fim indicaria um salto interno acrescentado depois do cliente. Usá-lo juntaria todos os clientes numa chave só, o mesmo defeito do X-1. Nesse caso a origem fica `null`.
- `True-Client-IP` e `CF-Connecting-IP` **não decidem**. A Cloudflare só garante `True-Client-IP` com uma transformação gerenciada ligada ("sem ela, o valor pode ser forjado"), e o Render não documenta nenhum dos dois. Eles servem apenas ao diagnóstico.
- **Diagnóstico sem endereço** (`registrarFormatoDaOrigem`): no primeiro login de cada processo, e em todo login cuja origem seja recusada no Render, o log recebe uma linha `[origem] ...`. Ela mostra quantos valores há no XFF, se o último é público e se `True-Client-IP` e `CF-Connecting-IP` concordam com ele. **Pendência de homologação:** depois do deploy em staging (com autorização), leia essa linha. Se aparecer `ultimo: "nao-publico"` ou `trueClientIp: "outra-posicao"` de forma consistente, o Render mudou a topologia e a regra precisa ser revista. Até lá, o login segue protegido pelo limite por conta.
- IPv6 é agrupado por **/64** na chave do limite de login. Sem isso, quem tem um /64 trocaria de endereço a cada tentativa.
- Falsificação testada: XFF com o IP da empresa no começo, mais `True-Client-IP` forjado → a chave é o IP real do fim (`lib/http/origem-cliente.test.ts` e a suíte PG).

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
- **Atenção: no Render vale a variável de ambiente.** `render.yaml` (staging) e o env de produção definem `DATABASE_POOL_MAX=10` e `DATABASE_CONNECTION_TIMEOUT_MS=5000`. O `render.yaml` local passou a 30/10000, mas **nada foi aplicado**. Trocar o env nos serviços exige autorização de Felipe e reinicia o serviço.
- **O pool não substitui CPU.** Com a CPU saturada (0,5 CPU, scrypt de ~128 MiB e CPU alta), mais conexões só mudam a espera de lugar, do pool para o processador. A correção do login tira o scrypt de dentro da conexão, e isso resolve o esgotamento causado pelo login. A latência com 40–50 pessoas ativas continua dependendo da CPU. O upgrade do plano é decisão separada de Felipe.

## Logs do 500 (X-3)

`fail()` passa a registrar a causa de qualquer 500 no log, nunca na resposta. A linha `[autenticacao] falha não tratada {...}` traz nome, código do driver e mensagem curta, com e-mails trocados por `<email>`. JSON inválido no corpo agora responde 400, não 500.

## Outros usos de `ORIGEM_NAO_VERIFICADA` (verificados, não alterados)

Esses fluxos recebem `ctx.ip` de `ipDaRequisicao`. No Render, o IP é conhecido, e cada IP tem a própria chave. A chave global só aparece fora do Render ou com topologia inesperada, e nesse caso a regra nova (último valor não público → `null`) equivale ao comportamento anterior: um salto interno como chave já era compartilhado por todos.

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

- Se o Render passar a acrescentar um salto **público** (por exemplo, um IP da Cloudflare) depois do cliente, a chave vira por ponto de presença. Sinal no log: `trueClientIp: "outra-posicao"`. O efeito seria um limite compartilhado, mas alto (300 falhas, sucessos não contam). Ação: rever a regra com a linha de diagnóstico.
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
