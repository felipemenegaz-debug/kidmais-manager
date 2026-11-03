import type { ExtracaoContrato } from "./modelo.ts";
import { conflitosDeIdentidade, dadosNormalizados, identidadeInformada, pendenciasDeValidacao, reavaliar, type DadosNormalizados, type EnderecoLido, type IdentidadeInformada } from "./rascunho.ts";
import { parcelasConferem, somaConfere, type TipoPessoa } from "./validadores.ts";
import { normalizarCnpj } from "../cadastro/cnpj.ts";

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
  /** Entrega B (112): chave da PJ. Ausente nas análises sem CNPJ. */
  cnpjExistente?: { clienteId: string; nomeCompleto: string; status?: string } | null;
  possiveisDuplicidades: Array<{ clienteId: string; nomeCompleto: string; motivos: string[]; status?: string; tipoPessoa?: TipoPessoa }>;
};

export type ResultadoMatch = {
  estado: EstadoMatch;
  clienteId: string | null;
  candidatos: Array<{ clienteId: string; nome: string; motivos: string[]; tipoPessoa?: TipoPessoa }>;
  motivo: string;
};

/**
 * Entrega B (112, R2-1/R2-5): a chave é o documento do contratante — CPF na PF, CNPJ na PJ. Na PJ o CPF do representante
 * nunca é procurado (o plano não o passa à análise). `tipoPessoa` ausente = comportamento PF de antes.
 */
export function classificarMatch(dados: DadosNormalizados, analise: AnaliseDuplicidade | null, tipoPessoa: TipoPessoa | null = "PF"): ResultadoMatch {
  const c = dados.contratante;
  if (!c.nome || c.nome.trim().length < 3) return { estado: "PRECISA_REVISAO", clienteId: null, candidatos: [], motivo: "Informe o nome do contratante." };
  if (!analise) return { estado: "PRECISA_REVISAO", clienteId: null, candidatos: [], motivo: "Não foi possível procurar o cliente agora." };
  const pj = tipoPessoa === "PJ";
  const existente = pj ? analise.cnpjExistente ?? null : analise.cpfExistente;
  const doc = pj ? "CNPJ" : "CPF";
  if (existente) {
    const candidato = { clienteId: existente.clienteId, nome: existente.nomeCompleto, motivos: [`${doc}_IGUAL`], ...(pj ? { tipoPessoa: "PJ" as const } : {}) };
    if (existente.status === "INATIVO") {
      return { estado: "PRECISA_REVISAO", clienteId: null, candidatos: [candidato], motivo: `O ${doc} pertence a um cliente arquivado. Restaure o cadastro antes de importar.` };
    }
    return { estado: "CLIENTE_EXISTENTE", clienteId: existente.clienteId, candidatos: [candidato], motivo: `Cliente encontrado pelo ${doc}.` };
  }
  const candidatos = analise.possiveisDuplicidades.map((p) => ({ clienteId: p.clienteId, nome: p.nomeCompleto, motivos: p.motivos, ...(p.tipoPessoa ? { tipoPessoa: p.tipoPessoa } : {}) }));
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

/**
 * Cliente novo da importação: identificação, contatos e, quando lido e completo, RG e endereço (R2-8). PJ (Entrega B,
 * só com a 112): nome = razão social, CPF nulo, CNPJ e representante; PF não leva nenhuma chave de PJ.
 */
export type DadosClienteNovo = {
  nomeCompleto: string; cpf: string | null; telefone: string | null; whatsapp: string | null; email: string | null;
  rg?: string | null; cep?: string | null; logradouro?: string | null; numero?: string | null; complemento?: string | null; bairro?: string | null; cidade?: string | null; uf?: string | null;
  tipoPessoa?: "PJ"; cnpj?: string; representanteNome?: string | null; representanteCpf?: string | null;
};

/**
 * Recusa de pessoa jurídica (plano rev. 2.1, R21-1/R21-4): contrato único PJ_INDISPONIVEL (409). Na Entrega B a PJ é
 * liberada só com a migration 112 aplicada; sem ela, motivo MIGRACAO_PENDENTE. `ENTREGA_A` fica no tipo só por
 * compatibilidade de leitura: este código não o emite mais.
 */
export type RecusaPlano = { codigo: "PJ_INDISPONIVEL"; motivo: "ENTREGA_A" | "MIGRACAO_PENDENTE"; mensagem: string };
export const MENSAGEM_PJ_INDISPONIVEL = "O contratante é pessoa jurídica (CNPJ). A importação de cliente pessoa jurídica ainda não está disponível nesta instalação. Nada foi gravado; a leitura e as correções continuam salvas.";

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

/**
 * O que procurar no CRM antes do plano (Entrega B, R2-1/R2-5). PF: CPF, como sempre. PJ: só o CNPJ, e só com a 112
 * (`pessoaJuridica`); o CPF (do representante ou digitado por engano) nunca é procurado. `busca` null = nome curto.
 */
export function buscaDoCliente(extracao: ExtracaoContrato, pessoaJuridica: boolean) {
  const campos = extracao.secoes.flatMap((s) => s.campos);
  const c = dadosNormalizados(campos).contratante;
  const tipoPessoa = tipoPessoaDoPlano(extracao, identidadeInformada(campos));
  const documento = tipoPessoa === "PJ" ? { cpf: null, cnpj: pessoaJuridica && c.cnpj ? normalizarCnpj(c.cnpj) : null } : { cpf: c.cpf };
  const busca = c.nome && c.nome.trim().length >= 3 ? { nomeCompleto: c.nome, ...documento, telefone: c.telefone, whatsapp: c.whatsapp, email: c.email } : null;
  return { tipoPessoa, busca };
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
  /** Só na PJ liberada: CNPJ do contrato (o vínculo é conferido contra ele na execução). Ausente na PF. */
  cnpj?: string;
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
 * `pessoaJuridica`: a 112 está aplicada (conferida pelo servidor na mesma transação). Ausente = recusa a PJ.
 */
export function montarPlano(extracao: ExtracaoContrato, _revisados: readonly string[], match: ResultadoMatch, decisao: DecisaoCliente, opcoes: { pessoaJuridica?: boolean } = {}): PlanoImportacao {
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
  const recusa: RecusaPlano | null = tipoPessoa === "PJ" && !opcoes.pessoaJuridica ? { codigo: "PJ_INDISPONIVEL", motivo: "MIGRACAO_PENDENTE", mensagem: MENSAGEM_PJ_INDISPONIVEL } : null;
  if (recusa) bloqueios.unshift(recusa.mensagem);
  else if (!tipoPessoa) bloqueios.unshift("Confirme se o contratante é pessoa física ou jurídica.");
  // Conferência própria do plano (P1-2): tipo × documento não depende de estado, confirmação ou divergência aceita.
  for (const x of conflitosDeIdentidade({ ...identidade, tipoPessoa })) bloqueios.push(`Identidade do contratante: ${x.motivo}`);
  const endereco = avaliarEndereco(dados.contratante.endereco);
  if (endereco.bloqueio) bloqueios.push(endereco.bloqueio);
  if (endereco.aviso) avisos.push(endereco.aviso);
  const e = dados.contratante.endereco;
  const pj = tipoPessoa === "PJ" && !recusa;
  const ct = dados.contratante;
  // Documentos como o cadastro grava (sem pontuação): o vínculo é conferido contra o CNPJ gravado.
  const cnpj = pj && ct.cnpj ? normalizarCnpj(ct.cnpj) : null;
  const novo: DadosClienteNovo = {
    nomeCompleto: ct.nome!, cpf: pj ? null : ct.cpf, telefone: ct.telefone, whatsapp: ct.whatsapp, email: ct.email,
    // RG é documento de pessoa física: na PJ não entra no cadastro.
    ...(ct.rg && !pj ? { rg: ct.rg } : {}),
    ...(endereco.completo ? { cep: e.cep, logradouro: e.logradouro, numero: e.numero, complemento: e.complemento, bairro: e.bairro, cidade: e.cidade, uf: e.uf } : {}),
    ...(cnpj ? { tipoPessoa: "PJ" as const, cnpj, representanteNome: ct.representanteNome, representanteCpf: ct.representanteCpf?.replace(/\D/g, "") || null } : {}),
  };

  const passos: PassoPlano[] = [];
  if (match.estado === "CLIENTE_EXISTENTE" && match.clienteId) {
    passos.push({ tipo: "CLIENTE", acao: "VINCULAR", clienteId: match.clienteId, motivo: match.motivo });
  } else if (match.estado === "POSSIVEL_MATCH") {
    const escolhido = decisao?.tipo === "VINCULAR" ? match.candidatos.find((c) => c.clienteId === decisao.clienteId) : undefined;
    if (escolhido && tipoPessoa && (escolhido.tipoPessoa ?? "PF") !== tipoPessoa) {
      // R2-5: a conferência não muda o tipo de um cliente existente; contrato PJ só vincula a PJ (e PF a PF).
      bloqueios.push(tipoPessoa === "PJ"
        ? "O cliente escolhido é pessoa física e o contrato é de pessoa jurídica. Escolha outro cliente ou crie um novo."
        : "O cliente escolhido é pessoa jurídica e o contrato é de pessoa física. Escolha outro cliente ou crie um novo.");
    } else if (escolhido && tipoPessoa === "PJ") {
      // O CNPJ é único na empresa e não foi achado: uma PJ parecida (mesmo contato ou nome) tem outro CNPJ.
      bloqueios.push("O cliente escolhido tem outro CNPJ. Para este contrato, crie um novo cliente.");
    } else if (escolhido) {
      passos.push({ tipo: "CLIENTE", acao: "VINCULAR", clienteId: escolhido.clienteId, motivo: "Escolhido pelo operador." });
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
    ...(cnpj ? { cnpj } : {}),
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
