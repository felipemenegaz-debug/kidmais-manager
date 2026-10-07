/**
 * Cobrança da assinatura pela Gestão da empresa (E8, Asaas SANDBOX).
 *
 *   iniciarAssinatura  devolve a página hospedada de pagamento do Asaas (invoiceUrl = "checkout"). Idempotente: com
 *                      assinatura ativa no provedor, devolve a cobrança em aberto dela em vez de criar outra; uma
 *                      assinatura criada antes e não gravada aqui (falha no commit) é reencontrada pela referência
 *                      externa (= id da empresa). Gravar os ids do provedor NÃO muda a situação nem o acesso:
 *                      só webhook/sincronização liberam (voltar da página de pagamento não concede nada).
 *   cancelarAssinatura remove a assinatura no provedor (cobranças pendentes saem, pagas ficam) e sincroniza:
 *                      CANCELADA_FIM_PERIODO com acesso até o fim do período pago. Exige senha confirmada há ≤ 5 min.
 *
 * Três fases para não segurar travas do banco durante a chamada ao provedor:
 *   A. transação curta do tenant: Gestão, situação e ids gravados;
 *   B. provedor, sem transação aberta (10 s por chamada);
 *   C. transação curta do tenant: trava a linha, confere que nada mudou e grava ids/estado; audita.
 * Falhas: provedor criou e o commit da fase C falhou → a próxima tentativa reencontra cliente e assinatura pela
 * referência externa; o webhook e a reconciliação (scripts/assinatura-reconciliar.cjs) corrigem o resto. Provedor fora
 * do ar → COBRANCA_FALHOU (502) e nada é gravado.
 */
import type { DbExecutor } from '../db/contracts';
import type { SessaoAdmin } from '../autenticacao/service.ts';
import type { TenantComprovado } from '../saas/provar-tenant.ts';
import { AcessoServiceError, erroAcesso } from '../acessos/erros.ts';
import { exigirReautenticacaoRecente } from '../desenvolvedor/autorizacao.ts';
import { precoDoCiclo, ConfiguracaoComercialInvalida, type Ciclo } from './configuracao.ts';
import { AsaasFalhou, cicloDoProvedor, type AssinaturaProvedor, type ClienteAsaas } from './asaas.ts';
import { cobrancaEmAberto } from './provedor-estado.ts';
import { auditarCobranca, sincronizarEmpresa } from './sincronizacao.ts';
import { registrarPendencia } from './reconciliacao-contratacao.ts';
import { decidirCompensacao, type DecisaoCompensacao } from './compensacao.ts';

const GESTAO = 'REPRESENTANTE_AUTORIZADO';
const CNPJ = /^[0-9A-Z]{12}[0-9]{2}$/;

export type Contexto = { requestId: string; ip?: string | null; userAgent?: string | null };
export type DepsCobranca = {
    withTenantTransaction: <T>(sessao: SessaoAdmin, empresaSolicitada: string | null | undefined, trabalho: (tx: DbExecutor, tenant: TenantComprovado) => Promise<T>) => Promise<T>;
    /** Cliente do provedor, ou null quando a cobrança está desligada neste ambiente. */
    provedor: () => ClienteAsaas | null;
    env?: Record<string, string | undefined>;
    /** Transação comum (sem tenant): releitura do vínculo e registro de pendências. */
    withTransaction: <T>(trabalho: (tx: DbExecutor) => Promise<T>) => Promise<T>;
    /** Executa a contratação com a trava exclusiva da empresa; ocupada → 409 CONTRATACAO_EM_ANDAMENTO. */
    travarContratacao: <T>(empresaId: string, trabalho: () => Promise<T>) => Promise<T>;
};

/**
 * Trava exclusiva por empresa para a contratação: pg_try_advisory_xact_lock numa transação própria, mantida aberta
 * durante as fases A/B/C. Duas contratações da mesma empresa (abas, cliques, instâncias) nunca rodam juntas; se o
 * processo cair, a conexão fecha e a trava some sozinha. Não trava linha nenhuma.
 */
export function travaPorEmpresa(withTransaction: DepsCobranca['withTransaction']): DepsCobranca['travarContratacao'] {
    return (empresaId, trabalho) => withTransaction(async (tx) => {
        const livre = (await tx.query<{ ok: boolean }>("SELECT pg_try_advisory_xact_lock(hashtext('kidmais:contratacao'), hashtext($1)) AS ok", [empresaId])).rows[0]?.ok === true;
        if (!livre)
            throw erroAcesso('CONTRATACAO_EM_ANDAMENTO', 'Já existe uma contratação desta empresa em andamento. Aguarde alguns segundos e atualize a página.', 409);
        return trabalho();
    });
}

type Linha = {
    situacao: string; ciclo: Ciclo | null; provedor_cliente_id: string | null; provedor_assinatura_id: string | null;
    provedor_situacao: string | null; documento_teste: string | null; nome: string; hoje: string;
};

function exigirGestao(tenant: TenantComprovado) {
    if (tenant.papelAtual !== GESTAO)
        throw erroAcesso('COBRANCA_SEM_PERMISSAO', 'Somente a Gestão desta empresa contrata ou cancela a assinatura.', 403);
}
const desligada = () => erroAcesso('COBRANCA_NAO_CONFIGURADA', 'A contratação on-line ainda não está disponível neste ambiente.', 503);
const incerto = () => erroAcesso('COBRANCA_RESULTADO_INCERTO', 'Não conseguimos confirmar o resultado com o provedor de pagamento. Nada será cobrado em duplicidade: atualize a página em alguns instantes.', 503);
const falhou = () => erroAcesso('COBRANCA_FALHOU', 'Não foi possível falar com o provedor de pagamento agora. Nada foi alterado; tente novamente em instantes.', 502);

async function linhaDaEmpresa(tx: DbExecutor, empresaId: string, travar: boolean): Promise<Linha | null> {
    const instalada = (await tx.query<{ ok: boolean }>("SELECT to_regclass('public.cobranca_eventos') IS NOT NULL AS ok")).rows[0]?.ok === true;
    if (!instalada)
        throw desligada();
    return (await tx.query<Linha>(
        `SELECT a.situacao, a.ciclo, a.provedor_cliente_id, a.provedor_assinatura_id, a.provedor_situacao, a.documento_teste, e.nome,
                to_char(clock_timestamp() AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS hoje
           FROM empresa_assinaturas a JOIN empresas e ON e.id = a.empresa_id
          WHERE a.empresa_id = $1::uuid ${travar ? 'FOR UPDATE OF a' : ''}`, [empresaId])).rows[0] ?? null;
}

/** CNPJ e razão social para o cadastro do cliente no provedor: o CNPJ do teste; senão o do cadastro da plataforma (063). */
async function dadosDoCliente(tx: DbExecutor, empresaId: string, linha: Linha) {
    let nome = linha.nome, documento = linha.documento_teste;
    if ((await tx.query<{ ok: boolean }>("SELECT to_regclass('public.plataforma_empresas_cadastro') IS NOT NULL AS ok")).rows[0]?.ok) {
        const c = (await tx.query<{ nome_empresarial: string | null; documento_fiscal: string | null }>(
            'SELECT nome_empresarial, documento_fiscal FROM plataforma_empresas_cadastro WHERE empresa_id = $1::uuid', [empresaId])).rows[0];
        if (c?.nome_empresarial?.trim())
            nome = c.nome_empresarial.trim();
        if (!documento && c?.documento_fiscal && CNPJ.test(c.documento_fiscal))
            documento = c.documento_fiscal;
    }
    return { nome, documento };
}

const ativa = (a: AssinaturaProvedor | null) => Boolean(a && !a.deleted && a.status === 'ACTIVE');
/** Retomada só com UMA candidata inequívoca (única ativa da referência, do mesmo cliente). Várias → nunca escolhe a primeira. */
function unicaCandidata(lista: readonly AssinaturaProvedor[], clienteId: string | null) {
    const ativas = lista.filter(ativa);
    if (ativas.length === 0)
        return { tipo: 'NENHUMA' as const };
    if (ativas.length === 1 && (!ativas[0].customer || ativas[0].customer === clienteId))
        return { tipo: 'UNICA' as const, assinatura: ativas[0] };
    return { tipo: 'AMBIGUA' as const };
}

async function noProvedor<T>(acao: () => Promise<T>): Promise<T> {
    try {
        return await acao();
    }
    catch (error) {
        if (error instanceof AsaasFalhou)
            throw falhou();
        throw error;
    }
}

export async function iniciarAssinatura(sessao: SessaoAdmin, empresaSolicitada: string | null | undefined, raw: unknown, ctx: Contexto, deps: DepsCobranca) {
    const ciclo = (raw as { ciclo?: unknown } | null)?.ciclo;
    if (ciclo !== 'MENSAL' && ciclo !== 'ANUAL')
        throw erroAcesso('DADOS_INVALIDOS', 'Escolha o plano mensal ou anual.', 400, { campo: 'ciclo' });
    let preco: number | null;
    try {
        preco = precoDoCiclo(ciclo, deps.env ?? process.env);
    }
    catch (error) {
        if (error instanceof ConfiguracaoComercialInvalida)
            throw desligada();
        throw error;
    }
    if (!preco)
        throw erroAcesso('COBRANCA_NAO_CONFIGURADA', 'Este plano ainda não está publicado neste ambiente.', 503);
    const provedor = deps.provedor();
    if (!provedor)
        throw desligada();
    // Empresa comprovada primeiro (a trava é por empresa); depois TODA a contratação roda sob a trava.
    const empresaId = await deps.withTenantTransaction(sessao, empresaSolicitada, async (_tx, tenant) => {
        exigirGestao(tenant);
        return tenant.empresaComprovada;
    });
    return deps.travarContratacao(empresaId, () => contratar(sessao, empresaSolicitada, empresaId, ciclo, preco, provedor, ctx, deps));
}

async function contratar(sessao: SessaoAdmin, empresaSolicitada: string | null | undefined, empresaId: string, ciclo: Ciclo, preco: number, provedor: ClienteAsaas, ctx: Contexto, deps: DepsCobranca) {
    // A. leitura curta (sob a trava: o que outra contratação já gravou aparece aqui)
    const a = await deps.withTenantTransaction(sessao, empresaSolicitada, async (tx, tenant) => {
        exigirGestao(tenant);
        if (tenant.empresaComprovada !== empresaId)
            throw erroAcesso('CONFLITO', 'A empresa da sessão mudou. Atualize a página.', 409);
        const linha = await linhaDaEmpresa(tx, empresaId, false);
        if (!linha)
            throw erroAcesso('CONFLITO', 'Esta empresa não tem cobrança registrada no Kidmais Manager.', 409);
        return { linha, cliente: await dadosDoCliente(tx, empresaId, linha) };
    });

    // B. provedor, sem transação de tenant aberta
    const b = await noProvedor(async () => {
        const anterior = a.linha.provedor_assinatura_id ? await provedor.obterAssinatura(a.linha.provedor_assinatura_id) : null;
        if (anterior && ativa(anterior)) {
            const aberta = cobrancaEmAberto(await provedor.listarCobrancasDaAssinatura(anterior.id));
            return { assinatura: anterior, clienteId: a.linha.provedor_cliente_id ?? anterior.customer, aberta, criada: false, reaproveitada: true };
        }
        let clienteId = a.linha.provedor_cliente_id;
        if (!clienteId) {
            const existente = await provedor.buscarClientePorReferencia(empresaId);
            if (existente)
                clienteId = existente.id;
            else {
                if (!a.cliente.documento)
                    throw erroAcesso('CONFLITO', 'Cadastre o CNPJ da empresa antes de assinar (Perfil da empresa ou atendimento Kidmais).', 409);
                clienteId = (await provedor.criarCliente({ nome: a.cliente.nome, cpfCnpj: a.cliente.documento, referencia: empresaId })).id;
            }
        }
        // Retomada: assinatura ativa criada antes e não gravada (resposta perdida, COMMIT incerto) é reaproveitada.
        const retomada = unicaCandidata(await provedor.listarAssinaturasPorReferencia(empresaId), clienteId);
        if (retomada.tipo === 'UNICA')
            return { assinatura: retomada.assinatura, clienteId, aberta: await cobrancaAberta(provedor, retomada.assinatura.id), criada: false, reaproveitada: true };
        if (retomada.tipo === 'AMBIGUA') {
            // Várias assinaturas (ou de outro cliente) para a empresa: não escolhe, não cria outra, não exclui.
            await registrarPendenciaSegura(deps, { empresaId, assinaturaId: null, motivo: 'ASSINATURAS_AMBIGUAS' });
            throw incerto();
        }
        let assinatura: AssinaturaProvedor;
        try {
            assinatura = await provedor.criarAssinatura({
                cliente: clienteId, valorCentavos: preco, ciclo, vencimento: a.linha.hoje, referencia: empresaId,
                descricao: `Kidmais Manager — assinatura ${ciclo === 'MENSAL' ? 'mensal' : 'anual'}`,
            });
        }
        catch (error) {
            if (!resultadoIncerto(error))
                throw error;
            // Resposta perdida: o provedor pode ter criado. Nunca cria outra às cegas; procura pela referência.
            const achadas = await provedor.listarAssinaturasPorReferencia(empresaId).catch(() => null);
            const confirmada = achadas ? unicaCandidata(achadas, clienteId) : null;
            if (confirmada?.tipo === 'UNICA')
                return { assinatura: confirmada.assinatura, clienteId, aberta: await cobrancaAberta(provedor, confirmada.assinatura.id), criada: true, reaproveitada: false };
            await registrarPendenciaSegura(deps, { empresaId, assinaturaId: null, motivo: 'CRIACAO_SEM_RESPOSTA' });
            throw incerto();
        }
        return { assinatura, clienteId, aberta: await cobrancaAberta(provedor, assinatura.id), criada: true, reaproveitada: false };
    });

    // C. grava os ids (nunca a situação) com a linha travada
    try {
        await deps.withTenantTransaction(sessao, empresaSolicitada, async (tx, tenant) => {
            exigirGestao(tenant);
            if (tenant.empresaComprovada !== empresaId)
                throw erroAcesso('CONFLITO', 'A empresa da sessão mudou. Atualize a página.', 409);
            let linha = await linhaDaEmpresa(tx, empresaId, true);
            if (!linha)
                throw erroAcesso('CONFLITO', 'Esta empresa não tem cobrança registrada no Kidmais Manager.', 409);
            if (linha.provedor_cliente_id && b.clienteId && linha.provedor_cliente_id !== b.clienteId)
                throw erroAcesso('CONFLITO', 'O cadastro no provedor mudou durante a operação. Atualize a página e tente de novo.', 409);
            if (linha.provedor_assinatura_id && linha.provedor_assinatura_id !== b.assinatura.id) {
                if (linha.provedor_assinatura_id !== a.linha.provedor_assinatura_id)
                    throw erroAcesso('CONFLITO', 'Outra contratação foi iniciada ao mesmo tempo. Atualize a página.', 409);
                // A assinatura anterior não está ativa no provedor: aplica o estado dela antes de trocar (068: a troca só
                // é aceita em TESTE, CANCELADA_FIM_PERIODO ou ENCERRADA).
                if (linha.situacao === 'ATIVA' || linha.situacao === 'EM_ATRASO') {
                    await sincronizarEmpresa(tx, empresaId, { provedor }, { tipo: 'GESTAO', usuarioId: sessao.usuario_id, requestId: ctx.requestId });
                    linha = await linhaDaEmpresa(tx, empresaId, true);
                    if (!linha || linha.situacao === 'ATIVA' || linha.situacao === 'EM_ATRASO')
                        throw erroAcesso('CONFLITO', 'A assinatura atual continua ativa no provedor.', 409);
                }
            }
            await tx.query(
                `UPDATE empresa_assinaturas SET provedor = 'ASAAS', provedor_cliente_id = COALESCE(provedor_cliente_id, $2), provedor_assinatura_id = $3,
                        ciclo = CASE WHEN situacao IN ('TESTE', 'ENCERRADA') THEN $4 ELSE ciclo END, provedor_situacao = $5
                  WHERE empresa_id = $1::uuid`,
                [empresaId, b.clienteId, b.assinatura.id, cicloDoProvedor(b.assinatura.cycle) ?? ciclo, b.assinatura.status.slice(0, 40)]);
            await auditarCobranca(tx, {
                acao: b.reaproveitada ? 'ASSINATURA_CHECKOUT_RETOMADO' : 'ASSINATURA_CHECKOUT_INICIADO', empresaId,
                origem: { tipo: 'GESTAO', usuarioId: sessao.usuario_id, requestId: ctx.requestId }, ip: ctx.ip ?? null,
                depois: { situacao: linha.situacao, ciclo: cicloDoProvedor(b.assinatura.cycle) ?? ciclo, cobrancaEmAberto: Boolean(b.aberta) },
            });
        });
    }
    catch (error) {
        await resolverFalhaNoVinculo(error, empresaId, a.linha.provedor_assinatura_id, b, provedor, deps);
    }
    return {
        ciclo: cicloDoProvedor(b.assinatura.cycle) ?? ciclo,
        reaproveitada: b.reaproveitada,
        // Página hospedada do Asaas; o acesso só muda quando o pagamento for confirmado (webhook + reconsulta).
        urlPagamento: b.aberta?.invoiceUrl ?? null,
        vencimento: b.aberta?.dueDate ?? null,
    };
}

/** Status HTTP 4xx definitivo = o provedor recusou e não criou nada. Tempo esgotado, rede, 5xx, 408/409/429 e resposta ilegível = incerto. */
export function resultadoIncerto(error: unknown) {
    if (!(error instanceof AsaasFalhou))
        return false;
    const s = error.status;
    return s === null || s >= 500 || s === 408 || s === 409 || s === 429 || s < 400;
}

async function cobrancaAberta(provedor: ClienteAsaas, assinaturaId: string) {
    // A assinatura já existe: falha só na leitura da cobrança não pode impedir o vínculo (a página sai na próxima vez).
    try {
        return cobrancaEmAberto(await provedor.listarCobrancasDaAssinatura(assinaturaId));
    }
    catch (error) {
        if (error instanceof AsaasFalhou)
            return null;
        throw error;
    }
}

/** Registra a pendência sem mascarar o erro original; se nem isso for possível, o log diz (sem dados) e o vínculo pela referência externa ainda permite retomar. */
async function registrarPendenciaSegura(deps: DepsCobranca, input: Parameters<typeof registrarPendencia>[1]) {
    try {
        await deps.withTransaction((tx) => registrarPendencia(tx, input));
        return true;
    }
    catch (error) {
        console.error('[cobrança] pendência de reconciliação NÃO registrada', input.motivo, error instanceof Error ? error.name : typeof error);
        return false;
    }
}

/**
 * Falha na fase C (gravação do vínculo). O COMMIT pode ter acontecido mesmo com erro de comunicação, então o banco é
 * relido por uma transação nova:
 *   - vinculada a ESTA assinatura → COMMIT confirmado: segue como sucesso (nada é desfeito);
 *   - esta foi criada agora e o banco mostra OUTRO vínculo → a decisão central (compensacao.ts) confere a assinatura
 *     vigente e os pagamentos; só com justificativa segura exclui (falha ao excluir → pendência COMPENSACAO_FALHOU);
 *     preservada → pendência com o motivo (vínculo que não mudou = COMMIT_INCERTO, ex.: recontratação após cancelamento);
 *   - qualquer outra dúvida (releitura falhou, nenhuma vinculada) → NADA é excluído; pendência e resposta "incerta".
 */
async function resolverFalhaNoVinculo(error: unknown, empresaId: string, vinculoAnterior: string | null, b: { assinatura: AssinaturaProvedor; criada: boolean }, provedor: ClienteAsaas, deps: DepsCobranca) {
    // Só o tipo do erro (sem mensagem, ids ou dados): permite investigar sem expor nada.
    console.warn('[cobrança] falha ao gravar o vínculo da assinatura', error instanceof Error ? ((error as { code?: string }).code ?? error.name) : typeof error);
    let vinculo: string | null | undefined;
    try {
        vinculo = await deps.withTransaction(async (tx) => (await tx.query<{ id: string | null }>(
            'SELECT provedor_assinatura_id AS id FROM empresa_assinaturas WHERE empresa_id = $1::uuid', [empresaId])).rows[0]?.id ?? null);
    }
    catch {
        vinculo = undefined;
    }
    if (vinculo === b.assinatura.id)
        return;
    const responder = () => { throw error instanceof AcessoServiceError ? error : incerto(); };
    if (typeof vinculo === 'string' && b.criada) {
        let decisao: DecisaoCompensacao | null;
        try {
            decisao = await decidirCompensacao(provedor, { empresaId, vinculo, vinculoAnterior, candidataId: b.assinatura.id });
        }
        catch {
            decisao = null; // provedor indisponível para confirmar: preserva
        }
        if (decisao?.excluir) {
            try {
                await provedor.removerAssinatura(b.assinatura.id);
            }
            catch {
                await registrarPendenciaSegura(deps, { empresaId, assinaturaId: b.assinatura.id, motivo: 'COMPENSACAO_FALHOU' });
            }
            throw error;
        }
        if (decisao?.motivo === 'VINCULO_NAO_MUDOU')
            await registrarPendenciaSegura(deps, { empresaId, assinaturaId: b.assinatura.id, motivo: 'COMMIT_INCERTO' });
        else
            await registrarPendenciaSegura(deps, { empresaId, assinaturaId: b.assinatura.id, motivo: decisao ? 'COMPENSACAO_PRESERVADA' : 'VINCULO_DUVIDOSO', detalhe: decisao?.motivo });
        return responder();
    }
    if (typeof vinculo === 'string')
        throw error;
    await registrarPendenciaSegura(deps, { empresaId, assinaturaId: b.assinatura.id, motivo: vinculo === undefined || error instanceof AcessoServiceError ? 'VINCULO_DUVIDOSO' : 'COMMIT_INCERTO' });
    if (error instanceof AcessoServiceError && vinculo === null)
        throw error;
    throw incerto();
}

export async function cancelarAssinatura(sessao: SessaoAdmin, empresaSolicitada: string | null | undefined, raw: unknown, ctx: Contexto, deps: DepsCobranca) {
    const corpo = (raw ?? {}) as { confirmar?: unknown; motivo?: unknown };
    if (corpo.confirmar !== true)
        throw erroAcesso('DADOS_INVALIDOS', 'Confirme o cancelamento.', 400, { campo: 'confirmar' });
    const motivo = typeof corpo.motivo === 'string' ? corpo.motivo.trim().slice(0, 500) : '';
    exigirReautenticacaoRecente(sessao);
    const provedor = deps.provedor();
    if (!provedor)
        throw desligada();

    const a = await deps.withTenantTransaction(sessao, empresaSolicitada, async (tx, tenant) => {
        exigirGestao(tenant);
        const linha = await linhaDaEmpresa(tx, tenant.empresaComprovada, false);
        if (!linha?.provedor_assinatura_id)
            throw erroAcesso('CONFLITO', 'Não há assinatura contratada para cancelar.', 409);
        if ((linha.situacao === 'CANCELADA_FIM_PERIODO' || linha.situacao === 'ENCERRADA') && linha.provedor_situacao === 'DELETED')
            throw erroAcesso('CONFLITO', 'A assinatura já foi cancelada.', 409);
        return { empresaId: tenant.empresaComprovada, assinaturaId: linha.provedor_assinatura_id, situacao: linha.situacao };
    });

    await noProvedor(() => provedor.removerAssinatura(a.assinaturaId));

    return deps.withTenantTransaction(sessao, empresaSolicitada, async (tx, tenant) => {
        exigirGestao(tenant);
        if (tenant.empresaComprovada !== a.empresaId)
            throw erroAcesso('CONFLITO', 'A empresa da sessão mudou. Atualize a página.', 409);
        const origem = { tipo: 'GESTAO' as const, usuarioId: sessao.usuario_id, requestId: ctx.requestId };
        let r;
        try {
            r = await sincronizarEmpresa(tx, a.empresaId, { provedor }, origem);
        }
        catch (error) {
            // A remoção no provedor já aconteceu; o webhook SUBSCRIPTION_DELETED ou a reconciliação aplicam o estado.
            if (error instanceof AsaasFalhou)
                throw erroAcesso('COBRANCA_FALHOU', 'O cancelamento foi enviado ao provedor, mas a confirmação ainda não chegou. Atualize a página em instantes.', 502);
            throw error;
        }
        await auditarCobranca(tx, {
            acao: 'ASSINATURA_CANCELADA', empresaId: a.empresaId, origem, ip: ctx.ip ?? null, justificativa: motivo || null,
            antes: { situacao: a.situacao }, depois: { situacao: r.resultado === 'SINCRONIZADA' ? r.depois : a.situacao },
        });
        return { situacao: r.resultado === 'SINCRONIZADA' ? r.depois : a.situacao };
    });
}
