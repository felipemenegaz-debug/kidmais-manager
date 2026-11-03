import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { Client } from 'pg';
import type { MensagemEmail } from '../acessos/email.ts';
import { conectarDescartavel, encerrarDescartavel, semTransacaoExplicita } from '../comercial/postgres-descartavel.ts';
import { cod, empresa, executor, porSavepoint, SENHA_FALSA, vincular } from '../marketing/harness-postgres.ts';
import { enfileirarAvisosDaEmpresa, enviarPendentes, type DepsAvisos } from './avisos-envio.ts';
import { registrarAvisosDaTransicao, registrarDevolucaoAviso, repositorioAvisos } from './avisos-repositorio.ts';

/**
 * Migration 087 (avisos por e-mail da assinatura) no PostgreSQL descartável, sobre o modelo 086. ESCRITA, NÃO EXECUTADA:
 * só pelo check:v1:postgres com KIDMAIS_POSTGRES_DESCARTAVEL e autorização explícita de Felipe para o cluster descartável.
 * Tudo numa transação desfeita no fim. Dados sintéticos (domínio .test); e-mail por provedor falso.
 *   1. precheck, aplicação, postcheck e reaplicação recusada;
 *   2. job: um aviso por pessoa da Gestão (Equipe fora), repetir não duplica (UNIQUE), envio grava evidências;
 *   3. guarda: destinatário fora da Gestão, DELETE, conteúdo alterado e transição inválida recusados;
 *   4. gancho da transição: idempotente e, com falha no INSERT, a transação externa continua utilizável;
 *   5. devolução (bounce): ENVIADO → DEVOLVIDO, idempotente;
 *   6. rollback: recusado com histórico; sem histórico, desfaz e permite reaplicar.
 */
const ler = (f: string) => readFileSync(f, 'utf8');
const UP = ler('database/migrations/20261019_087_assinatura_avisos.sql');
const PRE = ler('database/checks/20261019_087_precheck.sql');
const POST = ler('database/checks/20261019_087_postcheck.sql');
const DOWN = ler('database/rollback/20261019_087_assinatura_avisos_down.sql');
const P = { regularizacaoDias: 7, somenteLeituraDias: 60 };

async function recusa(c: Client, sql: string, v: unknown[], motivo: RegExp) {
    await c.query('SAVEPOINT recusa');
    await assert.rejects(c.query(sql, v), motivo);
    await c.query('ROLLBACK TO SAVEPOINT recusa');
}
async function pessoa(c: Client, empresaId: string, papel: 'REPRESENTANTE_AUTORIZADO' | 'ADMINISTRATIVO') {
    const usuario = (await c.query<{ id: string }>(`INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Pessoa sintética', $2, $3, true) RETURNING id::text AS id`,
        [`${cod('u')}@avisos.test`, SENHA_FALSA, papel])).rows[0].id;
    await vincular(c, empresaId, usuario, papel);
    return usuario;
}

test('087: checks, fila idempotente por pessoa da Gestão, guarda, gancho isolado, devolução e rollback', { timeout: 300_000 }, async (t) => {
    if (process.env.KIDMAIS_POSTGRES_DESCARTAVEL !== 'kidmais_pacotes_v1_descartavel') { t.skip('opt-in ausente: harness PostgreSQL não executado'); return; }
    const c = await conectarDescartavel();
    try {
        // 1. Checks e aplicação (a 087 tem BEGIN/COMMIT próprios: aplicada fora da transação da suíte e desfeita no fim pelo down).
        await c.query(PRE); await c.query(UP); await c.query(POST);
        await assert.rejects(c.query(UP), /087 já aplicada/); await c.query('ROLLBACK').catch(() => {});
        await c.query('BEGIN');
        const e = await empresa(c, 'Buffet Sintético Avisos');
        const gestao = await pessoa(c, e, 'REPRESENTANTE_AUTORIZADO');
        const equipe = await pessoa(c, e, 'ADMINISTRATIVO');
        // Último dia do teste daqui a 2 dias (Brasília) ⇒ TESTE_FIM_3_DIAS.
        await c.query(`INSERT INTO empresa_assinaturas (empresa_id, situacao, teste_inicio, teste_fim) VALUES ($1::uuid, 'TESTE', clock_timestamp() - interval '12 days', clock_timestamp() + interval '2 days 6 hours')`, [e]);

        // 2. Job: enfileira e envia.
        const enviados: MensagemEmail[] = [];
        const deps: DepsAvisos = { repositorio: repositorioAvisos(porSavepoint(c)), origem: 'https://manager.example', prazos: P, simular: false,
            enviar: async (m) => { enviados.push(m); return { provedor: 'arquivo', idExterno: `email_${enviados.length}` }; } };
        assert.deepEqual(await enfileirarAvisosDaEmpresa(e, deps), { criados: 1, existentes: 0 });
        assert.deepEqual(await enfileirarAvisosDaEmpresa(e, deps), { criados: 0, existentes: 1 });
        const linha = (await c.query<{ id: string; tipo: string; destinatario_id: string; estado: string }>('SELECT id::text AS id, tipo, destinatario_id::text AS destinatario_id, estado FROM assinatura_avisos WHERE empresa_id = $1::uuid', [e])).rows;
        assert.deepEqual(linha.map((l) => [l.tipo, l.destinatario_id, l.estado]), [['TESTE_FIM_3_DIAS', gestao, 'PENDENTE']]);
        assert.deepEqual(await enviarPendentes(deps, e), { ENVIADO: 1 });
        assert.deepEqual(await enviarPendentes(deps, e), {});
        const enviado = (await c.query('SELECT estado, id_externo, tentado_em IS NOT NULL AS tentou, enviado_em IS NOT NULL AS enviou FROM assinatura_avisos WHERE id = $1::uuid', [linha[0].id])).rows[0];
        assert.deepEqual(enviado, { estado: 'ENVIADO', id_externo: 'email_1', tentou: true, enviou: true });
        assert.equal(enviados.length, 1);

        // 3. Guarda.
        const mensagem = (id: string) => JSON.stringify({ para: 'x@avisos.test', assunto: 'a', texto: 't', html: 'h', idempotencia: `kidmais-aviso-assinatura/${id}` });
        const outro = '99999999-9999-4999-8999-999999999999';
        await recusa(c, `INSERT INTO assinatura_avisos (id, empresa_id, tipo, marco, destinatario_id, mensagem) VALUES ($1::uuid, $2::uuid, 'SUSPENSO', clock_timestamp(), $3::uuid, $4::jsonb)`,
            [outro, e, equipe, mensagem(outro)], /destinatário ativo da Gestão/);
        await recusa(c, `INSERT INTO assinatura_avisos (id, empresa_id, tipo, marco, destinatario_id, mensagem) VALUES ($1::uuid, $2::uuid, 'SUSPENSO', clock_timestamp(), $3::uuid, $4::jsonb)`,
            [outro, e, gestao, mensagem('outra-chave')], /check/i);
        await recusa(c, 'DELETE FROM assinatura_avisos WHERE id = $1::uuid', [linha[0].id], /não é apagado/);
        await recusa(c, `UPDATE assinatura_avisos SET mensagem = mensagem || '{"assunto":"x"}'::jsonb WHERE id = $1::uuid`, [linha[0].id], /imutáveis/);
        await recusa(c, `UPDATE assinatura_avisos SET estado = 'PENDENTE' WHERE id = $1::uuid`, [linha[0].id], /Transição de aviso inválida/);

        // 4. Gancho da transição (pagamento confirmado): idempotente; com falha no INSERT, a transação externa segue viva.
        const tx = executor(c);
        const ligado = { env: { ASSINATURA_AVISOS_EMAIL: 'ligado' }, origem: () => 'https://manager.example' };
        const antes = { situacao: 'TESTE' as const, periodoAtualFim: null };
        const depois = { situacao: 'ATIVA' as const, periodoAtualFim: '2030-01-09T03:00:00.000Z' };
        assert.equal(await registrarAvisosDaTransicao(tx, e, antes, depois, ligado), 1);
        assert.equal(await registrarAvisosDaTransicao(tx, e, antes, depois, ligado), 0);
        await c.query(`CREATE FUNCTION pg_temp.falha_sintetica() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'falha sintética'; END $$`);
        await c.query('CREATE TRIGGER falha_sintetica BEFORE INSERT ON assinatura_avisos FOR EACH ROW EXECUTE FUNCTION pg_temp.falha_sintetica()');
        const aviso = console.warn; console.warn = () => undefined;
        try { assert.equal(await registrarAvisosDaTransicao(tx, e, antes, { ...depois, periodoAtualFim: '2030-02-09T03:00:00.000Z' }, ligado), 0); }
        finally { console.warn = aviso; }
        assert.equal((await c.query('SELECT 1 AS ok')).rows[0].ok, 1, 'transação externa utilizável');
        await c.query('DROP TRIGGER falha_sintetica ON assinatura_avisos');

        // 5. Devolução.
        const entrada = { idExterno: 'email_1', motivo: 'ENTREGA_RECUSADA', eventoId: 'msg_sintetica' };
        assert.equal(await registrarDevolucaoAviso(tx, entrada), 'AVISO_DEVOLVIDO');
        assert.equal(await registrarDevolucaoAviso(tx, entrada), 'AVISO_JA_DEVOLVIDO');

        // 6. Rollback com histórico recusado (sem CASCADE); dados da suíte desfeitos.
        await recusa(c, semTransacaoExplicita(DOWN), [], /rollback recusado com histórico/);
        await c.query('ROLLBACK');
        // Sem histórico: o down desfaz e a 087 pode ser reaplicada; o schema volta ao modelo 086 no fim.
        await c.query(DOWN);
        assert.equal((await c.query("SELECT to_regclass('public.assinatura_avisos') IS NULL AS ausente")).rows[0].ausente, true);
        await c.query(UP); await c.query(DOWN);
    }
    finally {
        await c.query('ROLLBACK').catch(() => {});
        await encerrarDescartavel(c);
    }
});
