import type { DbExecutor } from "../db/contracts.ts";
import type { EscopoAgenda } from "../disponibilidade/escopo.ts";
import { situacaoDosSaloesNoHorario, type SituacaoSalao } from "../disponibilidade/services/availability.service.ts";
import {
  EXCLUSIVOS, fraseConvivencia, GRUPOS_ITEM, idadeSugerida, NOMES_GRUPO, pendenciasPublicacao,
  type Exclusivo, type GrupoItem,
} from "./salao-apresentacao-regras.ts";
import { itensDosPacotesDoSalao, pacotesElegiveisDoSalao } from "./salao-pacotes.ts";
import { estadoCombinados } from "./estado-combinados.ts";
import { combinadosPublicos } from "./combinados-publicos.ts";
import { menorPreco, pacotesDaOfertaPublica, precoMinimo, precosPublicosDeHoje } from "../comercial/oferta-publica.ts";
import { pacoteComporta } from "../fechamentos/convidados-consulta.ts";

/**
 * S-D — "Conheça os salões" (plano S-E/S-D rev. 4.1, aprovado). Leitura PÚBLICA dos salões prontos de um escopo:
 *   * portões, nesta ordem e antes de qualquer dado ou byte (R-D3): flag SALOES_PUBLICOS → escopo da empresa → agenda
 *     POR_SALAO → 2 ou mais salões prontos → o salão pronto do escopo → (foto) a foto do salão, não removida.
 *     Qualquer falha devolve o mesmo "não publicado" (404 igual na rota);
 *   * "pronto" = ativo, da unidade do escopo (IS NOT DISTINCT FROM) e sem pendência de publicação (a declaração vigente
 *     é uma das pendências, 102);
 *   * DTO por lista branca: nunca ids de festa/ocupação, declaração, versão do conteúdo ou autor;
 *   * situação no horário pedido pelo Core da S-C/S-D (situacaoPorSalao), sem expor quem ocupa; recomendado calculado
 *     (menor livre que comporta; capacidade nula por último; desempate por ordem e id), nunca digitado.
 */

/** D-D1: a tela pública só existe com a flag ligada (desligada por padrão). */
export function saloesPublicosLigados(env: { SALOES_PUBLICOS?: string } = process.env as { SALOES_PUBLICOS?: string }) {
  return env.SALOES_PUBLICOS?.trim() === "true";
}

export class SalaoPublicoIndisponivel extends Error {
  readonly code = "SALOES_NAO_PUBLICADOS";
  readonly httpStatus = 404;
  constructor() { super("Não encontrado."); }
}
const naoPublicado = (): never => { throw new SalaoPublicoIndisponivel(); };

type LinhaPronta = {
  id: string; nome: string; ordem: number; capacidade_convidados: number | null; convidados_minimo: number | null;
  convidados_sentados: number | null; area_m2: number | null; idade_min: number | null; idade_max: number | null; frase: string | null;
  outra_festa_simultanea: boolean | null; exclusivos: string[]; fotos_referencia: string | null; fotos: number;
  conteudo_versao: number; declaracao_versao: number | null; ativo: boolean; combinado: boolean; membros: string[] | null;
};

type EnvPublico = { SALOES_PUBLICOS?: string; SALOES_COMBINADOS_PUBLICOS?: string };

const COLUNAS = `s.id::text, s.nome, s.ordem, s.capacidade_convidados, s.convidados_minimo, s.convidados_sentados, s.area_m2,
            s.idade_min, s.idade_max, s.frase, s.outra_festa_simultanea, s.exclusivos, to_char(s.fotos_referencia, 'YYYY-MM-DD') AS fotos_referencia,
            (SELECT count(*)::int FROM agenda_salao_fotos f WHERE f.salao_id = s.id AND f.removida_em IS NULL) AS fotos,
            s.conteudo_versao, s.declaracao_versao, s.ativo`;

/** Tipo e membros do salão quando a coluna existe; sem ela, todo salão é simples. */
const tipoDoSalao = (coluna: boolean) => coluna ? "s.combinado, s.membros::text[] AS membros" : "false AS combinado, NULL::text[] AS membros";

async function apresentacao102(db: DbExecutor) {
  const r = await db.query<{ ok: boolean }>(`SELECT to_regclass('public.agenda_salao_fotos') IS NOT NULL AS ok`);
  return r.rows[0]?.ok === true;
}

/**
 * Salões ATIVOS da unidade do escopo, com o necessário para decidir se estão prontos (102).
 * Retomada 098 (rev. 2.1, P2-R2-2): sem `comCombinados`, o combinado não aparece ao cliente, em qualquer estado da
 * instalação em que a coluna exista (antiga, nova ou parcial) — é a E2a. E2b (rev. 2, E2b-2): com combinadosPublicos
 * (só instalação NOVA), o combinado entra se ELEGÍVEL (todos os membros ativos, kidmais098_salao_elegivel).
 */
async function saloesDoEscopo(db: DbExecutor, escopo: EscopoAgenda, comCombinados: boolean): Promise<LinhaPronta[]> {
  const coluna = (await estadoCombinados(db)).coluna;
  const filtro = !coluna ? "" : comCombinados ? " AND (NOT s.combinado OR kidmais098_salao_elegivel(s.id))" : " AND NOT s.combinado";
  return (await db.query<LinhaPronta>(
    `SELECT ${COLUNAS}, ${tipoDoSalao(coluna)}
       FROM agenda_saloes s
      WHERE s.ativo AND s.empresa_id = $1::uuid AND s.estabelecimento_id IS NOT DISTINCT FROM $2::uuid${filtro}
      ORDER BY s.ordem, s.id`,
    [escopo.empresaId, escopo.estabelecimentoId ?? null],
  )).rows;
}

/**
 * E2b (rev. 2.1, passos 1–2 da decisão da preferência): o salão do escopo com o conteúdo para `pendenciasPublicacao`,
 * SEM filtrar atividade nem elegibilidade dos membros (o inativo cai na pendência; o membro inativo vira motivo). null =
 * não existe nesta empresa/unidade.
 */
export async function salaoDoEscopoParaPublicacao(db: DbExecutor, escopo: EscopoAgenda, salaoId: string): Promise<LinhaPronta | null> {
  if (!escopo.empresaId || !(await apresentacao102(db))) return null;
  const coluna = (await estadoCombinados(db)).coluna;
  return (await db.query<LinhaPronta>(
    `SELECT ${COLUNAS}, ${tipoDoSalao(coluna)}
       FROM agenda_saloes s
      WHERE s.id = $3::uuid AND s.empresa_id = $1::uuid AND s.estabelecimento_id IS NOT DISTINCT FROM $2::uuid`,
    [escopo.empresaId, escopo.estabelecimentoId ?? null, salaoId],
  )).rows[0] ?? null;
}

export const pronto = (s: LinhaPronta) => pendenciasPublicacao({
  ativo: s.ativo, capacidade: s.capacidade_convidados, fotosAtivas: Number(s.fotos), fotosReferencia: s.fotos_referencia,
  outraFestaSimultanea: s.outra_festa_simultanea, conteudoVersao: s.conteudo_versao, declaracaoVersao: s.declaracao_versao,
}).length === 0;

/**
 * Portões comuns da lista e das fotos (R-D3, itens 1–4). Devolve os salões prontos do escopo, em (ordem, id), ou lança
 * SalaoPublicoIndisponivel. Escopo já resolvido pela rota (escopoCotacaoPublica).
 */
export async function saloesProntosPublicos(db: DbExecutor, escopo: EscopoAgenda, env?: EnvPublico) {
  return (await portoesPublicos(db, escopo, env)).prontos;
}

/**
 * Os portões e o que a lista precisa além dos prontos: se os combinados valem para o cliente (combinadosPublicos) e os
 * salões ativos do escopo (texto de convivência do combinado). D-E2b-2: o mínimo de 2 prontos conta SÓ os simples —
 * um combinado nunca completa a etapa.
 */
async function portoesPublicos(db: DbExecutor, escopo: EscopoAgenda, env?: EnvPublico) {
  if (!saloesPublicosLigados(env)) naoPublicado();
  if (!escopo.empresaId || !(await apresentacao102(db))) naoPublicado();
  const porSalao = (await db.query<{ ok: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM agenda_escopo_config WHERE empresa_id = $1::uuid AND estabelecimento_id IS NOT DISTINCT FROM $2::uuid
                       AND capacidade_tipo = 'POR_SALAO') AS ok`,
    [escopo.empresaId, escopo.estabelecimentoId ?? null],
  )).rows[0]?.ok === true;
  if (!porSalao) naoPublicado();
  const comCombinados = await combinadosPublicos(db, env);
  const ativos = await saloesDoEscopo(db, escopo, comCombinados);
  const prontos = ativos.filter(pronto);
  if (prontos.filter((s) => !s.combinado).length < 2) naoPublicado();
  return { prontos, ativos, comCombinados };
}

export type SalaoPublico = {
  id: string;
  nome: string;
  numeros: { capacidade: number | null; minimo: number | null; sentados: number | null; areaM2: number | null };
  idade: { min: number; max: number; sugerida: boolean } | null;
  frase: string | null;
  destaques: string[];
  grupos: Array<{ grupo: GrupoItem; nome: string; itens: string[] }>;
  fotos: Array<{ id: string; legenda: string; ordem: number; largura: number; altura: number }>;
  mesDasFotos: string | null;
  convivencia: string | null;
  emTodosOsPacotes: string[];
  situacao: SituacaoSalao;
  /**
   * E2b (só com combinadosPublicos; desligado, os três campos nem existem — paridade com a E2a, P3-E2b-1):
   * combinado = nomes dos membros (null no simples); papel na escolha; preço "a partir de" do pacote (nunca A+B, sem +R$).
   */
  combinado?: { membros: string[] } | null;
  papel?: PapelSalao | null;
  precoAPartirDe?: string | null;
};

export type PapelSalao = "recomendado" | "alternativa";

/** Monta o DTO por lista branca (o teste confere os campos exatos). */
export function dtoPublico(
  s: LinhaPronta,
  itens: Array<{ grupo: GrupoItem; nome: string; destaque: boolean; idadeMin: number | null; idadeMax: number | null; catalogo: boolean }>,
  fotos: Array<{ id: string; legenda: string; ordem: number; largura: number; altura: number }>,
  emTodos: string[],
  situacao: SituacaoSalao,
): SalaoPublico {
  const exclusivos = s.exclusivos.filter((x): x is Exclusivo => (EXCLUSIVOS as readonly string[]).includes(x));
  const sugerida = idadeSugerida(itens.filter((i) => i.catalogo).map((i) => ({ idadeMin: i.idadeMin, idadeMax: i.idadeMax })));
  const idade = s.idade_min != null && s.idade_max != null ? { min: s.idade_min, max: s.idade_max, sugerida: false }
    : sugerida ? { ...sugerida, sugerida: true } : null;
  return {
    id: s.id,
    nome: s.nome,
    numeros: { capacidade: s.capacidade_convidados, minimo: s.convidados_minimo, sentados: s.convidados_sentados, areaM2: s.area_m2 },
    idade,
    frase: s.frase,
    destaques: itens.filter((i) => i.destaque).map((i) => i.nome),
    grupos: GRUPOS_ITEM.map((g) => ({ grupo: g, nome: NOMES_GRUPO[g], itens: itens.filter((i) => i.grupo === g).map((i) => i.nome) }))
      .filter((g) => g.itens.length > 0),
    fotos: fotos.map((f) => ({ id: f.id, legenda: f.legenda, ordem: f.ordem, largura: f.largura, altura: f.altura })),
    mesDasFotos: s.fotos_referencia ? s.fotos_referencia.slice(0, 7) : null,
    convivencia: fraseConvivencia(s.outra_festa_simultanea, exclusivos),
    emTodosOsPacotes: emTodos,
    situacao,
  };
}

/**
 * Recomendado (R-D4/R3-D3): só entre os LIVRES; o de menor capacidade (capacidade nula por último), desempate por
 * (ordem, id). null = nenhum livre comporta.
 */
export function recomendado(saloes: Array<{ id: string; ordem: number; capacidade: number | null; situacao: SituacaoSalao }>) {
  const livres = saloes.filter((s) => s.situacao === "livre");
  livres.sort((a, b) => (a.capacidade ?? Number.MAX_SAFE_INTEGER) - (b.capacidade ?? Number.MAX_SAFE_INTEGER)
    || a.ordem - b.ordem || a.id.localeCompare(b.id));
  return livres[0]?.id ?? null;
}

/**
 * E2b (plano rev. 2, "Recomendação — casos completos"; D-R4, P3-R2-1). Entre os salões visíveis no horário:
 *   1. há simples LIVRE → recomendado = menor simples livre (regra de `recomendado`); combinado livre é opção comum;
 *   2. nenhum simples livre, mas algum simples OCUPADO (comportaria, já reservado) → sem recomendado; cada combinado
 *      livre é ALTERNATIVA;
 *   3. nenhum simples livre nem ocupado (todos não comportam/abaixo do mínimo, ou nenhum simples candidato no horário
 *      ou pacote) → recomendado = menor combinado livre.
 * Sem combinados o resultado é o de `recomendado` (paridade E2a).
 */
export function papeisDosSaloes(saloes: Array<{ id: string; ordem: number; capacidade: number | null; situacao: SituacaoSalao; combinado: boolean }>) {
  const simples = saloes.filter((s) => !s.combinado);
  const combinados = saloes.filter((s) => s.combinado);
  const alternativas = new Set<string>();
  const simplesLivre = recomendado(simples);
  if (simplesLivre) return { recomendado: simplesLivre, alternativas };
  if (simples.some((s) => s.situacao === "ocupado")) {
    for (const s of combinados) if (s.situacao === "livre") alternativas.add(s.id);
    return { recomendado: null, alternativas };
  }
  return { recomendado: recomendado(combinados), alternativas };
}

/**
 * E2b (texto de convivência do combinado): só os SIMPLES ativos da mesma unidade fora dos membros podem receber outra
 * festa no mesmo horário; outro combinado sobreposto não é recurso independente. Sem simples externos: nenhuma frase.
 * Nunca promete exclusividade.
 */
export function convivenciaDoCombinado(membros: readonly string[], ativos: Array<{ id: string; nome: string; combinado: boolean }>) {
  const externos = ativos.filter((s) => !s.combinado && !membros.includes(s.id)).map((s) => s.nome);
  if (externos.length === 0) return null;
  const lista = externos.length === 1 ? externos[0] : `${externos.slice(0, -1).join(", ")} e ${externos.at(-1)}`;
  return `${lista} ${externos.length === 1 ? "pode" : "podem"} receber outra festa no mesmo horário.`;
}

/** Motivo do recomendado, para o cliente: "indicado para 80 · cabe até 120". */
export function motivoRecomendado(convidados: number, capacidade: number | null) {
  return capacidade == null ? `indicado para ${convidados}` : `indicado para ${convidados} · cabe até ${capacidade}`;
}

export type ConsultaPublica = { data: string; configuracaoId: string; inicio: string; fim: string; convidados: number };

/**
 * Lista pública (D2): salões prontos ELEGÍVEIS no horário pedido (inelegível nem aparece), com a situação e o
 * recomendado. Escopo e portões antes de qualquer leitura de conteúdo.
 */
export async function listarSaloesPublicos(
  db: DbExecutor, escopo: EscopoAgenda, consulta: ConsultaPublica, env?: EnvPublico, oferta: { enderecoDaEmpresa: boolean } = { enderecoDaEmpresa: false },
) {
  const { prontos, ativos, comCombinados } = await portoesPublicos(db, escopo, env);
  const situacoes = await situacaoDosSaloesNoHorario({ ...consulta, incluirCombinados: comCombinados }, db, escopo);
  if (!situacoes) naoPublicado();
  const porId = new Map(situacoes!.map((s) => [s.salaoId, s.situacao]));
  // E2b (D-E2b-4, P2-E2b-2): o combinado só aparece com pacote no universo efetivo — catálogo do endereço ∩ pacotes que
  // o servem ∩ comportam N (o mesmo da etapa de pacotes); a faixa usa o menor preço publicado não nulo desse universo.
  // Data, horário e tabela ficam fora (limite declarado: a cotação seguinte explica).
  const precoDoCombinado = new Map<string, string | null>();
  if (comCombinados && prontos.some((s) => s.combinado && porId.has(s.id))) {
    const catalogo = (await pacotesDaOfertaPublica(db, escopo.empresaId!, oferta.enderecoDaEmpresa))
      .filter((p) => pacoteComporta(p, consulta.convidados));
    const precos = await precosPublicosDeHoje(db, escopo.empresaId!);
    for (const s of prontos.filter((x) => x.combinado && porId.has(x.id))) {
      const servem = new Set(await pacotesElegiveisDoSalao(db, escopo.empresaId!, s.id));
      const universo = catalogo.filter((p) => servem.has(p.id));
      if (universo.length === 0) continue;
      const minimos = universo.map((p) => precoMinimo(precos.filter((l) => l.pacoteId === p.id))).filter((v): v is string => v !== null);
      precoDoCombinado.set(s.id, menorPreco(minimos));
    }
  }
  const visiveis = prontos.filter((s) => porId.has(s.id) && (!s.combinado || precoDoCombinado.has(s.id)));
  const papeis = papeisDosSaloes(visiveis.map((s) => ({
    id: s.id, ordem: s.ordem, capacidade: s.capacidade_convidados, situacao: porId.get(s.id)!, combinado: s.combinado,
  })));
  const saloes: SalaoPublico[] = [];
  for (const s of visiveis) {
    const itens = (await db.query<{ grupo: GrupoItem; nome: string; destaque: boolean; idade_min: number | null; idade_max: number | null; catalogo: boolean }>(
      `SELECT i.grupo, coalesce(c.nome, i.item_proprio) AS nome, i.destaque, c.idade_min, c.idade_max, (i.item_codigo IS NOT NULL) AS catalogo
         FROM agenda_salao_itens i LEFT JOIN agenda_salao_itens_catalogo c ON c.codigo = i.item_codigo
        WHERE i.salao_id = $1::uuid AND i.empresa_id = $2::uuid
        ORDER BY array_position(ARRAY['BRINCADEIRAS','ADULTOS','CONFORTO','ESPACO'], i.grupo), c.ordem NULLS LAST, i.criado_em`,
      [s.id, escopo.empresaId],
    )).rows;
    const fotos = (await db.query<{ id: string; legenda: string; ordem: number; largura: number; altura: number }>(
      `SELECT id::text, legenda, ordem, largura, altura FROM agenda_salao_fotos
        WHERE salao_id = $1::uuid AND empresa_id = $2::uuid AND removida_em IS NULL ORDER BY ordem`,
      [s.id, escopo.empresaId],
    )).rows;
    const pacotes = await itensDosPacotesDoSalao(db, escopo.empresaId!, s.id);
    const dto = dtoPublico(
      s,
      itens.map((i) => ({ grupo: i.grupo, nome: i.nome, destaque: i.destaque, idadeMin: i.idade_min, idadeMax: i.idade_max, catalogo: i.catalogo })),
      fotos,
      pacotes.emTodos.map((g) => g.nome),
      porId.get(s.id)!,
    );
    if (comCombinados) {
      const membros = s.combinado ? (s.membros ?? []) : [];
      // Nomes na ordem do cadastro (ativos = ORDER BY ordem, id), nunca na dos ids guardados em `membros`.
      dto.combinado = s.combinado ? { membros: ativos.filter((a) => membros.includes(a.id)).map((a) => a.nome) } : null;
      dto.papel = papeis.recomendado === s.id ? "recomendado" : papeis.alternativas.has(s.id) ? "alternativa" : null;
      dto.precoAPartirDe = s.combinado ? precoDoCombinado.get(s.id) ?? null : null;
      if (s.combinado) dto.convivencia = convivenciaDoCombinado(membros, ativos);
    }
    saloes.push(dto);
  }
  const rec = papeis.recomendado;
  const salaoRec = visiveis.find((s) => s.id === rec);
  return {
    saloes,
    recomendado: rec ? { id: rec, motivo: motivoRecomendado(consulta.convidados, salaoRec?.capacidade_convidados ?? null) } : null,
  };
}

/** Foto pública (D3/R-D3): os mesmos portões e o salão pronto do escopo; foto removida ou alheia = não publicado. */
export async function fotoPublica(db: DbExecutor, escopo: EscopoAgenda, salaoId: string, fotoId: string, env?: EnvPublico) {
  const prontos = await saloesProntosPublicos(db, escopo, env);
  if (!prontos.some((s) => s.id === salaoId)) naoPublicado();
  const r = await db.query<{ conteudo: Buffer; sha256: string }>(
    `SELECT conteudo, sha256 FROM agenda_salao_fotos WHERE id = $1::uuid AND salao_id = $2::uuid AND empresa_id = $3::uuid AND removida_em IS NULL`,
    [fotoId, salaoId, escopo.empresaId],
  );
  return r.rows[0] ?? naoPublicado();
}

/** Nome público de um salão pronto do escopo (chip do assistente, Resumo); null fora dos portões. */
export async function nomeDoSalaoPublico(db: DbExecutor, escopo: EscopoAgenda, salaoId: string, env?: EnvPublico) {
  try {
    const prontos = await saloesProntosPublicos(db, escopo, env);
    return prontos.find((s) => s.id === salaoId)?.nome ?? null;
  } catch (erro) {
    if (erro instanceof SalaoPublicoIndisponivel) return null;
    throw erro;
  }
}
