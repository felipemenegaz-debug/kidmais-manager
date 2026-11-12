/** Contratações 074: valores e concessões calculados no servidor; nenhuma chamada externa. */
import { randomUUID } from 'node:crypto';
import type { DbExecutor } from '../db/contracts';
import { erroAcesso } from '../acessos/erros.ts';
import { condicoesComerciais, planosComerciais, planoComercialValido, valorComercial, type PlanoComercialId } from './planos-comerciais.ts';
import type { Ciclo } from './configuracao.ts';
import { ambienteAsaas, type AssinaturaProvedor, type CobrancaProvedor } from './asaas.ts';
import { pagamentoDaOferta } from './pagamento-oferta.ts';
import { campanhaFundadorLigada, faseCampanha, lerCampanhaAtivada, ocupacaoPosJanela, prazoAnunciado, schemaCampanhaInstalado,
    type CampanhaFundador, type ResumoCampanha } from './campanha.ts';
import { PAGAMENTO_TARDIO } from './textos-fundador.ts';
import { documentoVigente, MENSAGEM_CONTINUIDADE_PENDENTE } from './documento-contratante.ts';
import { comprovanteInstalado, exigirDocumentosConfirmados, registrarComprovante } from './comprovante.ts';

export type Oferta = {
    id: string; empresa_id: string; plano: 'ESSENCIAL' | 'PROFISSIONAL' | 'PREMIUM'; ciclo: Ciclo;
    valor_regular_centavos: number; valor_final_centavos: number; fundador_id: string | null;
    estado: 'EM_ABERTO' | 'CONFIRMADA' | 'CANCELADA'; catalogo_versao: string; desconto_percentual?: number;
    pagamento_confirmacao_id?: string | null;
};
type Ambiente = Record<string, string | undefined>;
/** Chave dos planos + provedor no ambiente pareado com o serviço (sandbox fora de produção; produção só no serviço de produção). */
export const novosPlanosLigados = (env: Ambiente = process.env) => env.ASSINATURA_PLANOS_ATIVOS === 'true' && typeof ambienteAsaas(env) === 'string';

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

/**
 * Trava comercial da RECONCILIAÇÃO de duplicatas (#147). NÃO é equivalente a `travarEmpresaComercial`:
 * `FOR NO KEY UPDATE` continua exclusivo contra `FOR UPDATE`, `FOR NO KEY UPDATE` e `FOR SHARE` sobre a mesma empresa
 * (checkout e cancelamento via provarTenant/linhaDaEmpresa, sincronização, renovação, limites, convites e os gatilhos 074a
 * de isenção, vaga Fundador e contratação), mas deixa passar `FOR KEY SHARE`, isto é, as verificações de FK de linhas
 * que referenciam `empresas`. É o que o marcador de exclusão precisa: ele é gravado e confirmado em OUTRA conexão, numa
 * linha de `cobranca_eventos` (FK para `empresas`), enquanto esta transação mantém a trava até depois do DELETE.
 * Com `FOR UPDATE` aqui, esse INSERT esperava o lock_timeout e nenhuma exclusão acontecia.
 * Só para quem não escreve em empresa_assinaturas nem nas tabelas 074a antes de gravar o marcador: esses gatilhos tomam
 * `FOR UPDATE` na empresa e, a partir daí, o marcador volta a esperar.
 */
export async function travarEmpresaParaReconciliacao(tx: DbExecutor, empresaId: string) {
    if (await schemaPlanosInstalado(tx))
        await tx.query('SELECT id FROM empresas WHERE id = $1::uuid FOR NO KEY UPDATE', [empresaId]);
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

type OrigemConcessao = 'LEGADO' | 'JANELA' | 'POS_JANELA';
type BloqueioCampanha = { codigo: 'CAMPANHA_DESLIGADA' | 'CAMPANHA_REGRA_PENDENTE' | 'CAMPANHA_ANTES_DA_ABERTURA'; mensagem: string; status: number };
type SituacaoFundador = {
    id: string | null; elegivel: boolean; aguardando: boolean; origem: OrigemConcessao | null;
    campanha: CampanhaFundador | null; instalado090: boolean; bloqueio: BloqueioCampanha | null; resumo: ResumoCampanha;
};
const ISO_AGORA = `SELECT to_char((clock_timestamp()) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS agora`;

/**
 * Serializa alocação da campanha, sem rede. Quem disputa a última vaga relê sob o mesmo lock.
 * Sem a 090 (ou sem campanha ativada): regra anterior, 20 primeiros (LEGADO). Com campanha ativada: a fase é decidida
 * pelo relógio do banco lido DEPOIS da trava; a guarda 090 confere de novo na inserção.
 */
async function situacaoFundador(tx: DbExecutor, empresaId: string, travar: boolean, env: Ambiente): Promise<SituacaoFundador> {
    if (travar) await tx.query("SELECT pg_advisory_xact_lock(hashtext('kidmais:fundadores:2026'))");
    const instalado090 = await schemaCampanhaInstalado(tx);
    const base = { instalado090, bloqueio: null, campanha: null } as const;
    const propria = (await tx.query<{ id: string; estado: string; vigente: boolean }>(`SELECT id, estado,
        (estado = 'RESERVADA' OR beneficio_fim > clock_timestamp()) AS vigente
        FROM assinatura_fundadores WHERE empresa_id = $1::uuid AND estado <> 'LIBERADA'`, [empresaId])).rows[0];
    // Concessão existente (de qualquer origem) é retomada: não reinicia 12 meses nem ocupa vaga nova.
    if (propria) {
        // Revisão de 22/10/2026: concessão própria também respeita a chave operacional da campanha ativada.
        if (instalado090 && !campanhaFundadorLigada(env) && await lerCampanhaAtivada(tx))
            return { ...base, id: null, elegivel: false, aguardando: false, origem: null, resumo: { fase: 'DESLIGADA' }, bloqueio: { codigo: 'CAMPANHA_DESLIGADA', status: 503,
                mensagem: 'A contratação está temporariamente indisponível. Nenhuma cobrança foi criada.' } };
        return { ...base, id: propria.id, elegivel: propria.vigente, aguardando: false, origem: null, resumo: { fase: 'LEGADO' } };
    }
    const campanha = instalado090 ? await lerCampanhaAtivada(tx, travar) : null;
    if (!campanha) {
        const ocupacao = (await tx.query<{ confirmadas: number; ocupadas: number }>(`SELECT
            count(*) FILTER (WHERE estado = 'CONFIRMADA')::int AS confirmadas,
            count(*) FILTER (WHERE estado <> 'LIBERADA')::int AS ocupadas FROM assinatura_fundadores${instalado090 ? " WHERE origem = 'LEGADO'" : ''}`)).rows[0];
        if (!ocupacao) throw new Error('Estado da campanha indisponível.');
        return { ...base, id: null, origem: 'LEGADO', resumo: { fase: 'LEGADO' }, elegivel: ocupacao.ocupadas < condicoesComerciais.fundador.vagas,
            aguardando: ocupacao.ocupadas >= condicoesComerciais.fundador.vagas && ocupacao.confirmadas < condicoesComerciais.fundador.vagas };
    }
    const sem = { ...base, campanha, id: null, elegivel: false, aguardando: false, origem: null };
    if (!campanhaFundadorLigada(env))
        return { ...sem, resumo: { fase: 'DESLIGADA' }, bloqueio: { codigo: 'CAMPANHA_DESLIGADA', status: 503,
            mensagem: 'A contratação está temporariamente indisponível. Nenhuma cobrança foi criada.' } };
    if (campanha.elegibilidade !== 'OFERTA_PERSISTIDA')
        return { ...sem, resumo: { fase: 'DESLIGADA' }, bloqueio: { codigo: 'CAMPANHA_REGRA_PENDENTE', status: 503,
            mensagem: 'A contratação está temporariamente indisponível. Nenhuma cobrança foi criada.' } };
    const agora = (await tx.query<{ agora: string }>(ISO_AGORA)).rows[0]?.agora;
    const fase = faseCampanha(campanha, Date.parse(String(agora)));
    if (fase === 'ANTES')
        return { ...sem, resumo: { fase, inicio: campanha.inicio }, bloqueio: { codigo: 'CAMPANHA_ANTES_DA_ABERTURA', status: 409,
            mensagem: 'A contratação abre junto com a campanha Fundador. Nenhuma cobrança foi criada.' } };
    if (fase === 'JANELA') return { ...sem, elegivel: true, origem: 'JANELA', resumo: { fase, prazo: prazoAnunciado(campanha) } };
    if (fase === 'ENCERRADA') return { ...sem, resumo: { fase } };
    const o = await ocupacaoPosJanela(tx, campanha.id);
    const limite = campanha.vagasPosJanela;
    return { ...sem, origem: 'POS_JANELA', elegivel: o.ocupadas < limite, aguardando: o.ocupadas >= limite && o.confirmadas < limite,
        resumo: { fase, vagasRestantes: Math.max(0, limite - o.ocupadas), emConfirmacao: o.ocupadas - o.confirmadas, limite } };
}

/**
 * Validade da condição reservada na campanha 090 (D3 de 22/10/2026: 7 dias corridos a partir da aceitação persistida).
 * Concessão LEGADO, sem a 090 ou já confirmada: sem prazo (null). `dia` é a data local (America/Sao_Paulo) do fim.
 * Critério ÚNICO (revisão de 22/10/2026): a condição vale até o fim desse dia local, inclusive — para a tela, para a
 * retomada e para o pagamento (comparado pela data do pagamento no provedor).
 */
export async function validadeDaConcessao(tx: DbExecutor, fundadorId: string | null) {
    if (!fundadorId || !await schemaCampanhaInstalado(tx)) return null;
    const r = (await tx.query<{ estado: string; ate: string | null; dia: string | null; vencida: boolean }>(`SELECT estado,
        to_char(oferta_valida_ate AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ate,
        to_char(oferta_valida_ate AT TIME ZONE 'America/Sao_Paulo','YYYY-MM-DD') AS dia,
        coalesce((clock_timestamp() AT TIME ZONE 'America/Sao_Paulo')::date > (oferta_valida_ate AT TIME ZONE 'America/Sao_Paulo')::date, false) AS vencida
        FROM assinatura_fundadores WHERE id = $1::uuid`, [fundadorId])).rows[0];
    if (!r?.ate || !r.dia || r.estado !== 'RESERVADA') return null;
    return { ate: r.ate, dia: r.dia, vencida: r.vencida };
}
/** Data do pagamento para D3: a mais antiga entre as datas válidas que o provedor informou. */
export function dataDoPagamento(p: Pick<CobrancaProvedor, 'paymentDate' | 'confirmedDate' | 'clientPaymentDate'>): string | null {
    const datas = [p.clientPaymentDate, p.confirmedDate, p.paymentDate].filter((d): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d));
    return datas.length ? datas.sort()[0]! : null;
}
const EXPIRADA = 'A condição Fundador reservada venceu sem pagamento. Fale com o atendimento: a reserva só é liberada depois de conferirmos que não há cobrança em aberto.';

/** Insere a concessão da fase decidida. Guarda 090 recusa (fase virou, lote esgotado) → o cliente confirma de novo. */
async function reservarConcessao(tx: DbExecutor, empresaId: string, documento: string, s: SituacaoFundador): Promise<string | null> {
    try {
        if (s.origem === 'JANELA') return (await tx.query<{ id: string }>(`INSERT INTO assinatura_fundadores
            (empresa_id,documento_beneficiario,vaga,origem,campanha_id) VALUES ($1::uuid,$2,NULL,'JANELA',$3::uuid) RETURNING id`,
            [empresaId, documento, s.campanha!.id])).rows[0]?.id ?? null;
        if (s.origem === 'POS_JANELA') return (await tx.query<{ id: string }>(`INSERT INTO assinatura_fundadores
            (empresa_id,documento_beneficiario,vaga,origem,campanha_id)
            SELECT $1::uuid,$2,v,'POS_JANELA',$3::uuid FROM generate_series(1,$4::int) v
            WHERE NOT EXISTS (SELECT 1 FROM assinatura_fundadores f WHERE f.campanha_id = $3::uuid AND f.origem = 'POS_JANELA'
                AND f.vaga = v AND f.estado <> 'LIBERADA')
            ORDER BY v LIMIT 1 RETURNING id`, [empresaId, documento, s.campanha!.id, s.campanha!.vagasPosJanela])).rows[0]?.id ?? null;
        if (s.instalado090) return (await tx.query<{ id: string }>(`INSERT INTO assinatura_fundadores (empresa_id,documento_beneficiario,vaga,origem)
            SELECT $1::uuid,$2,v,'LEGADO' FROM generate_series(1,20) v
            WHERE NOT EXISTS (SELECT 1 FROM assinatura_fundadores f WHERE f.origem = 'LEGADO' AND f.vaga = v AND f.estado <> 'LIBERADA')
            ORDER BY v LIMIT 1 RETURNING id`, [empresaId, documento])).rows[0]?.id ?? null;
        return (await tx.query<{ id: string }>(`INSERT INTO assinatura_fundadores (empresa_id,documento_beneficiario,vaga)
            SELECT $1::uuid,$2,v FROM generate_series(1,20) v
            WHERE NOT EXISTS (SELECT 1 FROM assinatura_fundadores f WHERE f.vaga = v AND f.estado <> 'LIBERADA')
            ORDER BY v LIMIT 1 RETURNING id`, [empresaId, documento])).rows[0]?.id ?? null;
    }
    catch (e) {
        if (String((e as Error)?.message ?? '').startsWith('090:'))
            throw erroAcesso('OFERTA_ALTERADA', 'As condições disponíveis mudaram. Atualize e confirme o novo valor antes de continuar.', 409);
        throw e;
    }
}

export async function consultarOfertas(tx: DbExecutor, empresaId: string, env: Ambiente = process.env) {
    if (!await schemaPlanosInstalado(tx)) return null;
    const isenta = await empresaIsenta(tx, empresaId);
    const linha = (await tx.query<{ plano: string; provedor_assinatura_id: string | null }>('SELECT plano, provedor_assinatura_id FROM empresa_assinaturas WHERE empresa_id = $1::uuid', [empresaId])).rows[0];
    const ativa = linha?.plano !== 'UNICO' ? linha?.plano ?? null : null;
    const pendente = (await tx.query<Oferta>("SELECT * FROM assinatura_contratacoes WHERE empresa_id = $1::uuid AND estado = 'EM_ABERTO'", [empresaId])).rows[0];
    const elegivel = Boolean(linha && linha.plano === 'UNICO' && (!linha.provedor_assinatura_id || pendente));
    const habilitado = novosPlanosLigados(env) && !isenta && elegivel;
    const campanha = habilitado ? await situacaoFundador(tx, empresaId, false, env) : null;
    return {
        // Oferta já aceita e persistida (D1) continua retomável mesmo com a campanha bloqueada, como em prepararOferta, que a
        // devolve antes de olhar a campanha (a vencida é recusada lá). Sem oferta pendente, o bloqueio fecha a venda.
        isenta, habilitado: habilitado && (!campanha?.bloqueio || Boolean(pendente)), planoAtual: ativa,
        // P2-R1 (revisão de 31c5704d): com oferta pendente, a tela mostra a condição PERSISTIDA dela (fundador_id), nunca a
        // disponibilidade atual para uma oferta nova — uma oferta regular não passa a anunciar Fundador se uma vaga for liberada.
        aguardandoVaga: pendente ? false : campanha?.aguardando ?? false,
        fundador: pendente ? pendente.fundador_id !== null : campanha?.elegivel ?? false,
        // Indicativo: o checkout recalcula sob trava e pede nova confirmação se a fase ou as vagas mudarem.
        campanha: campanha ? campanha.resumo : null,
        bloqueio: campanha?.bloqueio && !pendente ? { codigo: campanha.bloqueio.codigo, mensagem: campanha.bloqueio.mensagem } : null,
        versao: condicoesComerciais.versao,
        pendente: pendente ? { plano: pendente.plano.toLowerCase() as PlanoComercialId, ciclo: pendente.ciclo, valorCentavos: pendente.valor_final_centavos,
            fundadorValidoAte: await validadeDaConcessao(tx, pendente.fundador_id) } : null,
        planos: Object.entries(planosComerciais).map(([id, plano]) => ({
            id: id as PlanoComercialId, nome: plano.nome,
            mensal: valorComercial(id as PlanoComercialId, 'mensal', campanha?.elegivel ?? false),
            anual: valorComercial(id as PlanoComercialId, 'anual', campanha?.elegivel ?? false),
            mensalRegular: valorComercial(id as PlanoComercialId, 'mensal'),
            anualRegular: valorComercial(id as PlanoComercialId, 'anual'),
        })),
    };
}

export type PedidoOferta = { plano: PlanoComercialId; ciclo: Ciclo; valorEsperadoCentavos: number; versao: string;
    /** Versões e hashes apresentados na síntese (grupo B): com a 096, exigidos e iguais aos vigentes. */
    documentos?: unknown };
export function validarPedidoOferta(raw: unknown): PedidoOferta {
    const o = raw as Partial<PedidoOferta> | null;
    if (!o || !planoComercialValido(o.plano) || !['MENSAL', 'ANUAL'].includes(o.ciclo ?? '')
        || !Number.isSafeInteger(o.valorEsperadoCentavos) || (o.valorEsperadoCentavos ?? 0) <= 0 || o.versao !== condicoesComerciais.versao)
        throw erroAcesso('OFERTA_INVALIDA', 'Atualize a página e escolha um plano e ciclo válidos.', 400);
    return o as PedidoOferta;
}

/** Chamar sob trava de contratação da empresa e transação tenant, depois de exigir Gestão. */
export async function prepararOferta(tx: DbExecutor, empresaId: string, usuarioId: string, pedido: PedidoOferta, env: Ambiente = process.env): Promise<Oferta> {
    if (!await schemaPlanosInstalado(tx)) throw erroAcesso('PLANOS_NAO_INSTALADOS', 'Os novos planos ainda não estão disponíveis neste ambiente.', 503);
    await tx.query('SELECT id FROM empresas WHERE id = $1::uuid FOR UPDATE', [empresaId]);
    await exigirEmpresaCobravel(tx, empresaId);
    const linha = (await tx.query<{ documento_teste: string | null; provedor_assinatura_id: string | null; plano: string }>(
        'SELECT plano, documento_teste, provedor_assinatura_id FROM empresa_assinaturas WHERE empresa_id = $1::uuid FOR UPDATE', [empresaId])).rows[0];
    if (!linha) throw erroAcesso('EMPRESA_SEM_COBRANCA', 'Esta empresa mantém seu acesso atual sem cobrança.', 409);
    // D5: continuidade aguardando a conferência do provedor não abre oferta.
    const vigente = await documentoVigente(tx, empresaId, linha.documento_teste);
    if (vigente.pendente) throw erroAcesso('CONTINUIDADE_PENDENTE', MENSAGEM_CONTINUIDADE_PENDENTE, 409);
    const aberta = (await tx.query<Oferta>("SELECT * FROM assinatura_contratacoes WHERE empresa_id = $1::uuid AND estado = 'EM_ABERTO' FOR UPDATE", [empresaId])).rows[0];
    if (aberta) {
        if (aberta.plano !== pedido.plano.toUpperCase() || aberta.ciclo !== pedido.ciclo || aberta.valor_final_centavos !== pedido.valorEsperadoCentavos)
            throw erroAcesso('OFERTA_EM_ANDAMENTO', 'Há uma contratação em andamento. Retome as condições já confirmadas.', 409);
        // D3: retomar oferta com a condição vencida não reabre o prazo; a liberação exige prova (atendimento).
        if ((await validadeDaConcessao(tx, aberta.fundador_id))?.vencida)
            throw erroAcesso('FUNDADOR_OFERTA_EXPIRADA', EXPIRADA, 409);
        return aberta;
    }
    // Oferta NOVA: com a 096, os documentos apresentados na síntese precisam ser os vigentes (aba antiga → reler e confirmar).
    const documentos = await comprovanteInstalado(tx) ? exigirDocumentosConfirmados(pedido.documentos) : null;
    if (linha.provedor_assinatura_id || linha.plano !== 'UNICO')
        throw erroAcesso('TROCA_PLANO_NAO_DISPONIVEL', 'A assinatura existente mantém suas condições. A mudança de plano exige atendimento.', 409);
    const campanha = await situacaoFundador(tx, empresaId, true, env);
    if (campanha.bloqueio) throw erroAcesso(campanha.bloqueio.codigo, campanha.bloqueio.mensagem, campanha.bloqueio.status);
    // D3: concessão própria reservada com a validade vencida não gera oferta nova com desconto (atendimento).
    if (campanha.id && (await validadeDaConcessao(tx, campanha.id))?.vencida)
        throw erroAcesso('FUNDADOR_OFERTA_EXPIRADA', EXPIRADA, 409);
    // O3 (decisão de Felipe, 24/10/2026, opção A): vagas em confirmação NÃO travam a venda. Sem vaga livre, `elegivel` é falso e
    // a oferta sai pelo preço regular, sem concessão; quem esperava o Fundador recebe OFERTA_ALTERADA e confirma o novo valor.
    const ciclo = pedido.ciclo === 'ANUAL' ? 'anual' : 'mensal';
    const valor = valorComercial(pedido.plano, ciclo, campanha.elegivel);
    if (valor !== pedido.valorEsperadoCentavos)
        throw erroAcesso('OFERTA_ALTERADA', 'As condições disponíveis mudaram. Atualize e confirme o novo valor antes de continuar.', 409);
    let fundadorId = campanha.elegivel ? campanha.id : null;
    if (campanha.elegivel && !fundadorId) {
        // O beneficiário é o documento do TESTE (guarda 074a); a continuidade (D5) liga esse snapshot ao documento vigente.
        if (!linha.documento_teste) throw erroAcesso('DOCUMENTO_NAO_CONFIRMADO', 'A assinatura precisa do documento cadastrado para participar da campanha.', 409);
        fundadorId = await reservarConcessao(tx, empresaId, linha.documento_teste, campanha);
        // Sem vaga na inserção (corrida que a trava não cobriu): nunca trava nem muda o preço em silêncio — o cliente reconfirma.
        if (!fundadorId) throw erroAcesso('OFERTA_ALTERADA', 'As condições disponíveis mudaram. Atualize e confirme o novo valor antes de continuar.', 409);
    }
    const oferta = (await tx.query<Oferta>(`INSERT INTO assinatura_contratacoes
        (empresa_id,chave_idempotencia,plano,ciclo,catalogo_versao,valor_regular_centavos,desconto_percentual,valor_final_centavos,fundador_id,criada_por)
        VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9::uuid,$10::uuid) RETURNING *`,
        [empresaId, randomUUID(), pedido.plano.toUpperCase(), pedido.ciclo, condicoesComerciais.versao,
            valorComercial(pedido.plano,ciclo), campanha.elegivel ? 40 : 0, valor, fundadorId, usuarioId])).rows[0];
    if (!oferta) throw new Error('Oferta não foi persistida.');
    // Grupo B (096): comprovante com as versões CONFIRMADAS na síntese, na MESMA transação da oferta; sem a 096, nada muda.
    if (documentos) await registrarComprovante(tx, { empresaId, usuarioId, oferta, pagueAte: (await validadeDaConcessao(tx, fundadorId))?.dia ?? null, documentos });
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
    // D3: pagamento depois da validade não confirma sozinho: fica para reconciliação, sem liberar a vaga, sem reprecificar
    // e sem cobrança complementar automática. Vale a data MAIS ANTIGA informada pelo provedor (`clientPaymentDate` do
    // boleto, `confirmedDate` do cartão, `paymentDate`); nunca a chegada do webhook nem o relógio.
    const validade = oferta.estado === 'EM_ABERTO' && beneficio?.estado === 'RESERVADA' ? await validadeDaConcessao(tx, oferta.fundador_id) : null;
    if (validade) {
        const pagoEm = dataDoPagamento(pagamento);
        if (!pagoEm || pagoEm > validade.dia)
            throw erroAcesso('FUNDADOR_OFERTA_EXPIRADA', pagoEm
                ? PAGAMENTO_TARDIO
                : 'O provedor não informou a data do pagamento: a contratação Fundador fica em reconciliação pelo atendimento.', 409);
    }
    if (!ativar) return null;
    if (oferta.estado === 'EM_ABERTO') {
        // B14: transição — o WHERE só aceita o estado de origem, então nunca regrava o mesmo valor.
        if (beneficio?.estado === 'RESERVADA') await tx.query(`UPDATE assinatura_fundadores SET estado = 'CONFIRMADA',
            confirmada_em = clock_timestamp(), pagamento_confirmacao_id = $3
            WHERE id = $1::uuid AND empresa_id = $2::uuid AND estado = 'RESERVADA'`, [oferta.fundador_id,empresaId,pagamento.id]);
        // B14: transição — o WHERE só aceita o estado de origem, então nunca regrava o mesmo valor.
        await tx.query(`UPDATE assinatura_contratacoes SET estado = 'CONFIRMADA', confirmada_em = clock_timestamp(),
            pagamento_confirmacao_id = $3, provedor_assinatura_id = $4
            WHERE id = $1::uuid AND empresa_id = $2::uuid AND estado = 'EM_ABERTO'`, [oferta.id,empresaId,pagamento.id,assinatura!.id]);
    }
    return oferta.estado === 'EM_ABERTO' ? { id: oferta.id, plano: oferta.plano } : null;
}
