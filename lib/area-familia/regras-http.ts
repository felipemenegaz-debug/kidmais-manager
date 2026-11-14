/**
 * Regras puras da borda HTTP da área "Minha festa" (sem Next nem banco), testadas em area-familia.test.ts.
 * lib/area-familia/http.ts reexporta tudo.
 */
export function areaFamiliaLigada(env: Record<string, string | undefined> = process.env) {
  return env.AREA_FAMILIA_ENABLED === "true";
}

export function origemPublicaValida(request: Request, env: Record<string, string | undefined> = process.env) {
  const configurada = env.AREA_FAMILIA_PUBLIC_ORIGIN || env.ADMIN_AUTH_ORIGIN;
  if (!configurada) return false;
  let esperada: string;
  try { esperada = new URL(configurada).origin; } catch { return false; }
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return false;
  return request.headers.get("origin") === esperada;
}

export async function lerCorpoJson(request: Request): Promise<unknown | null> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return null;
  const texto = await request.text();
  if (texto.length > 4096) return null;
  try { return JSON.parse(texto) as unknown; } catch { return null; }
}

export function pepperIdentidade(env: Record<string, string | undefined> = process.env) {
  const pepper = env.IDENTIDADE_OTP_PEPPER;
  return pepper && pepper.trim().length >= 16 ? pepper : null;
}
