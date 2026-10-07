/**
 * Cliente mínimo da API Asaas (E8) — SOMENTE SANDBOX nesta entrega. Sem SDK: `fetch` com tempo-limite e injeção para
 * testes. Nenhuma função aqui grava no banco, registra log ou devolve a chave em mensagens de erro.
 *
 * Configuração (somente nomes; valores ficam no ambiente do serviço, nunca no código ou em arquivos versionados):
 *   ASAAS_AMBIENTE        só `sandbox` é aceito nesta entrega. Qualquer outro valor (inclusive `producao`) deixa a
 *                         cobrança DESLIGADA com motivo explícito. Produção é etapa posterior, com autorização própria.
 *   ASAAS_API_KEY         chave da conta sandbox; precisa começar com `$aact_hmlg_` (prefixo de sandbox do Asaas).
 *   ASAAS_WEBHOOK_TOKEN   token do webhook (32–255 caracteres), conferido no cabeçalho `asaas-access-token`.
 *
 * Fontes oficiais (lidas em 06–07/10/2026):
 *   autenticação/sandbox  https://docs.asaas.com/docs/autenticação-1 · https://docs.asaas.com/docs/sandbox
 *   clientes              https://docs.asaas.com/reference/listar-clientes · https://docs.asaas.com/reference/criar-novo-cliente
 *   assinaturas           https://docs.asaas.com/reference/criar-nova-assinatura · https://docs.asaas.com/reference/listar-assinaturas
 *                         https://docs.asaas.com/reference/recuperar-uma-unica-assinatura · https://docs.asaas.com/reference/remover-assinatura
 *   cobranças             https://docs.asaas.com/reference/listar-cobrancas-de-uma-assinatura
 *   webhooks              https://docs.asaas.com/docs/sobre-os-webhooks
 */
import type { Ciclo } from './configuracao.ts';

export const ASAAS_SANDBOX_URL = 'https://api-sandbox.asaas.com/v3';
export const PREFIXO_CHAVE_SANDBOX = '$aact_hmlg_';
export const TEMPO_LIMITE_MS = 10_000;
const USER_AGENT = 'kidmais-manager';
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const DATA = /^\d{4}-\d{2}-\d{2}$/;

type Ambiente = Record<string, string | undefined>;
export type ConfiguracaoAsaas = { ambiente: 'sandbox'; baseUrl: string; apiKey: string; webhookToken: string };
export type MotivoDesligado = 'AMBIENTE_AUSENTE' | 'AMBIENTE_NAO_SUPORTADO' | 'CHAVE_AUSENTE' | 'CHAVE_FORA_DO_SANDBOX' | 'TOKEN_WEBHOOK_INVALIDO';
export type EstadoConfiguracao = { ligado: true; config: ConfiguracaoAsaas } | { ligado: false; motivo: MotivoDesligado };

const EXPLICACAO: Record<MotivoDesligado, string> = {
    AMBIENTE_AUSENTE: 'ASAAS_AMBIENTE não definido: cobrança desligada.',
    AMBIENTE_NAO_SUPORTADO: 'ASAAS_AMBIENTE aceita somente "sandbox" nesta versão; produção exige autorização separada.',
    CHAVE_AUSENTE: 'ASAAS_API_KEY não definida: cobrança desligada.',
    CHAVE_FORA_DO_SANDBOX: 'ASAAS_API_KEY não é uma chave de sandbox: cobrança desligada.',
    TOKEN_WEBHOOK_INVALIDO: 'ASAAS_WEBHOOK_TOKEN ausente ou fora de 32–255 caracteres: cobrança desligada.',
};
export const explicarDesligado = (motivo: MotivoDesligado) => EXPLICACAO[motivo];

/** Lê e valida a configuração. Nunca devolve a chave em mensagens; o valor só sai daqui dentro de `config`. */
export function configuracaoAsaas(env: Ambiente = process.env): EstadoConfiguracao {
    const ambiente = env.ASAAS_AMBIENTE?.trim();
    if (!ambiente)
        return { ligado: false, motivo: 'AMBIENTE_AUSENTE' };
    if (ambiente !== 'sandbox')
        return { ligado: false, motivo: 'AMBIENTE_NAO_SUPORTADO' };
    const apiKey = env.ASAAS_API_KEY?.trim() ?? '';
    if (!apiKey)
        return { ligado: false, motivo: 'CHAVE_AUSENTE' };
    if (!apiKey.startsWith(PREFIXO_CHAVE_SANDBOX) || apiKey.length > 300 || /\s/.test(apiKey))
        return { ligado: false, motivo: 'CHAVE_FORA_DO_SANDBOX' };
    const webhookToken = env.ASAAS_WEBHOOK_TOKEN ?? '';
    if (!/^[\x21-\x7e]{32,255}$/.test(webhookToken))
        return { ligado: false, motivo: 'TOKEN_WEBHOOK_INVALIDO' };
    return { ligado: true, config: { ambiente: 'sandbox', baseUrl: ASAAS_SANDBOX_URL, apiKey, webhookToken } };
}

/** Falha de comunicação ou resposta inesperada. A mensagem nunca leva corpo da resposta, chave ou dado do pagador. */
export class AsaasFalhou extends Error {
    readonly operacao: string;
    readonly status: number | null;
    constructor(operacao: string, status: number | null, motivo: 'HTTP' | 'TEMPO_ESGOTADO' | 'REDE' | 'RESPOSTA_INVALIDA') {
        super(`Asaas: ${operacao} falhou (${motivo}${status ? ` ${status}` : ''}).`);
        this.name = 'AsaasFalhou';
        this.operacao = operacao;
        this.status = status;
    }
}

export type ClienteProvedor = { id: string; externalReference: string | null };
export type AssinaturaProvedor = { id: string; status: string; deleted: boolean; cycle: string | null; customer: string | null; externalReference: string | null };
export type CobrancaProvedor = { id: string; status: string; dueDate: string; paymentDate: string | null; invoiceUrl: string | null; deleted: boolean };

export type ClienteAsaas = {
    buscarClientePorReferencia(referencia: string): Promise<ClienteProvedor | null>;
    criarCliente(input: { nome: string; cpfCnpj: string; referencia: string }): Promise<ClienteProvedor>;
    obterAssinatura(id: string): Promise<AssinaturaProvedor | null>;
    listarAssinaturasPorReferencia(referencia: string): Promise<AssinaturaProvedor[]>;
    criarAssinatura(input: { cliente: string; valorCentavos: number; ciclo: Ciclo; vencimento: string; referencia: string; descricao: string }): Promise<AssinaturaProvedor>;
    listarCobrancasDaAssinatura(id: string): Promise<CobrancaProvedor[]>;
    removerAssinatura(id: string): Promise<{ removida: boolean }>;
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
    };
}
function cobranca(o: Record<string, unknown>, operacao: string): CobrancaProvedor {
    const dueDate = texto(o.dueDate, 10);
    if (!dueDate || !DATA.test(dueDate))
        throw new AsaasFalhou(operacao, null, 'RESPOSTA_INVALIDA');
    const invoiceUrl = texto(o.invoiceUrl, 500);
    return {
        id: idValido(o.id, operacao), status: texto(o.status, 40) ?? 'DESCONHECIDO', dueDate,
        paymentDate: texto(o.paymentDate, 10), invoiceUrl: invoiceUrl && urlDeFaturaValida(invoiceUrl) ? invoiceUrl : null, deleted: o.deleted === true,
    };
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

export function criarClienteAsaas(config: ConfiguracaoAsaas, opcoes: OpcoesCliente = {}): ClienteAsaas {
    if (config.ambiente !== 'sandbox' || config.baseUrl !== ASAAS_SANDBOX_URL || !config.apiKey.startsWith(PREFIXO_CHAVE_SANDBOX))
        throw new Error('Cliente Asaas recusado: somente sandbox nesta versão.');
    const executar = opcoes.fetch ?? ((url, init) => fetch(url, init));
    const tempo = opcoes.tempoLimiteMs ?? TEMPO_LIMITE_MS;

    async function chamar(operacao: string, metodo: 'GET' | 'POST' | 'DELETE', caminho: string, corpo?: unknown, aceitar404 = false): Promise<Record<string, unknown> | null> {
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
        return itens;
    }
    const ref = (v: string) => encodeURIComponent(v);
    const idPath = (v: string, operacao: string) => encodeURIComponent(idValido(v, operacao));

    return {
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
        // notificationDisabled: true — o sandbox pode enviar e-mail/SMS reais; nenhum contato é enviado ao provedor.
        async criarCliente(input) {
            const r = await chamar('criar cliente', 'POST', '/customers', { name: input.nome.slice(0, 200), cpfCnpj: input.cpfCnpj, externalReference: input.referencia, notificationDisabled: true });
            return { id: idValido(r?.id, 'criar cliente'), externalReference: input.referencia };
        },
        // GET /v3/subscriptions/{id} — removida/inexistente devolve 404 → null.
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
        // DELETE /v3/subscriptions/{id} — remove cobranças pendentes/vencidas; pagas permanecem. 404 = já removida.
        // https://docs.asaas.com/reference/remover-assinatura
        async removerAssinatura(id) {
            const r = await chamar('remover assinatura', 'DELETE', `/subscriptions/${idPath(id, 'remover assinatura')}`, undefined, true);
            return { removida: r === null || r.deleted === true };
        },
    };
}

/** Cliente do ambiente atual, ou null com o motivo quando a cobrança está desligada. */
export function clienteAsaasDoAmbiente(env: Ambiente = process.env, opcoes: OpcoesCliente = {}): { cliente: ClienteAsaas; config: ConfiguracaoAsaas } | { cliente: null; motivo: MotivoDesligado } {
    const estado = configuracaoAsaas(env);
    if (!estado.ligado)
        return { cliente: null, motivo: estado.motivo };
    return { cliente: criarClienteAsaas(estado.config, opcoes), config: estado.config };
}
