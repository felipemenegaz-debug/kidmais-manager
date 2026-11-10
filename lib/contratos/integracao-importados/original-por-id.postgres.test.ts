import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../../comercial/postgres-descartavel.ts";
import type { DbExecutor } from "../../db/contracts.ts";
import {
  carregar, cenario, cpfValido, ctxIntegracao, decisoes, dia, executor, importacao, instalar055, instalar061, instalar062, integrar, PARCIAL, validarAgora,
  type Cenario, type Servico,
} from "../../../scripts/integracao-importados-test-support.ts";

/**
 * B1 do plano do P1 monetário (leitura M2, D-P1r4-2): o original de uma importação é o que a extração dela leu
 * (importação → extração → original), nunca "a última versão do documento".
 *
 * Cada cenário cria a versão 1 (lida pela extração) e, depois, uma versão 2 do MESMO documento, inserida à mão (o
 * upload do produto só cria a versão 1). A simulação a partir do rascunho e a conclusão com o vínculo gravado têm de
 * usar o ID e o SHA da versão 1, também em sequência sobre a mesma importação; o detalhe do contrato importado tem de
 * devolver o ID da versão 1, e o download, bytes cujo SHA calculado é o da versão 1.
 * Um mutante "última versão" em cada consulta tem de falhar no ponto correspondente.
 *
 * Só roda pelo `check:v1:postgres` no cluster descartável, com opt-in e autorização (docs/OPERACAO_AGENTES.md).
 */

type Importados = typeof import("../importados.ts");

async function segundaVersao(db: Client, c: Cenario, documento: string) {
  const pdf = Buffer.from(`%PDF-1.4\n% segunda versão ${randomUUID()}\n%%EOF\n`);
  const sha = createHash("sha256").update(pdf).digest("hex");
  const r = await db.query<{ id: string }>(
    `INSERT INTO ia_documento_originais (documento_id, empresa_id, versao, nome_original, content_type, tamanho_bytes, sha256, conteudo, enviado_por)
     VALUES ($1::uuid, $2::uuid, 2, 'contrato-v2.pdf', 'application/pdf', $3, $4, $5, $6::uuid) RETURNING id::text`,
    [documento, c.empresa, pdf.length, sha, pdf, c.usuario]);
  return { id: r.rows[0].id, sha };
}

async function originalDaExtracao(db: Client, extracao: string) {
  return (await db.query<{ id: string; sha256: string }>(
    `SELECT o.id::text, o.sha256 FROM ia_extracoes x JOIN ia_documento_originais o ON o.id = x.original_id WHERE x.id = $1::uuid`, [extracao])).rows[0];
}

/** Executor que registra as linhas devolvidas por toda consulta a ia_documento_originais. */
function espiao(db: Client) {
  const base = executor(db);
  const vistos: Array<{ id?: string; sha256?: string }> = [];
  const tx: DbExecutor = { query: async (sql, values) => {
    const r = await base.query(sql, values);
    if (sql.includes("ia_documento_originais")) vistos.push(...(r.rows as Array<{ id?: string; sha256?: string }>));
    return r;
  } } as DbExecutor;
  return { tx, vistos };
}

test("B1: original pela extração em simulação, conclusão, vínculo, detalhe e bytes, com duas versões do documento", { timeout: 600_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const a = await conectarDescartavel();
  try {
    await instalar055(a);
    await instalar061(a);
    await instalar062(a);
    process.env.CONTRACT_IMPORT_INTEGRATION_ENABLED = "true";
    const s = carregar<Servico>("lib/contratos/integracao-importados/servico.ts");
    const { coreNativo } = carregar<typeof import("./composicao.ts")>("lib/contratos/integracao-importados/composicao.ts");
    const imp = carregar<Importados>("lib/contratos/importados.ts");
    t.beforeEach(async () => { await a.query("ROLLBACK"); });
    const ev = { data: dia(45), inicio: "14:00", fim: "18:00" };

    await t.test("simulação a partir do rascunho usa o original da extração", async () => {
      await a.query("BEGIN");
      const c = await cenario(a);
      const i = await importacao(a, c, ev, true);
      const v1 = await originalDaExtracao(a, i.extracao);
      const v2 = await segundaVersao(a, c, i.documento);
      assert.notEqual(v1.id, v2.id);
      const fonte = {
        importacao: { id: i.id, documentoId: i.documento, clienteId: i.id, status: "EM_REVISAO", snapshot: i.snapshot, recebimentosDocumento: null },
        cliente: { id: i.id, nomeCompleto: "Cliente 061", cpf: null, telefone: "11999990000", whatsapp: "11999990000", email: null, status: "ATIVO" },
        clienteNovo: true,
      };
      const { tx, vistos } = espiao(a);
      const sim = await s.simularIntegracao(tx, c.tenant as never, i.id, decisoes(c, ev, PARCIAL()), dia(0), fonte as never);
      assert.equal(sim.integrada, false);
      assert.ok(vistos.length >= 1, "a simulação consultou o original");
      assert.deepEqual(vistos.map((v) => [v.id, v.sha256]), vistos.map(() => [v1.id, v1.sha256]), "só a versão lida pela extração");
      await a.query("ROLLBACK");
    });

    await t.test("conclusão grava o vínculo e a versão conferida com o ID e o SHA da extração", async () => {
      await a.query("BEGIN");
      const c = await cenario(a);
      const i = await importacao(a, c, ev);
      const v1 = await originalDaExtracao(a, i.extracao);
      await segundaVersao(a, c, i.documento);
      const r = await integrar(s, coreNativo, a, c, i.id, decisoes(c, ev, PARCIAL()));
      assert.equal(r.reutilizado, false);
      const vinculo = (await a.query(`SELECT ci.documento_original_id::text AS id, ci.documento_sha256 AS sha, v.documento_pdf_hash AS hash
          FROM contrato_importacoes ci JOIN contrato_versoes v ON v.id = ci.contrato_versao_id WHERE ci.importacao_id = $1::uuid`, [i.id])).rows[0];
      assert.deepEqual({ ...vinculo }, { id: v1.id, sha: v1.sha256, hash: v1.sha256 });
      await a.query("ROLLBACK");
    });

    // Parecer do Astra (08/11, P2): mesma importação do rascunho ao vínculo, como na confirmação única
    // (integracao.postgres.test.ts): simulação pela fonte do rascunho → executarImportacao → confirmarIntegracao.
    await t.test("encadeado: o mesmo rascunho simula, conclui e grava vínculo e versão com o ID e o SHA da extração", async () => {
      await a.query("BEGIN");
      const c = await cenario(a);
      const ev2 = { data: dia(152), inicio: "14:00", fim: "18:00" };
      const i0 = await importacao(a, c, ev2, true);
      const v1 = await originalDaExtracao(a, i0.extracao);
      const v2 = await segundaVersao(a, c, i0.documento);
      assert.notEqual(v1.sha256, v2.sha);
      const ri = carregar<typeof import("../../importacao-contrato/repositorio-importacao.ts")>("lib/importacao-contrato/repositorio-importacao.ts");
      const crm = carregar<typeof import("../../clientes/services/index.ts")>("lib/clientes/services/index.ts");
      const motor = carregar<typeof import("../../importacao-contrato/motor.ts")>("lib/importacao-contrato/motor.ts");
      const rascunho = carregar<typeof import("./rascunho.ts")>("lib/contratos/integracao-importados/rascunho.ts");
      const { tx, vistos } = espiao(a);
      const lida = (await ri.lerImportacao(tx, c.empresa, i0.id, false))!;
      assert.equal(lida.status, "EM_REVISAO");
      const plano: import("../../importacao-contrato/plano.ts").PlanoImportacao = { pronto: true, bloqueios: [], avisos: [], tipoPessoa: "PF", recusa: null,
        match: { estado: "NOVO_CLIENTE", clienteId: null, candidatos: [], motivo: "Sintético" },
        passos: [{ tipo: "CLIENTE", acao: "CRIAR", dados: { nomeCompleto: "Cliente B1 encadeado", cpf: cpfValido(), telefone: "11999990000", whatsapp: null, email: null } }, { tipo: "CONTRATO_HISTORICO", acao: "REGISTRAR_SNAPSHOT" }], snapshot: i0.snapshot };
      const d = decisoes(c, ev2, { situacao: "PAGO", parcelas: [
        { valorCentavos: 250000, vencimento: dia(-60), recebimento: { data: dia(-60), forma: "PIX" } },
        { valorCentavos: 250000, vencimento: dia(-30), recebimento: { data: dia(-30), forma: "PIX" } },
      ] });
      const sim = await s.simularIntegracao(tx, c.tenant as never, i0.id, d, dia(0), await rascunho.fonteDoRascunho(tx, c.tenant as never, lida, plano));
      if (sim.integrada) throw Error("preview inesperado");
      assert.ok(sim.pronto, JSON.stringify(sim));
      const naSimulacao = vistos.length;
      assert.ok(naSimulacao >= 1, "a simulação consultou o original");
      await motor.executarImportacao(tx, { empresaId: c.empresa, usuarioId: c.usuario, requestId: randomUUID(), importacao: lida, plano, agora: new Date().toISOString() }, {
        cadastrarCliente: async (t2, empresaId, dados, ctx) => ({ clienteId: (await crm.cadastrarClienteInterno({ ...dados, empresaId }, { ...ctx, origem: "CRM_INTERNO", ip: null, userAgent: "sintetico" }, t2)).cliente.id }),
        conferirCliente: async () => { throw Error("cliente novo não vincula existente"); }, atualizarImportacao: ri.atualizarImportacao,
      });
      const r = await s.confirmarIntegracao(tx, c.tenant as never, ctxIntegracao(c), i0.id, { decisoes: d, resumoHash: sim.resumoHash, chave: randomUUID() }, dia(0), coreNativo as never);
      assert.equal(r.reutilizado, false);
      await validarAgora(a);
      assert.ok(vistos.length > naSimulacao, "a conclusão consultou o original de novo");
      assert.deepEqual(vistos.map((v) => [v.id, v.sha256]), vistos.map(() => [v1.id, v1.sha256]), "simulação e conclusão: só a versão lida pela extração");
      const gravado = (await a.query(`SELECT ci.importacao_id::text AS importacao, ci.documento_original_id::text AS id, ci.documento_sha256 AS sha,
            v.documento_pdf_hash AS hash, v.snapshot->'origem'->>'documentoOriginalId' AS origem_id, v.snapshot->'origem'->>'documentoSha256' AS origem_sha
          FROM contrato_importacoes ci JOIN contrato_versoes v ON v.id = ci.contrato_versao_id WHERE ci.importacao_id = $1::uuid`, [i0.id])).rows[0];
      assert.deepEqual({ ...gravado }, { importacao: i0.id, id: v1.id, sha: v1.sha256, hash: v1.sha256, origem_id: v1.id, origem_sha: v1.sha256 });
      await a.query("ROLLBACK");
    });

    await t.test("detalhe do contrato importado aponta o original da extração", async () => {
      await a.query("BEGIN");
      const c = await cenario(a);
      const i = await importacao(a, c, ev);
      const v1 = await originalDaExtracao(a, i.extracao);
      await segundaVersao(a, c, i.documento);
      const d = await imp.detalheContratoImportado(executor(a), c.empresa, dia(0), i.id, "ADMINISTRATIVO");
      assert.ok(d);
      assert.equal(d.documento?.id, v1.id);
      assert.equal(d.documento?.nome, "contrato.pdf");
      await a.query("ROLLBACK");
    });

    await t.test("bytes do original são os da extração", async () => {
      await a.query("BEGIN");
      const c = await cenario(a);
      const i = await importacao(a, c, ev);
      const v1 = await originalDaExtracao(a, i.extracao);
      await segundaVersao(a, c, i.documento);
      const o = await imp.originalDoContratoImportado(executor(a), c.empresa, i.id);
      assert.ok(o);
      assert.equal(createHash("sha256").update(o.conteudo).digest("hex"), v1.sha256);
      assert.equal(o.nome, "contrato.pdf");
      // Outra empresa: nada.
      const outra = await cenario(a);
      assert.equal(await imp.originalDoContratoImportado(executor(a), outra.empresa, i.id), null);
      await a.query("ROLLBACK");
    });
  } finally {
    await a.query("ROLLBACK").catch(() => undefined);
    await encerrarDescartavel(a);
  }
});
