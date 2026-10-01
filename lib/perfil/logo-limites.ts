export const LOGO_MAX_UPLOAD_MB = 10;
export const LOGO_MAX_UPLOAD = LOGO_MAX_UPLOAD_MB * 1024 * 1024;
export const LOGO_MAX_PNG = 512 * 1024;
export const LOGO_MAX_DATA_URL = Math.ceil(LOGO_MAX_PNG / 3) * 4 + 22;
export const LOGO_TIPOS = ['image/png', 'image/jpeg', 'image/webp'];

export function erroArquivoLogo(arquivo: { name: string; type: string; size: number }): string | null {
    if (!LOGO_TIPOS.includes(arquivo.type))
        return `Formato não aceito para ${arquivo.name}. Selecione uma imagem PNG, JPEG ou WebP.`;
    if (arquivo.size > LOGO_MAX_UPLOAD) {
        const tamanho = (arquivo.size / (1024 * 1024)).toLocaleString('pt-BR', { maximumFractionDigits: 2 });
        return `${arquivo.name} tem ${tamanho} MB. A logo deve ter até ${LOGO_MAX_UPLOAD_MB} MB.`;
    }
    if (!arquivo.size) return `${arquivo.name} está vazio. Selecione outra imagem.`;
    return null;
}
