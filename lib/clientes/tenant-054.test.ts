/* eslint-disable @typescript-eslint/no-explicit-any */
// PR-B1 (migration 054): testes sem banco. Cobrem SQL da 054, escopo de tenant em clientes,
// deduplicação, identidade comprovada separada do tenant, revisão fail-closed e rotas.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';

const req = createRequire(import.meta.url);
const empresaA = 'aaaaaaaa-0000-4000-8000-00000000000a';
const empresaB = 'bbbbbbbb-0000-4000-8000-00000000000b';
// Normaliza CRLF: checkouts com core.autocrlf=true (Windows) não podem mudar o resultado das regex.
const ler = (f: string) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n');

/** Carrega o TS real; módulos cujo caminho termina com uma chave de `mocks` são substituídos. */
function carregar(arquivo: string, mocks: Record<string, unknown>) {
    const cache = new Map<string, Record<string, unknown>>();
    const achar = (base: string) => [base, base + '.ts', base + '/index.ts'].find(p => existsSync(p) && statSync(p).isFile()) ?? base;
    function load(file: string): Record<string, unknown> {
        const abs = achar(resolve(file)).replaceAll('\\', '/');
        for (const [chave, valor] of Object.entries(mocks)) if (abs.endsWith(chave)) return valor as Record<string, unknown>;
        const hit = cache.get(abs); if (hit) return hit;
        const exports: Record<string, unknown> = {}; cache.set(abs, exports);
        const code = ts.transpileModule(ler(abs), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
        new Function('require', 'exports', code)((n: string) => n.startsWith('@/') ? load(n.slice(2)) : n.startsWith('.') ? load(resolve(dirname(abs), n)) : req(n), exports);
        return exports;
    }
    return load(arquivo);
}
function executor(respostas: (sql: string, v: unknown[]) => unknown[] = () => []) {
    const sql: { texto: string; valores: unknown[] }[] = [];
    return { sql, tx: { query: async (texto: string, valores: unknown[] = []) => { sql.push({ texto, valores }); const rows = respostas(texto, valores); return { rows, rowCount: rows.length }; } } };
}
function arquivos(dir: string): string[] {
    return readdirSync(dir).flatMap(n => { const p = join(dir, n); return statSync(p).isDirectory() ? (n === 'node_modules' ? [] : arquivos(p)) : /\.(ts|tsx)$/.test(n) ? [p] : []; });
}

// ---------------------------------------------------------------------------------------------
// Migration 054
// ---------------------------------------------------------------------------------------------
const migration = ler('database/migrations/20260928_054_empresa_id_clientes_fechamentos.sql');
const precheck = ler('database/checks/20260928_054_precheck.sql');
const postcheck = ler('database/checks/20260928_054_postcheck.sql');
const down = ler('database/rollback/20260928_054_empresa_id_clientes_fechamentos_down.sql');
const rollbackPrecheck = ler('database/checks/20260928_054_rollback_precheck.sql');
const semComentario = (s: string) => s.split('\n').map(l => l.replace(/--.*$/, '')).join('\n');

test('F1: backfill não usa min(uuid); prova de unicidade preservada e determinística', () => {
    for (const s of [migration, rollbackPrecheck, down]) assert.doesNotMatch(semComentario(s), /\bmin\s*\(/i);
    assert.match(migration, /HAVING count\(DISTINCT f\.empresa_id\) = 1/);
    assert.match(migration, /\(array_agg\(DISTINCT f\.empresa_id ORDER BY f\.empresa_id\)\)\[1\]/);
    // A ambiguidade continua detectada e aborta, antes e depois da trava.
    assert.match(migration, /HAVING count\(DISTINCT p\.empresa_id\) > 1/);
    assert.match(migration, /RAISE EXCEPTION '054: cliente com fechamentos em empresas distintas/);
    assert.match(precheck, /HAVING count\(DISTINCT p\.empresa_id\) > 1/);
});

test('054 valida dependências (036/038, 053, gatilhos de atualizado_em) antes de criar qualquer objeto', () => {
    const corpo = semComentario(migration);
    const dependencias = corpo.indexOf("'pacotes_empresa_imutavel_trg'");
    const primeiroObjeto = Math.min(...['ALTER TABLE', 'CREATE FUNCTION', 'CREATE TRIGGER', 'CREATE INDEX', 'UPDATE public.'].map(t => corpo.indexOf(t)).filter(i => i >= 0));
    assert(dependencias > 0 && dependencias < primeiroObjeto);
    for (const dep of ["'fechamentos_053_empresa_trg'", "'clientes_atualizado_em_trg'", "'fechamentos_atualizado_em_trg'", 'fechamento_pacote_snapshots_anterior_mesmo_fechamento_fk', 'kidmais\\_053\\_%']) {
        const i = corpo.indexOf(dep); assert(i > 0 && i < primeiroObjeto, dep);
    }
    for (const criterio of ["t.tgenabled = 'O'", 't.tgqual IS NULL', '(t.tgconstraint <> 0) = e.restricao', 't.tgdeferrable = e.restricao', 't.tginitdeferred = e.restricao', 't.tgfoid = to_regprocedure(e.funcao)', 't.tgtype = e.tipo', "n.nspname = 'public'"]) assert(corpo.includes(criterio), criterio);
});

test('054 preserva dado: só gatilhos de atualizado_em desligados no backfill, religados e conferidos por hash', () => {
    const c = semComentario(migration);
    const desliga = c.indexOf('DISABLE TRIGGER clientes_atualizado_em_trg'), religa = c.indexOf('ENABLE TRIGGER clientes_atualizado_em_trg');
    assert(desliga > 0 && religa > desliga);
    assert.equal((c.match(/DISABLE TRIGGER/g) ?? []).length, 2);
    assert.equal((c.match(/ENABLE TRIGGER/g) ?? []).length, 2);
    const update = c.indexOf('UPDATE public.fechamentos f');
    assert(update > desliga && update < religa);
    assert.match(c, /\(to_jsonb\(c\) - 'empresa_id'\)::text/);
    assert.match(c, /o backfill alterou coluna além de empresa_id/);
    assert.match(c, /contagem de clientes ou fechamentos mudou/);
    assert.doesNotMatch(c, /DELETE FROM|\bTRUNCATE\b|session_replication_role/i);
});

test('054 cria coerência empresa↔pacote, imutabilidade e coerência cliente↔fechamento em nova associação', () => {
    for (const t of ['clientes_054_empresa_imutavel_trg', 'fechamentos_054_empresa_imutavel_trg', 'fechamentos_054_empresa_coerente_trg', 'fechamentos_054_cliente_coerente_trg']) assert(migration.includes('CREATE TRIGGER ' + t), t);
    assert.match(migration, /BEFORE INSERT OR UPDATE OF cliente_id ON public\.fechamentos/);
    assert.match(migration, /IF TG_OP = 'UPDATE' AND NEW\.cliente_id IS NOT DISTINCT FROM OLD\.cliente_id/);
    assert.match(migration, /empresa_cliente IS NULL OR NEW\.empresa_id IS NULL OR empresa_cliente <> NEW\.empresa_id/);
    assert.match(migration, /ON UPDATE RESTRICT ON DELETE RESTRICT/);
    assert.doesNotMatch(semComentario(migration), /SECURITY DEFINER/);
    assert.equal((migration.match(/SET search_path = pg_catalog, pg_temp/g) ?? []).length, 5);
    // CPF continua global (PR-B2).
    assert.doesNotMatch(semComentario(migration), /clientes_cpf_canonico_uk/);
});

test('postcheck 054 confere colunas, FKs, gatilhos, funções, backfill e CPF global', () => {
    for (const trecho of ["a.atttypid = 'uuid'::regtype", 'NOT a.attnotnull', "k.confupdtype = 'r'", "k.confdeltype = 'r'", 'k.convalidated',
        'NOT k.condeferrable', "t.tgenabled = 'O'", 't.tgqual IS NULL', 't.tgconstraint = 0', 'NOT p.prosecdef',
        "p.proconfig @> ARRAY['search_path=pg_catalog, pg_temp']", 'clientes_cpf_canonico_uk', 'kidmais_054_falhar_se_incompativel()',
        "'fechamentos_054_cliente_coerente_trg'", "'pacotes_empresa_imutavel_trg'", "'fechamentos_053_empresa_trg'",
        "(to_jsonb(c) - 'empresa_id')::text", 'count(*) FROM public.fechamentos']) assert(postcheck.includes(trecho), trecho);
    // Critério do histórico: fechamento=pacote, grupo ambíguo, cliente que deveria ter recebido, vínculo, mesclado.
    for (const trecho of ['f.empresa_id IS DISTINCT FROM p.empresa_id', 'count(DISTINCT f.empresa_id) > 1', 'c.empresa_id IS DISTINCT FROM u.empresa_id', 'f.empresa_id <> c.empresa_id', 's.empresa_id <> p.empresa_id']) assert(migration.includes(trecho), trecho);
    for (const s of [precheck, postcheck, rollbackPrecheck]) assert.doesNotMatch(semComentario(s), /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/);
});

test('rollback 054: aborta se perderia empresa não reconstruível; remove só objetos da 054; nunca apaga linha', () => {
    const c = semComentario(down);
    const criterio = c.indexOf('remover a 054 perderia empresa não reconstruível'), primeiroDrop = c.indexOf('DROP ');
    assert(criterio > 0 && criterio < primeiroDrop);
    assert.doesNotMatch(c, /\bDELETE\b|\bTRUNCATE\b|\bUPDATE\b|\bINSERT\b/);
    for (const obj of ['fechamento_revisoes_054_cliente_coerente_trg', 'kidmais_054_revisao_cliente_coerente', 'fechamentos_054_cliente_coerente_trg', 'fechamentos_054_empresa_coerente_trg', 'fechamentos_054_empresa_imutavel_trg', 'clientes_054_empresa_imutavel_trg',
        'kidmais_054_falhar_se_incompativel', 'kidmais_054_fechamento_cliente_coerente', 'kidmais_054_fechamento_empresa_coerente', 'kidmais_054_empresa_imutavel',
        'fechamentos_054_empresa_idx', 'clientes_054_empresa_idx', 'fechamentos_054_empresa_fk', 'clientes_054_empresa_fk']) assert(c.includes(obj), obj);
    assert.equal((c.match(/DROP COLUMN IF EXISTS empresa_id/g) ?? []).length, 2);
    assert.doesNotMatch(c, /_053_|_036_|pacotes_empresa_imutavel_trg/);
    assert.match(down, /primeiro a aplicação volta/);
    assert.match(rollbackPrecheck, /c\.empresa_id IS DISTINCT FROM d\.empresa_id/);
});

// ---------------------------------------------------------------------------------------------
// Repositório de clientes: escopo na SQL, antes de ORDER BY/LIMIT
// ---------------------------------------------------------------------------------------------
function repositorio(respostas?: (sql: string, v: unknown[]) => unknown[]) {
    const e = executor(respostas);
    const mod = carregar('lib/clientes/repositories/cliente.repository.ts', { 'lib/db/postgres.ts': { db: () => e.tx } }) as any;
    return { ...e, mod };
}
test('CRM e deduplicação: toda busca filtra empresa_id na consulta, antes de ORDER BY e LIMIT', async () => {
    const r = repositorio();
    await r.mod.buscarClienteCanonicoPorCpf('52998224725', empresaA);
    await r.mod.buscarClientesPorContatoExato('11999999999', empresaA);
    await r.mod.buscarClientesPorNomeSemelhante('Cliente Sintético', empresaA, { limit: 5 });
    await r.mod.buscarClientesPorEmail('cliente@example', empresaA, { limit: 5 });
    await r.mod.buscarClientesPorEmailExato('cliente@example.invalid', empresaA);
    await r.mod.listarClientes(empresaA, { limit: 5 });
    assert.equal(r.sql.length, 6);
    for (const { texto, valores } of r.sql) {
        const m = texto.match(/empresa_id = \$(\d+)(::uuid)?/); assert(m, texto);
        assert.equal(valores[Number(m[1]) - 1], empresaA);
        const where = texto.indexOf('WHERE'), filtro = texto.indexOf(m[0]);
        assert(where >= 0 && filtro > where);
        for (const depois of ['ORDER BY', 'LIMIT']) { const i = texto.indexOf(depois); if (i >= 0) assert(filtro < i, depois); }
    }
});
test('busca global por CPF existe só para a identidade pública', () => {
    const usos = [...arquivos('lib'), ...arquivos('app')].filter(f => !f.endsWith('.test.ts') && ler(f).includes('buscarClienteCanonicoPorCpfParaIdentidade'))
        .map(f => f.replaceAll('\\', '/'));
    assert.deepEqual(usos.sort(), ['lib/clientes/repositories/cliente.repository.ts', 'lib/identidade/services/identity.service.ts']);
});
test('atualizarCliente: escopo TENANT filtra empresa; IDENTIDADE só vale para o próprio cliente comprovado', async () => {
    const r = repositorio();
    await r.mod.atualizarCliente('cliente-1', { tipo: 'TENANT', empresaId: empresaA }, { nomeCompleto: 'Novo Nome' });
    assert.match(r.sql[0].texto, /AND empresa_id = \$\d+::uuid/); assert(r.sql[0].valores.includes(empresaA));
    await r.mod.atualizarCliente('cliente-1', { tipo: 'IDENTIDADE', clienteIdComprovado: 'cliente-1' }, { nomeCompleto: 'Novo Nome' });
    assert.doesNotMatch(r.sql[1].texto, /AND empresa_id =/);
    await assert.rejects(r.mod.atualizarCliente('cliente-2', { tipo: 'IDENTIDADE', clienteIdComprovado: 'cliente-1' }, { nomeCompleto: 'X Y Z' }), /não pertence/);
    assert.equal(r.sql.length, 2);
});
test('possível duplicidade só entre clientes da mesma empresa comprovada (nunca A–B nem legado)', async () => {
    for (const [ok, esperado] of [[false, 'recusa'], [null, 'recusa'], [true, 'grava']] as const) {
        const e = executor(sql => sql.includes('bool_and') ? [{ ok }] : [{ id: 'd', cliente_a_id: 'a', cliente_b_id: 'b', motivos: ['X'], status: 'PENDENTE', criado_em: new Date() }]);
        const mod = carregar('lib/clientes/repositories/duplicidade.repository.ts', { 'lib/db/postgres.ts': { db: () => e.tx } }) as any;
        const chamada = mod.registrarPossivelDuplicidade({ clienteUmId: 'a', clienteDoisId: 'b', motivos: ['TELEFONE_IGUAL'] });
        if (esperado === 'recusa') { await assert.rejects(chamada, /mesma empresa/); assert(!e.sql.some(s => s.texto.includes('INSERT'))); }
        else { await chamada; assert(e.sql.some(s => s.texto.includes('INSERT'))); }
    }
});

// ---------------------------------------------------------------------------------------------
// Serviço de clientes
// ---------------------------------------------------------------------------------------------
class Falha extends Error {
    code: string; httpStatus: number; details?: unknown;
    constructor(code: string, message: string, httpStatus = 400, details?: unknown) { super(message); this.code = code; this.httpStatus = httpStatus; this.details = details; }
}
function servico(estado: { clientes: Record<string, any>; canonico?: Record<string, string>; violacaoCpf?: boolean; cpfExistente?: unknown }) {
    const chamadas: { fn: string; args: unknown[] }[] = [];
    const reg = (fn: string, retorno: (...a: any[]) => unknown) => async (...args: unknown[]) => { chamadas.push({ fn, args }); return retorno(...args); };
    const repos = {
        buscarClientePorId: reg('buscarClientePorId', (id: string) => estado.clientes[id] ?? null),
        buscarClienteCanonicoPorId: reg('buscarClienteCanonicoPorId', (id: string) => estado.clientes[estado.canonico?.[id] ?? id] ?? null),
        buscarClienteCanonicoPorCpf: reg('buscarClienteCanonicoPorCpf', () => estado.cpfExistente ?? null),
        buscarClientesPorContatoExato: reg('buscarClientesPorContatoExato', () => []),
        buscarClientesPorNomeSemelhante: reg('buscarClientesPorNomeSemelhante', () => []),
        buscarClientesPorEmail: reg('buscarClientesPorEmail', () => []),
        buscarClientesPorEmailExato: reg('buscarClientesPorEmailExato', () => []),
        listarClientes: reg('listarClientes', () => []),
        criarCliente: reg('criarCliente', (i: any) => { if (estado.violacaoCpf) { const e: any = Error('duplicate'); e.code = '23505'; e.constraint = 'clientes_cpf_canonico_uk'; throw e; } return { id: 'novo', ...i, status: 'ATIVO' }; }),
        atualizarCliente: reg('atualizarCliente', (id: string) => estado.clientes[id]),
        listarAniversariantesDoCliente: reg('listarAniversariantesDoCliente', () => []),
        listarResponsaveisDoCliente: reg('listarResponsaveisDoCliente', () => []),
        registrarAuditoria: reg('registrarAuditoria', () => undefined),
        registrarEventoHistorico: reg('registrarEventoHistorico', () => undefined),
        registrarPossivelDuplicidade: reg('registrarPossivelDuplicidade', () => undefined),
        INDICES_CPF_CANONICO: ['clientes_cpf_canonico_uk', 'clientes_cpf_empresa_canonico_uk'],
    };
    const e = executor();
    const mod = carregar('lib/clientes/services/cliente.service.ts', {
        'lib/db/postgres.ts': { withTransaction: (fn: any) => fn(e.tx), db: () => e.tx },
        'lib/clientes/repositories/index.ts': repos,
        'lib/clientes/services/errors.ts': { ClienteServiceError: Falha },
    }) as any;
    return { mod, chamadas, sql: e.sql, tx: e.tx };
}
const cliente = (id: string, empresaId: string | null, extra: object = {}) => ({ id, empresaId, status: 'ATIVO', nomeCompleto: 'Cliente Sintético', cpf: '52998224725', whatsapp: '11999999999', ...extra });
const dados = { nomeCompleto: 'Cliente Sintético', cpf: '52998224725', whatsapp: '11999999999', email: 'c@example.invalid' };

test('análise de cadastro, cadastro e busca do CRM passam o tenant a cada consulta', async () => {
    const s = servico({ clientes: {} });
    await s.mod.analisarCadastroCliente(dados, empresaA, {});
    await s.mod.buscarClientesCrm('52998224725', empresaA, 20, true);
    await s.mod.buscarClientesCrm('Cliente', empresaA, 20, true);
    const buscas = s.chamadas.filter(c => /^buscarClien(teCanonicoPorCpf|tesPor)/.test(c.fn));
    assert(buscas.length >= 6);
    for (const b of buscas) assert.equal(b.args[1], empresaA, b.fn);
    assert.doesNotMatch(ler('lib/clientes/services/cliente.service.ts'), /\.filter\(\(?c\)? => c\.empresaId === empresaId\)/);
});
test('cadastro: CPF de outra empresa (índice global) não revela dono e não consulta depois da violação', async () => {
    const s = servico({ clientes: {}, violacaoCpf: true });
    const erro: any = await s.mod.cadastrarClienteInterno({ ...dados, empresaId: empresaA }, { usuarioId: 'u', origem: 'CRM_INTERNO' }).catch((e: unknown) => e);
    assert.equal(erro.code, 'CPF_INDISPONIVEL'); assert.equal(erro.details, undefined);
    const depois = s.chamadas.slice(s.chamadas.findIndex(c => c.fn === 'criarCliente') + 1);
    assert.deepEqual(depois, []);
    assert.equal(s.chamadas.find(c => c.fn === 'criarCliente')!.args[0] && (s.chamadas.find(c => c.fn === 'criarCliente')!.args[0] as any).empresaId, empresaA);
});
test('cadastro administrativo exige empresa comprovada', async () => {
    const s = servico({ clientes: {} });
    for (const empresaId of [null, '', undefined]) await assert.rejects(s.mod.cadastrarClienteInterno({ ...dados, empresaId }, { usuarioId: 'u', origem: 'CRM_INTERNO' }), /não comprovada/);
    assert(!s.chamadas.some(c => c.fn === 'criarCliente'));
});
for (const [caso, empresaCliente] of [['de outra empresa', empresaB], ['legado sem empresa', null]] as const) {
    test(`A não lê nem edita cliente ${caso}`, async () => {
        const s = servico({ clientes: { c1: cliente('c1', empresaCliente) } });
        await assert.rejects(s.mod.obterClienteBase('c1', empresaA), (e: any) => e.code === 'CLIENTE_NAO_ENCONTRADO' && e.httpStatus === 404);
        await assert.rejects(s.mod.atualizarClienteInterno('c1', empresaA, { nomeCompleto: 'Outro Nome' }, { usuarioId: 'u', origem: 'CRM_INTERNO' }), (e: any) => e.code === 'CLIENTE_NAO_ENCONTRADO');
        assert(!s.chamadas.some(c => c.fn === 'atualizarCliente'));
        assert.match(s.sql[0].texto, /empresa_id=\$2::uuid FOR UPDATE/);
    });
}
test('edição administrativa exige tenant: empresa nula nunca é curinga', async () => {
    const s = servico({ clientes: { c1: cliente('c1', null) } });
    await assert.rejects(s.mod.atualizarClienteInterno('c1', null, { nomeCompleto: 'Outro Nome' }, { usuarioId: 'u', origem: 'CRM_INTERNO' }), /não comprovada/);
    assert.equal(s.sql.length, 0);
});
test('mesma empresa: leitura e edição administrativas funcionam com escopo TENANT', async () => {
    const s = servico({ clientes: { c1: cliente('c1', empresaA) } });
    assert.equal((await s.mod.obterClienteBase('c1', empresaA)).cliente.id, 'c1');
    await s.mod.atualizarClienteInterno('c1', empresaA, { nomeCompleto: 'Outro Nome' }, { usuarioId: 'u', origem: 'CRM_INTERNO' });
    assert.deepEqual(s.chamadas.find(c => c.fn === 'atualizarCliente')!.args[1], { tipo: 'TENANT', empresaId: empresaA });
});

// ---------------------------------------------------------------------------------------------
// Identidade comprovada ≠ Tenant Context
// ---------------------------------------------------------------------------------------------
test('sentinela IDENTIDADE_JA_COMPROVADA removida de todo o código', () => {
    const achados = [...arquivos('lib'), ...arquivos('app'), ...arquivos('components')].filter(f => !/tenant-054[^\\/]*\.test\.ts$/.test(f) && ler(f).includes('IDENTIDADE_JA_COMPROVADA'));
    assert.deepEqual(achados, []);
});
test('identidade: acesso só ao cliente canônico comprovado; prova antiga (mesclado) não abre outro cliente', async () => {
    const s = servico({ clientes: { c1: cliente('c1', empresaB), velho: cliente('velho', empresaB, { status: 'MESCLADO' }) }, canonico: { velho: 'c1' } });
    assert.equal((await s.mod.obterClienteBasePorIdentidade({ validacaoId: 'v', clienteId: 'c1' })).cliente.id, 'c1');
    await assert.rejects(s.mod.obterClienteBasePorIdentidade({ validacaoId: 'v', clienteId: 'velho' }), (e: any) => e.code === 'CLIENTE_NAO_ENCONTRADO');
    await assert.rejects(s.mod.obterClienteBasePorIdentidade({ validacaoId: '', clienteId: 'c1' }), (e: any) => e.code === 'CLIENTE_NAO_ENCONTRADO');
    // A prova não vira tenant: a leitura administrativa continua exigindo empresa comprovada.
    await assert.rejects(s.mod.obterClienteBase('c1', empresaA), (e: any) => e.code === 'CLIENTE_NAO_ENCONTRADO');
});
function rotaIdentidade(resolver: (token: string) => Promise<unknown>) {
    const lidos: unknown[] = [];
    const mod = carregar('app/api/identidade/contexto/route.ts', {
        'lib/clientes/services/index.ts': { obterClienteBasePorIdentidade: async (p: unknown) => { lidos.push(p); return { cliente: {}, aniversariantes: [], cadastro: {} }; } },
        'lib/identidade/delivery/index.ts': { enviarOtpComAmbiente: async () => undefined },
        'lib/identidade/services/index.ts': {
            criarIdentityServiceComAmbiente: () => ({ resolverClientePorProva: resolver }),
            isIdentityServiceError: (e: any) => typeof e?.code === 'string' && typeof e?.httpStatus === 'number',
        },
    }) as any;
    const post = (body: unknown) => mod.POST({ json: async () => body });
    return { post, lidos };
}
for (const [caso, codigo] of [['inválida', 'PROVA_INVALIDA_OU_EXPIRADA'], ['expirada', 'PROVA_INVALIDA_OU_EXPIRADA'], ['de outra finalidade', 'PROVA_FINALIDADE_INVALIDA']] as const) {
    test(`identidade: prova ${caso} recusa sem ler cliente`, async () => {
        const r = rotaIdentidade(async () => { throw Object.assign(Error('prova'), { code: codigo, httpStatus: 401 }); });
        const resposta = await r.post({ provaToken: 'p'.repeat(40) });
        assert.equal(resposta.status, 401); assert.deepEqual(r.lidos, []);
    });
}
test('identidade: corpo não escolhe cliente; só a prova resolvida define o id', async () => {
    const r = rotaIdentidade(async () => ({ validacaoId: 'v', clienteId: 'comprovado', expiraEm: 'x' }));
    assert.equal((await r.post({ provaToken: 'p'.repeat(40), clienteId: 'outro' })).status, 400);
    assert.deepEqual(r.lidos, []);
    assert.equal((await r.post({ provaToken: 'p'.repeat(40) })).status, 200);
    assert.deepEqual(r.lidos, [{ validacaoId: 'v', clienteId: 'comprovado', expiraEm: 'x' }]);
    assert.match(ler('lib/identidade/repositories/identidade.repository.ts'), /AND prova_expira_em > now\(\)/);
});

// ---------------------------------------------------------------------------------------------
// Aniversariantes (rota auxiliar) escopados pelo cliente pai
// ---------------------------------------------------------------------------------------------
for (const [caso, empresaCliente] of [['de outra empresa', empresaB], ['legado sem empresa', null]] as const) {
    test(`aniversariante: A não cria nem edita para cliente ${caso}`, async () => {
        const criados: unknown[] = [];
        const e = executor();
        const c = cliente('c1', empresaCliente);
        const mod = carregar('lib/clientes/services/aniversariante.service.ts', {
            'lib/db/postgres.ts': { withTransaction: (fn: any) => fn(e.tx) },
            'lib/clientes/repositories/index.ts': {
                buscarClientePorId: async () => c, buscarClienteCanonicoPorId: async () => c,
                criarAniversariante: async (i: unknown) => { criados.push(i); return i; }, atualizarAniversariante: async (i: unknown) => { criados.push(i); return i; },
                bloquearNomeAniversariante: async () => undefined, buscarAniversarianteAtivoPorNome: async () => null,
                buscarAniversariantePorId: async () => ({ id: 'a1', clienteId: 'c1', ativo: true }),
                registrarAuditoria: async () => undefined, registrarEventoHistorico: async () => undefined,
            },
            'lib/clientes/services/errors.ts': { ClienteServiceError: Falha },
        }) as any;
        const ctx = { usuarioId: 'u', origem: 'CRM_INTERNO' };
        await assert.rejects(mod.cadastrarAniversarianteInterno('c1', empresaA, { nome: 'Aniversariante' }, ctx), (x: any) => x.code === 'CLIENTE_NAO_ENCONTRADO');
        await assert.rejects(mod.editarAniversarianteInterno('c1', empresaA, 'a1', { nome: 'Aniversariante' }, ctx), (x: any) => x.code === 'CLIENTE_NAO_ENCONTRADO');
        await assert.rejects(mod.atualizarAniversarianteInterno('a1', 'c1', empresaA, { nome: 'Aniversariante', dataNascimento: null }, ctx, e.tx), (x: any) => x.code === 'CLIENTE_NAO_ENCONTRADO');
        assert.deepEqual(criados, []);
        assert(e.sql.every(s => !s.texto.startsWith('SELECT id FROM clientes') || /empresa_id=\$2::uuid/.test(s.texto)));
    });
}

// ---------------------------------------------------------------------------------------------
// Contratos/revisão: mutação cadastral só com tenant comprovado igual à empresa do fechamento
// ---------------------------------------------------------------------------------------------
function revisao(estado: { empresaFechamento: string | null; clienteVinculo?: any }) {
    const atualizados: unknown[][] = [];
    const e = executor();
    const r = { id: 'r1', estado: 'EM_ELABORACAO', contrato_versao_id: 'v1', fechamento_id: 'f1', revisao: 1, conteudo_hash: 'h',
        operacao: { clienteId: 'c1', aniversarianteId: 'a1', pacoteId: 'p1', valorTabela: 1 } };
    const mod = carregar('lib/fechamentos/services/revisao-operacional.service.ts', {
        'lib/db/postgres.ts': { db: () => e.tx },
        'lib/fechamentos/repositories/index.ts': { empresaDoFechamentoSemTrava: async () => estado.empresaFechamento, empresaDoFechamentoComTrava: async () => estado.empresaFechamento },
        'lib/fechamentos/repositories/revisao.repository.ts': { buscarRevisaoDaVersao: async () => r, listarItensRevisao: async () => [] },
        'lib/clientes/repositories/index.ts': {
            buscarClientePorId: async (id: string) => id === 'c1' ? cliente('c1', estado.empresaFechamento) : estado.clienteVinculo ?? null,
            buscarAniversariantePorId: async () => ({ id: 'a2', clienteId: 'c2', ativo: true }), buscarResponsavelPorId: async () => null,
            registrarAuditoria: async () => undefined,
        },
        'lib/clientes/services/index.ts': { atualizarClienteInterno: async (...a: unknown[]) => { atualizados.push(a); } },
        'lib/clientes/services/aniversariante.service.ts': { atualizarAniversarianteInterno: async (...a: unknown[]) => { atualizados.push(a); } },
        'lib/comercial/services/index.ts': { calcularResumoComercial: async () => { throw Error('PARADA_DO_TESTE'); } },
        'lib/comercial/condicao-pagamento.ts': {}, 'lib/comercial/composicao.ts': {}, 'lib/disponibilidade/services/index.ts': {},
        'lib/contratos/services/contrato.service.ts': {}, 'lib/contratos/services/snapshot-core.ts': { hashSnapshotContrato: () => 'hash' },
    }) as any;
    const editar = (input: object, empresaAutorizada?: string | null) =>
        mod.editarPreparacao(e.tx, r, { fonteHash: 'hash', ...input }, { usuarioId: 'u', empresaAutorizada });
    return { editar, atualizados };
}
const cadastro = { nomeCompleto: 'Cliente Sintético' };
test('revisão: alterar cadastro sem tenant comprovado falha fechado', async () => {
    const r = revisao({ empresaFechamento: empresaA });
    for (const input of [{ cliente: cadastro }, { aniversariante: { nome: 'Nome', dataNascimento: null } }, { vinculos: { clienteId: 'c2', aniversarianteId: 'a2' } }])
        await assert.rejects(r.editar(input, null), /empresa administrativa comprovada/);
    assert.deepEqual(r.atualizados, []);
});
test('revisão: tenant comprovado diferente da empresa do fechamento, ou fechamento legado, falha fechado', async () => {
    for (const empresaFechamento of [empresaB, null]) {
        const r = revisao({ empresaFechamento });
        await assert.rejects(r.editar({ cliente: cadastro }, empresaA), /empresa administrativa comprovada/);
        assert.deepEqual(r.atualizados, []);
    }
});
test('revisão: troca de vínculo para cliente de outra empresa ou legado é recusada', async () => {
    for (const empresaVinculo of [empresaB, null]) {
        const r = revisao({ empresaFechamento: empresaA, clienteVinculo: cliente('c2', empresaVinculo) });
        await assert.rejects(r.editar({ vinculos: { clienteId: 'c2', aniversarianteId: 'a2' } }, empresaA), /cliente canônico válido/);
    }
});
test('revisão: mesma empresa comprovada chega ao serviço de clientes com o tenant do chamador', async () => {
    const r = revisao({ empresaFechamento: empresaA });
    await assert.rejects(r.editar({ cliente: cadastro }, empresaA), /PARADA_DO_TESTE/);
    assert.equal(r.atualizados.length, 1); assert.equal(r.atualizados[0][1], empresaA);
});
test('contratos: empresa autorizada vem de provarTenant da sessão e é confrontada com o fechamento', () => {
    const s = ler('lib/contratos/services/administrativo.service.ts');
    assert.match(s, /const tenant = await provarTenant\(tx, s, empresaSolicitada\)/);
    assert.match(s, /if \(!contrato \|\| !empresaFechamento \|\| empresaFechamento !== tenant\.empresaComprovada\) conflito\('Versão não encontrada\.'\)/);
    assert.doesNotMatch(s, /tocaCadastro/);
    assert.match(s, /const \{ contrato: c, empresaAutorizada, tenant \} = await contratoDoTenant\(tx, s, versaoId, empresaSolicitada\)/);
    assert.doesNotMatch(s, /clienteAtual/);
    assert.doesNotMatch(ler('lib/fechamentos/services/revisao-operacional.service.ts'), /clienteAtual/);
});

// ---------------------------------------------------------------------------------------------
// Coerência cliente↔fechamento no serviço e no fluxo público
// ---------------------------------------------------------------------------------------------
test('fluxo público: prova de identidade não associa cliente de outra empresa nem legado; pacote sem empresa recusado', () => {
    const s = ler('lib/fechamentos/services/fechamento-publico.service.ts');
    const checagem = s.indexOf('canonico.empresaId === null || canonico.empresaId !== empresaDoPacote');
    assert(checagem > 0 && checagem < s.indexOf('await atualizarClienteConfirmado('));
    assert.match(s, /if \(!empresaDoPacote\)/);
    assert.match(s, /criarNovoCliente\(input\.cliente, input, empresaDoPacote, tx\)/);
    assert.match(s, /\{ tipo: "IDENTIDADE", clienteIdComprovado: cliente\.id \}/);
    assert.match(ler('lib/fechamentos/services/fechamento.service.ts'), /cliente\.empresaId === null \|\| cliente\.empresaId !== empresaDoPacote/);
});
test('rotas de cliente: Tenant Context comprovado e nenhuma empresa lida do corpo', () => {
    for (const f of ['app/api/admin/clientes/route.ts', 'app/api/admin/clientes/[id]/route.ts', 'app/api/admin/clientes/analisar-cadastro/route.ts',
        'app/api/admin/clientes/lixeira/route.ts', 'app/api/admin/clientes/[id]/lixeira/route.ts',
        'app/api/admin/clientes/[id]/aniversariantes/route.ts', 'app/api/admin/clientes/[id]/aniversariantes/[aniversarianteId]/route.ts',
        'app/api/admin/fechamentos/contratacoes/route.ts']) {
        const s = ler(f); assert.match(s, /withTenantTransaction\(sessao/, f); assert.match(s, /tenant\.empresaComprovada/, f);
        assert.doesNotMatch(s, /(body|bruto|parsed\.data|dados\.data)\.empresaId/, f);
    }
    const fechamento = ler('lib/fechamentos/services/fechamento-administrativo.service.ts');
    assert.match(fechamento, /executarNoTenant\(tx, sessao, contexto\.empresaSolicitada/);
    const edicao = ler('app/api/admin/contratos/versoes/[versaoId]/edicao/route.ts');
    assert.match(edicao, /WHERE empresa_id=\$1::uuid AND status<>'MESCLADO'/);
    assert.doesNotMatch(edicao, /FROM clientes WHERE status<>'MESCLADO'/);
});

// F3 na revisão operacional: a autorização não depende de campos cadastrais no payload.
const soData = { dataEvento: '2027-02-20' };
const soPacote = { pacoteId: '99999999-0000-4000-8000-000000000000' };
const soComercial = { comercial: { confirmarAprovacao: true, forma: 'PIX_AVISTA', baseNegociada: null, condicaoPix: null } };
for (const [caso, payload] of [['apenas data', soData], ['apenas pacote', soPacote], ['apenas condição comercial', soComercial]] as const) {
    test(`F3 revisão: ${caso} — tenant A em fechamento B, legado ou sem tenant é recusado antes de ler ou alterar`, async () => {
        for (const [empresaFechamento, autorizada] of [[empresaB, empresaA], [null, empresaA], [empresaA, null]] as const) {
            const r = revisao({ empresaFechamento });
            await assert.rejects(r.editar(payload, autorizada), /empresa administrativa comprovada/);
            assert.deepEqual(r.atualizados, []);
        }
    });
    test(`F3 revisão: ${caso} — mesma empresa comprovada segue para o cálculo`, async () => {
        const r = revisao({ empresaFechamento: empresaA });
        await assert.rejects(r.editar(payload, empresaA), /PARADA_DO_TESTE/);
    });
}

test('completar CPF ausente usa validação, deduplicação no tenant e auditoria; substituir CPF continua protegido', async () => {
  const vazio = servico({ clientes: { c1: cliente('c1', empresaA, { cpf: null }) } });
  await vazio.mod.atualizarClienteInterno('c1', empresaA, { cpf: '529.982.247-25' }, { usuarioId: 'u', origem: 'CRM_INTERNO' });
  assert(vazio.chamadas.some(c => c.fn === 'atualizarCliente'));
  assert(vazio.chamadas.some(c => c.fn === 'registrarAuditoria'));
  const existente = servico({ clientes: { c1: cliente('c1', empresaA) } });
  await assert.rejects(existente.mod.atualizarClienteInterno('c1', empresaA, { cpf: '11144477735' }, { usuarioId: 'u', origem: 'CRM_INTERNO' }), (e: any) => e.code === 'ALTERACAO_CPF_REQUER_PERMISSAO');
  assert(!existente.chamadas.some(c => c.fn === 'atualizarCliente'));
  const duplicado = servico({ clientes: { c1: cliente('c1', empresaA, { cpf: null }) }, cpfExistente: cliente('c2', empresaA) });
  await assert.rejects(duplicado.mod.atualizarClienteInterno('c1', empresaA, { cpf: '52998224725' }, { usuarioId: 'u', origem: 'CRM_INTERNO' }), (e: any) => e.code === 'CPF_EXISTENTE');
  assert(!duplicado.chamadas.some(c => c.fn === 'atualizarCliente'));
});
