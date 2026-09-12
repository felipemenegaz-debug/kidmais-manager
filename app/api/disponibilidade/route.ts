import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import {
  consultarDisponibilidadeData,
  consultarDisponibilidadePeriodo,
  isAvailabilityServiceError,
} from "@/lib/disponibilidade/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const arquivoComercialLegado = path.join(
  process.cwd(),
  "data",
  "disponibilidade.json",
);

type ComercialLegado = {
  pacoteOverrides?: Array<{
    data: string;
    horario: "almoco" | "noite";
    pacote: string;
    status: "liberado" | "consulta" | "excecao" | "bloqueado";
    motivo?: string;
  }>;
  descontos?: Array<{
    data: string;
    horario: "almoco" | "noite";
    pacote: string;
    percentual: number;
    titulo?: string;
  }>;
};

async function lerComercialPublico() {
  try {
    const conteudo = await fs.readFile(arquivoComercialLegado, "utf8");
    const parsed = JSON.parse(conteudo) as ComercialLegado;

    return {
      // Motivos/observações internas não saem pela API pública.
      pacoteOverrides: (parsed.pacoteOverrides ?? []).map((item) => ({
        data: item.data,
        horario: item.horario,
        pacote: item.pacote,
        status: item.status,
      })),
      descontos: (parsed.descontos ?? []).map((item) => ({
        data: item.data,
        horario: item.horario,
        pacote: item.pacote,
        percentual: item.percentual,
        titulo: item.titulo,
      })),
    };
  } catch {
    return { pacoteOverrides: [], descontos: [] };
  }
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const data = searchParams.get("data")?.trim();
    const inicio = searchParams.get("inicio")?.trim();
    const fim = searchParams.get("fim")?.trim();

    const [resultado, comercial] = await Promise.all([
      data
        ? consultarDisponibilidadeData(data)
        : inicio && fim
          ? consultarDisponibilidadePeriodo(inicio, fim)
          : Promise.reject(
              new Error(
                "Informe data=YYYY-MM-DD ou inicio=YYYY-MM-DD&fim=YYYY-MM-DD.",
              ),
            ),
      lerComercialPublico(),
    ]);

    return NextResponse.json(
      { ok: true, data: resultado, comercial },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (isAvailabilityServiceError(error)) {
      return NextResponse.json(
        {
          ok: false,
          erro: error.message,
          codigo: error.code,
          detalhes: error.details ?? null,
        },
        { status: error.httpStatus },
      );
    }

    if (error instanceof Error && error.message.startsWith("Informe data=")) {
      return NextResponse.json(
        {
          ok: false,
          erro: error.message,
          codigo: "PARAMETROS_INVALIDOS",
        },
        { status: 400 },
      );
    }

    console.error("[Kidmais Disponibilidade API] erro não tratado", error);
    return NextResponse.json(
      {
        ok: false,
        erro: "Não foi possível consultar a disponibilidade agora. Tente novamente.",
        codigo: "ERRO_CONSULTA_DISPONIBILIDADE",
      },
      { status: 500 },
    );
  }
}
