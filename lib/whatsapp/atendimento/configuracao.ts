export type AmbienteAtendimento = 'staging' | 'production';
export function ambienteAtendimento(env: NodeJS.ProcessEnv = process.env): AmbienteAtendimento {
  if (env.KIDMAIS_DEPLOY_ENV !== 'staging' && env.KIDMAIS_DEPLOY_ENV !== 'production') throw new Error('ATENDIMENTO_AMBIENTE_INVALIDO');
  return env.KIDMAIS_DEPLOY_ENV;
}
export function empresaPiloto(env: NodeJS.ProcessEnv = process.env) {
  const id = env.WHATSAPP_ATENDIMENTO_EMPRESA_ID;
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) throw new Error('ATENDIMENTO_EMPRESA_NAO_CONFIGURADA');
  return id;
}
/**
 * Receptor único do número comercial. O app Gupshup aceita até cinco assinaturas de webhook e cada uma recebe uma
 * cópia dos eventos: staging e produção podem receber a mesma mensagem. Só o ambiente nomeado em
 * WHATSAPP_ATENDIMENTO_RECEPTOR (igual a KIDMAIS_DEPLOY_ENV) grava entradas e envia respostas. Ausente ou divergente:
 * nenhuma automação (fail-closed); as flags de ligar não bastam sem o receptor.
 */
export function receptorDoNumero(env: NodeJS.ProcessEnv = process.env) {
  const receptor = env.WHATSAPP_ATENDIMENTO_RECEPTOR;
  return (receptor === 'staging' || receptor === 'production') && receptor === env.KIDMAIS_DEPLOY_ENV;
}
/**
 * WHATSAPP_ATENDIMENTO_WALLE_ENTENDIMENTO=regras: NENHUM caminho do atendimento chama o modelo — nem o Wall-e nem a fase B
 * (Wall-e desligado na tela ou sem a 082), qualquer que seja o orçamento de IA. Variável do próprio canal (não é a chave
 * da IA): o worker e a porta do Wall-e conferem a cada uso, além da composition root, que nem monta o modelo.
 */
// 12/10 (D1): o PADRÃO passou a ser o modo regras. O modelo só é usado com WHATSAPP_ATENDIMENTO_WALLE_ENTENDIMENTO=modelo,
// opção explícita do ambiente, que não deve ser ligada com dados reais enquanto a cobertura de dados sensíveis tiver lacunas
// (docs/PRIVACIDADE_ATENDIMENTO_D1_D4.md, R6). Qualquer outro valor (ausente, "regras", erro de digitação) = regras.
// H1 (revisão de 69dc301): pedir o modelo NÃO basta. O modo modelo exige também a referência da decisão R6 em
// WHATSAPP_ATENDIMENTO_IA_AUTORIZACAO (ex.: "R6-2026-11-03-ata12") e, fora de produção, a lista de contatos controlados.
// Faltando qualquer um, o modo efetivo é regras (falha fechada), em todos os caminhos (Wall-e, fase B, composition root).
export const FORMATO_AUTORIZACAO_IA = /^R6-[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/;
export type ModoEntendimento = { modo: 'REGRAS' | 'MODELO'; motivo: 'PADRAO_REGRAS' | 'SEM_AUTORIZACAO_R6' | 'SEM_LISTA_DE_CONTATOS' | 'AUTORIZADO' };
export function modoEntendimento(env: NodeJS.ProcessEnv = process.env): ModoEntendimento {
  if (env.WHATSAPP_ATENDIMENTO_WALLE_ENTENDIMENTO !== 'modelo') return { modo: 'REGRAS', motivo: 'PADRAO_REGRAS' };
  if (!FORMATO_AUTORIZACAO_IA.test(env.WHATSAPP_ATENDIMENTO_IA_AUTORIZACAO ?? '')) return { modo: 'REGRAS', motivo: 'SEM_AUTORIZACAO_R6' };
  if (env.KIDMAIS_DEPLOY_ENV !== 'production' && !(env.WHATSAPP_ATENDIMENTO_CONTATOS_PERMITIDOS ?? '').trim()) return { modo: 'REGRAS', motivo: 'SEM_LISTA_DE_CONTATOS' };
  return { modo: 'MODELO', motivo: 'AUTORIZADO' };
}
export function entendimentoSoRegras(env: NodeJS.ProcessEnv = process.env) { return modoEntendimento(env).modo === 'REGRAS'; }
/** Sem empresa piloto válida a recepção fica desligada (só metadados): erro de configuração não vira 503 eterno. */
export function recepcaoAtiva(env: NodeJS.ProcessEnv = process.env) {
  if (env.WHATSAPP_ATENDIMENTO_RECEIVE_ENABLED !== 'true' || !receptorDoNumero(env)) return false;
  try { empresaPiloto(env); return true; } catch { return false; }
}
export function atendimentoAtivo(env: NodeJS.ProcessEnv = process.env) { return env.WHATSAPP_ATENDIMENTO_ENABLED === 'true' && receptorDoNumero(env); }

/**
 * Contatos que o canal pode receber e responder (WHATSAPP_ATENDIMENTO_CONTATOS_PERMITIDOS: números com DDI, só
 * dígitos, separados por vírgula). Staging usa o número comercial real: sem a lista, nada é gravado nem enviado
 * (fail-closed), e mensagens de clientes reais nunca entram no banco de homologação. Em produção a lista é opcional
 * (ativação gradual); ausente, todos os contatos são atendidos.
 */
export function contatoPermitido(contato: string, env: NodeJS.ProcessEnv = process.env) {
  const lista = (env.WHATSAPP_ATENDIMENTO_CONTATOS_PERMITIDOS ?? '').split(',').map(v => v.trim()).filter(Boolean);
  if (lista.some(v => !/^\d{8,15}$/.test(v))) return false;
  if (!lista.length) return ambienteAtendimento(env) === 'production';
  return lista.includes(contato);
}

/**
 * Origem pública (https) das URLs de arquivos próprios da biblioteca (082), baixadas pelo provedor sem sessão:
 * WHATSAPP_ATENDIMENTO_MIDIA_ORIGEM ou, sem ela, ADMIN_AUTH_ORIGIN. Sem origem https o arquivo não é enviado.
 */
export function origemMidia(env: NodeJS.ProcessEnv = process.env) {
  return env.WHATSAPP_ATENDIMENTO_MIDIA_ORIGEM || env.ADMIN_AUTH_ORIGIN || null;
}
