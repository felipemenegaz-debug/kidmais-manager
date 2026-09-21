import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
export const hashToken = (value: string) => createHash('sha256').update(value).digest('hex');
let active = 0;
const waiting: Array<() => void> = [];
async function derive(password: string, salt: Buffer) {
    if (active >= 2)
        await new Promise<void>(resolve => waiting.push(resolve));
    else
        active++;
    try {
        return await new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 64, { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }, (error, key) => error ? reject(error) : resolve(key)));
    }
    finally {
        const next = waiting.shift();
        if (next)
            next();
        else
            active--;
    }
}
export function senhaValida(password: string) {
    return [...password].length >= 8 && [...password].length <= 128 && Buffer.byteLength(password) <= 512;
}
export async function criarHashSenha(password: string) {
    if (!senhaValida(password))
        throw new Error('A senha deve ter entre 8 e 128 caracteres.');
    const salt = randomBytes(16);
    const key = await derive(password, salt);
    return `scrypt$v=1$N=131072$r=8$p=1$${salt.toString('base64')}$${key.toString('base64')}`;
}
export async function conferirSenha(password: string, encoded: string | null) {
    const match = encoded?.match(/^scrypt\$v=1\$N=131072\$r=8\$p=1\$([A-Za-z0-9+/]{22}==)\$([A-Za-z0-9+/]{86}==)$/);
    const salt = match ? Buffer.from(match[1], 'base64') : Buffer.alloc(16);
    const expected = match ? Buffer.from(match[2], 'base64') : Buffer.alloc(64);
    const actual = await derive(Buffer.byteLength(password) <= 512 ? password : '', salt);
    return timingSafeEqual(actual, expected) && !!match && senhaValida(password);
}
