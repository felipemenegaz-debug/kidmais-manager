import { randomUUID } from "node:crypto";
import type { DbExecutor } from "../db/contracts.ts";
import { auditarMutacaoComercial } from "./auditoria-comercial.ts";
import { faixasContiguas, validarFaixas, type FaixaFixa } from "./modelo-preco.ts";
import { PacoteAdminError } from "./pacotes-admin.ts";

type Contexto = { empresaId: string; usuarioId: string; requestId: string; motivo?: string };

export type LeituraFaixas = {
  editavel: boolean;
  faixas: FaixaFixa[];
  aviso: string | null;
};

const AVISO_HORARIO = "Este pacote tem preços diferentes conforme o horário. A tela não junta esses valores, para não perder a diferença.";
const AVISO_POR_CONVIDADO = "Este pacote cobra por convidado. A tela de faixas não altera esse cálculo.";
const PRECO_BLOQUEADO = "Não consegui aplicar o preço novo sem mudar o que já foi contratado. Nada foi salvo.";
const PRECO_NAO_SALVO = "Não foi possível guardar os preços. Nada foi salvo.";
const PRECO_NAO_PRESERVADO = "Não foi possível preservar o preço atual deste pacote. Nenhuma alteração foi salva.";

function faixasIguais(atuais: FaixaFixa[], anteriores: FaixaFixa[]) {
  if (atuais.length !== anteriores.length) return false;
  return atuais.every((faixa, indice) => {
    const anterior = anteriores[indice];
    return anterior
      && faixa.convidadosMin === anterior.convidadosMin
      && faixa.convidadosMax === anterior.convidadosMax
      && faixa.valor === anterior.valor;
  });
}

function recusar(code: string, message: string, status: number): never {
  throw new PacoteAdminError(code, message, status);
}

type LinhaPreco = {
  tabela_id: string;
  publicada: boolean;
  convidados_min: number;
  convidados_max: number | null;
  tipo_calculo: string;
  valor: string;
  categoria_horario: string;
};

async function linhasDaTabela(tx: DbExecutor, empresaId: string, pacoteId: string, tabelaId: string) {
  const result = await tx.query<LinhaPreco>(
    `SELECT t.id AS tabela_id, t.publicada_em IS NOT NULL AS publicada,
            pp.convidados_min, pp.convidados_max, pp.tipo_calculo, pp.valor::text AS valor, pp.categoria_horario
       FROM precos_pacote pp
       JOIN tabelas_preco t ON t.id = pp.tabela_preco_id
      WHERE pp.pacote_id = $1::uuid
        AND pp.ativo
        AND t.empresa_id = $2::uuid
        AND t.id = $3::uuid
      ORDER BY pp.categoria_horario, pp.convidados_min`,
    [pacoteId, empresaId, tabelaId],
  );
  return result.rows;
}

function classificar(linhas: LinhaPreco[]): LeituraFaixas {
  if (linhas.length === 0) return { editavel: true, faixas: [], aviso: null };
  if (linhas.some((linha) => linha.tipo_calculo === "POR_CONVIDADO")) {
    return { editavel: false, faixas: [], aviso: AVISO_POR_CONVIDADO };
  }
  if (linhas.some((linha) => linha.tipo_calculo !== "FIXO")) {
    return { editavel: false, faixas: [], aviso: AVISO_HORARIO };
  }
  const grupos = new Map<string, string>();
  for (const linha of linhas) {
    const chave = `${linha.convidados_min}:${linha.convidados_max ?? ""}:${linha.valor}`;
    const grupo = grupos.get(linha.categoria_horario) ?? "";
    grupos.set(linha.categoria_horario, `${grupo}|${chave}`);
  }
  const assinaturas = [...grupos.values()];
  if (new Set(assinaturas).size > 1) return { editavel: false, faixas: [], aviso: AVISO_HORARIO };
  const categoria = linhas[0]?.categoria_horario;
  const faixas = linhas
    .filter((linha) => linha.categoria_horario === categoria)
    .map((linha) => ({
      convidadosMin: Number(linha.convidados_min),
      convidadosMax: linha.convidados_max == null ? null : Number(linha.convidados_max),
      valor: Number(linha.valor).toFixed(2),
    }));
  return { editavel: true, faixas, aviso: null };
}

const CORRENTE = `
  empresa_id = $1::uuid
  AND publicada_em IS NOT NULL
  AND substituida_em IS NULL
  AND vigencia_inicio <= CURRENT_DATE
  AND (vigencia_fim IS NULL OR vigencia_fim >= CURRENT_DATE)`;

async function tabelaDeHoje(tx: DbExecutor, empresaId: string) {
  const tabelas = await tx.query<{ id: string; publicada: boolean }>(
    `SELECT id, publicada_em IS NOT NULL AS publicada
       FROM tabelas_preco
      WHERE ${CORRENTE}
      ORDER BY vigencia_inicio, criado_em`,
    [empresaId],
  );
  if (tabelas.rows.length > 1) recusar("PRECO_AMBIGUO", "Há mais de um preço valendo ao mesmo tempo. Nada foi salvo.", 409);
  return tabelas.rows[0] ?? null;
}

export async function lerFaixasPacote(tx: DbExecutor, empresaId: string, pacoteId: string): Promise<LeituraFaixas> {
  const tabela = await tabelaDeHoje(tx, empresaId);
  if (!tabela) return { editavel: true, faixas: [], aviso: null };
  return classificar(await linhasDaTabela(tx, empresaId, pacoteId, tabela.id));
}

function codigoTabela() {
  return `PCOM_${randomUUID().replaceAll("-", "").slice(0, 24).toUpperCase()}`;
}

async function travarEmpresa(tx: DbExecutor, empresaId: string) {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext('kidmais-048-supersessao'))`);
  await tx.query(`SELECT kidmais_037_trava_publicacao($1::uuid)`, [empresaId]);
}

async function travarCorrente(tx: DbExecutor, empresaId: string) {
  const tabelas = await tx.query<{ id: string }>(
    `SELECT id
       FROM tabelas_preco
      WHERE ${CORRENTE}
      FOR UPDATE`,
    [empresaId],
  );
  if (tabelas.rows.length > 1) recusar("PRECO_AMBIGUO", "Há mais de um preço valendo ao mesmo tempo. Nada foi salvo.", 409);
  return tabelas.rows[0]?.id ?? null;
}

async function criarNaoPublicada(tx: DbExecutor, empresaId: string, origemId: string | null) {
  const criada = origemId
    ? await tx.query<{ id: string }>(
      `INSERT INTO tabelas_preco (empresa_id, codigo, nome, vigencia_inicio, vigencia_fim, ativa)
       SELECT $1::uuid, $2, $3, vigencia_inicio, vigencia_fim, false
         FROM tabelas_preco
        WHERE id = $4::uuid
          AND empresa_id = $1::uuid
          AND publicada_em IS NOT NULL
          AND substituida_em IS NULL
       RETURNING id`,
      [empresaId, codigoTabela(), "Preços dos pacotes", origemId],
    )
    : await tx.query<{ id: string }>(
      `INSERT INTO tabelas_preco (empresa_id, codigo, nome, vigencia_inicio, vigencia_fim, ativa)
       VALUES ($1::uuid, $2, $3, CURRENT_DATE, NULL, false)
       RETURNING id`,
      [empresaId, codigoTabela(), "Preços dos pacotes"],
    );
  return criada.rows[0]?.id ?? recusar("DADOS_INVALIDOS", PRECO_NAO_SALVO, 500);
}

async function copiarAgregado(tx: DbExecutor, empresaId: string, origemId: string, destinoId: string) {
  await tx.query(
    `INSERT INTO precos_pacote (
       tabela_preco_id, pacote_id, convidados_min, convidados_max, tipo_calculo, valor, categoria_horario, ativo
     )
     SELECT $1::uuid, pp.pacote_id, pp.convidados_min, pp.convidados_max, pp.tipo_calculo, pp.valor, pp.categoria_horario, pp.ativo
       FROM precos_pacote pp
       JOIN pacotes p ON p.id = pp.pacote_id
      WHERE pp.tabela_preco_id = $2::uuid
        AND pp.ativo
        AND p.empresa_id = $3::uuid`,
    [destinoId, origemId, empresaId],
  );
  await tx.query(
    `INSERT INTO precos_adicional (
       tabela_preco_id, adicional_id, convidados_min, convidados_max, valor, observacoes, ativo
     )
     SELECT $1::uuid, adicional_id, convidados_min, convidados_max, valor, observacoes, ativo
       FROM precos_adicional
      WHERE tabela_preco_id = $2::uuid
        AND ativo`,
    [destinoId, origemId],
  );
  await tx.query(
    `WITH copiados AS (
       INSERT INTO tabela_preco_escopos (
         tabela_preco_id, pacote_id, categoria_horario, cobertura_continua,
         limite_convidados_min, limite_convidados_max
       )
       SELECT $1::uuid, pacote_id, categoria_horario, cobertura_continua,
              limite_convidados_min, limite_convidados_max
         FROM tabela_preco_escopos
        WHERE tabela_preco_id = $2::uuid
       RETURNING id, pacote_id, categoria_horario
     )
     INSERT INTO tabela_preco_escopo_faixas (escopo_id, convidados_min, convidados_max)
     SELECT c.id, f.convidados_min, f.convidados_max
       FROM copiados c
       JOIN tabela_preco_escopos e
         ON e.tabela_preco_id = $2::uuid
        AND e.pacote_id = c.pacote_id
        AND e.categoria_horario = c.categoria_horario
       JOIN tabela_preco_escopo_faixas f ON f.escopo_id = e.id`,
    [destinoId, origemId],
  );
}

async function substituirFaixas(
  tx: DbExecutor,
  tabelaId: string,
  pacoteId: string,
  prontas: FaixaFixa[],
  limites: { minimo: number; maximo: number },
) {
  await tx.query(
    `DELETE FROM tabela_preco_escopo_faixas f
      USING tabela_preco_escopos e
      WHERE f.escopo_id = e.id
        AND e.tabela_preco_id = $1::uuid
        AND e.pacote_id = $2::uuid`,
    [tabelaId, pacoteId],
  );
  await tx.query(
    `DELETE FROM tabela_preco_escopos WHERE tabela_preco_id = $1::uuid AND pacote_id = $2::uuid`,
    [tabelaId, pacoteId],
  );
  await tx.query(
    `DELETE FROM precos_pacote WHERE tabela_preco_id = $1::uuid AND pacote_id = $2::uuid`,
    [tabelaId, pacoteId],
  );
  for (const faixa of prontas) {
    await tx.query(
      `INSERT INTO precos_pacote (
         tabela_preco_id, pacote_id, convidados_min, convidados_max, tipo_calculo, valor, categoria_horario
       ) VALUES ($1::uuid, $2::uuid, $3, $4, 'FIXO', $5, 'GERAL')`,
      [tabelaId, pacoteId, faixa.convidadosMin, faixa.convidadosMax, faixa.valor],
    );
  }
  if (prontas.length === 0) return;
  const escopo = await tx.query<{ id: string }>(
    `INSERT INTO tabela_preco_escopos (
       tabela_preco_id, pacote_id, categoria_horario, cobertura_continua,
       limite_convidados_min, limite_convidados_max
     ) VALUES ($1::uuid, $2::uuid, 'GERAL', $3, NULL, NULL)
     RETURNING id`,
    [tabelaId, pacoteId, faixasContiguas(prontas, limites)],
  );
  const escopoId = escopo.rows[0]?.id ?? recusar("DADOS_INVALIDOS", PRECO_NAO_SALVO, 500);
  for (const faixa of prontas) {
    await tx.query(
      `INSERT INTO tabela_preco_escopo_faixas (escopo_id, convidados_min, convidados_max)
       VALUES ($1::uuid, $2, $3)`,
      [escopoId, faixa.convidadosMin, faixa.convidadosMax],
    );
  }
}

async function validarCompleta(tx: DbExecutor, tabelaId: string) {
  const lacuna = await tx.query<{ codigo: string }>(
    `SELECT codigo FROM kidmais_047_lacunas_escopo($1::uuid) LIMIT 1`,
    [tabelaId],
  );
  if (lacuna.rows[0]) recusar("PRECO_INCOMPLETO", PRECO_NAO_SALVO, 409);
}

async function ligarSupersessao(tx: DbExecutor, empresaId: string, anteriorId: string, sucessoraId: string) {
  const ligada = await tx.query<{ id: string }>(
    `UPDATE tabelas_preco
        SET substituida_por_id = $3::uuid,
            substituida_em = clock_timestamp()
      WHERE id = $1::uuid
        AND empresa_id = $2::uuid
        AND publicada_em IS NOT NULL
        AND substituida_em IS NULL
        AND substituida_por_id IS NULL
      RETURNING id`,
    [anteriorId, empresaId, sucessoraId],
  );
  if (!ligada.rows[0]) recusar("PRECO_AMBIGUO", "Há mais de um preço valendo ao mesmo tempo. Nada foi salvo.", 409);
}

async function publicar(tx: DbExecutor, empresaId: string, tabelaId: string) {
  const publicada = await tx.query<{ id: string }>(
    `UPDATE tabelas_preco
        SET publicada_em = clock_timestamp()
      WHERE id = $1::uuid
        AND empresa_id = $2::uuid
        AND publicada_em IS NULL
        AND ativa = false
      RETURNING id`,
    [tabelaId, empresaId],
  );
  if (!publicada.rows[0]) recusar("PRECO_INCOMPLETO", PRECO_NAO_SALVO, 409);
}

async function exigirUmaCorrente(tx: DbExecutor, empresaId: string) {
  const tabelas = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM tabelas_preco
      WHERE ${CORRENTE}`,
    [empresaId],
  );
  if (Number(tabelas.rows[0]?.n) !== 1) recusar("PRECO_AMBIGUO", "Há mais de um preço valendo ao mesmo tempo. Nada foi salvo.", 409);
}

async function concluirTabela(
  tx: DbExecutor,
  empresaId: string,
  origemId: string | null,
  tabelaId: string,
  ctx: Contexto,
  auditoria: { antes: Record<string, unknown> | null; depois: Record<string, unknown> },
) {
  await validarCompleta(tx, tabelaId);
  if (origemId) await ligarSupersessao(tx, empresaId, origemId, tabelaId);
  await publicar(tx, empresaId, tabelaId);
  await exigirUmaCorrente(tx, empresaId);
  await auditarMutacaoComercial(tx, {
    usuarioId: ctx.usuarioId,
    requestId: ctx.requestId,
    motivo: ctx.motivo ?? "PACOTE_EDITADO",
    acao: "PRECO_PACOTE_INCLUIDO",
    entidadeTipo: "TABELA_PRECO",
    entidadeId: tabelaId,
    empresaId,
    antes: auditoria.antes,
    depois: auditoria.depois,
  });
}

export async function gravarFaixasPacote(
  tx: DbExecutor,
  empresaId: string,
  pacoteId: string,
  faixas: FaixaFixa[] | null,
  limites: { minimo: number; maximo: number },
  ctx: Contexto,
) {
  if (faixas == null) return { aplicado: true, aviso: null as string | null };
  const leitura = await lerFaixasPacote(tx, empresaId, pacoteId);
  if (!leitura.editavel) recusar("PRECO_NAO_EDITAVEL", leitura.aviso ?? PRECO_BLOQUEADO, 409);
  const prontas = validarFaixas(faixas, limites);
  if (faixasIguais(prontas, leitura.faixas)) return { aplicado: true, aviso: null };
  await travarEmpresa(tx, empresaId);
  const origemId = await travarCorrente(tx, empresaId);
  const tabelaId = await criarNaoPublicada(tx, empresaId, origemId);
  if (origemId) await copiarAgregado(tx, empresaId, origemId, tabelaId);
  await substituirFaixas(tx, tabelaId, pacoteId, prontas, limites);
  await concluirTabela(tx, empresaId, origemId, tabelaId, ctx, {
    antes: { faixas: leitura.faixas, tabelaCorrenteId: origemId },
    depois: { pacoteId, faixas: prontas, sucessoraDe: origemId },
  });
  return { aplicado: true, aviso: null as string | null };
}

async function copiarPacoteNaTabela(tx: DbExecutor, origemTabelaId: string, origemPacoteId: string, destinoTabelaId: string, destinoPacoteId: string) {
  await tx.query(
    `INSERT INTO precos_pacote (
       tabela_preco_id, pacote_id, convidados_min, convidados_max, tipo_calculo, valor, categoria_horario, ativo
     )
     SELECT $1::uuid, $2::uuid, convidados_min, convidados_max, tipo_calculo, valor, categoria_horario, ativo
       FROM precos_pacote
      WHERE tabela_preco_id = $3::uuid
        AND pacote_id = $4::uuid
        AND ativo`,
    [destinoTabelaId, destinoPacoteId, origemTabelaId, origemPacoteId],
  );
  await tx.query(
    `WITH copiados AS (
       INSERT INTO tabela_preco_escopos (
         tabela_preco_id, pacote_id, categoria_horario, cobertura_continua,
         limite_convidados_min, limite_convidados_max
       )
       SELECT $1::uuid, $2::uuid, categoria_horario, cobertura_continua,
              limite_convidados_min, limite_convidados_max
         FROM tabela_preco_escopos
        WHERE tabela_preco_id = $3::uuid
          AND pacote_id = $4::uuid
       RETURNING id, categoria_horario
     )
     INSERT INTO tabela_preco_escopo_faixas (escopo_id, convidados_min, convidados_max)
     SELECT c.id, f.convidados_min, f.convidados_max
       FROM copiados c
       JOIN tabela_preco_escopos e
         ON e.tabela_preco_id = $3::uuid
        AND e.pacote_id = $4::uuid
        AND e.categoria_horario = c.categoria_horario
       JOIN tabela_preco_escopo_faixas f ON f.escopo_id = e.id`,
    [destinoTabelaId, destinoPacoteId, origemTabelaId, origemPacoteId],
  );
}

/**
 * Uma revisão de pacote utilizado e a troca de faixas compartilham a mesma sucessora.
 * O save não pode publicar B e em seguida substituir B por C.
 */
export async function aplicarPrecoDaRevisao(
  tx: DbExecutor,
  empresaId: string,
  origemPacoteId: string,
  destinoPacoteId: string,
  faixas: FaixaFixa[] | null,
  limites: { minimo: number; maximo: number },
  ctx: Contexto,
) {
  await travarEmpresa(tx, empresaId);
  const origemTabelaId = await travarCorrente(tx, empresaId);
  const linhas = origemTabelaId ? await linhasDaTabela(tx, empresaId, origemPacoteId, origemTabelaId) : [];
  if (faixas == null) {
    if (!origemTabelaId || linhas.length === 0) recusar("PRECO_INCOMPLETO", PRECO_NAO_PRESERVADO, 409);
    const tabelaId = await criarNaoPublicada(tx, empresaId, origemTabelaId);
    await copiarAgregado(tx, empresaId, origemTabelaId, tabelaId);
    await copiarPacoteNaTabela(tx, origemTabelaId, origemPacoteId, tabelaId, destinoPacoteId);
    await concluirTabela(tx, empresaId, origemTabelaId, tabelaId, ctx, {
      antes: { pacoteOrigemId: origemPacoteId, tabelaCorrenteId: origemTabelaId },
      depois: { pacoteId: destinoPacoteId, precoPreservado: true, sucessoraDe: origemTabelaId },
    });
    return { aplicado: true, aviso: null as string | null };
  }
  const prontas = validarFaixas(faixas, limites);
  if (prontas.length === 0) recusar("PRECO_INCOMPLETO", PRECO_NAO_PRESERVADO, 409);
  if (!origemTabelaId) {
    const tabelaId = await criarNaoPublicada(tx, empresaId, null);
    await substituirFaixas(tx, tabelaId, destinoPacoteId, prontas, limites);
    await concluirTabela(tx, empresaId, null, tabelaId, ctx, {
      antes: null,
      depois: { pacoteId: destinoPacoteId, faixas: prontas },
    });
    return { aplicado: true, aviso: null as string | null };
  }
  const leitura = classificar(linhas);
  const manter = leitura.editavel && faixasIguais(prontas, leitura.faixas);
  if (!manter && !leitura.editavel) recusar("PRECO_NAO_EDITAVEL", leitura.aviso ?? PRECO_BLOQUEADO, 409);
  const tabelaId = await criarNaoPublicada(tx, empresaId, origemTabelaId);
  await copiarAgregado(tx, empresaId, origemTabelaId, tabelaId);
  await copiarPacoteNaTabela(tx, origemTabelaId, origemPacoteId, tabelaId, destinoPacoteId);
  if (!manter) await substituirFaixas(tx, tabelaId, destinoPacoteId, prontas, limites);
  await concluirTabela(tx, empresaId, origemTabelaId, tabelaId, ctx, {
    antes: { pacoteOrigemId: origemPacoteId, tabelaCorrenteId: origemTabelaId, faixas: leitura.faixas },
    depois: { pacoteId: destinoPacoteId, faixas: manter ? leitura.faixas : prontas, sucessoraDe: origemTabelaId },
  });
  return { aplicado: true, aviso: null as string | null };
}

export async function copiarPrecosPacote(
  tx: DbExecutor,
  empresaId: string,
  origemId: string,
  destinoId: string,
  ctx: Contexto,
) {
  const leitura = await tabelaDeHoje(tx, empresaId);
  if (!leitura) return;
  const linhas = await linhasDaTabela(tx, empresaId, origemId, leitura.id);
  if (linhas.length === 0) return;
  await travarEmpresa(tx, empresaId);
  const origemTabelaId = await travarCorrente(tx, empresaId);
  if (!origemTabelaId) recusar("PRECO_AMBIGUO", "Há mais de um preço valendo ao mesmo tempo. Nada foi salvo.", 409);
  const tabelaId = await criarNaoPublicada(tx, empresaId, origemTabelaId);
  await copiarAgregado(tx, empresaId, origemTabelaId, tabelaId);
  await copiarPacoteNaTabela(tx, origemTabelaId, origemId, tabelaId, destinoId);
  await concluirTabela(tx, empresaId, origemTabelaId, tabelaId, ctx, {
    antes: { pacoteOrigemId: origemId, tabelaCorrenteId: origemTabelaId },
    depois: { pacoteId: destinoId, sucessoraDe: origemTabelaId },
  });
}
