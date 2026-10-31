# Conferência somente leitura de production (B-5, 26/10/2026)

Estado: **implementação LOCAL**, sem commit. Clone `kidmais-manager-conferencia-b5-production-20261026`, branch `codex/conferencia-b5-production-20261026`, sobre staging `58c54518bed2fa6ef904e5da7a16468180df114d` (#241). Nada foi colado em nenhum Shell, nenhum banco foi consultado e o Asaas não foi chamado. Este documento não autoriza execução.

Origem: B-5 do plano de promoção (`PLANO_PROMOCAO_PRODUCTION_20261025.md`, §7.2, E1 e §12; rodadas 10–13: a E2c também usa o B-5 para ver a 091 no artefato antigo).

## Decisão desta implementação

- **Data do Fundador pelo Asaas (Felipe, 26/10/2026).** A regra do código `primeiraRenovacaoRegular(primeiroVencimento, beneficioFim, ciclo)` precisa do primeiro vencimento, que é o `dueDate` da cobrança de confirmação no Asaas. O banco só guarda o id dela (`assinatura_fundadores.pagamento_confirmacao_id`). `assinatura_renovacoes.primeiro_vencimento` só existe quando a renovação já rodou, e ela nunca rodou em production (§7.2). Por isso o modo do E1 faz **um GET por concessão confirmada** em `https://api.asaas.com/v3/payments/{id}`, com a chave de produção do Shell, só leitura. **O plano precisa de rodada documental:** a autorização A1 ("Banco de production (leitura)") passa a incluir essa leitura do Asaas.

## Composição desta árvore

Os aplicadores aprovados vivem em clones próprios, sem commit. O B-5 reaproveita as funções de estado deles, então os três diffs foram aplicados no índice (staged). O B-5 é só o que está fora do índice:

| Origem | `git diff --binary` | Conferência |
| --- | --- | --- |
| B-1 (092–094) | `e88daa64…` | arquivos iguais ao clone aprovado |
| B-2 (099) | `f7832198…` | idem |
| B-3 (100) | `42c12cbd…` | idem |

Os três se aplicaram sem conflito sobre `58c54518`. Staging avançou desde a base do plano (`54598a92`/`a590d247`): #239 (concorrência da agenda), **#240 (renovação Fundador agendada = B-9)** e **#241 (migrations 102/103)**. O plano congelado não cobre 102/103 nem o B-9 já em staging; isso também pede rodada documental.

## O que o B-5 acrescenta

| Arquivo | Conteúdo |
| --- | --- |
| `scripts/conferencia-b5-producao.cjs` | agregador somente leitura (plano, `--conferir-b5` para o E1, `--conferir-b5-estado` para a E2c) |
| `scripts/conferencia-b5-producao.test.cjs` | 11 testes com cliente e Asaas simulados |
| `scripts/bloco-shell-conferencia-b5-producao.cjs` | gerador dos blocos de entrega (partes + carregador conferido) |
| `scripts/bloco-shell-conferencia-b5-producao.test.cjs` | 13 testes com bash real |
| `.github/workflows/ci.yml` | passo novo com as duas suítes |

### O agregador

- **Alvo e identidade:** os do B-1 (`migration-092-094-production.cjs`: serviço, TLS, banco, servidor privado), com nome de aplicação próprio. Toda consulta corre em `BEGIN TRANSACTION READ ONLY`, com `lock_timeout 5s` e `statement_timeout 30s` (60 s para os documentos). Nada é gravado no banco, no disco ou no Asaas.
- **Estados:** para 089, 090, 091, 092–094, 095, 096, 097, 099 e 100, roda o `SQL_ESTADO` e o `lerEstado` do **próprio núcleo do aplicador**: a mesma régua que o CONFERIR de cada um. A 098 não tem núcleo (aparece como `SEM_NUCLEO_VER_COMBINADOS`); o estado dela sai dos **combinados** (B-21, abaixo). Estado `parcial`, ilegível ou 100 `divergente` levam a **PARAR**. A saída lista os `presentes` (tudo o que não está no estado de partida).
- **Combinados (B-21, E1 e E2c):** prova somente leitura de que a 098 histórica não está em production. Roda o **mesmo SQL de catálogo** de `lerCatalogoCombinados` (`lib/agenda/estado-combinados.ts`; só `pg_proc`, `pg_attribute`, `pg_constraint` e `pg_trigger`, nenhuma linha de agenda) e classifica com a **mesma regra** de `classificarCombinados`. Só `AUSENTE` passa. `ANTIGA` (098 histórica), `PARCIAL` ou `NOVA` (108, fora desta promoção: reconciliar o escopo, D-ESC-6) levam a **PARAR**. Diferença deliberada em relação ao detector: sem linha, várias linhas ou tipos fora do esperado = `COMBINADOS_ILEGIVEIS` (PARAR), nunca `AUSENTE` por omissão. A saída traz `combinados.estado` e o catálogo (contagens, booleanos e hashes de corpo), a guardar na evidência ligada ao `C` e à janela.
- **B-15:** confere `empresa_assinaturas.documento_teste` e `assinatura_fundadores.documento_beneficiario`, as duas tabelas do gatilho de INSERT da 091, com a **mesma regra de DV da função da 091**. A saída traz só contagens: total, nulos, CPF de 11 dígitos, CNPJ de 14, outro formato, DV inválido, e empresas com DV inválido ainda sem concessão. Os documentos ficam apenas na memória do processo. DV inválido não para a conferência; marca `DECISAO_D_OP_4_NECESSARIA` (adiar a 091 é tratamento válido).
- **Fundador:** para **todas** as concessões confirmadas:
  - pega no banco a contratação confirmada, `beneficio_fim` (UTC, como o código), ciclo e identificadores do provedor;
  - lê a cobrança de confirmação no Asaas e exige a mesma identidade de `identidadePagamento` do código (id, assinatura, cliente e `dueDate` válido);
  - calcula `primeiraRenovacaoRegular`; um registro já existente em `assinatura_renovacoes` prevalece, como no código.

  A saída traz:
  - `menorPrimeiraDataRegular`;
  - `inicioJanelaAviso` (−33 dias, D-B9-5) e `limiteAviso` (−30);
  - `prazoB9` (**−47**: −33 da abertura da janela menos a margem de 14 dias; D-COM-5, decisão de Felipe de 27/10/2026);
  - `janelasPerdidas` e `janelasAbertas`;
  - contagens de cobertura e de divergência.

  **PARAR** em: cobertura incompleta, datas ausentes, prazo do B-9 vencido ou janela já perdida. A saída não tem ids, documentos, e-mails nem valores.
- **E2c (`--conferir-b5-estado`):** só identidade e estados, sem documentos nem Asaas. Para se a 091 ou a 094 não estiverem ausentes.
- **Códigos:** 0 CONFERIDO; 1 recusa antes de conectar (fora do Render, alvo, TLS, Asaas mal configurado no modo E1); 2 FALHA (conexão, identidade, consulta); 3 PARAR, com motivos nomeados.

### Os blocos

O desenho foi adaptado do gerador do B-4 na rodada 3 (`2296846f…`, ainda em revisão em outra sessão):
- carregador com o programa codificado e conferido por sha256; só o programa conferido imprime `CODIGO_SAIDA_BLOCO=0`;
- guarda de serviço repetida no corpo;
- destino físico conferido (`pwd -P`, sem link ou junção na pasta, nas subpastas ou nos arquivos);
- `T=` antes do trap, `builtin unset -v C T` na abertura e `trap ERR` com o motivo;
- partes de no máximo 40 KB.

Diferenças: só leitura (sem APLICAR, sem backup, sem marcador) e pasta própria `.kidmais-conferencia-b5-producao`. **Unificar os dois geradores depois do aceite do B-4 é pendência registrada.**

| Bloco | Faz |
| --- | --- |
| `PARTE-1-DE-8` … `PARTE-8-DE-8` | transportam os 15 arquivos (agregador, trava do B-1, os 9 núcleos e os 4 módulos da 107/108 que os núcleos carregam; consolidação sobre staging d8943742 — antes 11 em 5 partes) |
| `CONFERIR-B5` | E1: monta e roda `--conferir-b5` |
| `CONFERIR-B5-ESTADO` | E2c: monta e roda `--conferir-b5-estado` |
| `LIMPEZA` | remove só o que tem o sha esperado |

Tamanhos (rótulo `58c5451`, 11 arquivos): partes de 22,0 a 28,4 KB; curtos de 4,4 a 4,5 KB; LIMPEZA 4,1 KB. Na consolidação (rótulo `d894374`, 15 arquivos): 8 partes de 15,1 a 28,8 KB; curtos de 4,8 a 4,9 KB; LIMPEZA 4,4 KB.

## Uso (artefato de revisão — não executar sem autorização)

1. Gerar da árvore integrada final: `node scripts/bloco-shell-conferencia-b5-producao.cjs TODOS <commit> <pasta-nova>`. Conferir sha256 e bytes de cada bloco.
2. **E1** (A1, ampliada para o Asaas): colar as 5 partes e depois `CONFERIR-B5`. Copiar a saída JSON para as evidências. Com `PARAR`, seguir o plano: decisão D-COM-4 ou D-OP-4, conforme o motivo.
3. **E2c** (A2c): na instância live, depois do E2/E2b, colar as partes (se a pasta sumiu) e depois `CONFERIR-B5-ESTADO`.
4. `LIMPEZA` (opcional).

## Validação local (sem banco, sem Asaas e sem Shell real)

- `scripts/conferencia-b5-producao.test.cjs` 11/11, cobrindo:
  - DV igual ao do código (`cpfValido`, `cnpjFormatoDvOficial`) em 4 mil documentos sorteados, mais casos fixos (inclusive CNPJ alfanumérico) e trechos da função da 091;
  - datas iguais às de `renovacao-fundador.ts` (`primeiraRenovacaoRegular`, `diasAntes`, `dataValida`, `diaBrasil`, `AVISO_*`);
  - alvo e identidade de production, recusas antes de conectar e nenhum estado lido com identidade errada;
  - toda consulta em READ ONLY; os 9 núcleos carregados na ordem; a 098 sem núcleo; a saída sem ids, documentos, chave ou URL;
  - paradas por estado e regras da E2c;
  - contagens do B-15;
  - cobertura, registro existente, ANUAL/MENSAL e prazos do Fundador;
  - 13 casos de PARAR do Fundador;
  - Asaas só por GET, sem seguir redirecionamento, com id validado e erros sem a chave;
  - FALHA com ROLLBACK;
  - núcleos reais carregáveis.
- `scripts/bloco-shell-conferencia-b5-producao.test.cjs` 13/13, com Git Bash real (cerca de 7 min), cobrindo:
  - lista e tamanhos; carregador; guarda e guarda repetida; `pg` ausente; montagem só com todas as partes;
  - fluxo completo; pacote montado com os 9 núcleos carregados e plano offline real; conferências reais recusando fora do Render (código 1);
  - junções na pasta e nas subpastas, e `pwd -P` divergente;
  - arquivo divergente, inclusive sem as linhas `livre`; parte adulterada; carga corrompida ou trocada; parte que só grava depois de conferir todos os itens;
  - perda de cada linha de um curto, e perda de linhas de uma parte;
  - colagem truncada e interativa (0–3);
  - `T` exportado preservado, `C` somente leitura recusado e `BASH_ENV`;
  - `rm` falso; hashes; CLI `TODOS`.
- Suítes dos aplicadores nesta composição (089, 090, 091, 092–094, 095, 096, 097, 099 e 100, inclusive production e blocos): 178/178.
- 32 mutantes em cópia isolada (controles 11/11 e 13/13), todos derrubados. Dois sobreviveram à primeira bateria e levaram a testes novos: o registro existente ignorado (caso em que a data registrada é a menor) e o `T=` do corpo (o corpo rodado sem o carregador). Os mutantes cobrem regra de DV, ciclo ANUAL, margem do B-9, janela perdida, 091 na E2c, 098 consultada, consulta fora do READ ONLY, identidade, identidade da cobrança, cobertura, Asaas por POST ou seguindo redirecionamento, nulo contado como inválido, parcial sem parada, id na saída, datas ausentes sem parada, carregador sem sha, corpo sem guarda, `pwd -P`, `find` de links, `unset`, montagem sem todas as partes, LIMPEZA sem sha, núcleo da 099 fora da lista, modos trocados, `inst` sem reconferir e `BASH_ENV`.
- ESLint dos 4 arquivos sem erro; `git diff --check` limpo; `npm run check:v1:static` código 0 (3654 + 103 testes; 2 avisos de ESLint preexistentes; build compilado; `next-env.d.ts` restaurado).

## B-21: combinados no B-5 (31/10/2026)

Amplia o agregador sem bloco novo: os mesmos `CONFERIR-B5` (E1) e `CONFERIR-B5-ESTADO` (E2c) passam a classificar os salões combinados. O pacote de entrega já levava `migration-108-retrato.cjs` e as dependências dele, de onde vêm as constantes da 108. A lista de arquivos dos blocos não muda.

- **Paridade com a candidata:** um teste captura o SQL de `lerCatalogoCombinados` e exige o mesmo texto, byte a byte. O mesmo teste confere que o SQL só lê `pg_proc`, `pg_attribute`, `pg_constraint` e `pg_trigger`, sem verbo de escrita. A classificação é comparada com `classificarCombinados` numa matriz de 20.736 combinações, em que os 4 estados aparecem. O mapeamento da linha é comparado com o do detector, inclusive numa sonda com todos os campos distintos.
- **Paradas:** ANTIGA, PARCIAL e NOVA dão código 3, com motivo nomeado, nos dois modos. Os motivos dos combinados somam-se aos dos núcleos. Sem linha, mais de uma linha, contagem não inteira ou negativa, booleano de outro tipo ou hash que não seja string primitiva em `^[0-9a-f]{64}$` (array, Buffer ou objeto `String` também recusados) dão `COMBINADOS_ILEGIVEIS` (PARAR). Uma falha na consulta dá FALHA (código 2) com ROLLBACK.
- **Validação local:**
  - `conferencia-b5-producao.test.cjs`: 23/23.
  - `bloco-shell-conferencia-b5-producao.test.cjs`: 13/13.
  - 25 mutantes em cópia isolada, todos derrubados. Dois sobreviveram à primeira bateria e levaram a reforços do teste: `gatilhosOk` intermediário na matriz e a sonda de mapeamento.
  - Sonda em PostgreSQL 18.6 descartável local (nunca staging ou production), com os modelos da receita. Em cada um, o `combinados()` real do B-5, com o driver `pg` e a sequência exata `BEGIN TRANSACTION READ ONLY` → `SET LOCAL` ×2 → SQL → `ROLLBACK`, e o detector no mesmo banco dão o mesmo estado:

    | Modelo | Estado |
    | --- | --- |
    | 107 (sem a 098) | AUSENTE |
    | 098 (cadeia com a 098 histórica) | ANTIGA |
    | 108 | NOVA |
    | 107 com a coluna `combinado` solta | PARCIAL |
- **Não feito:** nenhuma execução em production. O E1 e a E2c com o B-21 dependem das autorizações A1/A2c, e os blocos de production só se geram depois de congelar `C`.

## Limites e pendências

- **Nenhuma execução real em production nem em staging:** nenhum banco real, nenhuma chamada ao Asaas, nenhuma colagem. Na validação original do B-5 (26/10) também não houve PostgreSQL algum; a única execução em PostgreSQL é a sonda do B-21, em cluster descartável local (seção acima).
  - O formato da resposta do Asaas (`id`, `dueDate`, `subscription`, `customer`, `status`, `deleted`) segue o mapeamento de `lib/assinatura/asaas.ts`, mas não foi exercitado contra a API.
  - O `lerEstado` real de cada núcleo contra o schema de production só se prova num ensaio isolado autorizado ou no próprio E1.
- **Rodada documental do plano necessária:**
  - A1 inclui a leitura do Asaas;
  - staging tem 102/103 e o B-9 (#240), fora do plano congelado;
  - decidir se o B-5 deve conferir 102/103.
- O gerador repete o desenho do B-4 (rodada 3); unificar depois do aceite.
- A margem de 14 dias do prazo do B-9 vem do plano; o B-9 já em staging usa uma janela de aviso de 33 a 30 dias, e ambos estão na saída.
- Revisão independente pendente.

## Revisão independente — rodada 1 (REPROVADO: 4 P2 + 1 P3) e correção

- **P2-1 — `papel_trocado` descartado:** todos os núcleos devolvem `papel_trocado` (`session_user <> current_user`), e o agregador agora o preserva na saída (`papelTrocado`).
  - Leitura ausente, ilegível ou diferente entre os núcleos: `PARAR PAPEL_TROCADO_ILEGIVEL_OU_INCONSISTENTE`.
  - Papel trocado só passa com previsão explícita do operador: `export KIDMAIS_B5_PAPEL_TROCADO_ESPERADO=sim` antes de colar, conforme o CONFERIR anterior de production. Sem ela, `PARAR PAPEL_TROCADO_INESPERADO`.
  - Previsão declarada e papel não trocado: `PARAR PAPEL_TROCADO_ESPERADO_MAS_AUSENTE`.
- **P2-2 — o tempo-limite do Asaas não cobria o corpo:** o prazo de 10 s vale para a chamada inteira, inclusive a leitura e a validação do corpo (corrida com o aborto). Cabeçalhos imediatos com corpo pendurado dão `ASAAS_TEMPO_ESGOTADO`, mesmo quando o `json()` ignora o sinal. Corpo inválido sem tempo esgotado dá `ASAAS_RESPOSTA_INVALIDA`.
- **P2-3 — o registro de renovação dependia do Asaas:** um registro válido em `assinatura_renovacoes` é resolvido antes, e o Asaas nem é chamado, como no código (que só consulta a cobrança `if (!r)`). Cobrança 404, timeout ou divergente não deixam mais a cobertura incompleta quando há registro. O campo `registroDivergente` saiu.
- **P2-4 — `dueDate` truncado:** vale só a string inteira de 10 caracteres, como no adaptador (`texto(o.dueDate, 10)` + `DATA`). Sufixo, timestamp, espaço, tipo errado e data inexistente contam como cobrança divergente.
- **P3 — sigilo das mensagens:** saem só mensagens nomeadas deste código (`MAIUSCULAS_COM_SUBLINHADO`, mais um complemento curto sem `@`, `:` ou URL). Qualquer outra vira `ERRO_INESPERADO`, com o SQLSTATE quando houver; `e.message` alheia nunca é repassada.
- **Regressões:** um teste por achado (conferência de 11 para 16). Mutantes novos derrubados: papel trocado sem parada, papel inconsistente aceito, tempo só até os cabeçalhos (o teste tem tempo-limite próprio), registro depois do Asaas, `dueDate` truncado e mensagem crua. Os 17 mutantes anteriores ainda aplicáveis continuam derrubados, e o controle dos blocos dá 13/13 com a conferência nova.
- **Ponto da revisão, sem mudança:** o prazo do B-9 em −44 segue o plano. Se a intenção for 14 dias antes da abertura da janela (−33), o prazo vira −47; isso precisa ser decidido e harmonizado nos documentos.
- Suítes depois da correção: conferência 16/16; blocos 13/13; aplicadores compostos 178/178; ESLint e `git diff --check` limpos; `npm run check:v1:static` repetido com código 0 (3654 + 103 testes; 2 avisos preexistentes; build compilado).

## Re-revisão — APROVADO COM RESSALVAS (4 P2 fechados; P3 parcial) e ajuste do P3

- P2-1, P2-2, P2-3 e P2-4 fechados (o revisor reproduziu as sondas da rodada 1). Observações sem achado: a previsão de papel trocado é uma declaração operacional e precisa estar vinculada à evidência do CONFERIR anterior de production; o `cancel()` do corpo, num erro HTTP, é disparado sem `await` (não bloqueia o retorno, mas a conclusão dele não fica garantida pelo prazo).
- **P3 — o filtro aceitava texto externo pelo formato:** as sondas `FALHA pay_SONDA_SINTETICA`, `ERRO 12345678901` e `CODIGO_INVENTADO` saíam inteiras. Correção: `CODIGOS_PUBLICOS` é uma **lista fechada** dos 18 códigos que o agregador e a trava de production do B-1 lançam, comparados por igualdade e sem complemento. Qualquer outra mensagem vira `ERRO_INESPERADO`, com `SQLSTATE` só quando `e.code` tem exatamente 5 caracteres `[0-9A-Z]`.
- **Regressão:**
  - as três sondas do revisor e variações (código conhecido com sufixo, espaço, quebra de linha, `ESTADO_ILEGIVEL 095`, `ASAAS_HTTP_404`) dão `ERRO_INESPERADO`;
  - `code` fora do formato não sai;
  - **bijeção**: os códigos realmente lançados pelas travas (sondados) são exatamente os da lista.
  - Mutantes novos derrubados: filtro por formato de volta, SQLSTATE sem validação e código a mais na lista. Os 24 anteriores continuam derrubados (27 no total, controle 17/17).
- Suítes depois do ajuste: conferência 17/17; blocos 13/13; aplicadores compostos 178/178; ESLint e `git diff --check` limpos; `npm run check:v1:static` código 0 (3654 + 103 testes; 2 avisos preexistentes; build compilado).
- Continua pendente antes de production: vincular a previsão de papel ao CONFERIR anterior; rodada documental do plano (A1/Asaas, 102/103, B-9, −44 × −47); gerar de novo e conferir os blocos da árvore final; autorização explícita da execução.

## Ajuste do prazo do B-9 para −47 (D-COM-5, 27/10/2026)

- Decisão de Felipe registrada na rodada 14 do plano (D-COM-5): a margem de 14 dias conta da abertura da janela de aviso (−33, D-B9-5). `prazoB9` passa de `diasAntes(menor, 30 + 14)` (−44) para `diasAntes(menor, 30 + 3 + 14)` (**−47**). `PRAZO_B9_VENCIDO` continua sendo `hoje > prazoB9`: no próprio dia −47 ainda não venceu.
- Testes: as asserções de prazo passam a −47, e há um teste novo de fronteira. Com data regular 2026-12-26 e hoje 2026-11-10, o −47 (2026-11-09) já venceu enquanto o −44 (2026-11-12) não teria vencido. Com 2026-12-27, o −47 cai exatamente hoje e não para. Conferência 18/18.
- Mutantes em cópia isolada (controle 18/18), todos derrubados: fórmula antiga (−44), margem zero, −46, `>=` no lugar de `>` e janela antecipada de 2 dias.
- Isso fecha a pendência "B-5 reportar −47" da rodada 14 do plano. A observação "−44 × −47" da re-revisão fica resolvida pela D-COM-5.
- Suítes depois do ajuste: blocos 13/13; aplicadores compostos 178/178; ESLint e `git diff --check` limpos; `npm run check:v1:static` código 0 (3654 + 103 testes; 2 avisos preexistentes; build compilado). Mudaram os blocos que carregam a conferência (PARTE-1, CONFERIR-B5, CONFERIR-B5-ESTADO, LIMPEZA).
