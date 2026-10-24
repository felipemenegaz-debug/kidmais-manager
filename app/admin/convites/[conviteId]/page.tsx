import ConviteEditor from '@/components/convites/ConviteEditor';
export default async function Page({ params }: { params: Promise<{ conviteId: string }> }) {
  const { conviteId } = await params;
  return <ConviteEditor conviteId={conviteId} />;
}
