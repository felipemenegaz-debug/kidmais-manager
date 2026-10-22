/**
 * Compra avulsa de pacotes de créditos de IA (095) pela tela Assinatura → Créditos de IA. Só a Gestão, com senha
 * confirmada há ≤ 5 min (como a devolução da 089), resumo e confirmação explícita na tela.
 *
 *   A. transação curta (tenant): Gestão, 095 instalada, idempotência (mesma chave + mesmo conteúdo devolve o pedido;
 *      conteúdo diferente = conflito), assinatura apta, carteira de Convites já cortada do legado, limites persistentes
 *      (pedidos/hora por pessoa e por empresa, pendentes, total do dia) e o pedido em CRIACAO_EM_CURSO com protocolo,
 *      fotografia da oferta, versão/hash dos termos e vencimento — tudo calculado no servidor;
 *   B. fora de transação: UM POST de cobrança avulsa (nunca repetido). 4xx definitivo = FALHOU_CRIACAO (nada criado);
 *      timeout/rede/5xx/resposta inválida = CRIACAO_INCERTA (procura pela referência, leitura; nunca outro POST);
 *   C. transação curta: vínculo durável pedido ↔ pagamento (AGUARDANDO_PAGAMENTO).
 * Criar a cobrança NÃO libera crédito: só a confirmação reconsultada (lib/creditos/pagamento.ts). Cobrança avulsa nunca
 * passa pelo sincronizador da assinatura (não ativa nem renova assinatura).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DbExecutor } from '../db/contracts';
import type { SessaoAdmin } from '../autenticacao/service.ts';
import type { TenantComprovado } from '../saas/provar-tenant.ts';
import { erroAcesso } from '../acessos/erros.ts';
import { exigirReautenticacaoRecente } from '../desenvolvedor/autorizacao.ts';
import { lerEstadoComercial } from '../assinatura/estado.ts';
import { AsaasFalhou, urlDeFaturaValida, type CobrancaProvedor, type ProvedorCreditos } from '../assinatura/asaas.ts';
import { CATALOGO_VIGENTE, fotografiaOferta, ofertaPorCodigo, termosSha256, validarCatalogo, type Catalogo } from './catalogo.ts';
import { contaProvedor, LIMITES, vendaAberta, walleDisponivel } from './config.ts';
import { BILLING_TYPE, FORMAS, gerarProtocolo, PROTOCOLO, referenciaExterna, vencimentoPagamento, type Forma } from './dominio.ts';
import { creditosInstalados, lerCarteira } from './ledger.ts';
import { vincularCobrancaCriada, type ContextoProvedor } from './pagamento.ts';
import { auditarCreditos } from './auditoria.ts';

export const GESTAO = 'REPRESENTANTE_AUTORIZADO';
type Env = Record<string, string | undefined>;
export type ConsumirLimite = (tx: DbExecutor, tipo: 'IDENTIFICADOR' | 'ORIGEM', valor: string, regra: { namespace?: string; janelaSegundos: number; limite: number }) => Promise<boolean>;
export type DepsCreditos = {
    withTenantTransaction: <T>(sessao: SessaoAdmin, empresaSolicitada: string | null | undefined, trabalho: (tx: DbExecutor, tenant: TenantComprovado) => Promise<T>) => Promise<T>;
    withTransaction: <T>(trabalho: (tx: DbExecutor) => Promise<T>) => Promise<T>;
    provedor: () => { cliente: ProvedorCreditos; ambiente: 'sandbox' | 'producao' } | null;
    consumirLimite: ConsumirLimite;
    env?: Env;
    catalogo?: Catalogo;
};

export const naoInstalados = () => erroAcesso('COBRANCA_NAO_CONFIGURADA', 'Os créditos de IA ainda não estão disponíveis neste ambiente.', 503);
export function exigirGestao(tenant: TenantComprovado) {
    if (tenant.papelAtual !== GESTAO) throw erroAcesso('COBRANCA_SEM_PERMISSAO', 'Somente a Gestão desta empresa compra créditos ou pede devolução.', 403);
}
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v), 'utf8').digest('hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RespostaPedido = { protocolo: string; estado: string; recurso: string; ofertaCodigo: string; quantidadeExibida: number; precoCentavos: number; forma: Forma;
    vencimentoPagamento: string; urlPagamento: string | null; repetido: boolean; mensagem: string };
const MENSAGEM: Record<string, string> = {
    CRIACAO_EM_CURSO: 'Estamos gerando a cobrança. Não repita o pedido: acompanhe pelo protocolo.',
    CRIACAO_INCERTA: 'Estamos confirmando a criação da cobrança com o Asaas. Não repita o pedido: acompanhe pelo protocolo.',
    FALHOU_CRIACAO: 'O Asaas recusou a criação da cobrança. Nada foi cobrado; você pode tentar de novo.',
    AGUARDANDO_PAGAMENTO: 'Pagamento em confirmação. Os créditos serão liberados após a confirmação do Asaas.',
    VENCIDO: 'O prazo de pagamento terminou. Se você já pagou, os créditos serão liberados quando o Asaas confirmar.',
    CREDITADO: 'Pagamento confirmado: créditos liberados.',
    REVISAO: 'O pedido está em conferência pela equipe Kidmais. Guarde o protocolo.',
    ENCERRADO: 'Pedido encerrado sem cobrança.',
};

type LinhaPedido = { id: string; protocolo: string; estado: string; recurso: string; oferta_codigo: string; oferta: { quantidadeExibida?: number }; preco_centavos: string;
    forma: Forma; vencimento: string; payload_sha256: string; url: string | null };
const SELECT_PEDIDO = `SELECT p.id, p.protocolo, p.estado, p.recurso, p.oferta_codigo, p.oferta, p.preco_centavos, p.forma, to_char(p.vencimento_pagamento, 'YYYY-MM-DD') AS vencimento,
    p.payload_sha256, (SELECT c.url_fatura FROM ia_credito_cobrancas c WHERE c.pedido_id = p.id AND c.canonica) AS url FROM ia_credito_pedidos p`;
function resposta(p: LinhaPedido, repetido: boolean): RespostaPedido {
    return { protocolo: p.protocolo, estado: p.estado, recurso: p.recurso, ofertaCodigo: p.oferta_codigo, quantidadeExibida: Number(p.oferta?.quantidadeExibida ?? 0),
        precoCentavos: Number(p.preco_centavos), forma: p.forma, vencimentoPagamento: p.vencimento,
        urlPagamento: ['AGUARDANDO_PAGAMENTO', 'VENCIDO'].includes(p.estado) && p.url && urlDeFaturaValida(p.url) ? p.url : null, repetido, mensagem: MENSAGEM[p.estado] ?? '' };
}

/** Assinatura apta: acesso completo e cliente do provedor já criado (a compra usa o mesmo cliente, nunca o cartão salvo). */
async function clienteApto(tx: DbExecutor, empresaId: string) {
    const comercial = await lerEstadoComercial(tx, empresaId);
    const a = (await tx.query<{ situacao: string; cliente: string | null }>(
        "SELECT situacao, provedor_cliente_id AS cliente FROM empresa_assinaturas WHERE empresa_id = $1::uuid AND provedor = 'ASAAS'", [empresaId])).rows[0];
    if (comercial.acesso.nivel !== 'COMPLETO' || !a?.cliente || !['ATIVA', 'CANCELADA_FIM_PERIODO'].includes(a.situacao))
        throw erroAcesso('ASSINATURA_NECESSARIA', 'A compra de créditos exige uma assinatura paga ativa.', 409);
    return a.cliente;
}

export async function criarPedido(sessao: SessaoAdmin, empresaSolicitada: string | null | undefined, raw: unknown, deps: DepsCreditos): Promise<RespostaPedido> {
    const env = deps.env ?? process.env;
    const cat = deps.catalogo ?? CATALOGO_VIGENTE;
    validarCatalogo(cat);
    const corpo = (raw ?? {}) as Record<string, unknown>;
    const oferta = ofertaPorCodigo(cat, corpo.oferta);
    if (!oferta) throw erroAcesso('DADOS_INVALIDOS', 'Escolha um pacote.', 400, { campo: 'oferta' });
    if (typeof corpo.forma !== 'string' || !FORMAS.includes(corpo.forma as Forma)) throw erroAcesso('DADOS_INVALIDOS', 'Escolha Pix, cartão ou boleto.', 400, { campo: 'forma' });
    if (corpo.confirmar !== true) throw erroAcesso('DADOS_INVALIDOS', 'Confirme o resumo da compra.', 400, { campo: 'confirmar' });
    if (corpo.termosVersao !== cat.termos.versao) throw erroAcesso('OFERTA_ALTERADA', 'As condições mudaram desde que a tela foi aberta. Confira e confirme de novo.', 409);
    if (corpo.precoEsperadoCentavos !== oferta.precoCentavos) throw erroAcesso('OFERTA_ALTERADA', 'O preço mudou desde que a tela foi aberta. Confira e confirme de novo.', 409);
    if (typeof corpo.chave !== 'string' || !UUID.test(corpo.chave)) throw erroAcesso('DADOS_INVALIDOS', 'Atualize a página e tente de novo.', 400, { campo: 'chave' });
    const forma = corpo.forma as Forma;
    const chave = corpo.chave.toLowerCase();
    exigirReautenticacaoRecente(sessao);
    const venda = vendaAberta(cat, env);
    if (!venda.ok) throw erroAcesso('COBRANCA_NAO_CONFIGURADA', 'A compra de créditos não está disponível neste ambiente.', 503, { motivo: venda.motivo });
    if (oferta.recurso === 'WALLE' && !walleDisponivel(env)) throw erroAcesso('CONFLITO', 'O Wall-e não está disponível: não há compra de créditos para ele agora.', 409);
    const prov = deps.provedor();
    if (!prov) throw erroAcesso('COBRANCA_NAO_CONFIGURADA', 'A cobrança on-line não está disponível neste ambiente.', 503);
    const termos = termosSha256(cat);
    const payload = sha({ oferta: oferta.codigo, forma, catalogo: cat.versao, termos, preco: oferta.precoCentavos });

    // A. pedido (ou o já registrado com a mesma chave).
    const a = await deps.withTenantTransaction(sessao, empresaSolicitada, async (tx, tenant) => {
        exigirGestao(tenant);
        if (!await creditosInstalados(tx)) throw naoInstalados();
        const empresaId = tenant.empresaComprovada;
        await tx.query("SELECT pg_advisory_xact_lock(hashtext('ia_credito_pedido:' || $1::text))", [empresaId]);
        const anterior = (await tx.query<LinhaPedido>(`${SELECT_PEDIDO} WHERE p.empresa_id = $1::uuid AND p.chave_idempotencia = $2::uuid`, [empresaId, chave])).rows[0];
        if (anterior) {
            if (anterior.payload_sha256 !== payload) throw erroAcesso('CONFLITO', 'Esta confirmação já foi usada para outro pedido. Atualize a página.', 409);
            return { anterior, novo: null };
        }
        const cliente = await clienteApto(tx, empresaId);
        if (oferta.recurso === 'CONVITES' && !await lerCarteira(tx, empresaId, 'CONVITES'))
            throw erroAcesso('CONFLITO', 'Os créditos de Convites desta empresa ainda seguem a franquia mensal anterior. A compra fica disponível depois da migração da carteira.', 409);
        const limites = [
            await deps.consumirLimite(tx, 'IDENTIFICADOR', `${sessao.usuario_id}`, { namespace: 'CREDITOS_PEDIDO_USUARIO', janelaSegundos: 3600, limite: LIMITES.pedidosPorHoraUsuario }),
            await deps.consumirLimite(tx, 'IDENTIFICADOR', `${empresaId}`, { namespace: 'CREDITOS_PEDIDO_EMPRESA', janelaSegundos: 3600, limite: LIMITES.pedidosPorHoraEmpresa }),
        ];
        if (limites.some((ok) => !ok)) return { limite: 'Muitos pedidos em pouco tempo. Tente novamente mais tarde.' as const };
        const uso = (await tx.query<{ pendentes: number; hoje: string }>(`SELECT
            count(*) FILTER (WHERE estado IN ('CRIACAO_EM_CURSO', 'CRIACAO_INCERTA', 'AGUARDANDO_PAGAMENTO'))::int AS pendentes,
            coalesce(sum(preco_centavos) FILTER (WHERE estado NOT IN ('FALHOU_CRIACAO', 'ENCERRADO')
              AND (criado_em AT TIME ZONE 'America/Sao_Paulo')::date = (clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date), 0) AS hoje
          FROM ia_credito_pedidos WHERE empresa_id = $1::uuid`, [empresaId])).rows[0];
        if (uso.pendentes >= LIMITES.pedidosPendentesPorEmpresa)
            return { limite: 'Há pedidos aguardando pagamento. Conclua ou aguarde o vencimento deles antes de um novo.' as const };
        if (Number(uso.hoje) + oferta.precoCentavos > LIMITES.compraDiariaCentavos)
            return { limite: 'O limite diário de compras de créditos foi atingido. Tente amanhã ou fale com o atendimento.' as const };
        const agora = Number((await tx.query<{ t: string }>('SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint AS t')).rows[0].t);
        for (let tentativa = 0; ; tentativa += 1) {
            const protocolo = gerarProtocolo(agora, randomBytes(8));
            if (!PROTOCOLO.test(protocolo)) throw new Error('Protocolo inválido.');
            await tx.query('SAVEPOINT kidmais_095_protocolo');
            try {
                const id = randomUUID();
                await tx.query(`INSERT INTO ia_credito_pedidos (id, empresa_id, protocolo, recurso, catalogo_versao, oferta_codigo, oferta, termos_versao, termos_sha256,
                        quantidade, preco_centavos, validade_dias, forma, ambiente, chave_idempotencia, payload_sha256, estado, solicitado_por, vencimento_pagamento)
                    VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12, $13, $14, $15::uuid, $16, 'CRIACAO_EM_CURSO', $17::uuid, $18::date)`,
                [id, empresaId, protocolo, oferta.recurso, cat.versao, oferta.codigo, JSON.stringify(fotografiaOferta(cat, oferta)), cat.termos.versao, termos,
                    oferta.quantidade, oferta.precoCentavos, oferta.validadeDias, forma, prov.ambiente, chave, payload, sessao.usuario_id,
                    vencimentoPagamento(agora, LIMITES.vencimentoDias)]);
                await tx.query('RELEASE SAVEPOINT kidmais_095_protocolo');
                await auditarCreditos(tx, { usuarioId: sessao.usuario_id, acao: 'CREDITOS_PEDIDO_CRIADO', entidadeTipo: 'IA_CREDITO_PEDIDO', entidadeId: id,
                    dados: { protocolo, recurso: oferta.recurso, oferta: oferta.codigo, precoCentavos: oferta.precoCentavos, forma } });
                const novo = (await tx.query<LinhaPedido>(`${SELECT_PEDIDO} WHERE p.id = $1::uuid`, [id])).rows[0];
                return { anterior: null, novo, cliente, empresaId };
            }
            catch (error) {
                await tx.query('ROLLBACK TO SAVEPOINT kidmais_095_protocolo');
                const e = error as { code?: string; constraint?: string };
                if (e.code !== '23505' || e.constraint !== 'ia_credito_pedidos_protocolo_key' || tentativa >= 1) throw error;
            }
        }
    });
    if ('limite' in a) throw erroAcesso('LIMITE_TENTATIVAS', a.limite as string, 429);
    if (a.anterior) return resposta(a.anterior, true);
    const pedido = a.novo!;
    const ctx: ContextoProvedor = { provedor: prov.cliente, ambiente: prov.ambiente, conta: contaProvedor(env) };

    // B. um único POST (fora de transação).
    let criada: CobrancaProvedor | null = null;
    let estadoFinal: 'FALHOU_CRIACAO' | 'CRIACAO_INCERTA' | null = null;
    try {
        criada = await prov.cliente.criarCobrancaAvulsa({ cliente: a.cliente!, forma: BILLING_TYPE[forma], valorCentavos: oferta.precoCentavos, vencimento: pedido.vencimento,
            descricao: `Kidmais Manager - creditos de IA ${pedido.protocolo}`, referencia: referenciaExterna(prov.ambiente, pedido.id) });
    }
    catch (error) {
        estadoFinal = error instanceof AsaasFalhou && error.motivo === 'HTTP' && error.status !== null && error.status >= 400 && error.status < 500 && ![408, 409, 425, 429].includes(error.status)
            ? 'FALHOU_CRIACAO' : 'CRIACAO_INCERTA';
    }
    // C. vínculo durável (ou o resultado da falha). Se esta gravação falhar, o pedido fica CRIACAO_EM_CURSO e a reconciliação o encontra pela referência.
    try {
        await deps.withTransaction(async (tx) => {
            if (criada) await vincularCobrancaCriada(tx, pedido.id, ctx, criada);
            else await tx.query(`UPDATE ia_credito_pedidos SET estado = $2 WHERE id = $1::uuid AND estado = 'CRIACAO_EM_CURSO'`, [pedido.id, estadoFinal]);
        });
    }
    catch (error) {
        console.error('[creditos] resultado da criação da cobrança não gravado (reconciliação procura pela referência)', error instanceof Error ? error.name : typeof error);
    }
    const atual = await deps.withTransaction(async (tx) => (await tx.query<LinhaPedido>(`${SELECT_PEDIDO} WHERE p.id = $1::uuid`, [pedido.id])).rows[0]);
    return resposta(atual, false);
}

/** Situação de um pedido da própria empresa (polling da tela; outra aba; retorno da fatura). Não consulta o provedor. */
export async function consultarPedido(sessao: SessaoAdmin, empresaSolicitada: string | null | undefined, protocolo: unknown, deps: Pick<DepsCreditos, 'withTenantTransaction'>) {
    if (typeof protocolo !== 'string' || !PROTOCOLO.test(protocolo)) throw erroAcesso('DADOS_INVALIDOS', 'Protocolo inválido.', 400);
    return deps.withTenantTransaction(sessao, empresaSolicitada, async (tx, tenant) => {
        exigirGestao(tenant);
        if (!await creditosInstalados(tx)) throw naoInstalados();
        const p = (await tx.query<LinhaPedido>(`${SELECT_PEDIDO} WHERE p.empresa_id = $1::uuid AND p.protocolo = $2`, [tenant.empresaComprovada, protocolo])).rows[0];
        if (!p) throw erroAcesso('NAO_ENCONTRADO', 'Pedido não encontrado.', 404);
        return resposta(p, false);
    });
}
