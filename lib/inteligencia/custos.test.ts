import assert from "node:assert/strict";
import test from "node:test";
import type { DbExecutor } from "../db/contracts.ts";
import { lerUsoAgrupado } from "../ia-persistencia/uso.ts";
import type { SessaoParaTenant, TenantComprovado } from "../saas/provar-tenant.ts";
import { atenderCustos, consolidarCustos, type DependenciasCustos, type UsoAgrupadoLido } from "./custos.ts";
import type { RastreioInteligencia } from "./rastreio.ts";

const MES = "2026-09";
const uso = (extra: Partial<UsoAgrupadoLido>): UsoAgrupadoLido => ({
  estabelecimentoId: null, capacidade: "copiloto_explicar", provedor: "OPENAI", modelo: "m1", dia: "2026-09-29", mes: MES, moeda: "USD",
  chamadas: 2, tokensEntrada: 100, tokensSaida: 20, tokensDesconhecidos: 0, custoMicros: 500, custoDesconhecido: 0, ...extra,
});

// ---------------------------------------------------------------- consolidação pura

test("Custos: soma por empresa, estabelecimento, capacidade, modelo e dia quando tudo é conhecido", () => {
  const v = consolidarCustos({ disponivel: true, usos: [uso({}), uso({ capacidade: "jev_classificar", modelo: "m2", dia: "2026-09-28", custoMicros: 100, chamadas: 1 })], reservas: [] }, MES, "USD");
  assert.deepEqual(v.total, { chamadas: 3, tokens: 240, custoMicros: 600, desconhecidos: 0 });
  assert.equal(v.porCapacidade.copiloto_explicar.custoMicros, 500);
  assert.equal(v.porModelo["OPENAI:m2"].custoMicros, 100);
  assert.equal(v.porDia["2026-09-28"].chamadas, 1);
  assert.equal(v.porEstabelecimento.EMPRESA.chamadas, 3);
});

test("Custos: preço desconhecido, moeda diferente ou pricing ausente NUNCA viram zero", () => {
  const desconhecido = consolidarCustos({ disponivel: true, usos: [uso({}), uso({ capacidade: "x", custoMicros: 0, custoDesconhecido: 2 })], reservas: [] }, MES, "USD");
  assert.equal(desconhecido.total.custoMicros, null);
  assert.equal(desconhecido.total.desconhecidos, 2);
  assert.equal(desconhecido.porCapacidade.copiloto_explicar.custoMicros, 500, "o grupo conhecido continua conhecido");
  assert.equal(desconhecido.porCapacidade.x.custoMicros, null);

  const outraMoeda = consolidarCustos({ disponivel: true, usos: [uso({ moeda: "BRL" })], reservas: [] }, MES, "USD");
  assert.equal(outraMoeda.total.custoMicros, null);
  assert.equal(outraMoeda.total.desconhecidos, 2);

  const semPricing = consolidarCustos({ disponivel: true, usos: [uso({})], reservas: [] }, MES, null);
  assert.equal(semPricing.total.custoMicros, null);

  const semTokens = consolidarCustos({ disponivel: true, usos: [uso({ tokensDesconhecidos: 1 })], reservas: [] }, MES, "USD");
  assert.equal(semTokens.total.tokens, null);
});

test("Custos: reservas abertas aparecem como consumo comprometido, à parte; outro mês é ignorado", () => {
  const v = consolidarCustos({
    disponivel: true,
    usos: [uso({}), uso({ mes: "2026-08", dia: "2026-08-31" })],
    reservas: [{ capacidade: "copiloto_explicar", dia: "2026-09-29", moeda: "USD", reservas: 1, tokens: 800, custoMicros: 90, custoDesconhecido: 0 }],
  }, MES, "USD");
  assert.equal(v.total.chamadas, 2);
  assert.deepEqual(v.reservado, { reservas: 1, tokens: 800, custoMicros: 90, desconhecidos: 0 });
  const sem = consolidarCustos({ disponivel: true, usos: [], reservas: [{ capacidade: "c", dia: "2026-09-29", moeda: "USD", reservas: 1, tokens: 1, custoMicros: 0, custoDesconhecido: 1 }] }, MES, "USD");
  assert.equal(sem.reservado.custoMicros, null);
});

test("Custos: sem tabelas de uso ⇒ indisponível com null (não zero)", () => {
  const v = consolidarCustos({ disponivel: false, usos: [], reservas: [] }, MES, "USD");
  assert.equal(v.disponivel, false);
  assert.equal(v.total.custoMicros, null);
  assert.equal(v.total.tokens, null);
});

// ---------------------------------------------------------------- persistência (somente leitura, empresa no WHERE)

test("Persistência: lê só tabelas ia_* da empresa informada, sem escrita; sem tabela ⇒ indisponível", async () => {
  const consultas: Array<{ sql: string; values: readonly unknown[] }> = [];
  const tx = (existe: boolean): DbExecutor => ({
    async query<Row extends object>(sql: string, values: readonly unknown[] = []) {
      consultas.push({ sql, values });
      if (sql.includes("to_regclass")) return { rows: [{ ok: existe }] as unknown as Row[], rowCount: 1 };
      return { rows: [] as Row[], rowCount: 0 };
    },
  });
  assert.deepEqual(await lerUsoAgrupado(tx(false), "e1", MES), { disponivel: false, usos: [], reservas: [] });
  consultas.length = 0;
  await lerUsoAgrupado(tx(true), "e1", MES);
  for (const c of consultas.slice(1)) {
    assert.match(c.sql, /WHERE empresa_id = \$1::uuid AND periodo_mes = \$2/);
    assert.deepEqual(c.values, ["e1", MES]);
  }
  assert.ok(consultas.every((c) => !/\b(INSERT|UPDATE|DELETE)\b/.test(c.sql)));
});

// ---------------------------------------------------------------- endpoint

const EMPRESA = "11111111-1111-4111-8111-111111111111";
const sessao = { id: "s", usuario_id: "aaaaaaaa-0000-4000-8000-000000000001", nome: "N", cargo: null, papel: "REPRESENTANTE_AUTORIZADO", autenticado_em: "", expira_em: "", csrf_hash: "" } as unknown as SessaoParaTenant;

function montar(papelAtual: string, env: Record<string, string> = { INTELIGENCIA_ENABLED: "true" }) {
  const leituras: Array<[string, string]> = [];
  const rastros: RastreioInteligencia[] = [];
  const deps: DependenciasCustos = {
    env,
    autenticar: async () => sessao,
    withTenantTransaction: async (_s, _e, work) => work({} as never, { empresaComprovada: EMPRESA, membershipId: "m", usuarioId: sessao.usuario_id, papelAtual } as unknown as TenantComprovado),
    lerUso: async (_tx, empresaId, mes) => { leituras.push([empresaId, mes]); return { disponivel: true, usos: [uso({})], reservas: [] }; },
    moeda: () => "USD",
    agora: () => new Date("2026-09-29T12:00:00Z"),
    requestId: () => "req",
    registrar: (r) => rastros.push({ ...r }),
    relogio: () => 0,
  };
  return { deps, leituras, rastros };
}
const pedir = (deps: DependenciasCustos, corpo: unknown = {}) => atenderCustos({ lerCorpo: async () => corpo, empresaSolicitada: EMPRESA }, deps);

test("Endpoint: Gestão da empresa comprovada vê a visão do mês; empresa vem do Tenant Context", async () => {
  const m = montar("REPRESENTANTE_AUTORIZADO");
  const r = await pedir(m.deps);
  assert.equal(r.status, 200, JSON.stringify(r.corpo));
  assert.deepEqual(m.leituras, [[EMPRESA, "2026-09"]]);
  assert.equal(m.rastros[0].evento, "inteligencia.custos");
  assert.equal(m.rastros[0].politica, "PERMITIDO");
});

test("Endpoint: papel operacional nesta empresa ⇒ 403 sem ler uso; empresa no corpo ⇒ 400; flag off ⇒ 503", async () => {
  const operacional = montar("ADMINISTRATIVO");
  assert.equal((await pedir(operacional.deps)).status, 403);
  assert.equal(operacional.leituras.length, 0);

  const outra = montar("REPRESENTANTE_AUTORIZADO");
  assert.equal((await pedir(outra.deps, { empresaId: "22222222-2222-4222-8222-222222222222" })).status, 400);
  assert.equal((await pedir(outra.deps, { mes: "2026-13" })).status, 400);
  assert.equal(outra.leituras.length, 0);

  const desligada = montar("REPRESENTANTE_AUTORIZADO", {});
  assert.equal((await pedir(desligada.deps)).status, 503);
});
