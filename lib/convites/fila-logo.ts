'use client';
import { adminFetch } from '@/lib/http/admin-fetch';

/**
 * Fila da logo do buffet (plano etapa 3 r15.1, §5). Módulo do navegador, uma instância por convite no documento:
 * continua viva quando o editor desmonta numa navegação interna. O editor só entrega intenções e lê o estado.
 *
 * Regras centrais:
 *  - um envio em voo, sempre; o próximo comando leva todos os campos pendentes (o `mostrar` e até 4 posições);
 *  - a sessão da logo só nasce no servidor (`logo_sessao`), na primeira mudança; o id fica na chave da aba
 *    (`sessionStorage`) com o dono = geração desta instância, gravado ANTES do primeiro `logo_buffet`;
 *  - a instância lê a chave ao nascer (`referencia`) e confere antes de cada passo e ao processar cada resposta:
 *    outro documento gravou a chave → superada, para sempre;
 *  - ciclo de envio sem reinício: `renovacoes` ≤ 1 e `tentativasExtras` ≤ 1 (só drenando, só falha retentável).
 */

export type PosicaoLogoEnvio = { modo: 'faixa' | 'sobre'; arteId: string; x: number; y: number; largura: number; fundo: boolean };
export type EstadoFilaLogo = {
    situacao: 'ocioso' | 'salvando' | 'salvo' | 'erro' | 'superada';
    pendente: boolean;
    epoca: number;
    mostrar?: boolean;
    /** Intenções pendentes ou em voo, por arte (o que a tela deve mostrar no lugar do gravado). */
    posicoes: Record<string, PosicaoLogoEnvio>;
    /**
     * r2 (Astra r1, P2): só o que o servidor marcou como aplicado, com o número da confirmação. A tela incorpora à base
     * gravada apenas estes campos; intenção descartada (superada, arte ausente, seq velha) nunca vira "gravada".
     */
    confirmados: ConfirmadosLogo;
};
export type ConfirmadosLogo = { n: number; mostrar?: { valor: boolean; n: number }; posicoes: Record<string, { valor: PosicaoLogoEnvio; n: number }> };
/** Lança em erro de rede ou de contexto administrativo; senão devolve o status e o corpo lido. */
export type Transporte = (corpo: object) => Promise<{ status: number; codigo?: string; data?: unknown }>;
export type ArmazenamentoAba = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };
export type FilaLogo = {
    mostrar(v: boolean): void;
    posicao(p: PosicaoLogoEnvio, op?: { adiar?: boolean }): void;
    cancelarAdiado(arteId: string): void;
    drenar(): void;
    tentarDeNovo(): void;
    esquecerArte(arteId: string): void;
    estado(): EstadoFilaLogo;
    assinar(fn: (e: EstadoFilaLogo) => void): () => void;
    temPendencia(): boolean;
    epoca(): number;
    aguardarMostrar(ms: number): Promise<'ok' | 'tempo' | 'erro'>;
    suspender(): void;
    retomar(): void;
};

export const ESPERA_TECLADO_MS = 600;
export const POSICOES_POR_COMANDO = 4;
export const chaveSessaoLogo = (conviteId: string) => `iafest:logo-sessao:${conviteId}`;

/**
 * Retentável (§5, tabela de respostas): rejeição do `fetch` com TypeError e `RESULTADO_INCERTO` do adminFetch.
 * Qualquer outro erro lançado (outros códigos de contexto, código desconhecido, AbortError, corpo ilegível) é terminal.
 * O 5xx chega como resposta e é tratado à parte.
 */
export function falhaRetentavel(e: unknown) {
    if (e instanceof TypeError) return true;
    return typeof e === 'object' && e !== null && (e as { tipo?: unknown }).tipo === 'RESULTADO_INCERTO';
}

type Intencao = { valor: boolean | PosicaoLogoEnvio; versao: number };
const CAMPO_MOSTRAR = 'mostrar';
const campoPosicao = (arteId: string) => `posicao:${arteId}`;
const arteDoCampo = (campo: string) => (campo.startsWith('posicao:') ? campo.slice(8) : null);
type Voo = { tipo: 'sessao' } | { tipo: 'buffet'; campos: Map<string, Intencao> };

export function criarFilaLogo(op: {
    conviteId: string; transporte: Transporte; armazenamento?: ArmazenamentoAba | null; geracao?: string;
    agendar?: (fn: () => void, ms: number) => unknown; cancelar?: (h: unknown) => void; agora?: () => number;
}): FilaLogo {
    const chave = chaveSessaoLogo(op.conviteId);
    const geracao = op.geracao ?? crypto.randomUUID();
    const agendar = op.agendar ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
    const cancelar = op.cancelar ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
    const armazenamento = op.armazenamento ?? null;

    // Referência de dono desde a criação: o valor bruto da chave visto ao nascer (inclusive vazio). Estados do §5:
    // nunca_abriu (sessao nula, nenhuma abertura), abrindo (abertura em voo), dona (sessao gravada pela própria instância).
    let semPersistencia = !armazenamento;
    let referencia: string | null = null;
    if (armazenamento) {
        try { referencia = armazenamento.getItem(chave); }
        catch { semPersistencia = true; }
    }
    let sessao: string | null = null;
    let seq = 0;
    let superada = false, suspensa = false, parado = false, jaSalvou = false;
    let epoca = 0, versao = 0;
    const pendente = new Map<string, Intencao>();
    const adiados = new Map<string, Intencao>();
    let relogio: unknown = null;
    let emVoo: Voo | null = null;
    let ciclo = { ativo: false, drenando: false, renovacoes: 0, tentativasExtras: 0 };
    const esquecidas = new Set<string>();
    const ouvintes = new Set<(e: EstadoFilaLogo) => void>();
    const esperas = new Set<() => void>();
    const confirmados: ConfirmadosLogo = { n: 0, posicoes: {} };

    function estado(): EstadoFilaLogo {
        const posicoes: Record<string, PosicaoLogoEnvio> = {};
        let mostrar: boolean | undefined;
        const adiadosComoCampos = new Map([...adiados].map(([id, i]) => [campoPosicao(id), i] as const));
        for (const camada of [emVoo?.tipo === 'buffet' ? emVoo.campos : null, pendente, adiadosComoCampos]) {
            if (!camada) continue;
            for (const [campo, i] of camada) {
                const arte = arteDoCampo(campo);
                if (arte === null) mostrar = i.valor as boolean;
                else if (!esquecidas.has(arte)) posicoes[arte] = i.valor as PosicaoLogoEnvio;
            }
        }
        const situacao = superada ? 'superada' : ciclo.ativo || adiados.size > 0 ? 'salvando' : parado ? 'erro' : jaSalvou ? 'salvo' : 'ocioso';
        const conf: ConfirmadosLogo = { n: confirmados.n, ...(confirmados.mostrar ? { mostrar: { ...confirmados.mostrar } } : {}), posicoes: { ...confirmados.posicoes } };
        return { situacao, pendente: temPendencia(), epoca, ...(mostrar === undefined ? {} : { mostrar }), posicoes, confirmados: conf };
    }
    function temPendencia() { return !superada && (adiados.size > 0 || pendente.size > 0 || emVoo !== null); }
    function notificar() {
        for (const espera of [...esperas]) espera();
        const e = estado();
        for (const fn of [...ouvintes]) fn(e);
    }

    /** Conferência de dono: diferente da referência → superada (permanente). Sem persistência não há conferência. */
    function conferir(): boolean {
        if (superada) return false;
        if (semPersistencia) return true;
        let atual: string | null;
        try { atual = armazenamento!.getItem(chave); }
        catch { semPersistencia = true; return true; }
        if (atual === referencia) return true;
        superar();
        return false;
    }
    function superar() {
        superada = true;
        pendente.clear(); adiados.clear();
        if (relogio !== null) { cancelar(relogio); relogio = null; }
        ciclo = { ativo: false, drenando: false, renovacoes: 0, tentativasExtras: 0 };
        notificar();
    }

    function novoCiclo() {
        parado = false;
        ciclo = { ativo: true, drenando: false, renovacoes: 0, tentativasExtras: 0 };
    }
    function encerrarCiclo(erro: boolean) {
        ciclo = { ativo: false, drenando: false, renovacoes: 0, tentativasExtras: 0 };
        parado = erro;
        if (!erro) jaSalvou = true;
        notificar();
    }
    function iniciarOuSeguir() {
        if (!ciclo.ativo) novoCiclo();
        bombear();
        notificar();
    }

    function bombear() {
        if (superada || suspensa || emVoo || !ciclo.ativo) return;
        if (pendente.size === 0) { encerrarCiclo(false); return; }
        if (!conferir()) return;
        if (!sessao) abrir();
        else enviarBuffet();
    }

    function chamar(corpo: object) {
        try { return op.transporte(corpo); }
        catch (e) { return Promise.reject(e); }
    }

    function abrir() {
        let substitui: string | undefined;
        // Só o id da própria chave (o dela) ou, na primeira abertura, o deixado por um documento anterior ao nascimento:
        // a conferência acabou de garantir que o storage é igual à referência.
        if (!semPersistencia && referencia) {
            try {
                const v = JSON.parse(referencia) as { id?: unknown };
                if (typeof v?.id === 'string') substitui = v.id;
            }
            catch { /* valor ilegível: abre sem substituir */ }
        }
        emVoo = { tipo: 'sessao' };
        chamar({ acao: 'logo_sessao', ...(substitui ? { substitui } : {}) }).then(aoAbrir, (e) => aoFalhar(e, null));
    }

    function aoAbrir(r: Awaited<ReturnType<Transporte>>) {
        emVoo = null;
        // Já superada: avisa a tela para tirar a intenção que estava em voo.
        if (superada) { notificar(); return; }
        if (!conferir()) return;
        const id = (r.data as { logoSessao?: unknown } | undefined)?.logoSessao;
        if (r.status >= 200 && r.status < 300 && typeof id === 'string') {
            if (!semPersistencia) {
                const valor = JSON.stringify({ id, dono: geracao });
                try { armazenamento!.setItem(chave, valor); referencia = valor; }
                catch {
                    // Não deixar um id antigo como referência; daqui em diante a ordem entre documentos não é garantida (D-L3-6).
                    try { armazenamento!.removeItem(chave); } catch { /* pior caso: outro documento substitui uma sessão morta */ }
                    semPersistencia = true;
                }
            }
            sessao = id;
            seq = 0;
            bombear();
            notificar();
            return;
        }
        falhou(r, null, null);
    }

    function enviarBuffet() {
        const campos = new Map<string, Intencao>();
        const m = pendente.get(CAMPO_MOSTRAR);
        if (m) campos.set(CAMPO_MOSTRAR, m);
        const posicoes = [...pendente].filter(([c]) => c !== CAMPO_MOSTRAR).sort((a, b) => a[1].versao - b[1].versao).slice(0, POSICOES_POR_COMANDO);
        for (const [c, i] of posicoes) campos.set(c, i);
        for (const c of campos.keys()) pendente.delete(c);
        seq += 1;
        const corpo = {
            acao: 'logo_buffet', sessao, seq,
            ...(m ? { mostrar: m.valor as boolean } : {}),
            ...(posicoes.length ? {
                posicoes: posicoes.map(([, i]) => {
                    const p = i.valor as PosicaoLogoEnvio;
                    return { modo: p.modo, arteId: p.arteId, x: p.x, y: p.y, largura: p.largura, fundo: p.fundo };
                }),
            } : {}),
        };
        emVoo = { tipo: 'buffet', campos };
        chamar(corpo).then((r) => aoBuffet(r, campos), (e) => aoFalhar(e, campos));
    }

    function aoBuffet(r: Awaited<ReturnType<Transporte>>, campos: Map<string, Intencao>) {
        emVoo = null;
        // Já superada: avisa a tela para tirar a intenção que estava em voo.
        if (superada) { notificar(); return; }
        if (!conferir()) return;
        if (r.status >= 200 && r.status < 300) {
            const dados = r.data as { artesAusentes?: unknown; aplicado?: { mostrar?: unknown; posicoes?: Record<string, unknown> } } | undefined;
            const ausentes = new Set(Array.isArray(dados?.artesAusentes) ? dados.artesAusentes.filter((id): id is string => typeof id === 'string') : []);
            for (const id of ausentes) esquecer(id);
            confirmar(campos, dados?.aplicado, ausentes);
            bombear();
            notificar();
            return;
        }
        if (r.status === 409 && r.codigo === 'sessao_expirada') {
            devolver(campos);
            sessao = null;
            if (ciclo.renovacoes === 0) {
                ciclo.renovacoes = 1;
                bombear();
                notificar();
                return;
            }
            encerrarCiclo(true);
            return;
        }
        falhou(r, null, campos);
    }

    function aoFalhar(e: unknown, campos: Map<string, Intencao> | null) {
        emVoo = null;
        // Já superada: avisa a tela para tirar a intenção que estava em voo.
        if (superada) { notificar(); return; }
        if (!conferir()) return;
        falhou(null, e, campos);
    }

    function falhou(r: Awaited<ReturnType<Transporte>> | null, erro: unknown, campos: Map<string, Intencao> | null) {
        if (campos) devolver(campos);
        const retentavel = r ? r.status >= 500 : falhaRetentavel(erro);
        if (retentavel && ciclo.drenando && ciclo.tentativasExtras === 0) {
            ciclo.tentativasExtras = 1;
            bombear();
            notificar();
            return;
        }
        encerrarCiclo(true);
    }

    /** Campos de um comando sem sucesso voltam só se não há intenção mais nova do mesmo campo nem arte esquecida. */
    function devolver(campos: Map<string, Intencao>) {
        for (const [c, i] of campos) {
            const arte = arteDoCampo(c);
            if (arte !== null && (esquecidas.has(arte) || adiados.has(arte))) continue;
            if (pendente.has(c)) continue;
            pendente.set(c, i);
        }
    }

    /** Registra só os campos que a resposta marcou como aplicados; a confirmação conta como mudança para a regra da época. */
    function confirmar(campos: Map<string, Intencao>, aplicado: { mostrar?: unknown; posicoes?: Record<string, unknown> } | undefined, ausentes: Set<string>) {
        let houve = false;
        for (const [c, i] of campos) {
            const arte = arteDoCampo(c);
            if (arte === null) {
                if (aplicado?.mostrar !== true) continue;
                confirmados.mostrar = { valor: i.valor as boolean, n: confirmados.n + 1 };
            } else {
                if (ausentes.has(arte) || esquecidas.has(arte) || aplicado?.posicoes?.[arte] !== true) continue;
                confirmados.posicoes[arte] = { valor: { ...(i.valor as PosicaoLogoEnvio) }, n: confirmados.n + 1 };
            }
            houve = true;
        }
        if (houve) { confirmados.n += 1; epoca += 1; }
    }

    function esquecer(arteId: string) {
        esquecidas.add(arteId);
        pendente.delete(campoPosicao(arteId));
        if (adiados.delete(arteId) && adiados.size === 0 && relogio !== null) { cancelar(relogio); relogio = null; }
    }

    function moverAdiados() {
        if (relogio !== null) { cancelar(relogio); relogio = null; }
        if (adiados.size === 0) return false;
        for (const [id, i] of adiados) pendente.set(campoPosicao(id), i);
        adiados.clear();
        return true;
    }

    function intencao(campo: string, valor: boolean | PosicaoLogoEnvio) {
        epoca += 1; versao += 1;
        pendente.set(campo, { valor, versao });
        iniciarOuSeguir();
    }

    return {
        mostrar(v) {
            if (superada) return;
            intencao(CAMPO_MOSTRAR, v);
        },
        posicao(p, opcoes) {
            if (superada || esquecidas.has(p.arteId)) return;
            if (opcoes?.adiar) {
                epoca += 1; versao += 1;
                adiados.set(p.arteId, { valor: { ...p }, versao });
                if (relogio !== null) cancelar(relogio);
                relogio = agendar(() => {
                    relogio = null;
                    if (superada || !conferir()) return;
                    if (moverAdiados()) iniciarOuSeguir();
                }, ESPERA_TECLADO_MS);
                notificar();
                return;
            }
            if (adiados.delete(p.arteId) && adiados.size === 0 && relogio !== null) { cancelar(relogio); relogio = null; }
            intencao(campoPosicao(p.arteId), { ...p });
        },
        cancelarAdiado(arteId) {
            if (!adiados.delete(arteId)) return;
            if (adiados.size === 0 && relogio !== null) { cancelar(relogio); relogio = null; }
            notificar();
        },
        drenar() {
            if (superada) return;
            const havia = moverAdiados();
            if (!ciclo.ativo) {
                if ((parado && !havia) || pendente.size === 0) { notificar(); return; }
                novoCiclo();
            }
            ciclo.drenando = true;
            bombear();
            notificar();
        },
        tentarDeNovo() {
            if (superada) return;
            moverAdiados();
            if (ciclo.ativo || pendente.size === 0) { notificar(); return; }
            novoCiclo();
            bombear();
            notificar();
        },
        esquecerArte(arteId) {
            esquecer(arteId);
            notificar();
        },
        estado,
        assinar(fn) {
            ouvintes.add(fn);
            return () => { ouvintes.delete(fn); };
        },
        temPendencia,
        epoca: () => epoca,
        aguardarMostrar(ms) {
            return new Promise((resolver) => {
                let prazo: unknown = null, feito = false;
                const fim = (r: 'ok' | 'tempo' | 'erro') => {
                    if (feito) return;
                    feito = true;
                    esperas.delete(checar);
                    if (prazo !== null) cancelar(prazo);
                    resolver(r);
                };
                function checar() {
                    if (superada) return fim('erro');
                    const pend = pendente.has(CAMPO_MOSTRAR);
                    const voando = emVoo?.tipo === 'buffet' && emVoo.campos.has(CAMPO_MOSTRAR);
                    if (!pend && !voando) return fim('ok');
                    if (parado && !ciclo.ativo && pend) return fim('erro');
                }
                esperas.add(checar);
                checar();
                if (!feito) prazo = agendar(() => { prazo = null; fim('tempo'); }, ms);
            });
        },
        suspender() { suspensa = true; },
        retomar() {
            if (!suspensa) return;
            suspensa = false;
            if (superada || !conferir()) return;
            bombear();
            notificar();
        },
    };
}

/** Lê o corpo da resposta da rota administrativa; corpo ilegível é erro terminal (não é transporte). */
export class ErroCorpoLogo extends Error {}

async function transporteAdmin(endpoint: string, corpo: object) {
    const r = await adminFetch(endpoint, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
    let j: { codigo?: unknown; data?: unknown } | null;
    try { j = await r.json() as typeof j; }
    catch { throw new ErroCorpoLogo('Resposta ilegível.'); }
    return { status: r.status, ...(typeof j?.codigo === 'string' ? { codigo: j.codigo } : {}), data: j?.data };
}

/** Rota administrativa do convite (r2, Astra r1 P1): o endereço nasce do id, nunca de um valor montado antes da leitura. */
export const endpointDaLogo = (conviteId: string) => `/api/admin/convites?conviteId=${encodeURIComponent(conviteId)}`;

const instancias = new Map<string, FilaLogo>();
/**
 * r4 (Astra r3, P2): foto do número confirmado de cada fila deste documento, tirada antes de uma leitura. Não depende
 * do id do convite (que só se sabe na resposta); fila ausente na foto = criada depois do início, então tudo dela é novo.
 */
export function confirmadosDasFilas(): ReadonlyMap<string, number> {
    return new Map([...instancias].map(([id, f]) => [id, f.estado().confirmados.n]));
}
/** Uma instância por convite neste documento; sobrevive à desmontagem do editor numa navegação interna. */
export function filaDaLogo(conviteId: string): FilaLogo {
    if (!conviteId) throw new Error('Fila da logo sem convite.');
    const existente = instancias.get(conviteId);
    if (existente) return existente;
    const endpoint = endpointDaLogo(conviteId);
    const armazenamento: ArmazenamentoAba = {
        getItem: (k) => globalThis.sessionStorage.getItem(k),
        setItem: (k, v) => globalThis.sessionStorage.setItem(k, v),
        removeItem: (k) => globalThis.sessionStorage.removeItem(k),
    };
    const fila = criarFilaLogo({ conviteId, transporte: (corpo) => transporteAdmin(endpoint, corpo), armazenamento });
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('pagehide', () => fila.suspender());
        window.addEventListener('pageshow', () => fila.retomar());
    }
    instancias.set(conviteId, fila);
    return fila;
}
