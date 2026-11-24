import { db } from "../db/postgres.ts";
import { CODIGO_EMPRESA_PUBLICA } from "../http/empresas-publicas.ts";

type AmbienteEmpresaLegada = {
  AGENDA_PUBLICA_EMPRESA_CODIGO?: string;
  AGENDA_PUBLICA_EMPRESA_ID?: string;
};

type EmpresaPublica = { id: string; status: string };

async function consultarEmpresa(codigo: string): Promise<EmpresaPublica | undefined> {
  const { rows } = await db().query<EmpresaPublica>("SELECT id, status FROM empresas WHERE codigo = $1", [codigo]);
  return rows[0];
}

export async function modoEmpresaPublicaLegada(
  codigo: string,
  env: AmbienteEmpresaLegada = {
    AGENDA_PUBLICA_EMPRESA_CODIGO: process.env.AGENDA_PUBLICA_EMPRESA_CODIGO,
    AGENDA_PUBLICA_EMPRESA_ID: process.env.AGENDA_PUBLICA_EMPRESA_ID,
  },
  consultar: (codigo: string) => Promise<EmpresaPublica | undefined> = consultarEmpresa,
): Promise<"NAO_E_LEGADA" | "LEGADA" | "RECUSADA"> {
  const codigoConfigurado = env.AGENDA_PUBLICA_EMPRESA_CODIGO;
  if (!codigoConfigurado || codigo !== codigoConfigurado || !CODIGO_EMPRESA_PUBLICA.test(codigoConfigurado)) {
    return "NAO_E_LEGADA";
  }

  const idConfigurado = env.AGENDA_PUBLICA_EMPRESA_ID?.trim().toLowerCase();
  if (!idConfigurado) return "RECUSADA";

  try {
    const empresa = await consultar(codigo);
    if (empresa?.status === "ATIVA" && empresa.id.toLowerCase() === idConfigurado) return "LEGADA";
  } catch {
    return "RECUSADA";
  }
  return "RECUSADA";
}
