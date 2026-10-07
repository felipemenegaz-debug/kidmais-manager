import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Client } from 'pg';
import { conectarDescartavel, encerrarDescartavel } from '../comercial/postgres-descartavel.ts';
import { carregarModulo } from '../acessos/teste-carregador.ts';

/**
 * 067 — modelo comercial no PostgreSQL DESCARTÁVEL (modelo "atual" + 067 aplicada aqui): pre/postcheck, CHECKs,
 * guardas de exceção e representação, leitura do estado comercial (sem linha = sem cobrança) e rollback.
 */
const sql = (f: string) => readFileSync(f, 'utf8');
const MIGRATION = 'database/migrations/20261006_067_modelo_comercial_empresa.sql';
const ROLLBACK = 'database/rollback/20261006_067_modelo_comercial_empresa_down.sql';
const PRE = 'database/checks/20261006_067_precheck.sql';
const POS = 'database/checks/20261006_067_postcheck.sql';

let client: Client;
let estado: { lerEstadoComercial: (tx: unknown, empresaId: string, instante?: string) => Promise<{ instalado: boolean; agora: string; excecoes: Array<{ id: string }>; acesso: { nivel: string; motivo: string } }> };
const ids: Record<string, string> = {};
const codigo = () => `c067${randomBytes(3).toString('hex')}`;

async function erroDe(acao: () => Promise<unknown>) {
    await client.query('SAVEPOINT s');
    try {
        await acao();
        await client.query('RELEASE SAVEPOINT s');
        return 'OK';
    } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT s');
        const { code } = error as { code?: string };
        return code && code !== 'P0001' ? code : (error as Error).message;
    }
}
const q = (texto: string, params: unknown[] = []) => client.query(texto, params);

test.before(async () => {
    client = await conectarDescartavel();
    estado = carregarModulo('lib/assinatura/estado.ts', { 'db/postgres': { db: () => client, withTransaction: async (w: (c: Client) => unknown) => w(client) } }, new Map()) as unknown as typeof estado;
});
test.after(async () => {
    if (client)
        await encerrarDescartavel(client);
});

test('067: sem a migration o acesso é completo (sem cobrança); precheck, migration e postcheck; reaplicar recusa', async () => {
    ids.empresa = (await q("INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Buffet 067', 'PROVISIONAMENTO') RETURNING id", [codigo()])).rows[0].id;
    await q("UPDATE empresas SET status = 'ATIVA' WHERE id = $1", [ids.empresa]);
    ids.usuario = (await q("INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Plataforma 067', $2, 'ADMINISTRATIVO', true) RETURNING id",
        [`${codigo()}@example.test`, `scrypt$v=1$N=131072$r=8$p=1$${'A'.repeat(22)}==$${'B'.repeat(86)}==`])).rows[0].id;
    const sem = await estado.lerEstadoComercial(client, ids.empresa);
    assert.deepEqual([sem.instalado, sem.acesso.nivel, sem.acesso.motivo], [false, 'COMPLETO', 'SEM_COBRANCA']);
    await q(sql(PRE));
    await q(sql(MIGRATION));
    await q(sql(POS));
    await assert.rejects(q(sql(MIGRATION)), /067 já aplicada/);
    await q('ROLLBACK').catch(() => undefined);
    const instalada = await estado.lerEstadoComercial(client, ids.empresa);
    assert.deepEqual([instalada.instalado, instalada.acesso.nivel, instalada.acesso.motivo], [true, 'COMPLETO', 'SEM_COBRANCA'], 'empresa atual sem linha continua sem cobrança');
});

test('assinatura: CHECKs de coerência (teste, pagante, atraso, provedor) e unicidade do id no provedor', async () => {
    await q('BEGIN');
    const ins = (cols: string, vals: string) => q(`INSERT INTO empresa_assinaturas (empresa_id, ${cols}) VALUES ($1, ${vals})`, [ids.empresa]);
    assert.equal(await erroDe(() => ins('situacao, teste_inicio, teste_fim', "'TESTE', now(), now() - interval '1 day'")), '23514', 'teste_fim antes do início');
    assert.equal(await erroDe(() => ins('situacao, teste_inicio, teste_fim', "'ATIVA', now(), now() + interval '30 days'")), '23514', 'ativa sem ciclo/período');
    assert.equal(await erroDe(() => ins('situacao, teste_inicio, teste_fim, ciclo, periodo_atual_fim', "'EM_ATRASO', now(), now() + interval '30 days', 'MENSAL', now()")), '23514', 'atraso sem data');
    assert.equal(await erroDe(() => ins('situacao, teste_inicio, teste_fim, provedor_assinatura_id', "'TESTE', now(), now() + interval '30 days', 'sub_1'")), '23514', 'id de provedor sem provedor');
    assert.equal(await erroDe(() => ins('situacao, teste_inicio, teste_fim, plano', "'TESTE', now(), now() + interval '30 days', 'PREMIUM'")), '23514');
    assert.equal(await erroDe(() => ins('situacao, teste_inicio, teste_fim, provedor, provedor_assinatura_id', "'TESTE', now(), now() + interval '30 days', 'ASAAS', 'sub_1'")), 'OK');
    const outra = (await q("INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Outra 067', 'PROVISIONAMENTO') RETURNING id", [codigo()])).rows[0].id;
    assert.equal(await erroDe(() => q("INSERT INTO empresa_assinaturas (empresa_id, situacao, teste_inicio, teste_fim, provedor, provedor_assinatura_id) VALUES ($1, 'TESTE', now(), now() + interval '30 days', 'ASAAS', 'sub_1')", [outra])), '23505');
    await q('ROLLBACK');
});

test('estado comercial lido do banco: teste vigente completo; vencido há 10 dias somente leitura; cortesia vigente libera', async () => {
    await q('BEGIN');
    await q("INSERT INTO empresa_assinaturas (empresa_id, situacao, teste_inicio, teste_fim) VALUES ($1, 'TESTE', clock_timestamp() - interval '5 days', clock_timestamp() + interval '25 days')", [ids.empresa]);
    assert.equal((await estado.lerEstadoComercial(client, ids.empresa)).acesso.motivo, 'TESTE');
    await q("UPDATE empresa_assinaturas SET teste_inicio = clock_timestamp() - interval '40 days', teste_fim = clock_timestamp() - interval '10 days' WHERE empresa_id = $1", [ids.empresa]);
    const vencido = await estado.lerEstadoComercial(client, ids.empresa);
    assert.deepEqual([vencido.acesso.nivel, vencido.acesso.motivo], ['SOMENTE_LEITURA', 'TESTE_ENCERRADO']);
    await q("INSERT INTO empresa_excecoes_comerciais (empresa_id, tipo, valida_ate, motivo, criado_por) VALUES ($1, 'CORTESIA', clock_timestamp() + interval '15 days', 'Parceiro de lançamento', $2)", [ids.empresa, ids.usuario]);
    const cortesia = await estado.lerEstadoComercial(client, ids.empresa);
    assert.deepEqual([cortesia.acesso.nivel, cortesia.acesso.motivo], ['COMPLETO', 'EXCECAO_COMERCIAL']);
    await q('ROLLBACK');
});

test('fronteira de expiração da exceção: UM instante decide a lista e o acesso — vigente até 1 ms antes do prazo, vencida exatamente no prazo', async () => {
    await q('BEGIN');
    await q("INSERT INTO empresa_assinaturas (empresa_id, situacao, teste_inicio, teste_fim) VALUES ($1, 'TESTE', clock_timestamp() - interval '40 days', clock_timestamp() - interval '10 days')", [ids.empresa]);
    // Prazo com precisão de milissegundos (a mesma dos horários devolvidos pelo estado).
    const prazo = (await q(`SELECT to_char(date_trunc('milliseconds', clock_timestamp() + interval '2 days') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS t`)).rows[0].t as string;
    await q("INSERT INTO empresa_excecoes_comerciais (empresa_id, tipo, valida_ate, motivo, criado_por) VALUES ($1, 'CORTESIA', $2::timestamptz, 'Cortesia de fronteira', $3)", [ids.empresa, prazo, ids.usuario]);
    const em = (deltaMs: number) => new Date(Date.parse(prazo) + deltaMs).toISOString();
    const antes = await estado.lerEstadoComercial(client, ids.empresa, em(-1));
    assert.equal(antes.agora, em(-1), 'o instante informado é o instante usado');
    assert.deepEqual([antes.excecoes.length, antes.acesso.nivel, antes.acesso.motivo], [1, 'COMPLETO', 'EXCECAO_COMERCIAL'], '1 ms antes: listada e vigente');
    for (const delta of [0, 1, 60_000]) {
        const depois = await estado.lerEstadoComercial(client, ids.empresa, em(delta));
        // Antes da correção, o filtro do SQL usava outra leitura do relógio: no prazo, a exceção podia vir listada sem valer.
        assert.deepEqual([depois.excecoes.length, depois.acesso.nivel, depois.acesso.motivo], [0, 'SOMENTE_LEITURA', 'TESTE_ENCERRADO'], `prazo + ${delta} ms: nem listada nem vigente`);
    }
    // Sem instante: relógio do banco (hoje, 2 dias antes do prazo) — vigente.
    assert.equal((await estado.lerEstadoComercial(client, ids.empresa)).acesso.motivo, 'EXCECAO_COMERCIAL');
    await q('ROLLBACK');
});

test('exceção comercial: motivo e prazo obrigatórios; imutável; só a revogação (uma vez, com motivo); nunca apagada', async () => {
    await q('BEGIN');
    const ins = (motivo: string, prazo: string) => q(`INSERT INTO empresa_excecoes_comerciais (empresa_id, tipo, valida_ate, motivo, criado_por) VALUES ($1, 'EXTENSAO_TESTE', clock_timestamp() + interval '${prazo}', $2, $3) RETURNING id`, [ids.empresa, motivo, ids.usuario]);
    assert.equal(await erroDe(() => ins('ok', '10 days')), '23514', 'motivo curto');
    assert.equal(await erroDe(() => ins('Implantação atrasada', '400 days')), '23514', 'prazo acima de 366 dias');
    const id = (await ins('Implantação atrasada pelo suporte', '10 days')).rows[0].id;
    assert.match(await erroDe(() => q("UPDATE empresa_excecoes_comerciais SET valida_ate = valida_ate + interval '30 days' WHERE id = $1", [id])), /imutável/);
    assert.match(await erroDe(() => q('DELETE FROM empresa_excecoes_comerciais WHERE id = $1', [id])), /não é apagada/);
    assert.equal(await erroDe(() => q('UPDATE empresa_excecoes_comerciais SET revogada_em = now(), revogada_por = $2 WHERE id = $1', [id, ids.usuario])), '23514', 'revogação sem motivo');
    assert.equal(await erroDe(() => q("UPDATE empresa_excecoes_comerciais SET revogada_em = now(), revogada_por = $2, motivo_revogacao = 'Concedida por engano' WHERE id = $1", [id, ids.usuario])), 'OK');
    assert.match(await erroDe(() => q("UPDATE empresa_excecoes_comerciais SET motivo_revogacao = 'Outra revogação' WHERE id = $1", [id])), /já revogada/);
    await q('ROLLBACK');
});

test('representação: uma vigente por pessoa e empresa; DECLARADA → APROVADA/RECUSADA com motivo; APROVADA → REVOGADA; nada volta', async () => {
    await q('BEGIN');
    const declarar = () => q("INSERT INTO empresa_representacoes (empresa_id, usuario_id, qualificacao, descricao_evidencia) VALUES ($1, $2, 'RESPONSAVEL_INDICADO', 'Autorização assinada pelo sócio') RETURNING id", [ids.empresa, ids.usuario]);
    const id = (await declarar()).rows[0].id;
    assert.equal(await erroDe(() => declarar()), '23505', 'segunda declaração vigente');
    assert.equal(await erroDe(() => q("UPDATE empresa_representacoes SET situacao = 'APROVADA', decidido_por = $2, decidido_em = now() WHERE id = $1", [id, ids.usuario])), '23514', 'decisão sem motivo');
    assert.equal(await erroDe(() => q("UPDATE empresa_representacoes SET situacao = 'APROVADA', decidido_por = $2, decidido_em = now(), motivo_decisao = 'Contrato social conferido' WHERE id = $1", [id, ids.usuario])), 'OK');
    assert.match(await erroDe(() => q("UPDATE empresa_representacoes SET situacao = 'DECLARADA', decidido_por = NULL, decidido_em = NULL, motivo_decisao = NULL WHERE id = $1", [id])), /Transição de representação inválida/);
    assert.match(await erroDe(() => q("UPDATE empresa_representacoes SET qualificacao = 'PROCURADOR' WHERE id = $1", [id])), /imutável/);
    assert.equal(await erroDe(() => q("UPDATE empresa_representacoes SET situacao = 'REVOGADA', motivo_decisao = 'Deixou a empresa' WHERE id = $1", [id])), 'OK');
    assert.equal(await erroDe(() => declarar()), 'OK', 'nova declaração depois da revogação');
    assert.match(await erroDe(() => q('DELETE FROM empresa_representacoes WHERE id = $1', [id])), /não é apagada/);
    await q('ROLLBACK');
});

test('rollback: recusa com dado comercial; sem dados remove tudo; reaplicação limpa', async () => {
    await q("INSERT INTO empresa_assinaturas (empresa_id, situacao, teste_inicio, teste_fim) VALUES ($1, 'TESTE', now(), now() + interval '30 days')", [ids.empresa]);
    await assert.rejects(q(sql(ROLLBACK)), /rollback recusado/);
    await q('ROLLBACK').catch(() => undefined);
    await q('DELETE FROM empresa_assinaturas WHERE empresa_id = $1', [ids.empresa]);
    await q(sql(ROLLBACK));
    assert.equal((await q("SELECT to_regclass('public.empresa_assinaturas') IS NULL AS ok")).rows[0].ok, true);
    await q(sql(PRE));
    await q(sql(MIGRATION));
    await q(sql(POS));
});
