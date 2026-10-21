import { deflateRawSync, inflateRawSync } from 'node:zlib';

/**
 * ZIP mínimo (PKZIP 2.0, sem ZIP64, sem criptografia) para o pacote de exportação. Sem dependência nova: deflate do
 * zlib do Node e CRC-32 próprio. Nomes em UTF-8 (bit 11). Limite do formato sem ZIP64: 4 GiB por arquivo e no total e
 * 65 535 entradas — muito acima dos limites da exportação (lib/exportacao/limites.ts), conferidos antes de escrever.
 * `lerZip` existe para os testes e para quem quiser conferir o pacote com o próprio código do produto.
 */
export type EntradaZip = { caminho: string; conteudo: Buffer };

const TABELA_CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();

export function crc32(dados: Uint8Array): number {
    let c = 0xffffffff;
    for (let i = 0; i < dados.length; i++) c = TABELA_CRC[(c ^ dados[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

/** Data/hora no formato MS-DOS (resolução de 2 s), a partir dos campos UTC do instante informado. */
function dataDos(instante: Date) {
    const ano = Math.min(Math.max(instante.getUTCFullYear(), 1980), 2107);
    const hora = (instante.getUTCHours() << 11) | (instante.getUTCMinutes() << 5) | Math.floor(instante.getUTCSeconds() / 2);
    const data = ((ano - 1980) << 9) | ((instante.getUTCMonth() + 1) << 5) | instante.getUTCDate();
    return { hora, data };
}

const LIMITE_32 = 0xffffffff;

function caminhoSeguro(caminho: string) {
    if (!caminho || caminho.startsWith('/') || caminho.includes('\\') || caminho.split('/').some((p) => p === '' || p === '.' || p === '..'))
        throw new Error(`caminho inválido no ZIP: ${caminho}`);
    return Buffer.from(caminho, 'utf8');
}

/** Monta o ZIP inteiro em memória. Arquivos pequenos ou que não comprimem ficam armazenados (método 0). */
export function montarZip(entradas: readonly EntradaZip[], instante: Date): Buffer {
    if (entradas.length > 0xffff) throw new Error('ZIP: entradas demais');
    const { hora, data } = dataDos(instante);
    const locais: Buffer[] = [];
    const centrais: Buffer[] = [];
    const vistos = new Set<string>();
    let deslocamento = 0;
    for (const e of entradas) {
        if (vistos.has(e.caminho)) throw new Error(`ZIP: caminho repetido ${e.caminho}`);
        vistos.add(e.caminho);
        const nome = caminhoSeguro(e.caminho);
        const crc = crc32(e.conteudo);
        const comprimido = e.conteudo.length > 64 ? deflateRawSync(e.conteudo, { level: 6 }) : null;
        const usarDeflate = comprimido !== null && comprimido.length < e.conteudo.length;
        const dados = usarDeflate ? comprimido : e.conteudo;
        if (e.conteudo.length >= LIMITE_32 || dados.length >= LIMITE_32 || deslocamento >= LIMITE_32) throw new Error('ZIP: tamanho acima do formato sem ZIP64');
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0x0800, 6);
        local.writeUInt16LE(usarDeflate ? 8 : 0, 8);
        local.writeUInt16LE(hora, 10);
        local.writeUInt16LE(data, 12);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(dados.length, 18);
        local.writeUInt32LE(e.conteudo.length, 22);
        local.writeUInt16LE(nome.length, 26);
        local.writeUInt16LE(0, 28);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x0800, 8);
        central.writeUInt16LE(usarDeflate ? 8 : 0, 10);
        central.writeUInt16LE(hora, 12);
        central.writeUInt16LE(data, 14);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(dados.length, 20);
        central.writeUInt32LE(e.conteudo.length, 24);
        central.writeUInt16LE(nome.length, 28);
        central.writeUInt32LE(deslocamento, 42);
        locais.push(local, nome, dados);
        centrais.push(central, nome);
        deslocamento += local.length + nome.length + dados.length;
    }
    const diretorio = Buffer.concat(centrais);
    if (deslocamento + diretorio.length >= LIMITE_32) throw new Error('ZIP: tamanho acima do formato sem ZIP64');
    const fim = Buffer.alloc(22);
    fim.writeUInt32LE(0x06054b50, 0);
    fim.writeUInt16LE(entradas.length, 8);
    fim.writeUInt16LE(entradas.length, 10);
    fim.writeUInt32LE(diretorio.length, 12);
    fim.writeUInt32LE(deslocamento, 16);
    return Buffer.concat([...locais, diretorio, fim]);
}

/** Lê um ZIP gerado por montarZip (ou outro PKZIP simples), conferindo o CRC-32 de cada entrada. */
export function lerZip(zip: Buffer): Map<string, Buffer> {
    let fim = -1;
    for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
        if (zip.readUInt32LE(i) === 0x06054b50) { fim = i; break; }
    }
    if (fim < 0) throw new Error('ZIP: fim do diretório central não encontrado');
    const total = zip.readUInt16LE(fim + 10);
    let p = zip.readUInt32LE(fim + 16);
    const saida = new Map<string, Buffer>();
    for (let n = 0; n < total; n++) {
        if (zip.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP: diretório central inválido');
        const metodo = zip.readUInt16LE(p + 10);
        const crc = zip.readUInt32LE(p + 16);
        const tamComprimido = zip.readUInt32LE(p + 20);
        const tamanho = zip.readUInt32LE(p + 24);
        const nLen = zip.readUInt16LE(p + 28), xLen = zip.readUInt16LE(p + 30), cLen = zip.readUInt16LE(p + 32);
        const local = zip.readUInt32LE(p + 42);
        const nome = zip.subarray(p + 46, p + 46 + nLen).toString('utf8');
        if (zip.readUInt32LE(local) !== 0x04034b50) throw new Error('ZIP: cabeçalho local inválido');
        const inicio = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
        const bruto = zip.subarray(inicio, inicio + tamComprimido);
        const conteudo = metodo === 8 ? inflateRawSync(bruto) : metodo === 0 ? Buffer.from(bruto) : (() => { throw new Error(`ZIP: método ${metodo} não suportado`); })();
        if (conteudo.length !== tamanho || crc32(conteudo) !== crc) throw new Error(`ZIP: CRC/tamanho divergente em ${nome}`);
        saida.set(nome, conteudo);
        p += 46 + nLen + xLen + cLen;
    }
    return saida;
}
