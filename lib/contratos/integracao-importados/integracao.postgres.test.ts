import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { conectarDescartavel, encerrarDescartavel } from "../../comercial/postgres-descartavel.ts";
import { estruturaFesta019Sql } from "../../festas/estrutura-019.ts";
import {
  ambienteAssinatura, assinarComoCliente, carregar, catalogoNativo, catalogoNoTurno, cenario, completarCliente, congelarEAssinarKidmais, ctxIntegracao, decisoes, dia, executor, id, importacao,
  instalar055, instalar061, instalar062, integrar, ler, PARCIAL, poolNaTransacao, validarAgora, type Servico,
} from "../../../scripts/integracao-importados-test-support.ts";

/**
 * Integração de contrato importado no PostgreSQL REAL (061 + 062 + gatilhos 019/057/015).
 *
 * Execução: rodada R5 autorizada no cluster sintético em 04/10/2026, árvore local não mesclada: 20/20 (inclusive os
 * cenários [R5]); ajustes de fixture e o defeito de produto da 015 registrados na seção 16 do doc. Rodada R6
 * autorizada (04/10/2026): 24/24, inclusive os cenários [R6] (horário histórico fora dos turnos; transação e commit;
 * busca complementar de duplicados; corrida com datas divergentes).
 *
 * Só roda pelo `check:v1:postgres` no cluster descartável (127.0.0.1, banco kidmais_pacotes_v1_descartavel) com
 * KIDMAIS_POSTGRES_DESCARTAVEL definido; nunca em staging/produção nem no banco local `kidmais_manager`.
 * A execução depende de autorização explícita do Felipe (docs/OPERACAO_AGENTES.md).
 *
 * Instala 055a–d, a 061 e a 062 com os SCRIPTS REAIS (precheck/up/postcheck) — a integração só fica disponível com a
 * agenda por empresa e unidade — e usa o serviço real (`confirmarIntegracao` + `coreNativo`: fechamento, auditoria,
 * pagamentos e `registrarRecebimentoPagamento`). Cada cenário roda numa transação externa; `SET CONSTRAINTS ALL
 * IMMEDIATE` dispara as guardas DIFERIDAS (formalização, ocupação, vínculo, ledger 015) antes do ROLLBACK. A corrida
 * usa duas conexões e commit. Cenários sintéticos em scripts/integracao-importados-test-support.ts (compartilhados com a suíte da 062).
 */

test("061: integração real — formalização em papel, festa, agenda, recebíveis e caixa; idempotência; passado; conflito; recusas", { timeout: 600_000 }, async (t) => {
  if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== "kidmais_pacotes_v1_descartavel") { t.skip("opt-in ausente: harness PostgreSQL não executado"); return; }
  const a = await conectarDescartavel();
  const b = await conectarDescartavel({ travar: false });
  try {
    await instalar055(a);
    await instalar061(a);
    await instalar062(a);
    assert.equal((await a.query<{ valida: boolean }>(estruturaFesta019Sql)).rows[0].valida, true, "módulo Festa aceita o conjunto da 062");
    process.env.CONTRACT_IMPORT_INTEGRATION_ENABLED = "true";
    const s = carregar<Servico>("lib/contratos/integracao-importados/servico.ts");
    const { coreNativo } = carregar<typeof import("./composicao.ts")>("lib/contratos/integracao-importados/composicao.ts");
    const fin = carregar<typeof import("../../financeiro/servico.ts")>("lib/financeiro/servico.ts");
    // Subteste que falha no meio não pode deixar transação aberta (ou abortada) para o próximo.
    t.beforeEach(async () => { await a.query("ROLLBACK"); await b.query("ROLLBACK"); });

    await t.test("futuro parcialmente pago: Core completo, gatilhos diferidos aceitam, recebível e caixa nas datas reais", async () => {
      await a.query("BEGIN");
      const c = await cenario(a);
      const ev = { data: dia(45), inicio: "14:00", fim: "18:00" };
      const imp = await importacao(a, c, ev);
      const r = await integrar(s, coreNativo, a, c, imp.id, decisoes(c, ev, PARCIAL()));
      assert.equal(r.reutilizado, false);
      await validarAgora(a);
      const linha = (await a.query(`SELECT f.status, f.origem_fechamento, c.status contrato, v.aceite_metodo, v.documento_pdf_hash, v.documento_template_versao,
          (SELECT count(*)::int FROM contrato_assinaturas WHERE contrato_versao_id = v.id) assinaturas,
          (SELECT origem_criacao FROM festas WHERE contrato_id = c.id) festa, kidmais019_formalizacao(c.id, v.id) formal, kidmais019_ocupa(f.id) ocupa
        FROM contratos c JOIN fechamentos f ON f.id = c.fechamento_id JOIN contrato_versoes v ON v.contrato_id = c.id WHERE c.id = $1`, [r.contratoId])).rows[0];
      assert.deepEqual({ ...linha }, { status: "CONFIRMADO", origem_fechamento: "IMPORTACAO_HISTORICA", contrato: "ASSINADO", aceite_metodo: "CONFERENCIA_PAPEL",
        documento_pdf_hash: imp.sha, documento_template_versao: null, assinaturas: 0, festa: "IMPORTACAO_HISTORICA", formal: true, ocupa: true });
      const receber = await fin.listarRecebiveis(executor(a), c.empresa, dia(0));
      const doContrato = receber.filter((x: { cliente?: string }) => JSON.stringify(x).includes("Cliente 061"));
      assert.ok(doContrato.length >= 1, "parcela a receber em Contas a receber");
      const recebimento = (await a.query(`SELECT rec.recebido_em::date::text d, rec.status, rec.metadata_provedor->>'origem' origem FROM pagamento_recebimentos rec
          JOIN pagamentos p ON p.id = rec.pagamento_id JOIN contrato_versoes v ON v.id = p.contrato_versao_id WHERE v.contrato_id = $1`, [r.contratoId])).rows;
      assert.deepEqual(recebimento, [{ d: dia(-58), status: "CONFIRMADO", origem: "IMPORTACAO_HISTORICA" }]);
      const parcelas = (await a.query(`SELECT pp.status FROM pagamento_parcelas pp JOIN pagamento_planos pl ON pl.id = pp.plano_id JOIN pagamentos p ON p.id = pl.pagamento_id
          JOIN contrato_versoes v ON v.id = p.contrato_versao_id WHERE v.contrato_id = $1 ORDER BY pp.numero`, [r.contratoId])).rows.map((x) => x.status);
      assert.deepEqual(parcelas, ["PAGA", "PENDENTE"]);
      const caixa = await fin.fluxoCaixa(executor(a), c.empresa, dia(-90), dia(0), dia(0));
      assert.match(JSON.stringify(caixa), new RegExp(dia(-58)), "recebimento no Fluxo de caixa na data efetiva");
      // Repetir a mesma confirmação não duplica nada.
      const vinculo = (await a.query(`SELECT chave_idempotencia::text chave, payload_hash FROM contrato_importacoes WHERE importacao_id = $1`, [imp.id])).rows[0];
      const repetida = await s.confirmarIntegracao(executor(a), c.tenant as never, ctxIntegracao(c), imp.id,
        { decisoes: decisoes(c, ev, PARCIAL()), resumoHash: vinculo.payload_hash.trim(), chave: vinculo.chave }, dia(0), coreNativo as never);
      assert.equal(repetida.reutilizado, true);
      // [R2] Mesma chave com outro conteúdo: 409 (contrato da API), sem escrita.
      await assert.rejects(s.confirmarIntegracao(executor(a), c.tenant as never, ctxIntegracao(c), imp.id,
        { decisoes: decisoes(c, ev, PARCIAL()), resumoHash: "0".repeat(64), chave: vinculo.chave }, dia(0), coreNativo as never), (e: { code?: string }) => e.code === "IDEMPOTENCIA_CONFLITANTE");
      assert.equal((await a.query(`SELECT count(*)::int n FROM contrato_importacoes WHERE importacao_id = $1`, [imp.id])).rows[0].n, 1);
      // Imutabilidade e nenhuma assinatura digital sobre a versão de conferência.
      await a.query("SAVEPOINT s1");
      await assert.rejects(a.query(`UPDATE contrato_importacoes SET declaracao = declaracao || '.' WHERE importacao_id = $1`, [imp.id]), /imutável/);
      await a.query("ROLLBACK TO SAVEPOINT s1");
      await assert.rejects(a.query(`DELETE FROM contrato_importacoes WHERE importacao_id = $1`, [imp.id]), /imutável/);
      await a.query("ROLLBACK");
    });

    await t.test("pagamento não conferido: sem obrigação nem recebível; conferência posterior é idempotente", async () => {
      await a.query("BEGIN");
      const c = await cenario(a);
      const ev = { data: dia(50), inicio: "10:00", fim: "13:00" };
      const imp = await importacao(a, c, ev);
      const r = await integrar(s, coreNativo, a, c, imp.id, decisoes(c, ev, { situacao: "NAO_CONFERIDO" }));
      if (r.reutilizado) throw new Error("inesperado");
      await validarAgora(a);
      assert.equal((await a.query(`SELECT count(*)::int n FROM pagamentos p JOIN contrato_versoes v ON v.id = p.contrato_versao_id WHERE v.contrato_id = $1`, [r.contratoId])).rows[0].n, 0);
      const tx = executor(a);
      const simF = await s.simularFinanceiro(tx, c.tenant as never, imp.id, PARCIAL(), dia(0));
      if (simF.conferido) throw new Error("inesperado");
      const chave = randomUUID();
      const ctx = ctxIntegracao(c);
      await s.conferirFinanceiro(tx, c.tenant as never, ctx, imp.id, { financeiro: PARCIAL(), resumoHash: simF.resumoHash, chave }, dia(0), coreNativo as never);
      assert.equal((await s.conferirFinanceiro(tx, c.tenant as never, ctx, imp.id, { financeiro: PARCIAL(), resumoHash: simF.resumoHash, chave }, dia(0), coreNativo as never)).reutilizado, true);
      await validarAgora(a);
      assert.equal((await a.query(`SELECT situacao FROM contrato_importacao_financeiro f JOIN contrato_importacoes ci ON ci.id = f.contrato_importacao_id WHERE ci.importacao_id = $1`, [imp.id])).rows[0].situacao, "PARCIALMENTE_PAGO");
      await a.query("ROLLBACK");
    });

    await t.test("evento passado: fica fora da detecção de conflito só no slot integrado; remarcado, volta a ocupar e a ser validado", async () => {
      await a.query("BEGIN");
      const c = await cenario(a);
      const ev = { data: dia(-200), inicio: "14:00", fim: "18:00" };
      const pago = { situacao: "PAGO", parcelas: [{ valorCentavos: 500000, vencimento: dia(-210), recebimento: { data: dia(-209), forma: "DINHEIRO" } }] };
      const r1 = await integrar(s, coreNativo, a, c, (await importacao(a, c, ev)).id, decisoes(c, ev, pago));
      const r2 = await integrar(s, coreNativo, a, c, (await importacao(a, c, ev)).id, decisoes(c, ev, pago));
      await validarAgora(a);
      const estado = async (contratoId: string) => (await a.query(`SELECT kidmais019_ocupa(f.id) reserva, kidmais061_historico_passado(f.id) historico,
          EXISTS(SELECT 1 FROM kidmais_ocupacoes_operacionais(f.data_evento, f.data_evento) o WHERE o.fechamento_id = f.id) na_agenda, f.id fechamento
        FROM contratos c JOIN fechamentos f ON f.id = c.fechamento_id WHERE c.id = $1`, [contratoId])).rows[0];
      for (const r of [r1, r2]) {
        const e = await estado(r.contratoId);
        assert.deepEqual([e.reserva, e.historico, e.na_agenda], [true, true, false], "reserva vigente, fora da agenda, sem conflito no passado");
      }
      // Ocupação futura de outra contratação, para provar que a remarcação passa a ser validada.
      const futuro = { data: dia(150), inicio: "14:00", fim: "18:00" };
      await integrar(s, coreNativo, a, c, (await importacao(a, c, futuro)).id, decisoes(c, futuro, { situacao: "NAO_CONFERIDO" }));
      await validarAgora(a);
      const f1 = (await estado(r1.contratoId)).fechamento;
      // Remarcação (efeito da aplicação da revisão nativa sobre o fechamento) para o MESMO slot de outra festa: recusada.
      await a.query("SAVEPOINT remarca1");
      await a.query(`UPDATE fechamentos SET data_evento = $2::date WHERE id = $1`, [f1, futuro.data]);
      await assert.rejects(validarAgora(a), /Conflito/);
      await a.query("ROLLBACK TO SAVEPOINT remarca1");
      // Remarcação para slot livre no futuro: perde a isenção e passa a ocupar a agenda.
      await a.query("SAVEPOINT remarca2");
      await a.query(`UPDATE fechamentos SET data_evento = $2::date WHERE id = $1`, [f1, dia(160)]);
      await validarAgora(a);
      const depois = await estado(r1.contratoId);
      assert.deepEqual([depois.reserva, depois.historico, depois.na_agenda], [true, false, true], "remarcado: ocupa e é validado");
      // Mudar só o horário no próprio dia passado também tira a isenção (não é mais o slot integrado).
      await a.query("ROLLBACK TO SAVEPOINT remarca2");
      const f2 = (await estado(r2.contratoId)).fechamento;
      await a.query("SAVEPOINT remarca3");
      await a.query(`UPDATE fechamentos SET horario_inicio = '15:00' WHERE id = $1`, [f2]);
      await validarAgora(a);
      const mudado = await estado(r2.contratoId);
      assert.deepEqual([mudado.historico, mudado.na_agenda], [false, true], "fora do slot integrado: perde a isenção e ocupa");
      await a.query("ROLLBACK TO SAVEPOINT remarca3");
      await a.query("ROLLBACK");
    });

    await t.test("formalização: só a versão 1 conferida dispensa OTP; versão digital seguinte exige o fluxo nativo; vínculo forjado recusado", async () => {
      await a.query("BEGIN");
      const c = await cenario(a);
      const ev = { data: dia(170), inicio: "09:00", fim: "11:00" };
      const imp = await importacao(a, c, ev);
      const r = await integrar(s, coreNativo, a, c, imp.id, decisoes(c, ev, { situacao: "NAO_CONFERIDO" }));
      await validarAgora(a);
      const v1 = (await a.query(`SELECT id, snapshot FROM contrato_versoes WHERE contrato_id = $1`, [r.contratoId])).rows[0];
      // V2 "de conferência em papel": recusada (só a versão 1 do vínculo pode).
      await a.query("SAVEPOINT v2a");
      const v2 = await id(a, `INSERT INTO contrato_versoes (contrato_id, numero_versao, status, snapshot, snapshot_hash, assinado_em, documento_pdf_hash, aceite_metodo, motivo_nova_versao)
         VALUES ($1::uuid, 2, 'ASSINADA', $2::jsonb, $3, now(), $3, 'CONFERENCIA_PAPEL', 'tentativa') RETURNING id`, [r.contratoId, JSON.stringify(v1.snapshot), imp.sha]);
      await a.query(`INSERT INTO contrato_edicoes (contrato_versao_id, contrato_id, origem_versao_id, tipo, estado, dados_fonte, alteracoes, criado_por_usuario_id, atualizado_por_usuario_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'NOVA_VERSAO', 'CONCLUIDA', '{"schemaVersao":1}'::jsonb, '{}'::jsonb, $4::uuid, $4::uuid)`, [v2, r.contratoId, v1.id, c.usuario]);
      await assert.rejects(validarAgora(a), /Conferência histórica exige vínculo|Estado edição\/versão|Ponteiro|Vigência/);
      await a.query("ROLLBACK TO SAVEPOINT v2a");
      // V2 digital (OTP) sem assinaturas: o validador nativo recusa — o fluxo nativo continua obrigatório.
      await a.query("SAVEPOINT v2b");
      const v2b = await id(a, `INSERT INTO contrato_versoes (contrato_id, numero_versao, status, snapshot, snapshot_hash, assinado_em, documento_template_versao, documento_pdf_hash, aceite_metodo, motivo_nova_versao)
         VALUES ($1::uuid, 2, 'ASSINADA', $2::jsonb, $3, now(), 1, $3, 'OTP', 'remarcação') RETURNING id`, [r.contratoId, JSON.stringify(v1.snapshot), "b".repeat(64)]);
      await a.query(`INSERT INTO contrato_edicoes (contrato_versao_id, contrato_id, origem_versao_id, tipo, estado, dados_fonte, alteracoes, criado_por_usuario_id, atualizado_por_usuario_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'NOVA_VERSAO', 'CONCLUIDA', '{"schemaVersao":1}'::jsonb, '{}'::jsonb, $4::uuid, $4::uuid)`, [v2b, r.contratoId, v1.id, c.usuario]);
      await assert.rejects(validarAgora(a), /Assinatura Kidmais\/revisão ausente|Estado edição\/versão|Ponteiro|Vigência/);
      await a.query("ROLLBACK TO SAVEPOINT v2b");
      await a.query("ROLLBACK");
    });

    await t.test("vínculo validado no banco: hash do original, operador ativo da empresa e importação da mesma empresa", async () => {
      await a.query("BEGIN");
      const c = await cenario(a);
      const outra = await cenario(a);
      const ev = { data: dia(180), inicio: "09:00", fim: "11:00" };
      const imp = await importacao(a, c, ev);
      const r = await integrar(s, coreNativo, a, c, imp.id, decisoes(c, ev, { situacao: "NAO_CONFERIDO" }));
      const ci = (await a.query(`SELECT * FROM contrato_importacoes WHERE importacao_id = $1`, [imp.id])).rows[0];
      const forjar = async (mudar: Record<string, unknown>, motivo: RegExp) => {
        const l = { ...ci, ...mudar };
        await a.query("SAVEPOINT forja");
        await assert.rejects(a.query(`INSERT INTO contrato_importacoes (empresa_id, importacao_id, estabelecimento_id, cliente_id, fechamento_id, contrato_id, contrato_versao_id, documento_original_id,
            documento_sha256, situacao_contrato, financeiro_declarado, agenda_a_partir_de, data_evento, horario_inicio, horario_fim, decisoes, declaracao, chave_idempotencia, payload_hash, conferido_por, conferido_papel, conferido_em, request_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'VIGENTE',$10,CURRENT_DATE,CURRENT_DATE,'00:00','01:00','{}'::jsonb,$11,gen_random_uuid(),$12,$13,$14,now(),gen_random_uuid())`,
          [l.empresa_id, l.importacao_id, l.estabelecimento_id, l.cliente_id, l.fechamento_id, l.contrato_id, l.contrato_versao_id, l.documento_original_id, l.documento_sha256,
            l.financeiro_declarado, l.declaracao, l.payload_hash, l.conferido_por, l.conferido_papel]), motivo);
        await a.query("ROLLBACK TO SAVEPOINT forja");
      };
      await forjar({}, /duplicate key|importacao_uk/);
      await forjar({ documento_sha256: "d".repeat(64) }, /documento original não pertence|duplicate key/);
      await forjar({ conferido_por: outra.usuario }, /operador ativo da empresa|duplicate key/);
      await forjar({ empresa_id: outra.empresa }, /outra empresa|duplicate key|violates foreign key/);
      assert.ok(r.contratoId);
      await a.query("ROLLBACK");
    });

    await t.test("financeiro na MESMA conexão: sem DATABASE_URL, qualquer uso do pool global falharia; repetir não duplica recebimentos", async () => {
      assert.equal(process.env.DATABASE_URL, undefined, "o runner remove DATABASE_URL: só o executor da transação existe");
      await a.query("BEGIN");
      const c = await cenario(a);
      const ev = { data: dia(190), inicio: "16:00", fim: "19:00" };
      const imp = await importacao(a, c, ev);
      const total = { situacao: "PAGO", parcelas: [
        { valorCentavos: 166667, vencimento: dia(-90), recebimento: { data: dia(-90), forma: "PIX" } },
        { valorCentavos: 166667, vencimento: dia(-60), recebimento: { data: dia(-59), forma: "CARTAO_CREDITO" } },
        { valorCentavos: 166666, vencimento: dia(-30), recebimento: { data: dia(-31), forma: "DINHEIRO" } },
      ] };
      const chave = randomUUID();
      const r = await integrar(s, coreNativo, a, c, imp.id, decisoes(c, ev, total), chave);
      await validarAgora(a);
      const contar = async () => (await a.query(`SELECT count(*)::int n, sum(rec.valor_bruto)*100 c FROM pagamento_recebimentos rec JOIN pagamentos p ON p.id = rec.pagamento_id
          JOIN contrato_versoes v ON v.id = p.contrato_versao_id WHERE v.contrato_id = $1 AND rec.status = 'CONFIRMADO'`, [r.contratoId])).rows[0];
      assert.deepEqual({ ...(await contar()) }, { n: 3, c: "500000.00" }, "centavos: 1666,67 + 1666,67 + 1666,66 = 5000,00");
      const p = (await a.query(`SELECT p.status, p.quitado_em IS NOT NULL quitado FROM pagamentos p JOIN contrato_versoes v ON v.id = p.contrato_versao_id WHERE v.contrato_id = $1`, [r.contratoId])).rows[0];
      assert.deepEqual({ ...p }, { status: "QUITADO", quitado: true });
      const gravado = (await a.query(`SELECT payload_hash FROM contrato_importacoes WHERE importacao_id = $1`, [imp.id])).rows[0].payload_hash.trim();
      const repetida = await s.confirmarIntegracao(executor(a), c.tenant as never, ctxIntegracao(c), imp.id,
        { decisoes: decisoes(c, ev, total), resumoHash: gravado, chave }, dia(0), coreNativo as never);
      assert.equal(repetida.reutilizado, true);
      assert.deepEqual({ ...(await contar()) }, { n: 3, c: "500000.00" }, "nenhum recebimento duplicado");
      await a.query("ROLLBACK");
    });

    await t.test("confirmação concorrente da MESMA importação: a segunda espera o lock e reaproveita, sem duplicar", async () => {
      await a.query("BEGIN");
      const c = await cenario(a);
      const ev = { data: dia(200), inicio: "10:00", fim: "12:00" };
      const imp = await importacao(a, c, ev);
      await a.query("COMMIT");
      const chave = randomUUID();
      await a.query("BEGIN");
      await integrar(s, coreNativo, a, c, imp.id, decisoes(c, ev, PARCIAL()), chave);
      await b.query("BEGIN");
      await b.query("SET LOCAL lock_timeout = '2s'");
      await assert.rejects(integrar(s, coreNativo, b, c, imp.id, decisoes(c, ev, PARCIAL()), randomUUID()), /lock timeout|canceling statement/i, "espera o lock da importação");
      await b.query("ROLLBACK");
      await a.query("COMMIT");
      await b.query("BEGIN");
      const tx = executor(b);
      const gravado = (await b.query(`SELECT payload_hash FROM contrato_importacoes WHERE importacao_id = $1`, [imp.id])).rows[0].payload_hash.trim();
      const segunda = await s.confirmarIntegracao(tx, c.tenant as never, ctxIntegracao(c), imp.id,
        { decisoes: decisoes(c, ev, PARCIAL()), resumoHash: gravado, chave }, dia(0), coreNativo as never);
      assert.equal(segunda.reutilizado, true);
      assert.equal((await b.query(`SELECT count(*)::int n FROM contrato_importacoes WHERE importacao_id = $1`, [imp.id])).rows[0].n, 1);
      await b.query("ROLLBACK");
    });

    await t.test("conflito futuro: recusado pelo serviço; vínculo forjado e origem nativa recusados pelo banco", async () => {
      await a.query("BEGIN");
      const c = await cenario(a);
      const ev = { data: dia(70), inicio: "15:00", fim: "19:00" };
      await integrar(s, coreNativo, a, c, (await importacao(a, c, ev)).id, decisoes(c, ev, { situacao: "NAO_CONFERIDO" }));
      const segunda = await importacao(a, c, ev);
      await assert.rejects(integrar(s, coreNativo, a, c, segunda.id, decisoes(c, ev, { situacao: "NAO_CONFERIDO" })), /ocupado|indisponível/i);
      await a.query("SAVEPOINT s2");
      // Versão "de conferência" sem vínculo: a validação de fluxo recusa no commit.
      const outro = await cenario(a);
      const fech = await id(a, `INSERT INTO fechamentos (data_evento, horario_inicio, horario_fim, configuracao_agenda_id, empresa_id, pacote_id, tabela_preco_id, preco_pacote_id,
          categoria_horario, categoria_preco_aplicada, convidados, convidados_faturados, valor_pacote_base, valor_pacote_aplicado, valor_tabela, origem_fechamento, cliente_id, status)
        SELECT $1::date, '08:00', '09:00', (SELECT id FROM configuracao_agenda WHERE ativo ORDER BY ordem_exibicao LIMIT 1), $2::uuid, p.id, pp.tabela_preco_id, pp.id, 'PADRAO', 'PADRAO', 10, 10, 100, 100, 100,
               'ATENDIMENTO_KIDMAIS', NULL, 'AGUARDANDO_CONTRATO' FROM pacotes p JOIN precos_pacote pp ON pp.pacote_id = p.id WHERE p.id = $3::uuid RETURNING fechamentos.id`, [dia(80), outro.empresa, outro.pacote]);
      const contrato = await id(a, `INSERT INTO contratos (fechamento_id, status, versao_atual, assinado_em) VALUES ($1::uuid, 'ASSINADO', 1, now()) RETURNING id`, [fech]);
      const versao = await id(a, `INSERT INTO contrato_versoes (contrato_id, numero_versao, status, snapshot, snapshot_hash, assinado_em, documento_pdf_hash, aceite_metodo)
         VALUES ($1::uuid, 1, 'ASSINADA', '{}'::jsonb, $2, now(), $2, 'CONFERENCIA_PAPEL') RETURNING id`, [contrato, "a".repeat(64)]);
      await a.query(`INSERT INTO contrato_edicoes (contrato_versao_id, contrato_id, tipo, estado, dados_fonte, alteracoes, criado_por_usuario_id, atualizado_por_usuario_id)
         VALUES ($1::uuid, $2::uuid, 'INICIAL', 'CONCLUIDA', '{"schemaVersao":1}'::jsonb, '{}'::jsonb, $3::uuid, $3::uuid)`, [versao, contrato, outro.usuario]);
      await a.query(`INSERT INTO contrato_fluxos (contrato_id, versao_vigente_id) VALUES ($1::uuid, $2::uuid)`, [contrato, versao]);
      await assert.rejects(validarAgora(a), /Conferência histórica exige vínculo|Formalização exige/);
      await a.query("ROLLBACK TO SAVEPOINT s2");
      await a.query("ROLLBACK");
    });

    await t.test("[R2] conferência posterior de pagamentos: só na versão conferida VIGENTE — serviço e gatilho da 061 recusam a versão antiga", async () => {
      await a.query("BEGIN");
      const c = await cenario(a);
      const ev = { data: dia(210), inicio: "10:00", fim: "12:00" };
      const imp = await importacao(a, c, ev);
      const r = await integrar(s, coreNativo, a, c, imp.id, decisoes(c, ev, { situacao: "NAO_CONFERIDO" }));
      if (r.reutilizado) throw new Error("inesperado");
      await validarAgora(a);
      const tx = executor(a);
      const repo = carregar<typeof import("./repositorio.ts")>("lib/contratos/integracao-importados/repositorio.ts");
      const v1 = (await a.query(`SELECT id, snapshot, snapshot_hash FROM contrato_versoes WHERE contrato_id = $1`, [r.contratoId])).rows[0];
      const ci = (await a.query(`SELECT id FROM contrato_importacoes WHERE importacao_id = $1`, [imp.id])).rows[0];
      const v2 = await id(a, `INSERT INTO contrato_versoes (contrato_id, numero_versao, status, snapshot, snapshot_hash, motivo_nova_versao)
          VALUES ($1::uuid, 2, 'ATIVA', $2::jsonb, $3, 'Revisão de valores') RETURNING id`, [r.contratoId, JSON.stringify(v1.snapshot), v1.snapshot_hash]);
      // Obrigação (nativa) da versão 1 criada enquanto ela é a vigente.
      const pagamento = await coreNativo.criarPagamento(tx, { contratoVersaoId: v1.id, valorTotalContratado: 5000, criadoPorUsuarioId: c.usuario });
      const registro = (pagamentoId: string) => ({ empresaId: c.empresa, vinculoId: ci.id, pagamentoId, situacao: "NAO_PAGO" as const, contratado: 500000, recebido: 0, saldo: 500000,
        decisoes: { financeiro: { situacao: "NAO_PAGO" } }, chave: randomUUID(), payloadHash: "e".repeat(64), usuarioId: c.usuario, papel: "ADMINISTRATIVO", requestId: randomUUID() });
      // Controle positivo: com a v1 vigente, o gatilho aceita o registro.
      await a.query("SAVEPOINT positivo");
      await repo.inserirFinanceiro(tx, registro(pagamento.id) as never);
      await a.query("ROLLBACK TO SAVEPOINT positivo");
      // O contrato foi revisado (v2 vigente): o serviço bloqueia e o banco recusa a conferência sobre a v1.
      await a.query(`UPDATE contrato_fluxos SET versao_vigente_id = $2::uuid WHERE contrato_id = $1::uuid`, [r.contratoId, v2]);
      const sim = await s.simularFinanceiro(tx, c.tenant as never, imp.id, PARCIAL(), dia(0));
      if (sim.conferido) throw new Error("inesperado");
      assert.equal(sim.pronto, false);
      assert.match(sim.bloqueios.join(" "), /revisado depois da integração/);
      await a.query("SAVEPOINT banco");
      await assert.rejects(repo.inserirFinanceiro(tx, registro(pagamento.id) as never), /a versão conferida não é mais a vigente/);
      await a.query("ROLLBACK TO SAVEPOINT banco");
      await a.query("ROLLBACK");
    });

    await t.test("[R2] reescaneamento: o mesmo papel em OUTRO cliente aparece como possível duplicidade; sem decisão auditada não integra", async () => {
      await a.query("BEGIN");
      const c = await cenario(a);
      const ev = { data: dia(220), inicio: "14:00", fim: "18:00" };
      const original = await integrar(s, coreNativo, a, c, (await importacao(a, c, ev)).id, decisoes(c, ev, { situacao: "NAO_CONFERIDO" }));
      if (original.reutilizado) throw new Error("inesperado");
      // importacao() cria outro cliente e outro arquivo (outro sha256): mesmo aniversariante e mesmo valor.
      const reescaneado = await importacao(a, c, ev);
      const tx = executor(a);
      const motivos = { horarioInicio: "Segunda festa do dia, outro horário", horarioFim: "Segunda festa do dia, outro horário" };
      const semDecisao = { ...decisoes(c, { ...ev, inicio: "19:00", fim: "21:00" }, { situacao: "NAO_CONFERIDO" }, null, null), motivos };
      const sim = await s.simularIntegracao(tx, c.tenant as never, reescaneado.id, semDecisao, dia(0));
      if (sim.integrada) throw new Error("inesperado");
      assert.equal(sim.pronto, false);
      const candidato = sim.possiveisVinculos.find((v: { contratoId: string | null }) => v.contratoId === original.contratoId) as { sinais: string[]; importado: boolean };
      assert.ok(candidato, "a contratação integrada aparece como candidata");
      assert.deepEqual([candidato.importado, candidato.sinais.includes("MESMO_CLIENTE"), candidato.sinais.includes("MESMO_ANIVERSARIANTE"), candidato.sinais.includes("MESMO_VALOR")],
        [true, false, true, true]);
      await assert.rejects(s.confirmarIntegracao(tx, c.tenant as never, ctxIntegracao(c), reescaneado.id, { decisoes: semDecisao, resumoHash: sim.resumoHash, chave: randomUUID() }, dia(0), coreNativo as never),
        (e: { code?: string }) => e.code === "INTEGRACAO_BLOQUEADA");
      // Decisão com motivo: integra e grava a auditoria da decisão.
      const comDecisao = { ...decisoes(c, { ...ev, inicio: "19:00", fim: "21:00" }, { situacao: "NAO_CONFERIDO" }, null, { motivo: "Segunda festa no mesmo dia, outro contrato" }), motivos };
      const r = await integrar(s, coreNativo, a, c, reescaneado.id, comDecisao);
      await validarAgora(a);
      const auditoria = (await a.query(`SELECT justificativa, dados_depois FROM auditoria WHERE acao = 'POSSIVEL_DUPLICIDADE_DESCARTADA' AND entidade_id = $1`, [r.contratoId])).rows[0];
      assert.equal(auditoria.justificativa, "Segunda festa no mesmo dia, outro contrato");
      assert.ok(JSON.stringify(auditoria.dados_depois).includes(original.contratoId));
      await a.query("ROLLBACK");
    });

    await t.test("[R2] autenticação recente: sessão com senha há mais de 5 minutos não integra (403) e nada é gravado", async () => {
      await a.query("BEGIN");
      const c = await cenario(a);
      const ev = { data: dia(230), inicio: "14:00", fim: "18:00" };
      const imp = await importacao(a, c, ev);
      const d = decisoes(c, ev, { situacao: "NAO_CONFERIDO" });
      const tx = executor(a);
      const sim = await s.simularIntegracao(tx, c.tenant as never, imp.id, d, dia(0));
      if (sim.integrada) throw new Error("inesperado");
      await assert.rejects(s.confirmarIntegracao(tx, c.tenant as never, ctxIntegracao(c, new Date(Date.now() - 6 * 60 * 1000).toISOString()), imp.id,
        { decisoes: d, resumoHash: sim.resumoHash, chave: randomUUID() }, dia(0), coreNativo as never), (e: { code?: string; httpStatus?: number }) => e.code === "REAUTENTICACAO_NECESSARIA" && e.httpStatus === 403);
      assert.equal((await a.query(`SELECT count(*)::int n FROM fechamentos WHERE empresa_id = $1 AND origem_fechamento = 'IMPORTACAO_HISTORICA'`, [c.empresa])).rows[0].n, 0);
      await a.query("ROLLBACK");
    });

    await t.test("[R3] exceção histórica no banco: parcela depois da festa só com a confirmação gravada para a mesma parcela e vencimento", async () => {
      await a.query("BEGIN");
      const c = await cenario(a);
      const ev = { data: dia(240), inicio: "14:00", fim: "18:00" };
      const imp = await importacao(a, c, ev);
      const r = await integrar(s, coreNativo, a, c, imp.id, decisoes(c, ev, { situacao: "NAO_CONFERIDO" }));
      if (r.reutilizado) throw new Error("inesperado");
      await validarAgora(a);
      const tx = executor(a);
      const repo = carregar<typeof import("./repositorio.ts")>("lib/contratos/integracao-importados/repositorio.ts");
      const v1 = (await a.query(`SELECT id FROM contrato_versoes WHERE contrato_id = $1`, [r.contratoId])).rows[0].id as string;
      const ci = (await a.query(`SELECT id FROM contrato_importacoes WHERE importacao_id = $1`, [imp.id])).rows[0].id as string;
      // Plano com a parcela 2 depois da festa (gravado pelos repositórios nativos, como a integração faz).
      const pagamento = await coreNativo.criarPagamento(tx, { contratoVersaoId: v1, valorTotalContratado: 5000, criadoPorUsuarioId: c.usuario });
      const plano = await coreNativo.criarPlano(tx, { pagamentoId: pagamento.id, numeroVersao: 1, meioPagamento: "PIX", modalidade: "PARCELADO", quantidadeParcelas: 2, observacoes: "teste", criadoPorUsuarioId: c.usuario });
      await coreNativo.criarParcela(tx, { planoId: plano.id, numero: 1, valorPrevisto: 2000, vencimento: dia(230), confirmaReserva: true });
      await coreNativo.criarParcela(tx, { planoId: plano.id, numero: 2, valorPrevisto: 3000, vencimento: dia(260), confirmaReserva: false });
      const registro = (parcela2: Record<string, unknown>) => ({ empresaId: c.empresa, vinculoId: ci, pagamentoId: pagamento.id, situacao: "NAO_PAGO" as const, contratado: 500000, recebido: 0, saldo: 500000,
        decisoes: { financeiro: { situacao: "NAO_PAGO", parcelas: [{ valorCentavos: 200000, vencimento: dia(230), recebimento: null }, { valorCentavos: 300000, recebimento: null, ...parcela2 }] } },
        chave: randomUUID(), payloadHash: "e".repeat(64), usuarioId: c.usuario, papel: "ADMINISTRATIVO", requestId: randomUUID() });
      for (const [parcela2, motivo] of [
        [{ vencimento: dia(260) }, "sem confirmação"],
        [{ vencimento: dia(260), aposFestaConfirmada: false }, "confirmação negada"],
        [{ vencimento: dia(261), aposFestaConfirmada: true }, "confirmação de outro vencimento"],
      ] as const) {
        await a.query("SAVEPOINT exc");
        await assert.rejects(repo.inserirFinanceiro(tx, registro(parcela2) as never), /parcela vence depois da festa sem a exceção histórica confirmada/, motivo);
        await a.query("ROLLBACK TO SAVEPOINT exc");
      }
      await repo.inserirFinanceiro(tx, registro({ vencimento: dia(260), aposFestaConfirmada: true }) as never);
      assert.equal((await a.query(`SELECT vencimento::text v FROM pagamento_parcelas WHERE plano_id = $1 AND numero = 2`, [plano.id])).rows[0].v, dia(260), "vencimento não alterado");
      await a.query("ROLLBACK");
    });

    await t.test("[R3] depois de revisão: a conferência da v1 é recusada e o caminho oficial cria o plano na versão vigente; recebimento com data real", async () => {
      await a.query("BEGIN");
      const c = await cenario(a);
      const ev = { data: dia(250), inicio: "14:00", fim: "18:00" };
      const imp = await importacao(a, c, ev);
      const r = await integrar(s, coreNativo, a, c, imp.id, decisoes(c, ev, { situacao: "NAO_CONFERIDO" }));
      if (r.reutilizado) throw new Error("inesperado");
      await validarAgora(a);
      const tx = executor(a);
      const { hashSnapshotContrato } = carregar<typeof import("../services/snapshot-core.ts")>("lib/contratos/services/snapshot-core.ts");
      const { criarPagamentoDoFechamento } = carregar<typeof import("../../pagamentos/services/pagamento.service.ts")>("lib/pagamentos/services/pagamento.service.ts");
      const k = (await a.query(`SELECT k.fechamento_id, v.snapshot FROM contratos k JOIN contrato_versoes v ON v.contrato_id = k.id WHERE k.id = $1`, [r.contratoId])).rows[0];
      const contextoPagamento = { usuarioId: c.usuario, origem: "ADMIN_FINANCEIRO", requestId: randomUUID(), ip: null, userAgent: "h061", executor: tx };
      const plano = { meioPagamento: "PIX" as const, modalidade: "AVISTA" as const, parcelas: [{ valor: 5200, vencimento: dia(240), confirmaReserva: true }] };
      // Na v1 (ainda vigente), o caminho oficial é "Conferir pagamentos": o plano nativo recusa.
      await assert.rejects(criarPagamentoDoFechamento({ fechamentoId: k.fechamento_id, plano } as never, contextoPagamento as never), (e: { code?: string }) => e.code === "CONFERENCIA_HISTORICA_PENDENTE");
      // Revisão concluída (v2 assinada e vigente, valor revisado): simulação direta do estado final do fluxo nativo.
      const snapshot2 = { ...k.snapshot, origem: undefined, historico: undefined, comercial: { ...k.snapshot.comercial, valorFinalContrato: 5200, formaPagamentoPretendida: "PIX_AVISTA" } };
      delete snapshot2.origem; delete snapshot2.historico;
      const v2 = await id(a, `INSERT INTO contrato_versoes (contrato_id, numero_versao, status, snapshot, snapshot_hash, assinado_em, documento_template_versao, documento_pdf_hash, aceite_metodo, motivo_nova_versao)
          VALUES ($1::uuid, 2, 'ASSINADA', $2::jsonb, $3, now(), 1, $4, 'OTP', 'Revisão de valor') RETURNING id`, [r.contratoId, JSON.stringify(snapshot2), hashSnapshotContrato(snapshot2), "f".repeat(64)]);
      await a.query(`UPDATE contratos SET versao_atual = 2 WHERE id = $1`, [r.contratoId]);
      await a.query(`UPDATE contrato_fluxos SET versao_vigente_id = $2::uuid WHERE contrato_id = $1::uuid`, [r.contratoId, v2]);
      const simF = await s.simularFinanceiro(tx, c.tenant as never, imp.id, PARCIAL(), dia(0));
      if (simF.conferido) throw new Error("inesperado");
      assert.match(simF.bloqueios.join(" "), /Criar plano financeiro/, "a recusa da v1 aponta o caminho oficial");
      const criado = await criarPagamentoDoFechamento({ fechamentoId: k.fechamento_id, plano } as never, contextoPagamento as never) as { detalhe: { pagamento: { id: string } } };
      const pag = (await a.query(`SELECT p.contrato_versao_id::text v, p.valor_total_contratado::text valor, p.reserva_status FROM pagamentos p WHERE p.id = $1`, [criado.detalhe.pagamento.id])).rows[0];
      assert.deepEqual([pag.v, Number(pag.valor), pag.reserva_status], [v2, 5200, "CONFIRMADA"], "obrigação na versão VIGENTE, com o valor revisado; reserva confirmada");
      assert.equal((await a.query(`SELECT status FROM fechamentos WHERE id = $1`, [k.fechamento_id])).rows[0].status, "CONFIRMADO", "reserva histórica continua confirmada");
      // Recebimento já feito, com a data real (passada), pelo serviço nativo.
      const parcela = (await a.query(`SELECT pp.id FROM pagamento_parcelas pp JOIN pagamento_planos pl ON pl.id = pp.plano_id WHERE pl.pagamento_id = $1`, [criado.detalhe.pagamento.id])).rows[0].id;
      await coreNativo.registrarRecebimento({ pagamentoId: criado.detalhe.pagamento.id, meioPagamento: "PIX", valorBruto: 5200, recebidoEm: `${dia(-30)}T12:00:00.000Z`, chaveIdempotencia: randomUUID(),
        observacoes: "Recebimento histórico", metadataProvedor: {}, confirmarAgora: true, alocacoes: [{ parcelaId: parcela, valor: 5200 }] },
        { token: c.token, usuarioId: c.usuario, origem: "ADMIN_FINANCEIRO", requestId: randomUUID(), ip: null, userAgent: "h061", executor: tx, aoConfirmar: async () => undefined });
      assert.equal((await a.query(`SELECT recebido_em::date::text d FROM pagamento_recebimentos WHERE pagamento_id = $1`, [criado.detalhe.pagamento.id])).rows[0].d, dia(-30));
      await a.query("ROLLBACK");
    });

    await t.test("[R5] página pública e resumo em PDF a partir da versão PERSISTIDA do contrato histórico (snapshot real, sem enriquecer)", async () => {
      await a.query("BEGIN");
      const c = await cenario(a);
      const ev = { data: dia(270), inicio: "14:00", fim: "18:00" };
      const r = await integrar(s, coreNativo, a, c, (await importacao(a, c, ev)).id, decisoes(c, ev, { situacao: "NAO_CONFERIDO" }));
      if (r.reutilizado) throw new Error("inesperado");
      await validarAgora(a);
      const tx = executor(a);
      const repoContrato = carregar<typeof import("../repositories/contrato.repository.ts")>("lib/contratos/repositories/contrato.repository.ts");
      const publico = carregar<typeof import("../services/contrato-publico.service.ts")>("lib/contratos/services/contrato-publico.service.ts");
      const documento = carregar<typeof import("../services/documento.service.ts")>("lib/contratos/services/documento.service.ts");
      const contrato = (await repoContrato.buscarContratoPorId(r.contratoId, tx))!;
      const versao = (await repoContrato.buscarVersaoCorrente(r.contratoId, tx))!;
      assert.equal(versao.aceiteMetodo, "CONFERENCIA_PAPEL");
      assert.equal((versao.snapshot.contratante as unknown as Record<string, unknown>).endereco, undefined, "snapshot persistido sem endereço (como a importação grava)");
      const gerado = documento.gerarResumoContratacaoPdfDaVersao(versao);
      assert.equal(Buffer.from(gerado.pdf).subarray(0, 5).toString(), "%PDF-");
      const linhas = gerado.documento.linhas.map((l) => l.texto).join("\n");
      assert.match(linhas, /Endereço: Não informado/);
      assert.match(linhas, /Contrato assinado em papel/);
      assert.doesNotMatch(linhas, /undefined|aceite eletrônico/);
      const contexto = await publico.montarContextoContratoPublico(contrato, versao, [], async () => { throw new Error("documento eletrônico não deveria ser lido"); });
      assert.deepEqual([contexto.assinatura.tipo, contexto.aceitePermitido, contexto.versao.contratoOficial.disponivel, contexto.comprovantes.length], ["PAPEL", false, false, 0]);
      await a.query("ROLLBACK");
    });

    await t.test("[R5] duplicidade concorrente: dois scans distintos confirmados ao mesmo tempo (evento passado e slots diferentes) — o segundo espera, vê o primeiro e exige decisão auditada", async () => {
      const obs = await conectarDescartavel({ travar: false });
      const pid = async (db: typeof a) => (await db.query<{ p: number }>("SELECT pg_backend_pid() p")).rows[0].p;
      const esperandoLock = async (p: number) => {
        for (let i = 0; i < 200; i++) {
          if ((await obs.query<{ w: string | null }>("SELECT wait_event_type w FROM pg_stat_activity WHERE pid = $1", [p])).rows[0]?.w === "Lock") return;
          await new Promise((res) => setTimeout(res, 25));
        }
        assert.fail(`conexão ${p} não chegou a esperar lock`);
      };
      try {
        const [, pidB] = [await pid(a), await pid(b)];
        for (const [rotulo, ev1, ev2] of [
          ["evento passado (agenda não serializa)", { data: dia(-300), inicio: "14:00", fim: "18:00" }, { data: dia(-300), inicio: "19:00", fim: "21:00" }],
          ["evento futuro em slots diferentes", { data: dia(280), inicio: "10:00", fim: "13:00" }, { data: dia(280), inicio: "15:00", fim: "18:00" }],
          // [R6] Datas divergentes (7 dias): a serialização é por empresa e a busca complementar vê a outra data.
          ["[R6] datas divergentes (busca complementar)", { data: dia(320), inicio: "14:00", fim: "18:00" }, { data: dia(327), inicio: "14:00", fim: "18:00" }],
        ] as const) {
          await a.query("BEGIN");
          const c = await cenario(a);
          const imp1 = await importacao(a, c, ev1);
          const imp2 = await importacao(a, c, ev2); // outro arquivo e outro cliente; mesmo aniversariante e valor
          await a.query("COMMIT");
          const d1 = decisoes(c, ev1, { situacao: "NAO_CONFERIDO" }, null, null);
          const d2 = decisoes(c, ev2, { situacao: "NAO_CONFERIDO" }, null, null);
          await a.query("BEGIN");
          const sim1 = await s.simularIntegracao(executor(a), c.tenant as never, imp1.id, d1, dia(0));
          if (sim1.integrada || !sim1.pronto) throw new Error(`${rotulo}: simulação 1 ${JSON.stringify(sim1)}`);
          const r1 = await s.confirmarIntegracao(executor(a), c.tenant as never, ctxIntegracao(c), imp1.id, { decisoes: d1, resumoHash: sim1.resumoHash, chave: randomUUID() }, dia(0), coreNativo as never);
          // A ainda não terminou: B revisa sem ver o primeiro e tenta confirmar ao mesmo tempo.
          await b.query("BEGIN");
          await b.query("SET LOCAL lock_timeout = '20s'");
          const sim2 = await s.simularIntegracao(executor(b), c.tenant as never, imp2.id, d2, dia(0));
          if (sim2.integrada || !sim2.pronto) throw new Error(`${rotulo}: simulação 2 ${JSON.stringify(sim2)}`);
          const corrida = s.confirmarIntegracao(executor(b), c.tenant as never, ctxIntegracao(c), imp2.id, { decisoes: d2, resumoHash: sim2.resumoHash, chave: randomUUID() }, dia(0), coreNativo as never)
            .then(() => "ok", (e: { code?: string; details?: Record<string, unknown> }) => e);
          await esperandoLock(pidB);
          await a.query("COMMIT");
          const resultado = await corrida as { code?: string; details?: { possiveisVinculos?: Array<{ contratoId: string | null }> } };
          assert.equal(resultado.code, "RESUMO_DESATUALIZADO", `${rotulo}: a segunda confirmação não pode integrar sem ver a primeira`);
          assert.ok(resultado.details?.possiveisVinculos?.some((v) => v.contratoId === r1.contratoId), rotulo);
          await b.query("ROLLBACK");
          // Nova revisão: o candidato aparece; sem decisão não integra; com decisão e motivo integra e audita.
          await b.query("BEGIN");
          const sim3 = await s.simularIntegracao(executor(b), c.tenant as never, imp2.id, d2, dia(0));
          if (sim3.integrada) throw new Error("inesperado");
          assert.equal(sim3.pronto, false, rotulo);
          const d3 = decisoes(c, ev2, { situacao: "NAO_CONFERIDO" }, null, { motivo: "Outro contrato: festa do irmão no mesmo dia" });
          const sim4 = await s.simularIntegracao(executor(b), c.tenant as never, imp2.id, d3, dia(0));
          if (sim4.integrada || !sim4.pronto) throw new Error(`${rotulo}: simulação 4 ${JSON.stringify(sim4)}`);
          const r2 = await s.confirmarIntegracao(executor(b), c.tenant as never, ctxIntegracao(c), imp2.id, { decisoes: d3, resumoHash: sim4.resumoHash, chave: randomUUID() }, dia(0), coreNativo as never);
          if (r2.reutilizado) throw new Error("inesperado");
          await validarAgora(b);
          const auditoria = (await b.query(`SELECT justificativa, dados_depois FROM auditoria WHERE acao = 'POSSIVEL_DUPLICIDADE_DESCARTADA' AND entidade_id = $1`, [r2.contratoId])).rows[0];
          assert.equal(auditoria.justificativa, "Outro contrato: festa do irmão no mesmo dia");
          assert.ok(JSON.stringify(auditoria.dados_depois).includes(r1.contratoId));
          await b.query("ROLLBACK");
        }
      } finally {
        await a.query("ROLLBACK").catch(() => undefined);
        await b.query("ROLLBACK").catch(() => undefined);
        await encerrarDescartavel(obs, false);
      }
    });

    await t.test("[R5] revisão e assinaturas NATIVAS sobre o contrato histórico (diferidas validadas) e edição financeira real preservando o vencimento histórico", async () => {
      await a.query("BEGIN");
      const restaurarPool = poolNaTransacao(a);
      const restaurarAmbiente = ambienteAssinatura();
      try {
        const c = await cenario(a);
        const nativo = await catalogoNativo(a, c);
        // Horário que o turno nativo oferece (padrão 10:00–22:00): a revisão nativa só aceita destino entre os horários
        // candidatos do turno. Contrato histórico fora deles não entra na revisão nativa (limitação registrada na matriz R5).
        const ev = { data: dia(20), inicio: "10:00", fim: "22:00" };
        const imp = await importacao(a, c, ev);
        const cpf = await completarCliente(a, imp.cliente);
        // Parcela 2 vence DEPOIS da festa, conforme o contrato original (exceção histórica confirmada).
        const financeiro = { situacao: "PARCIALMENTE_PAGO", parcelas: [
          { valorCentavos: 150000, vencimento: dia(-60), recebimento: { data: dia(-58), forma: "PIX" } },
          { valorCentavos: 350000, vencimento: dia(30), recebimento: null, aposFestaConfirmada: true },
        ] };
        const r = await integrar(s, coreNativo, a, c, imp.id, decisoes(c, ev, financeiro));
        if (r.reutilizado) throw new Error("inesperado");
        await validarAgora(a);
        const tx = executor(a);
      const adm = carregar<typeof import("../services/administrativo.service.ts")>("lib/contratos/services/administrativo.service.ts");
      const rs = carregar<typeof import("../../fechamentos/services/revisao-operacional.service.ts")>("lib/fechamentos/services/revisao-operacional.service.ts");
      const operar = adm.operarContrato as unknown as Parameters<typeof congelarEAssinarKidmais>[1];
      const ctxOp = () => ({ requestId: randomUUID(), ip: null, userAgent: "r5" });
        const v1 = (await a.query<{ id: string }>(`SELECT id FROM contrato_versoes WHERE contrato_id = $1 AND numero_versao = 1`, [r.contratoId])).rows[0].id;
        // 1. Revisão NATIVA: nova versão, edição (remarcação dentro do prazo e condição PIX parcelado), PDF, revisão, assinatura Kidmais, liberação.
        await operar(v1, { acao: "nova_versao", tipo: "NOVA_VERSAO", motivo: "Remarcação e condição PIX parcelado", chaveCriacao: randomUUID() }, c.token, ctxOp(), c.empresa);
        const v2 = (await a.query<{ id: string }>(`SELECT versao_em_preparacao_id id FROM contrato_fluxos WHERE contrato_id = $1`, [r.contratoId])).rows[0].id;
        const fonte = (await rs.fontesPreparacao(v2, tx))!;
        const revisao = (await a.query<{ revisao: number }>(`SELECT revisao FROM contrato_edicoes WHERE contrato_versao_id = $1`, [v2])).rows[0].revisao;
        await operar(v2, { acao: "editar_festa", revisao, motivo: "Remarcação pedida pelo cliente", fonteHash: fonte.fonteHash, pacoteId: c.pacote, convidados: 50,
          dataEvento: dia(25), configuracaoAgendaId: nativo.turno, horarioInicio: "10:00", horarioFim: "22:00", adicionais: fonte.adicionais,
          idadeAniversarianteEvento: 6, temaFesta: "Circo", buffetStatus: "PENDENTE", buffetSalgados: "", buffetBebidas: "", buffetDoces: "", buffetBolo: "", buffetOutros: "",
          observacoesEquipe: "Revisão nativa do contrato histórico",
          comercial: { confirmarAprovacao: true, forma: "PIX_PARCELADO", baseNegociada: 6000, condicaoPix: { quantidadeParcelas: 2 } } }, c.token, ctxOp(), c.empresa);
        await congelarEAssinarKidmais(a, operar, v2, c.empresa, c.token, nativo.tokenRepresentante);
        // 2. Assinatura do cliente pelo fluxo público real: UPDATE de contrato_fluxos (vigente = v2) e pendência financeira.
        await assinarComoCliente(r.contratoId, cpf);
        await validarAgora(a);
        const fluxo = (await a.query(`SELECT versao_vigente_id::text v FROM contrato_fluxos WHERE contrato_id = $1`, [r.contratoId])).rows[0];
        assert.equal(fluxo.v, v2, "v2 vigente pela assinatura nativa");
        assert.equal((await a.query(`SELECT data_evento::text d FROM fechamentos f JOIN contratos k ON k.fechamento_id = f.id WHERE k.id = $1`, [r.contratoId])).rows[0].d, dia(25));
        // 3. A conferência histórica da v1 segue recusada (versão não vigente).
        const simF = await s.simularFinanceiro(tx, c.tenant as never, imp.id, PARCIAL(), dia(0));
        if (!simF.conferido) assert.equal(simF.pronto, false);
        // 4. Edição financeira REAL: a pendência existe (condição mudou), mas o vencimento histórico confirmado não é motivo.
        const repo = carregar<typeof import("../../pagamentos/repositories/alteracao-financeira.repository.ts")>("lib/pagamentos/repositories/alteracao-financeira.repository.ts");
        const af = carregar<typeof import("../../pagamentos/services/alteracao-financeira.service.ts")>("lib/pagamentos/services/alteracao-financeira.service.ts");
        const core = carregar<typeof import("../../pagamentos/services/alteracao-financeira-core.ts")>("lib/pagamentos/services/alteracao-financeira-core.ts");
        let p = await repo.lerPosicaoFinanceira(tx, r.contratoId);
        assert.equal(p.forma, "PIX_PARCELADO");
        assert.ok(!p.motivos.includes("CRONOGRAMA_DATA"), "vencimento histórico confirmado não obriga reprogramação");
        const pendencia = p.pendencias.find((x) => x.versao_nova_id === p.vigente.id)!;
        assert.ok(pendencia, "pendência da troca de condição");
        const historica = p.futuro.find((i) => i.vencimento === dia(30))!;
        assert.ok(historica && p.excecoesHistoricas.size === 1);
        const ctxFin = { token: c.token, requestId: randomUUID(), ip: null, userAgent: "r5", executor: tx, papelNoTenant: "ADMINISTRATIVO" };
        const tratamento = await af.iniciarTratamento(r.contratoId, pendencia.id, p.posicaoHash, randomUUID(), ctxFin as never) as { resultado?: { tratamentoId?: string } };
        p = await repo.lerPosicaoFinanceira(tx, r.contratoId);
        const tratamentoId = tratamento.resultado?.tratamentoId ?? p.tratamentos.find((x) => x.estado === "EM_TRATAMENTO")!.id;
        const pedido = (parcelas: Array<{ parcelaId?: string; valorCentavos: string; vencimento: string }>) =>
          ({ posicaoHash: p.posicaoHash, modo: "MANTER_E_COMPLEMENTAR", parcelas, credito: "NAO_SE_APLICA", decisaoContratante: "NAO_SE_APLICA", justificativa: "Mantém o cronograma do contrato original" });
        // Saldo futuro da versão vigente, pela mesma conta do serviço: a parcela histórica + complemento ANTES da festa.
        const saldoNovo = core.posicaoEconomica(p.valorVigente, 0n, p.posicao.recebido, p.posicao.estornado, p.posicao.devolvido, p.posicao.reservado).saldo;
        const complemento = saldoNovo - BigInt(historica.valorCentavos);
        assert.ok(complemento >= 0n, `saldo novo ${saldoNovo} menor que a parcela histórica ${historica.valorCentavos}`);
        const extra = complemento > 0n ? [{ valorCentavos: complemento.toString(), vencimento: dia(10) }] : [];
        // 4a. Alterar o vencimento da parcela histórica: regra da versão vigente (PIX até a festa) recusa.
        await assert.rejects(af.simularAlteracao(r.contratoId, tratamentoId, pedido([{ parcelaId: historica.parcelaId, valorCentavos: historica.valorCentavos, vencimento: dia(31) }, ...extra]) as never, tx),
          (e: { code?: string }) => ["PIX_APOS_DATA_FESTA", "PARCELA_NAO_PRESERVAVEL"].includes(String(e.code)));
        // 4b. Parcela NOVA depois da festa (mesmo vencimento): não herda a exceção.
        await assert.rejects(af.simularAlteracao(r.contratoId, tratamentoId, { ...pedido([{ valorCentavos: historica.valorCentavos, vencimento: dia(30) }, ...extra]), modo: "PERSONALIZADO" } as never, tx),
          (e: { code?: string }) => e.code === "PIX_APOS_DATA_FESTA");
        // 4c. Preservação legítima: mesma parcela, mesmo saldo e vencimento — aceita e resolvida pelo serviço nativo.
        await af.resolverAlteracao(r.contratoId, tratamentoId, pedido([{ parcelaId: historica.parcelaId, valorCentavos: historica.valorCentavos, vencimento: historica.vencimento }, ...extra]) as never, randomUUID(), ctxFin as never);
        await validarAgora(a);
        const depois = await repo.lerPosicaoFinanceira(tx, r.contratoId);
        assert.ok(depois.futuro.some((i) => i.parcelaId === historica.parcelaId && i.vencimento === dia(30)), "vencimento histórico preservado");
        // 5. N3: plano substituto (versão 2) com a mesma numeração e vencimento não herda a exceção.
        await a.query("SAVEPOINT plano2");
        const plano1 = (await a.query<{ id: string }>(`SELECT id FROM pagamento_planos WHERE pagamento_id = $1 AND numero_versao = 1`, [depois.pagamento.id])).rows[0].id;
        // Planos criados pelo próprio serviço nativo na resolução (versão > 1) também não herdam.
        const nativos = (await a.query<{ id: string }>(`SELECT pp.id::text id FROM pagamento_parcelas pp JOIN pagamento_planos pl ON pl.id = pp.plano_id WHERE pl.pagamento_id = $1 AND pl.numero_versao > 1`, [depois.pagamento.id])).rows;
        assert.ok(nativos.every((n) => ![...depois.excecoesHistoricas].some((k) => k.startsWith(n.id.toLowerCase()))), "plano da resolução nativa fora da exceção");
        await a.query(`UPDATE pagamento_planos SET status = 'SUBSTITUIDO', substituido_em = clock_timestamp() WHERE pagamento_id = $1 AND status = 'ATIVO'`, [depois.pagamento.id]);
        const proxima = (await a.query<{ n: number }>(`SELECT max(numero_versao) + 1 n FROM pagamento_planos WHERE pagamento_id = $1`, [depois.pagamento.id])).rows[0].n;
        assert.ok(plano1);
        const plano2 = await coreNativo.criarPlano(tx, { pagamentoId: depois.pagamento.id, numeroVersao: proxima, meioPagamento: "PIX", modalidade: "PARCELADO", quantidadeParcelas: 2, observacoes: "substituto sintético", criadoPorUsuarioId: c.usuario });
        await coreNativo.criarParcela(tx, { planoId: plano2.id, numero: 1, valorPrevisto: 1500, vencimento: dia(-60), confirmaReserva: true });
        const nova = await coreNativo.criarParcela(tx, { planoId: plano2.id, numero: 2, valorPrevisto: 3500, vencimento: dia(30), confirmaReserva: false });
        const excecoes = await repo.excecoesHistoricasDoPagamento(tx, depois.pagamento.id);
        assert.ok(![...excecoes].some((k) => k.startsWith(nova.id.toLowerCase())), "parcela do plano substituto não herda a exceção");
        assert.ok([...excecoes].some((k) => k.startsWith(historica.parcelaId.toLowerCase())), "parcela do plano histórico mantém a exceção");
        // O gatilho financeiro diferido (015 via 061) usa o mesmo critério.
        const noBanco = async (parcela: string) => (await a.query<{ ok: boolean }>(`SELECT public.kidmais061_excecao_historica($1::uuid, $2::date) ok`, [parcela, dia(30)])).rows[0].ok;
        assert.equal(await noBanco(nova.id), false, "banco: parcela nova não herda");
        assert.equal(await noBanco(historica.parcelaId), true, "banco: parcela histórica mantém");
        await a.query("ROLLBACK TO SAVEPOINT plano2");
      } finally {
        restaurarAmbiente();
        restaurarPool();
        await a.query("ROLLBACK");
      }
    });

    /**
     * [R6] Contrato histórico no horário original FORA dos candidatos do turno (decisão de 04/10/2026). A integração
     * grava 14:00–18:00 no turno TURNO_1 (11:00–15:00, tolerância 30): o horário não é candidato. A precondição é
     * conferida no próprio teste antes de qualquer revisão.
     */
    const historicoForaDoTurno = async (data: string) => {
      const c = await cenario(a);
      const nativo = await catalogoNativo(a, c);
      const ev = { data, inicio: "14:00", fim: "18:00" };
      const imp = await importacao(a, c, ev);
      const cpf = await completarCliente(a, imp.cliente);
      const r = await integrar(s, coreNativo, a, c, imp.id, decisoes(c, ev, PARCIAL()));
      if (r.reutilizado) throw new Error("inesperado");
      await validarAgora(a);
      const tx = executor(a);
      const f = (await a.query<{ id: string; turno: string }>(`SELECT f.id::text, f.configuracao_agenda_id::text turno FROM fechamentos f JOIN contratos k ON k.fechamento_id = f.id WHERE k.id = $1`, [r.contratoId])).rows[0];
      await catalogoNoTurno(a, c, f.turno);
      const disp = carregar<typeof import("../../disponibilidade/services/availability.service.ts")>("lib/disponibilidade/services/availability.service.ts");
      const periodo = (await disp.consultarDisponibilidadeData(data, tx, f.id)).periodos.find((p) => p.configuracaoId === f.turno)!;
      assert.ok(periodo && !periodo.horarios.some((h) => h.inicio === "14:00" && h.fim === "18:00"), "precondição: horário histórico fora dos candidatos do turno");
      const adm = carregar<typeof import("../services/administrativo.service.ts")>("lib/contratos/services/administrativo.service.ts");
      const rs = carregar<typeof import("../../fechamentos/services/revisao-operacional.service.ts")>("lib/fechamentos/services/revisao-operacional.service.ts");
      const operar = adm.operarContrato as unknown as Parameters<typeof congelarEAssinarKidmais>[1];
      const ctxOp = () => ({ requestId: randomUUID(), ip: null, userAgent: "r6" });
      const abrirRevisao = async (motivo: string) => {
        const vigente = (await a.query<{ v: string }>(`SELECT versao_vigente_id::text v FROM contrato_fluxos WHERE contrato_id = $1`, [r.contratoId])).rows[0].v;
        await operar(vigente, { acao: "nova_versao", tipo: "NOVA_VERSAO", motivo, chaveCriacao: randomUUID() }, c.token, ctxOp(), c.empresa);
        const v2 = (await a.query<{ id: string }>(`SELECT versao_em_preparacao_id::text id FROM contrato_fluxos WHERE contrato_id = $1`, [r.contratoId])).rows[0].id;
        const editar = async (mudanca: Record<string, unknown>) => {
          const fonte = (await rs.fontesPreparacao(v2, tx))!;
          const revisao = (await a.query<{ revisao: number }>(`SELECT revisao FROM contrato_edicoes WHERE contrato_versao_id = $1`, [v2])).rows[0].revisao;
          return operar(v2, { acao: "editar_festa", revisao, motivo, fonteHash: fonte.fonteHash, pacoteId: c.pacote, convidados: 50,
            dataEvento: data, configuracaoAgendaId: f.turno, horarioInicio: "14:00", horarioFim: "18:00", adicionais: fonte.adicionais,
            idadeAniversarianteEvento: 6, temaFesta: "Circo", buffetStatus: "PENDENTE", buffetSalgados: "", buffetBebidas: "", buffetDoces: "", buffetBolo: "", buffetOutros: "",
            observacoesEquipe: "Revisão do contrato histórico", ...mudanca }, c.token, ctxOp(), c.empresa);
        };
        const concluir = async () => {
          await congelarEAssinarKidmais(a, operar, v2, c.empresa, c.token, nativo.tokenRepresentante);
          await assinarComoCliente(r.contratoId, cpf);
          await validarAgora(a);
          assert.equal((await a.query(`SELECT versao_vigente_id::text v FROM contrato_fluxos WHERE contrato_id = $1`, [r.contratoId])).rows[0].v, v2, "versão revisada vigente");
        };
        return { v2, editar, concluir };
      };
      const destino = async () => (await a.query(`SELECT data_evento::text data, to_char(horario_inicio, 'HH24:MI') inicio, to_char(horario_fim, 'HH24:MI') fim, configuracao_agenda_id::text turno, tema_festa tema, convidados
          FROM fechamentos WHERE id = $1`, [f.id])).rows[0];
      return { c, nativo, r, f, abrirRevisao, destino };
    };
    const indisponivel = /Destino da revisão indisponível|Conflito de agenda da revisão/;
    const COMERCIAL = { confirmarAprovacao: true, forma: "PIX_PARCELADO", baseNegociada: 6000, condicaoPix: { quantidadeParcelas: 2 } };

    await t.test("[R6] horário histórico fora dos turnos: revisão sem mudança de destino e correção sem mudança de horário, pelas assinaturas nativas; duração nova recusada", async () => {
      await a.query("BEGIN");
      const restaurarPool = poolNaTransacao(a);
      const restaurarAmbiente = ambienteAssinatura();
      try {
        const h = await historicoForaDoTurno(dia(40));
        const original = await h.destino();
        // 1. Revisão sem mudança de destino (antes: "Destino da revisão indisponível" já ao abrir).
        const rev = await h.abrirRevisao("Mais convidados, mesmo horário");
        // Duração muda (mesmo início, fim novo): é mudança de destino; a exceção não vale e o horário não é candidato.
        await assert.rejects(rev.editar({ horarioFim: "19:00", comercial: COMERCIAL }), indisponivel);
        await rev.editar({ convidados: 60, comercial: COMERCIAL });
        await rev.concluir();
        const depois = await h.destino();
        assert.deepEqual([depois.data, depois.inicio, depois.fim, depois.turno, depois.convidados], [original.data, "14:00", "18:00", original.turno, 60], "nada recalculado nem deslocado");
        const hold = (await a.query(`SELECT a.dados_depois FROM auditoria a JOIN fechamento_revisoes fr ON fr.id = a.entidade_id
            WHERE fr.contrato_versao_id = $1 AND a.acao = 'RESERVA_REVISAO_ADQUIRIDA'`, [rev.v2])).rows[0];
        assert.equal(hold?.dados_depois?.resultado?.horarioHistoricoPreservado, true, "auditado como horário histórico preservado");
        // 2. Correção sem mudança de horário (tema e observações), sem revisão comercial.
        const correcao = await h.abrirRevisao("Correção do tema");
        await correcao.editar({ convidados: 60, temaFesta: "Fundo do mar", observacoesEquipe: "Correção sem mudar horário" });
        await correcao.concluir();
        const corrigido = await h.destino();
        assert.deepEqual([corrigido.data, corrigido.inicio, corrigido.fim, corrigido.turno, corrigido.tema], [original.data, "14:00", "18:00", original.turno, "Fundo do mar"]);
        assert.equal((await a.query(`SELECT kidmais019_ocupa($1::uuid) o`, [h.f.id])).rows[0].o, true, "continua ocupando o horário original");
      } finally {
        restaurarAmbiente();
        restaurarPool();
        await a.query("ROLLBACK");
      }
    });

    await t.test("[R6] horário histórico fora dos turnos: remarcação válida para horário oficial; remarcação com conflito e destino novo fora dos candidatos recusados", async () => {
      await a.query("BEGIN");
      const restaurarPool = poolNaTransacao(a);
      const restaurarAmbiente = ambienteAssinatura();
      try {
        const h = await historicoForaDoTurno(dia(42));
        const original = await h.destino();
        // Outra contratação da mesma empresa (mesmo recurso) no horário oficial 10:00–22:00 de outro dia.
        const evOcupado = { data: dia(50), inicio: "10:00", fim: "22:00" };
        await integrar(s, coreNativo, a, h.c, (await importacao(a, h.c, evOcupado)).id, decisoes(h.c, evOcupado, { situacao: "NAO_CONFERIDO" }));
        await validarAgora(a);
        const rev = await h.abrirRevisao("Remarcação pedida pelo cliente");
        // Conflito: horário oficial ocupado.
        await assert.rejects(rev.editar({ dataEvento: dia(50), configuracaoAgendaId: h.nativo.turno, horarioInicio: "10:00", horarioFim: "22:00", comercial: COMERCIAL }), indisponivel);
        // Destino novo com o horário histórico (outra data): a exceção não vale para destino novo.
        await assert.rejects(rev.editar({ dataEvento: dia(52), comercial: COMERCIAL }), indisponivel);
        assert.deepEqual(await h.destino(), original, "recusas não alteram a reserva");
        // Remarcação válida: horário oficial livre.
        await rev.editar({ dataEvento: dia(55), configuracaoAgendaId: h.nativo.turno, horarioInicio: "10:00", horarioFim: "22:00", comercial: COMERCIAL });
        await rev.concluir();
        const depois = await h.destino();
        assert.deepEqual([depois.data, depois.inicio, depois.fim, depois.turno], [dia(55), "10:00", "22:00", h.nativo.turno]);
        assert.equal((await a.query(`SELECT count(*)::int n FROM kidmais_ocupacoes_operacionais($1::date, $1::date) WHERE fechamento_id = $2::uuid`, [dia(42), h.f.id])).rows[0].n, 0, "horário original liberado");
        assert.equal((await a.query(`SELECT kidmais019_ocupa($1::uuid) o`, [h.f.id])).rows[0].o, true);
      } finally {
        restaurarAmbiente();
        restaurarPool();
        await a.query("ROLLBACK");
      }
    });

    await t.test("[R6] horário histórico preservado: a conferência do intervalo lê a própria transação; o banco protege a reserva no commit", async () => {
      await a.query("BEGIN");
      const restaurarPool = poolNaTransacao(a);
      const restaurarAmbiente = ambienteAssinatura();
      try {
        const h = await historicoForaDoTurno(dia(44));
        // Estado legado (anterior às regras da 062): bloqueio da empresa no meio do horário histórico, gravado NESTA
        // transação, ainda não commitado. O gatilho de proteção é desligado só para plantar esse estado e religado em seguida.
        await a.query("ALTER TABLE bloqueios_agenda DISABLE TRIGGER fr_bloqueio_proteger_trg");
        const legado = await id(a, `INSERT INTO bloqueios_agenda (data, horario_inicio, horario_fim, dia_inteiro, motivo, empresa_id) VALUES ($1::date, '15:00', '16:00', false, 'Bloqueio legado', $2::uuid) RETURNING id`, [dia(44), h.c.empresa]);
        await a.query("ALTER TABLE bloqueios_agenda ENABLE TRIGGER fr_bloqueio_proteger_trg");
        // A revalidação do horário histórico enxerga o bloqueio não commitado (mesma transação) e recusa.
        await assert.rejects(h.abrirRevisao("Correção com bloqueio no horário"), indisponivel);
        assert.equal((await a.query(`SELECT versao_em_preparacao_id FROM contrato_fluxos WHERE contrato_id = $1`, [h.r.contratoId])).rows[0].versao_em_preparacao_id, null, "nada aberto");
        // Sem o bloqueio, a revisão no próprio horário é aceita.
        await a.query(`UPDATE bloqueios_agenda SET ativo = false WHERE id = $1`, [legado]);
        const rev = await h.abrirRevisao("Correção sem bloqueio");
        await rev.editar({ temaFesta: "Fundo do mar", comercial: COMERCIAL });
        // Validação definitiva no banco, independente do serviço: novo bloqueio sobre a reserva (em revisão) é recusado.
        await a.query("SAVEPOINT bloqueio_novo");
        await assert.rejects(a.query(`INSERT INTO bloqueios_agenda (data, horario_inicio, horario_fim, dia_inteiro, motivo, empresa_id) VALUES ($1::date, '16:00', '17:00', false, 'Bloqueio novo', $2::uuid)`, [dia(44), h.c.empresa]),
          /Bloqueio conflita com/);
        await a.query("ROLLBACK TO SAVEPOINT bloqueio_novo");
        await validarAgora(a);
      } finally {
        restaurarAmbiente();
        restaurarPool();
        await a.query("ROLLBACK");
      }
    });

    await t.test("[R6] busca complementar de duplicados: data lida no documento e data próxima aparecem; festa do ano seguinte e outra empresa não; decisão explícita e auditada", async () => {
      await a.query("BEGIN");
      const c = await cenario(a);
      const tx = executor(a);
      const ev1 = { data: dia(120), inicio: "14:00", fim: "18:00" };
      const r1 = await integrar(s, coreNativo, a, c, (await importacao(a, c, ev1)).id, decisoes(c, ev1, { situacao: "NAO_CONFERIDO" }));
      if (r1.reutilizado) throw new Error("inesperado");
      await validarAgora(a);
      const candidatos = async (imp: string, d: ReturnType<typeof decisoes>) => {
        const sim = await s.simularIntegracao(tx, c.tenant as never, imp, d, dia(0));
        if (sim.integrada) throw new Error("inesperado");
        return sim;
      };
      // (a) Mesmo papel escaneado de novo; o operador corrigiu a data para outra, longe (fora da janela): a data lida
      //     no documento é a do contrato já integrado.
      const imp2 = await importacao(a, c, ev1);
      const ev2 = { data: dia(250), inicio: "14:00", fim: "18:00" };
      const motivos = { data: "Data corrigida à mão no papel" };
      const sem2 = await candidatos(imp2.id, { ...decisoes(c, ev2, { situacao: "NAO_CONFERIDO" }, null, null), motivos });
      assert.equal(sem2.pronto, false, "não integra sem decisão");
      const v2 = sem2.possiveisVinculos.find((v: { contratoId: string | null }) => v.contratoId === r1.contratoId) as { alcance: string; data: string; sinais: string[] } | undefined;
      assert.ok(v2 && v2.alcance === "OUTRA_DATA" && v2.data === dia(120) && v2.sinais.includes("DATA_DO_DOCUMENTO"), JSON.stringify(sem2.possiveisVinculos));
      const d2 = { ...decisoes(c, ev2, { situacao: "NAO_CONFERIDO" }, null, { motivo: "Outro contrato: segunda festa do mesmo cliente" }), motivos };
      const r2 = await integrar(s, coreNativo, a, c, imp2.id, d2);
      if (r2.reutilizado) throw new Error("inesperado");
      await validarAgora(a);
      const auditoria = (await a.query(`SELECT justificativa, dados_depois FROM auditoria WHERE acao = 'POSSIVEL_DUPLICIDADE_DESCARTADA' AND entidade_id = $1`, [r2.contratoId])).rows[0];
      assert.equal(auditoria.justificativa, "Outro contrato: segunda festa do mesmo cliente");
      const auditado = (auditoria.dados_depois.candidatos as Array<{ contratoId: string; alcance: string; data: string }>).find((x) => x.contratoId === r1.contratoId);
      assert.deepEqual([auditado?.alcance, auditado?.data], ["OUTRA_DATA", dia(120)]);
      // Nada foi unido: dois contratos, dois fechamentos.
      assert.notEqual(r1.contratoId, r2.contratoId);
      // (b) Data próxima (7 dias) com dois sinais (mesmo telefone em outro cadastro, aniversariante e valor).
      const ev3 = { data: dia(127), inicio: "14:00", fim: "18:00" };
      const sem3 = await candidatos((await importacao(a, c, ev3)).id, decisoes(c, ev3, { situacao: "NAO_CONFERIDO" }, null, null));
      assert.equal(sem3.pronto, false);
      assert.ok(sem3.possiveisVinculos.some((v: { contratoId: string | null; sinais: string[] }) => v.contratoId === r1.contratoId && v.sinais.includes("DATA_PROXIMA")));
      // (c) Festa do ano seguinte (fora da janela, outra data lida): não aparece nem bloqueia.
      const ev4 = { data: dia(120 + 364), inicio: "14:00", fim: "18:00" };
      const sem4 = await candidatos((await importacao(a, c, ev4)).id, decisoes(c, ev4, { situacao: "NAO_CONFERIDO" }, null, null));
      assert.ok(!sem4.possiveisVinculos.some((v: { contratoId: string | null }) => v.contratoId === r1.contratoId || v.contratoId === r2.contratoId), JSON.stringify(sem4.possiveisVinculos));
      // (d) Outra empresa nunca vê candidatos desta.
      const outra = await cenario(a);
      const sim5 = await s.simularIntegracao(tx, outra.tenant as never, (await importacao(a, outra, ev1)).id, decisoes(outra, ev1, { situacao: "NAO_CONFERIDO" }, null, null), dia(0));
      if (sim5.integrada) throw new Error("inesperado");
      assert.deepEqual(sim5.possiveisVinculos, []);
      await a.query("ROLLBACK");
    });

    await t.test("isolamento: outra empresa não vê nem integra a importação", async () => {
      await a.query("BEGIN");
      const c = await cenario(a);
      const outra = await cenario(a);
      const ev = { data: dia(90), inicio: "14:00", fim: "18:00" };
      const imp = await importacao(a, c, ev);
      await assert.rejects(s.simularIntegracao(executor(a), outra.tenant as never, imp.id, decisoes(outra, ev, { situacao: "NAO_CONFERIDO" }), dia(0)), /não encontrado/);
      await a.query("ROLLBACK");
    });

    await t.test("falha no meio: recebimento recusado desfaz fechamento, contrato, festa e vínculo", async () => {
      await a.query("BEGIN");
      const c = await cenario(a);
      const ev = { data: dia(100), inicio: "14:00", fim: "18:00" };
      const imp = await importacao(a, c, ev);
      await a.query("SAVEPOINT s3");
      const quebrado = { ...coreNativo, registrarRecebimento: async () => { throw new Error("falha simulada no recebimento"); } };
      await assert.rejects(integrar(s, quebrado, a, c, imp.id, decisoes(c, ev, PARCIAL())), /falha simulada/);
      await a.query("ROLLBACK TO SAVEPOINT s3");
      assert.equal((await a.query(`SELECT count(*)::int n FROM contrato_importacoes WHERE importacao_id = $1`, [imp.id])).rows[0].n, 0);
      assert.equal((await a.query(`SELECT count(*)::int n FROM fechamentos WHERE empresa_id = $1 AND origem_fechamento = 'IMPORTACAO_HISTORICA'`, [c.empresa])).rows[0].n, 0);
      await a.query("ROLLBACK");
    });

    await t.test("concorrência: duas confirmações para o mesmo horário — a segunda espera o lock e encontra o conflito", async () => {
      await a.query("BEGIN");
      const c = await cenario(a);
      const ev = { data: dia(120), inicio: "14:00", fim: "18:00" };
      const imp1 = await importacao(a, c, ev);
      const imp2 = await importacao(a, c, ev);
      await a.query("COMMIT");
      await a.query("BEGIN");
      await integrar(s, coreNativo, a, c, imp1.id, decisoes(c, ev, { situacao: "NAO_CONFERIDO" }));
      await b.query("BEGIN");
      await b.query("SET LOCAL lock_timeout = '2s'");
      await assert.rejects(integrar(s, coreNativo, b, c, imp2.id, decisoes(c, ev, { situacao: "NAO_CONFERIDO" })), /lock timeout|canceling statement/i);
      await b.query("ROLLBACK");
      await a.query("COMMIT");
      await b.query("BEGIN");
      await assert.rejects(integrar(s, coreNativo, b, c, imp2.id, decisoes(c, ev, { situacao: "NAO_CONFERIDO" })), /ocupado|indisponível/i);
      await b.query("ROLLBACK");
      // Com a 062 aplicada, o rollback da 061 recusa antes de tudo (a recusa por integração gravada vale depois do rollback da 062).
      await assert.rejects(a.query(ler("database/rollback/20261002_061_contratos_importados_integracao_down.sql")), /Rollback 061 recusado: a 062 está aplicada/);
      await a.query("ROLLBACK");
    });
  } finally {
    await encerrarDescartavel(b, false);
    await encerrarDescartavel(a);
  }
});
