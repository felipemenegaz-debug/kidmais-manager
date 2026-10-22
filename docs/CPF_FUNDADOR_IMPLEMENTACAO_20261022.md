# CPF do contratante e campanha Fundador em duas fases: implementação local

Data: 22/10/2026 (segunda rodada com D1–D5 decididas; terceira rodada com as correções da revisão independente). Estado: **implementação LOCAL**. Não houve push, PR, deploy, migration em ambiente real, Asaas real ou sandbox.
A campanha nova está desligada e sem data. O CPF fica desligado até a 091 ser aplicada e a chave ser ligada com autorização.
Plano de origem: [PLANO_PLANO_CPF_E_FUNDADOR.md](PLANO_PLANO_CPF_E_FUNDADOR.md).

## 1. Proveniência

- Clone local novo `kidmais-manager-cpf-fundador-20261022`, criado a partir do clone `kidmais-manager-piloto-20261022`.
  - Feito com `--no-checkout --no-hardlinks -c core.autocrlf=false`, antes do checkout.
  - Branch `codex/implementar-cpf-fundador-20261022`, sobre a staging conhecida localmente `326895eaef59eb926e34397220df333cdf754b4e`.
  - Não houve `git fetch` do GitHub. O commit do plano veio do clone local do plano.
  - A ponta remota não foi conferida.
- Cherry-picks com autoria preservada:
  - `eb6cd5c` (plano), que virou `1a9cfe8`;
  - `3348f80` (piloto "Iniciar teste grátis"), que virou `35a429b`.
- O piloto continua **não publicado**. A composição foi revalidada aqui: a suíte PG `comercial` roda no modelo 063.

## 2. Decisões comerciais e conferência da implementação

**Recebidas no pedido de 22/10/2026:**
- CPF válido aceito no teste, na assinatura e no Fundador.
- 40% por 12 meses.
- Janela de 30 dias para todos, sem teto; depois, mais 20 vagas por ordem de contratação.
- Pilotos que assinarem na janela estão garantidos.
- Devolução não cobra o desconto de volta.

**D1–D5, decididas por Felipe em 22/10/2026 (segunda rodada).** A data de abertura **ainda não foi definida**. Ordem
expressa: não ativar a campanha nem o CPF, não publicar e não acessar ambientes reais.

| # | Decisão | Como a implementação cumpre | Prova |
|---|---|---|---|
| D1 | Oferta aceita e persistida pelo servidor garante a elegibilidade; o pagamento confirma o benefício e inicia os 12 meses. | A concessão nasce com a oferta persistida (`prepararOferta`); a confirmação do pagamento grava `confirmada_em` e `beneficio_fim` (+12 meses, guarda 074a). O banco só aceita `elegibilidade = 'OFERTA_PERSISTIDA'` (CHECK). | 090 casos 3, 4 e 7 |
| D2 | 30 dias de calendário em America/Sao_Paulo, `[D 00:00, D+30 00:00)`. | `ativarCampanhaAprovada` fixa `CALENDARIO_LOCAL` e calcula a janela pela data D. O site anuncia "até D+29, 23h59 (horário de Brasília)". **Resíduo:** o schema mantém `HORARIO_EXATO` para o ensaio sintético de fronteira em banco descartável; a ativação real só pode usar a função (controle operacional). | 090 caso 3; unitário de calendário |
| D3 | Oferta vale 7 dias corridos da aceitação persistida. Paga depois do corte e dentro dos 7 dias: continua JANELA, sem consumir as 20. Vencida: liberação só com prova de cobrança ausente ou cancelada. Pagamento tardio vai para reconciliação, sem cobrança complementar automática. O prazo é informado ao contratante. | O banco fixa `validade_oferta = 7 days`; `oferta_valida_ate = reservada_em + 7 dias`, imutável. Critério **único por dia local**: a condição vale até o fim do dia (America/Sao_Paulo) de `oferta_valida_ate`, inclusive. Esse dia vale para a tela, a retomada e o pagamento. O pagamento é comparado pela **data mais antiga informada pelo provedor** (`clientPaymentDate` do boleto, que é o dia pago; `confirmedDate` do cartão; `paymentDate`). Nunca pela chegada do webhook ou pelo relógio. Até o dia: confirma JANELA. Depois, ou sem nenhuma data: `FUNDADOR_OFERTA_EXPIRADA`, sem confirmar, liberar, reprecificar ou cobrar de novo. A sincronização grava `ERRO_INTERNO: FUNDADOR_OFERTA_EXPIRADA` e a reconciliação diária conta `ERRO_FUNDADOR_OFERTA_EXPIRADA` e alarma (código de saída 2); isso é testado. Retomar oferta vencida também é recusado. Não existe liberação automática: a liberação continua manual, com evidência (guarda 074a). A tela de assinatura mostra "pague até DD/MM/AAAA (horário de Brasília)" ou o aviso de vencida, também junto do link de pagamento (o checkout devolve a validade); o site e a tela explicam os 7 dias. | 090 caso 8 (inclui boleto no último dia, sem data, último dia por calendário, reconciliação real); unitário `dataDoPagamento`; Playwright `E2E_VALIDADE_OK` e prazo no link |
| D4 | Reservas legadas preservadas, inclusive pendentes, sem consumir as 20. Pendente legada paga mantém a condição. Vaga posterior confirmada não é reciclada. | Backfill `LEGADO` sem alterar nenhuma coluna antiga (prova coluna a coluna e md5 do aplicador). LEGADO não tem prazo e confirma pelo valor contratado. `CONFIRMADA` nunca volta a `LIBERADA` (074a); vaga posterior continua ocupada. | 090 casos 1, 2, 6 e 9; aplicadores PG |
| D5 | Benefício por empresa/tenant e documento. Troca CPF→CNPJ da mesma operação não gera novo teste nem novo benefício. Vínculos são declarados e conferidos no atendimento. Ser sócio não bloqueia. Continuidade preserva prazo, preço e benefício, sem nova vaga; bloqueada no autoatendimento. | Unicidade por empresa e por documento (índices 074a e `documento_teste_uk`). `documento_teste` e `documento_beneficiario` são imutáveis. O painel recusa trocar CPF↔CNPJ depois do teste. O checkout recusa documento de outro tipo (`DOCUMENTO_DIVERGENTE`). Nenhuma checagem de sociedade, nome, telefone ou IP. **Resíduo declarado:** um cadastro NOVO com o CNPJ da mesma operação não é detectável automaticamente; depende do vínculo declarado e conferido no atendimento. | 091 casos 5 e 6; unitários |

**Antes da abertura:** sem campanha ativada, o código mantém a regra anterior (20 primeiros, `LEGADO`) **apenas como
compatibilidade técnica**. Isso não autoriza anunciar a campanha nova nem vender com promessas divergentes. A abertura
exige data decidida, ativação autorizada e alinhamento dos textos públicos (site, termos e termo do piloto, que fala
em "sem limite por 30 dias").

## 3. Numeração das migrations

Antes de escrever, foi feita uma busca local em todos os clones `kidmais-manager-*`:
- refs `heads/remotes` e árvore de trabalho;
- caminhos `database/` e `scripts/` com `_09x`/`-09x`.

Nenhuma ocorrência de 090 ou 091 foi encontrada. 087 continua reservada aos e-mails de cobrança; 088 e 089 já estão
tomadas. **Número livre localmente não é reserva global**: repetir a busca antes de congelar a candidata e antes de
aplicar.

- **090:** campanha Fundador (B).
- **091:** documento fiscal do contratante (A). É independente da 090.

## 4. B — campanha Fundador (commits `afc427c`, `77520e1`)

### 4.1 Migration 090
Arquivos: `database/migrations/20261022_090_campanha_fundador.sql`, os checks pre/post e o rollback.

**`assinatura_campanhas`:**
- Fonte persistida e auditável da campanha. Começa em `RASCUNHO`, editável.
- `RASCUNHO → ATIVA` exige: contagem, elegibilidade, validade da oferta, abertura (data ou horário), autorização em
  texto e quem ativou.
- A guarda calcula `inicio`/`janela_fim` em `America/Sao_Paulo`:
  - calendário: `[D 00:00, D+30 00:00)`;
  - horário exato: 720 h.
- Recusa janela que já terminaria antes da ativação.
- Só uma campanha pode estar ativada (índice parcial e guarda).
- Depois de ativada é imutável. `ATIVA → ENCERRADA` só com motivo.
- `DELETE` só em rascunho; `TRUNCATE` é recusado.
- Percentual (40), meses (12), janela (30) e lote (20) são fixados por CHECK.

**`assinatura_fundadores` ganha:**
- `origem`: `LEGADO`/`JANELA`/`POS_JANELA`. O padrão `LEGADO` existe só no backfill e é removido em seguida.
- `campanha_id`, `regra_versao` e `oferta_valida_ate`.
- `vaga` passa a nullable:
  - nula na janela;
  - 1–20 no `LEGADO` (números antigos) e no `POS_JANELA`.
- O índice global de vaga foi trocado por:
  - `vaga_legado_uk` (`LEGADO` não liberado);
  - `vaga_pos_uk` (campanha + vaga, `POS_JANELA` não liberado).
- Os índices únicos por empresa e por documento continuam.

**Guarda `kidmais_090_fundador_guarda`:**
- Roda depois da 074a, que já travou a empresa.
- Recusa `origem` nula.
- Toma a mesma trava da alocação (`kidmais:fundadores:2026`) e lê `clock_timestamp()` **depois** da trava.
- Recusa `LEGADO` se alguma campanha já foi ativada.
- Recusa campanha não ativa e janela fechada para `JANELA`.
- Recusa lote posterior antes do corte, acima de 20 ou esgotado.
- Grava `reservada_em`, `regra_versao` e `oferta_valida_ate` (validade da campanha).
- As colunas novas são imutáveis.

**Não muda:** 068, 074a (arquivo intacto, hash fixado no `schema-completo`), 075, 089, preços, renovação e o cálculo UTC dos 12 meses.

### 4.2 Código
- `lib/assinatura/campanha.ts`: schema instalado, campanha ativada, fase (início inclusivo, fim exclusivo), cálculo de
  calendário com base IANA, prazo anunciado e resumo indicativo sem ids nem documentos.
- `lib/assinatura/ofertas.ts`:
  - Sem a 090, ou sem campanha ativada, vale a regra antiga (20 primeiros; com a 090 instalada a contagem é só `LEGADO`).
  - Com campanha ativada e `ASSINATURA_CAMPANHA_FUNDADOR_ATIVA` diferente de `true`, a contratação fica indisponível
    (`CAMPANHA_DESLIGADA`, 503). Isso é intencional: não vende sem a condição prometida.
  - Antes do início: `CAMPANHA_ANTES_DA_ABERTURA`.
  - Na janela: concessão `JANELA`. Depois: `POS_JANELA` com a primeira vaga livre. Com 20 ocupadas e não confirmadas:
    `FUNDADOR_AGUARDANDO`. Com 20 confirmadas: preço regular.
  - A guarda que recusa na virada vira `OFERTA_ALTERADA` (409): o cliente confirma de novo.
  - A retomada de oferta e a concessão existente não reiniciam 12 meses nem ocupam vaga nova.
- `lib/assinatura/cobranca.ts`: o checkout passa o `env` à oferta.
- Site e assinatura (`lib/site/fundador.ts`):
  - mesmo texto na barra, no cartão e no FAQ;
  - prazo vindo do banco, com "(horário de Brasília)";
  - vagas reais restantes, "em confirmação" ou encerrado;
  - desligada, antes da abertura ou sem leitura do banco: sem prazo nem estoque.
  - A tela de assinatura mostra o prazo ou as vagas (indicativo) e o bloqueio.
- Exportação: `assinatura_campanhas` é `FORA_DO_ESCOPO` (configuração da plataforma); `assinatura_fundadores` continua
  fora do escopo. A guarda de tabela desconhecida continua intacta.

### 4.3 Compatibilidade
- **L1/089:** a devolução usa o valor efetivamente pago; a concessão continua CONFIRMADA (suíte 090, caso 7).
- **075:** a renovação aceita contrato Fundador da janela com o preço regular contratado (suíte 090, caso 7).
- **D-C4:** `scripts/assinatura-reconciliar.cjs` não conta concessões; mais de 20 na janela não gera alarme.
  Pagamento de oferta vencida aparece na reconciliação como `ERRO_FUNDADOR_OFERTA_EXPIRADA`, com alarme (suíte 090, caso 8). A empresa
  fica sem sincronizar até o atendimento resolver; é intencional, porque ainda não há plano a ativar.
- **Isenção Kidmais:** inalterada (regra 074a e a mesma verificação de 0 concessões).
- **Staging (seis vagas):** viram `LEGADO` sem consulta ou limpeza nesta tarefa. O efeito sobre elas só pode ser
  conferido por operação futura autorizada (§8).

## 5. A — CPF do contratante (commit `7b4db68`)

### 5.1 Migration 091
Arquivos: `database/migrations/20261022_091_documento_fiscal_contratante.sql`, os checks e o rollback.

- Alarga o formato para `^([0-9]{11}|[0-9A-Z]{12}[0-9]{2})$` em quatro colunas:
  - `empresa_assinaturas.documento_teste`;
  - `assinatura_fundadores.documento_beneficiario`;
  - `cadastros_empresas.documento`;
  - `solicitacoes_acesso_empresa.documento`.
- `kidmais_091_documento_valido(text)` (IMMUTABLE) calcula o DV oficial de CPF e de CNPJ numérico e alfanumérico.
  Ele é aplicado por **gatilho só no INSERT** (`kidmais_091_documento_guarda`) em `empresa_assinaturas` e
  `assinatura_fundadores`.
  - Revisão independente: um CHECK `NOT VALID` também valeria em todo UPDATE de linha antiga, e uma linha legada com DV
    inválido deixaria de sincronizar.
  - Como o documento é imutável, conferir na inserção basta. Linhas antigas continuam atualizáveis (provado na suíte
    091, caso 2).
  - O precheck só **informa** quantas linhas antigas têm DV de CNPJ inválido.
  - O postcheck recusa qualquer CHECK que use a função de DV.
  - A 091 toma ACCESS EXCLUSIVE já no início.
- `empresa_representacoes.qualificacao` ganha `TITULAR_PF`.
- **Não muda:** imutabilidade de `documento_teste`/`documento_beneficiario` (guardas 068/074a), `assinatura_isencoes`
  (só CNPJ) e `perfil_empresas.cnpj` (só CNPJ).
- O tipo não ganhou coluna própria. Ele é derivado do formato normalizado (11 dígitos = CPF; 14 caracteres = CNPJ),
  garantido pelos CHECKs: sem duplicar estado nem fazer backfill.

### 5.2 Código
- **Validação única** (`lib/acessos/validacao.ts`): `cpfValido` (zeros à esquerda, dois DVs, sequência repetida),
  `documentoFiscalValido` e `tipoDocumentoFiscal`, reaproveitando `normalizarDocumentoFiscal` e o CNPJ alfanumérico de
  `lib/cadastro/cnpj.ts`.
- **`lib/assinatura/documento-contratante.ts`:**
  - CPF só com a 091 instalada **e** `ASSINATURA_CPF_ATIVO=true`; senão `CPF_INDISPONIVEL`.
  - Trava única por documento (`kidmais:cnpj:` + documento, nome histórico mantido para coincidir com o código antigo).
- **`iniciarTeste`:** valida no servidor qualquer que seja a origem. DV de CNPJ agora é exigido; antes era só formato.
- **Cadastro público:**
  - PJ: CNPJ, razão social, qualificação e sócios.
  - PF: CPF, nome civil e `TITULAR_PF`, sem sócios.
  - Nome do buffet separado nos dois casos.
  - Combinações incompatíveis são recusadas no servidor.
  - O campo antigo `cnpj` continua aceito como PJ.
  - Auditoria com documento mascarado e tipo de pessoa.
- **Provisionamento pelo painel:**
  - documento continua opcional no rascunho;
  - mesma trava do cadastro público;
  - conferência também contra `documento_teste`;
  - troca CPF ↔ CNPJ depois do teste é recusada (atendimento).
- **Piloto:** "Iniciar teste grátis" aceita CPF com a 091 e a chave. A expectativa da suíte do piloto passou de
  `DADOS_INVALIDOS` para `CPF_INDISPONIVEL` sem a 091, conforme a decisão A.
- **Checkout/Asaas:**
  - O cliente é criado com `cpfCnpj` e o titular fiscal (PF: nome civil; PJ: razão social).
  - Documento do teste primeiro; senão, o do cadastro, validado.
  - CPF ↔ CNPJ divergente entre o teste e o cadastro recusa a criação do cliente (`DOCUMENTO_DIVERGENTE`).
  - **Aceite da cobrança não comprova emissão de NFS-e.**
- **Telas:**
  - `/cadastro/empresa` mostra "Quem contrata" só com a chave ligada.
  - O site cita CPF só com a chave ligada.
  - O painel deixou de dizer "CPF não serve".
  - O CNPJ do fornecedor no rodapé não mudou.

### 5.3 Não implementado (bloqueado ou fora do escopo)
- **Continuidade CPF → CNPJ:** sem fluxo, bloqueada no autoatendimento e no painel depois do teste. Depende de:
  - decisão contratual (cessão/continuidade, Astra);
  - capacidade do provedor de trocar `cpfCnpj` do cliente existente ou exigir cliente e assinatura novos (sandbox não
    executado);
  - efeito fiscal (contador).
  - Documentos do teste e do beneficiário continuam snapshots.
- **Perfil da empresa, separando o técnico do jurídico:**
  - **Impedimento técnico, CORRIGIDO na segunda rodada.** Antes, a aplicação exigia CNPJ válido, e um buffet PF não
    aplicava o Perfil.
    - Agora, se o contratante é PF (documento do teste ou do cadastro com 11 dígitos, resolvido pela empresa SaaS do
      perfil), o CNPJ fica opcional. Se for informado, continua validado como CNPJ.
    - "Razão social" vira "Razão social ou nome civil do titular", obrigatório.
    - O CNPJ vazio é gravado como NULL (CHECK 027).
    - O CPF nunca é gravado no Perfil.
    - Os contratos dos buffets vêm do modelo da própria empresa, que já prevê "CNPJ ou CPF" da contratada; não
      dependem do CNPJ do Perfil.
  - **Decisões que dependem da Astra (pendentes):** se e como o CPF do titular aparece nos documentos com os clientes do
    buffet (contratos, recibos, Pix); se o nome civil basta como identificação; endereço residencial × comercial;
    texto de ajuda definitivo. Até lá, o Perfil PF mostra nome civil e nome comercial, sem CPF.
- Vínculo CPF↔CNPJ, consulta societária, coleta de CPF de sócios: não criados, por decisão.
- Textos legais (Termos/Aviso/Acordo v2) **não alterados**: continuam citando CNPJ/razão social.

## 6. Aplicadores e blocos de Shell

Arquivos:
- `scripts/migration-090-comum.cjs`, `-staging.cjs`, `-production.cjs`, `scripts/bloco-shell-090.cjs`;
- os equivalentes `091`;
- testes `scripts/migration-09x.test.cjs` e `scripts/bloco-shell-09x.test.cjs`.

O padrão é o mesmo da 088/089:
- identidade e TLS do alvo;
- hashes LF fixados;
- conferência READ ONLY;
- backup obrigatório;
- recusa de estado parcial e de privilégio insuficiente (CREATE, REFERENCES, **dono** das tabelas alteradas);
- marcador exclusivo contra repetição;
- saída sanitizada;
- bloco ASCII em subshell com `CODIGO_SAIDA_BLOCO`.

**Prova agregada de preservação.** São contagens e md5 agregados, com NULL explícito, só das colunas **imutáveis**
que a migration poderia afetar:
- identidade da concessão e snapshot da contratação (090);
- documentos e qualificação (091).

Entram só as linhas criadas até um **corte** lido no banco antes da migration. Estado, versão e pagamentos ficam fora,
porque mudam com o tráfego: assim, escrita normal durante a aplicação não gera falso `PRESERVACAO_DIVERGENTE`
(achado da revisão independente). O backfill LEGADO é conferido pelas linhas até o corte. A divergência real continua
`FALHA` com `migracaoCommitada=true`.

Ordem futura, para cada uma das migrations, independentes:
1. código publicado com a chave desligada;
2. `--conferir-09x`;
3. autorização;
4. backup;
5. `--aplicar-09x-autorizado`;
6. `--conferir-09x`.

Só depois disso, com autorização própria, vêm a campanha (rascunho, decisões e ativação) e a chave
`ASSINATURA_CAMPANHA_FUNDADOR_ATIVA`, e também `ASSINATURA_CPF_ATIVO`.

**Rollback:**
- 090: só sem campanha registrada e sem concessão nova.
- 091: só sem CPF ou `TITULAR_PF`.
- Depois disso: desligar a chave e corrigir para frente.

### 6.1 Aplicadores em PostgreSQL descartável (segunda rodada)

`lib/assinatura/aplicador-090-091.postgres.test.ts` roda os aplicadores REAIS de staging e produção no modelo 089, no
desenho do teste 088/089. Para cada migration:
1. conferência só leitura nos dois ambientes;
2. papel sem CREATE/REFERENCES e depois sem ser dono das tabelas → RECUSARIA e FALHA antes de escrever;
3. vestígio parcial → recusa;
4. falha real por `lock_timeout` com outra sessão em ROW EXCLUSIVE → FALHA no marcador, nada fica, sem repetição;
5. aplicação em produção sobre duas concessões legadas → APLICADA_POSTCHECK_PASS, md5 de preservação igual, saída sem
   documentos, marcador CONCLUIDA, repetição recusada;
6. depois disso, só confere.

## 7. Validação executada (local)

O resultado completo está no §10.

## 8. Roteiro futuro de homologação (não executado; cada passo exige autorização)

1. Revalidar a ponta de staging e as colisões 090/091 em todas as branches e clones (busca de nomes de checks também).
2. Revisão independente da candidata.
3. Decisões D1–D5, data de abertura, parecer da Astra e do contador (§9).
4. PR para staging e deploy do código com as chaves desligadas. Smoke:
   - site com a regra anterior;
   - CPF recusado com `CPF_INDISPONIVEL`.
5. Staging, para cada migration:
   - export/PITR anotado;
   - bloco `CONFERIR 090`, `APLICAR 090` e `CONFERIR`;
   - mesmo ciclo para a 091.
   - Conferir as seis concessões históricas: mesmas linhas, `LEGADO`, valores e datas iguais, nada removido.
6. Asaas **sandbox** (plano separado de fixtures e limpeza):
   - cliente PF sintético aceito;
   - mensal e anual;
   - pagamento confirmado;
   - webhook atrasado e repetido;
   - devolução L1;
   - retomada após falha;
   - tentativa de troca de `cpfCnpj`.
   - NFS-e só com o roteiro do contador.
7. Campanha de staging:
   - rascunho com data própria de staging;
   - ativação autorizada;
   - janela, corte, lote posterior e renovação, em campanha sintética de staging.
8. Produção: mesma ordem, com autorizações próprias. A data real nunca é copiada de staging.

## 9. Perguntas e impedimentos (Astra / contador)

Nada foi enviado a terceiros. Pauta, não conclusão:

1. **Astra:**
   - qualificação do buffet PF nos Termos (titular em nome próprio, sem representação societária);
   - informação prévia e resumo contratual para PF;
   - aceite e comprovante na contratação eletrônica;
   - arrependimento pelo mesmo meio e protocolo (L1 existe, mas falta a conferência jurídica);
   - CPF como dado do próprio contratante (base, finalidade, retenção);
   - redação "assinar até DD/MM" e o efeito da validade da oferta (D1/D3);
   - promessa aos pilotos;
   - continuidade/cessão CPF → CNPJ;
   - Aviso e Acordo v2 (citam CNPJ/razão social; PF continua controlador dos dados dos clientes);
   - como o buffet PF aparece nos documentos do Perfil.
2. **Contador:**
   - emissão de NFS-e para tomador PF (campos obrigatórios, endereço, município, código de serviço);
   - momento de emissão;
   - cancelamento/substituição;
   - devolução proporcional;
   - diferença entre o documento do contratante e o do pagador;
   - efeito da troca CPF → CNPJ no meio do ciclo.
3. **Provedor (sandbox autorizado):**
   - aceitação de cliente PF;
   - alteração de `cpfCnpj` em cliente existente;
   - efeitos na assinatura.

## 10. Resultado das validações

Tudo executado localmente, sem `.env.local`, rede externa, banco real ou credencial real. Os logs ficam fora do
repositório, em `D:/glass/KidMais Manager/cpf-fundador-*.log`.

### Unitários e verificações estáticas
- Unitários: `lib/assinatura` **188/188** antes de A; depois de A, `lib/assinatura`+`cadastro`+`desenvolvedor`+`acessos` **301/301**.
  Incluem calendário da campanha (5), textos do site (5) e validador/chave de CPF (3).
- Aplicadores e blocos: `migration-090` + `bloco-shell-090` **22/22**; `migration-091` + `bloco-shell-091` **22/22**.
  Os blocos rodam com bash real, inclusive em colagem interativa.
- Inventário de produção (`scripts/production/production.test.mjs`): **37/37**, com 090 e 091 registradas.
- `check:v1:static`: **PASS**, com 3276 + 103 testes, ESLint, TypeScript e `next build`. Rodou com B e de novo com A.

### PostgreSQL descartável
Cluster **novo** desta tarefa: porta 55607, `cluster_name`/papel `kidmais_descartavel`, identidade provada antes de
qualquer escrita, modelos recriados do schema vazio.

- **090: 7/7.** Cobre:
  - seis concessões criadas pelo código antigo e preservadas coluna a coluna (aplicação, rollback e reaplicação);
  - regra anterior sem campanha; guardas da campanha;
  - **22 adesões na janela** sem vaga numerada; chave desligada; inserções diretas recusadas;
  - mesma empresa em duas conexões;
  - **fronteira**: o pedido que espera a trava atravessa o corte e vira lote posterior, com a espera observada no servidor;
  - **disputa real da 20ª vaga** em duas conexões (uma vence, a outra recebe `FUNDADOR_AGUARDANDO` sem oferta nem cobrança);
  - 21ª concessão direta recusada; "em confirmação" e depois preço cheio;
  - pagamento tardio da janela pela sincronização, repetido sem efeito;
  - renovação 075 aceita; devolução L1 sobre o valor pago, com a concessão preservada.
- **Controle negativo da 090:** com o relógio lido ANTES da trava, a fronteira falha (`OFERTA_ALTERADA`, barrada pela guarda
  do banco). O original foi restaurado.
- **091: 7/7.** Cobre:
  - sem a 091, CPF recusado e PJ pelo campo antigo;
  - aplicação com preservação, rollback e reaplicação;
  - cadastro PF completo, idempotente, com auditoria mascarada; combinações inválidas;
  - CPF duplicado vira pedido neutro;
  - corrida real de duas pessoas; espera na trava compartilhada com o "painel" observada no servidor;
  - DV e imutabilidade no banco; piloto com CPF;
  - Fundador JANELA com CPF;
  - checkout com cliente do provedor PF (nome civil + CPF) e PJ (razão social + CNPJ);
  - divergência CPF↔CNPJ sem criar cliente;
  - rollback recusado com CPF.
- **Regressão de 14 arquivos / 18 execuções** (cadastro 069, piloto/comercial, painel 063, contratação/cobrança E8,
  cobrança 068, devolução 089, aplicador 089, exportação, gratuidade Kidmais, transação com prazo, assinatura):
  - 1ª rodada: 4 falhas, todas atribuídas e corrigidas:
    - painel no schema 063;
    - mensagem de duplicidade;
    - `kidmais-gratuidade`, já quebrado pelo piloto;
    - mensagem de documento inválido.
  - Depois disso, as suítes afetadas passaram.
  - **Rodada final sobre o commit A (`7b4db68`): 18/18 PASS.**

### Playwright local
Chrome sem rede externa, checkout interceptado, e-mail em arquivo.
- `scripts/cpf-fundador-ui.cjs`: **5/5**:
  - site com o prazo do banco;
  - cadastro PF (DV errado recusado com alerta acessível; válido cria TITULAR_PF);
  - assinatura com o prazo e o valor Fundador;
  - CPF existente com mensagem neutra;
  - celular 375 px sem rolagem horizontal.
- `scripts/cadastro-publico-ui.cjs` (regressão, chave de CPF desligada): **8/8**.

### Preexistente e não relacionado
`scripts/concorrencia-vagas-isolado.test.cjs` falha também na base `326895e` (`INVENTARIO_MUDOU`, pacote histórico
de 10/10). Não foi alterado.

### Segunda rodada (decisões D1–D5, Perfil e aplicadores)

Executada sobre os commits `e9f0447`, `d13b6c8` e `b9812cd`, num cluster descartável recriado na mesma porta 55607.

**Aprovado:**
- Unitários: `lib/assinatura`+`perfil`+`site`+`cadastro`+`acessos` **330/330**.
- Aplicadores, blocos e produção: **81/81**.
- PG descartável:
  - **090: 9/9**, com casos novos:
    - 3: ativação aprovada D1–D3 no schema;
    - 8: D3, com pagamento a +6 dias confirmando JANELA, a +8 dias indo para reconciliação sem efeito, retomada
      vencida recusada e prazo informado;
    - 9: D4, legado pago depois.
  - **091: 8/8**, com o caso 8 do Perfil PF. Ele pegou e motivou a correção de um `\d` perdido.
  - **Aplicadores reais 090/091: 1/1**, cobrindo conferência, privilégios e dono, parcial, falha real, preservação e
    anti-repetição.
  - **Regressão de 15 arquivos / 19 execuções: 19/19.** Rodou antes do caso 9 da 090, que só acrescentou um teste e
    foi rodado à parte, 9/9.
- `check:v1:static`: **PASS**, com 3278 + 103 testes, ESLint, TypeScript e build.
- Playwright `cpf-fundador-ui`: **7/7**, acrescentando o prazo "pague até" e o Perfil PF.

**Preexistente e não relacionado:** `scripts/concorrencia-vagas-isolado.test.cjs` (`INVENTARIO_MUDOU`, falha também na
base `326895e`).

**Pendente ou não executado:**
- Asaas sandbox.
- Staging e produção.
- Revisão independente.
- Liberação de reserva vencida: continua manual, com prova (sem ferramenta própria).

### Terceira rodada: correções da revisão independente

A revisão independente da faixa `326895e..2927d45` resultou em REPROVADO, por um bloqueante e alguns P2.

**Corrigido:**
- **Bloqueante, DV da 091:** passou para um gatilho só no INSERT. O precheck informa as linhas antigas com DV de CNPJ
  inválido, e uma linha legada com DV inválido continua atualizável (provado).
- **D3:**
  - data do pagamento: `clientPaymentDate` do boleto, depois a mais antiga das datas; sem relógio, e sem data o
    pagamento vai para reconciliação;
  - critério único por dia local na tela, na retomada e no pagamento;
  - código `FUNDADOR_OFERTA_EXPIRADA` visível no `ultimo_erro` e na reconciliação (`ERRO_FUNDADOR_OFERTA_EXPIRADA`,
    alarme), testado com o ciclo real.
- **Aplicadores:** preservação só de colunas imutáveis e até o corte, com NULL explícito e corte validado.
- **Prazo junto do link de pagamento:** o checkout devolve `fundadorValidoAte`, e o Playwright verifica.
- **Perfil PF:** provado pelo serviço `aplicarCadastroPerfil`. Sem CNPJ, grava NULL; PJ sem CNPJ é recusado.
- **Docs:** §11 do plano marcado como primeira rodada; alarme da reconciliação agora com teste.

**Bugs que os testes pegaram e foram corrigidos:**
- o `CASE` do gatilho novo referenciava um campo que a outra tabela não tem;
- o próprio teste fazia o UPDATE fora de ordem.

**Ajuste de expectativa:** um teste aceita a recusa do gatilho de DV no lugar da recusa do CHECK de formato para um
documento mascarado. A recusa continua; só mudou qual guarda chega primeiro.

**P3 da revisão ainda não tratados:**
- corrida LEGADO × ativação;
- ativação retroativa;
- ENCERRADA sem motivo obrigatório;
- concessão própria ignora a chave da campanha;
- site sem timeout de banco;
- concorrência da 20ª vaga sem espera observada;
- janela de 45 s;
- guarda de ordem fraca no teste `kidmais-gratuidade`.

(O lock da 091 foi tratado junto com o bloqueante.)

**Validação da terceira rodada** (commits `df7c48f`, `5306225`, `f2e0d5f`). Cluster descartável 55607, recriado e removido
no fim.
- Unitários: 332/332.
- Scripts: aplicadores, blocos, produção e reconciliação, 104/104.
- PG descartável:
  - 090: 9/9;
  - 091: 8/8;
  - aplicadores reais: 1/1;
  - regressão de 19 execuções: 19/19.
- Playwright: `cpf-fundador-ui` 7/7 e `cadastro-publico-ui` 8/8.
- `check:v1:static`: PASS (3280 + 103).
- Preexistente: `concorrencia-vagas-isolado`.
- Não executado: sandbox Asaas, staging/produção, nova revisão independente das correções.

### Quarta rodada: P3 das duas revisões independentes

A segunda revisão (das correções `2927d45..db39107`) foi **APROVADA** local, sem P1 nem P2. Os P3 dela e os da primeira
revisão foram tratados assim:

| P3 | Correção | Prova |
|---|---|---|
| Corrida LEGADO × ativação | A ativação toma a mesma trava da alocação (`kidmais:fundadores:2026`). Uma reserva LEGADO em andamento termina antes, ou espera e é recusada depois. O encerramento não toma a trava: a concessão segura a campanha com FOR SHARE, sem ciclo. | 090 caso 3 (espera observada no servidor; LEGADO recusada) |
| Ativação retroativa | No calendário, a guarda 090 e `ativarCampanhaAprovada` recusam data de abertura no passado. `HORARIO_EXATO` continua só para ensaio sintético. | 090 caso 3 |
| ENCERRADA sem motivo | O gatilho exige motivo (≥5) e o CHECK exige motivo em ENCERRADA. | 090 caso 3 |
| Concessão própria × chave e validade | Com a campanha ativada e a chave desligada, a concessão própria também bloqueia (`CAMPANHA_DESLIGADA`). Uma concessão própria reservada e vencida não gera oferta nova (`FUNDADOR_OFERTA_EXPIRADA`). | 090 caso 10 (chave desligada, reaproveitamento, vencida sem oferta aberta) |
| Site sem timeout | `resumoCampanhaSite` usa `statement_timeout` de 2 s e um limite de 2,5 s; se passar, usa o texto neutro. | `lib/site/fundador-servidor.test.ts` |
| Código cortado no relatório D-C4 | O formato passa a ser `ERRO_INTERNO: <CÓDIGO>`, que `motivoSeguro` preserva. Sem código de domínio, continua `ERRO_INTERNO: <nome>`. | `lib/assinatura/recusa-visivel.test.ts` |
| Chaves `ERRO_<código>` para todos os erros de domínio | Mudança intencional e documentada: o alarme não muda e não há consumidor no repositório. Um painel externo que contasse `ERRO_AcessoServiceError` precisa ser ajustado. | reconciliar.test 23/23 |
| Falso alarme por transação aberta antes do corte | Depois de ler o corte, o aplicador espera (só lendo, até 30 s) até nenhuma outra sessão ter transação aberta desde antes dele. Se não terminar, recusa ANTES de escrever (`TRANSACOES_ANTERIORES_AO_CORTE`). **Limite:** o papel precisa enxergar `xact_start` das outras sessões; sessões invisíveis não são esperadas. | unitário dos aplicadores; aplicador PG cenário 4a |
| Postcheck 091 só por nome | Confere também `tgtype = 7` (ROW, BEFORE, INSERT) e a função de guarda. A 090 passou a conferir tipo e função dos três gatilhos. | 091 caso 7b (gatilho adulterado recusado) |
| Rollback 091 parcial com erro genérico | Confere todos os objetos antes de qualquer DROP e recusa com "migration ausente ou parcial". | 091 caso 7b |
| Concorrência sem espera observada | "Mesma empresa" e "20ª vaga": uma terceira conexão segura a trava até as duas estarem esperando no servidor. | 090 casos 4 e 6 |
| Janela de 45 s | Passou para 90 s. | suíte 090 |
| Último dia perto da meia-noite; datas do caso 8 | As datas são relativas à validade de cada empresa. O bloco do último dia espera virar o dia se faltarem menos de 2 min. | 090 caso 8 |
| Reconciliação do caso 8 não presa à empresa | O ciclo roda só com a empresa testada, sem eventos: `{ERRO_FUNDADOR_OFERTA_EXPIRADA: 1}`. | 090 caso 8 |
| Guarda fraca em `kidmais-gratuidade` | Confere as recusas dentro do corpo de `iniciarTesteDaContratante`, antes da única chamada. | kidmais-gratuidade |

Os testes do aplicador real foram ajustados ao comportamento novo:
- tráfego aberto antes do corte gera recusa sem escrita;
- tráfego iniciado depois do corte, por um gancho que só existe no teste, gera a falha real por `lock_timeout` na migration.

### Quinta rodada: P3 restantes da revisão de `db39107..f0e72e9`

A revisão foi **APROVADA** local, sem P1 nem P2. Os P3 restantes foram tratados assim:

| P3 | Correção | Prova |
|---|---|---|
| Concessão própria sem teste | Cobre três situações: chave desligada (bloqueia); chave ligada (reaproveita a concessão, sem vaga nova); vencida sem oferta aberta (`FUNDADOR_OFERTA_EXPIRADA`). | 090 caso 10 |
| Formato antigo no texto do D3 | Corrigido para `ERRO_INTERNO: FUNDADOR_OFERTA_EXPIRADA`. A prova da concessão própria agora aponta o caso 10. | — |
| Tela × servidor com oferta aberta e chave desligada | A tela mostra a retomada, como o servidor já permitia. É um alinhamento técnico coerente com D1 (oferta persistida garante a condição), não uma decisão comercial nova. Oferta vencida continua recusada na retomada. | 090 caso 10 |
| Site segurando o pool | Uma única leitura em andamento por processo e cache de 30 s. Falha não fica guardada. | `fundador-servidor.test.ts` |
| Testes de concorrência travando a suíte | A terceira conexão e a transação da ativação são sempre fechadas em `finally`. | 090 casos 3, 4 e 6 |
| Espera do aplicador | Filtra só `client backend`. As sessões cujo detalhe o papel não enxerga são contadas e informadas (`esperaCorte.sessoesInvisiveis`), sem recusar. | unitário dos aplicadores |
| `HORARIO_EXATO` por SQL direto | Recusado nos bancos `kidmais_production` e `kidmais_staging_1z91`; lá vale só o calendário. Nos bancos de ensaio continua disponível para o teste de fronteira. | `campanha.test.ts` (prova estática: o banco descartável não pode ter esses nomes) |
| Prova de "esperar e seguir" | O aplicador real em PG espera uma transação aberta antes do corte, que é confirmada durante a espera, e aplica. | aplicador PG, passo 5 |
| Espera observada sem identificar a trava | Agora identifica a trava: `advisory` (LEGADO e 20ª vaga) e `transactionid`/`tuple` (mesma empresa). | 090 casos 3, 4 e 6 |

**Validação:**
- Unitários: 338/338.
- Scripts: 106/106.
- PG descartável: 090 10/10, aplicadores 1/1, regressão 19/19.
- Playwright: 7/7 e 8/8.
- `check:v1:static`: PASS (3286 + 103).
- Preexistente: `concorrencia-vagas-isolado`.

### Sexta rodada: revisão completa do Astra (`326895e..1b9cf5c`)

A revisão completa foi **REPROVADA**, com dois P2 reproduzidos e um P3 (relatório em
`revisao-cpf-fundador-completa-20261022/RELATORIO.md`, fora do checkout). Correções em `2a7275c` e `3a481f9`:

| Achado | Correção | Prova |
|---|---|---|
| P2-1: PF provisionada pelo painel chegava ao checkout com o nome do buffet + CPF | `exigirNomeCivil`: com CPF, o nome civil (`nome_empresarial`) é obrigatório ao provisionar, editar a ficha e iniciar o teste pelo painel. O checkout confere de novo (`semNomeCivil`) e recusa com `DADOS_INVALIDOS` (campo `nomeEmpresarial`) antes de criar o cliente. O rótulo do painel passou a "Nome empresarial / nome civil". | `identidade-fiscal.test.ts`; 091 caso 6; piloto em `comercial.postgres` |
| P2-2: trocar o CPF na ficha misturava o nome novo com o CPF do teste | Depois do teste, a ficha não troca nem apaga o documento (CPF A→B, CNPJ A→B, CPF↔CNPJ): `CONFLITO`, nada gravado. Voltar ao documento do teste e corrigir o nome continuam permitidos. O checkout compara o documento normalizado (não só o tipo): `DOCUMENTO_DIVERGENTE` sem criar cliente. | `identidade-fiscal.test.ts`; 091 caso 6 (CPF A→B) |
| P3-1: cache do site atravessava a mudança de fase | O cache dura no máximo até a próxima fronteira conhecida (abertura ou fim da janela). Usa o relógio do processo, então a defasagem para o banco continua valendo. O estoque pós-janela segue indicativo. | `fundador-servidor.test.ts` (P3-1) |

As mutações foram conferidas: com o código anterior, os testes de painel falham e o caso 6 do 091 recebe `OK` no lugar de
`DOCUMENTO_DIVERGENTE`.

**D3 e D5, pontos levantados pela revisão (sem mudança de código):**
- D3: a validade conta até o **fim do dia local** da data de reserva + 7 (uma reserva às 10h vale até 23h59 do 7º dia), ou seja, pode passar de 168 horas. É a interpretação do §2 e é o que a tela mostra. O texto comercial e jurídico precisa dizer isso com essa precisão.
- D5: a continuidade CPF→CNPJ e o vínculo declarado continuam sem fluxo operacional (atendimento). Agora o painel também recusa trocar documento do mesmo tipo.

**Validação:**
- Unitários: 406/406 (assinatura, cadastro, site, desenvolvedor, perfil, acessos).
- Scripts: 63/63 + blocos de Shell 20/20 (Git Bash).
- PG descartável 55607: 45/45 (090 10, 091 9, aplicadores 1, cobrança 7, gratuidade 5+5, painel comercial 8). Cluster removido.
- Playwright `cpf-fundador-ui`: 7/7.
- tsc, ESLint e build: PASS. `check:v1:static`: PASS (3291 + 103).
- Não executado: Asaas sandbox, staging/produção, revisão do delta pelo Astra.
