/**
 * Campanha Fundador 090 (janela de 30 dias sem teto + lote posterior de 20 vagas). A fonte da verdade é a linha de
 * `assinatura_campanhas`: datas, regra e versão ficam no banco, calculadas pela guarda da 090 na ativação. O env
 * ASSINATURA_CAMPANHA_FUNDADOR_ATIVA é só a chave operacional que permite ao código usar a campanha ativada.
 * Sem a 090 instalada, ou sem campanha ativada, vale a regra anterior (20 primeiros, origem LEGADO).
 * Nada aqui cria, ativa ou altera campanha: isso é operação própria, com decisões D1–D3 e autorização registradas.
 */
import type { DbExecutor } from '../db/contracts';

export const FUSO_CAMPANHA = 'America/Sao_Paulo';
/** Trava única de alocação (mesma chave da 074a, também tomada pela guarda 090). */
export const TRAVA_FUNDADORES = 'kidmais:fundadores:2026';

type Ambiente = Record<string, string | undefined>;
export const campanhaFundadorLigada = (env: Ambiente = process.env) => env.ASSINATURA_CAMPANHA_FUNDADOR_ATIVA === 'true';

export type Contagem = 'CALENDARIO_LOCAL' | 'HORARIO_EXATO';
export type CampanhaFundador = {
    id: string; codigo: string; versaoRegra: string; estado: 'ATIVA' | 'ENCERRADA';
    contagem: Contagem; elegibilidade: 'OFERTA_PERSISTIDA' | 'PAGAMENTO_CONFIRMADO';
    aberturaData: string; inicio: string; janelaFim: string; vagasPosJanela: number;
};
export type FaseCampanha = 'ANTES' | 'JANELA' | 'POS_JANELA' | 'ENCERRADA';

/** Regra decidida por Felipe em 22/10/2026 (D1, D2, D3). O banco fixa D1 e D3; D2 é fixada aqui, na ativação. */
export const REGRA_APROVADA = Object.freeze({ elegibilidade: 'OFERTA_PERSISTIDA', contagem: 'CALENDARIO_LOCAL', validadeDias: 7, decididaEm: '2026-10-22' } as const);

/**
 * Ativação autorizada de uma campanha em rascunho com a regra aprovada. NÃO é chamada por nenhum fluxo do produto:
 * ativar exige data de abertura decidida e autorização registrada (operação própria). Datas calculadas pela guarda 090.
 */
export async function ativarCampanhaAprovada(tx: DbExecutor, input: { codigo: string; aberturaData: string; autorizacao: string; operadorId: string }) {
    meiaNoiteLocal(input.aberturaData);
    const r = (await tx.query<{ id: string }>(`UPDATE assinatura_campanhas SET estado = 'ATIVA', contagem = $2, elegibilidade = $3,
        validade_oferta = make_interval(days => $4::int), abertura_data = $5::date, autorizacao = $6, ativada_por = $7::uuid
        WHERE codigo = $1 AND estado = 'RASCUNHO' RETURNING id`,
        [input.codigo, REGRA_APROVADA.contagem, REGRA_APROVADA.elegibilidade, REGRA_APROVADA.validadeDias, input.aberturaData, input.autorizacao, input.operadorId])).rows[0];
    if (!r) throw new Error('Campanha em rascunho não encontrada.');
    return r.id;
}

/** 090 completa: tabela de campanhas e colunas de origem. Sem ela, o código segue a regra anterior. */
export async function schemaCampanhaInstalado(tx: DbExecutor) {
    return (await tx.query<{ instalado090: boolean }>(`SELECT to_regclass('public.assinatura_campanhas') IS NOT NULL
        AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
            AND table_name = 'assinatura_fundadores' AND column_name = 'origem') AS instalado090`)).rows[0]?.instalado090 === true;
}

const ISO = (c: string) => `to_char((${c}) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/** A campanha ativada (ATIVA, ou a ENCERRADA mais recente). Rascunho não conta: nunca muda preço nem regra. */
export async function lerCampanhaAtivada(tx: DbExecutor, travar = false): Promise<CampanhaFundador | null> {
    const r = (await tx.query<{ id: string; codigo: string; versao_regra: string; estado: 'ATIVA' | 'ENCERRADA'; contagem: Contagem;
        elegibilidade: CampanhaFundador['elegibilidade']; abertura_data: string; inicio: string; janela_fim: string; vagas_pos_janela: number }>(
        `SELECT id, codigo, versao_regra, estado, contagem, elegibilidade, to_char(abertura_data, 'YYYY-MM-DD') AS abertura_data,
            ${ISO('inicio')} AS inicio, ${ISO('janela_fim')} AS janela_fim, vagas_pos_janela
           FROM assinatura_campanhas WHERE estado <> 'RASCUNHO'
          ORDER BY (estado = 'ATIVA') DESC, ativada_em DESC LIMIT 1${travar ? ' FOR SHARE' : ''}`)).rows[0];
    if (!r) return null;
    return { id: r.id, codigo: r.codigo, versaoRegra: r.versao_regra, estado: r.estado, contagem: r.contagem, elegibilidade: r.elegibilidade,
        aberturaData: r.abertura_data, inicio: r.inicio, janelaFim: r.janela_fim, vagasPosJanela: Number(r.vagas_pos_janela) };
}

/** Fase num instante (ms). Use o relógio do banco lido DEPOIS das travas para decidir concessão; aqui só se compara. */
export function faseCampanha(c: Pick<CampanhaFundador, 'estado' | 'inicio' | 'janelaFim'>, agoraMs: number): FaseCampanha {
    if (c.estado === 'ENCERRADA') return 'ENCERRADA';
    if (agoraMs < Date.parse(c.inicio)) return 'ANTES';
    return agoraMs < Date.parse(c.janelaFim) ? 'JANELA' : 'POS_JANELA';
}

/** Meia-noite local de uma data (YYYY-MM-DD) no fuso da campanha, em ISO UTC. Sem offset fixo: usa a base IANA. */
export function meiaNoiteLocal(data: string): string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(data) || Number.isNaN(Date.parse(`${data}T00:00:00Z`))) throw new Error('Data inválida.');
    const base = Date.parse(`${data}T00:00:00Z`);
    // O deslocamento do fuso no instante aproximado; repetido uma vez para atravessar eventual mudança de regra.
    let t = base;
    for (let i = 0; i < 2; i += 1) t = base - deslocamentoMs(t);
    return new Date(t).toISOString();
}
function deslocamentoMs(instante: number) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: FUSO_CAMPANHA, hourCycle: 'h23', year: 'numeric', month: '2-digit',
        day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(instante)).map(x => [x.type, x.value]));
    return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second)) - Math.floor(instante / 1000) * 1000;
}
export function somarDias(data: string, dias: number): string {
    const d = new Date(`${data}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + dias);
    return d.toISOString().slice(0, 10);
}

/** Mesmo cálculo da guarda 090, para conferência e testes: [D 00:00, D+30 00:00) local, ou 30×24 h do horário exato. */
export function janelaCalculada(contagem: Contagem, abertura: { data?: string; inicio?: string }, dias = 30) {
    if (contagem === 'CALENDARIO_LOCAL') {
        if (!abertura.data) throw new Error('Data de abertura obrigatória.');
        return { inicio: meiaNoiteLocal(abertura.data), janelaFim: meiaNoiteLocal(somarDias(abertura.data, dias)) };
    }
    if (!abertura.inicio || Number.isNaN(Date.parse(abertura.inicio))) throw new Error('Horário de abertura obrigatório.');
    const inicio = new Date(abertura.inicio).toISOString();
    return { inicio, janelaFim: new Date(Date.parse(inicio) + dias * 86_400_000).toISOString() };
}

const fmt = (instante: string, opcoes: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO_CAMPANHA, ...opcoes }).format(new Date(instante));
/**
 * Prazo anunciado da janela. Calendário local: último dia D+29, "até 23h59". Horário exato: último minuto antes do fim.
 * Sempre com o fuso por extenso; nunca inventado quando não há campanha ativada.
 */
export function prazoAnunciado(c: Pick<CampanhaFundador, 'contagem' | 'janelaFim'>) {
    const ultimo = new Date(Date.parse(c.janelaFim) - 60_000).toISOString();
    const dia = fmt(ultimo, { day: '2-digit', month: '2-digit', year: 'numeric' });
    const hora = c.contagem === 'CALENDARIO_LOCAL' ? '23h59' : fmt(ultimo, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).replace(':', 'h');
    return { dia, hora, texto: `até ${dia}, ${hora} (horário de Brasília)` };
}

/** Disponibilidade indicativa, sem ids nem documentos. O checkout sempre recalcula sob trava. */
export type ResumoCampanha =
    | { fase: 'LEGADO' } | { fase: 'DESLIGADA' } | { fase: 'ANTES'; inicio: string }
    | { fase: 'JANELA'; prazo: ReturnType<typeof prazoAnunciado> }
    | { fase: 'POS_JANELA'; vagasRestantes: number; emConfirmacao: number; limite: number }
    | { fase: 'ENCERRADA' };

export async function resumoCampanha(tx: DbExecutor, env: Ambiente = process.env): Promise<ResumoCampanha> {
    if (!await schemaCampanhaInstalado(tx)) return { fase: 'LEGADO' };
    const c = await lerCampanhaAtivada(tx);
    if (!c) return { fase: 'LEGADO' };
    if (!campanhaFundadorLigada(env)) return { fase: 'DESLIGADA' };
    const agora = (await tx.query<{ agora: string }>(`SELECT ${ISO('clock_timestamp()')} AS agora`)).rows[0]?.agora;
    const fase = faseCampanha(c, Date.parse(String(agora)));
    if (fase === 'ANTES') return { fase, inicio: c.inicio };
    if (fase === 'JANELA') return { fase, prazo: prazoAnunciado(c) };
    if (fase === 'ENCERRADA') return { fase };
    const o = await ocupacaoPosJanela(tx, c.id);
    return { fase, vagasRestantes: Math.max(0, c.vagasPosJanela - o.ocupadas), emConfirmacao: o.ocupadas - o.confirmadas, limite: c.vagasPosJanela };
}

export async function ocupacaoPosJanela(tx: DbExecutor, campanhaId: string) {
    const r = (await tx.query<{ ocupadas: number; confirmadas: number }>(`SELECT
        count(*) FILTER (WHERE estado <> 'LIBERADA')::int AS ocupadas, count(*) FILTER (WHERE estado = 'CONFIRMADA')::int AS confirmadas
        FROM assinatura_fundadores WHERE campanha_id = $1::uuid AND origem = 'POS_JANELA'`, [campanhaId])).rows[0];
    return { ocupadas: Number(r?.ocupadas ?? 0), confirmadas: Number(r?.confirmadas ?? 0) };
}
