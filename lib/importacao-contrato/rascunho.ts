import { createHash } from "node:crypto";
import { localizarEvidencia, type CampoLido, type ExtracaoLida, type Localizacao } from "./extracao.ts";
import type { ArquivoSelecionado, CampoExtraido, EstadoValidacao, ExtracaoContrato, IdSecao, SecaoRevisao } from "./modelo.ts";
import {
  minutosEntre, parcelasConferem, somaConfere, validarCpf, validarData, validarDuracao, validarEmail, validarHorario,
  validarInteiro, validarParcela, validarTelefone, validarValor, type TipoCampo, type Validacao,
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
    case "cpf": return validarCpf(texto);
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
    { id: "contratante.nome", rotulo: "Nome", tipo: "texto", ler: (e) => e.contratante.nome, ausente: "Nome do contratante não localizado." },
    { id: "contratante.cpf", rotulo: "CPF", tipo: "cpf", ler: (e) => e.contratante.cpf, ausente: "CPF não localizado. Pode ser completado no cadastro." },
    { id: "contratante.telefone", rotulo: "Telefone", tipo: "telefone", ler: (e) => e.contratante.telefone, ausente: "Telefone não localizado." },
    { id: "contratante.whatsapp", rotulo: "WhatsApp", tipo: "telefone", ler: (e) => e.contratante.whatsapp, ausente: "WhatsApp não localizado." },
    { id: "contratante.email", rotulo: "E-mail", tipo: "email", ler: (e) => e.contratante.email, ausente: "E-mail não localizado. Pode ser completado depois." },
  ] },
  { id: "evento", titulo: "Evento", campos: [
    { id: "evento.data", rotulo: "Data", tipo: "data", ler: (e) => e.evento.data, ausente: "Data da festa não localizada." },
    { id: "evento.horario", rotulo: "Horário", tipo: "horario", ler: (e) => e.evento.horario, ausente: "Horário não localizado." },
    { id: "evento.duracao", rotulo: "Duração", tipo: "duracao", ler: (e) => e.evento.duracao, ausente: "Duração não localizada." },
    { id: "evento.aniversariante", rotulo: "Aniversariante", tipo: "texto", ler: (e) => e.evento.aniversariante, ausente: "Aniversariante não localizado." },
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
  return achados;
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
    const v = validarPorTipo(tipo, bruto);
    return v.ok
      ? { ...c, valor: v.valor, normalizado: v.valor, validacao: "VALIDO" }
      : { ...c, valor: bruto, normalizado: null, validacao: v.estado, motivo: `${v.motivo} Corrija ou remova o valor.` };
  });
  const achados = conflitos(validados);
  const revisados: string[] = [];
  const finais = validados.map((c): CampoExtraido => {
    if (c.bruto == null || !c.validacao) return c;
    if (FALHAS.has(c.validacao)) return { ...c, estado: "PRECISA_REVISAO", conflito: undefined, confirmacao: undefined };
    const conflito = achados.get(c.id);
    const informado = c.origem === INFORMADO;
    const semTrecho = !informado && !c.evidencia?.conferida;
    if (!conflito && !semTrecho) {
      return { ...c, estado: "ENCONTRADO", validacao: "VALIDO", motivo: undefined, conflito: undefined, confirmacao: undefined };
    }
    const tipo = conflito ? "DIVERGENCIA" : "LEITURA";
    const esperada = assinatura([c.normalizado, conflito ?? null, semTrecho ? "SEM_TRECHO" : null]);
    const confirmacao = c.confirmacao?.tipo === tipo && c.confirmacao.assinatura === esperada ? c.confirmacao : undefined;
    if (confirmacao) revisados.push(c.id);
    return {
      ...c,
      estado: "PRECISA_REVISAO",
      validacao: "PRECISA_REVISAO",
      conflito,
      motivo: conflito ?? "Trecho não localizado no documento. Confira a leitura.",
      confirmacao,
    };
  });
  return { campos: finais, revisados };
}

/** Assinatura esperada para confirmar o campo agora (mesma regra de `reavaliar`). */
function assinaturaAtual(c: CampoExtraido) {
  const semTrecho = c.origem !== INFORMADO && !c.evidencia?.conferida;
  return assinatura([c.normalizado ?? null, c.conflito ?? null, semTrecho ? "SEM_TRECHO" : null]);
}

function comCampos(extracao: ExtracaoContrato, campos: readonly CampoExtraido[]): ExtracaoContrato {
  const porId = new Map(campos.map((c) => [c.id, c]));
  return { ...extracao, secoes: extracao.secoes.map((s) => ({ ...s, campos: s.campos.map((c) => porId.get(c.id) ?? c) })) };
}

export function montarRevisao(lida: ExtracaoLida, paginas: readonly string[], arquivo: ArquivoSelecionado): ExtracaoContrato {
  const campos = new Map<string, CampoExtraido>();
  for (const secao of SECOES) for (const d of secao.campos) campos.set(d.id, campoLido(d, d.ler(lida), paginas));
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
  const base: ExtracaoContrato = { fonte: "DOCUMENTO", arquivo, secoes };
  return comCampos(base, reavaliar(secoes.flatMap((s) => s.campos)).campos);
}

// ---------------------------------------------------------------- leitura normalizada (para o plano)

export type DadosNormalizados = {
  contratante: { nome: string | null; cpf: string | null; telefone: string | null; whatsapp: string | null; email: string | null };
  evento: { data: string | null; horario: { inicio: string; fim: string | null } | null; duracaoMinutos: number | null; aniversariante: string | null; idade: number | null; convidados: number | null; tema: string | null };
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
    contratante: { nome: texto("contratante.nome"), cpf: com("contratante.cpf", validarCpf), telefone: com("contratante.telefone", validarTelefone), whatsapp: com("contratante.whatsapp", validarTelefone), email: com("contratante.email", validarEmail) },
    evento: { data: com("evento.data", validarData), horario: com("evento.horario", validarHorario), duracaoMinutos: com("evento.duracao", validarDuracao), aniversariante: texto("evento.aniversariante"), idade: inteiro("evento.idade", 120), convidados: inteiro("evento.convidados", 10000), tema: texto("evento.tema") },
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

export type RevisaoCampo = { campoId: string; valor?: string; confirmarDivergencia?: boolean };

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
  const atual = campos.find((c) => c.id === revisao.campoId);
  if (!atual || atual.id === "pagamentos.realizados") return { erro: "Campo não pode ser revisado." };
  let novo: CampoExtraido;
  if (revisao.valor !== undefined) {
    const tipo = tipoDoCampo(atual.id);
    if (!tipo) return { erro: "Campo não pode ser revisado." };
    const texto = revisao.valor.trim();
    if (!texto) {
      novo = { ...atual, valor: null, bruto: null, normalizado: null, validacao: undefined, conflito: undefined, confirmacao: undefined, estado: "NAO_ENCONTRADO", motivo: "Removido na revisão.", origem: INFORMADO, evidencia: undefined };
    } else {
      const validado = validarPorTipo(tipo, texto);
      if (!validado.ok) return { erro: validado.motivo };
      novo = { ...atual, valor: validado.valor, bruto: texto, normalizado: validado.valor, validacao: "VALIDO", conflito: undefined, confirmacao: undefined, motivo: undefined, origem: INFORMADO, evidencia: undefined };
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
