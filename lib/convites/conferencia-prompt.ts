// Conferência conservadora de informações explícitas; não interpreta todo texto livre.
type Dados = { nome: string; idade: string };
const normal = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').trim().toLowerCase().replace(/\s+/g, ' ');
function mencoes(prompt: string) {
  const nomes = [...prompt.matchAll(/(?:anivers[aá]rio\s+(?:da|do|de)|nome\s*:)\s*([\p{L}][\p{L}\s'-]*?)(?=\s+(?:de\s+)?\d+\s+anos?\b|\s+(?:dia|em|na|no|com|que)\b|[,.;\n]|$)/giu)];
  const curtos = [...prompt.matchAll(/\b(?:da|do)\s+([\p{L}][\p{L}'-]*(?:\s+(?!(?:da|do|de)\b)[\p{L}][\p{L}'-]*)*)\s+(?:de\s+)?\d+\s+anos?\b/giu)];
  const idades = [...prompt.matchAll(/\b(\d{1,3})\s+anos?\b/gi)].map(m => m[1]);
  const diretos = [...prompt.matchAll(/(?<![\p{L}])([\p{Lu}][\p{L}'-]*(?:\s+[\p{Lu}][\p{L}'-]*)*)\s+(?:de\s+)?\d+\s+anos?\b/gu)];
  return { nomes: [...nomes, ...curtos, ...diretos], idades };
}
export function dadosNoPrompt(prompt: string) {
  const encontrados = mencoes(prompt);
  return { nomes: [...new Set(encontrados.nomes.map(m => m[1].trim()))], idades: [...new Set(encontrados.idades)] };
}
export function conferirPrompt(prompt: string, campos: Dados) {
  const { nomes, idades } = dadosNoPrompt(prompt);
  return { nomes, idades, conflito: nomes.some(n => normal(n) !== normal(campos.nome)) || idades.some(i => Number(i) !== Number(campos.idade.match(/\d+/)?.[0] ?? NaN)), ambiguo: new Set(nomes.map(normal)).size > 1 || idades.length > 1 };
}
export function alinharPrompt(prompt: string, campos: Dados) {
  const spans = mencoes(prompt).nomes.map(m => ({ inicio: m.index! + m[0].lastIndexOf(m[1]), fim: m.index! + m[0].lastIndexOf(m[1]) + m[1].length }));
  const unicos = spans.filter((s, i) => !spans.some((o, j) => j !== i && o.inicio <= s.inicio && o.fim >= s.fim && (o.inicio < s.inicio || o.fim > s.fim || j < i))).sort((a,b) => b.inicio - a.inicio);
  let resultado = prompt;
  for (const s of unicos) resultado = resultado.slice(0,s.inicio) + campos.nome + resultado.slice(s.fim);
  const idade = campos.idade.match(/\d+/)?.[0];
  if (idade) resultado = resultado.replace(/\b\d{1,3}\s+anos?\b/gi, `${idade} ${Number(idade) === 1 ? 'ano' : 'anos'}`);
  return resultado;
}
