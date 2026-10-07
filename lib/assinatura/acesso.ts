/**
 * Acesso comercial da empresa (venda por assinatura, E3) — função PURA, calculada só a partir das datas gravadas na 067.
 * Nenhuma tarefa agendada é necessária: o teste "vence" porque a data passou, na próxima requisição.
 *
 * Prazos (proposta §4.2 e D8; revisão comercial pendente antes da publicação):
 *   - teste sem cartão com a duração gravada em teste_fim na criação (padrão configurável em
 *     lib/assinatura/configuracao.ts — 15 dias por padrão desde 07/10/2026; a 06/10 registrou 30);
 *   - falha de cobrança: 7 dias de regularização com acesso completo;
 *   - depois do teste, da regularização ou do fim do período cancelado: 60 dias SOMENTE_LEITURA (consulta e exportação);
 *   - depois disso: BLOQUEADO (dados retidos; nada é apagado aqui).
 * Empresa sem assinatura (Kidmais e empresas atuais) = sem cobrança: COMPLETO.
 * Exceção comercial vigente (cortesia ou acesso temporário) = COMPLETO até o prazo dela.
 * A situação ADMINISTRATIVA da empresa (empresas.status) é outro eixo e continua sendo aplicada por provarTenant.
 */
export const REGULARIZACAO_DIAS = 7;
export const SOMENTE_LEITURA_DIAS = 60;
const DIA_MS = 86_400_000;

export type SituacaoAssinatura = 'TESTE' | 'ATIVA' | 'EM_ATRASO' | 'CANCELADA_FIM_PERIODO' | 'ENCERRADA';
export type TipoExcecao = 'EXTENSAO_TESTE' | 'CORTESIA' | 'ACESSO_TEMPORARIO';

export type AssinaturaGravada = {
    situacao: SituacaoAssinatura;
    testeFim: string;
    periodoAtualFim: string | null;
    emAtrasoDesde: string | null;
    encerradaEm: string | null;
};
export type ExcecaoGravada = { tipo: TipoExcecao; validaAte: string; revogadaEm: string | null };

export type NivelAcesso = 'COMPLETO' | 'SOMENTE_LEITURA' | 'BLOQUEADO';
export type MotivoAcesso =
    | 'SEM_COBRANCA' | 'EXCECAO_COMERCIAL' | 'TESTE' | 'TESTE_ENCERRADO' | 'ASSINATURA_ATIVA' | 'REGULARIZACAO'
    | 'PAGAMENTO_PENDENTE' | 'CANCELADA_NO_PERIODO' | 'CANCELADA' | 'ENCERRADA';

export type AcessoComercial = {
    nivel: NivelAcesso;
    motivo: MotivoAcesso;
    /** Quando o nível atual muda (fim do teste, da regularização ou da consulta). null = sem mudança prevista. */
    ate: string | null;
};

const ms = (iso: string | null) => (iso ? Date.parse(iso) : Number.NaN);
const iso = (t: number) => new Date(t).toISOString();

/** A partir de `inicio` (quando o acesso completo terminou): SOMENTE_LEITURA por 60 dias, depois BLOQUEADO. */
function aposFim(inicio: number, agora: number, motivo: MotivoAcesso): AcessoComercial {
    const fimLeitura = inicio + SOMENTE_LEITURA_DIAS * DIA_MS;
    return agora < fimLeitura
        ? { nivel: 'SOMENTE_LEITURA', motivo, ate: iso(fimLeitura) }
        : { nivel: 'BLOQUEADO', motivo, ate: null };
}

export function excecaoVigente(excecoes: readonly ExcecaoGravada[], agora: number) {
    return excecoes
        .filter((e) => (e.tipo === 'CORTESIA' || e.tipo === 'ACESSO_TEMPORARIO') && !e.revogadaEm && ms(e.validaAte) > agora)
        .sort((a, b) => ms(b.validaAte) - ms(a.validaAte))[0] ?? null;
}

export function calcularAcessoComercial(assinatura: AssinaturaGravada | null, excecoes: readonly ExcecaoGravada[] = [], agora = Date.now()): AcessoComercial {
    if (!assinatura)
        return { nivel: 'COMPLETO', motivo: 'SEM_COBRANCA', ate: null };
    const base = acessoDaAssinatura(assinatura, agora);
    const excecao = excecaoVigente(excecoes, agora);
    if (!excecao)
        return base;
    // A exceção garante COMPLETO até o prazo dela; se a própria assinatura já garante COMPLETO por mais tempo, o
    // acesso completo vale até o maior dos dois prazos.
    if (base.nivel === 'COMPLETO' && base.ate !== null && ms(base.ate) > ms(excecao.validaAte))
        return base;
    return { nivel: 'COMPLETO', motivo: 'EXCECAO_COMERCIAL', ate: excecao.validaAte };
}

function acessoDaAssinatura(assinatura: AssinaturaGravada, agora: number): AcessoComercial {
    const fimPeriodo = ms(assinatura.periodoAtualFim);
    switch (assinatura.situacao) {
        case 'TESTE': {
            const fim = ms(assinatura.testeFim);
            if (!Number.isFinite(fim))
                return { nivel: 'BLOQUEADO', motivo: 'TESTE_ENCERRADO', ate: null };
            return agora < fim ? { nivel: 'COMPLETO', motivo: 'TESTE', ate: assinatura.testeFim } : aposFim(fim, agora, 'TESTE_ENCERRADO');
        }
        case 'ATIVA': {
            if (!Number.isFinite(fimPeriodo))
                return { nivel: 'BLOQUEADO', motivo: 'PAGAMENTO_PENDENTE', ate: null };
            if (agora < fimPeriodo)
                return { nivel: 'COMPLETO', motivo: 'ASSINATURA_ATIVA', ate: assinatura.periodoAtualFim };
            // Período acabou sem a renovação confirmada: mesma regra do atraso, contada do fim do período.
            return emAtraso(fimPeriodo, agora);
        }
        // Datas ausentes ou inválidas (só possíveis fora dos CHECKs da 067) falham FECHADO, nunca abrem acesso.
        case 'EM_ATRASO': {
            const desde = ms(assinatura.emAtrasoDesde);
            return Number.isFinite(desde) ? emAtraso(desde, agora) : { nivel: 'BLOQUEADO', motivo: 'PAGAMENTO_PENDENTE', ate: null };
        }
        case 'CANCELADA_FIM_PERIODO': {
            if (!Number.isFinite(fimPeriodo))
                return { nivel: 'BLOQUEADO', motivo: 'CANCELADA', ate: null };
            if (agora < fimPeriodo)
                return { nivel: 'COMPLETO', motivo: 'CANCELADA_NO_PERIODO', ate: assinatura.periodoAtualFim };
            return aposFim(fimPeriodo, agora, 'CANCELADA');
        }
        case 'ENCERRADA': {
            const fim = ms(assinatura.encerradaEm);
            return Number.isFinite(fim) ? aposFim(fim, agora, 'ENCERRADA') : { nivel: 'BLOQUEADO', motivo: 'ENCERRADA', ate: null };
        }
        default:
            return { nivel: 'BLOQUEADO', motivo: 'ENCERRADA', ate: null };
    }
}

function emAtraso(desde: number, agora: number): AcessoComercial {
    const fimRegularizacao = desde + REGULARIZACAO_DIAS * DIA_MS;
    if (agora < fimRegularizacao)
        return { nivel: 'COMPLETO', motivo: 'REGULARIZACAO', ate: iso(fimRegularizacao) };
    return aposFim(fimRegularizacao, agora, 'PAGAMENTO_PENDENTE');
}

/** Escrita permitida? (E4 usa isto nas rotas de mutação; leitura exige só nível diferente de BLOQUEADO.) */
export const permiteEscrita = (a: AcessoComercial) => a.nivel === 'COMPLETO';
export const permiteLeitura = (a: AcessoComercial) => a.nivel !== 'BLOQUEADO';
