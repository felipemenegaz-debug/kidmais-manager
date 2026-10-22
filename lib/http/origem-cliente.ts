import { BlockList, isIP } from 'node:net';

/**
 * Origem (IP do cliente) para limites e auditoria — decisão de 22/10/2026 (docs/LOGIN_LIMITE_ORIGEM_POOL_20261022.md).
 *
 * No Render a requisição passa pela borda (Cloudflare) e pelo balanceador do Render. Os dois ACRESCENTAM ao
 * X-Forwarded-For e nenhum limpa o valor recebido do cliente: o começo da lista é forjável, o fim é de quem
 * conectou na borda. Por isso a origem confiável é o ÚLTIMO valor, e só quando ele é um endereço público:
 * endereço privado, de loopback ou reservado no fim significaria um salto interno acrescentado depois do
 * cliente, e usá-lo juntaria todos os clientes numa chave só (o mesmo defeito do limite global).
 *
 * True-Client-IP e CF-Connecting-IP NÃO decidem: a Cloudflare só garante True-Client-IP com a transformação
 * gerenciada ligada ("sem ela, o valor pode ser forjado"), e o Render não documenta nenhum dos dois. Eles servem
 * apenas ao diagnóstico de formato (`formatoDaOrigem`), que mostra se concordam com o último X-Forwarded-For sem
 * registrar endereço.
 *
 * Fora do Render (local, testes) não há proxy confiável: null. Quem recebe null NÃO pode transformar isso numa
 * chave global que bloqueie todo mundo (ver o login em lib/autenticacao/service.ts).
 */
type Cabecalhos = { headers: { get(nome: string): string | null } };
type Ambiente = { RENDER?: string };

const NAO_PUBLICOS = new BlockList();
for (const [rede, prefixo] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
    ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
    ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const)
    NAO_PUBLICOS.addSubnet(rede, prefixo, 'ipv4');
for (const [rede, prefixo] of [
    ['::', 128], ['::1', 128], ['64:ff9b:1::', 48], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const)
    NAO_PUBLICOS.addSubnet(rede, prefixo, 'ipv6');

/** Endereço normalizado (IPv4 mapeado em IPv6 vira IPv4; IPv6 em minúsculas) ou null quando não é IP. */
export function normalizarIp(valor: string | null | undefined): string | null {
    const bruto = (valor ?? '').trim().replace(/^\[(.*)\]$/, '$1');
    const mapeado = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(bruto);
    const ip = mapeado ? mapeado[1] : bruto.toLowerCase();
    return isIP(ip) ? ip : null;
}

export function ipPublico(ip: string): boolean {
    const versao = isIP(ip);
    if (!versao)
        return false;
    if (versao === 6 && !/^[23]/.test(ip))
        return false; // só unicast global (2000::/3)
    return !NAO_PUBLICOS.check(ip, versao === 4 ? 'ipv4' : 'ipv6');
}

function ultimoDoEncaminhamento(request: Cabecalhos) {
    const valores = (request.headers.get('x-forwarded-for') ?? '').split(',').map((v) => v.trim()).filter(Boolean);
    return { valores, ultimo: valores.at(-1) ?? null };
}

/** IP confiável do cliente: último X-Forwarded-For no Render, público e válido; senão null. */
export function origemConfiavel(request: Cabecalhos, env: Ambiente = { RENDER: process.env.RENDER }): string | null {
    if (env.RENDER !== 'true')
        return null;
    const ip = normalizarIp(ultimoDoEncaminhamento(request).ultimo);
    return ip && ipPublico(ip) ? ip : null;
}

/**
 * Chave do limite de origem: IPv4 inteiro; IPv6 pelo /64 (uma rede de casa, escritório ou aparelho móvel).
 * Sem agrupar, quem tem um /64 troca de endereço a cada tentativa e escapa do limite.
 */
export function chaveDaOrigem(ip: string): string {
    if (isIP(ip) !== 6)
        return ip;
    const [esquerda, direita = ''] = ip.split('::');
    const a = esquerda ? esquerda.split(':') : [];
    const b = direita ? direita.split(':') : [];
    const grupos = ip.includes('::') ? [...a, ...Array(8 - a.length - b.length).fill('0'), ...b] : a;
    return `${grupos.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(':')}::/64`;
}

/**
 * Formato da origem, SEM endereço: quantos valores no X-Forwarded-For, se o último é público, e se
 * True-Client-IP / CF-Connecting-IP existem e concordam com ele. Serve para confirmar no log de staging a
 * decisão acima (por exemplo, se o Render passar a acrescentar um salto interno depois do cliente).
 */
export function formatoDaOrigem(request: Cabecalhos, env: Ambiente = { RENDER: process.env.RENDER }) {
    const { valores, ultimo } = ultimoDoEncaminhamento(request);
    const ip = normalizarIp(ultimo);
    const compara = (nome: string) => {
        const valor = request.headers.get(nome);
        if (valor === null)
            return 'ausente';
        const outro = normalizarIp(valor);
        return !outro ? 'invalido' : outro === ip ? 'igual-ao-ultimo' : valores.some((v) => normalizarIp(v) === outro) ? 'outra-posicao' : 'fora-da-lista';
    };
    return {
        render: env.RENDER === 'true',
        valoresNoEncaminhamento: valores.length,
        ultimo: !ultimo ? 'ausente' : !ip ? 'invalido' : ipPublico(ip) ? 'publico' : 'nao-publico',
        trueClientIp: compara('true-client-ip'),
        cfConnectingIp: compara('cf-connecting-ip'),
    };
}

/** Causa de um 500 para o log, sem corpo da requisição: nome, código do driver e mensagem curta, sem e-mail. */
export function causaDoErro(error: unknown) {
    const e = error as { name?: unknown; code?: unknown; message?: unknown } | null;
    const texto = (v: unknown, max: number) => (typeof v === 'string' ? v : '').replace(/[^\s@]+@[^\s@]+/g, '<email>').replace(/\s+/g, ' ').slice(0, max);
    return { nome: texto(e?.name, 60) || typeof error, codigo: texto(e?.code, 40) || null, mensagem: texto(e?.message, 200) || null };
}

let formatoRegistrado = false;
/** Registra o formato uma vez por processo (no primeiro login), ou sempre que a origem for recusada no Render. */
export function registrarFormatoDaOrigem(request: Cabecalhos, ip: string | null, env: Ambiente = { RENDER: process.env.RENDER }, log: (m: string) => void = console.warn) {
    const recusada = env.RENDER === 'true' && ip === null;
    if (formatoRegistrado && !recusada)
        return;
    formatoRegistrado = true;
    log(`[origem] ${recusada ? 'origem não confiável no Render; login sem limite de origem' : 'formato'} ${JSON.stringify(formatoDaOrigem(request, env))}`);
}
