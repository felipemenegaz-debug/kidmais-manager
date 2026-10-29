/**
 * B-14 (plano rev. 8.1, §3.1): provedor SOMENTE LEITURA por lista fechada para a recuperação de pagamentos.
 * O mesmo objeto é entregue aos serviços em todos os modos (conferir, recuperar, inventário): nenhum método de escrita
 * existe nele, então um caminho que precise escrever no Asaas (remover duplicata, mudar valor, suspender) cai na falha
 * visível que o serviço já tem (ex.: `PROVEDOR_SEM_ESCRITA` em `processarPendencia`) e vira item para pessoa.
 * Sem rede nem banco: só monta o objeto a partir do cliente real (`criarClienteAsaas`) ou de um dublê.
 */

/** Únicos métodos expostos. Leituras de assinatura/cobrança e as duas listagens do inventário e da fila (§3.5, §3.7). */
export const LEITURAS_PERMITIDAS = Object.freeze([
    'obterAssinatura',
    'listarCobrancasDaAssinatura',
    'obterCobranca',
    'listarCobrancasPorReferencia',
    'listarAssinaturasPorReferencia',
    'listarCobrancas',
    'listarWebhooks',
] as const);
export type LeituraPermitida = (typeof LEITURAS_PERMITIDAS)[number];

type Funcao = (...args: never[]) => unknown;
export type ProvedorSomenteLeitura = Partial<Record<LeituraPermitida, Funcao>>;

/**
 * Copia SÓ os métodos da lista fechada que o cliente tem, ligados ao próprio cliente. O objeto é congelado: nada pode ser
 * acrescentado depois (um adaptador que tentasse pôr `removerAssinatura` falha em vez de passar despercebido).
 */
export function provedorSomenteLeitura(cliente: object): Readonly<ProvedorSomenteLeitura> {
    const origem = cliente as Record<string, unknown>;
    const provedor: ProvedorSomenteLeitura = {};
    for (const nome of LEITURAS_PERMITIDAS) {
        const f = origem[nome];
        if (typeof f === 'function') provedor[nome] = (f as Funcao).bind(cliente) as Funcao;
    }
    return Object.freeze(provedor);
}

/** Confere que um provedor recebido por um serviço só tem chaves da lista fechada (usado pelos testes de espião). */
export function chavesForaDaLista(provedor: object): string[] {
    return Object.keys(provedor).filter((k) => !(LEITURAS_PERMITIDAS as readonly string[]).includes(k)).sort();
}
