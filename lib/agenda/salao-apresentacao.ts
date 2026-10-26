import type { DbExecutor } from "../db/contracts.ts";
import { auditarMutacaoComercial } from "../comercial/auditoria-comercial.ts";
import { PacoteAdminError } from "../comercial/pacotes-admin.ts";
import type { WebpNormalizado } from "../imagens/normalizar-webp.ts";
import {
  EXCLUSIVOS, GRUPOS_ITEM, MAX_DESTAQUES, MAX_FOTOS, fotosAntigas, fraseConvivencia, idadeSugerida, mensagemErroSalao, mesDasFotos,
  normalizarTexto, ordemDaNovaFoto, pendenciasPublicacao, planejarReordenacao, TEXTO_PENDENCIA,
  type Exclusivo, type GrupoItem, type Pendencia,
} from "./salao-apresentacao-regras.ts";

/**
 * Apresentação do salão ao cliente (102), única porta de escrita do conteúdo. Plano rev. 4 aprovado com ressalvas pelo
 * Astra (25/10/2026):
 *   * NÃO escreve campos da agenda (nome, capacidade, ordem, ativo): eles são só lidos aqui (separação de portas);
 *   * toda escrita: advisory `kidmais:agenda-config:<empresa>` → salão FOR UPDATE (posse pela empresa da sessão) →
 *     versão esperada (`conteudo_versao`, 409 se mudou) → filhas. Sem lock de data, fechamento ou pacote depois;
 *   * o banco garante a invalidação da declaração para todos os escritores; aqui só se confere versão e autorização,
 *     e se audita;
 *   * Gestão é exigida pela rota (sem exceção de assistente).
 */
export class SalaoApresentacaoError extends PacoteAdminError {}

const recusar = (code: string, message: string, status = 409): never => {
  throw new SalaoApresentacaoError(code, message, status);
};

type Contexto = { empresaId: string; usuarioId: string; requestId: string };

const COLUNAS_102 = ["convidados_minimo", "convidados_sentados", "area_m2", "idade_min", "idade_max", "frase", "outra_festa_simultanea",
  "exclusivos", "fotos_referencia", "declaracao_em", "declaracao_por", "declaracao_versao", "conteudo_versao"];

export type Instalacao = "AUSENTE" | "COMPLETA" | "PARCIAL";

/** Ausência completa = recurso não instalado; qualquer parcial falha fechado (nunca vira "não instalado"). */
export async function apresentacaoInstalada(db: DbExecutor): Promise<Instalacao> {
  const r = await db.query<{ colunas: number; tabelas: number }>(
    `SELECT (SELECT count(*)::int FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'agenda_saloes'
              AND column_name = ANY($1::text[])) AS colunas,
            ((to_regclass('public.agenda_salao_itens_catalogo') IS NOT NULL)::int + (to_regclass('public.agenda_salao_itens') IS NOT NULL)::int
              + (to_regclass('public.agenda_salao_fotos') IS NOT NULL)::int) AS tabelas`, [COLUNAS_102]);
  const { colunas, tabelas } = r.rows[0] ?? { colunas: 0, tabelas: 0 };
  if (colunas === 0 && tabelas === 0) return "AUSENTE";
  if (colunas === COLUNAS_102.length && tabelas === 3) return "COMPLETA";
  return "PARCIAL";
}

export async function exigirApresentacaoInstalada(db: DbExecutor) {
  const estado = await apresentacaoInstalada(db);
  if (estado === "AUSENTE") recusar("RECURSO_INDISPONIVEL", "A apresentação dos salões ainda não está disponível.", 409);
  if (estado === "PARCIAL") recusar("INSTALACAO_INCOMPLETA", "A apresentação dos salões está temporariamente indisponível.", 503);
}

/**
 * Retentativa limitada (R2-6): a TRANSAÇÃO INTEIRA é repetida até 2 vezes em deadlock (40P01) ou falha de serialização
 * (40001), sem commit parcial e com a mesma versão esperada; depois disso, 503. Conflito de versão é 409, nunca repetido.
 */
export async function repetirEmConflito<T>(transacao: () => Promise<T>): Promise<T> {
  for (let tentativa = 0; ; tentativa++) {
    try {
      return await transacao();
    } catch (erro) {
      const code = (erro as { code?: string } | null)?.code;
      if (code !== "40P01" && code !== "40001") throw erro;
      if (tentativa >= 2) recusar("TENTE_DE_NOVO", "O salão estava sendo alterado ao mesmo tempo. Tente de novo.", 503);
    }
  }
}

/** Erro do banco conhecido da 102 → mensagem amigável (SQLSTATE + constraint); outro erro segue intacto. */
export function traduzirErroSalao(erro: unknown): unknown {
  const mensagem = mensagemErroSalao(erro);
  return mensagem ? new SalaoApresentacaoError("DADOS_INVALIDOS", mensagem, 409) : erro;
}

type LinhaSalao = {
  id: string; nome: string; capacidade_convidados: number | null; ativo: boolean; estabelecimento_id: string | null; unidade: string | null;
  convidados_minimo: number | null; convidados_sentados: number | null; area_m2: number | null; idade_min: number | null; idade_max: number | null;
  frase: string | null; outra_festa_simultanea: boolean | null; exclusivos: string[]; fotos_referencia: string | null;
  declaracao_em: string | null; declaracao_versao: number | null; conteudo_versao: number;
};

const SELECT_SALAO = `SELECT s.id::text, s.nome, s.capacidade_convidados, s.ativo, s.estabelecimento_id::text, e.nome AS unidade,
       s.convidados_minimo, s.convidados_sentados, s.area_m2, s.idade_min, s.idade_max, s.frase, s.outra_festa_simultanea,
       s.exclusivos, to_char(s.fotos_referencia, 'YYYY-MM-DD') AS fotos_referencia, s.declaracao_em::text, s.declaracao_versao, s.conteudo_versao
  FROM agenda_saloes s LEFT JOIN estabelecimentos e ON e.id = s.estabelecimento_id`;

/**
 * Trava para escrita: advisory da configuração da empresa → salão FOR UPDATE, só da empresa da sessão (404 igual para
 * salão alheio ou inexistente) → versão esperada. Combinado da 098 nunca chega aqui (a 102 recusa a 098).
 */
async function travarSalao(tx: DbExecutor, empresaId: string, salaoId: string, versaoEsperada: number) {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('kidmais:agenda-config:' || $1::text, 0))`, [empresaId]);
  const r = await tx.query<LinhaSalao>(`${SELECT_SALAO} WHERE s.id = $1::uuid AND s.empresa_id = $2::uuid FOR UPDATE OF s`, [salaoId, empresaId]);
  const salao = r.rows[0] ?? recusar("SALAO_NAO_ENCONTRADO", "Salão não encontrado.", 404);
  if (salao.conteudo_versao !== versaoEsperada) recusar("SALAO_MUDOU", "O salão mudou desde que você abriu esta tela. Recarregue a página.", 409);
  return salao;
}

async function auditar(tx: DbExecutor, ctx: Contexto, salaoId: string, acao: string, depois: Record<string, unknown>) {
  await auditarMutacaoComercial(tx, {
    usuarioId: ctx.usuarioId, requestId: ctx.requestId, acao, entidadeTipo: "AGENDA_SALAO", entidadeId: salaoId,
    empresaId: ctx.empresaId, antes: null, depois, motivo: null,
  });
}

const versaoAtual = async (tx: DbExecutor, salaoId: string) =>
  Number((await tx.query<{ v: number }>(`SELECT conteudo_versao AS v FROM agenda_saloes WHERE id = $1::uuid`, [salaoId])).rows[0]?.v ?? 0);

/** Executa uma escrita e traduz os erros conhecidos do banco (sem mascarar os demais). */
async function comTraducao<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (erro) {
    throw traduzirErroSalao(erro);
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------------------------------------------------
export type ItemCatalogo = { codigo: string; grupo: GrupoItem; nome: string; ativo: boolean; idadeMin: number | null; idadeMax: number | null; pedeDetalhe: boolean };
export type ItemSalao = { id: string; grupo: GrupoItem; codigo: string | null; proprio: string | null; nome: string; detalhe: string | null; destaque: boolean };
export type FotoSalao = { id: string; legenda: string; ordem: number; largura: number; altura: number; bytes: number; origem: "UPLOAD" | "SITE" };

export async function catalogoDeItens(db: DbExecutor): Promise<ItemCatalogo[]> {
  const r = await db.query<{ codigo: string; grupo: GrupoItem; nome: string; ativo: boolean; idade_min: number | null; idade_max: number | null; pede_detalhe: boolean }>(
    `SELECT codigo, grupo, nome, ativo, idade_min, idade_max, pede_detalhe FROM agenda_salao_itens_catalogo
      ORDER BY array_position(ARRAY['BRINCADEIRAS','ADULTOS','CONFORTO','ESPACO'], grupo), ordem`);
  return r.rows.map((l) => ({ codigo: l.codigo, grupo: l.grupo, nome: l.nome, ativo: l.ativo, idadeMin: l.idade_min, idadeMax: l.idade_max, pedeDetalhe: l.pede_detalhe }));
}

export async function lerApresentacao(db: DbExecutor, empresaId: string, salaoId: string, agora: Date = new Date()) {
  const s = (await db.query<LinhaSalao>(`${SELECT_SALAO} WHERE s.id = $1::uuid AND s.empresa_id = $2::uuid`, [salaoId, empresaId])).rows[0]
    ?? recusar("SALAO_NAO_ENCONTRADO", "Salão não encontrado.", 404);
  const catalogo = await catalogoDeItens(db);
  const itens = (await db.query<{ id: string; grupo: GrupoItem; item_codigo: string | null; item_proprio: string | null; nome: string; detalhe: string | null; destaque: boolean;
    idade_min: number | null; idade_max: number | null }>(
    `SELECT i.id::text, i.grupo, i.item_codigo, i.item_proprio, coalesce(c.nome, i.item_proprio) AS nome, i.detalhe, i.destaque, c.idade_min, c.idade_max
       FROM agenda_salao_itens i LEFT JOIN agenda_salao_itens_catalogo c ON c.codigo = i.item_codigo
      WHERE i.salao_id = $1::uuid AND i.empresa_id = $2::uuid
      ORDER BY array_position(ARRAY['BRINCADEIRAS','ADULTOS','CONFORTO','ESPACO'], i.grupo), c.ordem NULLS LAST, i.criado_em`, [salaoId, empresaId])).rows;
  const fotos = (await db.query<{ id: string; legenda: string; ordem: number; largura: number; altura: number; bytes: number; origem: "UPLOAD" | "SITE" }>(
    `SELECT id::text, legenda, ordem, largura, altura, bytes, origem FROM agenda_salao_fotos
      WHERE salao_id = $1::uuid AND empresa_id = $2::uuid AND removida_em IS NULL ORDER BY ordem`, [salaoId, empresaId])).rows;
  const estado = {
    ativo: s.ativo, capacidade: s.capacidade_convidados, fotosAtivas: fotos.length, fotosReferencia: s.fotos_referencia,
    outraFestaSimultanea: s.outra_festa_simultanea, conteudoVersao: s.conteudo_versao, declaracaoVersao: s.declaracao_versao,
  };
  const pendencias = pendenciasPublicacao(estado);
  const exclusivos = s.exclusivos.filter((x): x is Exclusivo => (EXCLUSIVOS as readonly string[]).includes(x));
  return {
    salao: { id: s.id, nome: s.nome, capacidadeConvidados: s.capacidade_convidados, ativo: s.ativo, unidadeId: s.estabelecimento_id, unidade: s.unidade },
    campos: {
      convidadosMinimo: s.convidados_minimo, convidadosSentados: s.convidados_sentados, areaM2: s.area_m2,
      idadeMin: s.idade_min, idadeMax: s.idade_max, frase: s.frase, outraFestaSimultanea: s.outra_festa_simultanea,
      exclusivos, fotosReferencia: s.fotos_referencia ? s.fotos_referencia.slice(0, 7) : null,
    },
    itens: itens.map((i): ItemSalao => ({ id: i.id, grupo: i.grupo, codigo: i.item_codigo, proprio: i.item_proprio, nome: i.nome, detalhe: i.detalhe, destaque: i.destaque })),
    fotos: fotos as FotoSalao[],
    conteudoVersao: s.conteudo_versao,
    declaracao: s.declaracao_em && s.declaracao_versao === s.conteudo_versao ? { em: s.declaracao_em, versao: s.declaracao_versao } : null,
    publicavel: { ok: pendencias.length === 0, pendencias: pendencias.map((p) => ({ codigo: p, texto: TEXTO_PENDENCIA[p] })) },
    avisos: fotosAntigas(s.fotos_referencia, agora) ? ["As fotos têm mais de 12 meses. Considere atualizar."] : [],
    idadeSugerida: idadeSugerida(itens.filter((i) => i.item_codigo).map((i) => ({ idadeMin: i.idade_min, idadeMax: i.idade_max }))),
    fraseConvivencia: fraseConvivencia(s.outra_festa_simultanea, exclusivos),
    catalogo,
    limites: { fotos: MAX_FOTOS, destaques: MAX_DESTAQUES },
  };
}

export type Apresentacao = Awaited<ReturnType<typeof lerApresentacao>>;

/** Salões da empresa com o resumo da apresentação (lista em Configurações › Salões). */
export async function listarSaloesComApresentacao(db: DbExecutor, empresaId: string) {
  const r = await db.query<{ id: string; nome: string; ativo: boolean; capacidade_convidados: number | null; unidade: string | null; fotos: number;
    fotos_referencia: string | null; outra_festa_simultanea: boolean | null; conteudo_versao: number; declaracao_versao: number | null }>(
    `SELECT s.id::text, s.nome, s.ativo, s.capacidade_convidados, e.nome AS unidade,
            (SELECT count(*)::int FROM agenda_salao_fotos f WHERE f.salao_id = s.id AND f.removida_em IS NULL) AS fotos,
            to_char(s.fotos_referencia, 'YYYY-MM-DD') AS fotos_referencia, s.outra_festa_simultanea, s.conteudo_versao, s.declaracao_versao
       FROM agenda_saloes s LEFT JOIN estabelecimentos e ON e.id = s.estabelecimento_id
      WHERE s.empresa_id = $1::uuid AND s.ativo ORDER BY e.nome NULLS FIRST, s.ordem, s.nome`, [empresaId]);
  return r.rows.map((s) => {
    const pendencias: Pendencia[] = pendenciasPublicacao({
      ativo: s.ativo, capacidade: s.capacidade_convidados, fotosAtivas: s.fotos, fotosReferencia: s.fotos_referencia,
      outraFestaSimultanea: s.outra_festa_simultanea, conteudoVersao: s.conteudo_versao, declaracaoVersao: s.declaracao_versao,
    });
    return { id: s.id, nome: s.nome, unidade: s.unidade, capacidadeConvidados: s.capacidade_convidados, fotos: s.fotos, pronto: pendencias.length === 0, pendencias: pendencias.length };
  });
}

/** Bytes de uma foto ativa do salão (prévia do painel). Salão/foto alheios ou removidos: 404 igual. */
export async function lerFotoSalao(db: DbExecutor, empresaId: string, salaoId: string, fotoId: string) {
  const r = await db.query<{ conteudo: Buffer; sha256: string }>(
    `SELECT conteudo, sha256 FROM agenda_salao_fotos WHERE id = $1::uuid AND salao_id = $2::uuid AND empresa_id = $3::uuid AND removida_em IS NULL`,
    [fotoId, salaoId, empresaId]);
  return r.rows[0] ?? recusar("FOTO_NAO_ENCONTRADA", "Foto não encontrada.", 404);
}

// ---------------------------------------------------------------------------------------------------------------------
// Escrita: campos e itens
// ---------------------------------------------------------------------------------------------------------------------
export type ItemInformado = { id?: string; grupo: GrupoItem; codigo?: string | null; proprio?: string | null; detalhe?: string | null; destaque: boolean };
export type CamposInformados = {
  convidadosMinimo: number | null; convidadosSentados: number | null; areaM2: number | null;
  idadeMin: number | null; idadeMax: number | null; frase: string | null; outraFestaSimultanea: boolean | null;
  exclusivos: Exclusivo[]; fotosReferencia: string | null; // AAAA-MM
};

/**
 * Grava campos e o conjunto completo de itens numa transação. Itens: identidade imutável (trocar = remover e criar);
 * a ordem das operações evita estourar o teto de destaques no meio do lote (remove → tira destaques → demais).
 */
export async function salvarApresentacao(tx: DbExecutor, ctx: Contexto, salaoId: string, versaoEsperada: number,
  campos: CamposInformados, itens: ItemInformado[], agora: Date = new Date()) {
  await exigirApresentacaoInstalada(tx);
  await travarSalao(tx, ctx.empresaId, salaoId, versaoEsperada);
  const fotosReferencia = campos.fotosReferencia === null ? null : mesDasFotos(campos.fotosReferencia, agora);
  if (campos.fotosReferencia !== null && fotosReferencia === null) recusar("DADOS_INVALIDOS", "Informe um mês que já passou ou o mês atual.", 400);
  const frase = campos.frase === null ? null : normalizarTexto(campos.frase) || null;
  if (itens.filter((i) => i.destaque).length > MAX_DESTAQUES) recusar("DADOS_INVALIDOS", `Escolha no máximo ${MAX_DESTAQUES} destaques.`, 400);
  for (const i of itens) {
    if (!(GRUPOS_ITEM as readonly string[]).includes(i.grupo) || Boolean(i.codigo) === Boolean(i.proprio)) recusar("DADOS_INVALIDOS", "Item inválido.", 400);
  }
  return comTraducao(async () => {
    await tx.query(
      `UPDATE agenda_saloes SET convidados_minimo = $2, convidados_sentados = $3, area_m2 = $4, idade_min = $5, idade_max = $6, frase = $7,
              outra_festa_simultanea = $8, exclusivos = $9::text[], fotos_referencia = $10::date
        WHERE id = $1::uuid`,
      [salaoId, campos.convidadosMinimo, campos.convidadosSentados, campos.areaM2, campos.idadeMin, campos.idadeMax, frase,
        campos.outraFestaSimultanea, [...new Set(campos.exclusivos)], fotosReferencia]);
    const atuais = (await tx.query<{ id: string; grupo: string; item_codigo: string | null; item_proprio: string | null; detalhe: string | null; destaque: boolean }>(
      `SELECT id::text, grupo, item_codigo, item_proprio, detalhe, destaque FROM agenda_salao_itens WHERE salao_id = $1::uuid ORDER BY id`, [salaoId])).rows;
    const porId = new Map(atuais.map((a) => [a.id, a]));
    const informados = itens.map((i) => ({ ...i, proprio: i.proprio ? normalizarTexto(i.proprio) : null, detalhe: i.detalhe ? normalizarTexto(i.detalhe) || null : null }));
    for (const i of informados) {
      if (!i.id) continue;
      const atual = porId.get(i.id) ?? recusar("SALAO_MUDOU", "Os itens mudaram. Recarregue a página.", 409);
      if (atual.grupo !== i.grupo || (atual.item_codigo ?? null) !== (i.codigo ?? null) || (atual.item_proprio === null) !== (i.proprio === null)) {
        recusar("DADOS_INVALIDOS", "Para trocar um item, remova e adicione outro.", 400);
      }
    }
    const mantidos = new Set(informados.filter((i) => i.id).map((i) => i.id));
    for (const a of atuais) if (!mantidos.has(a.id)) await tx.query(`DELETE FROM agenda_salao_itens WHERE id = $1::uuid`, [a.id]);
    const atualizar = informados.filter((i) => i.id).sort((x, y) => Number(x.destaque) - Number(y.destaque));
    for (const i of atualizar) {
      await tx.query(`UPDATE agenda_salao_itens SET item_proprio = $2, detalhe = $3, destaque = $4 WHERE id = $1::uuid`,
        [i.id, i.proprio, i.detalhe, i.destaque]);
    }
    for (const i of informados.filter((x) => !x.id)) {
      await tx.query(`INSERT INTO agenda_salao_itens (empresa_id, salao_id, grupo, item_codigo, item_proprio, detalhe, destaque)
                      VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)`, [ctx.empresaId, salaoId, i.grupo, i.codigo ?? null, i.proprio, i.detalhe, i.destaque]);
    }
    await auditar(tx, ctx, salaoId, "SALAO_APRESENTACAO_SALVA", { itens: informados.length, versao: await versaoAtual(tx, salaoId) });
    return lerApresentacao(tx, ctx.empresaId, salaoId, agora);
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Escrita: fotos
// ---------------------------------------------------------------------------------------------------------------------
async function fotosAtivas(tx: DbExecutor, salaoId: string) {
  return (await tx.query<{ id: string; ordem: number }>(
    `SELECT id::text, ordem FROM agenda_salao_fotos WHERE salao_id = $1::uuid AND removida_em IS NULL ORDER BY ordem, id`, [salaoId])).rows;
}

/** Aplica um plano de reordenação já validado: temporárias (livres) e depois finais. */
async function aplicarOrdem(tx: DbExecutor, atuais: { id: string; ordem: number }[], finais: string[]) {
  const plano = planejarReordenacao(atuais, finais) ?? recusar("SALAO_MUDOU", "As fotos mudaram. Recarregue a página.", 409);
  for (const p of plano.temporarias) await tx.query(`UPDATE agenda_salao_fotos SET ordem = $2 WHERE id = $1::uuid`, [p.id, p.ordem]);
  for (const p of plano.finais) await tx.query(`UPDATE agenda_salao_fotos SET ordem = $2 WHERE id = $1::uuid`, [p.id, p.ordem]);
}

const legendaValida = (legenda: string) => {
  const l = normalizarTexto(legenda);
  if (l.length < 1 || l.length > 60) recusar("DADOS_INVALIDOS", "A legenda precisa ter de 1 a 60 caracteres (o nome do ambiente).", 400);
  return l;
};

async function inserirFoto(tx: DbExecutor, ctx: Contexto, salaoId: string, imagem: WebpNormalizado, legenda: string, origemSha256: string | null) {
  let atuais = await fotosAtivas(tx, salaoId);
  if (atuais.length >= MAX_FOTOS) recusar("FOTOS_LIMITE", `No máximo ${MAX_FOTOS} fotos por salão. Remova alguma antes de enviar outra.`, 409);
  let ordem = ordemDaNovaFoto(atuais);
  if (ordem === null) {
    await aplicarOrdem(tx, atuais, atuais.map((f) => f.id)); // compacta para 1..n mantendo a ordem atual
    atuais = await fotosAtivas(tx, salaoId);
    ordem = atuais.length + 1;
  }
  const r = await tx.query<{ id: string }>(
    `INSERT INTO agenda_salao_fotos (empresa_id, salao_id, conteudo, mime, bytes, largura, altura, sha256, legenda, ordem, origem, origem_sha256, criado_por)
     VALUES ($1::uuid, $2::uuid, $3, 'image/webp', $4, $5, $6, $7, $8, $9, $10, $11, $12::uuid) RETURNING id::text`,
    [ctx.empresaId, salaoId, imagem.conteudo, imagem.conteudo.length, imagem.largura, imagem.altura, imagem.sha256, legenda, ordem,
      origemSha256 ? "SITE" : "UPLOAD", origemSha256, ctx.usuarioId]);
  return r.rows[0].id;
}

/** Foto enviada (já normalizada FORA da transação pela rota). Revalida tenant, versão e vaga sob o lock. */
export async function adicionarFoto(tx: DbExecutor, ctx: Contexto, salaoId: string, versaoEsperada: number, imagem: WebpNormalizado, legenda: string) {
  await exigirApresentacaoInstalada(tx);
  const l = legendaValida(legenda);
  await travarSalao(tx, ctx.empresaId, salaoId, versaoEsperada);
  return comTraducao(async () => {
    const id = await inserirFoto(tx, ctx, salaoId, imagem, l, null);
    await auditar(tx, ctx, salaoId, "SALAO_FOTO_ADICIONADA", { fotoId: id, sha256: imagem.sha256 });
    return lerApresentacao(tx, ctx.empresaId, salaoId);
  });
}

export async function editarLegenda(tx: DbExecutor, ctx: Contexto, salaoId: string, versaoEsperada: number, fotoId: string, legenda: string) {
  await exigirApresentacaoInstalada(tx);
  const l = legendaValida(legenda);
  await travarSalao(tx, ctx.empresaId, salaoId, versaoEsperada);
  return comTraducao(async () => {
    const r = await tx.query(`UPDATE agenda_salao_fotos SET legenda = $3 WHERE id = $1::uuid AND salao_id = $2::uuid AND removida_em IS NULL`, [fotoId, salaoId, l]);
    if (r.rowCount !== 1) recusar("FOTO_NAO_ENCONTRADA", "Foto não encontrada.", 404);
    await auditar(tx, ctx, salaoId, "SALAO_FOTO_LEGENDA", { fotoId });
    return lerApresentacao(tx, ctx.empresaId, salaoId);
  });
}

export async function removerFoto(tx: DbExecutor, ctx: Contexto, salaoId: string, versaoEsperada: number, fotoId: string) {
  await exigirApresentacaoInstalada(tx);
  await travarSalao(tx, ctx.empresaId, salaoId, versaoEsperada);
  return comTraducao(async () => {
    const r = await tx.query(`UPDATE agenda_salao_fotos SET removida_em = clock_timestamp() WHERE id = $1::uuid AND salao_id = $2::uuid AND removida_em IS NULL`, [fotoId, salaoId]);
    if (r.rowCount !== 1) recusar("FOTO_NAO_ENCONTRADA", "Foto não encontrada.", 404);
    await auditar(tx, ctx, salaoId, "SALAO_FOTO_REMOVIDA", { fotoId });
    return lerApresentacao(tx, ctx.empresaId, salaoId);
  });
}

/** Reordenação completa: `ids` precisa ser exatamente o conjunto das fotos ativas (senão 409, nada gravado). */
export async function reordenarFotos(tx: DbExecutor, ctx: Contexto, salaoId: string, versaoEsperada: number, ids: string[]) {
  await exigirApresentacaoInstalada(tx);
  await travarSalao(tx, ctx.empresaId, salaoId, versaoEsperada);
  return comTraducao(async () => {
    await aplicarOrdem(tx, await fotosAtivas(tx, salaoId), ids);
    await auditar(tx, ctx, salaoId, "SALAO_FOTOS_REORDENADAS", { fotos: ids.length });
    return lerApresentacao(tx, ctx.empresaId, salaoId);
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Cópia de foto do site da unidade (085). Sem a 085 a ação não existe (409); o cadastro continua funcionando.
// ---------------------------------------------------------------------------------------------------------------------
export async function siteInstalado(db: DbExecutor) {
  const r = await db.query<{ ok: boolean }>(`SELECT to_regclass('public.marketing_site_imagens') IS NOT NULL AND to_regclass('public.marketing_sites') IS NOT NULL AS ok`);
  return Boolean(r.rows[0]?.ok);
}

const ORIGEM_DO_SITE = `FROM marketing_site_imagens i JOIN marketing_sites m ON m.id = i.site_id AND m.empresa_id = i.empresa_id
       JOIN agenda_saloes s ON s.id = $2::uuid AND s.empresa_id = i.empresa_id AND s.estabelecimento_id IS NOT DISTINCT FROM m.estabelecimento_id
      WHERE i.id = $1::uuid AND i.empresa_id = $3::uuid AND m.empresa_id = $3::uuid AND i.removida_em IS NULL`;

/** Imagens ativas dos sites da mesma empresa e da mesma unidade do salão (seletor da tela). */
export async function imagensDoSiteParaSalao(db: DbExecutor, empresaId: string, salaoId: string) {
  if (!(await siteInstalado(db))) return { disponivel: false, imagens: [] as { id: string; descricao: string | null; largura: number; altura: number }[] };
  const r = await db.query<{ id: string; descricao: string | null; largura: number; altura: number }>(
    `SELECT i.id::text, i.descricao, i.largura, i.altura FROM marketing_site_imagens i
       JOIN marketing_sites m ON m.id = i.site_id AND m.empresa_id = i.empresa_id
       JOIN agenda_saloes s ON s.id = $1::uuid AND s.empresa_id = i.empresa_id AND s.estabelecimento_id IS NOT DISTINCT FROM m.estabelecimento_id
      WHERE i.empresa_id = $2::uuid AND i.removida_em IS NULL ORDER BY i.criado_em DESC LIMIT 60`, [salaoId, empresaId]);
  return { disponivel: true, imagens: r.rows };
}

/** Fase 1 (fora da transação de gravação): bytes da origem para normalizar. */
export async function lerOrigemDoSite(db: DbExecutor, empresaId: string, salaoId: string, imagemId: string) {
  if (!(await siteInstalado(db))) recusar("RECURSO_INDISPONIVEL", "O site da unidade não está disponível.", 409);
  const r = await db.query<{ conteudo: Buffer; sha256: string; descricao: string | null }>(`SELECT i.conteudo, i.sha256, i.descricao ${ORIGEM_DO_SITE}`, [imagemId, salaoId, empresaId]);
  return r.rows[0] ?? recusar("IMAGEM_NAO_ENCONTRADA", "Imagem do site não encontrada.", 404);
}

/**
 * Fase 2: sob o lock do salão, a imagem de origem é relida FOR SHARE (a remoção no site, um UPDATE da linha, espera
 * ou já venceu) e o hash conferido com o lido na fase 1. A cópia guarda bytes próprios (normalizados de novo) e fica
 * independente da origem. Sem ciclo: a remoção do site não pega advisory nem salão.
 */
export async function copiarFotoDoSite(tx: DbExecutor, ctx: Contexto, salaoId: string, versaoEsperada: number,
  imagemId: string, origemSha256: string, imagem: WebpNormalizado, legenda: string) {
  await exigirApresentacaoInstalada(tx);
  const l = legendaValida(legenda);
  if (!(await siteInstalado(tx))) recusar("RECURSO_INDISPONIVEL", "O site da unidade não está disponível.", 409);
  await travarSalao(tx, ctx.empresaId, salaoId, versaoEsperada);
  const origem = await tx.query<{ sha256: string }>(`SELECT i.sha256 ${ORIGEM_DO_SITE} FOR SHARE OF i`, [imagemId, salaoId, ctx.empresaId]);
  if (origem.rows[0]?.sha256 !== origemSha256) recusar("IMAGEM_NAO_ENCONTRADA", "A imagem do site foi removida ou mudou. Escolha outra.", 409);
  return comTraducao(async () => {
    const id = await inserirFoto(tx, ctx, salaoId, imagem, l, origemSha256);
    await auditar(tx, ctx, salaoId, "SALAO_FOTO_COPIADA_DO_SITE", { fotoId: id, imagemId });
    return lerApresentacao(tx, ctx.empresaId, salaoId);
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Declaração "salão como está hoje" (CDC art. 30): só com o resto pronto e na versão que o usuário viu.
// ---------------------------------------------------------------------------------------------------------------------
export async function confirmarDeclaracao(tx: DbExecutor, ctx: Contexto, salaoId: string, versaoVista: number) {
  await exigirApresentacaoInstalada(tx);
  const s = await travarSalao(tx, ctx.empresaId, salaoId, versaoVista);
  const fotos = (await fotosAtivas(tx, salaoId)).length;
  const falta = pendenciasPublicacao({
    ativo: s.ativo, capacidade: s.capacidade_convidados, fotosAtivas: fotos, fotosReferencia: s.fotos_referencia,
    outraFestaSimultanea: s.outra_festa_simultanea, conteudoVersao: s.conteudo_versao, declaracaoVersao: s.declaracao_versao,
  }, { semDeclaracao: true });
  if (falta.length > 0) recusar("SALAO_INCOMPLETO", falta.map((p) => TEXTO_PENDENCIA[p]).join(" "), 409);
  return comTraducao(async () => {
    await tx.query(`UPDATE agenda_saloes SET declaracao_em = clock_timestamp(), declaracao_por = $2::uuid, declaracao_versao = $3 WHERE id = $1::uuid`,
      [salaoId, ctx.usuarioId, versaoVista]);
    await auditar(tx, ctx, salaoId, "SALAO_DECLARACAO_CONFIRMADA", { versao: versaoVista });
    return lerApresentacao(tx, ctx.empresaId, salaoId);
  });
}
