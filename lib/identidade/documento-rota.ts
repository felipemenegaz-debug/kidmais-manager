import { z } from "zod";

/**
 * Campo do documento nas rotas públicas (R2-1): `documento` (CPF ou CNPJ) e, por compatibilidade, `cpf`, que continua
 * aceito com o mesmo significado. Um dos dois é obrigatório; a classificação e a validação ficam no serviço.
 */
const valor = z.string().trim().min(1).max(32);
export const camposDocumentoPublico = { cpf: valor.optional(), documento: valor.optional() };
export const temDocumento = (v: { cpf?: string; documento?: string }) => Boolean(v.documento ?? v.cpf);
export const MENSAGEM_SEM_DOCUMENTO = { message: "Informe o CPF ou CNPJ.", path: ["documento"] };
export const documentoInformado = (v: { cpf?: string; documento?: string }) => (v.documento ?? v.cpf) as string;
