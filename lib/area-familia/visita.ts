// Área "Minha festa" F3: marcações desta visita (resultado das ações já gravadas, mostrado antes de os dados novos
// chegarem). Elas valem só sobre os dados do servidor em que foram feitas: quando router.refresh() traz dados novos, o
// servidor manda (ex.: o buffet devolveu uma pendência que a família marcou como feita, ou descartou um "já paguei").
// O link do segundo é a exceção, porque o servidor nunca devolve o token de novo: ele segue só enquanto for o link ativo
// do servidor (mesmo id). Link revogado, segundo removido ou outro segundo cadastrado: o id muda e o link não volta.

type ComSegundo = { acoes: { segundo?: { linkId: string | null } | null } } | null;

export type LinkDaVisita = { url: string; linkId: string };

export type MarcasDaVisita<D extends ComSegundo> = {
  de: D;
  feitas: string[];
  avisadas: string[];
  link: (LinkDaVisita & { de: D }) | null;
};

export type MarcasVigentes = { feitas: string[]; avisadas: string[]; link: string | null };

export function marcasIniciais<D extends ComSegundo>(dados: D): MarcasDaVisita<D> {
  return { de: dados, feitas: [], avisadas: [], link: null };
}

function linkVigente<D extends ComSegundo>(m: MarcasDaVisita<D>, dados: D): boolean {
  if (!m.link) return false;
  // Antes do refresh (mesmos dados) o servidor ainda não mostra o link novo; depois, só o mesmo id ativo vale.
  return m.link.de === dados || (dados?.acoes.segundo?.linkId ?? null) === m.link.linkId;
}

export function marcasVigentes<D extends ComSegundo>(m: MarcasDaVisita<D>, dados: D): MarcasVigentes {
  const mesmos = m.de === dados;
  return { feitas: mesmos ? m.feitas : [], avisadas: mesmos ? m.avisadas : [], link: linkVigente(m, dados) ? m.link!.url : null };
}

function sobre<D extends ComSegundo>(m: MarcasDaVisita<D>, dados: D): MarcasDaVisita<D> {
  const v = marcasVigentes(m, dados);
  return { de: dados, feitas: v.feitas, avisadas: v.avisadas, link: v.link ? m.link : null };
}

export function comMarca<D extends ComSegundo>(m: MarcasDaVisita<D>, dados: D, tipo: "feitas" | "avisadas", id: string): MarcasDaVisita<D> {
  const base = sobre(m, dados);
  return { ...base, [tipo]: [...base[tipo], id] };
}

/** Convite ou link novo (url e id do link) ou remoção (null). */
export function comLink<D extends ComSegundo>(m: MarcasDaVisita<D>, dados: D, novo: LinkDaVisita | null): MarcasDaVisita<D> {
  return { ...sobre(m, dados), link: novo ? { ...novo, de: dados } : null };
}
