import AvisoEndereco from '@/components/enderecos/AvisoEndereco';

/** Só para o aviso de troca de endereço: o editor chama a API do próprio host e conserva o conteúdo ao receber erro. */
export default function ConvitesLayout({ children }: { children: React.ReactNode }) {
    return <><AvisoEndereco />{children}</>;
}
