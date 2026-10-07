/* eslint-disable @typescript-eslint/no-explicit-any */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import ts from 'typescript';

const req = createRequire(import.meta.url);
const empresaA = 'aaaaaaaa-0000-4000-8000-00000000000a';
const empresaB = 'bbbbbbbb-0000-4000-8000-00000000000b';
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

/** Harness da fotografia append-only (Pacotes V1, Marco 1). Não altera a regra do produto. */
function responderFotografia(sql: string) {
    const compact = sql.replace(/\s+/g, ' ').trim();
    if (compact.startsWith('INSERT INTO fechamento_pacote_snapshots'))
        return { rows: [{ id: 'snapshot-unitario' }], rowCount: 1 };
    if (compact.startsWith('SELECT a.id, a.codigo, a.nome') && compact.includes('FROM pacote_adicionais'))
        return { rows: [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', codigo: 'PENNE', nome: 'Penne' }], rowCount: 1 };
    if (compact.startsWith('SELECT c.id, c.codigo, c.nome') && compact.includes('FROM pacote_buffet_categorias'))
        return { rows: [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', codigo: 'SALGADOS', nome: 'Salgados', modo_itens: 'TODOS_ATIVOS', escolhas_min: 1, escolhas_max: 4 }], rowCount: 1 };
    if (compact.startsWith('INSERT INTO fechamento_pacote_composicao'))
        return { rows: [], rowCount: 1 };
    if (compact.includes('to_regclass'))
        return { rows: [{ especificos: false, fotografia: false }], rowCount: 1 };
    if (compact.startsWith('UPDATE fechamentos') && compact.includes('pacote_snapshot_vigente_id'))
        return { rows: [], rowCount: 1 };
    return null;
}

/** Loader fechado: postgres e repositórios são fixtures em memória; nenhuma conexão real. */
function ambiente() {
    const state = {
        tenant: empresaA as string, tenantRecusado: false, papelNaEmpresa: 'REPRESENTANTE_AUTORIZADO' as string,
        cliente: { id: clienteId, empresaId: empresaA, status: 'ATIVO', nomeCompleto: 'Cliente fictício unitário', cpf: '52998224725',
            telefone: '11900000000', whatsapp: null, email: 'unitario@example.invalid', cep: '00000000',
            logradouro: 'Rua Fictícia', numero: '1', bairro: 'Teste', cidade: 'Teste', uf: 'SP' } as any,
        aniversariante: { id: aniversarianteId, clienteId, nome: 'Aniversariante fictício', ativo: true },
        responsavel: { id: responsavelId, clienteId, nome: 'Responsável fictício', ativo: true },
        sessao: { id: 'sessao', usuario_id: 'usuario-unitario', papel: 'ADMINISTRATIVO', csrf_hash: hash(csrf),
            revogada: false, ativo: true, expirada: false, ociosa: false, senhaAlterada: false },
        pacote: { id: 'pacote', codigo: 'POCKET', nome: 'Pocket', convidadosMinimos: 20, convidadosMaximos: 150, ativo: true, empresaId: empresaA } as any,
        consultasPacote: [] as Array<{ empresaId: unknown; codigo: unknown }>, pacotesExtras: [] as any[],
        indisponivel: false, pricingError: false, auditError: false, pricingInput: null as any,
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
        // E4 (paywall na guarda): empresa efetiva da sessão, relógio e 067 ausente = sem cobrança, como hoje.
        if (sql.includes('FROM memberships m JOIN empresas e ON e.id = m.empresa_id') && sql.includes('LIMIT 2')) return { rows: state.tenantRecusado ? [] : [{ id: state.tenant }] };
        if (sql.includes('to_char(clock_timestamp() AT TIME ZONE')) return { rows: [{ agora: '2026-10-07T12:00:00.000Z' }] };
        if (sql.includes("to_regclass('public.empresa_assinaturas')")) return { rows: [{ ok: false }] };
        if (sql.includes('FROM pacotes') && sql.includes('WHERE empresa_id = $1::uuid')) {
            // Mesmos predicados do SELECT real: empresa comprovada, código, vigente, ativo e não arquivado.
            for (const predicate of ['codigo = $2', 'AND vigente', 'AND ativo', 'arquivado_em IS NULL']) assert(sql.includes(predicate));
            state.consultasPacote.push({ empresaId: params[0], codigo: params[1] });
            const linhas = [state.pacote, ...state.pacotesExtras].filter((x: any) => x.empresaId === params[0] && x.codigo === params[1] && x.ativo && x.vigente !== false && !x.arquivadoEm);
            return { rows: linhas.map((x: any) => ({ id: x.id, codigo: x.codigo, nome: x.nome, descricao: null, convidados_minimos: x.convidadosMinimos, convidados_maximos: x.convidadosMaximos, duracao_minutos: 240, ordem_exibicao: 1, ativo: x.ativo, empresa_id: x.empresaId })) };
        }
        const fotografia = responderFotografia(sql);
        if (fotografia) return fotografia;
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
        new Function('require', 'exports', 'window', 'fetch', 'requestAnimationFrame', code)((n: string) => n in mocks ? mocks[n] : n.startsWith('@/') ? load(n.slice(2)) : n.startsWith('.') ? load(resolve(dirname(file), n)) : n === 'pg' ? (() => { throw Error('Conexão proibida'); })() : req(n), exports, mocks.__window, mocks.__fetch, (fn: () => void) => fn());
        return exports;
    }
    mock('lib/db/postgres', { db: () => tx, withTransaction: transacao });
    // Prova de tenant real tem teste próprio; aqui só entrega a empresa comprovada da sessão.
    mock('lib/saas/provar-tenant', { executarNoTenant: async (executor: any, sessao: any, _pedida: any, work: any) => {
        assert.equal(executor, tx);
        // Mesmo erro que provarTenant lança (classe real carregada pelo harness).
        if (state.tenantRecusado) { const { PacoteAdminError } = load('lib/comercial/pacotes-admin'); throw new PacoteAdminError('TENANT_NAO_COMPROVADO', 'A sessão administrativa não comprova a empresa autorizada.', 403); }
        return work(executor, { empresaComprovada: state.tenant, membershipId: 'membership', usuarioId: sessao.usuario_id, papelAtual: state.papelNaEmpresa });
    } });
    mock('lib/clientes/repositories', {
        buscarClienteCanonicoPorId: async () => state.cliente,
        buscarClientePorId: async () => state.cliente,
        listarAniversariantesDoCliente: async () => [state.aniversariante], listarResponsaveisDoCliente: async () => [state.responsavel],
        registrarEventoHistorico: async (v: any, executor: any) => { assert.equal(executor, tx); state.historico.push(v); },
        registrarAuditoria: async (v: any, executor: any) => { assert.equal(executor, tx); if (state.auditError) throw Error('Auditoria indisponível'); state.auditoria.push(v); },
    });
    mock('lib/clientes/repositories/auditoria.repository', {});
    mock('lib/clientes/services', load('lib/clientes/services/errors'));
    // Repositório REAL de pacotes (busca da empresa comprovada) sobre a tabela fictícia; o catálogo público segue recusado.
    const repositorioPacotes = load('lib/comercial/repositories/comercial.repository.ts');
    mock('lib/comercial/repositories', { buscarPacoteAtivoPorCodigo: repositorioPacotes.buscarPacoteAtivoPorCodigo, buscarPacoteVigenteDaEmpresaPorCodigo: repositorioPacotes.buscarPacoteVigenteDaEmpresaPorCodigo });
    // Agenda por empresa/unidade (062): o escopo é resolvido na mesma transação, pela empresa comprovada.
    mock('lib/disponibilidade/escopo', { escopoDaEmpresa: async (executor: any, empresaId: string, unidade?: string | null) => {
        assert.equal(executor, tx); assert.equal(empresaId, state.tenant);
        return { empresaId, estabelecimentoId: unidade ?? null };
    } });
    mock('lib/disponibilidade/services', { revalidarHorarioSelecionado: async (i: any, executor: any) => {
        assert.equal(executor, tx);
        if (state.indisponivel) throw Error('HORARIO_NAO_DISPONIVEL');
        return { candidato: { inicio: i.inicio, fim: i.fim }, periodo: { configuracaoId: 'agenda-confiavel' } };
    } });
    mock('lib/comercial/services', { calcularResumoComercial: async (input: any) => {
        state.pricingInput = input;
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
    const sql = a.state.sql.map(s => s.replace(/\s+/g, ' ').trim());
    const fotografia = /^(INSERT INTO fechamento_pacote_snapshots|INSERT INTO fechamento_pacote_composicao|UPDATE fechamentos SET pacote_snapshot_vigente_id )/;
    assert(sql.filter(s => /^(INSERT|DELETE|UPDATE)/.test(s)).every(s => s.startsWith('UPDATE sessoes_administrativas') || fotografia.test(s)));
    assert(sql.some(s => s.startsWith('INSERT INTO fechamento_pacote_snapshots')));
    assert(sql.some(s => s.startsWith('INSERT INTO fechamento_pacote_composicao') && s.includes("'INCLUSO'")));
    assert(sql.some(s => s.startsWith('INSERT INTO fechamento_pacote_composicao') && s.includes("'BUFFET'")));
    assert(sql.some(s => s.startsWith('UPDATE fechamentos') && s.includes('pacote_snapshot_vigente_id IS NULL')));
});

test('extras unitários: SKUs próprios e quantidades chegam intactos ao cálculo administrativo', async () => {
    const a = ambiente();
    assert.equal((await a.chamar({ ...payload, adicionaisSelecionados: ['bombom', 'lembrancinha-copo', 'lembrancinha-bola'],
        adicionaisQuantidades: { bombom: 3, 'lembrancinha-copo': 2, 'lembrancinha-bola': 1 } })).status, 201);
    assert.deepEqual(a.state.pricingInput.adicionais, [
        { codigo: 'BOMBOM', quantidade: 3 }, { codigo: 'LEMBRANCINHA_COPO', quantidade: 2 }, { codigo: 'LEMBRANCINHA_BOLA', quantidade: 1 },
    ]);
});
for (const quantidade of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    test(`quantidade extra inválida ${quantidade}: rejeita antes de criar fechamento`, async () => {
        const a = ambiente();
        assert.equal((await a.chamar({ ...payload, adicionaisSelecionados: ['bombom'], adicionaisQuantidades: { bombom: quantidade } })).status, 400);
        assert.equal(a.state.fechamentos.length, 0); assert.equal(a.state.pricingInput, null);
        assert.equal(a.load('lib/fechamentos/comercial-input').traduzirAdicionais(['bombom'], { bombom: quantidade }).ok, false);
    });
}
test('extra opcional: não selecionado não cobra; uma unidade não exige lote mínimo', () => {
    const traduzir = ambiente().load('lib/fechamentos/comercial-input').traduzirAdicionais;
    assert.deepEqual(traduzir([], { bombom: 4 }).itens, []);
    assert.deepEqual(traduzir(['bombom']).itens, [{ codigo: 'BOMBOM', quantidade: 1 }]);
    assert.equal(traduzir(['lembrancinha-personalizada']).ok, false);
    assert.equal(traduzir(['lembrancinha-premium']).ok, false);
});
for (const [caso, options] of [['ausente', { token: '' }], ['malformada', { token: 'invalida' }], ['desconhecida', { token: 'y'.repeat(43) }]] as const) {
    test(`sessão ${caso}: HTTP 401 sem gravação`, async () => { const a = ambiente(); assert.equal((await a.chamar(payload, options)).status, 401); assert.equal(a.state.fechamentos.length, 0); });
}
for (const campo of ['revogada', 'expirada', 'ociosa', 'senhaAlterada', 'ativo'] as const) {
    test(`sessão ${campo}: rejeitada pelo serviço real`, async () => { const a = ambiente(); a.state.sessao[campo] = campo !== 'ativo'; assert.equal((await a.chamar()).status, 401); assert.equal(a.state.fechamentos.length, 0); });
}
test('papel NESTA empresa (membership) decide; o papel global da identidade não autoriza nem recusa', async () => { // @pr:UX
    const a = ambiente(); a.state.papelNaEmpresa = 'VISITANTE'; assert.equal((await a.chamar()).status, 403); // @pr:UX
    assert.equal(a.state.fechamentos.length, 0); // @pr:UX
    a.state.papelNaEmpresa = 'ADMINISTRATIVO'; a.state.sessao.papel = 'VISITANTE'; assert.equal((await a.chamar()).status, 201); // @pr:UX
}); // @pr:UX
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

test('POST público usa pacote e unidade do servidor e ignora empresa/unidade forjadas', async () => {
    for (const pacoteDeOutraEmpresa of [false, true]) {
        const a = ambiente(); let recebido: any = null;
        if (pacoteDeOutraEmpresa) a.state.pacote.empresaId = empresaB;
        a.mock('lib/comercial/catalogo-publico', { escopoCatalogoPublico: async () => ({ empresaId: empresaA, estabelecimentoId: 'unidade-publica' }) });
        a.mock('lib/disponibilidade/services', {
            revalidarHorarioSelecionado: async (i: any, _tx: any, escopo: any) => {
                assert.deepEqual(escopo, { empresaId: empresaA, estabelecimentoId: 'unidade-publica' });
                return { candidato: { inicio: i.inicio, fim: i.fim }, periodo: { configuracaoId: 'agenda-confiavel' } };
            }, isAvailabilityServiceError: () => false,
        });
        a.mock('lib/identidade/services', { isIdentityServiceError: () => false });
        a.mock('lib/fechamentos/services', {
            criarFechamentoPublicoComIdentidade: async (input: any) => {
                recebido = input;
                return { fechamento: { id: 'fechamento-publico', status: 'RASCUNHO' },
                    cliente: { novo: true, camposFaltantesParaContrato: [] }, aniversariante: { novo: true },
                    resumoComercial: { pacote: { pacote: a.state.pacote, tabelaPreco: {} }, adicionais: { itens: [] } } };
            }, isFechamentoServiceError: () => false,
        });
        const route = a.load('app/api/fechamentos/route.ts');
        const { NextRequest } = req('next/server');
        const body = { ...payload, identidadeTipo: 'NOVO_CLIENTE', nomeCliente: 'Cliente fictício', cpf: '52998224725',
            email: 'unitario@example.invalid', cep: '00000000', logradouro: 'Rua Fictícia', numero: '1', bairro: 'Teste', cidade: 'Teste', uf: 'SP', nomeAniversariante: 'Fictício',
            empresaId: empresaB, estabelecimentoId: 'unidade-forjada' };
        const res = await route.POST(new NextRequest(origin + '/api/fechamentos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
        assert.equal(res.status, pacoteDeOutraEmpresa ? 404 : 201);
        if (pacoteDeOutraEmpresa) assert.equal(recebido, null);
        else {
            assert.equal(recebido.pacoteId, a.state.pacote.id);
            assert.equal(recebido.estabelecimentoId, 'unidade-publica');
            assert.equal(recebido.configuracaoAgendaId, 'agenda-confiavel');
        }
        assert.deepEqual(a.state.consultasPacote, [{ empresaId: empresaA, codigo: 'POCKET' }]);
    }
});

/** Executa os handlers reais do formulário com hooks e HTTP em memória. */
async function formulario() {
    const a = ambiente(), states: any[] = [], refs: any[] = [], deps: any[] = [], effects: any[] = [], redirects: string[] = [];
    a.external('next/navigation', { useRouter: () => ({ replace: (url: string) => redirects.push(url) }) });
    let si = 0, ri = 0, ei = 0;
    a.external('react', {
        useState: (initial: any) => { const i = si++; if (!(i in states)) states[i] = initial; return [states[i], (value: any) => { states[i] = typeof value === 'function' ? value(states[i]) : value; }]; },
        useRef: (initial: any) => { const i = ri++; return refs[i] ??= { current: initial }; },
        useCallback: (fn: any) => fn,
        useEffect: (fn: any, values: any[]) => { const i = ei++; if (!deps[i] || values.some((v, j) => v !== deps[i][j])) { deps[i] = values; effects.push(fn); } },
    });
    a.external('__window', { location: { assign: (url: string) => redirects.push(url) } });
    a.external('__fetch', async (url: string, init: any = {}) => {
        if (url === '/api/admin/autenticacao') return Response.json({ ok: true, data: { sessaoId: a.state.sessao.id, usuarioId: a.state.sessao.expirada ? null : 'usuario-unitario', csrf, contexto: { empresaAtual: { id: empresaA } } } });
        // Admin lê a agenda da empresa comprovada (062); a API pública (sem tenant) não é usada pelo wizard.
        assert(!url.startsWith('/api/disponibilidade'), 'wizard admin não usa a disponibilidade pública');
        if (url.startsWith('/api/admin/disponibilidade?')) return Response.json({ dias: [{ periodos: [{ codigo: 'TURNO_1', horarios: [{ inicio: '11:00', fim: '15:00', ajusteMinutos: 0, status: 'DISPONIVEL' }] }] }], unidades: [] });
        // Admin lê adicionais pela rota com Tenant Context; a pública (fechada desde a PR-A) não é usada.
        if (url.startsWith('/api/admin/fechamentos/adicionais?')) return Response.json({ adicionais: [] });
        assert(!url.startsWith('/api/fechamentos/adicionais'), 'wizard admin não usa a rota pública de adicionais');
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
        render(); await new Promise(resolve => setImmediate(resolve));
        assert(nodes(render()).some(n => n.type === 'option' && n.props.value === '11:00'), 'Horário 11:00 não carregou');
        field('Horário disponível', '11:00'); field('Aniversariante', aniversarianteId); field('Valor comercial proposto', '10000,00');
        await new Promise(resolve => setImmediate(resolve));
    }
    async function submit() { await nodes(render()).find(n => n.type === 'form').props.onSubmit({ preventDefault() {} }); }
    return { ...a, render, text, preencher, submit, redirects };
}

test('CRM → formulário administrativo → conclusão com GET/POST e núcleo reais, sem OTP', async () => {
    const profile = readFileSync('components/clientes/ClienteProfile.tsx', 'utf8');
    assert.match(profile, /href=\{`\/admin\/clientes\/\$\{clienteId\}\/fechamento`\}/);
    const a = await formulario(); await a.preencher(); await a.submit();
    assert.match(a.text(a.render()), /Revise antes de criar/);
    assert.equal(a.state.fechamentos.length, 0, 'A conferência não cria o fechamento.');
    await a.submit();
    assert.match(a.text(a.render()), /Fechamento criado/); assert.equal(a.state.fechamentos.length, 1);
    assert.equal(a.state.fechamentos[0].clienteId, clienteId);
});
test('sessão expirada durante preenchimento redireciona ao login sem POST de criação', async () => {
    const a = await formulario(); await a.preencher(); await a.submit(); a.state.sessao.expirada = true; await a.submit();
    assert.deepEqual(a.redirects, ['/admin/login']); assert.equal(a.state.fechamentos.length, 0);
    assert.match(a.text(a.render()), /Faça login para continuar/);
});

// PR-B1: contexto administrativo de fechamento escopado pelo tenant comprovado.
for (const [caso, empresaCliente] of [['de outra empresa', empresaB], ['legado sem empresa', null]] as const) {
    test(`cliente ${caso}: GET e POST respondem como inexistente, sem gravação`, async () => {
        const a = ambiente(); a.state.cliente.empresaId = empresaCliente;
        const get = await a.chamar(null, { method: 'GET' });
        assert.equal(get.status, 404);
        const corpo = JSON.stringify(await get.json());
        assert(!corpo.includes(a.state.cliente.nomeCompleto) && !corpo.includes(a.state.cliente.cpf));
        assert.equal((await a.chamar()).status, 404);
        assert.equal(a.state.fechamentos.length, 0); assert.equal(a.state.auditoria.length, 0);
    });
}
test('tenant não comprovado: nada é lido nem gravado', async () => {
    const a = ambiente(); a.state.tenantRecusado = true;
    for (const r of [await a.chamar(null, { method: 'GET' }), await a.chamar()]) {
        assert.equal(r.status, 403); assert.equal((await r.json()).codigo, 'TENANT_NAO_COMPROVADO');
    }
    assert.equal(a.state.fechamentos.length, 0); assert.equal(a.state.pricingInput, null); assert.equal(a.state.auditoria.length, 0);
});
test('cliente A com pacote só na empresa B: a busca da empresa comprovada não o encontra; nada é associado', async () => {
    const a = ambiente(); a.state.pacote.empresaId = empresaB;
    const r = await a.chamar();
    assert.equal(r.status, 404); assert.equal((await r.json()).erro, 'Pacote não disponível.');
    assert.deepEqual(a.state.consultasPacote, [{ empresaId: empresaA, codigo: 'POCKET' }]);
    assert.equal(a.state.fechamentos.length, 0); assert.equal(a.state.pricingInput, null);
});
test('pacote legado sem empresa: fora da busca da empresa comprovada; nada é associado', async () => {
    const a = ambiente(); a.state.pacote.empresaId = null;
    assert.equal((await a.chamar()).status, 404); assert.equal(a.state.fechamentos.length, 0);
});
test('busca de pacote pela empresa comprovada: vigente, ativo, não arquivado e sem ambiguidade; catálogo público segue recusado', async () => {
    const ok = ambiente();
    assert.equal((await ok.chamar()).status, 201);
    assert.deepEqual(ok.state.consultasPacote, [{ empresaId: empresaA, codigo: 'POCKET' }]);
    assert.equal(ok.state.pricingInput.pacoteId, 'pacote');
    const ajustes: Array<(s: any) => void> = [
        (s) => { s.pacote.ativo = false; }, (s) => { s.pacote.vigente = false; }, (s) => { s.pacote.arquivadoEm = '2026-01-01'; },
        (s) => { s.pacotesExtras.push({ ...s.pacote, id: 'pacote-duplicado' }); },
    ];
    for (const ajuste of ajustes) {
        const a = ambiente(); ajuste(a.state);
        assert.equal((await a.chamar()).status, 404); assert.equal(a.state.fechamentos.length, 0);
    }
    const repositorio = ok.load('lib/comercial/repositories/comercial.repository.ts');
    await assert.rejects(repositorio.buscarPacoteAtivoPorCodigo('POCKET'), (e: any) => e.code === 'CATALOGO_PUBLICO_INDETERMINADO');
    await assert.rejects(repositorio.buscarPacoteVigenteDaEmpresaPorCodigo('', 'POCKET', { query: async () => { throw Error('não deveria consultar'); } }), (e: any) => e.code === 'CATALOGO_PUBLICO_INDETERMINADO');
});
