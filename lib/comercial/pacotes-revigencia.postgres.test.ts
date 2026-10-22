import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
import type { DbExecutor } from "../db/contracts.ts";
import { conectarDescartavel, encerrarDescartavel } from "./postgres-descartavel.ts";
import { salvarPacoteComercial } from "./pacote-comercial.ts";
import { definirDisponibilidadePacoteAdmin, listarPacotesAdmin } from "./pacotes-admin.ts";

/**
 * Re-salvar um pacote em Configurações → Pacotes mantendo dia/horário que já tem regra aberta, no PostgreSQL DESCARTÁVEL
 * (modelo 089). Antes, o INSERT … ON CONFLICT de definirDisponibilidadePacoteAdmin criava uma regra de hoje para todo par
 * escolhido e o gatilho BEFORE da 006 (kidmais_validar_vigencia_regra_disponibilidade_pacote) recusava como sobreposta.
 *
 *  V1 pacote não usado, re-salvo no mesmo dia com a mesma disponibilidade: as regras ficam as mesmas (mesmos ids);
 *  V2 pacote não usado com regras de dias anteriores: mantém (regra intacta), remove (fim = ontem) e acrescenta (início hoje);
 *     remover uma regra criada hoje a desativa;
 *  V3 pacote usado (revisão copia as regras): mantém, remove e acrescenta na revisão; o pacote anterior não muda;
 *  V4 casos de borda do par mantido: INDISPONIVEL aberta, DISPONIVEL com fim marcado, início futuro e regra de hoje com
 *     outro estado — nenhuma sobreposição sobra e cada par termina com exatamente uma regra DISPONIVEL aberta.
 *
 * Só pelo check:v1:postgres com opt-in. Dados sintéticos; nenhuma rede.
 */
const SENHA = `scrypt$v=1$N=131072$r=8$p=1$${"A".repeat(22)}==$${"B".repeat(86)}==`;
const sufixo = randomBytes(3).toString("hex");
const cod = (p: string) => `${p}${randomBytes(4).toString("hex")}`;
let client: Client;
let tx: DbExecutor;
let turnos: string[];
let dono: { empresa: string; usuario: string };

type Regra = { id: string; dia: number; turno: string; estado: string; inicio: number; fim: number | null; ativo: boolean };

const pular = () => process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel";

async function emTransacao<T>(fn: () => Promise<T>) {
  await client.query("BEGIN");
  try { const r = await fn(); await client.query("COMMIT"); return r; } catch (erro) { await client.query("ROLLBACK"); throw erro; }
}

async function empresa(nome: string) {
  const id = async (sql: string, v: unknown[]) => (await client.query<{ id: string }>(sql, v)).rows[0].id;
  const e = await id(`INSERT INTO empresas (codigo, nome, status) VALUES ($1, $2, 'PROVISIONAMENTO') RETURNING id::text AS id`, [`revig${nome}${sufixo}`.toLowerCase(), `Buffet revigência ${nome}`]);
  await client.query(`UPDATE empresas SET status = 'ATIVA' WHERE id = $1::uuid`, [e]);
  const u = await id(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Harness revigência', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id::text AS id`, [`${cod("u")}@example.test`, SENHA]);
  const m = await id(`INSERT INTO memberships (empresa_id, usuario_id, status, vigente_desde, papel) VALUES ($1::uuid, $2::uuid, 'PENDENTE', clock_timestamp(), 'REPRESENTANTE_AUTORIZADO') RETURNING id::text AS id`, [e, u]);
  await client.query(`UPDATE memberships SET status = 'ATIVA' WHERE id = $1::uuid`, [m]);
  return { empresa: e, usuario: u };
}

const ctx = (motivo = "Edição administrativa") => ({ empresaId: dono.empresa, usuarioId: dono.usuario, requestId: randomUUID(), motivo });
const pares = (dias: number[], turno = turnos[0]) => dias.map((dia) => ({ dia, horarioId: turno }));

function salvar(nome: string, disponibilidade: Array<{ dia: number; horarioId: string }>, id?: string) {
  return emTransacao(() => salvarPacoteComercial(tx, {
    id, nome, descricao: "Pacote do teste de revigência", duracaoMinutos: 240, convidadosMinimos: 30, convidadosMaximos: 80,
    disponibilidade, faixas: [{ convidadosMin: 30, convidadosMax: 80, valor: "4500.00" }], categorias: [],
  }, ctx(id ? "Edição administrativa" : "Criação administrativa")));
}

/** Regras do pacote com as datas em dias relativos a hoje (0 = hoje, -1 = ontem); fim nulo = aberta. */
async function regras(pacoteId: string): Promise<Regra[]> {
  return (await client.query<Regra>(
    `SELECT id::text AS id, dia_semana::int AS dia, configuracao_agenda_id::text AS turno, estado,
            (vigencia_inicio - CURRENT_DATE)::int AS inicio, (vigencia_fim - CURRENT_DATE)::int AS fim, ativo
       FROM regras_disponibilidade_pacote WHERE pacote_id = $1::uuid ORDER BY dia_semana, configuracao_agenda_id, vigencia_inicio, id`,
    [pacoteId],
  )).rows;
}

/** Dias que a tela (listarPacotesAdmin) mostra hoje para o pacote. */
async function diasDaTela(pacoteId: string) {
  const p = (await listarPacotesAdmin(tx, dono.empresa)).find((x) => x.id === pacoteId) as unknown as { diasPermitidos?: number[] } | undefined;
  assert.ok(p, "o pacote aparece na lista da tela");
  return (p.diasPermitidos ?? []).map(Number);
}

/** Envelhece as regras do pacote: início (e fim, se houver) recuam `dias` dias, como se tivessem sido criadas antes. */
async function envelhecer(pacoteId: string, dias: number) {
  await client.query(
    `UPDATE regras_disponibilidade_pacote
        SET vigencia_inicio = vigencia_inicio - $2::int, vigencia_fim = vigencia_fim - $2::int
      WHERE pacote_id = $1::uuid`,
    [pacoteId, dias],
  );
}

/** Marca o pacote como usado: um fechamento em rascunho com o preço vigente dele (como em catalogo-buffet-078). */
async function usar(pacoteId: string) {
  const preco = (await client.query<{ id: string; tabela: string; valor: string }>(
    `SELECT id::text AS id, tabela_preco_id::text AS tabela, valor::text AS valor FROM precos_pacote WHERE pacote_id = $1::uuid AND ativo LIMIT 1`, [pacoteId])).rows[0];
  assert.ok(preco, "o pacote tem preço gravado");
  await client.query(
    `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
       categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, desconto_percentual, valor_desconto_pacote,
       valor_pacote_aplicado, valor_adicionais, valor_tabela, status, origem_fechamento)
     VALUES (CURRENT_DATE + 40, TIME '10:00', TIME '14:00', $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'PADRAO', 'PADRAO', 40, 40, $6, 0, 0, $6, 0, $6,
             'RASCUNHO', 'ATENDIMENTO_KIDMAIS')`,
    [turnos[0], dono.empresa, pacoteId, preco.tabela, preco.id, preco.valor]);
}

/** Nenhum par termina com duas regras ativas sobrepostas (o gatilho já recusaria, mas a prova fica explícita). */
async function semSobreposicao(pacoteId: string) {
  const r = await client.query(
    `SELECT 1 FROM regras_disponibilidade_pacote a JOIN regras_disponibilidade_pacote b
        ON a.pacote_id = b.pacote_id AND a.dia_semana = b.dia_semana AND a.configuracao_agenda_id = b.configuracao_agenda_id
       AND a.id < b.id AND a.ativo AND b.ativo
       AND daterange(a.vigencia_inicio, a.vigencia_fim, '[]') && daterange(b.vigencia_inicio, b.vigencia_fim, '[]')
     WHERE a.pacote_id = $1::uuid`,
    [pacoteId],
  );
  assert.equal(r.rowCount, 0, "sem regras ativas sobrepostas");
}

test.before(async () => {
  if (pular()) return;
  client = await conectarDescartavel();
  tx = { async query<Row extends object>(text: string, values?: readonly unknown[]) {
    const r = await client.query(text, values as unknown[]);
    return { rows: r.rows as Row[], rowCount: r.rowCount };
  } };
  turnos = (await client.query<{ id: string }>(`SELECT id::text AS id FROM configuracao_agenda WHERE codigo IN ('TURNO_1', 'TURNO_2') AND ativo ORDER BY codigo`)).rows.map((r) => r.id);
  assert.equal(turnos.length, 2);
  dono = await empresa("A");
});
test.after(async () => { if (client) await encerrarDescartavel(client); });

test("V1: pacote não usado re-salvo no mesmo dia com a mesma disponibilidade", { timeout: 300_000 }, async (t) => {
  if (pular()) { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const disp = [...pares([1, 2]), ...pares([1], turnos[1])];
  const criado = await salvar("Festa V1", disp);
  const antes = await regras(criado.pacote.id);
  assert.equal(antes.length, 3);
  const salvo = await salvar("Festa V1 renomeada", disp, criado.pacote.id);
  assert.equal(salvo.pacote.id, criado.pacote.id, "não usado: edita a mesma linha");
  assert.deepEqual(await regras(criado.pacote.id), antes, "V1: as regras são as mesmas (mesmos ids, datas e estado)");
  assert.deepEqual(await diasDaTela(criado.pacote.id), [1, 2]);
});

test("V2: pacote não usado com regras de dias anteriores — mantém, remove e acrescenta", { timeout: 300_000 }, async (t) => {
  if (pular()) { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const criado = await salvar("Festa V2", pares([1, 2]));
  const id = criado.pacote.id;
  await envelhecer(id, 10);
  const [seg, ter] = await regras(id);

  // Mantém segunda, remove terça, acrescenta quarta.
  await salvar("Festa V2", pares([1, 3]), id);
  const depois = await regras(id);
  assert.deepEqual(depois.find((r) => r.id === seg.id), seg, "V2: a regra mantida fica intacta (aberta desde -10)");
  assert.deepEqual(depois.find((r) => r.id === ter.id), { ...ter, fim: -1 }, "V2: removida fecha ontem, como antes");
  const quarta = depois.filter((r) => r.dia === 3);
  assert.deepEqual(quarta.map(({ estado, inicio, fim, ativo }) => ({ estado, inicio, fim, ativo })), [{ estado: "DISPONIVEL", inicio: 0, fim: null, ativo: true }], "V2: acrescentada começa hoje");
  assert.equal(depois.length, 3);
  assert.deepEqual(await diasDaTela(id), [1, 3]);

  // Re-salvar de novo, igual: nada muda. Depois, remover a quarta (criada hoje) a desativa; devolver a terça reabre hoje.
  await salvar("Festa V2", pares([1, 3]), id);
  assert.deepEqual(await regras(id), depois, "V2: segundo re-salvar idêntico não mexe em nada");
  await salvar("Festa V2", pares([1, 2]), id);
  const final = await regras(id);
  assert.equal(final.find((r) => r.id === quarta[0].id)?.ativo, false, "V2: removida criada hoje é desativada");
  const tercas = final.filter((r) => r.dia === 2);
  assert.deepEqual(tercas.map(({ inicio, fim, ativo }) => ({ inicio, fim, ativo })), [{ inicio: -10, fim: -1, ativo: true }, { inicio: 0, fim: null, ativo: true }], "V2: terça devolvida = histórico fechado + regra nova de hoje");
  assert.deepEqual(await diasDaTela(id), [1, 2]);
  await semSobreposicao(id);
});

test("V3: pacote usado (revisão copia as regras) — mantém, remove e acrescenta", { timeout: 300_000 }, async (t) => {
  if (pular()) { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const criado = await salvar("Festa V3", pares([5, 6]));
  const original = criado.pacote.id;
  await envelhecer(original, 3);
  await usar(original);
  const regrasOriginais = await regras(original);

  // Mesma disponibilidade (o caso do defeito) e depois mantém sexta, remove sábado, acrescenta domingo.
  const igual = await salvar("Festa V3", pares([5, 6]), original);
  const rev1 = igual.pacote.id;
  assert.notEqual(rev1, original, "V3: pacote usado → revisão com uuid novo");
  const copiadas = await regras(rev1);
  assert.deepEqual(copiadas.map(({ dia, inicio, fim, ativo }) => ({ dia, inicio, fim, ativo })),
    [{ dia: 5, inicio: -3, fim: null, ativo: true }, { dia: 6, inicio: -3, fim: null, ativo: true }], "V3: revisão mantém as regras copiadas");
  assert.deepEqual(await regras(original), regrasOriginais, "V3: o pacote anterior não muda");

  await usar(rev1);
  const mudou = await salvar("Festa V3", pares([5, 7]), rev1);
  const rev2 = mudou.pacote.id;
  assert.notEqual(rev2, rev1, "V3: a revisão usada gera outra revisão");
  const final = await regras(rev2);
  assert.deepEqual(final.map(({ dia, estado, inicio, fim, ativo }) => ({ dia, estado, inicio, fim, ativo })), [
    { dia: 5, estado: "DISPONIVEL", inicio: -3, fim: null, ativo: true },
    { dia: 6, estado: "DISPONIVEL", inicio: -3, fim: -1, ativo: true },
    { dia: 7, estado: "DISPONIVEL", inicio: 0, fim: null, ativo: true },
  ], "V3: mantida intacta, removida fechada ontem, acrescentada hoje");
  assert.deepEqual(await diasDaTela(rev2), [5, 7]);
  await semSobreposicao(rev2);
});

test("V4: par mantido com regra de outro estado, fim marcado, início futuro ou criada hoje", { timeout: 300_000 }, async (t) => {
  if (pular()) { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const criado = await salvar("Festa V4", []);
  const id = criado.pacote.id;
  const [t1] = turnos;
  const regra = (dia: number, estado: string, inicio: number, fim: number | null) => client.query(
    `INSERT INTO regras_disponibilidade_pacote (pacote_id, dia_semana, configuracao_agenda_id, estado, vigencia_inicio, vigencia_fim, ativo)
     VALUES ($1::uuid, $2, $3::uuid, $4, CURRENT_DATE + $5::int, CURRENT_DATE + $6::int, true)`,
    [id, dia, t1, estado, inicio, fim]);
  await regra(1, "INDISPONIVEL", -5, null);   // outro estado, aberta desde antes
  await regra(2, "DISPONIVEL", -5, 10);       // disponível, mas com fim marcado
  await regra(3, "DISPONIVEL", 5, null);      // começa no futuro
  await regra(4, "SOB_CONSULTA", 0, null);    // criada hoje com outro estado (mesma chave da regra nova)
  await regra(5, "DISPONIVEL", -5, null);     // já vale: fica
  const antes = await regras(id);

  await emTransacao(() => definirDisponibilidadePacoteAdmin(tx, id, { disponibilidade: pares([1, 2, 3, 4, 5]) }, ctx()));
  const depois = await regras(id);
  const de = (dia: number) => depois.filter((r) => r.dia === dia).map(({ estado, inicio, fim, ativo }) => ({ estado, inicio, fim, ativo }));
  assert.deepEqual(de(1), [{ estado: "INDISPONIVEL", inicio: -5, fim: -1, ativo: true }, { estado: "DISPONIVEL", inicio: 0, fim: null, ativo: true }], "V4: INDISPONIVEL fecha ontem");
  assert.deepEqual(de(2), [{ estado: "DISPONIVEL", inicio: -5, fim: -1, ativo: true }, { estado: "DISPONIVEL", inicio: 0, fim: null, ativo: true }], "V4: fim marcado fecha ontem e abre hoje");
  assert.deepEqual(de(3), [{ estado: "DISPONIVEL", inicio: 0, fim: null, ativo: true }, { estado: "DISPONIVEL", inicio: 5, fim: null, ativo: false }], "V4: futura desativada");
  assert.deepEqual(de(4), [{ estado: "DISPONIVEL", inicio: 0, fim: null, ativo: true }], "V4: a de hoje vira DISPONIVEL aberta (mesma linha)");
  assert.equal(depois.find((r) => r.dia === 4)?.id, antes.find((r) => r.dia === 4)?.id);
  assert.deepEqual(depois.find((r) => r.dia === 5), antes.find((r) => r.dia === 5), "V4: a que já vale fica intacta");
  assert.deepEqual(await diasDaTela(id), [1, 2, 3, 4, 5]);
  await semSobreposicao(id);

  // Idempotente: aplicar de novo não muda nada.
  await emTransacao(() => definirDisponibilidadePacoteAdmin(tx, id, { disponibilidade: pares([1, 2, 3, 4, 5]) }, ctx()));
  assert.deepEqual(await regras(id), depois, "V4: segunda aplicação idêntica não mexe em nada");
});
