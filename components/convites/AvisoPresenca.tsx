/** Aviso exibido antes da coleta da confirmação de presença, igual no link do convite e no link da família (R-5): controlador, finalidade, quem vê e acesso ao Aviso de privacidade. */
export default function AvisoPresenca({ buffet, className }: { buffet: string; className?: string }) {
  return <p className={className} data-aviso-presenca="">
    O buffet {buffet} é o responsável pelos dados desta confirmação. Usamos o nome informado e o número de adultos e crianças só para organizar a festa;
    a resposta é vista pelo buffet e pelo organizador. A confirmação deve ser feita por um adulto responsável.
    {' '}<a href="/privacidade#tratamento-de-dados" target="_blank" rel="noopener">Aviso de privacidade</a>
  </p>;
}
