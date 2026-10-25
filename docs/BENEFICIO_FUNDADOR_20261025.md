# Situação atual do benefício Fundador: Gestão e desenvolvedor (25/10/2026)

**Estado: IMPLEMENTADO LOCAL.** Commit `99428cf9` sobre `staging` `6c16a965`, na branch `codex/beneficio-fundador-20261025`.
- Sem push, PR, deploy, migration, flag, banco real ou SQL em staging.
- **Aguarda revisão independente.**

**Origem:**
- smoke de pagamento PF em staging (25/10), que confirmou a assinatura, mas não conseguiu observar pelo produto a confirmação Fundador nem as datas do benefício;
- `DIAGNOSTICO-BENEFICIO-FUNDADOR.md`, somente leitura, que mostrou que nenhum endpoint ou painel expunha esses dados;
- autorização de Felipe para implementar localmente.

## O que mudou

| Onde | O quê |
|---|---|
| `lib/assinatura/beneficio-fundador.ts` (novo) | Leitura da concessão: `situacao` (`RESERVADA`, `CONFIRMADA_VIGENTE` ou `ENCERRADA`), `reservadaEm`, `confirmadaEm`, `beneficioFim` e a oferta vinculada (`contratacaoId` e `contratacaoEstado`). A versão do desenvolvedor acrescenta `vaga` e `origem`. |
| `lib/assinatura/consulta.ts` | `GET /api/admin/assinatura` ganha `fundador`, só para a Gestão (`REPRESENTANTE_AUTORIZADO`) e com assinatura, mesmo critério de `contratacao`. A Equipe recebe `null`. |
| `components/admin/AssinaturaAcoes.tsx` e `Assinatura.tsx` | Bloco próprio `data-beneficio-fundador`, fora do link "Ver comprovante da contratação", com o texto da situação e a nota "O comprovante registra as condições aceitas na contratação; esta é a situação atual do benefício." |
| `lib/desenvolvedor/comercial.ts` e `components/desenvolvedor/ComercialEmpresa.tsx` | Seção "Fundador" na ficha da empresa: situação, vaga, fase, datas e oferta. |
| `lib/assinatura/textos-fundador.ts` | `dataHoraBrasilia`, `textoBeneficioFundador` e `NOTA_COMPROVANTE_BENEFICIO`. |
| `scripts/regressao-v1-selecao.cjs` | A suíte nova no modelo 089. |

### Regras

**Isolamento:**
- a consulta usa `WHERE f.empresa_id = $1::uuid AND f.estado <> 'LIBERADA'`, que dá no máximo uma linha pelo índice único por empresa;
- a contratação só entra se for da mesma empresa e da mesma concessão (`o.empresa_id = f.empresa_id AND o.fundador_id = f.id`, não cancelada), preferindo a atual da assinatura e depois a em aberto;
- a empresa vem de `tenant.empresaComprovada` (Gestão) ou do `empresaId` da ficha já autorizada (desenvolvedor), nunca do corpo da requisição.

**Datas e cálculo:**
- devolve as datas **persistidas**; o fim continua sendo calculado só pelo gatilho 074a (confirmação + 12 meses, em UTC);
- nada é recalculado nem gravado.

**Situação:**
- reservada → `RESERVADA`;
- confirmada com fim maior que o relógio do banco → `CONFIRMADA_VIGENTE`;
- confirmada com o fim já alcançado → `ENCERRADA`. É a mesma regra de `situacaoFundador`, então no instante do fim já conta como encerrada.

**Dados excluídos:** nunca seleciona `documento_beneficiario` nem `pagamento_confirmacao_id`.

**Compatibilidade:**
- sem a 074a, devolve `null` e a tela não muda (comportamento anterior);
- sem a 090, a fase vem nula.

**Apresentação:**
- datas em `America/Sao_Paulo` ("25/10/2026 às 07:22"); o cálculo fica em UTC;
- reservada: "Condição Fundador reservada, ainda não confirmada…", nunca "confirmada" nem "vigente";
- confirmada sem datas, um dado incoerente: não é apresentada.

**Comprovante:** intocado. Continua dizendo `fundador: { reservada: true, pagueAte }`, o retrato do aceite.

## Validação local (sem mutação, clone de trabalho)

- **Unitários e render:** 31/31, incluindo os testes anteriores de Fundador, renovação e continuidade.
  - `lib/assinatura/beneficio-fundador.test.ts` (executor falso): guarda de schema, filtro de empresa, ausência de escrita e de recálculo, fase com e sem a 090, projeção da Gestão, horário de Brasília com virada do dia e textos.
  - `components/admin/assinatura-beneficio-fundador-ui.test.ts` (componentes reais): Gestão vigente, reservada e encerrada; virada do dia; ausência sem dado, para a Equipe ou com dado incoerente; ficha do desenvolvedor.
- **PostgreSQL descartável** (cluster próprio 55613, modelo 089), `lib/assinatura/beneficio-fundador.postgres.test.ts`, 5/5:
  1. sem a 090 e sem a 096: reservada (nunca confirmada); Gestão × Equipe; empresa sem concessão; leitura em `READ ONLY`;
  2. com a 096: **confirmação pelo caminho do produto** (`sincronizarEmpresa` com provedor falso). As datas devolvidas são iguais às persistidas, e o fim é igual à confirmação + 12 meses UTC. Oferta vinculada, comprovante idêntico antes e depois da confirmação, isolamento A × B × C, sem documento nem id do pagamento;
  3. concessão liberada não aparece;
  4. limites do prazo: fim no futuro dá vigente; fim no instante da gravação, já alcançado na leitura, dá encerrada; fim no passado dá encerrada; retrato das tabelas igual antes e depois das leituras;
  5. com a 090: o desenvolvedor vê a fase `LEGADO` e a vaga; a Gestão recebe só os seis campos.
- **Bateria PostgreSQL completa:** 142 arquivos, 828/832, com 4 pulados de propósito (como antes).
- **CI local:** os 24 passos de `.github/workflows/ci.yml` (além do `npm ci`) com saída 0; `check:v1:static` com build.

### Mutantes, em cópia isolada (`mutacao-beneficio-fundador-20261025`, clone LF + `npm ci`)

Controle positivo antes e depois com saída 0; cópia limpa ao fim; clone de trabalho intocado.

| Mutante | Detectado por |
|---|---|
| M1 sem filtro de empresa | unit (consulta) + PG 1–4 |
| M2 liberada exibida | unit + PG 3 |
| M3 reserva como confirmada | PG 1, 2, 4 |
| M4 fim recalculado | unit + PG 1, 2, 4 |
| M5 encerrada como vigente | unit + PG 4 |
| M6 documento vazado | unit + PG 1, 2, 5 |
| M7 Equipe recebe o benefício | PG 1; o caso 2 cai em cascata, porque a empresa C não chega a ser criada |
| M8 sem guarda de schema | unit |
| M9 horário em UTC | unit + render |
| M10 bloco acoplado ao comprovante | render |
| M11 desenvolvedor vê reserva como confirmada | render |

## Limitações

- **Tempo simulado no caso 4:** a fixture desloca as datas persistidas com `session_replication_role = replica`, só no cluster descartável e só para simular a passagem do tempo; a coerência (CHECK) continua valendo. O produto nunca move datas.
- **Instante exato do fim:** o caso de igualdade com o relógio não é reproduzível, porque o relógio avança entre a gravação e a leitura. A regra está no SQL (`>`) e o mutante M5 cobre a direção.
- **Staging:** as datas reais da `TESTE contratacao CPF - 20261025` continuam **não comprovadas** até esta mudança ser publicada e conferida pela tela ou pela API.
- **Renovação Fundador não agendada:** é a pendência separada do diagnóstico, fora desta tarefa. Nada aqui configura cron nem executa a rotina.
- **Revisão independente (Astra, 25/10):** APROVADO COM RESSALVAS, sem P1/P2; a reexecução PostgreSQL do revisor não rodou (EACCES no cluster novo dele), então os 5/5 PG seguem só desta implementação. **P3-T1 fechado:** o teste de render passou a exigir o bloco com benefício confirmado e sem comprovante (contratação nula ou comprovante nulo), unit+render 32/32; o mutante "bloco exige comprovante" (M12) é detectado na cópia isolada. Oportunidades não bloqueantes registradas pelo revisor: casos PG de reserva só com contratação cancelada e de várias contratações da mesma concessão.
- **Estilo:** o bloco usa só os estilos já existentes (`workspace.muted`); nenhuma mudança visual foi validada no navegador além do render estático.
