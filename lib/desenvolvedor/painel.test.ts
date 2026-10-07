import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { carregarModulo, executorFalso } from '../acessos/teste-carregador.ts';

/**
 * Painel do desenvolvedor sem banco: autorização no servidor (rotas, páginas e serviços), isolamento por empresa,
 * auditoria sanitizada e contrato da migration 063. Os fluxos com banco ficam em painel-063.postgres.test.ts.
 */
type Mod = Record<string, (...args: never[]) => unknown>;
const json = (body: unknown, init?: { status?: number }) => new Response(JSON.stringify(body), { status: init?.status ?? 200 });
const agora = Date.now();
const sessao = (papel = 'REPRESENTANTE_AUTORIZADO', autenticadoHaMs = 60_000) => ({
    id: 's', usuario_id: '00000000-0000-4000-8000-000000000001', nome: 'Pessoa', cargo: null, papel,
    autenticado_em: new Date(agora - autenticadoHaMs).toISOString(), consultado_em: new Date(agora).toISOString(), expira_em: new Date(agora + 3_600_000).toISOString(), csrf_hash: 'h',
});

class Recusa extends Error {
    code = 'AUTENTICACAO_ADMINISTRATIVA';
    httpStatus: number;
    constructor(m: string, s: number) { super(m); this.httpStatus = s; }
}

function carregarRota(opcoes: { sessao?: ReturnType<typeof sessao> | null; concedido?: boolean }) {
    const auditorias: Array<Record<string, unknown>> = [];
    const trabalhos: string[] = [];
    const banco = executorFalso([[/FROM plataforma_desenvolvedores/, () => (opcoes.concedido ? [{ id: 'd' }] : [])]]);
    const mod = carregarModulo('lib/desenvolvedor/http.ts', {
        'next/server': { NextResponse: { json } },
        'http/admin-crm-api': { exigirApiAdminCrmDisponivel: async () => { if (!opcoes.sessao) throw new Recusa('Autenticação administrativa necessária.', 401); return opcoes.sessao; } },
        'db/postgres': { db: () => banco, withTransaction: () => { throw new Error('sem transação'); } },
        'clientes/repositories/auditoria.repository': { registrarAuditoria: async (input: Record<string, unknown>) => { auditorias.push(input); } },
        'clientes/services/errors': { isClienteServiceError: (e: unknown) => e instanceof Recusa },
    }) as Mod;
    const rota = mod.rotaDesenvolvedor as (req: unknown, t: (s: unknown) => Promise<unknown>) => Promise<Response>;
    const req = { method: 'GET', headers: { get: () => null }, nextUrl: { pathname: '/api/desenvolvedor/resumo' } };
    return { chamar: () => rota(req, async () => { trabalhos.push('executou'); return { ok: 1 }; }), auditorias, trabalhos, banco };
}

test('rota do painel: sem sessão → 401; proprietário/Gestão SEM concessão → 404 genérico, recusa auditada e trabalho não executa', async () => {
    const semSessao = carregarRota({ sessao: null });
    assert.equal((await semSessao.chamar()).status, 401);
    assert.deepEqual(semSessao.trabalhos, []);
    for (const papel of ['REPRESENTANTE_AUTORIZADO', 'ADMINISTRATIVO']) {
        const dono = carregarRota({ sessao: sessao(papel), concedido: false });
        const r = await dono.chamar();
        assert.equal(r.status, 404, papel);
        assert.deepEqual(await r.json(), { ok: false, erro: 'Recurso não encontrado.', codigo: 'NAO_ENCONTRADO', detalhes: null });
        assert.deepEqual(dono.trabalhos, []);
        assert.equal(dono.auditorias[0].acao, 'PAINEL_ACESSO_RECUSADO');
        assert.equal((dono.auditorias[0].dadosDepois as Record<string, unknown>).resultado, 'RECUSADO');
    }
});

test('rota do painel: com concessão ativa executa e responde no-store; a concessão é lida do banco pela identidade da sessão', async () => {
    const dev = carregarRota({ sessao: sessao('ADMINISTRATIVO'), concedido: true });
    const r = await dev.chamar();
    assert.equal(r.status, 200);
    assert.deepEqual(dev.trabalhos, ['executou']);
    const consulta = dev.banco.executados.find((q) => /plataforma_desenvolvedores/.test(q.sql))!;
    assert.match(consulta.sql, /revogado_em IS NULL AND u\.ativo/);
    assert.deepEqual(consulta.params, ['00000000-0000-4000-8000-000000000001']);
});

function arquivos(dir: string, filtro: RegExp, saida: string[] = []) {
    for (const nome of readdirSync(dir)) {
        const p = path.join(dir, nome);
        if (statSync(p).isDirectory()) arquivos(p, filtro, saida);
        else if (filtro.test(nome)) saida.push(p.replace(/\\/g, '/'));
    }
    return saida;
}

test('toda rota /api/desenvolvedor/* passa pela guarda única em todos os métodos exportados', () => {
    const rotas = arquivos('app/api/desenvolvedor', /^route\.ts$/);
    assert.ok(rotas.length >= 6);
    for (const f of rotas) {
        const texto = readFileSync(f, 'utf8');
        const metodos = [...texto.matchAll(/export async function (GET|POST|PATCH|PUT|DELETE)\b/g)].map((m) => m[1]);
        assert.ok(metodos.length > 0, f);
        for (const m of metodos) {
            const corpo = texto.slice(texto.indexOf(`export async function ${m}`)).split(/\nexport /)[0];
            assert.match(corpo, /return rotaDesenvolvedor\(request,/, `${f} ${m}`);
        }
        assert.doesNotMatch(texto, /temAutoridadeDePlataforma|\.papel\s*[!=]==|exigirApiAdminCrmDisponivel/, `${f}: só a guarda do painel decide`);
    }
});

test('toda página de /desenvolvedor confere a concessão no servidor (cada page.tsx, não só o layout)', () => {
    const paginas = arquivos('app/desenvolvedor', /^(page|layout)\.tsx$/);
    assert.ok(paginas.length >= 6);
    for (const f of paginas) {
        const texto = readFileSync(f, 'utf8');
        assert.doesNotMatch(texto, /^'use client'/m, `${f}: componente de servidor`);
        assert.match(texto, /await exigirDesenvolvedorNaPagina\(/, f);
    }
    const guarda = readFileSync('lib/desenvolvedor/pagina.ts', 'utf8');
    assert.match(guarda, /consultarSessao\(token\)/);
    assert.match(guarda, /temConcessaoDesenvolvedor\(db\(\), sessao\.usuario_id\)/);
    assert.match(guarda, /notFound\(\)/);
});

test('todo serviço exportado do painel confere a concessão DENTRO da transação antes de ler ou escrever', () => {
    for (const f of ['lib/desenvolvedor/interessadas.ts', 'lib/desenvolvedor/empresas.ts', 'lib/desenvolvedor/vinculos.ts', 'lib/desenvolvedor/resumo.ts', 'lib/desenvolvedor/comercial.ts']) {
        const texto = readFileSync(f, 'utf8');
        const funcoes = [...texto.matchAll(/export async function (\w+)\(sessao: SessaoAdmin/g)].map((m) => m[1]);
        assert.ok(funcoes.length > 0, f);
        for (const nome of funcoes) {
            const corpo = texto.slice(texto.indexOf(`export async function ${nome}(`)).split(/\nexport /)[0];
            assert.match(corpo, /exigirDesenvolvedorNaTransacao\(tx, sessao\)|vinculoTravado\(tx, sessao,/, `${f}: ${nome}`);
        }
    }
    const vinculos = readFileSync('lib/desenvolvedor/vinculos.ts', 'utf8');
    const travado = vinculos.slice(vinculos.indexOf('async function vinculoTravado('));
    assert.match(travado.split('\n}\n')[0], /await exigirDesenvolvedorNaTransacao\(tx, sessao\);/);
});

test('isolamento: todo SQL de vínculo, convite e recuperação do painel é filtrado pela empresa informada', () => {
    const vinculos = readFileSync('lib/desenvolvedor/vinculos.ts', 'utf8');
    assert.match(vinculos, /WHERE m\.empresa_id = \$1::uuid AND m\.usuario_id = \$2::uuid FOR UPDATE OF m/);
    const updates = vinculos.split(/\r?\n/).filter((l) => l.includes('UPDATE memberships SET'));
    assert.ok(updates.length >= 3);
    for (const sql of updates)
        assert.match(sql, /WHERE id = \$1::uuid AND empresa_id = \$2::uuid/, sql);
    const convites = readFileSync('lib/acessos/convites.ts', 'utf8');
    for (const trecho of ['renovarConviteNaTransacao', 'cancelarConviteNaTransacao']) {
        const corpo = convites.slice(convites.indexOf(`export async function ${trecho}(`)).split(/\nexport /)[0];
        assert.match(corpo, /WHERE c\.id = \$1::uuid AND c\.empresa_id = \$2::uuid FOR UPDATE/, trecho);
    }
});

test('a concessão de desenvolvedor só nasce e morre pelo CLI: nenhum código da aplicação escreve plataforma_desenvolvedores', () => {
    const codigo = [...arquivos('app', /\.(ts|tsx)$/), ...arquivos('lib', /\.(ts|tsx)$/)].filter((f) => !/\.test\.ts$/.test(f));
    for (const f of codigo)
        assert.doesNotMatch(readFileSync(f, 'utf8'), /(INSERT INTO|UPDATE|DELETE FROM)\s+plataforma_desenvolvedores/i, f);
    const cli = readFileSync('scripts/admin-provision.cjs', 'utf8');
    assert.match(cli, /INSERT INTO plataforma_desenvolvedores/);
    assert.match(cli, /Digite CONFIRMAR/);
});

test('serviço sem concessão: proprietário recebe 404 e nenhuma outra consulta roda (nem leitura de empresa)', async () => {
    const banco = executorFalso([]);
    const deps = { withTransaction: async (w: (t: typeof banco) => Promise<unknown>) => w(banco), registrarAuditoria: async () => undefined };
    const dubles = { 'db/postgres': { db: () => banco, withTransaction: deps.withTransaction } };
    const interessadas = carregarModulo('lib/desenvolvedor/interessadas.ts', dubles) as Mod;
    const empresas = carregarModulo('lib/desenvolvedor/empresas.ts', dubles) as Mod;
    const casos: Array<() => Promise<unknown>> = [
        () => (interessadas.listarInteressadas as (s: unknown, r: unknown, d: unknown) => Promise<unknown>)(sessao(), {}, deps),
        () => (empresas.obterEmpresa as (s: unknown, id: string, d: unknown) => Promise<unknown>)(sessao(), '00000000-0000-4000-8000-0000000000e1', deps),
        () => (empresas.listarEmpresas as (s: unknown, r: unknown, d: unknown) => Promise<unknown>)(sessao(), {}, deps),
    ];
    for (const caso of casos) {
        banco.executados.length = 0;
        await assert.rejects(caso(), (e: { httpStatus?: number; message: string }) => e.httpStatus === 404 && e.message === 'Recurso não encontrado.');
        assert.equal(banco.executados.length, 1);
        assert.match(banco.executados[0].sql, /FROM plataforma_desenvolvedores .* FOR SHARE OF d/s);
    }
});

test('operações de efeito exigem senha confirmada há no máximo 5 minutos, antes de abrir transação', async () => {
    const banco = executorFalso([]);
    const deps = { withTransaction: async () => { throw new Error('não deveria abrir transação'); }, registrarAuditoria: async () => undefined, enviarEmail: async () => undefined, gerarToken: () => 'x' };
    const dubles = { 'db/postgres': { db: () => banco, withTransaction: deps.withTransaction } };
    const empresas = carregarModulo('lib/desenvolvedor/empresas.ts', dubles) as Mod;
    const vinculos = carregarModulo('lib/desenvolvedor/vinculos.ts', dubles) as Mod;
    const antiga = sessao('ADMINISTRATIVO', 6 * 60_000);
    const id = '00000000-0000-4000-8000-0000000000e1';
    const ctx = { requestId: id, ip: null, userAgent: null };
    for (const caso of [
        () => (empresas.provisionarContratante as (...a: unknown[]) => Promise<unknown>)(antiga, { nome: 'Buffet', responsavelNome: 'Ana', email: 'ana@exemplo.test', confirmar: true }, ctx, deps),
        () => (empresas.alterarSituacaoEmpresa as (...a: unknown[]) => Promise<unknown>)(antiga, id, 'suspender', { motivo: 'teste', confirmacaoCodigo: 'x' }, ctx, deps),
        () => (vinculos.alterarSituacaoVinculo as (...a: unknown[]) => Promise<unknown>)(antiga, id, id, 'desativar', { motivo: 'teste' }, ctx, deps),
        () => (vinculos.alterarPapelVinculo as (...a: unknown[]) => Promise<unknown>)(antiga, id, id, { nivel: 'EQUIPE' }, ctx, deps),
    ])
        await assert.rejects(caso(), (e: { code?: string; httpStatus?: number }) => e.code === 'REAUTENTICACAO' && e.httpStatus === 403);
});

test('reautenticação: mesmo relógio, 5 min inclusivos; futuro, expirado e carimbo inválido recusam', () => {
    const { exigirReautenticacaoRecente } = carregarModulo('lib/desenvolvedor/autorizacao.ts', {}) as { exigirReautenticacaoRecente: (s: { autenticado_em: string }, agora: number) => void };
    const t0 = Date.parse('2026-10-04T12:00:00.000Z');
    const em = (ms: number) => ({ autenticado_em: new Date(t0 + ms).toISOString() });
    assert.doesNotThrow(() => exigirReautenticacaoRecente(em(-4 * 60_000), t0));
    assert.doesNotThrow(() => exigirReautenticacaoRecente(em(0), t0));
    assert.doesNotThrow(() => exigirReautenticacaoRecente(em(-300_000), t0));
    assert.doesNotThrow(() => exigirReautenticacaoRecente(em(-299_999), t0));
    assert.throws(() => exigirReautenticacaoRecente(em(-300_001), t0), /Confirme sua senha/);
    assert.throws(() => exigirReautenticacaoRecente(em(1), t0), /Confirme sua senha/);
    assert.throws(() => exigirReautenticacaoRecente(em(90_000), t0), /Confirme sua senha/);
    assert.throws(() => exigirReautenticacaoRecente(em(3 * 60_000), t0), /Confirme sua senha/);
    assert.throws(() => exigirReautenticacaoRecente(em(-6 * 60_000), t0), /Confirme sua senha/);
    assert.throws(() => exigirReautenticacaoRecente({ autenticado_em: 'invalido' }, t0), /Confirme sua senha/);
    const verifica = exigirReautenticacaoRecente as (s: { autenticado_em: string; consultado_em?: string }) => void;
    assert.doesNotThrow(() => verifica({ autenticado_em: new Date(t0 - 300_000).toISOString(), consultado_em: new Date(t0).toISOString() }), 'usa o horário do banco, independentemente de Date.now');
    assert.throws(() => verifica({ autenticado_em: new Date(t0).toISOString() }), /Confirme sua senha/, 'sem fonte comum fecha o acesso');
});

test('auditoria consultável: concessão antes de ler, só origens administrativas, filtros parametrizados, paginação fixa e saída sanitizada', async () => {
    const fonte = readFileSync('lib/desenvolvedor/auditoria-consulta.ts', 'utf8');
    assert.doesNotMatch(fonte, /\$\{f\./, 'nenhum filtro entra no SQL por interpolação');
    const { ORIGENS_ADMINISTRATIVAS, consultarAuditoria } = carregarModulo('lib/desenvolvedor/auditoria-consulta.ts', { 'db/postgres': { db: () => { throw new Error('sem banco'); }, withTransaction: () => { throw new Error('sem banco'); } } }) as unknown as {
        ORIGENS_ADMINISTRATIVAS: readonly string[];
        consultarAuditoria: (s: unknown, raw: unknown, deps: unknown) => Promise<{ itens: Array<{ depois: Record<string, unknown> | null }>; total: number; porPagina: number }>;
    };
    for (const operacional of ['CRM_INTERNO', 'CONTRATOS', 'PAGAMENTOS', 'FESTA', 'FINANCEIRO', 'INTELIGENCIA', 'IMPORTACAO', 'ADMIN_AUTENTICACAO'])
        assert.ok(!ORIGENS_ADMINISTRATIVAS.includes(operacional), operacional);
    const banco = executorFalso([
        [/FROM plataforma_desenvolvedores/, () => [{ id: 'd' }]],
        [/to_regclass\('public\.perfil_empresas'\)/, () => [{ t: 'perfil_empresas' }]],
        [/SELECT count\(\*\)::int AS n FROM auditoria a/, () => [{ n: 1 }]],
        [/FROM auditoria a\s+LEFT JOIN usuarios_administrativos/, () => [{ id: 'a1', acao: 'CONVITE_CRIADO', origem: 'PAINEL_DESENVOLVEDOR', criado_em: '2026-10-05', ator: 'Dev', ator_id: 'u', empresa_id: 'e1', empresa: 'Alfa', entidade_tipo: 'CONVITE_ACESSO', entidade_id: 'c1', resultado: 'SUCESSO', justificativa: null, dados_antes: null, dados_depois: { email: 'a@b.test', token: 'SEGREDO', linkConvite: 'https://x/#t=1', resultado: 'SUCESSO' } }]],
        [/SELECT DISTINCT acao/, () => [{ acao: 'CONVITE_CRIADO' }]],
        [/SELECT id::text AS id, nome FROM empresas/, () => [{ id: 'e1', nome: 'Alfa' }]],
    ]);
    const deps = { withTransaction: async (w: (t: typeof banco) => Promise<unknown>) => w(banco), registrarAuditoria: async () => undefined };
    const r = await consultarAuditoria(sessao(), { empresaId: '00000000-0000-4000-8000-0000000000e1', acao: 'CONVITE_CRIADO', de: '2026-10-01', ate: '2026-10-05', pagina: 2 }, deps);
    assert.match(banco.executados[0].sql, /FROM plataforma_desenvolvedores .* FOR SHARE OF d/s, 'a concessão é conferida antes de qualquer leitura');
    const lista = banco.executados.find((q) => /LEFT JOIN usuarios_administrativos/.test(q.sql))!;
    assert.deepEqual(lista.params, ['00000000-0000-4000-8000-0000000000e1', [...ORIGENS_ADMINISTRATIVAS], 'CONVITE_CRIADO', '2026-10-01', '2026-10-05', 25]);
    assert.match(lista.sql, /a\.origem = ANY\(\$2::text\[\]\)/);
    assert.match(lista.sql, /a\.acao = \$3/);
    assert.match(lista.sql, /a\.criado_em >= \$4::date/);
    assert.match(lista.sql, /a\.criado_em < \(\$5::date \+ interval '1 day'\)/);
    assert.match(lista.sql, /LIMIT 25 OFFSET \$6/);
    assert.match(lista.sql, /entidade_tipo = 'PERFIL_EMPRESA'/, 'registros do perfil entram pela associação com a empresa');
    assert.deepEqual([r.total, r.porPagina], [1, 25]);
    assert.deepEqual(r.itens[0].depois, { email: 'a@b.test', resultado: 'SUCESSO' }, 'token e link nunca saem');
    await assert.rejects(consultarAuditoria(sessao(), { acao: "x'; DROP TABLE auditoria;--" }, deps), 'ação fora do formato é recusada antes do SQL');
    await assert.rejects(consultarAuditoria(sessao(), { empresaId: 'nao-uuid' }, deps));
    const invertido = await consultarAuditoria(sessao(), { de: '2026-10-05', ate: '2026-10-01' }, deps);
    assert.deepEqual([invertido.total, invertido.itens.length], [0, 0], 'período invertido não consulta');
});

test('auditoria do painel: remove senha, token, hash, link/URL e cookies em qualquer nível e mascara documento', () => {
    const { sanitizarAuditoria } = carregarModulo('lib/desenvolvedor/auditoria.ts', {}) as { sanitizarAuditoria: (v: unknown) => unknown };
    const saida = sanitizarAuditoria({
        email: 'ana@exemplo.test', senha: 'x', novaSenha: 'y', token: 't', tokenHash: 'h', senha_hash: 'z', link: 'https://a/#t=1', urlConvite: 'u', csrf: 'c',
        documentoFiscal: '11222333000181', aninhado: { password: 'p', ok: 1, lista: [{ token: 'q', valor: 2 }] },
    });
    assert.deepEqual(saida, { email: 'ana@exemplo.test', documentoFiscal: '**********0181', aninhado: { ok: 1, lista: [{ valor: 2 }] } });
});

test('migration 063: confere os corpos exatos da 044/045, só acrescenta as transições pedidas e não concede ninguém', () => {
    const sql = readFileSync('database/migrations/20261004_063_painel_desenvolvedor.sql', 'utf8').replace(/\r/g, '');
    const corpo = (arquivo: string) => {
        const t = readFileSync(arquivo, 'utf8').replace(/\r/g, '');
        const i = t.indexOf('AS $guard$') + 'AS $guard$'.length;
        return createHash('sha256').update(t.slice(i, t.indexOf('$guard$;', i)), 'utf8').digest('hex');
    };
    assert.ok(sql.includes(corpo('database/migrations/20260926_044_ciclo_empresa.sql')), 'hash da 044 no precheck da 063');
    assert.ok(sql.includes(corpo('database/migrations/20260926_045_ciclo_membership.sql')), 'hash da 045 no precheck da 063');
    assert.match(sql, /\(OLD\.status = 'SUSPENSA' AND NEW\.status IN \('ATIVA', 'DESATIVADA'\)\)/);
    assert.match(sql, /\(OLD\.status = 'ATIVA' AND NEW\.status IN \('SUSPENSA', 'REVOGADA'\)\)/);
    assert.match(sql, /\(OLD\.status = 'SUSPENSA' AND NEW\.status IN \('ATIVA', 'REVOGADA'\)\)/);
    assert.match(sql, /CHECK \(status IN \('PENDENTE', 'ATIVA', 'SUSPENSA', 'REVOGADA'\)\)/);
    assert.doesNotMatch(sql, /INSERT INTO plataforma_desenvolvedores/);
    assert.doesNotMatch(sql, /DROP FUNCTION|CREATE OR REPLACE FUNCTION kidmais_04[45]/, 'funções da 044/045 ficam para o rollback');
    for (const tabela of ['plataforma_desenvolvedores', 'plataforma_interessadas', 'plataforma_empresas_cadastro', 'convites_acesso', 'recuperacoes_senha'])
        assert.match(sql, new RegExp(`BEFORE DELETE ON ${tabela}\\s+FOR EACH ROW EXECUTE FUNCTION kidmais_063_sem_exclusao\\(\\)`), tabela);
    assert.match(sql, /token_hash char\(64\) NOT NULL/);
    assert.doesNotMatch(sql, /\btoken\s+text/, 'só o hash do token é guardado');
    const down = readFileSync('database/rollback/20261004_063_painel_desenvolvedor_down.sql', 'utf8');
    assert.match(down, /há vínculo SUSPENSO/);
    assert.match(down, /tabelas do painel têm registros/);
    assert.match(down, /EXECUTE FUNCTION kidmais_044_guard_empresas\(\)/);
    assert.match(down, /EXECUTE FUNCTION kidmais_045_guard_memberships\(\)/);
});
