import { z } from 'zod';
import { MENSAGEM_ERRO_ARQUIVO } from './arquivos.ts';

/** Erro de domínio do atendimento → resposta HTTP. Compartilhado pelas rotas de atendimento e de mensagens prontas. */
const MENSAGEM: Record<string, string> = {
  ATENDIMENTO_CONTATO_BLOQUEADO: 'Este contato pediu para não receber mensagens.',
  ATENDIMENTO_PAUSA_PEDIDA: 'O cliente pediu para parar as mensagens: o Wall-e não responde mais esta conversa. A equipe pode responder pessoalmente.',
  ATENDIMENTO_DESATUALIZADO: 'A conversa mudou. Atualize antes de continuar.',
  ATENDIMENTO_ENVIO_EM_ANDAMENTO: 'Uma mensagem está sendo enviada. Aguarde e atualize a conversa.',
  ATENDIMENTO_JANELA_EXPIRADA: 'A janela de atendimento expirou. Aguarde nova mensagem do cliente.',
  ATENDIMENTO_ASSUMA_ANTES_DE_ENVIAR: 'Assuma a conversa antes de responder.',
  ATENDIMENTO_AUTOMACAO_DESLIGADA: 'O piloto ainda não foi ativado no servidor.',
  ATENDIMENTO_ACESSO_NEGADO: 'Seu perfil não tem acesso a esta ação do atendimento.',
  ATENDIMENTO_SEM_ACESSO: 'Seu acesso não inclui o Atendimento WhatsApp desta empresa.',
  ATENDIMENTO_EMPRESA_DIVERGENTE: 'A empresa ativa não é a do Atendimento WhatsApp. Troque a empresa ativa no menu para usá-lo.',
  ATENDIMENTO_EMPRESA_NAO_SELECIONADA: 'Selecione a empresa ativa no menu para abrir o Atendimento WhatsApp.',
  ATENDIMENTO_IA_DESLIGADA: 'A chave da IA está desligada neste ambiente: a fila não envia respostas agora.',
  ATENDIMENTO_NAO_ENCONTRADO: 'Conversa não encontrada. Atualize a lista.',
  ATENDIMENTO_PRONTAS_INDISPONIVEL: 'Mensagens prontas indisponíveis neste ambiente: a estrutura da biblioteca (migration 080) ainda não foi aplicada.',
  ATENDIMENTO_PRONTA_ATALHO_EM_USO: 'Já existe uma mensagem ativa neste atalho. Edite a atual ou tire o atalho dela antes.',
  ATENDIMENTO_PRONTA_TITULO_EM_USO: 'Já existe uma mensagem pronta com este título.',
  ATENDIMENTO_PRONTA_DESATUALIZADA: 'A mensagem pronta mudou. Atualize a lista antes de continuar.',
  ATENDIMENTO_PRONTA_NAO_ENCONTRADA: 'Mensagem pronta não encontrada. Atualize a lista.',
  ATENDIMENTO_MIDIA_INDISPONIVEL: 'Fotos, vídeos e os atalhos de salgados, bolos, endereço e localização ainda não estão disponíveis neste ambiente (migration 081 não aplicada).',
  ATENDIMENTO_LEGENDA_LONGA: 'A legenda da foto ou do vídeo passa de 1024 caracteres.',
  ATENDIMENTO_RECURSO_082_INDISPONIVEL: 'PDF, arquivos próprios, rascunho/publicação e envio automático pelo Wall-e ainda não estão disponíveis neste ambiente (migration 082 não aplicada).',
  ATENDIMENTO_PACOTE_NAO_ENCONTRADO: 'Pacote não encontrado entre os pacotes vigentes desta empresa.',
  ATENDIMENTO_UNIDADE_NAO_ENCONTRADA: 'Unidade não encontrada nesta empresa.',
  ATENDIMENTO_ARQUIVO_INVALIDO: 'O arquivo escolhido não é desta empresa ou não é do tipo da mensagem. Envie o arquivo de novo.',
  ATENDIMENTO_ARQUIVO_NAO_ENCONTRADO: 'Arquivo não encontrado nesta empresa (ou já revogado). Atualize a lista.',
  ATENDIMENTO_ARQUIVO_INDISPONIVEL: 'O arquivo desta mensagem pronta foi revogado ou expirou. Nada foi enviado; escolha outro material.',
  ATENDIMENTO_ARQUIVO_VENCIDO: 'Este arquivo já expirou. Para usá-lo de novo, reative-o: um link novo será gerado.',
  ATENDIMENTO_ARQUIVO_NAO_VENCIDO: 'Este arquivo não está vencido: não há o que reativar.',
  ATENDIMENTO_DATA_INVALIDA: 'Informe uma data e hora futura (até 5 anos).',
  ATENDIMENTO_PRAZO_INVALIDO: 'Informe um prazo entre 1 e 3650 dias, ou desligue a exclusão automática.',
  ATENDIMENTO_EXCLUSAO_ADIADA: 'Esta conversa tem uma mensagem em processamento ou em envio. Nada foi apagado; tente de novo em alguns instantes.',
  ATENDIMENTO_REAUTENTICACAO: 'Confirme sua senha antes desta ação.',
  ATENDIMENTO_GRUPO_PARCIAL: 'Parte desta resposta já foi enviada e este arquivo ainda está na fila. Esperar não resolve: assuma ou encerre a conversa (a fila automática sai) e revogue de novo. Nada foi alterado.',
  ATENDIMENTO_CONTATO_INVALIDO: 'Informe o número completo, só com dígitos (DDI, DDD e número).',
  ATENDIMENTO_PRONTA_MIDIA_ALTERADA: 'A foto ou o vídeo desta mensagem pronta mudou ou foi removido depois da prévia. Nada foi enviado: remova o anexo e abra a prévia de novo para revisar.',
};
// Regra de negócio não é indisponibilidade: só falha inesperada (banco, configuração) devolve 503.
const CONFLITO = ['ATENDIMENTO_DESATUALIZADO', 'ATENDIMENTO_ENVIO_EM_ANDAMENTO', 'ATENDIMENTO_CONTATO_BLOQUEADO', 'ATENDIMENTO_PAUSA_PEDIDA', 'ATENDIMENTO_JANELA_EXPIRADA', 'ATENDIMENTO_ASSUMA_ANTES_DE_ENVIAR', 'ATENDIMENTO_AUTOMACAO_DESLIGADA', 'ATENDIMENTO_IA_DESLIGADA', 'ATENDIMENTO_LEGENDA_LONGA',
  'ATENDIMENTO_PRONTA_ATALHO_EM_USO', 'ATENDIMENTO_PRONTA_TITULO_EM_USO', 'ATENDIMENTO_PRONTA_DESATUALIZADA', 'ATENDIMENTO_PRONTA_MIDIA_ALTERADA', 'ATENDIMENTO_RECURSO_082_INDISPONIVEL', 'ATENDIMENTO_ARQUIVO_INVALIDO',
  'ATENDIMENTO_ARQUIVO_INDISPONIVEL', 'ATENDIMENTO_ARQUIVO_VENCIDO', 'ATENDIMENTO_ARQUIVO_NAO_VENCIDO', 'ATENDIMENTO_EXCLUSAO_ADIADA', 'ATENDIMENTO_GRUPO_PARCIAL'];
// Dado informado inválido (data, prazo): 400, nunca 503.
const INVALIDO = ['ATENDIMENTO_DATA_INVALIDA', 'ATENDIMENTO_PRAZO_INVALIDO', 'ATENDIMENTO_CONTATO_INVALIDO'];
const NAO_ENCONTRADO = ['ATENDIMENTO_NAO_ENCONTRADO', 'ATENDIMENTO_ARQUIVO_NAO_ENCONTRADO', 'ATENDIMENTO_PRONTA_NAO_ENCONTRADA', 'ATENDIMENTO_PACOTE_NAO_ENCONTRADO', 'ATENDIMENTO_UNIDADE_NAO_ENCONTRADA'];
// Recusas de acesso (antes de ler ou gravar qualquer coisa): papel, vínculo e empresa ativa (063 do painel).
const ACESSO = ['ATENDIMENTO_ACESSO_NEGADO', 'ATENDIMENTO_REAUTENTICACAO', 'ATENDIMENTO_SEM_ACESSO', 'ATENDIMENTO_EMPRESA_DIVERGENTE', 'ATENDIMENTO_EMPRESA_NAO_SELECIONADA'];

export function respostaDeErroAtendimento(error: unknown): { status: number; corpo: { ok: false; erro: string; codigo: string } } {
  if (error instanceof SyntaxError) return { status: 400, corpo: { ok: false, erro: 'Confira os campos.', codigo: 'DADOS_INVALIDOS' } };
  if (error instanceof z.ZodError) {
    // Mensagens próprias do schema (ex.: "Informe um link https completo.") são para a pessoa; as genéricas não.
    const propria = error.issues.find(i => i.code === 'custom')?.message;
    return { status: 400, corpo: { ok: false, erro: propria ?? 'Confira os campos.', codigo: 'DADOS_INVALIDOS' } };
  }
  // Arquivo recusado na validação (formato, tamanho, tipo): mensagem para a pessoa, sem 503.
  if (error instanceof Error && MENSAGEM_ERRO_ARQUIVO[error.message]) return { status: 400, corpo: { ok: false, erro: MENSAGEM_ERRO_ARQUIVO[error.message], codigo: error.message } };
  const code = error instanceof Error && /^ATENDIMENTO_[A-Z_]+$/.test(error.message) ? error.message : 'ATENDIMENTO_INDISPONIVEL';
  const status = INVALIDO.includes(code) ? 400 : CONFLITO.includes(code) ? 409 : ACESSO.includes(code) ? 403 : NAO_ENCONTRADO.includes(code) ? 404 : 503;
  return { status, corpo: { ok: false, erro: MENSAGEM[code] ?? 'Atendimento indisponível ou acesso não autorizado. Confira a configuração do piloto.', codigo: code } };
}
