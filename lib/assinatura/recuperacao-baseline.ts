import { createHash } from 'node:crypto';
import type { Ciclo } from './configuracao.ts';
import { STATUS_PAGO } from './provedor-estado.ts';
import type { Leitura } from './recuperacao-caso.ts';
import { identidadeDoCaso, type PropostaDoCaso } from './recuperacao-casos.ts';
import { CLASSES, cobrancasLidas, periodoCalculado, type Classe, type Classificacao } from './recuperacao-classes.ts';
import { COLUNAS_DE_OBSERVACAO, TABELAS, type Fotografia, type Linha } from './recuperacao-efeitos.ts';
import { hashCanonico } from './recuperacao-hash.ts';

/**
 * B-14 (plano rev. 8.1, §3.5): linha de base da JANELA.
 *   - Formato versionado; o schema é o prefixo admitido (P0a…P11) com a impressão digital das migrations aplicadas além
 *     do production atual (até 088). Fora da lista → nenhum modo além de `--fila`.
 *   - D-HML-1 = B (Felipe, 28/10/2026): prefixo de HOMOLOGAÇÃO `PH`, só no ambiente sandbox (staging e o descartável):
 *     P11 completo mais um subconjunto não vazio das migrations NEUTRAS para o B-14 (102–106: salões, categoria Serviços,
 *     hash da revisão, OAuth do MCP, salão preferido; nenhuma altera tabela, gatilho ou função que a árvore usa — teste
 *     estático `recuperacao-neutras.test.ts`, com o sha de cada arquivo fixado). Vale como P11 na matriz e na base. Em
 *     production nunca: com qualquer neutra o schema fica fora da lista (D-ESC-3 deixa 102/103 fora da promoção).
 *   - A base é selada pelo sha do conteúdo canônico e NUNCA recriada: ausente, sha divergente, formato desconhecido ou
 *     prefixo fora da lista/não contido no atual → BASELINE_INVALIDA (código 2).
 *   - Identidade estável = sha(tipo + id interno), sem o motivo. Conteúdo comparável: classe, estado, motivo, hash da
 *     proposta, indicadores e prazos como INSTANTE ABSOLUTO do limite (o passar do tempo não muda o item).
 * Função pura: a leitura das migrations aplicadas (CONFERIR do B-5) e o arquivo restrito ficam com a entrada.
 */
/**
 * Formato 2 (revisão do HB-3 r3, P2): a base guarda a FORMA do schema em que foi selada (colunas de cada tabela da
 * fotografia, pelo catálogo). Entre prefixos, o hash comparável do item atual é calculado NA FORMA DA BASE: tabelas e
 * colunas surgidas depois (adições estruturais esperadas) ficam de fora; tudo o que existia na base continua comparado —
 * inclusive valores comerciais (ex.: estorno de R$ 10 para R$ 80) —, e coluna da base que sumiu conta como diferença.
 */
export const FORMATO_BASE = 2;
/** Colunas de cada tabela da lista fechada no schema em que a base foi selada (ordem alfabética). */
export type Forma = Record<string, readonly string[]>;

/** Ordem da promoção (§3.5): cada prefixo acrescenta uma migration atômica. P0b e P1 têm a mesma impressão digital. */
export const PREFIXOS: readonly { nome: string; migrations: readonly string[] }[] = (() => {
    const passos: [string, string | null][] = [['P0a', null], ['P1', '089'], ['P2', '092'], ['P3', '093'], ['P4', '099'], ['P5', '090'],
        ['P6', '094'], ['P7', '095'], ['P8', '096'], ['P9', '097'], ['P10', '100'], ['P11', '091']];
    const r: { nome: string; migrations: string[] }[] = [];
    let acumulado: string[] = [];
    for (const [nome, m] of passos) { acumulado = m ? [...acumulado, m] : acumulado; r.push({ nome, migrations: [...acumulado].sort() }); }
    return Object.freeze(r);
})();

/** Migrations neutras para o B-14, admitidas SÓ em sandbox e SÓ sobre o P11 completo (prefixo `PH`). */
export const NEUTRAS_HOMOLOGACAO: readonly string[] = Object.freeze(['102', '103', '104', '105', '106']);
const P11 = PREFIXOS.length - 1;
export type AmbienteDoSchema = 'sandbox' | 'producao';
const impressaoDe = (migrations: readonly string[]) => createHash('sha256').update(migrations.join(',')).digest('hex');
/** Impressões digitais possíveis do PH: P11 mais cada subconjunto não vazio das neutras (31). */
const IMPRESSOES_PH: ReadonlySet<string> = (() => {
    const r = new Set<string>();
    for (let mascara = 1; mascara < 1 << NEUTRAS_HOMOLOGACAO.length; mascara++)
        r.add(impressaoDe([...PREFIXOS[P11].migrations, ...NEUTRAS_HOMOLOGACAO.filter((_, i) => mascara & (1 << i))].sort()));
    return r;
})();

/** Migrations além do production atual: número > 088 (sufixos como 074a ficam no production). */
const alemDoProduction = (aplicadas: readonly string[]) => [...new Set(aplicadas.filter((m) => /^\d{3}[a-z]?$/.test(m) && Number.parseInt(m, 10) > 88))].sort();

/** Prefixo admitido do schema ou null (migration parcial, ordem diferente, migration fora da lista: só `--fila`). */
export function prefixoDoSchema(aplicadas: readonly string[], ambiente: AmbienteDoSchema = 'producao'): { nome: string; indice: number; impressao: string } | null {
    const alem = alemDoProduction(aplicadas);
    const impressao = impressaoDe(alem);
    const indice = PREFIXOS.findIndex((p) => p.migrations.length === alem.length && p.migrations.every((m, i) => m === alem[i]));
    if (indice >= 0) return { nome: PREFIXOS[indice].nome, indice, impressao };
    // PH: só em sandbox (o padrão é production, que nunca o admite) e só com a impressão de P11 + neutras.
    if (ambiente !== 'sandbox' || !IMPRESSOES_PH.has(impressao)) return null;
    return { nome: 'PH', indice: P11, impressao };
}

/** A partir de qual prefixo cada tipo de item existe (créditos desde a 095 = P7). */
const DESDE: Record<string, string> = { PEDIDO: 'P7', COBRANCA: 'P7' };
const indiceDe = (nome: string) => nome === 'PH' ? P11 : PREFIXOS.findIndex((p) => p.nome === nome);

export type ItemBase = {
    identidade: string;
    tipo: string;
    /** sha(EMPRESA + id): agrupa os itens da mesma empresa sem gravar o id. */
    empresa: string | null;
    classe: Classe;
    estado: string | null;
    motivo: string | null;
    /** Hash estrito da proposta (aplicação T1/T2): só para rastreio; NÃO é comparado entre base e conferência. */
    hashProposta: string | null;
    /**
     * Hash comparável (revisão de 27/10, P2-4): fotografia, leituras e efeitos SEM os metadados de observação tolerados
     * (sincronizado_em, provedor_situacao, conferida_em, reconciliado_em e as derivadas dos gatilhos). Uma sincronização
     * normal do web entre a base e a conferência não o muda; qualquer outra mudança, sim.
     */
    hashComparavel: string | null;
    /** Indicadores (§3.5): inteiros não negativos; ausência = 0. */
    indicadores: Record<string, number>;
    /** Prazos: instante absoluto (ISO) de cada limite — período e UM por lote com saldo (`lote:<sha da chave natural>`). */
    limites: Record<string, string>;
};
export type LinhaDeBase = { formato: number; schema: { prefixo: string; impressao: string }; forma: Forma; instante: string; itens: ItemBase[] };

export const INDICADORES = ['cobrancas_problematicas', 'estorno_disputa_devolucao', 'periodo_local_menos_calculado_s', 'creditos_pagos_sem_lote'] as const;

export function selarBase(base: LinhaDeBase): { base: LinhaDeBase; sha: string } {
    const ordenada = { ...base, itens: [...base.itens].sort((a, b) => a.identidade.localeCompare(b.identidade)) };
    return { base: ordenada, sha: hashCanonico(ordenada) };
}

export type BaseValidada = { valida: true; base: LinhaDeBase } | { valida: false; motivo: 'BASELINE_INVALIDA'; detalhe: string; codigo: 2 };

/** Confere a base preservada contra o sha registrado e contra o schema atual (§3.5). Nunca a recria. */
export function validarBase(base: LinhaDeBase | null | undefined, shaRegistrado: string | null | undefined, aplicadasAgora: readonly string[],
    ambiente: AmbienteDoSchema = 'producao'): BaseValidada {
    const invalida = (detalhe: string): BaseValidada => ({ valida: false, motivo: 'BASELINE_INVALIDA', detalhe, codigo: 2 });
    if (!base || !shaRegistrado) return invalida('BASE_AUSENTE');
    if (base.formato !== FORMATO_BASE || !base.forma || typeof base.forma !== 'object' || Object.values(base.forma).some((c) => !Array.isArray(c))) return invalida('FORMATO_DESCONHECIDO');
    if (selarBase(base).sha !== shaRegistrado) return invalida('SHA_DIVERGENTE');
    if (base.schema.prefixo === 'PH') {
        if (ambiente !== 'sandbox' || !IMPRESSOES_PH.has(base.schema.impressao)) return invalida('PREFIXO_DA_BASE_FORA_DA_LISTA');
    }
    else {
        const daBase = PREFIXOS[indiceDe(base.schema.prefixo)];
        if (!daBase || impressaoDe(daBase.migrations) !== base.schema.impressao) return invalida('PREFIXO_DA_BASE_FORA_DA_LISTA');
    }
    const atual = prefixoDoSchema(aplicadasAgora, ambiente);
    if (!atual) return invalida('PREFIXO_ATUAL_FORA_DA_LISTA');
    if (atual.indice < indiceDe(base.schema.prefixo)) return invalida('PREFIXO_ATUAL_NAO_CONTEM_A_BASE');
    if (base.itens.some((i) => !(CLASSES as readonly string[]).includes(i.classe))) return invalida('CLASSE_DESCONHECIDA');
    return { valida: true, base };
}

const GRAVIDADE_CLASSE: Record<Classe, number> = { RECONCILIADA: 0, PROPOSTA: 1, CORRELACIONADA_NAO_COMPROVADA: 2, ORFA_CREDITOS: 3, ORFA_ASSINATURA: 3, INDETERMINADA: 4 };
/** Estados com ordem conhecida (assinatura); para os demais, qualquer mudança conta como piora (fecha em falha). */
const GRAVIDADE_ESTADO: Record<string, number> = { TESTE: 0, ATIVA: 0, CANCELADA_FIM_PERIODO: 1, EM_ATRASO: 2, ENCERRADA: 3 };
function estadoPior(antes: string | null, depois: string | null) {
    if (antes === depois) return false;
    const a = antes === null ? undefined : GRAVIDADE_ESTADO[antes], d = depois === null ? undefined : GRAVIDADE_ESTADO[depois];
    return a === undefined || d === undefined ? true : d > a;
}

export type Agravamento = 'CLASSE_PIOR' | 'ESTADO_PIOR' | 'INDICADOR_AUMENTOU' | 'LIMITE_CRUZADO' | 'HASH_DIFERENTE' | 'ITEM_NOVO_DA_EMPRESA';
export type Comparacao = {
    agravados: { identidade: string; motivos: Agravamento[] }[];
    /** Tipo que só existe a partir de um prefixo posterior ao da base: precisa ser RECONCILIADA ou aceito (§3.5). */
    novosSemComparacao: string[];
    novos: string[];
    resolvidos: string[];
};

export function compararComBase(base: LinhaDeBase, atual: LinhaDeBase): Comparacao {
    const porId = new Map(base.itens.map((i) => [i.identidade, i]));
    const empresasDaBase = new Set(base.itens.map((i) => i.empresa).filter((x): x is string => !!x));
    const ib = indiceDe(base.schema.prefixo);
    const tBase = Date.parse(base.instante), tAtual = Date.parse(atual.instante);
    const r: Comparacao = { agravados: [], novosSemComparacao: [], novos: [], resolvidos: [] };
    for (const item of [...atual.itens].sort((a, b) => a.identidade.localeCompare(b.identidade))) {
        const antes = porId.get(item.identidade);
        porId.delete(item.identidade);
        if (!antes) {
            if (DESDE[item.tipo] !== undefined && indiceDe(DESDE[item.tipo]) > ib) r.novosSemComparacao.push(item.identidade);
            else if (item.empresa && empresasDaBase.has(item.empresa)) r.agravados.push({ identidade: item.identidade, motivos: ['ITEM_NOVO_DA_EMPRESA'] });
            else r.novos.push(item.identidade);
            continue;
        }
        const m = new Set<Agravamento>();
        if (GRAVIDADE_CLASSE[item.classe] > GRAVIDADE_CLASSE[antes.classe]) m.add('CLASSE_PIOR');
        if (estadoPior(antes.estado, item.estado)) m.add('ESTADO_PIOR');
        for (const k of new Set([...Object.keys(item.indicadores), ...Object.keys(antes.indicadores)]))
            if ((item.indicadores[k] ?? 0) > (antes.indicadores[k] ?? 0)) m.add('INDICADOR_AUMENTOU');
        // Limite cruzado entre o instante da base e o da conferência (o limite é o da base: idade não conta).
        for (const limite of Object.values(antes.limites)) { const t = Date.parse(limite); if (t > tBase && t <= tAtual) m.add('LIMITE_CRUZADO'); }
        // Revisão do HB-3 r3 (P2): o hash do item atual chega calculado NA FORMA DA BASE (modoJanela), então a comparação vale
        // entre prefixos: adições estruturais ficam de fora, mudança comercial no que já existia agrava.
        if (item.hashComparavel !== antes.hashComparavel) m.add('HASH_DIFERENTE');
        if (m.size) r.agravados.push({ identidade: item.identidade, motivos: [...m].sort() });
    }
    r.resolvidos = [...porId.keys()].sort();
    return r;
}

const linhasDe = (f: Fotografia | null | undefined, t: string): Linha[] => f?.[t] ?? [];
const REMOTO_PROBLEMA = new Set(['OVERDUE', 'REFUNDED', 'REFUND_REQUESTED', 'REFUND_IN_PROGRESS', 'CHARGEBACK_REQUESTED', 'CHARGEBACK_DISPUTE', 'AWAITING_CHARGEBACK_REVERSAL']);

/** Indicadores e prazos do caso (§3.5), a partir da fotografia do inventário e das leituras gravadas. */
export function indicadoresDoCaso(antes: Fotografia | null | undefined, leituras: readonly Leitura[] = []): { indicadores: Record<string, number>; limites: Record<string, string> } {
    const lidas = cobrancasLidas(leituras);
    const credito = linhasDe(antes, 'ia_credito_cobrancas');
    const assinatura = linhasDe(antes, 'empresa_assinaturas')[0];
    const calculado = assinatura ? periodoCalculado(leituras, (assinatura.ciclo as Ciclo | null) ?? null) : null;
    const local = typeof assinatura?.periodo_atual_fim === 'string' ? Date.parse(assinatura.periodo_atual_fim) : NaN;
    const lotes = new Set(linhasDe(antes, 'ia_credito_lotes').map((l) => String(l.chave_origem)));
    const pagosSemLote = new Set(credito.filter((c) => STATUS_PAGO.has(String(c.situacao_provedor)) && !lotes.has(`COMPRA:${String(c.pedido_id)}`)).map((c) => String(c.pedido_id)));
    const indicadores: Record<string, number> = {
        cobrancas_problematicas: lidas.filter((p) => REMOTO_PROBLEMA.has(p.status) || (p.estornos?.length ?? 0) > 0).length,
        estorno_disputa_devolucao: linhasDe(antes, 'ia_credito_devolucoes').length
            + credito.filter((c) => Number(c.estornado_centavos ?? 0) > 0 || (c.disputa !== undefined && c.disputa !== 'NENHUMA')).length,
        periodo_local_menos_calculado_s: calculado && Number.isFinite(local) ? Math.max(0, Math.floor((local - Date.parse(calculado)) / 1000)) : 0,
        creditos_pagos_sem_lote: pagosSemLote.size,
    };
    const limites: Record<string, string> = {};
    if (Number.isFinite(local)) limites.periodo_atual_fim = new Date(local).toISOString();
    // P2-5 (revisão de 27/10): todos os lotes com saldo (disponível, reservado ou bloqueado), cada um pela identidade estável
    // (recurso + chave de origem); a comparação confere o cruzamento de cada um desde a base original.
    for (const l of linhasDe(antes, 'ia_credito_lotes')) {
        const t = Date.parse(String(l.vence_em));
        if (!Number.isFinite(t) || Number(l.disponivel ?? 0) + Number(l.reservado ?? 0) + Number(l.bloqueado ?? 0) <= 0) continue;
        limites[`lote:${createHash('sha256').update(`${String(l.recurso)}:${String(l.chave_origem)}`).digest('hex').slice(0, 32)}`] = new Date(t).toISOString();
    }
    return { indicadores, limites };
}

/** Remove as colunas de observação toleradas de uma linha da tabela. */
function semObservacao(tabela: string, linha: Linha): Linha {
    const tiradas = COLUNAS_DE_OBSERVACAO[tabela];
    return tiradas ? Object.fromEntries(Object.entries(linha).filter(([c]) => !tiradas.includes(c))) : linha;
}

/**
 * Hash comparável do caso (P2-4): o estrito da proposta continua intacto para a aplicação. Sem proposta (falha) → null.
 * Com `forma` (a da base): só as tabelas e colunas que existiam nela; coluna da forma ausente na linha atual vira `$ausente`.
 */
export function hashComparavel(p: PropostaDoCaso, forma?: Forma): string | null {
    if (!p.proposta || !p.antes) return null;
    const naForma = (t: string, l: Linha): Linha => (forma ? Object.fromEntries((forma[t] ?? []).map((c) => [c, Object.hasOwn(l, c) ? l[c] : '$ausente'])) : l);
    const local = Object.fromEntries(Object.entries(p.antes).filter(([t]) => !forma || Object.hasOwn(forma, t)).map(([t, ls]) => [t, ls.map((l) => semObservacao(t, naForma(t, l)))]));
    const efeitos = p.proposta.efeitos.filter((e) => !forma || Object.hasOwn(forma, e.tabela))
        // Revisão do HB-3 r3 (achado da trajetória S0 → S2): o VALOR das colunas comerciais do instante (doInstante, ex.:
        // cancelada_em = agora) é mascarado — sem isto, todo cancelamento pendente parecia agravado ao ser comparado com a base.
        .map((e) => ({ ...e, colunas: Object.fromEntries(Object.entries(e.colunas).filter(([c]) => !(COLUNAS_DE_OBSERVACAO[e.tabela] ?? []).includes(c) && (!forma || forma[e.tabela].includes(c)))
            .map(([c, v]) => [c, (TABELAS[e.tabela]?.doInstante ?? []).includes(c) && v.depois !== null ? { ...v, depois: '$doInstante' } : v])) }))
        .filter((e) => e.operacao !== 'UPDATE' || Object.keys(e.colunas).length > 0);
    return hashCanonico(JSON.parse(JSON.stringify({ caso: p.proposta.caso, local, remoto: p.proposta.precondicoes.remoto, efeitos },
        (_k, x) => (typeof x === 'number' && !Number.isSafeInteger(x) ? String(x) : x))));
}

/** Item da base de um caso classificado. `estado`: situação da assinatura, do evento ou do pedido na fotografia. */
export function itemDaBase(p: PropostaDoCaso, c: Classificacao): ItemBase {
    const antes = p.antes;
    const estado = p.caso.tipo === 'EMPRESA' ? linhasDe(antes, 'empresa_assinaturas')[0]?.situacao
        : p.caso.tipo === 'EVENTO' ? linhasDe(antes, 'cobranca_eventos').find((l) => l.id === p.caso.id)?.situacao
        : p.caso.tipo === 'COBRANCA' ? linhasDe(antes, 'ia_credito_cobrancas').find((l) => l.id === p.caso.id)?.situacao_provedor
        : linhasDe(antes, 'ia_credito_pedidos').find((l) => l.id === p.caso.id)?.estado;
    const { indicadores, limites } = indicadoresDoCaso(antes, p.proposta?.precondicoes.remoto as Leitura[] | undefined);
    return {
        identidade: p.identidade,
        tipo: p.caso.tipo,
        empresa: identidadeDoCaso('EMPRESA', p.caso.empresaId),
        classe: c.classe,
        estado: typeof estado === 'string' ? estado : null,
        motivo: c.motivo,
        hashProposta: p.hash,
        hashComparavel: hashComparavel(p),
        indicadores,
        limites,
    };
}
