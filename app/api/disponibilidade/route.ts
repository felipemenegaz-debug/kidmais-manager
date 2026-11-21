import type { HorarioCandidatoPublico } from "@/lib/disponibilidade/services/models";
import { aplicarOferta, ofertasDoIntervalo } from "@/lib/comercial/oferta-intervalo";
import { NextRequest, NextResponse } from "next/server";
import {
  consultarDisponibilidadeData,
  consultarDisponibilidadePeriodo,
  duracaoAceita,
  isAvailabilityServiceError,
} from "@/lib/disponibilidade/services";
import { escopoPublico } from "@/lib/disponibilidade/escopo";
import { codigoEmpresaDoPedido, escopoCotacaoPublica } from "@/lib/comercial/cotacao-publica";
import type { DbExecutor, DbQueryResult } from "@/lib/db/contracts";
import { db } from "@/lib/db/postgres";
import { limitarPublico } from "@/lib/http/limite-publico";
import { convidadosDaConsulta } from "@/lib/fechamentos/convidados-consulta";
import { combinadosPublicos } from "@/lib/agenda/combinados-publicos";
import { descontosPublicosDaEmpresa } from "@/lib/comercial/descontos-dia-publico";
import { descontosPorIdV1 } from "@/lib/comercial/descontos-dia";
import { lerConfigLegada } from "@/lib/disponibilidade/config-legada-armazem";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Apenas sondagens de catálogo sem parâmetros, repetidas na resolução do escopo público ou na agenda.
const consultasDeCatalogo = [
  /^SELECT to_regprocedure\('public\.kidmais062_ocupacoes_escopo\(date,date\)'\) IS NOT NULL AS instalada$/,
  /^SELECT to_regprocedure\('public\.kidmais094_conflito_ocupacao\([^']+\)'\) IS NOT NULL AS ok$/,
  /^SELECT \(SELECT count\(\*\)::int FROM \(VALUES .* AS e\(nome, h\) JOIN pg_proc[\s\S]* AS marcador114$/,
  /^SELECT to_regclass\('public\.assinatura_contratacoes'\) IS NOT NULL\s+AND to_regclass\('public\.assinatura_isencoes'\) IS NOT NULL\s+AND to_regclass\('public\.assinatura_fundadores'\) IS NOT NULL AS instalado074$/,
];

function conexaoDaConsulta(): () => DbExecutor {
  const executor = db();
  const catalogo = new Map<string, Promise<DbQueryResult<object>>>();
  const leitura: DbExecutor = {
    query<Row extends object>(sql: string, params?: readonly unknown[]) {
      if (params?.length || !consultasDeCatalogo.some(padrao => padrao.test(sql))) {
        return executor.query<Row>(sql, params);
      }
      const lida = catalogo.get(sql);
      if (lida) return lida as Promise<DbQueryResult<Row>>;
      const consulta = executor.query<Row>(sql, params);
      catalogo.set(sql, consulta);
      return consulta;
    },
  };
  return () => leitura;
}

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
  // 128: banco quando a linha existe; senão o arquivo do disco (até a cópia). Arquivo ausente ou ilegível já vira listas
  // vazias dentro de lerConfigLegada; erro do banco NÃO vira vazio: sobe para o GET, que responde erro em vez de uma
  // agenda sem as regras comerciais.
  const parsed = (await lerConfigLegada(db())) as ComercialLegado;

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
}

export async function GET(request: NextRequest) {
  const limite = await limitarPublico(request, "LEITURA");
  if (limite) return limite;
  try {
    const { searchParams } = new URL(request.url);
    const data = searchParams.get("data")?.trim();
    const inicio = searchParams.get("inicio")?.trim();
    const fim = searchParams.get("fim")?.trim();
    // S-C: convidados opcionais (1..1000); ausente = resposta de antes; inválido = 400.
    const convidados = convidadosDaConsulta(searchParams.get("convidados"));
    if (convidados === null) {
      return NextResponse.json(
        { ok: false, erro: "Informe a quantidade de convidados com um número inteiro de 1 a 1000.", codigo: "PARAMETROS_INVALIDOS" },
        { status: 400 },
      );
    }
    const db = conexaoDaConsulta();
    // 2c-2: duração da festa (minutos) para os inícios do horário livre; sem ela, 4 horas.
    // E2b: o combinado conta como opção só com combinadosPublicos; desligado, as opções de antes (sem o campo).
    const saloesLivres = new Map<HorarioCandidatoPublico, string[]>();
    const opcoes = {
      duracaoMinutos: duracaoAceita(searchParams.get("duracao")), ...(convidados ? { convidados, saloesLivres } : {}),
      ...((await combinadosPublicos(db())) ? { incluirCombinados: true } : {}),
      executorComSondagensReutilizadas: db(),
    };
    // Endereço da empresa (/b/<código>): mesma regra da cotação pública; sem código, só a configuração do servidor.
    const codigo = codigoEmpresaDoPedido(request.nextUrl);
    const escopo = codigo === null
      ? await escopoPublico(db)
      : await escopoCotacaoPublica(db, codigo).then(({ empresaId, estabelecimentoId }) => ({ empresaId, estabelecimentoId }));

    const [resultado, comercial] = await Promise.all([
      data
        ? consultarDisponibilidadeData(data, undefined, undefined, escopo, opcoes)
        : inicio && fim
          ? consultarDisponibilidadePeriodo(inicio, fim, undefined, undefined, escopo, opcoes)
          : Promise.reject(
              new Error(
                "Informe data=YYYY-MM-DD ou inicio=YYYY-MM-DD&fim=YYYY-MM-DD.",
              ),
            ),
      // Ajustes do arquivo legado são da instalação (endereço atual); nunca aparecem no endereço de outra empresa.
      // D4: no endereço da empresa, os descontos por dia vêm das regras dela (as mesmas que a cotação aplica).
      // Endereço atual (Kidmais, 18/11/2026): também as regras da empresa dona da agenda, com a chave no id V1 que a tela
      // usa. Com o campo, a tela ignora o 15% fixo e os descontos de data do arquivo (que a cotação não cobra); sem
      // empresa no escopo, sem o campo, e a tela segue pelo caminho antigo.
      codigo === null
        ? Promise.all([lerComercialPublico(), escopo.empresaId ? descontosPublicosDaEmpresa(db(), escopo.empresaId) : Promise.resolve(null)])
            .then(([legado, descontosEmpresa]) => ({ ...legado, ...(descontosEmpresa ? { descontosEmpresa: descontosPorIdV1(descontosEmpresa) } : {}) }))
        : (escopo.empresaId ? descontosPublicosDaEmpresa(db(), escopo.empresaId) : Promise.resolve(null)).then((descontosEmpresa) => ({
            pacoteOverrides: [], descontos: [], ...(descontosEmpresa ? { descontosEmpresa } : {}),
          })),
    ]);

    const ofertas = convidados && escopo.empresaId && (data || (inicio && fim))
      ? await ofertasDoIntervalo(db(), escopo.empresaId, codigo === null, data || inicio!, data || fim!, convidados, saloesLivres.size > 0)
      : [];
    const dias = convidados
      ? Array.isArray(resultado)
        ? resultado.map(dia => aplicarOferta(dia, ofertas, codigo === null, convidados, saloesLivres))
        : aplicarOferta(resultado, ofertas, codigo === null, convidados, saloesLivres)
      : resultado;
    return NextResponse.json(
      { ok: true, data: dias, comercial },
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
