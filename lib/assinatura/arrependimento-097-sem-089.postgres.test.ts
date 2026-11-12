import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Client } from 'pg';
import { conectarDescartavel, encerrarDescartavel } from '../comercial/postgres-descartavel.ts';
import { iniciarTeste } from './servico.ts';
import { sincronizarEmpresa } from './sincronizacao.ts';
import type { AssinaturaProvedor, CobrancaProvedor } from './asaas.ts';
import { concluirArrependimento, evidenciaDaAssinatura, registrarArrependimento, registrarComunicacaoIntermediador, type DepsArrependimento } from './arrependimento.ts';

/**
 * 097 SEM a 089 (revisão f6b6fbb, P2-N5): controle físico no modelo 086 (068 e 074a instaladas, assinatura_encerramentos
 * ausente). A 097 aplica; registro, evidência de titularidade, conclusão com restituição, sincronização (cobrancasDevolvidas
 * só com a 097), vigia e rollback funcionam sem tocar a tabela da 089.
 */
const ler = (f: string) => readFileSync(f, 'utf8');
const SQL = {
    pre: ler('database/checks/20261023_097_precheck.sql'), up: ler('database/migrations/20261023_097_assinatura_arrependimentos.sql'),
    post: ler('database/checks/20261023_097_postcheck.sql'), down: ler('database/rollback/20261023_097_assinatura_arrependimentos_down.sql'),
};
const vigia = createRequire(import.meta.url)('../../scripts/arrependimento-vigia.cjs') as {
    lerVigia: (c: unknown, instanteMs?: number | null) => Promise<{ instalado: boolean; recebidas: number; codigo: number }>;
};
const opt = () => process.env.KIDMAIS_POSTGRES_DESCARTAVEL === 'kidmais_pacotes_v1_descartavel';

let client: Client;
const q = (texto: string, params: unknown[] = []) => client.query(texto, params);
const ids: Record<string, string> = {};
async function emTx<T>(acao: () => Promise<T>): Promise<T> {
    await q('BEGIN');
    try { const r = await acao(); await q('COMMIT'); return r; }
    catch (error) { await q('ROLLBACK'); throw error; }
}
async function erro(p: Promise<unknown>) { try { await p; return 'OK'; } catch (e) { return (e as { code?: string }).code ?? (e as Error).message; } }
const tenant = () => ({ empresaComprovada: ids.empresa, membershipId: 'm', usuarioId: ids.usuario, papelAtual: 'REPRESENTANTE_AUTORIZADO' });
const deps = (): DepsArrependimento => ({ withTenantTransaction: (_s, _e, t) => emTx(() => t(client as never, tenant() as never)), withTransaction: (t) => emTx(() => t(client as never)),
    env: {}, enviarEmail: null });
async function sessao() {
    const r = (await q(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS c`)).rows[0];
    return { id: 's', usuario_id: ids.usuario, nome: 'Gestão', cargo: null, papel: 'REPRESENTANTE_AUTORIZADO' as const, autenticado_em: r.c, consultado_em: r.c, expira_em: '', csrf_hash: '' };
}
const assinaturas = new Map<string, AssinaturaProvedor>();
const cobrancas = new Map<string, CobrancaProvedor[]>();
const provedor = {
    async obterAssinatura(id: string) { return assinaturas.get(id) ?? null; },
    async listarCobrancasDaAssinatura(id: string) { return (cobrancas.get(id) ?? []).map((c) => ({ ...c })); },
    async listarAssinaturasPorReferencia(ref: string) { return [...assinaturas.values()].filter((a) => a.externalReference === ref); },
};

test.before(async () => {
    if (!opt()) return;
    client = await conectarDescartavel();
    ids.usuario = (await q("INSERT INTO usuarios_administrativos (email, nome, senha_hash, papel, ativo) VALUES ($1, 'Gestão 097', $2, 'REPRESENTANTE_AUTORIZADO', true) RETURNING id",
        [`s89${randomBytes(3).toString('hex')}@example.test`, `scrypt$v=1$N=131072$r=8$p=1$${'A'.repeat(22)}==$${'B'.repeat(86)}==`])).rows[0].id;
});
test.after(async () => { if (client) await encerrarDescartavel(client); });

test('097 sem 089: aplica, registra, prova titularidade, conclui, sincroniza sem reabrir, vigia e rollback', { skip: !opt() }, async () => {
    assert.equal((await q("SELECT to_regclass('public.assinatura_encerramentos') IS NULL AS sem89, to_regclass('public.assinatura_contratacoes') IS NOT NULL AS com074a")).rows[0].sem89, true, 'modelo sem a 089');
    await q(SQL.pre); await q(SQL.up); await q(SQL.post);
    // Empresa em TESTE, pedido SEM vínculo; depois a assinatura é vinculada e paga (ATIVA).
    ids.empresa = (await q("INSERT INTO empresas (codigo, nome, status) VALUES ($1, 'Buffet Sem 089', 'PROVISIONAMENTO') RETURNING id", [`s89${randomBytes(3).toString('hex')}`])).rows[0].id;
    await q("UPDATE empresas SET status = 'ATIVA' WHERE id = $1", [ids.empresa]);
    await emTx(() => iniciarTeste(client as never, { empresaId: ids.empresa, documento: '11444777000161' }));
    const r = await registrarArrependimento(await sessao(), null, { chave: randomUUID(), confirmar: true, motivo: 'sem 089' }, { requestId: randomUUID() }, deps());
    const sub = 'sub_sem89_1';
    const hoje = (await q("SELECT to_char((clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date, 'YYYY-MM-DD') AS d")).rows[0].d as string;
    assinaturas.set(sub, { id: sub, status: 'ACTIVE', deleted: false, cycle: 'MONTHLY', customer: 'cus_sem89', externalReference: ids.empresa, valorCentavos: 19_700 });
    cobrancas.set(sub, [{ id: 'pay_sem89_1', status: 'RECEIVED', dueDate: hoje, paymentDate: hoje, invoiceUrl: null, deleted: false, valorCentavos: 19_700, billingType: 'PIX', assinaturaId: sub }]);
    await q("UPDATE empresa_assinaturas SET provedor = 'ASAAS', provedor_cliente_id = 'cus_sem89', provedor_assinatura_id = $2 WHERE empresa_id = $1", [ids.empresa, sub]);
    const s0 = await emTx(() => sincronizarEmpresa(client as never, ids.empresa, { provedor: provedor as never }, { tipo: 'RECONCILIACAO' }));
    assert.equal(s0.resultado === 'SINCRONIZADA' && s0.depois, 'ATIVA');
    // Evidência sem a 089: ATUAL pela fonte local; desconhecida sem provedor → null (sem 42P01).
    assert.equal(await emTx(() => evidenciaDaAssinatura(client as never, ids.empresa, sub, null)), 'ATUAL');
    assert.equal(await emTx(() => evidenciaDaAssinatura(client as never, ids.empresa, 'sub_desconhecida', null)), null);
    await emTx(() => registrarComunicacaoIntermediador(client as never, { empresaId: ids.empresa, protocolo: r.protocolo, referencia: 'estorno pedido' }));
    const c = await emTx(() => concluirArrependimento(client as never, { empresaId: ids.empresa, protocolo: r.protocolo, usuarioId: ids.usuario, situacao: 'RESTITUIDO',
        referencia: 'estorno Asaas', valorCentavos: 19_700, cobrancaIds: ['pay_sem89_1'], assinaturaId: sub }, provedor as never));
    assert.deepEqual(c, { protocolo: r.protocolo, situacao: 'RESTITUIDO', encerrou: true, mesmaAssinatura: true, evidencia: 'ATUAL' });
    // Sincronização com cobrancasDevolvidas só da 097: a cobrança restituída não reabre.
    const s1 = await emTx(() => sincronizarEmpresa(client as never, ids.empresa, { provedor: provedor as never }, { tipo: 'RECONCILIACAO' }));
    assert.equal(s1.resultado === 'SINCRONIZADA' && s1.depois, 'ENCERRADA', JSON.stringify(s1));
    // Vigia sem a 089.
    const v = await vigia.lerVigia(client);
    assert.equal(v.instalado, true); assert.equal(v.recebidas, 0); assert.equal(v.codigo, 0);
    assert.equal(await erro(q(SQL.down)), 'P0001', 'rollback recusado com dados');
    await q('ROLLBACK').catch(() => undefined);
    assert.equal((await q("SELECT to_regclass('public.assinatura_encerramentos') IS NULL AS ok")).rows[0].ok, true, 'a 089 continua ausente');
});
