/**
 * Motivo de falha seguro para o log do atendimento: só códigos (ATENDIMENTO_MODELO_INDISPONIVEL:TIMEOUT etc.).
 * Mensagem livre de erro pode trazer trecho do pedido, da resposta do provedor ou do texto do cliente; nesse caso,
 * só o tipo do erro.
 */
export function motivoSeguro(erro: unknown): string {
  const mensagem = erro instanceof Error ? erro.message : '';
  if (/^[A-Z0-9_:]{1,120}$/.test(mensagem)) return mensagem;
  const nome = erro instanceof Error ? erro.name : typeof erro;
  return /^[A-Za-z0-9_]{1,60}$/.test(nome) ? `ERRO_${nome}` : 'ERRO_DESCONHECIDO';
}
