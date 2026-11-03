import { buscar, semEnderecoDeMidia, trechoDe, termos } from '../conhecimento/busca.ts';
import { visivel, type Corpus, type DocumentoConhecimento } from '../conhecimento/corpus.ts';
import { ROTA_AJUDA } from './rota.ts';

/**
 * Central de ajuda do Admin (plano de suporte, fase 1, S3). Mesma fonte do MCP: `conhecimento/manifesto.json`.
 * Só aparece documento APROVADO, vigente e com ACL PLATAFORMA: a página não lê a sessão no servidor, então nunca
 * mostra documento restrito a uma empresa ou unidade, mesmo que exista no corpus.
 */
const LEITOR_SEM_EMPRESA = { empresaId: '00000000-0000-0000-0000-000000000000', estabelecimentoId: null };

export function naCentral(doc: DocumentoConhecimento, hoje: string) {
    return doc.acl.tipo === 'PLATAFORMA' && visivel(doc, LEITOR_SEM_EMPRESA, hoje);
}

export function artigosDaCentral(corpus: Corpus | null, hoje: string) {
    if (!corpus) return [];
    return corpus.documentos.filter((doc) => naCentral(doc, hoje))
        .map((doc) => ({ id: doc.id, titulo: doc.titulo, ate: doc.vigenteAte }))
        .sort((a, b) => a.titulo.localeCompare(b.titulo, 'pt-BR'));
}

export function artigoDaCentral(corpus: Corpus | null, hoje: string, id: string) {
    return corpus?.documentos.find((doc) => doc.id === id && naCentral(doc, hoje)) ?? null;
}

export const CONSULTA_MAX = 120;
const RESULTADOS = 8;
const TRECHO = 220;

export function buscarNaCentral(corpus: Corpus | null, hoje: string, consulta: string) {
    const q = consulta.trim().slice(0, CONSULTA_MAX);
    if (!corpus || !q) return [];
    const publicos: Corpus = { documentos: corpus.documentos.filter((doc) => naCentral(doc, hoje)) };
    const chaves = termos(q);
    return buscar(publicos, LEITOR_SEM_EMPRESA, hoje, q, RESULTADOS).map((r) => ({
        id: r.doc.id,
        titulo: r.doc.titulo,
        secao: r.secao.titulo,
        href: rotaDoArtigo(r.doc.id, r.secao.indice),
        trecho: trechoDe(textoSemMarcacao(r.secao.texto), chaves, TRECHO),
    }));
}

export function rotaDoArtigo(id: string, secao?: number) {
    return `${ROTA_AJUDA}/${id}${secao === undefined ? '' : `#secao-${secao}`}`;
}

// ---------------------------------------------------------------- texto do artigo

/**
 * Markdown mínimo e fechado: parágrafos, listas "- " e "1. ", **negrito** e links internos. Nada vira HTML cru (o React
 * escapa o texto); link só para rota interna do Admin ou de Clientes, nunca externo, `javascript:` ou outro esquema.
 * Mídia em linha própria, só arquivo da própria aplicação em `public/ajuda/` e sempre com texto alternativo:
 *   ![descrição](/ajuda/imagens/nome.png)        imagem (png, webp ou jpg)
 *   !video[descrição](/ajuda/videos/nome.mp4)    vídeo com capa nome.jpg e legenda nome.vtt ao lado
 * Qualquer outro endereço vira só o texto da descrição.
 */
export type Trecho = { tipo: 'texto'; texto: string } | { tipo: 'negrito'; texto: string } | { tipo: 'link'; texto: string; href: string };
export type Bloco = { tipo: 'p'; trechos: Trecho[] } | { tipo: 'ul' | 'ol'; itens: Trecho[][] }
    | { tipo: 'imagem'; src: string; alt: string } | { tipo: 'video'; src: string; capa: string; legenda: string; alt: string };

const MIDIA = /^(!|!video)\[([^\]]{3,200})\]\(([^)\s]+)\)$/;
const IMAGEM = /^\/ajuda\/imagens\/[a-z0-9][a-z0-9-]{0,80}\.(png|webp|jpg)$/;
const VIDEO = /^\/ajuda\/videos\/[a-z0-9][a-z0-9-]{0,80}\.mp4$/;

/** Linha de mídia: imagem ou vídeo válidos viram bloco próprio; endereço fora da regra vira só a descrição. */
export function midia(linha: string): Bloco | null {
    const m = MIDIA.exec(linha);
    if (!m) return null;
    const [, marca, bruto, src] = m;
    const alt = bruto.trim();
    if (alt.length < 3) return null;
    if (marca === '!' && IMAGEM.test(src)) return { tipo: 'imagem', src, alt };
    if (marca === '!video' && VIDEO.test(src)) {
        const base = src.slice(0, -'.mp4'.length);
        return { tipo: 'video', src, capa: `${base}.jpg`, legenda: `${base}.vtt`, alt };
    }
    return { tipo: 'p', trechos: [{ tipo: 'texto', texto: alt }] };
}

/** Texto corrido para trechos da busca: sem negrito, link vira o texto e mídia vira a descrição. */
export function textoSemMarcacao(texto: string) {
    return semEnderecoDeMidia(texto).replace(/\*\*/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
}

const LINK_INTERNO = /^\/(admin|clientes)(\/[a-z0-9-]+)*\/?(#[a-z0-9-]+)?$/;

export function linkInterno(href: string) {
    return LINK_INTERNO.test(href);
}

export function trechos(linha: string): Trecho[] {
    const saida: Trecho[] = [];
    const padrao = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
    let ultimo = 0;
    for (let m = padrao.exec(linha); m; m = padrao.exec(linha)) {
        if (m.index > ultimo) saida.push({ tipo: 'texto', texto: linha.slice(ultimo, m.index) });
        if (m[1] !== undefined) saida.push({ tipo: 'negrito', texto: m[1] });
        else if (linkInterno(m[3])) saida.push({ tipo: 'link', texto: m[2], href: m[3] });
        else saida.push({ tipo: 'texto', texto: m[2] });
        ultimo = padrao.lastIndex;
    }
    if (ultimo < linha.length) saida.push({ tipo: 'texto', texto: linha.slice(ultimo) });
    return saida;
}

export function blocos(texto: string): Bloco[] {
    const saida: Bloco[] = [];
    let paragrafo: string[] = [];
    let lista: { tipo: 'ul' | 'ol'; itens: string[] } | null = null;
    const fechar = () => {
        if (paragrafo.length) saida.push({ tipo: 'p', trechos: trechos(paragrafo.join(' ')) });
        if (lista) saida.push({ tipo: lista.tipo, itens: lista.itens.map(trechos) });
        paragrafo = [];
        lista = null;
    };
    for (const bruta of texto.replace(/\r\n?/g, '\n').split('\n')) {
        const linha = bruta.trim();
        const item = /^(?:([-*])|(\d{1,3})[.)])\s+(.*)$/.exec(linha);
        const bloco = linha ? midia(linha) : null;
        if (!linha) fechar();
        else if (bloco) {
            fechar();
            saida.push(bloco);
        } else if (item) {
            const tipo = item[1] ? 'ul' : 'ol';
            if (paragrafo.length || (lista && lista.tipo !== tipo)) fechar();
            lista ??= { tipo, itens: [] };
            lista.itens.push(item[3]);
        } else if (lista && /^\s{2,}/.test(bruta)) lista.itens[lista.itens.length - 1] += ` ${linha}`;
        else {
            if (lista) fechar();
            paragrafo.push(linha.replace(/^#{1,6}\s+/, ''));
        }
    }
    fechar();
    return saida;
}
