'use client';

/**
 * Abas abertas durante a troca de host (plano D4, H23): ponto único de decisão, chamado antes de ir ao login ou de
 * descartar a página. Módulo independente: fetch direto, sem importar AdminShell nem adminFetch. A consulta não vale
 * como sessão, e o servidor continua recusando; ela só decide se a tela é mantida. O estado fica na memória da aba.
 * Fora de migração nada muda: falha sem aba armada volta "como hoje", sem consulta.
 */
export const TOLERANCIA_TROCA_MS = 20 * 60 * 1000;
export const INTERVALO_FORCADO_MS = 30 * 1000;
export const INTERVALO_PERIODICO_MS = 5 * 60 * 1000;
export const TEMPO_LIMITE_CONSULTA_MS = 5000;

const MODOS = ['DESLIGADO', 'PREPARACAO', 'ATIVA', 'REVERSAO', 'CONFIGURACAO_INVALIDA'];

export type ConsultaEndereco = { modoEfetivo: string; painelNesteHost: boolean | null; toleranciaAtiva: boolean };
type Resultado = { iniciadaEm: number; consulta: ConsultaEndereco | null };
export type DecisaoSessao = 'COMO_HOJE' | 'ENDERECO_MUDOU' | 'INCONCLUSIVO';
export type EstadoAviso = 'NENHUM' | 'ENDERECO_MUDOU' | 'SEM_RESPOSTA';
export type ClasseLeitura = 'VALIDA' | 'ENCERRADA' | 'RECUSA_403' | 'FALHA';

let armada = false;
let final = false;
let inicioFalha: number | null = null;
let semResposta = false;
let resultadosMantidos: string[] = [];
let resultadoPendente: (() => void) | null = null;
let emAndamento: Promise<Resultado> | null = null;
let ultima: Resultado | null = null;
let ultimaTentativa = 0;
let ultimaPeriodica = 0;
let referencias = 0;
let temporizador: ReturnType<typeof setInterval> | null = null;
const assinantes = new Set<() => void>();

const notificar = () => { for (const a of assinantes) a(); };

function lerConsulta(corpo: unknown): ConsultaEndereco | null {
    const c = corpo as Partial<ConsultaEndereco> | null;
    if (!c || typeof c !== 'object' || !MODOS.includes(c.modoEfetivo as string) || typeof c.toleranciaAtiva !== 'boolean') return null;
    if (c.painelNesteHost !== true && c.painelNesteHost !== false && c.painelNesteHost !== null) return null;
    return { modoEfetivo: c.modoEfetivo as string, painelNesteHost: c.painelNesteHost, toleranciaAtiva: c.toleranciaAtiva };
}

function marcarFinal() {
    final = true;
    armada = true;
    semResposta = false;
    pararTemporizador();
    const pendente = resultadoPendente;
    resultadoPendente = null;
    pendente?.();
    notificar();
}

function aplicar(c: ConsultaEndereco) {
    const emUso = c.modoEfetivo === 'PREPARACAO' || c.modoEfetivo === 'ATIVA' || c.modoEfetivo === 'REVERSAO';
    if (c.toleranciaAtiva && emUso) armada = true;
    else if (!(c.toleranciaAtiva && c.modoEfetivo === 'CONFIGURACAO_INVALIDA')) {
        armada = false;
        inicioFalha = null;
        if (semResposta) { semResposta = false; notificar(); }
    }
    if ((c.modoEfetivo === 'ATIVA' || c.modoEfetivo === 'REVERSAO') && c.painelNesteHost === false && !final) marcarFinal();
}

async function buscar(): Promise<Resultado> {
    const iniciadaEm = Date.now();
    const controle = new AbortController();
    const prazo = setTimeout(() => controle.abort(), TEMPO_LIMITE_CONSULTA_MS);
    try {
        const r = await fetch('/api/endereco-atual', { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: controle.signal });
        return { iniciadaEm, consulta: r.ok ? lerConsulta(await r.json()) : null };
    }
    catch {
        return { iniciadaEm, consulta: null };
    }
    finally {
        clearTimeout(prazo);
    }
}

/**
 * Uma por vez, sem efeito no estado da aba: quem pediu aplica o resultado quando ele ainda vale. Uma consulta inválida ou
 * indisponível não muda o estado: falha = nenhum aviso.
 */
function consultar(): Promise<Resultado> {
    if (emAndamento) return emAndamento;
    ultimaTentativa = Date.now();
    emAndamento = buscar().then((resultado) => {
        emAndamento = null;
        ultima = resultado;
        return resultado;
    });
    return emAndamento;
}

/** Tentativa forçada: reaproveita a mais recente dentro do intervalo mínimo. */
function consultaParaFalha(): Promise<Resultado> {
    if (emAndamento) return emAndamento;
    if (ultima && Date.now() - ultimaTentativa < INTERVALO_FORCADO_MS) return Promise.resolve(ultima);
    return consultar();
}

/** Status preservado: 401 e 200 válido sem usuário são fim real; 200 com corpo inválido é falha, não sessão encerrada. */
export function classificarLeituraSessao(status: number, corpo: unknown): ClasseLeitura {
    if (status === 401) return 'ENCERRADA';
    if (status === 403) return 'RECUSA_403';
    if (status < 200 || status >= 300) return 'FALHA';
    const c = corpo as { ok?: unknown; data?: { usuarioId?: unknown } } | null | undefined;
    if (!c || typeof c !== 'object' || c.ok !== true || !c.data || typeof c.data !== 'object') return 'FALHA';
    return c.data.usuarioId ? 'VALIDA' : 'ENCERRADA';
}

/**
 * Decide uma falha na leitura da sessão, depois das precedências de hoje (saída, sessão obsoleta, outra aba, contexto).
 * `aindaValida` refaz essas precedências depois da espera: se mudaram, o resultado é ignorado e vale o caminho de hoje.
 */
export async function decidirFalhaSessao(entrada: { tipo: '403' | 'falha'; telaCarregada: boolean; aindaValida: () => boolean }): Promise<DecisaoSessao> {
    if (final) return 'ENDERECO_MUDOU';
    if (!entrada.telaCarregada) return 'COMO_HOJE';
    if (entrada.tipo === 'falha' && !armada) return 'COMO_HOJE';
    const armadaNaFalha = armada;
    const falhaEm = Date.now();
    if (armadaNaFalha) {
        inicioFalha ??= falhaEm;
        if (falhaEm - inicioFalha >= TOLERANCIA_TROCA_MS) {
            if (semResposta) { semResposta = false; notificar(); }
            return 'COMO_HOJE';
        }
    }
    const resultado = await consultaParaFalha();
    // Decisão recusada não deixa efeito: nada de estado final, aviso ou parada do acompanhamento vindos desta consulta.
    if (!entrada.aindaValida()) return 'COMO_HOJE';
    const c = resultado.consulta;
    if (c) aplicar(c);
    if (final) return 'ENDERECO_MUDOU';
    // Falso prova a troca mesmo vindo de consulta anterior; verdadeiro só vale se a consulta começou depois desta falha.
    if (c?.painelNesteHost === false && c.modoEfetivo !== 'DESLIGADO') {
        marcarFinal();
        return 'ENDERECO_MUDOU';
    }
    if (c?.painelNesteHost === true && resultado.iniciadaEm >= falhaEm) return 'COMO_HOJE';
    if (!armadaNaFalha || !armada) return 'COMO_HOJE';
    if (!semResposta) { semResposta = true; notificar(); }
    return 'INCONCLUSIVO';
}

/** Só uma leitura de sessão válida zera o prazo. */
export function sessaoValida() {
    inicioFalha = null;
    if (!final) resultadosMantidos = [];
    if (semResposta) { semResposta = false; notificar(); }
}

export const enderecoFinal = () => final;

/**
 * Leitura de sessão do AdminShell. Devolve o corpo para o caminho de hoje, null quando a tela fica como está, ou relança
 * a falha de rede ou de corpo para o `.catch` de hoje. O status fica preservado até o fim da decisão.
 */
export async function conferirLeituraDaSessao<T>(leitura: { resposta: Response } | { erro: unknown }, ctx: { telaCarregada: () => boolean; aindaValida: () => boolean; vivo: () => boolean }): Promise<T | null> {
    let corpo: unknown;
    let falhaDeCorpo: { erro: unknown } | null = null;
    if ('erro' in leitura) falhaDeCorpo = { erro: leitura.erro };
    else {
        try { corpo = await leitura.resposta.json(); }
        catch (erro) { falhaDeCorpo = { erro }; }
    }
    const comoHoje = () => {
        if (falhaDeCorpo) throw falhaDeCorpo.erro;
        return corpo as T;
    };
    if (final) return null;
    const classe = 'erro' in leitura ? 'FALHA' : classificarLeituraSessao(leitura.resposta.status, corpo);
    if (classe === 'VALIDA') sessaoValida();
    if (classe === 'VALIDA' || classe === 'ENCERRADA' || !ctx.aindaValida()) return comoHoje();
    const vivoAntes = ctx.vivo();
    const decisao = await decidirFalhaSessao({ tipo: classe === 'RECUSA_403' ? '403' : 'falha', telaCarregada: ctx.telaCarregada(), aindaValida: ctx.aindaValida });
    // Estado final vindo de outra consulta enquanto esta decisão perdia a validade: também não relança.
    if (decisao !== 'COMO_HOJE' || final) return null;
    // A tela mudou durante a espera: o ciclo novo decide. Sem espera, a resposta segue como hoje.
    if (vivoAntes && !ctx.vivo()) return null;
    return comoHoje();
}

export function estadoAviso(): EstadoAviso {
    return final ? 'ENDERECO_MUDOU' : semResposta ? 'SEM_RESPOSTA' : 'NENHUM';
}

/**
 * Resultado real de uma escrita quando a tela é mantida. Fica visível no aviso da própria tela, qualquer que seja o
 * tratamento de erro do componente que fez o pedido.
 */
export function registrarResultadoMantido(texto: string) {
    if (resultadosMantidos.includes(texto)) return;
    resultadosMantidos = [...resultadosMantidos, texto];
    notificar();
}

export const resultadosDaTelaMantida = () => resultadosMantidos;

/**
 * Último resultado de escrita entregue a uma tela. Vale só se a aba chegar ao estado final, por qualquer caminho: o que
 * vier depois da escrita (atualizar a tela, por exemplo) não apaga o que o servidor já respondeu.
 */
export function anotarResultadoPendente(registrar: (() => void) | null) {
    if (final && registrar) { registrar(); return; }
    resultadoPendente = registrar;
}

export function assinarAviso(assinante: () => void) {
    assinantes.add(assinante);
    return () => { assinantes.delete(assinante); };
}

function consultaPeriodica() {
    if (final || Date.now() - ultimaPeriodica < INTERVALO_PERIODICO_MS - 1000) return;
    ultimaPeriodica = Date.now();
    void consultar().then(({ consulta }) => { if (consulta) aplicar(consulta); });
}

function pararTemporizador() {
    if (temporizador !== null) clearInterval(temporizador);
    temporizador = null;
}

/** Um único temporizador, compartilhado entre foco e intervalo, no máximo a cada 5 min. */
export function iniciarAcompanhamento() {
    referencias += 1;
    if (referencias === 1) {
        consultaPeriodica();
        if (!final) temporizador = setInterval(consultaPeriodica, INTERVALO_PERIODICO_MS);
        window.addEventListener('focus', consultaPeriodica);
    }
    return () => {
        referencias -= 1;
        if (referencias === 0) {
            pararTemporizador();
            window.removeEventListener('focus', consultaPeriodica);
        }
    };
}
