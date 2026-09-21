import type { ContratoSnapshotV1 } from '../repositories/models';
export function diferencasContratuais(antes: ContratoSnapshotV1, depois: ContratoSnapshotV1) {
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
export function analisarRevisao(antes: ContratoSnapshotV1, depois: ContratoSnapshotV1) {
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
