import type { ClienteRecord, CreateClienteInput } from "../repositories";
import {
  normalizarCep,
  normalizarCpf,
  normalizarEmail,
  normalizarTelefone,
  normalizarUf,
} from "../repositories/normalizers.ts";
import { cnpjRaizPlaceholder, cnpjValido, normalizarCnpj } from "../../cadastro/cnpj.ts";
import { ClienteServiceError } from "./errors.ts";

export function cpfValidoServico(valor: string | null | undefined) {
  const cpf = normalizarCpf(valor);
  if (!cpf) return true;
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;

  const calcular = (base: string, pesoInicial: number) => {
    let soma = 0;
    for (let i = 0; i < base.length; i += 1) {
      soma += Number(base[i]) * (pesoInicial - i);
    }
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };

  const d1 = calcular(cpf.slice(0, 9), 10);
  const d2 = calcular(cpf.slice(0, 10), 11);
  return d1 === Number(cpf[9]) && d2 === Number(cpf[10]);
}

/**
 * Regra de PF/PJ do cadastro (D-IMP-1/2, R2-5, R21-3). PF: CPF opcional, nenhum campo de PJ. PJ: CNPJ válido
 * (numérico ou alfanumérico, sem raiz repetida), razão social em `nomeCompleto`, CPF ausente; representante opcional
 * e, com CPF, nome obrigatório. O CPF do representante nunca é o documento do contratante.
 */
export function validarTipoPessoaCliente(input: Pick<CreateClienteInput, "tipoPessoa" | "nomeCompleto" | "cpf" | "cnpj" | "nomeFantasia" | "representanteNome" | "representanteCpf">) {
  const tipo = input.tipoPessoa ?? "PF";
  if (tipo !== "PF" && tipo !== "PJ") {
    throw new ClienteServiceError("DADOS_INVALIDOS", "Escolha pessoa física ou jurídica.", 400, { campo: "tipoPessoa" });
  }
  const texto = (v: string | null | undefined) => (v ?? "").trim();
  if (tipo === "PF") {
    for (const [campo, valor] of [["cnpj", input.cnpj], ["nomeFantasia", input.nomeFantasia], ["representanteNome", input.representanteNome], ["representanteCpf", input.representanteCpf]] as const) {
      if (texto(valor)) throw new ClienteServiceError("DADOS_INVALIDOS", "Pessoa física não tem CNPJ, nome fantasia nem representante.", 400, { campo });
    }
    return;
  }
  if (texto(input.cpf)) {
    throw new ClienteServiceError("DADOS_INVALIDOS", "Pessoa jurídica é identificada pelo CNPJ; o CPF fica no representante.", 400, { campo: "cpf" });
  }
  const cnpj = normalizarCnpj(input.cnpj);
  if (!cnpj) throw new ClienteServiceError("DADOS_INVALIDOS", "Informe o CNPJ.", 400, { campo: "cnpj" });
  if (!cnpjValido(cnpj) || cnpjRaizPlaceholder(cnpj)) {
    throw new ClienteServiceError("DADOS_INVALIDOS", "Informe um CNPJ válido.", 400, { campo: "cnpj" });
  }
  if (input.nomeCompleto.trim().length < 3) {
    throw new ClienteServiceError("DADOS_INVALIDOS", "Informe a razão social.", 400, { campo: "nomeCompleto" });
  }
  const repCpf = normalizarCpf(input.representanteCpf);
  if (repCpf && !cpfValidoServico(repCpf)) {
    throw new ClienteServiceError("DADOS_INVALIDOS", "Informe um CPF válido para o representante.", 400, { campo: "representanteCpf" });
  }
  if (repCpf && !texto(input.representanteNome)) {
    throw new ClienteServiceError("DADOS_INVALIDOS", "Informe o nome do representante.", 400, { campo: "representanteNome" });
  }
}

export function validarCadastroBasicoCliente(input: CreateClienteInput) {
  if (input.nomeCompleto.trim().length < 3) {
    throw new ClienteServiceError("DADOS_INVALIDOS", input.tipoPessoa === "PJ" ? "Informe a razão social." : "Informe o nome completo do Cliente.", 400, {
      campo: "nomeCompleto",
    });
  }
  validarTipoPessoaCliente(input);

  const telefone = normalizarTelefone(input.telefone);
  const whatsapp = normalizarTelefone(input.whatsapp);
  if (!telefone && !whatsapp) {
    throw new ClienteServiceError(
      "DADOS_INVALIDOS",
      "Informe pelo menos WhatsApp ou telefone.",
      400,
      { campo: "contato" },
    );
  }

  const cpf = normalizarCpf(input.cpf);
  if (cpf && !cpfValidoServico(cpf)) {
    throw new ClienteServiceError("DADOS_INVALIDOS", "Informe um CPF válido.", 400, {
      campo: "cpf",
    });
  }

  for (const [campo, valor] of [["telefone", telefone], ["whatsapp", whatsapp]] as const) {
    if (valor && (valor.length < 10 || valor.length > 15)) {
      throw new ClienteServiceError("DADOS_INVALIDOS", `Informe um ${campo} válido.`, 400, { campo });
    }
  }

  const cep = normalizarCep(input.cep);
  if (cep && cep.length !== 8) {
    throw new ClienteServiceError("DADOS_INVALIDOS", "Informe um CEP válido.", 400, { campo: "cep" });
  }

  const uf = normalizarUf(input.uf);
  if (uf && uf.length !== 2) {
    throw new ClienteServiceError("DADOS_INVALIDOS", "Informe uma UF válida.", 400, { campo: "uf" });
  }

  const email = normalizarEmail(input.email);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ClienteServiceError("DADOS_INVALIDOS", "Informe um e-mail válido.", 400, { campo: "email" });
  }
}

export type CampoFaltanteCadastro = {
  campo: string;
  label: string;
};

/**
 * Espelha a regra funcional da V8.8 para cadastro contratual completo.
 * Cadastro básico pode existir sem estes campos; a exigência vale antes do contrato.
 */
export function camposFaltantesParaContrato(cliente: ClienteRecord): CampoFaltanteCadastro[] {
  const faltantes: CampoFaltanteCadastro[] = [];

  // PJ: razão social e CNPJ no lugar de nome e CPF (o representante é opcional).
  const pj = cliente.tipoPessoa === "PJ";
  const checks: Array<[string, string, unknown]> = [
    pj ? ["nomeCompleto", "Razão social", cliente.nomeCompleto] : ["nomeCompleto", "Nome completo", cliente.nomeCompleto],
    pj ? ["cnpj", "CNPJ", cliente.cnpj] : ["cpf", "CPF", cliente.cpf],
    ["email", "E-mail", cliente.email],
    ["cep", "CEP", cliente.cep],
    ["logradouro", "Logradouro", cliente.logradouro],
    ["numero", "Número", cliente.numero],
    ["bairro", "Bairro", cliente.bairro],
    ["cidade", "Cidade", cliente.cidade],
    ["uf", "UF", cliente.uf],
  ];

  for (const [campo, label, value] of checks) {
    if (typeof value !== "string" || value.trim() === "") faltantes.push({ campo, label });
  }

  const temContato = Boolean(cliente.whatsapp?.trim() || cliente.telefone?.trim());
  if (!temContato) {
    // Regra oficial: basta um dos meios; nunca exigir o segundo contato.
    faltantes.splice(2, 0, { campo: "contato", label: "WhatsApp ou telefone" });
  }

  return faltantes;
}
