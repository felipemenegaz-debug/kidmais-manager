import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Script de fixtures do painel em staging (scripts/fixture-painel-staging.cjs), sem banco: o cliente é falso e responde
 * por SQL. Prova trava de alvo, execução única, senhas sem eco e nunca impressas, precheck de fixtures livres, diagnóstico
 * só leitura, limpeza só do que foi criado aqui e conferência do encerramento. O caminho real de escrita (gatilhos,
 * constraints) é provado na suíte PostgreSQL (fixture-painel-staging.postgres.test.ts).
 */
const exigir = createRequire(import.meta.url);
type Res = Record<string, unknown> & { resultado: string };
const s = exigir('../../scripts/fixture-painel-staging.cjs') as {
    EMPRESAS: Array<{ id: string; codigo: string }>; CONTAS: Array<{ chave: string; id: string; email: string }>; VINCULOS: string[][]; ARQUIVO: string; RODADA: string;
    modo: (a: string[]) => string | null; alvo: (e: Record<string, string>) => unknown;
    criar: (a: Record<string, unknown>) => Promise<Res>; encerrar: (a: Record<string, unknown>) => Promise<Res>;
    conferirEncerramento: (a: Record<string, unknown>) => Promise<Res>; diagnosticar: (a: Record<string, unknown>) => Promise<Res>;
    desativar: (db: unknown, r: unknown, servicos: unknown) => Promise<string>;
    lerSenhaDoTerminal: (rotulo: string, o: { entrada: unknown; saida: unknown }) => Promise<string>;
};
const { SQL_IDENTIDADE } = exigir('../../scripts/conexao-staging.cjs') as { SQL_IDENTIDADE: string };

const ENV = {
    RENDER: 'true', RENDER_SERVICE_ID: 'srv-daif418ae00c73e8k2gg', KIDMAIS_DEPLOY_ENV: 'staging', ASAAS_AMBIENTE: 'sandbox', DATABASE_SSL: 'false',
    DATABASE_URL: 'postgresql://sintetico:sintetico@dpg-daidko3m8hqs73ce4jt0-a:5432/kidmais_staging_1z91',
};
const SENHA_A = 'senha-sintetica-A-123', SENHA_B = 'senha-sintetica-B-456';
const sem = () => {};

type Consulta = { t: string; v?: unknown[] };
function clienteFalso(opcoes: { ocupado?: boolean; conferencia?: Record<string, number>; perfil?: string | null } = {}) {
    const consultas: Consulta[] = [];
    function Cliente(this: unknown) { /* alvo recebido e descartado */ }
    Cliente.prototype.connect = async () => {};
    Cliente.prototype.end = async () => {};
    Cliente.prototype.query = async (t: string, v?: unknown[]) => {
        consultas.push({ t, v });
        if (t === SQL_IDENTIDADE) return { rows: [{ db: 'kidmais_staging_1z91', tls: false, servidor_privado: true }], rowCount: 1 };
        if (/AS ocupado/.test(t)) return { rows: [{ ocupado: opcoes.ocupado ?? false }], rowCount: 1 };
        if (/to_regclass\('public\.assinatura_isencoes'\)/.test(t)) return { rows: [{ ok: true }], rowCount: 1 };
        if (/AS empresas,/.test(t) && /md5/.test(t)) return { rows: [{ empresas: 'e', memberships: 'm', usuarios: 'u' }], rowCount: 1 };
        if (/count\(\*\)::int AS n FROM memberships/.test(t)) return { rows: [{ n: s.VINCULOS.length }], rowCount: 1 };
        if (/status='ATIVA' AS ativa/.test(t)) return { rows: [{ ativa: true }], rowCount: 1 };
        if (/empresas_nao_desativadas/.test(t)) return { rows: [opcoes.conferencia ?? { empresas_nao_desativadas: 0, vinculos_ativos: 0, contas_ativas: 0, sessoes_ativas: 0, concessoes_ativas: 0 }], rowCount: 1 };
        if (/^UPDATE sessoes_administrativas/.test(t)) return { rows: [{ id: 's1' }], rowCount: 1 };
        if (/gestoes_ativas/.test(t)) return { rows: [{ codigo: 'hml-x', gestoes_ativas: 1 }], rowCount: 1 };
        if (/count\(\*\)::int AS n FROM \(/.test(t)) return { rows: [{ n: 0 }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
    };
    return { Cliente, consultas };
}
const servicos = (perfil: string | null = 'perfil-p') => {
    const chamadas: Array<Record<string, unknown>> = [];
    return {
        chamadas,
        senhaValida: (x: string) => [...x].length >= 8,
        criarHashSenha: async (x: string) => `scrypt$sintetico$${x.length}`,
        perfilDoTenantOuNulo: async () => perfil,
        revogarConcessoesAtivasDoUsuario: async (_tx: unknown, input: Record<string, unknown>) => { chamadas.push(input); return [{ id: 'c' }]; },
    };
};
const leitor = (respostas: string[]) => { const fila = [...respostas]; let n = 0; const f = async () => { n++; return fila.shift() ?? ''; }; return Object.assign(f, { vezes: () => n }); };
const dir = () => mkdtempSync(join(tmpdir(), 'fixture-painel-'));
const estado = (d: string) => readFileSync(join(d, s.ARQUIVO), 'utf8');

test('flags: exatamente uma conhecida; outra, nenhuma ou duas → recusa', () => {
    assert.equal(s.modo(['--diagnosticar']), 'DIAGNOSTICAR');
    assert.equal(s.modo(['--criar-fixtures-painel-autorizado']), 'CRIAR');
    assert.equal(s.modo(['--encerrar-fixtures-painel-autorizado']), 'ENCERRAR');
    assert.equal(s.modo(['--conferir-encerramento']), 'CONFERIR');
    for (const a of [[], ['--criar'], ['--diagnosticar', '--conferir-encerramento']]) assert.equal(s.modo(a), null);
});

test('trava de alvo: fora do serviço/banco de staging, recusa', () => {
    assert.ok(s.alvo(ENV));
    for (const ruim of [{ RENDER: undefined }, { RENDER_SERVICE_ID: 'srv-outro' }, { KIDMAIS_DEPLOY_ENV: 'production' }, { ASAAS_AMBIENTE: 'desligado' },
        { DATABASE_URL: 'postgresql://x:y@outro-host:5432/kidmais_staging_1z91' }])
        assert.throws(() => s.alvo({ ...ENV, ...ruim } as Record<string, string>));
});

test('execução única: com estado anterior, recusa ANTES de pedir senha ou conectar', async () => {
    const d = dir(); writeFileSync(join(d, s.ARQUIVO), '{}');
    const { Cliente, consultas } = clienteFalso(); const ler = leitor([SENHA_A, SENHA_A, SENHA_B, SENHA_B]);
    await assert.rejects(s.criar({ env: ENV, Client: Cliente, servicos: servicos(), lerSenha: ler, dir: d, disco: sem }), /RODADA_EXISTENTE/);
    assert.equal(ler.vezes(), 0); assert.equal(consultas.length, 0);
});

test('senhas: diferentes, fora da regra ou iguais entre contas → recusa sem escrever estado nem conectar', async () => {
    const casos: Array<[string[], RegExp]> = [
        [[SENHA_A, 'outra-coisa-1'], /SENHAS_DIFERENTES/],
        [['curta', 'curta'], /SENHA_FORA_DA_REGRA/],
        [[SENHA_A, SENHA_A, SENHA_A, SENHA_A], /SENHAS_IGUAIS_ENTRE_CONTAS/],
    ];
    for (const [respostas, erro] of casos) {
        const d = dir(); const { Cliente, consultas } = clienteFalso();
        await assert.rejects(s.criar({ env: ENV, Client: Cliente, servicos: servicos(), lerSenha: leitor(respostas), dir: d, disco: sem }), erro);
        assert.equal(existsSync(join(d, s.ARQUIVO)), false); assert.equal(consultas.length, 0);
    }
});

test('fixture já existente no banco → FALHA no precheck, nenhum INSERT, nada a desativar', async () => {
    const d = dir(); const { Cliente, consultas } = clienteFalso({ ocupado: true });
    const r = await s.criar({ env: ENV, Client: Cliente, servicos: servicos(), lerSenha: leitor([SENHA_A, SENHA_A, SENHA_B, SENHA_B]), dir: d, disco: sem });
    assert.equal(r.resultado, 'FALHA'); assert.match(String((r.falha as { mensagem: string }).mensagem), /FIXTURE_PREEXISTENTE_S1/);
    assert.ok(!consultas.some((c) => /^INSERT/.test(c.t)), 'nenhum INSERT');
    assert.equal(r.encerramento, 'NADA_CRIADO_PELA_RODADA');
});

test('criação: contas, empresas, vínculos e isenções; senha e hash nunca saem no resultado nem no arquivo de estado', async () => {
    const d = dir(); const { Cliente, consultas } = clienteFalso();
    const r = await s.criar({ env: ENV, Client: Cliente, servicos: servicos(), lerSenha: leitor([SENHA_A, SENHA_A, SENHA_B, SENHA_B]), dir: d, disco: sem });
    assert.equal(r.resultado, 'PASS'); assert.equal(r.preservacao, 'IGUAL');
    const inserts = consultas.filter((c) => /^INSERT/.test(c.t)).map((c) => c.t.match(/^INSERT INTO (\w+)/)![1]);
    assert.deepEqual(inserts.reduce((a: Record<string, number>, t) => ({ ...a, [t]: (a[t] ?? 0) + 1 }), {}),
        { empresas: 3, usuarios_administrativos: 2, memberships: 4, assinatura_isencoes: 3 });
    assert.ok(!consultas.some((c) => /perfil_empresas|perfil_empresa_concessoes|cobranca|empresa_assinaturas/.test(c.t) && /^INSERT|^UPDATE/.test(c.t)), 'nenhum Perfil, concessão ou cobrança criados');
    const texto = JSON.stringify(r) + estado(d);
    for (const segredo of [SENHA_A, SENHA_B, 'scrypt$']) assert.ok(!texto.includes(segredo), `não vaza ${segredo.slice(0, 6)}…`);
    const hashes = consultas.filter((c) => /^INSERT INTO usuarios_administrativos/.test(c.t)).map((c) => (c.v as string[])[3]);
    assert.deepEqual(hashes, [`scrypt$sintetico$${SENHA_A.length}`, `scrypt$sintetico$${SENHA_B.length}`], 'o banco recebe só o hash');
    // repetição: a segunda execução recusa.
    await assert.rejects(s.criar({ env: ENV, Client: Cliente, servicos: servicos(), lerSenha: leitor([]), dir: d, disco: sem }), /RODADA_EXISTENTE/);
});

test('diagnóstico: só leitura (BEGIN READ ONLY … ROLLBACK), sem INSERT/UPDATE e sem e-mail no resultado', async () => {
    const { Cliente, consultas } = clienteFalso();
    const r = await s.diagnosticar({ env: ENV, Client: Cliente });
    assert.equal(r.resultado, 'DIAGNOSTICO'); assert.equal(r.fixturesDestaRodadaLivres, true);
    assert.ok(consultas.some((c) => c.t === 'BEGIN READ ONLY') && consultas.some((c) => c.t === 'ROLLBACK'));
    assert.ok(!consultas.some((c) => /^\s*(INSERT|UPDATE|DELETE)/.test(c.t)));
    assert.ok(!JSON.stringify(r).includes('@'));
});

test('limpeza: sem prova de autoria não toca nada; com prova, revoga concessões, sessões, suspende vínculos, inativa contas e desativa empresas', async () => {
    const { Cliente, consultas } = clienteFalso(); const db = new (Cliente as unknown as new () => { query: (t: string, v?: unknown[]) => Promise<unknown> })();
    assert.equal(await s.desativar(db, { rodada: 'outra' }, servicos()), 'NADA_CRIADO_PELA_RODADA');
    assert.equal(consultas.length, 0);
    const sv = servicos('perfil-p');
    const r = { rodada: s.RODADA, precheck: { livres: true }, intencao: true } as Record<string, unknown>;
    assert.equal(await s.desativar(db, r, sv), 'DESATIVADAS');
    const ups = consultas.filter((c) => /^UPDATE/.test(c.t)).map((c) => c.t.match(/^UPDATE (\w+)/)![1]);
    assert.deepEqual(ups, ['sessoes_administrativas', 'memberships', 'usuarios_administrativos', 'empresas']);
    assert.ok(consultas.every((c) => !/^UPDATE/.test(c.t) || JSON.stringify(c.v).includes(s.EMPRESAS[0].id) || JSON.stringify(c.v).includes(s.CONTAS[0].id)), 'todo UPDATE filtra pelos ids das fixtures');
    assert.ok(!consultas.some((c) => /DELETE/.test(c.t)), 'nada é apagado');
    assert.equal(sv.chamadas.length, s.CONTAS.length * 3, 'concessões revogadas por conta e por Perfil associado');
    assert.ok(sv.chamadas.every((x) => x.empresaId === 'perfil-p'), 'revogação pelo id do PERFIL');
});

test('encerrar e conferir: VERIFICADO só com tudo zerado; qualquer resto → DIVERGENTE', async () => {
    const d = dir(); writeFileSync(join(d, s.ARQUIVO), JSON.stringify({ rodada: s.RODADA, precheck: { livres: true }, intencao: true }));
    const { Cliente } = clienteFalso();
    assert.equal((await s.encerrar({ env: ENV, Client: Cliente, servicos: servicos(), dir: d, disco: sem })).resultado, 'ENCERRADO');
    assert.equal((await s.conferirEncerramento({ env: ENV, Client: Cliente, dir: d, disco: sem })).resultado, 'VERIFICADO');
    const resto = clienteFalso({ conferencia: { empresas_nao_desativadas: 0, vinculos_ativos: 0, contas_ativas: 0, sessoes_ativas: 1, concessoes_ativas: 0 } });
    assert.equal((await s.conferirEncerramento({ env: ENV, Client: resto.Cliente, dir: d, disco: sem })).resultado, 'DIVERGENTE');
    const vazio = dir();
    await assert.rejects(s.encerrar({ env: ENV, Client: Cliente, servicos: servicos(), dir: vazio, disco: sem }), /SEM_FIXTURES_PARA_ENCERRAR/);
});

test('senha no terminal: sem TTY recusa; com TTY lê sem eco (o que é digitado não aparece na saída)', async () => {
    await assert.rejects(s.lerSenhaDoTerminal('x', { entrada: { isTTY: false }, saida: { write: sem } }), /SEM_TERMINAL/);
    const entrada = Object.assign(new EventEmitter(), { isTTY: true, raw: false, setRawMode(v: boolean) { this.raw = v; }, setEncoding: sem, resume: sem, pause: sem });
    let escrito = '';
    const p = s.lerSenhaDoTerminal('Senha', { entrada, saida: { write: (t: string) => { escrito += t; } } });
    entrada.emit('data', 'segredoX'); entrada.emit('data', '\u007f'); entrada.emit('data', 'Y\r');
    assert.equal(await p, 'segredoY');
    assert.ok(!escrito.includes('segredo'), 'nada digitado é ecoado');
    assert.equal(entrada.raw, false, 'o terminal volta ao modo normal');
});
