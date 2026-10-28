import { gerado, type Efeito, type Gerado } from './recuperacao-hash.ts';

/**
 * B-14 (plano rev. 8.1, §3.3, §3.4): efeitos de um caso a partir de duas fotografias (antes/depois) das linhas da empresa.
 * Função pura, sem banco: quem fotografa é `recuperacao-fotografia.ts`. Assim a proposta lista TODOS os efeitos — inclusive
 * os de gatilho (versão, atualizado_em) e as linhas criadas — sem reimplementar a lógica dos serviços.
 *   - cada tabela tem chave natural estável entre o inventário (T1) e a aplicação (T2); id gerado vira símbolo (`$lote:…`)
 *     e referências a ele em outras linhas também (ex.: lançamento.lote_id → símbolo do lote);
 *   - colunas geradas na execução (instantes, ids, contadores) viram marcador `$gerado`;
 *   - colunas comerciais que o domínio deriva do instante atual ficam com o valor real: a aplicação regrava o aprovado.
 */
export type Linha = Record<string, unknown>;
export type Fotografia = Record<string, Linha[]>;

type ConfigTabela = {
    /** Chave natural; `lotes` traduz lote_id em chave natural do lote (lançamentos). */
    natural: (l: Linha, lotes: Map<string, string>) => string;
    /** Colunas geradas na execução: o valor novo vira marcador. */
    geradas: Record<string, Gerado['$gerado']>;
    /** Colunas comerciais derivadas do instante atual: ficam fixas na proposta e são regravadas na aplicação. */
    doInstante?: readonly string[];
};

const texto = (v: unknown) => (v === null || v === undefined ? '' : String(v));
export const TABELAS: Record<string, ConfigTabela> = {
    empresa_assinaturas: { natural: (l) => texto(l.empresa_id), geradas: { sincronizado_em: 'instante', atualizado_em: 'instante', versao: 'contador' },
        doInstante: ['em_atraso_desde', 'cancelada_em', 'encerrada_em'] },
    assinatura_contratacoes: { natural: (l) => texto(l.id), geradas: { confirmada_em: 'instante', atualizado_em: 'instante' } },
    assinatura_fundadores: { natural: (l) => texto(l.id), geradas: { confirmada_em: 'instante', atualizado_em: 'instante' } },
    assinatura_encerramentos: { natural: (l) => texto(l.id), geradas: { atualizado_em: 'instante' } },
    // 097: só lida pela sincronização (cobranças restituídas); entra para a recusa 089/097 (§4) e para mostrar qualquer escrita.
    assinatura_arrependimentos: { natural: (l) => texto(l.id), geradas: {} },
    cobranca_eventos: { natural: (l) => `${texto(l.provedor)}:${texto(l.evento_id)}`, geradas: { id: 'id', recebido_em: 'instante', processado_em: 'instante' } },
    auditoria: { natural: (l) => `${texto(l.acao)}:${texto(l.entidade_id)}`, geradas: { id: 'id', criado_em: 'instante', request_id: 'id' } },
    ia_credito_pedidos: { natural: (l) => texto(l.id), geradas: { creditado_em: 'instante', atualizado_em: 'instante', reconciliado_em: 'instante' } },
    ia_credito_cobrancas: { natural: (l) => `${texto(l.provedor)}:${texto(l.ambiente)}:${texto(l.conta)}:${texto(l.pagamento_id)}`,
        geradas: { id: 'id', registrada_em: 'instante', atualizada_em: 'instante', conferida_em: 'instante', confirmada_em: 'instante', perda_definitiva_em: 'instante' } },
    ia_credito_carteiras: { natural: (l) => `${texto(l.empresa_id)}:${texto(l.recurso)}`, geradas: { criada_em: 'instante', atualizada_em: 'instante' } },
    ia_credito_lotes: { natural: (l) => `${texto(l.recurso)}:${texto(l.chave_origem)}`, geradas: { id: 'id', criado_em: 'instante', liberado_em: 'instante', atualizado_em: 'instante' } },
    ia_credito_lancamentos: { natural: (l, lotes) => `${texto(l.recurso)}:${texto(l.operacao)}:${texto(l.tipo)}:${lotes.get(texto(l.lote_id)) ?? texto(l.lote_id)}`,
        geradas: { id: 'id', criado_em: 'instante' } },
    ia_credito_devolucoes: { natural: (l) => texto(l.id), geradas: { atualizado_em: 'instante', concluida_em: 'instante' } },
    ia_credito_notificacoes: { natural: (l) => texto(l.dedupe), geradas: { id: 'id', criada_em: 'instante', proxima_em: 'instante', enviada_em: 'instante' } },
};

/** Valor do to_jsonb em forma canônica: inteiro seguro fica número; numeric fracionário vira texto; objeto/lista por JSON. */
function valor(v: unknown): unknown {
    if (typeof v === 'number') return Number.isSafeInteger(v) ? v : String(v);
    if (v !== null && typeof v === 'object') return JSON.stringify(v);
    return v ?? null;
}

/** Mapa id → chave natural do lote, nas duas fotografias (lançamentos referenciam o lote pelo id). */
function lotesPorId(...fotos: Fotografia[]) {
    const m = new Map<string, string>();
    for (const f of fotos) for (const l of f.ia_credito_lotes ?? []) m.set(texto(l.id), TABELAS.ia_credito_lotes.natural(l, m));
    return m;
}

/** Ids que só existem na fotografia "depois" (gerados na execução) → símbolo `$tabela:chave natural`. */
function simbolos(antes: Fotografia, depois: Fotografia, lotes: Map<string, string>) {
    const existentes = new Set<string>();
    for (const linhas of Object.values(antes)) for (const l of linhas) if (l.id !== undefined) existentes.add(texto(l.id));
    const s = new Map<string, string>();
    for (const [tabela, linhas] of Object.entries(depois)) {
        const cfg = TABELAS[tabela];
        if (!cfg) continue;
        for (const l of linhas) if (l.id !== undefined && !existentes.has(texto(l.id))) s.set(texto(l.id), `$${tabela}:${cfg.natural(l, lotes)}`);
    }
    return s;
}

/** Diferença por linha: INSERT (linha nova), UPDATE (colunas que mudaram) e DELETE. Ordem estável por tabela e chave. */
export function diferenca(antes: Fotografia, depois: Fotografia): Efeito[] {
    const lotes = lotesPorId(antes, depois);
    const sim = simbolos(antes, depois, lotes);
    const trocar = (v: unknown) => (typeof v === 'string' && sim.has(v) ? sim.get(v)! : valor(v));
    const efeitos: Efeito[] = [];
    for (const tabela of Object.keys(TABELAS).sort()) {
        const cfg = TABELAS[tabela];
        const indexar = (linhas: Linha[] | undefined) => {
            const m = new Map<string, Linha[]>();
            for (const l of linhas ?? []) { const k = cfg.natural(l, lotes); m.set(k, [...(m.get(k) ?? []), l]); }
            return m;
        };
        const a = indexar(antes[tabela]), d = indexar(depois[tabela]);
        // Conteúdo sem colunas geradas: ordena, de forma estável entre T1 e T2, linhas com a mesma chave natural.
        const conteudo = (l: Linha) => JSON.stringify(Object.keys(l).filter((c) => !cfg.geradas[c]).sort().map((c) => [c, trocar(l[c])]));
        for (const chave of [...new Set([...a.keys(), ...d.keys()])].sort()) {
            const la = a.get(chave) ?? [], ld = d.get(chave) ?? [];
            // Chave natural repetida (ex.: duas auditorias da mesma ação): linhas que já existiam pareiam pela IDENTIDADE (`id`),
            // nunca pela posição — a ordem da fotografia depende do id aleatório e mudaria o pareamento entre T1 e T2. As linhas
            // novas (só no "depois") e as removidas são ordenadas pelo conteúdo sem colunas geradas e numeradas.
            const temId = [...la, ...ld].every((l) => l.id !== undefined);
            const pares: [Linha | undefined, Linha | undefined][] = [];
            if (temId && (la.length > 1 || ld.length > 1)) {
                const porId = new Map(ld.map((l) => [texto(l.id), l]));
                for (const x of [...la].sort((p, q) => texto(p.id).localeCompare(texto(q.id)))) { pares.push([x, porId.get(texto(x.id))]); porId.delete(texto(x.id)); }
                for (const y of [...porId.values()].sort((p, q) => conteudo(p).localeCompare(conteudo(q)))) pares.push([undefined, y]);
            }
            else for (let i = 0; i < Math.max(la.length, ld.length); i++) pares.push([la[i], ld[i]]);
            for (let i = 0; i < pares.length; i++) {
                const [x, y] = pares[i];
                const k = i === 0 ? chave : `${chave}#${i + 1}`;
                const colunas: Efeito['colunas'] = {};
                const nomes = [...new Set([...Object.keys(x ?? {}), ...Object.keys(y ?? {})])].sort();
                for (const c of nomes) {
                    const va = x ? trocar(x[c]) : null;
                    const vd = y ? trocar(y[c]) : null;
                    if (x && y && JSON.stringify(va) === JSON.stringify(vd)) continue;
                    // Coluna gerada que mudou ou nasceu: o valor novo é do relógio/sequência, só o tipo entra no contrato.
                    colunas[c] = { antes: va, depois: y && cfg.geradas[c] ? gerado(cfg.geradas[c]) : vd };
                }
                if (!x) efeitos.push({ tabela, chave: k, operacao: 'INSERT', colunas });
                else if (!y) efeitos.push({ tabela, chave: k, operacao: 'DELETE', colunas: {} });
                else if (Object.keys(colunas).length) efeitos.push({ tabela, chave: k, operacao: 'UPDATE', colunas });
            }
        }
    }
    return efeitos;
}

/** Prova de que a linha veio da aplicação: instante gerado a partir do início dela e, na auditoria, o request_id da execução. */
export type ProvaDaAplicacao = { desdeMs: number; requestId: string };
const simbolo = (v: unknown): v is string => typeof v === 'string' && v.startsWith('$');

/**
 * `conferir-caso` (§3.4, COMMIT sem resposta): os efeitos aprovados estão na fotografia atual E vieram da aplicação?
 * Revisão do Astra do incremento 4 (P2-3): conteúdo igual não basta — uma auditoria histórica da mesma ação e do mesmo caso
 * satisfaria um INSERT que nunca ocorreu. Por isso:
 *   - INSERT: toda coluna gerada de instante preenchida é posterior ao início da aplicação (há ao menos uma); na auditoria,
 *     `request_id` = a execução da aplicação;
 *   - UPDATE: as colunas geradas de instante que o efeito muda são posteriores ao início;
 *   - referências simbólicas (`$tabela:chave`) são resolvidas para o id concreto da linha inserida e conferidas;
 *   - chave repetida (`#n`) pareia com uma linha ainda não usada do grupo que cumpre tudo isso;
 *   - DELETE não é localizável: não presente. Sem prova suficiente → falso (DIVERGENTE para a pessoa).
 */
export function efeitosPresentes(foto: Fotografia, efeitos: readonly Efeito[], prova: ProvaDaAplicacao): boolean {
    const lotes = lotesPorId(foto);
    const usadas = new Set<Linha>();
    const posterior = (v: unknown) => { const t = typeof v === 'string' ? Date.parse(v) : NaN; return Number.isFinite(t) && t >= prova.desdeMs; };
    const pares: { e: Efeito; l: Linha }[] = [];
    const ids = new Map<string, string>();
    for (const e of efeitos) {
        const cfg = TABELAS[e.tabela];
        if (!cfg || e.operacao === 'DELETE') return false;
        const base = e.chave.replace(/#\d+$/, '');
        const instantes = Object.keys(e.colunas).filter((c) => cfg.geradas[c] === 'instante');
        const confere = (l: Linha) => {
            for (const [c, { depois }] of Object.entries(e.colunas)) {
                if (cfg.geradas[c] !== undefined || simbolo(depois)) continue;
                if (JSON.stringify(valor(l[c])) !== JSON.stringify(depois)) return false;
            }
            const preenchidos = instantes.filter((c) => l[c] !== null && l[c] !== undefined);
            if (e.operacao === 'INSERT' && preenchidos.length === 0) return false;
            if (!preenchidos.every((c) => posterior(l[c]))) return false;
            return e.tabela !== 'auditoria' || e.operacao !== 'INSERT' || l.request_id === prova.requestId;
        };
        const achada = (foto[e.tabela] ?? []).find((l) => !usadas.has(l) && cfg.natural(l, lotes) === base && confere(l));
        if (!achada) return false;
        usadas.add(achada);
        pares.push({ e, l: achada });
        if (e.operacao === 'INSERT' && achada.id !== undefined) ids.set(`$${e.tabela}:${base}`, texto(achada.id));
    }
    // Referências simbólicas: o vínculo concreto tem de ser a linha inserida por esta aplicação.
    for (const { e, l } of pares)
        for (const [c, { depois }] of Object.entries(e.colunas))
            if (simbolo(depois) && TABELAS[e.tabela].geradas[c] === undefined && (!ids.has(depois) || texto(l[c]) !== ids.get(depois))) return false;
    return true;
}

/**
 * Domínio exato do SEM_EFEITO (§3.3): só UPDATEs de observação. Qualquer INSERT, DELETE ou coluna fora destes conjuntos é
 * efeito. As derivadas de gatilho só são toleradas quando a linha mudou apenas colunas de observação.
 */
const OBSERVACAO: Record<string, { observacao: readonly string[]; derivadas: readonly string[] }> = {
    empresa_assinaturas: { observacao: ['sincronizado_em', 'provedor_situacao'], derivadas: ['versao', 'atualizado_em'] },
    ia_credito_cobrancas: { observacao: ['conferida_em'], derivadas: ['atualizada_em'] },
    ia_credito_pedidos: { observacao: ['reconciliado_em'], derivadas: [] },
};
/** Colunas de observação e suas derivadas por tabela (domínio do SEM_EFEITO): a linha de base as normaliza (§3.5). */
export const COLUNAS_DE_OBSERVACAO: Readonly<Record<string, readonly string[]>> = Object.freeze(
    Object.fromEntries(Object.entries(OBSERVACAO).map(([t, r]) => [t, [...r.observacao, ...r.derivadas]])));
export function efeitoTolerado(e: Efeito) {
    const regra = OBSERVACAO[e.tabela];
    if (!regra || e.operacao !== 'UPDATE') return false;
    const cols = Object.keys(e.colunas);
    const permitidas = new Set([...regra.observacao, ...regra.derivadas]);
    return cols.length > 0 && cols.every((c) => permitidas.has(c)) && cols.some((c) => regra.observacao.includes(c));
}
export function semEfeito(efeitos: readonly Efeito[]) {
    return efeitos.every(efeitoTolerado);
}

/** Valores comerciais do instante na proposta aprovada, para a aplicação regravá-los (nunca recalculados de agora). */
export function valoresDoInstante(efeitos: readonly Efeito[]): { tabela: string; chave: string; coluna: string; valor: unknown }[] {
    const r: { tabela: string; chave: string; coluna: string; valor: unknown }[] = [];
    for (const e of efeitos) {
        const doInstante = TABELAS[e.tabela]?.doInstante ?? [];
        for (const c of doInstante) if (e.colunas[c] && e.colunas[c].depois !== null) r.push({ tabela: e.tabela, chave: e.chave, coluna: c, valor: e.colunas[c].depois });
    }
    return r;
}
