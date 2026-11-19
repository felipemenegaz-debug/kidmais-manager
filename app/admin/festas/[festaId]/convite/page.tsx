import ConviteEditor from '@/components/convites/ConviteEditor';
export default async function Page({ params }: { params: Promise<{ festaId: string }> }) {
  const { festaId } = await params; return <ConviteEditor key={festaId} festaId={festaId} />; // r5: outra festa remonta o editor
}
