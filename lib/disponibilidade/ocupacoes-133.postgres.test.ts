import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel, semTransacaoExplicita } from "../comercial/postgres-descartavel.ts";
import type { DbExecutor } from "../db/contracts.ts";
import { carregarComBanco, cliente, comercial, fechamento } from "../marketing/harness-postgres.ts";
import { carregar, cenario, comSalaoEscolhido, decisoes, id, importacao, integrar, representante, type Cenario, type Evento, type Servico } from "../../scripts/integracao-importados-test-support.ts";
import { travarConfiguracaoAgenda } from "../agenda/trava-configuracao.ts";

/**
 * 133 (Agenda lenta F3/F6, LOCAL 23/11/2026): kidmais133_ocupacoes_escopo(i,f,emp,uni) devolve exatamente as linhas de
 * kidmais094_ocupacoes(i,f) filtradas por kidmais062_mesmo_recurso(emp,uni,…), nas três origens (CONFIRMADA,
 * REVISAO_DESTINO e PRE_RESERVA), com ocupação legada sem empresa nem unidade, para empresa com e sem unidade e para o
 * escopo global (emp nulo). O repositório lê o mesmo resultado antes e depois da 133 e após o down. A migration recusa
 * uma 094 divergente antes de criar a função. Tudo numa transação desfeita no fim; modelo 131.
 */
const ler = (f: string) => readFileSync(f, "utf8");
const M133 = ["database/checks/20261123_133_precheck.sql", "database/migrations/20261123_133_ocupacoes_por_empresa.sql", "database/checks/20261123_133_postcheck.sql"].map(ler);
const PERIODO = ["2028-03-01", "2028-03-31"] as const;
type Revisao = typeof import("../fechamentos/repositories/revisao.repository.ts");

const executor = (db: Client): DbExecutor => ({
  async query<Row extends object>(text: string, values?: readonly unknown[]) { const r = await db.query(text, values as unknown[]); return { rows: r.rows as Row[], rowCount: r.rowCount }; },
});

/**
 * Festa integrada pelo caminho real (importação conferida → contrato, festa confirmada) com a remarcação em preparação
 * (versão 2 + revisão operacional) e o destino reservado (hold), como duracao-hold-094. O gatilho adiado da revisão só
 * rodaria no COMMIT, e o teste termina em ROLLBACK.
 */
async function remarcacaoComDestino(a: Client, c: Cenario, ev: Evento) {
  const tx = executor(a);
  const s = carregar<Servico>("lib/contratos/integracao-importados/servico.ts");
  const { coreNativo } = carregar<typeof import("../contratos/integracao-importados/composicao.ts")>("lib/contratos/integracao-importados/composicao.ts");
  const impId = (await importacao(a, c, ev)).id;
  const r = await integrar(s, coreNativo, a, c, impId, await comSalaoEscolhido(s, a, c, impId, decisoes(c, ev, { situacao: "NAO_CONFERIDO" })));
  const reserva = (await a.query(`SELECT f.id, v.id versao, v.snapshot, v.snapshot_hash FROM contratos k JOIN fechamentos f ON f.id = k.fechamento_id
      JOIN contrato_versoes v ON v.contrato_id = k.id WHERE k.id = $1`, [r.contratoId])).rows[0];
  const v2 = await id(a, `INSERT INTO contrato_versoes (contrato_id, numero_versao, status, snapshot, snapshot_hash, motivo_nova_versao)
      VALUES ($1::uuid, 2, 'ATIVA', $2::jsonb, $3, 'Remarcação 133') RETURNING id`, [r.contratoId, JSON.stringify(reserva.snapshot), reserva.snapshot_hash]);
  await a.query(`UPDATE contrato_fluxos SET versao_em_preparacao_id = $2::uuid WHERE contrato_id = $1::uuid`, [r.contratoId, v2]);
  const { criarRevisaoOperacionalRegistro } = carregar<Revisao>("lib/fechamentos/repositories/revisao.repository.ts");
  const revisao = randomUUID();
  await criarRevisaoOperacionalRegistro(tx, { id: revisao, fechamentoId: reserva.id, contratoId: r.contratoId, versaoId: v2, baseId: reserva.versao,
    baseHash: reserva.snapshot_hash, motivo: "Remarcação", chave: randomUUID(), usuarioId: c.usuario });
  await a.query(`UPDATE fechamento_revisoes SET hold_destino_adquirido_em = clock_timestamp() WHERE id = $1::uuid`, [revisao]);
  return { festa: reserva.id as string, revisao };
}

test("133: ocupações por empresa iguais à 094 filtrada, nas três origens, com legado e fallback", async () => {
  // Como a suíte 062: módulo Festa e integração de importados ligados só neste processo de teste.
  process.env.FESTA_ENABLED = "true";
  process.env.CONTRACT_IMPORT_INTEGRATION_ENABLED = "true";
  const a = await conectarDescartavel();
  try {
    await a.query("BEGIN");
    const repo = carregarComBanco("lib/disponibilidade/repositories/disponibilidade.repository.ts", a, () => ({})) as
      typeof import("./repositories/disponibilidade.repository.ts");
    // Remarcação com destino reservado (origem REVISAO_DESTINO) numa empresa C sem unidades.
    const C = await cenario(a, 0);
    const { festa: fC, revisao } = await remarcacaoComDestino(a, C, { data: "2028-03-15", inicio: "09:00", fim: "13:00" });
    const A = await cenario(a, 2);
    const B = await cenario(a, 1);
    // Unidades agendáveis (062): habilitação vigente por Representante autorizado, como agenda-um-salao-100.
    for (const [c, unidade] of [[A, A.unidades[0]], [A, A.unidades[1]], [B, B.unidades[0]]] as const) {
      const rep = await representante(a, c);
      await a.query(`INSERT INTO agenda_062_unidades_habilitacao (empresa_id, estabelecimento_id, habilitada_por, habilitada_papel, motivo_habilitacao)
          VALUES ($1::uuid, $2::uuid, $3::uuid, 'REPRESENTANTE_AUTORIZADO', 'Prova 133')`, [c.empresa, unidade, rep.usuarioId]);
    }
    const baseA = await comercial(a, A.empresa);
    const baseB = await comercial(a, B.empresa);
    const tA = await cliente(a, A.empresa, "Titular A sintético", null);
    const tB = await cliente(a, B.empresa, "Titular B sintético", null);
    // Festas confirmadas: A na unidade 1, A na unidade 2, A sem unidade, B; e uma fora do período.
    // A trava da configuração da agenda (114) vale para uma empresa por vez nesta transação.
    const travar = (emp: string) => travarConfiguracaoAgenda(a, emp, { modo: "COMPARTILHADA", linha: "KEY_SHARE" });
    await travar(B.empresa);
    const fB = await fechamento(a, B.empresa, baseB, tB, { data: "2028-03-10", status: "CONFIRMADO" });
    // B tem uma unidade só: o gatilho 062 já a atribui no INSERT.
    await travar(A.empresa);
    const fA1 = await fechamento(a, A.empresa, baseA, tA, { data: "2028-03-10", status: "CONFIRMADO" });
    const fA2 = await fechamento(a, A.empresa, baseA, tA, { data: "2028-03-11", status: "CONFIRMADO" });
    const fA0 = await fechamento(a, A.empresa, baseA, tA, { data: "2028-03-12", status: "CONFIRMADO" });
    await fechamento(a, A.empresa, baseA, tA, { data: "2028-05-01", status: "CONFIRMADO" });
    await a.query("UPDATE fechamentos SET estabelecimento_id=$2 WHERE id=$1", [fA1, A.unidades[0]]);
    await a.query("UPDATE fechamentos SET estabelecimento_id=$2 WHERE id=$1", [fA2, A.unidades[1]]);
    // Ocupação legada sem empresa nem unidade (anterior à 054/062). Os gatilhos de hoje recusam gravá-la, então a linha
    // é copiada de fA0 com os gatilhos desligados só para este INSERT (cluster descartável, papel dono).
    const fLegado = randomUUID();
    await a.query("SET LOCAL session_replication_role = replica");
    await a.query(`CREATE TEMP TABLE legado_133 ON COMMIT DROP AS SELECT * FROM fechamentos WHERE id = $1::uuid`, [fA0]);
    await a.query(`UPDATE legado_133 SET id = $1::uuid, empresa_id = NULL, estabelecimento_id = NULL, data_evento = '2028-03-13'`, [fLegado]);
    await a.query(`INSERT INTO fechamentos SELECT * FROM legado_133`);
    await a.query("SET LOCAL session_replication_role = origin");
    // Pré-reserva com garantia vigente em A (origem PRE_RESERVA).
    const pedido = await fechamento(a, A.empresa, baseA, tA, { data: "2028-03-20", status: "AGUARDANDO_CONTRATO" });
    await a.query(`INSERT INTO pre_reserva_aceites(empresa_id,fechamento_id,cliente_id,inicio_evento,fim_evento,
        preco_aceito_centavos,sinal_centavos,recebedor,chave_pix,termos_versao,termos_aceitos)
        VALUES($1,$2,$3,'2028-03-20 18:00Z','2028-03-20 21:00Z',25000,10000,'Teste','pix@example.test','1','Teste')`, [A.empresa, pedido, tA]);
    await a.query(`INSERT INTO pre_reserva_recebimentos(empresa_id,fechamento_id,end_to_end_id,valor_centavos,confirmado_por,
        sinal_garantido_centavos,confirmado_em,garantia_ate)
        VALUES($1,$2,'E12345678202611231234Ab123456789',10000,$3,10000,now(),now()+interval '48 hours')`, [A.empresa, pedido, A.usuario]);
    const garantida = (await a.query("SELECT garantia_ate IS NOT NULL AND garantia_ate > statement_timestamp() AS ok FROM pre_reserva_recebimentos WHERE fechamento_id=$1", [pedido])).rows[0]?.ok;
    assert.equal(garantida, true, "cenário: pré-reserva com garantia vigente");

    const ESCOPOS: Array<[string, string | null, string | null]> = [
      ["A sem unidade", A.empresa, null], ["A unidade 1", A.empresa, A.unidades[0]], ["A unidade 2", A.empresa, A.unidades[1]],
      ["B", B.empresa, null], ["C", C.empresa, null], ["global", null, null], ["global com unidade", null, A.unidades[0]],
    ];
    const chave = "fechamento_id::text||'|'||coalesce(revisao_id::text,'')||'|'||origem||'|'||data||'|'||horario_inicio||'|'||horario_fim||'|'||coalesce(empresa_id::text,'')||'|'||coalesce(estabelecimento_id::text,'')||'|'||coalesce(configuracao_agenda_id::text,'')||'|'||coalesce(salao_id::text,'')";
    const via094 = async (emp: string | null, uni: string | null) => (await a.query(`SELECT ${chave} AS k FROM kidmais094_ocupacoes($3::date,$4::date) o
        WHERE kidmais062_mesmo_recurso($1::uuid,$2::uuid,o.empresa_id,o.estabelecimento_id) ORDER BY 1`, [emp, uni, ...PERIODO])).rows.map((r) => r.k);
    const via133 = async (emp: string | null, uni: string | null) => (await a.query(`SELECT ${chave} AS k FROM kidmais133_ocupacoes_escopo($3::date,$4::date,$1::uuid,$2::uuid) o ORDER BY 1`, [emp, uni, ...PERIODO])).rows.map((r) => r.k);
    // O SQL do repositório ordena só por data e horário (empates possíveis): compara em ordem estável, com duplicatas.
    const doRepo = async (emp: string | null, uni: string | null) =>
      (await repo.listarFechamentosConfirmadosPorPeriodo(PERIODO[0], PERIODO[1], a, { empresaId: emp, estabelecimentoId: uni } as never))
        .map((linha) => JSON.stringify(linha)).sort();

    const antes = new Map<string, string[]>();
    for (const [nome, emp, uni] of ESCOPOS) antes.set(nome, await doRepo(emp, uni));
    assert.equal(await repo.ocupacoesPorEmpresaInstaladas(a), false, "sem a 133, o repositório usa a 094");

    // A migration recusa uma 094 divergente antes de criar a função (mesmo rodada sem o precheck).
    await a.query("SAVEPOINT divergente");
    // COST entra em pg_get_functiondef: muda o hash sem mudar o corpo (simula uma 094 alterada fora da 131).
    await a.query(`ALTER FUNCTION kidmais094_ocupacoes(date,date) COST 101`);
    await assert.rejects(a.query(semTransacaoExplicita(M133[1])), /133 requer a 094 exatamente/);
    await a.query("ROLLBACK TO SAVEPOINT divergente");
    assert.equal(await repo.ocupacoesPorEmpresaInstaladas(a), false);

    for (const sql of M133) await a.query(semTransacaoExplicita(sql));
    assert.equal(await repo.ocupacoesPorEmpresaInstaladas(a), true);

    const origens = new Set<string>();
    const vistos = new Map<string, Set<string>>();
    for (const [nome, emp, uni] of ESCOPOS) {
      const esperado = await via094(emp, uni);
      assert.deepEqual(await via133(emp, uni), esperado, `133 = 094 filtrada (${nome})`);
      assert.deepEqual(await doRepo(emp, uni), antes.get(nome), `repositório igual antes e depois da 133 (${nome})`);
      for (const k of esperado) origens.add(k.split("|")[2]);
      vistos.set(nome, new Set(esperado.map((k) => `${k.split("|")[2]}:${k.split("|")[0]}:${k.split("|")[1]}`)));
    }
    assert.deepEqual([...origens].sort(), ["CONFIRMADA", "PRE_RESERVA", "REVISAO_DESTINO"], "as três origens cobertas");
    const ve = (escopo: string, origem: string, f: string, r = "") => vistos.get(escopo)!.has(`${origem}:${f}:${r}`);
    // Remarcação: o destino reservado de C aparece em C e no global, e em nenhuma outra empresa.
    for (const e of ["C", "global", "global com unidade"]) assert.ok(ve(e, "REVISAO_DESTINO", fC, revisao) && ve(e, "CONFIRMADA", fC), `remarcação de C em ${e}`);
    for (const e of ["A sem unidade", "A unidade 1", "B"]) assert.ok(!ve(e, "REVISAO_DESTINO", fC, revisao) && !ve(e, "CONFIRMADA", fC), `remarcação de C fora de ${e}`);
    // Legado sem empresa nem unidade: ocupa o recurso de todos os escopos (regra nula da mesmo_recurso).
    for (const [nome] of ESCOPOS) assert.ok(ve(nome, "CONFIRMADA", fLegado), `legado sem empresa em ${nome}`);
    // Recorte: A não vê a festa de B e vice-versa; a unidade 1 não vê a unidade 2, mas vê a festa sem unidade.
    assert.ok(ve("A unidade 1", "CONFIRMADA", fA1) && ve("A unidade 1", "CONFIRMADA", fA0) && !ve("A unidade 1", "CONFIRMADA", fA2)
      && !ve("A unidade 1", "CONFIRMADA", fB) && ve("A unidade 1", "PRE_RESERVA", pedido));
    assert.ok(ve("B", "CONFIRMADA", fB) && !ve("B", "CONFIRMADA", fA1) && !ve("B", "PRE_RESERVA", pedido));
    // A 094 não mudou (mesma definição pinada pela 131).
    const hash094 = (await a.query(`SELECT encode(sha256(convert_to(replace(pg_get_functiondef('public.kidmais094_ocupacoes(date,date)'::regprocedure), chr(13), ''), 'UTF8')), 'hex') AS h`)).rows[0].h;
    assert.equal(hash094, "2fd9540c61c1d30bd64e53e912b90799e3cd6ab48d38f04ea82efe3f21385646");
    // O down remove só a função nova e o repositório volta à 094 com o mesmo resultado.
    await a.query(semTransacaoExplicita(ler("database/rollback/20261123_133_ocupacoes_por_empresa_down.sql")));
    assert.equal(await repo.ocupacoesPorEmpresaInstaladas(a), false);
    for (const [nome, emp, uni] of ESCOPOS) assert.deepEqual(await doRepo(emp, uni), antes.get(nome), `após o down (${nome})`);
  } finally {
    await a.query("ROLLBACK").catch(() => undefined);
    await encerrarDescartavel(a);
  }
});
