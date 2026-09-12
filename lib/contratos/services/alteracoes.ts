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
                if (['id', 'clienteId', 'adicionalId', 'status', 'schemaVersao', 'revisaoOperacional'].includes(chave))
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
