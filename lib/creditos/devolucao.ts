/**
 * Devolução de pacote de créditos (090), separada da devolução da assinatura (089/L1) e com flag própria
 * (CREDITOS_ESTORNO_ATIVO; nunca ASSINATURA_ESTORNO_ATIVO). Regras PROPOSTAS (sujeitas ao jurídico), em dominio.ts:
 * garantia de 7 dias por compra (integral, mesmo com uso) e, depois, saldo pago não utilizado pelo preço original.
 *
 *   A. transação (tenant, Gestão, senha recente): pedido travado → carteira → lote; recalcula com o relógio do banco,
 *      confere o valor mostrado, grava a devolução (protocolo, cálculo imutável; a guarda impede soma acima do pago) e
 *      CANCELA o remanescente do lote na mesma transação (bloqueio + reversão: o saldo devolvido nunca volta a ser usado;
 *      gerações já enviadas terminam sem reabrir crédito). Outbox: confirmação à Gestão e aviso interno à plataforma.
 *   B. só com CREDITOS_ESTORNO_ATIVO=true e Pix/cartão: registro prévio EM_CURSO e UM POST de estorno; resultado
 *      desconhecido = SEM_CONFIRMACAO (nunca repetido; reconsulta e operador). Boleto e flag desligada: AGUARDANDO_MANUAL
 *      (a obrigação existe e entra na fila; desligar a flag não suprime o direito).
 * Pedido pelo atendimento (login inacessível): mesma função `registrarDevolucao`, com origem ATENDIMENTO e operador
 * da plataforma (lib/creditos/operacao.ts).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { DbExecutor } from '../db/contracts';
import type { SessaoAdmin } from '../autenticacao/service.ts';
import { erroAcesso } from '../acessos/erros.ts';
import { exigirReautenticacaoRecente } from '../desenvolvedor/autorizacao.ts';
import { AsaasFalhou, type ProvedorCreditos } from '../assinatura/asaas.ts';
import { flagsCreditos } from './config.ts';
import { gerarProtocolo, opcaoDevolucao, PROTOCOLO, REGRA_DEVOLUCAO_PACOTE, type Forma, type TipoDevolucaoPacote } from './dominio.ts';
import { bloquearDisponivel, cancelarBloqueado, creditosInstalados, lerCarteira } from './ledger.ts';
import { enfileirarNotificacao } from './notificacoes.ts';
import { auditarCreditos } from './auditoria.ts';
import { exigirGestao, naoInstalados, type DepsCreditos } from './compra.ts';
import type { Recurso } from './catalogo.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type RespostaDevolucao = { protocolo: string; pedidoProtocolo: string; tipo: TipoDevolucaoPacote; valorCentavos: number; quantidadeCancelada: number; prazo: string;
    estado: string; estornoAutomatico: boolean; repetido: boolean };

type Lote = { id: string; quantidade: string; disponivel: string; reservado: string; bloqueado: string; consumido: string; expirado: string; cancelado: string; liberado_ms: string; vence_ms: string };
type Alvo = { pedido: { id: string; protocolo: string; empresa_id: string; recurso: Recurso; preco_centavos: string; forma: Forma; estado: string };
    lote: Lote | null; cobranca: { id: string; pagamento_id: string } | null; devolucao: boolean };

async function lerAlvo(tx: DbExecutor, empresaId: string, protocoloPedido: string, travar: boolean): Promise<Alvo | null> {
    const pedido = (await tx.query<Alvo['pedido']>(`SELECT id, protocolo, empresa_id, recurso, preco_centavos, forma, estado FROM ia_credito_pedidos
        WHERE empresa_id = $1::uuid AND protocolo = $2 ${travar ? 'FOR UPDATE' : ''}`, [empresaId, protocoloPedido])).rows[0];
    if (!pedido) return null;
    if (travar) await lerCarteira(tx, empresaId, pedido.recurso, true);
    const lote = (await tx.query<Lote>(`SELECT id, quantidade, disponivel, reservado, bloqueado, consumido, expirado, cancelado,
        (extract(epoch FROM liberado_em) * 1000)::bigint AS liberado_ms, (extract(epoch FROM vence_em) * 1000)::bigint AS vence_ms
        FROM ia_credito_lotes WHERE pedido_id = $1::uuid AND empresa_id = $2::uuid ${travar ? 'FOR UPDATE' : ''}`, [pedido.id, empresaId])).rows[0] ?? null;
    const cobranca = (await tx.query<{ id: string; pagamento_id: string }>('SELECT id, pagamento_id FROM ia_credito_cobrancas WHERE pedido_id = $1::uuid AND canonica', [pedido.id])).rows[0] ?? null;
    const devolucao = (await tx.query('SELECT 1 FROM ia_credito_devolucoes WHERE pedido_id = $1::uuid', [pedido.id])).rows.length > 0;
    return { pedido, lote, cobranca, devolucao };
}
async function agora(tx: DbExecutor) {
    return Number((await tx.query<{ t: string }>('SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS t')).rows[0].t);
}
const loteParaRegra = (l: Lote) => ({ quantidade: Number(l.quantidade), disponivel: Number(l.disponivel), reservado: Number(l.reservado), bloqueado: Number(l.bloqueado),
    consumido: Number(l.consumido), expirado: Number(l.expirado), cancelado: Number(l.cancelado), liberadoEm: Number(l.liberado_ms), venceEm: Number(l.vence_ms) });

/** Opção de devolução de um pedido (leitura; usada pela tela). */
export async function opcaoDoPedido(tx: DbExecutor, empresaId: string, protocoloPedido: string) {
    const a = await lerAlvo(tx, empresaId, protocoloPedido, false);
    if (!a || a.pedido.estado !== 'CREDITADO' || !a.lote || !a.cobranca) return { disponivel: false as const, motivo: 'PEDIDO_SEM_CREDITO' };
    return opcaoDevolucao(loteParaRegra(a.lote), Number(a.pedido.preco_centavos), await agora(tx), a.devolucao);
}

type Registro = { empresaId: string; protocoloPedido: string; tipo: TipoDevolucaoPacote; valorEsperado: number; chave: string; solicitadoPor: string; origem: 'GESTAO' | 'ATENDIMENTO' };
/** A. registro atômico (transação do chamador, tenant já comprovado). */
export async function registrarDevolucao(tx: DbExecutor, r: Registro) {
    if (!await creditosInstalados(tx)) throw naoInstalados();
    const anterior = (await tx.query<{ protocolo: string }>('SELECT protocolo FROM ia_credito_devolucoes WHERE empresa_id = $1::uuid AND chave_idempotencia = $2::uuid',
        [r.empresaId, r.chave])).rows[0];
    if (anterior) return { repetido: true as const, ...(await resumo(tx, r.empresaId, anterior.protocolo)) };
    const a = await lerAlvo(tx, r.empresaId, r.protocoloPedido, true);
    if (!a) throw erroAcesso('NAO_ENCONTRADO', 'Pedido não encontrado.', 404);
    if (a.pedido.estado !== 'CREDITADO' || !a.lote || !a.cobranca) throw erroAcesso('CONFLITO', 'Este pedido ainda não teve créditos liberados.', 409);
    const opcao = opcaoDevolucao(loteParaRegra(a.lote), Number(a.pedido.preco_centavos), await agora(tx), a.devolucao);
    if (!opcao.disponivel) throw erroAcesso('CONFLITO', 'A devolução não está disponível para este pacote agora.', 409, { motivo: opcao.motivo });
    const c = opcao.calculo;
    if (c.tipo !== r.tipo || c.valorCentavos !== r.valorEsperado)
        throw erroAcesso('OFERTA_ALTERADA', 'O valor da devolução mudou desde que a tela foi aberta. Confira e confirme de novo.', 409, { valorCentavos: c.valorCentavos, tipo: c.tipo });
    const id = randomUUID();
    let protocolo = '';
    for (let tentativa = 0; ; tentativa += 1) {
        protocolo = gerarProtocolo(Date.now(), randomBytes(8));
        if (!PROTOCOLO.test(protocolo)) throw new Error('Protocolo inválido.');
        await tx.query('SAVEPOINT kidmais_090_devolucao');
        try {
            await tx.query(`INSERT INTO ia_credito_devolucoes (id, empresa_id, pedido_id, cobranca_id, lote_id, protocolo, tipo, origem, chave_idempotencia, solicitado_por, regra,
                    quantidade_comprada, quantidade_consumida, quantidade_cancelada, valor_pago_centavos, valor_centavos, forma, prazo, estado)
                VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8, $9::uuid, $10::uuid, $11, $12, $13, $14, $15, $16, $17, $18::date, 'AGUARDANDO_MANUAL')`,
            [id, r.empresaId, a.pedido.id, a.cobranca.id, a.lote.id, protocolo, c.tipo, r.origem, r.chave, r.solicitadoPor, REGRA_DEVOLUCAO_PACOTE,
                Number(a.lote.quantidade), c.quantidadeConsumida, c.quantidadeCancelada, Number(a.pedido.preco_centavos), c.valorCentavos, a.pedido.forma, c.prazo]);
            await tx.query('RELEASE SAVEPOINT kidmais_090_devolucao');
            break;
        }
        catch (error) {
            await tx.query('ROLLBACK TO SAVEPOINT kidmais_090_devolucao');
            const e = error as { code?: string; constraint?: string };
            if (e.code !== '23505' || e.constraint !== 'ia_credito_devolucoes_protocolo_key' || tentativa >= 1) throw error;
        }
    }
    // Remanescente cancelado na mesma transação (as reservas abertas desse lote terminam sem reabrir crédito: ledger.ts).
    await bloquearDisponivel(tx, r.empresaId, a.pedido.recurso, a.lote.id, `DEVOLUCAO:${id}`, r.origem === 'GESTAO' ? 'GESTAO' : 'PLATAFORMA', protocolo);
    await cancelarBloqueado(tx, r.empresaId, a.pedido.recurso, a.lote.id, `DEVOLUCAO:${id}`, r.origem === 'GESTAO' ? 'GESTAO' : 'PLATAFORMA', protocolo);
    await enfileirarNotificacao(tx, { empresaId: r.empresaId, tipo: 'DEVOLUCAO_REGISTRADA', dedupe: `DEVOLUCAO_REGISTRADA:${id}`, protocolo });
    await enfileirarNotificacao(tx, { empresaId: r.empresaId, tipo: 'AVISO_INTERNO_DEVOLUCAO', dedupe: `AVISO_INTERNO_DEVOLUCAO:${id}`, protocolo });
    await auditarCreditos(tx, { usuarioId: r.solicitadoPor, acao: 'CREDITOS_DEVOLUCAO_REGISTRADA', entidadeTipo: 'IA_CREDITO_DEVOLUCAO', entidadeId: id,
        dados: { protocolo, pedido: a.pedido.protocolo, tipo: c.tipo, valorCentavos: c.valorCentavos, quantidadeCancelada: c.quantidadeCancelada, origem: r.origem } });
    return { repetido: false as const, id, pagamentoId: a.cobranca.pagamento_id, forma: a.pedido.forma, ...(await resumo(tx, r.empresaId, protocolo)) };
}

async function resumo(tx: DbExecutor, empresaId: string, protocolo: string) {
    const d = (await tx.query<{ protocolo: string; pedido: string; tipo: TipoDevolucaoPacote; valor_centavos: string; quantidade_cancelada: string; prazo: string; estado: string }>(
        `SELECT d.protocolo, p.protocolo AS pedido, d.tipo, d.valor_centavos, d.quantidade_cancelada, to_char(d.prazo, 'YYYY-MM-DD') AS prazo, d.estado
         FROM ia_credito_devolucoes d JOIN ia_credito_pedidos p ON p.id = d.pedido_id AND p.empresa_id = d.empresa_id WHERE d.empresa_id = $1::uuid AND d.protocolo = $2`,
        [empresaId, protocolo])).rows[0];
    return { protocolo: d.protocolo, pedidoProtocolo: d.pedido, tipo: d.tipo, valorCentavos: Number(d.valor_centavos), quantidadeCancelada: Number(d.quantidade_cancelada),
        prazo: d.prazo, estado: d.estado };
}

/** B. estorno automático (flag + Pix/cartão), registro prévio antes do POST, sem repetição em resultado desconhecido. */
export async function estornarSePermitido(deps: Pick<DepsCreditos, 'withTransaction' | 'env'> & { provedor: () => Pick<ProvedorCreditos, 'estornarCobranca'> | null },
    empresaId: string, devolucaoId: string, pagamentoId: string, forma: Forma, valorCentavos: number, protocolo: string) {
    const env = deps.env ?? process.env;
    const prov = deps.provedor();
    if (!flagsCreditos(env).estorno || forma === 'BOLETO' || !prov?.estornarCobranca) return 'AGUARDANDO_MANUAL';
    const marcado = await deps.withTransaction(async (tx) => (await tx.query(`UPDATE ia_credito_devolucoes SET estado = 'EM_CURSO', modo = 'AUTOMATICO'
        WHERE id = $1::uuid AND empresa_id = $2::uuid AND estado = 'AGUARDANDO_MANUAL' RETURNING id`, [devolucaoId, empresaId])).rowCount === 1).catch(() => false);
    if (!marcado) return 'AGUARDANDO_MANUAL';
    let estado: 'SOLICITADO' | 'SEM_CONFIRMACAO' | 'RECUSADO';
    let status: string | null = null;
    try {
        status = (await prov.estornarCobranca(pagamentoId, valorCentavos, `Kidmais Manager - devolucao de creditos ${protocolo}`)).status;
        estado = 'SOLICITADO';
    }
    catch (error) {
        estado = error instanceof AsaasFalhou && error.status !== null && error.status >= 400 && error.status < 500 && ![408, 409, 429].includes(error.status) ? 'RECUSADO' : 'SEM_CONFIRMACAO';
    }
    try {
        await deps.withTransaction((tx) => tx.query(`UPDATE ia_credito_devolucoes SET estado = $2, status_provedor = $3 WHERE id = $1::uuid AND estado = 'EM_CURSO'`,
            [devolucaoId, estado, status && /^[A-Z_]{1,40}$/.test(status) ? status : null]));
    }
    catch { console.error('[creditos] resultado do estorno não gravado (fica EM_CURSO para conferência manual)'); return 'EM_CURSO'; }
    return estado;
}

export async function solicitarDevolucao(sessao: SessaoAdmin, empresaSolicitada: string | null | undefined, raw: unknown,
    deps: DepsCreditos & { provedorEstorno?: () => Pick<ProvedorCreditos, 'estornarCobranca'> | null }): Promise<RespostaDevolucao> {
    const corpo = (raw ?? {}) as Record<string, unknown>;
    if (typeof corpo.pedido !== 'string' || !PROTOCOLO.test(corpo.pedido)) throw erroAcesso('DADOS_INVALIDOS', 'Pedido inválido.', 400, { campo: 'pedido' });
    if (corpo.tipo !== 'ARREPENDIMENTO_7_DIAS' && corpo.tipo !== 'SALDO_NAO_UTILIZADO') throw erroAcesso('DADOS_INVALIDOS', 'Tipo de devolução inválido.', 400, { campo: 'tipo' });
    if (corpo.confirmar !== true) throw erroAcesso('DADOS_INVALIDOS', 'Confirme a devolução.', 400, { campo: 'confirmar' });
    if (!Number.isSafeInteger(corpo.valorEsperadoCentavos) || (corpo.valorEsperadoCentavos as number) <= 0) throw erroAcesso('DADOS_INVALIDOS', 'Valor ausente: atualize a página.', 400);
    if (typeof corpo.chave !== 'string' || !UUID.test(corpo.chave)) throw erroAcesso('DADOS_INVALIDOS', 'Atualize a página e tente de novo.', 400, { campo: 'chave' });
    exigirReautenticacaoRecente(sessao);
    const r = await deps.withTenantTransaction(sessao, empresaSolicitada, async (tx, tenant) => {
        exigirGestao(tenant);
        const registro = await registrarDevolucao(tx, { empresaId: tenant.empresaComprovada, protocoloPedido: corpo.pedido as string, tipo: corpo.tipo as TipoDevolucaoPacote,
            valorEsperado: corpo.valorEsperadoCentavos as number, chave: (corpo.chave as string).toLowerCase(), solicitadoPor: sessao.usuario_id, origem: 'GESTAO' });
        return { ...registro, empresaId: tenant.empresaComprovada };
    });
    const env = deps.env ?? process.env;
    let estado = r.estado;
    if (!r.repetido)
        estado = await estornarSePermitido({ ...deps, provedor: deps.provedorEstorno ?? (() => deps.provedor()?.cliente ?? null) }, r.empresaId,
            r.id, r.pagamentoId, r.forma, r.valorCentavos, r.protocolo);
    return { protocolo: r.protocolo, pedidoProtocolo: r.pedidoProtocolo, tipo: r.tipo, valorCentavos: r.valorCentavos, quantidadeCancelada: r.quantidadeCancelada,
        prazo: r.prazo, estado, estornoAutomatico: flagsCreditos(env).estorno, repetido: r.repetido };
}
