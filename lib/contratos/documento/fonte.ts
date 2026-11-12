import { configuracaoModeloOficial } from './oficial/configuracao.ts';

/**
 * De onde sai o PDF de um contrato novo (regra do `gerar_pdf`, administrativo.service.ts). Uma função só, usada pelo
 * servidor ao gerar e pela tela para avisar antes: os dois não podem divergir (plano UX achados Frente C, rev. 3).
 *   - modelo próprio ATIVO (072) → EMPRESA, qualquer que seja o pacote;
 *   - sem modelo, com a 072, empresa que não é a Kidmais → SEM_MODELO_EMPRESA (o servidor recusa);
 *   - demais casos (Kidmais, ou antes da 072) → modelo fixo do pacote, se existir; senão SEM_TEMPLATE_OFICIAL (recusa).
 */
export type FonteDocumentoContrato = 'EMPRESA' | 'OFICIAL_KIDMAIS' | 'SEM_MODELO_EMPRESA' | 'SEM_TEMPLATE_OFICIAL';
export type BaseDocumentoContrato = { migration072: boolean; modeloEmpresaAtivo: boolean; empresaKidmais: boolean };

export const MENSAGEM_SEM_MODELO_EMPRESA = 'Esta empresa ainda não tem modelo de contrato. Cadastre em Configurações › Importar documentos › Modelo de contrato.';
export const MENSAGEM_SEM_TEMPLATE_OFICIAL = 'Pacote sem template oficial disponível.';

export function fonteDoDocumentoContrato(e: BaseDocumentoContrato & { pacoteCodigo: string }): FonteDocumentoContrato {
  if (e.modeloEmpresaAtivo) return 'EMPRESA';
  if (e.migration072 && !e.empresaKidmais) return 'SEM_MODELO_EMPRESA';
  return configuracaoModeloOficial(e.pacoteCodigo) ? 'OFICIAL_KIDMAIS' : 'SEM_TEMPLATE_OFICIAL';
}
