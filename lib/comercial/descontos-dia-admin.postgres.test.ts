import test from "node:test";
import assert from "node:assert/strict";
import type { Client } from "pg";
import type { DbExecutor } from "../db/contracts.ts";
import type { TenantComprovado } from "../saas/provar-tenant.ts";
import { travarConfiguracaoAgenda } from "../agenda/trava-configuracao.ts";
import { catalogoNativo, cenario, cpfValido, dia, executor, id, poolNaTransacao, representante, type Cenario } from "../../scripts/integracao-importados-test-support.ts";
import { conectarDescartavel, encerrarDescartavel } from "./postgres-descartavel.ts";
import { CODIGO_DESCONTO_DIA, CODIGO_DESCONTO_DIA_UTIL_KIDMAIS, diaSemanaIso, rascunhoDoEstado } from "./descontos-dia.ts";
import { lerDescontoDiaAdmin, salvarDescontoDiaAdmin, type EstadoDescontoDia } from "./descontos-dia-admin.ts";
import { descontosPublicosDaEmpresa } from "./descontos-dia-publico.ts";
import { calcularResumoComercial } from "./services/pricing.service.ts";

/**
 * D3/D4 (18/11/2026) — desconto por dia da semana no PostgreSQL DESCARTÁVEL (modelo 122), com os serviços reais:
 *   gravação só em regras_desconto_pacote + auditoria; equipe 403; teto 400; início no passado 400; versão 409;
 *   isolamento entre empresas; a cotação do servidor aplica a regra; regra usada por festa não muda de percentual
 *   (409 no mesmo início) e a nova vale a partir do dia seguinte sem apagar a antiga; 0% desliga; pacotes escolhidos;
 *   API pública só com a própria empresa e sem campos internos; Kidmais (18/11) editável pela mesma tela: a regra da 006
 *   aparece preenchida, salvar igual não escreve, mudar encerra a regra antiga no dia anterior e a cotação usa a nova,
 *   0% desliga, regra que não cabe no formulário bloqueia leitura e gravação. Tudo numa transação que termina em ROLLBACK.
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

test("D3/D4 no banco: gravação própria, recusas sem escrita, cotação aplica, festa fechada protegida, 0% desliga, isolamento, público e Kidmais pela mesma tela", { timeout: 300_000 }, async () => {
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
    // Astra r2, P1: grupo só da tela com percentuais diferentes (editado fora da tela) também não cabe. Sem a guarda, o
    // formulário juntaria tudo num percentual só e "salvar sem mudar" trocaria preços. Leitura bloqueada, gravação 409.
    await a.query("SAVEPOINT tela_mista");
    await a.query(`UPDATE regras_desconto_pacote SET percentual = 20 WHERE id = (
        SELECT r.id FROM regras_desconto_pacote r JOIN pacotes p ON p.id = r.pacote_id
         WHERE p.empresa_id = $1::uuid AND r.ativo AND r.codigo = 'DIA_SEMANA_BUFFET' ORDER BY r.id LIMIT 1)`, [A.empresa]);
    assert.deepEqual(await lerDescontoDiaAdmin(tx, gA), { disponivel: false, motivo: "REGRAS_FORA_DA_TELA" });
    const versaoMista = (await a.query<{ v: string }>(
      `SELECT coalesce(max(r.atualizado_em)::text, '-') || '|' || count(*)::text AS v FROM regras_desconto_pacote r JOIN pacotes p ON p.id = r.pacote_id
        WHERE p.empresa_id = $1::uuid AND r.codigo IN ('DIA_SEMANA_BUFFET', 'DIA_UTIL_15') AND r.configuracao_agenda_id IS NULL`, [A.empresa])).rows[0]!.v;
    await recusa(() => salvarDescontoDiaAdmin(tx, gA, { dias: semana, percentual: 20, pacoteIds: todos, inicio: hoje, versao: versaoMista }, { requestId: null }), "DESCONTO_DIA_FORA_DA_TELA", 409);
    await a.query("ROLLBACK TO SAVEPOINT tela_mista");

    // A cotação do servidor aplica a regra: 10% sobre o pacote, com o código da tela.
    const dataFesta = dia(40);
    const cotar = () => calcularResumoComercial({ data: dataFesta, configuracaoAgendaId: nativo.turno, pacoteId: A.pacote, convidados: 30, empresaEsperada: A.empresa }, tx);
    const r1 = await cotar();
    assert.deepEqual([r1.pacote.desconto.percentual, r1.pacote.desconto.codigo, r1.valorDescontoPacote],
      [10, CODIGO_DESCONTO_DIA, Math.round(r1.valorTabelaPacoteBase * 10) / 100]);
    assert.equal(r1.valorTabelaPacoteAplicado, Math.round((r1.valorTabelaPacoteBase - r1.valorDescontoPacote) * 100) / 100);

    // Público (D4): só a empresa A, por código do pacote, sem id nem observação; B sem nada (Kidmais: no fim).
    const pubA = (await descontosPublicosDaEmpresa(tx, A.empresa))!;
    assert.deepEqual(Object.keys(pubA).sort(), ["COMPLETA", "MINI"]);
    assert.equal(pubA.COMPLETA!.length, 7);
    assert.deepEqual(Object.keys(pubA.COMPLETA![0]!).sort(), ["configuracaoId", "dia", "percentual", "prioridade", "titulo", "vigenciaFim", "vigenciaInicio"]);
    assert.deepEqual(pubA.COMPLETA!.map((r) => r.percentual), [10, 10, 10, 10, 10, 10, 10]);
    assert.deepEqual(await descontosPublicosDaEmpresa(tx, B.empresa), {});

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

    // Kidmais (18/11/2026): mesma tela. A regra da 006 (DIA_UTIL_15, 15% de segunda a quinta) vem preenchida.
    const gK = await representante(a, { empresa: kidmais }) as TenantComprovado;
    const legadas = (await regrasDa(kidmais)).filter((r) => r.ativo && r.codigo === CODIGO_DESCONTO_DIA_UTIL_KIDMAIS && r.fim === null);
    assert.ok(legadas.length >= 4, "o modelo tem a regra da 006");
    const eK = aberto(await lerDescontoDiaAdmin(tx, gK));
    assert.deepEqual(eK.vigente && [eK.vigente.percentual, eK.vigente.dias, eK.vigente.fim], [15, [1, 2, 3, 4], null]);
    assert.equal(eK.agendada, null);
    const codigoDe = new Map(eK.pacotes.map((p) => [p.id, p.codigo]));
    const pacotesK = eK.vigente!.pacoteIds;
    assert.deepEqual(pacotesK.map((p) => codigoDe.get(p)).sort(), [...new Set(legadas.map((r) => codigoDe.get(r.pacote)).filter(Boolean))].sort());
    const outrasK = Number((await a.query<{ n: string }>(
      `SELECT count(*)::text n FROM regras_desconto_pacote r JOIN pacotes p ON p.id = r.pacote_id
        WHERE p.empresa_id = $1::uuid AND p.ativo AND p.vigente AND r.ativo AND (r.vigencia_fim IS NULL OR r.vigencia_fim >= $2::date)
          AND (r.codigo NOT IN ('DIA_SEMANA_BUFFET', 'DIA_UTIL_15') OR r.configuracao_agenda_id IS NOT NULL)`, [kidmais, hoje])).rows[0]!.n);
    assert.equal(eK.outrasRegras, outrasK, "a regra da 006 não conta como 'outra regra'");
    // Público: as regras da Kidmais saem (antes: null), 15% de segunda a quinta.
    const pubK0 = (await descontosPublicosDaEmpresa(tx, kidmais))!;
    for (const p of pacotesK)
      assert.deepEqual(pubK0[codigoDe.get(p)!]!.filter((r) => r.configuracaoId === null).map((r) => [r.dia, r.percentual]).sort(), [[1, 15], [2, 15], [3, 15], [4, 15]]);
    // Salvar sem mudar nada (o formulário manda o que veio, com início hoje): nada escrito, regras iguais.
    assert.deepEqual((await salvarMedindo(gK, { dias: [1, 2, 3, 4], percentual: 15, pacoteIds: pacotesK, inicio: hoje, versao: eK.versao })).escritas, []);
    assert.equal(JSON.stringify(await regrasDa(kidmais)), regrasKidmaisAntes, "regras intactas");
    // Versão só das linhas da tela (Astra r1, P3): uma regra por horário com o mesmo código não muda a versão.
    await a.query("SAVEPOINT versao_horario");
    const turnoV = (await a.query<{ id: string }>(
      `SELECT id::text id FROM configuracao_agenda WHERE (empresa_id = $1::uuid OR empresa_id IS NULL) AND ativo
        ORDER BY empresa_id IS NULL, codigo LIMIT 1`, [kidmais])).rows[0]!.id;
    await a.query(`INSERT INTO regras_desconto_pacote (pacote_id, dia_semana, configuracao_agenda_id, percentual, base_calculo, codigo, titulo, prioridade, vigencia_inicio, ativo)
      VALUES ($1::uuid, 6, $2::uuid, 5, 'PACOTE', 'DIA_SEMANA_BUFFET', 'regra por horário', 100, $3::date, true)`, [pacotesK[0], turnoV, somaDias(hoje, 3)]);
    const eKh = aberto(await lerDescontoDiaAdmin(tx, gK));
    assert.equal(eKh.versao, eK.versao, "linha com horário fora da versão");
    assert.equal(eKh.outrasRegras, eK.outrasRegras + 1, "linha com horário conta como outra regra");
    await a.query("ROLLBACK TO SAVEPOINT versao_horario");

    // Regra que não cabe no formulário (percentual diferente num dia): leitura bloqueada e gravação 409, nada escrito.
    await a.query("SAVEPOINT fora_da_tela");
    await a.query(`UPDATE regras_desconto_pacote SET percentual = 12 WHERE id = (
        SELECT r.id FROM regras_desconto_pacote r JOIN pacotes p ON p.id = r.pacote_id
         WHERE p.empresa_id = $1::uuid AND p.ativo AND p.vigente AND r.ativo AND r.codigo = 'DIA_UTIL_15' AND r.vigencia_fim IS NULL AND r.configuracao_agenda_id IS NULL
         ORDER BY r.id LIMIT 1)`, [kidmais]);
    assert.deepEqual(await lerDescontoDiaAdmin(tx, gK), { disponivel: false, motivo: "REGRAS_FORA_DA_TELA" });
    const versaoFora = (await a.query<{ v: string }>(
      `SELECT coalesce(max(r.atualizado_em)::text, '-') || '|' || count(*)::text AS v FROM regras_desconto_pacote r JOIN pacotes p ON p.id = r.pacote_id
        WHERE p.empresa_id = $1::uuid AND r.codigo IN ('DIA_SEMANA_BUFFET', 'DIA_UTIL_15') AND r.configuracao_agenda_id IS NULL`, [kidmais])).rows[0]!.v;
    await recusa(() => salvarDescontoDiaAdmin(tx, gK, { dias: [1, 2, 3, 4], percentual: 10, pacoteIds: pacotesK, inicio: hoje, versao: versaoFora }, { requestId: null }), "DESCONTO_DIA_FORA_DA_TELA", 409);
    await a.query("ROLLBACK TO SAVEPOINT fora_da_tela");
    // Linha do tempo (Astra r1, P1): uma linha da tela começando amanhã por cima da 006 aberta (cada grupo, sozinho,
    // caberia). Leitura bloqueada e gravação 409, nada escrito.
    await a.query("SAVEPOINT sobreposta");
    await a.query(`INSERT INTO regras_desconto_pacote (pacote_id, dia_semana, configuracao_agenda_id, percentual, base_calculo, codigo, titulo, prioridade, vigencia_inicio, ativo)
      VALUES ($1::uuid, 5, NULL, 10, 'PACOTE', 'DIA_SEMANA_BUFFET', '10% de desconto sexta', 100, $2::date, true)`, [pacotesK[0], somaDias(hoje, 1)]);
    assert.deepEqual(await lerDescontoDiaAdmin(tx, gK), { disponivel: false, motivo: "REGRAS_FORA_DA_TELA" });
    const versaoSobreposta = (await a.query<{ v: string }>(
      `SELECT coalesce(max(r.atualizado_em)::text, '-') || '|' || count(*)::text AS v FROM regras_desconto_pacote r JOIN pacotes p ON p.id = r.pacote_id
        WHERE p.empresa_id = $1::uuid AND r.codigo IN ('DIA_SEMANA_BUFFET', 'DIA_UTIL_15') AND r.configuracao_agenda_id IS NULL`, [kidmais])).rows[0]!.v;
    await recusa(() => salvarDescontoDiaAdmin(tx, gK, { dias: [1, 2, 3, 4], percentual: 10, pacoteIds: pacotesK, inicio: hoje, versao: versaoSobreposta }, { requestId: null }), "DESCONTO_DIA_FORA_DA_TELA", 409);
    await a.query("ROLLBACK TO SAVEPOINT sobreposta");

    // 10% a partir de amanhã: a regra da 006 termina hoje (percentual intacto, nada apagado) e as linhas novas são da tela.
    const amanhaK = somaDias(hoje, 1);
    const sK = await salvarMedindo(gK, { dias: [1, 2, 3, 4], percentual: 10, pacoteIds: pacotesK, inicio: amanhaK, versao: eK.versao });
    assert.deepEqual(sK.escritas, ["auditoria", "regras_desconto_pacote"]);
    const eK2 = aberto(sK.estado);
    assert.deepEqual(eK2.vigente && [eK2.vigente.percentual, eK2.vigente.fim], [15, hoje]);
    assert.deepEqual(eK2.agendada && [eK2.agendada.percentual, eK2.agendada.dias, eK2.agendada.inicio, eK2.agendada.fim], [10, [1, 2, 3, 4], amanhaK, null]);
    const linhasK = await regrasDa(kidmais);
    const legadasDepois = linhasK.filter((r) => r.codigo === CODIGO_DESCONTO_DIA_UTIL_KIDMAIS && legadas.some((l) => l.pacote === r.pacote && l.dia === r.dia && l.inicio === r.inicio));
    assert.equal(legadasDepois.length, legadas.length, "nada apagado");
    assert.ok(legadasDepois.every((r) => r.fim === hoje && r.ativo && Number(r.pct) === 15), "a 006 termina hoje com 15% intacto");
    assert.equal(linhasK.filter((r) => r.codigo === CODIGO_DESCONTO_DIA && r.ativo && r.inicio === amanhaK).length, pacotesK.length * 4);
    // Cotação do servidor numa segunda-feira depois de amanhã: 10% pela regra nova (quando o modelo tem agenda para a Kidmais).
    // Turno da Kidmais: o da própria empresa ou o da agenda pública da instalação (empresa_id nulo, da dona = Kidmais,
    // como no modelo 122). Nunca o turno de outra empresa.
    const turnoK = (await a.query<{ id: string }>(
      `SELECT id::text id FROM configuracao_agenda WHERE (empresa_id = $1::uuid OR empresa_id IS NULL) AND ativo
        ORDER BY empresa_id IS NULL, codigo = 'TURNO_1' DESC, codigo LIMIT 1`, [kidmais])).rows[0]?.id;
    assert.ok(turnoK, "o modelo tem agenda da Kidmais");
    let segunda = somaDias(hoje, 14);
    while (diaSemanaIso(segunda) !== 1) segunda = somaDias(segunda, 1);
    // Só a falta de tabela de preço no modelo é tolerada (savepoint: o erro não aborta a transação); outro erro reprova.
    await a.query("SAVEPOINT cotacao_kidmais");
    const rK = await calcularResumoComercial({ data: segunda, configuracaoAgendaId: turnoK!, pacoteId: pacotesK[0]!, convidados: 30, empresaEsperada: kidmais }, tx).catch((e: Error) => e);
    await a.query("ROLLBACK TO SAVEPOINT cotacao_kidmais");
    if (rK instanceof Error) {
      if ((rK as { code?: string }).code !== "TABELA_PRECO_NAO_CONFIGURADA") throw rK;
      console.log("# cotação Kidmais não exercitada: TABELA_PRECO_NAO_CONFIGURADA (modelo sem tabela de preço da Kidmais)");
    } else assert.deepEqual([rK.pacote.desconto.percentual, rK.pacote.desconto.codigo], [10, CODIGO_DESCONTO_DIA]);
    // Público: a 006 até hoje e a nova a partir de amanhã.
    const pubK1 = (await descontosPublicosDaEmpresa(tx, kidmais))!;
    const segundas = pubK1[codigoDe.get(pacotesK[0]!)!]!.filter((r) => r.configuracaoId === null && r.dia === 1);
    assert.deepEqual(segundas.map((r) => [r.percentual, r.vigenciaInicio, r.vigenciaFim]).sort(), [[10, amanhaK, null], [15, legadas[0]!.inicio, hoje]].sort());
    // 0% a partir de amanhã: as linhas novas saem de cena; a 006 continua terminando hoje.
    const eK3 = aberto((await salvarMedindo(gK, { dias: [], percentual: 0, pacoteIds: [], inicio: amanhaK, versao: eK2.versao })).estado);
    assert.equal(eK3.agendada, null);
    assert.equal((await regrasDa(kidmais)).filter((r) => (r.codigo === CODIGO_DESCONTO_DIA || r.codigo === CODIGO_DESCONTO_DIA_UTIL_KIDMAIS) && r.ativo && (r.fim === null || r.fim > hoje)).length, 0, "nada vale depois de hoje");
    assert.equal(eK3.historico.length, 2);
    // Astra r1, P1: reabrir a tela depois do 0% de amanhã e salvar sem mexer não recria os 15% (nada escrito).
    assert.equal(eK3.desligaEm, amanhaK);
    const rascK = rascunhoDoEstado(eK3);
    assert.deepEqual([rascK.percentual, rascK.inicio], ["0", amanhaK]);
    const reabrir = aberto(await lerDescontoDiaAdmin(tx, gK));
    assert.deepEqual((await salvarMedindo(gK, { dias: rascK.dias, percentual: Number(rascK.percentual), pacoteIds: rascK.pacoteIds, inicio: rascK.inicio, versao: reabrir.versao })).escritas, []);
    assert.equal((await regrasDa(kidmais)).filter((r) => (r.codigo === CODIGO_DESCONTO_DIA || r.codigo === CODIGO_DESCONTO_DIA_UTIL_KIDMAIS) && r.ativo && (r.fim === null || r.fim > hoje)).length, 0, "continua desligado");
    // Com a regra vigente aberta (eK), o rascunho repete a regra com início hoje: o "salvar igual" já provado acima.
    assert.deepEqual(rascunhoDoEstado(eK), { dias: [1, 2, 3, 4], percentual: "15", pacoteIds: pacotesK, inicio: hoje });

    // Cotação com a regra antiga (o modelo não tem tabela de preço da Kidmais): empresa sintética com linhas DIA_UTIL_15
    // como as da 006 (15%, todos os dias, sem horário). Antes da troca a cotação dá 15% (dia_util); depois de salvar 10%
    // a partir de amanhã, uma festa futura recebe 10% pela regra nova, e a linha antiga só termina (não muda nem some).
    const C = await cenario(a, 0);
    const nativoC = await catalogoNativo(a, C);
    const gC = await representante(a, C) as TenantComprovado;
    for (const d of semana)
      await a.query(`INSERT INTO regras_desconto_pacote (pacote_id, dia_semana, configuracao_agenda_id, percentual, base_calculo, codigo, titulo, prioridade, vigencia_inicio, ativo)
        VALUES ($1::uuid, $2, NULL, 15, 'PACOTE', 'DIA_UTIL_15', '15% de desconto', 100, $3::date, true)`, [C.pacote, d, somaDias(hoje, -30)]);
    const cotarC = () => calcularResumoComercial({ data: dataFesta, configuracaoAgendaId: nativoC.turno, pacoteId: C.pacote, convidados: 30, empresaEsperada: C.empresa }, tx);
    const c0 = await cotarC();
    assert.deepEqual([c0.pacote.desconto.percentual, c0.pacote.desconto.codigo], [15, CODIGO_DESCONTO_DIA_UTIL_KIDMAIS]);
    const eC = aberto(await lerDescontoDiaAdmin(tx, gC));
    assert.deepEqual(eC.vigente && [eC.vigente.percentual, eC.vigente.dias, eC.vigente.pacoteIds], [15, semana, [C.pacote]]);
    assert.deepEqual((await salvarMedindo(gC, { dias: semana, percentual: 15, pacoteIds: [C.pacote], inicio: hoje, versao: eC.versao })).escritas, [], "salvar igual não escreve");
    assert.deepEqual((await cotarC()).pacote.desconto.percentual, 15, "salvar igual não muda o preço");
    aberto((await salvarMedindo(gC, { dias: semana, percentual: 10, pacoteIds: [C.pacote], inicio: somaDias(hoje, 1), versao: eC.versao })).estado);
    const c1 = await cotarC();
    assert.deepEqual([c1.pacote.desconto.percentual, c1.pacote.desconto.codigo], [10, CODIGO_DESCONTO_DIA], "festa futura usa a regra nova");
    const antigasC = (await regrasDa(C.empresa)).filter((r) => r.codigo === CODIGO_DESCONTO_DIA_UTIL_KIDMAIS);
    assert.ok(antigasC.length === 7 && antigasC.every((r) => r.fim === hoje && r.ativo && Number(r.pct) === 15), "a antiga termina hoje, intacta");

    // Astra r1, P2: linha DIA_UTIL_15 com o MESMO início do pedido não é reaproveitada (nem muda de percentual): sai de
    // cena e a regra nova entra com o código da tela; se já foi usada por festa, 409 sem escrever.
    const depoisC = somaDias(hoje, 2);
    await a.query(`UPDATE regras_desconto_pacote SET ativo = false WHERE codigo = 'DIA_SEMANA_BUFFET' AND pacote_id = $1::uuid`, [C.pacote]);
    for (const d of semana)
      await a.query(`INSERT INTO regras_desconto_pacote (pacote_id, dia_semana, configuracao_agenda_id, percentual, base_calculo, codigo, titulo, prioridade, vigencia_inicio, ativo)
        VALUES ($1::uuid, $2, NULL, 15, 'PACOTE', 'DIA_UTIL_15', '15% de desconto', 100, $3::date, true)`, [C.pacote, d, depoisC]);
    const eC2 = aberto(await lerDescontoDiaAdmin(tx, gC));
    assert.deepEqual(eC2.agendada && [eC2.agendada.percentual, eC2.agendada.inicio], [15, depoisC]);
    await a.query("SAVEPOINT usada_c");
    const legadaDepois = (await a.query<{ id: string }>(`SELECT id::text id FROM regras_desconto_pacote WHERE pacote_id = $1::uuid AND codigo = 'DIA_UTIL_15' AND vigencia_inicio = $2::date ORDER BY dia_semana LIMIT 1`, [C.pacote, depoisC])).rows[0]!.id;
    await festaComRegra(C, nativoC.turno, dataFesta, legadaDepois, 15);
    const eC3 = aberto(await lerDescontoDiaAdmin(tx, gC));
    await recusa(() => salvarDescontoDiaAdmin(tx, gC, { dias: semana, percentual: 12, pacoteIds: [C.pacote], inicio: depoisC, versao: eC3.versao }, { requestId: null }), "DESCONTO_DIA_INICIO_USADO", 409);
    await a.query("ROLLBACK TO SAVEPOINT usada_c");
    aberto((await salvarMedindo(gC, { dias: semana, percentual: 12, pacoteIds: [C.pacote], inicio: depoisC, versao: eC2.versao })).estado);
    const noDepois = (await regrasDa(C.empresa)).filter((r) => r.inicio === depoisC);
    assert.ok(noDepois.filter((r) => r.codigo === CODIGO_DESCONTO_DIA_UTIL_KIDMAIS).every((r) => !r.ativo && Number(r.pct) === 15), "DIA_UTIL_15 do mesmo início: desativada, percentual intacto");
    assert.equal(noDepois.filter((r) => r.codigo === CODIGO_DESCONTO_DIA && r.ativo && Number(r.pct) === 12).length, 7, "regra nova com o código da tela");
  } finally {
    await a.query("ROLLBACK");
    restaurarPool();
  }
});
