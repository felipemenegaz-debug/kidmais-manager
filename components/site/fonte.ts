import { Bricolage_Grotesque, Figtree } from 'next/font/google';
export const fonteTitulo = Bricolage_Grotesque({ subsets: ['latin'], variable: '--font-site-display', display: 'swap', axes: ['opsz'] });
export const fonteTexto = Figtree({ subsets: ['latin'], variable: '--font-site-body', display: 'swap', weight: ['400', '500', '600'] });
