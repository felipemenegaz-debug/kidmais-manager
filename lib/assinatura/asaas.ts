/**
 * Cliente mínimo da API Asaas (E8). Sem SDK: `fetch` com tempo-limite e injeção para testes. Nenhuma função aqui grava
 * no banco, registra log ou devolve a chave em mensagens de erro.
 *
 * Configuração (somente nomes; valores ficam no ambiente do serviço, nunca no código ou em arquivos versionados):
 *   ASAAS_AMBIENTE        `sandbox` ou `producao`, PAREADO com KIDMAIS_DEPLOY_ENV: `producao` só no serviço de produção
 *                         (KIDMAIS_DEPLOY_ENV=production) e `sandbox` nunca nele. Divergência, ausência ou outro valor deixa
 *                         a cobrança DESLIGADA com motivo explícito (fail-closed).
 *   ASAAS_API_KEY         chave da conta do ambiente: `$aact_hmlg_` (sandbox) ou `$aact_prod_` (produção). Nunca reutilizar.
 *   ASAAS_WEBHOOK_TOKEN   token do webhook (32–255 caracteres), conferido no cabeçalho `asaas-access-token`; exclusivo do ambiente.
 *
 * Fontes oficiais (lidas em 06–07/10/2026):
 *   autenticação/sandbox  https://docs.asaas.com/docs/autenticação-1 · https://docs.asaas.com/docs/sandbox
 *   clientes              https://docs.asaas.com/reference/listar-clientes · https://docs.asaas.com/reference/criar-novo-cliente
 *   assinaturas           https://docs.asaas.com/reference/criar-nova-assinatura · https://docs.asaas.com/reference/listar-assinaturas
 *                         https://docs.asaas.com/reference/recuperar-uma-unica-assinatura · https://docs.asaas.com/reference/remover-assinatura
 *   cobranças             https://docs.asaas.com/reference/listar-cobrancas-de-uma-assinatura
 *   estorno (21/10/2026)  https://docs.asaas.com/reference/estornar-cobranca · https://docs.asaas.com/reference/estornar-boleto
 *                         https://docs.asaas.com/docs/estornos · https://docs.asaas.com/docs/webhook-para-cobrancas
 *   webhooks              https://docs.asaas.com/docs/sobre-os-webhooks
 *   avulsa (22/10/2026)   https://docs.asaas.com/reference/criar-nova-cobranca · https://docs.asaas.com/reference/listar-cobrancas
 *                         (créditos de IA, lib/creditos: contrato PLANEJADO, exercitado só com dublê; sandbox NÃO executado)
 */
import type { Ciclo } from './configuracao.ts';

export const ASAAS_SANDBOX_URL = 'https://api-sandbox.asaas.com/v3';
export const PREFIXO_CHAVE_SANDBOX = '$aact_hmlg_';
export const ASAAS_PRODUCAO_URL = 'https://api.asaas.com/v3';
export const PREFIXO_CHAVE_PRODUCAO = '$aact_prod_';
export type AmbienteAsaas = 'sandbox' | 'producao';
/** URL e prefixo de chave de cada ambiente: a combinação é fixa (nunca chave de um com a URL do outro). */
const AMBIENTES: Record<AmbienteAsaas, { baseUrl: string; prefixo: string }> = {
    sandbox: { baseUrl: ASAAS_SANDBOX_URL, prefixo: PREFIXO_CHAVE_SANDBOX },
    producao: { baseUrl: ASAAS_PRODUCAO_URL, prefixo: PREFIXO_CHAVE_PRODUCAO },
};
export const TEMPO_LIMITE_MS = 10_000;
const USER_AGENT = 'kidmais-manager';
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const DATA = /^\d{4}-\d{2}-\d{2}$/;

type Ambiente = Record<string, string | undefined>;
export type ConfiguracaoAsaas = { ambiente: AmbienteAsaas; baseUrl: string; apiKey: string; webhookToken: string };
export type MotivoDesligado = 'AMBIENTE_AUSENTE' | 'AMBIENTE_NAO_SUPORTADO' | 'AMBIENTE_DIVERGENTE' | 'CHAVE_AUSENTE' | 'CHAVE_FORA_DO_SANDBOX' | 'CHAVE_FORA_DA_PRODUCAO' | 'TOKEN_WEBHOOK_INVALIDO';
export type EstadoConfiguracao = { ligado: true; config: ConfiguracaoAsaas } | { ligado: false; motivo: MotivoDesligado };

const EXPLICACAO: Record<MotivoDesligado, string> = {
    AMBIENTE_AUSENTE: 'ASAAS_AMBIENTE não definido: cobrança desligada.',
    AMBIENTE_NAO_SUPORTADO: 'ASAAS_AMBIENTE aceita somente "sandbox" ou "producao": cobrança desligada.',
    AMBIENTE_DIVERGENTE: 'ASAAS_AMBIENTE não corresponde ao serviço (produção exige "producao"; os demais, "sandbox"): cobrança desligada.',
    CHAVE_AUSENTE: 'ASAAS_API_KEY não definida: cobrança desligada.',
    CHAVE_FORA_DO_SANDBOX: 'ASAAS_API_KEY não é uma chave de sandbox: cobrança desligada.',
    CHAVE_FORA_DA_PRODUCAO: 'ASAAS_API_KEY não é uma chave de produção: cobrança desligada.',
    TOKEN_WEBHOOK_INVALIDO: 'ASAAS_WEBHOOK_TOKEN ausente ou fora de 32–255 caracteres: cobrança desligada.',
};
export const explicarDesligado = (motivo: MotivoDesligado) => EXPLICACAO[motivo];

/** Lê e valida a configuração. Nunca devolve a chave em mensagens; o valor só sai daqui dentro de `config`. */
export function configuracaoAsaas(env: Ambiente = process.env): EstadoConfiguracao {
    const ambiente = ambienteAsaas(env);
    if (typeof ambiente !== 'string')
        return { ligado: false, motivo: ambiente.motivo };
    const apiKey = env.ASAAS_API_KEY?.trim() ?? '';
    if (!apiKey)
        return { ligado: false, motivo: 'CHAVE_AUSENTE' };
    const { baseUrl, prefixo } = AMBIENTES[ambiente];
    if (!apiKey.startsWith(prefixo) || apiKey.length > 300 || /\s/.test(apiKey))
        return { ligado: false, motivo: ambiente === 'producao' ? 'CHAVE_FORA_DA_PRODUCAO' : 'CHAVE_FORA_DO_SANDBOX' };
    const webhookToken = env.ASAAS_WEBHOOK_TOKEN ?? '';
    if (!/^[\x21-\x7e]{32,255}$/.test(webhookToken))
        return { ligado: false, motivo: 'TOKEN_WEBHOOK_INVALIDO' };
    return { ligado: true, config: { ambiente, baseUrl, apiKey, webhookToken } };
}

/**
 * Ambiente do provedor PAREADO com o serviço (sem olhar chaves): `producao` exige KIDMAIS_DEPLOY_ENV=production e o
 * serviço de produção nunca aceita `sandbox` (nem cobrança de mentira em produção, nem cobrança real fora dela).
 */
export function ambienteAsaas(env: Ambiente = process.env): AmbienteAsaas | { motivo: MotivoDesligado } {
    const ambiente = env.ASAAS_AMBIENTE?.trim();
    if (!ambiente)
        return { motivo: 'AMBIENTE_AUSENTE' };
    if (ambiente !== 'sandbox' && ambiente !== 'producao')
        return { motivo: 'AMBIENTE_NAO_SUPORTADO' };
    const servicoDeProducao = env.KIDMAIS_DEPLOY_ENV?.trim() === 'production';
    if ((ambiente === 'producao') !== servicoDeProducao)
        return { motivo: 'AMBIENTE_DIVERGENTE' };
    return ambiente;
}

/** Falha de comunicação ou resposta inesperada. A mensagem nunca leva corpo da resposta, chave ou dado do pagador. */
/** LISTA_INCOMPLETA: o provedor tem mais páginas que o limite conferido. Não é indisponibilidade: repetir não resolve. */
export type MotivoFalhaAsaas = 'HTTP' | 'TEMPO_ESGOTADO' | 'REDE' | 'RESPOSTA_INVALIDA' | 'LISTA_INCOMPLETA';

export class AsaasFalhou extends Error {
    readonly operacao: string;
    readonly status: number | null;
    readonly motivo: MotivoFalhaAsaas;
    constructor(operacao: string, status: number | null, motivo: MotivoFalhaAsaas) {
        super(`Asaas: ${operacao} falhou (${motivo}${status ? ` ${status}` : ''}).`);
        this.name = 'AsaasFalhou';
        this.operacao = operacao;
        this.status = status;
        this.motivo = motivo;
    }
}

export type ClienteProvedor = { id: string; externalReference: string | null };
export type AssinaturaProvedor = { id: string; status: string; deleted: boolean; cycle: string | null; customer: string | null; externalReference: string | null; valorCentavos?: number | null; nextDueDate?: string | null };
export type CobrancaProvedor = { id: string; status: string; dueDate: string; paymentDate: string | null; invoiceUrl: string | null; deleted: boolean; valorCentavos?: number | null; assinaturaId?: string | null; clienteId?: string | null; billingType?: string | null;
    /** `confirmedDate` (cartão confirmado antes de `paymentDate`). */
    confirmedDate?: string | null;
    /** Correlação gravada por nós na criação (créditos: km:<ambiente>:creditos:<pedido>); nunca prova idempotência. */
    externalReference?: string | null;
    /** `refunds[]` da cobrança, quando o provedor devolve (créditos, P2-5: estornos parciais concluídos = status DONE). */
    estornos?: EstornoProvedor[] };

/** Situação de cada devolução da cobrança (`refunds[]`): só `DONE` conta como devolvida (docs.asaas.com/docs/estornos). */
export type EstornoProvedor = { status: string; valorCentavos: number | null; descricao: string | null };
export type ResultadoEstorno = { status: string; estornos: EstornoProvedor[] };
/**
 * Estorno de cobrança (POST /v3/payments/{id}/refund). Escrita financeira: quem chama grava o registro prévio ANTES e
 * nunca repete depois de resultado desconhecido. Boleto não passa por aqui (exige dados bancários do pagador).
 */
export type ProvedorEstorno = {
    obterCobranca(id: string): Promise<CobrancaProvedor | null>;
    estornarCobranca(id: string, valorCentavos: number, descricao: string): Promise<ResultadoEstorno>;
};

/**
 * Cobrança AVULSA dos pacotes de créditos (POST /v3/payments, sem `subscription`): nunca ativa nem renova assinatura.
 * `externalReference` é só correlação; timeout depois do POST é resultado INCERTO (quem chama não repete o POST e
 * procura pela referência). Cartão: só a fatura hospedada do provedor (nenhum dado de cartão passa por aqui).
 */
export type ProvedorCreditos = {
    obterCobranca(id: string): Promise<CobrancaProvedor | null>;
    criarCobrancaAvulsa(input: { cliente: string; forma: 'PIX' | 'CREDIT_CARD' | 'BOLETO'; valorCentavos: number; vencimento: string; descricao: string; referencia: string }): Promise<CobrancaProvedor>;
    /** Todas as páginas (até o limite conferido); lista maior → AsaasFalhou LISTA_INCOMPLETA (nunca "não existe"). */
    listarCobrancasPorReferencia(referencia: string): Promise<CobrancaProvedor[]>;
} & Partial<Pick<ProvedorEstorno, 'estornarCobranca'>>;

export type ProvedorRenovacao = Pick<ClienteAsaas, 'obterAssinatura' | 'listarCobrancasDaAssinatura'> & {
    obterCobranca(id: string): Promise<CobrancaProvedor | null>;
    atualizarValorAssinatura(id: string, valorCentavos: number): Promise<AssinaturaProvedor>;
    atualizarValorCobranca(cobranca: CobrancaProvedor, valorCentavos: number): Promise<CobrancaProvedor>;
    suspenderGeracao(id: string): Promise<AssinaturaProvedor>;
};

export type ClienteAsaas = {
    buscarClientePorReferencia(referencia: string): Promise<ClienteProvedor | null>;
    criarCliente(input: { nome: string; cpfCnpj: string; referencia: string }): Promise<ClienteProvedor>;
    obterAssinatura(id: string): Promise<AssinaturaProvedor | null>;
    listarAssinaturasPorReferencia(referencia: string): Promise<AssinaturaProvedor[]>;
    criarAssinatura(input: { cliente: string; valorCentavos: number; ciclo: Ciclo; vencimento: string; referencia: string; descricao: string }): Promise<AssinaturaProvedor>;
    listarCobrancasDaAssinatura(id: string): Promise<CobrancaProvedor[]>;
    /**
     * `ausente`: o DELETE respondeu 404 e a releitura por id comprovou a ausência (`ausenciaComprovada`) — a assinatura não
     * existe mais, mas nada prova que ESTE pedido a removeu. `removida: false` = sem confirmação.
     */
    removerAssinatura(id: string): Promise<{ removida: boolean; ausente?: boolean }>;
};

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
export type OpcoesCliente = { fetch?: Fetch; tempoLimiteMs?: number };

const texto = (v: unknown, max = 200) => (typeof v === 'string' && v.length <= max ? v : null);
function idValido(v: unknown, operacao: string) {
    if (typeof v !== 'string' || !ID.test(v))
        throw new AsaasFalhou(operacao, null, 'RESPOSTA_INVALIDA');
    return v;
}
function assinatura(o: Record<string, unknown>, operacao: string): AssinaturaProvedor {
    return {
        id: idValido(o.id, operacao), status: texto(o.status, 40) ?? 'DESCONHECIDO', deleted: o.deleted === true,
        cycle: texto(o.cycle, 40), customer: texto(o.customer, 100), externalReference: texto(o.externalReference),
        ...(o.value !== undefined ? { valorCentavos: valorDoProvedor(o.value) } : {}),
        ...(o.nextDueDate !== undefined ? { nextDueDate: texto(o.nextDueDate, 10) } : {}),
    };
}
/**
 * Prova positiva de que a assinatura não existe mais no provedor: a leitura por id devolveu ESTA assinatura com
 * `deleted=true`. O campo `deleted` ("Informa se a assinatura foi removida") está no esquema documentado da resposta 200;
 * que a removida volte assim, e não como 404, foi observado uma vez no sandbox em 10/10/2026, docs/evidencias/sonda-cobranca-removida-asaas-20261010.md; não documentado e não observado em production.
 * Leitura 404 (null) não prova: o 404 do Asaas também cobre rota inexistente e id de outra conta. Se em production a
 * removida responder 404, nada é concluído (fica sem confirmação, para revisão): o lado seguro.
 */
export function ausenciaComprovada(s: AssinaturaProvedor | null, id: string) {
    return s !== null && s.id === id && s.deleted === true;
}

export function valorDoProvedor(valor: unknown): number | null {
    if (typeof valor !== 'number' || !Number.isFinite(valor) || valor <= 0) return null;
    const centavos = Math.round(valor * 100);
    return Number.isSafeInteger(centavos) && Math.abs(valor * 100 - centavos) < 0.000001 ? centavos : null;
}
function cobranca(o: Record<string, unknown>, operacao: string): CobrancaProvedor {
    const dueDate = texto(o.dueDate, 10);
    if (!dueDate || !DATA.test(dueDate))
        throw new AsaasFalhou(operacao, null, 'RESPOSTA_INVALIDA');
    const invoiceUrl = texto(o.invoiceUrl, 500);
    return {
        id: idValido(o.id, operacao), status: texto(o.status, 40) ?? 'DESCONHECIDO', dueDate,
        paymentDate: texto(o.paymentDate, 10), invoiceUrl: invoiceUrl && urlDeFaturaValida(invoiceUrl) ? invoiceUrl : null, deleted: o.deleted === true,
        ...(o.value !== undefined ? { valorCentavos: valorDoProvedor(o.value) } : {}),
        ...(o.subscription !== undefined ? { assinaturaId: texto(o.subscription, 100) } : {}),
        ...(o.customer !== undefined ? { clienteId: texto(o.customer, 100) } : {}),
        ...(o.billingType !== undefined ? { billingType: texto(o.billingType, 40) } : {}),
        ...(o.confirmedDate !== undefined ? { confirmedDate: texto(o.confirmedDate, 10) && DATA.test(String(o.confirmedDate)) ? String(o.confirmedDate) : null } : {}),
        ...(o.externalReference !== undefined ? { externalReference: texto(o.externalReference) } : {}),
        ...(o.refunds !== undefined ? { estornos: estornos(o.refunds) } : {}),
    };
}

function estornos(lista: unknown): EstornoProvedor[] {
    if (!Array.isArray(lista)) return [];
    return lista.filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === 'object')
        .map((r) => ({ status: texto(r.status, 40) ?? 'DESCONHECIDO', valorCentavos: valorDoProvedor(r.value), descricao: texto(r.description, 500) }));
}

/** Só aceita a página hospedada do próprio Asaas (https, domínio asaas.com) como destino de pagamento. */
export function urlDeFaturaValida(url: string) {
    try {
        const u = new URL(url);
        return u.protocol === 'https:' && (u.hostname === 'asaas.com' || u.hostname.endsWith('.asaas.com')) && !u.username && !u.password;
    }
    catch {
        return false;
    }
}

const CICLO_ASAAS: Record<Ciclo, string> = { MENSAL: 'MONTHLY', ANUAL: 'YEARLY' };
export function cicloDoProvedor(cycle: string | null): Ciclo | null {
    return cycle === 'MONTHLY' ? 'MENSAL' : cycle === 'YEARLY' ? 'ANUAL' : null;
}

export function criarClienteAsaas(config: ConfiguracaoAsaas, opcoes: OpcoesCliente = {}): ClienteAsaas & ProvedorRenovacao & ProvedorEstorno & ProvedorCreditos {
    const esperado = (AMBIENTES as Record<string, { baseUrl: string; prefixo: string } | undefined>)[config.ambiente];
    if (!esperado || config.baseUrl !== esperado.baseUrl || !config.apiKey.startsWith(esperado.prefixo))
        throw new Error('Cliente Asaas recusado: ambiente, URL e chave precisam ser do mesmo ambiente.');
    const executar = opcoes.fetch ?? ((url, init) => fetch(url, init));
    const tempo = opcoes.tempoLimiteMs ?? TEMPO_LIMITE_MS;

    async function chamar(operacao: string, metodo: 'GET' | 'POST' | 'PUT' | 'DELETE', caminho: string, corpo?: unknown, aceitar404 = false): Promise<Record<string, unknown> | null> {
        const controle = new AbortController();
        const timer = setTimeout(() => controle.abort(), tempo);
        let res: Response;
        try {
            res = await executar(`${config.baseUrl}${caminho}`, {
                method: metodo,
                headers: { access_token: config.apiKey, 'Content-Type': 'application/json', 'User-Agent': USER_AGENT, Accept: 'application/json' },
                body: corpo === undefined ? undefined : JSON.stringify(corpo),
                signal: controle.signal,
                redirect: 'error',
                cache: 'no-store',
            });
        }
        catch {
            throw new AsaasFalhou(operacao, null, controle.signal.aborted ? 'TEMPO_ESGOTADO' : 'REDE');
        }
        finally {
            clearTimeout(timer);
        }
        if (aceitar404 && res.status === 404) {
            await res.body?.cancel().catch(() => undefined);
            return null;
        }
        if (!res.ok) {
            await res.body?.cancel().catch(() => undefined);
            throw new AsaasFalhou(operacao, res.status, 'HTTP');
        }
        const json = await res.json().catch(() => null) as unknown;
        if (!json || typeof json !== 'object' || Array.isArray(json))
            throw new AsaasFalhou(operacao, res.status, 'RESPOSTA_INVALIDA');
        return json as Record<string, unknown>;
    }

    async function listar<T>(operacao: string, caminho: string, mapear: (o: Record<string, unknown>) => T, paginas = 5): Promise<T[]> {
        const itens: T[] = [];
        for (let pagina = 0; pagina < paginas; pagina += 1) {
            const sep = caminho.includes('?') ? '&' : '?';
            const r = await chamar(operacao, 'GET', `${caminho}${sep}offset=${pagina * 100}&limit=100`);
            const data = r?.data;
            if (!Array.isArray(data))
                throw new AsaasFalhou(operacao, null, 'RESPOSTA_INVALIDA');
            for (const item of data)
                if (item && typeof item === 'object')
                    itens.push(mapear(item as Record<string, unknown>));
            if (r?.hasMore !== true)
                return itens;
        }
        // Ainda há páginas além do limite: uma lista parcial pode ocultar pagamento já realizado, assinatura vigente
        // ou cobrança a corrigir, e nunca prova ausência (retomada, liberação, renovação). Falha fechada.
        throw new AsaasFalhou(operacao, null, 'LISTA_INCOMPLETA');
    }
    const ref = (v: string) => encodeURIComponent(v);
    const idPath = (v: string, operacao: string) => encodeURIComponent(idValido(v, operacao));

    return {
        async obterCobranca(id) {
            const r = await chamar('consultar cobrança', 'GET', `/payments/${idPath(id, 'consultar cobrança')}`, undefined, true);
            return r ? cobranca(r, 'consultar cobrança') : null;
        },
        // POST /v3/payments/{id}/refund — https://docs.asaas.com/reference/estornar-cobranca (lida em 21/10/2026): `value`
        // opcional (parcial; ausente = integral), `description` opcional; 200 devolve a cobrança com `status`
        // (REFUNDED, REFUND_REQUESTED, REFUND_IN_PROGRESS…) e `refunds[]`. Pix aceita parciais até o valor da cobrança; cartão
        // só confirmado/recebido (até 10 dias úteis na fatura); taxas da cobrança não voltam; saldo insuficiente → 400.
        // Sempre envia `value` explícito (inclusive o integral), para o pedido nunca depender do padrão do provedor.
        async estornarCobranca(id, valorCentavos, descricao) {
            if (!Number.isSafeInteger(valorCentavos) || valorCentavos <= 0) throw new Error('Valor inválido.');
            const r = await chamar('estornar cobrança', 'POST', `/payments/${idPath(id, 'estornar cobrança')}/refund`,
                { value: valorCentavos / 100, description: descricao.slice(0, 500) });
            if (!r || r.id !== id) throw new AsaasFalhou('estornar cobrança', 200, 'RESPOSTA_INVALIDA');
            return { status: texto(r.status, 40) ?? 'DESCONHECIDO', estornos: estornos(r.refunds) };
        },
        // POST /v3/payments (avulsa) — https://docs.asaas.com/reference/criar-nova-cobranca (lida em 22/10/2026): customer,
        // billingType, value, dueDate, description, externalReference. Sem subscription nem parcelamento. A resposta é
        // conferida (id, referência e valor); divergência = RESPOSTA_INVALIDA, tratada como resultado incerto por quem chama.
        async criarCobrancaAvulsa(input) {
            if (!Number.isSafeInteger(input.valorCentavos) || input.valorCentavos <= 0 || !DATA.test(input.vencimento)
                || !['PIX', 'CREDIT_CARD', 'BOLETO'].includes(input.forma) || !/^km:(sandbox|producao):creditos:[0-9a-f-]{36}$/.test(input.referencia))
                throw new Error('Cobrança avulsa inválida.');
            const r = await chamar('criar cobrança avulsa', 'POST', '/payments', {
                customer: idValido(input.cliente, 'criar cobrança avulsa'), billingType: input.forma, value: input.valorCentavos / 100,
                dueDate: input.vencimento, description: input.descricao.slice(0, 500), externalReference: input.referencia,
            });
            const c = cobranca(r ?? {}, 'criar cobrança avulsa');
            if (c.externalReference !== input.referencia || c.valorCentavos !== input.valorCentavos || c.assinaturaId)
                throw new AsaasFalhou('criar cobrança avulsa', 200, 'RESPOSTA_INVALIDA');
            return c;
        },
        // GET /v3/payments?externalReference= — https://docs.asaas.com/reference/listar-cobrancas (paginado; 5 páginas de 100).
        async listarCobrancasPorReferencia(referencia) {
            return (await listar('listar cobranças avulsas', `/payments?externalReference=${ref(referencia)}`, (o) => cobranca(o, 'listar cobranças avulsas')))
                .filter((c) => c.externalReference === referencia);
        },
        // Só próximas parcelas; nunca reprifica mensalidades antigas ainda pendentes.
        async atualizarValorAssinatura(id, valorCentavos) {
            if (!Number.isSafeInteger(valorCentavos) || valorCentavos <= 0) throw new Error('Valor inválido.');
            const r = await chamar('atualizar valor assinatura', 'PUT', `/subscriptions/${idPath(id, 'atualizar assinatura')}`,
                { value: valorCentavos / 100, updatePendingPayments: false });
            return assinatura(r ?? {}, 'atualizar assinatura');
        },
        async atualizarValorCobranca(p, valorCentavos) {
            if (!Number.isSafeInteger(valorCentavos) || valorCentavos <= 0 || !DATA.test(p.dueDate)
                || !['UNDEFINED','BOLETO','PIX','CREDIT_CARD'].includes(p.billingType ?? '') || !['PENDING','OVERDUE'].includes(p.status) || p.deleted)
                throw new Error('Cobrança não pode ser reprecificada.');
            const r = await chamar('atualizar valor cobrança', 'PUT', `/payments/${idPath(p.id, 'atualizar cobrança')}`,
                { value: valorCentavos / 100, dueDate: p.dueDate, billingType: p.billingType });
            return cobranca(r ?? {}, 'atualizar cobrança');
        },
        async suspenderGeracao(id) {
            const r = await chamar('suspender geração', 'PUT', `/subscriptions/${idPath(id, 'suspender geração')}`, { status: 'INACTIVE', updatePendingPayments: false });
            return assinatura(r ?? {}, 'suspender geração');
        },
        // GET /v3/customers?externalReference= — https://docs.asaas.com/reference/listar-clientes
        async buscarClientePorReferencia(referencia) {
            const r = await chamar('listar clientes', 'GET', `/customers?externalReference=${ref(referencia)}&limit=10`);
            const data = Array.isArray(r?.data) ? r.data as Record<string, unknown>[] : null;
            if (!data)
                throw new AsaasFalhou('listar clientes', null, 'RESPOSTA_INVALIDA');
            const c = data.find((d) => d && d.deleted !== true && d.externalReference === referencia);
            return c ? { id: idValido(c.id, 'listar clientes'), externalReference: referencia } : null;
        },
        // POST /v3/customers — https://docs.asaas.com/reference/criar-novo-cliente
        // notificationDisabled: true — em qualquer ambiente o provedor não envia e-mail/SMS ao cliente: a fatura e os avisos
        // são mostrados pelo próprio Kidmais Manager (nenhum contato é enviado ao provedor).
        async criarCliente(input) {
            const r = await chamar('criar cliente', 'POST', '/customers', { name: input.nome.slice(0, 200), cpfCnpj: input.cpfCnpj, externalReference: input.referencia, notificationDisabled: true });
            return { id: idValido(r?.id, 'criar cliente'), externalReference: input.referencia };
        },
        // GET /v3/subscriptions/{id} — 404 → null. A doc diz só que o 404 vem quando o id não identifica assinatura
        // acessível à conta (inclui id de outra conta); null NÃO prova remoção. A removida foi lida com 200 e `deleted=true`
        // (observado uma vez no sandbox em 10/10/2026, docs/evidencias/sonda-cobranca-removida-asaas-20261010.md; não documentado e não observado em production).
        // https://docs.asaas.com/reference/recuperar-uma-unica-assinatura
        async obterAssinatura(id) {
            const r = await chamar('consultar assinatura', 'GET', `/subscriptions/${idPath(id, 'consultar assinatura')}`, undefined, true);
            return r ? assinatura(r, 'consultar assinatura') : null;
        },
        // GET /v3/subscriptions?externalReference= — https://docs.asaas.com/reference/listar-assinaturas
        async listarAssinaturasPorReferencia(referencia) {
            return (await listar('listar assinaturas', `/subscriptions?externalReference=${ref(referencia)}`, (o) => assinatura(o, 'listar assinaturas'), 2))
                .filter((a) => a.externalReference === referencia);
        },
        // POST /v3/subscriptions — billingType UNDEFINED: a fatura hospedada oferece Pix, boleto e cartão.
        // https://docs.asaas.com/reference/criar-nova-assinatura
        async criarAssinatura(input) {
            if (!Number.isSafeInteger(input.valorCentavos) || input.valorCentavos <= 0 || !DATA.test(input.vencimento))
                throw new Error('Assinatura inválida.');
            const r = await chamar('criar assinatura', 'POST', '/subscriptions', {
                customer: idValido(input.cliente, 'criar assinatura'), billingType: 'UNDEFINED', value: input.valorCentavos / 100,
                nextDueDate: input.vencimento, cycle: CICLO_ASAAS[input.ciclo], description: input.descricao.slice(0, 500), externalReference: input.referencia,
            });
            return assinatura(r ?? {}, 'criar assinatura');
        },
        // GET /v3/subscriptions/{id}/payments — https://docs.asaas.com/reference/listar-cobrancas-de-uma-assinatura
        async listarCobrancasDaAssinatura(id) {
            return listar('listar cobranças', `/subscriptions/${idPath(id, 'listar cobranças')}/payments`, (o) => cobranca(o, 'listar cobranças'));
        },
        // DELETE /v3/subscriptions/{id} — remove cobranças pendentes/vencidas; pagas permanecem.
        // https://docs.asaas.com/reference/remover-assinatura documenta 200 `{ deleted, id }` e um 404 "Not found" sem corpo;
        // https://docs.asaas.com/reference/codigos-http-das-respostas: 404 também é endpoint inexistente ou id de OUTRA conta.
        // Por isso o 404 sozinho não prova nada (o corpo nem é lido). A resposta do DELETE para assinatura já removida nunca
        // foi observada. Ausência só com a releitura por id na forma do esquema documentado
        // (`ausenciaComprovada`): comprova a ausência, não a autoria (`ausente`, auditado com ação neutra). Qualquer outra
        // resposta, ou falha da releitura → sem confirmação (`removida: false`); o DELETE nunca é repetido aqui.
        async removerAssinatura(id) {
            const r = await chamar('remover assinatura', 'DELETE', `/subscriptions/${idPath(id, 'remover assinatura')}`, undefined, true);
            if (r !== null)
                return { removida: r.deleted === true && r.id === id };
            try {
                const relida = await chamar('conferir exclusão', 'GET', `/subscriptions/${idPath(id, 'conferir exclusão')}`, undefined, true);
                return ausenciaComprovada(relida ? assinatura(relida, 'conferir exclusão') : null, id) ? { removida: true, ausente: true } : { removida: false };
            }
            catch {
                return { removida: false };
            }
        },
    };
}

/** Cliente do ambiente atual, ou null com o motivo quando a cobrança está desligada. */
export function clienteAsaasDoAmbiente(env: Ambiente = process.env, opcoes: OpcoesCliente = {}): { cliente: ClienteAsaas & ProvedorEstorno & ProvedorCreditos; config: ConfiguracaoAsaas } | { cliente: null; motivo: MotivoDesligado } {
    const estado = configuracaoAsaas(env);
    if (!estado.ligado)
        return { cliente: null, motivo: estado.motivo };
    return { cliente: criarClienteAsaas(estado.config, opcoes), config: estado.config };
}
