// Textos da autorização específica para Convites com IA (parecer da Astra de 21/10/2026, ponto urgente 1).
// Módulo puro (servidor e navegador). Qualquer mudança de redação exige nova VERSAO_TEXTOS_IA: as autorizações
// registradas com a versão anterior deixam de valer para novas gerações e o responsável precisa autorizar de novo.
// Os textos-base são os da Astra; as adaptações (nome do provedor, versão do buffet) estão em
// docs/CONVITES_IA_CONSENTIMENTO_20261021.md e dependem de conferência jurídica.

export const VERSAO_TEXTOS_IA = 'convites-ia-20261021.1';

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
  const foto = operador === 'CLIENTE'
    ? `Autorizo também o envio desta fotografia ao provedor indicado (${p.nome}) para gerar a arte.`
    : `O responsável autorizou também o envio desta fotografia ao provedor indicado (${p.nome}) para gerar a arte.`;
  return {
    versao: VERSAO_TEXTOS_IA, provedor, provedorNome: p.nome, operador, aviso, consentimento, foto,
    imagens: 'Sem a autorização da fotografia, nenhuma foto nem imagem da festa usada como referência é enviada ao provedor.',
    alternativa: 'Prefere não usar IA? Use uma arte própria ou o visual padrão do convite: nada é enviado a provedores de IA.',
  };
}

/**
 * Conteúdo canônico que identifica o texto exibido. A foto entra só quando autorizada: os textos aceitos com e sem
 * foto têm hashes diferentes. O hash (sha-256 deste conteúdo) é calculado no servidor.
 */
export function conteudoCanonicoIA(t: TextosAutorizacaoIA, fotoAutorizada: boolean) {
  return JSON.stringify([t.versao, t.operador, t.provedor, t.aviso, t.consentimento, fotoAutorizada ? t.foto : null]);
}
