import type { DbExecutor } from "../db/contracts.ts";
import { filtrarAdicionaisElegiveis } from "./adicionais-elegiveis.ts";
import { migration070Aplicada } from "./migration-070.ts";
import { PacoteAdminError } from "./pacotes-admin.ts";

/**
 * Adicionais oferecíveis de um pacote, SÓ dentro da empresa comprovada (Tenant Context).
 *
 * Diferente da consulta pública antiga (removida na PR-A), nada aqui escolhe pacote, tabela ou adicional
 * por "ativo" ou ordem entre empresas: pacote vigente DA EMPRESA pelo código, a única tabela de preços
 * publicada e corrente DA EMPRESA na data do evento, adicionais DA EMPRESA ligados ao pacote. Pacote de
 * outra empresa, legado sem empresa ou inexistente: a mesma recusa.
 *
 * Somente leitura. Aplica as regras oficiais (`adicionais-elegiveis.ts`): incluso no pacote nunca aparece
 * como pago; lembrancinha/empratado conforme o pacote; item de buffet incluso não vira adicional.
 * Adicional de categoria do buffet (070) traz os itens ativos que o cliente escolhe; sem item ativo, não é oferecido.
 */
export type EscolhasDoAdicional = { max: number | null; itens: Array<{ id: string; nome: string }> };
export type AdicionalOferecido = {
  codigo: string;
  nome: string;
  categoria: string;
  unidadeCobranca: string;
  preco: number;
  escolhas?: EscolhasDoAdicional;
};

function recusar(codigo: string, mensagem: string, status: number): never {
  throw new PacoteAdminError(codigo, mensagem, status);
}

export async function adicionaisDoPacoteNoTenant(
  tx: DbExecutor,
  entrada: { empresaId: string; pacoteCodigo: string; data: string; convidados: number },
): Promise<AdicionalOferecido[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entrada.data) || !Number.isInteger(entrada.convidados) || entrada.convidados < 1 || entrada.convidados > 1000) {
    recusar("DADOS_INVALIDOS", "Informe pacote, data e convidados válidos.", 400);
  }
  const pacotes = await tx.query<{ id: string }>(
    `SELECT id::text AS id FROM pacotes
      WHERE empresa_id = $1::uuid AND codigo = $2 AND vigente AND ativo AND arquivado_em IS NULL`,
    [entrada.empresaId, entrada.pacoteCodigo],
  );
  if (pacotes.rows.length !== 1) recusar("NAO_ENCONTRADO", "Pacote não encontrado nesta empresa.", 404);
  const pacoteId = pacotes.rows[0].id;
  const tabelas = await tx.query<{ id: string }>(
    `SELECT id::text AS id FROM tabelas_preco
      WHERE empresa_id = $1::uuid AND publicada_em IS NOT NULL AND substituida_em IS NULL
        AND vigencia_inicio <= $2::date AND (vigencia_fim IS NULL OR vigencia_fim >= $2::date)`,
    [entrada.empresaId, entrada.data],
  );
  if (tabelas.rows.length !== 1) recusar("PRECO_INDISPONIVEL", "Não há uma única tabela de preços valendo nesta data.", 409);
  const tabelaId = tabelas.rows[0].id;
  const tem070 = await migration070Aplicada(tx);
  const linhas = await tx.query<{
    codigo: string; nome: string; categoria: string; unidade_cobranca: string; modalidade: "INCLUSO" | "EXTRA" | "INDISPONIVEL";
    valor: string | null; origem_categoria: string | null; escolhas_max: number | null;
  }>(
    `SELECT a.codigo, a.nome, a.categoria, a.unidade_cobranca, pa.modalidade, preco.valor::text AS valor,
            ${tem070 ? "a.origem_buffet_categoria_id::text AS origem_categoria, a.escolhas_max" : "NULL::text AS origem_categoria, NULL::smallint AS escolhas_max"}
       FROM pacote_adicionais pa
       JOIN adicionais a ON a.id = pa.adicional_id AND a.ativo AND a.empresa_id = $1::uuid
       LEFT JOIN LATERAL (
         SELECT x.valor FROM precos_adicional x
          WHERE x.tabela_preco_id = $3::uuid AND x.adicional_id = a.id AND x.ativo
            AND x.convidados_min <= $4::smallint AND (x.convidados_max IS NULL OR x.convidados_max >= $4::smallint)
          ORDER BY x.convidados_min DESC LIMIT 1
       ) preco ON true
      WHERE pa.pacote_id = $2::uuid AND pa.ativo
      ORDER BY a.categoria, a.ordem_exibicao, a.codigo`,
    [entrada.empresaId, pacoteId, tabelaId, entrada.convidados],
  );
  const itensDoBuffet = await tx.query<{ codigo: string }>(
    `SELECT DISTINCT i.codigo FROM pacote_buffet_itens pbi JOIN buffet_itens i ON i.id = pbi.item_id WHERE pbi.pacote_id = $1::uuid`,
    [pacoteId],
  );
  const inclusos = new Set(itensDoBuffet.rows.map((l) => l.codigo));
  // Sem preço na tabela da empresa para esta faixa de convidados: não é oferecido (nunca preço inventado).
  const elegiveis = filtrarAdicionaisElegiveis(entrada.pacoteCodigo, linhas.rows, inclusos)
    .filter((l) => l.valor !== null && Number.isFinite(Number(l.valor)));
  const categorias = [...new Set(elegiveis.map((l) => l.origem_categoria).filter((c): c is string => Boolean(c)))];
  const porCategoria = new Map<string, Array<{ id: string; nome: string }>>();
  if (categorias.length) {
    const itens = await tx.query<{ id: string; nome: string; categoria_id: string }>(
      `SELECT id::text AS id, nome, categoria_id::text AS categoria_id FROM buffet_itens
        WHERE ativo AND categoria_id = ANY($1::uuid[])
        ORDER BY ordem_exibicao, nome`,
      [categorias],
    );
    for (const item of itens.rows) porCategoria.set(item.categoria_id, [...(porCategoria.get(item.categoria_id) ?? []), { id: item.id, nome: item.nome }]);
  }
  return elegiveis
    .filter((l) => !l.origem_categoria || (porCategoria.get(l.origem_categoria)?.length ?? 0) > 0)
    .map((l) => ({
      codigo: l.codigo,
      nome: l.nome,
      categoria: l.categoria,
      unidadeCobranca: l.unidade_cobranca,
      preco: Number(l.valor),
      ...(l.origem_categoria ? { escolhas: { max: l.escolhas_max == null ? null : Number(l.escolhas_max), itens: porCategoria.get(l.origem_categoria)! } } : {}),
    }));
}
