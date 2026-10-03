import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { conectarDescartavel, encerrarDescartavel } from "../../comercial/postgres-descartavel.ts";
import { estruturaFesta019Sql } from "../../festas/estrutura-019.ts";
import {
  carregar, cenario, decisoes, dia, executor, id, importacao, instalar055, instalar061, instalar062, integrar, ler, PARCIAL, validarAgora, type Servico,
} from "../../../scripts/integracao-importados-test-support.ts";

/**
 * Integração de contrato importado no PostgreSQL REAL (061 + 062 + gatilhos 019/057/015). ESCRITO, NÃO EXECUTADO.
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
      const vinculo = (await a.query(`SELECT chave_idempotencia::text chave FROM contrato_importacoes WHERE importacao_id = $1`, [imp.id])).rows[0];
      const repetida = await s.confirmarIntegracao(executor(a), c.tenant as never, { usuarioId: c.usuario, token: c.token, requestId: randomUUID(), ip: null, userAgent: "h061" }, imp.id,
        { decisoes: decisoes(c, ev, PARCIAL()), resumoHash: "0".repeat(64), chave: vinculo.chave }, dia(0), coreNativo as never);
      assert.equal(repetida.reutilizado, true);
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
      const ctx = { usuarioId: c.usuario, token: c.token, requestId: randomUUID(), ip: null, userAgent: "h061" };
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
      const repetida = await s.confirmarIntegracao(executor(a), c.tenant as never, { usuarioId: c.usuario, token: c.token, requestId: randomUUID(), ip: null, userAgent: "h061" }, imp.id,
        { decisoes: decisoes(c, ev, total), resumoHash: "0".repeat(64), chave }, dia(0), coreNativo as never);
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
      const segunda = await s.confirmarIntegracao(tx, c.tenant as never, { usuarioId: c.usuario, token: c.token, requestId: randomUUID(), ip: null, userAgent: "h061" }, imp.id,
        { decisoes: decisoes(c, ev, PARCIAL()), resumoHash: "0".repeat(64), chave }, dia(0), coreNativo as never);
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
      // Com integração gravada, o rollback da 061 recusa.
      await assert.rejects(a.query(ler("database/rollback/20261002_061_contratos_importados_integracao_down.sql")), /Rollback 061 recusado/);
      await a.query("ROLLBACK");
    });
  } finally {
    await encerrarDescartavel(b, false);
    await encerrarDescartavel(a);
  }
});
