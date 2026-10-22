/**
 * Flags e travas dos créditos de IA (095). Tudo server-side e DESLIGADO por padrão: só o texto exato `true` liga.
 *
 *   CREDITOS_CATALOGO_ATIVO          mostra o catálogo de pacotes (sem ele, nenhuma oferta é exibida nem aceita);
 *   CREDITOS_COMPRA_ATIVA            aceita novos pedidos de compra (exige também o catálogo);
 *   CREDITOS_CONVITES_CONSUMO_ATIVO  geração de Convites debita do motor novo nas empresas com corte registrado;
 *   CREDITOS_WALLE_CONSUMO_ATIVO     reservas/débitos do Wall-e no motor novo (o atendimento continua com gates próprios);
 *   CREDITOS_ESTORNO_ATIVO           estorno automático de pacote (Pix/cartão) pelo provedor; sem ela, fila manual.
 * Nunca reutiliza ASSINATURA_ESTORNO_ATIVO (assinatura e pacote têm filas e decisões separadas).
 *
 * Desligar compra ou consumo NÃO desliga obrigações já assumidas: webhook, reconciliação, histórico, devolução e o
 * encerramento de reservas abertas continuam funcionando com qualquer combinação de flags.
 *
 * Produção (KIDMAIS_DEPLOY_ENV=production): além das flags, a venda exige que a versão do catálogo no código tenha
 * aprovação registrada (`aprovacao`, revisada em PR) e que CREDITOS_CATALOGO_APROVADO repita exatamente essa versão.
 * O catálogo de demonstração desta entrega não tem aprovação: em produção a venda fica recusada qualquer que seja a flag.
 */
import { atendimentoAtivo, modoEntendimento } from '../whatsapp/atendimento/configuracao.ts';
import type { Catalogo } from './catalogo.ts';

type Ambiente = Record<string, string | undefined>;
const ligada = (v: string | undefined) => v?.trim() === 'true';

export type FlagsCreditos = { catalogo: boolean; compra: boolean; consumoConvites: boolean; consumoWalle: boolean; estorno: boolean };
export function flagsCreditos(env: Ambiente = process.env): FlagsCreditos {
    return {
        catalogo: ligada(env.CREDITOS_CATALOGO_ATIVO),
        compra: ligada(env.CREDITOS_COMPRA_ATIVA),
        consumoConvites: ligada(env.CREDITOS_CONVITES_CONSUMO_ATIVO),
        consumoWalle: ligada(env.CREDITOS_WALLE_CONSUMO_ATIVO),
        estorno: ligada(env.CREDITOS_ESTORNO_ATIVO),
    };
}

export const servicoDeProducao = (env: Ambiente = process.env) => env.KIDMAIS_DEPLOY_ENV?.trim() === 'production';
/**
 * P3-7 (revisão de 22/10): só staging declarado ou execução local (fora do Render e fora de NODE_ENV=production) vendem
 * catálogo sem aprovação. Qualquer outro ambiente sem `KIDMAIS_DEPLOY_ENV` reconhecido é tratado como produção.
 */
export const ambienteSemAprovacao = (env: Ambiente = process.env) => {
    const deploy = env.KIDMAIS_DEPLOY_ENV?.trim();
    if (deploy === 'production') return false;
    if (deploy === 'staging') return true;
    return !deploy && env.RENDER !== 'true' && env.NODE_ENV !== 'production';
};

export type MotivoVendaFechada = 'CATALOGO_DESLIGADO' | 'COMPRA_DESLIGADA' | 'CATALOGO_NAO_APROVADO_PRODUCAO' | 'APROVACAO_DIVERGENTE' | 'CONTA_INVALIDA';
/** Catálogo visível (ofertas exibidas) — fora de staging/local, só com aprovação registrada e confirmada no ambiente. */
export function catalogoVisivel(cat: Catalogo, env: Ambiente = process.env): { ok: true } | { ok: false; motivo: MotivoVendaFechada } {
    if (!flagsCreditos(env).catalogo) return { ok: false, motivo: 'CATALOGO_DESLIGADO' };
    if (!ambienteSemAprovacao(env)) {
        if (!cat.aprovacao) return { ok: false, motivo: 'CATALOGO_NAO_APROVADO_PRODUCAO' };
        if (env.CREDITOS_CATALOGO_APROVADO?.trim() !== cat.versao) return { ok: false, motivo: 'APROVACAO_DIVERGENTE' };
    }
    return { ok: true };
}
/** Novos pedidos de compra: catálogo visível + flag de compra. */
export function vendaAberta(cat: Catalogo, env: Ambiente = process.env): { ok: true } | { ok: false; motivo: MotivoVendaFechada } {
    const v = catalogoVisivel(cat, env);
    if (!v.ok) return v;
    if (!flagsCreditos(env).compra) return { ok: false, motivo: 'COMPRA_DESLIGADA' };
    if (!contaValida(env)) return { ok: false, motivo: 'CONTA_INVALIDA' };
    return { ok: true };
}

/**
 * Wall-e só é recurso utilizável (e só então vendável) com o consumo novo ligado E o atendimento com modelo autorizado
 * pelos gates próprios (R6, receptor, lista de contatos). Saldo nunca reativa o atendimento.
 */
export function walleDisponivel(env: Ambiente = process.env) {
    return flagsCreditos(env).consumoWalle && atendimentoAtivo(env as NodeJS.ProcessEnv) && modoEntendimento(env as NodeJS.ProcessEnv).modo === 'MODELO';
}

/**
 * Conta do provedor (rótulo não secreto, ex.: "kidmais-sandbox"); separa ids de contas diferentes do mesmo ambiente.
 * P3-2 (revisão de 22/10): rótulo inválido falha fechado (a venda fecha com CONTA_INVALIDA; quem processa recusa).
 */
const CONTA = /^[a-z0-9_-]{1,40}$/;
export const contaValida = (env: Ambiente = process.env) => CONTA.test(env.CREDITOS_ASAAS_CONTA?.trim() || 'padrao');
export function contaProvedor(env: Ambiente = process.env) {
    const c = env.CREDITOS_ASAAS_CONTA?.trim() || 'padrao';
    if (!CONTA.test(c)) throw new Error('CREDITOS_ASAAS_CONTA_INVALIDA');
    return c;
}

/** Limites operacionais (sugestões do plano; configuráveis, nunca afrouxados pela compra). */
export const LIMITES = Object.freeze({
    pedidosPorHoraUsuario: 5,
    pedidosPorHoraEmpresa: 10,
    pedidosPendentesPorEmpresa: 3,
    compraDiariaCentavos: 100_000,
    /** Prazo da cobrança avulsa (Pix/boleto/cartão) a partir do pedido, em dias corridos. */
    vencimentoDias: 3,
    /** Janela da garantia de 7 dias por compra (contada da liberação do lote). */
    garantiaDias: 7,
    /** Prazo de início da devolução ordinária (dias úteis, como a L1). */
    prazoDevolucaoDiasUteis: 5,
    /** Aviso de saldo baixo: abaixo de 20% da última recarga/franquia. */
    saldoBaixoPercentual: 20,
});
