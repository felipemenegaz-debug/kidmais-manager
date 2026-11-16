import assert from 'node:assert/strict';
import test from 'node:test';
import { carregarModulo } from '../acessos/teste-carregador.ts';
import type * as F from './fila-logo.ts';

/**
 * Fila da logo (plano etapa 3 r15.1, §5 e §9 "Fila da logo"): sem navegador, com servidor simulado em memória que segue
 * a regra de sessões e seq do §1 (lista de 20, substitui, registro por campo e por arte, artes ausentes ignoradas).
 * Toda chamada passa por um transporte que falha o teste se a mesma instância tiver dois envios em voo.
 */
type Corpo = { acao: string; sessao?: string; seq?: number; substitui?: string; mostrar?: boolean; posicoes?: F.PosicaoLogoEnvio[] };
type Resp = Awaited<ReturnType<F.Transporte>>;

function modulo(dubles: Record<string, unknown> = {}) {
    return carregarModulo('lib/convites/fila-logo.ts', { 'lib/http/admin-fetch': { adminFetch: () => { throw Error('sem adminFetch'); } }, ...dubles }) as unknown as typeof F;
}
const esvaziar = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
const P = (arteId: string, x = 50): F.PosicaoLogoEnvio => ({ modo: 'sobre', arteId, x, y: 50, largura: 18, fundo: false });
const CHAVE = 'iafest:logo-sessao:conv';

class Servidor {
    sessoes: { id: string; mostrar?: number; posicoes: Record<string, number> }[] = [];
    mostrar: boolean | undefined;
    posicoes: Record<string, F.PosicaoLogoEnvio> = {};
    artes = new Set(['A', 'B', 'C', 'D', 'E', 'F']);
    emitidos: string[] = [];
    private n = 0;
    abrir(substitui?: string): Resp {
        if (substitui) this.sessoes = this.sessoes.filter((s) => s.id !== substitui);
        const id = `S${++this.n}`;
        this.sessoes.push({ id, posicoes: {} });
        if (this.sessoes.length > 20) this.sessoes.shift();
        this.emitidos.push(id);
        return { status: 200, data: { logoSessao: id } };
    }
    processar(c: Corpo): Resp {
        if (c.acao === 'logo_sessao') return this.abrir(c.substitui);
        const s = this.sessoes.find((x) => x.id === c.sessao);
        if (!s) return { status: 409, codigo: 'sessao_expirada' };
        const aplicado: { mostrar?: boolean; posicoes?: Record<string, boolean> } = {};
        const artesAusentes: string[] = [];
        if (c.mostrar !== undefined) {
            aplicado.mostrar = (s.mostrar ?? 0) < c.seq!;
            if (aplicado.mostrar) { this.mostrar = c.mostrar; s.mostrar = c.seq; }
        }
        for (const p of c.posicoes ?? []) {
            assert.equal('origem' in p, false, 'posição sem origem');
            if ((s.posicoes[p.arteId] ?? 0) >= c.seq!) { (aplicado.posicoes ??= {})[p.arteId] = false; continue; }
            if (!this.artes.has(p.arteId)) { artesAusentes.push(p.arteId); continue; }
            (aplicado.posicoes ??= {})[p.arteId] = true;
            this.posicoes[p.arteId] = p;
            s.posicoes[p.arteId] = c.seq!;
        }
        return { status: 200, data: { aplicado, artesAusentes } };
    }
}

type Chamada = { nome: string; corpo: Corpo; resultado?: Resp; processar(): Resp; entregar(r?: Resp): void; falhar(e: unknown): void };
type Regra = 'auto' | 'segurar' | 'processar-segurar' | Resp | { erro: unknown } | ((c: Chamada) => void);
class Rede {
    servidor = new Servidor();
    chamadas: Chamada[] = [];
    linha: string[];
    private emVoo = new Map<string, number>();
    private regras = new Map<string, Regra[]>();
    constructor(linha: string[] = []) { this.linha = linha; }
    regra(nome: string, ...r: Regra[]) { this.regras.set(nome, [...(this.regras.get(nome) ?? []), ...r]); }
    transporte(nome: string): F.Transporte {
        return (corpo) => new Promise<Resp>((resolver, rejeitar) => {
            const c = corpo as Corpo;
            const n = (this.emVoo.get(nome) ?? 0) + 1;
            assert.ok(n <= 1, `${nome}: dois envios em voo`);
            this.emVoo.set(nome, n);
            this.linha.push(`${nome} POST ${c.acao}`);
            let encerrada = false;
            const fim = () => { assert.equal(encerrada, false); encerrada = true; this.emVoo.set(nome, this.emVoo.get(nome)! - 1); };
            const ch: Chamada = {
                nome, corpo: JSON.parse(JSON.stringify(c)) as Corpo,
                processar: () => (ch.resultado = this.servidor.processar(ch.corpo)),
                entregar: (r) => { fim(); resolver(r ?? ch.resultado ?? ch.processar()); },
                falhar: (e) => { fim(); rejeitar(e); },
            };
            this.chamadas.push(ch);
            const regra = this.regras.get(nome)?.shift() ?? 'auto';
            if (regra === 'auto') { ch.processar(); queueMicrotask(() => ch.entregar()); }
            else if (regra === 'segurar') { /* o teste decide */ }
            else if (regra === 'processar-segurar') ch.processar();
            else if (typeof regra === 'function') regra(ch);
            else if ('erro' in regra) queueMicrotask(() => ch.falhar(regra.erro));
            else queueMicrotask(() => ch.entregar(regra as Resp));
        });
    }
    de(nome: string) { return this.chamadas.filter((c) => c.nome === nome); }
    acoes(nome: string) { return this.de(nome).map((c) => c.corpo.acao === 'logo_sessao' ? 'sessao' : 'buffet'); }
    ultima(nome: string) { return this.de(nome).at(-1)!; }
}

class Aba {
    mapa = new Map<string, string>();
    falhaLer = false; falhaEscrever = false; falhaRemover = false;
    linha: string[];
    constructor(linha: string[]) { this.linha = linha; }
    para(dono: string): F.ArmazenamentoAba {
        return {
            getItem: (k) => { if (this.falhaLer) throw Error('bloqueado'); return this.mapa.get(k) ?? null; },
            setItem: (k, v) => { this.linha.push(`${dono} set`); if (this.falhaEscrever) throw Error('cheio'); this.mapa.set(k, v); },
            removeItem: (k) => { this.linha.push(`${dono} remove`); if (this.falhaRemover) throw Error('bloqueado'); this.mapa.delete(k); },
        };
    }
    duplicar() { const a = new Aba(this.linha); a.mapa = new Map(this.mapa); return a; }
    dono() { const v = this.mapa.get(CHAVE); return v ? JSON.parse(v) as { id: string; dono: string } : null; }
}

function relogio() {
    let agora = 0;
    const timers: { fn: () => void; em: number; ativo: boolean }[] = [];
    return {
        agendar: (fn: () => void, ms: number) => { const t = { fn, em: agora + ms, ativo: true }; timers.push(t); return t; },
        cancelar: (h: unknown) => { (h as { ativo: boolean }).ativo = false; },
        async avancar(ms: number) {
            agora += ms;
            for (const t of timers) if (t.ativo && t.em <= agora) { t.ativo = false; t.fn(); }
            await esvaziar();
        },
    };
}

function cenario() {
    const M = modulo();
    const linha: string[] = [];
    const rede = new Rede(linha);
    const aba = new Aba(linha);
    const clock = relogio();
    const criar = (nome: string, a: Aba | null = aba) => M.criarFilaLogo({ conviteId: 'conv', transporte: rede.transporte(nome), armazenamento: a ? a.para(nome) : null, geracao: nome, agendar: clock.agendar, cancelar: clock.cancelar });
    return { M, rede, aba, clock, criar, linha };
}
/** Preparação comum: a primeira mudança já abriu a sessão e gravou (2 POSTs). */
async function preparada(nome = 'X') {
    const c = cenario();
    const fila = c.criar(nome);
    fila.posicao(P('F', 1));
    await esvaziar();
    assert.deepEqual(c.rede.acoes(nome), ['sessao', 'buffet']);
    assert.equal(fila.estado().situacao, 'salvo');
    return { ...c, fila };
}
const ErroCtx = (tipo: string) => Object.assign(new Error(tipo), { tipo, enviado: true });

test('abrir a fila não chama nada; a primeira mudança abre a sessão, grava o id na aba e só então envia', async () => {
    const { rede, criar, aba, linha } = cenario();
    const fila = criar('X');
    await esvaziar();
    assert.equal(rede.chamadas.length, 0);
    assert.equal(fila.estado().situacao, 'ocioso');
    fila.posicao(P('A', 10));
    assert.equal(fila.temPendencia(), true);
    await esvaziar();
    assert.deepEqual(linha, ['X POST logo_sessao', 'X set', 'X POST logo_buffet']);
    assert.deepEqual(aba.dono(), { id: 'S1', dono: 'X' });
    assert.deepEqual(rede.ultima('X').corpo, { acao: 'logo_buffet', sessao: 'S1', seq: 1, posicoes: [P('A', 10)] });
    assert.equal(rede.de('X')[0].corpo.substitui, undefined);
    assert.deepEqual(rede.servidor.posicoes.A, P('A', 10));
    assert.equal(fila.estado().situacao, 'salvo');
    assert.equal(fila.temPendencia(), false);
});

test('um envio em voo: três intenções intercaladas viram um comando com mostrar:true + posição', async () => {
    const { rede, fila } = await preparada();
    rede.regra('X', 'segurar');
    fila.mostrar(false);
    await esvaziar();
    fila.mostrar(false); fila.posicao(P('A', 30)); fila.mostrar(true);
    await esvaziar();
    assert.equal(rede.de('X').length, 3);
    assert.deepEqual(fila.estado().posicoes.A, P('A', 30));
    assert.equal(fila.estado().mostrar, true);
    rede.ultima('X').entregar();
    await esvaziar();
    const ult = rede.ultima('X').corpo;
    assert.deepEqual([ult.mostrar, ult.posicoes, ult.seq], [true, [P('A', 30)], 3]);
    assert.equal(rede.de('X').length, 4);
    assert.deepEqual([rede.servidor.mostrar, rede.servidor.posicoes.A.x], [true, 30]);
});

test('erro terminal preserva os campos; "Tentar de novo" reenvia os dois com seq nova', async () => {
    const { rede, fila } = await preparada();
    rede.regra('X', { status: 400 });
    fila.mostrar(false);
    fila.posicao(P('A', 20));
    await esvaziar();
    // o primeiro comando só tinha mostrar (envio imediato); a posição foi junto no segundo? não: um em voo → a posição espera
    assert.equal(fila.estado().situacao, 'erro');
    assert.equal(rede.de('X').length, 3, 'nenhum envio automático depois do erro');
    assert.equal(fila.temPendencia(), true);
    fila.tentarDeNovo();
    await esvaziar();
    const ult = rede.ultima('X').corpo;
    assert.deepEqual([ult.mostrar, ult.posicoes, ult.seq], [false, [P('A', 20)], 3]);
    assert.equal(fila.estado().situacao, 'salvo');
});

test('a devolução de um erro não sobrescreve intenção mais nova do mesmo campo', async () => {
    const { rede, fila } = await preparada();
    rede.regra('X', 'segurar');
    fila.posicao(P('A', 10));
    await esvaziar();
    fila.posicao(P('A', 20));
    rede.ultima('X').entregar({ status: 400 });
    await esvaziar();
    assert.equal(fila.estado().situacao, 'erro');
    fila.tentarDeNovo();
    await esvaziar();
    assert.deepEqual(rede.ultima('X').corpo.posicoes, [P('A', 20)]);
    assert.equal(rede.servidor.posicoes.A.x, 20);
});

test('época: sobe a cada intenção nova; leitura iniciada antes de uma mudança vê época diferente', async () => {
    const { fila } = await preparada();
    const inicioDaLeitura = fila.epoca();
    fila.posicao(P('A', 5), { adiar: true });
    assert.notEqual(fila.epoca(), inicioDaLeitura);
    assert.equal(fila.temPendencia(), true, 'pendência começa antes do debounce');
    const e2 = fila.epoca();
    fila.esquecerArte('B');
    assert.equal(fila.epoca(), e2, 'esquecer arte não é intenção');
});

test('renovação: 409 sessao_expirada → logo_sessao (substitui o id antigo) → reenvio com seq 1', async () => {
    const { rede, fila, aba } = await preparada();
    rede.servidor.sessoes = [];
    fila.posicao(P('A', 40));
    await esvaziar();
    assert.deepEqual(rede.acoes('X'), ['sessao', 'buffet', 'buffet', 'sessao', 'buffet']);
    const [, , b409, s, b] = rede.de('X');
    assert.deepEqual([b409.corpo.sessao, s.corpo.substitui, b.corpo.sessao, b.corpo.seq], ['S1', 'S1', 'S2', 1]);
    assert.deepEqual(aba.dono(), { id: 'S2', dono: 'X' });
    assert.equal(rede.servidor.posicoes.A.x, 40);
    assert.equal(fila.estado().situacao, 'salvo');
});

test('intenção nova chegando com o 409 em voo: o reenvio leva a intenção nova', async () => {
    const { rede, fila } = await preparada();
    rede.servidor.sessoes = [];
    rede.regra('X', 'processar-segurar');
    fila.posicao(P('A', 10));
    await esvaziar();
    fila.posicao(P('A', 30));
    rede.ultima('X').entregar();
    await esvaziar();
    assert.deepEqual(rede.acoes('X').slice(2), ['buffet', 'sessao', 'buffet']);
    assert.deepEqual(rede.ultima('X').corpo.posicoes, [P('A', 30)]);
    assert.equal(rede.servidor.posicoes.A.x, 30);
});

test('segundo 409 no mesmo ciclo → terminal, sem quarto POST; "Tentar de novo" grava', async () => {
    const { rede, fila, clock } = await preparada();
    const expirada: Resp = { status: 409, codigo: 'sessao_expirada' };
    rede.regra('X', expirada, 'auto', expirada);
    fila.posicao(P('A', 10));
    await esvaziar();
    await clock.avancar(10_000);
    assert.deepEqual(rede.acoes('X').slice(2), ['buffet', 'sessao', 'buffet']);
    assert.equal(fila.estado().situacao, 'erro');
    assert.deepEqual(fila.estado().posicoes.A, P('A', 10));
    fila.tentarDeNovo();
    await esvaziar();
    assert.equal(rede.servidor.posicoes.A.x, 10);
    assert.equal(fila.estado().situacao, 'salvo');
});

test('drenagem (a): 409, renovação, transporte, uma tentativa extra → grava', async () => {
    const { rede, fila } = await preparada();
    rede.regra('X', { status: 409, codigo: 'sessao_expirada' }, 'auto', { erro: new TypeError('Failed to fetch') }, 'auto');
    fila.posicao(P('A', 10));
    fila.drenar();
    await esvaziar();
    assert.deepEqual(rede.acoes('X').slice(2), ['buffet', 'sessao', 'buffet', 'buffet']);
    const [b1, b2] = rede.de('X').slice(4);
    assert.deepEqual([b1.corpo.seq, b2.corpo.seq], [1, 2], 'a tentativa extra leva seq nova');
    assert.equal(rede.servidor.posicoes.A.x, 10);
    assert.equal(fila.estado().situacao, 'salvo');
});

test('sem drenagem, a mesma falha de transporte é terminal (nenhuma tentativa extra)', async () => {
    const { rede, fila } = await preparada();
    rede.regra('X', { status: 409, codigo: 'sessao_expirada' }, 'auto', { erro: new TypeError('Failed to fetch') });
    fila.posicao(P('A', 10));
    await esvaziar();
    assert.deepEqual(rede.acoes('X').slice(2), ['buffet', 'sessao', 'buffet']);
    assert.equal(fila.estado().situacao, 'erro');
});

test('drenagem (b): 409, renovação, 409 → fim com pendência', async () => {
    const { rede, fila } = await preparada();
    const expirada: Resp = { status: 409, codigo: 'sessao_expirada' };
    rede.regra('X', expirada, 'auto', expirada);
    fila.posicao(P('A', 10));
    fila.drenar();
    await esvaziar();
    assert.deepEqual(rede.acoes('X').slice(2), ['buffet', 'sessao', 'buffet']);
    assert.equal(fila.estado().situacao, 'erro');
    assert.equal(fila.temPendencia(), true);
});

test('ciclo sem reinício: intenção nova e drenar() com a abertura em voo → três POSTs, terminal, pendente com a mais nova', async () => {
    const { rede, fila, clock } = await preparada();
    const expirada: Resp = { status: 409, codigo: 'sessao_expirada' };
    let abertura: Chamada | null = null;
    rede.regra('X', expirada, (c) => { abertura = c; }, expirada, 'auto', 'auto');
    fila.posicao(P('A', 10));
    await esvaziar();
    assert.ok(abertura);
    fila.posicao(P('A', 20));
    fila.drenar();
    (abertura as Chamada).entregar();
    await esvaziar();
    await clock.avancar(10_000);
    assert.deepEqual(rede.acoes('X').slice(2), ['buffet', 'sessao', 'buffet']);
    assert.equal(fila.estado().situacao, 'erro');
    assert.deepEqual(fila.estado().posicoes.A, P('A', 20));
});

test('ciclo sem reinício (variação): drenar() antes do primeiro 409 e intenção nova durante o reenvio', async () => {
    const { rede, fila, clock } = await preparada();
    const expirada: Resp = { status: 409, codigo: 'sessao_expirada' };
    let reenvio: Chamada | null = null;
    rede.regra('X', expirada, 'auto', (c) => { reenvio = c; }, 'auto', 'auto');
    fila.posicao(P('A', 10));
    fila.drenar();
    await esvaziar();
    assert.ok(reenvio);
    fila.posicao(P('A', 20));
    (reenvio as Chamada).entregar(expirada);
    await esvaziar();
    await clock.avancar(10_000);
    assert.deepEqual(rede.acoes('X').slice(2), ['buffet', 'sessao', 'buffet']);
    assert.equal(fila.estado().situacao, 'erro');
    assert.deepEqual(fila.estado().posicoes.A, P('A', 20));
});

const CASOS: Array<[string, Regra, boolean]> = [
    ['TypeError', { erro: new TypeError('Failed to fetch') }, true],
    ['RESULTADO_INCERTO', { erro: ErroCtx('RESULTADO_INCERTO') }, true],
    ['500', { status: 500 }, true],
    ['503', { status: 503 }, true],
    ['400', { status: 400 }, false],
    ['403', { status: 403 }, false],
    ['404', { status: 404 }, false],
    ['409 sem código', { status: 409 }, false],
    ['429', { status: 429 }, false],
    ['CONTEXTO_MUDOU', { erro: ErroCtx('CONTEXTO_MUDOU') }, false],
    ['SESSAO_ENCERRADA', { erro: ErroCtx('SESSAO_ENCERRADA') }, false],
    ['SESSAO_NAO_CONFIRMADA', { erro: ErroCtx('SESSAO_NAO_CONFIRMADA') }, false],
    ['ENDERECO_EM_VERIFICACAO', { erro: ErroCtx('ENDERECO_EM_VERIFICACAO') }, false],
    ['RECUSADA_PELO_CONTEXTO', { erro: ErroCtx('RECUSADA_PELO_CONTEXTO') }, false],
    ['REDE (contexto)', { erro: ErroCtx('REDE') }, false],
    ['código desconhecido', { erro: ErroCtx('OUTRO') }, false],
    ['AbortError', { erro: new DOMException('abortado', 'AbortError') }, false],
    ['corpo ilegível', { erro: new SyntaxError('Unexpected token') }, false],
];
for (const [nome, regra, retentavel] of CASOS) {
    for (const drenando of [false, true]) {
        test(`tabela de respostas: ${nome}, ${drenando ? 'drenando' : 'sem drenar'}, em logo_buffet e em logo_sessao`, async () => {
            // logo_buffet (sessão já aberta)
            const a = await preparada();
            a.rede.regra('X', regra);
            a.fila.posicao(P('A', 10));
            if (drenando) a.fila.drenar();
            await esvaziar();
            const extra = retentavel && drenando;
            assert.deepEqual(a.rede.acoes('X').slice(2), extra ? ['buffet', 'buffet'] : ['buffet'], 'nenhuma renovação; extra só retentável e drenando');
            assert.equal(a.fila.estado().situacao, extra ? 'salvo' : 'erro');
            if (!extra) assert.deepEqual(a.fila.estado().posicoes.A, P('A', 10));
            // logo_sessao (primeira abertura)
            const b = cenario();
            const fila = b.criar('Y');
            b.rede.regra('Y', regra);
            fila.posicao(P('A', 10));
            if (drenando) fila.drenar();
            await esvaziar();
            assert.deepEqual(b.rede.acoes('Y'), extra ? ['sessao', 'sessao', 'buffet'] : ['sessao']);
            assert.equal(fila.estado().situacao, extra ? 'salvo' : 'erro');
        });
    }
}

test('429 na abertura durante a renovação → terminal com dois POSTs, mesmo drenando; "Tentar de novo" zera os contadores', async () => {
    const { rede, fila } = await preparada();
    const expirada: Resp = { status: 409, codigo: 'sessao_expirada' };
    rede.regra('X', expirada, { status: 429 });
    fila.posicao(P('A', 10));
    fila.drenar();
    await esvaziar();
    assert.deepEqual(rede.acoes('X').slice(2), ['buffet', 'sessao']);
    assert.equal(fila.estado().situacao, 'erro');
    assert.deepEqual(fila.estado().posicoes.A, P('A', 10));
    // ciclo novo: uma renovação volta a ser permitida
    rede.regra('X', 'auto', expirada, 'auto', 'auto');
    fila.tentarDeNovo();
    await esvaziar();
    assert.deepEqual(rede.acoes('X').slice(4), ['sessao', 'buffet', 'sessao', 'buffet']);
    assert.equal(fila.estado().situacao, 'salvo');
});

test('identidade da aba: a abertura manda substitui com o id deixado por um documento anterior', async () => {
    const { rede, criar, aba } = cenario();
    aba.mapa.set(CHAVE, JSON.stringify({ id: 'S0', dono: 'antigo' }));
    const fila = criar('X');
    fila.mostrar(false);
    await esvaziar();
    assert.equal(rede.de('X')[0].corpo.substitui, 'S0');
    assert.equal(fila.estado().situacao, 'salvo');
});

test('storage com falha só na leitura → abre sem substitui, sem persistência, grava, não fica superada', async () => {
    const { rede, criar, aba, linha } = cenario();
    aba.mapa.set(CHAVE, JSON.stringify({ id: 'S0', dono: 'antigo' }));
    aba.falhaLer = true;
    const fila = criar('X');
    fila.mostrar(false);
    await esvaziar();
    assert.equal(rede.de('X')[0].corpo.substitui, undefined);
    assert.deepEqual(linha.filter((l) => !l.includes('POST')), [], 'sem persistência: não grava a chave');
    assert.equal(fila.estado().situacao, 'salvo');
});

test('storage com falha só na escrita → removeItem, sem persistência, grava; renovações não reivindicam a chave', async () => {
    const { rede, criar, aba, linha } = cenario();
    aba.falhaEscrever = true;
    const fila = criar('X');
    fila.mostrar(false);
    await esvaziar();
    assert.deepEqual(linha.filter((l) => !l.includes('POST')), ['X set', 'X remove']);
    assert.equal(rede.servidor.mostrar, false);
    rede.servidor.sessoes = [];
    aba.falhaEscrever = false;
    aba.mapa.set(CHAVE, 'outro documento');
    fila.mostrar(true);
    await esvaziar();
    assert.deepEqual(rede.acoes('X'), ['sessao', 'buffet', 'buffet', 'sessao', 'buffet']);
    assert.equal(rede.de('X')[3].corpo.substitui, undefined);
    assert.deepEqual(linha.filter((l) => !l.includes('POST')), ['X set', 'X remove'], 'nenhuma escrita depois');
    assert.equal(fila.estado().situacao, 'salvo');
    assert.equal(rede.servidor.mostrar, true);
});

test('storage com falha na leitura e na escrita → grava sem substitui', async () => {
    const { rede, criar, aba } = cenario();
    aba.falhaLer = true; aba.falhaEscrever = true; aba.falhaRemover = true;
    const fila = criar('X');
    fila.posicao(P('A'));
    await esvaziar();
    assert.equal(rede.de('X')[0].corpo.substitui, undefined);
    assert.equal(fila.estado().situacao, 'salvo');
});

test('storage com falha só na escrita e no removeItem → grava mesmo assim', async () => {
    const { rede, criar, aba } = cenario();
    aba.falhaEscrever = true; aba.falhaRemover = true;
    const fila = criar('X');
    fila.posicao(P('A'));
    await esvaziar();
    assert.equal(fila.estado().situacao, 'salvo');
    assert.equal(rede.servidor.posicoes.A.x, 50);
});

test('reload com A retido entre a abertura e o primeiro logo_buffet: A recebe 409, B fica gravada', async () => {
    const { rede, criar, aba } = cenario();
    const i1 = criar('I1');
    rede.regra('I1', 'auto', 'segurar');
    i1.posicao(P('A', 10));
    await esvaziar();
    const a = rede.ultima('I1');
    assert.equal(a.corpo.acao, 'logo_buffet');
    // página nova da mesma aba (I1 não roda mais: o documento antigo saiu)
    i1.suspender();
    const i2 = criar('I2');
    i2.posicao(P('A', 20));
    await esvaziar();
    assert.equal(rede.de('I2')[0].corpo.substitui, 'S1');
    assert.deepEqual(aba.dono(), { id: 'S2', dono: 'I2' });
    a.processar();
    assert.deepEqual(a.resultado, { status: 409, codigo: 'sessao_expirada' });
    a.entregar();
    await esvaziar();
    assert.equal(rede.servidor.posicoes.A.x, 20);
    assert.equal(rede.de('I1').length, 2);
});

test('duas abas independentes: recarregar X não tira a sessão de Y', async () => {
    const { rede, criar, linha } = cenario();
    const abaY = new Aba(linha);
    const x = criar('X');
    const y = criar('Y', abaY);
    x.posicao(P('A')); y.posicao(P('B'));
    await esvaziar();
    x.suspender();
    const x2 = criar('X2');
    x2.posicao(P('A', 5));
    await esvaziar();
    y.posicao(P('B', 7));
    await esvaziar();
    assert.deepEqual(rede.acoes('Y'), ['sessao', 'buffet', 'buffet']);
    assert.equal(rede.servidor.posicoes.B.x, 7);
});

test('aba duplicada: a abertura de Y expulsa X; X renova uma vez e grava, sem ficar superada', async () => {
    const { rede, criar, aba } = cenario();
    const x = criar('X');
    x.posicao(P('A', 1));
    await esvaziar();
    const abaY = aba.duplicar();
    const y = criar('Y', abaY);
    y.posicao(P('B', 2));
    await esvaziar();
    assert.equal(rede.de('Y')[0].corpo.substitui, 'S1');
    x.posicao(P('A', 3));
    await esvaziar();
    assert.deepEqual(rede.acoes('X'), ['sessao', 'buffet', 'buffet', 'sessao', 'buffet']);
    assert.equal(x.estado().situacao, 'salvo');
    assert.deepEqual([rede.servidor.posicoes.A.x, rede.servidor.posicoes.B.x], [3, 2]);
    assert.deepEqual(aba.dono(), { id: 'S3', dono: 'X' });
    assert.deepEqual(abaY.dono(), { id: 'S2', dono: 'Y' });
});

test('aba ativa expulsa por 20 aberturas independentes: o próximo arraste custa 3 POSTs e grava', async () => {
    const { rede, fila } = await preparada();
    for (let i = 0; i < 20; i++) rede.servidor.abrir();
    fila.posicao(P('A', 9));
    await esvaziar();
    assert.deepEqual(rede.acoes('X').slice(2), ['buffet', 'sessao', 'buffet']);
    assert.equal(rede.servidor.posicoes.A.x, 9);
});

test('25 renovações de Y pelo protocolo (substitui da própria sessão) não expulsam X', async () => {
    const { rede, criar, linha } = cenario();
    const x = criar('X');
    x.posicao(P('A', 1));
    await esvaziar();
    const abaY = new Aba(linha);
    let y = criar('Y0', abaY);
    for (let i = 1; i <= 25; i++) {
        y.posicao(P('B', i));
        await esvaziar();
        y.suspender();
        y = criar(`Y${i}`, abaY);
    }
    assert.equal(rede.servidor.sessoes.length, 2);
    x.posicao(P('A', 2));
    await esvaziar();
    assert.deepEqual(rede.acoes('X'), ['sessao', 'buffet', 'buffet']);
    assert.equal(rede.servidor.posicoes.A.x, 2);
});

test('invalidação repetida: S1 e depois S2 substituídas por outro documento → terminal sem quarto POST; "Tentar de novo" grava', async () => {
    const { rede, fila } = await preparada();
    rede.servidor.abrir('S1');
    rede.regra('X', 'auto', (c) => { c.processar(); rede.servidor.abrir((c.resultado!.data as { logoSessao: string }).logoSessao); queueMicrotask(() => c.entregar()); });
    fila.posicao(P('A', 4));
    await esvaziar();
    assert.deepEqual(rede.acoes('X').slice(2), ['buffet', 'sessao', 'buffet']);
    assert.equal(fila.estado().situacao, 'erro');
    assert.deepEqual(fila.estado().posicoes.A, P('A', 4));
    fila.tentarDeNovo();
    await esvaziar();
    assert.equal(rede.servidor.posicoes.A.x, 4);
});

test('bfcache, sucesso atrasado: I1 superada, resposta descartada, nenhum POST novo, chave de I2', async () => {
    const { rede, criar, aba } = cenario();
    const i1 = criar('I1');
    i1.posicao(P('A', 1));
    await esvaziar();
    rede.regra('I1', 'processar-segurar');
    i1.posicao(P('A', 10));
    await esvaziar();
    const a = rede.ultima('I1');
    i1.suspender();
    const i2 = criar('I2');
    i2.posicao(P('A', 20));
    await esvaziar();
    const chave = aba.mapa.get(CHAVE);
    i1.retomar();
    a.entregar();
    await esvaziar();
    i1.posicao(P('A', 30));
    await esvaziar();
    assert.equal(i1.estado().situacao, 'superada');
    assert.equal(rede.de('I1').length, 3);
    assert.equal(aba.mapa.get(CHAVE), chave);
    assert.deepEqual(aba.dono(), { id: 'S2', dono: 'I2' });
    assert.equal(rede.servidor.posicoes.A.x, 20);
});

for (const antes of [false, true]) {
    test(`bfcache, 409 atrasado (${antes ? 'antes' : 'depois'} do pageshow): I1 superada, nenhum POST de I1, B persistido`, async () => {
        const { rede, criar, aba, linha } = cenario();
        const i1 = criar('I1');
        i1.posicao(P('A', 1));
        await esvaziar();
        rede.regra('I1', 'segurar');
        i1.posicao(P('A', 10));
        await esvaziar();
        const a = rede.ultima('I1');
        i1.suspender();
        const i2 = criar('I2');
        i2.posicao(P('A', 20));
        await esvaziar();
        if (!antes) i1.retomar();
        a.processar();
        a.entregar();
        await esvaziar();
        assert.equal(i1.estado().situacao, 'superada', 'a conferência ao processar a resposta já supera');
        if (antes) { i1.retomar(); await esvaziar(); }
        assert.equal(rede.de('I1').length, 3);
        assert.deepEqual(aba.dono(), { id: 'S2', dono: 'I2' });
        assert.deepEqual(linha.filter((l) => l.startsWith('I1 ') && !l.includes('POST')), ['I1 set']);
        assert.equal(rede.servidor.posicoes.A.x, 20);
    });
}

test('bfcache, abertura atrasada: id descartado sem gravar, chave de I2 intacta byte a byte, nenhum logo_buffet de I1', async () => {
    const { rede, criar, aba, linha } = cenario();
    const i1 = criar('I1');
    rede.regra('I1', 'segurar');
    i1.posicao(P('A', 10));
    await esvaziar();
    const abertura = rede.ultima('I1');
    i1.suspender();
    const i2 = criar('I2');
    i2.posicao(P('A', 20));
    await esvaziar();
    const chave = aba.mapa.get(CHAVE);
    abertura.processar();
    abertura.entregar();
    i1.retomar();
    await esvaziar();
    assert.equal(aba.mapa.get(CHAVE), chave);
    assert.equal(i1.estado().situacao, 'superada');
    assert.deepEqual(rede.acoes('I1'), ['sessao']);
    assert.deepEqual(linha.filter((l) => l.startsWith('I1 ') && !l.includes('POST')), [], 'I1 nunca grava no storage');
});

test('bfcache, abertura atrasada processada antes do pageshow: não grava a chave de I2 nem envia', async () => {
    const { rede, criar, aba, linha } = cenario();
    const i1 = criar('I1');
    rede.regra('I1', 'segurar');
    i1.posicao(P('A', 10));
    await esvaziar();
    const abertura = rede.ultima('I1');
    i1.suspender();
    const i2 = criar('I2');
    i2.posicao(P('A', 20));
    await esvaziar();
    const chave = aba.mapa.get(CHAVE);
    abertura.processar();
    abertura.entregar();
    await esvaziar();
    assert.equal(aba.mapa.get(CHAVE), chave, 'a conferência ao processar a abertura descarta o id');
    assert.equal(i1.estado().situacao, 'superada');
    i1.retomar();
    await esvaziar();
    assert.deepEqual(rede.acoes('I1'), ['sessao']);
    assert.deepEqual(linha.filter((l) => l.startsWith('I1 ') && !l.includes('POST')), []);
});

test('bfcache, falha de transporte atrasada: superada (não "erro"), nenhuma tentativa extra', async () => {
    const { rede, criar } = cenario();
    const i1 = criar('I1');
    i1.posicao(P('A', 1));
    await esvaziar();
    rede.regra('I1', 'segurar');
    i1.posicao(P('A', 10));
    i1.drenar();
    await esvaziar();
    const a = rede.ultima('I1');
    i1.suspender();
    const i2 = criar('I2');
    i2.posicao(P('A', 20));
    await esvaziar();
    a.falhar(new TypeError('Failed to fetch'));
    await esvaziar();
    assert.equal(i1.estado().situacao, 'superada');
    i1.retomar();
    await esvaziar();
    assert.equal(rede.de('I1').length, 3);
});

test('pageshow confere o dono mesmo sem nada pendente: I1 fica superada na hora', async () => {
    const { criar } = cenario();
    const i1 = criar('I1');
    i1.posicao(P('A', 1));
    await esvaziar();
    i1.suspender();
    const i2 = criar('I2');
    i2.posicao(P('A', 2));
    await esvaziar();
    i1.retomar();
    assert.equal(i1.estado().situacao, 'superada');
});

for (const s0 of [false, true]) {
    test(`bfcache no debounce (chave ${s0 ? 'com S0' : 'vazia'} ao nascer): I1 superada, nenhum POST, B preservado`, async () => {
        const { rede, criar, aba, clock } = cenario();
        if (s0) aba.mapa.set(CHAVE, JSON.stringify({ id: 'S0', dono: 'antigo' }));
        const i1 = criar('I1');
        i1.posicao(P('A', 10), { adiar: true });
        i1.suspender();
        const i2 = criar('I2');
        i2.posicao(P('A', 20));
        await esvaziar();
        i1.retomar();
        await clock.avancar(600);
        assert.equal(rede.de('I1').length, 0);
        assert.equal(i1.estado().situacao, 'superada');
        assert.equal(rede.servidor.posicoes.A.x, 20);
    });
}

test('retorno sem outro documento: não fica superada; abre com o substitui visto ao nascer e grava', async () => {
    const { rede, criar, aba, clock } = cenario();
    aba.mapa.set(CHAVE, JSON.stringify({ id: 'S0', dono: 'antigo' }));
    const i1 = criar('I1');
    i1.posicao(P('A', 10), { adiar: true });
    i1.suspender();
    i1.retomar();
    await clock.avancar(600);
    assert.deepEqual(rede.acoes('I1'), ['sessao', 'buffet']);
    assert.equal(rede.de('I1')[0].corpo.substitui, 'S0');
    assert.equal(i1.estado().situacao, 'salvo');
    assert.equal(rede.servidor.posicoes.A.x, 10);
});

test('retorno sem outro documento com a sessão já aberta: retoma como dona', async () => {
    const { rede, fila } = await preparada();
    fila.suspender();
    fila.posicao(P('A', 3));
    await esvaziar();
    assert.equal(rede.de('X').length, 2, 'suspensa: nada sai');
    fila.retomar();
    await esvaziar();
    assert.deepEqual(rede.acoes('X'), ['sessao', 'buffet', 'buffet']);
});

test('intenção nova depois de superada: recusada, sem POST', async () => {
    const { rede, criar } = cenario();
    const i1 = criar('I1');
    const i2 = criar('I2');
    i2.mostrar(false);
    await esvaziar();
    i1.mostrar(true);
    await esvaziar();
    assert.equal(i1.estado().situacao, 'superada');
    assert.equal(rede.de('I1').length, 0);
    i1.posicao(P('A')); i1.tentarDeNovo(); i1.drenar();
    await esvaziar();
    assert.equal(rede.de('I1').length, 0);
});

test('arte excluída em outra aba: o comando grava B, A volta em artesAusentes e é esquecida; fica "Salvo"', async () => {
    const { rede, fila } = await preparada();
    rede.servidor.artes.delete('A');
    rede.regra('X', 'segurar');
    fila.mostrar(true);
    await esvaziar();
    fila.posicao(P('A', 1)); fila.posicao(P('B', 2));
    rede.ultima('X').entregar();
    await esvaziar();
    assert.deepEqual(rede.ultima('X').corpo.posicoes, [P('A', 1), P('B', 2)]);
    assert.equal(rede.servidor.posicoes.B.x, 2);
    assert.equal(fila.estado().situacao, 'salvo');
    assert.equal(fila.estado().posicoes.A, undefined);
    fila.posicao(P('A', 3));
    await esvaziar();
    assert.equal(rede.de('X').length, 4, 'intenção para arte esquecida é descartada');
});

test('arte excluída nesta aba durante o envio: o erro não devolve A; "Tentar de novo" leva só B', async () => {
    const { rede, fila } = await preparada();
    rede.regra('X', 'segurar');
    fila.mostrar(false);
    await esvaziar();
    const primeiro = rede.ultima('X');
    fila.posicao(P('A', 1)); fila.posicao(P('B', 2));
    rede.regra('X', 'segurar');
    primeiro.entregar();
    await esvaziar();
    const comAB = rede.ultima('X');
    assert.deepEqual(comAB.corpo.posicoes, [P('A', 1), P('B', 2)]);
    fila.esquecerArte('A');
    comAB.falhar(new TypeError('Failed to fetch'));
    await esvaziar();
    assert.equal(fila.estado().situacao, 'erro');
    fila.tentarDeNovo();
    await esvaziar();
    assert.deepEqual(rede.ultima('X').corpo.posicoes, [P('B', 2)]);
    assert.equal(rede.servidor.posicoes.A, undefined);
});

test('posição de arte de outro convite: ignorada pelo servidor, esquecida pela fila, nada gravado', async () => {
    const { rede, fila } = await preparada();
    fila.posicao(P('Z', 1));
    await esvaziar();
    assert.equal(rede.servidor.posicoes.Z, undefined);
    assert.equal(fila.estado().situacao, 'salvo');
    assert.equal(fila.temPendencia(), false);
});

test('com A em voo e a prévia em B: o erro devolve só posicao:A; o reenvio grava só A', async () => {
    const { rede, fila } = await preparada();
    rede.regra('X', { status: 500 });
    fila.posicao(P('A', 1));
    await esvaziar();
    assert.deepEqual(Object.keys(fila.estado().posicoes), ['A']);
    fila.tentarDeNovo();
    await esvaziar();
    assert.deepEqual(rede.ultima('X').corpo.posicoes, [P('A', 1)]);
    assert.equal(rede.ultima('X').corpo.mostrar, undefined);
});

test('quatro posições por comando: a quinta vai no comando seguinte do mesmo ciclo', async () => {
    const { rede, fila } = await preparada();
    rede.regra('X', 'segurar');
    fila.mostrar(true);
    await esvaziar();
    for (const id of ['A', 'B', 'C', 'D', 'E']) fila.posicao(P(id, 1));
    rede.ultima('X').entregar();
    await esvaziar();
    const [c1, c2] = rede.de('X').slice(3).map((c) => c.corpo.posicoes!.map((p) => p.arteId));
    assert.deepEqual([c1, c2], [['A', 'B', 'C', 'D'], ['E']]);
    assert.equal(fila.estado().situacao, 'salvo');
});

test('drenar() com envio em voo espera e envia depois; adianta o debounce', async () => {
    const { rede, fila, clock } = await preparada();
    rede.regra('X', 'segurar');
    fila.posicao(P('A', 1));
    await esvaziar();
    fila.posicao(P('B', 2), { adiar: true });
    fila.drenar();
    await esvaziar();
    assert.equal(rede.de('X').length, 3, 'nada sai enquanto o primeiro está em voo');
    rede.ultima('X').entregar();
    await esvaziar();
    assert.deepEqual(rede.ultima('X').corpo.posicoes, [P('B', 2)]);
    await clock.avancar(600);
    assert.equal(rede.de('X').length, 4);
});

test('debounce de 600 ms no teclado; cancelarAdiado (Esc) some com a única pendência', async () => {
    const { rede, fila, clock } = await preparada();
    fila.posicao(P('A', 1), { adiar: true });
    await clock.avancar(300);
    fila.posicao(P('A', 2), { adiar: true });
    await clock.avancar(300);
    assert.equal(rede.de('X').length, 2);
    await clock.avancar(300);
    assert.deepEqual(rede.ultima('X').corpo.posicoes, [P('A', 2)]);
    fila.posicao(P('B', 1), { adiar: true });
    fila.cancelarAdiado('B');
    assert.equal(fila.temPendencia(), false);
    await clock.avancar(1000);
    assert.equal(rede.de('X').length, 3);
});

test('aguardarMostrar: resposta em 1 s → ok; em 6 s → tempo; erro terminal → erro; só posição pendente → ok na hora', async () => {
    const { rede, fila, clock } = await preparada();
    rede.regra('X', 'segurar');
    fila.mostrar(false);
    await esvaziar();
    const p1 = fila.aguardarMostrar(5000);
    await clock.avancar(1000);
    rede.ultima('X').entregar();
    assert.equal(await p1, 'ok');
    rede.regra('X', 'segurar');
    fila.mostrar(true);
    await esvaziar();
    const p2 = fila.aguardarMostrar(5000);
    await clock.avancar(5000);
    assert.equal(await p2, 'tempo');
    rede.ultima('X').entregar();
    await esvaziar();
    rede.regra('X', { status: 400 });
    fila.mostrar(false);
    const p3 = fila.aguardarMostrar(5000);
    await esvaziar();
    assert.equal(await p3, 'erro');
    assert.equal(await fila.aguardarMostrar(5000), 'erro', 'mostrar continua pendente depois do erro terminal');
    fila.tentarDeNovo();
    await esvaziar();
    assert.equal(fila.estado().situacao, 'salvo');
    rede.regra('X', 'segurar');
    fila.posicao(P('A', 2));
    assert.equal(await fila.aguardarMostrar(5000), 'ok');
});

test('assinar recebe o estado a cada mudança e para depois de cancelar', async () => {
    const { fila } = await preparada();
    const vistos: string[] = [];
    const parar = fila.assinar((e) => vistos.push(e.situacao));
    fila.mostrar(false);
    await esvaziar();
    parar();
    fila.mostrar(true);
    await esvaziar();
    assert.ok(vistos.includes('salvando') && vistos.at(-1) === 'salvo');
    const n = vistos.length;
    assert.equal(vistos.length, n);
});

test('o comando nunca leva origem nem campos extras da posição', async () => {
    const { rede, fila } = await preparada();
    fila.posicao({ ...P('A', 1), origem: 'reservada' } as unknown as F.PosicaoLogoEnvio);
    await esvaziar();
    assert.deepEqual(Object.keys(rede.ultima('X').corpo.posicoes![0]).sort(), ['arteId', 'fundo', 'largura', 'modo', 'x', 'y']);
});

/**
 * Transporte real: adminFetch verdadeiro com globais falsos (mesma técnica de lib/http/admin-fetch-tipo.test.ts), contra
 * uma rota simulada que responde com o corpo da rota real ({ ok, data } / { ok:false, erro, codigo }).
 */
test('transporte real: adminFetch com POST, keepalive e os dois cabeçalhos; sessão → buffet; 20 aberturas → 409, renova e grava', async () => {
    const g = globalThis as unknown as Record<string, unknown>;
    const antes = { window: g.window, sessionStorage: g.sessionStorage, fetch: g.fetch };
    try {
        const armazenado = new Map<string, string>();
        g.window = { location: { pathname: '/admin/convites', replace() {}, assign() {} }, addEventListener() {} };
        g.sessionStorage = { getItem: (k: string) => armazenado.get(k) ?? null, setItem: (k: string, v: string) => { armazenado.set(k, v); }, removeItem: (k: string) => { armazenado.delete(k); } };
        const servidor = new Servidor();
        const posts: { corpo: Corpo; init: RequestInit }[] = [];
        let auxiliares = 0;
        const ENDPOINT = '/api/admin/convites?conviteId=conv';
        g.fetch = async (input: string, init: RequestInit = {}) => {
            if (String(input) === '/api/admin/autenticacao') {
                auxiliares++;
                return Response.json({ ok: true, data: { usuarioId: 'u', sessaoId: 'sess', csrf: 'csrf', contexto: { empresaAtual: { id: 'emp' } } } });
            }
            assert.equal(String(input), ENDPOINT);
            const corpo = JSON.parse(String(init.body)) as Corpo;
            posts.push({ corpo, init });
            const r = servidor.processar(corpo);
            return r.status === 200 ? Response.json({ ok: true, data: r.data }, { status: 200 }) : Response.json({ ok: false, erro: 'A sessão da logo terminou.', codigo: r.codigo }, { status: r.status });
        };
        const cache = new Map();
        carregarModulo('lib/http/contexto-empresa-cliente.ts', {}, cache);
        const M = carregarModulo('lib/convites/fila-logo.ts', {}, cache) as unknown as typeof F;
        const fila = M.filaDaLogo('conv');
        assert.equal(M.filaDaLogo('conv'), fila, 'uma instância por convite no documento');
        assert.equal(posts.length, 0);
        fila.posicao(P('A', 10));
        for (let i = 0; i < 20 && fila.temPendencia(); i++) await esvaziar();
        assert.deepEqual(posts.map((p) => p.corpo.acao), ['logo_sessao', 'logo_buffet']);
        for (const { init } of posts) {
            const h = new Headers(init.headers);
            assert.deepEqual([init.method, init.keepalive, h.get('x-csrf-token'), h.get('x-kidmais-sessao')], ['POST', true, 'csrf', 'sess']);
        }
        assert.ok(auxiliares > 0, 'consultas auxiliares do adminFetch contadas à parte');
        assert.equal(JSON.parse(armazenado.get(CHAVE)!).id, 'S1');
        for (let i = 0; i < 20; i++) servidor.abrir();
        fila.posicao(P('A', 30));
        for (let i = 0; i < 20 && fila.temPendencia(); i++) await esvaziar();
        assert.deepEqual(posts.map((p) => p.corpo.acao), ['logo_sessao', 'logo_buffet', 'logo_buffet', 'logo_sessao', 'logo_buffet']);
        assert.deepEqual([posts[2].corpo.sessao, posts[3].corpo.substitui, posts[4].corpo.sessao], ['S1', 'S1', 'S22']);
        assert.equal(servidor.posicoes.A.x, 30);
        assert.equal(fila.estado().situacao, 'salvo');
    }
    finally {
        Object.assign(g, antes);
    }
});

test('r2 confirmados: só o que a resposta marcou como aplicado; arte ausente e seq velha não confirmam; a confirmação sobe a época', async () => {
    const { rede, fila } = await preparada();
    const c0 = fila.estado().confirmados;
    assert.equal(c0.n, 1, 'a preparação confirmou F');
    assert.deepEqual(c0.posicoes.F?.valor, P('F', 1));
    rede.servidor.artes.delete('B');
    const ep = fila.epoca();
    fila.mostrar(false); fila.posicao(P('A', 40)); fila.posicao(P('B', 60));
    const depoisDaIntencao = fila.epoca();
    assert.ok(depoisDaIntencao > ep);
    await esvaziar();
    const c = fila.estado().confirmados;
    assert.equal(c.n, 3, 'mostrar sai sozinho; A e B no comando seguinte');
    assert.deepEqual(c.mostrar, { valor: false, n: 2 });
    assert.deepEqual(c.posicoes.A, { valor: P('A', 40), n: 3 });
    assert.equal(c.posicoes.B, undefined, 'arte ausente nunca é confirmada');
    assert.ok(fila.epoca() > depoisDaIntencao, 'a confirmação conta para a regra da época');
    // Resposta sem `aplicado` verdadeiro (seq velha): não confirma.
    rede.regra('X', { status: 200, data: { aplicado: { posicoes: { A: false } }, artesAusentes: [] } });
    fila.posicao(P('A', 70));
    await esvaziar();
    assert.equal(fila.estado().confirmados.n, 3);
    assert.deepEqual(fila.estado().confirmados.posicoes.A.valor, P('A', 40));
    // Resposta sem `aplicado.mostrar` verdadeiro: o mostrar não é confirmado.
    rede.regra('X', { status: 200, data: { aplicado: {}, artesAusentes: [] } });
    fila.mostrar(true);
    await esvaziar();
    assert.deepEqual(fila.estado().confirmados.mostrar, { valor: false, n: 2 });
    // Arte esquecida (excluída) com o comando em voo: o servidor ainda responde aplicado, mas não confirma.
    rede.regra('X', 'segurar');
    fila.posicao(P('A', 55));
    await esvaziar();
    fila.esquecerArte('A');
    rede.ultima('X').entregar();
    await esvaziar();
    assert.deepEqual(fila.estado().confirmados.posicoes.A.valor, P('A', 40), 'arte esquecida não é confirmada');
});

test('r2 confirmados: superada e erro terminal não confirmam a intenção descartada', async () => {
    const { rede, fila, aba } = await preparada();
    rede.regra('X', 'segurar');
    fila.posicao(P('A', 33));
    await esvaziar();
    aba.mapa.set(CHAVE, JSON.stringify({ id: 'S9', dono: 'Y' }));
    rede.ultima('X').entregar();
    await esvaziar();
    assert.equal(fila.estado().situacao, 'superada');
    assert.equal(fila.estado().confirmados.posicoes.A, undefined);
    assert.deepEqual(fila.estado().posicoes, {}, 'a intenção some da fila');
});

test('r2 endpoint da fila nasce do id do convite', () => {
    const M = modulo();
    assert.equal(M.endpointDaLogo('a b'), '/api/admin/convites?conviteId=a%20b');
    assert.throws(() => M.filaDaLogo(''), /sem convite/);
});
