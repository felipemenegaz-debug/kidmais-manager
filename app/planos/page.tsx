import SiteVenda from '@/components/site/Site';
import { metadataSite } from '@/lib/site/metadata';
export const dynamic = 'force-dynamic';
export const generateMetadata = () => metadataSite('/planos');
export default function Planos() { return <SiteVenda somentePlanos />; }
