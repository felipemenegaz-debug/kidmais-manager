/** Estado do salvamento do editor do site (o mesmo do selo "Rascunho salvo / Alterações não salvas / Salvando… / Erro"). */
export type EstadoSalvar = 'salvo' | 'sujo' | 'salvando' | 'erro';
export type AcaoDialogo = 'continuar' | 'sair' | 'salvar-e-sair' | 'sair-sem-salvar';

/**
 * Texto e ações da confirmação ao sair do editor (ou trocar de unidade), conforme o estado REAL do salvamento (O1). O
 * pedido de saída é preservado mesmo quando o salvamento termina antes de a pessoa responder; então:
 *  - salvo: não afirma perda nem exige salvar de novo — "Continuar editando" ou sair;
 *  - sujo (inclusive o que foi digitado durante o envio) e salvando: protege o que não foi salvo, como antes;
 *  - erro: diz que falhou e que nada foi salvo — nunca aparece como salvo.
 * Sair é sempre uma decisão explícita.
 */
export function conteudoDialogoAlteracoes(estado: EstadoSalvar, acao: 'sair' | 'trocar', nomeUnidade: string, podeSalvar: boolean): { texto: string; acoes: AcaoDialogo[] } {
  const perde = acao === 'sair' ? 'Se sair agora sem salvar, elas se perdem.' : 'Se trocar agora sem salvar, elas se perdem.';
  if (estado === 'salvo') {
    return {
      texto: `As alterações do site da ${nomeUnidade} já foram salvas. ${acao === 'sair' ? 'Você pode sair do editor sem perder nada.' : 'Você pode trocar de unidade sem perder nada.'}`,
      acoes: ['continuar', 'sair'],
    };
  }
  const texto = estado === 'erro'
    ? `O salvamento do site da ${nomeUnidade} falhou: as alterações ainda não foram salvas. ${perde}`
    : `O site da ${nomeUnidade} tem alterações que ainda não foram salvas. ${perde}`;
  return { texto, acoes: podeSalvar ? ['continuar', 'salvar-e-sair', 'sair-sem-salvar'] : ['continuar', 'sair-sem-salvar'] };
}
