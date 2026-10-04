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

/** Documental is descriptive, never permission to bypass the existing double signature. */
export function analisarRevisao(antes: ContratoSnapshot, depois: ContratoSnapshot) {
    const campos = diferencasContratuais(antes, depois).map(d => ({
        ...d, natureza: d.campo === 'documental.observacoes' ? 'DOCUMENTAL' as const : 'MATERIAL' as const,
    }));
    return {
        campos,
        natureza: campos.some(d => d.natureza === 'MATERIAL') ? 'MATERIAL' : campos.length ? 'DOCUMENTAL' : 'SEM_ALTERACOES',
        exigeNovaAssinatura: true,
        impactoFinanceiro: campos.some(d => d.campo.startsWith('comercial.')),
        alteraAgenda: campos.some(d => ['evento.data', 'evento.horarioInicio', 'evento.horarioFim'].includes(d.campo)),
    };
}
