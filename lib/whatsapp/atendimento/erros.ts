import { z } from 'zod';

/** Erro de domínio do atendimento → resposta HTTP. Compartilhado pelas rotas de atendimento e de mensagens prontas. */
const MENSAGEM: Record<string, string> = {
  ATENDIMENTO_CONTATO_BLOQUEADO: 'Este contato pediu para não receber mensagens.',
  ATENDIMENTO_DESATUALIZADO: 'A conversa mudou. Atualize antes de continuar.',
  ATENDIMENTO_ENVIO_EM_ANDAMENTO: 'Uma mensagem está sendo enviada. Aguarde e atualize a conversa.',
  ATENDIMENTO_JANELA_EXPIRADA: 'A janela de atendimento expirou. Aguarde nova mensagem do cliente.',
  ATENDIMENTO_ASSUMA_ANTES_DE_ENVIAR: 'Assuma a conversa antes de responder.',
  ATENDIMENTO_AUTOMACAO_DESLIGADA: 'O piloto ainda não foi ativado no servidor.',
  ATENDIMENTO_ACESSO_NEGADO: 'Seu perfil não tem acesso a esta ação do atendimento.',
  ATENDIMENTO_IA_DESLIGADA: 'A chave da IA está desligada neste ambiente: a fila não envia respostas agora.',
  ATENDIMENTO_NAO_ENCONTRADO: 'Conversa não encontrada. Atualize a lista.',
  ATENDIMENTO_PRONTAS_INDISPONIVEL: 'Mensagens prontas indisponíveis neste ambiente: a estrutura da biblioteca (migration 063) ainda não foi aplicada.',
  ATENDIMENTO_PRONTA_ATALHO_EM_USO: 'Já existe uma mensagem ativa neste atalho. Edite a atual ou tire o atalho dela antes.',
  ATENDIMENTO_PRONTA_TITULO_EM_USO: 'Já existe uma mensagem pronta com este título.',
  ATENDIMENTO_PRONTA_DESATUALIZADA: 'A mensagem pronta mudou. Atualize a lista antes de continuar.',
  ATENDIMENTO_PRONTA_NAO_ENCONTRADA: 'Mensagem pronta não encontrada. Atualize a lista.',
};
// Regra de negócio não é indisponibilidade: só falha inesperada (banco, configuração) devolve 503.
const CONFLITO = ['ATENDIMENTO_DESATUALIZADO', 'ATENDIMENTO_ENVIO_EM_ANDAMENTO', 'ATENDIMENTO_CONTATO_BLOQUEADO', 'ATENDIMENTO_JANELA_EXPIRADA', 'ATENDIMENTO_ASSUMA_ANTES_DE_ENVIAR', 'ATENDIMENTO_AUTOMACAO_DESLIGADA', 'ATENDIMENTO_IA_DESLIGADA',
  'ATENDIMENTO_PRONTA_ATALHO_EM_USO', 'ATENDIMENTO_PRONTA_TITULO_EM_USO', 'ATENDIMENTO_PRONTA_DESATUALIZADA'];
const NAO_ENCONTRADO = ['ATENDIMENTO_NAO_ENCONTRADO', 'ATENDIMENTO_PRONTA_NAO_ENCONTRADA'];

export function respostaDeErroAtendimento(error: unknown): { status: number; corpo: { ok: false; erro: string; codigo: string } } {
  if (error instanceof SyntaxError) return { status: 400, corpo: { ok: false, erro: 'Confira os campos.', codigo: 'DADOS_INVALIDOS' } };
  if (error instanceof z.ZodError) {
    // Mensagens próprias do schema (ex.: "Informe um link https completo.") são para a pessoa; as genéricas não.
    const propria = error.issues.find(i => i.code === 'custom')?.message;
    return { status: 400, corpo: { ok: false, erro: propria ?? 'Confira os campos.', codigo: 'DADOS_INVALIDOS' } };
  }
  const code = error instanceof Error && /^ATENDIMENTO_[A-Z_]+$/.test(error.message) ? error.message : 'ATENDIMENTO_INDISPONIVEL';
  const status = CONFLITO.includes(code) ? 409 : code === 'ATENDIMENTO_ACESSO_NEGADO' ? 403 : NAO_ENCONTRADO.includes(code) ? 404 : 503;
  return { status, corpo: { ok: false, erro: MENSAGEM[code] ?? 'Atendimento indisponível ou acesso não autorizado. Confira a configuração do piloto.', codigo: code } };
}
