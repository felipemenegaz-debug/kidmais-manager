/**
 * Catálogo versionado dos pacotes de créditos de IA. ESTA VERSÃO É DEMONSTRAÇÃO da PROPOSTA de 22/10/2026
 * (docs/PLANO_PACOTES_CREDITOS.md §3): preços, quantidades e validade são hipóteses ainda não aprovadas por Felipe,
 * jurídico ou contador. `aprovacao: null` impede a venda em produção (lib/creditos/config.ts) qualquer que seja a flag;
 * aprovar exige nova versão no código (revisão), com o registro da decisão, e a variável CREDITOS_CATALOGO_APROVADO igual
 * à versão. O pedido guarda a fotografia da oferta: mudar o catálogo nunca muda pedidos já feitos.
 *
 * Unidades: Convites = 1 geração concluída (arte ou convite completo); Wall-e = µUS$ de custo calculado de inferência
 * (1 crédito comercial = 1.000 µUS$ = US$ 0,001). Valores em centavos de real, inteiros.
 */
import { createHash } from 'node:crypto';

export type Recurso = 'CONVITES' | 'WALLE';
export type Oferta = {
    codigo: string; recurso: Recurso; nome: string;
    /** Quantidade na unidade interna do recurso (gerações; µUS$ no Wall-e). */
    quantidade: number;
    /** Quantidade mostrada à pessoa (gerações; créditos comerciais de US$ 0,001 no Wall-e). */
    quantidadeExibida: number;
    precoCentavos: number; validadeDias: number;
};
export type Catalogo = {
    versao: string; proposta: true | false;
    /** Registro da aprovação comercial/jurídica (null = não aprovado para venda). */
    aprovacao: null | { decisao: string; em: string };
    termos: { versao: string; texto: string };
    ofertas: readonly Oferta[];
};

export const MICROUSD_POR_CREDITO_WALLE = 1000;

const TERMOS_DEMO = [
    'Pacote de créditos de IA: compra avulsa para o recurso indicado, sem renovação automática.',
    'A oferta informa quantidade, unidade, preço e validade. Os créditos são liberados somente após a confirmação do pagamento pelo provedor.',
    'Créditos não substituem as autorizações de uso de dados e imagens nem afastam os limites de segurança.',
    'Garantia de 7 dias por compra, inclusive para CNPJ: devolução integral do valor pago, mesmo com utilização.',
    'Depois desse prazo, o saldo pago não utilizado pode ser devolvido pelo valor proporcional original.',
    'Direitos legais por arrependimento, falha e cobrança indevida são preservados.',
    'TEXTO DE DEMONSTRAÇÃO, sujeito à revisão jurídica: não é oferta vigente.',
].join('\n');

/** Proposta de 22/10/2026, NÃO aprovada (demonstração local). */
export const CATALOGO_DEMO: Catalogo = Object.freeze({
    versao: 'PROPOSTA-20261022-DEMO',
    proposta: true,
    aprovacao: null,
    termos: Object.freeze({ versao: 'creditos-ia-20261022.demo', texto: TERMOS_DEMO }),
    ofertas: Object.freeze([
        { codigo: 'CONVITES_10', recurso: 'CONVITES', nome: 'Convites — 10 gerações', quantidade: 10, quantidadeExibida: 10, precoCentavos: 5900, validadeDias: 365 },
        { codigo: 'CONVITES_30', recurso: 'CONVITES', nome: 'Convites — 30 gerações', quantidade: 30, quantidadeExibida: 30, precoCentavos: 15900, validadeDias: 365 },
        { codigo: 'CONVITES_100', recurso: 'CONVITES', nome: 'Convites — 100 gerações', quantidade: 100, quantidadeExibida: 100, precoCentavos: 49900, validadeDias: 365 },
        { codigo: 'WALLE_5000', recurso: 'WALLE', nome: 'Wall-e — 5.000 créditos', quantidade: 5_000_000, quantidadeExibida: 5000, precoCentavos: 9900, validadeDias: 365 },
        { codigo: 'WALLE_15000', recurso: 'WALLE', nome: 'Wall-e — 15.000 créditos', quantidade: 15_000_000, quantidadeExibida: 15000, precoCentavos: 26900, validadeDias: 365 },
        { codigo: 'WALLE_50000', recurso: 'WALLE', nome: 'Wall-e — 50.000 créditos', quantidade: 50_000_000, quantidadeExibida: 50000, precoCentavos: 84900, validadeDias: 365 },
    ].map((o) => Object.freeze(o as Oferta))),
}) as Catalogo;

/** Catálogo vigente no código. Trocar por uma versão aprovada exige revisão e o registro da decisão. */
export const CATALOGO_VIGENTE: Catalogo = CATALOGO_DEMO;

export const termosSha256 = (cat: Catalogo) => createHash('sha256').update(cat.termos.texto, 'utf8').digest('hex');

/** Validação estrutural (testada): inteiros seguros, códigos únicos, Wall-e múltiplo de 1.000 µUS$. */
export function validarCatalogo(cat: Catalogo) {
    const codigos = new Set<string>();
    if (!/^[A-Z0-9-]{3,60}$/.test(cat.versao)) throw new Error('versão de catálogo inválida');
    if (!/^[A-Za-z0-9._-]{3,60}$/.test(cat.termos.versao)) throw new Error('versão dos termos inválida');
    for (const o of cat.ofertas) {
        if (!/^[A-Z0-9_]{3,40}$/.test(o.codigo) || codigos.has(o.codigo)) throw new Error(`código de oferta inválido: ${o.codigo}`);
        codigos.add(o.codigo);
        for (const n of [o.quantidade, o.quantidadeExibida, o.precoCentavos, o.validadeDias])
            if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`valor inválido na oferta ${o.codigo}`);
        if (o.precoCentavos > 10_000_000 || o.validadeDias > 1100) throw new Error(`limite excedido na oferta ${o.codigo}`);
        if (o.recurso === 'WALLE' && o.quantidade !== o.quantidadeExibida * MICROUSD_POR_CREDITO_WALLE) throw new Error(`unidade Wall-e inconsistente em ${o.codigo}`);
        if (o.recurso === 'CONVITES' && o.quantidade !== o.quantidadeExibida) throw new Error(`unidade Convites inconsistente em ${o.codigo}`);
    }
    return true;
}

export function ofertaPorCodigo(cat: Catalogo, codigo: unknown) {
    return typeof codigo === 'string' ? cat.ofertas.find((o) => o.codigo === codigo) ?? null : null;
}

/** Fotografia gravada no pedido (sem dados pessoais). */
export function fotografiaOferta(cat: Catalogo, o: Oferta) {
    return { catalogo: cat.versao, proposta: cat.proposta, codigo: o.codigo, recurso: o.recurso, nome: o.nome, quantidade: o.quantidade,
        quantidadeExibida: o.quantidadeExibida, precoCentavos: o.precoCentavos, validadeDias: o.validadeDias, termos: cat.termos.versao };
}
