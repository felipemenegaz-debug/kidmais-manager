// Synthetic legacy fixture only: schema 001–018 plus disposable test data without Festa,
// then migration 019 installed normally. Never restores or reads a real database.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { Client } from 'pg';

const expected = process.argv[process.argv.indexOf('--database') + 1];
let url;
try { url = new URL(process.env.FESTA_019_TEST_URL ?? 'postgresql://invalid@invalid/invalid'); }
catch { throw Error('Invalid disposable target; no connection attempted'); }
if (!process.argv.includes('--authorize-disposable') || !/^kidmais_019_\d+$/.test(expected ?? '')
    || decodeURIComponent(url.pathname.slice(1)) !== expected || url.hostname !== '127.0.0.1'
    || !['postgres:', 'postgresql:'].includes(url.protocol) || url.search || url.hash) {
    throw Error('Explicit disposable target required; no connection attempted');
}
const client = new Client({ connectionString: url.toString() });
const execute = id => {
    const args = ['--experimental-strip-types', 'scripts/festa-019-reconciliar.mjs', '--database', expected];
    if (id) args.push('--apply', '--authorize-write', '--contrato', id);
    const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 40000,
        env: { ...process.env, FESTA_ENABLED: 'true', FESTA_019_RECONCILIACAO_URL: url.toString() } });
    return { status: r.status, data: r.stdout.trim() ? JSON.parse(r.stdout) : null };
};
try {
    await client.connect();
    const identity = (await client.query('SELECT current_database() db,current_user usuario,inet_server_addr() host,inet_server_port() porta')).rows[0];
    assert.equal(identity.db, expected);
    console.log(JSON.stringify(identity));
    const candidates = execute();
    assert.equal(candidates.status, 0);
    const candidate = candidates.data.contratos.find(c => c.elegivel && !c.conflito_contrato && !c.conflito_bloqueio);
    assert(candidate, 'Requires signed synthetic legacy contract without Festa');
    const id = candidate.contrato_id;
    const counts = async () => Number((await client.query('SELECT count(*) n FROM festas WHERE contrato_id=$1', [id])).rows[0].n);
    assert.equal(await counts(), 0);
    console.log('PASS signed legacy contract without Festa is reported eligible; read-only does not write');

    // Deliberately reproduce an inconsistent legacy block, solely in this disposable fixture.
    // Disable exactly its validation trigger for the INSERT, restoring it in the SAME transaction.
    // Application/migration triggers are never bypassed by the reconciliation tool under test.
    await client.query('BEGIN');
    try {
        assert.equal((await client.query('SELECT current_database() db')).rows[0].db, expected);
        await client.query('ALTER TABLE bloqueios_agenda DISABLE TRIGGER fr_bloqueio_proteger_trg');
        const block = (await client.query(`INSERT INTO bloqueios_agenda(data,dia_inteiro,motivo)
            SELECT f.data_evento,true,'Synthetic legacy conflict 019' FROM fechamentos f
            JOIN contratos c ON c.fechamento_id=f.id WHERE c.id=$1 RETURNING id`, [id])).rows[0].id;
        await client.query('ALTER TABLE bloqueios_agenda ENABLE TRIGGER fr_bloqueio_proteger_trg');
        await client.query('COMMIT');
        assert.equal((await client.query("SELECT tgenabled FROM pg_trigger WHERE tgname='fr_bloqueio_proteger_trg'")).rows[0].tgenabled, 'O');
        const conflict = execute();
        assert.equal(conflict.status, 0);
        assert.equal(conflict.data.contratos.find(c => c.contrato_id === id).conflito_bloqueio, true);
        assert.equal(execute(id).status, 1);
        assert.equal(await counts(), 0);
        console.log('PASS legacy conflict detected; authorized reconciliation refuses and creates nothing');
        await client.query('UPDATE bloqueios_agenda SET ativo=false WHERE id=$1', [block]);
    } catch (error) { await client.query('ROLLBACK'); throw error; }

    const cancelled = (await client.query("SELECT id FROM contratos WHERE status='CANCELADO' LIMIT 1")).rows[0];
    assert(cancelled);
    assert.equal(execute(cancelled.id).status, 1);
    assert.equal(Number((await client.query('SELECT count(*) n FROM festas WHERE contrato_id=$1', [cancelled.id])).rows[0].n), 0);
    console.log('PASS cancelled contract refuses reconciliation');
    const first = execute(id);
    assert.equal(first.status, 0);
    assert.equal(await counts(), 1);
    const second = execute(id);
    assert.equal(second.status, 0);
    assert.equal(second.data.festaId, first.data.festaId);
    assert.equal(await counts(), 1);
    assert.equal((await client.query("SELECT count(*)::int n FROM festa_eventos e JOIN festas f ON f.id=e.festa_id WHERE f.contrato_id=$1 AND e.tipo='FESTA_CRIADA'", [id])).rows[0].n, 1);
    console.log('PASS reconciliation creates once; repeated execution reuses same Festa and single event');
} catch (error) {
    console.error(JSON.stringify({ status: 'FAIL', code: error?.code ?? 'ASSERTION_OR_EXECUTION' }));
    process.exitCode = 1;
} finally { await client.end(); }
