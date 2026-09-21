/* eslint-disable @typescript-eslint/no-explicit-any */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import ts from 'typescript';

const req = createRequire(import.meta.url);
const clienteId = '11111111-1111-4111-8111-111111111111';
const aniversarianteId = '22222222-2222-4222-8222-222222222222';
const responsavelId = '33333333-3333-4333-8333-333333333333';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const token = 'x'.repeat(43), csrf = 'c'.repeat(43);
const origin = 'https://admin.example.invalid';
const payload = { pacote: 'pocket', dataFesta: '2027-06-15', horarioBase: 'almoco', ajusteHorario: '0',
    horarioInicio: '11:00', horarioFim: '15:00', statusDisponibilidade: 'disponivel', convidadosPagantes: 20,
    buffetDefinicao: 'depois', valorCombinado: '10000,00', formaPagamento: 'pix_avista',
    aniversarianteId, idadeAniversariante: '', adicionaisSelecionados: [] };

/** Loader fechado: postgres e repositórios são fixtures em memória; nenhuma conexão real. */
function ambiente() {
    const state = {
        cliente: { id: clienteId, status: 'ATIVO', nomeCompleto: 'Cliente fictício unitário', cpf: '52998224725',
            telefone: '11900000000', whatsapp: null, email: 'unitario@example.invalid', cep: '00000000',
            logradouro: 'Rua Fictícia', numero: '1', bairro: 'Teste', cidade: 'Teste', uf: 'SP' } as any,
        aniversariante: { id: aniversarianteId, clienteId, nome: 'Aniversariante fictício', ativo: true },
        responsavel: { id: responsavelId, clienteId, nome: 'Responsável fictício', ativo: true },
        sessao: { id: 'sessao', usuario_id: 'usuario-unitario', papel: 'ADMINISTRATIVO', csrf_hash: hash(csrf),
            revogada: false, ativo: true, expirada: false, ociosa: false, senhaAlterada: false },
        pacote: { id: 'pacote', codigo: 'POCKET', nome: 'Pocket', convidadosMinimos: 20, convidadosMaximos: 150, ativo: true },
        indisponivel: false, pricingError: false, auditError: false,
        fechamentos: [] as any[], adicionais: [] as any[], aprovacoes: [] as any[], historico: [] as any[], auditoria: [] as any[], sql: [] as string[],
    };
    const tx = { query: async (sql: string, params: unknown[] = []) => {
        state.sql.push(sql);
        if (sql.includes('FROM sessoes_administrativas s JOIN usuarios_administrativos')) {
            // Modela os predicados do SELECT real, sem substituir consultarSessao.
            for (const predicate of ['s.revogado_em IS NULL', 'u.ativo', 's.expira_em>clock_timestamp()', "interval '30 minutes'", 's.autenticado_em>=u.senha_alterada_em']) assert(sql.includes(predicate));
            const s = state.sessao;
            return { rows: params[0] === hash(token) && !s.revogada && s.ativo && !s.expirada && !s.ociosa && !s.senhaAlterada ? [s] : [] };
        }
        if (sql.startsWith('UPDATE sessoes_administrativas') || /^SELECT id FROM (clientes|aniversariantes|responsaveis_adicionais) WHERE/.test(sql)) return { rows: [] };
        throw Error('SQL não permitido no mock: ' + sql);
    } };
    const transacao = async (fn: any) => {
        const nomes = ['fechamentos', 'adicionais', 'aprovacoes', 'historico', 'auditoria'] as const;
        const antes = nomes.map(k => structuredClone(state[k]));
        try { return await fn(tx); } catch (e) { nomes.forEach((k, i) => { state[k] = antes[i]; }); throw e; }
    };
    const mocks: Record<string, any> = {};
    const cache: Record<string, any> = {};
    function nomeArquivo(input: string) {
        const base = resolve(input);
        return [base, base + '.ts', base + '.tsx', base + '/index.ts'].find(p => existsSync(p) && /\.(ts|tsx|css)$/.test(p)) ?? base;
    }
    function mock(path: string, value: any) { mocks[nomeArquivo(path)] = value; }
    function load(path: string): any {
        const file = nomeArquivo(path);
        if (file in mocks) return mocks[file];
        if (file in cache) return cache[file];
        if (file.includes('/identidade/') || file.includes('\\identidade\\')) throw Error('OTP nunca deve ser carregado pelo fluxo administrativo');
        if (file.endsWith('.css')) return {};
        const exports = {}; cache[file] = exports;
        const source = readFileSync(file, 'utf8');
        const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
        new Function('require', 'exports', 'window', 'fetch', code)((n: string) => n in mocks ? mocks[n] : n.startsWith('@/') ? load(n.slice(2)) : n.startsWith('.') ? load(resolve(dirname(file), n)) : n === 'pg' ? (() => { throw Error('Conexão proibida'); })() : req(n), exports, mocks.__window, mocks.__fetch);
        return exports;
    }
    mock('lib/db/postgres', { db: () => tx, withTransaction: transacao });
    mock('lib/clientes/repositories', {
        buscarClienteCanonicoPorId: async () => state.cliente,
        listarAniversariantesDoCliente: async () => [state.aniversariante], listarResponsaveisDoCliente: async () => [state.responsavel],
        registrarEventoHistorico: async (v: any, executor: any) => { assert.equal(executor, tx); state.historico.push(v); },
        registrarAuditoria: async (v: any, executor: any) => { assert.equal(executor, tx); if (state.auditError) throw Error('Auditoria indisponível'); state.auditoria.push(v); },
    });
    mock('lib/clientes/repositories/auditoria.repository', {});
    mock('lib/clientes/services', load('lib/clientes/services/errors'));
    mock('lib/comercial/repositories', { buscarPacoteAtivoPorCodigo: async () => state.pacote.ativo ? state.pacote : null });
    mock('lib/disponibilidade/services', { revalidarHorarioSelecionado: async (i: any, executor: any) => {
        assert.equal(executor, tx);
        if (state.indisponivel) throw Error('HORARIO_NAO_DISPONIVEL');
        return { candidato: { inicio: i.inicio, fim: i.fim }, periodo: { configuracaoId: 'agenda-confiavel' } };
    } });
    mock('lib/comercial/services', { calcularResumoComercial: async () => {
        if (state.pricingError) throw Error('PACOTE_INDISPONIVEL');
        return { valorTotalTabela: 10000, valorTabelaPacoteBase: 10000, valorDescontoPacote: 0, valorTabelaPacoteAplicado: 10000, valorAdicionais: 0,
            pacote: { pacote: state.pacote, tabelaPreco: { id: 'tabela' }, precoRegra: { id: 'preco' }, desconto: { regraId: null, percentual: 0 }, convidadosInformados: 20, convidadosFaturados: 20 }, adicionais: { itens: [] } };
    } });
    mock('lib/fechamentos/repositories', {
        criarFechamento: async (i: any, executor: any) => { assert.equal(executor, tx); const f = { ...i, id: 'fechamento-unitario' }; state.fechamentos.push(f); return f; },
        criarFechamentoAdicional: async (i: any) => { state.adicionais.push(i); return i; },
        criarAprovacaoNegociacao: async (i: any) => { state.aprovacoes.push(i); return i; },
    });
    const politica = load('lib/http/admin-origin');
    mock('lib/http/admin-origin.ts', { ...politica, ambientePoliticaAdminAtual: () => ({ ADMIN_AUTH_ORIGIN: origin, NODE_ENV: 'production' }) });
    const route = load('app/api/admin/clientes/[id]/fechamentos/route.ts');
    const { NextRequest } = req('next/server');
    const chamar = async (body: any = payload, options: any = {}) => {
        const method = options.method ?? 'POST';
        const headers = { origin, 'Content-Type': 'application/json', 'x-csrf-token': csrf,
            cookie: `__Host-kidmais_admin=${options.token ?? token}`, ...options.headers };
        const request = new NextRequest(origin + '/api/admin/clientes/' + clienteId + '/fechamentos', { method, headers, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
        return route[method](request, { params: Promise.resolve({ id: options.id ?? clienteId }) });
    };
    return { state, chamar, load, mock, external: (name: string, value: any) => { mocks[name] = value; } };
}

test('GET e POST reais: cliente existente, núcleo comercial, origem/ator do servidor, histórico e zero OTP', async () => {
    const a = ambiente();
    assert.equal((await a.chamar(null, { method: 'GET' })).status, 200);
    assert.equal((await a.chamar({ ...payload, responsavelAdicionalId: responsavelId })).status, 201);
    const f = a.state.fechamentos[0];
    assert.equal(f.clienteId, clienteId); assert.equal(f.aniversarianteId, aniversarianteId);
    assert.equal(f.origemFechamento, 'ATENDIMENTO_KIDMAIS'); assert.equal(f.iniciadoPorUsuarioId, 'usuario-unitario');
    assert.equal(f.usuarioResponsavelId, 'usuario-unitario'); assert.equal(f.valorTabela, 10000);
    assert.equal(f.status, 'AGUARDANDO_CONTRATO');
    assert.equal(a.state.historico[0].tipoEvento, 'FECHAMENTO_CRIADO');
    assert.equal(a.state.auditoria[0].atorTipo, 'USUARIO'); assert(a.state.auditoria[0].requestId);
    assert(!a.state.sql.some(s => /^(INSERT|DELETE|UPDATE (?!sessoes_administrativas))/.test(s)));
});
for (const [caso, options] of [['ausente', { token: '' }], ['malformada', { token: 'invalida' }], ['desconhecida', { token: 'y'.repeat(43) }]] as const) {
    test(`sessão ${caso}: HTTP 401 sem gravação`, async () => { const a = ambiente(); assert.equal((await a.chamar(payload, options)).status, 401); assert.equal(a.state.fechamentos.length, 0); });
}
for (const campo of ['revogada', 'expirada', 'ociosa', 'senhaAlterada', 'ativo'] as const) {
    test(`sessão ${campo}: rejeitada pelo serviço real`, async () => { const a = ambiente(); a.state.sessao[campo] = campo !== 'ativo'; assert.equal((await a.chamar()).status, 401); assert.equal(a.state.fechamentos.length, 0); });
}
test('papel desconhecido negado; representante permitido', async () => {
    const a = ambiente(); a.state.sessao.papel = 'VISITANTE'; assert.equal((await a.chamar()).status, 403);
    a.state.sessao.papel = 'REPRESENTANTE_AUTORIZADO'; assert.equal((await a.chamar()).status, 201);
});
for (const headers of [{ origin: 'https://outro.example.invalid' }, { 'x-csrf-token': '' }, { 'x-csrf-token': 'forjado' }]) {
    test(`origem/CSRF inválido ${JSON.stringify(headers)}`, async () => { const a = ambiente(); assert.equal((await a.chamar(payload, { headers })).status, 403); assert.equal(a.state.fechamentos.length, 0); });
}
test('cliente inexistente/inativo/incompleto e CPF inválido', async () => {
    for (const patch of [null, { status: 'INATIVO' }, { email: '' }, { cpf: '00000000000' }]) {
        const a = ambiente(); a.state.cliente = patch === null ? null : { ...a.state.cliente, ...patch };
        assert((await a.chamar()).status >= 400); assert.equal(a.state.fechamentos.length, 0);
    }
});
test('mesclado é apresentado no GET e exige confirmar o canônico em outra URL no POST', async () => {
    const a = ambiente(); a.state.cliente.id = '44444444-4444-4444-8444-444444444444';
    const get = await (await a.chamar(null, { method: 'GET' })).json(); assert.equal(get.data.redirecionadoDe, clienteId);
    assert.equal((await a.chamar()).status, 409); assert.equal(a.state.fechamentos.length, 0);
});
test('aniversariante/responsável de outro cliente ou inativo é recusado', async () => {
    for (const alvo of ['aniversariante', 'responsavel'] as const) for (const campo of ['clienteId', 'ativo']) {
        const a = ambiente(); Object.assign(a.state[alvo], { [campo]: campo === 'ativo' ? false : 'outro-cliente' });
        assert.equal((await a.chamar({ ...payload, responsavelAdicionalId: responsavelId })).status, 409); assert.equal(a.state.fechamentos.length, 0);
    }
});
for (const campo of ['clienteId', 'cpf', 'nomeCliente', 'email', 'logradouro', 'origemFechamento', 'usuarioResponsavelId', 'iniciadoPorUsuarioId', 'admin', 'valorAprovado', 'condicaoAprovada']) {
    test(`payload não pode forjar ${campo}`, async () => { const a = ambiente(); assert.equal((await a.chamar({ ...payload, [campo]: 'forjado' })).status, 400); assert.equal(a.state.fechamentos.length, 0); });
}
test('pacote/horário/convidados/valor/buffet/pagamento/adicionais inválidos não persistem', async () => {
    for (const patch of [{ pacote: 'fora' }, { convidadosPagantes: 151 }, { convidadosPagantes: 19 }, { pacote: 'compacta', convidadosPagantes: 41 }, { valorCombinado: '1,001' }, { valorCombinado: '0' }, { buffetDefinicao: 'inventado' }, { formaPagamento: 'inventada' }, { adicionaisSelecionados: ['inventado'] }, { adicionaisSelecionados: ['mesa-cafe-p', 'mesa-cafe-g'] }, { condicaoPixPretendida: { entrada: '100' } }]) {
        const a = ambiente(); assert((await a.chamar({ ...payload, ...patch })).status >= 400, JSON.stringify(patch)); assert.equal(a.state.fechamentos.length, 0);
    }
    for (const campo of ['indisponivel', 'pricingError'] as const) {
        const a = ambiente(); a.state[campo] = true; assert((await a.chamar()).status >= 400); assert.equal(a.state.fechamentos.length, 0);
    }
});
test('negociação e PIX mantêm aprovação pendente; buffet definido preserva escolhas', async () => {
    const a = ambiente();
    assert.equal((await a.chamar({ ...payload, valorCombinado: '9000', formaPagamento: 'pix_parcelado', condicaoPixPretendida: { entrada: 1000 }, buffetDefinicao: 'agora', buffetBolo: 'Escolha fictícia' })).status, 201);
    assert.equal(a.state.fechamentos[0].status, 'AGUARDANDO_APROVACAO'); assert.equal(a.state.aprovacoes.length, 1);
    assert.equal(a.state.fechamentos[0].buffetStatus, 'DEFINIDO'); assert.equal(a.state.fechamentos[0].buffetBolo, 'Escolha fictícia');
});
test('POST relê cadastro e sessão depois do GET', async () => {
    const a = ambiente(); assert.equal((await a.chamar(null, { method: 'GET' })).status, 200);
    a.state.cliente.status = 'INATIVO'; assert.equal((await a.chamar()).status, 409);
    a.state.cliente.status = 'ATIVO'; a.state.sessao.expirada = true; assert.equal((await a.chamar()).status, 401);
    assert.equal(a.state.fechamentos.length, 0);
});
test('falha de auditoria faz rollback de fechamento, revisão e histórico', async () => {
    const a = ambiente(); a.state.auditError = true;
    assert.equal((await a.chamar({ ...payload, valorCombinado: '9000' })).status, 500);
    for (const k of ['fechamentos', 'adicionais', 'aprovacoes', 'historico', 'auditoria'] as const) assert.equal(a.state[k].length, 0);
});
test('guard pública permanece e rota pública não oferece identidade administrativa', () => {
    const wizard = readFileSync('components/fechamento/FechamentoWizard.tsx', 'utf8');
    assert.match(wizard, /if \(etapa === 6\) \{\s*if \(origemInterna\) \{\s*setErro\([\s\S]*?return false;/);
    const route = readFileSync('app/api/fechamentos/route.ts', 'utf8');
    assert.match(route, /identidadeTipo: z.enum\(\["NOVO_CLIENTE", "CLIENTE_EXISTENTE"\]\)/);
    assert.match(route, /!dados.data.provaIdentidade/); assert.doesNotMatch(route, /criarFechamentoAdministrativo|exigirApiAdmin/);
});

test('POST público continua recusando cliente existente sem prova mesmo com parâmetros administrativos', async () => {
    const a = ambiente(); let criacoes = 0;
    a.mock('lib/fechamentos/services', { criarFechamentoPublicoComIdentidade: async () => { criacoes++; }, isFechamentoServiceError: () => false });
    a.mock('lib/identidade/services', { isIdentityServiceError: () => false });
    const route = a.load('app/api/fechamentos/route.ts');
    const { NextRequest } = req('next/server');
    const body = { ...payload, identidadeTipo: 'CLIENTE_EXISTENTE', nomeCliente: 'Cliente fictício', cpf: '52998224725',
        email: 'unitario@example.invalid', telefone: '11900000000', cep: '00000000', logradouro: 'Rua Fictícia', numero: '1', bairro: 'Teste', cidade: 'Teste', uf: 'SP', nomeAniversariante: 'Fictício',
        admin: true, contexto: 'ADMIN', origem: 'ATENDIMENTO_KIDMAIS', clienteId };
    const res = await route.POST(new NextRequest(origin + '/api/fechamentos?contexto=ADMIN', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
    assert.equal(res.status, 401); assert.equal((await res.json()).codigo, 'IDENTIDADE_OBRIGATORIA'); assert.equal(criacoes, 0);
});

/** Executa os handlers reais do formulário com hooks e HTTP em memória. */
async function formulario() {
    const a = ambiente(), states: any[] = [], refs: any[] = [], deps: any[] = [], effects: any[] = [], redirects: string[] = [];
    a.external('next/navigation', { useRouter: () => ({ replace: (url: string) => redirects.push(url) }) });
    let si = 0, ri = 0, ei = 0;
    a.external('react', {
        useState: (initial: any) => { const i = si++; if (!(i in states)) states[i] = initial; return [states[i], (value: any) => { states[i] = typeof value === 'function' ? value(states[i]) : value; }]; },
        useRef: (initial: any) => { const i = ri++; return refs[i] ??= { current: initial }; },
        useEffect: (fn: any, values: any[]) => { const i = ei++; if (!deps[i] || values.some((v, j) => v !== deps[i][j])) { deps[i] = values; effects.push(fn); } },
    });
    a.external('__window', { location: { assign: (url: string) => redirects.push(url) } });
    a.external('__fetch', async (url: string, init: any = {}) => {
        if (url === '/api/admin/autenticacao') return Response.json({ ok: true, data: { usuarioId: a.state.sessao.expirada ? null : 'usuario-unitario', csrf } });
        if (url.startsWith('/api/disponibilidade?')) return Response.json({ ok: true, data: { periodos: [{ codigo: 'TURNO_1', horarios: [{ inicio: '11:00', fim: '15:00', ajusteMinutos: 0, status: 'DISPONIVEL' }] }] } });
        assert.equal(url, `/api/admin/clientes/${clienteId}/fechamentos`);
        return a.chamar(init.body ? JSON.parse(init.body) : null, { method: init.method ?? 'GET', headers: Object.fromEntries(new Headers(init.headers)) });
    });
    const Component = a.load('components/admin/FechamentoAdminWizard.tsx').default;
    function render() { si = ri = ei = 0; const tree = Component({ clienteId }); while (effects.length) effects.shift()(); return tree; }
    function nodes(root: any): any[] { return !root || typeof root !== 'object' ? [] : Array.isArray(root) ? root.flatMap(nodes) : [root, ...nodes(root.props?.children)]; }
    function text(root: any): string { return root === null || root === undefined ? '' : Array.isArray(root) ? root.map(text).join(' ') : typeof root === 'object' ? text(root.props?.children) : String(root); }
    function field(label: string, value: string) {
        const l = nodes(render()).find(n => n.type === 'label' && text(n).startsWith(label)); assert(l, label);
        const input = nodes(l).find(n => ['select', 'input', 'textarea'].includes(n.type));
        input.props.onChange({ target: { value } });
    }
    render(); await new Promise(resolve => setImmediate(resolve));
    async function preencher() {
        const calendar = nodes(render()).find(n => n.type?.name === 'CalendarioDisponibilidade'); assert(calendar);
        calendar.props.onSelecionar(payload.dataFesta);
        await new Promise(resolve => setImmediate(resolve));
        field('Horário disponível', '11:00'); field('Aniversariante', aniversarianteId); field('Valor comercial proposto', '10000,00');
    }
    async function submit() { await nodes(render()).find(n => n.type === 'form').props.onSubmit({ preventDefault() {} }); }
    return { ...a, render, text, preencher, submit, redirects };
}

test('CRM → formulário administrativo → conclusão com GET/POST e núcleo reais, sem OTP', async () => {
    const profile = readFileSync('components/clientes/ClienteProfile.tsx', 'utf8');
    assert.match(profile, /href=\{`\/admin\/clientes\/\$\{clienteId\}\/fechamento`\}/);
    const a = await formulario(); await a.preencher(); await a.submit();
    assert.match(a.text(a.render()), /Fechamento criado/); assert.equal(a.state.fechamentos.length, 1);
    assert.equal(a.state.fechamentos[0].clienteId, clienteId);
});
test('sessão expirada durante preenchimento redireciona ao login sem POST de criação', async () => {
    const a = await formulario(); await a.preencher(); a.state.sessao.expirada = true; await a.submit();
    assert.deepEqual(a.redirects, ['/admin/login']); assert.equal(a.state.fechamentos.length, 0);
    assert.match(a.text(a.render()), /Faça login para continuar/);
});
