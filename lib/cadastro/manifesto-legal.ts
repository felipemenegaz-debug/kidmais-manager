import { createHash } from 'node:crypto';
import { hashDocumento, textoCanonico, type DocumentoPublicado, type TextoLegal } from './documentos-legais.ts';

/**
 * Manifesto congelado versão → SHA-256 dos textos legais (R-5, revisão do Astra de 03/11/2026). O hash calculado do
 * objeto corrente não prova nada sozinho: quem muda uma vírgula mantendo a versão também muda o hash "esperado". O
 * manifesto guarda, para cada versão já fixada, o hash e o texto canônico (lib/cadastro/textos-legais/), de modo que
 * reaproveitar uma versão com outro conteúdo, ou mudar o DPA sem nova versão dos Termos, reprova o teste. Novas
 * versões entram com `node --experimental-strip-types scripts/textos-legais-manifesto.mjs`, que nunca reescreve uma
 * entrada existente.
 */
export type EntradaManifesto = {
    documento: DocumentoPublicado; versao: string; sha256: string; arquivo: string;
    /** Só nos Termos que incorporam o DPA: a versão e o hash exatos do DPA citado no texto. */
    dpa?: { versao: string; sha256: string };
};

export const sha256 = (texto: string) => createHash('sha256').update(texto, 'utf8').digest('hex');
export const arquivoCanonico = (documento: DocumentoPublicado, versao: string) => `${documento}-${versao}.txt`;

/** Lista de problemas; vazia quando os documentos correntes e o histórico batem com o manifesto. */
export function conferirManifesto(docs: Record<DocumentoPublicado, TextoLegal>, manifesto: readonly EntradaManifesto[], ler: (arquivo: string) => string | null) {
    const erros: string[] = [], vistas = new Set<string>();
    for (const e of manifesto) {
        const chave = `${e.documento}@${e.versao}`;
        if (vistas.has(chave)) erros.push(`${chave}: versão repetida no manifesto`);
        vistas.add(chave);
        const texto = ler(e.arquivo);
        if (texto == null) erros.push(`${chave}: texto canônico ausente (${e.arquivo})`);
        else if (sha256(texto) !== e.sha256) erros.push(`${chave}: o texto canônico guardado não corresponde ao hash`);
    }
    for (const d of Object.values(docs)) {
        const e = manifesto.find((x) => x.documento === d.documento && x.versao === d.versao);
        if (!e) { erros.push(`${d.documento}@${d.versao}: versão sem entrada no manifesto`); continue; }
        if (hashDocumento(d) !== e.sha256) erros.push(`${d.documento}@${d.versao}: conteúdo mudou sem nova versão`);
        else if (ler(e.arquivo) !== textoCanonico(d)) erros.push(`${d.documento}@${d.versao}: texto canônico guardado diverge do publicado`);
    }
    const termos = manifesto.find((x) => x.documento === 'TERMOS_USO' && x.versao === docs.TERMOS_USO.versao);
    const dpa = { versao: docs.DPA.versao, sha256: hashDocumento(docs.DPA) };
    if (termos && (termos.dpa?.versao !== dpa.versao || termos.dpa?.sha256 !== dpa.sha256))
        erros.push(`TERMOS_USO@${docs.TERMOS_USO.versao}: o DPA mudou sem nova versão dos Termos`);
    return erros;
}
