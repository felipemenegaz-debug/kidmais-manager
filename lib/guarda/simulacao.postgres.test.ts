import test from "node:test";
import assert from "node:assert/strict";
import type { Client } from "pg";
import { conectarDescartavel, encerrarDescartavel } from "../comercial/postgres-descartavel.ts";
import { travarConfiguracaoAgenda } from "../agenda/trava-configuracao.ts";
import { carregarComBanco, cliente, cod, comercial, contratoAssinado, empresa, executor, fechamento, SENHA_FALSA } from "../marketing/harness-postgres.ts";

/**
 * Guarda fase 3 (20/11/2026), PostgreSQL DESCARTÁVEL no modelo 127. Simulação do lote (só leitura, só contagens) com dados
 * 100% sintéticos (telefones 5511955551xxx, e-mails @guarda.test): recusa fora de transação READ ONLY; empresa com aceite
 * dos Termos 2026-11-17 é apta, sem aceite ou com versão anterior não é (contagens só informativas, fora dos totais);
 * interessado vencido = ANONIMIZAR_TUDO; contrato vencido com contato em dia = ELIMINAR_SO_CONTRATO com valor em aberto;
 * MESCLADO conta pelo principal; nenhum nome, contato ou id de cliente no resultado nem no rascunho do aviso.
 */
const opt = () => process.env.KIDMAIS_POSTGRES_DESCARTAVEL === "kidmais_pacotes_v1_descartavel";
type Sim = {
  simularLote(tx: unknown, o: { aviso: string; tipo?: string; empresaId?: string }): Promise<{
    lote: unknown; disputaMedida: boolean; totais: Record<string, unknown>;
    empresas: { empresaId: string; apto: boolean; aceiteVersao: string | null; clientes: number; clientesAlcancados: number; itens: number;
      porMedida: Record<string, number>; porPrazo: Record<string, number>; comExcecao: Record<string, number>; porExecucao: Record<string, Record<string, number>> }[];
  }>;
  rascunhoDoAviso(r: unknown, lote: unknown): string;
};

async function aceite(c: Client, empresaId: string, versao: string) {
  const u = (await c.query<{ id: string }>(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Pessoa sintética', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id::text AS id`,
    [`${cod("u")}@guarda.test`, SENHA_FALSA])).rows[0].id;
  await c.query(`INSERT INTO aceites_documentos_legais (usuario_id, empresa_id, documento, versao, hash_conteudo, origem) VALUES ($1::uuid, $2::uuid, 'TERMOS_USO', $3, $4, 'CADASTRO')`,
    [u, empresaId, versao, "d".repeat(64)]);
}
const antigo = (c: Client, id: string, dia: string) => c.query(`UPDATE clientes SET criado_em = $2::timestamptz WHERE id = $1::uuid`, [id, `${dia} 12:00-03`]);

test("simulação do lote: aptidão pelo aceite, medidas, exceção de valor em aberto, mescla e nenhum dado pessoal", { skip: !opt() }, async () => {
  const c = await conectarDescartavel();
  try {
    const sim = carregarComBanco("lib/guarda/simulacao.ts", c, () => null, {}, new Map()) as unknown as Sim;
    const tx = executor(c);
    await c.query("BEGIN");
    const A = await empresa(c, "Guarda simulação A"), B = await empresa(c, "Guarda simulação B"), C = await empresa(c, "Guarda simulação C");
    await aceite(c, A, "2026-11-17-termos");
    await aceite(c, C, "2026-11-15-termos");
    const base = await comercial(c, A);
    await travarConfiguracaoAgenda(tx, A, { modo: "COMPARTILHADA", linha: "KEY_SHARE" });
    // Interessado sem contato desde 2020: venceu em 2022 → ANONIMIZAR_TUDO na primeira aplicação.
    const ana = await cliente(c, A, "Ana Simulada", "11955551001", "ana@guarda.test");
    await antigo(c, ana, "2020-01-10");
    // Festa de 2020 assinada, pagamento em aberto, conversa no WhatsApp em 2026 (contato em dia): só o contrato vence.
    const bruno = await cliente(c, A, "Bruno Simulado", "11955551002", "bruno@guarda.test");
    const fb = await fechamento(c, A, base, bruno, { data: "2020-03-10", status: "CONFIRMADO" });
    await contratoAssinado(c, fb, 4500, null);
    await c.query("INSERT INTO whatsapp_atendimento_conversas (empresa_id, ambiente, contato, ultima_entrada_em) VALUES ($1::uuid, 'staging', '5511955551002', '2026-09-01 10:00-03')", [A]);
    // Cadastro duplicado do Bruno, mesclado: não conta como cliente próprio.
    const brunoAntigo = await cliente(c, A, "Bruno cadastro antigo", "11955551003", null);
    await c.query("UPDATE clientes SET status = 'MESCLADO', cliente_principal_id = $2::uuid, mesclado_em = now() WHERE id = $1::uuid", [brunoAntigo, bruno]);
    // Cliente recente: fora do lote.
    await cliente(c, A, "Caio Simulado", "11955551004", null);
    // B sem aceite e C com aceite anterior ao DPA: não aptos, com contagem só informativa.
    await antigo(c, await cliente(c, B, "Dani Simulada", "11955551005", null), "2020-01-10");
    await antigo(c, await cliente(c, C, "Edu Simulado", "11955551006", null), "2020-01-10");

    await assert.rejects(sim.simularLote(tx, { aviso: "2027-01-01", empresaId: A }), /READ ONLY/);
    await c.query("SET TRANSACTION READ ONLY");
    const r = await sim.simularLote(tx, { aviso: "2027-01-01", empresaId: A });
    assert.equal(r.disputaMedida, false);
    assert.deepEqual(r.empresas.map((e) => [e.apto, e.aceiteVersao, e.clientes, e.clientesAlcancados, e.itens]), [[true, "2026-11-17-termos", 3, 2, 2]]);
    const [a] = r.empresas;
    assert.deepEqual(a.porMedida, { PARAR_CAMPANHA: 0, ELIMINAR_SO_CONTRATO: 1, ANONIMIZAR_TUDO: 1 });
    assert.deepEqual(a.porPrazo, { CONTRATO: 1, CAMPANHAS: 0, INTERESSADO: 1 });
    assert.deepEqual(a.comExcecao, { VALOR_EM_ABERTO: 1, DISPUTA: 0 });
    assert.deepEqual(a.porExecucao, { "2027-01-31": { PARAR_CAMPANHA: 0, ELIMINAR_SO_CONTRATO: 1, ANONIMIZAR_TUDO: 1 } });
    // Ciclo normal do mesmo aviso: nada vence em março/2027.
    assert.equal((await sim.simularLote(tx, { aviso: "2027-01-01", tipo: "NORMAL", empresaId: A })).empresas[0].itens, 0);

    for (const [id, apto, versao] of [[B, false, null], [C, false, null]] as const) {
      const e = (await sim.simularLote(tx, { aviso: "2027-01-01", empresaId: id })).empresas[0];
      assert.deepEqual([e.apto, e.aceiteVersao, e.clientesAlcancados, e.porMedida.ANONIMIZAR_TUDO], [apto, versao, 1, 1]);
    }
    // Rodada sem filtro: totais só das aptas; o resultado inteiro e o aviso não trazem dado pessoal nem id de cliente.
    const todas = await sim.simularLote(tx, { aviso: "2027-01-01" });
    assert.ok(todas.empresas.some((e) => e.empresaId === B && !e.apto));
    assert.ok((todas.totais.empresasNaoAptas as number) >= 2);
    const aviso = sim.rascunhoDoAviso(a, r.lote);
    assert.match(aviso, /Em 31\/01\/2027: 1 cliente\(s\) terão todos os dados anonimizados; 1 cliente\(s\) terão contrato/);
    assert.match(aviso, /1 desses cliente\(s\) têm valor em aberto/);
    const texto = JSON.stringify(todas) + aviso;
    for (const proibido of ["Simulad", "Bruno", "guarda.test", "1195555100", ana, bruno, brunoAntigo]) assert.ok(!texto.includes(proibido), proibido);
    const vazio = sim.rascunhoDoAviso({ ...a, porExecucao: {}, comExcecao: { VALOR_EM_ABERTO: 0, DISPUTA: 0 } }, r.lote);
    assert.match(vazio, /Nenhum cliente da sua empresa chega ao fim do prazo/);
  } finally { await c.query("ROLLBACK").catch(() => {}); await encerrarDescartavel(c); }
});
