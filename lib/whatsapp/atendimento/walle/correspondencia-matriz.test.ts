import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConfiguracaoAtendimento } from '../core.ts';
import { entenderPorRegras } from './entendimento.ts';
import { resolverWallE, type Composicao, type FontesWallE, type ItemAdicional } from './resolver.ts';
import type { Catalogos, ResultadoWallE } from './tipos.ts';

/**
 * Revisão de d590845 — conjunto INDEPENDENTE para procurar seleções indevidas de adicional de decoração.
 *
 * Cada item do catálogo sintético é descrito por METADADOS explícitos (modalidade, se é a unidade principal ou uma
 * unidade "a mais", e as características), não pelo nome; o resolver real (entendimento por regras + resolverWallE) roda
 * sobre a matriz e a resposta é conferida contra as invariantes:
 *  1. todo preço corresponde ao pedido completo e ao item consultado;
 *  2. inclusão da principal não comprova inclusão de outra unidade;
 *  3. sem correspondência única, nenhum preço ou inclusão é presumido (e a parte vai à equipe);
 *  4. cobertura incompleta não permite afirmar "todos os pacotes";
 *  5. (contraprova) havendo correspondência única e a fonte, não há encaminhamento desnecessário.
 * Matriz: principal inclusa × adicional; quantidade simples × segunda/outra/mais uma/a mais; característica ausente,
 * correspondente ou divergente (e a ordem dos qualificadores); combinação cadastrada × ausente; preço presente × ausente;
 * cobertura completa × incompleta; pergunta de valor × de inclusão; e duas referências na mesma mensagem.
 * Tudo sintético e em memória: nenhum banco, modelo ou provedor.
 */
type Meta = { id: string; nome: string; modalidade: 'INCLUSO' | 'EXTRA'; unidade: 'PRINCIPAL' | 'A_MAIS'; caracteristicas: string[] };
const M = (id: string, nome: string, modalidade: Meta['modalidade'], unidade: Meta['unidade'], caracteristicas: string[]): Meta => ({ id, nome, modalidade, unidade, caracteristicas });
const P_SIMPLES = M('p', 'Mesa temática', 'INCLUSO', 'PRINCIPAL', []);
const P_VIDRO = M('pv', 'Mesa temática de vidro', 'INCLUSO', 'PRINCIPAL', ['vidro']);
const E_SIMPLES = M('es', 'Mesa temática', 'EXTRA', 'PRINCIPAL', []);
const E_VIDRO = M('ev', 'Mesa temática de vidro', 'EXTRA', 'PRINCIPAL', ['vidro']);
const E_XL = M('exl', 'Mesa temática XL', 'EXTRA', 'PRINCIPAL', ['xl']);
const A_SIMPLES = M('as', 'Segunda mesa temática', 'EXTRA', 'A_MAIS', []);
const A_VIDRO = M('av', 'Segunda mesa temática de vidro', 'EXTRA', 'A_MAIS', ['vidro']);
const A_VIDRO_LED = M('avl', 'Outra mesa temática de vidro com LED', 'EXTRA', 'A_MAIS', ['vidro', 'led']);
const PRINCIPAIS: Meta[][] = [[], [P_SIMPLES], [P_VIDRO], [E_SIMPLES], [P_SIMPLES, E_VIDRO]];
const ADICIONAIS: Meta[][] = [[], [A_SIMPLES], [A_VIDRO], [A_SIMPLES, A_VIDRO], [A_VIDRO_LED], [E_XL]];
const QUANTIDADES: Array<{ qtd: boolean; forma: (item: string) => string }> = [
  { qtd: false, forma: (i) => `a ${i}` }, { qtd: true, forma: (i) => `uma segunda ${i}` }, { qtd: true, forma: (i) => `outra ${i}` },
  { qtd: true, forma: (i) => `mais uma ${i}` }, { qtd: true, forma: (i) => `uma ${i} a mais` },
];
const CARACTERISTICAS: Array<{ texto: string; c: string[] }> = [
  { texto: '', c: [] }, { texto: ' de vidro', c: ['vidro'] }, { texto: ' com LED', c: ['led'] }, { texto: ' XL', c: ['xl'] },
  { texto: ' de vidro com LED', c: ['vidro', 'led'] }, { texto: ' com LED de vidro', c: ['vidro', 'led'] },
];
type Pedido = { qtd: boolean; c: string[]; valor: boolean };
const iguais = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
/** Itens que satisfazem o pedido COMPLETO, pelos metadados (regra do produto, escrita aqui de forma independente). */
function satisfazem(itens: Meta[], p: Pedido): Meta[] {
  if (p.qtd) {
    const aMais = itens.filter((i) => i.unidade === 'A_MAIS' && iguais(i.caracteristicas, p.c));
    if (aMais.length) return aMais;
    // Outra unidade do próprio adicional só sem unidade desse tipo inclusa.
    if (itens.some((i) => i.modalidade === 'INCLUSO' && i.unidade === 'PRINCIPAL' && iguais(i.caracteristicas, p.c))) return [];
    return itens.filter((i) => i.modalidade === 'EXTRA' && i.unidade === 'PRINCIPAL' && iguais(i.caracteristicas, p.c));
  }
  const inclusos = itens.filter((i) => i.modalidade === 'INCLUSO' && i.unidade === 'PRINCIPAL' && iguais(i.caracteristicas, p.c));
  return inclusos.length ? inclusos : itens.filter((i) => i.modalidade === 'EXTRA' && i.unidade === 'PRINCIPAL' && iguais(i.caracteristicas, p.c));
}

const catalogos: Catalogos = {
  pacotes: [{ codigo: 'ESSENCIAL', nome: 'Essencial' }, { codigo: 'COMPLETA', nome: 'Completa' }, { codigo: 'PREMIUM', nome: 'Premium' }],
  unidades: [], unidadesAgenda: [], turnos: [{ codigo: 'TURNO_1', nome: 'Almoço', inicio: '11:00', fim: '15:00' }], perguntas: [], hoje: '2026-10-05',
};
const config: ConfiguracaoAtendimento = { ativo: true, nome: 'Buffet sintético', perguntas: [], limites: { respostasPor24h: 20 } };
function fontes(itens: Meta[], comPreco: boolean, incompleta: boolean) {
  const consultas: string[] = [];
  const item = (m: Meta): ItemAdicional => ({ id: m.id, nome: m.nome, categoria: 'DECORACAO' });
  const comp: Composicao = { categorias: [], inclusos: itens.filter((i) => i.modalidade === 'INCLUSO').map(item), extras: itens.filter((i) => i.modalidade === 'EXTRA').map(item) };
  const f: FontesWallE = {
    async prontasAutorizadas() { return []; },
    async pacotes() { return catalogos.pacotes.map((p, k) => ({ id: `pk-${k}`, codigo: p.codigo, nome: p.nome, descricao: null, duracaoMinutos: 240, convidadosMinimos: 30, convidadosMaximos: 150 })); },
    async composicao(codigo) { return incompleta && codigo === 'ESSENCIAL' ? null : structuredClone(comp); },
    async preco() { return { erro: 'SOB_CONSULTA' as const, maximo: 0 }; },
    async disponibilidade() { return { periodos: [], escopo: { tipo: 'EMPRESA' as const } }; },
    async alternativas() { return []; },
    async linkContratoProprio() { return null; },
    async precoAdicional(id) { consultas.push(id); return comPreco ? { valor: 100 + id.length, unidade: 'VALOR_FIXO', faixa: null, tabela: 't-matriz' } : { erro: 'SEM_PRECO' as const }; },
  };
  return { f, consultas };
}
async function responder(texto: string, itens: Meta[], comPreco: boolean, incompleta: boolean) {
  const { f, consultas } = fontes(itens, comPreco, incompleta);
  const contexto = { apresentado: true };
  const r: ResultadoWallE = await resolverWallE({ texto, entendimento: entenderPorRegras(texto, catalogos, contexto), contexto, config, catalogos, agora: '2026-10-05T12:00:00.000Z' }, f);
  return { r, consultas, saida: r.saidas.map((s) => s.texto ?? '').join('\n') };
}
const comPrecoNomes = (saida: string) => [...saida.matchAll(/“([^”]+)” é adicional: R\$/g)].map((m) => m[1]);
const jaVemNomes = (saida: string) => [...saida.matchAll(/“([^”]+)” já vem/g)].map((m) => m[1]);
const porNome = (itens: Meta[], nome: string, modalidade: Meta['modalidade']) => itens.filter((i) => i.nome === nome && i.modalidade === modalidade);

/** Confere as invariantes para os pedidos de uma mensagem; devolve as violações (vazio = conforme). */
function violacoes(pedidos: Pedido[], itens: Meta[], comPreco: boolean, incompleta: boolean, res: Awaited<ReturnType<typeof responder>>): string[] {
  const v: string[] = [];
  const { r, consultas, saida } = res;
  const certos = pedidos.map((p) => satisfazem(itens, p));
  const unicos = certos.map((c) => (c.length === 1 ? c[0] : null));
  // 1. Preço: só de item EXTRA que satisfaz por inteiro um pedido de valor; a consulta e a fonte são desse item.
  const precosOk = new Set(pedidos.flatMap((p, k) => (p.valor && unicos[k]?.modalidade === 'EXTRA' ? [unicos[k]!.id] : [])));
  for (const id of consultas) if (!precosOk.has(id)) v.push(`1: consultou o preço de ${id}, que não corresponde ao pedido completo`);
  for (const nome of comPrecoNomes(saida)) if (!porNome(itens, nome, 'EXTRA').some((i) => precosOk.has(i.id))) v.push(`1: informou preço de “${nome}”, que não corresponde ao pedido`);
  for (const f of r.saidas.flatMap((s) => s.fontes)) if (f.tipo === 'PRECO_ADICIONAL' && !precosOk.has(f.id)) v.push(`1: fonte de preço ${f.id} não corresponde ao pedido`);
  // 2. Inclusão afirmada só de item INCLUSO que satisfaz o pedido (pedido de outra unidade exige unidade "a mais").
  const inclusosOk = new Set(pedidos.flatMap((_, k) => (unicos[k]?.modalidade === 'INCLUSO' ? [unicos[k]!.id] : [])));
  for (const nome of jaVemNomes(saida)) if (!porNome(itens, nome, 'INCLUSO').some((i) => inclusosOk.has(i.id))) v.push(`2: afirmou que “${nome}” já vem, sem corresponder ao pedido`);
  // 3. Sem correspondência única: nada presumido e a parte vai à equipe.
  if (unicos.some((u) => !u) && !r.passagem) v.push('3: pedido sem correspondência única e sem passagem à equipe');
  // 4. Cobertura incompleta.
  if (incompleta && /todos os pacotes/i.test(saida)) v.push('4: afirmou "todos os pacotes" com cobertura incompleta');
  if (incompleta && !r.passagem) v.push('4: cobertura incompleta sem passagem da lacuna');
  // 5. Contraprova: tudo correspondido e com fonte → sem encaminhamento desnecessário (e o preço pedido é dado).
  if (!incompleta && unicos.every((u, k) => u && (u.modalidade === 'INCLUSO' || comPreco || !pedidos[k].valor))) {
    if (r.passagem) v.push(`5: encaminhamento desnecessário (${r.passagem.motivo})`);
    for (const [k, p] of pedidos.entries()) if (p.valor && unicos[k]!.modalidade === 'EXTRA' && !comPrecoNomes(saida).includes(unicos[k]!.nome)) v.push(`5: não informou o preço de “${unicos[k]!.nome}” pedido`);
  }
  return v;
}

test('matriz independente — uma referência: principal × adicional, quantidade, característica, combinação, preço, cobertura, valor × inclusão', async () => {
  const falhas: string[] = [];
  let casos = 0;
  for (const principal of PRINCIPAIS) for (const adicionais of ADICIONAIS) {
    const itens = [...principal, ...adicionais];
    for (const comPreco of [true, false]) for (const incompleta of [false, true]) {
      if (incompleta && !comPreco) continue;
      for (const q of QUANTIDADES) for (const c of CARACTERISTICAS) for (const valor of [true, false]) {
        const item = `mesa temática${c.texto}`;
        const texto = valor ? `quanto custa ${q.forma(item)}?` : `${q.forma(item).replace(/^uma /, 'a ')} vem inclusa?`;
        const pedido: Pedido = { qtd: q.qtd, c: c.c, valor };
        const res = await responder(texto, itens, comPreco, incompleta);
        casos++;
        for (const x of violacoes([pedido], itens, comPreco, incompleta, res)) falhas.push(`«${texto}» [${itens.map((i) => `${i.nome}/${i.modalidade}`).join(', ') || 'sem mesa'}; preço ${comPreco ? 'sim' : 'não'}; cobertura ${incompleta ? 'incompleta' : 'completa'}] → ${x}`);
      }
    }
  }
  assert.ok(casos >= 3000, `matriz com ${casos} casos`);
  const porInvariante = falhas.reduce<Record<string, number>>((n, x) => { const k = (x.match(/→ (\d):/) ?? [])[1] ?? "?"; n[k] = (n[k] ?? 0) + 1; return n; }, {});
  console.log(`MATRIZ ${casos} casos; violações por invariante: ${JSON.stringify(porInvariante)}`);
  // MATRIZ_DETALHE=1: lista todas as violações (para as provas de antes/depois).
  if (process.env.MATRIZ_DETALHE) for (const x of falhas) console.log(`VIOLACAO ${x}`);
  assert.deepEqual(falhas.slice(0, 15), [], `${falhas.length} violações em ${casos} casos`);
});

test('matriz independente — duas referências na mesma mensagem, nas duas ordens', async () => {
  const falhas: string[] = [];
  let casos = 0;
  for (const principal of PRINCIPAIS) for (const adicionais of ADICIONAIS) {
    const itens = [...principal, ...adicionais];
    for (const c1 of CARACTERISTICAS.slice(0, 3)) for (const c2 of CARACTERISTICAS.slice(0, 3)) for (const inverter of [false, true]) {
      const inclusa = `A mesa temática${c1.texto} está inclusa?`;
      const segunda = `Quanto custa uma segunda mesa temática${c2.texto}?`;
      const texto = inverter ? `${segunda} ${inclusa}` : `${inclusa} ${segunda}`;
      const pedidos: Pedido[] = [{ qtd: false, c: c1.c, valor: false }, { qtd: true, c: c2.c, valor: true }];
      const res = await responder(texto, itens, true, false);
      casos++;
      for (const x of violacoes(pedidos, itens, true, false, res)) falhas.push(`«${texto}» [${itens.map((i) => `${i.nome}/${i.modalidade}`).join(', ') || 'sem mesa'}] → ${x}`);
    }
  }
  assert.ok(casos >= 500, `matriz com ${casos} casos`);
  const porInvariante = falhas.reduce<Record<string, number>>((n, x) => { const k = (x.match(/→ (\d):/) ?? [])[1] ?? "?"; n[k] = (n[k] ?? 0) + 1; return n; }, {});
  console.log(`MATRIZ ${casos} casos; violações por invariante: ${JSON.stringify(porInvariante)}`);
  // MATRIZ_DETALHE=1: lista todas as violações (para as provas de antes/depois).
  if (process.env.MATRIZ_DETALHE) for (const x of falhas) console.log(`VIOLACAO ${x}`);
  assert.deepEqual(falhas.slice(0, 15), [], `${falhas.length} violações em ${casos} casos`);
});
