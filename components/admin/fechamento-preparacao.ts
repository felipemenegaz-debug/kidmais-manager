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
