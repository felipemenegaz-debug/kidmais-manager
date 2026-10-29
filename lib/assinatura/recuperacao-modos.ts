import type { DbExecutor } from '../db/contracts';
import { pedidoDoEvento } from '../creditos/pagamento.ts';
import { hashCanonico, hashProposta, type Proposta } from './recuperacao-hash.ts';
import { aplicarCasoReal, identidadeDoCaso, proporCasoReal, type Caso, type ContextoRecuperacao, type ModoRecuperacao, type PropostaDoCaso } from './recuperacao-casos.ts';
import { LimpezaDoCasoFalhou, type Leitura } from './recuperacao-caso.ts';
import { classificar, type Classificacao } from './recuperacao-classes.ts';
import { compararComBase, FORMATO_BASE, hashComparavel, itemDaBase, prefixoDoSchema, selarBase, validarBase, type Forma, type ItemBase, type LinhaDeBase } from './recuperacao-baseline.ts';
import { evidenciaDoCaso, type EvidenciaDoCaso } from './recuperacao-evidencia.ts';
import { fotografar, tabelasPresentes } from './recuperacao-fotografia.ts';
import { efeitosPresentes, TABELAS } from './recuperacao-efeitos.ts';
import { empresasComProvedor } from './sincronizacao.ts';
import type { CobrancaProvedor, FiltroCobrancas, ListaComprovada, WebhookProvedor } from './asaas.ts';
import { assinaturaDaProposta, avaliarLiberacao, codigoFinal, conferirFila, conferirVinculoDasDecisoes, falhaDeCobertura, falhaDoCaso, lerCobrancasRemotas, lerDecisoes, orfasRemotas,
    proporDuasVezes, RETENCAO_MAXIMA_MS, validarProvaCronAntigo,
    type ChavesRemotas, type Codigo, type CodigoNoAr, type ConferenciaFila, type Consistencia, type Liberacao, type Orfa,
} from './recuperacao-execucao.ts';

/**
 * B-14 (plano rev. 8.1, §3.2, §3.6, §4, §5): os modos da recuperação de pagamentos sobre uma conexão já conferida (alvo,
 * TLS, trava global) pela entrada `scripts/recuperacao-pagamentos-producao.cjs`. Cada modo devolve um resultado só com ids
 * opacos e o código da tabela única (§3.10, composto só por `codigoFinal`); arquivos restritos saem por `Arquivos` (600,
 * nunca sobrescritos).
 *
 * Transações:
 *   - enumeração das chaves locais: `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` (um snapshot para todas as consultas);
 *   - JANELA: uma transação por caso (o web está aberto) — `--conferir` sempre ROLLBACK; `--recuperar` COMMIT só do caso
 *     aplicado com hash idêntico, depois de `parar()`;
 *   - RESTORE (`inventario`, `conferir-caso`, `liberacao`): UMA transação REPEATABLE READ para tudo, sempre ROLLBACK. Não é
 *     READ ONLY porque a proposta É o processamento normal num SAVEPOINT desfeito (§3.4): o READ ONLY recusaria a primeira
 *     escrita. Nada de DML fica gravado (digest das tabelas); sequências consumidas não voltam (os ids novos são símbolos);
 *   - `aplicar-caso`: uma transação; antes de tentar o COMMIT invalida as liberações e grava o registro da aplicação.
 */
export type Controle = {
    /** Motivo para parar: TRAVA_PERDIDA, SIGTERM (código 1) ou LIMITE_EXECUCAO (3). */
    parar: () => Promise<string | null>;
};
export const PARADAS_DE_COBERTURA = new Set(['LIMITE_EXECUCAO']);
const codigoDaParada = (p: string) => (PARADAS_DE_COBERTURA.has(p) ? 3 : 1) as Codigo;

export type Arquivos = {
    ler(nome: string): unknown | null;
    /** Grava um arquivo NOVO (600); já existir é erro: a base e as evidências nunca são recriadas. */
    gravarNovo(nome: string, conteudo: unknown): void;
    /** Marca um arquivo como invalidado (a liberação depois de um aplicar-caso). */
    invalidar(nome: string): void;
    listar(prefixo: string): string[];
};

export type Execucao = {
    client: DbExecutor;
    /** Cliente Asaas (real ou dublê); os serviços só recebem a lista fechada de leituras. */
    cliente: object & { listarWebhooks?: () => Promise<ListaComprovada<WebhookProvedor>>; listarCobrancas?: (f: FiltroCobrancas) => Promise<ListaComprovada<CobrancaProvedor>>;
        obterCobranca?: (id: string) => Promise<CobrancaProvedor | null> };
    execucao: string;
    ambiente: 'sandbox' | 'producao';
    /** Conta de créditos válida (095); sem ela os pedidos falham e a cobertura fica incompleta. */
    creditos: { ambiente: 'sandbox' | 'producao'; conta: string } | null;
    controle: Controle;
    arquivos: Arquivos;
    /** Migrations declaradas pelo CONFERIR do B-5 (já cruzadas com os marcadores pela entrada). */
    migracoes: readonly string[];
    codigoNoAr: CodigoNoAr;
};

export class ParadaExecucao extends Error {
    readonly motivo: string;
    constructor(motivo: string) { super(`Execução interrompida: ${motivo}`); this.name = 'ParadaExecucao'; this.motivo = motivo; }
}

// --- Enumeração (§3.6 a) ---------------------------------------------------------------------------------------------
export const LIMITE_EVENTOS_B14 = 500;
export type Chaves = {
    casos: Caso[];
    /** Evento → identidade do objeto ligado (pedido ou assinatura da empresa), para `relacionadoReconciliado`. */
    relacionado: Map<string, string>;
    /** Eventos sem empresa resolvível: sem fotografia possível, vão para pessoa (identidade opaca). */
    semEmpresa: string[];
    limites: string[];
    locais: ChavesRemotas;
    cobrancasLocais: number;
};

type LinhaEvento = { id: string; empresa_id: string | null; cobranca_provedor_id: string | null; referencia_externa: string | null; empresa_da_assinatura: string | null };
const SQL_EVENTO = `SELECT e.id, e.empresa_id, e.cobranca_provedor_id, e.referencia_externa,
    (SELECT a.empresa_id FROM empresa_assinaturas a WHERE a.provedor = 'ASAAS' AND a.provedor_assinatura_id = e.assinatura_provedor_id ORDER BY a.empresa_id LIMIT 1) AS empresa_da_assinatura
  FROM cobranca_eventos e WHERE e.provedor = 'ASAAS'`;

/** Empresa e objeto ligado de um evento: o pedido de créditos (quando é de créditos) ou a assinatura da empresa. */
async function resolverEvento(tx: DbExecutor, e: LinhaEvento, creditos: boolean) {
    const alvo = creditos ? await pedidoDoEvento(tx, { cobrancaProvedorId: e.cobranca_provedor_id, referenciaExterna: e.referencia_externa }) : null;
    const empresa = alvo
        ? (await tx.query<{ e: string }>('SELECT empresa_id AS e FROM ia_credito_pedidos WHERE id = $1::uuid', [alvo.pedidoId])).rows[0]?.e ?? null
        : e.empresa_id ?? e.empresa_da_assinatura;
    return { empresa, relacionado: alvo ? identidadeDoCaso('PEDIDO', alvo.pedidoId) : empresa ? identidadeDoCaso('EMPRESA', empresa) : null };
}

const temCreditos = (presentes: readonly string[]) => presentes.includes('ia_credito_pedidos') && presentes.includes('ia_credito_cobrancas');

/**
 * Chaves locais lidas num único snapshot (quem chama abriu a transação): empresas com provedor, todos os pedidos, TODA
 * cobrança não canônica como caso próprio (revisão do Astra do incremento 4, P2-1: a canônica é lida pelo pedido; a extra
 * paga não pode depender de evento) e os eventos da janela e pendentes.
 */
export async function enumerarChaves(tx: DbExecutor, j: { desde: string; ate: string; presentes: readonly string[] }): Promise<Chaves> {
    const creditos = temCreditos(j.presentes);
    const casos: Caso[] = [];
    for (const empresaId of await empresasComProvedor(tx)) casos.push({ tipo: 'EMPRESA', id: empresaId, empresaId });
    const pedidos = creditos ? (await tx.query<{ id: string; empresa_id: string }>('SELECT id, empresa_id FROM ia_credito_pedidos ORDER BY id')).rows : [];
    for (const p of pedidos) casos.push({ tipo: 'PEDIDO', id: p.id, empresaId: p.empresa_id });
    const extras = creditos ? (await tx.query<{ id: string; empresa_id: string }>('SELECT id, empresa_id FROM ia_credito_cobrancas WHERE NOT canonica ORDER BY id')).rows : [];
    for (const c of extras) casos.push({ tipo: 'COBRANCA', id: c.id, empresaId: c.empresa_id });
    const eventos = (await tx.query<LinhaEvento>(`${SQL_EVENTO} AND ((e.recebido_em >= $1::timestamptz AND e.recebido_em <= $2::timestamptz) OR e.situacao IN ('PENDENTE', 'FALHOU'))
         ORDER BY e.recebido_em, e.id LIMIT $3`, [j.desde, j.ate, LIMITE_EVENTOS_B14 + 1])).rows;
    const limites = eventos.length > LIMITE_EVENTOS_B14 ? [`EVENTOS_${LIMITE_EVENTOS_B14}`] : [];
    const relacionado = new Map<string, string>();
    const semEmpresa: string[] = [];
    for (const e of eventos.slice(0, LIMITE_EVENTOS_B14)) {
        const r = await resolverEvento(tx, e, creditos);
        if (!r.empresa) { semEmpresa.push(identidadeDoCaso('EVENTO', e.id)); continue; }
        casos.push({ tipo: 'EVENTO', id: e.id, empresaId: r.empresa });
        relacionado.set(e.id, r.relacionado!);
    }
    const pagamentos = creditos ? (await tx.query<{ p: string }>('SELECT pagamento_id AS p FROM ia_credito_cobrancas')).rows.map((r) => r.p) : [];
    const assinaturas = (await tx.query<{ s: string }>("SELECT provedor_assinatura_id AS s FROM empresa_assinaturas WHERE provedor = 'ASAAS' AND provedor_assinatura_id IS NOT NULL")).rows.map((r) => r.s);
    return { casos, relacionado, semEmpresa: semEmpresa.sort(), limites,
        locais: { pagamentos: new Set(pagamentos), pedidos: new Set(pedidos.map((p) => p.id)), assinaturas: new Set(assinaturas) }, cobrancasLocais: pagamentos.length };
}

/**
 * Localiza o caso pela identidade opaca direto no banco (sha-256 no SQL), sem janela nem limite de 500 (P2-2). A aplicação
 * só aceita evento ainda PENDENTE/FALHOU (D-I4-8); a conferência acha também o evento já concluído pela própria aplicação.
 */
const SHA = (tipo: string, coluna: string) => `encode(sha256(convert_to('${tipo}:' || ${coluna}::text, 'UTF8')), 'hex') = $1`;
async function localizarCaso(x: Execucao, identidade: string, presentes: readonly string[], j: { soPendentes: boolean }): Promise<Caso> {
    const e1 = (await x.client.query<{ id: string }>(`SELECT empresa_id AS id FROM empresa_assinaturas WHERE provedor = 'ASAAS' AND provedor_assinatura_id IS NOT NULL
        AND ${SHA('EMPRESA', 'empresa_id')}`, [identidade])).rows[0];
    if (e1) return { tipo: 'EMPRESA', id: e1.id, empresaId: e1.id };
    if (temCreditos(presentes)) {
        const p = (await x.client.query<{ id: string; empresa_id: string }>(`SELECT id, empresa_id FROM ia_credito_pedidos WHERE ${SHA('PEDIDO', 'id')}`, [identidade])).rows[0];
        if (p) return { tipo: 'PEDIDO', id: p.id, empresaId: p.empresa_id };
        const c = (await x.client.query<{ id: string; empresa_id: string }>(`SELECT id, empresa_id FROM ia_credito_cobrancas WHERE NOT canonica AND ${SHA('COBRANCA', 'id')}`, [identidade])).rows[0];
        if (c) return { tipo: 'COBRANCA', id: c.id, empresaId: c.empresa_id };
    }
    const ev = (await x.client.query<LinhaEvento & { situacao: string }>(`${SQL_EVENTO.replace('SELECT e.id,', 'SELECT e.id, e.situacao,')} AND ${SHA('EVENTO', 'e.id')}`, [identidade])).rows[0];
    if (ev && (!j.soPendentes || ['PENDENTE', 'FALHOU'].includes(ev.situacao))) {
        const r = await resolverEvento(x.client, ev, temCreditos(presentes));
        if (r.empresa) return { tipo: 'EVENTO', id: ev.id, empresaId: r.empresa };
    }
    throw new ParadaExecucao('CASO_NAO_LOCALIZADO');
}

async function snapshotDasChaves(client: DbExecutor, j: { desde: string; ate: string }) {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
        const presentes = await tabelasPresentes(client);
        return { presentes, chaves: await enumerarChaves(client, { ...j, presentes }) };
    }
    finally { await client.query('ROLLBACK'); }
}

// --- Caso classificado ------------------------------------------------------------------------------------------------
export type ItemDoInventario = { p: PropostaDoCaso; c: Classificacao; consistencia: Consistencia; item: ItemBase; evidencia: EvidenciaDoCaso };

const entradaDaClasse = (p: PropostaDoCaso, modo: ModoRecuperacao, relacionadoReconciliado?: boolean) => ({ modo, tipo: p.caso.tipo, id: p.caso.id,
    empresaId: p.caso.empresaId, falha: p.falha, resultado: p.resultado, antes: p.antes, efeitos: p.proposta?.efeitos ?? [],
    leituras: (p.proposta?.precondicoes.remoto ?? []) as Leitura[], ...(relacionadoReconciliado === undefined ? {} : { relacionadoReconciliado }) });

function contextoDoCaso(x: Execucao, modo: ModoRecuperacao, presentes: readonly string[]): ContextoRecuperacao {
    return { tx: x.client, execucao: x.execucao, modo, cliente: x.cliente, presentes, ...(x.creditos ? { creditos: { ...x.creditos } } : {}) };
}

async function proporEClassificar(x: Execucao, modo: ModoRecuperacao, presentes: readonly string[], caso: Caso, relacionado: boolean | undefined): Promise<ItemDoInventario> {
    const { p, consistencia } = await proporDuasVezes(() => proporCasoReal(contextoDoCaso(x, modo, presentes), caso));
    const c = classificar(entradaDaClasse(p, modo, relacionado), x.creditos ?? undefined);
    const item = itemDaBase(p, c);
    return { p, c, consistencia, item, evidencia: evidenciaDoCaso(p, c, item) };
}

/** Item que não pode ser comprovado nesta leitura (cobertura): falha de provedor/lista, inclusive a absorvida pelo serviço. */
const incompleto = (i: ItemDoInventario) => i.consistencia === 'INCONCLUSIVO' || falhaDeCobertura(falhaDoCaso(i.p));

// --- Schema (§3.5) ----------------------------------------------------------------------------------------------------
/** Forma do schema (colunas de cada tabela da lista fechada presente), pelo catálogo: guardada na base (formato 2). */
async function formaDoSchema(client: DbExecutor): Promise<Forma> {
    const r = await client.query<{ t: string; c: string[] }>(`SELECT table_name AS t, array_agg(column_name::text ORDER BY column_name::text) AS c FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ANY($1::text[]) GROUP BY table_name ORDER BY table_name`, [Object.keys(TABELAS)]);
    return Object.fromEntries(r.rows.map((l) => [l.t, l.c]));
}
export function schemaAtual(migracoes: readonly string[], ambiente: 'sandbox' | 'producao') {
    const p = prefixoDoSchema(migracoes, ambiente);
    if (!p) throw new ParadaExecucao('SCHEMA_FORA_DA_LISTA');
    return p;
}

// --- Resultado público -------------------------------------------------------------------------------------------------
export type ItemPublico = { identidade: string; tipo: string; classe: string; recusas: string[]; motivo: string | null; hash: string | null; consistencia?: Consistencia };
const publico = (i: ItemDoInventario): ItemPublico => ({ identidade: i.p.identidade, tipo: i.p.caso.tipo, classe: i.c.classe, recusas: [...i.c.recusas],
    motivo: i.c.motivo, hash: i.p.hash, consistencia: i.consistencia });
export type Resultado = { modo: string; codigo: Codigo; execucao: string; [k: string]: unknown };

const contagem = (itens: readonly { classe: string }[]) => itens.reduce<Record<string, number>>((m, i) => ({ ...m, [i.classe]: (m[i.classe] ?? 0) + 1 }), {});
const interrompida = (modo: string, x: Execucao, parada: string): Resultado => ({ modo, codigo: codigoDaParada(parada), execucao: x.execucao, resultado: 'INTERROMPIDA', parada });

// --- JANELA (§3.2, §3.5, §3.6) -------------------------------------------------------------------------------------------
/**
 * `--janela --conferir` (DML revertido por caso) e `--janela --recuperar` (COMMIT do caso aplicado). Código 0 só com
 * enumeração e consistência completas e todo item RECONCILIADA ou preexistente igual à base. Aplicação que sai DIVERGENTE
 * na reexecução é desfeita e é recusa técnica (1; P2-7). A base é selada uma única vez (`selar`); nunca é recriada.
 */
export async function modoJanela(x: Execucao, j: { desde: string; ate: string; recuperar: boolean; base?: { nome: string; sha: string } | null; selar?: string | null }): Promise<Resultado> {
    const modo = j.recuperar ? 'JANELA_RECUPERAR' : 'JANELA_CONFERIR';
    const schema = schemaAtual(x.migracoes, x.ambiente);
    let parada = await x.controle.parar();
    if (parada) return interrompida(modo, x, parada);
    const { presentes, chaves } = await snapshotDasChaves(x.client, j);
    const itens: ItemDoInventario[] = [];
    const aplicados: string[] = [];
    const divergentes: string[] = [];
    const classes = new Map<string, string>();
    for (const caso of chaves.casos) {
        parada = await x.controle.parar();
        if (parada) break;
        const rel = caso.tipo === 'EVENTO' ? classes.get(chaves.relacionado.get(caso.id) ?? '') === 'RECONCILIADA' : undefined;
        await x.client.query('BEGIN');
        let i: ItemDoInventario;
        try {
            i = await proporEClassificar(x, 'JANELA', presentes, caso, rel);
            let manter = false;
            if (j.recuperar && i.c.classe === 'PROPOSTA' && i.c.recusas.length === 0 && i.consistencia !== 'INCONCLUSIVO' && i.p.proposta) {
                const r = await aplicarCasoReal(contextoDoCaso(x, 'JANELA', presentes), caso, { hash: i.p.hash!, proposta: i.p.proposta });
                manter = r.situacao === 'APLICADO';
                if (!manter) divergentes.push(i.p.identidade);
            }
            parada = await x.controle.parar();
            if (!manter || parada) await x.client.query('ROLLBACK');
            else {
                try { await x.client.query('COMMIT'); }
                catch { throw new ParadaExecucao('COMMIT_INDETERMINADO'); }
                aplicados.push(i.p.identidade);
            }
        }
        catch (error) {
            if (!(error instanceof ParadaExecucao)) await x.client.query('ROLLBACK').catch(() => undefined);
            if (error instanceof LimpezaDoCasoFalhou) throw new ParadaExecucao('LIMPEZA_DO_CASO_FALHOU');
            throw error;
        }
        classes.set(i.p.identidade, i.c.classe);
        itens.push(i);
        if (parada) break;
    }
    parada = parada ?? await x.controle.parar();
    // Revisão do HB-3 r3 (P2): a base guarda a forma do schema; o hash comparável de cada item é calculado na forma da
    // base (selagem: a forma atual; comparação: a forma da base selada).
    const forma = await formaDoSchema(x.client);
    const naForma = (f: Forma): ItemBase[] => itens.map((i) => ({ ...i.item, hashComparavel: hashComparavel(i.p, f) }));
    const atual: LinhaDeBase = { formato: FORMATO_BASE, schema: { prefixo: schema.nome, impressao: schema.impressao }, forma, instante: new Date().toISOString(), itens: naForma(forma) };
    let comparacao: ReturnType<typeof compararComBase> | null = null;
    let baseInvalida: string | null = null;
    let selada: string | null = null;
    if (j.base) {
        const v = validarBase(x.arquivos.ler(j.base.nome) as LinhaDeBase | null, j.base.sha, x.migracoes, x.ambiente);
        if (v.valida) comparacao = compararComBase(v.base, { ...atual, itens: naForma(v.base.forma) });
        else baseInvalida = v.detalhe;
    }
    const coberturaIncompleta = chaves.limites.length > 0 || itens.some(incompleto) || (parada !== null && PARADAS_DE_COBERTURA.has(parada));
    if (j.selar && !j.recuperar) {
        // A base só é selada a partir de uma conferência completa (sem limite, parada nem item inconclusivo).
        if (coberturaIncompleta || parada) baseInvalida = 'BASE_DE_CONFERENCIA_INCOMPLETA';
        else if (x.arquivos.ler(j.selar) !== null) baseInvalida = 'BASE_JA_EXISTE';
        else { const s = selarBase(atual); x.arquivos.gravarNovo(j.selar, s.base); selada = s.sha; }
    }
    const agravados = new Set(comparacao?.agravados.map((a) => a.identidade) ?? []);
    const naBase = (id: string) => comparacao !== null && !comparacao.novos.includes(id) && !comparacao.novosSemComparacao.includes(id) && !agravados.has(id);
    const pendentes = itens.filter((i) => i.c.classe !== 'RECONCILIADA' && !aplicados.includes(i.p.identidade) && !naBase(i.p.identidade));
    const pendencias = pendentes.length + chaves.semEmpresa.length + aplicados.length + (baseInvalida ? 1 : 0);
    const recusaTecnica = divergentes.length > 0 || (parada !== null && !PARADAS_DE_COBERTURA.has(parada));
    const codigo = codigoFinal({ modo: 'JANELA', recusaTecnica, coberturaIncompleta, pendencias });
    return {
        modo, codigo, execucao: x.execucao, schema: schema.nome, parada,
        resultado: codigo === 0 ? 'CONCLUIDA' : codigo === 1 ? (divergentes.length ? 'HASH_DIVERGENTE' : 'INTERROMPIDA') : codigo === 3 ? 'COBERTURA_INCOMPLETA' : 'COM_PENDENCIAS',
        cobertura: { limites: chaves.limites, inconclusivos: itens.filter(incompleto).map((i) => i.p.identidade), casos: chaves.casos.length, cobrancasLocais: chaves.cobrancasLocais },
        classes: contagem(itens.map((i) => i.c)), aplicados, divergentes, eventosSemEmpresa: chaves.semEmpresa,
        base: j.base ? (baseInvalida ? { valida: false, motivo: 'BASELINE_INVALIDA', detalhe: baseInvalida } : { valida: true, agravados: comparacao!.agravados, novos: comparacao!.novos,
            novosSemComparacao: comparacao!.novosSemComparacao, resolvidos: comparacao!.resolvidos.length }) : null,
        baseSelada: selada, baseRecusada: !j.base && baseInvalida ? baseInvalida : null,
        pendentes: pendentes.map(publico),
    };
}

// --- RESTORE ------------------------------------------------------------------------------------------------------------
export const NOME_APLICACAO_B14 = 'kidmais-recuperacao-b14';
/** Sessões identificadas que podem ser anteriores ao reinício (§5.3 b): a ferramenta e os crons suspensos. */
export const SESSOES_ADMITIDAS = Object.freeze([NOME_APLICACAO_B14, 'kidmais-assinatura-reconciliar', 'kidmais-assinatura-reconciliar-marcador',
    'kidmais-renovacao-cron', 'kidmais-renovacao-cron-trava']);

export async function sessoesAnteriores(tx: DbExecutor, reinicio: string) {
    return Number((await tx.query<{ n: string }>(`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND backend_type = 'client backend'
        AND pid <> pg_backend_pid() AND backend_start < $1::timestamptz AND coalesce(application_name, '') <> ALL($2::text[])`, [reinicio, [...SESSOES_ADMITIDAS]])).rows[0].n);
}
export async function sessoesPresas(tx: DbExecutor, reinicio: string) {
    return Number((await tx.query<{ n: string }>(`SELECT count(*) AS n FROM pg_stat_activity WHERE datname = current_database() AND backend_type = 'client backend'
        AND pid <> pg_backend_pid() AND backend_start >= $1::timestamptz AND coalesce(application_name, '') <> $2
        AND (state LIKE 'idle in transaction%' OR (xact_start IS NOT NULL AND xact_start < clock_timestamp() - interval '5 seconds'))`, [reinicio, NOME_APLICACAO_B14])).rows[0].n);
}

/**
 * Drenagem (§5.3 b e c): nenhuma sessão anterior ao reinício `R` fora das identificadas; depois, amostras (padrão 13 × 10 s
 * = 2 min) sem sessão posterior a `R` presa em transação. Registra também o início da contenção (manutenção ligada), base do
 * controle de retenção de 14 dias na liberação (P2-8). A parte (a), metadados de instâncias do Render, fica com o bloco.
 */
export async function modoDrenagem(x: Execucao, j: { reinicio: string; contencaoDesde: string; amostras?: number; intervaloMs?: number; esperar?: (ms: number) => Promise<void> }): Promise<Resultado> {
    if (!(Date.parse(j.contencaoDesde) <= Date.parse(j.reinicio))) throw new ParadaExecucao('CONTENCAO_DEPOIS_DO_REINICIO');
    const anteriores = await sessoesAnteriores(x.client, j.reinicio);
    const presas: number[] = [];
    const esperar = j.esperar ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let k = 0; k < (j.amostras ?? 13); k++) {
        if (k > 0) await esperar(j.intervaloMs ?? 10_000);
        const parada = await x.controle.parar();
        if (parada) return interrompida('RESTORE_DRENAGEM', x, parada);
        presas.push(await sessoesPresas(x.client, j.reinicio));
    }
    // Revisão da rodada 1 (P2-R1-3): a última amostra pode ter durado; parada antes de emitir a evidência.
    const parada = await x.controle.parar();
    if (parada) return interrompida('RESTORE_DRENAGEM', x, parada);
    const pass = anteriores === 0 && presas.every((n) => n === 0);
    x.arquivos.gravarNovo(`drenagem-${x.execucao}.json`, { formato: 1, execucao: x.execucao, reinicio: j.reinicio, contencaoDesde: j.contencaoDesde,
        resultado: pass ? 'PASS' : 'FALHA', anteriores, presas });
    return { modo: 'RESTORE_DRENAGEM', codigo: pass ? 2 : 1, execucao: x.execucao, resultado: pass ? 'PASS' : 'FALHA', anteriores, presas: Math.max(0, ...presas) };
}

/** Inventário, `conferir-caso` e liberação: uma transação RR desfeita no fim (ver o cabeçalho). */
async function emSnapshotDesfeito<T>(client: DbExecutor, trabalho: () => Promise<T>): Promise<T> {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    try { return await trabalho(); }
    finally { await client.query('ROLLBACK'); }
}

async function inventarioRestore(x: Execucao, j: { desde: string; ate: string }, presentes: readonly string[], chaves: Chaves) {
    const itens: ItemDoInventario[] = [];
    const classes = new Map<string, string>();
    let parada: string | null = null;
    for (const caso of chaves.casos) {
        parada = await x.controle.parar();
        if (parada) break;
        const rel = caso.tipo === 'EVENTO' ? classes.get(chaves.relacionado.get(caso.id) ?? '') === 'RECONCILIADA' : undefined;
        let i: ItemDoInventario;
        try { i = await proporEClassificar(x, 'RESTORE', presentes, caso, rel); }
        catch (error) { if (error instanceof LimpezaDoCasoFalhou) throw new ParadaExecucao('LIMPEZA_DO_CASO_FALHOU'); throw error; }
        classes.set(i.p.identidade, i.c.classe);
        itens.push(i);
    }
    const leitor = x.cliente.listarCobrancas && x.cliente.obterCobranca ? { listarCobrancas: x.cliente.listarCobrancas.bind(x.cliente), obterCobranca: x.cliente.obterCobranca.bind(x.cliente) } : null;
    const dia = j.desde.slice(0, 10);
    const remota = parada ? { itens: [], completa: false, motivos: ['NAO_LIDA'], inconclusivos: [] }
        : leitor ? await lerCobrancasRemotas(leitor, [{ campo: 'dateCreated', desde: dia }, { campo: 'paymentDate', desde: dia }])
        : { itens: [], completa: false, motivos: ['PROVEDOR_SEM_LISTAGEM'], inconclusivos: [] };
    // P2-6: as listagens remotas também podem durar; a parada é conferida de novo depois delas.
    parada = parada ?? await x.controle.parar();
    const orfas: Orfa[] = orfasRemotas(remota.itens, chaves.locais, x.ambiente);
    const coberturaIncompleta = chaves.limites.length > 0 || itens.some(incompleto) || !remota.completa || remota.inconclusivos.length > 0
        || (parada !== null && PARADAS_DE_COBERTURA.has(parada));
    return { itens, parada, remota, orfas, coberturaIncompleta };
}

type Drenagem = { resultado?: string; reinicio?: string; contencaoDesde?: string };
/** Exige a drenagem PASS do mesmo reinício e revalida: nenhuma sessão anterior a `R` não identificada (§5.3 b). */
async function exigirDrenagem(x: Execucao, j: { drenagem: string; reinicio: string }): Promise<Drenagem> {
    const d = x.arquivos.ler(j.drenagem) as Drenagem | null;
    if (!d || d.resultado !== 'PASS' || d.reinicio !== j.reinicio || typeof d.contencaoDesde !== 'string') throw new ParadaExecucao('DRENAGEM_NAO_COMPROVADA');
    if (await sessoesAnteriores(x.client, j.reinicio) !== 0) throw new ParadaExecucao('SESSAO_ANTERIOR_AO_REINICIO');
    return d;
}

export async function modoInventario(x: Execucao, j: { desde: string; ate: string; drenagem: string; reinicio: string }): Promise<Resultado> {
    const schema = schemaAtual(x.migracoes, x.ambiente);
    let parada = await x.controle.parar();
    if (parada) return interrompida('RESTORE_INVENTARIO', x, parada);
    await exigirDrenagem(x, j);
    const r = await emSnapshotDesfeito(x.client, async () => {
        const presentes = await tabelasPresentes(x.client);
        const chaves = await enumerarChaves(x.client, { ...j, presentes });
        return { chaves, ...(await inventarioRestore(x, j, presentes, chaves)) };
    });
    parada = r.parada ?? await x.controle.parar();
    if (parada) return interrompida('RESTORE_INVENTARIO', x, parada);
    const coberturaIncompleta = r.coberturaIncompleta;
    const arquivo = `casos-${x.execucao}.json`;
    x.arquivos.gravarNovo(arquivo, { formato: 1, execucao: x.execucao, instante: new Date().toISOString(), schema: schema.nome, codigoNoAr: x.codigoNoAr, reinicio: j.reinicio,
            casos: r.itens.map((i) => ({ ...i.evidencia, consistencia: i.consistencia })), orfas: r.orfas, eventosSemEmpresa: r.chaves.semEmpresa,
            cobertura: { incompleta: coberturaIncompleta, limites: r.chaves.limites, remota: r.remota.motivos, inconclusivos: r.remota.inconclusivos } });
    const codigo = codigoFinal({ modo: 'RESTORE', recusaTecnica: false, coberturaIncompleta, pendencias: 0 });
    return { modo: 'RESTORE_INVENTARIO', codigo, execucao: x.execucao, schema: schema.nome, parada: null, resultado: 'ASSISTIDO',
        arquivoDeCasos: arquivo, digestDoArquivo: hashCanonico(x.arquivos.ler(arquivo)), classes: contagem([...r.itens.map((i) => i.c), ...r.orfas]),
        cobertura: { incompleta: coberturaIncompleta, limites: r.chaves.limites, remota: r.remota.motivos, inconclusivos: [...r.remota.inconclusivos, ...r.itens.filter(incompleto).map((i) => i.p.identidade)] },
        casos: r.itens.map(publico), orfas: r.orfas, eventosSemEmpresa: r.chaves.semEmpresa };
}

type CasoAprovado = EvidenciaDoCaso & { proposta: Proposta; hash: string };
/** Caso do arquivo de casos, conferido: hash informado = hash registrado = hash do conteúdo. */
function casoDoArquivo(x: Execucao, j: { casos: string; identidade: string; proposta: string }): CasoAprovado {
    const f = x.arquivos.ler(j.casos) as { formato?: number; casos?: EvidenciaDoCaso[] } | null;
    const e = f?.formato === 1 ? f.casos?.find((c) => c.identidade === j.identidade) : undefined;
    if (!e || !e.proposta || !e.hash) throw new ParadaExecucao('CASO_NAO_ENCONTRADO');
    if (e.hash !== j.proposta || hashProposta(e.proposta) !== e.hash) throw new ParadaExecucao('HASH_DA_PROPOSTA_DIVERGENTE');
    return e as CasoAprovado;
}

const iso = (expr: string) => `SELECT to_char(${expr} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS t`;
const instanteDoBanco = async (tx: DbExecutor) => (await tx.query<{ t: string }>(iso('clock_timestamp()'))).rows[0].t;
/** Início da transação corrente (now()): limite inferior de todo instante gravado nela, inclusive DEFAULT now(). */
const inicioDaTransacao = async (tx: DbExecutor) => (await tx.query<{ t: string }>(iso('now()'))).rows[0].t;

/**
 * Comprovante transacional da aplicação (revisão da rodada 1, P2-R1-1): uma linha de auditoria (tabela só de inserção)
 * gravada NA MESMA transação dos efeitos, com execução, caso e hash. Existe ⇔ aquele COMMIT confirmou. Vale também para os
 * casos cujo serviço não audita (cobrança extra, créditos): os efeitos de OUTRA execução nunca comprovam esta.
 */
export const ACAO_COMPROVANTE = 'RECUPERACAO_B14_CASO_APLICADO';
async function gravarComprovante(tx: DbExecutor, j: { empresaId: string; execucao: string; identidade: string; hash: string }) {
    await tx.query(`INSERT INTO auditoria (ator_tipo, acao, entidade_tipo, entidade_id, dados_depois, origem, request_id)
        VALUES ('SISTEMA', $1, 'EMPRESA_ASSINATURA', $2::uuid, $3::jsonb, 'RECUPERACAO_B14', $4::uuid)`,
    [ACAO_COMPROVANTE, j.empresaId, JSON.stringify({ caso: j.identidade, hash: j.hash, execucao: j.execucao }), j.execucao]);
}
async function comprovanteExiste(tx: DbExecutor, j: { execucao: string; identidade: string; hash: string }) {
    return (await tx.query(`SELECT 1 FROM auditoria WHERE request_id = $1::uuid AND acao = $2 AND dados_depois->>'caso' = $3 AND dados_depois->>'hash' = $4
        AND dados_depois->>'execucao' = $1::text`, [j.execucao, ACAO_COMPROVANTE, j.identidade, j.hash])).rows.length > 0;
}

/**
 * `aplicar-caso` (A-B14-O): T2 com os valores aprovados; COMMIT só com hash idêntico. P2-5 (revisão do incremento 4): ANTES
 * de qualquer tentativa de COMMIT, invalida as liberações e grava o registro da aplicação (`aplicacao-<execução>.json`, com
 * o início medido no relógio do banco — a prova do `conferir-caso`, P2-3). Falha em qualquer dos dois desfaz e recusa.
 */
export async function modoAplicarCaso(x: Execucao, j: { casos: string; identidade: string; proposta: string }): Promise<Resultado> {
    schemaAtual(x.migracoes, x.ambiente);
    const aprovado = casoDoArquivo(x, j);
    const parada0 = await x.controle.parar();
    if (parada0) return interrompida('RESTORE_APLICAR_CASO', x, parada0);
    await x.client.query('BEGIN');
    let situacao: string;
    try {
        const inicio = await inicioDaTransacao(x.client);
        const presentes = await tabelasPresentes(x.client);
        const caso = await localizarCaso(x, j.identidade, presentes, { soPendentes: true });
        const r = await aplicarCasoReal(contextoDoCaso(x, 'RESTORE', presentes), caso, { hash: aprovado.hash, proposta: aprovado.proposta });
        situacao = r.situacao;
        const parada = await x.controle.parar();
        if (r.situacao !== 'APLICADO' || parada) {
            await x.client.query('ROLLBACK');
            if (parada) throw new ParadaExecucao(parada);
        }
        else {
            await gravarComprovante(x.client, { empresaId: caso.empresaId, execucao: x.execucao, identidade: j.identidade, hash: aprovado.hash });
            // Revisão da rodada 2 (P2-R2-2): a gravação do comprovante pode ter durado; parada → ROLLBACK explícito, sem COMMIT.
            const depois = await x.controle.parar();
            if (depois) {
                await x.client.query('ROLLBACK');
                throw new ParadaExecucao(depois);
            }
            try {
                for (const l of x.arquivos.listar('liberacao-')) x.arquivos.invalidar(l);
                x.arquivos.gravarNovo(`aplicacao-${x.execucao}.json`, { formato: 1, execucao: x.execucao, identidade: j.identidade, hash: aprovado.hash, inicio, estado: 'COMMIT_TENTADO' });
            }
            catch { throw new ParadaExecucao('REGISTRO_DA_APLICACAO_FALHOU'); }
            try { await x.client.query('COMMIT'); }
            catch { throw new ParadaExecucao('COMMIT_INDETERMINADO'); }
        }
    }
    catch (error) {
        if (!(error instanceof ParadaExecucao) || error.motivo === 'REGISTRO_DA_APLICACAO_FALHOU' || error.motivo === 'CASO_NAO_LOCALIZADO')
            await x.client.query('ROLLBACK').catch(() => undefined);
        if (error instanceof LimpezaDoCasoFalhou) throw new ParadaExecucao('LIMPEZA_DO_CASO_FALHOU');
        throw error;
    }
    return { modo: 'RESTORE_APLICAR_CASO', codigo: situacao === 'APLICADO' ? 2 : 1, execucao: x.execucao, identidade: j.identidade, resultado: situacao };
}

/**
 * `conferir-caso` (COMMIT indeterminado), com a execução da aplicação (`--execucao`). Rodada 2: APLICADO exige o comprovante
 * transacional da execução (P2-R1-1) além dos efeitos; a parada é conferida na entrada e antes do resultado (P2-R1-3).
 *   - NAO_APLICADO: a proposta recalculada tem o mesmo hash (pré-condições intactas);
 *   - APLICADO: os efeitos aprovados estão presentes E vieram dessa aplicação (instantes depois do início registrado; a
 *     auditoria com o request_id dela; vínculos simbólicos resolvidos) — P2-3;
 *   - DIVERGENTE (1): os demais casos, inclusive aplicação sem registro.
 * A localização acha também o evento já concluído pela aplicação (P2-2).
 */
export async function modoConferirCaso(x: Execucao, j: { casos: string; identidade: string; proposta: string; execucaoDaAplicacao: string }): Promise<Resultado> {
    schemaAtual(x.migracoes, x.ambiente);
    const aprovado = casoDoArquivo(x, j);
    const reg = x.arquivos.ler(`aplicacao-${j.execucaoDaAplicacao}.json`) as { identidade?: string; hash?: string; inicio?: string; execucao?: string } | null;
    const prova = reg && reg.identidade === j.identidade && reg.hash === aprovado.hash && reg.execucao === j.execucaoDaAplicacao && Number.isFinite(Date.parse(reg.inicio ?? ''))
        ? { desdeMs: Date.parse(reg.inicio!), requestId: j.execucaoDaAplicacao } : null;
    let parada = await x.controle.parar();
    if (parada) return interrompida('RESTORE_CONFERIR_CASO', x, parada);
    const situacao = await emSnapshotDesfeito(x.client, async () => {
        const presentes = await tabelasPresentes(x.client);
        const caso = await localizarCaso(x, j.identidade, presentes, { soPendentes: false });
        const p = await proporCasoReal(contextoDoCaso(x, 'RESTORE', presentes), caso);
        // Revisão do HB-3 r2 (achado da perda de COMMIT): a proposta recalculada leva um instante novo (cancelada_em = agora)
        // e o hash integral nunca batia — um COMMIT que não gravou saía DIVERGENTE. Mesmas pré-condições e mesmos efeitos com o
        // instante mascarado = nada aplicado (aplicado, a fotografia da empresa — pré-condição local — teria mudado).
        if (p.hash === aprovado.hash || (p.proposta && assinaturaDaProposta(p.proposta) === assinaturaDaProposta(aprovado.proposta))) return 'NAO_APLICADO';
        if (!prova || !(await comprovanteExiste(x.client, { execucao: j.execucaoDaAplicacao, identidade: j.identidade, hash: aprovado.hash }))) return 'DIVERGENTE';
        const foto = await fotografar(x.client, { empresaId: caso.empresaId, eventoIds: caso.tipo === 'EVENTO' ? [caso.id] : [] }, presentes);
        return efeitosPresentes(foto, aprovado.proposta.efeitos, prova) ? 'APLICADO' : 'DIVERGENTE';
    });
    parada = await x.controle.parar();
    if (parada) return interrompida('RESTORE_CONFERIR_CASO', x, parada);
    return { modo: 'RESTORE_CONFERIR_CASO', codigo: situacao === 'DIVERGENTE' ? 1 : 2, execucao: x.execucao, identidade: j.identidade, resultado: situacao,
        registroDaAplicacao: prova !== null };
}

/**
 * Liberação (§5): inventário final (Tf) imediatamente antes de desligar a manutenção, com a fila e as decisões presas ao
 * inventário que declaram (P2-4). Retenção acima de 14 dias desde o início da contenção exige aceite (P2-8). A parada é
 * conferida na entrada, depois das leituras remotas e da fila e imediatamente antes de gravar o registro (P2-6). Fila
 * ilegível é cobertura incompleta (3; P2-7). Um `aplicar-caso` posterior invalida o registro.
 */
export async function modoLiberacao(x: Execucao, j: { desde: string; ate: string; drenagem: string; reinicio: string; decisoes: string; urlWebhook: string; provaCron?: string | null }): Promise<Resultado> {
    const modo = 'RESTORE_LIBERACAO';
    const schema = schemaAtual(x.migracoes, x.ambiente);
    let parada = await x.controle.parar();
    if (parada) return interrompida(modo, x, parada);
    const decisoes = lerDecisoes(x.arquivos.ler(j.decisoes));
    const vinculo = conferirVinculoDasDecisoes(decisoes, x.arquivos.ler(`casos-${decisoes.inventario}.json`), { schema: schema.nome, codigoNoAr: x.codigoNoAr, reinicio: j.reinicio });
    if (vinculo) throw new ParadaExecucao(vinculo);
    const drenagem = await exigirDrenagem(x, j);
    const r = await emSnapshotDesfeito(x.client, async () => {
        const presentes = await tabelasPresentes(x.client);
        const chaves = await enumerarChaves(x.client, { ...j, presentes });
        return { chaves, ...(await inventarioRestore(x, j, presentes, chaves)) };
    });
    if (r.parada) return interrompida(modo, x, r.parada);
    const fila: ConferenciaFila = x.cliente.listarWebhooks ? await conferirFila(x.cliente.listarWebhooks.bind(x.cliente), j.urlWebhook)
        : { codigo: 3, motivos: ['PROVEDOR_SEM_LISTAGEM'], configuracoes: 0, enabled: null, interrupted: null, sendType: null, faltantes: [], soInterrompida: false };
    parada = await x.controle.parar();
    if (parada) return interrompida(modo, x, parada);
    const provaCronAntigo = x.codigoNoAr === 'ANTIGO' ? (j.provaCron ? validarProvaCronAntigo(x.arquivos.ler(j.provaCron)) : 'AUSENTE') : null;
    const tf = await instanteDoBanco(x.client);
    const retencaoAcima14Dias = Date.parse(tf) - Date.parse(drenagem.contencaoDesde!) > RETENCAO_MAXIMA_MS;
    const coberturaIncompleta = r.coberturaIncompleta || fila.codigo === 3;
    const lib: Liberacao = avaliarLiberacao({
        itens: [...r.itens.map((i) => ({ identidade: i.p.identidade, semEfeito: i.p.semEfeito, falha: falhaDoCaso(i.p) })),
            ...r.chaves.semEmpresa.map((identidade) => ({ identidade, semEfeito: false, falha: 'EVENTO_SEM_EMPRESA' }))],
        orfas: r.orfas.map((o) => o.identidade), coberturaIncompleta, decisoes: { ...decisoes, casos: decisoes.casos }, fila, codigo: x.codigoNoAr, provaCronAntigo,
        retencaoAcima14Dias,
    });
    // Última conferência da parada, imediatamente antes de emitir a evidência válida.
    parada = await x.controle.parar();
    if (parada) return interrompida(modo, x, parada);
    x.arquivos.gravarNovo(`liberacao-${x.execucao}.json`, { formato: 1, execucao: x.execucao, tf, inventario: decisoes.inventario, digestInventario: decisoes.digestInventario,
        schema: schema.nome, codigoNoAr: x.codigoNoAr, liberada: lib.liberada, bloqueios: lib.bloqueios, exigenciasPosReabertura: lib.exigenciasPosReabertura,
        excecaoExpressa: lib.excecaoExpressa, limitacoes: [...(coberturaIncompleta ? ['COBERTURA_INCOMPLETA'] : []), ...(retencaoAcima14Dias ? ['RETENCAO_ACIMA_DE_14_DIAS'] : [])] });
    const codigo = codigoFinal({ modo: 'RESTORE', recusaTecnica: false, coberturaIncompleta, pendencias: 0 });
    return { modo, codigo, execucao: x.execucao, tf, resultado: lib.liberada ? 'LIBERADA' : 'BLOQUEADA', bloqueios: lib.bloqueios,
        exigenciasPosReabertura: lib.exigenciasPosReabertura, excecaoExpressa: lib.excecaoExpressa, retencaoAcima14Dias,
        fila: { codigo: fila.codigo, motivos: fila.motivos, faltantes: fila.faltantes },
        comEfeito: r.itens.filter((i) => falhaDoCaso(i.p) !== null || !i.p.semEfeito).map(publico), orfasSemDecisao: r.orfas.filter((o) => !decisoes.orfas[o.identidade]).map((o) => o.identidade) };
}

/** `--fila` (§3.7): não conecta ao banco. */
export async function modoFila(cliente: Execucao['cliente'], urlWebhook: string, execucao: string): Promise<Resultado> {
    const f = cliente.listarWebhooks ? await conferirFila(cliente.listarWebhooks.bind(cliente), urlWebhook)
        : { codigo: 3 as const, motivos: ['PROVEDOR_SEM_LISTAGEM'], configuracoes: 0, enabled: null, interrupted: null, sendType: null, faltantes: [], soInterrompida: false };
    return { modo: 'FILA', codigo: f.codigo, execucao, resultado: f.codigo === 0 ? 'FILA_OK' : f.codigo === 3 ? 'LISTAGEM_INCOMPLETA' : 'FILA_RECUSADA',
        enabled: f.enabled, interrupted: f.interrupted, sendType: f.sendType, faltantes: f.faltantes, motivos: f.motivos, soInterrompida: f.soInterrompida };
}
