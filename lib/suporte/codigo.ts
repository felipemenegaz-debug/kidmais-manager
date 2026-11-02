/**
 * Código curto que a pessoa informa ao suporte (D-SUP-1/S3): "KM-" + 8 hex do SHA-256 de um rótulo fixo + id da empresa.
 * Não contém nome, CPF, e-mail nem o id; só a Kidmais, que tem a lista de empresas, acha a conta pelo código:
 *   SELECT id, nome FROM empresas
 *    WHERE upper(substr(encode(sha256(convert_to('kidmais-suporte-v1:' || id::text, 'UTF8')), 'hex'), 1, 8)) = 'XXXXXXXX';
 * Calculado no navegador (Web Crypto), sem nova rota nem consulta ao banco.
 */
export async function codigoSuporte(empresaId: string) {
    const bytes = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(`kidmais-suporte-v1:${empresaId}`)));
    return `KM-${[...bytes.slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

export function mensagemSuporte(codigo: string | null) {
    return codigo ? `Olá! Sou cliente do Kidmais Manager e preciso de ajuda. Código de suporte: ${codigo}` : 'Olá! Sou cliente do Kidmais Manager e preciso de ajuda.';
}
