import type { DbExecutor } from '../db/contracts';
import { diferenca, semEfeito, valoresDoInstante, type Fotografia } from './recuperacao-efeitos.ts';
import { FORMATO_PROPOSTA, hashCanonico, hashProposta, mesmaProposta, type Proposta } from './recuperacao-hash.ts';

/**
 * B-14 (plano rev. 8.1, §3.4, §4): proposta e aplicação de UM caso.
 *   - proporCaso: dentro de um SAVEPOINT, fotografa, roda o processamento normal com um provedor que GRAVA cada leitura,
 *     fotografa de novo e desfaz tudo (ROLLBACK TO SAVEPOINT). A proposta = pré-condições (fotografia local e leituras do
 *     provedor) + efeitos por linha. Nada fica gravado.
 *   - aplicarCaso: refaz o mesmo caminho em T2, regrava os valores comerciais do instante aprovados e recalcula a proposta;
 *     só mantém as escritas se o hash for IDÊNTICO ao aprovado; senão desfaz e devolve DIVERGENTE (código 1, novo inventário).
 * Quem chama abre a transação, aplica a trava e faz COMMIT; aqui só SAVEPOINT.
 */
export type Leitura = { metodo: string; args: unknown[]; resultado: unknown };

/**
 * Campos de texto livre que o provedor devolve e que nenhuma decisão usa (revisão do Astra, rodada 2, P3): hoje só a
 * descrição dos estornos (`refunds[].description`, digitada no painel do Asaas). Saem da leitura GRAVADA antes de ela entrar
 * na proposta e no hash — nunca depois —; o serviço continua recebendo a leitura inteira.
 */
export const CAMPOS_LIVRES_DO_PROVEDOR = Object.freeze(['descricao']);
export function minimizarLeitura(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(minimizarLeitura);
    if (!v || typeof v !== 'object') return v;
    return Object.fromEntries(Object.entries(v).filter(([k]) => !CAMPOS_LIVRES_DO_PROVEDOR.includes(k)).map(([k, x]) => [k, minimizarLeitura(x)]));
}

/** Provedor que registra cada leitura (método, argumentos e resultado, minimizado) — as leituras viram pré-condição remota. */
export function gravarLeituras<P extends object>(provedor: P): { provedor: P; leituras: Leitura[] } {
    const leituras: Leitura[] = [];
    const embrulhado: Record<string, unknown> = {};
    for (const [nome, f] of Object.entries(provedor)) {
        if (typeof f !== 'function') continue;
        embrulhado[nome] = async (...args: unknown[]) => {
            const resultado = await (f as (...a: unknown[]) => Promise<unknown>)(...args);
            leituras.push({ metodo: nome, args: JSON.parse(paraJsonSeguro(args)), resultado: minimizarLeitura(JSON.parse(paraJsonSeguro(resultado ?? null))) });
            return resultado;
        };
    }
    return { provedor: Object.freeze(embrulhado) as P, leituras };
}

export type DepsCaso<P extends object> = {
    tx: DbExecutor;
    caso: string;
    provedor: P;
    fotografar: () => Promise<Fotografia>;
    /** O processamento normal do caso (sincronizarEmpresa, processarEvento, processarPedido…) com o provedor recebido. */
    executar: (provedor: P) => Promise<unknown>;
};

const PONTO = 'b14_caso';

/**
 * Falha ao desfazer/soltar o SAVEPOINT do caso (revisão de 27/10, D1): a transação externa fica em estado desconhecido e
 * TEM de ser desfeita por quem chama (ROLLBACK e fim da execução). Nunca é tratada como falha comum do caso. Sequências
 * (ids `GENERATED … AS IDENTITY`) consumidas na proposta não voltam com o ROLLBACK: por isso os ids novos são símbolos.
 */
export class LimpezaDoCasoFalhou extends Error {
    constructor(causa: unknown) {
        super('Falha ao desfazer o SAVEPOINT do caso: desfaça a transação externa.', { cause: causa });
        this.name = 'LimpezaDoCasoFalhou';
    }
}
async function limpar(tx: DbExecutor, desfazer: boolean) {
    try {
        if (desfazer) await tx.query(`ROLLBACK TO SAVEPOINT ${PONTO}`);
        await tx.query(`RELEASE SAVEPOINT ${PONTO}`);
    }
    catch (error) {
        throw new LimpezaDoCasoFalhou(error);
    }
}

async function rodar<P extends object>(d: DepsCaso<P>, depoisDeExecutar?: () => Promise<void>) {
    const antes = await d.fotografar();
    const { provedor, leituras } = gravarLeituras(d.provedor);
    const resultado = await d.executar(provedor);
    if (depoisDeExecutar) await depoisDeExecutar();
    const depois = await d.fotografar();
    const efeitos = diferenca(antes, depois);
    const proposta: Proposta = { formato: FORMATO_PROPOSTA, caso: d.caso, precondicoes: { local: hashCanonico(JSON.parse(paraJsonSeguro(antes))), remoto: leituras }, efeitos };
    return { proposta, resultado, efeitos, antes };
}

/** JSON aceito pela serialização canônica: número fracionário (numeric) vira texto. Usado na fotografia e nas leituras. */
function paraJsonSeguro(v: unknown) {
    return JSON.stringify(v, (_k, x) => (typeof x === 'number' && !Number.isSafeInteger(x) ? String(x) : x));
}

export async function proporCaso<P extends object>(d: DepsCaso<P>) {
    await d.tx.query(`SAVEPOINT ${PONTO}`);
    try {
        const r = await rodar(d);
        // `antes`: fotografia INTERNA do inventário, para as recusas, a comprovação e os indicadores (na proposta, só o sha).
        // Nunca vai para disco: a evidência exportável sai de `evidenciaDoCaso` (recuperacao-evidencia.ts).
        return { proposta: r.proposta, hash: hashProposta(r.proposta), semEfeito: semEfeito(r.efeitos), resultado: r.resultado, antes: r.antes };
    }
    finally {
        await limpar(d.tx, true);
    }
}

/** `proposta`: a recalculada em T2 — no DIVERGENTE, mostra o que mudou desde o inventário (nada fica gravado). */
export type ResultadoAplicacao = { situacao: 'APLICADO' | 'DIVERGENTE'; hash: string; proposta: Proposta };

export async function aplicarCaso<P extends object>(d: DepsCaso<P> & { regravar: (valores: ReturnType<typeof valoresDoInstante>) => Promise<void> },
    aprovado: { hash: string; proposta: Proposta }): Promise<ResultadoAplicacao> {
    if (!mesmaProposta(aprovado.hash, aprovado.proposta) || aprovado.proposta.caso !== d.caso) throw new Error('Proposta aprovada inconsistente com o hash ou com o caso.');
    await d.tx.query(`SAVEPOINT ${PONTO}`);
    let manter = false;
    try {
        const r = await rodar(d, () => d.regravar(valoresDoInstante(aprovado.proposta.efeitos)));
        const hash = hashProposta(r.proposta);
        manter = hash === aprovado.hash;
        return { situacao: manter ? 'APLICADO' : 'DIVERGENTE', hash, proposta: r.proposta };
    }
    finally {
        await limpar(d.tx, !manter);
    }
}
