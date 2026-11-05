import { BlockList, isIP } from 'node:net';

/**
 * Origem (IP do cliente) para limites e auditoria — docs/LOGIN_LIMITE_ORIGEM_POOL_20261022.md.
 *
 * Regra (revista em 22/10/2026 depois do G1 em staging): no Render, o cliente é o PENÚLTIMO valor do
 * X-Forwarded-For, só quando é um endereço público válido e coincide com CF-Connecting-IP (e com True-Client-IP,
 * se este vier). O G1 mostrou o formato real: [valores do cliente (forjáveis)…, IP do cliente, salto público da
 * infraestrutura]. O ÚLTIMO valor é esse salto, compartilhado por muitos clientes: usá-lo (a regra anterior)
 * transformava o limite por IP num limite comum a todos.
 *
 * Por que a conferência com CF-Connecting-IP: a borda (Cloudflare) acrescenta ao XFF o IP de quem conectou nela e
 * grava o mesmo IP em CF-Connecting-IP. Em qualquer divergência, a origem fica null (nunca uma chave global).
 *
 * A concordância NÃO autentica a borda (revisão de 22/10): quem chegasse ao balanceador do Render sem passar por uma
 * borda que SOBRESCREVE CF-Connecting-IP mandaria XFF `[forjado, salto]` e CF = forjado, indistinguível da lista
 * legítima. Por isso os cabeçalhos só valem com a confirmação operacional ORIGEM_CLIENTE_BORDA = BORDA_CONFIRMADA no
 * ambiente, ligada só depois de provado (G1, docs/LOGIN_LIMITE_ORIGEM_POOL_20261022.md) que toda entrada pública passa
 * pela borda e que um CF-Connecting-IP forjado é sobrescrito. Sem ela: null em todo pedido.
 *
 * Estrutura exigida (formato inesperado → null): nenhum elemento vazio no XFF (posições não são compactadas), ao
 * menos 2 valores, último (salto da infraestrutura) e penúltimo (cliente) IPs públicos válidos. Os valores à esquerda
 * vêm do próprio cliente e não são validados.
 * Por que não True-Client-IP sozinho: a Cloudflare só o garante com a transformação gerenciada ligada ("sem ela, o
 * valor pode ser forjado"), o Render não documenta nenhum dos dois, e um cabeçalho isolado não tem com o que ser
 * conferido. Quando ele vem, precisa concordar; senão, null.
 *
 * Fora do Render (local, testes) não há proxy confiável: null. Quem recebe null NÃO pode transformar isso numa
 * chave global que bloqueie todo mundo (ver o login em lib/autenticacao/service.ts).
 */
type Cabecalhos = { headers: { get(nome: string): string | null } };
type Ambiente = { RENDER?: string; ORIGEM_CLIENTE_BORDA?: string };

/** Valor de ORIGEM_CLIENTE_BORDA que declara a borda provada (entrada única + CF-Connecting-IP sobrescrito). */
export const BORDA_CONFIRMADA = 'render-cloudflare-sobrescreve';

export function ambienteDaOrigem(env: Record<string, string | undefined> = process.env): Ambiente {
    return { RENDER: env.RENDER, ORIGEM_CLIENTE_BORDA: env.ORIGEM_CLIENTE_BORDA };
}

function bordaConfirmada(env: Ambiente) {
    return env.RENDER === 'true' && env.ORIGEM_CLIENTE_BORDA === BORDA_CONFIRMADA;
}

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

/** Elementos do X-Forwarded-For SEM compactar vazios (`a, ,b` são 3, o do meio vazio); cabeçalho ausente → []. */
function encaminhamento(request: Cabecalhos) {
    const bruto = request.headers.get('x-forwarded-for');
    return bruto === null ? [] : bruto.split(',').map((v) => v.trim());
}

function publicoValido(valor: string | undefined) {
    const ip = normalizarIp(valor);
    return ip && ipPublico(ip) ? ip : null;
}

/**
 * IP confiável do cliente: só com a borda confirmada no Render, XFF sem elementos vazios, último e penúltimo públicos
 * válidos, e penúltimo igual a CF-Connecting-IP (e a True-Client-IP, se vier); senão null.
 */
export function origemConfiavel(request: Cabecalhos, env: Ambiente = ambienteDaOrigem()): string | null {
    if (!bordaConfirmada(env))
        return null;
    const valores = encaminhamento(request);
    if (valores.length < 2 || valores.includes('') || !publicoValido(valores.at(-1)))
        return null;
    const ip = publicoValido(valores.at(-2));
    if (!ip || normalizarIp(request.headers.get('cf-connecting-ip')) !== ip)
        return null;
    const tci = request.headers.get('true-client-ip');
    return tci === null || normalizarIp(tci) === ip ? ip : null;
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
 * Formato da origem, SEM endereço: quantos valores há no X-Forwarded-For, se o penúltimo e o último são públicos,
 * e em que posição (contada do fim: 1 = último) aparecem CF-Connecting-IP e True-Client-IP. Serve para conferir a
 * regra no log de staging (G1) sem expor IP. Esperado no Render: cfConnectingIp e trueClientIp na posição 2.
 * `vazios` conta elementos vazios (que recusam a origem); `bordaConfirmada` diz se ORIGEM_CLIENTE_BORDA está ligada.
 */
export function formatoDaOrigem(request: Cabecalhos, env: Ambiente = ambienteDaOrigem()) {
    const valores = encaminhamento(request);
    const normalizados = valores.map((v) => normalizarIp(v));
    const classe = (v: string | undefined) => {
        if (v === undefined)
            return 'ausente';
        if (v === '')
            return 'vazio';
        const ip = normalizarIp(v);
        return !ip ? 'invalido' : ipPublico(ip) ? 'publico' : 'nao-publico';
    };
    const posicao = (nome: string) => {
        const valor = request.headers.get(nome);
        if (valor === null)
            return 'ausente';
        const ip = normalizarIp(valor);
        if (!ip)
            return 'invalido';
        const i = normalizados.lastIndexOf(ip);
        return i < 0 ? 'fora-da-lista' : valores.length - i;
    };
    return {
        render: env.RENDER === 'true',
        bordaConfirmada: bordaConfirmada(env),
        valoresNoEncaminhamento: valores.length,
        vazios: valores.filter((v) => v === '').length,
        penultimo: classe(valores.at(-2)),
        ultimo: classe(valores.at(-1)),
        cfConnectingIp: posicao('cf-connecting-ip'),
        trueClientIp: posicao('true-client-ip'),
        aceito: origemConfiavel(request, env) !== null,
    };
}

/** Causa de um 500 para o log, sem corpo da requisição: nome, código do driver e mensagem curta, sem e-mail. */
export function causaDoErro(error: unknown) {
    const e = error as { name?: unknown; code?: unknown; message?: unknown } | null;
    const texto = (v: unknown, max: number) => (typeof v === 'string' ? v : '').replace(/[^\s@]+@[^\s@]+/g, '<email>').replace(/\s+/g, ' ').slice(0, max);
    return { nome: texto(e?.name, 60) || typeof error, codigo: texto(e?.code, 40) || null, mensagem: texto(e?.message, 200) || null };
}

/**
 * Marca de diagnóstico do G1 (cabeçalho x-kidmais-diagnostico): um nonce escolhido por quem testa, para achar no log a
 * linha DAQUELE pedido. Só [A-Za-z0-9-]{8,64}; qualquer outra coisa é ignorada (nada de texto livre no log).
 */
function marcaDeDiagnostico(request: Cabecalhos) {
    const valor = request.headers.get('x-kidmais-diagnostico');
    return valor !== null && /^[A-Za-z0-9-]{8,64}$/.test(valor) ? valor : null;
}

/**
 * Teto das linhas forçadas por marca (revisão de 22/10, P3-R3-3: a marca é pública e forçava uma linha por pedido).
 * Um contador fixo por processo, sem guardar marcas: no máximo MARCAS_POR_JANELA linhas a cada JANELA_MARCAS_MS. O G1
 * precisa de poucas; acima do teto a marca é ignorada (vale a amostragem normal).
 */
export const MARCAS_POR_JANELA = 10;
export const JANELA_MARCAS_MS = 60_000;
const janelaMarcas = { inicio: Number.NEGATIVE_INFINITY, usadas: 0 };
function marcaDentroDoTeto(agora: number) {
    if (agora - janelaMarcas.inicio >= JANELA_MARCAS_MS) {
        janelaMarcas.inicio = agora;
        janelaMarcas.usadas = 0;
    }
    if (janelaMarcas.usadas >= MARCAS_POR_JANELA)
        return false;
    janelaMarcas.usadas += 1;
    return true;
}

let formatoRegistrado = false;
/**
 * Registra o formato uma vez por processo (no primeiro login), sempre que a origem for recusada no Render e quando o
 * pedido trouxer uma marca de diagnóstico válida dentro do teto (que vai na linha, para correlacionar).
 */
export function registrarFormatoDaOrigem(request: Cabecalhos, ip: string | null, env: Ambiente = ambienteDaOrigem(), log: (m: string) => void = console.warn, agora: () => number = Date.now) {
    const recusada = env.RENDER === 'true' && ip === null;
    const valida = marcaDeDiagnostico(request);
    const marca = valida !== null && marcaDentroDoTeto(agora()) ? valida : null;
    if (formatoRegistrado && !recusada && !marca)
        return;
    formatoRegistrado = true;
    log(`[origem] ${recusada ? 'origem não confiável no Render; login sem limite de origem' : 'formato'} ${JSON.stringify({ ...formatoDaOrigem(request, env), marca })}`);
}
