import { AVISO_FUNDADOR_DIAS, diaBrasil, diasAntes, inicioJanelaAviso, type ContextoRenovacao, type DepsRenovacao, type EstadoRenovacao }
    from './renovacao-fundador.ts';
import type { ProvedorRenovacao } from './asaas.ts';
import type { RepositorioRenovacao } from './renovacao-fundador.ts';

/**
 * B-9 — execução agendada da renovação Fundador (plano docs/PLANO_RENOVACAO_AGENDADA_B9_20261025.md, rev. 3.1).
 * Sem rede nem banco próprios: recebe o processamento (processarRenovacao com `modoAgendado: true`), a trava por empresa,
 * o repositório, o provedor e a trava global. Classifica TODOS os resultados (§2.5), relê o preço remoto (§2.6), conta os
 * avisos na janela (§2.7) e para ao perder a trava global, ao estourar o limite ou ao receber SIGTERM (§2.2).
 * O relatório não traz e-mail, destinatário, valor nem id do provedor: só id interno da empresa, códigos e contagens.
 */
export type ModoAgendado = 'simular' | 'aplicar';
export type EstadoLido = EstadoRenovacao | 'SEM_REGISTRO' | 'SEM_FUNDADOR' | 'ILEGIVEL';
export type PrecoRemoto = {
    assinatura: 'REGULAR' | 'FUNDADOR' | 'DIVERGENTE' | 'NAO_LIDA';
    parcelasDaRenovacao: { regulares: number; fundador: number; outras: number; naoLidas: number };
    estadoPersistido: EstadoLido;
    /** true quando a releitura foi conclusiva (assinatura e parcelas lidas). */
    confirmado: boolean;
};
/**
 * D-P5-5 = B (Felipe, 29/10/2026): tentativas de mutação no Asaas por empresa, contadas na fronteira do provedor
 * (instrumentarProvedor), POR FORA do bloqueio da simulação. São tentativas e falhas OBSERVADAS: não provam efeito remoto
 * (timeout pode ter sido aplicado; bloqueio da simulação não chega à rede). Só em memória: SIGKILL as perde.
 */
export type ContagemPuts = { assinatura: number; parcelas: number; suspensao: number; falhas: number; foraDeAplicando: number };
export type TotaisPuts = ContagemPuts & { empresasComTentativa: number };
/** Estado de uma empresa durante o processamento, sob a trava dela. Nunca compartilhado entre empresas. */
export type Instrumentos = { contagem: ContagemPuts; estadoVigente: EstadoLido; substituiu: boolean };
export const contagemVazia = (): ContagemPuts => ({ assinatura: 0, parcelas: 0, suspensao: 0, falhas: 0, foraDeAplicando: 0 });
const tentativas = (c: ContagemPuts) => c.assinatura + c.parcelas + c.suspensao;
export type ItemAgendado = {
    empresaId: string; resultado: string; estadoEntrada: EstadoLido; estadoSaida: EstadoLido;
    classe: 'OK' | 'ALERTA'; motivo: string | null; precoRemoto: PrecoRemoto | null; avisoNaJanela: boolean; ultimoDiaJanela: boolean;
    puts: ContagemPuts;
};
export type ExecucaoAgendada = 'CONCLUIDA' | 'EXECUCAO_SOBREPOSTA' | 'TRAVA_PERDIDA' | 'LIMITE_EXECUCAO' | 'INTERROMPIDA';
export type RelatorioAgendado = {
    modo: ModoAgendado; execucao: ExecucaoAgendada; empresas: number; processadas: number;
    resultados: Record<string, number>; alertas: ItemAgendado[];
    /** Empresas sem alerta que já avisaram: estado persistido e preço relido (§2.6), para o acompanhamento. */
    emAndamento: ItemAgendado[];
    avisosNaJanela: number; putsTotais: TotaisPuts; codigo: 0 | 1 | 2;
};

/**
 * Lista FECHADA dos 6 métodos de ProvedorRenovacao (3 leituras, 3 mutações, todas PUT no Asaas). Qualquer outro método do
 * cliente fica ausente. Cada mutação conta ANTES de delegar e soma a falha se lançar; nada de argumento, resposta ou mensagem
 * é guardado. Fora de APLICANDO = estado persistido vigente (observarRepositorio) diferente de APLICANDO no momento da chamada.
 */
export function instrumentarProvedor(p: ProvedorRenovacao, i: Instrumentos): ProvedorRenovacao {
    const mutar = <A extends unknown[], R>(campo: 'assinatura' | 'parcelas' | 'suspensao', f: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => {
        i.contagem[campo]++;
        if (i.estadoVigente !== 'APLICANDO') i.contagem.foraDeAplicando++;
        try { return await f(...a); } catch (e) { i.contagem.falhas++; throw e; }
    };
    return {
        obterAssinatura: (id) => p.obterAssinatura(id),
        listarCobrancasDaAssinatura: (id) => p.listarCobrancasDaAssinatura(id),
        obterCobranca: (id) => p.obterCobranca(id),
        atualizarValorAssinatura: mutar('assinatura', (id: string, v: number) => p.atualizarValorAssinatura(id, v)),
        atualizarValorCobranca: mutar('parcelas', (c: Parameters<ProvedorRenovacao['atualizarValorCobranca']>[0], v: number) => p.atualizarValorCobranca(c, v)),
        suspenderGeracao: mutar('suspensao', (id: string) => p.suspenderGeracao(id)),
    };
}

/** O estado vigente só muda DEPOIS que a escrita resolve (COMMIT); falha de escrita não muda nada. */
export function observarRepositorio(r: RepositorioRenovacao, i: Instrumentos): RepositorioRenovacao {
    const o: RepositorioRenovacao = {
        ler: (e) => r.ler(e),
        criar: async (reg) => { const x = await r.criar(reg); i.estadoVigente = x.estado; return x; },
        marcar: async (e, id, a) => { await r.marcar(e, id, a); i.estadoVigente = a.estado; },
    };
    if (r.substituir) {
        const substituir = r.substituir.bind(r);
        o.substituir = async (e, anterior, sucessor) => { const x = await substituir(e, anterior, sucessor); i.substituiu = true; i.estadoVigente = x.estado; return x; };
    }
    return o;
}

const OK = new Set(['AGUARDANDO_AVISO', 'AGUARDANDO_ULTIMA_PARCELA', 'REGULAR', 'CANCELADA', 'SEM_FUNDADOR', 'NAO_ELEGIVEL']);
const SO_SIMULACAO = new Set(['ENVIARIA_AVISO', 'ATUALIZARIA_PRECO', 'REAGENDARIA_AVISO']);
/** Trabalho pendente: 0 na primeira vez; repetição é pega pela regra da intenção (entrada e saída iguais). */
const PENDENTE = new Set(['ENVIO_INCERTO', 'AGUARDANDO_CONFIRMACAO_PRECO']);
const INTENCAO: ReadonlySet<EstadoLido> = new Set(['AVISANDO', 'APLICANDO']);

/**
 * §2.5. A regra da intenção NÃO afirma que o mesmo resultado se repetiu: afirma que uma intenção (AVISANDO/APLICANDO)
 * persistiu por ao menos duas execuções, por qualquer motivo (inclusive queda antes do PUT). Desconhecido → alerta.
 */
export function classificar(resultado: string, estadoEntrada: EstadoLido, estadoSaida: EstadoLido, modo: ModoAgendado): { classe: 'OK' | 'ALERTA'; motivo: string | null } {
    if (INTENCAO.has(estadoEntrada) && estadoSaida === estadoEntrada) return { classe: 'ALERTA', motivo: 'INTENCAO_PENDENTE_REPETIDA' };
    // Janela perdida trocada pelo sucessor (D-JP-1): sempre alerta na execução em que acontece, qualquer que seja o desfecho.
    if (resultado.startsWith('AVISO_REAGENDADO')) return { classe: 'ALERTA', motivo: 'JANELA_PERDIDA_REAGENDADA' };
    if (OK.has(resultado) || PENDENTE.has(resultado)) return { classe: 'OK', motivo: null };
    if (SO_SIMULACAO.has(resultado)) return modo === 'simular' ? { classe: 'OK', motivo: null } : { classe: 'ALERTA', motivo: 'RESULTADO_DESCONHECIDO' };
    if (resultado.startsWith('ALERTA_') || resultado === 'REVISAO_EXISTENTE' || resultado === 'ERRO_REPROCESSAVEL') return { classe: 'ALERTA', motivo: resultado };
    return { classe: 'ALERTA', motivo: 'RESULTADO_DESCONHECIDO' };
}

function estadoDe(c: ContextoRenovacao | null): EstadoLido {
    if (!c) return 'SEM_FUNDADOR';
    return c.registro ? c.registro.estado : 'SEM_REGISTRO';
}

/**
 * §2.6: preço pela RELEITURA, nunca por "PUT feito nesta execução". Só para quem já avisou (há preço a conferir).
 * Falha de leitura → NAO_LIDA (não confirmado), que é alerta.
 */
export async function relerPreco(c: ContextoRenovacao, provedor: Pick<ProvedorRenovacao, 'obterAssinatura' | 'listarCobrancasDaAssinatura'>): Promise<PrecoRemoto | null> {
    const r = c.registro;
    if (!r || !r.avisoEnviadoEm) return null;
    const preco: PrecoRemoto = { assinatura: 'NAO_LIDA', parcelasDaRenovacao: { regulares: 0, fundador: 0, outras: 0, naoLidas: 0 },
        estadoPersistido: r.estado, confirmado: false };
    let lidas = 0;
    try {
        const s = await provedor.obterAssinatura(c.assinaturaId);
        preco.assinatura = !s || s.valorCentavos === undefined ? 'NAO_LIDA'
            : s.valorCentavos === c.valorRegular ? 'REGULAR' : s.valorCentavos === c.valorFinal ? 'FUNDADOR' : 'DIVERGENTE';
        if (preco.assinatura !== 'NAO_LIDA') lidas++;
    } catch { preco.assinatura = 'NAO_LIDA'; }
    try {
        for (const x of await provedor.listarCobrancasDaAssinatura(c.assinaturaId)) {
            if (x.deleted || x.dueDate < r.primeiraDataRegular) continue;
            const p = preco.parcelasDaRenovacao;
            if (x.valorCentavos === c.valorRegular) p.regulares++; else if (x.valorCentavos === c.valorFinal) p.fundador++; else p.outras++;
        }
        lidas++;
    } catch { preco.parcelasDaRenovacao.naoLidas = 1; }
    preco.confirmado = lidas === 2;
    return preco;
}

export type TravaGlobal = {
    /** pg_try_advisory_lock numa conexão dedicada (de sessão). */
    adquirir(): Promise<boolean>;
    /** A trava continua desta sessão? Falha de conexão → false. */
    aindaMinha(): Promise<boolean>;
    liberar(): Promise<void>;
};
export type OpcoesExecucao = {
    modo: ModoAgendado;
    /** Seleção já calculada (global, ou interseção com o filtro de homologação). */
    empresas: string[];
    /** Filtro de homologação fora da seleção: relatados, nunca processados. */
    naoElegiveis?: string[];
    travaGlobal: TravaGlobal;
    /** Trava por empresa da contratação (travaPorEmpresa): UMA aquisição envolve leitura inicial, processamento e leitura final. */
    travarEmpresa: DepsRenovacao['travar'];
    ler: (empresaId: string) => Promise<ContextoRenovacao | null>;
    provedor: Pick<ProvedorRenovacao, 'obterAssinatura' | 'listarCobrancasDaAssinatura'>;
    /**
     * processarRenovacao com `modoAgendado: true` e `simular` conforme o modo; recebe a trava que já está segura e os
     * instrumentos DESTA empresa (instrumentarProvedor/observarRepositorio).
     */
    processar: (empresaId: string, travar: DepsRenovacao['travar'], instrumentos: Instrumentos) => Promise<string>;
    agora: () => Date;
    /** Relógio da execução (ms), para o limite de início de novas empresas. */
    relogio?: () => number;
    limiteMs?: number;
    interrompido?: () => boolean;
};
export const LIMITE_EXECUCAO_MS = 30 * 60_000;

export async function executarAgendada(o: OpcoesExecucao): Promise<RelatorioAgendado> {
    const relogio = o.relogio ?? Date.now;
    const inicio = relogio();
    const resultados: Record<string, number> = {};
    const alertas: ItemAgendado[] = [], emAndamento: ItemAgendado[] = [];
    let avisosNaJanela = 0, ultimoDia = 0, processadas = 0;
    const contar = (r: string) => { resultados[r] = (resultados[r] ?? 0) + 1; };
    const base = { modo: o.modo, empresas: o.empresas.length };
    // Mapa por empresa, independente das listas: totais sem dupla soma, preenchido mesmo com exceção ou parada.
    const porEmpresa = new Map<string, ContagemPuts>();
    const totais = (): TotaisPuts => {
        const t: TotaisPuts = { ...contagemVazia(), empresasComTentativa: 0 };
        for (const c of porEmpresa.values()) {
            if (tentativas(c) > 0) t.empresasComTentativa++;
            for (const k of Object.keys(c) as (keyof ContagemPuts)[]) t[k] += c[k];
        }
        return t;
    };
    if (!await o.travaGlobal.adquirir())
        return { ...base, execucao: 'EXECUCAO_SOBREPOSTA', processadas: 0, resultados: { EXECUCAO_SOBREPOSTA: 1 }, alertas: [], emAndamento: [], avisosNaJanela: 0, putsTotais: totais(), codigo: 0 };
    let execucao: ExecucaoAgendada = 'CONCLUIDA';
    try {
        if (o.naoElegiveis?.length) resultados.NAO_ELEGIVEL = o.naoElegiveis.length;
        for (const empresaId of o.empresas) {
            if (o.interrompido?.()) { execucao = 'INTERROMPIDA'; break; }
            if (relogio() - inicio >= (o.limiteMs ?? LIMITE_EXECUCAO_MS)) { execucao = 'LIMITE_EXECUCAO'; break; }
            if (!await o.travaGlobal.aindaMinha().catch(() => false)) { execucao = 'TRAVA_PERDIDA'; break; }
            let entrada: EstadoLido = 'ILEGIVEL', saida: EstadoLido = 'ILEGIVEL', preco: PrecoRemoto | null = null;
            let contexto: ContextoRenovacao | null = null;
            // P2-N1: falha da releitura do banco depois de um resultado normal nunca sai como sucesso.
            let estadoNaoLido = false;
            // Uma única aquisição da trava por empresa: a rotina recebe um `travar` que só executa o trabalho, já sob ela.
            const travar: DepsRenovacao['travar'] = async (_e, trabalho) => trabalho();
            const instrumentos: Instrumentos = { contagem: contagemVazia(), estadoVigente: 'ILEGIVEL', substituiu: false };
            let resultado: string;
            try {
                resultado = await o.travarEmpresa(empresaId, async () => {
                    entrada = estadoDe(await o.ler(empresaId));
                    instrumentos.estadoVigente = entrada;
                    // Falha do processamento é capturada AQUI, ainda sob a trava: as releituras de estado e de preço acontecem
                    // também depois de uma exceção (ex.: PUT feito com resposta perdida), antes de a trava ser liberada.
                    let r: string;
                    try { r = await o.processar(empresaId, travar, instrumentos); }
                    // A substituição já commitada nunca some do resultado, nem diante de exceção posterior.
                    catch { r = instrumentos.substituiu ? 'AVISO_REAGENDADO_ERRO_REPROCESSAVEL' : 'ERRO_REPROCESSAVEL'; }
                    try {
                        contexto = await o.ler(empresaId);
                        saida = estadoDe(contexto);
                        // REVISAO_EXISTENTE: a execução inteira não toca a rede para esse registro (contrato da rotina).
                        if (contexto && r !== 'REVISAO_EXISTENTE') preco = await relerPreco(contexto, o.provedor);
                    } catch { saida = 'ILEGIVEL'; estadoNaoLido = true; }
                    return r;
                });
            } catch { resultado = instrumentos.substituiu ? 'AVISO_REAGENDADO_ERRO_REPROCESSAVEL' : 'ERRO_REPROCESSAVEL'; } // a trava por empresa não veio (ou caiu antes do trabalho)
            finally { porEmpresa.set(empresaId, instrumentos.contagem); }
            processadas++;
            contar(resultado);
            let { classe, motivo } = classificar(resultado, entrada, saida, o.modo);
            if (estadoNaoLido) { classe = 'ALERTA'; motivo ??= 'ESTADO_NAO_LIDO'; }
            if (preco && !(preco as PrecoRemoto).confirmado) { classe = 'ALERTA'; motivo ??= 'PRECO_NAO_LIDO'; }
            const puts = instrumentos.contagem;
            const alertaPut = puts.foraDeAplicando > 0 ? 'PUT_FORA_DE_APLICANDO' : puts.assinatura > 1 ? 'PUT_ASSINATURA_REPETIDO'
                : puts.suspensao > 0 ? 'PUT_SUSPENSAO_NO_AGENDADO' : o.modo === 'simular' && tentativas(puts) > 0 ? 'PUT_EM_SIMULACAO' : null;
            if (alertaPut) { classe = 'ALERTA'; motivo ??= alertaPut; }
            // §2.7: sem avisoEnviadoEm (não pelo estado ≠ AVISADA), dentro de −33..−30.
            const reg = (contexto as ContextoRenovacao | null)?.registro ?? null;
            let naJanela = false, ultimo = false;
            if (reg && !reg.avisoEnviadoEm && !['CANCELADA', 'REVISAO', 'SUBSTITUIDA'].includes(reg.estado)) {
                const hoje = diaBrasil(o.agora()), limite = diasAntes(reg.primeiraDataRegular, AVISO_FUNDADOR_DIAS);
                naJanela = hoje >= inicioJanelaAviso(reg.primeiraDataRegular, reg.substituto) && hoje <= limite;
                ultimo = naJanela && hoje === limite;
            }
            if (naJanela) avisosNaJanela++;
            if (ultimo) { ultimoDia++; classe = 'ALERTA'; motivo ??= 'AVISO_PENDENTE_ULTIMO_DIA'; }
            const item: ItemAgendado = { empresaId, resultado, estadoEntrada: entrada, estadoSaida: saida, classe, motivo, precoRemoto: preco, avisoNaJanela: naJanela, ultimoDiaJanela: ultimo, puts: { ...puts } };
            if (classe === 'ALERTA') alertas.push(item);
            // §2.6: quem já avisou (AVISADA, APLICANDO, REGULAR…) sai com o preço relido, mesmo sem alerta.
            else if (preco || ['AVISADA', 'APLICANDO'].includes(saida as EstadoLido) || tentativas(puts) > 0) emAndamento.push(item);
        }
    } finally {
        await o.travaGlobal.liberar().catch(() => undefined);
    }
    const codigo: 0 | 1 | 2 = execucao === 'INTERROMPIDA' ? 1 : execucao !== 'CONCLUIDA' || alertas.length > 0 || ultimoDia > 0 ? 2 : 0;
    if (execucao !== 'CONCLUIDA') contar(execucao);
    return { ...base, execucao, processadas, resultados, alertas, emAndamento, avisosNaJanela, putsTotais: totais(), codigo };
}
