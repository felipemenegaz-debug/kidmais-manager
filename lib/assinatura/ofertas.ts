/** Contratações 074: valores e concessões calculados no servidor; nenhuma chamada externa. */
import { randomUUID } from 'node:crypto';
import type { DbExecutor } from '../db/contracts';
import { erroAcesso } from '../acessos/erros.ts';
import { condicoesComerciais, planosComerciais, planoComercialValido, valorComercial, type PlanoComercialId } from './planos-comerciais.ts';
import type { Ciclo } from './configuracao.ts';
import type { AssinaturaProvedor, CobrancaProvedor } from './asaas.ts';
import { pagamentoDaOferta } from './pagamento-oferta.ts';

export type Oferta = {
    id: string; empresa_id: string; plano: 'ESSENCIAL' | 'PROFISSIONAL' | 'PREMIUM'; ciclo: Ciclo;
    valor_regular_centavos: number; valor_final_centavos: number; fundador_id: string | null;
    estado: 'EM_ABERTO' | 'CONFIRMADA' | 'CANCELADA'; catalogo_versao: string;
    pagamento_confirmacao_id?: string | null;
};
type Ambiente = Record<string, string | undefined>;
export const novosPlanosLigados = (env: Ambiente = process.env) => env.ASSINATURA_PLANOS_ATIVOS === 'true' && env.ASAAS_AMBIENTE === 'sandbox';

export async function schemaPlanosInstalado(tx: DbExecutor) {
    return (await tx.query<{ instalado074: boolean }>(`SELECT to_regclass('public.assinatura_contratacoes') IS NOT NULL
        AND to_regclass('public.assinatura_isencoes') IS NOT NULL
        AND to_regclass('public.assinatura_fundadores') IS NOT NULL AS instalado074`)).rows[0]?.instalado074 === true;
}

export async function empresaIsenta(tx: DbExecutor, empresaId: string) {
    if (!await schemaPlanosInstalado(tx)) return false;
    return (await tx.query<{ isenta: boolean }>('SELECT EXISTS (SELECT 1 FROM assinatura_isencoes WHERE empresa_id = $1::uuid) AS isenta', [empresaId])).rows[0]?.isenta === true;
}

export async function travarEmpresaComercial(tx: DbExecutor, empresaId: string) {
    if (await schemaPlanosInstalado(tx))
        await tx.query('SELECT id FROM empresas WHERE id = $1::uuid FOR UPDATE', [empresaId]);
}

export async function exigirEmpresaCobravel(tx: DbExecutor, empresaId: string) {
    if (await empresaIsenta(tx, empresaId)) throw erroAcesso('EMPRESA_ISENTA', 'Esta empresa possui isenção permanente e não será cobrada.', 409);
}

/** O endpoint legado nunca pode criar ou reprecificar uma contratação 074. */
export async function conferirCheckoutLegado(tx: DbExecutor, empresaId: string, ciclo: Ciclo, env: Ambiente) {
    if (!await schemaPlanosInstalado(tx)) {
        if (novosPlanosLigados(env)) throw erroAcesso('PLANOS_NAO_INSTALADOS', 'Os novos planos ainda não estão disponíveis neste ambiente.', 503);
        return false;
    }
    const atual = (await tx.query<{ plano: string; ciclo: Ciclo | null; provedor_assinatura_id: string | null; aberta: boolean }>(`SELECT a.plano, a.ciclo, a.provedor_assinatura_id,
        EXISTS (SELECT 1 FROM assinatura_contratacoes c WHERE c.empresa_id = a.empresa_id AND c.estado = 'EM_ABERTO') AS aberta
        FROM empresa_assinaturas a WHERE a.empresa_id = $1::uuid`, [empresaId])).rows[0];
    if (atual?.aberta || (novosPlanosLigados(env) && atual?.plano === 'UNICO' && !atual.provedor_assinatura_id))
        throw erroAcesso('OFERTA_INVALIDA', 'Atualize a página e confirme o plano e o valor antes de assinar.', 409);
    if (atual && atual.plano !== 'UNICO') {
        if (atual.ciclo !== ciclo) throw erroAcesso('TROCA_PLANO_NAO_DISPONIVEL', 'A assinatura mantém o ciclo contratado.', 409);
        return true;
    }
    return false;
}

/** Serializa alocação da campanha, sem rede. Quem disputa a última vaga relê sob o mesmo lock. */
async function situacaoFundador(tx: DbExecutor, empresaId: string, travar: boolean) {
    if (travar) await tx.query("SELECT pg_advisory_xact_lock(hashtext('kidmais:fundadores:2026'))");
    const propria = (await tx.query<{ id: string; estado: string; vigente: boolean }>(`SELECT id, estado,
        (estado = 'RESERVADA' OR beneficio_fim > clock_timestamp()) AS vigente
        FROM assinatura_fundadores WHERE empresa_id = $1::uuid AND estado <> 'LIBERADA'`, [empresaId])).rows[0];
    if (propria) return { id: propria.id, elegivel: propria.vigente, aguardando: false };
    const ocupacao = (await tx.query<{ confirmadas: number; ocupadas: number }>(`SELECT
        count(*) FILTER (WHERE estado = 'CONFIRMADA')::int AS confirmadas,
        count(*) FILTER (WHERE estado <> 'LIBERADA')::int AS ocupadas FROM assinatura_fundadores`)).rows[0];
    if (!ocupacao) throw new Error('Estado da campanha indisponível.');
    return { id: null, elegivel: ocupacao.ocupadas < condicoesComerciais.fundador.vagas,
        aguardando: ocupacao.ocupadas >= condicoesComerciais.fundador.vagas && ocupacao.confirmadas < condicoesComerciais.fundador.vagas };
}

export async function consultarOfertas(tx: DbExecutor, empresaId: string, env: Ambiente = process.env) {
    if (!await schemaPlanosInstalado(tx)) return null;
    const isenta = await empresaIsenta(tx, empresaId);
    const linha = (await tx.query<{ plano: string; provedor_assinatura_id: string | null }>('SELECT plano, provedor_assinatura_id FROM empresa_assinaturas WHERE empresa_id = $1::uuid', [empresaId])).rows[0];
    const ativa = linha?.plano !== 'UNICO' ? linha?.plano ?? null : null;
    const pendente = (await tx.query<Oferta>("SELECT * FROM assinatura_contratacoes WHERE empresa_id = $1::uuid AND estado = 'EM_ABERTO'", [empresaId])).rows[0];
    const elegivel = Boolean(linha && linha.plano === 'UNICO' && (!linha.provedor_assinatura_id || pendente));
    const habilitado = novosPlanosLigados(env) && !isenta && elegivel;
    const campanha = habilitado ? await situacaoFundador(tx, empresaId, false) : null;
    return {
        isenta, habilitado, planoAtual: ativa, aguardandoVaga: campanha?.aguardando ?? false,
        fundador: campanha?.elegivel ?? false,
        versao: condicoesComerciais.versao,
        pendente: pendente ? { plano: pendente.plano.toLowerCase() as PlanoComercialId, ciclo: pendente.ciclo, valorCentavos: pendente.valor_final_centavos } : null,
        planos: Object.entries(planosComerciais).map(([id, plano]) => ({
            id: id as PlanoComercialId, nome: plano.nome,
            mensal: valorComercial(id as PlanoComercialId, 'mensal', campanha?.elegivel ?? false),
            anual: valorComercial(id as PlanoComercialId, 'anual', campanha?.elegivel ?? false),
            mensalRegular: valorComercial(id as PlanoComercialId, 'mensal'),
            anualRegular: valorComercial(id as PlanoComercialId, 'anual'),
        })),
    };
}

export type PedidoOferta = { plano: PlanoComercialId; ciclo: Ciclo; valorEsperadoCentavos: number; versao: string };
export function validarPedidoOferta(raw: unknown): PedidoOferta {
    const o = raw as Partial<PedidoOferta> | null;
    if (!o || !planoComercialValido(o.plano) || !['MENSAL', 'ANUAL'].includes(o.ciclo ?? '')
        || !Number.isSafeInteger(o.valorEsperadoCentavos) || (o.valorEsperadoCentavos ?? 0) <= 0 || o.versao !== condicoesComerciais.versao)
        throw erroAcesso('OFERTA_INVALIDA', 'Atualize a página e escolha um plano e ciclo válidos.', 400);
    return o as PedidoOferta;
}

/** Chamar sob trava de contratação da empresa e transação tenant, depois de exigir Gestão. */
export async function prepararOferta(tx: DbExecutor, empresaId: string, usuarioId: string, pedido: PedidoOferta): Promise<Oferta> {
    if (!await schemaPlanosInstalado(tx)) throw erroAcesso('PLANOS_NAO_INSTALADOS', 'Os novos planos ainda não estão disponíveis neste ambiente.', 503);
    await tx.query('SELECT id FROM empresas WHERE id = $1::uuid FOR UPDATE', [empresaId]);
    await exigirEmpresaCobravel(tx, empresaId);
    const linha = (await tx.query<{ documento_teste: string | null; provedor_assinatura_id: string | null; plano: string }>(
        'SELECT plano, documento_teste, provedor_assinatura_id FROM empresa_assinaturas WHERE empresa_id = $1::uuid FOR UPDATE', [empresaId])).rows[0];
    if (!linha) throw erroAcesso('EMPRESA_SEM_COBRANCA', 'Esta empresa mantém seu acesso atual sem cobrança.', 409);
    const aberta = (await tx.query<Oferta>("SELECT * FROM assinatura_contratacoes WHERE empresa_id = $1::uuid AND estado = 'EM_ABERTO' FOR UPDATE", [empresaId])).rows[0];
    if (aberta) {
        if (aberta.plano !== pedido.plano.toUpperCase() || aberta.ciclo !== pedido.ciclo || aberta.valor_final_centavos !== pedido.valorEsperadoCentavos)
            throw erroAcesso('OFERTA_EM_ANDAMENTO', 'Há uma contratação em andamento. Retome as condições já confirmadas.', 409);
        return aberta;
    }
    if (linha.provedor_assinatura_id || linha.plano !== 'UNICO')
        throw erroAcesso('TROCA_PLANO_NAO_DISPONIVEL', 'A assinatura existente mantém suas condições. A mudança de plano exige atendimento.', 409);
    const campanha = await situacaoFundador(tx, empresaId, true);
    if (campanha.aguardando) throw erroAcesso('FUNDADOR_AGUARDANDO', 'As vagas Fundador estão em confirmação. Tente novamente mais tarde; nenhuma cobrança foi criada.', 409);
    const ciclo = pedido.ciclo === 'ANUAL' ? 'anual' : 'mensal';
    const valor = valorComercial(pedido.plano, ciclo, campanha.elegivel);
    if (valor !== pedido.valorEsperadoCentavos)
        throw erroAcesso('OFERTA_ALTERADA', 'As condições disponíveis mudaram. Atualize e confirme o novo valor antes de continuar.', 409);
    let fundadorId = campanha.elegivel ? campanha.id : null;
    if (campanha.elegivel && !fundadorId) {
        if (!linha.documento_teste) throw erroAcesso('DOCUMENTO_NAO_CONFIRMADO', 'A assinatura precisa do documento cadastrado para participar da campanha.', 409);
        fundadorId = (await tx.query<{ id: string }>(`INSERT INTO assinatura_fundadores (empresa_id,documento_beneficiario,vaga)
            SELECT $1::uuid,$2,v FROM generate_series(1,20) v
            WHERE NOT EXISTS (SELECT 1 FROM assinatura_fundadores f WHERE f.vaga = v AND f.estado <> 'LIBERADA')
            ORDER BY v LIMIT 1 RETURNING id`, [empresaId, linha.documento_teste])).rows[0]?.id ?? null;
        if (!fundadorId) throw erroAcesso('FUNDADOR_AGUARDANDO', 'Aguarde a confirmação das vagas disponíveis.', 409);
    }
    const oferta = (await tx.query<Oferta>(`INSERT INTO assinatura_contratacoes
        (empresa_id,chave_idempotencia,plano,ciclo,catalogo_versao,valor_regular_centavos,desconto_percentual,valor_final_centavos,fundador_id,criada_por)
        VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9::uuid,$10::uuid) RETURNING *`,
        [empresaId, randomUUID(), pedido.plano.toUpperCase(), pedido.ciclo, condicoesComerciais.versao,
            valorComercial(pedido.plano,ciclo), campanha.elegivel ? 40 : 0, valor, fundadorId, usuarioId])).rows[0];
    if (!oferta) throw new Error('Oferta não foi persistida.');
    return oferta;
}

/** Mesma transação que atualizará o acesso. A flag de venda não desliga reconciliação de contratos existentes. */
export async function confirmarOfertaPaga(tx: DbExecutor, empresaId: string, assinatura: AssinaturaProvedor | null,
    pagamentos: readonly CobrancaProvedor[], clienteId: string | null, ativar = true) {
    if (!await schemaPlanosInstalado(tx)) return null;
    await exigirEmpresaCobravel(tx, empresaId);
    const oferta = (await tx.query<Oferta>(`SELECT c.* FROM assinatura_contratacoes c
        LEFT JOIN empresa_assinaturas a ON a.empresa_id = c.empresa_id AND a.contratacao_atual_id = c.id
        WHERE c.empresa_id = $1::uuid AND (c.estado = 'EM_ABERTO' OR a.contratacao_atual_id IS NOT NULL)
        ORDER BY (c.estado = 'EM_ABERTO') DESC LIMIT 1`, [empresaId])).rows[0];
    if (!oferta) return null;
    const beneficio = oferta.fundador_id ? (await tx.query<{ estado: string; beneficio_fim: string | null }>(`SELECT estado,
        to_char(beneficio_fim AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS beneficio_fim
        FROM assinatura_fundadores WHERE id = $1::uuid AND empresa_id = $2::uuid FOR UPDATE`, [oferta.fundador_id, empresaId])).rows[0] : null;
    if (oferta.fundador_id && (!beneficio || beneficio.estado === 'LIBERADA'))
        throw erroAcesso('FUNDADOR_DIVERGENTE', 'Benefício comercial requer reconciliação.', 409);
    // A assinatura da empresa está travada pelo chamador; vaga vem antes do contrato.
    await tx.query('SELECT id FROM assinatura_contratacoes WHERE empresa_id = $1::uuid AND id = $2::uuid FOR UPDATE', [empresaId, oferta.id]);
    const pagamento = pagamentoDaOferta(oferta, assinatura, pagamentos, clienteId, beneficio?.beneficio_fim ?? null);
    if (!pagamento) throw erroAcesso('PAGAMENTO_OFERTA_DIVERGENTE', 'O pagamento não corresponde à oferta contratada.', 409);
    if (!ativar) return null;
    if (oferta.estado === 'EM_ABERTO') {
        if (beneficio?.estado === 'RESERVADA') await tx.query(`UPDATE assinatura_fundadores SET estado = 'CONFIRMADA',
            confirmada_em = clock_timestamp(), pagamento_confirmacao_id = $3
            WHERE id = $1::uuid AND empresa_id = $2::uuid AND estado = 'RESERVADA'`, [oferta.fundador_id,empresaId,pagamento.id]);
        await tx.query(`UPDATE assinatura_contratacoes SET estado = 'CONFIRMADA', confirmada_em = clock_timestamp(),
            pagamento_confirmacao_id = $3, provedor_assinatura_id = $4
            WHERE id = $1::uuid AND empresa_id = $2::uuid AND estado = 'EM_ABERTO'`, [oferta.id,empresaId,pagamento.id,assinatura!.id]);
    }
    return oferta.estado === 'EM_ABERTO' ? { id: oferta.id, plano: oferta.plano } : null;
}
