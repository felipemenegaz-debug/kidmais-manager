import sharp from 'sharp';
import { ClienteServiceError } from '../clientes/services/errors.ts';
import { LOGO_MAX_UPLOAD, LOGO_MAX_PNG, LOGO_MAX_DATA_URL } from './logo-limites.ts';

function invalida() {
    return new ClienteServiceError('PERFIL_LOGO_INVALIDA', 'Envie uma imagem PNG, JPEG ou WebP válida de até 2 MB.', 400);
}

// Apenas pixels de imagens estáticas. Reencodar remove metadados e conteúdo adicional.
export async function prepararLogo(bytes: Buffer): Promise<string> {
    if (!bytes.length || bytes.length > LOGO_MAX_UPLOAD) throw invalida();
    try {
        const imagem = sharp(bytes, { limitInputPixels: 16_000_000, failOn: 'warning' });
        const meta = await imagem.metadata();
        if (!['png', 'jpeg', 'webp'].includes(meta.format ?? '') || (meta.pages ?? 1) !== 1) throw invalida();
        const png = await imagem.rotate().resize({ width: 1024, height: 512, fit: 'inside', withoutEnlargement: true }).png().toBuffer();
        if (png.length > LOGO_MAX_PNG) throw invalida();
        return `data:image/png;base64,${png.toString('base64')}`;
    } catch { throw invalida(); }
}

export async function conferirLogoSalva(valor: string | null | undefined): Promise<string | null> {
    if (valor == null) return null;
    if (valor.length > LOGO_MAX_DATA_URL || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(valor)) throw invalida();
    const base64 = valor.slice(22), bytes = Buffer.from(base64, 'base64');
    if (bytes.toString('base64') !== base64 || bytes.length > LOGO_MAX_PNG) throw invalida();
    return prepararLogo(bytes);
}
