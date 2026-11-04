/**
 * Franquias de IA por plano — regra pura (plano "Franquias de IA por plano 20261102", rev. 4.1, §4.2; D-FR-1..12 decididas
 * por Felipe em 03/11/2026). Sem banco, sem relógio: o devido do mês é RECONSTRUÍDO do histórico comercial do ciclo, então
 * a ordem e o atraso das execuções nunca mudam o resultado.
 *
 *   V(p)   = max(piso legado, tabela[p])            (piso só em CONVITES; WHATSAPP = 0)
 *   V0     = V do plano vigente no INÍCIO do ciclo   (sem contratação vigente: o piso)
 *   devido = V0 + Σ ceil((Vi − M) × fração(confirmada_em_i)) para cada contratação do ciclo com Vi > M (M = maior V já alcançado)
 *   fração = (dias do mês − dia da confirmação + 1) ÷ dias do mês   (conta o dia da confirmação, em São Paulo)
 * Downgrade e retorno a um plano já alcançado não somam nem retiram. devido ≤ M final.
 */

/** Tabela versionada (D-FR-1, D-FR-4; WhatsApp de D-PL-2). Mudar números = PR revisada com versão nova. */
export const TABELA_FRANQUIAS = Object.freeze({
    versao: '2026-11-03',
    CONVITES: Object.freeze({ essencial: 10, profissional: 15, premium: 30 }),
    WHATSAPP: Object.freeze({ essencial: 0, profissional: 0, premium: 300 }),
    COPILOTO: Object.freeze({ essencial: 100, profissional: 300, premium: 1000 }),
});
export type RecursoFranquia = 'CONVITES' | 'WHATSAPP' | 'COPILOTO';
export type PlanoFranquia = 'essencial' | 'profissional' | 'premium';

export function valorDoPlano(recurso: RecursoFranquia, plano: PlanoFranquia | null, piso: number) {
    if (!Number.isSafeInteger(piso) || piso < 0) throw new Error('piso inválido');
    return Math.max(piso, plano ? TABELA_FRANQUIAS[recurso][plano] : 0);
}

/** Uma contratação confirmada DENTRO do ciclo: dia (1..31, em São Paulo), plano e o instante da confirmação (auditoria). */
export type MudancaNoCiclo = { dia: number; plano: PlanoFranquia; contratacaoId: string; confirmadaEm?: string };
/** `inicial`: a contratação vigente no início do ciclo (a do V0), só para a fotografia de auditoria. */
export type Historico = { recurso: RecursoFranquia; piso: number; diasNoMes: number; planoInicial: PlanoFranquia | null; mudancas: readonly MudancaNoCiclo[];
    inicial?: { contratacaoId: string; confirmadaEm: string } | null };
export type Segmento = { contratacaoId: string | null; plano: PlanoFranquia | null; confirmadaEm: string | null; dia: number; valor: number; parcela: number };

export function devidoDoCiclo(h: Historico): { devido: number; maximo: number; segmentos: Segmento[] } {
    if (!Number.isSafeInteger(h.diasNoMes) || h.diasNoMes < 28 || h.diasNoMes > 31) throw new Error('dias do mês inválidos');
    const v0 = valorDoPlano(h.recurso, h.planoInicial, h.piso);
    let maximo = v0, devido = v0;
    const segmentos: Segmento[] = [{ contratacaoId: h.inicial?.contratacaoId ?? null, plano: h.planoInicial, confirmadaEm: h.inicial?.confirmadaEm ?? null,
        dia: 1, valor: v0, parcela: v0 }];
    let anterior = 1;
    for (const m of h.mudancas) {
        if (!Number.isSafeInteger(m.dia) || m.dia < 1 || m.dia > h.diasNoMes) throw new Error('dia da confirmação inválido');
        if (m.dia < anterior) throw new Error('mudanças fora de ordem');
        anterior = m.dia;
        const valor = valorDoPlano(h.recurso, m.plano, h.piso);
        let parcela = 0;
        if (valor > maximo) {
            // Teto inteiro de (diferença × dias restantes) ÷ dias do mês, sem ponto flutuante.
            const produto = (valor - maximo) * (h.diasNoMes - m.dia + 1);
            parcela = Math.floor((produto + h.diasNoMes - 1) / h.diasNoMes);
            devido += parcela;
            maximo = valor;
        }
        segmentos.push({ contratacaoId: m.contratacaoId, plano: m.plano, confirmadaEm: m.confirmadaEm ?? null, dia: m.dia, valor, parcela });
    }
    return { devido, maximo, segmentos };
}

/** Chave do lote de franquia: a mensal sem sufixo; os complementos com :R<n> (n = linhas do ciclo + 1, sob a trava). */
export function chaveFranquia(ciclo: string, linhasNoCiclo: number, haLoteMensal: boolean) {
    if (!/^\d{4}-\d{2}-01$/.test(ciclo)) throw new Error('ciclo inválido');
    const base = `FRANQUIA:${ciclo.slice(0, 7)}`;
    return haLoteMensal ? `${base}:R${linhasNoCiclo + 1}` : base;
}

/** Avisos de uso (D-FR-5/§4.6): 80% e 100% de `uso` sobre `base` (direito do ciclo + saldos válidos; ver avisosDeUsoFranquia). */
export function marcoDeUso(consumido: number, direito: number): 'FRANQUIA_100' | 'FRANQUIA_80' | null {
    if (direito <= 0) return null;
    if (consumido >= direito) return 'FRANQUIA_100';
    if (consumido * 5 >= direito * 4) return 'FRANQUIA_80';
    return null;
}
