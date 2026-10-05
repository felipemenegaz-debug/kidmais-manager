import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { carregarModulo, executorFalso } from './teste-carregador.ts';

/**
 * Fluxos de acesso sem banco: validação, porta de e-mail, IP confiável, troca da própria senha e recuperação.
 * O banco é sempre dublado (executorFalso); nenhum e-mail real é enviado.
 */
type Mod = Record<string, (...args: never[]) => unknown>;
const dubleBanco = { 'db/postgres': { db: () => { throw new Error('sem banco'); }, withTransaction: () => { throw new Error('sem banco'); } } };
const json = (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => new Response(JSON.stringify(body), { status: init?.status ?? 200, headers: init?.headers });
const dubleNext = { 'next/server': { NextResponse: { json } } };
const auditoriaFalsa = () => {
    const registros: Array<Record<string, unknown>> = [];
    return { registros, registrar: async (input: Record<string, unknown>) => { registros.push(input); return input; } };
};

const validacao = carregarModulo('lib/acessos/validacao.ts', {}) as Mod;
const email = carregarModulo('lib/acessos/email.ts', {}) as Mod;
const http = carregarModulo('lib/acessos/http.ts', { ...dubleNext }) as Mod;

test('documento fiscal: CPF e CNPJ (inclusive alfanumérico) com DV; inválido recusado com mensagem de campo', () => {
    const doc = validacao.normalizarDocumentoFiscal as (v: string | null) => string | null;
    assert.equal(doc('529.982.247-25'), '52998224725');
    assert.equal(doc('11.222.333/0001-81'), '11222333000181');
    assert.equal(doc('12.ABC.345/01DE-35'), '12ABC34501DE35');
    assert.equal(doc(''), null);
    assert.throws(() => doc('111.111.111-11'), /CPF ou CNPJ inválido/);
    assert.throws(() => doc('11.222.333/0001-80'), /CPF ou CNPJ inválido/);
    assert.throws(() => doc('00.000.000/0000-00'), /CPF ou CNPJ inválido/);
});

test('telefone: DDD obrigatório; só dígitos; e-mail e documento mascarados para resposta e auditoria', () => {
    const tel = validacao.normalizarTelefone as (v: string | null) => string | null;
    assert.equal(tel('(11) 98765-4321'), '11987654321');
    assert.equal(tel('+55 11 3333-4444'), '551133334444');
    assert.equal(tel(null), null);
    assert.throws(() => tel('98765-4321'), /Telefone inválido/);
    assert.equal((validacao.mascararEmail as (e: string) => string)('fulana@exemplo.test'), 'f***@exemplo.test');
    assert.equal((validacao.mascararDocumento as (d: string) => string)('11222333000181'), '**********0181');
});

test('código da empresa sugerido a partir do nome cabe no formato do banco (031)', () => {
    const sugerir = validacao.sugerirCodigoEmpresa as (n: string) => string;
    const formato = validacao.CODIGO_EMPRESA as unknown as RegExp;
    for (const nome of ['Buffet Alegria & Cia', 'Ação Infantil', '123 Festas', 'X', 'Ç']) {
        const codigo = sugerir(nome);
        assert.match(codigo, formato, `${nome} → ${codigo}`);
    }
    assert.equal(sugerir('Buffet Alegria & Cia'), 'buffet-alegria-cia');
});

test('e-mail: desativado por padrão; provedor de arquivo recusado em deploy (Render/staging/production); envio real exige credencial e remetente', () => {
    const situacao = email.situacaoEmail as (env: Record<string, string | undefined>) => { configurado: boolean; provedor: string; motivo: string | null };
    assert.deepEqual(situacao({}).configurado, false);
    assert.equal(situacao({}).provedor, 'desativado');
    assert.equal(situacao({ EMAIL_PROVIDER: 'arquivo', EMAIL_ARQUIVO_DIR: path.resolve('tmp'), RENDER: 'true' }).configurado, false);
    assert.equal(situacao({ EMAIL_PROVIDER: 'arquivo', EMAIL_ARQUIVO_DIR: path.resolve('tmp'), KIDMAIS_DEPLOY_ENV: 'staging' }).configurado, false);
    assert.equal(situacao({ EMAIL_PROVIDER: 'arquivo', EMAIL_ARQUIVO_DIR: path.resolve('tmp'), NODE_ENV: 'production' }).configurado, false);
    assert.equal(situacao({ EMAIL_PROVIDER: 'arquivo', EMAIL_ARQUIVO_DIR: 'relativo' }).configurado, false);
    assert.equal(situacao({ EMAIL_PROVIDER: 'arquivo', EMAIL_ARQUIVO_DIR: path.resolve('tmp') }).configurado, true);
    assert.equal(situacao({ EMAIL_PROVIDER: 'resend', EMAIL_REMETENTE: 'Kidmais <nao-responda@exemplo.test>' }).configurado, false);
    assert.equal(situacao({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 'chave-sintetica', EMAIL_REMETENTE: 'Kidmais <nao-responda@exemplo.test>' }).configurado, true);
    const resumo = JSON.stringify(situacao({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 'chave-sintetica', EMAIL_REMETENTE: 'x' }));
    assert.doesNotMatch(resumo, /chave-sintetica/, 'situação nunca expõe a credencial');
});

test('e-mail: desativado recusa com EMAIL_NAO_CONFIGURADO; arquivo grava só localmente; provedor real recusado vira erro genérico sem corpo no log', async () => {
    const criar = email.criarEnviarEmail as (env: Record<string, string>, f?: typeof fetch) => (m: Record<string, string>) => Promise<{ provedor: string }>;
    const mensagem = { para: 'pessoa@exemplo.test', assunto: 'a', texto: 'link #t=segredo', html: '<p>x</p>' };
    await assert.rejects(criar({})(mensagem), (e: { code?: string }) => e.code === 'EMAIL_NAO_CONFIGURADO');
    const dir = mkdtempSync(path.join(tmpdir(), 'kidmais-email-'));
    try {
        const r = await criar({ EMAIL_PROVIDER: 'arquivo', EMAIL_ARQUIVO_DIR: dir })(mensagem);
        assert.equal(r.provedor, 'arquivo');
        const arquivos = readdirSync(dir);
        assert.equal(arquivos.length, 1);
        assert.equal(JSON.parse(readFileSync(path.join(dir, arquivos[0]), 'utf8')).para, 'pessoa@exemplo.test');
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
    const avisos: string[] = [];
    const original = console.warn;
    console.warn = (m: string) => { avisos.push(String(m)); };
    try {
        const recusado = criar({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 'k', EMAIL_REMETENTE: 'a@exemplo.test' }, (async () => new Response('{}', { status: 422 })) as typeof fetch);
        await assert.rejects(recusado(mensagem), (e: { code?: string; message: string }) => e.code === 'EMAIL_FALHOU' && !e.message.includes('segredo'));
        const sem = criar({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: 'k', EMAIL_REMETENTE: 'a@exemplo.test' }, (async () => { throw new Error('rede'); }) as typeof fetch);
        await assert.rejects(sem(mensagem), (e: { code?: string }) => e.code === 'EMAIL_FALHOU');
    }
    finally {
        console.warn = original;
    }
    assert.ok(avisos.every((a) => !a.includes('segredo') && !a.includes('pessoa@')), 'log sem corpo nem destinatário');
});

test('link com token vai no fragmento (#), nunca na query; origem é a administrativa', () => {
    const link = (email.linkComToken as (c: string, t: string, o: string) => string)('/acesso/redefinir', 'A'.repeat(43), 'https://admin.exemplo.test');
    assert.equal(link, `https://admin.exemplo.test/acesso/redefinir#t=${'A'.repeat(43)}`);
    assert.doesNotMatch(link, /\?/);
});

test('IP confiável: só no Render e só o ÚLTIMO valor do X-Forwarded-For (o início pode vir do cliente)', () => {
    const ip = http.ipDaRequisicao as (r: { headers: { get(n: string): string | null } }, env: { RENDER?: string }) => string | null;
    const req = (xff: string | null) => ({ headers: { get: (n: string) => (n === 'x-forwarded-for' ? xff : null) } });
    assert.equal(ip(req('1.2.3.4, 10.0.0.9'), { RENDER: 'true' }), '10.0.0.9');
    assert.equal(ip(req('1.2.3.4'), {}), null, 'fora do deploy não há proxy confiável');
    assert.equal(ip(req('nao-e-ip'), { RENDER: 'true' }), null);
    assert.equal(ip(req(null), { RENDER: 'true' }), null);
});

test('respostas de erro: tabela ausente vira 503 explícito; erro desconhecido não vaza detalhe', async () => {
    const falhar = http.falhar as (e: unknown) => Response;
    const r503 = falhar(Object.assign(new Error('relation "convites_acesso" does not exist'), { code: '42P01' }));
    assert.equal(r503.status, 503);
    assert.match(JSON.stringify(await r503.json()), /estrutura de recuperação de senha/);
    const original = console.error;
    console.error = () => undefined;
    try {
        const r500 = falhar(new Error('detalhe interno com senha=123'));
        assert.equal(r500.status, 500);
        assert.doesNotMatch(JSON.stringify(await r500.json()), /senha=123/);
    }
    finally {
        console.error = original;
    }
});

// ---------------------------------------------------------------- troca da própria senha

function depsTroca(opcoes: { limiteOk?: boolean; senhaConfere?: boolean } = {}) {
    const auditoria = auditoriaFalsa();
    const tx = executorFalso([[/SELECT senha_hash FROM usuarios_administrativos/, () => [{ senha_hash: 'hash-atual' }]]]);
    const chamadas: string[] = [];
    const deps = {
        withTransaction: async (work: (t: typeof tx) => Promise<unknown>) => work(tx),
        criarHashSenha: async () => 'hash-novo',
        conferirSenha: async () => opcoes.senhaConfere ?? true,
        registrarAuditoria: auditoria.registrar,
        consultarSessao: async () => ({ id: 's1', usuario_id: '00000000-0000-4000-8000-000000000001', nome: 'P', cargo: null, papel: 'ADMINISTRATIVO', autenticado_em: '', expira_em: '', csrf_hash: '' }),
        consumirLimite: async () => opcoes.limiteOk ?? true,
        limparLimite: async () => { chamadas.push('limpar'); },
        criarSessaoAdministrativa: async () => { chamadas.push('nova-sessao'); return { id: 's2', token: 'TOKEN-NOVO', csrf: 'CSRF-NOVO', expires: new Date() }; },
        revogarSessoesDoUsuario: async () => { chamadas.push('revogar'); return 3; },
    };
    return { deps, tx, auditoria, chamadas };
}
const senhaPropria = carregarModulo('lib/acessos/senha-propria.ts', { ...dubleBanco }) as Mod;
const trocar = senhaPropria.trocarPropriaSenha as (token: string, raw: unknown, ctx: unknown, deps: unknown) => Promise<{ token: string; csrf: string; sessoesEncerradas: number }>;
const ctx = { requestId: '00000000-0000-4000-8000-0000000000aa', ip: null, userAgent: 'teste' };

test('troca de senha: confirmação, política (8–128) e "diferente da atual" são recusadas antes de qualquer acesso ao banco', async () => {
    for (const [raw, msg] of [
        [{ senhaAtual: 'atual-123', novaSenha: 'nova-senha-1', confirmacao: 'outra-senha' }, /não conferem/],
        [{ senhaAtual: 'atual-123', novaSenha: 'curta', confirmacao: 'curta' }, /entre 8 e 128/],
        [{ senhaAtual: 'mesma-senha', novaSenha: 'mesma-senha', confirmacao: 'mesma-senha' }, /diferente da atual/],
        [{ senhaAtual: 'atual-123', novaSenha: 'x'.repeat(129), confirmacao: 'x'.repeat(129) }, /entre 8 e 128/],
    ] as const) {
        const { deps, tx } = depsTroca();
        await assert.rejects(trocar('t', raw, ctx, deps), msg);
        assert.equal(tx.executados.length, 0);
    }
});

test('troca de senha: senha atual errada audita a recusa (sem segredo) e não troca nada; limite estourado responde 429', async () => {
    const errada = depsTroca({ senhaConfere: false });
    await assert.rejects(trocar('t', { senhaAtual: 'errada-123', novaSenha: 'nova-senha-1', confirmacao: 'nova-senha-1' }, ctx, errada.deps), (e: { code?: string }) => e.code === 'SENHA_ATUAL_INCORRETA');
    assert.equal(errada.auditoria.registros[0].acao, 'SENHA_TROCA_RECUSADA');
    assert.ok(!errada.tx.executados.some((q) => /UPDATE usuarios_administrativos/.test(q.sql)));
    assert.deepEqual(errada.chamadas, []);
    const limite = depsTroca({ limiteOk: false });
    await assert.rejects(trocar('t', { senhaAtual: 'atual-123', novaSenha: 'nova-senha-1', confirmacao: 'nova-senha-1' }, ctx, limite.deps), (e: { httpStatus?: number }) => e.httpStatus === 429);
});

test('troca de senha: sucesso grava o hash novo, encerra TODAS as sessões, emite sessão nova e audita sem senha/hash/token', async () => {
    const { deps, tx, auditoria, chamadas } = depsTroca();
    const r = await trocar('t', { senhaAtual: 'atual-1234', novaSenha: 'nova-senha-1', confirmacao: 'nova-senha-1' }, ctx, deps);
    assert.equal(r.token, 'TOKEN-NOVO');
    assert.equal(r.sessoesEncerradas, 3);
    const update = tx.executados.find((q) => /UPDATE usuarios_administrativos SET senha_hash/.test(q.sql));
    assert.ok(update && /senha_alterada_em=clock_timestamp\(\)/.test(update.sql));
    assert.deepEqual(update!.params, ['00000000-0000-4000-8000-000000000001', 'hash-novo']);
    assert.deepEqual(chamadas, ['revogar', 'limpar', 'nova-sessao'], 'revoga antes de emitir a sessão nova');
    const textoAuditoria = JSON.stringify(auditoria.registros);
    assert.equal(auditoria.registros.at(-1)!.acao, 'SENHA_ALTERADA');
    for (const proibido of ['atual-1234', 'nova-senha-1', 'hash-novo', 'hash-atual', 'TOKEN-NOVO', 'CSRF-NOVO'])
        assert.doesNotMatch(textoAuditoria, new RegExp(proibido));
});

// ---------------------------------------------------------------- recuperação

const recuperacao = carregarModulo('lib/acessos/recuperacao.ts', { ...dubleBanco }) as Mod;

test('recuperação pública: corpo inválido é recusado; resposta pública é sempre a mesma mensagem neutra', () => {
    const validar = recuperacao.validarPedidoPublico as (raw: unknown) => { email: string };
    assert.throws(() => validar({ email: 'nao-e-email' }), /e-mail válido/);
    assert.throws(() => validar({ email: 'a@b.test', extra: 1 }), /e-mail válido/);
    assert.deepEqual(validar({ email: '  Pessoa@Exemplo.TEST ' }), { email: 'pessoa@exemplo.test' });
    assert.match(String(recuperacao.MENSAGEM_PEDIDO_PUBLICO), /Se houver uma conta ativa/);
});

test('recuperação: envio que falha invalida o pedido (nenhum link fica valendo sem entrega) e não lança', async () => {
    const tx = executorFalso([]);
    const enviar = recuperacao.enviarPedido as (deps: unknown, p: unknown, email: string) => Promise<{ enviado: boolean; motivo?: string; destino: string }>;
    const r = await enviar({
        withTransaction: async (w: (t: typeof tx) => Promise<unknown>) => w(tx),
        enviarEmail: async () => { throw new Error('provedor fora do ar'); },
    }, { pedidoId: 'p1', token: 'T'.repeat(43) }, 'pessoa@exemplo.test');
    assert.equal(r.enviado, false);
    assert.equal(r.destino, 'p***@exemplo.test');
    assert.match(String(r.motivo), /Nada foi enviado/, 'erro inesperado vira motivo genérico');
    assert.ok(tx.executados.some((q) => /UPDATE recuperacoes_senha SET invalidado_em/.test(q.sql) && q.params[0] === 'p1'));
});

test('redefinição: token malformado responde "link inválido" sem tocar no banco nem calcular hash', async () => {
    const redefinir = recuperacao.redefinirSenhaComToken as (raw: unknown, ctx: unknown, deps: unknown) => Promise<unknown>;
    let hash = 0;
    const deps = { withTransaction: async () => { throw new Error('não deveria abrir transação'); }, criarHashSenha: async () => { hash += 1; return 'h'; }, registrarAuditoria: async () => undefined, enviarEmail: async () => undefined, gerarToken: () => 'x' };
    await assert.rejects(redefinir({ token: 'curto', novaSenha: 'nova-senha-1', confirmacao: 'nova-senha-1' }, ctx, deps), (e: { code?: string; httpStatus?: number }) => e.code === 'LINK_INVALIDO' && e.httpStatus === 410);
    assert.equal(hash, 0);
});

// ---------------------------------------------------------------- custo do hash antes do limite

test('custo do hash: troca de senha só calcula scrypt depois de sessão, limite e senha atual conferidos', async () => {
    let hashes = 0;
    for (const opcoes of [{ limiteOk: false }, { senhaConfere: false }]) {
        const { deps } = depsTroca(opcoes);
        await assert.rejects(trocar('t', { senhaAtual: 'atual-123', novaSenha: 'nova-senha-1', confirmacao: 'nova-senha-1' }, ctx, { ...deps, criarHashSenha: async () => { hashes += 1; return 'h'; } }));
    }
    assert.equal(hashes, 0);
});

function depsRedefinir(opcoes: { limiteOk: boolean; pedido: boolean }) {
    let hashes = 0;
    const tx = executorFalso([
        [/SELECT tentativas/, () => [{ tentativas: opcoes.limiteOk ? 0 : 99, bloqueado: !opcoes.limiteOk, reiniciar: false }]],
        [/FROM recuperacoes_senha r JOIN usuarios_administrativos/, () => (opcoes.pedido ? [{ id: 'p1', usuario_id: '00000000-0000-4000-8000-000000000001', origem: 'PUBLICA' }] : [])],
        [/UPDATE sessoes_administrativas/, () => [{ id: 's' }]],
    ]);
    return {
        tx, contar: () => hashes,
        deps: { withTransaction: async (w: (t: typeof tx) => Promise<unknown>) => w(tx), criarHashSenha: async () => { hashes += 1; return 'hash-novo'; }, registrarAuditoria: async () => undefined, enviarEmail: async () => undefined, gerarToken: () => 'x' },
    };
}

test('custo do hash: redefinição pública não calcula scrypt acima do limite nem para token inexistente; calcula uma vez para token válido', async () => {
    process.env.ADMIN_AUTH_SECRET = 'segredo-sintetico-de-teste-unitario-0123456789';
    const redefinir = recuperacao.redefinirSenhaComToken as (raw: unknown, ctx: unknown, deps: unknown) => Promise<{ redefinida: boolean }>;
    const corpo = { token: 'A'.repeat(43), novaSenha: 'nova-senha-1', confirmacao: 'nova-senha-1' };
    const limite = depsRedefinir({ limiteOk: false, pedido: true });
    await assert.rejects(redefinir(corpo, ctx, limite.deps), (e: { httpStatus?: number }) => e.httpStatus === 429);
    assert.equal(limite.contar(), 0);
    assert.ok(!limite.tx.executados.some((q) => /recuperacoes_senha/.test(q.sql)), 'acima do limite nem consulta o token');
    const falso = depsRedefinir({ limiteOk: true, pedido: false });
    await assert.rejects(redefinir(corpo, ctx, falso.deps), (e: { code?: string }) => e.code === 'LINK_INVALIDO');
    assert.equal(falso.contar(), 0);
    const valido = depsRedefinir({ limiteOk: true, pedido: true });
    assert.equal((await redefinir(corpo, ctx, valido.deps)).redefinida, true);
    assert.equal(valido.contar(), 1);
    const ordem = valido.tx.executados.map((q) => q.sql);
    assert.ok(ordem.findIndex((s) => /SELECT tentativas/.test(s)) < ordem.findIndex((s) => /FROM recuperacoes_senha r/.test(s)), 'limite antes do token');
});
