import { randomUUID } from "node:crypto";
import type { DbExecutor } from "../db/contracts.ts";
import { auditarMutacaoComercial } from "./auditoria-comercial.ts";
import { validarVinculoComposicao } from "./composicao.ts";
import { MOTIVOS_PACOTE } from "./motivos-pacote.ts";
import { migration070Aplicada } from "./migration-070.ts";
import { gravarPrecoAdicional, lerPrecosAdicionais, lerPrecosCorrentes, publicarTabelaSucessora, substituirPrecosAdicionalNaTabela } from "./pacote-precos.ts";
import { PacoteAdminError, alterarComposicaoPacoteAdmin } from "./pacotes-admin.ts";

/**
 * Adicionais da empresa no admin (Configurações › Itens do Buffet).
 *
 * Três origens: um item do buffet ("Coxinha extra"), uma categoria do buffet ("Cento de salgados extra", o cliente
 * escolhe os itens) ou nenhuma (mesas, decoração, combos…). O buffet é global e não é tocado: a origem só aponta
 * para ele. Preço na tabela da empresa (sucessão publicada, `gravarPrecoAdicional`) e oferta por pacote pela
 * composição oficial (`alterarComposicaoPacoteAdmin`). Nada é oferecido em pacote nenhum até ser marcado.
 */
export const UNIDADES_ADICIONAL = ["UNIDADE", "CENTO", "CONVIDADO", "PACOTE", "VALOR_FIXO", "HORA", "METRO"] as const;
export type UnidadeAdicional = (typeof UNIDADES_ADICIONAL)[number];
export type ModalidadeAdicional = "INCLUSO" | "EXTRA" | "INDISPONIVEL";
export type OrigemAdicional = { tipo: "ITEM" | "CATEGORIA"; id: string };

export type AdicionalAdmin = {
  id: string;
  codigo: string;
  nome: string;
  categoria: string;
  unidadeCobranca: string;
  ativo: boolean;
  origem: OrigemAdicional | null;
  escolhasMax: number | null;
  preco: string | null;
  faixasPreco: number;
  /** Faixas atuais (tabela publicada de hoje), com rótulo (ex.: "Pequena"). */
  faixas: FaixaAdicional[];
  pacotes: Record<string, ModalidadeAdicional>;
};

export type EntradaAdicional = {
  id?: string;
  origem?: OrigemAdicional;
  nome: string;
  categoria: string;
  unidadeCobranca: UnidadeAdicional;
  ativo: boolean;
  escolhasMax?: number | null;
  /** undefined: não mexe no preço; null: tira o preço. */
  preco?: string | null;
  /** Preço por faixa de convidados (substitui o preço único). undefined: não mexe. */
  faixas?: FaixaAdicional[];
  /** Só os pacotes que mudam (gravados por `salvarAdicionalEmEtapas`, um pacote por transação). */
  pacotes?: Record<string, ModalidadeAdicional>;
};

/** Executa o trabalho numa transação própria da empresa comprovada. */
export type EmTransacao = <T>(trabalho: (tx: DbExecutor) => Promise<T>) => Promise<T>;

type Contexto = { empresaId: string; usuarioId: string; requestId: string };
export type FaixaAdicional = { min: number; max: number | null; valor: number; rotulo: string | null };

function recusar(codigo: string, mensagem: string, status: number): never {
  throw new PacoteAdminError(codigo, mensagem, status);
}

const colunasOrigem = (tem070: boolean) => tem070
  ? "a.origem_buffet_item_id::text AS origem_item, a.origem_buffet_categoria_id::text AS origem_categoria, a.escolhas_max"
  : "NULL::text AS origem_item, NULL::text AS origem_categoria, NULL::smallint AS escolhas_max";

export async function lerAdicionaisAdmin(tx: DbExecutor, empresaId: string) {
  const tem070 = await migration070Aplicada(tx);
  const adicionais = await tx.query<{
    id: string; codigo: string; nome: string; categoria: string; unidade_cobranca: string; ativo: boolean;
    origem_item: string | null; origem_categoria: string | null; escolhas_max: number | null;
  }>(
    `SELECT a.id::text AS id, a.codigo, a.nome, a.categoria, a.unidade_cobranca, a.ativo, ${colunasOrigem(tem070)}
       FROM adicionais a
      WHERE a.empresa_id = $1::uuid
      ORDER BY a.categoria, a.ordem_exibicao, a.nome`,
    [empresaId],
  );
  const pacotes = await tx.query<{ id: string; codigo: string; nome: string }>(
    `SELECT id::text AS id, codigo, nome FROM pacotes
      WHERE empresa_id = $1::uuid AND vigente AND arquivado_em IS NULL
      ORDER BY ordem_exibicao, nome`,
    [empresaId],
  );
  const vinculos = await tx.query<{ pacote_id: string; adicional_id: string; modalidade: ModalidadeAdicional }>(
    `SELECT pa.pacote_id::text AS pacote_id, pa.adicional_id::text AS adicional_id, pa.modalidade
       FROM pacote_adicionais pa
       JOIN pacotes p ON p.id = pa.pacote_id AND p.empresa_id = $1::uuid AND p.vigente AND p.arquivado_em IS NULL
      WHERE pa.ativo`,
    [empresaId],
  );
  const categorias = await tx.query<{ codigo: string; nome: string }>(
    `SELECT codigo, nome FROM adicional_categorias WHERE ativo ORDER BY ordem_exibicao, nome`,
  );
  let leitura: Awaited<ReturnType<typeof lerPrecosAdicionais>> = { tabelaCorrente: false, precos: new Map() };
  let correntes: Awaited<ReturnType<typeof lerPrecosCorrentes>>["adicionais"] = [];
  let aviso: string | null = null;
  try {
    leitura = await lerPrecosAdicionais(tx, empresaId);
    correntes = (await lerPrecosCorrentes(tx, empresaId)).adicionais;
  } catch (error) {
    if (!(error instanceof PacoteAdminError)) throw error;
    aviso = error.message;
  }
  return {
    migracaoPendente: !tem070,
    tabelaCorrente: leitura.tabelaCorrente,
    aviso,
    categorias: categorias.rows,
    pacotes: pacotes.rows,
    adicionais: adicionais.rows.map((a): AdicionalAdmin => ({
      id: a.id,
      codigo: a.codigo,
      nome: a.nome,
      categoria: a.categoria,
      unidadeCobranca: a.unidade_cobranca,
      ativo: a.ativo,
      origem: a.origem_item ? { tipo: "ITEM", id: a.origem_item } : a.origem_categoria ? { tipo: "CATEGORIA", id: a.origem_categoria } : null,
      escolhasMax: a.escolhas_max == null ? null : Number(a.escolhas_max),
      preco: leitura.precos.get(a.id)?.valor ?? null,
      faixasPreco: leitura.precos.get(a.id)?.faixas ?? 0,
      faixas: correntes.filter((f) => f.adicionalId === a.id).map((f) => ({ min: f.min, max: f.max, valor: f.valor, rotulo: f.rotulo })),
      pacotes: Object.fromEntries(vinculos.rows.filter((v) => v.adicional_id === a.id).map((v) => [v.pacote_id, v.modalidade])),
    })),
  };
}

function codigoLivre(nome: string) {
  const base = nome.normalize("NFD").replace(/\p{M}/gu, "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 60);
  return `${base || "ADICIONAL"}_${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`;
}

async function codigoDisponivel(tx: DbExecutor, empresaId: string, desejado: string) {
  const usado = await tx.query(`SELECT 1 FROM adicionais WHERE empresa_id = $1::uuid AND codigo = $2`, [empresaId, desejado]);
  return usado.rowCount ? `${desejado.slice(0, 72)}_${randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}` : desejado;
}

async function origemDoBuffet(tx: DbExecutor, origem: OrigemAdicional) {
  const tabela = origem.tipo === "ITEM" ? "buffet_itens" : "buffet_categorias";
  const r = await tx.query<{ codigo: string; nome: string }>(`SELECT codigo, nome FROM ${tabela} WHERE id = $1::uuid`, [origem.id]);
  return r.rows[0] ?? recusar("NAO_ENCONTRADO", origem.tipo === "ITEM" ? "Item do buffet não encontrado." : "Categoria do buffet não encontrada.", 404);
}

/**
 * Uma tabela publicada só pode ter UMA sucessora por transação (048: a sucessora tem de continuar corrente no
 * COMMIT). Preço do adicional e revisão de pacote já usado publicam cada um a sua; por isso o cadastro + preço vão
 * numa transação e cada pacote alterado em outra. Se um pacote falhar, o que veio antes fica salvo e o erro diz qual.
 */
export async function salvarAdicionalEmEtapas(emTransacao: EmTransacao, ctx: Contexto, entrada: EntradaAdicional) {
  const { pacotes, ...cadastro } = entrada;
  const salvo = await emTransacao((tx) => salvarAdicionalAdmin(tx, ctx, cadastro));
  for (const [pacoteId, modalidade] of Object.entries(pacotes ?? {})) {
    try {
      await emTransacao((tx) => vincularAdicionalAoPacote(tx, ctx, salvo.id, pacoteId, modalidade));
    } catch (error) {
      if (!(error instanceof PacoteAdminError)) throw error;
      throw new PacoteAdminError(error.code, `Adicional salvo, mas um pacote não foi atualizado: ${error.message}`, error.httpStatus, { adicionalId: salvo.id, pacoteId });
    }
  }
  return salvo;
}

export async function vincularAdicionalAoPacote(tx: DbExecutor, ctx: Contexto, adicionalId: string, pacoteId: string, modalidade: ModalidadeAdicional) {
  const vinculo = await tx.query<{ pacote: string; adicional: string; modalidade: ModalidadeAdicional | null }>(
    `SELECT p.codigo AS pacote, a.codigo AS adicional, pa.modalidade
       FROM pacotes p
       JOIN adicionais a ON a.id = $2::uuid AND a.empresa_id = p.empresa_id
       LEFT JOIN pacote_adicionais pa ON pa.pacote_id = p.id AND pa.adicional_id = a.id AND pa.ativo
      WHERE p.id = $1::uuid AND p.empresa_id = $3::uuid AND p.vigente AND p.arquivado_em IS NULL`,
    [pacoteId, adicionalId, ctx.empresaId],
  );
  const linha = vinculo.rows[0] ?? recusar("NAO_ENCONTRADO", "Pacote não encontrado nesta empresa.", 404);
  if ((linha.modalidade ?? "INDISPONIVEL") === modalidade) return;
  validarVinculoComposicao({ pacoteCodigo: linha.pacote, adicionalCodigo: linha.adicional, modalidade, modalidadeAtual: linha.modalidade });
  await alterarComposicaoPacoteAdmin(tx, pacoteId, { tipo: "vinculo", adicionalId, modalidade }, { ...ctx, motivo: MOTIVOS_PACOTE.composicao });
}

export type ResultadoExclusaoAdicional = { resultado: "EXCLUIDO" | "ARQUIVADO"; festas: number; pacotes: number };

/**
 * Exclusão pedida pela tela. Sem nenhum histórico, a linha é apagada. Com histórico (preço em tabela publicada,
 * vínculo com pacote, festa ou contrato, todos ON DELETE RESTRICT), o adicional é ARQUIVADO (ativo = false): some
 * do fechamento, continua no que já existe e pode ser reativado. A decisão é do próprio banco (FK), não de uma lista.
 */
export async function excluirAdicionalAdmin(tx: DbExecutor, ctx: Contexto, adicionalId: string): Promise<ResultadoExclusaoAdicional> {
  const r = await tx.query<{ nome: string; ativo: boolean }>(
    `SELECT nome, ativo FROM adicionais WHERE id = $1::uuid AND empresa_id = $2::uuid FOR UPDATE`,
    [adicionalId, ctx.empresaId],
  );
  const atual = r.rows[0] ?? recusar("NAO_ENCONTRADO", "Adicional não encontrado nesta empresa.", 404);
  const uso = (await tx.query<{ festas: number; pacotes: number }>(
    `SELECT (SELECT count(DISTINCT fechamento_id)::int FROM fechamento_adicionais WHERE adicional_id = $1::uuid) AS festas,
            (SELECT count(*)::int FROM pacote_adicionais WHERE adicional_id = $1::uuid AND ativo) AS pacotes`,
    [adicionalId],
  )).rows[0];
  const auditar = (acao: string, depois: Record<string, unknown> | null) => auditarMutacaoComercial(tx, {
    usuarioId: ctx.usuarioId, requestId: ctx.requestId, motivo: acao, acao, entidadeTipo: "ADICIONAL", entidadeId: adicionalId,
    empresaId: ctx.empresaId, antes: { nome: atual.nome, ativo: atual.ativo }, depois,
  });
  await tx.query("SAVEPOINT excluir_adicional");
  try {
    await tx.query(`DELETE FROM adicionais WHERE id = $1::uuid AND empresa_id = $2::uuid`, [adicionalId, ctx.empresaId]);
    await tx.query("RELEASE SAVEPOINT excluir_adicional");
    await auditar("ADICIONAL_EXCLUIDO", null);
    return { resultado: "EXCLUIDO", ...uso };
  } catch (error) {
    // 23001 = ON DELETE RESTRICT; 23503 = NO ACTION: alguma tabela ainda referencia o adicional.
    const codigo = (error as { code?: unknown }).code;
    if (codigo !== "23001" && codigo !== "23503") throw error;
    await tx.query("ROLLBACK TO SAVEPOINT excluir_adicional");
  }
  if (atual.ativo) await tx.query(`UPDATE adicionais SET ativo = false WHERE id = $1::uuid AND empresa_id = $2::uuid`, [adicionalId, ctx.empresaId]);
  await auditar("ADICIONAL_ARQUIVADO", { nome: atual.nome, ativo: false });
  return { resultado: "ARQUIVADO", ...uso };
}

/** Cadastro e preço do adicional (no máximo uma tabela sucessora). Pacotes: `salvarAdicionalEmEtapas`. */
export async function salvarAdicionalAdmin(tx: DbExecutor, ctx: Contexto, entrada: Omit<EntradaAdicional, "pacotes">) {
  if (!(await migration070Aplicada(tx))) {
    recusar("MIGRACAO_PENDENTE", "A atualização do banco para adicionais do buffet (070) ainda não foi aplicada.", 503);
  }
  const nome = entrada.nome.trim();
  if (nome.length < 1 || nome.length > 160) recusar("DADOS_INVALIDOS", "Informe o nome do adicional.", 400);
  if (!UNIDADES_ADICIONAL.includes(entrada.unidadeCobranca)) recusar("DADOS_INVALIDOS", "Unidade de cobrança inválida.", 400);
  const categoria = await tx.query<{ id: string }>(`SELECT id::text AS id FROM adicional_categorias WHERE codigo = $1 AND ativo`, [entrada.categoria]);
  const categoriaId = categoria.rows[0]?.id ?? recusar("DADOS_INVALIDOS", "Categoria do adicional inválida.", 400);

  let atual: { id: string; ativo: boolean; nome: string; categoria: string; unidade_cobranca: string; origem_categoria: string | null; escolhas_max: number | null } | undefined;
  if (entrada.id) {
    const r = await tx.query<NonNullable<typeof atual>>(
      `SELECT id::text AS id, ativo, nome, categoria, unidade_cobranca, origem_buffet_categoria_id::text AS origem_categoria, escolhas_max
         FROM adicionais WHERE id = $1::uuid AND empresa_id = $2::uuid FOR UPDATE`,
      [entrada.id, ctx.empresaId],
    );
    atual = r.rows[0] ?? recusar("NAO_ENCONTRADO", "Adicional não encontrado nesta empresa.", 404);
  } else if (entrada.origem) {
    const coluna = entrada.origem.tipo === "ITEM" ? "origem_buffet_item_id" : "origem_buffet_categoria_id";
    const r = await tx.query<NonNullable<typeof atual>>(
      `SELECT id::text AS id, ativo, nome, categoria, unidade_cobranca, origem_buffet_categoria_id::text AS origem_categoria, escolhas_max
         FROM adicionais WHERE empresa_id = $1::uuid AND ${coluna} = $2::uuid FOR UPDATE`,
      [ctx.empresaId, entrada.origem.id],
    );
    atual = r.rows[0];
  }

  const deCategoria = atual ? atual.origem_categoria !== null : entrada.origem?.tipo === "CATEGORIA";
  const escolhasMax = deCategoria ? (entrada.escolhasMax ?? null) : null;
  if (escolhasMax !== null && (!Number.isInteger(escolhasMax) || escolhasMax < 1 || escolhasMax > 30)) {
    recusar("DADOS_INVALIDOS", "O máximo de escolhas vai de 1 a 30.", 400);
  }

  let adicionalId: string;
  if (atual) {
    adicionalId = atual.id;
    await tx.query(
      `UPDATE adicionais SET nome = $3, categoria = $4, categoria_id = $5::uuid, unidade_cobranca = $6, ativo = $7, escolhas_max = $8
        WHERE id = $1::uuid AND empresa_id = $2::uuid`,
      [adicionalId, ctx.empresaId, nome, entrada.categoria, categoriaId, entrada.unidadeCobranca, entrada.ativo, escolhasMax],
    );
    await auditarMutacaoComercial(tx, {
      usuarioId: ctx.usuarioId, requestId: ctx.requestId, motivo: "ADICIONAL_EDITADO", acao: "ADICIONAL_EDITADO",
      entidadeTipo: "ADICIONAL", entidadeId: adicionalId, empresaId: ctx.empresaId,
      antes: { nome: atual.nome, categoria: atual.categoria, unidadeCobranca: atual.unidade_cobranca, ativo: atual.ativo, escolhasMax: atual.escolhas_max },
      depois: { nome, categoria: entrada.categoria, unidadeCobranca: entrada.unidadeCobranca, ativo: entrada.ativo, escolhasMax },
    });
  } else {
    const fonte = entrada.origem ? await origemDoBuffet(tx, entrada.origem) : null;
    const desejado = !entrada.origem ? codigoLivre(nome)
      : entrada.origem.tipo === "ITEM" ? fonte!.codigo : `CATEGORIA_${fonte!.codigo}`.slice(0, 80);
    const codigo = await codigoDisponivel(tx, ctx.empresaId, desejado);
    const criado = await tx.query<{ id: string }>(
      `INSERT INTO adicionais (empresa_id, codigo, nome, categoria, categoria_id, unidade_cobranca, ordem_exibicao, ativo,
                               origem_buffet_item_id, origem_buffet_categoria_id, escolhas_max)
       VALUES ($1::uuid, $2, $3, $4, $5::uuid, $6,
               (SELECT COALESCE(max(ordem_exibicao), 0) + 1 FROM adicionais WHERE empresa_id = $1::uuid),
               $7, $8::uuid, $9::uuid, $10)
       RETURNING id::text AS id`,
      [ctx.empresaId, codigo, nome, entrada.categoria, categoriaId, entrada.unidadeCobranca, entrada.ativo,
        entrada.origem?.tipo === "ITEM" ? entrada.origem.id : null,
        entrada.origem?.tipo === "CATEGORIA" ? entrada.origem.id : null,
        escolhasMax],
    );
    adicionalId = criado.rows[0].id;
    await auditarMutacaoComercial(tx, {
      usuarioId: ctx.usuarioId, requestId: ctx.requestId, motivo: "ADICIONAL_CRIADO", acao: "ADICIONAL_CRIADO",
      entidadeTipo: "ADICIONAL", entidadeId: adicionalId, empresaId: ctx.empresaId, antes: null,
      depois: { codigo, nome, categoria: entrada.categoria, unidadeCobranca: entrada.unidadeCobranca, origem: entrada.origem ?? null, escolhasMax },
    });
  }

  if (entrada.faixas !== undefined) {
    const corrente = await tx.query(`SELECT 1 FROM tabelas_preco WHERE empresa_id = $1::uuid AND publicada_em IS NOT NULL AND substituida_em IS NULL
      AND vigencia_inicio <= CURRENT_DATE AND (vigencia_fim IS NULL OR vigencia_fim >= CURRENT_DATE)`, [ctx.empresaId]);
    if (!corrente.rowCount) recusar("TABELA_NAO_PUBLICADA", "Publique a tabela de preços dos pacotes antes de definir o valor do adicional.", 409);
    const faixas = entrada.faixas;
    await publicarTabelaSucessora(tx, ctx.empresaId, { ...ctx, motivo: "PRECO_ADICIONAL_ALTERADO" }, async (tabelaId) => {
      await substituirPrecosAdicionalNaTabela(tx, tabelaId, adicionalId, faixas);
      return { adicionalId, faixas };
    }, "PRECO_ADICIONAL_ALTERADO");
  } else if (entrada.preco !== undefined) {
    await gravarPrecoAdicional(tx, ctx.empresaId, adicionalId, entrada.preco, { ...ctx, motivo: "PRECO_ADICIONAL_ALTERADO" });
  }

  return { id: adicionalId };
}
