import { lookup as lookupDns } from "node:dns/promises";
import { request as requestHttps } from "node:https";
import { isIP } from "node:net";
import { z } from "zod";
import { CanalOcupado, PrazoDoPedidoVencido, Vagas } from "../mcp/admissao.ts";
import type { ClienteOAuth } from "./repositorio.ts";

/**
 * Client ID Metadata Document (CIMD): o `client_id` é uma URL HTTPS que publica os metadados do cliente.
 * ChatGPT (preferido) e Claude (quando o servidor anuncia CIMD + `none`) usam este caminho; DCR não é oferecido no piloto.
 *
 * Proteções (SSRF/confused deputy):
 * - só HTTPS, porta padrão, sem credencial/query/fragmento, caminho não vazio, host na lista MCP_CIMD_HOSTS;
 * - DNS resolvido aqui e TODOS os endereços conferidos (privado, loopback, link-local, CGNAT, multicast, reservado ⇒
 *   recusa); a conexão usa o endereço conferido (sem nova resolução entre conferir e conectar);
 * - sem seguir redirecionamento; 5 s; 32 KiB; JSON;
 * - documento precisa repetir o mesmo `client_id`, aceitar autenticação `none` no token e só redirect HTTPS.
 *   `none` vale se for o `token_endpoint_auth_method` declarado OU estiver em `token_endpoint_auth_methods_supported`:
 *   o documento real do ChatGPT (27/10/2026) declara `private_key_jwt` e lista `["none", "private_key_jwt"]`. Como este
 *   servidor só anuncia `none`, o cliente usa `none` (sem segredo de cliente); nunca aceitamos outro método.
 *   Redirecionamento loopback (Claude Code) não faz parte do piloto.
 */
export class CimdRecusado extends Error {
  readonly motivo: string;
  constructor(motivo: string) {
    super("Cliente OAuth não reconhecido.");
    this.motivo = motivo;
    this.name = "CimdRecusado";
  }

  /** Falha TRANSITÓRIA do lado do servidor (busca ocupada, tempo, rede): não é culpa do aplicativo; vira 503 (rodada 5, P3). */
  get transitorio() {
    return this.motivo === "OCUPADO" || this.motivo === "TEMPO" || this.motivo === "FALHA_REDE";
  }
}

const documentoSchema = z.object({
  client_id: z.string(),
  client_name: z.string().min(1).max(120).optional(),
  redirect_uris: z.array(z.string().max(500)).min(1).max(20),
  token_endpoint_auth_method: z.string().optional(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
}).passthrough();

export function urlCimdAceita(clientId: string, hosts: readonly string[]): URL | null {
  if (clientId.length > 500) return null;
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username || url.password || url.search || url.hash) return null;
  if (url.pathname === "/" || url.pathname === "") return null;
  if (url.href !== clientId) return null;
  return hosts.includes(url.hostname.toLowerCase()) ? url : null;
}

function v4Publico(ip: string) {
  const [a, b, c] = ip.split(".").map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) return false;
  if ((a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113)) return false; // TEST-NET-2/3
  if (a === 198 && (b === 18 || b === 19)) return false;
  return true;
}

/** IPv6 em 16 bytes (aceita `::` e IPv4 embutido no fim). null se não for IPv6 válido ou tiver zona (`%`). */
export function bytesIpv6(ip: string): number[] | null {
  if (isIP(ip) !== 6 || ip.includes("%")) return null;
  let texto = ip.toLowerCase();
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(texto);
  if (v4) {
    const o = v4[1].split(".").map(Number);
    texto = `${texto.slice(0, -v4[1].length)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const [esq, dir] = texto.includes("::") ? texto.split("::") : [texto, null];
  const a = esq ? esq.split(":") : [];
  const b = dir ? dir.split(":") : [];
  const grupos = dir === null ? a : [...a, ...Array(8 - a.length - b.length).fill("0"), ...b];
  if (grupos.length !== 8) return null;
  return grupos.flatMap((g) => {
    const n = parseInt(g, 16);
    return [(n >> 8) & 0xff, n & 0xff];
  });
}

const prefixo = (b: number[], bits: string) => {
  // bits: "hex/len" (ex.: "fc00/7"); compara os `len` primeiros bits.
  const [hex, len] = bits.split("/");
  const ref = bytesIpv6(`${hex}::`)!;
  const n = Number(len);
  for (let i = 0; i < n; i += 1) {
    const byte = i >> 3, bit = 7 - (i & 7);
    if (((b[byte] >> bit) & 1) !== ((ref[byte] >> bit) & 1)) return false;
  }
  return true;
};

/**
 * Classificação por BYTES (revisão P2-3): qualquer grafia do mesmo endereço tem a mesma decisão. IPv6 público só em
 * unicast global 2000::/3 fora dos blocos especiais; IPv4 embutido (mapeado ::ffff:0:0/96, compatível ::/96, NAT64
 * 64:ff9b::/96 e 64:ff9b:1::/48, 6to4 2002::/16, Teredo 2001::/32) é recusado ou decidido pelo IPv4 interno.
 */
export function enderecoPublico(ip: string): boolean {
  const tipo = isIP(ip);
  if (tipo === 4) return v4Publico(ip);
  const b = bytesIpv6(ip);
  if (!b) return false;
  const zeros80 = b.slice(0, 10).every((x) => x === 0);
  if (zeros80 && b[10] === 0xff && b[11] === 0xff) return v4Publico(b.slice(12).join("."));
  if (zeros80) return false; // ::, ::1, IPv4-compatível e demais ::/80
  if (!prefixo(b, "2000/3")) return false; // fc00::/7, fe80::/10, ff00::/8, 64:ff9b::, 100::/64 etc. ficam fora
  for (const especial of ["2001/32", "2001:db8/32", "2002/16", "2001:10/28", "2001:20/28", "3fff/20"]) if (prefixo(b, especial)) return false;
  return true;
}

export type BuscaDocumento = (url: URL) => Promise<{ status: number; tipo: string | null; corpo: string }>;

export type Resolvedor = (host: string) => Promise<readonly string[]>;

const resolverPadrao: Resolvedor = async (host) => (await lookupDns(host, { all: true, verbatim: true })).map((r) => r.address);

/** Buscas CIMD em curso por instância (rodada 4, achado 4): trabalho abandonado continua contando até terminar de fato. */
const VAGAS_CIMD = new Vagas(4);

export type OpcoesBusca = {
  /** Prazo ABSOLUTO da operação inteira (DNS + conexão + transferência); vencido ⇒ soquete destruído. */
  prazoMs?: number;
  vagas?: Vagas;
  /** Só testes: substitui https.request. */
  abrir?: typeof requestHttps;
};

/** Busca real: endereço já conferido fixado no `lookup`, sem redirect, com prazo absoluto, tamanho e concorrência limitados. */
export function buscaHttpsFixada(resolver: Resolvedor = resolverPadrao, opcoes: OpcoesBusca = {}): BuscaDocumento {
  const prazoMs = opcoes.prazoMs ?? 5000;
  const vagas = opcoes.vagas ?? VAGAS_CIMD;
  const abrir = opcoes.abrir ?? requestHttps;
  return async (url) => {
    if (!vagas.iniciar()) throw new CimdRecusado("OCUPADO");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let destruir: (() => void) | null = null;
    let vencido = false;
    const prazo = new Promise<never>((_ok, falha) => {
      timer = setTimeout(() => {
        vencido = true;
        destruir?.();
        falha(new CimdRecusado("TEMPO"));
      }, prazoMs);
    });
    prazo.catch(() => undefined);
    const trabalho = (async () => {
      const enderecos = await resolver(url.hostname);
      if (vencido) throw new CimdRecusado("TEMPO");
      if (enderecos.length === 0 || !enderecos.every(enderecoPublico)) throw new CimdRecusado("ENDERECO_NAO_PUBLICO");
      const fixo = enderecos[0];
      return await new Promise<Awaited<ReturnType<BuscaDocumento>>>((resolve, reject) => {
        const req = abrir(url, {
          method: "GET",
          headers: { accept: "application/json" },
          timeout: prazoMs,
          // Node 20+ (autoSelectFamily) pede `{ all: true }` e espera lista; endereço solto quebra com ERR_INVALID_IP_ADDRESS.
          lookup: ((_host: string, opts: { all?: boolean } | undefined, cb: (...a: unknown[]) => void) =>
            opts?.all ? cb(null, [{ address: fixo, family: isIP(fixo) }]) : cb(null, fixo, isIP(fixo))) as never,
        }, (res) => {
          const partes: Buffer[] = [];
          let total = 0;
          res.on("data", (c: Buffer) => {
            total += c.length;
            if (total > 32 * 1024) {
              req.destroy(new CimdRecusado("DOCUMENTO_GRANDE"));
              return;
            }
            partes.push(c);
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, tipo: res.headers["content-type"] ?? null, corpo: Buffer.concat(partes).toString("utf8") }));
          res.on("error", reject);
          res.on("close", () => reject(new CimdRecusado("TEMPO")));
        });
        destruir = () => req.destroy(new CimdRecusado("TEMPO"));
        if (vencido) destruir();
        req.on("timeout", () => req.destroy(new CimdRecusado("TEMPO")));
        req.on("error", reject);
        req.on("close", () => reject(new CimdRecusado("TEMPO")));
        req.end();
      });
    })();
    // A vaga volta quando o trabalho REAL termina (DNS lento abandonado continua ocupando até resolver).
    trabalho.then(() => undefined, () => undefined).finally(() => vagas.terminar());
    try {
      return await Promise.race([trabalho, prazo]);
    } finally {
      clearTimeout(timer);
    }
  };
}

export async function carregarClienteCimd(clientId: string, hosts: readonly string[], buscar: BuscaDocumento, agora: Date, cacheS: number): Promise<ClienteOAuth> {
  const url = urlCimdAceita(clientId, hosts);
  if (!url) throw new CimdRecusado("CLIENT_ID_NAO_ACEITO");
  let resposta: Awaited<ReturnType<BuscaDocumento>>;
  try {
    resposta = await buscar(url);
  } catch (error) {
    // Prazo do pedido e canal ocupado não são falha do aplicativo: sobem como indisponibilidade.
    if (error instanceof CimdRecusado || error instanceof PrazoDoPedidoVencido || error instanceof CanalOcupado) throw error;
    throw new CimdRecusado("FALHA_REDE");
  }
  if (resposta.status !== 200) throw new CimdRecusado("STATUS");
  if (!resposta.tipo || !/^application\/(json|[a-z0-9.+-]+\+json)\b/i.test(resposta.tipo)) throw new CimdRecusado("TIPO");
  let bruto: unknown;
  try {
    bruto = JSON.parse(resposta.corpo);
  } catch {
    throw new CimdRecusado("JSON");
  }
  const doc = documentoSchema.safeParse(bruto);
  if (!doc.success || doc.data.client_id !== clientId) throw new CimdRecusado("DOCUMENTO");
  // `none` declarado (ou omitido, o padrão do RFC 7591) ou na lista de métodos suportados; sem `none`, recusa.
  const declarado = doc.data.token_endpoint_auth_method ?? "none";
  if (declarado !== "none" && !(doc.data.token_endpoint_auth_methods_supported ?? []).includes("none")) throw new CimdRecusado("AUTENTICACAO_CLIENTE_NAO_SUPORTADA");
  if (doc.data.grant_types && !doc.data.grant_types.includes("authorization_code")) throw new CimdRecusado("GRANT");
  if (doc.data.response_types && !doc.data.response_types.includes("code")) throw new CimdRecusado("RESPONSE_TYPE");
  const redirects = doc.data.redirect_uris.filter((r) => {
    try {
      const u = new URL(r);
      return u.protocol === "https:" && !u.hash && !u.username && !u.password && u.href === r;
    } catch {
      return false;
    }
  });
  if (redirects.length === 0) throw new CimdRecusado("REDIRECT");
  return {
    clientId,
    nome: (doc.data.client_name ?? url.hostname).replace(/[\u0000-\u001f\u007f<>]/g, "").slice(0, 120),
    redirectUris: redirects,
    validoAte: new Date(agora.getTime() + cacheS * 1000),
  };
}
