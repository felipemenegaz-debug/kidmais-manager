/**
 * S-C (revisão do Astra, P2-R1): com os convidados vindos da disponibilidade, o número pode mudar pelo chip em qualquer
 * etapa depois do Pacote (ex.: Valor). Enquanto a nova combinação não estiver confirmada, nenhuma etapa seguinte avança:
 * - revalidação do horário em andamento ou cotação carregando → aguardar (avança sozinho quando terminar);
 * - horário recusado para o novo número ou cotação com erro → erro, até o cliente trocar o número de novo (recuperação).
 * Sem o fluxo de convidados primeiro (URL antiga) ou até a etapa que já confere convidados, nada muda.
 */
export type CotacaoEstado = 'sem' | 'carregando' | 'ok' | 'erro';

export type EstadoTravaConvidados = {
    convidadosDaEntrada: boolean;
    etapa: number;
    etapaDosConvidados: number;
    cotacao: CotacaoEstado;
    erroCotacao?: string | null;
    revalidando: boolean;
    horarioRecusado: string | null;
};

export type Trava = { tipo: 'livre' } | { tipo: 'aguardar' } | { tipo: 'erro'; mensagem: string };

export const MENSAGEM_COTACAO_FALHOU = 'Não foi possível calcular o preço para essa quantidade. Altere os convidados ou tente novamente.';

export function travaAposConvidados(e: EstadoTravaConvidados): Trava {
    if (!e.convidadosDaEntrada || e.etapa <= e.etapaDosConvidados) return { tipo: 'livre' };
    if (e.revalidando) return { tipo: 'aguardar' };
    if (e.horarioRecusado) return { tipo: 'erro', mensagem: e.horarioRecusado };
    if (e.cotacao === 'carregando') return { tipo: 'aguardar' };
    if (e.cotacao === 'erro') return { tipo: 'erro', mensagem: e.erroCotacao || MENSAGEM_COTACAO_FALHOU };
    if (e.cotacao === 'sem') return { tipo: 'erro', mensagem: 'Informe a quantidade de convidados pagantes.' };
    return { tipo: 'livre' };
}

/** Mensagem da recusa do horário para o novo número (fica até a próxima alteração bem-sucedida). */
export function mensagemHorarioRecusado(quantidade: number) {
    return `Com ${quantidade} convidados, o horário escolhido não está disponível. Altere a quantidade acima ou volte à disponibilidade para escolher outra data.`;
}

/**
 * P2-R3 (Astra): duas trocas rápidas no chip sobrepõem revalidações; só a MAIS RECENTE pode mudar a tela. Resposta antiga
 * (sucesso ou recusa, chegando antes ou depois da nova) volta `vigente: false` e é descartada sem tocar em estado.
 */
export type ResultadoRevalidacao<T> = { vigente: false } | { vigente: true; ok: true; valor: T } | { vigente: true; ok: false };

export async function soAMaisRecente<T>(seq: { current: number }, consultar: () => Promise<T>): Promise<ResultadoRevalidacao<T>> {
    const minha = ++seq.current;
    try {
        const valor = await consultar();
        return minha === seq.current ? { vigente: true, ok: true, valor } : { vigente: false };
    } catch {
        return minha === seq.current ? { vigente: true, ok: false } : { vigente: false };
    }
}

/**
 * P2-R3 (rodada 3): TODA mudança de convidados invalida as revalidações pendentes, inclusive quando não vai iniciar outra
 * (ex.: o número não cabe no pacote e a tela volta ao Pacote). Uma resposta antiga não pode mais avançar a etapa.
 */
export function invalidarPendentes(seq: { current: number }) {
    seq.current++;
}
