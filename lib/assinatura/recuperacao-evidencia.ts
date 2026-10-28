import type { ItemBase } from './recuperacao-baseline.ts';
import type { PropostaDoCaso } from './recuperacao-casos.ts';
import type { Classificacao } from './recuperacao-classes.ts';

/**
 * B-14 (plano rev. 8.1, §3.3, §3.4; revisão de 27/10, P3-6): evidência EXPORTÁVEL de um caso, com lista explícita de
 * campos. A fotografia interna (`antes`) nunca entra: ela traz auditorias históricas inteiras e linhas que não interessam à
 * decisão. Ficam só:
 *   - o caso (tipo e identidade, nunca o id interno);
 *   - a classe, as recusas e o motivo;
 *   - o hash estrito e a proposta inteira (sem eles não há `aplicar-caso`: o hash cobre exatamente esse conteúdo; a
 *     fotografia prévia entra nela só como sha);
 *   - o hash comparável, os indicadores e os limites da linha de base;
 *   - a falha sanitizada do serviço (só o código).
 * Permissão 600 no arquivo continua exigida por quem grava; ela não substitui esta minimização.
 */
export type EvidenciaDoCaso = {
    tipo: string;
    identidade: string;
    classe: Classificacao['classe'];
    recusas: Classificacao['recusas'];
    motivo: string | null;
    falha: string | null;
    hash: string | null;
    hashComparavel: string | null;
    indicadores: ItemBase['indicadores'];
    limites: ItemBase['limites'];
    proposta: PropostaDoCaso['proposta'];
};

export function evidenciaDoCaso(p: PropostaDoCaso, c: Classificacao, item: ItemBase): EvidenciaDoCaso {
    return {
        tipo: p.caso.tipo,
        identidade: p.identidade,
        classe: c.classe,
        recusas: [...c.recusas],
        motivo: c.motivo,
        falha: p.falha,
        hash: p.hash,
        hashComparavel: item.hashComparavel,
        indicadores: { ...item.indicadores },
        limites: { ...item.limites },
        proposta: p.proposta,
    };
}
