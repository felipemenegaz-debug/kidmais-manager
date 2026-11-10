import { z } from 'zod';
import { cpfValidoServico } from './services/validators.ts';

export const CAMPOS_CADASTRO = {
  nomeCompleto: 'Nome completo', cpf: 'CPF', rg: 'RG', telefone: 'Telefone', whatsapp: 'WhatsApp', email: 'E-mail',
  cep: 'CEP', logradouro: 'Logradouro', numero: 'Número', complemento: 'Complemento', bairro: 'Bairro', cidade: 'Cidade', uf: 'UF',
} as const;
export type CadastroContratual = Record<keyof typeof CAMPOS_CADASTRO, string>;
/**
 * Identificação e contato exibidos na conferência. O telefone fixo NÃO é exibido (confundia com o WhatsApp) nem vai
 * no payload da conferência: o valor já gravado no CRM é preservado e ainda conta como contato.
 */
export const CAMPOS_IDENTIFICACAO = ['nomeCompleto', 'cpf', 'rg', 'whatsapp', 'email'] as const satisfies ReadonlyArray<keyof CadastroContratual>;
export const CAMPOS_ENDERECO = ['cep', 'logradouro', 'numero', 'complemento', 'bairro', 'cidade', 'uf'] as const satisfies ReadonlyArray<keyof CadastroContratual>;
/** Obrigatórios na conferência histórica: nome, CPF e um contato (WhatsApp, ou telefone já cadastrado). */
export const CAMPOS_OBRIGATORIOS = ['nomeCompleto', 'cpf', 'whatsapp'] as const satisfies ReadonlyArray<keyof CadastroContratual>;
/** Com endereço informado, estes passam a ser exigidos (CEP e complemento continuam opcionais). */
export const CAMPOS_ENDERECO_EXIGIDOS = ['logradouro', 'numero', 'bairro', 'cidade', 'uf'] as const satisfies ReadonlyArray<keyof CadastroContratual>;
export function formularioCadastro(fonte: Partial<Record<keyof CadastroContratual, string | null>> = {}): CadastroContratual {
  return Object.fromEntries(Object.keys(CAMPOS_CADASTRO).map(k => [k, fonte[k as keyof CadastroContratual] ?? ''])) as CadastroContratual;
}
const texto = z.string().trim().max(200);
const digitos = (t: string) => t.replace(/\D/g, '');
const telefone = texto.transform(digitos).refine(t => !t || (t.length >= 10 && t.length <= 15), 'Telefone inválido.');
type Endereco = Pick<CadastroContratual, (typeof CAMPOS_ENDERECO)[number]>;
export const enderecoInformado = (c: Endereco) => CAMPOS_ENDERECO.some(k => !!c[k]);
const enderecoCompleto = (c: Endereco) => CAMPOS_ENDERECO_EXIGIDOS.every(k => !!c[k]);
/**
 * Cadastro contratual da conferência histórica (importação). Obrigatórios: nome, CPF válido e um contato (WhatsApp ou
 * telefone já cadastrado). E-mail e endereço são OPCIONAIS; o endereço, quando informado, precisa estar completo
 * (logradouro, número, bairro, cidade e UF; CEP opcional) — nada parcial vai para o contrato. `telefone` é opcional no
 * payload: a tela não o envia, e o servidor valida o cadastro já mesclado com o CRM. O fechamento nativo continua
 * exigindo o cadastro completo (camposFaltantesParaContrato), fora deste schema.
 */
const objetoCadastro = z.object({
  nomeCompleto: texto.min(3, 'Informe o nome completo.'), cpf: texto.transform(digitos).refine(t => t.length === 11 && cpfValidoServico(t), 'Informe um CPF válido.'),
  rg: texto, telefone: telefone.optional(), whatsapp: telefone,
  email: texto.toLowerCase().refine(t => !t || z.email().safeParse(t).success, 'E-mail inválido.'),
  cep: texto.transform(digitos).refine(t => !t || t.length === 8, 'Informe um CEP válido.'),
  logradouro: texto, numero: texto, complemento: texto, bairro: texto, cidade: texto,
  uf: texto.toUpperCase().refine(t => !t || /^[A-Z]{2}$/.test(t), 'Informe a UF com 2 letras.'),
}).strict();
const mensagemEndereco = { message: 'Complete o endereço (logradouro, número, bairro, cidade e UF) ou deixe-o em branco.', path: ['logradouro'] };
export const cadastroPayloadSchema = objetoCadastro
  .refine(c => !enderecoInformado(c) || enderecoCompleto(c), mensagemEndereco);
/**
 * Entrega B (112): cadastro da conferência para cliente PJ. O nome é a razão social; CPF e RG ficam vazios (PJ não tem
 * CPF próprio; o do representante fica no cadastro do cliente). CNPJ e representante não são editados na conferência
 * (R2-5): vêm do cadastro do cliente.
 */
export const cadastroPayloadPjSchema = objetoCadastro.extend({
  nomeCompleto: texto.min(3, 'Informe a razão social.'),
  cpf: texto.refine(t => t === '', 'Pessoa jurídica não tem CPF próprio: deixe em branco.'),
  rg: texto.refine(t => t === '', 'Pessoa jurídica não tem RG: deixe em branco.'),
}).strict()
  .refine(c => !enderecoInformado(c) || enderecoCompleto(c), mensagemEndereco);
/**
 * Regra de contato aplicada ao cadastro COMPLETO (tela: formulário com o telefone do CRM; servidor: CRM mesclado com o
 * payload). Não vale para o payload isolado, que não traz o telefone.
 */
export const cadastroContratualSchema = cadastroPayloadSchema
  .refine(c => !!(c.telefone || c.whatsapp), { message: 'Informe o WhatsApp.', path: ['whatsapp'] });
export const cadastroContratualPjSchema = cadastroPayloadPjSchema
  .refine(c => !!(c.telefone || c.whatsapp), { message: 'Informe o WhatsApp.', path: ['whatsapp'] });
/** Schema da conferência pelo tipo de pessoa do cliente (o tipo vem do cadastro, nunca do payload). */
export const cadastroContratualDoTipo = (tipoPessoa: string | null | undefined) => tipoPessoa === 'PJ' ? cadastroContratualPjSchema : cadastroContratualSchema;
/** Cadastro como chega da conferência: igual a CadastroContratual, com `telefone` opcional (a tela não o envia). */
export type CadastroConferido = z.infer<typeof cadastroPayloadSchema>;

export type EnderecoContratante = { cep: string | null; logradouro: string; numero: string; complemento: string | null; bairro: string; cidade: string; uf: string };
/** Endereço do snapshot: null quando nada foi informado (contrato histórico sem endereço), nunca um objeto vazio. */
export function enderecoDoCadastro(c: Endereco): EnderecoContratante | null {
  if (!enderecoInformado(c)) return null;
  return { cep: c.cep || null, logradouro: c.logradouro, numero: c.numero, complemento: c.complemento || null, bairro: c.bairro, cidade: c.cidade, uf: c.uf };
}

/** Dados da PJ no cliente (112). Ausentes no cliente PF e em todo cliente antes da 112. */
export type DadosPjCliente = {
  tipoPessoa?: string | null; cnpj?: string | null; razaoSocial?: string | null; nomeFantasia?: string | null;
  representanteNome?: string | null; representanteCpf?: string | null;
};

/**
 * Campos de PJ do snapshot do contratante (Entrega B, R2-2). PF devolve {}: nenhuma chave nova, e o snapshot PF (e o
 * hash dele) fica byte a byte igual ao de antes da 112.
 */
export function contratantePjSnapshot(c: DadosPjCliente) {
  if (c.tipoPessoa !== 'PJ') return {};
  return {
    tipoPessoa: 'PJ' as const, cnpj: c.cnpj ?? '', razaoSocial: c.razaoSocial ?? null, nomeFantasia: c.nomeFantasia || null,
    representante: c.representanteNome ? { nome: c.representanteNome, cpf: c.representanteCpf || null } : null,
  };
}

export function contratanteSnapshot(c: CadastroContratual & { id: string }) {
  return { clienteId: c.id, nomeCompleto: c.nomeCompleto, cpf: c.cpf, rg: c.rg || null, telefone: c.telefone || null,
    whatsapp: c.whatsapp || null, email: c.email || null, endereco: enderecoDoCadastro(c) };
}
