export const LOGO_MAX_UPLOAD = 2 * 1024 * 1024;
export const LOGO_MAX_PNG = 512 * 1024;
export const LOGO_MAX_DATA_URL = Math.ceil(LOGO_MAX_PNG / 3) * 4 + 22;
export const LOGO_TIPOS = ['image/png', 'image/jpeg', 'image/webp'];
