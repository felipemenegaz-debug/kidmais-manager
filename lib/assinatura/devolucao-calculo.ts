/**
 * Política de cancelamento e devolução (L1 do parecer da Astra de 21/10/2026, decidida por Felipe) — funções PURAS.
 *
 *   - garantia de 7 dias: na PRIMEIRA ativação paga da empresa (inclusive CNPJ), devolução INTEGRAL do valor pago;
 *   - mensal depois da garantia: acesso até o fim do ciclo pago, sem devolução (só "cancelar ao fim do período");
 *   - anual depois da garantia: manter até o fim OU encerrar antes com devolução PROPORCIONAL aos dias não utilizados,
 *     calculada sobre o valor EFETIVAMENTE PAGO (Fundador: o valor com desconto). Sem multa, sem recalcular os meses
 *     usados pelo preço mensal e sem cobrar de volta o desconto Fundador;
 *   - devoluções ordinárias: processamento iniciado em até 5 dias úteis; arrependimento: imediato.
 *
 * Convenções (documentadas em docs/CANCELAMENTO_DEVOLUCAO_20261021.md):
 *   - datas de calendário no fuso de Brasília (UTC−3 fixo, como provedor-estado.ts);
 *   - ciclo anual = [vencimento da cobrança paga, mesmo dia do ano seguinte) — o mesmo fim de período de provedor-estado.ts;
 *   - dias utilizados = dias de calendário decorridos do início do ciclo até o dia do pedido, SEM contar o dia do pedido
 *     (o acesso pago termina no momento do pedido; o dia em curso não é cobrado). Pedido antes do início = 0 dias;
 *   - valor = valor pago × dias não utilizados ÷ dias do ciclo, em centavos inteiros, arredondado ao centavo mais
 *     próximo com meio centavo para cima (a favor do cliente). Aritmética inteira, sem ponto flutuante;
 *   - garantia: termina ao fim do 7º dia de calendário depois da data da ativação (o dia da ativação não conta, como no
 *     art. 132 do Código Civil): ativação em 10/11 → pedido aceito até 17/11 23:59:59 de Brasília;
 *   - dias úteis: segunda a sexta; feriados não são descontados (o prazo fica mais curto, nunca mais longo).
 */
export const GARANTIA_DIAS = 7;
export const DIAS_UTEIS_PROCESSAMENTO = 5;
/** Versão da regra gravada em cada pedido: muda se a política ou o arredondamento mudarem. */
export const REGRA_DEVOLUCAO = 'L1-20261021';

export type TipoPedido = 'CANCELAMENTO_FIM_PERIODO' | 'ARREPENDIMENTO_7_DIAS' | 'ENCERRAMENTO_ANUAL_PROPORCIONAL';
export const TIPOS_COM_DEVOLUCAO = ['ARREPENDIMENTO_7_DIAS', 'ENCERRAMENTO_ANUAL_PROPORCIONAL'] as const;
export type TipoDevolucao = typeof TIPOS_COM_DEVOLUCAO[number];

const DIA_MS = 86_400_000;
const FUSO_MS = 3 * 3_600_000;
const DATA = /^\d{4}-\d{2}-\d{2}$/;

function exigirData(data: string) {
    if (!DATA.test(data) || Number.isNaN(Date.parse(`${data}T00:00:00Z`)))
        throw new Error('Data inválida.');
}
const utc = (data: string) => { exigirData(data); return Date.parse(`${data}T00:00:00Z`); };

/** Instante → data de calendário em Brasília ('YYYY-MM-DD'). */
export function dataBrasilia(instante: number) {
    if (!Number.isFinite(instante)) throw new Error('Instante inválido.');
    return new Date(instante - FUSO_MS).toISOString().slice(0, 10);
}
/** Meia-noite de Brasília da data (o mesmo instante de provedor-estado.inicioDoDia). */
export const meiaNoiteBrasilia = (data: string) => utc(data) + FUSO_MS;
/** Dias de calendário de `de` até `ate` (negativo se `ate` vem antes). */
export const diasEntre = (de: string, ate: string) => Math.round((utc(ate) - utc(de)) / DIA_MS);
export const somarDias = (data: string, dias: number) => new Date(utc(data) + dias * DIA_MS).toISOString().slice(0, 10);

/** Mesmo dia do ano seguinte; 29/02 → 28/02 (como provedor-estado.somarCiclo). */
export function fimDoCicloAnual(inicio: string) {
    exigirData(inicio);
    const [a, m, d] = inicio.split('-').map(Number);
    const ultimo = new Date(Date.UTC(a + 1, m, 0)).getUTCDate();
    return `${a + 1}-${String(m).padStart(2, '0')}-${String(Math.min(d, ultimo)).padStart(2, '0')}`;
}

/** Instante em que a garantia de 7 dias termina (exclusivo): meia-noite de Brasília do 8º dia depois da ativação. */
export const fimDaGarantia = (dataAtivacao: string) => meiaNoiteBrasilia(somarDias(dataAtivacao, GARANTIA_DIAS + 1));

/** `dias` úteis (seg–sex) depois de `data`; o próprio dia não conta. */
export function somarDiasUteis(data: string, dias: number) {
    let atual = data;
    let restantes = dias;
    while (restantes > 0) {
        atual = somarDias(atual, 1);
        const semana = new Date(`${atual}T00:00:00Z`).getUTCDay();
        if (semana !== 0 && semana !== 6) restantes -= 1;
    }
    return atual;
}

/** Arredondamento inteiro: round(a / b) com meio para cima, para a ≥ 0 e b > 0. */
const dividirArredondando = (a: number, b: number) => Math.floor((2 * a + b) / (2 * b));

export type CalculoProporcional = { diasCiclo: number; diasUtilizados: number; diasNaoUtilizados: number; valorCentavos: number };

export function calcularProporcional(input: { valorPagoCentavos: number; inicioCiclo: string; dataPedido: string }): CalculoProporcional {
    const { valorPagoCentavos, inicioCiclo, dataPedido } = input;
    if (!Number.isSafeInteger(valorPagoCentavos) || valorPagoCentavos <= 0 || valorPagoCentavos > 100_000_000)
        throw new Error('Valor pago inválido.');
    const diasCiclo = diasEntre(inicioCiclo, fimDoCicloAnual(inicioCiclo));
    const diasUtilizados = Math.min(Math.max(diasEntre(inicioCiclo, dataPedido), 0), diasCiclo);
    const diasNaoUtilizados = diasCiclo - diasUtilizados;
    return { diasCiclo, diasUtilizados, diasNaoUtilizados, valorCentavos: dividirArredondando(valorPagoCentavos * diasNaoUtilizados, diasCiclo) };
}

/** Cobrança paga que sustenta o período vigente (a última paga da assinatura). */
export type PagamentoBase = {
    id: string;
    valorCentavos: number | null;
    /** Vencimento ('YYYY-MM-DD'): o ciclo começa aqui (provedor-estado.ts). */
    vencimento: string;
    /** Data (Brasília) em que o acesso pago foi ativado por esta cobrança. */
    dataAtivacao: string;
    formaPagamento: string | null;
};

export type EntradaOpcoes = {
    situacao: string;
    ciclo: 'MENSAL' | 'ANUAL' | null;
    agora: number;
    pagamento: PagamentoBase | null;
    /** A cobrança é a primeira ativação paga da empresa (nenhuma outra paga, nenhum pedido de devolução anterior). */
    primeiraAtivacao: boolean;
    /** Já existe pedido de devolução para esta cobrança ou um encerramento antecipado registrado. */
    pedidoExistente: boolean;
};

export type Opcao = { disponivel: true; valorCentavos: number; valorPagoCentavos: number; prazoProcessamento: string; ate: string | null; calculo: CalculoProporcional | null }
    | { disponivel: false; motivo: string };

export type Opcoes = { arrependimento: Opcao; anualProporcional: Opcao };

const indisponivel = (motivo: string): Opcao => ({ disponivel: false, motivo });

/**
 * Opções de encerramento com devolução para o instante `agora`. Quando a garantia vale, o encerramento anual proporcional
 * não é oferecido (a garantia devolve tudo). Sem cobrança paga confirmada pelo provedor, nada é oferecido.
 */
export function opcoesDeEncerramento(e: EntradaOpcoes): Opcoes {
    const nada = (motivo: string) => ({ arrependimento: indisponivel(motivo), anualProporcional: indisponivel(motivo) });
    if (e.situacao !== 'ATIVA' && e.situacao !== 'CANCELADA_FIM_PERIODO')
        return nada('SEM_PERIODO_PAGO_VIGENTE');
    if (e.pedidoExistente)
        return nada('PEDIDO_JA_REGISTRADO');
    const p = e.pagamento;
    if (!p || !e.ciclo)
        return nada('SEM_PAGAMENTO_CONFIRMADO');
    if (!p.valorCentavos || !Number.isSafeInteger(p.valorCentavos) || p.valorCentavos <= 0)
        return nada('VALOR_PAGO_DESCONHECIDO');
    const hoje = dataBrasilia(e.agora);
    const fimCiclo = e.ciclo === 'ANUAL' ? fimDoCicloAnual(p.vencimento) : null;
    if (fimCiclo && meiaNoiteBrasilia(fimCiclo) <= e.agora)
        return nada('PERIODO_TERMINADO');

    const prazoGarantia = fimDaGarantia(p.dataAtivacao);
    let arrependimento: Opcao;
    if (!e.primeiraAtivacao)
        arrependimento = indisponivel('NAO_E_PRIMEIRA_ATIVACAO');
    else if (e.agora >= prazoGarantia)
        arrependimento = indisponivel('GARANTIA_ENCERRADA');
    else
        // Arrependimento: restituição imediata (o prazo operacional é o próprio dia).
        arrependimento = { disponivel: true, valorCentavos: p.valorCentavos, valorPagoCentavos: p.valorCentavos, prazoProcessamento: hoje, ate: new Date(prazoGarantia).toISOString(), calculo: null };

    let anualProporcional: Opcao;
    if (e.ciclo !== 'ANUAL')
        anualProporcional = indisponivel('SOMENTE_ANUAL');
    else if (arrependimento.disponivel)
        anualProporcional = indisponivel('GARANTIA_PREVALECE');
    else {
        const calculo = calcularProporcional({ valorPagoCentavos: p.valorCentavos, inicioCiclo: p.vencimento, dataPedido: hoje });
        anualProporcional = calculo.valorCentavos > 0
            ? { disponivel: true, valorCentavos: calculo.valorCentavos, valorPagoCentavos: p.valorCentavos, prazoProcessamento: somarDiasUteis(hoje, DIAS_UTEIS_PROCESSAMENTO), ate: fimCiclo ? new Date(meiaNoiteBrasilia(fimCiclo)).toISOString() : null, calculo }
            : indisponivel('SEM_DIAS_NAO_UTILIZADOS');
    }
    return { arrependimento, anualProporcional };
}

/** Protocolo legível e sem dado pessoal: KM-AAAAMMDD-XXXXXXXX (8 caracteres Crockford, sem I, L, O, U). */
const ALFABETO = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function gerarProtocolo(instante: number, aleatorio: Uint8Array) {
    if (aleatorio.length < 8) throw new Error('Aleatoriedade insuficiente.');
    const sufixo = Array.from(aleatorio.slice(0, 8), (b) => ALFABETO[b % 32]).join('');
    return `KM-${dataBrasilia(instante).replaceAll('-', '')}-${sufixo}`;
}
export const PROTOCOLO = /^KM-\d{8}-[0-9A-HJKMNP-TV-Z]{8}$/;
