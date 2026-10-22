import { open, type FileHandle } from 'node:fs/promises';
import * as zlib from 'node:zlib';

/**
 * ZIP mínimo (PKZIP 2.0, sem ZIP64, sem criptografia) para o pacote de exportação, montado EM ARQUIVO a partir de
 * arquivos temporários: nenhum conteúdo inteiro fica em memória (cada entrada passa em fluxo pelo deflate do zlib e é
 * gravada direto no arquivo; o tamanho comprimido é corrigido no cabeçalho local depois). Nomes em UTF-8 (bit 11).
 * Limites do formato sem ZIP64 (4 GiB, 65 535 entradas) são conferidos antes, com mensagem própria (pacote.ts).
 * `lerZip` existe para os testes e para quem quiser conferir o pacote com o próprio código do produto.
 */
export const MAXIMO_ENTRADAS_ZIP = 0xffff;
export const MAXIMO_BYTES_ZIP = 0xffffffff;

const TABELA_CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c >>> 0;
    }
    return t;
})();
const crcNativo = (zlib as unknown as { crc32?: (dados: Uint8Array, valor?: number) => number }).crc32;

/** CRC-32 incremental: crc32(b, crc32(a)) = crc32(a + b). Usa o do zlib quando o Node oferece. */
export function crc32(dados: Uint8Array, anterior = 0): number {
    if (crcNativo) return crcNativo(dados, anterior) >>> 0;
    let c = (anterior ^ 0xffffffff) >>> 0;
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

function caminhoSeguro(caminho: string) {
    if (!caminho || caminho.startsWith('/') || caminho.includes('\\') || caminho.split('/').some((p) => p === '' || p === '.' || p === '..'))
        throw new Error(`caminho inválido no ZIP: ${caminho}`);
    return Buffer.from(caminho, 'utf8');
}

/** Bloco de leitura reutilizado na montagem do ZIP. */
const BLOCO = 256 * 1024;

/**
 * Copia uma entrada para o ZIP a partir de `inicio`, armazenada ou com deflate, e devolve o tamanho gravado. A leitura
 * usa sempre o mesmo bloco: com deflate, o bloco só volta a ser usado depois que o zlib confirmou que consumiu a
 * entrada (callback do write). Memória: o bloco + a saída comprimida pendente.
 */
async function copiarEntrada(e: EntradaArquivo, destino: FileHandle, inicio: number, bloco: Buffer): Promise<number> {
    const origem = await open(e.arquivo, 'r');
    let escrito = 0;
    let lidos = 0;
    const gravar = async (b: Buffer) => {
        if (inicio + escrito + b.length >= MAXIMO_BYTES_ZIP) throw new Error('ZIP: tamanho acima do formato sem ZIP64');
        await destino.write(b, 0, b.length, inicio + escrito);
        escrito += b.length;
    };
    try {
        if (e.armazenar) {
            for (;;) {
                const { bytesRead } = await origem.read(bloco, 0, bloco.length, null);
                if (bytesRead === 0) break;
                lidos += bytesRead;
                await gravar(bloco.subarray(0, bytesRead));
            }
        } else {
            const z = zlib.createDeflateRaw({ level: 6 });
            const saida = (async () => { for await (const b of z) await gravar(b as Buffer); })();
            try {
                for (;;) {
                    const { bytesRead } = await origem.read(bloco, 0, bloco.length, null);
                    if (bytesRead === 0) break;
                    lidos += bytesRead;
                    await new Promise<void>((ok, falha) => z.write(bloco.subarray(0, bytesRead), (erro) => (erro ? falha(erro) : ok())));
                }
                z.end();
            } catch (erro) {
                z.destroy(erro as Error);
                throw erro;
            } finally {
                await saida.catch((erro) => { throw erro; });
            }
        }
    } finally {
        await origem.close();
    }
    if (lidos !== e.bytes) throw new Error(`ZIP: tamanho divergente em ${e.caminho}`);
    return escrito;
}

/** Entrada já gravada em arquivo temporário, com CRC-32 e tamanho calculados na gravação. */
export type EntradaArquivo = { caminho: string; arquivo: string; bytes: number; crc: number; armazenar: boolean };

/**
 * Grava o ZIP em `destino` lendo cada entrada do seu arquivo temporário em fluxo. `armazenar` = método 0 (PDFs, que
 * já vêm comprimidos); o resto vai com deflate. Devolve o tamanho final. Memória: um bloco de leitura por vez + o
 * diretório central (≈ 100 bytes por entrada).
 */
export async function escreverZip(entradas: readonly EntradaArquivo[], destino: string, instante: Date): Promise<number> {
    if (entradas.length > MAXIMO_ENTRADAS_ZIP) throw new Error('ZIP: entradas demais');
    const { hora, data } = dataDos(instante);
    const vistos = new Set<string>();
    const centrais: Buffer[] = [];
    const bloco = Buffer.allocUnsafe(BLOCO);
    const fh = await open(destino, 'w');
    let pos = 0;
    try {
        for (const e of entradas) {
            if (vistos.has(e.caminho)) throw new Error(`ZIP: caminho repetido ${e.caminho}`);
            vistos.add(e.caminho);
            if (e.bytes >= MAXIMO_BYTES_ZIP) throw new Error('ZIP: tamanho acima do formato sem ZIP64');
            const nome = caminhoSeguro(e.caminho);
            const metodo = e.armazenar ? 0 : 8;
            const local = Buffer.alloc(30);
            local.writeUInt32LE(0x04034b50, 0);
            local.writeUInt16LE(20, 4);
            local.writeUInt16LE(0x0800, 6);
            local.writeUInt16LE(metodo, 8);
            local.writeUInt16LE(hora, 10);
            local.writeUInt16LE(data, 12);
            local.writeUInt32LE(e.crc, 14);
            local.writeUInt32LE(0, 18); // tamanho comprimido: corrigido depois do fluxo
            local.writeUInt32LE(e.bytes, 22);
            local.writeUInt16LE(nome.length, 26);
            local.writeUInt16LE(0, 28);
            const inicioCabecalho = pos;
            await fh.write(local, 0, local.length, pos);
            await fh.write(nome, 0, nome.length, pos + local.length);
            const inicioDados = pos + local.length + nome.length;
            const escrito = await copiarEntrada(e, fh, inicioDados, bloco);
            const tam = Buffer.alloc(4);
            tam.writeUInt32LE(escrito, 0);
            await fh.write(tam, 0, 4, inicioCabecalho + 18);
            const central = Buffer.alloc(46);
            central.writeUInt32LE(0x02014b50, 0);
            central.writeUInt16LE(20, 4);
            central.writeUInt16LE(20, 6);
            central.writeUInt16LE(0x0800, 8);
            central.writeUInt16LE(metodo, 10);
            central.writeUInt16LE(hora, 12);
            central.writeUInt16LE(data, 14);
            central.writeUInt32LE(e.crc, 16);
            central.writeUInt32LE(escrito, 20);
            central.writeUInt32LE(e.bytes, 24);
            central.writeUInt16LE(nome.length, 28);
            central.writeUInt32LE(inicioCabecalho, 42);
            centrais.push(central, nome);
            pos = inicioDados + escrito;
        }
        const diretorio = Buffer.concat(centrais);
        if (pos + diretorio.length + 22 >= MAXIMO_BYTES_ZIP) throw new Error('ZIP: tamanho acima do formato sem ZIP64');
        const fim = Buffer.alloc(22);
        fim.writeUInt32LE(0x06054b50, 0);
        fim.writeUInt16LE(entradas.length, 8);
        fim.writeUInt16LE(entradas.length, 10);
        fim.writeUInt32LE(diretorio.length, 12);
        fim.writeUInt32LE(pos, 16);
        await fh.write(diretorio, 0, diretorio.length, pos);
        await fh.write(fim, 0, fim.length, pos + diretorio.length);
        return pos + diretorio.length + fim.length;
    } finally {
        await fh.close();
    }
}

/** Lê um ZIP gerado por escreverZip (ou outro PKZIP simples), conferindo o CRC-32 de cada entrada. Só para testes. */
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
        if (zip.readUInt32LE(local + 18) !== tamComprimido || zip.readUInt32LE(local + 14) !== crc) throw new Error(`ZIP: cabeçalho local diverge do central em ${nome}`);
        const inicio = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
        const bruto = zip.subarray(inicio, inicio + tamComprimido);
        const conteudo = metodo === 8 ? zlib.inflateRawSync(bruto) : metodo === 0 ? Buffer.from(bruto) : (() => { throw new Error(`ZIP: método ${metodo} não suportado`); })();
        if (conteudo.length !== tamanho || crc32(conteudo) !== crc) throw new Error(`ZIP: CRC/tamanho divergente em ${nome}`);
        saida.set(nome, conteudo);
        p += 46 + nLen + xLen + cLen;
    }
    return saida;
}
