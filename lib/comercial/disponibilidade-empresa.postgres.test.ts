import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { Client } from "pg";
import type { DbExecutor } from "../db/contracts.ts";
import { regraDaEmpresa, regraPadraoPacote, type StatusCalendario } from "../agenda/disponibilidade.ts";
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

test("cenário: A vende POCKET todos os dias; B só dias úteis, sábado almoço sob consulta e uma janela que fecha a quarta; C sem POCKET", async () => {
  const t = (await client.query<{ codigo: string; id: string }>(
    `SELECT codigo, id::text AS id FROM configuracao_agenda WHERE codigo IN ('TURNO_1', 'TURNO_2') AND ativo`)).rows;
  turno = { almoco: t.find((x) => x.codigo === "TURNO_1")!.id, noite: t.find((x) => x.codigo === "TURNO_2")!.id };
  A = await empresa("A"); B = await empresa("B"); C = await empresa("C");
  pocketA = await pacote(A, "POCKET");
  pocketB = await pacote(B, "POCKET");
  miniB = await pacote(B, "MINI_FESTA"); // sem regra nenhuma
  const desde = isoDia(soma(hoje, -30));
  for (const dia of [1, 2, 3, 4, 5, 6, 7]) for (const h of HORARIOS) await regra(pocketA, dia, h, "DISPONIVEL", desde);
  for (const dia of [1, 2, 3, 4, 5]) for (const h of HORARIOS) await regra(pocketB, dia, h, "DISPONIVEL", desde);
  await regra(pocketB, 6, "almoco", "SOB_CONSULTA", desde);
  // Janela no meio da grade: quarta no almoço fica INDISPONIVEL por 14 dias (regra mais recente prevalece), depois volta.
  await regra(pocketB, 3, "almoco", "INDISPONIVEL", isoDia(soma(inicioGrade, 7)), isoDia(soma(inicioGrade, 20)));
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
  assert.equal(deB.pocket.length, 12, "10 dias úteis + sábado sob consulta + janela da quarta");
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
  // O cenário exercita os quatro casos: disponível, consulta, indisponível por falta de regra e pela janela.
  const sabado = grade.find((d) => diaIso(d) === 6)!;
  const quartaNaJanela = grade.slice(7, 21).find((d) => diaIso(d) === 3)!;
  const quartaDepois = grade.slice(21).find((d) => diaIso(d) === 3)!;
  assert.equal(regraDaEmpresa(deA.pocket, sabado, "almoco"), "disponivel");
  assert.equal(regraDaEmpresa(deB.pocket, sabado, "almoco"), "consulta");
  assert.equal(regraDaEmpresa(deB.pocket, sabado, "noite"), "indisponivel");
  assert.equal(regraDaEmpresa(deB.pocket, quartaNaJanela, "almoco"), "indisponivel");
  assert.equal(regraDaEmpresa(deB.pocket, quartaDepois, "almoco"), "disponivel");
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
