import { hashCanonico, type Efeito, type Proposta } from './recuperacao-hash.ts';
import { TABELAS } from './recuperacao-efeitos.ts';
import { identidadeDoCaso, type ModoRecuperacao, type PropostaDoCaso } from './recuperacao-casos.ts';
import { minimizarLeitura } from './recuperacao-caso.ts';
import { lerReferenciaExterna } from '../creditos/dominio.ts';
import { EVENTOS_SUPORTADOS } from './sincronizacao.ts';
import type { CobrancaProvedor, FiltroCobrancas, ListaComprovada, WebhookProvedor } from './asaas.ts';

/**
 * B-14 (plano rev. 8.1, §3.2, §3.6–§3.10, §5): regras da execução, sem banco nem rede. Quem conecta, trava, lê o Asaas e
 * grava arquivos é a entrada (`scripts/recuperacao-pagamentos-producao.cjs`) com os modos de `recuperacao-modos.ts`.
 */

// --- Códigos (§3.10) -------------------------------------------------------------------------------------------------
export type Codigo = 0 | 1 | 2 | 3;
/**
 * Tabela única: 1 (recusa técnica, trava, SIGTERM, COMMIT indeterminado, hash divergente) domina; depois 3 (cobertura
 * incompleta, inclusive LIMITE_EXECUCAO e limites internos), que nunca vira 2; o RESTORE nunca devolve 0.
 */
export function codigoFinal(r: { modo: ModoRecuperacao | 'FILA'; recusaTecnica: boolean; coberturaIncompleta: boolean; pendencias: number }): Codigo {
    if (r.recusaTecnica) return 1;
    if (r.coberturaIncompleta) return 3;
    if (r.modo === 'RESTORE') return 2;
    return r.pendencias > 0 ? 2 : 0;
}

// --- Fila do webhook (§3.7) ------------------------------------------------------------------------------------------
export const EVENTOS_OBRIGATORIOS = Object.freeze(['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED', 'PAYMENT_OVERDUE', 'PAYMENT_DELETED', 'PAYMENT_RESTORED',
    'PAYMENT_REFUNDED', 'PAYMENT_PARTIALLY_REFUNDED', 'PAYMENT_RECEIVED_IN_CASH_UNDONE', 'PAYMENT_CHARGEBACK_REQUESTED', 'PAYMENT_CHARGEBACK_DISPUTE',
    'PAYMENT_AWAITING_CHARGEBACK_REVERSAL']);
if (EVENTOS_OBRIGATORIOS.some((e) => !EVENTOS_SUPORTADOS.has(e))) throw new Error('Evento obrigatório da fila fora de EVENTOS_SUPORTADOS.');

export type ConferenciaFila = {
    codigo: 0 | 2 | 3;
    motivos: string[];
    configuracoes: number;
    enabled: boolean | null;
    interrupted: boolean | null;
    sendType: string | null;
    faltantes: string[];
    /** Recusa só por `interrupted = true`, com todas as outras condições atendidas (única exceção da liberação, §5). */
    soInterrompida: boolean;
};

/** Mesma rota: origem e caminho, sem a barra final; nunca impressa. */
function rota(u: string | null) {
    if (!u) return null;
    try { const x = new URL(u); return `${x.protocol}//${x.host}${x.pathname.replace(/\/+$/, '')}`; }
    catch { return null; }
}

/** Lê e confere a fila. Listagem incompleta (ou que falha) → 3. Imprime só estado e eventos faltantes; nunca reativa. */
export async function conferirFila(listar: () => Promise<ListaComprovada<WebhookProvedor>>, urlProducao: string): Promise<ConferenciaFila> {
    const vazia = { configuracoes: 0, enabled: null, interrupted: null, sendType: null, faltantes: [], soInterrompida: false };
    let lida: ListaComprovada<WebhookProvedor>;
    try { lida = await listar(); }
    catch { return { codigo: 3, motivos: ['LISTAGEM_INCOMPLETA'], ...vazia }; }
    const alvo = rota(urlProducao);
    if (!alvo) throw new Error('URL de produção do webhook inválida.');
    const da = lida.itens.filter((w) => rota(w.url) === alvo);
    if (da.length !== 1) return { codigo: 2, motivos: [da.length === 0 ? 'SEM_CONFIGURACAO' : 'CONFIGURACAO_DUPLICADA'], ...vazia, configuracoes: da.length };
    const w = da[0];
    const faltantes = EVENTOS_OBRIGATORIOS.filter((e) => !w.events.includes(e));
    const motivos = [
        ...(w.enabled !== true ? ['DESABILITADA'] : []),
        ...(w.interrupted !== false ? ['INTERROMPIDA'] : []),
        ...(w.sendType !== 'SEQUENTIALLY' ? ['SEND_TYPE'] : []),
        ...(faltantes.length ? ['EVENTOS_FALTANDO'] : []),
    ];
    return { codigo: motivos.length ? 2 : 0, motivos, configuracoes: 1, enabled: w.enabled, interrupted: w.interrupted,
        sendType: /^[A-Z_]{1,40}$/.test(w.sendType ?? '') ? w.sendType : null, faltantes, soInterrompida: motivos.length === 1 && motivos[0] === 'INTERROMPIDA' };
}

// --- Schema, código no ar e matriz de modos (§3.5, §3.8) -------------------------------------------------------------
/**
 * Marcadores verificáveis por presença de objeto. 092, 099 e 100 só fazem CREATE OR REPLACE de funções existentes: ficam
 * com o CONFERIR do B-5, que a pessoa passa em `--migracoes` (a ferramenta não as deduz).
 */
export const MARCADORES: Readonly<Record<string, { tipo: 'tabela' | 'funcao'; nome: string }>> = Object.freeze({
    '089': { tipo: 'tabela', nome: 'assinatura_encerramentos' },
    '090': { tipo: 'tabela', nome: 'assinatura_campanhas' },
    '091': { tipo: 'tabela', nome: 'empresa_documento_continuidades' },
    '093': { tipo: 'tabela', nome: 'agenda_saloes' },
    '094': { tipo: 'funcao', nome: 'kidmais094_salao_fechamento' },
    '095': { tipo: 'tabela', nome: 'ia_credito_carteiras' },
    '096': { tipo: 'tabela', nome: 'assinatura_comprovantes' },
    '097': { tipo: 'tabela', nome: 'assinatura_arrependimentos' },
});

/**
 * Marcadores das migrations neutras (PH, D-HML-1 = B): conferidos SÓ em sandbox, para que a 102–106 declarada exista de
 * fato e a presente seja declarada. A 103 só insere uma linha (sem objeto próprio): sem marcador, declarada pela fé do
 * CONFERIR; é neutra, logo não muda o que o B-14 lê. Production confere só os MARCADORES acima (comportamento inalterado).
 */
export const MARCADORES_NEUTROS: Readonly<Record<string, { tipo: 'tabela' | 'funcao'; nome: string }>> = Object.freeze({
    '102': { tipo: 'tabela', nome: 'agenda_salao_itens_catalogo' },
    '104': { tipo: 'funcao', nome: 'kidmais104_hash_versao_imutavel' },
    '105': { tipo: 'tabela', nome: 'mcp_oauth_clientes' },
    '106': { tipo: 'funcao', nome: 'kidmais106_salao_preferido_escopo' },
});
export const marcadoresDoAmbiente = (ambiente: 'sandbox' | 'producao') => ambiente === 'sandbox' ? { ...MARCADORES, ...MARCADORES_NEUTROS } : MARCADORES;

/** Declarado (CONFERIR do B-5) × presente no banco: qualquer marcador divergente recusa (código 1). */
export function divergenciasDeMarcadores(declaradas: readonly string[], presentes: ReadonlySet<string>, marcadores: Readonly<Record<string, unknown>> = MARCADORES): string[] {
    return Object.keys(marcadores).filter((m) => declaradas.includes(m) !== presentes.has(m)).sort();
}

export const CODIGO_ANTIGO = '00d3019a';
export type CodigoNoAr = 'CANDIDATA' | 'ANTIGO';
/** Commit do web (RENDER_GIT_COMMIT) × candidata informada: só um dos dois é aceito; outro commit recusa. */
export function codigoNoAr(commitDoWeb: string | undefined, candidata: string | undefined): CodigoNoAr | null {
    const c = (commitDoWeb ?? '').trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(c)) return null;
    if (candidata && /^[0-9a-f]{40}$/.test(candidata) && c === candidata) return 'CANDIDATA';
    if (c.startsWith(CODIGO_ANTIGO)) return 'ANTIGO';
    return null;
}

export const MODOS = ['fila', 'janela-conferir', 'janela-recuperar', 'restore-drenagem', 'restore-inventario', 'restore-aplicar', 'restore-conferir', 'restore-liberacao'] as const;
export type Modo = (typeof MODOS)[number];

/** Matriz ramo × código × schema (§3.8). Índices: P0a 0, P0b/P1 1, P2 2, P3 3, P4 4 … P11 11; null = fora da lista. */
export function modoAdmitido(indice: number | null, codigo: CodigoNoAr | null, modo: Modo): boolean {
    if (modo === 'fila') return true;
    if (indice === null || codigo === null) return false;
    const restore = modo.startsWith('restore-');
    if (codigo === 'ANTIGO') {
        if (indice <= 1) return restore || modo === 'janela-conferir';
        if (indice <= 4) return restore;
        return false;
    }
    return indice >= 4;
}

// --- Backup, prova do cron antigo e decisões --------------------------------------------------------------------------
/**
 * Manifesto do export (D-B14-2, D-B14-12): JSON do export validado, do MESMO banco, concluído há no máximo 24 h e, no
 * RESTORE, depois do restore. O formato final é o do export verificável usado no B-4 (fixado na homologação).
 */
export function validarBackup(m: unknown, c: { banco: string; agoraMs: number; restauradoEmMs?: number | null }): string | null {
    const o = m as Record<string, unknown> | null;
    if (!o || typeof o !== 'object') return 'BACKUP_ILEGIVEL';
    if (o.banco !== c.banco) return 'BACKUP_DE_OUTRO_BANCO';
    if (typeof o.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(o.sha256)) return 'BACKUP_SEM_SHA';
    if (o.validado !== true) return 'BACKUP_NAO_VALIDADO';
    const t = typeof o.concluido_em === 'string' ? Date.parse(o.concluido_em) : NaN;
    if (!Number.isFinite(t) || t > c.agoraMs || c.agoraMs - t > 24 * 3_600_000) return 'BACKUP_FORA_DO_PRAZO';
    if (c.restauradoEmMs != null && t < c.restauradoEmMs) return 'BACKUP_ANTERIOR_AO_RESTORE';
    return null;
}

/** D-B14-18: só a execução concluída, código 0, sem divergência nem incompletude, gratuidade válida, do artefato 7ce0916f. */
export function validarProvaCronAntigo(p: unknown): string | null {
    const o = p as { artefato?: unknown; concluida?: unknown; codigo?: unknown; relatorio?: { divergente?: unknown; incompleto?: unknown; kidmais?: { violada?: unknown } } } | null;
    if (!o || typeof o !== 'object') return 'PROVA_ILEGIVEL';
    if (o.artefato !== '7ce0916f') return 'ARTEFATO_DIFERENTE';
    if (o.concluida !== true) return 'EXECUCAO_NAO_CONCLUIDA';
    if (o.codigo !== 0) return 'CODIGO_DIFERENTE_DE_0';
    if (o.relatorio?.divergente !== false) return 'DIVERGENTE';
    if (o.relatorio?.incompleto !== false) return 'INCOMPLETO';
    if (o.relatorio?.kidmais?.violada !== false) return 'GRATUIDADE_VIOLADA';
    return null;
}

export type Decisao = 'APLICAR' | 'OUTRA' | 'NENHUMA';
/**
 * Arquivo de decisões de Felipe (A-B14-O). Revisão do Astra do incremento 4 (P2-4): preso a UM inventário — a execução
 * (`inventario`), o digest do arquivo de casos (`digestInventario`) e, por caso, o hash da proposta decidida (`proposta`,
 * null quando o inventário não trouxe proposta). Aceites explícitos: limitação de cobertura e retenção acima de 14 dias.
 * Achado do H7 (29/10, EVENTO_SEM_EMPRESA): evento sem empresa resolvível não tem fotografia nem proposta, então não é caso;
 * vai para a pessoa (D-I4-9) e só libera resolvido fora da ferramenta. `eventosSemEmpresa` (opcional; ausente = nenhuma
 * decisão) registra, por evento, a disposição de Felipe depois de examinar o contexto do inventário (revisão do Astra, P2-1):
 *   SEM_EFEITO_COMPROVADO  investigado no provedor: o evento não tem efeito KidMais a recuperar;
 *   TRATADO_FORA           o efeito foi tratado fora da ferramenta e o tratamento está concluído;
 * e a `evidencia` (referência ou justificativa, texto curto, sem dado pessoal). Risco assumido sem investigação não é
 * disposição aceita: mudaria a D-I4-9.
 */
export const DISPOSICOES_SEM_EMPRESA = Object.freeze(['SEM_EFEITO_COMPROVADO', 'TRATADO_FORA'] as const);
export type DecisaoSemEmpresa = { disposicao: (typeof DISPOSICOES_SEM_EMPRESA)[number]; evidencia: string };
export type Decisoes = { formato: 2; inventario: string; digestInventario: string; casos: Record<string, { decisao: Decisao; proposta: string | null }>;
    orfas: Record<string, 'ACEITA'>; eventosSemEmpresa: Record<string, DecisaoSemEmpresa>; coberturaAceita: boolean; retencaoAceita: boolean };
/** Evidência: 10 a 500 caracteres, uma linha, sem caracteres de controle nem separadores Unicode de linha/parágrafo (P3-R2-1). */
const EVIDENCIA = /^[^\p{Cc}\p{Zl}\p{Zp}]{10,500}$/u;
const ID = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function lerDecisoes(d: unknown): Decisoes {
    const o = d as Record<string, unknown> | null;
    if (!o || o.formato !== 2 || typeof o.inventario !== 'string' || !UUID.test(o.inventario) || typeof o.digestInventario !== 'string' || !ID.test(o.digestInventario)
        || typeof o.coberturaAceita !== 'boolean' || typeof o.retencaoAceita !== 'boolean') throw new Error('DECISOES_INVALIDAS');
    const casos = (o.casos ?? {}) as Record<string, { decisao?: unknown; proposta?: unknown }>, orfas = (o.orfas ?? {}) as Record<string, unknown>;
    const semEmpresa = (o.eventosSemEmpresa ?? {}) as Record<string, unknown>;
    if (typeof semEmpresa !== 'object' || semEmpresa === null || Array.isArray(semEmpresa)) throw new Error('DECISOES_INVALIDAS');
    for (const [k, v] of Object.entries(casos))
        if (!ID.test(k) || !v || !['APLICAR', 'OUTRA', 'NENHUMA'].includes(String(v.decisao)) || !(v.proposta === null || (typeof v.proposta === 'string' && ID.test(v.proposta))))
            throw new Error('DECISOES_INVALIDAS');
    for (const [k, v] of Object.entries(orfas)) if (!ID.test(k) || v !== 'ACEITA') throw new Error('DECISOES_INVALIDAS');
    const eventosSemEmpresa: Record<string, DecisaoSemEmpresa> = {};
    for (const [k, v] of Object.entries(semEmpresa)) {
        const s = v as { disposicao?: unknown; evidencia?: unknown } | null;
        if (!ID.test(k) || !s || typeof s !== 'object' || Object.keys(s).some((c) => c !== 'disposicao' && c !== 'evidencia')
            || !(DISPOSICOES_SEM_EMPRESA as readonly unknown[]).includes(s.disposicao) || typeof s.evidencia !== 'string' || !EVIDENCIA.test(s.evidencia.trim()))
            throw new Error('DECISOES_INVALIDAS');
        eventosSemEmpresa[k] = { disposicao: s.disposicao as DecisaoSemEmpresa['disposicao'], evidencia: s.evidencia.trim() };
    }
    return { formato: 2, inventario: o.inventario, digestInventario: o.digestInventario, casos: casos as Decisoes['casos'], orfas: orfas as Record<string, 'ACEITA'>,
        eventosSemEmpresa, coberturaAceita: o.coberturaAceita, retencaoAceita: o.retencaoAceita };
}

/** Arquivo de casos do inventário (o que `modoInventario` grava). */
export type ArquivoDeCasos = { formato: 1; execucao: string; schema: string; codigoNoAr: CodigoNoAr; reinicio: string;
    casos: { identidade: string; hash: string | null }[]; orfas: { identidade: string }[]; eventosSemEmpresa?: string[]; contextoSemEmpresa?: { identidade: string }[] };
/**
 * P2-4: as decisões valem só para o inventário que declaram — o arquivo existe, tem o formato, o digest declarado, o mesmo
 * schema, código no ar e reinício da liberação; cada caso, órfã e evento sem empresa do inventário tem decisão, cada decisão
 * é de um item dele e, no caso, com o hash da proposta apresentada. Devolve o primeiro motivo de recusa (código 1) ou null.
 */
export function conferirVinculoDasDecisoes(d: Decisoes, inv: unknown, ctx: { schema: string; codigoNoAr: CodigoNoAr; reinicio: string }): string | null {
    const i = inv as ArquivoDeCasos | null;
    if (!i || i.formato !== 1 || i.execucao !== d.inventario || !Array.isArray(i.casos) || !Array.isArray(i.orfas)) return 'INVENTARIO_DAS_DECISOES_INEXISTENTE';
    if (hashCanonico(i) !== d.digestInventario) return 'INVENTARIO_DAS_DECISOES_ALTERADO';
    if (i.schema !== ctx.schema || i.codigoNoAr !== ctx.codigoNoAr || i.reinicio !== ctx.reinicio) return 'INVENTARIO_DE_OUTRO_CONTEXTO';
    const doInventario = new Map(i.casos.map((c) => [c.identidade, c.hash]));
    for (const [id, v] of Object.entries(d.casos)) if (!doInventario.has(id) || doInventario.get(id) !== v.proposta) return 'DECISAO_FORA_DO_INVENTARIO';
    if ([...doInventario.keys()].some((id) => !d.casos[id])) return 'CASO_DO_INVENTARIO_SEM_DECISAO';
    const orfas = new Set(i.orfas.map((o) => o.identidade));
    if (Object.keys(d.orfas).some((o) => !orfas.has(o)) || [...orfas].some((o) => !d.orfas[o])) return 'ORFAS_FORA_DO_INVENTARIO';
    if (i.eventosSemEmpresa !== undefined && !Array.isArray(i.eventosSemEmpresa)) return 'INVENTARIO_DAS_DECISOES_INEXISTENTE';
    const semEmpresa = new Set(i.eventosSemEmpresa ?? []);
    if (Object.keys(d.eventosSemEmpresa).some((e) => !semEmpresa.has(e))) return 'EVENTOS_SEM_EMPRESA_FORA_DO_INVENTARIO';
    if ([...semEmpresa].some((e) => !d.eventosSemEmpresa[e])) return 'EVENTO_SEM_EMPRESA_DO_INVENTARIO_SEM_DECISAO';
    // P2-1: decidir exige o contexto apresentado no MESMO arquivo (preso pelo digest); inventário anterior à correção não serve.
    const contexto = new Set(Array.isArray(i.contextoSemEmpresa) ? i.contextoSemEmpresa.map((c) => c?.identidade) : []);
    if ([...semEmpresa].some((e) => !contexto.has(e))) return 'EVENTO_SEM_EMPRESA_SEM_CONTEXTO';
    return null;
}

/** §5: retenção no Asaas acima de 14 dias perde eventos; a liberação exige o aceite dessa limitação. */
export const RETENCAO_MAXIMA_MS = 14 * 24 * 3_600_000;

// --- Liberação (§5, D-B14-17, D-B14-18) -------------------------------------------------------------------------------
export type ItemLiberacao = { identidade: string; semEfeito: boolean; falha: string | null };
export type Liberacao = { liberada: boolean; bloqueios: string[]; exigenciasPosReabertura: string[]; excecaoExpressa: boolean };
/**
 * Libera só com: todo caso atual decidido (e nenhum caso novo); toda chave KidMais em SEM_EFEITO sob as regras da candidata
 * (com o código antigo, a prova é o cron antigo — exceção expressa — e o SEM_EFEITO vira evidência complementar); toda órfã
 * decidida; todo evento sem empresa com disposição (fora de `itens`: não é caso nem tem efeito calculável); cobertura completa ou
 * aceita; fila código 0 ou só `interrupted` (com as três exigências pós-reabertura).
 */
export function avaliarLiberacao(e: { itens: readonly ItemLiberacao[]; orfas: readonly string[]; semEmpresa: readonly string[]; coberturaIncompleta: boolean; decisoes: Decisoes;
    fila: ConferenciaFila; codigo: CodigoNoAr; provaCronAntigo: string | null | undefined; retencaoAcima14Dias: boolean }): Liberacao {
    const b: string[] = [];
    // Caso que não estava no inventário decidido (surgiu depois): sem decisão.
    if (e.itens.some((i) => !e.decisoes.casos[i.identidade])) b.push('CASO_SEM_DECISAO');
    const comEfeito = e.itens.some((i) => i.falha !== null || !i.semEfeito);
    if (e.codigo === 'CANDIDATA' && comEfeito) b.push('COM_EFEITO_NORMAL');
    if (e.codigo === 'ANTIGO' && e.provaCronAntigo !== null) b.push(`SEM_PROVA_DO_CRON_ANTIGO:${e.provaCronAntigo ?? 'AUSENTE'}`);
    if (e.orfas.some((o) => !e.decisoes.orfas[o])) b.push('ORFA_SEM_DECISAO');
    if (e.semEmpresa.some((s) => !e.decisoes.eventosSemEmpresa[s])) b.push('EVENTO_SEM_EMPRESA_SEM_DECISAO');
    if (e.coberturaIncompleta && !e.decisoes.coberturaAceita) b.push('COBERTURA_NAO_ACEITA');
    if (e.retencaoAcima14Dias && !e.decisoes.retencaoAceita) b.push('RETENCAO_ACIMA_DE_14_DIAS_NAO_ACEITA');
    const filaOk = e.fila.codigo === 0 || e.fila.soInterrompida;
    if (!filaOk) b.push(`FILA:${e.fila.motivos.join('+') || 'RECUSADA'}`);
    return { liberada: b.length === 0, bloqueios: b,
        exigenciasPosReabertura: filaOk && e.fila.soInterrompida ? ['REATIVAR_FILA', 'NOVA_LEITURA_FILA_CODIGO_0', 'CONFIRMAR_ENTREGA'] : [],
        excecaoExpressa: e.codigo === 'ANTIGO' };
}

// --- Dupla leitura (§3.6) ---------------------------------------------------------------------------------------------
export type Consistencia = 'CONSISTENTE' | 'RELIDO' | 'INCONCLUSIVO';
/** Assinatura do que o caso leu (local e remoto): o hash da proposta, ou o código da falha. */
/**
 * Assinatura de consistência (§3.6 b: o que o caso LEU tem de ser igual). Achado da matriz com dados (revisão do HB-3,
 * 28/10): comparar o hash inteiro tornava INCONCLUSIVO todo caso com coluna comercial do instante (`doInstante`, p.ex.
 * `cancelada_em` = agora num cancelamento), porque duas propostas a milissegundos de distância nunca batiam. Agora:
 * pré-condições (leituras locais e remotas) + efeitos com o VALOR dessas colunas mascarado (presença/ausência continua
 * contando). O valor fica fixo na proposta escolhida e é o regravado na aplicação.
 */
export function assinaturaDaProposta(proposta: Proposta, falha: string | null = null) {
    const efeitos = (proposta.efeitos as Efeito[]).map((e) => {
        const doInstante = TABELAS[e.tabela]?.doInstante ?? [];
        return { ...e, colunas: Object.fromEntries(Object.entries(e.colunas).map(([c, v]) => [c, doInstante.includes(c) && v.depois !== null ? { ...v, depois: '$doInstante' } : v])) };
    });
    return hashCanonico({ precondicoes: proposta.precondicoes, efeitos, falha });
}
function assinaturaDoCaso(p: PropostaDoCaso) {
    return p.proposta ? assinaturaDaProposta(p.proposta, p.falha) : (p.hash ?? `FALHA:${p.falha}`);
}

/**
 * Consistência por caso (§3.6 b): o caso é proposto duas vezes; o que ele leu (pré-condições locais e remotas) tem de ser
 * igual. Diferente → uma terceira leitura; diferente da segunda de novo → INCONCLUSIVO. Cobre também as listas que o serviço
 * lê (cobranças da assinatura, por referência), que ficam dentro da proposta.
 */
export async function proporDuasVezes(propor: () => Promise<PropostaDoCaso>): Promise<{ p: PropostaDoCaso; consistencia: Consistencia }> {
    const a = await propor();
    const b = await propor();
    if (assinaturaDoCaso(a) === assinaturaDoCaso(b)) return { p: b, consistencia: 'CONSISTENTE' };
    const c = await propor();
    return { p: c, consistencia: assinaturaDoCaso(c) === assinaturaDoCaso(b) ? 'RELIDO' : 'INCONCLUSIVO' };
}

/** Falha que é da LEITURA (provedor fora, lista acima do teto): cobertura incompleta (3), não decisão de pessoa. */
export const falhaDeCobertura = (falha: string | null) => !!falha && /^(?:PROVEDOR_INDISPONIVEL|LISTA_INCOMPLETA)(?::|$)/.test(falha);
/**
 * Falha efetiva do caso (P2-7): a lançada pelo serviço (`p.falha`) ou a que ele absorveu e devolveu no resultado — o
 * `processarEvento` marca o evento FALHOU e devolve `{ situacao: 'FALHOU', motivo }` em vez de lançar.
 */
export function falhaDoCaso(p: PropostaDoCaso): string | null {
    if (p.falha) return p.falha;
    const r = p.resultado as { situacao?: unknown; motivo?: unknown } | null;
    return r && r.situacao === 'FALHOU' ? (typeof r.motivo === 'string' && r.motivo ? r.motivo : 'EVENTO_FALHOU') : null;
}

/** Estado comparável de uma cobrança remota entre as passadas (sem texto livre). */
const estadoRemoto = (c: CobrancaProvedor) => hashCanonico(minimizarLeitura(JSON.parse(JSON.stringify(c))));

export type ListaRemota = { itens: CobrancaProvedor[]; completa: boolean; motivos: string[]; inconclusivos: string[] };
/**
 * Inventário remoto do RESTORE (D-B14-5): cada filtro lido duas vezes por completo (mesmo conjunto de ids); item que mudou
 * entre as passadas é relido uma vez por id; se mudou de novo, INCONCLUSIVO. Qualquer falha de listagem → incompleta.
 */
export async function lerCobrancasRemotas(cliente: { listarCobrancas(f: FiltroCobrancas): Promise<ListaComprovada<CobrancaProvedor>>; obterCobranca(id: string): Promise<CobrancaProvedor | null> },
    filtros: readonly FiltroCobrancas[]): Promise<ListaRemota> {
    const itens = new Map<string, CobrancaProvedor>();
    const motivos: string[] = [];
    const inconclusivos = new Set<string>();
    for (const f of filtros) {
        let a: ListaComprovada<CobrancaProvedor>, b: ListaComprovada<CobrancaProvedor>;
        try { a = await cliente.listarCobrancas(f); b = await cliente.listarCobrancas(f); }
        catch { motivos.push(`LISTA_FALHOU:${f.campo}`); continue; }
        const ma = new Map(a.itens.map((c) => [c.id, c])), mb = new Map(b.itens.map((c) => [c.id, c]));
        if (ma.size !== mb.size || [...ma.keys()].some((id) => !mb.has(id))) { motivos.push(`CONJUNTOS_DIFERENTES:${f.campo}`); continue; }
        for (const [id, cb] of mb) {
            let atual = cb;
            if (estadoRemoto(ma.get(id)!) !== estadoRemoto(cb)) {
                let relida: CobrancaProvedor | null = null;
                try { relida = await cliente.obterCobranca(id); } catch { relida = null; }
                if (!relida || estadoRemoto(relida) !== estadoRemoto(cb)) { inconclusivos.add(identidadeDoCaso('COBRANCA_REMOTA', id)); continue; }
                atual = relida;
            }
            itens.set(id, atual);
        }
    }
    return { itens: [...itens.values()].sort((x, y) => x.id.localeCompare(y.id)), completa: motivos.length === 0, motivos, inconclusivos: [...inconclusivos].sort() };
}

export type ChavesRemotas = { pagamentos: ReadonlySet<string>; pedidos: ReadonlySet<string>; assinaturas: ReadonlySet<string> };
export type Orfa = { identidade: string; classe: 'ORFA_CREDITOS' | 'ORFA_ASSINATURA' | 'INDETERMINADA' };
/**
 * Cobranças remotas sem registro local (§3.6.1, só RESTORE). Coberta: pagamento já local, referência de créditos de um
 * pedido local do mesmo ambiente, ou assinatura local. Referência de créditos sem pedido → ORFA_CREDITOS; assinatura sem
 * empresa → ORFA_ASSINATURA; sem chave KidMais → INDETERMINADA (nunca "fora do KidMais" só por falta de vínculo).
 */
export function orfasRemotas(itens: readonly CobrancaProvedor[], locais: ChavesRemotas, ambiente: 'sandbox' | 'producao'): Orfa[] {
    const r: Orfa[] = [];
    for (const c of itens) {
        if (locais.pagamentos.has(c.id)) continue;
        const ref = lerReferenciaExterna(c.externalReference ?? null);
        if (ref && ref.ambiente === ambiente && locais.pedidos.has(ref.pedidoId)) continue;
        if (c.assinaturaId && locais.assinaturas.has(c.assinaturaId)) continue;
        const classe = ref && ref.ambiente === ambiente ? 'ORFA_CREDITOS' : c.assinaturaId ? 'ORFA_ASSINATURA' : 'INDETERMINADA';
        r.push({ identidade: identidadeDoCaso('COBRANCA_REMOTA', c.id), classe });
    }
    return r.sort((a, b) => a.identidade.localeCompare(b.identidade));
}

// --- Saída pública (D-B14-3) -------------------------------------------------------------------------------------------
/** Só códigos (maiúsculas, dígitos, `_`, `:`, `+`); qualquer outra coisa vira `OUTRO`. */
export const codigoSeguro = (v: unknown) => (typeof v === 'string' && /^[A-Z0-9_:+]{1,120}$/.test(v) ? v : 'OUTRO');
/** Identidade opaca (sha-256) ou nada. */
export const opaco = (v: unknown) => (typeof v === 'string' && ID.test(v) ? v : null);
