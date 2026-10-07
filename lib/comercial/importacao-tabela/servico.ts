import type { DbExecutor } from "../../db/contracts.ts";
import type { ArquivoValidado } from "../../importacao-contrato/arquivo.ts";
import { salvarAdicionalAdmin, vincularAdicionalAoPacote, type EmTransacao } from "../adicionais-admin.ts";
import { migration070Aplicada } from "../migration-070.ts";
import { lerPrecosCorrentes, publicarTabelaSucessora, substituirPrecosAdicionalNaTabela, substituirPrecosPacoteNaTabela } from "../pacote-precos.ts";
import { criarRevisaoPacoteAdmin, editarPacoteNaoUtilizado, PacoteAdminError } from "../pacotes-admin.ts";
import type { LeituraTabela } from "./esquema.ts";
import { bloqueiosDaRevisao, normalizarLeitura, type AdicionalCadastro, type CategoriaPreco, type Faixa, type PacoteAtualPrecos, type PacoteCadastro, type RevisaoTabela } from "./normalizar.ts";

/**
 * Importação da tabela de preços em PDF (por empresa, Tenant Context sempre do chamador).
 *
 * 1. `registrarImportacao`: guarda o PDF (RASCUNHO). 2. A camada de IA lê o PDF (fora de transação): vai ao provedor
 * com visão como DADO, saída num JSON fechado. 3. `gravarLeitura`: normaliza contra o cadastro atual e guarda a
 * revisão. 4. A pessoa revisa (`salvarRevisao`, com versão). 5. `publicarImportacao`: preços numa ÚNICA tabela
 * sucessora; depois descrição/convidados (revisão do pacote quando já usado) e inclusos, um pacote por transação.
 */
type Contexto = { empresaId: string; usuarioId: string; requestId: string };

/** Resultado da leitura feita pela camada de IA (lib/inteligencia/documentos/tabela-precos.ts). */
export type ResultadoLeitura = { ok: true; leitura: LeituraTabela; modelo: string; provedor: string } | { ok: false; aviso: string };

export class ImportacaoError extends PacoteAdminError {}

function recusar(codigo: string, mensagem: string, status: number): never {
  throw new ImportacaoError(codigo, mensagem, status);
}

export async function migration071Aplicada(tx: DbExecutor) {
  const r = await tx.query<{ ok: boolean }>(`SELECT to_regclass('public.importacoes_comerciais') IS NOT NULL AS ok`);
  return Boolean(r.rows[0]?.ok);
}

async function exigirMigrations(tx: DbExecutor) {
  if (!(await migration070Aplicada(tx)) || !(await migration071Aplicada(tx))) {
    recusar("MIGRACAO_PENDENTE", "A atualização do banco para importação de tabelas (070 e 071) ainda não foi aplicada.", 503);
  }
}

export type ImportacaoResumo = {
  id: string; tipo: string; situacao: string; arquivoNome: string; versao: number; metodo: string | null;
  modelo: string | null; avisos: string[]; revisao: RevisaoTabela | null; resultado: Record<string, unknown> | null;
  criadoEm: string; publicadoEm: string | null;
};

type Linha = {
  id: string; tipo: string; situacao: string; arquivo_nome: string; versao: number; metodo: string | null; modelo: string | null;
  avisos: string[]; revisao: RevisaoTabela | null; resultado: Record<string, unknown> | null; criado_em: Date; publicado_em: Date | null;
};

const COLUNAS = `id::text AS id, tipo, situacao, arquivo_nome, versao, metodo, modelo, avisos, revisao, resultado, criado_em, publicado_em`;

function resumo(l: Linha): ImportacaoResumo {
  return {
    id: l.id, tipo: l.tipo, situacao: l.situacao, arquivoNome: l.arquivo_nome, versao: Number(l.versao), metodo: l.metodo,
    modelo: l.modelo, avisos: l.avisos ?? [], revisao: l.revisao, resultado: l.resultado,
    criadoEm: new Date(l.criado_em).toISOString(), publicadoEm: l.publicado_em ? new Date(l.publicado_em).toISOString() : null,
  };
}

export async function registrarImportacao(tx: DbExecutor, ctx: Contexto, arquivo: ArquivoValidado) {
  await exigirMigrations(tx);
  if (arquivo.contentType !== "application/pdf") recusar("ARQUIVO_INVALIDO", "Envie a tabela de preços em PDF.", 415);
  const r = await tx.query<{ id: string }>(
    `INSERT INTO importacoes_comerciais (empresa_id, tipo, arquivo_nome, arquivo_sha256, arquivo_bytes, criado_por)
     VALUES ($1::uuid, 'TABELA_PRECOS', $2, $3, $4, $5::uuid) RETURNING id::text AS id`,
    [ctx.empresaId, arquivo.nomeSeguro.slice(0, 200), arquivo.sha256, Buffer.from(arquivo.bytes), ctx.usuarioId],
  );
  return r.rows[0].id;
}

/** Cadastro e preços atuais da empresa, no formato da normalização. */
export async function lerCadastroParaRevisao(tx: DbExecutor, empresaId: string) {
  const pacotes = await tx.query<{ id: string; codigo: string; nome: string; descricao: string | null; convidados_minimos: number | null; convidados_maximos: number | null }>(
    `SELECT id::text AS id, codigo, nome, descricao, convidados_minimos, convidados_maximos FROM pacotes
      WHERE empresa_id = $1::uuid AND vigente AND arquivado_em IS NULL ORDER BY ordem_exibicao, nome`,
    [empresaId],
  );
  const adicionais = await tx.query<{ id: string; codigo: string; nome: string; categoria: string; unidade_cobranca: string }>(
    `SELECT id::text AS id, codigo, nome, categoria, unidade_cobranca FROM adicionais WHERE empresa_id = $1::uuid AND ativo ORDER BY nome`,
    [empresaId],
  );
  const precos = await lerPrecosCorrentes(tx, empresaId);
  const precosPacotes: PacoteAtualPrecos[] = [];
  for (const p of precos.pacotes) {
    let item = precosPacotes.find((x) => x.pacoteId === p.pacoteId);
    if (!item) { item = { pacoteId: p.pacoteId, grades: [] }; precosPacotes.push(item); }
    let grade = item.grades.find((g) => g.categoria === p.categoria);
    if (!grade) { grade = { categoria: p.categoria, faixas: [], porConvidado: p.porConvidado }; item.grades.push(grade); }
    grade.faixas.push({ min: p.min, max: p.max, valor: p.valor, rotulo: null });
  }
  return {
    tabelaCorrenteId: precos.tabelaId,
    pacotes: pacotes.rows.map((p): PacoteCadastro => ({ id: p.id, codigo: p.codigo, nome: p.nome, descricao: p.descricao, convidadosMin: p.convidados_minimos, convidadosMax: p.convidados_maximos })),
    adicionais: adicionais.rows.map((a): AdicionalCadastro => ({
      id: a.id, codigo: a.codigo, nome: a.nome, categoria: a.categoria, unidade: a.unidade_cobranca,
      faixasAtuais: precos.adicionais.filter((x) => x.adicionalId === a.id).map((x) => ({ min: x.min, max: x.max, valor: x.valor, rotulo: x.rotulo })),
    })),
    precosPacotes,
  };
}

export async function gravarLeitura(
  tx: DbExecutor,
  ctx: Contexto,
  id: string,
  resultado: ResultadoLeitura,
) {
  const cadastro = await lerCadastroParaRevisao(tx, ctx.empresaId);
  const revisao = resultado.ok ? normalizarLeitura(resultado.leitura, cadastro) : null;
  const r = await tx.query<Linha>(
    `UPDATE importacoes_comerciais
        SET leitura = $3::jsonb, revisao = $4::jsonb, metodo = $5, provedor = $6, modelo = $7, avisos = $8::jsonb, versao = versao + 1
      WHERE id = $1::uuid AND empresa_id = $2::uuid AND situacao = 'RASCUNHO'
      RETURNING ${COLUNAS}`,
    [id, ctx.empresaId, resultado.ok ? JSON.stringify(resultado.leitura) : null, revisao ? JSON.stringify(revisao) : null,
      resultado.ok ? "VISAO" : null, resultado.ok ? resultado.provedor : null, resultado.ok ? resultado.modelo : null,
      JSON.stringify(resultado.ok ? [] : [resultado.aviso])],
  );
  return resumo(r.rows[0] ?? recusar("NAO_ENCONTRADO", "Importação não encontrada nesta empresa.", 404));
}

export async function lerImportacao(tx: DbExecutor, empresaId: string, id: string) {
  await exigirMigrations(tx);
  const r = await tx.query<Linha>(`SELECT ${COLUNAS} FROM importacoes_comerciais WHERE id = $1::uuid AND empresa_id = $2::uuid`, [id, empresaId]);
  return resumo(r.rows[0] ?? recusar("NAO_ENCONTRADO", "Importação não encontrada nesta empresa.", 404));
}

export async function listarImportacoes(tx: DbExecutor, empresaId: string) {
  if (!(await migration071Aplicada(tx))) return [];
  const r = await tx.query<Linha>(
    `SELECT ${COLUNAS} FROM importacoes_comerciais WHERE empresa_id = $1::uuid AND tipo = 'TABELA_PRECOS' ORDER BY criado_em DESC LIMIT 20`,
    [empresaId],
  );
  return r.rows.map((l) => ({ ...resumo(l), revisao: null }));
}

/** Bytes do PDF da importação (para reler com o modelo). */
export async function arquivoDaImportacao(tx: DbExecutor, empresaId: string, id: string) {
  const r = await tx.query<{ arquivo_nome: string; arquivo_bytes: Buffer; arquivo_sha256: string; situacao: string }>(
    `SELECT arquivo_nome, arquivo_bytes, arquivo_sha256, situacao FROM importacoes_comerciais WHERE id = $1::uuid AND empresa_id = $2::uuid`,
    [id, empresaId],
  );
  const l = r.rows[0] ?? recusar("NAO_ENCONTRADO", "Importação não encontrada nesta empresa.", 404);
  if (l.situacao !== "RASCUNHO") recusar("IMPORTACAO_ENCERRADA", "Esta importação já foi publicada ou descartada.", 409);
  const bytes = new Uint8Array(l.arquivo_bytes);
  const arquivo: ArquivoValidado = { contentType: "application/pdf", nomeSeguro: l.arquivo_nome, tamanhoBytes: bytes.length, sha256: l.arquivo_sha256, bytes };
  return arquivo;
}

export async function salvarRevisao(tx: DbExecutor, ctx: Contexto, id: string, versao: number, revisao: RevisaoTabela) {
  await exigirMigrations(tx);
  const r = await tx.query<Linha>(
    `UPDATE importacoes_comerciais SET revisao = $4::jsonb, versao = versao + 1
      WHERE id = $1::uuid AND empresa_id = $2::uuid AND versao = $3 AND situacao = 'RASCUNHO'
      RETURNING ${COLUNAS}`,
    [id, ctx.empresaId, versao, JSON.stringify(revisao)],
  );
  if (!r.rows[0]) {
    await lerImportacao(tx, ctx.empresaId, id);
    recusar("VERSAO_DESATUALIZADA", "Esta revisão foi alterada em outra tela. Recarregue antes de salvar.", 409);
  }
  return resumo(r.rows[0]);
}

export async function descartarImportacao(tx: DbExecutor, ctx: Contexto, id: string) {
  await exigirMigrations(tx);
  const r = await tx.query(
    `UPDATE importacoes_comerciais SET situacao = 'DESCARTADA', descartado_em = clock_timestamp()
      WHERE id = $1::uuid AND empresa_id = $2::uuid AND situacao = 'RASCUNHO' RETURNING id`,
    [id, ctx.empresaId],
  );
  if (!r.rowCount) recusar("IMPORTACAO_ENCERRADA", "Esta importação já foi publicada ou descartada.", 409);
}

const dinheiro = (v: number) => Number.isFinite(v) && v > 0 && v <= 99_999_999;

function validarFaixasPublicaveis(faixas: readonly Faixa[], rotulo: string) {
  if (!faixas.length) recusar("FAIXAS_INVALIDAS", `${rotulo}: nenhum preço para publicar.`, 409);
  faixas.forEach((f, i) => {
    const anterior = faixas[i - 1];
    const forma = Number.isInteger(f.min) && f.min >= 1 && (f.max == null || (Number.isInteger(f.max) && f.max >= f.min));
    const continua = !anterior || (anterior.max != null && f.min === anterior.max + 1);
    if (!forma || !continua) recusar("FAIXAS_INVALIDAS", `${rotulo}: as faixas precisam ser contínuas e sem sobreposição.`, 409);
    if (!dinheiro(f.valor)) recusar("FAIXAS_INVALIDAS", `${rotulo}: há preço inválido.`, 409);
  });
}

type PassoPublicacao = { passo: string; ok: boolean; erro?: string };

/**
 * Publica a revisão confirmada. Ordem: (1) preços — uma tabela sucessora, tudo ou nada; (2) descrição e convidados
 * de cada pacote (revisão quando já usado); (3) inclusos. Falha no passo 1 não grava nada; nos passos 2 e 3, o que
 * veio antes fica e o resultado diz o que faltou.
 */
export async function publicarImportacao(emTransacao: EmTransacao, ctx: Contexto, id: string, versao: number) {
  const preparo = await emTransacao(async (tx) => {
    const imp = await lerImportacao(tx, ctx.empresaId, id);
    if (imp.situacao !== "RASCUNHO") recusar("IMPORTACAO_ENCERRADA", "Esta importação já foi publicada ou descartada.", 409);
    if (imp.versao !== versao) recusar("VERSAO_DESATUALIZADA", "A revisão mudou desde que você abriu. Recarregue antes de publicar.", 409);
    if (!imp.revisao) recusar("SEM_LEITURA", "Esta importação ainda não tem leitura do PDF.", 409);
    const bloqueios = bloqueiosDaRevisao(imp.revisao);
    if (bloqueios.length) recusar("REVISAO_PENDENTE", bloqueios.slice(0, 3).join(" "), 409);
    return imp.revisao;
  });
  const revisao = preparo;
  const pacotes = revisao.pacotes.filter((p) => p.pacoteId && p.confirmado);
  const adicionais = revisao.adicionais.filter((a) => a.destino.tipo !== "IGNORAR" && a.confirmado);
  const passos: PassoPublicacao[] = [];

  // (1) Preços: uma única tabela sucessora.
  const precos = await emTransacao(async (tx) => {
    const cadastro = await lerCadastroParaRevisao(tx, ctx.empresaId);
    const novos = new Map<string, string>();
    for (const a of adicionais) {
      validarFaixasPublicaveis(a.faixas, a.nomePdf);
      if (a.destino.tipo === "NOVO") {
        const criado = await salvarAdicionalAdmin(tx, ctx, { nome: a.destino.nome, categoria: a.categoria, unidadeCobranca: a.unidade, ativo: true });
        novos.set(a.chave, criado.id);
      } else if (a.destino.tipo === "EXISTENTE" && !cadastro.adicionais.some((x) => x.id === (a.destino as { adicionalId: string }).adicionalId)) {
        recusar("ADICIONAL_INEXISTENTE", `${a.nomePdf}: o adicional escolhido não existe mais nesta empresa.`, 409);
      } else if (a.destino.tipo === "EXISTENTE") {
        await tx.query(`UPDATE adicionais SET unidade_cobranca = $3 WHERE id = $1::uuid AND empresa_id = $2::uuid`, [a.destino.adicionalId, ctx.empresaId, a.unidade]);
      }
    }
    for (const p of pacotes) {
      const atual = cadastro.pacotes.find((x) => x.id === p.pacoteId);
      if (!atual) recusar("PACOTE_INEXISTENTE", `${p.nomePdf}: o pacote escolhido não está mais vigente. Reabra a revisão.`, 409);
      if (p.cobranca === "FAIXAS") {
        for (const g of p.grades) validarFaixasPublicaveis(g.faixas, `${p.nomePdf} (${g.categoria})`);
        const primeira = Math.min(...p.grades.map((g) => g.faixas[0]?.min ?? Infinity));
        if (atual.convidadosMin != null && primeira < atual.convidadosMin) {
          recusar("FAIXA_FORA_DO_PACOTE", `${p.nomePdf}: a tabela começa em ${primeira} convidados e o pacote aceita a partir de ${atual.convidadosMin}.`, 409);
        }
      }
      if (p.cobranca === "POR_CONVIDADO" && !(p.porConvidado != null && dinheiro(p.porConvidado))) recusar("FAIXAS_INVALIDAS", `${p.nomePdf}: informe o valor por convidado.`, 409);
    }
    const r = await publicarTabelaSucessora(tx, ctx.empresaId, { ...ctx, motivo: "TABELA_IMPORTADA_DO_PDF" }, async (tabelaId) => {
      for (const p of pacotes) {
        if (p.cobranca === "FAIXAS") {
          await substituirPrecosPacoteNaTabela(tx, tabelaId, p.pacoteId!, { tipo: "FAIXAS", grades: p.grades.map((g) => ({ categoria: g.categoria as CategoriaPreco, faixas: g.faixas })) });
        } else if (p.cobranca === "POR_CONVIDADO") {
          await substituirPrecosPacoteNaTabela(tx, tabelaId, p.pacoteId!, { tipo: "POR_CONVIDADO", minimo: p.convidadosMin ?? 1, maximo: null, valor: p.porConvidado! });
        }
      }
      for (const a of adicionais) {
        const adicionalId = a.destino.tipo === "EXISTENTE" ? a.destino.adicionalId : novos.get(a.chave)!;
        await substituirPrecosAdicionalNaTabela(tx, tabelaId, adicionalId, a.faixas);
      }
      return { importacaoId: id, pacotes: pacotes.length, adicionais: adicionais.length };
    });
    return { tabelaId: r.tabelaId, novos: Object.fromEntries(novos) };
  });
  passos.push({ passo: "PRECOS", ok: true });

  // (2) Descrição e convidados.
  for (const p of pacotes) {
    const mudaConvidados = p.convidadosMax != null;
    if (!p.aplicarDescricao && !mudaConvidados) continue;
    try {
      await emTransacao(async (tx) => {
        const atual = await tx.query<{ id: string; nome: string; descricao: string | null; duracao_minutos: number | null; convidados_minimos: number | null; convidados_maximos: number | null; usado: boolean }>(
          `SELECT p.id::text AS id, p.nome, p.descricao, p.duracao_minutos, p.convidados_minimos, p.convidados_maximos,
                  (EXISTS (SELECT 1 FROM fechamentos f WHERE f.pacote_id = p.id)
                   OR EXISTS (SELECT 1 FROM fechamento_pacote_snapshots s WHERE s.pacote_id = p.id)
                   OR EXISTS (SELECT 1 FROM fechamento_revisoes r WHERE r.pacote_id = p.id)) AS usado
             FROM pacotes p WHERE p.id = $1::uuid AND p.empresa_id = $2::uuid AND p.vigente`,
          [p.pacoteId, ctx.empresaId],
        );
        const a = atual.rows[0] ?? recusar("PACOTE_INEXISTENTE", "Pacote não está mais vigente.", 409);
        const dados = {
          nome: a.nome,
          descricao: p.aplicarDescricao ? (p.descricao?.trim() || null) : a.descricao,
          duracaoMinutos: a.duracao_minutos,
          convidadosMinimos: p.convidadosMin ?? a.convidados_minimos,
          convidadosMaximos: p.convidadosMax ?? a.convidados_maximos,
        };
        if (dados.descricao === a.descricao && dados.convidadosMinimos === a.convidados_minimos && dados.convidadosMaximos === a.convidados_maximos) return;
        const contexto = { ...ctx, motivo: "Descrição importada do PDF da tabela de preços" };
        if (a.usado) await criarRevisaoPacoteAdmin(tx, a.id, dados, contexto);
        else await editarPacoteNaoUtilizado(tx, a.id, dados, contexto);
      });
      passos.push({ passo: `DESCRICAO:${p.nomePdf}`, ok: true });
    } catch (error) {
      passos.push({ passo: `DESCRICAO:${p.nomePdf}`, ok: false, erro: error instanceof Error ? error.message : "Falha" });
    }
  }

  // (3) Inclusos: o pacote vigente (pode ser a revisão recém-criada) recebe INCLUSO para cada adicional escolhido.
  for (const p of pacotes.filter((x) => x.aplicarInclusos)) {
    for (const incluso of p.inclusos.filter((i) => i.adicionalId)) {
      try {
        await emTransacao(async (tx) => {
          const vigente = await tx.query<{ id: string }>(
            `SELECT p.id::text AS id FROM pacotes p
              WHERE p.empresa_id = $2::uuid AND p.vigente AND p.arquivado_em IS NULL
                AND (p.id = $1::uuid OR p.codigo = (SELECT codigo FROM pacotes WHERE id = $1::uuid))
              LIMIT 1`,
            [p.pacoteId, ctx.empresaId],
          );
          await vincularAdicionalAoPacote(tx, ctx, incluso.adicionalId!, vigente.rows[0]?.id ?? p.pacoteId!, "INCLUSO");
        });
        passos.push({ passo: `INCLUSO:${p.nomePdf}:${incluso.texto}`, ok: true });
      } catch (error) {
        passos.push({ passo: `INCLUSO:${p.nomePdf}:${incluso.texto}`, ok: false, erro: error instanceof Error ? error.message : "Falha" });
      }
    }
  }

  const resultado = { tabelaId: precos.tabelaId, adicionaisNovos: precos.novos, passos, publicadoEm: new Date().toISOString() };
  await emTransacao(async (tx) => {
    await tx.query(
      `UPDATE importacoes_comerciais SET situacao = 'PUBLICADA', publicado_em = clock_timestamp(), publicado_por = $3::uuid, resultado = $4::jsonb
        WHERE id = $1::uuid AND empresa_id = $2::uuid AND situacao = 'RASCUNHO'`,
      [id, ctx.empresaId, ctx.usuarioId, JSON.stringify(resultado)],
    );
  });
  return resultado;
}
