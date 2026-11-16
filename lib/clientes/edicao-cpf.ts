// Edição do cliente PF (15/11/2026): o CPF pode ser COMPLETADO quando o cadastro ainda não tem um (cliente vindo de
// contato do Marketing, por exemplo); TROCAR um CPF existente segue bloqueado na tela e no servidor
// (ALTERACAO_CPF_REQUER_PERMISSAO em atualizarClienteInterno). Sem imports para rodar no node:test.

const digitos = (valor: string | null | undefined) => String(valor ?? "").replace(/\D/g, "");

/** Na edição, o campo CPF fica liberado só quando o cadastro salvo não tem CPF (ou na troca de tipo PJ→PF). */
export function cpfEditavelNaEdicao(cpfSalvo: string | null | undefined, trocandoTipo: boolean) {
  return trocandoTipo || digitos(cpfSalvo).length === 0;
}

/**
 * Patch da edição: PJ envia tudo (o CPF vai nulo); PF só envia o CPF quando está completando um cadastro sem CPF e há
 * um valor digitado. Nunca envia um CPF que substitua o salvo nem um CPF vazio sobre o salvo.
 */
export function patchDeEdicaoCliente<T extends { tipoPessoa: "PF" | "PJ"; cpf: string | null }>(payload: T, cpfSalvo: string | null | undefined) {
  if (payload.tipoPessoa === "PJ") return payload;
  const { cpf, ...semCpf } = payload;
  return digitos(cpfSalvo).length === 0 && digitos(cpf).length > 0 ? payload : semCpf;
}
