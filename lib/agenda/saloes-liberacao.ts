/**
 * Decisão de Felipe (25/10/2026): duas festas no mesmo horário só com salões distintos e o nome do salão no contrato,
 * no resumo do cliente e no convite. A liberação da ida a "mais de um salão" é por ambiente (D-LIB-1, 31/10/2026):
 * env de runtime lida só no servidor (saloes-liberacao-servidor.ts); a tela recebe a capacidade pela API.
 * Na agenda com um salão, cada horário recebe uma festa por vez.
 */

export const AVISO_UM_SALAO = 'Com um salão, cada horário recebe uma festa por vez.';
export const AVISO_MAIS_DE_UM_SALAO_EM_BREVE = 'A agenda com mais de um salão ainda não está disponível. Por enquanto, a agenda funciona com um salão: uma festa por horário. Dá para mudar em Configurações › Agenda quando for liberada.';
export const AVISO_SALAO_DO_PACOTE = 'Escolha o salão ou os salões deste pacote.';
export const AVISO_SALAO_DO_PACOTE_ORIGEM = 'Este pacote ainda não tem salão. Abra o pacote, escolha o salão ou os salões e salve antes de duplicar, alterar ou ativar.';
/** D-LIB-2 (texto aprovado por Felipe em 31/10/2026): mostrado ANTES da ida, nas Configurações e no assistente. */
export const AVISO_IDA_SEM_VOLTA = 'Depois de mudar para mais de um salão, esta unidade não volta para um salão só. As festas já contratadas sem salão continuam ocupando todos os salões até a revisão do contrato.';
export const AVISO_IDA_HORARIOS_HERDADOS = 'Salve a agenda desta unidade antes de mudar para mais de um salão.';
export const AVISO_IDA_SO_SALOES = 'Ao mudar para mais de um salão, salve só os salões novos e os salões de cada horário. Mude o resto depois, num novo salvamento.';
export const AVISO_VOLTA_UM_SALAO = 'Voltar da agenda com mais de um salão para um salão ainda não está disponível pela tela. Fale com o suporte do iA.Fest.';
