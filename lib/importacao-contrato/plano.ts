import type { ExtracaoContrato } from "./modelo.ts";
import { dadosNormalizados, pendenciasDeValidacao, reavaliar, type DadosNormalizados } from "./rascunho.ts";
import { parcelasConferem, somaConfere } from "./validadores.ts";

/**
 * Match de cliente (Fase 16) e Import Plan (Fase 18). Funções puras.
 *
 * O match usa a análise de duplicidade do próprio CRM (`analisarCadastroCliente`), que já filtra a
 * empresa comprovada em cada consulta: nunca há candidato de outro tenant. Nada é mesclado automaticamente.
 */
export type EstadoMatch = "CLIENTE_EXISTENTE" | "POSSIVEL_MATCH" | "NOVO_CLIENTE" | "PRECISA_REVISAO";

/** Formato de `AnaliseCadastroCliente` usado aqui. */
export type AnaliseDuplicidade = {
  cpfExistente: { clienteId: string; nomeCompleto: string; status?: string } | null;
  possiveisDuplicidades: Array<{ clienteId: string; nomeCompleto: string; motivos: string[]; status?: string }>;
};

export type ResultadoMatch = {
  estado: EstadoMatch;
  clienteId: string | null;
  candidatos: Array<{ clienteId: string; nome: string; motivos: string[] }>;
  motivo: string;
};

export function classificarMatch(dados: DadosNormalizados, analise: AnaliseDuplicidade | null): ResultadoMatch {
  const c = dados.contratante;
  if (!c.nome || c.nome.trim().length < 3) return { estado: "PRECISA_REVISAO", clienteId: null, candidatos: [], motivo: "Informe o nome do contratante." };
  if (!analise) return { estado: "PRECISA_REVISAO", clienteId: null, candidatos: [], motivo: "Não foi possível procurar o cliente agora." };
  if (analise.cpfExistente) {
    if (analise.cpfExistente.status === "INATIVO") {
      return { estado: "PRECISA_REVISAO", clienteId: null, candidatos: [{ clienteId: analise.cpfExistente.clienteId, nome: analise.cpfExistente.nomeCompleto, motivos: ["CPF_IGUAL"] }], motivo: "O CPF pertence a um cliente arquivado. Restaure o cadastro antes de importar." };
    }
    return { estado: "CLIENTE_EXISTENTE", clienteId: analise.cpfExistente.clienteId, candidatos: [{ clienteId: analise.cpfExistente.clienteId, nome: analise.cpfExistente.nomeCompleto, motivos: ["CPF_IGUAL"] }], motivo: "Cliente encontrado pelo CPF." };
  }
  const candidatos = analise.possiveisDuplicidades.map((p) => ({ clienteId: p.clienteId, nome: p.nomeCompleto, motivos: p.motivos }));
  const porContato = candidatos.filter((p) => p.motivos.some((m) => m.endsWith("_IGUAL")));
  if (porContato.length) return { estado: "POSSIVEL_MATCH", clienteId: null, candidatos: porContato, motivo: "Há cliente com o mesmo telefone, WhatsApp ou e-mail. Escolha vincular ou criar novo." };
  if (candidatos.length) return { estado: "POSSIVEL_MATCH", clienteId: null, candidatos, motivo: "Há cliente com nome parecido. Confira antes de criar." };
  if (!c.telefone && !c.whatsapp) return { estado: "PRECISA_REVISAO", clienteId: null, candidatos: [], motivo: "Para criar o cliente, informe telefone ou WhatsApp." };
  return { estado: "NOVO_CLIENTE", clienteId: null, candidatos: [], motivo: "Nenhum cliente parecido nesta empresa." };
}

/** Decisão do operador para POSSIVEL_MATCH: vincular a um candidato listado ou criar novo. */
export type DecisaoCliente = { tipo: "VINCULAR"; clienteId: string } | { tipo: "CRIAR" } | null;

export type PassoPlano =
  | { tipo: "CLIENTE"; acao: "VINCULAR"; clienteId: string; motivo: string }
  | { tipo: "CLIENTE"; acao: "CRIAR"; dados: { nomeCompleto: string; cpf: string | null; telefone: string | null; whatsapp: string | null; email: string | null } }
  | { tipo: "CONTRATO_HISTORICO"; acao: "REGISTRAR_SNAPSHOT" }
  | { tipo: "FESTA"; acao: "PENDENTE_CORE"; motivo: string }
  | { tipo: "PAGAMENTOS_PREVISTOS"; acao: "REGISTRAR_NO_SNAPSHOT"; quantidade: number };

/** Retrato do contrato histórico como está no documento. Nada vem do catálogo ou da tabela de preços atual. */
export type SnapshotHistorico = {
  evento: DadosNormalizados["evento"];
  pacote: DadosNormalizados["pacote"];
  buffet: DadosNormalizados["buffet"];
  valores: DadosNormalizados["valores"];
  pagamentosPrevistos: DadosNormalizados["pagamentos"] & { natureza: "PREVISTO" };
  observacoes: string | null;
};

export type PlanoImportacao = {
  pronto: boolean;
  bloqueios: string[];
  avisos: string[];
  match: ResultadoMatch;
  passos: PassoPlano[];
  snapshot: SnapshotHistorico;
};

/**
 * Plano só fica pronto sem perda silenciosa (H4): o estado é revalidado aqui (nunca confiado do
 * rascunho gravado), campo com validação recusada bloqueia sempre (inclusive parcela inválida, que
 * continua visível como pendência) e conflito só passa com confirmação humana ainda válida.
 */
export function montarPlano(extracao: ExtracaoContrato, _revisados: readonly string[], match: ResultadoMatch, decisao: DecisaoCliente): PlanoImportacao {
  const { campos, revisados } = reavaliar(extracao.secoes.flatMap((s) => s.campos));
  const dados = dadosNormalizados(campos);
  const bloqueios: string[] = [];
  const avisos: string[] = [];
  const recusados = pendenciasDeValidacao(campos);
  for (const c of recusados) bloqueios.push(`${c.rotulo}: o valor lido não pode ser usado como está. Corrija ou remova.`);
  const pendentes = campos.filter((c) => c.estado === "PRECISA_REVISAO" && !recusados.includes(c) && !revisados.includes(c.id));
  if (pendentes.length) bloqueios.push(`Revise ${pendentes.length} ${pendentes.length === 1 ? "campo marcado" : "campos marcados"} como "Precisa revisão".`);
  if (!dados.evento.data) bloqueios.push("Informe a data da festa.");

  const passos: PassoPlano[] = [];
  if (match.estado === "CLIENTE_EXISTENTE" && match.clienteId) {
    passos.push({ tipo: "CLIENTE", acao: "VINCULAR", clienteId: match.clienteId, motivo: match.motivo });
  } else if (match.estado === "POSSIVEL_MATCH") {
    if (decisao?.tipo === "VINCULAR" && match.candidatos.some((c) => c.clienteId === decisao.clienteId)) {
      passos.push({ tipo: "CLIENTE", acao: "VINCULAR", clienteId: decisao.clienteId, motivo: "Escolhido pelo operador." });
    } else if (decisao?.tipo === "CRIAR" && (dados.contratante.telefone || dados.contratante.whatsapp)) {
      passos.push({ tipo: "CLIENTE", acao: "CRIAR", dados: { nomeCompleto: dados.contratante.nome!, cpf: dados.contratante.cpf, telefone: dados.contratante.telefone, whatsapp: dados.contratante.whatsapp, email: dados.contratante.email } });
    } else {
      bloqueios.push(decisao?.tipo === "CRIAR" ? "Para criar o cliente, informe telefone ou WhatsApp." : match.motivo);
    }
  } else if (match.estado === "NOVO_CLIENTE") {
    passos.push({ tipo: "CLIENTE", acao: "CRIAR", dados: { nomeCompleto: dados.contratante.nome!, cpf: dados.contratante.cpf, telefone: dados.contratante.telefone, whatsapp: dados.contratante.whatsapp, email: dados.contratante.email } });
  } else {
    bloqueios.push(match.motivo);
  }
  passos.push({ tipo: "CONTRATO_HISTORICO", acao: "REGISTRAR_SNAPSHOT" });
  passos.push({ tipo: "FESTA", acao: "PENDENTE_CORE", motivo: "A criação de festa a partir de contrato histórico depende de serviço de domínio ainda inexistente (fechamento com Tenant Context público)." });
  const previstos = (dados.pagamentos.entrada ? 1 : 0) + dados.pagamentos.parcelas.length;
  passos.push({ tipo: "PAGAMENTOS_PREVISTOS", acao: "REGISTRAR_NO_SNAPSHOT", quantidade: previstos });

  const { preco, adicionais, total } = dados.valores;
  if (preco != null && total != null && !somaConfere(preco, adicionais ?? 0, total)) avisos.push("Pacote + adicionais não somam o total. Será guardado como está no contrato.");
  if (total != null && previstos > 0) {
    const conferencia = parcelasConferem(dados.pagamentos.entrada, dados.pagamentos.parcelas, total, dados.evento.data);
    if (!conferencia.ok) avisos.push(`${conferencia.motivo} Será guardado como está no contrato.`);
  }
  avisos.push("Os pagamentos ficam registrados como previstos. Nenhum pagamento é marcado como recebido.");

  return {
    pronto: bloqueios.length === 0,
    bloqueios,
    avisos,
    match,
    passos,
    snapshot: {
      evento: dados.evento,
      pacote: dados.pacote,
      buffet: dados.buffet,
      valores: dados.valores,
      pagamentosPrevistos: { ...dados.pagamentos, natureza: "PREVISTO" },
      observacoes: dados.observacoes,
    },
  };
}
