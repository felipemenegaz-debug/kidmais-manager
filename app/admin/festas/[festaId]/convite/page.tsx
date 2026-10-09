import ConviteEditor from '@/components/convites/ConviteEditor';
export default async function Page({ params }: { params: Promise<{ festaId: string }> }) {
  const { festaId } = await params; return <ConviteEditor festaId={festaId} />;
}
