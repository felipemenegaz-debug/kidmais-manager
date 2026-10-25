/**
 * Decisão de Felipe (25/10/2026): duas festas no mesmo horário só com salões distintos e o nome do salão no contrato,
 * no resumo do cliente e no convite. Até essas peças existirem, a agenda com mais de um salão não pode ser escolhida:
 * só quem já está "por salão" continua nela. Na agenda com um salão, cada horário recebe uma festa por vez.
 */
export const AGENDA_MAIS_DE_UM_SALAO_LIBERADA = false;

export const AVISO_UM_SALAO = 'Com um salão, cada horário recebe uma festa por vez.';
export const AVISO_MAIS_DE_UM_SALAO_EM_BREVE = 'A agenda com mais de um salão ainda não está disponível. Por enquanto, a agenda funciona com um salão: uma festa por horário. Dá para mudar em Configurações › Agenda quando for liberada.';
export const AVISO_SALAO_DO_PACOTE = 'Escolha o salão ou os salões deste pacote.';
export const AVISO_SALAO_DO_PACOTE_ORIGEM = 'Este pacote ainda não tem salão. Abra o pacote, escolha o salão ou os salões e salve antes de duplicar, alterar ou ativar.';
export const AVISO_VOLTA_UM_SALAO = 'Voltar da agenda com mais de um salão para um salão ainda não está disponível pela tela. Fale com o suporte Kidmais.';
