import ConviteEditor from '@/components/convites/ConviteEditor';
export default async function Page({ params }: { params: Promise<{ conviteId: string }> }) {
  const { conviteId } = await params;
  // r5 (Astra r4, P2): outro convite remonta o editor; nada da carga ou do estado de um passa para o outro.
  return <ConviteEditor key={conviteId} conviteId={conviteId} />;
}
