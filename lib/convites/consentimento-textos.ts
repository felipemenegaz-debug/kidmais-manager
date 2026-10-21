// Textos da autorização específica para Convites com IA (parecer da Astra de 21/10/2026, ponto urgente 1).
// Módulo puro (servidor e navegador). Qualquer mudança de redação exige nova VERSAO_TEXTOS_IA: as autorizações
// registradas com a versão anterior deixam de valer para novas gerações e o responsável precisa autorizar de novo.
// Os textos-base são os da Astra; as adaptações (nome do provedor, versão do buffet, fotografia e imagens da galeria
// por geração) estão em docs/CONVITES_IA_CONSENTIMENTO_20261021.md e dependem de conferência jurídica.
// Versão .2 (P2-3 da revisão de 15aa937): a autorização geral (dados da festa) vale até a revogação; a da fotografia e
// das imagens da galeria é confirmada a cada geração que as envia (uso único, com o sha-256 das imagens no evento).

export const VERSAO_TEXTOS_IA = 'convites-ia-20261021.2';

// Seção do Aviso de privacidade que descreve os recursos de IA (L5), com âncora própria.
export const LINK_AVISO_IA = '/privacidade#inteligencia-artificial';

// Provedor REAL configurado no servidor (CONVITES_IA_PROVIDER). O nome exibido sai daqui; nunca do navegador.
export const PROVEDORES_IA = Object.freeze({
  openai: Object.freeze({ nome: 'OpenAI', comArtigo: 'à OpenAI' }),
  gemini: Object.freeze({ nome: 'Google (Gemini)', comArtigo: 'ao Google (Gemini)' }),
});
export type ProvedorIA = keyof typeof PROVEDORES_IA;
export const ehProvedorIA = (p: unknown): p is ProvedorIA => typeof p === 'string' && Object.hasOwn(PROVEDORES_IA, p);

export type OperadorIA = 'CLIENTE' | 'BUFFET';

// Identificação mínima do responsável: nome e vínculo informados por quem opera. Nunca cópia de documento.
export const VINCULOS_RESPONSAVEL = Object.freeze({
  MAE: 'Mãe',
  PAI: 'Pai',
  TUTOR: 'Tutor(a) ou guardião(ã) legal',
  OUTRO_RESPONSAVEL_LEGAL: 'Outro responsável legal',
});
export type VinculoResponsavel = keyof typeof VINCULOS_RESPONSAVEL;

// Como o buffet recebeu a autorização. PROPRIO_RESPONSAVEL é exclusivo do responsável usando o link do convite.
export const MEIOS_AUTORIZACAO = Object.freeze({
  PROPRIO_RESPONSAVEL: 'O próprio responsável, nesta tela',
  PRESENCIAL: 'Presencialmente',
  WHATSAPP: 'Por WhatsApp',
  EMAIL: 'Por e-mail',
  TELEFONE: 'Por telefone',
  OUTRO: 'Outro meio',
});
export type MeioAutorizacao = keyof typeof MEIOS_AUTORIZACAO;
export const MEIOS_DO_BUFFET = (Object.keys(MEIOS_AUTORIZACAO) as MeioAutorizacao[]).filter(m => m !== 'PROPRIO_RESPONSAVEL');

export type TextosAutorizacaoIA = {
  versao: string; provedor: ProvedorIA; provedorNome: string; operador: OperadorIA;
  aviso: string; consentimento: string; foto: string; alternativa: string; imagens: string;
};

/** Textos exibidos no momento da geração para o provedor e o operador dados. */
export function textosAutorizacaoIA(provedor: ProvedorIA, operador: OperadorIA): TextosAutorizacaoIA {
  if (!ehProvedorIA(provedor)) throw new Error('Provedor de IA desconhecido.');
  const p = PROVEDORES_IA[provedor];
  // Texto da Astra: "O nome deve corresponder ao provedor realmente escolhido."
  const aviso = `Para criar este convite com IA, enviaremos ${p.comArtigo} os dados selecionados da festa, que podem incluir nome e idade da criança e informações do evento. A fotografia só será enviada se você autorizar separadamente. A imagem gerada será armazenada no Kidmais e poderá conter esses dados. Consulte as condições de tratamento e retenção antes de continuar.`;
  const consentimento = operador === 'CLIENTE'
    ? 'Declaro ser responsável legal pela criança e autorizo especificamente o uso dos dados selecionados para gerar este convite por IA, nas condições informadas. Sei que posso escolher uma alternativa sem IA e revogar esta autorização para usos futuros.'
    // Funcionário do buffet: registra a autorização dada pelo responsável (adaptação; ver documentação).
    : 'Registro que o responsável legal identificado abaixo declarou ser responsável pela criança e autorizou especificamente o uso dos dados selecionados para gerar este convite por IA, nas condições informadas. Ele foi informado de que pode escolher uma alternativa sem IA e revogar esta autorização para usos futuros.';
  // Astra: "Autorizo também o envio desta fotografia ao provedor indicado para gerar a arte." Aqui a confirmação só
  // aparece depois de escolhida a imagem e vale para esta geração.
  const foto = operador === 'CLIENTE'
    ? `Autorizo também o envio desta fotografia e das imagens da galeria selecionadas ao provedor indicado (${p.nome}) para gerar esta arte.`
    : `O responsável autorizou também o envio desta fotografia e das imagens da galeria selecionadas ao provedor indicado (${p.nome}) para gerar esta arte.`;
  return {
    versao: VERSAO_TEXTOS_IA, provedor, provedorNome: p.nome, operador, aviso, consentimento, foto,
    imagens: 'Esta confirmação vale só para esta geração e para as imagens selecionadas agora. Sem ela, nenhuma foto nem imagem da galeria é enviada ao provedor.',
    alternativa: 'Prefere não usar IA? Use uma arte própria ou o visual padrão do convite: nada é enviado a provedores de IA.',
  };
}

/** Conteúdo canônico da autorização geral (dados da festa), sem a fotografia. Hash calculado no servidor. */
export function conteudoCanonicoIA(t: TextosAutorizacaoIA) {
  return JSON.stringify([t.versao, t.operador, t.provedor, t.aviso, t.consentimento]);
}
/** Conteúdo canônico da confirmação da fotografia e das imagens da galeria (por geração). */
export function conteudoCanonicoImagensIA(t: TextosAutorizacaoIA) {
  return JSON.stringify([t.versao, t.operador, t.provedor, 'IMAGENS', t.foto]);
}
