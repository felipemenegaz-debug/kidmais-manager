import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import type { DbExecutor } from "../db/contracts.ts";
import type { TenantComprovado } from "../saas/provar-tenant.ts";
import { travarConfiguracaoAgenda } from "../agenda/trava-configuracao.ts";
import { catalogoNativo, cenario, cpfValido, dia, executor, id, poolNaTransacao, representante, type Cenario } from "../../scripts/integracao-importados-test-support.ts";
import { conectarDescartavel, encerrarDescartavel } from "./postgres-descartavel.ts";
import { CODIGO_DESCONTO_DIA, diaSemanaIso } from "./descontos-dia.ts";
import { lerDescontoDiaAdmin, salvarDescontoDiaAdmin, type EstadoDescontoDia } from "./descontos-dia-admin.ts";
import { descontosPublicosDaEmpresa } from "./descontos-dia-publico.ts";
import { calcularResumoComercial } from "./services/pricing.service.ts";

/**
 * D3/D4 (18/11/2026) — desconto por dia da semana no PostgreSQL DESCARTÁVEL (modelo 122), com os serviços reais:
 *   gravação só em regras_desconto_pacote + auditoria; equipe 403; teto 400; início no passado 400; versão 409;
 *   isolamento entre empresas; a cotação do servidor aplica a regra; regra usada por festa não muda de percentual
 *   (409 no mesmo início) e a nova vale a partir do dia seguinte sem apagar a antiga; 0% desliga; pacotes escolhidos;
 *   API pública só com a própria empresa e sem campos internos; Kidmais intacta (leitura indisponível, gravação 409,
 *   público null). Tudo numa transação que termina em ROLLBACK.
 */
let a: Client;
let tx: DbExecutor;

const contar = async () => new Map((await a.query<{ relname: string; n: string }>(
  "SELECT relname, (n_tup_ins + n_tup_upd + n_tup_del)::text AS n FROM pg_stat_xact_user_tables")).rows.map((r) => [r.relname, Number(r.n)] as const));
/** Grava e devolve as tabelas escritas (diferença antes/depois: a transação carrega contadores das fixtures). */
async function salvarMedindo(tenant: TenantComprovado, corpo: unknown) {
  const antes = await contar();
  const estado = await salvarDescontoDiaAdmin(tx, tenant, corpo, { requestId: null });
  const depois = await contar();
  return { estado, escritas: [...depois].filter(([nome, n]) => n > (antes.get(nome) ?? 0)).map(([nome]) => nome).sort() };
}
/** Recusa sem escrever nada (savepoint: o erro do serviço não aborta a transação do teste). */
async function recusa(p: () => Promise<unknown>, codigo: string, status: number) {
  await a.query("SAVEPOINT recusa");
  const antes = await contar();
  await assert.rejects(p(), (e: { code?: string; httpStatus?: number }) => {
    assert.deepEqual([e.code, e.httpStatus], [codigo, status]);
    return true;
  });
  const depois = await contar();
  assert.deepEqual([...depois].filter(([nome, n]) => n > (antes.get(nome) ?? 0)).map(([nome]) => nome), [], `${codigo}: nada escrito`);
  await a.query("ROLLBACK TO SAVEPOINT recusa");
}
const aberto = (e: EstadoDescontoDia) => {
  assert.equal(e.disponivel, true);
  return e as Extract<EstadoDescontoDia, { disponivel: true }>;
};
const somaDias = (base: string, n: number) => new Date(Date.parse(`${base}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const regrasDa = async (empresa: string) => (await a.query<{ pacote: string; dia: number; pct: string; inicio: string; fim: string | null; ativo: boolean; codigo: string }>(
  `SELECT r.pacote_id::text pacote, r.dia_semana dia, r.percentual::text pct, r.vigencia_inicio::text inicio, r.vigencia_fim::text fim, r.ativo, r.codigo
     FROM regras_desconto_pacote r JOIN pacotes p ON p.id = r.pacote_id WHERE p.empresa_id = $1::uuid ORDER BY r.vigencia_inicio, r.dia_semana`, [empresa])).rows;

/** Festa fechada (aguardando contrato) que usa a regra de desconto informada, como a cotação grava. */
async function festaComRegra(c: Cenario, turno: string, data: string, regraId: string | null, percentual: number) {
  const cliente = await id(a, `INSERT INTO clientes (nome_completo, empresa_id, cpf, telefone, whatsapp) VALUES ('Cliente D3', $1::uuid, $2, '11999998888', '11999998888') RETURNING id`, [c.empresa, cpfValido()]);
  const aniversariante = await id(a, `INSERT INTO aniversariantes (cliente_id, nome) VALUES ($1::uuid, 'Aniversariante D3') RETURNING id`, [cliente]);
  await travarConfiguracaoAgenda(executor(a), c.empresa, { modo: "COMPARTILHADA", linha: "KEY_SHARE" });
  const desconto = Math.round(100 * percentual) / 100;
  return id(a, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
        categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, regra_desconto_pacote_id, desconto_percentual, valor_desconto_pacote,
        valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, aniversariante_id, status)
      SELECT $1::date, '10:00', '22:00', $2::uuid, $3::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', 30, 30, 100, $7::uuid, $8::numeric, $9::numeric, 100 - $9::numeric, 100 - $9::numeric,
        'ATENDIMENTO_KIDMAIS', $5::uuid, $6::uuid, 'AGUARDANDO_CONTRATO'
        FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $4::uuid LIMIT 1 RETURNING fechamentos.id`,
    [data, turno, c.empresa, c.pacote, cliente, aniversariante, regraId, percentual, desconto]);
}

test.before(async () => {
  a = await conectarDescartavel();
  tx = executor(a);
});
test.after(async () => { if (a) await encerrarDescartavel(a); });

test("D3/D4 no banco: gravação própria, recusas sem escrita, cotação aplica, festa fechada protegida, 0% desliga, isolamento, público e Kidmais intacta", { timeout: 300_000 }, async () => {
  await a.query("BEGIN");
  const restaurarPool = poolNaTransacao(a);
  try {
    const A = await cenario(a, 0);
    const nativo = await catalogoNativo(a, A);
    const B = await cenario(a, 0);
    const outroPacote = await id(a, `INSERT INTO pacotes (empresa_id, codigo, nome, ordem_exibicao, ativo, vigente) VALUES ($1::uuid, 'MINI', 'Mini', 2, true, true) RETURNING id`, [A.empresa]);
    const gA = await representante(a, A) as TenantComprovado;
    const gB = await representante(a, B) as TenantComprovado;
    const kidmais = (await a.query<{ id: string }>("SELECT id FROM empresas WHERE codigo = 'kidmais'")).rows[0]?.id;
    assert.ok(kidmais, "a Kidmais existe no modelo");
    const regrasKidmaisAntes = JSON.stringify(await regrasDa(kidmais));

    // Leitura inicial: nada configurado, os dois pacotes vigentes da própria empresa.
    const e0 = aberto(await lerDescontoDiaAdmin(tx, gA));
    assert.deepEqual([e0.vigente, e0.agendada, e0.outrasRegras, e0.historico.length], [null, null, 0, 0]);
    assert.deepEqual(e0.pacotes.map((p) => p.id).sort(), [A.pacote, outroPacote].sort());
    const hoje = e0.hoje;
    const todos = [A.pacote, outroPacote];
    const semana = [1, 2, 3, 4, 5, 6, 7];

    // Recusas: equipe (403), teto (400), início no passado (400), pacote de outra empresa (400). Nada escrito.
    await recusa(() => lerDescontoDiaAdmin(tx, A.tenant as TenantComprovado), "PAPEL_NAO_AUTORIZADO", 403);
    await recusa(() => salvarDescontoDiaAdmin(tx, A.tenant as TenantComprovado, { dias: semana, percentual: 10, pacoteIds: todos, inicio: hoje, versao: e0.versao }, { requestId: null }), "PAPEL_NAO_AUTORIZADO", 403);
    await recusa(() => salvarDescontoDiaAdmin(tx, gA, { dias: semana, percentual: 51, pacoteIds: todos, inicio: hoje, versao: e0.versao }, { requestId: null }), "DESCONTO_ACIMA_DO_TETO", 400);
    await recusa(() => salvarDescontoDiaAdmin(tx, gA, { dias: semana, percentual: 10, pacoteIds: todos, inicio: somaDias(hoje, -1), versao: e0.versao }, { requestId: null }), "INICIO_NO_PASSADO", 400);
    await recusa(() => salvarDescontoDiaAdmin(tx, gA, { dias: semana, percentual: 10, pacoteIds: [B.pacote], inicio: hoje, versao: e0.versao }, { requestId: null }), "PACOTE_INVALIDO", 400);

    // 10% todos os dias, todos os pacotes, a partir de hoje: 14 linhas; só regras_desconto_pacote + auditoria.
    const s1 = await salvarMedindo(gA, { dias: semana, percentual: 10, pacoteIds: todos, inicio: hoje, versao: e0.versao });
    assert.deepEqual(s1.escritas, ["auditoria", "regras_desconto_pacote"]);
    const e1 = aberto(s1.estado);
    assert.deepEqual(e1.vigente && [e1.vigente.percentual, e1.vigente.dias, e1.vigente.pacoteIds.sort(), e1.vigente.inicio, e1.vigente.fim], [10, semana, todos.sort(), hoje, null]);
    assert.equal((await regrasDa(A.empresa)).filter((r) => r.ativo && r.codigo === CODIGO_DESCONTO_DIA).length, 14);
    assert.equal(e1.historico.length, 1);
    assert.match(e1.historico[0]!.texto, /10%/);
    // Repetir o mesmo pedido não escreve nada.
    const repetido = await salvarMedindo(gA, { dias: semana, percentual: 10, pacoteIds: todos, inicio: hoje, versao: e1.versao });
    assert.deepEqual(repetido.escritas, []);
    // Versão antiga: 409, nada escrito.
    await recusa(() => salvarDescontoDiaAdmin(tx, gA, { dias: semana, percentual: 12, pacoteIds: todos, inicio: hoje, versao: e0.versao }, { requestId: null }), "DESCONTO_DIA_VERSAO", 409);

    // A cotação do servidor aplica a regra: 10% sobre o pacote, com o código da tela.
    const dataFesta = dia(40);
    const cotar = () => calcularResumoComercial({ data: dataFesta, configuracaoAgendaId: nativo.turno, pacoteId: A.pacote, convidados: 30, empresaEsperada: A.empresa }, tx);
    const r1 = await cotar();
    assert.deepEqual([r1.pacote.desconto.percentual, r1.pacote.desconto.codigo, r1.valorDescontoPacote],
      [10, CODIGO_DESCONTO_DIA, Math.round(r1.valorTabelaPacoteBase * 10) / 100]);
    assert.equal(r1.valorTabelaPacoteAplicado, Math.round((r1.valorTabelaPacoteBase - r1.valorDescontoPacote) * 100) / 100);

    // Público (D4): só a empresa A, por código do pacote, sem id nem observação; B sem nada; Kidmais null.
    const pubA = (await descontosPublicosDaEmpresa(tx, A.empresa))!;
    assert.deepEqual(Object.keys(pubA).sort(), ["COMPLETA", "MINI"]);
    assert.equal(pubA.COMPLETA!.length, 7);
    assert.deepEqual(Object.keys(pubA.COMPLETA![0]!).sort(), ["configuracaoId", "dia", "percentual", "prioridade", "titulo", "vigenciaFim", "vigenciaInicio"]);
    assert.deepEqual(pubA.COMPLETA!.map((r) => r.percentual), [10, 10, 10, 10, 10, 10, 10]);
    assert.deepEqual(await descontosPublicosDaEmpresa(tx, B.empresa), {});
    assert.equal(await descontosPublicosDaEmpresa(tx, kidmais), null);

    // Festa fechada com a regra de 10%: mudar o percentual no MESMO início é recusado (409) e nada muda.
    await festaComRegra(A, nativo.turno, dataFesta, r1.pacote.desconto.regraId, 10);
    const e1b = aberto(await lerDescontoDiaAdmin(tx, gA));
    await recusa(() => salvarDescontoDiaAdmin(tx, gA, { dias: semana, percentual: 20, pacoteIds: todos, inicio: hoje, versao: e1b.versao }, { requestId: null }), "DESCONTO_DIA_INICIO_USADO", 409);
    // Astra r1 P2: o início usado vale para TODAS as linhas da regra trocada naquela data, não só para os pares pedidos.
    // Mesmo 10%, mas sem o dia da festa: a linha usada sairia de cena → 409, nada escrito.
    const diaDaFesta = diaSemanaIso(dataFesta);
    const outro = diaDaFesta === 7 ? 6 : 7;
    await recusa(() => salvarDescontoDiaAdmin(tx, gA, { dias: semana.filter((d) => d !== diaDaFesta), percentual: 10, pacoteIds: todos, inicio: hoje, versao: e1b.versao }, { requestId: null }), "DESCONTO_DIA_INICIO_USADO", 409);
    // Só o outro pacote no mesmo início (a linha usada é do COMPLETA): 409.
    await recusa(() => salvarDescontoDiaAdmin(tx, gA, { dias: semana, percentual: 10, pacoteIds: [outroPacote], inicio: hoje, versao: e1b.versao }, { requestId: null }), "DESCONTO_DIA_INICIO_USADO", 409);
    // Astra r1 P2: mesmo percentual e o dia da festa mantido, mas o título muda ("todos os dias" → seis dias): a linha usada
    // guardaria um título que a festa não viu → 409.
    await recusa(() => salvarDescontoDiaAdmin(tx, gA, { dias: semana.filter((d) => d !== outro), percentual: 10, pacoteIds: todos, inicio: hoje, versao: e1b.versao }, { requestId: null }), "DESCONTO_DIA_INICIO_USADO", 409);
    // O mesmo pedido de antes continua aceito e não escreve nada.
    assert.deepEqual((await salvarMedindo(gA, { dias: semana, percentual: 10, pacoteIds: todos, inicio: hoje, versao: e1b.versao })).escritas, []);
    const tituloUsada = (await a.query<{ titulo: string }>("SELECT titulo FROM regras_desconto_pacote WHERE id = $1::uuid", [r1.pacote.desconto.regraId])).rows[0]!.titulo;
    assert.match(tituloUsada, /10%/);

    // 20% a partir de amanhã: as linhas de 10% terminam hoje (não são apagadas nem mudadas), as novas valem depois.
    const amanha = somaDias(hoje, 1);
    const e2 = aberto((await salvarMedindo(gA, { dias: semana, percentual: 20, pacoteIds: todos, inicio: amanha, versao: e1b.versao })).estado);
    assert.deepEqual(e2.vigente && [e2.vigente.percentual, e2.vigente.fim], [10, hoje]);
    assert.deepEqual(e2.agendada && [e2.agendada.percentual, e2.agendada.inicio, e2.agendada.fim], [20, amanha, null]);
    const linhas2 = await regrasDa(A.empresa);
    assert.equal(linhas2.length, 28, "nada apagado");
    assert.ok(linhas2.filter((r) => r.inicio === hoje).every((r) => r.pct === "10.00" || r.pct === "10"), "percentual antigo intacto");
    assert.ok(linhas2.filter((r) => r.inicio === hoje).every((r) => r.fim === hoje && r.ativo));
    const r2 = await cotar();
    assert.equal(r2.pacote.desconto.percentual, 20, "festa nova depois do início usa a regra nova");
    const fechada = (await a.query<{ pct: string; regra: string }>(`SELECT desconto_percentual::text pct, regra_desconto_pacote_id::text regra FROM fechamentos WHERE empresa_id = $1::uuid`, [A.empresa])).rows[0]!;
    assert.deepEqual([Number(fechada.pct), fechada.regra], [10, r1.pacote.desconto.regraId], "a festa fechada não muda");

    // Só alguns pacotes e dias: fim de semana, só o MINI, a partir de depois de amanhã.
    const depois = somaDias(hoje, 2);
    const e3 = aberto((await salvarMedindo(gA, { dias: [6, 7], percentual: 15, pacoteIds: [outroPacote], inicio: depois, versao: e2.versao })).estado);
    assert.deepEqual(e3.agendada && [e3.agendada.percentual, e3.agendada.dias, e3.agendada.pacoteIds], [15, [6, 7], [outroPacote]]);
    const ativasDepois = (await regrasDa(A.empresa)).filter((r) => r.ativo && r.fim === null);
    assert.deepEqual(ativasDepois.map((r) => [r.pacote, r.dia]), [[outroPacote, 6], [outroPacote, 7]]);
    // A data da festa (dia 40) no pacote COMPLETA: sem desconto a partir de "depois"; num sábado/domingo do MINI, 15%.
    assert.equal((await cotar()).pacote.desconto.percentual, 0);

    // 0% a partir de depois de amanhã: desliga (as linhas agendadas saem de cena; nada apagado).
    const e4 = aberto((await salvarMedindo(gA, { dias: [], percentual: 0, pacoteIds: [], inicio: depois, versao: e3.versao })).estado);
    // Sobra só o agendamento intermediário de amanhã (20%, um dia), que a tela mostra com o fim.
    assert.deepEqual(e4.agendada && [e4.agendada.percentual, e4.agendada.inicio, e4.agendada.fim], [20, somaDias(hoje, 1), somaDias(hoje, 1)]);
    assert.equal((await regrasDa(A.empresa)).filter((r) => r.ativo && r.fim === null).length, 0);
    assert.equal((await regrasDa(A.empresa)).length, 30, "nada apagado");
    assert.equal(e4.historico.length, 4, "uma entrada por gravação com mudança");

    // Isolamento: B continua sem regra, sem histórico; a leitura de B não enxerga A.
    const eB = aberto(await lerDescontoDiaAdmin(tx, gB));
    assert.deepEqual([eB.vigente, eB.agendada, eB.historico.length], [null, null, 0]);
    assert.equal((await regrasDa(B.empresa)).length, 0);

    // Kidmais: leitura indisponível, gravação 409, regras intactas.
    const gK = await representante(a, { empresa: kidmais }) as TenantComprovado;
    assert.deepEqual(await lerDescontoDiaAdmin(tx, gK), { disponivel: false, motivo: "KIDMAIS" });
    await recusa(() => salvarDescontoDiaAdmin(tx, gK, { dias: semana, percentual: 10, pacoteIds: [randomUUID()], inicio: hoje, versao: "x" }, { requestId: randomUUID() }), "DESCONTO_DIA_KIDMAIS", 409);
    assert.equal(JSON.stringify(await regrasDa(kidmais)), regrasKidmaisAntes);
  } finally {
    await a.query("ROLLBACK");
    restaurarPool();
  }
});
