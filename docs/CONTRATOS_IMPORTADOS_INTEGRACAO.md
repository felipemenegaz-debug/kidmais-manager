# Contratos importados — integração ao Core e agenda por empresa (etapa 2)

Base: `origin/staging` em `6ee59c9` (merge da PR #90). Branch local: `feat/contratos-importados-integracao-20261002`.
Migrations novas: **061** (integração) e **062** (agenda por empresa e unidade). A 060 é da PR #80 (WhatsApp).

**Nada foi publicado nem commitado, e nenhum banco real foi tocado.** Em 03/10/2026, com autorização do Felipe, as
migrations e as suítes PostgreSQL rodaram **só** no cluster sintético `pg-descartavel-061` (127.0.0.1:55498), que foi
encerrado e removido depois (seção 10). A homologação não começou.

## 1. Situação

| Item | Estado |
|---|---|
| Integração de contrato histórico (festa, agenda, contas a receber, caixa) | Implementada localmente; atrás de `CONTRACT_IMPORT_INTEGRATION_ENABLED=false` |
| Agenda separada por **empresa** (062) | Implementada localmente; ainda **não** isola dados antigos sem escopo (seção 5) |
| Agenda separada por **unidade** | Implementada localmente pela **D6 = opção A** (seção 4): só unidade habilitada explicitamente |
| Integração disponível | Só com 061 **e** 062 aplicadas **e** a flag ligada |
| Testes com mocks | Executados (seção 11) |
| Testes com banco real | **35/35 execuções aprovadas** no cluster sintético (seção 11) |
| Homologação | Não iniciada |

**Não anunciar isolamento completo da agenda.** Enquanto houver os registros da seção 5, horários continuam
indisponíveis para todas as empresas (sem revelar quem ocupa).

Decisões do Felipe em vigor:

- Administrativo e Representante autorizado podem conferir.
- Contratos cancelados ficam consultáveis, sem integração operacional.
- Estornos históricos não são inventados.
- D1 (unidade é o recurso exclusivo), D2 (Unidade principal só por reparo explícito), D3 (dono de bloqueio só por
  decisão explícita) e D4 (agenda pública pelo contexto do servidor).
- D5: turnos por empresa ou unidade, preservando os horários já contratados.
- D6 = **opção A** (03/10/2026): habilitação explícita e auditada da unidade para agenda.

## 2. Fluxo e telas da integração

- **Importação** (`/admin/contratos/importar`), em etapas:
  1. Enviar o arquivo.
  2. Dados do contrato e cliente. O registro da importação **não anuncia sucesso**: a tela diz "Falta integrar ao
     sistema".
  3. Festa e agenda:
     - situação do contrato (cancelado ou não comprovado não avança);
     - unidade (só aparece se houver unidade elegível; hoje, nenhuma);
     - pacote de referência, data, horário e convidados.

     Valor diferente do documento é **correção de leitura** e exige motivo. Valor ausente no documento é
     **complemento**.
  4. Pagamentos:
     - situação: nada pago, parte paga, pago integralmente ou "ainda não conferi";
     - parcela recebida exige data efetiva e forma;
     - "à vista", "entrada" ou "30%" no documento **não comprovam pagamento**;
     - a soma é conferida em centavos.
  5. Revisão final. O resumo vem do servidor, e a confirmação exige a declaração de conferência do original em papel
     e **o mesmo hash** do resumo exibido.
- **Importação já existente:** botão "Integrar ao sistema", sem reenviar o arquivo. Não há backfill.
- **Depois da integração:**
  - o contrato mostra "Contrato histórico — assinado em papel";
  - pagamentos "não conferidos" viram a pendência "Conferir pagamentos";
  - links antigos `?importacaoId=` levam ao contrato integrado;
  - a projeção da etapa 1 some.
- **Edição posterior:** pelos serviços do Core. Remarcar ou revisar gera nova versão com assinatura da Kidmais e OTP
  do cliente.

## 3. Agenda por empresa (062): regras

O recurso de agenda é a **unidade**, quando houver unidade elegível; senão, a **empresa inteira**. Duas ocupações
conflitam no mesmo dia, com horários sobrepostos, no mesmo recurso:

```
kidmais062_mesmo_recurso(e1,u1,e2,u2) = (e1 IS NULL OR e2 IS NULL OR e1=e2) AND (u1 IS NULL OR u2 IS NULL OR u1=u2)
```

| Dado | Alcance |
|---|---|
| Contratação com empresa | Só a própria empresa (e a unidade, se houver) |
| Contratação **sem empresa** (legado) | **Todas as empresas** (seção 5) |
| Bloqueio com empresa | Só a empresa (e a unidade, se houver) |
| Bloqueio **sem empresa** (todos os existentes) | **Todas as empresas** até a decisão D3 (seção 5) |
| Revisão/remarcação | Herda empresa e unidade da contratação |

**O que a 062 muda:**

- Colunas de escopo em `fechamentos`, `bloqueios_agenda` e `configuracao_agenda`.
- `kidmais062_ocupacoes_escopo`.
- Quatro corpos substituídos com as **mesmas mensagens e gatilhos**: `kidmais019_validar_destino`,
  `kidmais019_validar_contrato`, `kidmais_proteger_bloqueio_revisao` e `kidmais_validar_agenda_revisao`.

**O que não muda:**

- `kidmais019_ocupa`, `kidmais019_formalizacao` (061) e `kidmais_ocupacoes_operacionais` (061) ficam intactas.
- Lock: o namespace por data (`kidmais:agenda:<data>`) é mantido. Ele é mais grosso que o recurso: empresas
  diferentes na mesma data **esperam** uma pela outra, mas nunca recebem erro de agenda por isso.

**Turnos (D5):** a ordem é unidade → empresa → modelos globais, sem misturar níveis. As linhas existentes viram modelos
globais, e os horários já contratados ficam preservados.

Usar turno próprio de empresa exige republicar as regras comerciais que apontam para os turnos. A validação comercial
aceita turnos globais e da própria empresa.

**Unidade da contratação:**

- preenchida pelo banco só quando a empresa tem exatamente **uma unidade elegível**;
- imutável depois de definida (trocar de unidade é uma nova contratação);
- o vínculo da integração precisa ter a mesma unidade da contratação.

## 4. Unidade na agenda: D6 = opção A (habilitação explícita)

**Por que não usar o status da unidade:** pela 043, todo estabelecimento nasce `SUSPENSO`, o status é imutável e
`ATIVO` está fechado (D03), sem coluna de motivo. `SUSPENSO` não distingue "ainda não aberta" de "suspensa por
motivo administrativo". Por isso o status **nunca** concede agenda.

**Regra única** (banco e servidor usam a mesma função, `kidmais062_unidade_agendavel`): a unidade é elegível quando
**todas** as condições valem:

- é da empresa e não está `DESATIVADO`;
- a empresa está `ATIVA`;
- existe **habilitação vigente** em `agenda_062_unidades_habilitacao`.

**Quem habilita e revoga:** o Representante autorizado (Gestão, 056) com membership ATIVA **nesta** empresa, sempre
com motivo (5 a 1000 caracteres).

- Servidor: `lib/disponibilidade/unidades-agenda.ts` e a rota `/api/admin/disponibilidade/unidades` (Tenant Context;
  o corpo só escolhe a unidade da própria empresa).
- Banco: a guarda confere de novo o operador, o papel gravado, a unidade e a empresa.
- Auditoria na mesma transação: `AGENDA_UNIDADE_HABILITADA` / `AGENDA_UNIDADE_REVOGADA`, com o motivo.
- Tela: seção "Unidades na agenda" no painel de Disponibilidade.
- **Nenhuma unidade existente é habilitada** pela migration nem por reparo.

**Histórico imutável:**

- no máximo uma habilitação vigente por unidade (índice único parcial);
- a única alteração permitida é a revogação, uma vez;
- habilitar de novo cria outra linha;
- `DELETE` e `TRUNCATE` são recusados;
- a guarda faz parte da estrutura e continua valendo num rollback suave.

**Suspensão administrativa = revogação (com motivo). Efeitos:**

| Situação | Depois da revogação |
|---|---|
| Reservas já gravadas na unidade | **Preservadas**: continuam na unidade e continuam ocupando o horário (ninguém mais reserva por cima) |
| Nova contratação, ou atribuir a unidade a uma contratação | Recusada |
| Alterar data ou horário de reserva da unidade (edição, remarcação, revisão com novo destino) | Recusada, até habilitar de novo ou fazer nova contratação em unidade habilitada |
| Correção sem mudança de agenda (tema, observações, buffet etc.), operações financeiras (conferência, recebimento) e cancelamento nativo | Permitidas (provado no banco: o cancelamento libera o horário; a unidade segue revogada) |
| Novo bloqueio ou turno na unidade | Recusado; bloqueio antigo pode ser desativado |
| Revogação concorrente com uma contratação na unidade | Quem grava trava a habilitação (`FOR SHARE`); a revogação espera e vale para tudo que vier depois |

A resposta da revogação informa quantas reservas futuras foram preservadas.

## 5. Dados antigos sem escopo (pendência operacional)

A 062 não atribui escopo a nada existente (sem backfill). Depois dela, **continuam bloqueando todas as empresas**:

1. **Contratações sem `empresa_id`** que ocupam agenda, inclusive com destino de remarcação.
   - São o legado anterior à 054 cujo pacote não tinha empresa.
   - Resolução: reparo próprio pela política de legado da 054 (empresa do pacote), com autorização.
2. **Bloqueios ativos sem `empresa_id`:** todos os existentes antes da 062 e os criados enquanto a 062 estiver
   removida.
   - Resolução D3: registrar o dono em `agenda_062_bloqueios_resolucao` (quem decidiu e motivo).
   - Depois, rodar `database/repairs/20261002_062_bloqueios_propriedade.sql`, que trava se faltar decisão para
     qualquer bloqueio.
   - O levantamento mostra as empresas do autor do bloqueio só como **indício**.
   - Pelo painel, uma empresa não consegue desativar um bloqueio sem dono, porque isso liberaria todas.

Também ficam com alcance de **empresa inteira** (isoladas entre empresas; dentro da empresa, valem para todas as
unidades até alguém atribuir unidade habilitada):

- contratações de empresa sem unidade (todas as anteriores à 062 e as de empresas sem unidade habilitada);
- bloqueios da empresa sem unidade.

**Como acompanhar:** `database/repairs/20261002_062_levantamento_agenda.sql` (somente leitura). As consultas "2. GLOBAL"
e "3. GLOBAL" listam nominalmente o que ainda bloqueia todas as empresas. Enquanto devolverem linhas, o isolamento não
está completo.

A API devolve só "disponível / indisponível". Não expõe evento, cliente, motivo ou dono.

## 6. Disponibilidade pública (D4)

- O contexto vem **só do servidor**: `AGENDA_PUBLICA_EMPRESA_ID` e, opcionalmente, `AGENDA_PUBLICA_UNIDADE_ID`.
  Nenhum parâmetro do navegador escolhe empresa ou unidade.
- **Com a 062:**
  - sem contexto: `503 AGENDA_PUBLICA_NAO_CONFIGURADA`, e a tela pública mostra que a consulta está indisponível;
  - contexto inválido (empresa inativa, UUID malformado ou unidade não elegível): `503 AGENDA_PUBLICA_INDISPONIVEL`;
  - a consulta nunca cai na agenda de todas as empresas.
- **Sem a 062:** comportamento anterior (agenda global), porque o schema ainda não tem escopo.
- O fechamento público já está fechado pelo catálogo público sem tenant (`CATALOGO_PUBLICO_INDETERMINADO`). A
  revalidação de horário dele usa o mesmo contexto.
- Resposta pública: só datas, turnos e "disponível/indisponível". Não inclui eventos, clientes nem bloqueios de ninguém.
  - Ressalva: os registros globais da seção 5 aparecem como "indisponível" para todos.
  - O arquivo comercial legado `data/disponibilidade.json` (exceções e descontos por pacote) continua global; não é
    agenda nem dado de outra empresa.

## 7. Integração (061): regras principais

**Evento histórico:** `kidmais019_ocupa` não muda.

- A isenção vale só na detecção de conflito, por meio de `kidmais061_historico_passado`.
- Ela vale apenas para evento já realizado na data da integração **e** no exato slot integrado.
- Qualquer remarcação, mesmo só de horário, volta a ocupar e a ser validada.

**Formalização:**

- só a versão 1 com `CONFERENCIA_PAPEL`, vínculo, hash do original e nenhuma assinatura dispensa OTP;
- uma versão 2 "em papel" é recusada;
- a versão digital seguinte segue o fluxo nativo da 057.

**Financeiro:**

- toda escrita usa o `tx` da integração, inclusive `registrarRecebimentoPagamento` com `executor`;
- reconciliação em centavos;
- "não conferido" fica sem obrigação e vira pendência.

**Idempotência:**

- `UNIQUE(importacao_id)` com lock da importação;
- a mesma chave ou o mesmo conteúdo devolvem o resultado gravado;
- conteúdo diferente recebe 409;
- a mesma regra vale para o financeiro.

## 8. Compatibilidade código × schema

| Código \ schema | 057 (hoje) | 061 | 062 | 062 removida (suave) |
|---|---|---|---|---|
| Anterior a esta entrega | Hoje | **Festa e assinatura pública 503** (fingerprint estrito da 019) | **503** | **503** |
| Esta entrega | Como hoje; agenda global; integração indisponível | Agenda global; integração indisponível | Isolamento por empresa; integração conforme a flag; pública exige contexto | Agenda global; integração indisponível |

**Por caminho (código novo):**

| Caminho | Como funciona em 057 / 061 / 062 | Evidência local (mocks/estática) | Banco real |
|---|---|---|---|
| Assinatura pública e Festa | `validarAmbienteFesta` aceita os conjuntos completos 019, 061 ou 062, nunca mistura; `kidmais019_validar_destino` mantém a assinatura | `migration-061.test.ts` e `migration-062.test.ts` (conjuntos e hashes) | `agenda-062` etapas 0/1/2; `tenant-festa` em `atual`, `061` e `062` |
| Fechamento | Grava `estabelecimento_id` só quando informado, e só há unidade com a 062 e unidade elegível; o gatilho valida | `administrativo.test.ts`; teste estático de detecção | `agenda-062` (gravação em cada etapa) |
| Pagamentos (confirmação) | `verificarConflitoAgendaParaConfirmacao` escolhe o SQL pela detecção; com a 062, o escopo vem da própria contratação | `escopo.test.ts` | `agenda-062`; `estorno-completo` em `atual`, `061` e `062` |
| Disponibilidade admin e pública, revisão, edição, IA | Escopo opcional; sem a 062, consultas anteriores; ausência de escopo = global conservador (exceto a pública com a 062, que recusa) | `escopo.test.ts` (10 cenários); `migration-062.test.ts` exige detecção em todas as funções do repositório | `agenda-062` |

**Mudança visível:** o painel de Disponibilidade passou a exigir a prova de tenant (`withTenantTransaction`).
Administrador sem membership na empresa perde acesso ao painel. Isso precisa ser confirmado na homologação.

`CONTRACT_IMPORT_INTEGRATION_ENABLED` **não protege os módulos nativos**. Ela só controla a API de integração. Os
módulos nativos ficam protegidos pela ordem "código antes", pelos fingerprints por conjunto e pelos prechecks.

## 9. Publicação e recuperação

**Ordem** (cada passo exige autorização própria):

1. PostgreSQL descartável (seção 10).
2. PR para `staging`, resolvendo o inventário junto com a #80 (seção 12).
3. Publicar o código em **todas** as instâncias de staging e confirmar que não resta instância anterior. Com o código
   anterior ainda vivo, a 061 derruba Festa e assinatura pública.
4. Janela de manutenção coordenada, com precheck → migration → postcheck da 061 e, em seguida, da 062.
   - Cada script usa `lock_timeout = '5s'`: falha em vez de ficar esperando, e pode ser repetido.
   - Durante cada transação, as escritas e parte das leituras em `fechamentos`, `contrato_versoes`, `festas` (061),
     `bloqueios_agenda`, `configuracao_agenda`, `estabelecimentos` e `contrato_importacoes` (062) esperam.
   - Na prática, Festa, fechamento, pagamentos e disponibilidade ficam parados nesse intervalo.
   - **A duração não foi medida em volume real.** O cluster sintético aplica o inventário inteiro a partir do schema
     vazio, o que não representa o volume de produção. A duração deve ser medida num ensaio em clone de staging com
     volume real (autorização própria) antes de marcar a janela.
5. Rodar o levantamento e decidir D3 (bloqueios) e o legado sem empresa; o Representante habilita as unidades que vão
   receber agenda (nenhuma é habilitada automaticamente).
6. Configurar `AGENDA_PUBLICA_EMPRESA_ID` (sem isso, a agenda pública fica indisponível depois da 062).
7. Homologação (seção 13) e só depois a flag.
8. Produção na mesma ordem.

**Recuperação:**

| Situação | O que fazer | Condições |
|---|---|---|
| Só o código publicado | Voltar o código é seguro | Schema intacto |
| 061 aplicada, sem integração | Rollback da 061 (restaura 019/057 byte a byte); depois o código anterior pode voltar | Recusa se houver qualquer integração |
| 061 com integrações | Desligar a flag. Integrados continuam no Core. Correção forward | Rollback recusa |
| 062 aplicada | Rollback da 062: devolve a agenda global (código novo detecta e volta às consultas anteriores; integração fica indisponível) | Ver abaixo |
| Qualquer momento | **Nunca** voltar ao código anterior com 061/062 aplicadas | Festa e assinatura pública 503 |

O rollback da 062 (`database/rollback/20261002_062_agenda_empresa_unidade_down.sql`):

- **Recusa se houver turno ativo por empresa ou unidade.** Sem a 062, esse turno entraria na agenda de todas as
  empresas. É preciso desativá-lo por decisão explícita antes.
- **Recusa se houver duas reservas simultâneas em recursos diferentes** (empresas diferentes no mesmo horário, de
  qualquer data). Com a agenda global elas passariam a conflitar, e qualquer alteração nessas contratações seria
  recusada pelos gatilhos. Nesse caso **não há volta para a agenda global**; a correção é forward. Isso inclui duas
  **unidades habilitadas** da mesma empresa reservadas no mesmo horário. A recusa foi provada no cluster sintético.
- **É suave** quando há escopo gravado (contratação com unidade, bloqueio ou turno com empresa, resolução de dono,
  habilitação de unidade): remove só as regras e preserva colunas, dados e o histórico de habilitação **com a guarda**
  (sem as regras, nenhuma habilitação nova nem revogação passa). A 062 pode ser reaplicada e reaproveita a estrutura.
  Provado no cluster sintético.
- **É completo** quando não há escopo gravado: o schema volta a ser igual ao da 061.
- Depois da 062, bloqueios e contratações gravam empresa imediatamente, então na prática só o rollback suave
  costuma estar disponível.
- Para voltar ao código anterior depois de um rollback suave, é preciso também o rollback da 061, que exige não haver
  integração.

## 10. PostgreSQL descartável — execução autorizada em 03/10/2026

**Alvo autorizado:**

| Item | Valor |
|---|---|
| Cluster | `D:\glass\KidMais Manager\ambientes-locais\pg-descartavel-061` (criado novo e **removido** no fim) |
| Host e porta | `127.0.0.1:55498` |
| Papel e `cluster_name` | `kidmais_descartavel` |
| Binários | `C:\Program Files\PostgreSQL\18\bin` (PostgreSQL 18.6) |
| Não acessados | porta 5432, banco `kidmais_manager`, `perfil-v1-revisao`, staging e produção |
| Relatórios (preservados) | `D:\glass\KidMais Manager\ambientes-locais\pg-descartavel-061-relatorios` |

**Bancos sintéticos:**

- os 8 modelos (`kidmais_v1_modelo_atual`, `_053`, `_052`, `_039`, `_042_sem_040`, `_045_sem_040`, `_061`,
  `_062`);
- `kidmais_pacotes_v1_descartavel` e `kidmais_pacotes_v1_rollback`;
- o banco de manutenção `postgres`.

**Orquestrador:** `scripts/pg-descartavel-061.cjs`, com as ações `preparar`, `provar`, `executar`, `encerrar` e
`limpar`. Ele exige `KIDMAIS_CLUSTER_061_AUTORIZACAO="<diretório>|127.0.0.1:55498|kidmais_descartavel"` literal.

**Guardas:**

1. **Conexão explícita:** todo cliente (receita, `conectarDescartavel`, `conectar054`, `gates-c2`, orquestrador) recebe
   host, porta, usuário e banco explícitos, e nenhuma senha é carregada. O cluster usa `trust` só em 127.0.0.1; se o
   servidor pedir senha, a conexão falha (`senhaRecusada`).
2. **Porta 55498 sem `PG*`:** o runner remove do próprio processo e de cada suíte `DATABASE_URL` e **toda** variável
   `PG*` (inclusive `PGOPTIONS`, `PGSERVICE`, `PGSERVICEFILE`, `PGPASSFILE` e `PGSSL*`). Depois repassa
   `KIDMAIS_DESCARTAVEL_PORTA=55498` com a autorização literal `127.0.0.1:55498/kidmais_pacotes_v1_descartavel`
   (`ambienteDaSuite`). A porta nunca vem de `PGPORT` nem de padrão implícito; o teste estático "ambiente explícito"
   comprova isso. Os conectores recusam processo com configuração herdada.
3. **Identidade que aborta:** a prova confere `cluster_name`, endereço, porta, usuário, `data_directory` igual ao
   diretório autorizado, versão 18 e ausência de `kidmais_manager`. Qualquer divergência interrompe; no `preparar`,
   antes, para o servidor que ele mesmo subiu.
4. **Pré-condições:** se o diretório já existir ou a porta estiver ocupada (conexão ou bind em 127.0.0.1 e 0.0.0.0),
   o orquestrador para. Ele não reutiliza nem encerra outro servidor.
5. **Limpeza validada:** antes de remover, confere:
   - caminho absoluto exato;
   - `realpath` do diretório e do pai sem redirecionamento, e nenhum junction/symlink dentro;
   - `postgresql.conf` do cluster sintético;
   - `PG_VERSION` presente e sem `postmaster.pid`;
   - `pg_ctl status` = 3 e porta sem servidor.
6. **Relatórios fora do diretório removido:** log do servidor, saída das suítes, identidade, encerramento e limpeza.

**Execução (03/10/2026, 06:17–06:29):**

| Passo | Resultado |
|---|---|
| `preparar` | Diretório inexistente e porta livre conferidos; `initdb` e start ok. O primeiro `preparar` travou no Windows (o `postgres` herdava os pipes do `spawnSync`): corrigido com `stdio: "ignore"` (log em arquivo), e a identidade foi provada em seguida com `provar` |
| `provar` | `kidmais_descartavel`, 127.0.0.1, 55498, `data_directory` = diretório autorizado, versão 180006, sem `kidmais_manager` |
| Rodada 1 (todas) | 33/35. Falharam as duas suítes novas, por defeitos de **teste** (abaixo) |
| Rodadas 2 e 3 (só as que falharam) | 061: 11/11; 062: 13/13 depois da última correção |
| **Rodada final (todas, modelos recriados)** | **35/35** |
| Revisão antes da PR (só a suíte afetada, cluster recriado e removido de novo) | `agenda-062` 14/14 com o subteste novo da unidade revogada. O primeiro envio falhou porque o teste mudou `convidados` sem `convidados_faturados` (violou uma restrição já existente); o teste foi corrigido para uma correção coerente (tema) |
| `encerrar` | `pg_ctl status` 3, sem `postmaster.pid`, porta 55498 sem socket |
| `limpar` | Diretório removido (`existeDepois: false`); relatórios preservados; `perfil-v1-revisao` intocado |

**Falhas corrigidas (no teste, sem afrouxar asserção):**

- **`SET CONSTRAINTS ALL IMMEDIATE` durava o resto da transação.** Isso antecipava guardas de sequências com vários
  comandos (ledger 015: "Sequência sem evento"; vínculo 061: "fechamento histórico exige vínculo"), que no produto
  rodam cada uma na própria transação. Agora `validarAgora` dispara as verificações pendentes e devolve cada
  restrição ao modo padrão; ele recusa nomes de restrição ambíguos.
- **Subteste que falhava deixava a transação abortada para o próximo.** Agora há `beforeEach` com `ROLLBACK`.
- **O substituto do "código anterior" estava errado.** O postcheck da 019 também confere a linha de base da 016. Agora
  o teste usa o fingerprint estrito da 019, **idêntico** ao `estrutura-019.ts` publicado (HEAD), conferido byte a byte.
- **"Mesmo conteúdo com outra chave" usava hash fabricado.** Agora o teste reenvia o `resumoHash` revisado, e foi
  acrescentada a recusa de conteúdo diferente (`IMPORTACAO_JA_INTEGRADA`).

**Repetir (exige nova autorização):**

```
node scripts/pg-descartavel-061.cjs preparar
node scripts/pg-descartavel-061.cjs executar
node scripts/pg-descartavel-061.cjs encerrar
node scripts/pg-descartavel-061.cjs limpar
```

Para repetir suítes específicas, use `KIDMAIS_POSTGRES_SOMENTE` com os caminhos exatos.

## 11. Evidências

**Mocks, estática e locais:**

| Validação | Resultado |
|---|---|
| `npm run check:v1:static` (worker de PDF, testes unitários, harness de staging, ESLint, `tsc`, `next build`) | **Aprovado** em 03/10/2026: 1767/1767 unitários, 103/103 harness, `tsc` e build ok; lint com 1 aviso preexistente (`lib/inteligencia/skills/catalogo.ts`) |
| `escopo.test.ts`, `migration-062.test.ts`, `migration-061.test.ts`, testes da integração | Aprovados |
| `production.test.mjs` | 37/37; e 37/37 na árvore simulada 060 + 061 + 062 |
| `scripts/importacao-revisao.ui.cjs` (Edge headless, APIs simuladas) | **10/10** em 03/10/2026, incluindo "Integrar ao sistema" |

**Banco real (cluster sintético, 03/10/2026): 35/35 execuções aprovadas** (31 arquivos; `tenant-festa` e
`estorno-completo` em `atual`, `061` e `062`). Relatório:
`ambientes-locais\pg-descartavel-061-relatorios\2026-10-03T09-27-15-736Z-check-v1-postgres.log`.

- Os modelos `061` e `062` foram construídos do schema vazio com precheck, migration e postcheck reais.
- `agenda-062` (14 subtestes):
  - etapas 0/1/2 com o código novo; o código anterior valida antes da 061 e é recusado a partir dela;
  - D6: nenhuma habilitação automática; só o representante habilita;
  - **duas unidades habilitadas da mesma empresa no mesmo horário: aprovadas;**
  - **conflito na mesma unidade: recusado pelo serviço e pelo banco;**
  - **unidade não habilitada: recusada;**
  - revogação: reservas preservadas; novas contratações, remarcação, bloqueio e turno recusados; histórico imutável;
  - unidade revogada ainda aceita correção sem mudar horário, conferência financeira e cancelamento nativos;
  - revogação concorrente;
  - isolamento por empresa e bloqueios por alcance;
  - concorrência entre fluxo nativo e importação;
  - rollback suave e reaplicação; o rollback recusa reservas simultâneas;
  - remarcação histórica;
  - rollback no meio e repetição sem duplicar recebimentos.
- `integracao (061+062)` (11 subtestes): financeiro parcial, integral e não conferido; datas históricas e centavos;
  formalização; vínculo forjado; concorrência; isolamento; falha no meio.
- Nativas aprovadas: Festa, estorno, pagamentos (gates C1–C3), financeiro, 054–059, comercial e SaaS.

**Homologação:** não iniciada.

## 12. Coordenação com a 060 (WhatsApp, PR #80)

- A 060 só cria tabelas `whatsapp_atendimento_*`. Não há dependência de schema com a 061 ou a 062.
- Conflitos são só de inventário:
  - `check-migrations.mjs` e `production.test.mjs`: resolver por união, 060 antes de 061 e 062. Simulado: 37/37.
  - `regressao-v1-selecao.cjs`: manter a linha da suíte 060 **e** a linha `estorno-completo` com `tambem`.

## 13. Roteiro de homologação (depois da 062, da configuração pública e da flag)

1. **Agenda:**
   - o Representante habilita duas unidades; as duas recebem festa no mesmo horário; a mesma unidade conflita;
   - revogar uma unidade mantém as reservas dela e bloqueia novas contratações e remarcações;
   - empresa A ocupa um horário; empresa B vê o mesmo horário livre;
   - a agenda pública sem contexto mostra indisponibilidade;
   - com contexto, vê só a própria empresa;
   - o levantamento lista o que ainda é global.
2. **Painel de Disponibilidade:**
   - administradores com membership acessam;
   - bloqueio sem dono aparece como "vale para todas" e não pode ser desativado;
   - bloqueio novo pertence à empresa.
3. **Importação nova (evento futuro, parte paga):**
   - "Falta integrar" aparece depois do registro;
   - "à vista" não marca pagamento;
   - soma divergente bloqueia;
   - depois de integrar: festa, horário ocupado só na empresa, parcela a receber e recebimento no caixa na data real.
4. **Evento passado:** vai ao Histórico sem ocupar a agenda. Remarcado, volta a ocupar e é validado.
5. **"Não conferido":** vira pendência; repetir a conferência não duplica.
6. **Regressão nativa:**
   - fechamento admin e público (o público segue fechado pelo catálogo);
   - assinatura pública, festa automática, recebimento e estorno;
   - revisão e remarcação.
7. **Desligar a flag:** a integração fica indisponível e os integrados continuam no Core.

## 14. Contratos já importados

Não há backfill. Com a flag ligada, para cada contrato:

1. Abrir o contrato importado.
2. Conferir o original.
3. Clicar em "Integrar ao sistema".

Pagamentos que não puderem ser conferidos agora ficam como "Ainda não conferi".

## 15. Limitações

- **Unidades:** só recebem agenda depois da habilitação explícita pelo Representante; nenhuma vem habilitada.
- **Dados da seção 5:** continuam globais até a resolução.
- O Core não tem destino financeiro (conta ou caixa). A forma de pagamento fica em cada recebimento.
- `assinado_em` do contrato integrado é o instante da conferência. A tela deixa claro que é conferência em papel.
- Fechamento público continua fechado pelo catálogo público sem tenant.
- Revisões futuras exigem cadastro completo do cliente e do aniversariante.
