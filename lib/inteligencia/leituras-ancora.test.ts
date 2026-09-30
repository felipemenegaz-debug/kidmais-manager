import assert from "node:assert/strict";
import test from "node:test";
import { criarAmbiente, EMPRESA_A, EMPRESA_B, IDS, PII } from "../../scripts/ia-benchmark/ambiente.ts";
import { relacoesContratoDoTenant } from "../contratos/services/leitura-tenant.ts";
import type { DbExecutor } from "../db/contracts.ts";
import { padraoBusca } from "../comercial/catalogo-leitura.ts";
import { festaDoTenant, festasDoTenant } from "../festas/leitura-tenant.ts";
import type { TenantComprovado } from "../saas/provar-tenant.ts";
import type { AIResponse, RespostaLeitura } from "./contratos.ts";
import { ferramentaRegistrada, SEM_PORTAS, type ContextoFerramenta } from "./ferramentas.ts";
import { interpretarDeterministico } from "./intencao.ts";
import { manifestoLeitura, saidaValida } from "./registro-ferramentas.ts";

/** AI V1.1 — PR 4: leituras-âncora e relações (entidades estruturadas do Core, sem escrita, tenant fail-closed). */
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

const festa = (id: string, data: string, extra: object = {}) => ({
  id, data, hora: "14:00:00", hora_fim: "18:00:00", cliente: "Ana Oliveira", pacote: "Premium", convidados: 60, status: "ASSINADO",
  cliente_id: IDS.CLIENTE_ANA, contrato_id: IDS.CONTRATO_MARIA, numero_versao: 2, ...extra,
});
const tenant = { empresaComprovada: EMPRESA_A } as TenantComprovado;
const contexto: ContextoFerramenta = { hoje: "2026-09-30", geradoEm: "2026-09-30T15:00:00Z", portas: SEM_PORTAS };

async function ler(capacidade: string, parametros: unknown, tx: DbExecutor, ctx: ContextoFerramenta = contexto) {
  const f = ferramentaRegistrada(capacidade)!;
  const executar = f.preparar(parametros) as (tx: DbExecutor, t: TenantComprovado, c: ContextoFerramenta) => Promise<RespostaLeitura>;
  const r = await executar(tx, tenant, ctx);
  assert.equal(saidaValida(manifestoLeitura(f)!.saida, r), true, `${capacidade}: saída fora do schema`);
  return r;
}

// ---------------------------------------------------------------- Core

test("Core: próximas festas ASC a partir de hoje, últimas DESC; empresa comprovada como 1º parâmetro; limite limitado", async () => {
  const b = banco(() => []);
  await festasDoTenant(b.tx, EMPRESA_A, { ordem: "ASC", inicio: "2026-09-30", fim: null, limite: 5 });
  await festasDoTenant(b.tx, EMPRESA_A, { ordem: "DESC", inicio: null, fim: "2026-09-29", limite: 9999 });
  assert.match(b.consultas[0].sql, /ORDER BY fech\.data_evento ASC/);
  assert.match(b.consultas[1].sql, /ORDER BY fech\.data_evento DESC/);
  assert.deepEqual(b.consultas[0].values, [EMPRESA_A, "2026-09-30", null, 5, false]);
  assert.equal(b.consultas[1].values[3], 200, "limite nunca passa de 200");
  for (const c of b.consultas) {
    assert.match(c.sql, /pac\.empresa_id = \$1::uuid/);
    assert.match(c.sql, /festa\.invalidada_em IS NULL/);
    assert.equal(escrita(c.sql), false);
  }
});

test("Core: festa e contrato de outra empresa ⇒ null (inexistente); relações vêm das chaves do Core", async () => {
  const vazio = banco(() => []);
  assert.equal(await festaDoTenant(vazio.tx, EMPRESA_B, IDS.FESTA_MARIA), null);
  assert.equal(await relacoesContratoDoTenant(vazio.tx, EMPRESA_B, IDS.CONTRATO_MARIA), null);
  assert.deepEqual(vazio.consultas.map((c) => c.values.includes(EMPRESA_B)), [true, true]);
  const um = banco(() => [festa(IDS.FESTA_MARIA, "2026-10-01")]);
  const f = await festaDoTenant(um.tx, EMPRESA_A, IDS.FESTA_MARIA);
  assert.deepEqual([f?.clienteId, f?.contratoId, f?.versaoVigente], [IDS.CLIENTE_ANA, IDS.CONTRATO_MARIA, 2]);
});

// ---------------------------------------------------------------- ferramentas

test("proximas_festas: única, nenhuma futura e múltiplas — entidades FESTA com relações cliente/contrato", async () => {
  const unica = await ler("proximas_festas", { limite: 1 }, banco(() => [festa(IDS.FESTA_MARIA, "2026-10-01")]).tx);
  assert.equal(unica.entidades?.length, 1);
  assert.deepEqual(unica.entidades?.[0], {
    tipo: "FESTA", id: IDS.FESTA_MARIA, rotulo: "Festa de Ana Oliveira — 01/10/2026 às 14:00", tela: "festa",
    relacoes: { contrato: IDS.CONTRATO_MARIA, cliente: IDS.CLIENTE_ANA },
  });
  assert.match(unica.resumo, /^A próxima festa é em 01\/10\/2026 às 14:00, cliente Ana Oliveira\.$/);
  assert.equal(unica.itens[0].destino, `/admin/festas/${IDS.FESTA_MARIA}`);

  const nenhuma = await ler("proximas_festas", {}, banco(() => []).tx);
  assert.deepEqual([nenhuma.estado, nenhuma.entidades], ["sem_dados", []]);
  assert.match(nenhuma.resumo, /Não há festas futuras/);

  const varias = await ler("proximas_festas", { limite: 3 }, banco(() => [festa(IDS.FESTA_MARIA, "2026-10-01"), festa(IDS.FESTA_PEDRO, "2026-10-03", { cliente: "Carla Souza", cliente_id: IDS.CLIENTE_CARLA, contrato_id: IDS.CONTRATO_PEDRO })]).tx);
  assert.deepEqual(varias.entidades?.map((e) => e.id), [IDS.FESTA_MARIA, IDS.FESTA_PEDRO], "ordem cronológica do Core preservada");
});

test("proximas_festas: 'últimas' vão até ONTEM; intervalo e limite validados; entrada nunca aceita tenant", async () => {
  const b = banco(() => []);
  await ler("proximas_festas", { ordem: "DESC", limite: 1 }, b.tx);
  assert.deepEqual(b.consultas[0].values.slice(1, 4), [null, "2026-09-29", 1]);
  const entrada = ferramentaRegistrada("proximas_festas")!.entrada;
  for (const ruim of [
    { limite: 0 }, { limite: 21 }, { ordem: "RANDOM" }, { inicio: "2026-13-01" }, { inicio: "30/09/2026" },
    { inicio: "2026-10-10", fim: "2026-10-01" }, { inicio: "2026-01-01", fim: "2027-06-01" },
    { empresaId: EMPRESA_B }, { tenantId: EMPRESA_B }, { unidadeId: EMPRESA_B }, { estabelecimentoId: EMPRESA_B }, { sql: "select 1" },
  ]) assert.equal(entrada.safeParse(ruim).success, false, JSON.stringify(ruim));
});

test("relacoes_festa / relacoes_contrato: FESTA→CLIENTE, FESTA→CONTRATO, CONTRATO→CLIENTE/FESTA; inexistente ⇒ 404; id inválido recusado", async () => {
  const f = await ler("relacoes_festa", { id: IDS.FESTA_MARIA }, banco(() => [festa(IDS.FESTA_MARIA, "2026-10-01")]).tx);
  assert.deepEqual(f.entidades?.map((e) => [e.tipo, e.id]), [["FESTA", IDS.FESTA_MARIA], ["CLIENTE", IDS.CLIENTE_ANA], ["CONTRATO", IDS.CONTRATO_MARIA]]);
  assert.deepEqual(f.entidades?.[2].relacoes, { festa: IDS.FESTA_MARIA, cliente: IDS.CLIENTE_ANA });

  const c = await ler("relacoes_contrato", { id: IDS.CONTRATO_MARIA }, banco(() => [{ id: IDS.CONTRATO_MARIA, status: "ASSINADO", numero_versao: 2, data: "2026-10-01", cliente_id: IDS.CLIENTE_ANA, cliente: "Ana Oliveira", festa_id: IDS.FESTA_MARIA }]).tx);
  assert.deepEqual(c.entidades?.[0].relacoes, { cliente: IDS.CLIENTE_ANA, festa: IDS.FESTA_MARIA });

  await assert.rejects(ler("relacoes_festa", { id: IDS.FESTA_B }, banco(() => []).tx), { httpStatus: 404 });
  await assert.rejects(ler("relacoes_contrato", { id: IDS.CONTRATO_PEDRO }, banco(() => []).tx), { httpStatus: 404 });
  for (const id of ["nao-uuid", "../x", "", `${IDS.FESTA_MARIA}' OR 1=1`]) assert.throws(() => ferramentaRegistrada("relacoes_festa")!.preparar({ id }));
  assert.throws(() => ferramentaRegistrada("relacoes_contrato")!.preparar({ id: IDS.CONTRATO_MARIA, empresaId: EMPRESA_B }));
});

test("buscar_clientes: por nome no tenant, sem CPF/contato; termo com dígitos (CPF/telefone) ou e-mail recusado; zero resultado", async () => {
  const chamadas: Array<[string, string, number]> = [];
  const portas = { ...SEM_PORTAS, clientes: { async obter() { throw new Error("não usado"); }, async buscar(_tx: DbExecutor, empresaId: string, termo: string, limite: number) { chamadas.push([empresaId, termo, limite]); return termo === "Ana" ? [{ id: IDS.CLIENTE_ANA, nomeCompleto: "Ana Oliveira", status: "ATIVO" }] : []; } } };
  const r = await ler("buscar_clientes", { termo: "Ana" }, banco(() => []).tx, { ...contexto, portas });
  assert.deepEqual(chamadas, [[EMPRESA_A, "Ana", 5]], "sempre a empresa comprovada");
  assert.deepEqual(r.entidades, [{ tipo: "CLIENTE", id: IDS.CLIENTE_ANA, rotulo: "Ana Oliveira", tela: "cliente" }]);
  const vazio = await ler("buscar_clientes", { termo: "Zé Ninguém" }, banco(() => []).tx, { ...contexto, portas });
  assert.deepEqual([vazio.estado, vazio.entidades], ["sem_dados", []]);
  const entrada = ferramentaRegistrada("buscar_clientes")!.entrada;
  for (const termo of ["123.456.789-09", "11988887777", "ana@exemplo.com", "ab", "Ana'; DROP TABLE clientes; --"]) assert.equal(entrada.safeParse({ termo }).success, false, termo);
  assert.equal(entrada.safeParse({ termo: "Ana", empresaId: EMPRESA_B }).success, false);
});

test("buscar_catalogo: categorias e itens (com categoria) só leitura; termo escapado, nunca SQL", async () => {
  const b = banco(({ sql }) => (sql.includes("buffet_itens") ? [{ id: "99999999-9999-4999-8999-200000000001", nome: "Coxinha", categoria_id: "99999999-9999-4999-8999-100000000000", categoria: "Salgados" }] : [{ id: "99999999-9999-4999-8999-100000000000", nome: "Salgados" }]));
  const categorias = await ler("buscar_catalogo", { tipo: "CATEGORIA" }, b.tx);
  assert.deepEqual(categorias.entidades?.map((e) => e.tipo), ["CATEGORIA"]);
  const itens = await ler("buscar_catalogo", { tipo: "ITEM", termo: "cox%_\\" }, b.tx).catch(() => null);
  assert.equal(itens, null, "termo com curinga/barra é recusado pela entrada");
  const item = await ler("buscar_catalogo", { tipo: "ITEM", termo: "Coxinha" }, b.tx);
  assert.deepEqual(item.entidades?.[0].relacoes, { categoria: "99999999-9999-4999-8999-100000000000" });
  assert.match(item.resumo, /Coxinha está na categoria Salgados/);
  assert.equal(b.consultas.some((c) => escrita(c.sql)), false);
  assert.deepEqual(b.consultas.at(-1)!.values.slice(0, 2), ["%Coxinha%", null]);
  // Core: curingas e barra do termo viram literais (ILIKE com escape), mesmo sem o schema da IA na frente.
  assert.equal(padraoBusca("50%_off\\x"), "%50\\%\\_off\\\\x%");
});

// ---------------------------------------------------------------- intenção e conversa ponta a ponta

test("intenção: leitura direta por regra; composição ('cliente da próxima festa') fica para o PR 6", () => {
  const i = (t: string, c: Parameters<typeof interpretarDeterministico>[1] = null) => interpretarDeterministico(t, c);
  assert.deepEqual(i("Qual é a próxima festa?"), { tipo: "leitura", capacidade: "proximas_festas", parametros: { limite: 1 }, origem: "INTENCAO_DETERMINISTICA" });
  assert.deepEqual(i("Quais as próximas festas?"), { tipo: "leitura", capacidade: "proximas_festas", parametros: { limite: 5 }, origem: "INTENCAO_DETERMINISTICA" });
  assert.deepEqual(i("Procure a cliente Ana Oliveira"), { tipo: "leitura", capacidade: "buscar_clientes", parametros: { termo: "Ana Oliveira" }, origem: "INTENCAO_DETERMINISTICA" });
  assert.deepEqual(i("Procure o cliente 123.456.789-09"), { tipo: "nenhuma" }, "busca por documento não é feita pela IA");
  assert.deepEqual(i("Quem é o cliente desta festa?", { tela: "festa", entidadeId: IDS.FESTA_MARIA }), { tipo: "leitura", capacidade: "relacoes_festa", parametros: { id: IDS.FESTA_MARIA }, origem: "INTENCAO_DETERMINISTICA" });
  assert.notEqual((i("Quem é o cliente da próxima festa?") as { capacidade?: string }).capacidade, "proximas_festas");
});

async function perguntar(texto: string, contexto?: { tela: "festa" | "cliente" | "contrato"; entidade: keyof typeof IDS }) {
  const amb = criarAmbiente();
  const [o] = await amb.conversar({ id: "pr4-teste", categoria: "consultas", turnos: [{ texto, ...(contexto ? { contexto } : {}) }], esperado: { entendimento: "EXECUTADO" }, pr: "V1" });
  return { ...o, amb };
}

test("conversa: próxima festa pelo gateway; trace com tipos/cardinalidade/relações e sem PII, rótulo ou id", async () => {
  const r = await perguntar("Qual é a próxima festa?");
  const dados = (r.resposta as Extract<AIResponse, { tipo: "resposta" }>).dados as RespostaLeitura;
  assert.equal(dados.entidades?.[0].id, IDS.FESTA_MARIA, "a de amanhã (01/10)");
  assert.deepEqual(r.rastro?.leituras.map((l) => ({ capacidade: l.capacidade, tipos: l.tipos, total: l.total, cardinalidade: l.cardinalidade, relacoes: l.relacoes })), [{ capacidade: "proximas_festas", tipos: ["FESTA"], total: 1, cardinalidade: "UM", relacoes: ["FESTA.cliente", "FESTA.contrato"] }]);
  const trace = JSON.stringify(r.rastro);
  for (const proibido of [...PII, "Ana Oliveira", IDS.FESTA_MARIA]) assert.equal(trace.includes(proibido), false, proibido);
  assert.deepEqual([r.amb.violacoes.mutacoes, r.amb.violacoes.operacoesExecutadas, r.amb.violacoes.crossTenant], [[], 0, []]);
});

test("conversa: relação da festa de OUTRA empresa pela tela ⇒ 404 fail-closed; nada lido de fora do tenant", async () => {
  const r = await perguntar("Quem é o cliente desta festa?", { tela: "festa", entidade: "FESTA_B" });
  assert.equal(r.status, 404);
  assert.equal(r.resposta, null);
  assert.equal(r.rastro?.entendimento, "NEGADO_POLITICA");
  assert.deepEqual(r.amb.violacoes.crossTenant, []);
  const propria = await perguntar("Quem é o cliente desta festa?", { tela: "festa", entidade: "FESTA_MARIA" });
  assert.equal(propria.resposta?.tipo, "resposta");
  assert.match(((propria.resposta as Extract<AIResponse, { tipo: "resposta" }>).dados as RespostaLeitura).resumo, /Cliente: Ana Oliveira/);
});
