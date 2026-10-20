import SiteVenda from '@/components/site/Site';
import { metadataSite } from '@/lib/site/metadata';
export const dynamic = 'force-dynamic';
export const generateMetadata = () => metadataSite();
// Para promover a landing a /: reexportar este default em app/page.tsx após D1.
export default function Conheca() { return <SiteVenda />; }
