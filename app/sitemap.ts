import { sitemapDaPlataforma } from '@/lib/site/indexacao';
// Lido a cada pedido: a origem pública vem do ambiente.
export const dynamic = 'force-dynamic';
export default function sitemap() { return sitemapDaPlataforma(); }
