/**
 * Texto das mensagens automáticas: só três marcadores conhecidos; o resto é texto literal (sem HTML, sem IA).
 * Toda mensagem precisa dizer como parar ("PARAR"); o texto é revisado por uma pessoa antes de a regra ser ativada.
 */
export const MARCADORES = ["nome", "buffet", "data_festa"] as const;
export type Marcador = (typeof MARCADORES)[number];

export function validarModelo(texto: string): string[] {
  const problemas: string[] = [];
  const t = texto.trim();
  if (t.length < 10) problemas.push("Mensagem curta demais.");
  if (t.length > 1000) problemas.push("Mensagem com mais de 1000 caracteres.");
  for (const [, nome] of t.matchAll(/\{\{\s*([^}]*)\s*\}\}/g)) {
    if (!(MARCADORES as readonly string[]).includes(nome.trim())) problemas.push(`Marcador desconhecido: {{${nome.trim()}}}. Use {{nome}}, {{buffet}} ou {{data_festa}}.`);
  }
  if (/\{\{|\}\}/.test(t.replace(/\{\{\s*[^}]*\s*\}\}/g, ""))) problemas.push("Marcador mal fechado.");
  if (!/\bPARAR\b/.test(t)) problemas.push("Inclua como deixar de receber (ex.: “Responda PARAR para não receber mais mensagens”).");
  return problemas;
}

/**
 * Texto da pesquisa de satisfação (inicial e lembrete): os três marcadores e `{{link_pesquisa}}`, que é obrigatório.
 * Com WhatsApp entre os canais, o texto também precisa dizer como parar (PARAR), como toda mensagem.
 */
export function validarModeloPesquisa(texto: string, opcoes: { whatsapp: boolean }): string[] {
  const links = (texto.match(/\{\{\s*link_pesquisa\s*\}\}/g) ?? []).length;
  const problemas = validarModelo(texto.replace(/\{\{\s*link_pesquisa\s*\}\}/g, " "))
    .filter((p) => opcoes.whatsapp || !p.startsWith("Inclua como deixar de receber"));
  if (links === 0) problemas.push("Inclua {{link_pesquisa}} no texto da pesquisa.");
  if (links > 1) problemas.push("Use {{link_pesquisa}} uma vez só.");
  return problemas;
}

export function primeiroNome(nomeCompleto: string) {
  return nomeCompleto.trim().split(/\s+/)[0] ?? "";
}

export function renderizarModelo(texto: string, valores: { nome: string; buffet: string; dataFesta: string | null; linkPesquisa?: string }) {
  const data = valores.dataFesta ? valores.dataFesta.split("-").reverse().join("/") : "sua festa";
  return texto
    // Pesquisa: o link (ou o marcador gravado no lugar dele) é inserido por função, como os outros valores.
    .replace(/\{\{\s*link_pesquisa\s*\}\}/g, () => valores.linkPesquisa ?? "")
    // Substituição por função: nome ou buffet com "$'"/"$&" não podem virar padrões de String.replace.
    .replace(/\{\{\s*nome\s*\}\}/g, () => primeiroNome(valores.nome))
    .replace(/\{\{\s*buffet\s*\}\}/g, () => valores.buffet)
    .replace(/\{\{\s*data_festa\s*\}\}/g, () => data)
    .slice(0, 1200);
}

/** Destinatário exibido/gravado sem o número completo. */
export function mascararTelefone(digitos: string | null) {
  if (!digitos) return "";
  return digitos.length <= 4 ? "****" : `${"*".repeat(Math.max(0, digitos.length - 4))}${digitos.slice(-4)}`;
}
