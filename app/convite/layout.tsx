import AvisoEndereco from '@/components/enderecos/AvisoEndereco';

/** Só para o aviso de troca de endereço: o convite público chama a API do próprio host. */
export default function ConviteLayout({ children }: { children: React.ReactNode }) {
    return <><AvisoEndereco />{children}</>;
}
