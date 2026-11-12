import type { ContratoSnapshot } from '../repositories/models';

/**
 * Base histórica (061: versão 1 conferida em papel) traz metadados que a versão nativa seguinte não tem (origem,
 * histórico, condição do documento, itens do papel). Eles não são alteração: compara-se só o que a versão nova
 * descreve. Base nativa segue comparada por inteiro.
 */
function projetarBaseHistorica(antes: unknown, depois: unknown): unknown {
    if (!antes || typeof antes !== 'object' || Array.isArray(antes) || !depois || typeof depois !== 'object' || Array.isArray(depois)) return antes;
    const b = depois as Record<string, unknown>;
    return Object.fromEntries(Object.entries(antes as Record<string, unknown>).filter(([k]) => k in b).map(([k, v]) => [k, projetarBaseHistorica(v, b[k])]));
}
const baseHistorica = (s: unknown) => (s as { origem?: { tipo?: unknown } } | null)?.origem?.tipo === 'IMPORTACAO_HISTORICA';

export function diferencasContratuais(antesBruto: ContratoSnapshot, depois: ContratoSnapshot) {
    const antes = (baseHistorica(antesBruto) && !baseHistorica(depois) ? projetarBaseHistorica(antesBruto, depois) : antesBruto) as ContratoSnapshot;
    const resultado: Array<{
        campo: string;
        antes: unknown;
        depois: unknown;
    }> = [];
    const percorrer = (a: unknown, b: unknown, campo: string) => {
        if (JSON.stringify(a) === JSON.stringify(b))
            return;
        // S-E (R-E4): V1/V2 não têm salão nem horário configurado no evento. Salão ausente = nulo (sem diff artificial);
        // configuração ausente de um dos lados não é comparada. Entre dois V3, ambos são comparados.
        if (campo === 'evento.salao' && a == null && b == null)
            return;
        if (campo === 'evento.configuracaoAgendaId' && (a === undefined || b === undefined))
            return;
        if (((a && typeof a === 'object') || (b && typeof b === 'object')) && !Array.isArray(a) && !Array.isArray(b)) {
            const aa = (a && typeof a === 'object' ? a : {}) as Record<string, unknown>, bb = (b && typeof b === 'object' ? b : {}) as Record<string, unknown>;
            for (const chave of new Set([...Object.keys(aa), ...Object.keys(bb)])) {
                if ((!campo && ['schemaVersao', 'revisaoOperacional'].includes(chave)) || (campo === 'fechamento' && chave === 'status'))
                    continue;
                percorrer(aa[chave], bb[chave], campo ? campo + '.' + chave : chave);
            }
        }
        else
            resultado.push({ campo, antes: a ?? null, depois: b ?? null });
    };
    percorrer(antes, depois, '');
    return resultado;
}

/** Campos comerciais da reclassificação do contrato histórico (adicionais sem itens passam a compor o pacote). */
const CAMPOS_RECLASSIFICACAO = ['comercial.valorPacoteBase', 'comercial.valorPacoteAplicado', 'comercial.valorAdicionais'];

/**
 * Plano "importados com adicionais" (R2-4): contrato histórico cujos "Adicionais" do documento passam ao pacote na nova
 * versão. Só quando base e aplicado sobem exatamente o que os adicionais descem, sem desconto, e o total não muda. É só
 * explicação: as diferenças continuam listadas e a nova assinatura continua exigida.
 */
function reclassificacaoHistorica(antes: ContratoSnapshot, depois: ContratoSnapshot) {
    const historico = (s: ContratoSnapshot) => (s as { fechamento?: { origem?: string } }).fechamento?.origem === 'IMPORTACAO_HISTORICA'
        || (s as { origem?: { tipo?: string } }).origem?.tipo === 'IMPORTACAO_HISTORICA';
    if (!historico(antes) && !historico(depois)) return null;
    const a = antes.comercial as unknown as Record<string, number | null | undefined>, b = depois.comercial as unknown as Record<string, number | null | undefined>;
    const n = (v: number | null | undefined) => Math.round(Number(v ?? 0) * 100);
    const delta = n(a.valorAdicionais) - n(b.valorAdicionais);
    if (delta <= 0) return null;
    const ok = n(b.valorPacoteBase) - n(a.valorPacoteBase) === delta && n(b.valorPacoteAplicado) - n(a.valorPacoteAplicado) === delta
        && n(a.valorTabela) === n(b.valorTabela) && n(a.valorFinalContrato) === n(b.valorFinalContrato);
    return ok ? { valor: delta / 100 } : null;
}

/** Documental is descriptive, never permission to bypass the existing double signature. */
export function analisarRevisao(antes: ContratoSnapshot, depois: ContratoSnapshot) {
    const campos = diferencasContratuais(antes, depois).map(d => ({
        ...d, natureza: d.campo === 'documental.observacoes' ? 'DOCUMENTAL' as const : 'MATERIAL' as const,
    }));
    const reclassificacao = reclassificacaoHistorica(antes, depois);
    return {
        campos,
        natureza: campos.some(d => d.natureza === 'MATERIAL') ? 'MATERIAL' : campos.length ? 'DOCUMENTAL' : 'SEM_ALTERACOES',
        exigeNovaAssinatura: true,
        reclassificacaoHistorica: reclassificacao,
        // A reclassificação sozinha não muda a obrigação; qualquer OUTRA diferença comercial mantém o aviso de impacto.
        impactoFinanceiro: campos.some(d => d.campo.startsWith('comercial.') && !(reclassificacao && CAMPOS_RECLASSIFICACAO.includes(d.campo))),
        // S-E: trocar o salão (identidade) ou o horário configurado também altera a agenda.
        alteraAgenda: campos.some(d => ['evento.data', 'evento.horarioInicio', 'evento.horarioFim', 'evento.salao.id', 'evento.configuracaoAgendaId'].includes(d.campo)),
    };
}
