/* eslint-disable @typescript-eslint/no-explicit-any */
// PR-B1, rodadas F2/F3/F6 e locks: serviços e repositórios reais de contratos, fechamentos, revisão e
// festas com executor SQL simulado.
// Tenant A tenta operar/ler dado de B: recusa uniforme, antes de qualquer escrita ou leitura do alvo.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';

const req = createRequire(import.meta.url);
const empresaA = 'aaaaaaaa-0000-4000-8000-00000000000a';
const empresaB = 'bbbbbbbb-0000-4000-8000-00000000000b';
const HASH = 'a'.repeat(64);
const uuid = (n: number) => `${String(n).padStart(8, '0')}-0000-4000-8000-000000000000`;

function carregar(arquivo: string, mocks: Record<string, unknown>) {
    const cache = new Map<string, Record<string, unknown>>();
    const achar = (base: string) => [base, base + '.ts', base + '/index.ts'].find(p => existsSync(p) && statSync(p).isFile()) ?? base;
    function load(file: string): Record<string, unknown> {
        const abs = achar(resolve(file)).replaceAll('\\', '/');
        for (const [chave, valor] of Object.entries(mocks)) if (abs.endsWith(chave)) return valor as Record<string, unknown>;
        const hit = cache.get(abs); if (hit) return hit;
        const exports: Record<string, unknown> = {}; cache.set(abs, exports);
        const code = ts.transpileModule(readFileSync(abs, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
        new Function('require', 'exports', code)((n: string) => n.startsWith('@/') ? load(n.slice(2)) : n.startsWith('.') ? load(resolve(dirname(abs), n)) : req(n), exports);
        return exports;
    }
    return load(arquivo);
}

// ---------------------------------------------------------------------------------------------
// Contratos (operarContrato), leitura da edição, revisão operacional e comercial — repositórios
// REAIS de fechamentos e contratos sobre um banco simulado. Nada de empresaDoFechamento mockado:
// toda consulta passa pelo executor e toda modalidade de lock (FOR UPDATE, FOR NO KEY UPDATE,
// FOR SHARE, FOR KEY SHARE) é registrada.
// ---------------------------------------------------------------------------------------------
const LOCK = /\bFOR\s+(UPDATE|NO\s+KEY\s+UPDATE|SHARE|KEY\s+SHARE)\b/i;
const tabela = (sql: string) => /\bFROM\s+(?:public\.)?(\w+)/i.exec(sql)?.[1] ?? '?';
type Estado = { tenant: string; empresaFechamento: string | null; comPreparacao?: boolean; preparacaoDeOutroFechamento?: boolean; versaoExiste?: boolean };
/** Banco simulado: responde pelos mesmos predicados das consultas reais (id e, quando houver, empresa_id). */
function banco(estado: Estado) {
    const sql: { texto: string; v: unknown[] }[] = [];
    // Ordem observável: 'sessao', 'tenant' e, para cada consulta, 'ler:<tabela>' ou 'lock:<tabela>'.
    const ordem: string[] = [];
    const empresaDe: Record<string, string | null> = { f1: estado.empresaFechamento };
    const versaoRow = { id: 'v1', contrato_id: 'c1', numero_versao: 1, status: 'ATIVA', snapshot_schema_versao: 1, snapshot_hash: HASH,
        snapshot: { fechamento: { id: 'f1' }, contratante: { clienteId: 'cl1' }, aniversariante: { id: 'an1' } } };
    const query = async (texto: string, v: unknown[] = []) => {
        sql.push({ texto, v }); ordem.push(`${LOCK.test(texto) ? 'lock' : 'ler'}:${tabela(texto)}`);
        if (/FROM contrato_versoes\s+WHERE id = \$1::uuid/.test(texto)) return { rows: estado.versaoExiste === false ? [] : [versaoRow] };
        if (/SELECT empresa_id::text AS empresa_id\s+FROM fechamentos\s+WHERE id = \$1::uuid/.test(texto))
            return { rows: String(v[0]) in empresaDe ? [{ empresa_id: empresaDe[String(v[0])] }] : [] };
        if (texto.startsWith('SELECT id FROM fechamentos WHERE id=$1 AND empresa_id=$2::uuid'))
            return { rows: empresaDe[String(v[0])] != null && empresaDe[String(v[0])] === v[1] ? [{ id: v[0] }] : [] };
        if (texto.startsWith('SELECT id,fechamento_id,status FROM contratos')) return { rows: v[0] === 'c1' ? [{ id: 'c1', fechamento_id: 'f1', status: 'AGUARDANDO_ASSINATURA' }] : [] };
        if (texto.startsWith('SELECT id,fechamento_id FROM contratos')) return { rows: [{ id: 'c1', fechamento_id: 'f1' }] };
        if (texto.startsWith('SELECT * FROM contrato_fluxos')) return { rows: [{ versao_vigente_id: null, versao_em_preparacao_id: 'v1' }] };
        if (texto.startsWith('SELECT status FROM contratos')) return { rows: [{ status: 'AGUARDANDO_ASSINATURA' }] };
        if (texto.startsWith('SELECT * FROM contrato_edicoes')) return { rows: [{ revisao: 1, estado: 'EM_ELABORACAO', origem_versao_id: null, dados_fonte: { schemaVersao: 1 } }] };
        return { rows: [] };
    };
    const locks = () => sql.filter(s => LOCK.test(s.texto));
    const escritas = () => sql.map(s => s.texto).filter(s => /^(INSERT|UPDATE|DELETE)/.test(s.trim()));
    return { tx: { query }, sql, ordem, locks, escritas };
}
const repositorioFechamentos = (b: ReturnType<typeof banco>) => carregar('lib/fechamentos/repositories/fechamento.repository.ts', { 'lib/db/postgres.ts': { db: () => b.tx } }) as any;
const repositorioContratos = (b: ReturnType<typeof banco>) => carregar('lib/contratos/repositories/contrato.repository.ts', { 'lib/db/postgres.ts': { db: () => b.tx } }) as any;
/** Stub com o mesmo SQL do repositório real (buscarRevisaoDaVersao: `FOR UPDATE` só com lock=true). */
const revisaoSimulada = (b: ReturnType<typeof banco>, estado: Estado) => async (vid: string, _tx: unknown, lock = false) => {
    await b.tx.query(`SELECT r.* FROM fechamento_revisoes r WHERE contrato_versao_id=$1 ${lock ? 'FOR UPDATE' : ''}`, [vid]);
    return estado.comPreparacao ? { id: 'r1', estado: 'EM_ELABORACAO', fechamento_id: estado.preparacaoDeOutroFechamento ? 'f2' : 'f1' } : null;
};
function contratos(estado: Estado) {
    const b = banco(estado);
    const chamadas: { fn: string; args: unknown[] }[] = [];
    const reg = (fn: string, ret: (...a: any[]) => unknown = () => undefined) => async (...args: unknown[]) => { chamadas.push({ fn, args }); return ret(...args); };
    const mod = carregar('lib/contratos/services/administrativo.service.ts', {
        'lib/db/postgres.ts': { db: () => b.tx, withTransaction: (fn: any) => fn(b.tx) },
        'lib/autenticacao/service.ts': { consultarSessao: async () => { b.ordem.push('sessao'); return { usuario_id: 'u1', papel: 'ADMINISTRATIVO' }; }, authError: (m: string) => Error(m) },
        'lib/saas/provar-tenant.ts': { provarTenant: reg('provarTenant', () => (b.ordem.push('tenant'), { empresaComprovada: estado.tenant, membershipId: 'm', usuarioId: 'u1' })) },
        'lib/contratos/repositories/index.ts': { ...repositorioContratos(b), criarContratoVersao: reg('criarContratoVersao') },
        'lib/fechamentos/repositories/index.ts': { ...repositorioFechamentos(b), buscarFechamentoPorId: async () => ({ id: 'f1' }),
            buscarFechamentoPorIdParaAtualizacao: async (id: string) => { await b.tx.query('SELECT * FROM fechamentos WHERE id = $1::uuid LIMIT 1 FOR UPDATE', [id]); return { id: 'f1' }; } },
        'lib/fechamentos/repositories/revisao.repository.ts': {
            buscarRevisaoDaVersao: revisaoSimulada(b, estado), listarItensRevisao: async () => [], salvarOperacaoPreparada: reg('salvarOperacaoPreparada'),
        },
        'lib/fechamentos/services/revisao-operacional.service.ts': {
            editarPreparacao: reg('editarPreparacao', () => ({ id: 'r1' })), snapshotPreparacao: async () => ({}), recusarComercialPreparacao: reg('recusarComercialPreparacao'),
            iniciarPreparacao: reg('iniciarPreparacao'), aprovarPreparacao: reg('aprovarPreparacao'), revalidarAgendaRevisao: reg('revalidarAgendaRevisao'),
            congelarPreparacao: reg('congelarPreparacao'), cancelarPreparacao: reg('cancelarPreparacao'),
        },
        'lib/fechamentos/services/edicao-administrativa.service.ts': { editarFechamentoAdministrativo: reg('editarFechamentoAdministrativo', () => ({ id: 'f1' })) },
        'lib/clientes/repositories/index.ts': { registrarAuditoria: reg('registrarAuditoria'), registrarEventoHistorico: reg('registrarEventoHistorico'),
            buscarClientePorId: async () => null, buscarAniversariantePorId: async () => null },
        'lib/clientes/services/index.ts': { atualizarClienteInterno: reg('atualizarClienteInterno') },
        'lib/clientes/services/aniversariante.service.ts': { atualizarAniversarianteInterno: reg('atualizarAniversarianteInterno') },
        'lib/contratos/services/snapshot-core.ts': { hashSnapshotContrato: () => HASH },
        'lib/contratos/services/contrato.service.ts': { carregarSnapshot: async () => ({ snapshot: {} }) },
        'lib/contratos/services/revisao-inicial.ts': { exigirVersaoEditavel: () => undefined, fonteDaRevisaoInicial: async (_v: unknown, f: unknown) => f, prepararEdicaoInicial: reg('prepararEdicaoInicial') },
        'lib/contratos/services/alteracoes.ts': { diferencasContratuais: () => [] },
        'lib/contratos/documento/index.ts': {}, 'lib/contratos/storage/postgres.ts': {},
    }) as any;
    const mutacoes = () => chamadas.filter(c => c.fn !== 'provarTenant');
    return { mod, chamadas, mutacoes, ...b };
}
const edicao = {
    acao: 'editar_festa', revisao: 1, motivo: 'Ajuste pedido', fonteHash: HASH, pacoteId: uuid(1), convidados: 30, dataEvento: '2027-01-10',
    configuracaoAgendaId: uuid(2), horarioInicio: '11:00', horarioFim: '15:00', adicionais: [], idadeAniversarianteEvento: null, temaFesta: '',
    buffetStatus: 'PENDENTE', buffetSalgados: '', buffetBebidas: '', buffetDoces: '', buffetBolo: '', buffetOutros: '', observacoesEquipe: '',
};
const payloads: [string, object][] = [
    ['apenas data', { ...edicao, dataEvento: '2027-02-20' }],
    ['apenas pacote', { ...edicao, pacoteId: uuid(9) }],
    ['apenas condição comercial', { ...edicao, comercial: { confirmarAprovacao: true, forma: 'PIX_AVISTA', baseNegociada: null, condicaoPix: null } }],
    ['salvar', { acao: 'salvar', revisao: 1, observacoesDocumentais: '' }],
    ['revalidar destino', { acao: 'revalidar_destino', revisao: 1 }],
    ['cancelar revisão', { acao: 'cancelar_revisao', revisao: 1, motivo: 'Cancelar agora' }],
    ['cancelar contratação', { acao: 'cancelar_contratacao', motivo: 'Cliente desistiu' }],
];
const ctxReq = { requestId: 'r', ip: null, userAgent: null };
for (const [caso, payload] of payloads) {
    for (const comPreparacao of [true, false]) {
        test(`F3: tenant A operando contrato de B (${caso}, ${comPreparacao ? 'com' : 'sem'} revisão) é recusado antes de qualquer escrita`, async () => {
            const k = contratos({ tenant: empresaA, empresaFechamento: empresaB, comPreparacao });
            await assert.rejects(k.mod.operarContrato('v1', payload, 'token', ctxReq),
                (e: any) => e.code === 'DADOS_CONTRATUAIS_INCONSISTENTES' && e.message === 'Versão não encontrada.');
            assert.deepEqual(k.escritas(), []); assert.deepEqual(k.mutacoes(), []);
        });
    }
}
test('F3: fechamento legado sem empresa falha fechado para qualquer ação', async () => {
    for (const [, payload] of payloads) {
        const k = contratos({ tenant: empresaA, empresaFechamento: null, comPreparacao: true });
        await assert.rejects(k.mod.operarContrato('v1', payload, 'token', ctxReq), /Versão não encontrada/);
        assert.deepEqual(k.escritas(), []); assert.deepEqual(k.mutacoes(), []);
    }
});
test('F3: revisão de outro fechamento não é aceita mesmo com tenant correto', async () => {
    const k = contratos({ tenant: empresaA, empresaFechamento: empresaA, comPreparacao: true, preparacaoDeOutroFechamento: true });
    await assert.rejects(k.mod.operarContrato('v1', { ...edicao, dataEvento: '2027-02-20' }, 'token', ctxReq), /Versão não encontrada/);
    assert.deepEqual(k.escritas(), []); assert(!k.chamadas.some(c => c.fn === 'editarPreparacao'));
});
test('F3: tenant A no contrato de A segue e repassa a empresa comprovada à revisão, sem depender do payload', async () => {
    const k = contratos({ tenant: empresaA, empresaFechamento: empresaA, comPreparacao: true });
    await k.mod.operarContrato('v1', { ...edicao, dataEvento: '2027-02-20' }, 'token', ctxReq, empresaA);
    const editar = k.chamadas.find(c => c.fn === 'editarPreparacao')!;
    assert.equal((editar.args[3] as any).empresaAutorizada, empresaA);
    assert.equal(k.chamadas.find(c => c.fn === 'provarTenant')!.args[2], empresaA);
});
test('F3: sem revisão, edição de A em A passa pelo tenant antes de editar o fechamento', async () => {
    const k = contratos({ tenant: empresaA, empresaFechamento: empresaA, comPreparacao: false });
    await k.mod.operarContrato('v1', { ...edicao, pacoteId: uuid(9) }, 'token', ctxReq);
    const ordem = k.chamadas.map(c => c.fn);
    assert(ordem.indexOf('provarTenant') >= 0 && ordem.indexOf('provarTenant') < ordem.indexOf('editarFechamentoAdministrativo'));
});

// Ordem comum: sessão → provarTenant → pré-leitura sem lock → autorização → locks → revalidação.
for (const [caso, payload] of payloads) {
    test(`locks: tenant A contra contrato de B (${caso}) é recusado com ZERO consultas com lock de qualquer modalidade`, async () => {
        for (const comPreparacao of [true, false]) {
            const k = contratos({ tenant: empresaA, empresaFechamento: empresaB, comPreparacao });
            await assert.rejects(k.mod.operarContrato('v1', payload, 'token', ctxReq), /Versão não encontrada/);
            assert.deepEqual(k.locks(), [], 'nenhum FOR UPDATE / NO KEY UPDATE / SHARE / KEY SHARE');
            assert.deepEqual(k.ordem.slice(0, 2), ['sessao', 'tenant'], 'sessão e tenant antes de localizar o recurso');
            // A empresa do fechamento de B foi lida pelo repositório real, sem trava.
            const leitura = k.sql.find(s => s.texto.includes('empresa_id::text AS empresa_id'))!;
            assert.deepEqual(leitura.v, ['f1']); assert.doesNotMatch(leitura.texto, LOCK);
            assert(!k.ordem.some(o => o.endsWith(':fechamento_revisoes')), 'revisão nem é lida');
        }
    });
}
test('locks: versão inexistente e fechamento legado recusam igual, sem lock de qualquer modalidade', async () => {
    for (const estado of [{ versaoExiste: false, empresaFechamento: empresaA }, { empresaFechamento: null }]) {
        const k = contratos({ tenant: empresaA, comPreparacao: true, ...estado });
        await assert.rejects(k.mod.operarContrato('v1', payloads[0][1], 'token', ctxReq), (e: any) => e.message === 'Versão não encontrada.' && e.code === 'DADOS_CONTRATUAIS_INCONSISTENTES');
        assert.deepEqual(k.locks(), []);
    }
});
test('locks: revisão de outro fechamento é recusada sem travar a revisão', async () => {
    const k = contratos({ tenant: empresaA, empresaFechamento: empresaA, comPreparacao: true, preparacaoDeOutroFechamento: true });
    await assert.rejects(k.mod.operarContrato('v1', payloads[0][1], 'token', ctxReq), /Versão não encontrada/);
    assert(!k.locks().some(s => tabela(s.texto) === 'fechamento_revisoes'));
    assert(k.ordem.includes('ler:fechamento_revisoes'), 'comparada na leitura simples');
});
for (const [caso, payload] of payloads.slice(0, 3)) {
    test(`locks: A em A (${caso}) autoriza primeiro; depois fechamento (no tenant) → contrato → fluxo → versão → revisão`, async () => {
        const k = contratos({ tenant: empresaA, empresaFechamento: empresaA, comPreparacao: true });
        await k.mod.operarContrato('v1', payload, 'token', ctxReq, empresaA);
        const primeiroLock = k.ordem.findIndex(o => o.startsWith('lock:'));
        const antes = k.ordem.slice(0, primeiroLock);
        assert.deepEqual(antes, ['sessao', 'tenant', 'ler:contrato_versoes', 'ler:contratos', 'ler:fechamentos'], 'autorização sem lock antes do primeiro lock');
        assert.deepEqual(k.locks().slice(0, 5).map(s => tabela(s.texto)), ['fechamentos', 'contratos', 'contrato_fluxos', 'contrato_versoes', 'fechamento_revisoes']);
        const [fechamento] = k.locks();
        assert.match(fechamento.texto, /WHERE id=\$1 AND empresa_id=\$2::uuid FOR UPDATE/); assert.deepEqual(fechamento.v, ['f1', empresaA]);
        assert(k.ordem.indexOf('ler:fechamento_revisoes') < k.ordem.indexOf('lock:fechamento_revisoes'), 'revisão comparada antes de travar');
        assert(k.chamadas.some(c => c.fn === 'editarPreparacao'));
    });
}
test('locks: GET da edição e POST seguem a mesma sequência; nenhum helper de autorização usa a variante com trava', () => {
    const svc = readFileSync('lib/contratos/services/administrativo.service.ts', 'utf8');
    const operar = svc.slice(svc.indexOf('export async function operarContrato'));
    const pos = (t: string) => { const i = operar.indexOf(t); assert(i >= 0, t); return i; };
    assert(pos('consultarSessao(') < pos('contratoDoTenant(') && pos('contratoDoTenant(') < pos('FOR UPDATE'));
    const helpers = svc.slice(svc.indexOf('export async function contratoDoTenant'), svc.indexOf('export async function edicaoDaVersao'));
    assert(helpers.indexOf('provarTenant(') < helpers.indexOf('buscarVersaoPorId('));
    assert.doesNotMatch(helpers, /FOR (UPDATE|SHARE|NO KEY|KEY)|forUpdate|ComTrava/);
    assert.doesNotMatch(svc, /empresaDoFechamentoComTrava/);
    const rota = readFileSync('app/api/admin/contratos/versoes/[versaoId]/edicao/route.ts', 'utf8');
    assert(rota.indexOf('withTenantTransaction(') < rota.indexOf('versaoDoTenant('));
    // O stub de revisão reproduz o SQL do repositório real.
    assert.match(readFileSync('lib/fechamentos/repositories/revisao.repository.ts', 'utf8'), /WHERE contrato_versao_id=\$1 \$\{lock \? 'FOR UPDATE' : ''\}/);
});

// Repositório: leitura de autorização sem trava; variante com trava explícita e separada.
test('repositório: empresaDoFechamentoSemTrava nunca trava; ComTrava usa FOR SHARE; nome ambíguo removido', async () => {
    const b = banco({ tenant: empresaA, empresaFechamento: empresaB });
    const repo = repositorioFechamentos(b);
    assert.equal(repo.empresaDoFechamento, undefined);
    assert.equal(await repo.empresaDoFechamentoSemTrava('f1', b.tx), empresaB);
    assert.equal(await repo.empresaDoFechamentoSemTrava('inexistente', b.tx), undefined);
    for (const s of b.sql) {
        assert.doesNotMatch(s.texto, LOCK);
        for (const modo of ['FOR SHARE', 'FOR UPDATE', 'FOR KEY SHARE', 'FOR NO KEY UPDATE']) assert(!s.texto.toUpperCase().includes(modo), modo);
    }
    const legado = banco({ tenant: empresaA, empresaFechamento: null });
    assert.equal(await repositorioFechamentos(legado).empresaDoFechamentoSemTrava('f1', legado.tx), null);
    const n = b.sql.length;
    assert.equal(await repo.empresaDoFechamentoComTrava('f1', b.tx), empresaB);
    assert.equal(b.sql.length, n + 1);
    assert.match(b.sql[n].texto, /WHERE id = \$1::uuid\s+FOR SHARE$/);
    assert.equal(b.locks().length, 1);
});

// editarPreparacao: comparação sem trava antes de qualquer lock; FOR SHARE só depois.
function preparacao(empresaFechamento: string | null) {
    const b = banco({ tenant: empresaA, empresaFechamento });
    const r = { id: 'r1', estado: 'EM_ELABORACAO', contrato_versao_id: 'v1', fechamento_id: 'f1', revisao: 1, conteudo_hash: 'h',
        operacao: { clienteId: 'c1', aniversarianteId: 'a1', pacoteId: 'p1', valorTabela: 1 } };
    const atualizados: unknown[] = [];
    const mod = carregar('lib/fechamentos/services/revisao-operacional.service.ts', {
        'lib/db/postgres.ts': { db: () => b.tx },
        'lib/fechamentos/repositories/index.ts': { ...repositorioFechamentos(b) },
        'lib/fechamentos/repositories/revisao.repository.ts': { buscarRevisaoDaVersao: async () => r, listarItensRevisao: async () => [] },
        'lib/clientes/repositories/index.ts': {
            buscarClientePorId: async () => ({ id: 'c1', status: 'ATIVO', empresaId: empresaA }), buscarAniversariantePorId: async () => ({ id: 'a1', clienteId: 'c1', ativo: true }),
            buscarResponsavelPorId: async () => null, registrarAuditoria: async () => undefined,
        },
        'lib/clientes/services/index.ts': { atualizarClienteInterno: async (...a: unknown[]) => { atualizados.push(a); } },
        'lib/clientes/services/aniversariante.service.ts': { atualizarAniversarianteInterno: async (...a: unknown[]) => { atualizados.push(a); } },
        'lib/comercial/services/index.ts': { calcularResumoComercial: async () => { throw Error('PARADA_DO_TESTE'); } },
        'lib/comercial/condicao-pagamento.ts': {}, 'lib/comercial/composicao.ts': {}, 'lib/disponibilidade/services/index.ts': {},
        'lib/contratos/services/contrato.service.ts': {}, 'lib/contratos/services/snapshot-core.ts': { hashSnapshotContrato: () => 'hash' },
    }) as any;
    const editar = (input: object) => mod.editarPreparacao(b.tx, r, { ...input, fonteHash: 'hash' }, { usuarioId: 'u', empresaAutorizada: empresaA });
    return { editar, atualizados, ...b };
}
for (const [caso, payload] of payloads.slice(0, 3)) {
    test(`locks: editarPreparacao A→B/legado (${caso}) recusa sem lock; A→A compara sem trava e só depois trava`, async () => {
        for (const empresa of [empresaB, null]) {
            const p = preparacao(empresa);
            await assert.rejects(p.editar(payload), /empresa administrativa comprovada/);
            assert.deepEqual(p.locks(), []); assert.deepEqual(p.atualizados, []);
            assert.deepEqual(p.ordem, ['ler:fechamentos'], 'só a leitura de autorização');
        }
        const p = preparacao(empresaA);
        await assert.rejects(p.editar(payload), /PARADA_DO_TESTE/);
        assert.equal(p.ordem[0], 'ler:fechamentos');
        assert.doesNotMatch(p.sql[0].texto, LOCK);
        const share = p.locks().find(s => /FOR SHARE/.test(s.texto))!;
        assert(p.sql.indexOf(share) > 0 && tabela(share.texto) === 'fechamentos', 'FOR SHARE só depois da autorização');
    });
}

// F2 — GET da edição: tenant provado, versão/fechamento carregados sem lock, comparação, só então dados.
function rotaEdicao(estado: { tenant: string; empresaFechamento: string | null; versaoExiste?: boolean }) {
    const k = contratos({ tenant: estado.tenant, empresaFechamento: estado.empresaFechamento, versaoExiste: estado.versaoExiste });
    const lidos: string[] = [];
    const fonte = { fechamento: { id: 'f1', dataEvento: '2027-01-10', convidados: 30, configuracaoAgendaId: uuid(2), pacoteId: uuid(1) }, adicionais: [] };
    const rota = carregar('app/api/admin/contratos/versoes/[versaoId]/edicao/route.ts', {
        'lib/http/admin-crm-api.ts': { exigirApiAdminCrmDisponivel: async () => ({ usuario_id: 'u1', papel: 'ADMINISTRATIVO' }) },
        'lib/http/api-response.ts': { jsonNoStore: (b: unknown) => Response.json(b), apiErrorResponse: (e: any) => Response.json({ erro: e.message, codigo: e.code }, { status: e.httpStatus ?? 500 }) },
        'lib/saas/provar-tenant.ts': { withTenantTransaction: async (_s: unknown, _e: unknown, work: any) => work(k.tx, { empresaComprovada: estado.tenant }) },
        'lib/contratos/services/administrativo.service.ts': {
            versaoDoTenant: k.mod.versaoDoTenant,
            fontesEdicao: async () => { lidos.push('fontesEdicao'); return fonte; }, edicaoDaVersao: async () => { lidos.push('edicaoDaVersao'); return null; },
        },
        'lib/fechamentos/services/revisao-operacional.service.ts': { fontesPreparacao: async () => { lidos.push('fontesPreparacao'); return fonte; } },
        'lib/contratos/services/revisao-inicial.ts': { fonteDaRevisaoInicial: async () => fonte },
        'lib/comercial/services/index.ts': { calcularResumoComercial: async () => { lidos.push('resumo'); return null; },
            listarPacotesComerciais: async (i: any) => { lidos.push('pacotes:' + i.empresaId); return []; }, listarCatalogoAdicionais: async () => [] },
        'lib/disponibilidade/services/index.ts': { consultarDisponibilidadeData: async () => ({}) },
        'lib/comercial/composicao.ts': { listarCodigosInclusos: async () => [] },
    }) as any;
    const get = () => rota.GET({ nextUrl: new URL('https://x.invalid/api/admin/contratos/versoes/v1/edicao') }, { params: Promise.resolve({ versaoId: uuid(7) }) });
    return { get, lidos, consultas: k.sql, locks: k.locks };
}
test('F2: edição de versão de outra empresa responde igual a inexistente, sem lock e sem carregar dados', async () => {
    const outra = rotaEdicao({ tenant: empresaA, empresaFechamento: empresaB });
    const r1 = await outra.get();
    const inexistente = rotaEdicao({ tenant: empresaA, empresaFechamento: empresaA, versaoExiste: false });
    const r2 = await inexistente.get();
    const legado = rotaEdicao({ tenant: empresaA, empresaFechamento: null });
    const r3 = await legado.get();
    assert.equal(r1.status, 409); assert.equal(r2.status, r1.status); assert.equal(r3.status, r1.status);
    const [b1, b2, b3] = [await r1.json(), await r2.json(), await r3.json()];
    assert.deepEqual(b1, b2); assert.deepEqual(b1, b3); assert.equal(b1.erro, 'Versão não encontrada.');
    for (const x of [outra, inexistente, legado]) {
        assert.deepEqual(x.lidos, []); assert.deepEqual(x.locks(), []);
        assert.deepEqual(x.consultas.map(c => tabela(c.texto)).filter(t => t !== 'contrato_versoes' && t !== 'fechamentos'), [], 'só versão e empresa do fechamento');
    }
});
test('F2: versão da própria empresa carrega vínculos e catálogo só com a empresa comprovada', async () => {
    const r = rotaEdicao({ tenant: empresaA, empresaFechamento: empresaA });
    const resposta = await r.get();
    assert.equal(resposta.status, 200);
    assert.deepEqual(r.lidos.slice(0, 1), ['fontesPreparacao']);
    assert(r.lidos.includes('pacotes:' + empresaA));
    const vinculos = r.consultas.filter(c => /FROM (clientes|aniversariantes|responsaveis_adicionais)/.test(c.texto));
    assert.equal(vinculos.length, 3);
    for (const c of vinculos) { assert.match(c.texto, /empresa_id=\$1::uuid/); assert.deepEqual(c.v, [empresaA]); }
    assert.deepEqual(r.locks(), []);
    const src = readFileSync('app/api/admin/contratos/versoes/[versaoId]/edicao/route.ts', 'utf8');
    assert(src.indexOf('versaoDoTenant(') < src.indexOf('fontesPreparacao(v.id'), 'comparação antes de carregar');
    assert.doesNotMatch(src, /empresaDoFechamento/);
});

// ---------------------------------------------------------------------------------------------
// Revisão comercial (condição comercial do fechamento por id) — repositório real, sem trava antes
// da autorização; trava e revalida depois.
// ---------------------------------------------------------------------------------------------
function comercial(empresaFechamento: string | null) {
    const b = banco({ tenant: empresaA, empresaFechamento });
    const escritas: string[] = [];
    const mod = carregar('lib/fechamentos/services/revisao-comercial.service.ts', {
        'lib/db/postgres.ts': { withTransaction: (fn: any) => fn(b.tx) },
        'lib/clientes/repositories/index.ts': { registrarAuditoria: async () => escritas.push('auditoria'), registrarEventoHistorico: async () => escritas.push('historico') },
        'lib/fechamentos/repositories/fechamento.repository.ts': {
            ...repositorioFechamentos(b), buscarFechamentoPorId: async () => { escritas.push('leu'); return {}; },
            buscarFechamentoPorIdParaAtualizacao: async (id: string) => { await b.tx.query('SELECT * FROM fechamentos WHERE id = $1::uuid LIMIT 1 FOR UPDATE', [id]); return { id }; },
            listarAprovacoesDoFechamento: async () => [],
            criarAprovacaoNegociacao: async () => escritas.push('aprovacao'), registrarDecisaoNoFechamento: async () => escritas.push('decisao'),
        },
    }) as any;
    const revisar = () => mod.revisarComercial('f1', empresaA, { solicitacaoId: uuid(3), decisao: 'RECUSAR', motivo: 'Motivo' }, { usuarioId: 'u', origem: 'CRM_INTERNO' }, b.tx);
    return { mod, revisar, ...b, escritas };
}
test('F3: revisão comercial de fechamento de outra empresa ou legado responde como inexistente, sem escrita e sem lock', async () => {
    for (const empresaFechamento of [empresaB, null]) {
        const c = comercial(empresaFechamento);
        await assert.rejects(c.mod.obterRevisaoComercial('f1', empresaA, c.tx), (e: any) => e.code === 'FECHAMENTO_NAO_ENCONTRADO' && e.httpStatus === 404);
        await assert.rejects(c.revisar(), (e: any) => e.code === 'FECHAMENTO_NAO_ENCONTRADO');
        assert.deepEqual(c.escritas, []); assert.deepEqual(c.locks(), []);
        assert.deepEqual(c.ordem, ['ler:fechamentos', 'ler:fechamentos']);
    }
    const rota = readFileSync('app/api/admin/fechamentos/[fechamentoId]/revisao/route.ts', 'utf8');
    assert.equal((rota.match(/withTenantTransaction\(sessao/g) ?? []).length, 2);
});
test('locks: revisão comercial A→A autoriza sem trava, depois trava e revalida a empresa da linha travada', async () => {
    const c = comercial(empresaA);
    await c.revisar().catch(() => undefined);
    assert.deepEqual(c.ordem.slice(0, 3), ['ler:fechamentos', 'lock:fechamentos', 'lock:fechamentos']);
    assert.doesNotMatch(c.sql[0].texto, LOCK);
    assert.match(c.sql[1].texto, /FOR UPDATE/); assert.match(c.sql[2].texto, /empresa_id::text[\s\S]*FOR SHARE/);
});

// ---------------------------------------------------------------------------------------------
// F6 — Festas escopadas pelo tenant (festa → contrato → fechamento.empresa_id)
// ---------------------------------------------------------------------------------------------
function festas(tenant: string) {
    const dados = [
        { id: 'festa-a', empresa: empresaA, cliente: 'cliente-a', snapshot: { evento: {} }, contrato_status: 'ASSINADO', invalidada_em: null, criado_em: '2026-09-01' },
        { id: 'festa-b', empresa: empresaB, cliente: 'cliente-b', snapshot: { evento: {} }, contrato_status: 'ASSINADO', invalidada_em: null, criado_em: '2026-09-02' },
    ];
    const consultas: { sql: string; v: unknown[] }[] = [];
    const tx = { query: async (sql: string, v: unknown[] = []) => {
        consultas.push({ sql, v });
        // 056: capacidade da membership comprovada (a do tenant do dublê).
        if (sql.startsWith('SELECT id FROM festa_membership_capacidades')) return { rows: v[0] === 'membership-' + tenant ? [{ id: 1 }] : [] };
        if (sql.includes('FROM festas f JOIN contratos co') && sql.includes('fe.empresa_id=$2::uuid')) {
            // Aplica os mesmos filtros da SQL: empresa ($2) e, quando houver, cliente ($1) ou id ($1).
            const lista = sql.includes('WHERE f.id=$1')
                ? dados.filter(d => d.id === v[0] && d.empresa === v[1])
                : dados.filter(d => d.empresa === v[1] && (v[0] === null || d.cliente === v[0]));
            return { rows: lista };
        }
        return { rows: [] };
    } };
    const mod = carregar('lib/festas/service.ts', {
        'lib/db/postgres.ts': { db: () => tx, withTransaction: (fn: any) => fn(tx) },
        'lib/festas/ambiente.ts': { validarAmbienteFesta: async () => undefined },
        'lib/autenticacao/service.ts': { consultarSessao: async () => ({ usuario_id: 'u1', papel: 'ADMINISTRATIVO' }) },
        'lib/saas/provar-tenant.ts': { provarTenant: async (_t: unknown, _s: unknown, pedida: unknown) => { consultas.push({ sql: 'provarTenant', v: [pedida] }); return { empresaComprovada: tenant, membershipId: 'membership-' + tenant, papelAtual: 'ADMINISTRATIVO' }; }, revalidarTenant: async () => { consultas.push({ sql: 'revalidarTenant', v: [] }); } },
        'lib/clientes/repositories/auditoria.repository.ts': { registrarAuditoria: async () => undefined },
        'lib/pagamentos/services/financeiro-consulta.service.ts': { consultarPainelFinanceiro: async () => null },
        'lib/contratos/services/cancelamento.service.ts': { cancelarContratacaoDaFesta: async () => undefined },
        'lib/festas/repository.ts': { formalizacaoElegivelSql: 'TRUE', contrato: async () => ({ id: 'c', snapshot: { evento: {} } }), filhos: async () => ({ solicitacoes: [] }), contagens: async () => ({}) },
    }) as any;
    const ctx = { token: 't', requestId: 'r', userAgent: null, empresaSolicitada: null };
    return { mod, consultas, ctx };
}
test('F6: festas por clienteId de outra empresa não aparecem; lista só da empresa comprovada', async () => {
    const f = festas(empresaA);
    assert.deepEqual((await f.mod.consultarFestas(f.ctx, undefined, 'cliente-b')).festas, []);
    assert.deepEqual((await f.mod.consultarFestas(f.ctx)).festas.map((x: any) => x.id), ['festa-a']);
    const listas = f.consultas.filter(c => c.sql.includes('FROM festas f JOIN contratos co') || c.sql.includes('FROM contratos c JOIN contrato_fluxos cf'));
    assert.equal(listas.length, 4);
    for (const c of listas) { assert.match(c.sql, /fe\.empresa_id=\$2::uuid/); assert.equal(c.v[1], empresaA); }
    const i = f.consultas.findIndex(c => c.sql === 'provarTenant');
    assert(i >= 0 && i < f.consultas.findIndex(c => c.sql.includes('FROM festas f')), 'tenant provado antes da consulta');
});
test('F6: detalhe de festa de outra empresa responde como inexistente, sem snapshot nem contrato', async () => {
    const f = festas(empresaA);
    await assert.rejects(f.mod.consultarFestas(f.ctx, 'festa-b'), (e: any) => e.status === 404 && /Festa não encontrada/.test(e.message));
    assert(!f.consultas.some(c => /contrato_versoes v ON v.id=cf.versao_vigente_id/.test(c.sql) && c.sql.includes('WHERE v.contrato_id')), 'não leu versões');
    const src = readFileSync('lib/festas/service.ts', 'utf8');
    const consulta = src.slice(src.indexOf('export async function consultarFestas'), src.indexOf('export async function consultarCapacidades'));
    assert.doesNotMatch(consulta, /SELECT \* FROM festas WHERE id=\$1'/);
    assert.match(consulta, /WHERE f\.id=\$1 AND fe\.empresa_id=\$2::uuid/);
    assert.match(readFileSync('app/api/admin/festas/route.ts', 'utf8'), /empresaSolicitada:request\.nextUrl\.searchParams\.get\('empresaId'\)/);
});
