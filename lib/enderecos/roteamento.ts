import { hostReservado, normalizarHost, type AmbienteDominios } from '../marketing/dominios/hosts.ts';

/**
 * Troca de host do iA.Fest (plano D4). Decisão pura, sem banco nem rede: usada pelo proxy.ts e pelos testes.
 *
 * A é o host antigo, que continua servindo a operação pública da Kidmais; N é o host novo, do produto. Com
 * ENDERECOS_MODO ausente, só o invariante age: nenhum host sob demerzellabs.com.br serve as páginas globais.
 * O destino é uma URL fixa da configuração. A única exceção é o próprio host demerzellabs.com.br validado, no invariante:
 * o proxy do Next recusa Location relativa (500), e sem modo não há origem configurada para N. O cabeçalho nunca leva a
 * outro domínio: normalizarHost recusa lista, porta e credencial, e a origem final é conferida.
 */
export const MODOS_ENDERECOS = ['DESLIGADO', 'PREPARACAO', 'ATIVA', 'REVERSAO'] as const;
export type ModoEnderecos = (typeof MODOS_ENDERECOS)[number];
export type ModoEfetivo = ModoEnderecos | 'CONFIGURACAO_INVALIDA';
export type ModoSolicitado = ModoEnderecos | 'AUSENTE' | 'DESCONHECIDO';
export type CodigoEnderecos = 'OK' | 'MODO_DESCONHECIDO' | 'ORIGEM_ANTIGA_INVALIDA' | 'ORIGEM_NOVA_INVALIDA' | 'ORIGENS_IGUAIS' | 'ADMIN_DIVERGENTE';

export type AmbienteEnderecos = AmbienteDominios & {
  ENDERECOS_MODO?: string;
  ENDERECOS_ORIGEM_ANTIGA?: string;
  ENDERECOS_ORIGEM_NOVA?: string;
};

export type ConfiguracaoEnderecos = {
  modoSolicitado: ModoSolicitado;
  modoEfetivo: ModoEfetivo;
  codigo: CodigoEnderecos;
  /** Origens validadas; nulas fora de configuração válida com modo diferente de DESLIGADO. */
  antiga: string | null;
  nova: string | null;
  /** Origem de ADMIN_AUTH_ORIGIN, se for uma URL válida; não depende do modo. */
  painel: string | null;
};

export type DecisaoEndereco = { tipo: 'PASSAR' } | { tipo: 'REDIRECIONAR'; destino: string } | { tipo: 'NEUTRA' };

const PASSAR: DecisaoEndereco = { tipo: 'PASSAR' };
const NEUTRA: DecisaoEndereco = { tipo: 'NEUTRA' };
const DEMERZEL = /(^|\.)demerzellabs\.com\.br$/;
const CAMINHO_DO_ATALHO = '/clientes';
const BUSCA_DO_ATALHO = '?acao=fechamento';

export const hostDemerzel = (host: string) => DEMERZEL.test(host);

/** Origem exata em https: sem credencial, porta, caminho, query, fragmento ou barra final. */
function origemFixa(valor: string | undefined): string | null {
  if (!valor) return null;
  try {
    const url = new URL(valor);
    return url.protocol === 'https:' && !url.port && url.origin === valor ? url.origin : null;
  } catch {
    return null;
  }
}

function origemDoPainel(env: AmbienteEnderecos): string | null {
  try {
    return env.ADMIN_AUTH_ORIGIN ? new URL(env.ADMIN_AUTH_ORIGIN).origin : null;
  } catch {
    return null;
  }
}

const hostDe = (origem: string) => new URL(origem).hostname;

export function avaliarConfiguracao(env: AmbienteEnderecos): ConfiguracaoEnderecos {
  const bruto = env.ENDERECOS_MODO?.trim() ?? '';
  const painel = origemDoPainel(env);
  const invalida = (modoSolicitado: ModoSolicitado, codigo: CodigoEnderecos): ConfiguracaoEnderecos =>
    ({ modoSolicitado, modoEfetivo: 'CONFIGURACAO_INVALIDA', codigo, antiga: null, nova: null, painel });
  if (!bruto) return { modoSolicitado: 'AUSENTE', modoEfetivo: 'DESLIGADO', codigo: 'OK', antiga: null, nova: null, painel };
  if (!(MODOS_ENDERECOS as readonly string[]).includes(bruto)) return invalida('DESCONHECIDO', 'MODO_DESCONHECIDO');
  const modo = bruto as ModoEnderecos;
  if (modo === 'DESLIGADO') return { modoSolicitado: modo, modoEfetivo: modo, codigo: 'OK', antiga: null, nova: null, painel };
  const antiga = origemFixa(env.ENDERECOS_ORIGEM_ANTIGA);
  const nova = origemFixa(env.ENDERECOS_ORIGEM_NOVA);
  // A serve as páginas globais, proibidas sob demerzellabs.com.br; N depende do invariante, que só vale lá.
  if (!antiga || hostDemerzel(hostDe(antiga))) return invalida(modo, 'ORIGEM_ANTIGA_INVALIDA');
  if (!nova || !hostDemerzel(hostDe(nova))) return invalida(modo, 'ORIGEM_NOVA_INVALIDA');
  if (hostDe(antiga) === hostDe(nova)) return invalida(modo, 'ORIGENS_IGUAIS');
  if (painel !== (modo === 'ATIVA' ? nova : antiga)) return invalida(modo, 'ADMIN_DIVERGENTE');
  return { modoSolicitado: modo, modoEfetivo: modo, codigo: 'OK', antiga, nova, painel };
}

const semBarraFinal = (pathname: string) => pathname.replace(/\/+$/, '') || '/';

/** Nunca redirecionados: APIs, arquivos do Next, destino interno de domínio personalizado e arquivos públicos. */
function caminhoLivre(pathname: string) {
  if (pathname === '/favicon.ico' || pathname === '/robots.txt' || pathname === '/sitemap.xml') return true;
  if (/^\/(api|_next|\.well-known|sd)(\/|$)/.test(pathname)) return true;
  return /\/[^/]*\.[a-z0-9]+$/i.test(pathname);
}

const paginaGlobal = (caminho: string) => caminho === '/' || caminho === '/disponibilidade' || caminho === '/fechamento';
const grupoPublico = (caminho: string) => paginaGlobal(caminho) || caminho.startsWith('/contrato/');

/** Mesma regra de app/fechamento/page.tsx: primeiro valor de cada parâmetro. */
function atalhoDoPainel(caminho: string, search: string) {
  if (caminho !== '/fechamento') return false;
  const params = new URLSearchParams(search);
  return params.get('contexto') === 'ADMIN' || params.get('origem') === 'ATENDIMENTO_KIDMAIS';
}

const SERVIDAS_NA_PREPARACAO = /^\/(conheca|planos|termos|privacidade|acordo-de-tratamento)$|^\/b(\/|$)|^\/documentos\/[^/]+\/[^/]+$/;

/** Atribui caminho e query a uma URL fixa e confere a origem final. Divergência não redireciona. */
function emOrigem(origem: string, pathname: string, search: string): DecisaoEndereco {
  const url = new URL(origem);
  url.pathname = pathname;
  url.search = search;
  return url.origin === origem ? { tipo: 'REDIRECIONAR', destino: url.href } : PASSAR;
}

/** No mesmo host demerzellabs.com.br do pedido, já validado. Falha na conferência não redireciona. */
function noMesmoHost(host: string, pathname: string, search: string): DecisaoEndereco {
  const origem = `https://${host}`;
  return hostDemerzel(new URL(origem).hostname) ? emOrigem(origem, pathname, search) : PASSAR;
}

const atalho = (origem: string) => emOrigem(origem, CAMINHO_DO_ATALHO, BUSCA_DO_ATALHO);

export function decidirEndereco(
  pedido: { metodo: string; host: string | null; pathname: string; search: string },
  env: AmbienteEnderecos,
): DecisaoEndereco {
  if (pedido.metodo !== 'GET' && pedido.metodo !== 'HEAD') return PASSAR;
  if (caminhoLivre(pedido.pathname)) return PASSAR;
  const host = normalizarHost(pedido.host);
  if (!host) return PASSAR;

  const cfg = avaliarConfiguracao(env);
  const caminho = semBarraFinal(pedido.pathname);
  const demerzel = hostDemerzel(host);
  const global = paginaGlobal(caminho);

  if (cfg.modoEfetivo === 'CONFIGURACAO_INVALIDA') {
    if (!hostReservado(host, env)) return PASSAR;
    if (demerzel && global) return NEUTRA;
    if (cfg.painel && host === hostDe(cfg.painel)) return PASSAR;
    if (!demerzel && grupoPublico(caminho)) return PASSAR;
    return NEUTRA;
  }

  if (demerzel && global) {
    const eAtalho = atalhoDoPainel(caminho, pedido.search);
    if (cfg.modoEfetivo === 'REVERSAO')
      return eAtalho ? atalho(cfg.antiga!) : emOrigem(cfg.antiga!, pedido.pathname, pedido.search);
    if (eAtalho) {
      // DESLIGADO não tem origem validada: só vale a do painel em https; sem ela, o atalho fica neste host.
      const painelSeguro = cfg.painel?.startsWith('https://') ? cfg.painel : null;
      const destino = cfg.modoEfetivo === 'DESLIGADO' ? painelSeguro : cfg.modoEfetivo === 'ATIVA' ? cfg.nova : cfg.antiga;
      return destino ? atalho(destino) : noMesmoHost(host, CAMINHO_DO_ATALHO, BUSCA_DO_ATALHO);
    }
    return noMesmoHost(host, '/conheca', '');
  }

  if (cfg.modoEfetivo === 'DESLIGADO') return PASSAR;
  const antiga = cfg.antiga!;
  const nova = cfg.nova!;

  if (cfg.modoEfetivo === 'ATIVA' && host === hostDe(antiga)) {
    if (atalhoDoPainel(caminho, pedido.search)) return atalho(nova);
    if (grupoPublico(caminho)) return PASSAR;
    return emOrigem(nova, pedido.pathname, pedido.search);
  }
  if (cfg.modoEfetivo === 'PREPARACAO' && host === hostDe(nova)) {
    if (SERVIDAS_NA_PREPARACAO.test(caminho)) return PASSAR;
    return emOrigem(antiga, pedido.pathname, pedido.search);
  }
  if (cfg.modoEfetivo === 'REVERSAO' && host === hostDe(nova))
    return emOrigem(antiga, pedido.pathname, pedido.search);
  return PASSAR;
}

/**
 * "Ver tela do cliente" da empresa da configuração legada. Em ATIVA o painel está em N, onde /disponibilidade cairia
 * na vitrine: o destino é A, da configuração validada. Nos demais modos o painel está no host que serve a página.
 */
export function telaDoClienteGlobal(env: AmbienteEnderecos) {
  const cfg = avaliarConfiguracao(env);
  return cfg.modoEfetivo === 'ATIVA' ? `${cfg.antiga}/disponibilidade` : '/disponibilidade';
}
