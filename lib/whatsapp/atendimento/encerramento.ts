// Usado na tela (navegador) e nos testes: nada de Node aqui.
/** Contador do encerramento: saídas (respostas na fila) separadas das entradas do cliente ainda sem resposta automática. */
export function resumoEncerramento(c?: { entradas: number; saidas: number }) {
  const partes = [
    c?.saidas ? (c.saidas === 1 ? '1 resposta na fila foi cancelada' : `${c.saidas} respostas na fila foram canceladas`) : '',
    c?.entradas ? (c.entradas === 1 ? '1 mensagem do cliente ficou sem resposta automática' : `${c.entradas} mensagens do cliente ficaram sem resposta automática`) : '',
  ].filter(Boolean);
  return `Atendimento encerrado. ${partes.length ? partes.join('; ') + '. ' : ''}O histórico foi mantido.`;
}
