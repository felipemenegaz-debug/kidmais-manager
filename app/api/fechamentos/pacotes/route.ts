import { NextResponse } from "next/server";
import { db } from "@/lib/db/postgres";
import { limitesPizzaParty, PACOTES_CONTRATAVEIS_V1 } from "@/lib/comercial/pacotes-v1";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const codigosPublicos = PACOTES_CONTRATAVEIS_V1.map((pacote) => pacote.codigo);

export async function GET() {
  try {
    const resultado = await db().query<{
      codigo: string;
      nome: string;
      descricao: string | null;
      duracao_minutos: number | null;
      convidados_minimos: number | null;
      convidados_maximos: number | null;
      preco_minimo: string | null;
    }>(
      `SELECT p.codigo, p.nome, p.descricao, p.duracao_minutos, p.convidados_minimos, p.convidados_maximos,
              (SELECT MIN(pp.valor)::text
                 FROM precos_pacote pp
                 JOIN tabelas_preco t ON t.id = pp.tabela_preco_id
                WHERE pp.pacote_id = p.id
                  AND pp.ativo
                  AND t.ativa
                  AND t.vigencia_inicio <= CURRENT_DATE
                  AND (t.vigencia_fim IS NULL OR t.vigencia_fim >= CURRENT_DATE)) AS preco_minimo
         FROM pacotes p
        WHERE p.ativo
          AND p.codigo = ANY($1::text[])
        ORDER BY p.ordem_exibicao, p.codigo`,
      [codigosPublicos],
    );
    return NextResponse.json({
      pacotes: resultado.rows.map((row) => {
        const minimo = row.convidados_minimos === null ? null : Number(row.convidados_minimos);
        const maximo = row.convidados_maximos === null ? null : Number(row.convidados_maximos);
        const limites = row.codigo === "PIZZA_PARTY" ? limitesPizzaParty({ minimo, maximo }) : { minimo, maximo };
        return {
          codigo: row.codigo,
          nome: row.nome,
          descricao: row.descricao,
          duracaoMinutos: row.duracao_minutos === null ? null : Number(row.duracao_minutos),
          convidadosMinimos: limites.minimo,
          convidadosMaximos: limites.maximo,
          precoMinimo: row.preco_minimo,
        };
      }),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ erro: "Pacotes indisponíveis no momento." }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
