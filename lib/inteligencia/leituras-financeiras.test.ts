import assert from "node:assert/strict";
import test from "node:test";
import { criarAmbiente, EMPRESA_A, EMPRESA_B, IDS, PII } from "../../scripts/ia-benchmark/ambiente.ts";
import type { DbExecutor } from "../db/contracts.ts";
import type { TenantComprovado } from "../saas/provar-tenant.ts";
import type { AIResponse, RespostaLeitura } from "./contratos.ts";
import { ferramentaRegistrada, SEM_PORTAS, type ContextoFerramenta, type PortaFinanceiro, type PosicaoContratoDominio } from "./ferramentas.ts";
import { interpretarDeterministico } from "./intencao.ts";
import { manifestoLeitura, saidaValida } from "./registro-ferramentas.ts";

/** AI V1.1 — PR 5.5: saldo do contrato, próxima parcela e último contrato (números do Core, tenant fail-closed, sem escrita). */
type Consulta = { sql: string; values: readonly unknown[] };
function banco(linhas: (c: Consulta) => object[]) {
  const consultas: Consulta[] = [];
  const tx: DbExecutor = {
    async query<Row extends object>(sql: string, values: readonly unknown[] = []) {
      consultas.push({ sql, values });
      const rows = linhas({ sql, values }) as Row[];
      return { rows, rowCount: rows.length };
    },
  };
  return { tx, consultas };
}
const escrita = (sql: string) => /\b(insert|update|delete|merge|truncate|drop|alter)\b/i.test(sql);

const tenant = { empresaComprovada: EMPRESA_A } as TenantComprovado;
const HOJE = "2026-09-30";

/** Relações do contrato (prova de posse): só existe na EMPRESA_A. */
const relacoes = ({ sql, values }: Consulta) =>
  sql.includes("AS festa_id") && values[1] === EMPRESA_A && values[0] === IDS.CONTRATO_MARIA
    ? [{ id: IDS.CONTRATO_MARIA, status: "ASSINADO", numero_versao: 2, data: "2026-10-01", cliente_id: IDS.CLIENTE_ANA, cliente: "Ana Oliveira", festa_id: IDS.FESTA_MARIA }]
    : [];

function posicao(parcial: Partial<PosicaoContratoDominio> = {}): PosicaoContratoDominio {
  return {
    contratoId: IDS.CONTRATO_MARIA, obrigacaoCentavos: "450000", recebidoLiquidoCentavos: "330000", saldoACobrarCentavos: "120000", creditoCentavos: "0",
    encerrada: false, acertoAdministrativoPendente: false, parcelasAbertas: [{ numero: 3, vencimento: "2026-10-01", valorCentavos: "120000" }], ...parcial,
  };
}

function porta(resposta: PosicaoContratoDominio | "SEM_OBRIGACAO" | null) {
  const chamadas: Array<[string, string]> = [];
  const financeiro: PortaFinanceiro = { async posicaoContrato(_tx, empresaId, contratoId) { chamadas.push([empresaId, contratoId]); return resposta; } };
  return { chamadas, contexto: { hoje: HOJE, geradoEm: `${HOJE}T15:00:00Z`, portas: { ...SEM_PORTAS, financeiro } } as ContextoFerramenta };
}

async function ler(capacidade: string, parametros: unknown, tx: DbExecutor, ctx: ContextoFerramenta) {
  const f = ferramentaRegistrada(capacidade)!;
  const executar = f.preparar(parametros) as (tx: DbExecutor, t: TenantComprovado, c: ContextoFerramenta) => Promise<RespostaLeitura>;
  const r = await executar(tx, tenant, ctx);
  assert.equal(saidaValida(manifestoLeitura(f)!.saida, r), true, `${capacidade}: saída fora do schema`);
  return r;
}
const textos = (r: RespostaLeitura) => [r.resumo, ...r.fatos.map((f) => f.texto)].join(" | ");

// ---------------------------------------------------------------- saldo do contrato

test("saldo_contrato: pagamentos parciais — contratado, pago, em aberto e parcelas vêm do Core; entidade CONTRATO com relações", async () => {
  const { chamadas, contexto } = porta(posicao());
  const b = banco(relacoes);
  const r = await ler("saldo_contrato", { id: IDS.CONTRATO_MARIA }, b.tx, contexto);
  assert.equal(r.estado, "atencao");
  assert.equal(r.resumo, "Falta pagar R$ 1.200,00 de R$ 4.500,00 (Contrato V2 — Ana Oliveira — 01/10/2026).");
  const t = textos(r);
  for (const esperado of ["Valor contratado: R$ 4.500,00", "Valor pago (líquido): R$ 3.300,00", "Em aberto: R$ 1.200,00, em 1 parcela", "Situação: Em aberto."]) assert.ok(t.includes(esperado), esperado);
  assert.deepEqual(r.entidades, [{ tipo: "CONTRATO", id: IDS.CONTRATO_MARIA, rotulo: "Contrato V2 — Ana Oliveira — 01/10/2026", tela: "contrato", relacoes: { cliente: IDS.CLIENTE_ANA, festa: IDS.FESTA_MARIA } }]);
  assert.deepEqual(chamadas, [[EMPRESA_A, IDS.CONTRATO_MARIA]], "sempre a empresa comprovada");
  assert.ok(b.consultas.length > 0);
  assert.equal(b.consultas.some((c) => escrita(c.sql)), false, "nenhuma escrita no banco");
  assert.ok(b.consultas.every((c) => c.values.includes(EMPRESA_A)), "toda consulta filtra pela empresa comprovada");
});

test("saldo_contrato: quitado ⇒ em dia, sem parcela aberta; encerrado com acerto pendente é dito como tal", async () => {
  const quitado = await ler("saldo_contrato", { id: IDS.CONTRATO_MARIA }, banco(relacoes).tx, porta(posicao({ recebidoLiquidoCentavos: "450000", saldoACobrarCentavos: "0", parcelasAbertas: [] })).contexto);
  assert.equal(quitado.estado, "em_dia");
  assert.match(quitado.resumo, /quitado\.$/);
  assert.ok(textos(quitado).includes("Em aberto: R$ 0,00, em 0 parcelas"));
  const encerrado = await ler("saldo_contrato", { id: IDS.CONTRATO_MARIA }, banco(relacoes).tx, porta(posicao({ saldoACobrarCentavos: "0", encerrada: true, acertoAdministrativoPendente: true, parcelasAbertas: [] })).contexto);
  assert.ok(textos(encerrado).includes("acerto administrativo pendente"));
});

test("saldo_contrato / proxima_parcela: contrato sem obrigação financeira ⇒ sem_dados explícito, sem inventar valor", async () => {
  for (const capacidade of ["saldo_contrato", "proxima_parcela"]) {
    const r = await ler(capacidade, { id: IDS.CONTRATO_MARIA }, banco(relacoes).tx, porta("SEM_OBRIGACAO").contexto);
    assert.equal(r.estado, "sem_dados", capacidade);
    assert.match(r.resumo, /ainda não há plano financeiro registrado/);
    assert.equal(/R\$/.test(textos(r)), false, "nenhum valor sem plano");
  }
  // Sem porta financeira configurada: fail-closed para "sem dados", nunca um número.
  const semPorta = await ler("saldo_contrato", { id: IDS.CONTRATO_MARIA }, banco(relacoes).tx, { hoje: HOJE, geradoEm: `${HOJE}T15:00:00Z`, portas: SEM_PORTAS });
  assert.equal(semPorta.estado, "sem_dados");
});

test("contrato de outra empresa ou inexistente ⇒ 404 ANTES de ler a posição; id inválido e chaves de autoridade recusados", async () => {
  for (const capacidade of ["saldo_contrato", "proxima_parcela"]) {
    // Outra empresa: a prova de posse (relações) volta vazia; a porta nem é chamada.
    const outra = porta(posicao());
    await assert.rejects(ler(capacidade, { id: IDS.CONTRATO_PEDRO }, banco(relacoes).tx, outra.contexto), { httpStatus: 404 });
    assert.deepEqual(outra.chamadas, [], `${capacidade}: posição não lida sem posse`);
    // Posse ok nas relações, mas a porta (que revalida a posse) diz inexistente ⇒ 404 também.
    await assert.rejects(ler(capacidade, { id: IDS.CONTRATO_MARIA }, banco(relacoes).tx, porta(null).contexto), { httpStatus: 404 });
    const entrada = ferramentaRegistrada(capacidade)!.entrada;
    for (const ruim of [{ id: "nao-uuid" }, { id: `${IDS.CONTRATO_MARIA}' OR 1=1` }, { id: IDS.CONTRATO_MARIA, empresaId: EMPRESA_B }, { id: IDS.CONTRATO_MARIA, tenantId: EMPRESA_B }, { id: IDS.CONTRATO_MARIA, unidadeId: EMPRESA_B }, { id: IDS.CONTRATO_MARIA, valor: 1 }]) {
      assert.equal(entrada.safeParse(ruim).success, false, `${capacidade} ${JSON.stringify(ruim)}`);
    }
  }
  assert.equal(ferramentaRegistrada("saldo_contrato")!.entrada.safeParse({}).success, false, "saldo exige contrato");
});

// ---------------------------------------------------------------- próxima parcela

test("proxima_parcela do contrato: escolhida pelo vencimento (>= hoje); vencidas contadas à parte", async () => {
  const abertas = [
    { numero: 1, vencimento: "2026-09-25", valorCentavos: "250000" },
    { numero: 2, vencimento: "2026-10-02", valorCentavos: "250000" },
    { numero: 3, vencimento: "2026-11-02", valorCentavos: "100000" },
  ];
  const r = await ler("proxima_parcela", { id: IDS.CONTRATO_MARIA }, banco(relacoes).tx, porta(posicao({ parcelasAbertas: abertas })).contexto);
  assert.equal(r.estado, "atencao");
  assert.match(r.resumo, /^A próxima parcela a vencer é a 2ª, em 02\/10\/2026, de R\$ 2\.500,00/);
  assert.ok(textos(r).includes("1 parcela vencida em aberto."));
  // Vence hoje conta como futura (não vencida).
  const hoje = await ler("proxima_parcela", { id: IDS.CONTRATO_MARIA }, banco(relacoes).tx, porta(posicao({ parcelasAbertas: [{ numero: 4, vencimento: HOJE, valorCentavos: "5000" }] })).contexto);
  assert.equal(hoje.estado, "informativo");
  assert.match(hoje.resumo, /4ª, em 30\/09\/2026, de R\$ 50,00/);
  // Só vencidas: nada a vencer, mas o atraso aparece.
  const soVencidas = await ler("proxima_parcela", { id: IDS.CONTRATO_MARIA }, banco(relacoes).tx, porta(posicao({ parcelasAbertas: [abertas[0]] })).contexto);
  assert.deepEqual([soVencidas.estado, /Há 1 vencida em aberto/.test(soVencidas.resumo)], ["atencao", true]);
  // Nenhuma parcela em aberto: sem_dados explícito.
  const nenhuma = await ler("proxima_parcela", { id: IDS.CONTRATO_MARIA }, banco(relacoes).tx, porta(posicao({ saldoACobrarCentavos: "0", parcelasAbertas: [] })).contexto);
  assert.equal(nenhuma.estado, "sem_dados");
  assert.match(nenhuma.resumo, /^Não há parcela a vencer em Contrato V2/);
});

test("proxima_parcela da empresa: mesma fonte de Contas a receber, empresa comprovada, ordem por vencimento", async () => {
  const amb = criarAmbiente();
  const [o] = await amb.conversar({ id: "pp-teste", categoria: "pagamentos", turnos: [{ texto: "Qual é a próxima parcela?" }], esperado: { entendimento: "EXECUTADO" }, pr: "PR5" });
  const r = (o.resposta as Extract<AIResponse, { tipo: "resposta" }>).dados as RespostaLeitura;
  assert.equal(r.resumo, "A próxima parcela a vencer é a 3ª, em 01/10/2026, de R$ 1.200,00 (Ana Oliveira).");
  assert.ok(textos(r).includes("1 parcela vencida em aberto."), "a 1ª do Pedro (25/09) está vencida");
  assert.deepEqual(amb.violacoes.crossTenant, []);
});

// ---------------------------------------------------------------- último contrato

const recente = (id: string, criadoEm: string, cliente: string) => ({ id, status: "ASSINADO", criado_em: criadoEm, cliente, cliente_id: IDS.CLIENTE_ANA, data: "2026-10-01", festa_id: null });

test("ultimo_contrato: critério do painel (criado_em DESC, sem cancelados), empresa comprovada, limite fixo", async () => {
  const b = banco(({ sql }) => (sql.includes("ORDER BY c.criado_em DESC") ? [recente(IDS.CONTRATO_PEDRO, "2026-09-05 15:30:00+00", "Carla Souza"), recente(IDS.CONTRATO_MARIA, "2026-08-10 10:00:00+00", "Ana Oliveira")] : []));
  const r = await ler("ultimo_contrato", {}, b.tx, porta(null).contexto);
  assert.equal(r.resumo, "O contrato mais recente é Contrato — Carla Souza — 01/10/2026.");
  assert.deepEqual(r.entidades?.map((e) => [e.tipo, e.id]), [["CONTRATO", IDS.CONTRATO_PEDRO]]);
  assert.ok(textos(r).includes("Criado em 05/09/2026"));
  assert.match(b.consultas[0].sql, /ORDER BY c\.criado_em DESC, c\.id DESC/);
  assert.match(b.consultas[0].sql, /c\.status <> 'CANCELADO'/);
  assert.deepEqual(b.consultas[0].values, [false, EMPRESA_A, 2]);
  assert.equal(escrita(b.consultas[0].sql), false, "nenhuma escrita no banco");
  const comCancelados = banco(() => []);
  await ler("ultimo_contrato", { incluirCancelados: true }, comCancelados.tx, porta(null).contexto);
  assert.deepEqual(comCancelados.consultas[0].values, [true, EMPRESA_A, 2]);
  const entrada = ferramentaRegistrada("ultimo_contrato")!.entrada;
  for (const ruim of [{ empresaId: EMPRESA_B }, { limite: 50 }, { ordem: "ASC" }, { sql: "select 1" }]) assert.equal(entrada.safeParse(ruim).success, false, JSON.stringify(ruim));
});

test("ultimo_contrato: nenhum contrato ⇒ sem_dados; empate no instante ⇒ os dois, sem escolher", async () => {
  const nenhum = await ler("ultimo_contrato", {}, banco(() => []).tx, porta(null).contexto);
  assert.deepEqual([nenhum.estado, nenhum.entidades], ["sem_dados", []]);
  assert.equal(nenhum.resumo, "Ainda não há contratos registrados.");
  const instante = "2026-09-05 15:30:00+00";
  const empate = await ler("ultimo_contrato", {}, banco(() => [recente(IDS.CONTRATO_PEDRO, instante, "Carla Souza"), recente(IDS.CONTRATO_MARIA, instante, "Ana Oliveira")]).tx, porta(null).contexto);
  assert.match(empate.resumo, /^Dois contratos foram criados no mesmo instante/);
  assert.deepEqual(empate.entidades?.map((e) => e.id), [IDS.CONTRATO_PEDRO, IDS.CONTRATO_MARIA]);
});

// ---------------------------------------------------------------- roteamento, trace e escrita

test("roteamento: 'último contrato' e 'próxima parcela' vão às leituras novas (sem tela, nível empresa)", () => {
  assert.equal((interpretarDeterministico("Qual foi o último contrato?", null) as { capacidade?: string }).capacidade, "ultimo_contrato");
  assert.equal((interpretarDeterministico("Qual é a próxima parcela?", null) as { capacidade?: string }).capacidade, "proxima_parcela");
});

test("conversa: saldo, parcela e último contrato — trace sem PII e sem valores monetários; nenhuma escrita; nada de outra empresa", async () => {
  const amb = criarAmbiente();
  const obs = await amb.conversar({
    id: "fin-trace", categoria: "pagamentos", pr: "PR5", esperado: { entendimento: "EXECUTADO" },
    turnos: [
      { texto: "Quanto falta pagar deste contrato?", contexto: { tela: "contrato", entidade: "CONTRATO_MARIA" } },
      { texto: "Qual é a próxima parcela deste contrato?", contexto: { tela: "contrato", entidade: "CONTRATO_PEDRO" } },
      { texto: "Qual foi o último contrato?" },
    ],
  });
  const resumos = obs.map((o) => ((o.resposta as Extract<AIResponse, { tipo: "resposta" }>).dados as RespostaLeitura).resumo);
  assert.match(resumos[0], /^Falta pagar R\$ 1\.200,00 de R\$ 4\.500,00/);
  assert.match(resumos[1], /^A próxima parcela a vencer é a 2ª, em 02\/10\/2026, de R\$ 2\.500,00/);
  assert.match(resumos[2], /^O contrato mais recente é Contrato — Carla Souza/);
  for (const o of obs) {
    const trace = JSON.stringify(o.rastro);
    for (const proibido of [...PII, "Ana Oliveira", "Carla Souza", "R$", "1.200,00", "4.500,00", "2.500,00", "120000", "450000", "250000"]) {
      assert.equal(trace.includes(proibido), false, `trace contém ${proibido}`);
    }
  }
  assert.deepEqual([amb.violacoes.mutacoes, amb.violacoes.operacoesExecutadas, amb.violacoes.crossTenant], [[], 0, []]);
});
