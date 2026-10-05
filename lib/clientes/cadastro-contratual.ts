import { z } from 'zod';
import { cpfValidoServico } from './services/validators.ts';

export const CAMPOS_CADASTRO = {
  nomeCompleto: 'Nome completo', cpf: 'CPF', rg: 'RG', telefone: 'Telefone', whatsapp: 'WhatsApp', email: 'E-mail',
  cep: 'CEP', logradouro: 'Logradouro', numero: 'Número', complemento: 'Complemento', bairro: 'Bairro', cidade: 'Cidade', uf: 'UF',
} as const;
export type CadastroContratual = Record<keyof typeof CAMPOS_CADASTRO, string>;
export function formularioCadastro(fonte: Partial<Record<keyof CadastroContratual, string | null>> = {}): CadastroContratual {
  return Object.fromEntries(Object.keys(CAMPOS_CADASTRO).map(k => [k, fonte[k as keyof CadastroContratual] ?? ''])) as CadastroContratual;
}
const texto = z.string().trim().max(200);
const digitos = (t: string) => t.replace(/\D/g, '');
const telefone = texto.transform(digitos).refine(t => !t || (t.length >= 10 && t.length <= 15), 'Telefone inválido.');
/** Mesmo cadastro contratual nos dois caminhos: conferência histórica e fechamento. */
export const cadastroContratualSchema = z.object({
  nomeCompleto: texto.min(3), cpf: texto.transform(digitos).refine(t => t.length === 11 && cpfValidoServico(t), 'Informe um CPF válido.'),
  rg: texto, telefone, whatsapp: telefone, email: texto.toLowerCase().pipe(z.email()),
  cep: texto.transform(digitos).refine(t => t.length === 8, 'Informe um CEP válido.'),
  logradouro: texto.min(1), numero: texto.min(1), complemento: texto, bairro: texto.min(1), cidade: texto.min(1), uf: texto.toUpperCase().length(2),
}).strict().refine(c => !!(c.telefone || c.whatsapp), 'Informe WhatsApp ou telefone.');

export function contratanteSnapshot(c: CadastroContratual & { id: string }) {
  return { clienteId: c.id, nomeCompleto: c.nomeCompleto, cpf: c.cpf, rg: c.rg || null, telefone: c.telefone || null,
    whatsapp: c.whatsapp || null, email: c.email, endereco: { cep: c.cep, logradouro: c.logradouro, numero: c.numero,
      complemento: c.complemento || null, bairro: c.bairro, cidade: c.cidade, uf: c.uf } };
}
