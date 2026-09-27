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
const AVISO_PUBLICADO = "Os preços que já valem continuam protegidos, para não mudar festa ou contrato antigo. A alteração de preço não foi aplicada.";

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

export async function lerFaixasPacote(tx: DbExecutor, empresaId: string, pacoteId: string): Promise<LeituraFaixas> {
  const aberta = await tx.query<{ id: string }>(
    `SELECT id FROM tabelas_preco
      WHERE empresa_id = $1::uuid AND publicada_em IS NULL
      ORDER BY criado_em DESC
      LIMIT 1`,
    [empresaId],
  );
  if (aberta.rows[0]) {
    const linhas = await linhasDaTabela(tx, empresaId, pacoteId, aberta.rows[0].id);
    if (linhas.length > 0) return classificar(linhas);
  }
  const publicada = await tx.query<{ id: string }>(
    `SELECT id FROM tabelas_preco
      WHERE empresa_id = $1::uuid AND publicada_em IS NOT NULL
      ORDER BY vigencia_inicio DESC, publicada_em DESC
      LIMIT 1`,
    [empresaId],
  );
  if (!publicada.rows[0]) return { editavel: true, faixas: [], aviso: null };
  return classificar(await linhasDaTabela(tx, empresaId, pacoteId, publicada.rows[0].id));
}

async function tabelaAberta(tx: DbExecutor, empresaId: string, ctx: Contexto) {
  const aberta = await tx.query<{ id: string; publicada_em: string | null }>(
    `SELECT id, publicada_em::text AS publicada_em
       FROM tabelas_preco
      WHERE empresa_id = $1::uuid AND publicada_em IS NULL
      ORDER BY criado_em DESC
      LIMIT 1
      FOR UPDATE`,
    [empresaId],
  );
  if (aberta.rows[0]) {
    if (aberta.rows[0].publicada_em) recusar("PRECO_VIGENTE_PROTEGIDO", AVISO_PUBLICADO, 409);
    return aberta.rows[0].id;
  }
  const hoje = new Date().toISOString().slice(0, 10);
  const criada = await tx.query<{ id: string }>(
    `INSERT INTO tabelas_preco (empresa_id, codigo, nome, vigencia_inicio, vigencia_fim, ativa)
     VALUES ($1::uuid, $2, $3, $4::date, NULL, false)
     RETURNING id`,
    [empresaId, `PCOM_${randomUUID().replaceAll("-", "").slice(0, 24).toUpperCase()}`, "Preços dos pacotes", hoje],
  );
  const id = criada.rows[0]?.id ?? recusar("DADOS_INVALIDOS", "Não foi possível guardar os preços.", 500);
  await auditarMutacaoComercial(tx, {
    usuarioId: ctx.usuarioId,
    requestId: ctx.requestId,
    motivo: ctx.motivo ?? "PACOTE_EDITADO",
    acao: "TABELA_PRECO_CRIADA",
    entidadeTipo: "TABELA_PRECO",
    entidadeId: id,
    empresaId,
    antes: null,
    depois: { origem: "PACOTE" },
  });
  return id;
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
  if (!leitura.editavel) return { aplicado: false, aviso: leitura.aviso };
  const prontas = validarFaixas(faixas, limites);
  if (faixasIguais(prontas, leitura.faixas)) return { aplicado: true, aviso: null };
  const publicada = await tx.query(
    `SELECT 1 FROM tabelas_preco
      WHERE empresa_id = $1::uuid
        AND publicada_em IS NOT NULL
        AND vigencia_inicio <= CURRENT_DATE
        AND (vigencia_fim IS NULL OR vigencia_fim >= CURRENT_DATE)
      LIMIT 1`,
    [empresaId],
  );
  if (publicada.rows[0]) return { aplicado: false, aviso: AVISO_PUBLICADO };
  const tabelaId = await tabelaAberta(tx, empresaId, ctx);
  const presos = await tx.query(
    `SELECT 1
       FROM precos_pacote pp
      WHERE pp.tabela_preco_id = $1::uuid
        AND pp.pacote_id = $2::uuid
        AND (
          EXISTS (SELECT 1 FROM fechamentos f WHERE f.preco_pacote_id = pp.id)
          OR EXISTS (SELECT 1 FROM fechamento_pacote_snapshots s WHERE s.preco_pacote_id = pp.id)
          OR EXISTS (SELECT 1 FROM fechamento_revisoes r WHERE r.preco_pacote_id = pp.id)
        )
      LIMIT 1`,
    [tabelaId, pacoteId],
  );
  if (presos.rows[0]) return { aplicado: false, aviso: AVISO_PUBLICADO };
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
  if (prontas.length > 0) {
    const escopo = await tx.query<{ id: string }>(
      `INSERT INTO tabela_preco_escopos (
         tabela_preco_id, pacote_id, categoria_horario, cobertura_continua,
         limite_convidados_min, limite_convidados_max
       ) VALUES ($1::uuid, $2::uuid, 'GERAL', $3, NULL, NULL)
       RETURNING id`,
      [tabelaId, pacoteId, faixasContiguas(prontas, limites)],
    );
    const escopoId = escopo.rows[0]?.id ?? recusar("DADOS_INVALIDOS", "Não foi possível guardar os preços.", 500);
    for (const faixa of prontas) {
      await tx.query(
        `INSERT INTO tabela_preco_escopo_faixas (escopo_id, convidados_min, convidados_max)
         VALUES ($1::uuid, $2, $3)`,
        [escopoId, faixa.convidadosMin, faixa.convidadosMax],
      );
    }
  }
  await auditarMutacaoComercial(tx, {
    usuarioId: ctx.usuarioId,
    requestId: ctx.requestId,
    motivo: ctx.motivo ?? "PACOTE_EDITADO",
    acao: "PRECO_PACOTE_INCLUIDO",
    entidadeTipo: "TABELA_PRECO",
    entidadeId: tabelaId,
    empresaId,
    antes: { faixas: leitura.faixas },
    depois: { pacoteId, faixas: prontas },
  });
  return { aplicado: true, aviso: null as string | null };
}
