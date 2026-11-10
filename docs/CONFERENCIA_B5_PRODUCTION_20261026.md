# Conferência somente leitura de production (B-5, 26/10/2026)

Estado: **implementação LOCAL**, sem commit. Clone `kidmais-manager-conferencia-b5-production-20261026`, branch `codex/conferencia-b5-production-20261026`, sobre staging `58c54518bed2fa6ef904e5da7a16468180df114d` (#241). Nada foi colado em nenhum Shell, nenhum banco foi consultado e o Asaas não foi chamado. Este documento não autoriza execução.

Origem: B-5 do plano de promoção (`PLANO_PROMOCAO_PRODUCTION_20261025.md`, §7.2, E1 e §12; rodadas 10–13: a E2c também usa o B-5 para ver a 091 no artefato antigo).

## B-29 na opção (c) de D-ESC-8 (09/11/2026): modo E5b depois do E3

Estado: **implementação LOCAL**, sem commit. Clone `kidmais-manager-b5-pos-e3-20261109`, branch `codex/b5-pos-e3-20261109`, sobre staging `afeef387` (#377, B-5 ampliado LIVE em staging). Fonte: plano de promoção rodada 43 (D-ESC-8 = (c), decidida por Felipe em 09/11: a 118 entra na E6, do artefato `M`, depois da 100 e antes da 091). Nenhum Shell, banco real, env ou production foi tocado.

- **Lacuna.** A E5b roda a E2c-RECONFERIR com o B-5 depois do E3. Os dois modos antigos usam o prefixo de antes do E3, então, com 089, 092 e 093 aplicadas, davam sempre `PREFIXO_DIVERGENTE 089/092/093:completa (esperado ausente)`, isto é, PARAR. Confirmado no PostgreSQL descartável: era a única divergência.
- **Modo novo `--conferir-b5-estado-pos-e3` (E5b).** Mesmo conteúdo do modo estado (identidade, estados 089–118, combinados B-21 e matriz; 091 e 094 têm de estar ausentes; não lê documentos, Fundador nem o Asaas; não exige o ramo do provedor). Só muda o prefixo esperado: `ESPERADO_BASE_POS_E3` = o de antes do E3 com **089, 092 e 093 `completa`** (091, 094–097 `ausente`, 099 `completa`, 100 `sem_094`). A faixa 102–118 é a mesma de antes do E3: na opção (c) a **118 continua `ausente`** até a E6; presente, parcial ou ilegível = PARAR. A 114 continua `ausente` com o par de corpos 019/062 (a 092/093 não regravam esses corpos; provado em PG).
- **E1 e E2c não mudam.** O prefixo é escolhido por modo (`PREFIXOS`); `estados()` usa o de antes do E3 se nada for passado.
- **Bloco.** `CONFERIR-B5-ESTADO-POS-E3` (etapa E5b), com o mesmo carregador e as mesmas partes dos outros curtos.
- **Fora do escopo.** Depois da E6, a 118 `completa` é conferida pelo CONFERIR do próprio aplicador B-28, não pelo B-5. As outras opções de D-ESC-8 (a, b, d) continuam sem modo: o B-5 recusa qualquer prefixo que não seja um dos três.

Validação local (09/11): agregador 43/43 (4 testes novos), blocos em Git Bash 13/13 (a rodada completa deu 12/13: a contagem de blocos do `TODOS` estava fixa em `N + 4`; passou a `N + CURTOS.length + 1` e o teste foi repetido sozinho, 1/1), ESLint; sonda PG 18 descartável (`E:/kidmais-pg-descartavel/b5-pos-e3-20261109`, porta 55791) 9 execuções, nenhuma fora de READ ONLY e nenhuma escrita: antes do E3 (E2c 0, E5b 3 só pelas três do E3), depois do E3 (E5b 0, E2c e E1 3 só pelas três), depois do E3 + 118 (E5b 3, `118:presente`), + 094 (E5b 3), + 091 (E5b 3), E3 sem a 093 (E5b 3). 16 mutantes em cópia isolada, 16 mortos. Revisão do Astra (10/11): aprovado com 1 P3, porque faltava um cenário negativo da matriz no E5b (o mutante "E5b ignora a matriz" sobrevivia). Acrescentado o caso `MATRIZ_VAZIA_COM_LINHAS` (empresa_assinaturas 1, assinatura_avisos 7) no teste do E5b. Agregador 43/43, ESLint 0, 17 mutantes (P17 novo), 17 mortos. Evidências em `ambientes-locais/b5-pos-e3-20261109/`.

## B-5 ampliado (08/11/2026) — prevalece sobre o texto abaixo

Estado: **implementação LOCAL**, sem commit. Clone `kidmais-manager-b5-ampliado-20261108`, branch `codex/b5-ampliado-20261108`, sobre staging `9691392c`. Fonte: plano de promoção rodada 34, §9.2.2 (G-VAZIO), §9.2.4 (L1) e §9.2.7 (B-5 ampliado + B-15 reescopado). Nenhum Shell, banco real, Asaas, env ou production foi tocado. Onde as seções antigas deste documento falam em leitura do Asaas, valem as regras abaixo.

- **Sem provedor.** O agregador não lê nenhuma `ASAAS_*` (só a lista fechada `ENV_LIDAS`), não faz `fetch` e não tem caminho de GET. `criarLeitorAsaas`, `primeiraRenovacaoRegular` e os códigos `ASAAS_*` saíram. Isso fecha a lacuna do Astra de 07/11 (o leitor validava `ASAAS_AMBIENTE`/`ASAAS_API_KEY` antes de saber se havia concessão). O bloco E1 ainda retira as `ASAAS_*` do ambiente do node (`env -u`), como defesa em profundidade.
- **Ramo do provedor declarado.** O E1 exige `KIDMAIS_B5_RAMO_PROVEDOR=sem-conta|com-conta` antes de conectar (`RAMO_PROVEDOR_NAO_DECLARADO`, código 1). Há um bloco por ramo, `CONFERIR-B5-COM-CONTA` e `CONFERIR-B5-SEM-CONTA`, com o ramo escrito no cabeçalho; cola-se só o que o registro separado da §9.2.2 confirmar (a referência é COM-CONTA, porque a conta Asaas Demerzel existe). A declaração não substitui a leitura dos rótulos L1 no web e nos crons. A saída registra `provedor.conferencia = SEPARADA (§9.2.2)`, com conferência por painel ou GET com autorização própria e a chave fora do web. `chaveAsaasLida: false` e `consultasAsaas: 0`.
- **Fundador.** O B-5 conta as concessões `CONFIRMADA`. Com zero, a parte fica vazia (`SEM_CONCESSAO_CONFIRMADA`) e nada mais é lido. Com uma ou mais, o ramo é COM-DADOS e o resultado é PARAR (`FUNDADOR_CONFIRMADAS_RAMO_COM_DADOS`), com as datas só dos registros de `assinatura_renovacoes`, sem provedor. Os prazos D-COM-5 (−47, −33, −30) continuam calculados.
- **Estados 102–118.** A conferência usa os núcleos dos aplicadores 102-103, 104-106, 105, 107-108, 109, 112, 114, 116 e 117, e a 118 é conferida pelo catálogo (2 tabelas, 3 funções e 2 gatilhos). 110, 111, 113 e 115 não existem na árvore. O prefixo esperado antes do E3 é: base 088, mais 099 e 105 `completa`; 089–097 `ausente`, 100 `sem_094`, o resto `ausente`, e a 108 `AUSENTE` pelo B-21 (24 entradas, conferidas também na faixa 089–100 desde a rodada 2). Qualquer outra coisa dá `PREFIXO_DIVERGENTE`, que é PARAR, no E1 e no E2c.
  - A 109 usa a capacidade do contrato TS `lib/assinatura/renovacao-schema.ts`, conferido por sha256 (`n109.CONTRATO`) e importado com `--experimental-strip-types`. Roda em transação READ ONLY própria, com `search_path` fixo.
  - A 114: em production os corpos são de antes da 092/100, e o núcleo dá `divergente`. Desde a rodada 2, o B-5 só converte para `ausente` quando não há função nem hash de exigir da 114 **e** o par de corpos é exatamente o comprovado para o prefixo: lock da 019 (`eb5f187f…`) e revisão da 062 (`830dd6a3…`); nenhuma migration entre a 062 e a 094 regrava a revisão. Corpos ausentes, desconhecidos ou misturados ficam `divergente`; o par de staging (revisão da 098/108) sem a 114 fica `ausente_par_de_staging`. Os dois param.
  - A 108 vem do B-21. O valor do núcleo 107-108 fica em `nucleo108`, como diagnóstico. Achado: com a 114 aplicada, `classificar108` dá PARCIAL, enquanto o B-21 dá NOVA (provado em PG). Consequência fora do B-5: o aplicador 107–108 de staging, depois da 114, recusa o `CONFERIR` com `APLICACAO_PARCIAL_108`. Fica como pendência do B-20 (alinhar `classificar108` ao B-21 ou documentar a recusa); o B-5 não muda o aplicador.
- **Matriz §9.2.2 por contagens.** São 28 objetos numa única transação `REPEATABLE READ READ ONLY`: catálogo, papel e `count(*)`. Param o resultado: obrigatória ausente, fora do escopo presente (116), objeto que não é tabela, falta de privilégio de leitura, RLS que pode induzir zero (exceto com superusuário ou BYPASSRLS), linha em grupo VAZIA, exceção vigente não terminal, continuidade não concluída e `cadastros_empresas` com linha (explicação P1). Se algo estiver ilegível, o resultado é FALHA, nunca zero. O veredito G-VAZIO **não** é emitido aqui (é do conferidor B-26).
- **B-15 reescopado (§9.2.7).** Inventário legado com DV e `foraDoFormato091`; com a 091 ausente, legado fora do formato dos CHECKs novos é PARAR (`B15_091_CHECK_FALHARIA`). Rótulo `VAZIO` ⇒ prova artificial `NAO_APLICAVEL_SE_G_VAZIO_P1` (condicionada ao veredito do B-26; não é prova geral), ou `INDETERMINADA` se a própria matriz parou. Compatibilidade estrutural da 091: o espelho literal do precheck (6 tabelas, 5 CHECKs por nome, objetos da 091: `PASSARIA`/`FALHARIA`) e, desde a rodada 2, cada CHECK conferido na **sua** relação de `public`, validado, na coluna certa, com a definição da base (padrão de 14 posições, sem o de 11 dígitos; qualificação sem `TITULAR_PF`) e sem homônimo noutra relação (`checksDaBasePorRelacao`, `B15_091_CHECK_BASE_DIVERGENTE`). Origens futuras (`cadastros_empresas`, `solicitacoes_acesso_empresa` e `plataforma_empresas_cadastro`, consultas qualificadas `public.`) só são lidas depois de conferidos presença, privilégio e RLS (`B15_ORIGENS_AUSENTES`, `B15_ORIGEM_SEM_PRIVILEGIO_LEITURA`, `B15_ORIGEM_RLS_PODE_INDUZIR_ZERO`); depois, contagem de nulos, fora do formato (PARAR) e DV inválido. Ficam fora e declarados em `naoCoberto`: preservação do APLICAR, COMMIT e down da 091, LOCK sob carga, D-OP-4, e que `PASSARIA` não prova o APLICAR inteiro.
- **Lotes de crédito (§9.2.2).** Com a tabela presente, `ia_credito_lotes` sai com a origem aberta: `origemCompra`, `origemFranquia`, `origemCortesia`, `origemLegado` (valores do CHECK da 095) e `comPedido`. Linha no grupo continua sendo PARAR.
- **118.** Os gatilhos só contam nas duas tabelas da 118 (`tgrelid`); um gatilho homônimo noutra tabela não conta.
- **Blocos.** São 28 arquivos (agregador, estrutura da 105, trava do B-1, 18 núcleos, 4 módulos da 107/108, 2 arquivos do contrato da 109 e a integridade de catálogo da 105) em **11 partes** (carga por parte 31 KB; desde a rodada 8, maior bloco 34,5 KB, teto 36 KB), com primeiro encaixe, mais `CONFERIR-B5-COM-CONTA`, `CONFERIR-B5-SEM-CONTA`, `CONFERIR-B5-ESTADO` e `LIMPEZA`.
- **Códigos.** 2 = FALHA (consulta ou leitura impossível, catálogo ilegível); 3 = PARAR (estado detectado: prefixo, matriz, B-15, Fundador). Tipo, privilégio e RLS detectados são PARAR; erro de consulta é FALHA.

Validação local (08/11): `conferencia-b5-producao.test.cjs` 24/24 com dublês, incluindo um Proxy de ambiente que falha ao ler `ASAAS_*` ou ao enumerar o ambiente e um `fetch` espião. 18 mutantes em cópia isolada, 18 mortos. Sonda no PostgreSQL 18 descartável (`E:/kidmais-pg-descartavel/b5-ampliado`): 7/7 cenários, todos sem consulta fora de READ ONLY e sem verbo de escrita. Os cenários foram: base de production E1/E2c CONFERIDO; sem a 105; cadeia 109+112/116/117/118; staging até a 118; sobras com RLS e papel; sem privilégio. Também passaram a suíte dos blocos em Git Bash real e o ESLint. Evidências estão em `ambientes-locais/b5-ampliado-20261108/`.

Limites: não houve execução em staging nem em production. O G-VAZIO e a auditoria por marcadores ficam com o B-26. A conferência do provedor fica separada e é de Felipe. Com o ramo COM-DADOS, o resultado é só PARAR; a entrega própria fica para depois. O plano r34 não lista a 118: o B-5 a confere por catálogo e espera `ausente`, o que fica como achado para o Astra e o plano.

### Rodada 2 (08/11) — correção do parecer r1 do Astra (REPROVADO, 2 P1)

- **P1 prefixo:** a r1 aceitava 099 ausente e 090 instalada com tabela vazia. Agora `ESPERADO_BASE_ANTES_DO_E3` (089–097 ausentes, 099 completa, 100 `sem_094`) é conferido nos dois modos, antes das ampliadas.
- **P1 114:** a exceção agora exige o par comprovado (019 + 062), lido igual no catálogo real da base (sonda `par-114-da-base`).
- **P2-C (118), P2-D (bloco por ramo), P2-E (origem dos lotes), P2-F (CHECKs por relação, visibilidade das origens, rótulo condicionado, legado fora do formato):** corrigidos como descrito acima. **P2-B** (aplicador 107–108 de staging depois da 114) fica como pendência do B-20.
- **P3:** o texto do E1 no plano r34 ainda menciona GET e 5 partes; o plano não é editado por esta entrega (o E1 válido é o deste documento: sem GET, as partes do pacote gerado (11 desde a rodada 3), bloco do ramo).
- Validação: agregador 28/28; blocos em Git Bash; 31 mutantes em cópia isolada; sonda PG 18 descartável 13/13 (cenários novos: `base-sem-099` E1/E2c, `base-com-090-vazia` E1/E2c, `check-homonimo-e-gatilho-118-alheio`, par da 114 e CHECKs por relação `CONFORME` na base real). Cluster removido ao final.

### Rodada 3 (08/11) — correção do parecer r2 do Astra (REPROVADO, 1 P1 novo)

- **A · P1 — 105 incompleta passava.** O núcleo classifica a 105 `completa` por presença. Desde a r3, com `completa`, o B-5 roda nos dois modos a integridade **somente de catálogo** do próprio aplicador (`database/checks/20261027_105_integridade.sql`, conferida pelo sha256 de `ETAPAS`): colunas e restrições por tabela, os 11 índices com `mcp_oauth_concessoes_ativa_uk` único e parcial, corpo da função, gatilho na relação certa. Exige também esse índice `indisvalid`, `indisready` e `indislive`. Qualquer falta vira `105: incompleta` ⇒ `PREFIXO_DIVERGENTE` (PARAR). O arquivo entra no pacote dos blocos (27 arquivos).
  - Achado da sonda: nos modelos que a receita monta do checkout em CRLF, o `prosrc` da função da 105 tem CR, e a integridade do aplicador (que não remove CR) dá falso. Sem CR, o hash é o esperado (`71cd3496…`). Em production a 105 foi aplicada pelo aplicador, em LF; se não tiver sido, o B-5 para, como o `CONFERIR` do aplicador.
- **C · P2 — CHECKs por definição integral.** `pg_get_constraintdef(oid, false)` sob `search_path` fixo, comparada por igualdade com as referências do agregador. Na sonda, as definições do catálogo da base (PG 18) são exatamente essas referências. Servidor de outra versão maior ⇒ `B15_091_DEFINICAO_SEM_REFERENCIA_PG` (PARAR). Negar a regex (`!~`), `~*`, `AND` no lugar de `OR` ou um quarto valor de qualificação ⇒ `DIVERGENTE`, mesmo com o espelho literal `PASSARIA`. A E2c continua sem o B-15: `091: ausente` na E2c só prova a ausência das sentinelas da 091.
- **F · P2 — RLS.** A matriz não conta relação com RLS sem bypass (`linhas: null`, `contagem: INDETERMINADA_RLS`). O legado do B-15 (`empresa_assinaturas`, `assinatura_fundadores`) e o Fundador (`assinatura_fundadores`, `assinatura_contratacoes`, `empresa_assinaturas` e, se instalada, `assinatura_renovacoes`) passam pela mesma guarda de presença, privilégio e RLS das origens. Com falta, nada daquela parte é lido; a parte fica `INDETERMINADO` e há parada nomeada (`B15_LEGADO_*`, `FUNDADOR_*`), nunca zero nem erro genérico.
- **B, D, E:** B fechado. D: os dois blocos atendem; a L1 segue por rótulo no web e em cada cron; a linha do E1 da r34 precisa ser alinhada no plano (fora desta entrega). E: P2-B aceito como pendência do B-20.
- Validação: agregador 31/31; blocos em Git Bash; 40 mutantes (M32–M40 novos); sonda PG 18 descartável 19/19 (novos: `105-sem-indice-unico-parcial` e `105-gatilho-em-outra-relacao` em E1/E2c, `check-negado-e-lista-ampliada`, definições da base, RLS no legado e no Fundador sem leitura). Cluster removido ao final.

### Rodada 4 (08/11) — correção do parecer r3 do Astra (REPROVADO, 2 P1 + 1 P2 + 1 P3)

- **A · P1 — 105 pela definição.** A integridade herdada do aplicador continua, e agora roda na **mesma fotografia** (`REPEATABLE READ READ ONLY`, `search_path = public, pg_catalog`) de uma consulta estrutural positiva: `pg_get_indexdef` de `mcp_oauth_concessoes_ativa_uk` igual, por inteiro, à definição da migration (chaves `usuario_id, empresa_id, client_id` e `WHERE (revogada_em IS NULL)`), com o índice único, válido, pronto, vivo, imediato e na relação certa; **um único** gatilho com o nome, com `pg_get_triggerdef(oid, false)` igual à definição (sem `WHEN`, sem `UPDATE OF`), `tgqual` nulo, habilitado, `tgtype` 19, sem argumentos, e `tgfoid` igual ao OID de `to_regprocedure('public.mcp_oauth_concessao_revogacao_imutavel()')`, a função de `public` cujo corpo (`71cd3496…`), linguagem `plpgsql`, retorno `trigger` e `SECURITY INVOKER` são conferidos na mesma linha. Qualquer diferença ⇒ `105: incompleta` ⇒ `PREFIXO_DIVERGENTE`. As demais ampliadas fora do prefixo continuam só com a sentinela de presença (a integridade de cada instalação fica com o aplicador).
- **C · P1 — sentinela da 103 sob RLS.** Antes de ler a linha `SERVICOS`, `adicional_categorias` passa pela guarda de presença, tipo, SELECT e RLS. Com falta, nada é lido, a 103 fica `indeterminada` e a parada é nomeada (`M103_*` + `PREFIXO_DIVERGENTE 103:indeterminada`), nunca `103: ausente`.
- **C · P2 — Fundador qualificado e tipo de relação.** Todas as consultas do Fundador (total, concessões, JOINs e a subconsulta de renovação) usam `public.`. A guarda comum (legado, origens, Fundador, 103) também exige tabela (`relkind` `r` ou `p`): view, view materializada ou outra coisa ⇒ `*_NAO_E_TABELA` (PARAR). Quando só `assinatura_renovacoes` falha, o rótulo diz o que foi lido: o total, sem as datas.
- **Residual declarado.** Guardas de visibilidade e leituras do legado, das origens e do Fundador são transações separadas: o B-5 pressupõe catálogo estável durante a conferência (janela sem DDL). A 105 é a exceção, pois integridade e estrutura estão na mesma fotografia.
- **P3 — roteiro do E1 na r34.** Continua desatualizado (cinco partes, `CONFERIR-B5`, GET no Asaas). O texto do plano não é editado nesta entrega; alinhar na próxima rodada documental antes da janela.
- Validação: agregador 34/34; blocos em Git Bash; 48 mutantes (M41–M48 novos, M33 reancorado); sonda PG 18 descartável com as definições reais do índice e do gatilho da base e os controles `105-indice-predicado-invertido`, `105-indice-chaves-trocadas`, `105-gatilho-funcao-homonima`, `105-gatilho-com-when` e `103-oculta-por-rls`, cada um em E1 e E2c. Cluster removido ao final.

### Rodada 5 (08/11) — correção do parecer r4 do Astra (REPROVADO, 1 P1 + 1 P2 + 1 P3)

- **A · P1 — identidade anulável na 105.** O gatilho compara a identidade com `<>`, e `NULL` escapa a essa comparação. Na mesma fotografia da integridade e da estrutura, o B-5 exige agora o conjunto **exato** de colunas `NOT NULL` de `mcp_oauth_concessoes`, igual ao da migration (`NAO_NULAS_105`: `client_id, cliente_nome, criada_em, empresa_id, escopos, id, recurso, redirect_uri, usuario_id`). No PG 18+, só conta o `NOT NULL` validado (`pg_constraint` com `contype = 'n'` e `convalidated`). `DROP NOT NULL`, `NOT NULL NOT VALID`, coluna a menos ou a mais ⇒ `105: incompleta` ⇒ `PREFIXO_DIVERGENTE`. **Lacuna registrada para o aplicador da 105**: a integridade herdada por contagens também não vê a nulabilidade. A correção do aplicador fica fora desta entrega.
- **B · P2 — 103 no primeiro retrato.** A guarda da 103 roda sempre. Quando o primeiro retrato já mostra falta de SELECT ou de dependência (`adicional_categorias` ou `adicionais`), o resultado é `103: indeterminada` com o motivo nomeado: `M103_SEM_PRIVILEGIO_LEITURA`, `M103_AUSENTES`, `M103_NAO_E_TABELA` ou, se os retratos discordarem, `M103_DEPENDENCIA_AUSENTE`. Não sai mais o `nao_lida` genérico. RLS em `adicionais` não afeta a sentinela.
- **Pacote:** o agregador codificado passou de 29 KB; a carga por parte subiu para 30 KB. Continuam 11 partes, e o maior bloco tem 33.515 bytes, abaixo do teto de 36 KB.
- **C:** fechado. O residual das transações separadas foi aceito pelo Astra para a janela controlada. **P3:** a linha do E1 da r34 continua para a revisão documental do plano.
- Validação:
  - agregador 36/36;
  - blocos em Git Bash;
  - mutantes com M42 reancorado e M49–M52 novos;
  - sonda PG 18 descartável com `105-empresa-id-anulavel`, `105-not-null-nao-validado`, `103-dependencia-ausente` e `103-sem-select-primeiro-retrato`, em E1 e E2c.

  O cluster foi removido ao final.

### Rodada 6 (08/11) — correção do parecer r5 do Astra (REPROVADO, 1 P1 + 2 P2 + 1 P3)

- **A · P1 — gatilho posterior na 105.** O PostgreSQL dispara os gatilhos BEFORE da mesma espécie em ordem alfabética, e cada um recebe o `NEW` do anterior. Um segundo gatilho pode, portanto, reescrever `empresa_id` depois da guarda. Na mesma fotografia, o B-5 exige agora:
  - exatamente **um** gatilho de usuário em `mcp_oauth_concessoes` (`gatilhos_relacao = 1`), qualquer que seja o evento: `BEFORE UPDATE` extra, `INSERT OR UPDATE` etc. Os gatilhos internos das FKs não entram na conta;
  - **nenhuma** regra (`pg_rewrite`) na relação. A migration não cria gatilho nem regra a mais, e nenhuma outra migration toca essa tabela.
- **A · P2 — NOT NULL extra não validado.** Um `NOT NULL … NOT VALID` em `revogada_em` já recusa gravações novas, mas ficava fora da lista validada. Além do conjunto validado da r5, o **conjunto declarado** (`attnotnull` ou qualquer restrição `n`, validada ou não) também tem de ser exatamente `NAO_NULAS_105`.
- **B · P2 — 103.**
  - O motivo do primeiro retrato é sempre preservado: `M103_DEPENDENCIA_AUSENTE` ou `M103_SEM_PRIVILEGIO_LEITURA adicional_categorias`. Os motivos do segundo retrato se somam, sem apagá-lo.
  - Presença e tipo de **ambas** as relações são conferidos sempre. Uma view estável em `public.adicionais`, que passa no `to_regclass` do núcleo, dá `M103_NAO_E_TABELA adicionais`.
  - SELECT e RLS continuam conferidos só em `adicional_categorias`, a relação lida.
- **Pacote:** 11 partes. O agregador codificado ocupa 29.948 dos 30.000 bytes da parte, e o maior bloco tem 33.836 bytes, abaixo do teto de 36 KB. A folga da parte é pequena: um próximo acréscimo ao agregador exige subir a carga ou dividir o arquivo.
- **P3:** a linha do E1 da r34 segue para a revisão documental do plano.
- **Validação:**
  - agregador 37/37;
  - blocos em Git Bash;
  - mutantes com M14 e M52 reancorados e M53–M57 novos;
  - sonda PG 18 descartável com `105-gatilho-posterior`, `105-gatilho-insert-or-update`, `105-regra-update`, `105-not-null-extra-nao-validado` e `103-adicionais-view-estavel`, em E1 e E2c.

  O cluster foi removido ao final.

### Rodada 7 (08/11) — correção do parecer r6 do Astra (REPROVADO, 1 P1 + 1 P3)

- **A · P1 — coluna gerada na 105.** O valor de uma coluna gerada armazenada é calculado **depois** dos gatilhos `BEFORE`. Assim, uma `empresa_id` gerada escaparia da guarda, mesmo com o índice, a FK e o NOT NULL recompostos. Em vez de checar só `attgenerated`, o B-5 exige agora a **impressão digital completa das colunas** de `mcp_oauth_concessoes`, na ordem de `attnum` e na mesma fotografia:
  - nome, tipo (`format_type`) e NOT NULL;
  - `GENERATED` e `IDENTITY`;
  - collation fora do padrão;
  - `DEFAULT` (`pg_get_expr`).

  A referência `COLUNAS_105` foi capturada do catálogo da base em PG 18 descartável. O teste confere que ela tem os nomes da migration, na ordem, sem coluna gerada, identity ou collation. Qualquer diferença deixa a 105 `incompleta`: coluna gerada, identity, default trocado, tipo, collation ou ordem.
- **B e C:** fechados no parecer r6.
- **P3:** a linha do E1 da r34 segue para a revisão documental do plano.
- **Pendência registrada para o aplicador da 105**, que confere por contagens: nulabilidade, gatilhos ou regras extras e a natureza das colunas.
- **Pacote:** o agregador codificado chegou a 30.698 bytes, e a carga por parte subiu para 31 KB. Continuam 11 partes, e o maior bloco tem 34.610 bytes, abaixo do teto de 36 KB. Um novo acréscimo exige dividir o agregador.
- **Validação:**
  - agregador 38/38;
  - blocos em Git Bash;
  - mutantes com M54 reancorado e M58–M60 novos;
  - sonda PG 18 descartável com `105-empresa-id-gerada` (coluna gerada armazenada, com índice, FK e NOT NULL recompostos) e `105-default-alterado`, em E1 e E2c.

  O cluster foi removido ao final.

### Rodada 8 (08/11) — correção do parecer r7 do Astra (REPROVADO, 1 P1 + 3 P2 + 1 P3)

- **P1 — herança e P2 — RLS forçada, CHECK trocado e configuração da função.** Em vez de fechar uma propriedade por rodada, o B-5 compara agora o **catálogo inteiro** de `mcp_oauth_concessoes` com a referência da migration (`SQL_RELACAO_105` × `RELACAO_105`, 55 linhas). A comparação roda na mesma fotografia `REPEATABLE READ READ ONLY`, depois de `SET LOCAL search_path = pg_catalog`. Assim, todo objeto fora de `pg_catalog` sai qualificado nas definições, e uma função, um tipo ou um operador homônimo em `public` muda o texto. A referência cobre:
  - a classe (tipo, persistência, método de acesso, RLS ligada e forçada, identidade de réplica, partição e opções);
  - a herança nos dois sentidos e as políticas, mesmo inativas;
  - todas as restrições pela definição integral: PK, 4 FKs com destino e ações, 6 CHECKs e 9 NOT NULL, com as flags validada, adiável, local, sem herança e aplicada;
  - todos os índices, com flags e definição;
  - todos os gatilhos: o de usuário pela definição e os internos das FKs (desta tabela e das que a referenciam) pela restrição, função e tipo, com ligado ou desligado;
  - as colunas, com tipo e `DEFAULT` qualificados;
  - a função da guarda: `proconfig` (inclusive `search_path`), `SECURITY DEFINER`, `STRICT`, volatilidade, paralelismo, tipo e `LEAKPROOF`.

  Ficam fora, por não alterarem o valor gravado: dono, ACL, estatísticas e armazenamento. A ordem usa `COLLATE "C"`. As listas de NOT NULL por nome também passaram a usar `COLLATE "C"`, para não depender da collation padrão do banco.
- **Pressuposto de ambiente (falha fechada):** o `DEFAULT` de `id` é `public.gen_random_uuid()` (pgcrypto em `public` na base). Um banco com a extensão em outro esquema daria `incompleta`, nunca falso aceite.
- **Pacote:** a estrutura da 105 foi para um módulo próprio, `scripts/conferencia-b5-105.cjs`, só com constantes e SQL de catálogo. São 28 arquivos em 11 partes. O agregador codificado caiu para 28.570 bytes (folga de 2.430 na parte de 31 KB), e o maior bloco tem 34.537 bytes, abaixo do teto de 36 KB.
- **P3:** a linha do E1 da r34 segue para a revisão documental do plano.
- **Pendência do aplicador da 105**, que confere por contagens: agora inclui herança, RLS e políticas, a definição das restrições e a configuração da função.
- **Validação:**
  - agregador 39/39, com teste novo nos dois modos: herança, política, RLS forçada, CHECK trocado, FK com outra ação, `proconfig`, gatilho de FK desligado, domínio homônimo, índice extra, linha a menos, vazio e `null`, além de ilegíveis;
  - blocos em Git Bash, com o módulo novo no pacote (`ARQUIVOS_OK 28`);
  - mutantes M61–M67 novos e M50, M58–M60 reancorados no módulo;
  - sonda PG 18 descartável com 10 cenários novos em E1 e E2c: `105-tabela-filha`, `105-tabela-pai`, `105-rls-forcada`, `105-politica-inativa`, `105-check-trocado`, `105-fk-acao-trocada`, `105-indice-extra`, `105-gatilhos-de-fk-desligados`, `105-funcao-search-path` e `105-dominio-homonimo`. O resultado foi `B5_AMPLIADO_PG_OK 73`, com 69 execuções, nenhuma consulta fora de READ ONLY e nenhum verbo de escrita. Os nove primeiros dão código 3 com `PREFIXO_DIVERGENTE 105:incompleta`. O domínio `public.text` também muda os casts `::text` de outras leituras: a 105 sai `incompleta`, com código 2 (`B15_CATALOGO_ILEGIVEL`) no E1 e código 3 no E2c. A falha é fechada nos dois modos, nunca com código 0.

  O cluster foi removido ao final.

### Rodada 9 (09/11) — correção do parecer r8 do Astra (REPROVADO, 1 P2 + 1 P3)

- **P2 — FKs de entrada.** As FKs de `mcp_oauth_codigos` e `mcp_oauth_tokens` apontam para concessões (`confrelid`) e ficavam fora da referência. Os gatilhos internos delas, instalados em concessões, só traziam o nome da restrição. Duas mudanças passavam com `105: completa` e código 0: a FK de códigos tornada `DEFERRABLE INITIALLY DEFERRED` e a FK de tokens refeita sobre `id` em vez de `concessao_id`. Isso muda o que pode ser excluído em concessões. Agora:
  - as restrições entram quando concessões é a origem **ou** o destino (`IN (k.conrelid, k.confrelid)`), com a relação de origem em cada linha;
  - os gatilhos internos trazem a relação e o nome da restrição, a outra relação (`tgconstrrelid`) e o adiamento (`tgdeferrable`, `tginitdeferred`).

  A referência passou de 55 para 57 linhas (as duas FKs de entrada) e foi recapturada da base no PG 18.6 descartável.
- **Alcance da afirmação:** "catálogo da relação" quer dizer exatamente o conjunto listado no módulo (classe, herança, políticas, restrições de saída e de entrada, índices, gatilhos desta relação, colunas e a função da guarda). Gatilhos e índices das tabelas de origem das FKs de entrada ficam fora. A igualdade das definições não é uma auditoria transitiva do corpo das funções, tipos e operadores de que elas dependem.
- **B (pressuposto do `DEFAULT` e domínio homônimo):** aceito no parecer r8.
- **P3:** a linha do E1 da r34 segue para a revisão documental do plano.
- **Pendência do aplicador da 105** (conferência por contagens): inclui também as FKs de entrada.
- **Pacote:** sem mudança de tamanho relevante. São 28 arquivos em 11 partes. O agregador tem 28.570 bytes com a reserva, o módulo 6.759, e o maior bloco 34.537 bytes.
- **Validação:**
  - agregador 39/39, com o teste da relação ampliado nos dois modos: FK de entrada adiável, com outra coluna de origem, gatilho interno com outra relação e FK de entrada ausente;
  - blocos em Git Bash;
  - mutantes M68 (sem as FKs de entrada), M69 (gatilho interno sem adiamento) e M70 (restrição sem a origem), com M65 reancorado;
  - sonda PG 18.6 descartável com `105-fk-entrada-adiavel`, `105-fk-entrada-outra-coluna` e `105-fk-entrada-removida`, todos com código 3 em E1 e E2c. O resultado foi `B5_AMPLIADO_PG_OK 79`, com 75 execuções, nenhuma consulta fora de READ ONLY e nenhuma escrita.

  O cluster foi removido ao final.

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
| `scripts/conferencia-b5-producao.cjs` | agregador somente leitura (plano, `--conferir-b5` para o E1, `--conferir-b5-estado` para a E2c, `--conferir-b5-estado-pos-e3` para a E5b desde 09/11) |
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
| `CONFERIR-B5-COM-CONTA` / `CONFERIR-B5-SEM-CONTA` | E1: monta e roda `--conferir-b5` com o ramo do bloco |
| `CONFERIR-B5-ESTADO` | E2c: monta e roda `--conferir-b5-estado` |
| `LIMPEZA` | remove só o que tem o sha esperado |

Tamanhos (rótulo `58c5451`, 11 arquivos): partes de 22,0 a 28,4 KB; curtos de 4,4 a 4,5 KB; LIMPEZA 4,1 KB. Na consolidação (rótulo `d894374`, 15 arquivos): 8 partes de 15,1 a 28,8 KB; curtos de 4,8 a 4,9 KB; LIMPEZA 4,4 KB.

## Uso (artefato de revisão — não executar sem autorização)

> **Bloqueio em production (B-27, 07/11/2026).** Na versão de 26/10, o modo E1 recusava sem `ASAAS_API_KEY`. O B-5 ampliado (08/11, LOCAL, seção acima) retirou toda leitura do Asaas: o E1 não lê `ASAAS_*` e declara o ramo do provedor. A chave deve seguir ausente em production; não instalar, nem por pouco tempo.
>
> Vale enquanto a dívida D-COBRANCA-LIVE estiver aberta, com qualquer dado no ambiente, chamado de "teste" ou não; a reabertura técnica da promoção não libera este caminho. Para sair do bloqueio é preciso o fechamento formal da dívida, a entrega própria de abertura da L2, R3 PASS imediatamente antes e autorização própria de Felipe para cada ativação. Com a dívida aberta, cada deploy, env, E9, E10 ou promoção seletiva ordinários em production exige R3 PASS antes da mudança; a única exceção é a recuperação contida (RC, §9.2.5).
>
> Referência: [plano de promoção, rodada 34, §9.2.6](PLANO_PROMOCAO_PRODUCTION_20261025.md#926-d-cobranca-live-gate-de-ativação); o plano é local e ainda não está versionado neste repositório. Esta nota não autoriza nada, não afirma estado atual de serviço ou variável e, nos passos de production sujeitos à dívida, prevalece sobre o texto abaixo. Não trata de staging nem de sandbox.

1. Gerar da árvore integrada final: `node scripts/bloco-shell-conferencia-b5-producao.cjs TODOS <commit> <pasta-nova>`. Conferir sha256 e bytes de cada bloco.
2. **E1** (A1; sem Asaas, ramo declarado pelo bloco escolhido): colar as 11 partes e depois o bloco do ramo confirmado pelo registro separado da §9.2.2 (`CONFERIR-B5-COM-CONTA` ou `CONFERIR-B5-SEM-CONTA`, nunca os dois). Copiar a saída JSON para as evidências. Com `PARAR`, seguir o plano: decisão D-COM-4 ou D-OP-4, conforme o motivo.
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
