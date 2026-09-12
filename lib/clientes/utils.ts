import type {
  Cliente,
  ClienteDetalhe,
  ClienteListaItem,
  ProximoEventoCliente,
  StatusFechamento,
} from "@/components/clientes/types";

const camposCompletosSemContato: (keyof Cliente)[] = [
  "nomeCompleto",
  "cpf",
  "email",
  "cep",
  "logradouro",
  "numero",
  "bairro",
  "cidade",
  "uf",
];

const labelsCampos: Partial<Record<keyof Cliente, string>> = {
  nomeCompleto: "Nome completo",
  cpf: "CPF",
  email: "E-mail",
  cep: "CEP",
  logradouro: "Logradouro",
  numero: "Número",
  bairro: "Bairro",
  cidade: "Cidade",
  uf: "UF",
};

export function cadastroCompleto(cliente: Cliente) {
  const camposBaseCompletos = camposCompletosSemContato.every((campo) => Boolean(cliente[campo]?.trim?.()));
  const temContato = Boolean(cliente.whatsapp?.trim() || cliente.telefone?.trim());
  return camposBaseCompletos && temContato;
}

export function getCamposFaltantesCliente(cliente: Cliente) {
  const faltantes: Array<{ campo: keyof Cliente | "contato"; label: string }> = camposCompletosSemContato
    .filter((campo) => !cliente[campo]?.trim?.())
    .map((campo) => ({ campo, label: labelsCampos[campo] ?? String(campo) }));

  if (!cliente.whatsapp?.trim() && !cliente.telefone?.trim()) {
    faltantes.splice(2, 0, { campo: "contato", label: "WhatsApp ou telefone" });
  }

  return faltantes;
}

export function getProximoEvento(detalhe: ClienteDetalhe): ProximoEventoCliente | null {
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);

  const eventos: ProximoEventoCliente[] = [
    ...detalhe.fechamentos
      .filter((item) => !["CANCELADO", "RECUSADO", "EXPIRADO", "CONFIRMADO"].includes(item.status))
      .map((item) => ({
        id: item.id,
        tipo: "FECHAMENTO" as const,
        data: item.dataEvento,
        horarioInicio: item.horarioInicio,
        aniversarianteNome: item.aniversarianteNome,
        pacoteNome: item.pacoteNome,
        status: item.status,
      })),
    ...detalhe.festas
      .filter((item) => item.status === "CONFIRMADA")
      .map((item) => ({
        id: item.id,
        tipo: "FESTA" as const,
        data: item.data,
        horarioInicio: item.horarioInicio,
        aniversarianteNome: item.aniversarianteNome,
        pacoteNome: item.pacoteNome,
        status: item.status,
      })),
  ]
    .filter((evento) => new Date(`${evento.data}T00:00:00`) >= hoje)
    .sort((a, b) => `${a.data}T${a.horarioInicio}`.localeCompare(`${b.data}T${b.horarioInicio}`));

  return eventos[0] ?? null;
}

export function toClienteListaItem(detalhe: ClienteDetalhe): ClienteListaItem {
  return {
    id: detalhe.cliente.id,
    nomeCompleto: detalhe.cliente.nomeCompleto,
    whatsapp: detalhe.cliente.whatsapp,
    telefone: detalhe.cliente.telefone,
    aniversariantes: detalhe.aniversariantes.map(({ id, nome }) => ({ id, nome })),
    proximoEvento: getProximoEvento(detalhe),
    cadastroCompleto: cadastroCompleto(detalhe.cliente),
  };
}

export function somenteDigitos(valor: string | null | undefined) {
  return (valor ?? "").replace(/\D/g, "");
}

export function cpfValido(valor: string) {
  const cpf = somenteDigitos(valor);
  if (!cpf) return true;
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) return false;
  const calcular = (base: string, pesoInicial: number) => {
    let soma = 0;
    for (let i = 0; i < base.length; i += 1) soma += Number(base[i]) * (pesoInicial - i);
    const resto = (soma * 10) % 11;
    return resto === 10 ? 0 : resto;
  };
  const d1 = calcular(cpf.slice(0, 9), 10);
  const d2 = calcular(cpf.slice(0, 10), 11);
  return d1 === Number(cpf[9]) && d2 === Number(cpf[10]);
}

export function formatTelefone(valor: string | null) {
  if (!valor) return "—";
  const numeros = somenteDigitos(valor);
  if (numeros.length === 11) {
    return `(${numeros.slice(0, 2)}) ${numeros.slice(2, 7)}-${numeros.slice(7)}`;
  }
  if (numeros.length === 10) {
    return `(${numeros.slice(0, 2)}) ${numeros.slice(2, 6)}-${numeros.slice(6)}`;
  }
  return valor;
}

export function formatCpf(valor: string | null, mascarado = false) {
  if (!valor) return "Não informado";
  const numeros = somenteDigitos(valor).slice(0, 11);
  if (numeros.length !== 11) return valor;
  const formatado = `${numeros.slice(0, 3)}.${numeros.slice(3, 6)}.${numeros.slice(6, 9)}-${numeros.slice(9)}`;
  if (!mascarado) return formatado;
  return `***.${numeros.slice(3, 6)}.${numeros.slice(6, 9)}-**`;
}

export function formatData(valor: string) {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "UTC" }).format(new Date(`${valor}T00:00:00Z`));
}

export function formatDateTime(valor: string | null | undefined) {
  if (!valor) return "—";
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(valor));
}

export function formatMoney(valor: number | null) {
  if (valor == null) return "—";
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(valor);
}

export function calcularIdade(dataNascimento: string, referencia = new Date()) {
  const [ano, mes, dia] = dataNascimento.split("-").map(Number);
  let idade = referencia.getFullYear() - ano;
  const antesDoAniversario = referencia.getMonth() + 1 < mes ||
    (referencia.getMonth() + 1 === mes && referencia.getDate() < dia);
  if (antesDoAniversario) idade -= 1;
  return idade;
}

export function statusFechamentoLabel(status: StatusFechamento) {
  const labels: Record<StatusFechamento, string> = {
    RASCUNHO: "Rascunho",
    AGUARDANDO_APROVACAO: "Aguardando aprovação",
    APROVADO: "Aprovado",
    AGUARDANDO_CONTRATO: "Aguardando contrato",
    CONTRATO_ASSINADO: "Contrato assinado",
    AGUARDANDO_PAGAMENTO: "Aguardando pagamento",
    CONFIRMADO: "Confirmado",
    CANCELADO: "Cancelado",
    RECUSADO: "Recusado",
    EXPIRADO: "Expirado",
  };
  return labels[status];
}

export function fechamentoPrimaryAction(status: StatusFechamento) {
  switch (status) {
    case "RASCUNHO": return "Abrir fechamento";
    case "AGUARDANDO_APROVACAO": return "Revisar negociação";
    case "APROVADO": return "Abrir fechamento";
    case "AGUARDANDO_CONTRATO": return "Abrir contrato";
    case "CONTRATO_ASSINADO":
    case "AGUARDANDO_PAGAMENTO": return "Registrar pagamento";
    case "CONFIRMADO": return "Abrir festa";
    default: return "Ver detalhes";
  }
}
