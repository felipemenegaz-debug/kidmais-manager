import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { Client } from "pg";
import type { DbExecutor } from "../db/contracts.ts";
import { CONFIG_VAZIA, regraDaEmpresa, regraPadraoPacote, statusDataPacote, type StatusCalendario } from "../agenda/disponibilidade.ts";
import type { HorarioBase, PacoteId } from "../../components/fechamento/types.ts";
import { lerRegrasDisponibilidadePacote, regrasDosPacotesDaEmpresa } from "./disponibilidade-pacote-publica.ts";
import { PACOTES_CONTRATAVEIS_V1 } from "./pacotes-v1.ts";
import { conectarDescartavel, encerrarDescartavel } from "./postgres-descartavel.ts";
import { buscarElegibilidadePacoteAplicavel, buscarPacoteVigenteDaEmpresaPorCodigo } from "./repositories/comercial.repository.ts";

/**
 * Coerência da disponibilidade do pacote no PostgreSQL DESCARTÁVEL (modelo 063): para cada data e período de uma grade de
 * 5 semanas a partir de hoje + 14 dias, a decisão do SERVIDOR (buscarElegibilidadePacoteAplicavel, usada na cotação) é igual
 * à da TELA com as regras lidas para a cotação pública (lerRegrasDisponibilidadePacote) e para a ADMINISTRAÇÃO
 * (regrasDosPacotesDaEmpresa) — em duas empresas com o MESMO código POCKET e regras diferentes, sem cruzar empresas.
 * Kidmais (legado): a regra fixa da tela coincide com a matriz do servidor (006/017).
 */
let client: Client;
let tx: DbExecutor;
const sufixo = randomBytes(3).toString("hex");
let turno: Record<HorarioBase, string>;
let A: string; let B: string; let C: string;
let pocketA: string; let pocketB: string; let miniB: string;

const isoDia = (d: Date) => d.toISOString().slice(0, 10);
function soma(base: Date, dias: number) { const d = new Date(base); d.setUTCDate(d.getUTCDate() + dias); return d; }
const hoje = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
const inicioGrade = soma(hoje, 14);
const grade = Array.from({ length: 35 }, (_, i) => isoDia(soma(inicioGrade, i)));
const diaIso = (data: string) => new Date(`${data}T00:00:00Z`).getUTCDay() || 7;
const HORARIOS: HorarioBase[] = ["almoco", "noite"];
/**
 * Período fechado de B no POCKET, quarta-feira no almoço, com vigências CONTÍGUAS (o banco recusa sobreposição):
 * aberta até a véspera do fechamento → fechada de uma quarta até a quarta seguinte → reaberta a partir do dia seguinte.
 * Datas de fronteira (todas quartas, o dia da regra): último dia aberto, primeiro e último dia fechado, primeiro dia reaberto.
 */
const quartaFechada = grade.slice(7, 14).find((d) => diaIso(d) === 3)!;
const desloca = (data: string, dias: number) => isoDia(soma(new Date(`${data}T00:00:00Z`), dias));
const FRONTEIRA = {
  ultimoAberto: desloca(quartaFechada, -7),
  primeiroFechado: quartaFechada,
  ultimoFechado: desloca(quartaFechada, 7),
  primeiroReaberto: desloca(quartaFechada, 14),
};
const VIGENCIAS_QUARTA = {
  abertaAte: desloca(quartaFechada, -1),
  fechadaDe: quartaFechada,
  fechadaAte: desloca(quartaFechada, 7),
  reabertaDe: desloca(quartaFechada, 8),
};

const doServidor = (estado: string | null | undefined): StatusCalendario =>
  estado === "DISPONIVEL" ? "disponivel" : estado === "SOB_CONSULTA" ? "consulta" : "indisponivel";

async function servidor(pacoteId: string, data: string, horario: HorarioBase) {
  const regra = await buscarElegibilidadePacoteAplicavel({ pacoteId, data, configuracaoAgendaId: turno[horario] }, tx);
  return doServidor(regra?.estado);
}
async function empresa(nome: string) {
  return (await client.query<{ id: string }>(
    `INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id::text AS id`,
    [`dsp${nome}${sufixo}`.toLowerCase(), `Empresa disponibilidade ${nome}`],
  )).rows[0].id;
}
async function pacote(empresaId: string, codigo: string) {
  return (await client.query<{ id: string }>(
    `INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente, convidados_minimos, convidados_maximos)
     VALUES ($1::uuid, $2, $3, 790, true, true, 20, 30) RETURNING id::text AS id`,
    [empresaId, codigo, `Pacote ${codigo}`],
  )).rows[0].id;
}
async function regra(pacoteId: string, dia: number, horario: HorarioBase, estado: string, inicio: string, fim: string | null = null) {
  await client.query(
    `INSERT INTO regras_disponibilidade_pacote (pacote_id, dia_semana, configuracao_agenda_id, estado, vigencia_inicio, vigencia_fim)
     VALUES ($1::uuid, $2, $3::uuid, $4, $5::date, $6::date)`,
    [pacoteId, dia, turno[horario], estado, inicio, fim],
  );
}

test.before(async () => {
  client = await conectarDescartavel();
  tx = { async query<Row extends object>(text: string, values?: readonly unknown[]) {
    const r = await client.query(text, values as unknown[]);
    return { rows: r.rows as Row[], rowCount: r.rowCount };
  } };
});
test.after(async () => { if (client) await encerrarDescartavel(client); });

test("cenário: A vende POCKET todos os dias; B só dias úteis, sábado almoço sob consulta e a quarta (almoço) fechada por duas semanas; C sem POCKET", async () => {
  const t = (await client.query<{ codigo: string; id: string }>(
    `SELECT codigo, id::text AS id FROM configuracao_agenda WHERE codigo IN ('TURNO_1', 'TURNO_2') AND ativo`)).rows;
  turno = { almoco: t.find((x) => x.codigo === "TURNO_1")!.id, noite: t.find((x) => x.codigo === "TURNO_2")!.id };
  A = await empresa("A"); B = await empresa("B"); C = await empresa("C");
  pocketA = await pacote(A, "POCKET");
  pocketB = await pacote(B, "POCKET");
  miniB = await pacote(B, "MINI_FESTA"); // sem regra nenhuma
  const desde = isoDia(soma(hoje, -30));
  for (const dia of [1, 2, 3, 4, 5, 6, 7]) for (const h of HORARIOS) await regra(pocketA, dia, h, "DISPONIVEL", desde);
  for (const dia of [1, 2, 3, 4, 5]) for (const h of HORARIOS) {
    if (dia === 3 && h === "almoco") continue; // a quarta no almoço tem três vigências contíguas (abaixo)
    await regra(pocketB, dia, h, "DISPONIVEL", desde);
  }
  await regra(pocketB, 6, "almoco", "SOB_CONSULTA", desde);
  await regra(pocketB, 3, "almoco", "DISPONIVEL", desde, VIGENCIAS_QUARTA.abertaAte);
  await regra(pocketB, 3, "almoco", "INDISPONIVEL", VIGENCIAS_QUARTA.fechadaDe, VIGENCIAS_QUARTA.fechadaAte);
  await regra(pocketB, 3, "almoco", "DISPONIVEL", VIGENCIAS_QUARTA.reabertaDe);
  // As fronteiras estão dentro da grade e o fechamento cobre exatamente duas quartas.
  assert.ok(grade.includes(FRONTEIRA.ultimoAberto) && grade.includes(FRONTEIRA.primeiroReaberto));
  assert.ok(VIGENCIAS_QUARTA.abertaAte < VIGENCIAS_QUARTA.fechadaDe && VIGENCIAS_QUARTA.fechadaAte < VIGENCIAS_QUARTA.reabertaDe);
  assert.notEqual(pocketA, pocketB, "mesmo código, pacotes diferentes");
});

test("isolamento: a administração de cada empresa lê só os pacotes dela (o mesmo código POCKET não cruza)", async () => {
  const pedidos: Array<[string, string]> = [];
  const espiao = async (empresaId: string, codigo: string, t: DbExecutor) => { pedidos.push([empresaId, codigo]); return buscarPacoteVigenteDaEmpresaPorCodigo(empresaId, codigo, t); };
  const deA = await regrasDosPacotesDaEmpresa(tx, A, espiao);
  const deB = await regrasDosPacotesDaEmpresa(tx, B, espiao);
  const deC = await regrasDosPacotesDaEmpresa(tx, C, espiao);
  assert.ok(pedidos.every(([e]) => e === A || e === B || e === C));
  assert.deepEqual(Object.keys(deA).sort(), PACOTES_CONTRATAVEIS_V1.map((p) => p.id).sort());
  assert.equal(deA.pocket.length, 14);
  assert.equal(deB.pocket.length, 13, "9 períodos de dias úteis + 3 vigências da quarta no almoço + sábado sob consulta");
  assert.equal(deB.pocket.filter((r) => r.dia === 3 && r.horario === "almoco").length, 3, "aberta, fechada e reaberta");
  assert.deepEqual(deB.mini, [], "pacote sem regra");
  assert.deepEqual(deC.pocket, [], "empresa sem POCKET");
  assert.ok(deA.pocket.every((r) => r.estado === "DISPONIVEL"), "nada das regras de B em A");
  // Administração = cotação pública: mesma leitura, mesmo resultado.
  assert.deepEqual(deA.pocket, await lerRegrasDisponibilidadePacote(tx, pocketA));
  assert.deepEqual(deB.pocket, await lerRegrasDisponibilidadePacote(tx, pocketB));
});

test("coerência: tela (cotação pública e administração) = servidor, em toda a grade, nas duas empresas", async () => {
  const deA = await regrasDosPacotesDaEmpresa(tx, A, buscarPacoteVigenteDaEmpresaPorCodigo);
  const deB = await regrasDosPacotesDaEmpresa(tx, B, buscarPacoteVigenteDaEmpresaPorCodigo);
  const divergencias: string[] = [];
  for (const data of grade) for (const h of HORARIOS) {
    for (const [nome, regras, pacoteId] of [["A", deA.pocket, pocketA], ["B", deB.pocket, pocketB], ["B-mini", deB.mini, miniB]] as const) {
      const tela = regraDaEmpresa(regras, data, h);
      const srv = await servidor(pacoteId, data, h);
      if (tela !== srv) divergencias.push(`${nome} ${data} ${h}: tela=${tela} servidor=${srv}`);
    }
  }
  assert.deepEqual(divergencias, []);
  // O cenário exercita disponível, consulta e indisponível por falta de regra (o período fechado: teste seguinte).
  const sabado = grade.find((d) => diaIso(d) === 6)!;
  assert.equal(regraDaEmpresa(deA.pocket, sabado, "almoco"), "disponivel");
  assert.equal(regraDaEmpresa(deB.pocket, sabado, "almoco"), "consulta");
  assert.equal(regraDaEmpresa(deB.pocket, sabado, "noite"), "indisponivel");
});

test("fronteiras do período fechado: administração = cotação pública = servidor no último dia aberto, primeiro e último fechado e primeiro reaberto", async () => {
  const daAdministracao = (await regrasDosPacotesDaEmpresa(tx, B, buscarPacoteVigenteDaEmpresaPorCodigo)).pocket;
  const daCotacaoPublica = await lerRegrasDisponibilidadePacote(tx, pocketB);
  const esperado: Record<keyof typeof FRONTEIRA, StatusCalendario> = {
    ultimoAberto: "disponivel", primeiroFechado: "indisponivel", ultimoFechado: "indisponivel", primeiroReaberto: "disponivel",
  };
  const obtido: Record<string, { administracao: StatusCalendario; cotacao: StatusCalendario; servidor: StatusCalendario }> = {};
  for (const [nome, data] of Object.entries(FRONTEIRA)) {
    assert.equal(diaIso(data), 3, `${nome} é quarta`);
    obtido[nome] = {
      // As mesmas chamadas da tela: AdminDisponibilidade e FechamentoWizard usam statusDataPacote com as regras da empresa.
      administracao: statusDataPacote(CONFIG_VAZIA, "pocket", data, "almoco", daAdministracao).status,
      cotacao: statusDataPacote(CONFIG_VAZIA, "pocket", data, "almoco", daCotacaoPublica).status,
      servidor: await servidor(pocketB, data, "almoco"),
    };
  }
  assert.deepEqual(obtido, Object.fromEntries(Object.entries(esperado).map(([nome, s]) => [nome, { administracao: s, cotacao: s, servidor: s }])));
  // A noite da mesma quarta não é afetada pelo fechamento do almoço.
  for (const data of Object.values(FRONTEIRA)) assert.equal(await servidor(pocketB, data, "noite"), "disponivel");
});

test("legado da Kidmais: a regra fixa da tela (endereço atual e administração da dona) coincide com a matriz do servidor", async () => {
  const kidmais = (await client.query<{ id: string }>(`SELECT id::text AS id FROM empresas WHERE codigo = 'kidmais'`)).rows[0]?.id;
  assert.ok(kidmais, "empresa kidmais (046)");
  const divergencias: string[] = [];
  let comparados = 0;
  for (const { id, codigo } of PACOTES_CONTRATAVEIS_V1) {
    const p = await buscarPacoteVigenteDaEmpresaPorCodigo(kidmais, codigo, tx);
    if (!p) continue;
    for (const data of grade) for (const h of HORARIOS) {
      comparados++;
      const tela = regraPadraoPacote(id as PacoteId, data, h);
      const srv = await servidor(p.id, data, h);
      if (tela !== srv) divergencias.push(`${codigo} ${data} ${h}: tela=${tela} servidor=${srv}`);
    }
  }
  assert.ok(comparados > 0, "há pacotes da Kidmais no modelo");
  assert.deepEqual(divergencias, []);
});
