/**
 * Leitura da tela Assinatura → Créditos de IA (090). Empresa e papel sempre da sessão (withTenantTransaction).
 * Qualquer pessoa da empresa vê o saldo; só a Gestão vê pedidos, cobranças, devoluções, extrato e o catálogo.
 * Sem a 090: { instalado: false } e a tela mostra só o modelo atual (franquia mensal), sem erro.
 */
import type { DbExecutor } from '../db/contracts';
import type { SessaoAdmin } from '../autenticacao/service.ts';
import { urlDeFaturaValida } from '../assinatura/asaas.ts';
import { CATALOGO_VIGENTE, termosSha256, type Catalogo, type Recurso } from './catalogo.ts';
import { catalogoVisivel, flagsCreditos, vendaAberta, walleDisponivel } from './config.ts';
import { avisoSaldo, exibir } from './dominio.ts';
import { creditosInstalados, resumoCarteira, type ResumoCarteira } from './ledger.ts';
import { opcaoDoPedido } from './devolucao.ts';
import { GESTAO, type DepsCreditos } from './compra.ts';

type Env = Record<string, string | undefined>;
const ISO = (c: string) => `to_char(${c} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

function carteiraParaTela(w: ResumoCarteira) {
    const e = (q: number) => exibir(w.recurso, q);
    return { recurso: w.recurso, disponivel: e(w.disponivel), reservado: e(w.reservado), bloqueado: e(w.bloqueado), corteEm: w.corteEm,
        aviso: avisoSaldo(w.disponivel, w.referencia),
        lotes: w.lotes.map((l) => ({ origem: l.origem, quantidade: e(l.quantidade), disponivel: e(l.disponivel), reservado: e(l.reservado), consumido: e(l.consumido),
            expirado: e(l.expirado), cancelado: e(l.cancelado), liberadoEm: l.liberadoEm, venceEm: l.venceEm, protocolo: l.protocolo })) };
}

async function legadoConvites(tx: DbExecutor, empresaId: string) {
    const r = (await tx.query<{ limite: number; usado: number }>(`SELECT CASE WHEN w.ativo THEN w.limite_mensal ELSE 0 END AS limite, coalesce(u.usado, 0)::int AS usado
        FROM convite_carteiras w LEFT JOIN convite_consumos u ON u.empresa_id = w.empresa_id AND u.mes = date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')::date
        WHERE w.empresa_id = $1::uuid`, [empresaId])).rows[0];
    return { limiteMensal: r?.limite ?? 0, usadoNoMes: r?.usado ?? 0 };
}

export async function consultarCreditos(sessao: SessaoAdmin, empresaSolicitada: string | null | undefined, deps: Pick<DepsCreditos, 'withTenantTransaction'> & { env?: Env; catalogo?: Catalogo }) {
    const env = deps.env ?? process.env;
    const cat = deps.catalogo ?? CATALOGO_VIGENTE;
    return deps.withTenantTransaction(sessao, empresaSolicitada, async (tx, tenant) => {
        const empresaId = tenant.empresaComprovada;
        const gestao = tenant.papelAtual === GESTAO;
        const legado = await legadoConvites(tx, empresaId);
        const walle = walleDisponivel(env);
        if (!await creditosInstalados(tx))
            return { instalado: false as const, gestao, walleDisponivel: walle, convites: { motor: 'LEGADO' as const, legado } };
        const convites = await resumoCarteira(tx, empresaId, 'CONVITES');
        const carteiraWalle = await resumoCarteira(tx, empresaId, 'WALLE');
        const emVerificacao = Number((await tx.query<{ n: string }>("SELECT count(*) AS n FROM convite_geracoes WHERE empresa_id = $1::uuid AND estado = 'INCERTA'", [empresaId])).rows[0].n);
        const base = {
            instalado: true as const, gestao, walleDisponivel: walle,
            consumoConvitesAtivo: flagsCreditos(env).consumoConvites,
            convites: convites ? { motor: 'CREDITOS' as const, ...carteiraParaTela(convites), emVerificacao } : { motor: 'LEGADO' as const, legado, emVerificacao },
            walle: carteiraWalle && walle ? carteiraParaTela(carteiraWalle) : null,
        };
        if (!gestao) return base;
        const pedidos = (await tx.query<Record<string, unknown>>(`SELECT p.protocolo, p.estado, p.recurso, p.oferta_codigo, p.oferta, p.preco_centavos, p.forma,
                ${ISO('p.criado_em')} AS criado, to_char(p.vencimento_pagamento, 'YYYY-MM-DD') AS vencimento, ${ISO('p.creditado_em')} AS creditado,
                c.url_fatura, c.disputa, d.protocolo AS devolucao_protocolo, d.estado AS devolucao_estado, d.valor_centavos AS devolucao_valor, to_char(d.prazo, 'YYYY-MM-DD') AS devolucao_prazo,
                d.tipo AS devolucao_tipo
            FROM ia_credito_pedidos p LEFT JOIN ia_credito_cobrancas c ON c.pedido_id = p.id AND c.canonica
            LEFT JOIN ia_credito_devolucoes d ON d.pedido_id = p.id AND d.empresa_id = p.empresa_id
            WHERE p.empresa_id = $1::uuid ORDER BY p.criado_em DESC LIMIT 30`, [empresaId])).rows;
        const lista = [];
        for (const p of pedidos) {
            const recurso = p.recurso as Recurso;
            const opcao = p.estado === 'CREDITADO' && !p.devolucao_protocolo ? await opcaoDoPedido(tx, empresaId, String(p.protocolo)) : null;
            lista.push({
                protocolo: p.protocolo, estado: p.estado, recurso, ofertaCodigo: p.oferta_codigo, nome: (p.oferta as { nome?: string })?.nome ?? '',
                quantidadeExibida: Number((p.oferta as { quantidadeExibida?: number })?.quantidadeExibida ?? 0), precoCentavos: Number(p.preco_centavos), forma: p.forma,
                criadoEm: p.criado, vencimentoPagamento: p.vencimento, creditadoEm: p.creditado,
                urlPagamento: ['AGUARDANDO_PAGAMENTO', 'VENCIDO'].includes(String(p.estado)) && typeof p.url_fatura === 'string' && urlDeFaturaValida(p.url_fatura) ? p.url_fatura : null,
                emDisputa: p.disputa === 'ABERTA',
                devolucao: p.devolucao_protocolo ? { protocolo: p.devolucao_protocolo, estado: p.devolucao_estado, tipo: p.devolucao_tipo, valorCentavos: Number(p.devolucao_valor),
                    prazo: p.devolucao_prazo } : null,
                opcaoDevolucao: opcao && opcao.disponivel ? { tipo: opcao.calculo.tipo, valorCentavos: opcao.calculo.valorCentavos, quantidadeCancelada: exibir(recurso, opcao.calculo.quantidadeCancelada),
                    prazo: opcao.calculo.prazo, garantiaAte: new Date(opcao.calculo.garantiaAte).toISOString() } : opcao ? { indisponivel: opcao.motivo } : null,
            });
        }
        const extrato = (await tx.query<Record<string, unknown>>(`SELECT x.recurso, x.tipo, x.quantidade, x.protocolo, ${ISO('x.criado_em')} AS em, l.origem
            FROM ia_credito_lancamentos x JOIN ia_credito_lotes l ON l.id = x.lote_id AND l.empresa_id = x.empresa_id
            WHERE x.empresa_id = $1::uuid ORDER BY x.id DESC LIMIT 60`, [empresaId])).rows
            .map((x) => ({ recurso: x.recurso, tipo: x.tipo, quantidade: exibir(x.recurso as Recurso, Number(x.quantidade)), protocolo: x.protocolo, em: x.em, origem: x.origem }));
        const visivel = catalogoVisivel(cat, env);
        const venda = vendaAberta(cat, env);
        const catalogo = visivel.ok ? {
            versao: cat.versao, proposta: cat.proposta, aprovado: Boolean(cat.aprovacao), termos: { versao: cat.termos.versao, texto: cat.termos.texto, sha256: termosSha256(cat) },
            ofertas: cat.ofertas.filter((o) => o.recurso === 'CONVITES' ? Boolean(convites) : walle)
                .map((o) => ({ codigo: o.codigo, recurso: o.recurso, nome: o.nome, quantidadeExibida: o.quantidadeExibida, precoCentavos: o.precoCentavos, validadeDias: o.validadeDias })),
        } : null;
        return { ...base, pedidos: lista, extrato, catalogo, compraAberta: venda.ok, motivoCompraFechada: venda.ok ? null : venda.motivo };
    });
}
