import type { FechamentoAdministrativoInput } from '../../lib/fechamentos/administrativo-schema.ts';

/**
 * Revisão preenchida a partir de uma preparação do Kidmais (IA operacional). O formulário continua sendo o oficial:
 * só preenche o que o servidor conferiu; horário, valor proposto e forma de pagamento ficam com o operador. A referência
 * opaca (operação + versão + hash) vai no envio, que a confere e consome (no máximo uma contratação por preparação).
 *
 * O Core não importa a IA: a preparação é lida e enviada pela rota da IA (`ENDPOINT_PREPARACOES`); sem ela (flag
 * desligada, expirada, erro), o formulário segue normal pelo endpoint do Core.
 */
export const ENDPOINT_PREPARACOES = '/api/admin/inteligencia/preparacoes';

export type ReferenciaPreparacao = { operacaoId: string; versao: number; payloadHash: string };
export type PreparacaoRecebida =
    | { disponivel: true; referencia: ReferenciaPreparacao; expiraEm: string; pendencias: string[];
        campos: { pacote: FechamentoAdministrativoInput['pacote']; convidadosPagantes: number; aniversarianteId: string | null; idadeAniversariante: number | null;
            temaFesta: string | null; dataFesta: string; horarioBase: FechamentoAdministrativoInput['horarioBase']; horarioDesejado: string | null } }
    | { disponivel: false; motivo: string };
export type PreparacaoAplicada = { form: FechamentoAdministrativoInput; referencia: ReferenciaPreparacao; pendencias: string[]; horarioDesejado: string | null };

const PACOTES = new Set(['pocket', 'mini', 'compacta', 'essencial', 'completa', 'premium', 'pizza_party_scienza']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const texto = (v: unknown) => typeof v === 'string';

/** Aceita só o formato fechado; qualquer desvio ⇒ sem preparação (formulário vazio, como sempre). */
export function preparacaoValida(bruto: unknown): PreparacaoRecebida | null {
    const p = bruto as { disponivel?: unknown; motivo?: unknown; referencia?: Partial<ReferenciaPreparacao>; pendencias?: unknown; expiraEm?: unknown; campos?: Record<string, unknown> } | null;
    if (!p || typeof p !== 'object') return null;
    if (p.disponivel === false) return texto(p.motivo) ? { disponivel: false, motivo: String(p.motivo).slice(0, 300) } : null;
    const r = p.referencia, c = p.campos;
    if (p.disponivel !== true || !r || !c || !texto(r.operacaoId) || !UUID.test(r.operacaoId!) || typeof r.versao !== 'number' || !texto(r.payloadHash) || !/^[0-9a-f]{64}$/.test(r.payloadHash!)) return null;
    if (!PACOTES.has(String(c.pacote)) || typeof c.convidadosPagantes !== 'number' || !texto(c.dataFesta) || (c.horarioBase !== 'almoco' && c.horarioBase !== 'noite')) return null;
    return {
        disponivel: true,
        referencia: { operacaoId: r.operacaoId!, versao: r.versao, payloadHash: r.payloadHash! },
        expiraEm: texto(p.expiraEm) ? String(p.expiraEm) : '',
        pendencias: Array.isArray(p.pendencias) ? p.pendencias.filter(texto).map((x) => String(x).slice(0, 300)).slice(0, 10) : [],
        campos: {
            pacote: c.pacote as FechamentoAdministrativoInput['pacote'], convidadosPagantes: c.convidadosPagantes, dataFesta: String(c.dataFesta), horarioBase: c.horarioBase,
            aniversarianteId: texto(c.aniversarianteId) && UUID.test(String(c.aniversarianteId)) ? String(c.aniversarianteId) : null,
            idadeAniversariante: typeof c.idadeAniversariante === 'number' ? c.idadeAniversariante : null,
            temaFesta: texto(c.temaFesta) ? String(c.temaFesta).slice(0, 200) : null,
            horarioDesejado: texto(c.horarioDesejado) && /^\d{2}:\d{2}$/.test(String(c.horarioDesejado)) ? String(c.horarioDesejado) : null,
        },
    };
}

export function formularioPreparado(base: FechamentoAdministrativoInput, p: Extract<PreparacaoRecebida, { disponivel: true }>): PreparacaoAplicada {
    const c = p.campos;
    return {
        form: {
            ...base,
            pacote: c.pacote,
            convidadosPagantes: c.convidadosPagantes,
            dataFesta: c.dataFesta,
            horarioBase: c.horarioBase,
            horarioInicio: '',
            horarioFim: '',
            ...(c.aniversarianteId ? { aniversarianteId: c.aniversarianteId } : {}),
            ...(c.idadeAniversariante !== null ? { idadeAniversariante: c.idadeAniversariante } : {}),
            ...(c.temaFesta ? { temaFesta: c.temaFesta } : {}),
        },
        referencia: p.referencia,
        pendencias: [...p.pendencias, 'Escolha o horário disponível.'].filter((x, i, todos) => todos.indexOf(x) === i),
        horarioDesejado: c.horarioDesejado,
    };
}

// ---------------------------------------------------------------- envio com a preparação e reconciliação

type RespostaHttp = { ok: boolean; status: number; json(): Promise<unknown> };
export type Buscador = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string }) => Promise<RespostaHttp>;
export type ResultadoFechamento = { fechamentoId: string; status: string };

/**
 * Desfecho de um envio pela preparação. A regra: depois de um resultado INCERTO (rede caiu, resposta perdida, 5xx,
 * conflito de concorrência), nenhuma nova criação é permitida antes de reconciliar com o servidor.
 * - CRIADO: o Fechamento existe (inclusive quando só a reconciliação o confirmou);
 * - RECUSADO: recusa definitiva, nada foi criado (a transação do Core foi desfeita);
 * - NAO_CRIADO: incerto, mas a reconciliação confirmou que nada foi criado: pode enviar de novo;
 * - INCERTO: não foi possível reconciliar: bloqueia novas tentativas até verificar de novo;
 * - SESSAO: sessão expirada.
 */
export type DesfechoEnvio =
    | { tipo: 'CRIADO'; data: ResultadoFechamento; reconciliado: boolean }
    | { tipo: 'RECUSADO'; erro: string; codigo: string | null; daPreparacao: boolean }
    | { tipo: 'NAO_CRIADO'; erro: string }
    | { tipo: 'INCERTO'; erro: string }
    | { tipo: 'SESSAO' };

const MENSAGEM_INCERTO = 'Não foi possível confirmar se o Fechamento foi criado. Verifique de novo antes de enviar outra vez.';
const INCERTOS = new Set(['PREPARACAO_CONCORRENTE', 'PREPARACAO_FALHOU']);

async function postar(buscar: Buscador, corpo: object) {
    return buscar(ENDPOINT_PREPARACOES, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
}

function resultadoValido(d: unknown): ResultadoFechamento | null {
    const x = d as Partial<ResultadoFechamento> | null;
    return x && typeof x.fechamentoId === 'string' && typeof x.status === 'string' ? { fechamentoId: x.fechamentoId, status: x.status } : null;
}

/** Pergunta ao servidor (somente leitura) se a preparação já virou Fechamento. */
export async function reconciliar(buscar: Buscador, clienteId: string, operacaoId: string): Promise<DesfechoEnvio> {
    try {
        const r = await postar(buscar, { acao: 'situacao', clienteId, operacaoId });
        if (r.status === 401) return { tipo: 'SESSAO' };
        const body = await r.json() as { ok?: boolean; data?: { estado?: string; resultado?: unknown } };
        if (!r.ok || !body?.ok || !body.data) return { tipo: 'INCERTO', erro: MENSAGEM_INCERTO };
        if (body.data.estado === 'CONSUMIDA') {
            const data = resultadoValido(body.data.resultado);
            return data ? { tipo: 'CRIADO', data, reconciliado: true } : { tipo: 'INCERTO', erro: MENSAGEM_INCERTO };
        }
        if (body.data.estado === 'ABERTA') return { tipo: 'NAO_CRIADO', erro: 'O envio não foi confirmado e nada foi criado. Você pode enviar de novo.' };
        return { tipo: 'RECUSADO', erro: 'A preparação foi encerrada. Recarregue o formulário sem ela.', codigo: 'PREPARACAO_ENCERRADA', daPreparacao: true };
    } catch {
        return { tipo: 'INCERTO', erro: MENSAGEM_INCERTO };
    }
}

/**
 * Envio oficial pela preparação (com as conferências da prévia) ou "sem a preparação" (só o formulário oficial). Os dois
 * usam a MESMA operação como âncora: alternar caminhos, repetir ou outra aba nunca criam um segundo Fechamento.
 */
export async function enviarPreparado(buscar: Buscador, entrada: { clienteId: string; referencia: ReferenciaPreparacao; formulario: object; semPreparacao: boolean }): Promise<DesfechoEnvio> {
    const corpo = entrada.semPreparacao
        ? { acao: 'concluir_sem_preparacao', clienteId: entrada.clienteId, operacaoId: entrada.referencia.operacaoId, formulario: entrada.formulario }
        : { acao: 'concluir', clienteId: entrada.clienteId, referencia: entrada.referencia, formulario: entrada.formulario };
    let r: RespostaHttp;
    try {
        r = await postar(buscar, corpo);
    } catch {
        return reconciliar(buscar, entrada.clienteId, entrada.referencia.operacaoId);
    }
    if (r.status === 401) return { tipo: 'SESSAO' };
    type Corpo = { ok?: boolean; data?: unknown; erro?: unknown; codigo?: unknown };
    let body: Corpo | null;
    try { body = await r.json() as Corpo | null; } catch { body = null; }
    const codigo = typeof body?.codigo === 'string' ? body.codigo : null;
    if (r.ok && body?.ok) {
        const data = resultadoValido(body.data);
        if (data) return { tipo: 'CRIADO', data, reconciliado: false };
    }
    // Sem corpo legível, 5xx ou conflito: o servidor pode ter gravado ⇒ reconciliar ANTES de qualquer nova tentativa.
    if (!body || r.status >= 500 || (codigo && INCERTOS.has(codigo)) || (r.ok && body?.ok)) return reconciliar(buscar, entrada.clienteId, entrada.referencia.operacaoId);
    return { tipo: 'RECUSADO', erro: typeof body.erro === 'string' ? body.erro : 'Não foi possível concluir o Fechamento.', codigo, daPreparacao: Boolean(codigo?.startsWith('PREPARACAO_')) };
}
