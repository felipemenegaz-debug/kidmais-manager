/* eslint-disable @typescript-eslint/no-explicit-any */
// PR-B1 (migration 054), rodada F1–F8 da revisão independente. Sem banco: estrutura da SQL,
// modelos que espelham os predicados SQL termo a termo, e fluxos reais sobre SQL simulada.
// A prova no catálogo real do PostgreSQL é do ciclo descartável (ainda não executado).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import ts from 'typescript';

const req = createRequire(import.meta.url);
const empresaA = 'aaaaaaaa-0000-4000-8000-00000000000a';
const empresaB = 'bbbbbbbb-0000-4000-8000-00000000000b';
const ler = (f: string) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
const semComentario = (s: string) => s.split('\n').map(l => l.replace(/--.*$/, '')).join('\n');
const migration = ler('database/migrations/20260928_054_empresa_id_clientes_fechamentos.sql');
const precheck = ler('database/checks/20260928_054_precheck.sql');
const postcheck = ler('database/checks/20260928_054_postcheck.sql');
const down = ler('database/rollback/20260928_054_empresa_id_clientes_fechamentos_down.sql');

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
// F1 — nenhum ALTER TABLE/ENABLE com evento diferido pendente; só timestamp desligado.
// ---------------------------------------------------------------------------------------------
test('F1: backfill processa os eventos diferidos (SET CONSTRAINTS ALL IMMEDIATE) antes de qualquer DDL', () => {
    const c = semComentario(migration);
    const pos = (t: string) => { const i = c.indexOf(t); assert(i >= 0, t); return i; };
    const addColuna = pos('ALTER TABLE public.fechamentos\n  ADD COLUMN empresa_id');
    const desliga = pos('ALTER TABLE public.fechamentos DISABLE TRIGGER fechamentos_atualizado_em_trg');
    const updFech = pos('UPDATE public.fechamentos f');
    const imediato = pos('SET CONSTRAINTS ALL IMMEDIATE;');
    const updCli = pos('UPDATE public.clientes c');
    const religa = pos('ALTER TABLE public.fechamentos ENABLE TRIGGER fechamentos_atualizado_em_trg');
    assert(addColuna < desliga && desliga < updFech && updFech < imediato && imediato < updCli && updCli < religa);
    assert.equal(c.indexOf('UPDATE public.'), updFech, 'o primeiro DML é o UPDATE de fechamentos');
    assert.doesNotMatch(c.slice(updFech, imediato), /\b(ALTER|CREATE|DROP)\b/, 'nenhum DDL com a fila diferida pendente');
    for (const m of c.slice(updFech).matchAll(/\b(ALTER TABLE|CREATE TRIGGER|CREATE INDEX)\b/g)) assert(updFech + m.index! > imediato, 'DDL antes de processar a fila');
    assert.equal((c.match(/SET CONSTRAINTS/g) ?? []).length, 1);
});
test('F1: só os gatilhos de timestamp são desligados; transação única; erro não deixa gatilho desligado', () => {
    const c = semComentario(migration);
    assert.deepEqual([...c.matchAll(/DISABLE TRIGGER (\w+)/g)].map(m => m[1]).sort(), ['clientes_atualizado_em_trg', 'fechamentos_atualizado_em_trg']);
    assert.deepEqual([...c.matchAll(/ENABLE TRIGGER (\w+)/g)].map(m => m[1]).sort(), ['clientes_atualizado_em_trg', 'fechamentos_atualizado_em_trg']);
    assert.doesNotMatch(c, /DISABLE TRIGGER (ALL|USER)|session_replication_role|ENABLE REPLICA|ENABLE ALWAYS/i);
    // DISABLE/ENABLE TRIGGER são DDL transacional: qualquer erro desfaz tudo, inclusive o DISABLE.
    assert(c.trim().startsWith('BEGIN;') && c.trim().endsWith('COMMIT;'));
    assert.equal((c.match(/\bBEGIN;/g) ?? []).length, 1); assert.equal((c.match(/\bCOMMIT;/g) ?? []).length, 1);
    assert.doesNotMatch(c, /SAVEPOINT|ROLLBACK/i);
    assert.match(c, /gatilho de atualizado_em não voltou/);
});
const guardasHistoricas = ['fr_fechamento_proteger_trg', 'fr_confirmacao_agenda_trg', 'festa019_fechamento', 'festa019_lock_fechamento'];
test('Guardas históricas: aparecem só como dependência exigida; a 054 nunca as desliga, recria, altera ou remove', () => {
    for (const [nome, sql] of [['up', migration], ['precheck', precheck], ['postcheck', postcheck], ['down', down]] as const) {
        const c = semComentario(sql);
        const i = c.indexOf('SELECT string_agg(e.gatilho'), f = c.indexOf('IF divergentes IS NOT NULL');
        const fora = i >= 0 && f > i ? c.slice(0, i) + c.slice(f) : c;
        for (const g of guardasHistoricas) {
            assert(!fora.includes(g), `${nome}: ${g} fora do bloco de dependências`);
            assert.doesNotMatch(c, new RegExp(`(DISABLE|ENABLE|CREATE|DROP|ALTER)[^;]*\\b${g}\\b`), `${nome}: ${g} tocada`);
        }
        if (nome !== 'down') for (const g of guardasHistoricas) assert(blocoDep(sql).includes(`('${g}', 'fechamentos'`), `${nome}: ${g} exigida`);
    }
    assert.doesNotMatch(semComentario(migration), /CREATE (OR REPLACE )?FUNCTION public\.(kidmais_proteger_fechamento_em_revisao|kidmais_validar_agenda_revisao|kidmais019_validar_contrato|kidmais019_lock_ocupacao)\b/);
});
test('Guardas históricas: configuração exigida é a das migrations 014/019 (lida da origem, não do nome)', () => {
    const m014 = ler('database/migrations/20260909_014_revisao_operacional.sql');
    const m019 = ler('database/migrations/20260915_019_festa_formalizacao.sql');
    const origem: Record<string, [string, RegExp]> = {
        fr_fechamento_proteger_trg: [m014, /CREATE CONSTRAINT TRIGGER fr_fechamento_proteger_trg AFTER UPDATE ON fechamentos DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kidmais_proteger_fechamento_em_revisao\(\);/],
        fr_confirmacao_agenda_trg: [m014, /CREATE CONSTRAINT TRIGGER fr_confirmacao_agenda_trg AFTER INSERT OR UPDATE ON fechamentos DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION kidmais_validar_agenda_revisao\(\);/],
        festa019_fechamento: [m019, /CREATE CONSTRAINT TRIGGER festa019_fechamento AFTER INSERT OR UPDATE ON public\.fechamentos DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public\.kidmais019_validar_contrato\(\);/],
        festa019_lock_fechamento: [m019, /CREATE TRIGGER festa019_lock_fechamento BEFORE INSERT OR UPDATE ON public\.fechamentos FOR EACH ROW EXECUTE FUNCTION public\.kidmais019_lock_ocupacao\(\);/],
    };
    // AFTER UPDATE ROW = 1+16; AFTER INSERT OR UPDATE ROW = 1+4+16; BEFORE INSERT OR UPDATE ROW = 1+2+4+16.
    const esperado: Record<string, [string, number, boolean]> = {
        fr_fechamento_proteger_trg: ['public.kidmais_proteger_fechamento_em_revisao()', 17, true],
        fr_confirmacao_agenda_trg: ['public.kidmais_validar_agenda_revisao()', 21, true],
        festa019_fechamento: ['public.kidmais019_validar_contrato()', 21, true],
        festa019_lock_fechamento: ['public.kidmais019_lock_ocupacao()', 23, false],
    };
    const deps = dependencias(migration);
    for (const g of guardasHistoricas) {
        assert.match(origem[g][0], origem[g][1], g);
        const d = deps.find(x => x.gatilho === g)!;
        assert.deepEqual([d.tabela, d.funcao, d.tipo, d.restricao, d.colunas], ['fechamentos', ...esperado[g], []], g);
    }
    // Sem WHEN nem colunas na origem; nenhuma migration posterior recria ou desliga essas guardas.
    for (const f of ['20260909_014_revisao_operacional.sql', '20260915_019_festa_formalizacao.sql']) assert.doesNotMatch(ler('database/migrations/' + f), /(fr_fechamento_proteger_trg|fr_confirmacao_agenda_trg|festa019_fechamento|festa019_lock_fechamento)\b[^;]*\bWHEN\b/);
    const migrations = readdirSync('database/migrations').filter(f => f > '20260915_019_festa_formalizacao.sql' && !f.includes('_054_'));
    for (const f of migrations) for (const g of guardasHistoricas) assert.doesNotMatch(ler('database/migrations/' + f), new RegExp(`\\b${g}\\b`), `${f}: ${g}`);
});

// ---------------------------------------------------------------------------------------------
// F4 — cliente da revisão preparada.
// ---------------------------------------------------------------------------------------------
test('F4: gatilho na revisão exige cliente e fechamento pai da mesma empresa comprovada', () => {
    const c = semComentario(migration);
    assert.match(c, /CREATE TRIGGER fechamento_revisoes_054_cliente_coerente_trg\nBEFORE INSERT OR UPDATE OF cliente_id, fechamento_id ON public\.fechamento_revisoes/);
    const corpo = c.slice(c.indexOf('CREATE FUNCTION public.kidmais_054_revisao_cliente_coerente()'), c.indexOf('CREATE TRIGGER fechamento_revisoes_054_cliente_coerente_trg'));
    assert.match(corpo, /empresa_cliente IS NULL OR empresa_fechamento IS NULL OR empresa_cliente <> empresa_fechamento/);
    assert.match(corpo, /NEW\.cliente_id IS NOT DISTINCT FROM OLD\.cliente_id\s+AND NEW\.fechamento_id IS NOT DISTINCT FROM OLD\.fechamento_id/);
    assert.match(corpo, /SELECT empresa_id INTO empresa_fechamento FROM public\.fechamentos WHERE id = NEW\.fechamento_id/);
    assert.match(c, /FROM public\.fechamento_revisoes r\s+JOIN public\.fechamentos f ON f\.id = r\.fechamento_id\s+JOIN public\.clientes c ON c\.id = r\.cliente_id/);
    assert.match(postcheck, /'fechamento_revisoes_054_cliente_coerente_trg', 'fechamento_revisoes', 'public\.kidmais_054_revisao_cliente_coerente\(\)', 23, ARRAY\['cliente_id', 'fechamento_id'\]/);
    assert.match(down, /DROP TRIGGER IF EXISTS fechamento_revisoes_054_cliente_coerente_trg ON public\.fechamento_revisoes/);
    assert.match(down, /DROP FUNCTION IF EXISTS public\.kidmais_054_revisao_cliente_coerente\(\)/);
});
/** Espelha a regra do gatilho de revisão (empresa do cliente × empresa do fechamento pai). */
function revisaoPermitida(op: 'INSERT' | 'UPDATE', novo: { cliente: string | null; fechamento: string | null; ids?: string }, antigo?: { ids?: string }) {
    if (op === 'UPDATE' && antigo && antigo.ids === novo.ids) return true;
    return novo.cliente !== null && novo.fechamento !== null && novo.cliente === novo.fechamento;
}
test('F4: A/A permitido; A/B e B/A recusados; NULL nunca autoriza; troca revalida; legado sem troca não é revalidado', () => {
    assert.equal(revisaoPermitida('INSERT', { cliente: empresaA, fechamento: empresaA }), true);
    assert.equal(revisaoPermitida('INSERT', { cliente: empresaA, fechamento: empresaB }), false);
    assert.equal(revisaoPermitida('INSERT', { cliente: empresaB, fechamento: empresaA }), false);
    assert.equal(revisaoPermitida('INSERT', { cliente: null, fechamento: empresaA }), false);
    assert.equal(revisaoPermitida('INSERT', { cliente: null, fechamento: null }), false);
    assert.equal(revisaoPermitida('UPDATE', { cliente: empresaB, fechamento: empresaA, ids: 'c2/f1' }, { ids: 'c1/f1' }), false);
    assert.equal(revisaoPermitida('UPDATE', { cliente: null, fechamento: null, ids: 'c1/f1' }, { ids: 'c1/f1' }), true);
});

// ---------------------------------------------------------------------------------------------
// F5 — dependências completas, mesmo bloco nas três fontes, negativos pelo predicado espelhado.
// ---------------------------------------------------------------------------------------------
const blocoDep = (s: string) => { const i = s.indexOf('-- kidmais-054-dependencias:inicio'), f = s.indexOf('-- kidmais-054-dependencias:fim'); assert(i >= 0 && f > i); return s.slice(i, f); };
type Dep = { gatilho: string; tabela: string; funcao: string; tipo: number; colunas: string[]; restricao: boolean };
function dependencias(sql: string): Dep[] {
    return [...blocoDep(sql).matchAll(/\('(\w+)', '(\w+)', '([\w.()]+)', (\d+), ARRAY\[([^\]]*)\](?:::text\[\])?, (true|false)\)/g)].map(m => ({
        gatilho: m[1], tabela: m[2], funcao: m[3], tipo: Number(m[4]), restricao: m[6] === 'true',
        colunas: m[5].split(',').map(x => x.trim().replace(/'/g, '')).filter(Boolean),
    }));
}
type Gatilho = { nome: string; tabela: string; esquema: string; interno: boolean; funcao: string; tipo: number; enabled: string; when: string | null;
    restricao: boolean; deferrable: boolean; initdeferred: boolean; colunas: string[] };
/** Espelha o WHERE NOT EXISTS do bloco de dependências, termo a termo. */
function divergentes(esperados: Dep[], catalogo: Gatilho[]) {
    return esperados.filter(e => !catalogo.some(t => !t.interno && t.nome === e.gatilho && t.tabela === e.tabela && t.esquema === 'public'
        && t.funcao === e.funcao && t.tipo === e.tipo && t.enabled === 'O' && t.when === null
        && t.restricao === e.restricao && t.deferrable === e.restricao && t.initdeferred === e.restricao
        && JSON.stringify([...t.colunas].sort()) === JSON.stringify(e.colunas))).map(e => e.gatilho);
}
const integro = (deps: Dep[]): Gatilho[] => deps.map(d => ({ nome: d.gatilho, tabela: d.tabela, esquema: 'public', interno: false, funcao: d.funcao, tipo: d.tipo,
    enabled: 'O', when: null, restricao: d.restricao, deferrable: d.restricao, initdeferred: d.restricao, colunas: [...d.colunas] }));

test('F5: bloco de dependências idêntico em up, precheck e postcheck, antes de qualquer objeto no up', () => {
    const bloco = blocoDep(migration);
    assert.equal(blocoDep(precheck), bloco); assert.equal(blocoDep(postcheck), bloco);
    const c = semComentario(migration);
    const fimBloco = c.indexOf("RAISE EXCEPTION '054: instalação da 053 incompleta");
    const primeiroObjeto = Math.min(...['ALTER TABLE', 'CREATE FUNCTION', 'CREATE TRIGGER', 'CREATE INDEX', 'CREATE TEMP', 'UPDATE public.', 'LOCK TABLE'].map(t => c.indexOf(t)).filter(i => i >= 0));
    assert(fimBloco > 0 && fimBloco < primeiroObjeto);
    for (const termo of ["t.tgenabled = 'O'", 't.tgqual IS NULL', '(t.tgconstraint <> 0) = e.restricao', 't.tgdeferrable = e.restricao', 't.tginitdeferred = e.restricao',
        't.tgfoid = to_regprocedure(e.funcao)', 't.tgtype = e.tipo', "n.nspname = 'public'", 'NOT t.tgisinternal', 'ORDER BY a.attname) = e.colunas']) assert(bloco.includes(termo), termo);
});
test('F5: exige 036/038 e a 053 inteira (gatilhos, diferimento, FK da fotografia, funções) pelo critério da própria 053', () => {
    const deps = dependencias(migration);
    assert.deepEqual(deps.map(d => d.gatilho).sort(), ['adicionais_empresa_imutavel_trg', 'clientes_atualizado_em_trg', 'fechamento_adicionais_053_empresa_trg',
        'fechamento_pacote_composicao_053_empresa_trg', 'fechamento_pacote_snapshots_053_empresa_trg', 'fechamento_revisao_adicionais_053_empresa_trg',
        'fechamento_revisoes_053_empresa_trg', 'fechamento_revisoes_053_filhos_trg', 'fechamentos_053_empresa_trg', 'fechamentos_053_filhos_trg',
        'fechamentos_atualizado_em_trg', 'festa019_fechamento', 'festa019_lock_fechamento', 'fr_confirmacao_agenda_trg', 'fr_fechamento_proteger_trg',
        'pacotes_empresa_imutavel_trg', 'regras_desconto_pacote_053_utilizada_trg', 'tabelas_preco_empresa_imutavel_trg']);
    assert.deepEqual(deps.filter(d => d.restricao).map(d => d.gatilho).sort(), ['fechamento_revisoes_053_filhos_trg', 'fechamentos_053_filhos_trg',
        'festa019_fechamento', 'fr_confirmacao_agenda_trg', 'fr_fechamento_proteger_trg']);
    const post053 = ler('database/checks/20260928_053_postcheck.sql');
    for (const d of deps.filter(x => x.gatilho.includes('_053_') || x.funcao.includes('_036_'))) {
        const cols = d.colunas.length ? `ARRAY[${d.colunas.map(x => `'${x}'`).join(', ')}]` : 'ARRAY[]::text[]';
        assert(post053.replace(/\s+/g, ' ').includes(`('${d.gatilho}', '${d.tabela}', '${d.funcao}', ${d.tipo}, ${cols}, ${d.restricao})`), d.gatilho);
    }
    const bloco = blocoDep(migration);
    assert.match(bloco, /fechamento_pacote_snapshots_anterior_mesmo_fechamento_fk/);
    assert.match(bloco, /p\.proname LIKE 'kidmais\\_053\\_%'[\s\S]*<> 15 THEN/);
});
test('F5: negativos — ausente, desabilitada, réplica, função errada, eventos errados, WHEN, diferimento, colunas, schema, interno', () => {
    const deps = dependencias(migration);
    assert.deepEqual(divergentes(deps, integro(deps)), []);
    const casos: [string, (g: Gatilho[]) => Gatilho[], string][] = [
        ['ausente', g => g.filter(x => x.nome !== 'pacotes_empresa_imutavel_trg'), 'pacotes_empresa_imutavel_trg'],
        ['desabilitada', g => g.map(x => x.nome === 'fechamentos_053_empresa_trg' ? { ...x, enabled: 'D' } : x), 'fechamentos_053_empresa_trg'],
        ['só réplica', g => g.map(x => x.nome === 'fechamentos_053_empresa_trg' ? { ...x, enabled: 'R' } : x), 'fechamentos_053_empresa_trg'],
        ['função errada', g => g.map(x => x.nome === 'adicionais_empresa_imutavel_trg' ? { ...x, funcao: 'public.outra()' } : x), 'adicionais_empresa_imutavel_trg'],
        ['eventos errados', g => g.map(x => x.nome === 'fechamento_adicionais_053_empresa_trg' ? { ...x, tipo: 19 } : x), 'fechamento_adicionais_053_empresa_trg'],
        ['WHEN indevido', g => g.map(x => x.nome === 'regras_desconto_pacote_053_utilizada_trg' ? { ...x, when: '(NEW.ativo)' } : x), 'regras_desconto_pacote_053_utilizada_trg'],
        ['diferimento removido', g => g.map(x => x.nome === 'fechamentos_053_filhos_trg' ? { ...x, initdeferred: false } : x), 'fechamentos_053_filhos_trg'],
        ['vira gatilho comum', g => g.map(x => x.nome === 'fechamento_revisoes_053_filhos_trg' ? { ...x, restricao: false, deferrable: false, initdeferred: false } : x), 'fechamento_revisoes_053_filhos_trg'],
        ['comum vira diferido', g => g.map(x => x.nome === 'fechamentos_053_empresa_trg' ? { ...x, restricao: true, deferrable: true, initdeferred: true } : x), 'fechamentos_053_empresa_trg'],
        ['colunas trocadas', g => g.map(x => x.nome === 'fechamentos_053_empresa_trg' ? { ...x, colunas: ['pacote_id'] } : x), 'fechamentos_053_empresa_trg'],
        ['outro schema', g => g.map(x => x.nome === 'clientes_atualizado_em_trg' ? { ...x, esquema: 'outro' } : x), 'clientes_atualizado_em_trg'],
        ['interno', g => g.map(x => x.nome === 'tabelas_preco_empresa_imutavel_trg' ? { ...x, interno: true } : x), 'tabelas_preco_empresa_imutavel_trg'],
    ];
    for (const [caso, degradar, esperado] of casos) assert.deepEqual(divergentes(deps, degradar(integro(deps))), [esperado], caso);
    for (const s of [migration, precheck, postcheck]) assert.match(s, /IF divergentes IS NOT NULL THEN\s+RAISE EXCEPTION '054: dependência ausente ou degradada/);
});
test('Guardas históricas: negativos — ausente, desabilitada, função errada, evento, diferimento, WHEN, colunas', () => {
    const deps = dependencias(migration);
    const muda = (nome: string, delta: Partial<Gatilho>) => (g: Gatilho[]) => g.map(x => x.nome === nome ? { ...x, ...delta } : x);
    const casos: [string, (g: Gatilho[]) => Gatilho[], string][] = [
        ['ausente 014', g => g.filter(x => x.nome !== 'fr_fechamento_proteger_trg'), 'fr_fechamento_proteger_trg'],
        ['ausente 019', g => g.filter(x => x.nome !== 'festa019_lock_fechamento'), 'festa019_lock_fechamento'],
        ['desabilitada', muda('fr_confirmacao_agenda_trg', { enabled: 'D' }), 'fr_confirmacao_agenda_trg'],
        ['só réplica', muda('festa019_fechamento', { enabled: 'R' }), 'festa019_fechamento'],
        ['desabilitada (lock)', muda('festa019_lock_fechamento', { enabled: 'D' }), 'festa019_lock_fechamento'],
        ['função errada', muda('festa019_fechamento', { funcao: 'public.kidmais_validar_agenda_revisao()' }), 'festa019_fechamento'],
        ['função errada (lock)', muda('festa019_lock_fechamento', { funcao: 'public.kidmais_set_atualizado_em()' }), 'festa019_lock_fechamento'],
        ['perde INSERT', muda('fr_confirmacao_agenda_trg', { tipo: 17 }), 'fr_confirmacao_agenda_trg'],
        ['perde UPDATE', muda('fr_fechamento_proteger_trg', { tipo: 5 }), 'fr_fechamento_proteger_trg'],
        ['vira BEFORE', muda('festa019_fechamento', { tipo: 23 }), 'festa019_fechamento'],
        ['vira por instrução', muda('festa019_lock_fechamento', { tipo: 22 }), 'festa019_lock_fechamento'],
        ['não diferida', muda('fr_fechamento_proteger_trg', { initdeferred: false }), 'fr_fechamento_proteger_trg'],
        ['não adiável', muda('festa019_fechamento', { deferrable: false, initdeferred: false }), 'festa019_fechamento'],
        ['vira gatilho comum', muda('fr_confirmacao_agenda_trg', { restricao: false, deferrable: false, initdeferred: false }), 'fr_confirmacao_agenda_trg'],
        ['lock vira diferido', muda('festa019_lock_fechamento', { restricao: true, deferrable: true, initdeferred: true }), 'festa019_lock_fechamento'],
        ['WHEN indevido', muda('fr_fechamento_proteger_trg', { when: '(OLD.status IS DISTINCT FROM NEW.status)' }), 'fr_fechamento_proteger_trg'],
        ['WHEN indevido (lock)', muda('festa019_lock_fechamento', { when: '(false)' }), 'festa019_lock_fechamento'],
        ['restrita a colunas', muda('festa019_fechamento', { colunas: ['status'] }), 'festa019_fechamento'],
        ['outra tabela', muda('fr_fechamento_proteger_trg', { tabela: 'fechamento_adicionais' }), 'fr_fechamento_proteger_trg'],
    ];
    for (const [caso, degradar, esperado] of casos) assert.deepEqual(divergentes(deps, degradar(integro(deps))), [esperado], caso);
});

// ---------------------------------------------------------------------------------------------
// F7 — prova negativa do backfill imediato.
// ---------------------------------------------------------------------------------------------
test('F7: backfill imediato comparado linha a linha com o esperado, inclusive o NULL', () => {
    const c = semComentario(migration);
    assert.match(c, /CREATE TEMP TABLE kidmais_054_esperado ON COMMIT DROP AS/);
    assert(c.indexOf('CREATE TEMP TABLE kidmais_054_esperado') < c.indexOf('ADD COLUMN empresa_id'), 'esperado calculado antes do backfill');
    assert.match(c.slice(c.indexOf('CREATE TEMP TABLE kidmais_054_esperado'), c.indexOf('ADD COLUMN empresa_id')), /JOIN public\.pacotes p ON p\.id = f\.pacote_id/);
    for (const t of ['c.empresa_id IS DISTINCT FROM e.empresa_esperada', 'e.empresas_comprovadas = 0 AND c.empresa_id IS NOT NULL',
        'e.empresas_comprovadas = 1 AND c.empresa_id IS NULL', 'e.empresas_comprovadas > 1', 'e.cliente_id IS NULL', 'resultado esperado não cobre todos os clientes'])
        assert(c.includes(t), t);
    const check = ler('database/checks/20260928_054_backfill_imediato.sql');
    assert.match(check, /e\.empresas = 0 AND c\.empresa_id IS NOT NULL/);
    assert.match(check, /e\.empresas = 1 AND c\.empresa_id IS DISTINCT FROM e\.empresa_esperada/);
    assert.match(check, /FILTER \(WHERE e\.empresas > 1\)/);
    assert.match(check, /antes de a\n-- aplicação gravar qualquer cliente novo/);
    assert.doesNotMatch(semComentario(check), /\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/);
    assert.match(postcheck, /20260928_054_backfill_imediato\.sql/);
});
type Cli = { id: string; status: string; principal: string | null };
/** Espelha a derivação SQL: grupo canônico, count(DISTINCT), primeiro do array ordenado. */
function derivar(clientes: Cli[], fechamentos: { cliente: string; empresaPacote: string | null }[]) {
    const canonico = (c: Cli) => c.status === 'MESCLADO' ? c.principal! : c.id;
    const porGrupo = new Map<string, Set<string>>();
    for (const f of fechamentos) {
        if (f.empresaPacote === null) continue;
        const g = canonico(clientes.find(x => x.id === f.cliente)!);
        porGrupo.set(g, (porGrupo.get(g) ?? new Set()).add(f.empresaPacote));
    }
    const ambiguos = [...porGrupo.entries()].filter(([, s]) => s.size > 1).map(([g]) => g);
    if (ambiguos.length) throw Error('054: cliente com fechamentos em empresas distintas: ' + ambiguos.join(', '));
    return Object.fromEntries(clientes.map(c => { const s = porGrupo.get(canonico(c)); return [c.id, s ? [...s].sort()[0] : null]; }));
}
test('F7: 0 empresas → NULL; 1 → empresa (inclusive grupo mesclado); pacote legado → NULL; 2+ → aborta', () => {
    const clientes: Cli[] = [{ id: 'sem', status: 'ATIVO', principal: null }, { id: 'a', status: 'ATIVO', principal: null },
        { id: 'p', status: 'ATIVO', principal: null }, { id: 'm', status: 'MESCLADO', principal: 'p' }, { id: 'leg', status: 'ATIVO', principal: null }];
    assert.deepEqual(derivar(clientes, [{ cliente: 'a', empresaPacote: empresaA }, { cliente: 'a', empresaPacote: empresaA },
        { cliente: 'm', empresaPacote: empresaB }, { cliente: 'leg', empresaPacote: null }]), { sem: null, a: empresaA, p: empresaB, m: empresaB, leg: null });
    assert.throws(() => derivar(clientes, [{ cliente: 'a', empresaPacote: empresaA }, { cliente: 'a', empresaPacote: empresaB }]), /empresas distintas/);
    assert.throws(() => derivar(clientes, [{ cliente: 'p', empresaPacote: empresaA }, { cliente: 'm', empresaPacote: empresaB }]), /empresas distintas/);
});

// ---------------------------------------------------------------------------------------------
// F8 — prova real → canonicalização real → leitura por identidade real, sobre SQL simulada que
// aplica os mesmos predicados das consultas reais (asserts garantem que a SQL os contém).
// ---------------------------------------------------------------------------------------------
function identidade() {
    const agora = new Date('2026-09-28T12:00:00Z');
    const clientes: Record<string, any> = {};
    const provas: any[] = [];
    const lidas: string[] = [];
    const tx = { query: async (sql: string, v: unknown[] = []) => {
        lidas.push(sql);
        if (sql.includes('FROM validacoes_identidade_cliente') && sql.includes('token_prova_hash = $1')) {
            for (const p of ["status = 'CONFIRMADA'", 'confirmado_em IS NOT NULL', 'consumido_em IS NULL', 'prova_expira_em > now()']) assert(sql.includes(p), p);
            const rows = provas.filter(p => p.token_prova_hash === v[0] && p.status === 'CONFIRMADA' && p.confirmado_em && !p.consumido_em && new Date(p.prova_expira_em) > agora);
            return { rows: rows.slice(0, 1), rowCount: Math.min(rows.length, 1) };
        }
        if (sql.includes('FROM clientes origem')) {
            const origem = clientes[v[0] as string]; if (!origem) return { rows: [], rowCount: 0 };
            const c = clientes[origem.status === 'MESCLADO' ? origem.cliente_principal_id : origem.id];
            return { rows: c ? [c] : [], rowCount: c ? 1 : 0 };
        }
        if (/FROM clientes\s+WHERE id = \$1/.test(sql)) { const c = clientes[v[0] as string]; return { rows: c ? [c] : [], rowCount: c ? 1 : 0 }; }
        if (/FROM (aniversariantes|responsaveis_adicionais)/.test(sql)) return { rows: [], rowCount: 0 };
        throw Error('SQL não simulada: ' + sql.slice(0, 80));
    } };
    const linhaCliente = (id: string, empresa: string | null, status = 'ATIVO', principal: string | null = null) => ({ id, empresa_id: empresa, nome_completo: 'Cliente ' + id,
        cpf: null, rg: null, telefone: null, whatsapp: '11999999999', email: null, cep: null, logradouro: null, numero: null, complemento: null, bairro: null,
        cidade: null, uf: null, observacoes: null, status, cliente_principal_id: principal, mesclado_em: principal ? agora.toISOString() : null,
        criado_por_usuario_id: null, atualizado_por_usuario_id: null, criado_em: agora.toISOString(), atualizado_em: agora.toISOString() });
    const mocks = { 'lib/db/postgres.ts': { db: () => tx, withTransaction: (fn: any) => fn(tx) } };
    const idMod = carregar('lib/identidade/services/identity.service.ts', mocks) as any;
    const cliMod = carregar('lib/clientes/services/cliente.service.ts', mocks) as any;
    const service = idMod.criarIdentityService({ otpPepper: 'pepper-de-teste-com-16-ou-mais', enviarOtp: async () => undefined, now: () => agora });
    const emitir = (token: string, clienteId: string, extra: object = {}) => provas.push({ id: 'v-' + token.slice(0, 3), cliente_id: clienteId,
        finalidade: 'FECHAMENTO_PUBLICO', canal: 'WHATSAPP', status: 'CONFIRMADA', codigo_hash: 'x', tentativas: 0, max_tentativas: 5, envios: 1, max_envios: 3,
        ultimo_envio_em: null, codigo_expira_em: null, confirmado_em: agora.toISOString(), token_prova_hash: idMod.hashProvaIdentidadeToken(token),
        prova_expira_em: new Date(agora.getTime() + 600_000).toISOString(), consumido_em: null, consumido_por_fechamento_id: null,
        consumido_por_contrato_versao_id: null, recuperacao_solicitada_em: null, criado_em: agora.toISOString(), atualizado_em: agora.toISOString(), ...extra });
    // Mesmo encadeamento da rota /api/identidade/contexto.
    const fluxo = async (token: string) => cliMod.obterClienteBasePorIdentidade(await service.resolverClientePorProva(token));
    return { clientes, lidas, linhaCliente, service, emitir, fluxo, cliMod };
}
const tokenDe = (c: string) => c.repeat(40);
test('F8: prova curta, desconhecida, expirada, consumida e de outra finalidade não abrem cliente', async () => {
    const t = identidade(); t.clientes.c1 = t.linhaCliente('c1', empresaA);
    t.emitir(tokenDe('e'), 'c1', { prova_expira_em: '2026-09-28T11:59:59Z' });
    t.emitir(tokenDe('u'), 'c1', { consumido_em: '2026-09-28T11:00:00Z' });
    t.emitir(tokenDe('f'), 'c1', { finalidade: 'CONTRATO_ASSINATURA' });
    for (const [token, codigo] of [['curta', 'PROVA_INVALIDA_OU_EXPIRADA'], [tokenDe('z'), 'PROVA_INVALIDA_OU_EXPIRADA'], [tokenDe('e'), 'PROVA_INVALIDA_OU_EXPIRADA'],
        [tokenDe('u'), 'PROVA_INVALIDA_OU_EXPIRADA'], [tokenDe('f'), 'PROVA_FINALIDADE_INVALIDA']] as const)
        await assert.rejects(t.fluxo(token), (e: any) => e.code === codigo, token.slice(0, 5));
    assert(!t.lidas.some(s => /FROM clientes/.test(s)), 'nenhum cliente lido com prova recusada');
});
test('F8: prova do cliente canônico abre só esse cliente; prova de outro cliente não autoriza o primeiro', async () => {
    const t = identidade();
    t.clientes.c1 = t.linhaCliente('c1', empresaA); t.clientes.c2 = t.linhaCliente('c2', empresaB);
    t.emitir(tokenDe('a'), 'c1'); t.emitir(tokenDe('b'), 'c2');
    assert.equal((await t.fluxo(tokenDe('a'))).cliente.id, 'c1');
    const outro = await t.fluxo(tokenDe('b'));
    assert.equal(outro.cliente.id, 'c2');
    await assert.rejects(t.cliMod.obterClienteBasePorIdentidade({ ...(await t.service.resolverClientePorProva(tokenDe('b'))), clienteId: 'c3' }),
        (e: any) => e.code === 'CLIENTE_NAO_ENCONTRADO');
});
test('F8: prova emitida para cadastro mesclado resolve para o canônico; clienteId adversarial é recusado', async () => {
    const t = identidade();
    t.clientes.c1 = t.linhaCliente('c1', empresaA); t.clientes.velho = t.linhaCliente('velho', empresaA, 'MESCLADO', 'c1');
    t.emitir(tokenDe('m'), 'velho');
    const resolvida = await t.service.resolverClientePorProva(tokenDe('m'));
    assert.equal(resolvida.clienteId, 'c1');
    assert.equal((await t.cliMod.obterClienteBasePorIdentidade(resolvida)).cliente.id, 'c1');
    await assert.rejects(t.cliMod.obterClienteBasePorIdentidade({ ...resolvida, clienteId: 'velho' }), (e: any) => e.code === 'CLIENTE_NAO_ENCONTRADO');
    await assert.rejects(t.cliMod.obterClienteBasePorIdentidade({ ...resolvida, validacaoId: '' }), (e: any) => e.code === 'CLIENTE_NAO_ENCONTRADO');
    // A prova não vira tenant: a leitura administrativa continua exigindo a empresa comprovada.
    await assert.rejects(t.cliMod.obterClienteBase('c1', empresaB), (e: any) => e.code === 'CLIENTE_NAO_ENCONTRADO');
    assert.doesNotMatch(ler('app/api/identidade/contexto/route.ts') + ler('lib/clientes/services/cliente.service.ts'), /IDENTIDADE_JA_COMPROVADA/);
});
