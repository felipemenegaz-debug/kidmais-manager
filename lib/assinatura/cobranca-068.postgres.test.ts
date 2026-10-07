import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Client } from 'pg';
import { conectarDescartavel, encerrarDescartavel } from '../comercial/postgres-descartavel.ts';
import { carregarModulo } from '../acessos/teste-carregador.ts';
import { concederExcecao, estenderTeste, iniciarTeste, revogarExcecao } from './servico.ts';

/**
 * 068 no PostgreSQL DESCARTÁVEL (modelo "atual" + 067 + 068 aplicadas aqui): pre/postcheck e rollback, guarda de
 * transições da assinatura, teste único por CNPJ, extensão e exceções pelo serviço, e o espelho de eventos do provedor
 * (entrega repetida sem segundo efeito, identidade imutável, nunca apagado).
 */
const sql = (f: string) => readFileSync(f, 'utf8');
const M067 = 'database/migrations/20261006_067_modelo_comercial_empresa.sql';
const M068 = 'database/migrations/20261007_068_cobranca_assinatura.sql';
const R068 = 'database/rollback/20261007_068_cobranca_assinatura_down.sql';
const PRE = 'database/checks/20261007_068_precheck.sql';
const POS = 'database/checks/20261007_068_postcheck.sql';

let client: Client;
let estado: { lerEstadoComercial: (tx: unknown, empresaId: string) => Promise<{ assinatura: { situacao: string; testeFim: string; versao: number } | null; acesso: { nivel: string; motivo: string; ate: string | null } }> };
const ids: Record<string, string> = {};
const codigo = () => `c068${randomBytes(3).toString('hex')}`;
const q = (texto: string, params: unknown[] = []) => client.query(texto, params);

/** Cada ação roda na própria transação (como numa rota real); a falha desfaz tudo. */
async function erroDe(acao: () => Promise<unknown>) {
    await q('BEGIN');
    try {
        await acao();
        await q('COMMIT');
        return 'OK';
    }
    catch (error) {
        await q('ROLLBACK');
        const e = error as { code?: string; message: string; httpStatus?: number };
        // Erro do serviço: a mensagem apresentável; erro do PostgreSQL: o SQLSTATE (P0001 = mensagem da guarda).
        return e.httpStatus || !e.code || e.code === 'P0001' ? e.message : e.code;
    }
}
async function emTx<T>(acao: () => Promise<T>): Promise<T> {
    await q('BEGIN');
    try {
        const r = await acao();
        await q('COMMIT');
        return r;
    }
    catch (error) {
        await q('ROLLBACK');
        throw error;
    }
}
async function novaEmpresa() {
    const id = (await q("INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Buffet 068', 'PROVISIONAMENTO') RETURNING id", [codigo()])).rows[0].id as string;
    await q("UPDATE empresas SET status = 'ATIVA' WHERE id = $1", [id]);
    return id;
}
const assinatura = async (empresaId: string) => (await q('SELECT situacao, versao, teste_fim, atualizado_em FROM empresa_assinaturas WHERE empresa_id = $1', [empresaId])).rows[0];

test.before(async () => {
    client = await conectarDescartavel();
    estado = carregarModulo('lib/assinatura/estado.ts', { 'db/postgres': { db: () => client, withTransaction: async (w: (c: Client) => unknown) => w(client) } }, new Map()) as unknown as typeof estado;
});
test.after(async () => {
    if (client)
        await encerrarDescartavel(client);
});

test('068: exige a 067; pre/postcheck; rollback sem dados devolve a 067 intacta; reaplicar recusa', async () => {
    await assert.rejects(q(sql(M068)), /068 exige a 067/);
    await q('ROLLBACK').catch(() => undefined);
    await q(sql(M067));
    await q(sql(PRE));
    await q(sql(M068));
    await q(sql(POS));
    await assert.rejects(q(sql(M068)), /068 já aplicada/);
    await q('ROLLBACK').catch(() => undefined);
    await q(sql(R068));
    const colunas = (await q("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'empresa_assinaturas' AND column_name IN ('documento_teste', 'provedor_situacao', 'sincronizado_em')")).rows[0].n;
    assert.equal(colunas, 0);
    assert.equal((await q("SELECT to_regclass('public.cobranca_eventos') AS t")).rows[0].t, null);
    await q(sql(PRE));
    await q(sql(M068));
    await q(sql(POS));
    ids.usuario = (await q("INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Plataforma 068', $2, 'ADMINISTRATIVO', true) RETURNING id",
        [`${codigo()}@example.test`, `scrypt$v=1$N=131072$r=8$p=1$${'A'.repeat(22)}==$${'B'.repeat(86)}==`])).rows[0].id;
});

test('teste grátis: nasce em TESTE com a duração configurada, pelo relógio do banco; um teste por CNPJ, sem limitar a pessoa', async () => {
    ids.a = await novaEmpresa();
    const r = await emTx(() => iniciarTeste(client as never, { empresaId: ids.a, documento: '11222333000181' }));
    assert.equal(r.dias, 15, 'padrão sem ASSINATURA_TESTE_DIAS');
    assert.equal(Date.parse(r.testeFim) - Date.parse(r.testeInicio), 15 * 86_400_000);
    // Início e fim saem do MESMO instante: a diferença é exata também nos microssegundos que o ISO acima trunca.
    assert.equal((await q("SELECT (teste_fim - teste_inicio) = interval '15 days' AS exato FROM empresa_assinaturas WHERE empresa_id = $1", [ids.a])).rows[0].exato, true);
    const lido = await estado.lerEstadoComercial(client, ids.a);
    assert.deepEqual([lido.assinatura?.situacao, lido.acesso.nivel, lido.acesso.motivo, lido.acesso.ate], ['TESTE', 'COMPLETO', 'TESTE', r.testeFim]);
    ids.b = await novaEmpresa();
    assert.equal(await erroDe(() => iniciarTeste(client as never, { empresaId: ids.b, documento: '11222333000181' })), 'Este CNPJ já utilizou o teste grátis.');
    assert.equal(await erroDe(() => iniciarTeste(client as never, { empresaId: ids.a, documento: '45723174000110' })), 'Esta empresa já tem situação comercial registrada.');
    // A transação do chamador continua utilizável depois da recusa (savepoint interno) e o outro CNPJ tem o próprio teste.
    const b = await emTx(async () => {
        await assert.rejects(iniciarTeste(client as never, { empresaId: ids.b, documento: '11222333000181' }), /já utilizou o teste/);
        return iniciarTeste(client as never, { empresaId: ids.b, documento: '45723174000110', dias: 30 });
    });
    assert.equal(b.dias, 30);
    assert.equal(await erroDe(() => iniciarTeste(client as never, { empresaId: ids.b, documento: '1122233300018' })), 'CNPJ inválido para o teste.');
});

test('guarda: só nasce em TESTE; identidade imutável; teste só avança; transições explícitas; versão pelo banco; nunca apagada', async () => {
    const c = await novaEmpresa();
    assert.match(await erroDe(() => q("INSERT INTO empresa_assinaturas (empresa_id, situacao, ciclo, teste_inicio, teste_fim, periodo_atual_fim) VALUES ($1, 'ATIVA', 'MENSAL', now(), now() + interval '1 day', now() + interval '30 days')", [c])), /nasce em TESTE/);
    const antes = await assinatura(ids.a);
    assert.match(await erroDe(() => q("UPDATE empresa_assinaturas SET teste_inicio = teste_inicio - interval '1 day' WHERE empresa_id = $1", [ids.a])), /imutável/);
    assert.match(await erroDe(() => q("UPDATE empresa_assinaturas SET documento_teste = '45723174000110' WHERE empresa_id = $1", [ids.a])), /imutável/);
    assert.match(await erroDe(() => q("UPDATE empresa_assinaturas SET teste_fim = teste_fim - interval '1 day' WHERE empresa_id = $1", [ids.a])), /só avança/);
    assert.match(await erroDe(() => q("UPDATE empresa_assinaturas SET situacao = 'EM_ATRASO', em_atraso_desde = now(), ciclo = 'MENSAL', periodo_atual_fim = now() WHERE empresa_id = $1", [ids.a])), /TESTE → EM_ATRASO/);
    assert.match(await erroDe(() => q('DELETE FROM empresa_assinaturas WHERE empresa_id = $1', [ids.a])), /não é apagada/);
    assert.match(await erroDe(() => q('TRUNCATE empresa_assinaturas')), /não aceita TRUNCATE/);
    // TESTE → ATIVA (pagamento confirmado): versão e atualizado_em pelo banco, mesmo se o chamador tentar forjar.
    await q("UPDATE empresa_assinaturas SET situacao = 'ATIVA', ciclo = 'MENSAL', periodo_atual_fim = now() + interval '30 days', provedor = 'ASAAS', provedor_cliente_id = 'cus_1', provedor_assinatura_id = 'sub_1', versao = 99 WHERE empresa_id = $1", [ids.a]);
    const depois = await assinatura(ids.a);
    assert.deepEqual([depois.situacao, depois.versao], ['ATIVA', antes.versao + 1]);
    assert.ok(depois.atualizado_em >= antes.atualizado_em);
    assert.match(await erroDe(() => q("UPDATE empresa_assinaturas SET teste_fim = teste_fim + interval '5 days' WHERE empresa_id = $1", [ids.a])), /enquanto a assinatura está em TESTE/);
    assert.match(await erroDe(() => q("UPDATE empresa_assinaturas SET provedor_cliente_id = 'cus_2' WHERE empresa_id = $1", [ids.a])), /Cliente no provedor é imutável/);
    assert.match(await erroDe(() => q("UPDATE empresa_assinaturas SET provedor_assinatura_id = 'sub_2' WHERE empresa_id = $1", [ids.a])), /só é trocada depois de cancelada/);
    // Atraso, regularização, cancelamento ao fim do período, encerramento e nova assinatura sem perder a linha.
    await q("UPDATE empresa_assinaturas SET situacao = 'EM_ATRASO', em_atraso_desde = now() WHERE empresa_id = $1", [ids.a]);
    await q("UPDATE empresa_assinaturas SET situacao = 'ATIVA', em_atraso_desde = NULL WHERE empresa_id = $1", [ids.a]);
    await q("UPDATE empresa_assinaturas SET situacao = 'CANCELADA_FIM_PERIODO', cancelada_em = now() WHERE empresa_id = $1", [ids.a]);
    await q("UPDATE empresa_assinaturas SET situacao = 'ENCERRADA', encerrada_em = now() WHERE empresa_id = $1", [ids.a]);
    assert.match(await erroDe(() => q("UPDATE empresa_assinaturas SET situacao = 'TESTE', encerrada_em = NULL WHERE empresa_id = $1", [ids.a])), /ENCERRADA → TESTE/);
    await q("UPDATE empresa_assinaturas SET situacao = 'ATIVA', encerrada_em = NULL, cancelada_em = NULL, provedor_assinatura_id = 'sub_2', periodo_atual_fim = now() + interval '30 days' WHERE empresa_id = $1", [ids.a]);
    assert.equal((await assinatura(ids.a)).versao, antes.versao + 6);
});

test('extensão de teste: exige motivo e prazo, conta de hoje quando já venceu, grava exceção auditável e libera o acesso', async () => {
    const e = await novaEmpresa();
    await q("INSERT INTO empresa_assinaturas (empresa_id, situacao, teste_inicio, teste_fim, documento_teste) VALUES ($1, 'TESTE', clock_timestamp() - interval '20 days', clock_timestamp() - interval '5 days', '04252011000110')", [e]);
    assert.equal((await estado.lerEstadoComercial(client, e)).acesso.nivel, 'SOMENTE_LEITURA', 'teste vencido');
    assert.equal(await erroDe(() => estenderTeste(client as never, { empresaId: e, dias: 10, motivo: 'oi', usuarioId: ids.usuario })), 'Informe o motivo (5 a 500 caracteres).');
    assert.equal(await erroDe(() => estenderTeste(client as never, { empresaId: e, dias: 61, motivo: 'Implantação atrasada', usuarioId: ids.usuario })), 'A extensão vai de 1 a 60 dias.');
    const r = await emTx(() => estenderTeste(client as never, { empresaId: e, dias: 10, motivo: 'Implantação atrasada pela plataforma', usuarioId: ids.usuario }));
    const agora = Date.parse((await q(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS a`)).rows[0].a);
    assert.ok(Math.abs(Date.parse(r.testeFimDepois) - (agora + 10 * 86_400_000)) < 60_000, 'conta a partir de agora');
    const lido = await estado.lerEstadoComercial(client, e);
    assert.deepEqual([lido.acesso.nivel, lido.acesso.motivo], ['COMPLETO', 'TESTE']);
    const excecao = (await q('SELECT tipo, motivo, criado_por FROM empresa_excecoes_comerciais WHERE id = $1', [r.excecaoId])).rows[0];
    assert.deepEqual([excecao.tipo, excecao.criado_por], ['EXTENSAO_TESTE', ids.usuario]);
    assert.equal(await erroDe(() => revogarExcecao(client as never, { empresaId: e, excecaoId: r.excecaoId, motivo: 'Tentativa de revogar', usuarioId: ids.usuario })),
        'Extensão de teste não é revogada: o novo prazo já foi gravado no teste.');
    assert.equal(await erroDe(() => estenderTeste(client as never, { empresaId: ids.a, dias: 5, motivo: 'Empresa já paga', usuarioId: ids.usuario })), 'Só é possível estender enquanto a empresa está em teste.');
    const semCobranca = await novaEmpresa();
    assert.equal(await erroDe(() => estenderTeste(client as never, { empresaId: semCobranca, dias: 5, motivo: 'Sem assinatura', usuarioId: ids.usuario })), 'Empresa sem cobrança: não há teste a estender.');
});

test('cortesia: completo até o prazo; revogação com motivo devolve o nível da assinatura; outra empresa não alcança', async () => {
    const e = await novaEmpresa();
    await q("INSERT INTO empresa_assinaturas (empresa_id, situacao, teste_inicio, teste_fim, documento_teste) VALUES ($1, 'TESTE', clock_timestamp() - interval '100 days', clock_timestamp() - interval '85 days', '60701190000104')", [e]);
    assert.equal((await estado.lerEstadoComercial(client, e)).acesso.nivel, 'BLOQUEADO');
    const c = await emTx(() => concederExcecao(client as never, { empresaId: e, tipo: 'CORTESIA', dias: 30, motivo: 'Parceiro de lançamento', usuarioId: ids.usuario }));
    assert.deepEqual((await estado.lerEstadoComercial(client, e)).acesso, { nivel: 'COMPLETO', motivo: 'EXCECAO_COMERCIAL', ate: c.validaAte });
    assert.equal(await erroDe(() => revogarExcecao(client as never, { empresaId: ids.b, excecaoId: c.excecaoId, motivo: 'Empresa errada', usuarioId: ids.usuario })), 'Exceção não encontrada nesta empresa.');
    await emTx(() => revogarExcecao(client as never, { empresaId: e, excecaoId: c.excecaoId, motivo: 'Parceria encerrada', usuarioId: ids.usuario }));
    assert.equal((await estado.lerEstadoComercial(client, e)).acesso.nivel, 'BLOQUEADO');
    assert.equal(await erroDe(() => revogarExcecao(client as never, { empresaId: e, excecaoId: c.excecaoId, motivo: 'De novo', usuarioId: ids.usuario })), 'A exceção já foi revogada.');
    const semCobranca = await novaEmpresa();
    assert.equal(await erroDe(() => concederExcecao(client as never, { empresaId: semCobranca, tipo: 'CORTESIA', dias: 5, motivo: 'Sem assinatura', usuarioId: ids.usuario })), 'Empresa sem cobrança: o acesso já é completo.');
});

test('eventos do provedor: entrega repetida não duplica; identidade imutável; conclusão exige data; concluído não muda; nunca apagado', async () => {
    const inserir = () => q(`INSERT INTO cobranca_eventos (provedor, evento_id, tipo, assinatura_provedor_id, cobranca_provedor_id)
        VALUES ('ASAAS', 'evt_068_1', 'PAYMENT_CONFIRMED', 'sub_2', 'pay_1') ON CONFLICT (provedor, evento_id) DO NOTHING RETURNING id`);
    const primeiro = await inserir();
    const segundo = await inserir();
    assert.deepEqual([primeiro.rowCount, segundo.rowCount], [1, 0]);
    const id = primeiro.rows[0].id;
    assert.equal(await erroDe(() => q("INSERT INTO cobranca_eventos (provedor, evento_id, tipo) VALUES ('ASAAS', 'evt_068_1', 'PAYMENT_CONFIRMED')")), '23505');
    assert.equal(await erroDe(() => q("INSERT INTO cobranca_eventos (provedor, evento_id, tipo) VALUES ('ASAAS', 'evt_x', 'payment confirmed')")), '23514');
    assert.equal(await erroDe(() => q("INSERT INTO cobranca_eventos (provedor, evento_id, tipo) VALUES ('STRIPE', 'evt_y', 'X')")), '23514');
    assert.match(await erroDe(() => q("UPDATE cobranca_eventos SET cobranca_provedor_id = 'pay_2' WHERE id = $1", [id])), /identidade imutável/);
    assert.equal(await erroDe(() => q("UPDATE cobranca_eventos SET situacao = 'PROCESSADO' WHERE id = $1", [id])), '23514');
    await q("UPDATE cobranca_eventos SET situacao = 'FALHOU', tentativas = tentativas + 1, ultimo_erro = 'provedor indisponível' WHERE id = $1", [id]);
    await q("UPDATE cobranca_eventos SET situacao = 'PROCESSADO', processado_em = clock_timestamp(), empresa_id = $2 WHERE id = $1", [id, ids.a]);
    assert.match(await erroDe(() => q("UPDATE cobranca_eventos SET tentativas = 9 WHERE id = $1", [id])), /já concluído/);
    assert.match(await erroDe(() => q('DELETE FROM cobranca_eventos WHERE id = $1', [id])), /não é apagado/);
    assert.match(await erroDe(() => q('TRUNCATE cobranca_eventos')), /não aceita TRUNCATE/);
});

test('rollback da 068 recusa com assinaturas ou eventos registrados, sem apagar nada', async () => {
    await assert.rejects(q(sql(R068)), /rollback recusado/);
    await q('ROLLBACK').catch(() => undefined);
    assert.ok((await q('SELECT count(*)::int AS n FROM cobranca_eventos')).rows[0].n >= 1);
});
