import { avaliarConfiguracao, decidirEndereco, type AmbienteEnderecos } from "../../lib/enderecos/roteamento.ts";
import { CODIGO_EMPRESA_PUBLICA } from "../../lib/http/empresas-publicas.ts";
import { rotear } from "../../lib/marketing/dominios/hosts.ts";

export function destinoMeuPedido(headers: Pick<Headers, "get">, empresa: string | null, env: AmbienteEnderecos = process.env) {
  if (avaliarConfiguracao(env).modoEfetivo !== "PREPARACAO") return { tipo: "PASSAR" } as const;
  if (empresa !== null && !CODIGO_EMPRESA_PUBLICA.test(empresa)) return { tipo: "INDISPONIVEL" } as const;

  // A mesma precedência de origemPublicaValida, sem usar o Host como destino.
  const publica = env.AREA_FAMILIA_PUBLIC_ORIGIN || env.ADMIN_AUTH_ORIGIN;
  if (!publica || !URL.canParse(publica)) return { tipo: "INDISPONIVEL" } as const;
  const origem = new URL(publica).origin;
  if (!origem.startsWith("https://")) return { tipo: "INDISPONIVEL" } as const;
  const destino = new URL(empresa === null ? "/meu-pedido" : `/b/${empresa}/meu-pedido`, origem);
  if (decidirEndereco({ metodo: "GET", host: destino.host, pathname: destino.pathname, search: "" }, env).tipo !== "PASSAR"
    || rotear(destino.host, destino.pathname, env).tipo === "DOMINIO") return { tipo: "INDISPONIVEL" } as const;

  return headers.get("host")?.toLowerCase() === destino.host && headers.get("x-forwarded-proto") === "https"
    ? { tipo: "PASSAR" } as const
    : { tipo: "REDIRECIONAR", destino: destino.href } as const;
}
