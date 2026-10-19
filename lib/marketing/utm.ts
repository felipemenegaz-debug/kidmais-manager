/**
 * Links de campanha e captura de UTM.
 *
 * Link gerado: <base>/s/<site>/c/<código da campanha>. O servidor registra o CLIQUE (evento próprio) e redireciona para
 * a página do site com utm_source/utm_medium/utm_campaign e `kc` (identificador estável da campanha). Só `kc` decide a
 * campanha, e só se for de uma campanha da MESMA empresa do site, ativa no dia; UTM solta (sem `kc` válido) é guardada
 * como informação, nunca vira atribuição automática.
 *
 * Valores aceitos: minúsculas, dígitos, ponto, hífen e sublinhado (até 60). Qualquer outro valor é DESCARTADO (nem
 * gravado, nem refletido na página). Parâmetro repetido conta como inválido (ambíguo).
 */
export const UTM_VALOR = /^[a-z0-9][a-z0-9._-]{0,59}$/;
export const CODIGO_CAMPANHA = /^[a-z0-9][a-z0-9-]{2,46}[a-z0-9]$/;
export const CAMPOS_UTM = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"] as const;
export type CampoUtm = (typeof CAMPOS_UTM)[number];
export type Utm = Partial<Record<CampoUtm, string>>;
export type CapturaCampanha = { codigoCampanha: string | null; utm: Utm; descartados: string[] };

type Parametros = URLSearchParams | Record<string, string | string[] | undefined>;

function valores(parametros: Parametros, chave: string): string[] {
  if (parametros instanceof URLSearchParams) return parametros.getAll(chave);
  const v = parametros[chave];
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

export function normalizarValorUtm(valor: string) {
  return valor.trim().toLowerCase();
}

/** Lê UTM e `kc` de query string (página) ou do corpo do formulário. Nunca lança. */
export function capturarCampanha(parametros: Parametros): CapturaCampanha {
  const utm: Utm = {};
  const descartados: string[] = [];
  for (const campo of CAMPOS_UTM) {
    const lista = valores(parametros, campo);
    if (lista.length === 0) continue;
    const valor = lista.length === 1 ? normalizarValorUtm(lista[0] ?? "") : "";
    if (lista.length === 1 && UTM_VALOR.test(valor)) utm[campo] = valor;
    else descartados.push(campo);
  }
  const kcs = valores(parametros, "kc");
  let codigoCampanha: string | null = null;
  if (kcs.length === 1 && CODIGO_CAMPANHA.test(normalizarValorUtm(kcs[0] ?? ""))) codigoCampanha = normalizarValorUtm(kcs[0] ?? "");
  else if (kcs.length > 0) descartados.push("kc");
  return { codigoCampanha, utm, descartados };
}

/** Código estável a partir do nome (sugestão; a pessoa pode trocar antes de criar; depois é imutável). */
export function sugerirCodigoCampanha(nome: string, sufixo: string) {
  const base = nome.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 38);
  const codigo = `${base || "campanha"}-${sufixo}`.replace(/-+/g, "-").slice(0, 48).replace(/-+$/, "");
  return CODIGO_CAMPANHA.test(codigo) ? codigo : `campanha-${sufixo}`;
}

export type CampanhaParaLink = { codigo: string; utmSource: string; utmMedium: string };

/** Endereço que a campanha divulga (passa pelo registro de clique). */
export function linkRastreavel(baseSite: string, campanha: Pick<CampanhaParaLink, "codigo">) {
  return `${baseSite.replace(/\/+$/, "")}/c/${encodeURIComponent(campanha.codigo)}`;
}

/** Destino do redirecionamento depois do clique: página do site com UTM e `kc`. */
export function destinoComUtm(baseSite: string, campanha: CampanhaParaLink) {
  const url = new URL(`${baseSite.replace(/\/+$/, "")}/`);
  url.searchParams.set("utm_source", campanha.utmSource);
  url.searchParams.set("utm_medium", campanha.utmMedium);
  url.searchParams.set("utm_campaign", campanha.codigo);
  url.searchParams.set("kc", campanha.codigo);
  return url;
}

/** Campanha atende no dia (America/Sao_Paulo): ATIVA e dentro do período. */
export function campanhaVigente(c: { status: string; inicio: string; fim: string | null }, hojeIso: string) {
  return c.status === "ATIVA" && c.inicio <= hojeIso && (c.fim === null || c.fim >= hojeIso);
}

export function hojeSaoPaulo(agora: Date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit" }).format(agora);
}
