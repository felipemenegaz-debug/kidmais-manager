import { randomUUID } from 'node:crypto';
import type { DbExecutor } from '../db/contracts';
import { AsaasFalhou, cicloDoProvedor, type ClienteAsaas } from './asaas.ts';
import { auditarCobranca, type OrigemSincronizacao } from './sincronizacao-auditoria.ts';
import { decidirCompensacao, type MotivoPreservacao } from './compensacao.ts';

/**
 * Pendências de reconciliação da CONTRATAÇÃO (E8), sem migration nova: uma linha em `cobranca_eventos` (068) com
 * tipo `KIDMAIS_RECONCILIAR_CONTRATACAO`, `evento_id` começando por `kidmais:` e `empresa_id` preenchido. Nasce
 * sempre que o resultado de uma contratação fica INCERTO (resposta do provedor perdida, COMMIT sem confirmação, falha
 * na compensação). Fica PENDENTE/FALHOU até ser resolvida pelo processamento normal de eventos (reentrega, painel do
 * desenvolvedor ou scripts/assinatura-reconciliar.cjs) — nunca é descartada em silêncio.
 *
 * Regra de ouro: exclusão só pela decisão central (compensacao.ts): vínculo confirmado (linha travada) a uma assinatura
 * VIGENTE da mesma empresa e candidata sem nenhuma cobrança fora de "em aberto". Qualquer dúvida → nada é excluído e a
 * pendência fica para revisão.
 */
export const TIPO_PENDENCIA = 'KIDMAIS_RECONCILIAR_CONTRATACAO';
export const PREFIXO_PENDENCIA = 'kidmais:';
/** Intenção de criação gravada ANTES do POST de criação no provedor (registro prévio da operação). */
export const PREFIXO_CRIACAO = 'kidmais:criacao:';
/** Registro durável do id CONFIRMADO pelo provedor, gravado logo após a resposta e antes do vínculo (fase C). */
export const PREFIXO_ID_CONFIRMADO = 'kidmais:vinculo:';
/**
 * Exclusão pedida ao provedor sem confirmação (resposta perdida, 5xx, resposta sem `deleted`). Marcador durável, com o id
 * da assinatura: enquanto aberto, a assinatura NUNCA é excluída de novo automaticamente; a reconciliação só relê pelo id.
 * Removida ou inexistente na releitura → exclusão confirmada (auditada) e o marcador fecha; ainda existe → revisão humana.
 */
export const PREFIXO_REMOCAO_SEM_CONFIRMACAO = 'kidmais:remocao:';
const TROCA_PERMITIDA = new Set(['TESTE', 'CANCELADA_FIM_PERIODO', 'ENCERRADA']);

export type MotivoPendencia = 'CRIACAO_EM_CURSO' | 'CRIACAO_CONFIRMADA_SEM_VINCULO' | 'CRIACAO_SEM_RESPOSTA' | 'COMMIT_INCERTO' | 'COMPENSACAO_FALHOU' | 'VINCULO_DUVIDOSO' | 'COMPENSACAO_PRESERVADA' | 'ASSINATURAS_AMBIGUAS';
export type ProvedorReconciliacao = Pick<ClienteAsaas, 'obterAssinatura' | 'listarAssinaturasPorReferencia' | 'listarCobrancasDaAssinatura' | 'removerAssinatura'>;

/** Registra a pendência (só identificadores e o motivo). Devolve o id interno. */
export async function registrarPendencia(tx: DbExecutor, input: { empresaId: string; assinaturaId: string | null; motivo: MotivoPendencia; detalhe?: MotivoPreservacao; operacao?: 'criacao' }) {
    return (await tx.query<{ id: string }>(
        `INSERT INTO cobranca_eventos (provedor, evento_id, tipo, assinatura_provedor_id, referencia_externa, empresa_id, situacao, ultimo_erro)
         VALUES ('ASAAS', $1, $2, $3, $4, $5::uuid, 'PENDENTE', $6) RETURNING id`,
        [`${input.operacao === 'criacao' ? PREFIXO_CRIACAO : `${PREFIXO_PENDENCIA}contratacao:`}${input.empresaId}:${randomUUID()}`, TIPO_PENDENCIA, input.assinaturaId, input.empresaId, input.empresaId, input.detalhe ? `${input.motivo}: ${input.detalhe}` : input.motivo])).rows[0].id;
}

/** Pendências ainda abertas da empresa (PENDENTE/FALHOU): operações anteriores cujo resultado não foi resolvido. */
export async function pendenciasAbertas(tx: DbExecutor, empresaId: string) {
    return (await tx.query<{ id: string; evento_id: string; assinatura_provedor_id: string | null }>(
        `SELECT id, evento_id, assinatura_provedor_id FROM cobranca_eventos
          WHERE empresa_id = $1::uuid AND provedor = 'ASAAS' AND tipo = $2 AND situacao IN ('PENDENTE', 'FALHOU') ORDER BY recebido_em`,
        [empresaId, TIPO_PENDENCIA])).rows;
}

/**
 * Grava o id confirmado pelo provedor (evento `kidmais:vinculo:<empresa>:<intenção>`, aberto). Fica aberto até o vínculo:
 * se o processo cair antes da fase C, a próxima tentativa reaproveita a assinatura por este id — sem novo POST.
 */
export async function registrarIdConfirmado(tx: DbExecutor, input: { empresaId: string; assinaturaId: string; intencaoId: string }) {
    return (await tx.query<{ id: string }>(
        `INSERT INTO cobranca_eventos (provedor, evento_id, tipo, assinatura_provedor_id, referencia_externa, empresa_id, situacao, ultimo_erro)
         VALUES ('ASAAS', $1, $2, $3, $4, $5::uuid, 'PENDENTE', 'CRIACAO_CONFIRMADA_SEM_VINCULO') RETURNING id`,
        [`${PREFIXO_ID_CONFIRMADO}${input.empresaId}:${input.intencaoId}`, TIPO_PENDENCIA, input.assinaturaId, input.empresaId, input.empresaId])).rows[0].id;
}

/** Intenção à qual um registro de id confirmado pertence (último segmento do evento_id). */
export function intencaoDoIdConfirmado(eventoId: string) {
    return eventoId.startsWith(PREFIXO_ID_CONFIRMADO) ? eventoId.slice(eventoId.lastIndexOf(':') + 1) : null;
}

/**
 * Encerra pendências abertas da empresa (intenção e id confirmado). Chamada DENTRO da transação que grava o vínculo
 * (fase C): vínculo e encerramento são atômicos — ou os dois, ou nenhum.
 */
export async function encerrarPendencias(tx: DbExecutor, empresaId: string, ids: readonly string[], motivo: 'VINCULADA' | 'COMPENSADA' | 'SUBSTITUIDA_POR_PENDENCIA') {
    if (!ids.length)
        return;
    await tx.query(`UPDATE cobranca_eventos SET situacao = 'PROCESSADO', processado_em = clock_timestamp(), ultimo_erro = $3
                     WHERE id = ANY($2::uuid[]) AND empresa_id = $1::uuid AND tipo = $4 AND situacao IN ('PENDENTE', 'FALHOU')`, [empresaId, ids, motivo, TIPO_PENDENCIA]);
}

/** Fecha a intenção de criação (resultado conhecido). A identidade do evento é imutável (068): só situação e motivo mudam. */
export async function concluirIntencao(tx: DbExecutor, id: string, motivo: 'CRIACAO_RECUSADA' | 'LIBERADA_MANUALMENTE: CRIACAO_NAO_EXECUTADA') {
    await tx.query(`UPDATE cobranca_eventos SET situacao = 'PROCESSADO', processado_em = clock_timestamp(), ultimo_erro = $2
                     WHERE id = $1::uuid AND situacao IN ('PENDENTE', 'FALHOU')`, [id, motivo]);
}

/** Mantém a intenção aberta e registra por quê (resposta da criação perdida e não confirmada). */
export async function marcarIntencao(tx: DbExecutor, id: string, motivo: 'CRIACAO_SEM_RESPOSTA') {
    await tx.query(`UPDATE cobranca_eventos SET ultimo_erro = $2 WHERE id = $1::uuid AND situacao IN ('PENDENTE', 'FALHOU')`, [id, motivo]);
}

export function ehPendencia(ev: { tipo: string; evento_id: string; empresa_id: string | null }) {
    return ev.tipo === TIPO_PENDENCIA && ev.evento_id.startsWith(PREFIXO_PENDENCIA) && ev.empresa_id !== null;
}

export type ResultadoReconciliacao =
    | { resultado: 'NADA_A_FAZER' | 'CONCILIADA'; removidas: string[] }
    | { resultado: 'AGUARDANDO'; motivo: 'CRIACAO_NAO_CONFIRMADA' }
    | { resultado: 'VINCULADA'; assinaturaId: string }
    | { resultado: 'ADIADA'; motivo: 'MARCADOR_NAO_GRAVADO'; ids: string[] }
    | { resultado: 'REVISAO_HUMANA'; motivo: 'VARIAS_ASSINATURAS_SEM_VINCULO' | 'DUPLICATA_COM_PAGAMENTO' | 'DUPLICATA_PRESERVADA' | 'VINCULO_INATIVO_COM_ACESSO' | 'SEM_ASSINATURA_NO_BANCO' | 'REMOCAO_SEM_CONFIRMACAO'; ids: string[] };

/**
 * Exclusões no provedor durante uma reconciliação. O marcador e o resultado de cada DELETE já são gravados (e
 * confirmados) na transação independente; aqui ficam as listas para o retorno e as confirmações por RELEITURA, que
 * quem chama grava depois do SAVEPOINT (liberado ou desfeito). Sem confirmação nunca conta como removida.
 */
export type RegistroRemocoes = {
    /** O provedor confirmou (resposta com `deleted`, ou 404 = já removida). */
    confirmadas: string[];
    /** Pedido enviado sem confirmação: pode ou não ter sido executado. */
    semConfirmacao: string[];
    /** Marcadores de exclusão sem confirmação cuja assinatura, relida agora pelo id, não existe mais ou está removida. */
    confirmadasNaReleitura: Array<{ marcadorId: string }>;
};
export const novoRegistroRemocoes = (): RegistroRemocoes => ({ confirmadas: [], semConfirmacao: [], confirmadasNaReleitura: [] });

/** A exclusão pode ter sido executada? Mesma regra de `resultadoIncerto` (cobranca.ts); erro desconhecido → pode. */
function remocaoPodeTerOcorrido(error: unknown) {
    if (!(error instanceof AsaasFalhou))
        return true;
    const s = error.status;
    return s === null || s >= 500 || s === 408 || s === 409 || s === 429 || s < 400;
}

/** Resultado classificado de uma exclusão no provedor. Único ponto que chama `removerAssinatura` na contratação e na reconciliação. */
export type ResultadoRemocao = { resultado: 'CONFIRMADA' } | { resultado: 'RECUSADA'; erro: unknown } | { resultado: 'DESCONHECIDA' };
export async function removerComResultado(provedor: Pick<ClienteAsaas, 'removerAssinatura'>, assinaturaId: string): Promise<ResultadoRemocao> {
    try {
        return (await provedor.removerAssinatura(assinaturaId)).removida ? { resultado: 'CONFIRMADA' } : { resultado: 'DESCONHECIDA' };
    }
    catch (error) {
        return remocaoPodeTerOcorrido(error) ? { resultado: 'DESCONHECIDA' } : { resultado: 'RECUSADA', erro: error };
    }
}

/** Abre o marcador durável de exclusão (antes do DELETE: REMOCAO_EM_CURSO; depois, sem confirmação: REMOCAO_SEM_CONFIRMACAO). */
export async function abrirMarcadorRemocao(tx: DbExecutor, empresaId: string, assinaturaId: string, motivo: 'REMOCAO_EM_CURSO' | 'REMOCAO_SEM_CONFIRMACAO') {
    return (await tx.query<{ id: string }>(
        `INSERT INTO cobranca_eventos (provedor, evento_id, tipo, assinatura_provedor_id, referencia_externa, empresa_id, situacao, ultimo_erro)
         VALUES ('ASAAS', $1, $2, $3, $4, $5::uuid, 'PENDENTE', $6) RETURNING id`,
        [`${PREFIXO_REMOCAO_SEM_CONFIRMACAO}${empresaId}:${randomUUID()}`, TIPO_PENDENCIA, assinaturaId, empresaId, empresaId, motivo])).rows[0].id;
}

/** Resultado conhecido: o marcador fecha (a identidade do evento é imutável na 068; só situação e motivo mudam). */
export async function fecharMarcadorRemocao(tx: DbExecutor, empresaId: string, id: string, motivo: 'REMOCAO_CONFIRMADA' | 'REMOCAO_RECUSADA') {
    await tx.query(`UPDATE cobranca_eventos SET situacao = 'PROCESSADO', processado_em = clock_timestamp(), ultimo_erro = $3
                     WHERE id = $1::uuid AND empresa_id = $2::uuid AND tipo = $4 AND situacao IN ('PENDENTE', 'FALHOU')`, [id, empresaId, motivo, TIPO_PENDENCIA]);
}

/** Resultado desconhecido: o marcador continua aberto e diz por quê. */
export async function manterMarcadorRemocao(tx: DbExecutor, empresaId: string, id: string) {
    await tx.query(`UPDATE cobranca_eventos SET ultimo_erro = 'REMOCAO_SEM_CONFIRMACAO'
                     WHERE id = $1::uuid AND empresa_id = $2::uuid AND tipo = $3 AND situacao IN ('PENDENTE', 'FALHOU')`, [id, empresaId, TIPO_PENDENCIA]);
}

/**
 * Transação INDEPENDENTE (outra conexão, COMMIT próprio) para o marcador de exclusão: ele tem de estar confirmado no
 * banco ANTES do DELETE, mesmo com a transação de quem chama ainda aberta (travando linhas) ou desfeita depois.
 */
export type TransacaoIndependente = <T>(trabalho: (tx: DbExecutor) => Promise<T>) => Promise<T>;

/**
 * Quem chama está PARADO esperando esta transação, com locks próprios: se ela precisasse de um deles, o PostgreSQL não
 * veria o ciclo (a espera do outro lado está na aplicação). Por isso nunca espera lock por muito tempo: falha fechada.
 */
async function limitesIndependente(tx: DbExecutor) {
    await tx.query("SET LOCAL lock_timeout = '3s'");
    await tx.query("SET LOCAL statement_timeout = '10s'");
}

/**
 * Registro prévio: grava e CONFIRMA (COMMIT) o marcador REMOCAO_EM_CURSO antes do DELETE. Uma exclusão por assinatura de
 * cada vez (trava consultiva pela assinatura: contratação e reconciliação concorrentes). Devolve o id; ou null quando não
 * foi possível (sem transação independente, lock ocupado, banco fora, COMMIT sem confirmação) ou quando já há marcador
 * aberto para a mesma assinatura. null → quem chama NÃO exclui.
 */
export async function persistirMarcadorPrevio(independente: TransacaoIndependente | undefined, empresaId: string, assinaturaId: string): Promise<string | null> {
    if (!independente)
        return null;
    try {
        return await independente(async (tx) => {
            await limitesIndependente(tx);
            await tx.query("SELECT pg_advisory_xact_lock(hashtext('kidmais:remocao'), hashtext($1))", [assinaturaId]);
            const aberto = (await tx.query(
                `SELECT 1 FROM cobranca_eventos WHERE provedor = 'ASAAS' AND tipo = $1 AND evento_id LIKE $2 AND assinatura_provedor_id = $3
                    AND situacao IN ('PENDENTE', 'FALHOU') LIMIT 1`, [TIPO_PENDENCIA, `${PREFIXO_REMOCAO_SEM_CONFIRMACAO}%`, assinaturaId])).rows.length > 0;
            return aberto ? null : abrirMarcadorRemocao(tx, empresaId, assinaturaId, 'REMOCAO_EM_CURSO');
        });
    }
    catch {
        return null;
    }
}

/**
 * Grava o resultado do DELETE na transação independente (sobrevive à de quem chama). Confirmada → marcador fecha +
 * ASSINATURA_DUPLICADA_REMOVIDA; recusada (4xx) → marcador fecha; desconhecida → marcador aberto +
 * ASSINATURA_REMOCAO_SEM_CONFIRMACAO. `extra` roda na mesma transação (contratação: pendências da operação).
 * false → não gravou: o marcador continua REMOCAO_EM_CURSO e vale só a releitura.
 */
export async function registrarResultadoRemocao(independente: TransacaoIndependente, empresaId: string, marcadorId: string, remocao: ResultadoRemocao,
    origem: OrigemSincronizacao, extra?: (tx: DbExecutor) => Promise<void>) {
    try {
        await independente(async (tx) => {
            await limitesIndependente(tx);
            if (remocao.resultado === 'CONFIRMADA') {
                await fecharMarcadorRemocao(tx, empresaId, marcadorId, 'REMOCAO_CONFIRMADA');
                await auditarCobranca(tx, { acao: 'ASSINATURA_DUPLICADA_REMOVIDA', empresaId, origem, ip: null, depois: { removidas: 1, confirmacao: 'RESPOSTA_DO_PROVEDOR' } });
            }
            else if (remocao.resultado === 'RECUSADA')
                await fecharMarcadorRemocao(tx, empresaId, marcadorId, 'REMOCAO_RECUSADA');
            else {
                await manterMarcadorRemocao(tx, empresaId, marcadorId);
                await auditarCobranca(tx, { acao: 'ASSINATURA_REMOCAO_SEM_CONFIRMACAO', empresaId, origem, ip: null, depois: { pendenciaId: marcadorId } });
            }
            if (extra)
                await extra(tx);
        });
        return true;
    }
    catch {
        return false;
    }
}

/** Marcadores de exclusão abertos da empresa (qualquer motivo): enquanto existir um, nada é excluído de novo nem liberado. */
export async function marcadoresDeRemocao(tx: DbExecutor, empresaId: string) {
    return (await tx.query<{ id: string; assinatura_provedor_id: string }>(
        `SELECT id, assinatura_provedor_id FROM cobranca_eventos
          WHERE empresa_id = $1::uuid AND provedor = 'ASAAS' AND tipo = $2 AND evento_id LIKE $3 AND assinatura_provedor_id IS NOT NULL
            AND situacao IN ('PENDENTE', 'FALHOU') ORDER BY recebido_em`,
        [empresaId, TIPO_PENDENCIA, `${PREFIXO_REMOCAO_SEM_CONFIRMACAO}%`])).rows;
}

/**
 * Grava as confirmações por RELEITURA (chamar fora do SAVEPOINT): ASSINATURA_DUPLICADA_REMOVIDA (releitura) e o marcador
 * fecha. O marcador do evento em processamento só conta quando esse evento é concluído agora (senão é relido e registrado
 * na próxima vez, sem nova chamada de exclusão). Exclusões feitas agora já foram gravadas na transação independente.
 */
export async function registrarRemocoes(tx: DbExecutor, empresaId: string, registro: RegistroRemocoes, origem: OrigemSincronizacao,
    eventoAtual: { id: string; concluido: boolean }) {
    const releitura = registro.confirmadasNaReleitura.filter((m) => m.marcadorId !== eventoAtual.id || eventoAtual.concluido);
    if (releitura.length) {
        await auditarCobranca(tx, { acao: 'ASSINATURA_DUPLICADA_REMOVIDA', empresaId, origem, ip: null, depois: { removidas: releitura.length, confirmacao: 'RELEITURA' } });
        const fechar = releitura.map((m) => m.marcadorId).filter((id) => id !== eventoAtual.id);
        if (fechar.length)
            await tx.query(`UPDATE cobranca_eventos SET situacao = 'PROCESSADO', processado_em = clock_timestamp(), ultimo_erro = 'REMOCAO_CONFIRMADA_NA_RELEITURA'
                             WHERE id = ANY($1::uuid[]) AND empresa_id = $2::uuid AND tipo = $3 AND situacao IN ('PENDENTE', 'FALHOU')`, [fechar, empresaId, TIPO_PENDENCIA]);
    }
}

const ativa = (s: { status: string; deleted: boolean }) => !s.deleted && s.status === 'ACTIVE';

/**
 * Compara o vínculo gravado (linha travada, nesta transação) com o que o provedor tem para a referência da empresa:
 *   - vínculo vazio OU apontando para assinatura que não está mais ativa (ex.: cancelada antes de uma recontratação):
 *       nenhuma ativa → nada; exatamente uma → vincula (se a 068 permite a troca nesta situação; senão revisão);
 *       várias → revisão humana (não escolhe a primeira, não exclui);
 *   - vínculo a assinatura ativa → as outras ativas são candidatas a duplicata; cada uma passa pela decisão central
 *     (compensacao.ts): exclui só com justificativa segura; preservada → revisão humana com o motivo.
 * Pendência com assinatura conhecida e listagem vazia → consulta pelo id (a listagem pode atrasar). Intenção de criação
 * sem id e listagem vazia → AGUARDANDO: listagem vazia não prova que o POST falhou; a pendência fica aberta (e a
 * contratação não faz outro POST) até a assinatura aparecer. Não há liberação automática por tempo.
 * Falha do provedor propaga (o evento fica FALHOU e volta a ser tentado).
 * Exclusão: registro prévio na transação INDEPENDENTE (marcador confirmado antes do DELETE); sem ela, ou sem conseguir
 * gravar, nada é excluído (ADIADA). O resultado do DELETE também é gravado nela.
 */
export async function reconciliarContratacao(tx: DbExecutor, empresaId: string, provedor: ProvedorReconciliacao, requestId: string | null = null,
    pendencia: { criacao: boolean; assinaturaId: string | null } | null = null, registro: RegistroRemocoes = novoRegistroRemocoes(),
    independente?: TransacaoIndependente): Promise<ResultadoReconciliacao> {
    const linha = (await tx.query<{ situacao: string; provedor_assinatura_id: string | null; provedor_cliente_id: string | null }>(
        'SELECT situacao, provedor_assinatura_id, provedor_cliente_id FROM empresa_assinaturas WHERE empresa_id = $1::uuid FOR UPDATE', [empresaId])).rows[0];
    if (!linha)
        return { resultado: 'REVISAO_HUMANA', motivo: 'SEM_ASSINATURA_NO_BANCO', ids: [] };
    // Exclusões anteriores sem confirmação: só relidas pelo id, nunca repetidas.
    const semConfirmacao = new Set<string>();
    for (const m of await marcadoresDeRemocao(tx, empresaId)) {
        const s = await provedor.obterAssinatura(m.assinatura_provedor_id);
        if (!s || s.deleted)
            registro.confirmadasNaReleitura.push({ marcadorId: m.id });
        else
            semConfirmacao.add(m.assinatura_provedor_id);
    }
    const ativas = (await provedor.listarAssinaturasPorReferencia(empresaId)).filter(ativa);
    // A listagem pode atrasar: ids conhecidos (vínculo gravado, pendência) são confirmados um a um pelo id.
    for (const id of new Set([linha.provedor_assinatura_id, pendencia?.assinaturaId ?? null])) {
        if (!id || ativas.some((s) => s.id === id))
            continue;
        const conhecida = await provedor.obterAssinatura(id);
        if (conhecida && ativa(conhecida) && conhecida.externalReference === empresaId)
            ativas.push(conhecida);
    }
    const origem = { tipo: 'RECONCILIACAO' as const, requestId };
    const vinculada = linha.provedor_assinatura_id ? ativas.find((s) => s.id === linha.provedor_assinatura_id) ?? null : null;
    if (!vinculada) {
        if (ativas.length === 0)
            return pendencia?.criacao && !pendencia.assinaturaId ? { resultado: 'AGUARDANDO', motivo: 'CRIACAO_NAO_CONFIRMADA' } : { resultado: 'NADA_A_FAZER', removidas: [] };
        if (ativas.length > 1)
            return { resultado: 'REVISAO_HUMANA', motivo: 'VARIAS_ASSINATURAS_SEM_VINCULO', ids: ativas.map((s) => s.id) };
        const s = ativas[0];
        // Vínculo antigo não vigente: a troca só vale onde a 068 permite; com acesso pago em curso, pessoa decide.
        if (linha.provedor_assinatura_id && !TROCA_PERMITIDA.has(linha.situacao))
            return { resultado: 'REVISAO_HUMANA', motivo: 'VINCULO_INATIVO_COM_ACESSO', ids: [linha.provedor_assinatura_id, s.id] };
        await tx.query(
            `UPDATE empresa_assinaturas SET provedor = 'ASAAS', provedor_cliente_id = COALESCE(provedor_cliente_id, $2), provedor_assinatura_id = $3,
                    ciclo = CASE WHEN situacao IN ('TESTE', 'ENCERRADA') THEN COALESCE($4, ciclo) ELSE ciclo END, provedor_situacao = $5
              WHERE empresa_id = $1::uuid`, [empresaId, s.customer, s.id, cicloDoProvedor(s.cycle), s.status.slice(0, 40)]);
        await auditarCobranca(tx, { acao: 'ASSINATURA_VINCULADA_RECONCILIACAO', empresaId, origem, ip: null, depois: { vinculada: true } });
        return { resultado: 'VINCULADA', assinaturaId: s.id };
    }
    const preservadas: Array<{ id: string; motivo: MotivoPreservacao | 'REMOCAO_SEM_CONFIRMACAO' }> = [];
    const revisao = () => ({
        resultado: 'REVISAO_HUMANA' as const, ids: preservadas.map((p) => p.id),
        motivo: preservadas.some((p) => p.motivo === 'REMOCAO_SEM_CONFIRMACAO') ? 'REMOCAO_SEM_CONFIRMACAO' as const
            : preservadas.every((p) => p.motivo === 'CANDIDATA_COM_PAGAMENTO') ? 'DUPLICATA_COM_PAGAMENTO' as const : 'DUPLICATA_PRESERVADA' as const,
    });
    for (const d of ativas) {
        if (d.id === vinculada.id)
            continue;
        if (semConfirmacao.has(d.id)) {
            preservadas.push({ id: d.id, motivo: 'REMOCAO_SEM_CONFIRMACAO' });
            continue;
        }
        const decisao = await decidirCompensacao(provedor, { empresaId, vinculo: vinculada.id, candidataId: d.id });
        if (!decisao.excluir) {
            if (decisao.motivo !== 'CANDIDATA_INEXISTENTE')
                preservadas.push({ id: d.id, motivo: decisao.motivo });
            continue;
        }
        // Registro prévio: o marcador está CONFIRMADO no banco antes do DELETE; sem ele, nada é excluído agora.
        const marcadorId = await persistirMarcadorPrevio(independente, empresaId, d.id);
        if (!marcadorId)
            return { resultado: 'ADIADA', motivo: 'MARCADOR_NAO_GRAVADO', ids: [d.id] };
        const remocao = await removerComResultado(provedor, d.id);
        const gravado = await registrarResultadoRemocao(independente!, empresaId, marcadorId, remocao, origem);
        // Recusa definitiva (4xx) gravada: nada foi excluído; a pendência volta a ser tentada. O que já foi excluído está gravado.
        if (remocao.resultado === 'RECUSADA' && gravado)
            throw remocao.erro;
        if (remocao.resultado !== 'CONFIRMADA' || !gravado) {
            // Resultado desconhecido (ou não gravado): não conta como removida, não é repetida; para aqui e vai para revisão.
            registro.semConfirmacao.push(d.id);
            preservadas.push({ id: d.id, motivo: 'REMOCAO_SEM_CONFIRMACAO' });
            return revisao();
        }
        registro.confirmadas.push(d.id);
    }
    if (preservadas.length)
        return revisao();
    return { resultado: registro.confirmadas.length ? 'CONCILIADA' : 'NADA_A_FAZER', removidas: [...registro.confirmadas] };
}
