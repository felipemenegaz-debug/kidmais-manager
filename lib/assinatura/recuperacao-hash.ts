import { createHash } from 'node:crypto';

/**
 * B-14 (plano rev. 8.1, §3.4): serialização canônica e hash da proposta de um caso.
 *   - JSON UTF-8 com chaves ordenadas; listas na ordem dada (quem monta ordena efeitos por tabela e chave: `ordenarEfeitos`);
 *   - números só inteiros seguros (dinheiro já em centavos); nada de NaN, undefined, função, Date ou objeto não plano —
 *     datas entram como texto (`AAAA-MM-DD` ou ISO-8601 UTC) para o hash não depender de fuso nem de formatação;
 *   - valores gerados na execução entram como marcador `{ "$gerado": "instante" | "id" | "contador" }`: o tipo do efeito faz parte do
 *     contrato, o valor não (relógio e ids novos só existem na aplicação).
 * Igualdade de payload = igualdade do texto canônico. Sem rede nem banco.
 */
export const FORMATO_PROPOSTA = 1;
export type Gerado = { $gerado: 'instante' | 'id' | 'contador' };
export const gerado = (tipo: Gerado['$gerado']): Gerado => ({ $gerado: tipo });

export class ValorNaoCanonico extends Error {
    constructor(caminho: string, motivo: string) {
        super(`Valor não canônico em ${caminho || '(raiz)'}: ${motivo}.`);
        this.name = 'ValorNaoCanonico';
    }
}

function canonico(v: unknown, caminho: string): string {
    if (v === null) return 'null';
    if (typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
    if (typeof v === 'number') {
        if (!Number.isSafeInteger(v)) throw new ValorNaoCanonico(caminho, 'número não inteiro (dinheiro vai em centavos)');
        return String(v);
    }
    if (Array.isArray(v)) return `[${v.map((x, i) => canonico(x, `${caminho}[${i}]`)).join(',')}]`;
    if (typeof v === 'object') {
        if (Object.getPrototypeOf(v) !== Object.prototype) throw new ValorNaoCanonico(caminho, 'objeto não plano (Date, Map…)');
        const o = v as Record<string, unknown>;
        return `{${Object.keys(o).sort().map((k) => {
            if (o[k] === undefined) throw new ValorNaoCanonico(`${caminho}.${k}`, 'undefined');
            return `${JSON.stringify(k)}:${canonico(o[k], `${caminho}.${k}`)}`;
        }).join(',')}}`;
    }
    throw new ValorNaoCanonico(caminho, typeof v);
}

export function serializarCanonico(v: unknown): string {
    return canonico(v, '');
}

export function hashCanonico(v: unknown): string {
    return createHash('sha256').update(serializarCanonico(v), 'utf8').digest('hex');
}

/** Efeito por linha: tabela, chave (concreta, ou símbolo `$lote`… para linha criada na aplicação) e colunas antes → depois. */
export type Efeito = { tabela: string; chave: string; operacao: 'INSERT' | 'UPDATE' | 'DELETE'; colunas: Record<string, { antes: unknown; depois: unknown }> };
export function ordenarEfeitos(efeitos: readonly Efeito[]): Efeito[] {
    return [...efeitos].sort((a, b) => a.tabela.localeCompare(b.tabela) || a.chave.localeCompare(b.chave) || a.operacao.localeCompare(b.operacao));
}

/** Proposta de um caso: pré-condições lidas, efeitos comerciais com valor fixo e efeitos operacionais por tipo. */
export type Proposta = { formato: number; caso: string; precondicoes: Record<string, unknown>; efeitos: Efeito[] };
export function hashProposta(p: Proposta): string {
    if (p.formato !== FORMATO_PROPOSTA) throw new ValorNaoCanonico('formato', `esperado ${FORMATO_PROPOSTA}`);
    return hashCanonico({ ...p, efeitos: ordenarEfeitos(p.efeitos) });
}

/** `aplicar-caso`: o payload recalculado na transação tem de ser idêntico ao aprovado (pré-condições e todos os efeitos). */
export function mesmaProposta(aprovado: string, recalculada: Proposta): boolean {
    return /^[0-9a-f]{64}$/.test(aprovado) && hashProposta(recalculada) === aprovado;
}
