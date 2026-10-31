import type { ExtracaoContrato } from "./modelo.ts";
import { conflitosDeIdentidade, dadosNormalizados, identidadeInformada, pendenciasDeValidacao, reavaliar, type DadosNormalizados, type EnderecoLido, type IdentidadeInformada } from "./rascunho.ts";
import { parcelasConferem, somaConfere, type TipoPessoa } from "./validadores.ts";

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
  | { tipo: "CLIENTE"; acao: "CRIAR"; dados: DadosClienteNovo }
  | { tipo: "CONTRATO_HISTORICO"; acao: "REGISTRAR_SNAPSHOT" }
  | { tipo: "FESTA"; acao: "PENDENTE_CORE"; motivo: string }
  | { tipo: "PAGAMENTOS_PREVISTOS"; acao: "REGISTRAR_NO_SNAPSHOT"; quantidade: number };

/** Cliente novo da importação: identificação, contatos e, quando lido e completo, RG e endereço (R2-8). */
export type DadosClienteNovo = {
  nomeCompleto: string; cpf: string | null; telefone: string | null; whatsapp: string | null; email: string | null;
  rg?: string | null; cep?: string | null; logradouro?: string | null; numero?: string | null; complemento?: string | null; bairro?: string | null; cidade?: string | null; uf?: string | null;
};

/**
 * Recusa de pessoa jurídica (plano rev. 2.1, R21-1/R21-4): contrato único PJ_INDISPONIVEL (409). Na Entrega A o
 * código ainda não grava cliente com CNPJ; o motivo distingue a Entrega B sem a migration 112.
 */
export type RecusaPlano = { codigo: "PJ_INDISPONIVEL"; motivo: "ENTREGA_A" | "MIGRACAO_PENDENTE"; mensagem: string };
export const MENSAGEM_PJ_INDISPONIVEL = "O contratante é pessoa jurídica (CNPJ). A importação de cliente pessoa jurídica ainda não está disponível. Nada foi gravado; a leitura e as correções continuam salvas.";

/** Partes do endereço exigidas quando qualquer parte é informada (mesma regra do cadastro contratual). */
const ENDERECO_EXIGIDO = [["logradouro", "logradouro"], ["numero", "número"], ["bairro", "bairro"], ["cidade", "cidade"], ["uf", "UF"]] as const;

/**
 * Endereço na importação (D-IMP-3/7, R2-8): ausente segue com alerta; lido em parte (ou só como texto) pede completar
 * ou "Deixar sem endereço" — nada é descartado em silêncio. Completo vai para o cadastro do cliente novo.
 */
function avaliarEndereco(e: EnderecoLido): { completo: boolean; bloqueio: string | null; aviso: string | null } {
  const informado = [e.texto, e.cep, e.logradouro, e.numero, e.complemento, e.bairro, e.cidade, e.uf].some(Boolean);
  if (!informado) return { completo: false, bloqueio: null, aviso: "Endereço do contratante não localizado. Você pode seguir: o cliente ficará com o cadastro incompleto." };
  const faltando = ENDERECO_EXIGIDO.filter(([k]) => !e[k]).map(([, rotulo]) => rotulo);
  if (faltando.length) return { completo: false, bloqueio: `Endereço incompleto: falta ${faltando.join(", ")}. Complete as partes ou use "Deixar sem endereço".`, aviso: null };
  return { completo: true, bloqueio: null, aviso: null };
}

/**
 * Tipo de pessoa do contratante (R21-1), pelo que está na revisão (lido ou escolhido), não só pelo já aceito.
 * Revisão v1 (sem `versaoLeitura`) nunca leu CNPJ: continua PF só enquanto ninguém escolheu o tipo nem informou CNPJ
 * (revisão do Astra, P1-1); escolha ou CNPJ informados na retomada valem como na v2. A partir da v2 nunca há default
 * PF: PF só pelo CPF validado e comprovado ou pela escolha do usuário.
 */
export function tipoPessoaDoPlano(extracao: ExtracaoContrato, identidade: IdentidadeInformada): TipoPessoa | null {
  if (!extracao.versaoLeitura) return identidade.tipoPessoa ?? (identidade.cnpj ? null : "PF");
  return identidade.tipoPessoa;
}

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
  /** Tipo de pessoa resolvido no servidor, sobre a revisão gravada, antes de reduzir ao cadastro PF. */
  tipoPessoa: TipoPessoa | null;
  recusa: RecusaPlano | null;
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
  // Tipo de pessoa ANTES de qualquer passo de cliente: PJ ou indefinido nunca vira cadastro PF.
  const identidade = identidadeInformada(campos);
  const tipoPessoa = tipoPessoaDoPlano(extracao, identidade);
  const recusa: RecusaPlano | null = tipoPessoa === "PJ" ? { codigo: "PJ_INDISPONIVEL", motivo: "ENTREGA_A", mensagem: MENSAGEM_PJ_INDISPONIVEL } : null;
  if (recusa) bloqueios.unshift(recusa.mensagem);
  else if (!tipoPessoa) bloqueios.unshift("Confirme se o contratante é pessoa física ou jurídica.");
  // Conferência própria do plano (P1-2): tipo × documento não depende de estado, confirmação ou divergência aceita.
  for (const x of conflitosDeIdentidade({ ...identidade, tipoPessoa })) bloqueios.push(`Identidade do contratante: ${x.motivo}`);
  const endereco = avaliarEndereco(dados.contratante.endereco);
  if (endereco.bloqueio) bloqueios.push(endereco.bloqueio);
  if (endereco.aviso) avisos.push(endereco.aviso);
  const e = dados.contratante.endereco;
  const novo: DadosClienteNovo = {
    nomeCompleto: dados.contratante.nome!, cpf: dados.contratante.cpf, telefone: dados.contratante.telefone, whatsapp: dados.contratante.whatsapp, email: dados.contratante.email,
    ...(dados.contratante.rg ? { rg: dados.contratante.rg } : {}),
    ...(endereco.completo ? { cep: e.cep, logradouro: e.logradouro, numero: e.numero, complemento: e.complemento, bairro: e.bairro, cidade: e.cidade, uf: e.uf } : {}),
  };

  const passos: PassoPlano[] = [];
  if (match.estado === "CLIENTE_EXISTENTE" && match.clienteId) {
    passos.push({ tipo: "CLIENTE", acao: "VINCULAR", clienteId: match.clienteId, motivo: match.motivo });
  } else if (match.estado === "POSSIVEL_MATCH") {
    if (decisao?.tipo === "VINCULAR" && match.candidatos.some((c) => c.clienteId === decisao.clienteId)) {
      passos.push({ tipo: "CLIENTE", acao: "VINCULAR", clienteId: decisao.clienteId, motivo: "Escolhido pelo operador." });
    } else if (decisao?.tipo === "CRIAR" && (dados.contratante.telefone || dados.contratante.whatsapp)) {
      passos.push({ tipo: "CLIENTE", acao: "CRIAR", dados: novo });
    } else {
      bloqueios.push(decisao?.tipo === "CRIAR" ? "Para criar o cliente, informe telefone ou WhatsApp." : match.motivo);
    }
  } else if (match.estado === "NOVO_CLIENTE") {
    passos.push({ tipo: "CLIENTE", acao: "CRIAR", dados: novo });
  } else {
    bloqueios.push(match.motivo);
  }
  passos.push({ tipo: "CONTRATO_HISTORICO", acao: "REGISTRAR_SNAPSHOT" });
  passos.push({ tipo: "FESTA", acao: "PENDENTE_CORE", motivo: "Festa, agenda e pagamentos são confirmados na integração ao sistema, depois deste registro." });
  const previstos = (dados.pagamentos.entrada ? 1 : 0) + dados.pagamentos.parcelas.length;
  passos.push({ tipo: "PAGAMENTOS_PREVISTOS", acao: "REGISTRAR_NO_SNAPSHOT", quantidade: previstos });

  const { preco, adicionais, total } = dados.valores;
  if (preco != null && total != null && !somaConfere(preco, adicionais ?? 0, total)) avisos.push("Pacote + adicionais não somam o total. Será guardado como está no contrato.");
  if (total != null && previstos > 0) {
    const conferencia = parcelasConferem(dados.pagamentos.entrada, dados.pagamentos.parcelas, total, dados.evento.data);
    if (!conferencia.ok) avisos.push(`${conferencia.motivo} Será guardado como está no contrato.`);
  }
  avisos.push("Nenhum pagamento é marcado como recebido aqui. Recebimentos e parcelas a receber são confirmados na integração, com data e forma.");

  return {
    pronto: bloqueios.length === 0,
    tipoPessoa,
    recusa,
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
