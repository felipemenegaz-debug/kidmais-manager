/**
 * Avisos por e-mail do ciclo da assinatura — regras PURAS (sem banco nem rede). Migration 087 (assinatura_avisos).
 *
 * Os estágios do acesso (lib/assinatura/acesso.ts) mudam só porque a data passa: nada é gravado quando o teste termina,
 * quando começa a regularização, a leitura ou a suspensão. Por isso há duas fontes de aviso:
 *   - POR TEMPO (job diário, scripts/assinatura-avisos.cjs): `marcosDevidos` lê as datas gravadas + os prazos e diz
 *     quais avisos valem AGORA. Só entra um marco começado há ≤ JANELA_AVISO_DIAS: o primeiro deploy não manda e-mail
 *     para quem já está há semanas em leitura, e um dia de job perdido ainda é coberto. PAGAMENTO_PENDENTE só vale a
 *     partir do dia SEGUINTE ao vencimento (Brasília): quem paga no dia não recebe cobrança enquanto Pix, cartão ou boleto
 *     compensam (P2-1 da revisão de 20/10, fechado na rodada 2 de 02/11); o marco continua sendo o início da regularização;
 *   - POR TRANSIÇÃO (sincronizarEmpresa, mesma transação da mudança gravada): `avisosDaTransicao` compara antes/depois.
 *     A transição só acontece uma vez (reentrega do webhook ⇒ `mudou=false`), e o UNIQUE da 087 fecha o resto.
 * Cada aviso é identificado por (tipo, marco): o marco é o instante que define o evento (fim do teste, início da
 * regularização ou da leitura, fim da leitura, novo fim do período pago, cancelamento). Mesmo evento ⇒ mesmo marco.
 * Sem assinatura, isenta (Kidmais) ou com exceção comercial vigente ⇒ nenhum aviso.
 * Limitação conhecida: o fim de uma exceção comercial não é gravado; quem sai dela direto para leitura antiga só recebe
 * o aviso de suspensão próxima (SUSPENSAO_EM_7_DIAS).
 */
import { calcularAcessoComercial, type AssinaturaGravada, type ExcecaoGravada, type MotivoAcesso, type PrazosAcesso, type SituacaoAssinatura } from './acesso.ts';

export const TIPOS_AVISO = ['TESTE_FIM_3_DIAS', 'TESTE_FIM_HOJE', 'PAGAMENTO_PENDENTE', 'SOMENTE_LEITURA', 'SUSPENSAO_EM_7_DIAS', 'SUSPENSO',
    'PAGAMENTO_CONFIRMADO', 'CANCELAMENTO_CONFIRMADO'] as const;
export type TipoAviso = typeof TIPOS_AVISO[number];
export const TIPOS_DE_TRANSICAO: ReadonlySet<TipoAviso> = new Set(['PAGAMENTO_CONFIRMADO', 'CANCELAMENTO_CONFIRMADO']);

/** Quantos dias antes do último dia do teste sai o primeiro aviso. */
export const AVISO_TESTE_DIAS = 3;
/** Quantos dias antes da suspensão sai o lembrete (só quando a leitura dura mais que isso). */
export const AVISO_SUSPENSAO_DIAS = 7;
/** Marco por tempo começado há mais que isso não gera aviso novo (nem é enviado, se ficou pendente). */
export const JANELA_AVISO_DIAS = 2;
/** Aviso de transição pendente há mais que isso é descartado em vez de enviado atrasado. */
export const JANELA_TRANSICAO_DIAS = 3;
/** Teto de pessoas da Gestão avisadas por empresa. */
export const LIMITE_DESTINATARIOS = 5;
/** Retentativa do envio só dentro desta janela depois da 1ª tentativa (retenção da chave idempotente no Resend: 24 h). */
export const JANELA_RETENTATIVA_MS = 23 * 3_600_000;

const DIA_MS = 86_400_000;
const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : Number.NaN);
const iso = (t: number) => new Date(t).toISOString();

export type MarcoAviso = {
    tipo: TipoAviso;
    /** Instante ISO (ms, UTC) que identifica o evento. */
    marco: string;
    motivo: MotivoAcesso;
    /** Data relevante para o texto (fim do teste, da regularização, da leitura ou do período); null = nenhuma. */
    ate: string | null;
};

/** Trava de ativação: só `ASSINATURA_AVISOS_EMAIL=ligado` enfileira e envia. Ausente ou outro valor = desligado. */
export function avisosLigados(env: Record<string, string | undefined> = process.env) {
    return env.ASSINATURA_AVISOS_EMAIL?.trim().toLowerCase() === 'ligado';
}

/** 'YYYY-MM-DD' do instante no fuso de Brasília. */
export function diaBrasil(instante: number) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(instante));
}
/** Início (ms, UTC) do dia seguinte, em Brasília, ao instante dado. Brasília não tem horário de verão desde 2019 (UTC−3 fixo). */
export const inicioDoDiaSeguinteBrasil = (instante: number) => Date.parse(`${diaBrasil(instante)}T00:00:00-03:00`) + DIA_MS;
/** Último dia (Brasília) em que o acesso ainda vale, para um fim exclusivo em `fim`. */
export const ultimoDiaBrasil = (fim: string) => diaBrasil(ms(fim) - 1);

/** Instante em que o acesso COMPLETO terminou (início da leitura), pelas mesmas regras de acesso.ts. NaN = data inválida. */
export function fimDoAcessoCompleto(assinatura: AssinaturaGravada, prazos: PrazosAcesso) {
    switch (assinatura.situacao) {
        case 'TESTE': return ms(assinatura.testeFim);
        case 'ATIVA': return ms(assinatura.periodoAtualFim) + prazos.regularizacaoDias * DIA_MS;
        case 'EM_ATRASO': return ms(assinatura.emAtrasoDesde) + prazos.regularizacaoDias * DIA_MS;
        case 'CANCELADA_FIM_PERIODO': return ms(assinatura.periodoAtualFim);
        case 'ENCERRADA': return ms(assinatura.encerradaEm);
        default: return Number.NaN;
    }
}

/** Avisos por tempo que valem no instante `agora` (ms). Datas inválidas ⇒ nenhum aviso (falha fechada, sem e-mail). */
export function marcosDevidos(assinatura: AssinaturaGravada | null, excecoes: readonly ExcecaoGravada[], agora: number, prazos: PrazosAcesso): MarcoAviso[] {
    if (!assinatura)
        return [];
    const acesso = calcularAcessoComercial(assinatura, excecoes, agora, prazos);
    if (acesso.motivo === 'SEM_COBRANCA' || acesso.motivo === 'EXCECAO_COMERCIAL')
        return [];
    const recente = (inicio: number) => Number.isFinite(inicio) && inicio <= agora && agora - inicio <= JANELA_AVISO_DIAS * DIA_MS;
    const saida: MarcoAviso[] = [];
    if (acesso.nivel === 'COMPLETO' && acesso.motivo === 'TESTE') {
        const fim = ms(assinatura.testeFim);
        const faltam = (Date.parse(diaBrasil(fim - 1)) - Date.parse(diaBrasil(agora))) / DIA_MS;
        if (faltam === 0)
            saida.push({ tipo: 'TESTE_FIM_HOJE', marco: iso(fim), motivo: 'TESTE', ate: iso(fim) });
        else if (faltam >= 1 && faltam <= AVISO_TESTE_DIAS)
            saida.push({ tipo: 'TESTE_FIM_3_DIAS', marco: iso(fim), motivo: 'TESTE', ate: iso(fim) });
    }
    else if (acesso.nivel === 'COMPLETO' && acesso.motivo === 'REGULARIZACAO') {
        const fimRegularizacao = ms(acesso.ate);
        const inicio = fimRegularizacao - prazos.regularizacaoDias * DIA_MS;
        // Elegível só do dia seguinte ao vencimento (Brasília) em diante; a janela de JANELA_AVISO_DIAS desloca junto.
        if (Number.isFinite(inicio) && recente(inicioDoDiaSeguinteBrasil(inicio)))
            saida.push({ tipo: 'PAGAMENTO_PENDENTE', marco: iso(inicio), motivo: 'PAGAMENTO_PENDENTE', ate: iso(fimRegularizacao) });
    }
    else if (acesso.nivel === 'SOMENTE_LEITURA') {
        const fimLeitura = ms(acesso.ate);
        const inicio = fimDoAcessoCompleto(assinatura, prazos);
        if (recente(inicio))
            saida.push({ tipo: 'SOMENTE_LEITURA', marco: iso(inicio), motivo: acesso.motivo, ate: iso(fimLeitura) });
        if (prazos.somenteLeituraDias > AVISO_SUSPENSAO_DIAS && Number.isFinite(fimLeitura) && fimLeitura - agora <= AVISO_SUSPENSAO_DIAS * DIA_MS)
            saida.push({ tipo: 'SUSPENSAO_EM_7_DIAS', marco: iso(fimLeitura), motivo: acesso.motivo, ate: iso(fimLeitura) });
    }
    else if (acesso.nivel === 'BLOQUEADO') {
        const fimLeitura = fimDoAcessoCompleto(assinatura, prazos) + prazos.somenteLeituraDias * DIA_MS;
        if (recente(fimLeitura))
            saida.push({ tipo: 'SUSPENSO', marco: iso(fimLeitura), motivo: acesso.motivo, ate: null });
    }
    return saida;
}

export type EstadoTransicao = {
    situacao: SituacaoAssinatura; periodoAtualFim: string | null; canceladaEm?: string | null; encerradaEm?: string | null;
};
const encerrou = (s: SituacaoAssinatura) => s === 'CANCELADA_FIM_PERIODO' || s === 'ENCERRADA';

/** Avisos de uma transição GRAVADA (antes → depois). Sem mudança relevante ⇒ lista vazia. */
export function avisosDaTransicao(antes: EstadoTransicao, depois: EstadoTransicao, prazos: PrazosAcesso): MarcoAviso[] {
    const saida: MarcoAviso[] = [];
    const fimDepois = ms(depois.periodoAtualFim), fimAntes = ms(antes.periodoAtualFim);
    // Fim do período só cresce por cobrança paga (provedor-estado.ts): período maior em ATIVA = pagamento confirmado.
    if (depois.situacao === 'ATIVA' && Number.isFinite(fimDepois) && (!Number.isFinite(fimAntes) || fimDepois > fimAntes))
        saida.push({ tipo: 'PAGAMENTO_CONFIRMADO', marco: iso(fimDepois), motivo: 'ASSINATURA_ATIVA', ate: iso(fimDepois) });
    if (!encerrou(antes.situacao) && encerrou(depois.situacao)) {
        if (depois.situacao === 'CANCELADA_FIM_PERIODO') {
            const marco = ms(depois.canceladaEm);
            if (Number.isFinite(marco))
                saida.push({ tipo: 'CANCELAMENTO_CONFIRMADO', marco: iso(marco), motivo: 'CANCELADA_NO_PERIODO', ate: Number.isFinite(fimDepois) ? iso(fimDepois) : null });
        }
        else {
            const marco = ms(depois.encerradaEm);
            if (Number.isFinite(marco))
                saida.push({ tipo: 'CANCELAMENTO_CONFIRMADO', marco: iso(marco), motivo: 'ENCERRADA', ate: prazos.somenteLeituraDias > 0 ? iso(marco + prazos.somenteLeituraDias * DIA_MS) : null });
        }
    }
    return saida;
}

/**
 * Aviso pendente ainda vale? Por tempo: o mesmo (tipo, marco) continua devido agora. Por transição: criado há
 * ≤ JANELA_TRANSICAO_DIAS. Devolve o motivo do descarte ou null.
 */
export function motivoObsoleto(aviso: { tipo: TipoAviso; marco: string; criadoEm: string }, assinatura: AssinaturaGravada | null, excecoes: readonly ExcecaoGravada[], agora: number, prazos: PrazosAcesso): string | null {
    if (!assinatura)
        return 'SEM_ASSINATURA';
    if (TIPOS_DE_TRANSICAO.has(aviso.tipo))
        return agora - ms(aviso.criadoEm) > JANELA_TRANSICAO_DIAS * DIA_MS ? 'FORA_DA_JANELA' : null;
    const marco = ms(aviso.marco);
    return marcosDevidos(assinatura, excecoes, agora, prazos).some((m) => m.tipo === aviso.tipo && ms(m.marco) === marco) ? null : 'AVISO_OBSOLETO';
}
