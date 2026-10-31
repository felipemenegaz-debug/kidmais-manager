import { createHash } from "node:crypto";
import { lerRecebimentos } from "./recebimentos.ts";
import { localizarEvidencia, normalizarTrecho, SCHEMA_VERSAO, VAZIO, type CampoLido, type ExtracaoLida, type Localizacao } from "./extracao.ts";
import type { ArquivoSelecionado, CampoExtraido, EstadoValidacao, ExtracaoContrato, IdSecao, SecaoRevisao } from "./modelo.ts";
import {
  minutosEntre, parcelasConferem, somaConfere, soDigitos, tipoPessoaDe, validarCep, validarCnpj, validarCpf, validarData, validarDuracao, validarEmail,
  validarHorario, validarInteiro, validarParcela, validarTelefone, validarTipoPessoa, validarUf, validarValor, ROTULO_TIPO_PESSOA,
  type TipoCampo, type TipoPessoa, type Validacao,
} from "./validadores.ts";

/**
 * Rascunho de importação (ImportDraft) a partir da leitura do documento.
 *
 * Cada campo guarda três coisas separadas (H4): o BRUTO (como lido ou digitado, nunca reescrito), o
 * NORMALIZADO (só quando o validador aceitou o texto inteiro) e o estado da VALIDAÇÃO:
 * VALIDO, INVALIDO, AMBIGUO, NAO_REPRESENTAVEL ou PRECISA_REVISAO (valor válido em conflito / sem trecho).
 *
 * Estado exibido, sem porcentagem de confiança:
 * - NAO_ENCONTRADO: não há valor.
 * - PRECISA_REVISAO: validação recusou, evidência não confere ou há conflito entre campos.
 * - ENCONTRADO: valor válido com trecho localizado no documento (ou informado pelo operador).
 *
 * Toda mudança passa por `reavaliar`, que revalida TODOS os campos a partir do bruto e recalcula os
 * conflitos: uma correção manual nunca deixa outro campo com estado velho.
 *
 * O snapshot histórico (pacote, itens, preço, duração, condições) é preservado como está no documento:
 * nada é recalculado com o catálogo ou a tabela de preços atual.
 */
type Definicao = { id: string; rotulo: string; tipo: TipoCampo; ler(e: ExtracaoLida): CampoLido; ausente: string };

const reais = (centavos: number) => `R$ ${Math.floor(centavos / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".")},${String(centavos % 100).padStart(2, "0")}`;
const dataBr = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/** Valida e devolve o valor na forma exibida (e relida depois por `dadosNormalizados`). */
export function validarPorTipo(tipo: TipoCampo, valor: string): Validacao<string> {
  const texto = valor.trim();
  const em = <T>(v: Validacao<T>, formatar: (x: T) => string): Validacao<string> => (v.ok ? { ok: true, valor: formatar(v.valor) } : v);
  switch (tipo) {
    case "texto": return texto.length >= 2 ? { ok: true, valor: texto.slice(0, 500) } : { ok: false, motivo: "Texto muito curto.", estado: "NAO_REPRESENTAVEL" };
    case "textoCurto": return texto.length >= 1 && texto.length <= 60 ? { ok: true, valor: texto } : { ok: false, motivo: "Use até 60 caracteres.", estado: "NAO_REPRESENTAVEL" };
    case "cpf": return validarCpf(texto);
    case "cnpj": return validarCnpj(texto);
    case "cep": return validarCep(texto);
    case "uf": return validarUf(texto);
    case "tipoPessoa": return validarTipoPessoa(texto);
    case "telefone": return validarTelefone(texto);
    case "email": return validarEmail(texto);
    case "data": return em(validarData(texto), dataBr);
    case "horario": return em(validarHorario(texto), (h) => (h.fim ? `${h.inicio} às ${h.fim}` : h.inicio));
    case "duracao": return em(validarDuracao(texto), (m) => (m % 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}` : `${m / 60} ${m === 60 ? "hora" : "horas"}`));
    case "idade": return em(validarInteiro(texto, 0, 120, "Idade"), (n) => `${n} ${n === 1 ? "ano" : "anos"}`);
    case "convidados": return em(validarInteiro(texto, 1, 10000, "Número de convidados"), String);
    case "quantidade": return em(validarInteiro(texto, 1, 10000, "Quantidade"), String);
    case "valor": return em(validarValor(texto), reais);
    case "parcela": return em(validarParcela(texto), (p) => `${reais(p.valor)} em ${dataBr(p.vencimento)}`);
  }
}

const SECOES: ReadonlyArray<{ id: IdSecao; titulo: string; nota?: string; campos: Definicao[] }> = [
  { id: "contratante", titulo: "Contratante", campos: [
    { id: "contratante.tipoPessoa", rotulo: "Tipo de pessoa", tipo: "tipoPessoa", ler: () => VAZIO, ausente: "Sem CPF nem CNPJ do contratante. Informe se é pessoa física ou jurídica." },
    { id: "contratante.nome", rotulo: "Nome ou razão social", tipo: "texto", ler: (e) => e.contratante.nome, ausente: "Nome do contratante não localizado." },
    { id: "contratante.cpf", rotulo: "CPF", tipo: "cpf", ler: (e) => e.contratante.cpf, ausente: "CPF não localizado. Pode ser completado no cadastro." },
    { id: "contratante.cnpj", rotulo: "CNPJ", tipo: "cnpj", ler: (e) => e.contratante.cnpj, ausente: "Sem CNPJ: contratante pessoa física." },
    { id: "contratante.rg", rotulo: "RG", tipo: "texto", ler: (e) => e.contratante.rg, ausente: "RG não localizado." },
    { id: "contratante.representanteNome", rotulo: "Representante", tipo: "texto", ler: (e) => e.contratante.representanteNome, ausente: "Sem representante (só para pessoa jurídica)." },
    { id: "contratante.representanteCpf", rotulo: "CPF do representante", tipo: "cpf", ler: (e) => e.contratante.representanteCpf, ausente: "Sem CPF de representante." },
    { id: "contratante.telefone", rotulo: "Telefone", tipo: "telefone", ler: (e) => e.contratante.telefone, ausente: "Telefone não localizado." },
    { id: "contratante.whatsapp", rotulo: "WhatsApp", tipo: "telefone", ler: (e) => e.contratante.whatsapp, ausente: "WhatsApp não localizado." },
    { id: "contratante.email", rotulo: "E-mail", tipo: "email", ler: (e) => e.contratante.email, ausente: "E-mail não localizado. Pode ser completado depois." },
  ] },
  { id: "endereco", titulo: "Endereço do contratante", nota: "Opcional na importação. Sem endereço, o cliente fica com o cadastro incompleto.", campos: [
    { id: "contratante.endereco", rotulo: "Endereço como no contrato", tipo: "texto", ler: (e) => e.contratante.endereco, ausente: "Endereço não localizado no contrato." },
    { id: "contratante.cep", rotulo: "CEP", tipo: "cep", ler: (e) => e.contratante.cep, ausente: "CEP não localizado." },
    { id: "contratante.logradouro", rotulo: "Logradouro", tipo: "texto", ler: (e) => e.contratante.logradouro, ausente: "Logradouro não localizado." },
    { id: "contratante.numero", rotulo: "Número", tipo: "textoCurto", ler: (e) => e.contratante.numero, ausente: "Número não localizado." },
    { id: "contratante.complemento", rotulo: "Complemento", tipo: "textoCurto", ler: (e) => e.contratante.complemento, ausente: "Sem complemento." },
    { id: "contratante.bairro", rotulo: "Bairro", tipo: "texto", ler: (e) => e.contratante.bairro, ausente: "Bairro não localizado." },
    { id: "contratante.cidade", rotulo: "Cidade", tipo: "texto", ler: (e) => e.contratante.cidade, ausente: "Cidade não localizada." },
    { id: "contratante.uf", rotulo: "UF", tipo: "uf", ler: (e) => e.contratante.uf, ausente: "UF não localizada." },
  ] },
  { id: "evento", titulo: "Evento", campos: [
    { id: "evento.data", rotulo: "Data", tipo: "data", ler: (e) => e.evento.data, ausente: "Data da festa não localizada." },
    { id: "evento.horario", rotulo: "Horário", tipo: "horario", ler: (e) => e.evento.horario, ausente: "Horário não localizado." },
    { id: "evento.duracao", rotulo: "Duração", tipo: "duracao", ler: (e) => e.evento.duracao, ausente: "Duração não localizada." },
    { id: "evento.aniversariante", rotulo: "Aniversariante", tipo: "texto", ler: (e) => e.evento.aniversariante, ausente: "Aniversariante não localizado." },
    { id: "evento.nascimento", rotulo: "Nascimento do aniversariante", tipo: "data", ler: (e) => e.evento.nascimento, ausente: "Data de nascimento não localizada." },
    { id: "evento.idade", rotulo: "Idade", tipo: "idade", ler: (e) => e.evento.idade, ausente: "Idade não localizada." },
    { id: "evento.convidados", rotulo: "Convidados", tipo: "convidados", ler: (e) => e.evento.convidados, ausente: "Número de convidados não localizado." },
    { id: "evento.tema", rotulo: "Tema", tipo: "texto", ler: (e) => e.evento.tema, ausente: "Tema não localizado." },
  ] },
  { id: "pacote", titulo: "Pacote", nota: "Mantido exatamente como no contrato. Não é substituído pelo pacote atual do catálogo.", campos: [
    { id: "pacote.nome", rotulo: "Pacote original", tipo: "texto", ler: (e) => e.pacote.nome, ausente: "Nome do pacote não localizado." },
    { id: "pacote.duracao", rotulo: "Duração do pacote", tipo: "duracao", ler: (e) => e.pacote.duracao, ausente: "Duração do pacote não localizada." },
    { id: "pacote.quantidade", rotulo: "Convidados do pacote", tipo: "quantidade", ler: (e) => e.pacote.quantidade, ausente: "Quantidade do pacote não localizada." },
    { id: "pacote.itens", rotulo: "Itens originais", tipo: "texto", ler: (e) => e.pacote.itens, ausente: "Itens do pacote não localizados." },
  ] },
  { id: "buffet", titulo: "Buffet", campos: [
    { id: "buffet.itens", rotulo: "Cardápio", tipo: "texto", ler: (e) => e.buffet.itens, ausente: "Cardápio não localizado." },
    { id: "buffet.observacoes", rotulo: "Observações do buffet", tipo: "texto", ler: (e) => e.buffet.observacoes, ausente: "Sem observações de buffet." },
    { id: "buffet.restricoes", rotulo: "Restrições alimentares", tipo: "texto", ler: (e) => e.buffet.restricoes, ausente: "Nenhuma restrição localizada." },
  ] },
  { id: "valores", titulo: "Valores", nota: "Valores do contrato original. Não são recalculados com a tabela de preços atual.", campos: [
    { id: "valores.preco", rotulo: "Valor do pacote", tipo: "valor", ler: (e) => e.valores.preco, ausente: "Valor do pacote não localizado." },
    { id: "valores.adicionais", rotulo: "Adicionais", tipo: "valor", ler: (e) => e.valores.adicionais, ausente: "Adicionais não localizados." },
    { id: "valores.total", rotulo: "Valor contratado", tipo: "valor", ler: (e) => e.valores.total, ausente: "Valor total não localizado." },
  ] },
  { id: "pagamentos", titulo: "Pagamentos previstos", nota: "Pagamento previsto não é pagamento recebido. Recebimentos continuam sendo registrados no Financeiro.", campos: [
    { id: "pagamentos.condicao", rotulo: "Condição de pagamento", tipo: "texto", ler: (e) => e.pagamentoPrevisto.condicao, ausente: "Condição de pagamento não localizada." },
    { id: "pagamentos.entrada", rotulo: "Entrada prevista", tipo: "valor", ler: (e) => e.pagamentoPrevisto.entrada, ausente: "Entrada não localizada." },
    { id: "pagamentos.entradaVencimento", rotulo: "Vencimento da entrada", tipo: "data", ler: (e) => e.pagamentoPrevisto.entradaVencimento, ausente: "Vencimento da entrada não localizado." },
  ] },
  { id: "observacoes", titulo: "Observações", campos: [
    { id: "observacoes.gerais", rotulo: "Observações do contrato", tipo: "texto", ler: (e) => e.observacoes, ausente: "Sem observações." },
  ] },
];

const TIPO_POR_CAMPO: ReadonlyMap<string, TipoCampo> = new Map(SECOES.flatMap((s) => s.campos.map((c) => [c.id, c.tipo] as const)));
const PARCELA = /^pagamentos\.parcela_\d+$/;
const FALHAS: ReadonlySet<EstadoValidacao> = new Set(["INVALIDO", "AMBIGUO", "NAO_REPRESENTAVEL"]);
const INFORMADO = "Informado pelo operador";

export function tipoDoCampo(id: string): TipoCampo | null {
  if (PARCELA.test(id)) return "parcela";
  return TIPO_POR_CAMPO.get(id) ?? null;
}

/** Campo lido do documento: bruto, validação e evidência tipada. O estado final vem de `reavaliar`. */
function campoLido(d: { id: string; rotulo: string; tipo: TipoCampo; ausente: string }, lido: CampoLido, paginas: readonly string[], local?: Localizacao | null): CampoExtraido {
  if (!lido.valor) return { id: d.id, rotulo: d.rotulo, valor: null, estado: "NAO_ENCONTRADO", motivo: d.ausente, bruto: null };
  // Evidência só confere com localização estruturada (offsets e fronteiras de token na página original).
  const onde = local === undefined ? localizarEvidencia(lido, paginas, d.tipo) : local;
  const evidencia = lido.trecho ? { pagina: onde?.pagina ?? lido.pagina, trecho: lido.trecho.slice(0, 280), conferida: onde !== null, ...(onde ? { inicio: onde.inicio, fim: onde.fim } : {}) } : undefined;
  return { id: d.id, rotulo: d.rotulo, valor: lido.valor, estado: "PRECISA_REVISAO", bruto: lido.valor, ...(lido.pagina ? { origem: `Página ${lido.pagina}` } : {}), ...(evidencia ? { evidencia } : {}) };
}

const assinatura = (partes: readonly (string | null | undefined)[]) => createHash("sha256").update(JSON.stringify(partes)).digest("hex").slice(0, 32);

/** Conflitos entre campos: soma, parcelas, horário × duração, convidados × pacote. Só entre valores VÁLIDOS. */
function conflitos(campos: readonly CampoExtraido[]): Map<string, string> {
  const n = dadosNormalizados(campos);
  const achados = new Map<string, string>();
  const marcar = (ids: readonly string[], motivo: string) => { for (const id of ids) if (!achados.has(id)) achados.set(id, motivo); };
  const { preco, adicionais, total } = n.valores;
  if (preco != null && total != null && !somaConfere(preco, adicionais ?? 0, total)) {
    marcar(["valores.preco", "valores.adicionais", "valores.total"], adicionais == null ? "O total difere do valor do pacote e não há adicionais lidos." : "Pacote + adicionais não somam o total.");
  }
  if (total != null && (n.pagamentos.entrada || n.pagamentos.parcelas.length)) {
    const conferencia = parcelasConferem(n.pagamentos.entrada, n.pagamentos.parcelas, total, n.evento.data);
    if (!conferencia.ok) marcar(["pagamentos.entrada", ...n.pagamentos.parcelas.map((p) => `pagamentos.parcela_${p.numero}`)], conferencia.motivo);
  }
  if (n.evento.horario?.fim && n.evento.duracaoMinutos != null && minutosEntre(n.evento.horario.inicio, n.evento.horario.fim) !== n.evento.duracaoMinutos) {
    marcar(["evento.horario", "evento.duracao"], "Horário e duração não batem.");
  }
  if (n.evento.convidados != null && n.pacote.quantidade != null && n.evento.convidados > n.pacote.quantidade) {
    marcar(["evento.convidados", "pacote.quantidade"], "Há mais convidados que o previsto no pacote. Confira se há excedentes.");
  }
  // Leitura independente pelo modelo da empresa: valor diferente do atual pede revisão mostrando os dois.
  for (const campo of campos) {
    if (!campo.alternativa || !campo.normalizado) continue;
    const tipo = tipoDoCampo(campo.id);
    const alt = tipo ? validarPorTipo(tipo, campo.alternativa.valor) : null;
    if (!alt?.ok || normalizarTrecho(alt.valor) !== normalizarTrecho(campo.normalizado)) {
      marcar([campo.id], `Pelo modelo de contrato da empresa, o valor seria "${campo.alternativa.valor}". Confira qual está no contrato.`);
    }
  }
  return achados;
}

export type IdentidadeInformada = { tipoPessoa: TipoPessoa | null; cpf: string | null; cnpj: string | null; representanteCpf: string | null };

/**
 * Identidade do contratante pelo BRUTO de cada campo (lido ou digitado), inclusive quando um conflito de identidade
 * deixou o campo recusado: o plano decide sobre o que está na revisão, nunca só sobre o que já foi aceito. Documento
 * bloqueado (da contratada) ou ambíguo (mais de um CPF) não conta.
 */
export function identidadeInformada(campos: readonly CampoExtraido[]): IdentidadeInformada {
  const porId = new Map(campos.map((c) => [c.id, c]));
  const valor = (id: string, f: (t: string) => Validacao<string>) => {
    const c = porId.get(id);
    if (!c || c.bloqueio) return null;
    const texto = c.bruto === undefined ? c.valor : c.bruto;
    const r = texto ? f(texto) : null;
    return r?.ok ? r.valor : null;
  };
  return {
    tipoPessoa: tipoPessoaDe(valor("contratante.tipoPessoa", validarTipoPessoa)),
    cpf: valor("contratante.cpf", validarCpf), cnpj: valor("contratante.cnpj", validarCnpj), representanteCpf: valor("contratante.representanteCpf", validarCpf),
  };
}

/**
 * Conflitos de identidade (R2-7; revisão do Astra da Entrega A, P1-2): tipo de pessoa × documento do contratante.
 * São impeditivos: nunca são confirmados como "divergência do contrato histórico"; só saem com correção ou remoção.
 */
export function conflitosDeIdentidade(i: IdentidadeInformada): Array<{ ids: string[]; motivo: string }> {
  const saida: Array<{ ids: string[]; motivo: string }> = [];
  if (i.tipoPessoa === "PF" && i.cnpj) saida.push({ ids: ["contratante.tipoPessoa", "contratante.cnpj"], motivo: "Há CNPJ no contratante, mas o tipo está como pessoa física. Escolha o tipo certo ou remova o CNPJ." });
  if (i.tipoPessoa === "PJ" && i.cpf) saida.push({ ids: ["contratante.tipoPessoa", "contratante.cpf"], motivo: "Pessoa jurídica não tem CPF próprio: o CPF de quem assina vai em \"CPF do representante\"." });
  if (i.tipoPessoa === "PJ" && !i.cnpj) saida.push({ ids: ["contratante.tipoPessoa"], motivo: "Pessoa jurídica sem CNPJ. Informe o CNPJ ou troque para pessoa física." });
  if (i.representanteCpf && i.cpf && soDigitos(i.representanteCpf) === soDigitos(i.cpf)) saida.push({ ids: ["contratante.cpf", "contratante.representanteCpf"], motivo: "O CPF do contratante é igual ao do representante. Corrija um dos dois." });
  return saida;
}

/**
 * Revalidação completa. Para cada campo com valor: valida o BRUTO de novo, decide o estado pela
 * evidência e pelos conflitos atuais, e mantém a confirmação humana só se ela ainda vale para o
 * mesmo valor e o mesmo conflito. Devolve também a lista de campos revisados que continua valendo.
 */
export function reavaliar(campos: readonly CampoExtraido[]): { campos: CampoExtraido[]; revisados: string[] } {
  const validados = campos.map((c): CampoExtraido => {
    const tipo = tipoDoCampo(c.id);
    // Campo sem bruto registrado (demonstração, formato antigo): fora da revalidação.
    if (c.bruto === undefined) return c;
    const bruto = c.bruto;
    if (!tipo || bruto === null) {
      if (!tipo || c.id === "pagamentos.realizados") return c;
      return { ...c, valor: null, estado: "NAO_ENCONTRADO", normalizado: null, validacao: undefined, conflito: undefined, confirmacao: undefined };
    }
    // Valor que não serve neste papel (ex.: CNPJ da contratada lido como do cliente): recusado até corrigir ou remover.
    if (c.bloqueio) return { ...c, valor: bruto, normalizado: null, validacao: c.ambiguo ? "AMBIGUO" : "INVALIDO", motivo: c.bloqueio };
    const v = validarPorTipo(tipo, bruto);
    return v.ok
      ? { ...c, valor: v.valor, normalizado: v.valor, validacao: "VALIDO" }
      : { ...c, valor: bruto, normalizado: null, validacao: v.estado, motivo: `${v.motivo} Corrija ou remova o valor.` };
  });
  const achados = conflitos(validados);
  const identidade = new Map<string, string>();
  for (const x of conflitosDeIdentidade(identidadeInformada(validados))) for (const id of x.ids) if (!identidade.has(id)) identidade.set(id, x.motivo);
  const revisados: string[] = [];
  const finais = validados.map((c): CampoExtraido => {
    if (c.bruto == null || !c.validacao) return c;
    if (FALHAS.has(c.validacao)) return { ...c, estado: "PRECISA_REVISAO", conflito: undefined, confirmacao: undefined };
    // Conflito de identidade: recusado (AMBIGUO) até corrigir ou remover; confirmação nenhuma o libera.
    const deIdentidade = identidade.get(c.id);
    if (deIdentidade) return { ...c, estado: "PRECISA_REVISAO", validacao: "AMBIGUO", normalizado: null, conflito: undefined, confirmacao: undefined, motivo: deIdentidade };
    const conflito = achados.get(c.id);
    const leitura = pendenciaDeLeitura(c);
    if (!conflito && !leitura) {
      return { ...c, estado: "ENCONTRADO", validacao: "VALIDO", motivo: undefined, conflito: undefined, confirmacao: undefined };
    }
    const tipo = conflito ? "DIVERGENCIA" : "LEITURA";
    const esperada = assinatura([c.normalizado, conflito ?? null, leitura]);
    const confirmacao = c.confirmacao?.tipo === tipo && c.confirmacao.assinatura === esperada ? c.confirmacao : undefined;
    if (confirmacao) revisados.push(c.id);
    return {
      ...c,
      estado: "PRECISA_REVISAO",
      validacao: "PRECISA_REVISAO",
      conflito,
      motivo: conflito ?? (leitura === "SEM_TRECHO" ? "Trecho não localizado no documento. Confira a leitura." : c.inferido),
      confirmacao,
    };
  });
  return { campos: finais, revisados };
}

/** Assinatura esperada para confirmar o campo agora (mesma regra de `reavaliar`). */
function assinaturaAtual(c: CampoExtraido) {
  return assinatura([c.normalizado ?? null, c.conflito ?? null, pendenciaDeLeitura(c)]);
}

/**
 * O que ainda pede confirmação de leitura: trecho não conferido ("SEM_TRECHO") ou valor sugerido a partir de outro campo
 * ("INFERIDO"). Valor informado pelo operador não pede. Campos sem sugestão mantêm a mesma assinatura de antes.
 */
function pendenciaDeLeitura(c: CampoExtraido): "SEM_TRECHO" | "INFERIDO" | null {
  if (c.origem === INFORMADO) return null;
  if (!c.evidencia?.conferida) return "SEM_TRECHO";
  return c.inferido ? "INFERIDO" : null;
}

function comCampos(extracao: ExtracaoContrato, campos: readonly CampoExtraido[]): ExtracaoContrato {
  const porId = new Map(campos.map((c) => [c.id, c]));
  return { ...extracao, secoes: extracao.secoes.map((s) => ({ ...s, campos: s.campos.map((c) => porId.get(c.id) ?? c) })) };
}

export type OpcoesRevisao = {
  /** Leitura independente pelo modelo ATIVO da empresa (campo da revisão → valor no contrato importado). */
  porModelo?: Readonly<Record<string, CampoLido>>;
  modeloReferencia?: { id: string; versao: number } | null;
  /** CNPJ/CPF da contratada no modelo publicado da empresa: nunca aceito como documento do cliente. */
  documentoContratada?: string | null;
};

const DEFINICAO = new Map(SECOES.flatMap((s) => s.campos.map((d) => [d.id, d] as const)));
const celular = (telefone: string) => { const d = soDigitos(telefone); return d.length === 11 && d[2] === "9"; };

export type PartesEndereco = { logradouro: string; numero: string; complemento: string | null; bairro: string; cidade: string; uf: string };

/**
 * Partes de um endereço escrito por extenso no formato usual ("Rua X, 120, apto 302, Bairro, Cidade/UF"). Só devolve
 * quando o formato é inequívoco (número logo depois do logradouro, bairro presente, cidade e UF no fim); senão, null.
 * O resultado é sugestão: cada parte vai para a revisão como inferida e pede confirmação humana.
 */
export function decomporEndereco(texto: string): PartesEndereco | null {
  const partes = texto.split(",").map((p) => p.trim().replace(/\.$/, "")).filter((p) => p && !/^CEP\b/i.test(p));
  if (partes.length < 4) return null;
  const fim = /^(.+?)\s*(?:\/|-|–)\s*([A-Za-z]{2})$/.exec(partes[partes.length - 1]);
  const numero = /^(?:n[º°o.]?\s*)?(\d{1,6}[A-Za-z]?|s\/n)$/i.exec(partes[1]);
  if (!fim || !numero || !validarUf(fim[2]).ok) return null;
  const meio = partes.slice(2, -1);
  if (!meio.length) return null;
  return { logradouro: partes[0], numero: numero[1], complemento: meio.slice(0, -1).join(", ") || null, bairro: meio[meio.length - 1], cidade: fim[1].trim(), uf: fim[2].toUpperCase() };
}

/**
 * Cabeçalho de qualificação: nome da parte (ou de outro papel) no INÍCIO de linha ou de frase ("CONTRATANTE: …",
 * "Representante do contratante: …", "TESTEMUNHA: …"). Menção dentro da frase ("do contratante", "o contratante
 * pagará") não abre bloco (revisão do Astra, rodada 2, P1).
 */
const CABECALHO = /(?:^|\n|[.;]\s)\s*(contratante|locat[aá]ri[oa]|contratad[ao]|locador[a]?|representantes?|procurador[a]?|testemunhas?|fiador[a]?|avalista|interveniente|c[oô]njuge|cl[aá]usula)\b/gi;
const DO_CONTRATANTE = /^(contratante|locat)/i;
/**
 * Papel de outra pessoa (representação, testemunha, garantia, a outra parte). Conferido no texto SEM acento, com mapa de
 * posições ("cônjuge" e "cônjuge" são a mesma palavra) — revisão do Astra, rodadas 4 e 5.
 */
const OUTRO_TITULAR = /\b(?:represent\w*|neste ato|procurad\w*|mandatari\w*|prepost\w*|outorgad\w*|testemunh\w*|fiador\w*|avalist\w*|intervenient\w*|anuent\w*|garantidor\w*|contratad[ao]s?|locador\w*|curador\w*|tutor\w*|inventariant\w*|rep\.|por (?:sua|seu|meio|intermedio)\b)/i;
/**
 * Relação ou cargo que pode só DESCREVER a contratante ("sócia da Empresa", "cônjuge de João", "administradora de
 * empresas", "responsável legal pelo menor"): é papel de outra pessoa apenas sem "de/da/com/pelo/na…" depois.
 */
const RELACAO = /\b(?:soci[oa]s?|conjuges?|espos[ao]|marido|companheir[oa]|administrador[a]?|diretor[a]?|gerente|presidente|sindic[oa]|responsavel(?!\s+legal\b)|responsavel\s+legal)\b(?!\s+(?:de|da|do|das|dos|com|pelo|pela|pelos|pelas|na|no|nas|nos|em)\b)/i;
/** Marca de pessoa jurídica no NOME do sujeito da qualificação (o nome inteiro, sem apagar "de Festas Aurora Ltda"). */
const PESSOA_JURIDICA = /\b(?:ltda|eireli|mei|llc|inc|cia|companhia|empresa|sociedade|associacao|condominio|cooperativa|fundacao|instituto|igreja|escola|colegio|clube|hospital|clinica|buffet|festas|eventos|comercio|servicos|grupo|holding|pessoa juridica|razao social|nome fantasia|cnpj)\b|\bs\s?[./]\s?a\b|\bs\.a\.s\b/i;
const PORTE_EMPRESA = /\b(?:ME|EPP)\b/;
/** Rótulo de linha/coluna antes do valor ("Nome:", "Nome completo:"). */
const ROTULO_INICIAL = /^([\p{L} \/-]{1,40}):\s*/u;
/** Início da parte de endereço da qualificação: daí até o documento, nomes próprios são de rua, bairro e cidade. */
const ENDERECO_INICIO = /^(?:residente|domiciliad|com sede|com endereco|sediad|estabelecid)|^endereco\b|^logradouro\b/i;
const CNPJ_NO_TEXTO = /(?<![0-9A-Z])[0-9A-Z]{2}\.?[0-9A-Z]{3}\.?[0-9A-Z]{3}\/?[0-9A-Z]{4}-?\d{2}(?![0-9A-Z])/gi;
/**
 * Rótulo de linha que ainda é dado da qualificação ("Nome:", "CPF:", "Endereço:", "CPF do contratante:"), conferido
 * por INTEIRO (revisão do Astra, rodada 3). Qualquer outro rótulo ("Data do evento:", "CPF da testemunha:") encerra.
 */
const ATRIBUTO = /^(nome(?: completo)?|raz[aã]o social|nome fantasia|cpf|cnpj|cpf\/cnpj|rg|identidade|documento|telefone|fone|celular|whatsapp|e-?mail|endere[cç]o|logradouro|n[uú]mero|complemento|cep|bairro|cidade|uf|estado|nacionalidade|profiss[aã]o|estado civil|data de nascimento|nascimento)(?:\s+d[oa]s?\s+(?:contratante|locat[aá]ri[oa]|cliente))?$/i;
const CPF_NO_TEXTO = /(?<!\d)\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?!\d)/g;
const JANELA_PARTE = 600;
const formatarCpf = (d: string) => `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;

/** Texto sem acentos (inclusive marcas combinantes soltas) e, para cada caractere, a posição no texto original. */
export function semAcento(texto: string): { texto: string; origem: number[] } {
  let saida = "";
  const origem: number[] = [];
  for (let i = 0; i < texto.length; i++) for (const ch of texto[i].normalize("NFD").replace(/\p{M}/gu, "")) { saida += ch; origem.push(i); }
  origem.push(texto.length);
  return { texto: saida, origem };
}

/** Primeiro papel de outra pessoa no texto (sem acento), ou null. */
function primeiroPapel(texto: string): RegExpExecArray | null {
  const a = OUTRO_TITULAR.exec(texto);
  const b = RELACAO.exec(texto);
  return !a ? b : !b ? a : a.index <= b.index ? a : b;
}

/**
 * Depois do documento, o papel abre OUTRA pessoa — e a qualificação do titular termina ali — só com prova estrutural
 * (revisão do Astra, rodada 6, P1-A): introdução explícita ("e seu cônjuge …") ou nome próprio logo após o papel
 * ("testemunha João Lima", "neste ato representada por Carla Dias"), nome DIFERENTE do titular e documento próprio
 * em seguida. Qualquer outra coisa é aposto do próprio titular ("…, CPF …, testemunha", "como testemunha Paula Ramos",
 * "(testemunha)", "| representante legal |") e o documento não é comprovadamente do contratante.
 */
function abreOutraPessoa(texto: string, papel: RegExpExecArray, titular: string, documento: string): boolean {
  const seguinte = texto.slice(papel.index + papel[0].length);
  const introducao = /(?:^|[\s,;])e\s+(?:(?:o|a|os|as|seu|sua|seus|suas)\s+)?$/i.test(texto.slice(0, papel.index));
  const nome = /^\s*(?:(?:representad[ao]s?|por|pel[oa]|seu|sua|legal|legalmente)\s+){0,3}:?\s*(\p{Lu}[\p{L}'-]*(?:\s+(?:(?:d[aeo]s?|e)\s+)?\p{Lu}[\p{L}'-]*)*)/u.exec(seguinte);
  if (!introducao && !nome) return false;
  if (nome && mesmoNome(nome[1], titular)) return false;
  // Documento PRÓPRIO (revisões do Astra, rodadas 7 e 8, P1-C): o primeiro documento válido depois do nome, diferente
  // do titular e ligado ao nome só por atributos validados por inteiro ("João Lima, brasileiro, CPF …"). O mesmo CPF
  // repetido, um documento depois de outra frase ou o documento de uma terceira pessoa ("casado com Carla Dias portadora
  // do CPF …") não provam nada.
  const aposNome = nome ? nome.index + nome[0].length : 0;
  const doc = primeiroDocumento(seguinte.slice(aposNome));
  if (!doc || doc.canonico === documento) return false;
  const ligacao = seguinte.slice(aposNome, aposNome + doc.indice);
  if (quebraDeFrase(ligacao)) return false;
  const fragmentos = ligacao.split(/[,;\n()|\t]/).map((f) => f.trim().replace(/^[:\-–—\s]+/, ""));
  if (sombraDeOutro(fragmentos) || fragmentos.some(abreEndereco)) return false;
  const cauda = rotuloDoDocumento(fragmentos.pop() ?? "");
  return cauda !== null && (!cauda || ATRIBUTO_SOLTO.test(cauda)) && fragmentos.every(atributo);
}

/** Primeiro CPF ou CNPJ válido do texto (posição e forma canônica), ou null. */
function primeiroDocumento(texto: string): { indice: number; canonico: string } | null {
  const achados = [...[...texto.matchAll(CPF_NO_TEXTO)].filter((m) => validarCpf(soDigitos(m[0])).ok),
    ...[...texto.matchAll(CNPJ_NO_TEXTO)].filter((m) => validarCnpj(m[0].toUpperCase()).ok)].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const m = achados[0];
  return m ? { indice: m.index ?? 0, canonico: m[0].toUpperCase().replace(/[^0-9A-Z]/g, "") } : null;
}

/** "inscrita no CPF sob o nº", "portador do CNPJ", "CPF:", "de CPF:" logo antes do número. */
const ROTULO_DOCUMENTO_FINAL = /(?:\b(?:de|com)\s+)?(?:(?:portador[a]?|inscrit[oa]|titular)\s+(?:[dn][oa]\s+)?)?(?:cpf|cnpj)(?:\s*\/\s*(?:mf|cnpj))?(?:\s+sob\s+o)?(?:\s*n[º°o.]?)?\s*:?\s*$/i;
/**
 * O último fragmento antes do documento sem o rótulo do documento: "" quando é só o rótulo ("CPF", "inscrita no CPF sob
 * o nº"), o que vem antes dele quando está colado ("Maria Teste de CPF:" ⇒ "Maria Teste"), ou null quando o fragmento
 * não termina no rótulo. Quem pode vir colado é decidido por quem chama: o nome do titular ou um atributo simples —
 * nunca uma descrição que nomeia outra pessoa ("casada com João Lima portador do CPF" é o documento de João).
 */
function rotuloDoDocumento(fragmento: string): string | null {
  const m = ROTULO_DOCUMENTO_FINAL.exec(fragmento);
  return m ? fragmento.slice(0, m.index).trim() : fragmento.trim() ? null : "";
}

/**
 * Ponto final seguido de maiúscula dentro da qualificação, fora de abreviações ("Prof.", "Av.", "nº", iniciais): começa
 * outra frase, que pode falar de outra pessoa ("Profissão: médico. João Lima é inscrito no CPF …") — revisão r8, P1-B.
 */
// Só abreviações que vêm ANTES do que abreviam (tratamento, logradouro, número, inicial). "Jr.", "Ltda." e afins fecham
// o nome: maiúscula depois delas é outra frase (revisão r9, P1-B: "João Lima Jr. Ele Possui O").
const ABREVIACAO = /^(?:sr|sra|srta|dr|dra|prof|profa|eng|enga|exmo|exma|ilmo|ilma|av|r|rod|al|tv|trav|pc|pca|n|no|nº|n°|apto|ap|bl|qd|lt|cj|ed|sl|km|vl|jd|cond|\p{L})$/iu;
const quebraDeFrase = (texto: string) => [...texto.matchAll(/([\p{L}\dº°ª]+)\.\s+(?=\p{Lu})/gu)].some((m) => !ABREVIACAO.test(m[1]));

/**
 * Atributos da qualificação reconhecidos POSITIVAMENTE e POR INTEIRO (revisões do Astra, rodadas 7 e 8, P1-A), conferidos
 * no texto sem acento. Fragmento que não é atributo nem o nome do titular é outra coisa — talvez outra pessoa, talvez
 * empresa — e a titularidade fica incerta: "não reconheci" nunca vale como "não há ninguém", e reconhecer o começo
 * ("casada com …", "telefone …", "RG …") não reconhece o resto.
 */
const NACIONALIDADE = String.raw`brasileir[oa]|estrangeir[oa]|portugues[a]?|argentin[oa]|uruguai[oa]|paraguai[oa]|chilen[oa]|bolivian[oa]|venezuelan[oa]|colombian[oa]|peruan[oa]|italian[oa]|espanhol[a]?|frances[a]?|alema[o]?|american[oa]|japones[a]?|chines[a]?|naturalizad[oa]`;
const ESTADO_CIVIL = String.raw`solteir[oa]|casad[oa]|divorciad[oa]|separad[oa](?: judicialmente)?|viuv[oa]|em uniao estavel|convivente|maior(?: de idade)?|capaz|pessoa fisica`;
const PROFISSAO = String.raw`empresari[oa]|comerciante|autonom[oa]|aposentad[oa]|pensionista|desempregad[oa]|trabalhador[a]?|bacharel|estudante|do lar|professor[a]?|medic[oa]|enfermeir[oa]|advogad[oa]|engenheir[oa]|arquitet[oa]|contador[a]?|dentista|psicolog[oa]|nutricionista|fisioterapeuta|farmaceutic[oa]|veterinari[oa]|administrador[a]?|analista|tecnic[oa]|vendedor[a]?|motorista|policial|militar|bancari[oa]|secretari[oa]|cabeleireir[oa]|manicure|cozinheir[oa]|confeiteir[oa]|costureir[oa]|designer|programador[a]?|jornalista|publicitari[oa]|economista|corretor[a]?|consultor[a]?|gerente|diretor[a]?|assistente|auxiliar|recepcionista|atendente|operador[a]?|pedagog[oa]|biolog[oa]|quimic[oa]|musico|musicista|artista|fotograf[oa]|empreendedor[a]?|microempreendedor[a]?|agricultor[a]?|pecuarista|pedreiro|eletricista|mecanic[oa]|domestic[oa]|diarista|cuidador[a]?|terapeuta|esteticista|bombeir[oa]|delegad[oa]|juiz[a]?|promotor[a]?|defensor[a]?|servidor[a]?|funcionari[oa]|bibliotecari[oa]|zootecnista|odontolog[oa]|fonoaudiolog[oa]|educador[a]?|instrutor[a]?|personal trainer|chef|garcom|garconete|frentista|porteir[oa]|zelador[a]?|cientista|pesquisador[a]?|desenvolvedor[a]?|piloto|comissari[oa]|agente|inspetor[a]?|investigador[a]?|escrivao|tabeliao|oficial`;
/** Cabeça de uma descrição do próprio titular seguida de preposição ("sócia da Empresa X", "casada com João Lima"). */
const CABECA_DESCRICAO = String.raw`${PROFISSAO}|${ESTADO_CIVIL}|${NACIONALIDADE}|soci[oa]|conjuge|espos[ao]|filh[oa]|responsavel(?: legal)?|colaborador[a]?|proprietari[oa]|natural|nascid[oa]|residente|domiciliad[oa]`;
const ATRIBUTO_SOLTO = new RegExp(String.raw`^(?:${NACIONALIDADE}|${ESTADO_CIVIL}|${PROFISSAO})(?:\s+(?:${PROFISSAO}|civil|eletricista|mecanic[oa]|eletronic[oa]|de software|de sistemas|de vendas|administrativ[oa]|financeir[oa]|comercial|social|autonom[oa]|liberal|public[oa]|aposentad[oa]|de enfermagem|de imoveis|de seguros|fisic[oa]|de eventos|federal|estadual|municipal|universitari[oa]|individual))?$`, "i");
const DESCRICAO = new RegExp(String.raw`^(${CABECA_DESCRICAO})(?:\s+(?:legal|legalmente|judicialmente))?\s+(sob o|sob a|sob|de|da|do|das|dos|com|pelo|pela|pelos|pelas|em|na|no|nas|nos)\s+(.+)$`, "i");
/**
 * Palavras do complemento de uma descrição do próprio titular (revisão r11, P1-B): só o vocabulário fechado abaixo, que
 * não contém pessoa nenhuma — nem nome próprio, nem profissão, nem "menor". "casada com o médico", "filha de médico",
 * "responsável pelo menor" introduzem outra pessoa sem maiúscula e deixam a titularidade incerta.
 */
const COMPLEMENTO_MINUSCULO = /^(?:o|a|os|as|de|da|do|das|dos|e|em|regime|comunhao|parcial|universal|separacao|total|obrigatoria|convencional|participacao|final|aquestos|bens|empresas?|escola|enfermagem|sistemas|vendas|software|imoveis|seguros|eventos|ensino|uniao|estavel|lar|idade|educacao|infantil|producao|medicina|direito|engenharia|administracao|pedagogia|psicologia|odontologia|arquitetura|contabilidade|computacao|letras|nutricao|farmacia|fisioterapia|veterinaria|jornalismo)$/i;
/** Relação que sempre aponta para outra pessoa, qualquer que seja o complemento ("casada com …", "cônjuge de …"). */
const RELACAO_PESSOAL = /^(?:conjuge|espos[ao]|filh[oa]|responsavel)/i;
const PALAVRA_DE_LUGAR = /^(?:\p{Lu}[\p{L}'’]*|\d[\d.,ºª°]*[A-Za-z]?|d[aeo]s?|e|n[º°o.]?|s|rua|avenida|av|travessa|alameda|rodovia|estrada|praca|largo|quadra|qd|lote|conjunto|setor|vila|jardim|chacara|condominio|residencial|loteamento|km)$/u;
/**
 * Maiúscula não prova nome (revisão r9, P1-B): palavra de documento, pronome, verbo ou relativo — em qualquer caixa e sem
 * a pontuação final ("Inscrito.", "CPF.", "Ele", "Possui", "Que") — nunca compõe nome, lugar ou complemento.
 */
const PALAVRA_DE_DOCUMENTO = /^(?:cpf|cnpj|rg|cnh|oab|portador[a]?e?s?|inscrit[oa]s?|titular(?:es)?|documentos?|identidade|ele|ela|eles|elas|possui|possuem|tem|tendo|teve|que|cujo|cuja|cujos|cujas|qual|quais|sendo|esta|estao|era|foi|assina|assinam|comparece|comparecem|reside|residem|mora|moram|detentor[a]?|possuidor[a]?)$/i;
/** Palavras sem a pontuação colada; nunca mais de 8 (nome, lugar ou complemento não são frases). */
const palavras = (texto: string) => texto.split(/[\s\/–-]+/).map((p) => p.replace(/^[.,:;]+|[.,:;]+$/g, "")).filter(Boolean);
const curto = (lista: string[]) => lista.length <= 8;
/** Palavras em forma de lugar, sem verbo, documento ou prosa conhecidos: base do topônimo. */
const lugar = (texto: string) => { const p = palavras(texto); return curto(p) && p.every((x) => PALAVRA_DE_LUGAR.test(x) && !PALAVRA_DE_DOCUMENTO.test(x)); };
/**
 * Lugar de nascimento por estrutura estrita (revisões r10 e r11): maiúscula não prova topônimo e um nome de rua não se
 * distingue de uma oração ("Rua João Lima Apresenta O", "Vila João Informa"). Topônimo = um nome só ("Brasília"); dois
 * quando o primeiro é um tipo de lugar que não é nome de pessoa ("São Paulo", "Rio de Janeiro"); três só com tipo e dois
 * qualificadores, sem nome livre no fim ("Rio Grande do Sul", "Mato Grosso do Sul" — revisão r12: "Rio Grande Declara").
 * A UF final não conta; ":" ou "|" no meio é outra coisa. O resto ("Juiz de Fora", "Bela Vista", "Nossa Senhora
 * Aparecida") fica incerto para o operador.
 */
const CABECA_DE_LUGAR = /^(?:jardim|vila|parque|setor|lago|lagoa|nucleo|bairro|cidade|sao|santa|santo|nossa|senhora|rio|porto|campo|campos|ilha|morro|praia|recanto|chacara|serra|monte|vale|granja|sitio|bosque|distrito|aguas|feira|foz|ribeirao|cabo|cachoeira|varzea|colonia|fazenda|estancia|minas|mato|espirito|belo|barra|ponta|alto)$/i;
const QUALIFICADOR_DE_LUGAR = /^(?:norte|sul|leste|oeste|central|grande|grosso|nov[oa]|velh[oa]|[IVX]+)$/i;
function toponimo(texto: string): boolean {
  if (/[:|]/.test(texto) || !lugar(texto)) return false;
  const nomes = palavras(texto).filter((x) => /^\p{Lu}/u.test(x)).map((x) => semAcento(x).texto);
  if (nomes.length > 1 && /^[A-Z]{2}$/.test(nomes[nomes.length - 1]) && validarUf(nomes[nomes.length - 1]).ok) nomes.pop();
  if (nomes.length <= 1) return true;
  if (!CABECA_DE_LUGAR.test(nomes[0])) return false;
  return nomes.length === 2 || (nomes.length === 3 && QUALIFICADOR_DE_LUGAR.test(nomes[1]) && QUALIFICADOR_DE_LUGAR.test(nomes[2]));
}
/**
 * Nascimento só é lugar com conector locativo (revisão r12, P1): "natural de/da/do …", "nascida em/no/na …". Filiação
 * ("nascida de Maria") e companhia ("nascida com João") introduzem outra pessoa; qualquer outro conector também. Vale
 * para a descrição do titular e para a sombra (nomeiaOutro), que usam este mesmo teste.
 */
const nascimentoLocativo = (cabeca: string, conector: string) =>
  /^natural$/i.test(cabeca) ? /^d[aeo]s?$/i.test(conector) : /^(?:em|n[ao]s?)$/i.test(conector);
const complemento = (texto: string) => { const p = palavras(texto); return curto(p) && p.some((x) => !/^(?:o|a|os|as)$/i.test(x)) && p.every((x) => COMPLEMENTO_MINUSCULO.test(x)); };
/** Descrição do próprio titular: nascimento só com conector locativo e topônimo; relação com outra pessoa é decidida por nomeiaOutro. */
const descricao = (f: string) => {
  const m = DESCRICAO.exec(f);
  return !!m && (/^(?:natural|nascid)/i.test(m[1]) ? nascimentoLocativo(m[1], m[2]) && toponimo(m[3]) : complemento(m[3]));
};
/** Contato e documento só no formato próprio — "telefone de João Lima" e "RG de João Lima" não são atributos. */
const CONTATO = [
  /^\d[\d\s.\/º°ª-]*$/,
  /^n[º°o.]?\s*\d[\d.\/-]*[A-Za-z]?$/i,
  /^(?:tel\.?|telefone|fone|celular|whatsapp)(?:\s*\/\s*whatsapp)?(?:\s+(?:fixo|celular|residencial|comercial))?\s*:?\s*\+?[\d\s()+.-]{8,}$/i,
  /^(?:e-?mail\s*:?\s*)?[^\s@]+@[^\s@]+\.[^\s@]+$/i,
  // RG/CNH/identidade: número e órgão emissor em sigla ("portadora do RG 1.234.567 SSP/DF"), nada além disso.
  { test: (f: string) => {
    const m = /^(?:portador[a]?\s+d[ao]\s+)?(?:rg|cedula de identidade(?:\s+rg)?|carteira de identidade|identidade|cnh|ctps|passaporte)\s*(?:n[º°o.]?)?\s*:?\s*(.*)$/i.exec(f);
    return !!m && /^[\dXx][\dXx.\/-]*(?:\s*[-–\/]?\s*[A-Z]{2,6}(?:\s*[-–\/]\s*[A-Z]{2})?)?$/.test(m[1]);
  } },
  /^(?:nascid[oa]\s+(?:em|aos)\s+|data de nascimento\s*:?\s*)\d{1,2}\/\d{1,2}\/\d{2,4}$/i,
  /^cep\s*:?\s*\d{5}-?\d{3}$/i,
  /^(?:inscrit[oa]\s+na\s+)?oab\s*[\/-]?\s*[A-Za-z]{2}\s*(?:sob\s+o\s+)?(?:n[º°o.]?)?\s*\d[\d.\/-]*$/i,
  /^(?:cpf|cnpj)(?:\/mf)?\s*(?:n[º°o.]?)?\s*:?\s*[\dA-Z][\dA-Z.\/-]+$/i,
];
function atributo(fragmento: string): boolean {
  const f = fragmento.replace(/\s+/g, " ").replace(/[.:]$/, "").trim();
  if (!f) return true;
  if (ATRIBUTO.test(f) || ATRIBUTO_SOLTO.test(f) || descricao(f) || CONTATO.some((c) => c.test(f))) return true;
  // "Brasileira e casada com João Lima": cada parte ligada por "e" tem de ser atributo.
  const partes = f.split(/\s+e\s+/i);
  return partes.length > 1 && partes.every((p) => ATRIBUTO_SOLTO.test(p) || descricao(p));
}
/**
 * Relação que introduz outra pessoa ou entidade em qualquer ponto do fragmento, com ou sem maiúscula ("casada com João
 * Lima", "casada com o médico", "Paula Ramos cônjuge de João Ramos", "responsável pelo menor"): relação pessoal, "com"
 * ou complemento fora do vocabulário fechado. Nascimento só não introduz ninguém com conector
 * locativo e topônimo; residência é endereço.
 */
const RELACAO_NOMEADA = new RegExp(String.raw`\b(${CABECA_DESCRICAO})(?:\s+(?:legal|legalmente|judicialmente))?\s+(sob o|sob a|sob|de|da|do|das|dos|com|pelo|pela|pelos|pelas|em|na|no|nas|nos)\s+(?:(?:o|a|os|as)\s+)?(?=(\S.*))`, "gi");
const nomeiaOutro = (fragmento: string) => [...fragmento.matchAll(RELACAO_NOMEADA)].some((m) => {
  if (/^(?:natural|nascid)/i.test(m[1])) return !nascimentoLocativo(m[1], m[2]) || !toponimo(m[3]);
  return /^(?:residente|domiciliad)/i.test(m[1]) || RELACAO_PESSOAL.test(m[1]) || /^com$/i.test(m[2]) || !complemento(m[3]);
});
/**
 * Sombra de outra pessoa (revisões r8 a r10, P1-A): numa qualificação que nomeia outra pessoa ou entidade, o documento
 * pode ser dela — "casada com João Lima, brasileiro, portador do CPF …", "casada com João Lima Apresenta O, CPF …". Sem
 * exceção: nem "CPF" sozinho logo depois segue o titular, porque o nome nomeado não se distingue de uma oração. Devolve
 * true quando a titularidade fica incerta; o operador confirma de quem é o documento.
 */
const sombraDeOutro = (fragmentos: string[]) => fragmentos.some((f) => nomeiaOutro(f.trim()));

/** Nome comparável: sem pontuação, sem tratamento (Sr., Dra., Prof., Eng.) e sem diferença de caixa. */
const nomeComparavel = (nome: string) => semAcento(nome).texto.toLowerCase().replace(/[^\p{L}\s]/gu, " ")
  .replace(/^\s*(?:(?:sr|sra|srta|dr|dra|prof|profa|eng|enga|exmo|exma|ilmo|ilma)\s+)+/, "").replace(/\s+/g, " ").trim();
/**
 * Endereço antes do documento (revisão r11, P1-A): rótulo de endereço ("Endereço:", "Bairro:", "Cidade:", "UF:") ou
 * endereço por extenso ("residente na …", "com sede na …"). Nome de rua, bairro ou cidade não se distingue de uma oração
 * ("Rua João Lima Apresenta O, 10, CPF …"): o documento depois dele não se liga automaticamente ao titular.
 */
const ROTULO_DE_ENDERECO = /^(?:endere[cç]o|logradouro|n[uú]mero|complemento|bairro|cidade|uf|estado)(?:\s+d[oa]s?\s+\S+)?$/i;
/** Fragmento que abre endereço: rótulo de endereço, mesmo vazio ("Bairro", "UF:", "Número | 10" — revisão r12), ou endereço por extenso. */
const abreEndereco = (fragmento: string) => ROTULO_DE_ENDERECO.test(fragmento.trim().replace(/[.:\s]+$/, "")) || ENDERECO_INICIO.test(fragmento.trim());
/** Valor aceito por rótulo de qualificação: cada rótulo confere o próprio formato, nunca "qualquer coisa" (r8, P1-B). */
function valorDoRotulo(rotulo: string, valor: string): boolean {
  if (!valor) return true;
  if (/^profiss/i.test(rotulo)) return ATRIBUTO_SOLTO.test(valor) || descricao(valor);
  if (/^nacionalidade/i.test(rotulo)) return new RegExp(`^(?:${NACIONALIDADE})$`, "i").test(valor);
  if (/^estado civil/i.test(rotulo)) return new RegExp(`^(?:${ESTADO_CIVIL})$`, "i").test(valor) || descricao(valor);
  return atributo(`${rotulo} ${valor}`) || atributo(valor);
}

/**
 * Vínculo estrutural entre o titular e o documento (revisões do Astra, rodadas 6 a 8): entre o cabeçalho e o documento,
 * cada fragmento (vírgula, ponto e vírgula, linha, parênteses, célula) tem de ser reconhecido POR INTEIRO — o NOME do
 * contratante lido (em qualquer caixa, com ou sem tratamento), um atributo de qualificação ou uma parte do endereço — e o
 * nome tem de aparecer exatamente uma vez. Outra frase dentro da qualificação ⇒ incerto. O rótulo do documento só se liga
 * ao titular quando está sozinho ou colado ao nome/atributo simples. Endereço antes do documento ⇒ incerto (revisão r11:
 * nome de rua não se distingue de oração); o documento antes do endereço segue normal. Devolve o nome do titular no
 * texto, ou null quando o vínculo não é demonstrável.
 */
function titularAntes(texto: string, nomeLido: string): string | null {
  const rotuloLido = ROTULO_INICIAL.exec(nomeLido.trim());
  const alvo = nomeComparavel(rotuloLido && ATRIBUTO.test(semAcento(rotuloLido[1]).texto.trim()) ? nomeLido.trim().slice(rotuloLido[0].length) : nomeLido);
  if (!alvo || /\s+e\s+/.test(alvo) || quebraDeFrase(texto) || sombraDeOutro(texto.split(/[,;\n()|\t]/))) return null;
  // Rótulo do próprio documento no último fragmento: sozinho, ou colado ao nome ("Maria Teste de CPF:") ou a um atributo
  // simples ("brasileira inscrita no CPF"). Colado a qualquer outra coisa, o documento é de quem foi nomeado ali.
  const corte = Math.max(...[",", ";", "\n", "(", ")", "|", "\t"].map((s) => texto.lastIndexOf(s))) + 1;
  // Sem rótulo ("Paula Ramos 529…"), o último fragmento é classificado como qualquer outro.
  const colado = rotuloDoDocumento(texto.slice(corte).replace(/^[:\-–—.\s]+/, ""));
  if (colado !== null) {
    const nomeColado = colado.split(/\s+/).map((_, i, t) => t.slice(0, i + 1).join(" ")).find((p) => nomeComparavel(p) === alvo);
    const simples = (t: string) => !t.trim() || ATRIBUTO_SOLTO.test(t.trim());
    if (colado && !simples(colado) && !(nomeColado && simples(colado.slice(nomeColado.length)))) return null;
    texto = texto.slice(0, corte) + colado;
  }
  let titular: string | null = null;
  for (const linha of texto.split("\n")) {
    for (const bruto of linha.split(/[,;()|\t]/)) {
      let fragmento = bruto.trim().replace(/^[:\-–—.\s]+/, "");
      const rotulo = ROTULO_INICIAL.exec(fragmento);
      let rotuloNome = false;
      if (rotulo) {
        const r = rotulo[1].trim().replace(/\s+/g, " ");
        if (!ATRIBUTO.test(r) || ROTULO_DE_ENDERECO.test(r)) return null;
        fragmento = fragmento.slice(rotulo[0].length).trim();
        rotuloNome = /^(?:nome|razao social|nome fantasia)/i.test(r);
        if (!rotuloNome) { if (valorDoRotulo(r, fragmento)) continue; return null; }
      }
      if (!fragmento) continue;
      if (abreEndereco(fragmento)) return null;
      // O nome, sozinho ou seguido de atributo sem vírgula ("Paula Ramos brasileira"); o titular é só o nome.
      const termos = fragmento.split(/\s+/);
      const nome = termos.map((_, i) => termos.slice(0, i + 1).join(" ")).find((p) => nomeComparavel(p) === alvo);
      if (nome && atributo(fragmento.slice(nome.length))) {
        if (titular) return null;
        titular = nome;
        continue;
      }
      if (rotuloNome || !atributo(fragmento)) return null;
    }
  }
  return titular;
}
const termosDoNome = (nome: string) => nome.toLowerCase().split(/[^\p{L}]+/u).filter((p) => p.length > 2 && !/^(?:das?|dos?|de)$/.test(p));
/** O mesmo nome (ou parte dele) que o titular: "como testemunha Paula Ramos" logo depois do CPF de Paula Ramos. */
function mesmoNome(a: string, b: string): boolean {
  const x = termosDoNome(a), y = termosDoNome(b);
  return x.length > 0 && y.length > 0 && (x.every((p) => y.includes(p)) || y.every((p) => x.includes(p)));
}

/**
 * Fim ESTRUTURAL da qualificação dentro de `texto` (que começa logo depois do cabeçalho): cabeçalho em linha nova ou
 * seguido de ":" ("TESTEMUNHA: …"), frase sobre a outra parte (". A CONTRATADA …"), linha em branco ou linha com rótulo
 * que não é dado da qualificação. Ponto final sozinho não encerra (revisão do Astra, rodada 6, P1-B): ". Na qualidade de
 * testemunha" ainda fala do mesmo titular, e "Prof." não é fim de frase.
 */
function fimDaQualificacao(texto: string): number {
  const cabecalhos = [...texto.matchAll(CABECALHO)].filter((m) => m[0].includes("\n") || /^\s*:/.test(texto.slice((m.index ?? 0) + m[0].length)));
  const cortes = [cabecalhos[0]?.index ?? -1, texto.search(/\n\s*\n/), texto.search(/[.;]\s+(?:(?:a|o|as|os)\s+)?(?:contratad[ao]|contratante|locador[a]?|locatari[oa])\b/i)];
  for (const m of texto.matchAll(/\n\s*([\p{L}][\p{L} \/-]{1,40}):/gu)) if (!ATRIBUTO.test(m[1].trim().replace(/\s+/g, " "))) { cortes.push(m.index ?? texto.length); break; }
  return Math.min(texto.length, ...cortes.filter((i) => i >= 0));
}

/**
 * Papel do documento no contrato importado, conferido no texto e não na palavra da IA (revisões do Astra até a rodada 5).
 * Só COMPROVA o contratante (e libera PF automático) quando: o cabeçalho mais próximo antes do documento é o do
 * contratante; o documento está dentro da qualificação; nada entre o cabeçalho e o documento nomeia outro papel; um CPF
 * não vem depois de pessoa jurídica; a tabela tem só títulos de qualificação; e o que segue o documento não é aposto de
 * outro papel. "OUTRO" só com evidência de outra pessoa (cabeçalho de outra parte, CPF depois de CNPJ válido); o resto
 * é titularidade incerta (null). Devolve também os CPFs válidos distintos da qualificação do titular.
 */
/** CPFs válidos distintos do início da qualificação até `fim`. */
const cpfsAte = (texto: string, fim: number) => [...new Set([...texto.slice(0, fim).matchAll(CPF_NO_TEXTO)].map((m) => soDigitos(m[0])).filter((d) => validarCpf(d).ok))];

function qualificacaoNoTexto(c: CampoExtraido, paginas: readonly string[], nomeLido: string): { papel: "CONTRATANTE" | "OUTRO" | null; cpfs: string[] } {
  const ev = c.evidencia;
  const incerto = { papel: null, cpfs: [] };
  if (!ev?.conferida || ev.inicio == null || ev.fim == null || !ev.pagina || !c.bruto) return incerto;
  const { texto: pagina, origem } = semAcento(paginas[ev.pagina - 1] ?? "");
  const dobrado = (i: number) => { const k = origem.findIndex((o) => o >= i); return k < 0 ? pagina.length : k; };
  // A evidência cobre o trecho; a posição que importa é a do próprio documento dentro dele (com ou sem pontuação).
  const canonico = c.bruto.toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (canonico.length < 11) return incerto;
  const padrao = new RegExp(`(?<![0-9A-Z])${canonico.split("").join("[.\\-/\\s]?")}(?![0-9A-Z])`, "i");
  const inicioEvidencia = dobrado(ev.inicio);
  const achado = padrao.exec(pagina.slice(inicioEvidencia, dobrado(ev.fim)));
  if (!achado) return incerto;
  const posicao = inicioEvidencia + achado.index;
  // Cabeçalho mais próximo antes do documento, procurado na página inteira (o início de um recorte não é início de linha).
  let rotulo: RegExpMatchArray | null = null;
  for (const m of pagina.matchAll(CABECALHO)) {
    const i = m.index ?? 0;
    if (i >= posicao) break;
    if (i >= posicao - JANELA_PARTE) rotulo = m;
  }
  if (!rotulo) return incerto;
  if (!DO_CONTRATANTE.test(rotulo[1])) return { papel: "OUTRO", cpfs: [] };
  const inicioBloco = (rotulo.index ?? 0) + rotulo[0].length;
  const resto = pagina.slice(inicioBloco, inicioBloco + 2 * JANELA_PARTE);
  let fim = fimDaQualificacao(resto);
  // Depois do fim da qualificação (ex.: abaixo de "Data do evento:"), o documento não é comprovadamente do contratante.
  if (posicao - inicioBloco >= fim) return incerto;
  // Tudo entre o cabeçalho e o documento conta, não só o último fragmento.
  const entre = pagina.slice(inicioBloco, posicao);
  if (canonico.length === 11) {
    // CPF depois de um CNPJ válido: o contratante é empresa e o CPF é de outra pessoa.
    if ([...entre.matchAll(CNPJ_NO_TEXTO)].some((m) => validarCnpj(m[0].toUpperCase()).ok)) return { papel: "OUTRO", cpfs: [] };
  }
  if (primeiroPapel(entre)) return incerto;
  // Tudo antes do documento reconhecido e o nome lido exatamente uma vez; para CPF, o nome não pode ser de empresa.
  const titular = titularAntes(entre, nomeLido);
  // Sem titular demonstrável, os CPFs da qualificação ainda contam: dois ⇒ ambíguo (o operador digita o certo).
  if (!titular) return { papel: null, cpfs: cpfsAte(resto, fim) };
  if (canonico.length === 11 && (PESSOA_JURIDICA.test(titular) || PORTE_EMPRESA.test(titular))) return incerto;
  // Tabela ou colunas: cada célula de título já passou por titularAntes ("| Assinatura | CPF |" não é atributo ⇒ incerto).
  // Depois do documento: aposto de outro papel ⇒ incerto; papel que abre outra pessoa ⇒ a qualificação do titular termina ali.
  const aposDocumento = posicao + achado[0].length - inicioBloco;
  const depois = resto.slice(aposDocumento, fim);
  const papel = primeiroPapel(depois);
  if (papel) {
    if (!abreOutraPessoa(depois, papel, titular, canonico)) return incerto;
    fim = aposDocumento + papel.index;
  }
  return { papel: "CONTRATANTE", cpfs: cpfsAte(resto, fim) };
}

/**
 * Qualificação do contratante depois da leitura (R2-7): documento da contratada nunca vira o do cliente; o papel de cada
 * documento é conferido no texto importado (fora da qualificação do contratante ⇒ pede confirmação e não define o
 * tipo); mais de um CPF na qualificação ⇒ ambíguo, o operador digita o certo; o tipo de pessoa sai só do documento
 * VALIDADO e comprovado (CPF ⇒ PF, CNPJ ⇒ PJ; os dois ou nenhum ⇒ o usuário escolhe); o celular único vira WhatsApp
 * sugerido, sempre com confirmação.
 */
function qualificar(campos: Map<string, CampoExtraido>, lida: ExtracaoLida, documentoContratada: string | null, paginas: readonly string[]) {
  const canonico = (v: string) => v.toUpperCase().replace(/[^0-9A-Z]/g, "");
  // Documento da contratada: o lido no contrato e o do modelo publicado da empresa.
  const daContratada = new Set([lida.contratada.documento.valor, documentoContratada].filter((v): v is string => !!v).map(canonico).filter((v) => v.length >= 11));
  const mesmoDocumento = (valor: string | null | undefined) => !!valor && daContratada.has(canonico(valor));
  for (const id of ["contratante.cpf", "contratante.cnpj"]) {
    const c = campos.get(id)!;
    if (mesmoDocumento(c.bruto)) campos.set(id, { ...c, bloqueio: "Este é o documento da contratada (a empresa), não do cliente. Corrija ou remova." });
  }
  const comprovados = new Set<string>();
  for (const id of ["contratante.cpf", "contratante.cnpj"]) {
    const c = campos.get(id)!;
    if (!c.bruto || c.bloqueio) continue;
    const q = qualificacaoNoTexto(c, paginas, campos.get("contratante.nome")?.bruto ?? "");
    if (id === "contratante.cpf" && q.cpfs.length > 1) {
      campos.set(id, { ...c, ambiguo: true, bloqueio: `Há mais de um CPF na qualificação do contratante (${q.cpfs.map(formatarCpf).join(" e ")}). Digite o CPF do contratante.` });
    } else if (q.papel === "CONTRATANTE") comprovados.add(id);
    else campos.set(id, { ...c, inferido: q.papel === "OUTRO"
      ? "Este documento aparece junto do representante ou de outra parte no contrato. Confirme se é do contratante."
      : "Não foi possível comprovar no contrato que este documento é do contratante. Confirme de quem é." });
  }
  const valido = (id: string, f: (t: string) => Validacao<string>) => { const c = campos.get(id)!; return c.bruto && !c.bloqueio && comprovados.has(id) && f(c.bruto).ok ? c : null; };
  const cpf = valido("contratante.cpf", validarCpf);
  const cnpj = valido("contratante.cnpj", validarCnpj);
  const tipo = campos.get("contratante.tipoPessoa")!;
  const doc = cpf && !cnpj ? { c: cpf, rotulo: ROTULO_TIPO_PESSOA.PF, origem: "Definido pelo CPF lido" } : cnpj && !cpf ? { c: cnpj, rotulo: ROTULO_TIPO_PESSOA.PJ, origem: "Definido pelo CNPJ lido" } : null;
  if (doc) campos.set(tipo.id, { ...tipo, valor: doc.rotulo, bruto: doc.rotulo, estado: "PRECISA_REVISAO", motivo: undefined, origem: doc.origem, ...(doc.c.evidencia ? { evidencia: doc.c.evidencia } : {}) });
  else if (cpf && cnpj) campos.set(tipo.id, { ...tipo, motivo: "Há CPF e CNPJ no contratante. Informe se é pessoa física ou jurídica." });
  const whatsapp = campos.get("contratante.whatsapp")!;
  const telefone = campos.get("contratante.telefone")!;
  if (!whatsapp.bruto && telefone.bruto && validarTelefone(telefone.bruto).ok && celular(telefone.bruto)) {
    campos.set(whatsapp.id, { ...telefone, id: whatsapp.id, rotulo: whatsapp.rotulo, inferido: "Mesmo número do telefone (celular). Confirme se é o WhatsApp do cliente." });
  }
  // Endereço lido só por extenso: as partes são sugeridas a partir dele (mesma evidência) e cada uma pede confirmação.
  const endereco = campos.get("contratante.endereco")!;
  const ids = ["logradouro", "numero", "complemento", "bairro", "cidade", "uf"] as const;
  const partes = endereco.bruto && ids.every((k) => !campos.get(`contratante.${k}`)!.bruto) ? decomporEndereco(endereco.bruto) : null;
  if (partes) for (const k of ids) {
    const valor = partes[k];
    if (!valor) continue;
    const atual = campos.get(`contratante.${k}`)!;
    campos.set(atual.id, { ...endereco, id: atual.id, rotulo: atual.rotulo, valor, bruto: valor, inferido: "Separado do endereço lido no contrato. Confirme ou corrija." });
  }
}

/** Leitura pelo modelo da empresa: preenche o que faltou ou fica ao lado como alternativa (divergente ⇒ revisão). */
function aplicarModelo(campos: Map<string, CampoExtraido>, porModelo: Readonly<Record<string, CampoLido>>, paginas: readonly string[]) {
  for (const [id, lido] of Object.entries(porModelo)) {
    const atual = campos.get(id);
    const d = DEFINICAO.get(id);
    if (!atual || !d || !lido.valor || !lido.trecho) continue;
    if (!atual.bruto) {
      const novo = campoLido(d, lido, paginas);
      campos.set(id, { ...novo, origem: `${novo.origem ?? "Documento"} · pelo modelo da empresa` });
    } else {
      campos.set(id, { ...atual, alternativa: { valor: lido.valor, pagina: lido.pagina, trecho: lido.trecho.slice(0, 280) } });
    }
  }
}

export function montarRevisao(lida: ExtracaoLida, paginas: readonly string[], arquivo: ArquivoSelecionado, opcoes: OpcoesRevisao = {}): ExtracaoContrato {
  const campos = new Map<string, CampoExtraido>();
  for (const secao of SECOES) for (const d of secao.campos) campos.set(d.id, campoLido(d, d.ler(lida), paginas));
  if (opcoes.porModelo) aplicarModelo(campos, opcoes.porModelo, paginas);
  qualificar(campos, lida, opcoes.documentoContratada ?? null, paginas);
  for (const parcela of lida.pagamentoPrevisto.parcelas) {
    const valor = parcela.valor.valor && parcela.vencimento.valor ? `${parcela.valor.valor} em ${parcela.vencimento.valor}` : parcela.valor.valor ?? parcela.vencimento.valor;
    const lido: CampoLido = { valor, pagina: parcela.valor.pagina ?? parcela.vencimento.pagina, trecho: parcela.valor.trecho ?? parcela.vencimento.trecho };
    const id = `pagamentos.parcela_${parcela.numero}`;
    // Evidência da parcela: valor por igualdade monetária e vencimento pelo parser de data, cada um no seu trecho.
    const localValor = localizarEvidencia(parcela.valor, paginas, "valor");
    const localVencimento = localizarEvidencia(parcela.vencimento, paginas, "data");
    campos.set(id, campoLido({ id, rotulo: `Parcela ${parcela.numero} prevista`, tipo: "parcela", ausente: "" }, lido, paginas, localValor && localVencimento ? localValor : null));
  }
  const parcelas = [...campos.values()].filter((c) => PARCELA.test(c.id));
  const secoes: SecaoRevisao[] = SECOES.map((s) => ({
    id: s.id,
    titulo: s.titulo,
    ...(s.nota ? { nota: s.nota } : {}),
    campos: [
      ...s.campos.map((d) => campos.get(d.id)!),
      ...(s.id === "pagamentos" ? [
        ...parcelas,
        { id: "pagamentos.realizados", rotulo: "Pagamentos já realizados", valor: null, estado: "NAO_ENCONTRADO" as const, motivo: "O contrato mostra só o combinado. Recebimentos não são inferidos: confirme no Financeiro." },
      ] : []),
    ],
  }));
  const recebimentosDocumento = lerRecebimentos(paginas);
  const realizados = secoes.find(s => s.id === "pagamentos")!.campos.find(c => c.id === "pagamentos.realizados")!;
  if (recebimentosDocumento.recebimentos.length) {
    realizados.valor = recebimentosDocumento.recebimentos.map(r => `${reais(r.valorCentavos)} em ${dataBr(r.data)} por ${r.forma} (página ${r.pagina})`).join("; ");
    realizados.estado = "ENCONTRADO";
    realizados.motivo = "Recebimentos explícitos no documento. Confira na revisão final; nada foi lançado no Financeiro.";
  }
  if (recebimentosDocumento.pendencias.length) realizados.motivo = recebimentosDocumento.pendencias.join(" ");
  const base: ExtracaoContrato = { fonte: "DOCUMENTO", arquivo, secoes, recebimentosDocumento, versaoLeitura: SCHEMA_VERSAO, modeloReferencia: opcoes.modeloReferencia ?? null };
  return comCampos(base, reavaliar(secoes.flatMap((s) => s.campos)).campos);
}

// ---------------------------------------------------------------- leitura normalizada (para o plano)

export type EnderecoLido = { texto: string | null; cep: string | null; logradouro: string | null; numero: string | null; complemento: string | null; bairro: string | null; cidade: string | null; uf: string | null };

export type DadosNormalizados = {
  contratante: {
    nome: string | null; cpf: string | null; telefone: string | null; whatsapp: string | null; email: string | null;
    /** null = não resolvido (v2) ou revisão v1 sem o campo. Quem decide o legado é o plano, pela versão da leitura. */
    tipoPessoa: TipoPessoa | null; cnpj: string | null; rg: string | null; representanteNome: string | null; representanteCpf: string | null;
    endereco: EnderecoLido;
  };
  evento: { data: string | null; horario: { inicio: string; fim: string | null } | null; duracaoMinutos: number | null; aniversariante: string | null; /** Só na leitura v2; snapshots gravados antes não têm. */ nascimento?: string | null; idade: number | null; convidados: number | null; tema: string | null };
  pacote: { nome: string | null; duracaoMinutos: number | null; quantidade: number | null; itens: string | null };
  buffet: { itens: string | null; observacoes: string | null; restricoes: string | null };
  valores: { preco: number | null; adicionais: number | null; total: number | null };
  pagamentos: { condicao: string | null; entrada: { valor: number; vencimento: string | null } | null; parcelas: Array<{ numero: number; valor: number; vencimento: string | null }> };
  observacoes: string | null;
};

/** Valor utilizável do campo: o normalizado aceito (importação real) ou o exibido (demonstração). */
function utilizavel(c: CampoExtraido | undefined): string | null {
  if (!c) return null;
  if (c.validacao) return FALHAS.has(c.validacao) ? null : c.normalizado ?? null;
  return c.valor;
}

/**
 * Relê os valores aceitos com os mesmos validadores. Campo recusado ⇒ null aqui, mas nunca some em
 * silêncio: o plano bloqueia enquanto houver campo com validação recusada (ver `pendenciasDeValidacao`).
 */
export function dadosNormalizados(campos: readonly CampoExtraido[]): DadosNormalizados {
  const porId = new Map(campos.map((c) => [c.id, c]));
  const texto = (id: string) => utilizavel(porId.get(id));
  const com = <T>(id: string, f: (v: string) => Validacao<T>): T | null => { const v = texto(id); if (!v) return null; const r = f(v); return r.ok ? r.valor : null; };
  const inteiro = (id: string, max: number) => com(id, (v) => validarInteiro(v, id === "evento.idade" ? 0 : 1, max, id));
  const entradaValor = com("pagamentos.entrada", validarValor);
  const parcelas = campos.filter((c) => PARCELA.test(c.id)).map((c) => {
    const v = utilizavel(c);
    const p = v ? validarParcela(v) : null;
    return p?.ok ? { numero: Number(c.id.split("_")[1]), valor: p.valor.valor, vencimento: p.valor.vencimento } : null;
  }).filter((p): p is { numero: number; valor: number; vencimento: string } => p !== null).sort((a, b) => a.numero - b.numero);
  return {
    contratante: {
      nome: texto("contratante.nome"), cpf: com("contratante.cpf", validarCpf), telefone: com("contratante.telefone", validarTelefone), whatsapp: com("contratante.whatsapp", validarTelefone), email: com("contratante.email", validarEmail),
      tipoPessoa: tipoPessoaDe(texto("contratante.tipoPessoa")), cnpj: com("contratante.cnpj", validarCnpj), rg: texto("contratante.rg"),
      representanteNome: texto("contratante.representanteNome"), representanteCpf: com("contratante.representanteCpf", validarCpf),
      endereco: {
        texto: texto("contratante.endereco"), cep: com("contratante.cep", validarCep), logradouro: texto("contratante.logradouro"), numero: texto("contratante.numero"),
        complemento: texto("contratante.complemento"), bairro: texto("contratante.bairro"), cidade: texto("contratante.cidade"), uf: com("contratante.uf", validarUf),
      },
    },
    evento: { data: com("evento.data", validarData), horario: com("evento.horario", validarHorario), duracaoMinutos: com("evento.duracao", validarDuracao), aniversariante: texto("evento.aniversariante"), nascimento: com("evento.nascimento", validarData), idade: inteiro("evento.idade", 120), convidados: inteiro("evento.convidados", 10000), tema: texto("evento.tema") },
    pacote: { nome: texto("pacote.nome"), duracaoMinutos: com("pacote.duracao", validarDuracao), quantidade: inteiro("pacote.quantidade", 10000), itens: texto("pacote.itens") },
    buffet: { itens: texto("buffet.itens"), observacoes: texto("buffet.observacoes"), restricoes: texto("buffet.restricoes") },
    valores: { preco: com("valores.preco", validarValor), adicionais: com("valores.adicionais", validarValor), total: com("valores.total", validarValor) },
    pagamentos: { condicao: texto("pagamentos.condicao"), entrada: entradaValor == null ? null : { valor: entradaValor, vencimento: com("pagamentos.entradaVencimento", validarData) }, parcelas },
    observacoes: texto("observacoes.gerais"),
  };
}

/** Campos com valor lido e validação recusada: bloqueiam o plano até correção ou remoção explícita. */
export function pendenciasDeValidacao(campos: readonly CampoExtraido[]): CampoExtraido[] {
  return campos.filter((c) => c.bruto != null && c.validacao !== undefined && FALHAS.has(c.validacao));
}

// ---------------------------------------------------------------- revisão humana

export type RevisaoCampo = { campoId: string; valor?: string; confirmarDivergencia?: boolean; limparEndereco?: boolean };

export const CAMPOS_ENDERECO_LIDO = ["contratante.endereco", "contratante.cep", "contratante.logradouro", "contratante.numero", "contratante.complemento", "contratante.bairro", "contratante.cidade", "contratante.uf"] as const;

/**
 * Revisão gravada antes da leitura v2 (31/10/2026): os campos novos entram como "Não lido nesta versão", sem valor
 * presumido e sem bruto (ficam fora da revalidação até o operador digitar). Correções, confirmações e evidências
 * gravadas não mudam, e ninguém precisa reprocessar o documento.
 */
export function completarRevisao(extracao: ExtracaoContrato): ExtracaoContrato {
  if (extracao.versaoLeitura || extracao.fonte !== "DOCUMENTO") return extracao;
  const naoLido = (d: { id: string; rotulo: string }): CampoExtraido => ({ id: d.id, rotulo: d.rotulo, valor: null, estado: "NAO_ENCONTRADO", motivo: "Não lido nesta versão da leitura. Pode ser informado aqui." });
  const existentes = new Set(extracao.secoes.flatMap((s) => s.campos.map((c) => c.id)));
  const secoes = SECOES.flatMap((def): SecaoRevisao[] => {
    const gravada = extracao.secoes.find((s) => s.id === def.id);
    const novos = def.campos.filter((d) => !existentes.has(d.id)).map(naoLido);
    if (!gravada) return novos.length ? [{ id: def.id, titulo: def.titulo, ...(def.nota ? { nota: def.nota } : {}), campos: novos }] : [];
    return [{ ...gravada, campos: [...gravada.campos, ...novos] }];
  });
  return { ...extracao, secoes };
}

/**
 * Revisão humana de um campo, sempre seguida de revalidação completa:
 * - `valor` informado: passa pelo mesmo validador; recusado ⇒ erro, nada muda. Vazio ⇒ remoção explícita.
 * - sem `valor` (confirmar): só para campo "Precisa revisão" com valor ACEITO. Valor recusado
 *   (inválido/ambíguo/não representável) nunca é "confirmado": tem de ser corrigido ou removido.
 *   Conflito entre campos exige `confirmarDivergencia` ("confirmo que o contrato histórico contém este
 *   valor divergente"), que é diferente de aceitar uma conversão: conversão é o operador digitar o valor.
 */
export function aplicarRevisao(extracao: ExtracaoContrato, _revisados: readonly string[], revisao: RevisaoCampo): { extracao: ExtracaoContrato; revisados: string[] } | { erro: string } {
  const campos = reavaliar(extracao.secoes.flatMap((s) => s.campos)).campos;
  if (revisao.limparEndereco) {
    // "Deixar sem endereço": ação explícita do operador; o texto lido continua na evidência registrada da extração.
    const limpos = campos.map((c): CampoExtraido => ((CAMPOS_ENDERECO_LIDO as readonly string[]).includes(c.id)
      ? { ...c, valor: null, bruto: null, normalizado: null, validacao: undefined, conflito: undefined, confirmacao: undefined, estado: "NAO_ENCONTRADO", motivo: "Deixado sem endereço na revisão.", origem: INFORMADO, alternativa: undefined, inferido: undefined, bloqueio: undefined, ambiguo: undefined }
      : c));
    const resultado = reavaliar(limpos);
    return { extracao: comCampos(extracao, resultado.campos), revisados: resultado.revisados };
  }
  const atual = campos.find((c) => c.id === revisao.campoId);
  if (!atual || atual.id === "pagamentos.realizados") return { erro: "Campo não pode ser revisado." };
  let novo: CampoExtraido;
  if (revisao.valor !== undefined) {
    const tipo = tipoDoCampo(atual.id);
    if (!tipo) return { erro: "Campo não pode ser revisado." };
    const texto = revisao.valor.trim();
    if (!texto) {
      novo = { ...atual, valor: null, bruto: null, normalizado: null, validacao: undefined, conflito: undefined, confirmacao: undefined, estado: "NAO_ENCONTRADO", motivo: "Removido na revisão.", origem: INFORMADO, evidencia: undefined, alternativa: undefined, inferido: undefined, bloqueio: undefined, ambiguo: undefined };
    } else {
      const validado = validarPorTipo(tipo, texto);
      if (!validado.ok) return { erro: validado.motivo };
      novo = { ...atual, valor: validado.valor, bruto: texto, normalizado: validado.valor, validacao: "VALIDO", conflito: undefined, confirmacao: undefined, motivo: undefined, origem: INFORMADO, evidencia: undefined, alternativa: undefined, inferido: undefined, bloqueio: undefined, ambiguo: undefined };
    }
  } else {
    if (atual.estado !== "PRECISA_REVISAO") return { erro: "Só campos marcados como \"Precisa revisão\" são confirmados." };
    if (atual.validacao && FALHAS.has(atual.validacao)) return { erro: "Este valor não pode ser confirmado como está. Corrija ou remova." };
    if (atual.conflito && !revisao.confirmarDivergencia) return { erro: "Confirme que o contrato histórico contém este valor divergente, ou corrija o valor." };
    novo = { ...atual, confirmacao: { tipo: atual.conflito ? "DIVERGENCIA" : "LEITURA", assinatura: assinaturaAtual(atual) } };
  }
  const resultado = reavaliar(campos.map((c) => (c.id === atual.id ? novo : c)));
  return { extracao: comCampos(extracao, resultado.campos), revisados: resultado.revisados };
}
