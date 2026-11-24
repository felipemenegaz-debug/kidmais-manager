import { createHash } from 'node:crypto';
import { enderecoPublicoAbsoluto } from '../fechamentos/rota-publica.ts';
import { urlsMcp } from '../integracoes/mcp/config.ts';
import { normalizarHost } from '../marketing/dominios/hosts.ts';
import { avaliarConfiguracao, codigoKidmaisEmN, type AmbienteEnderecos, type CodigoEnderecos, type ModoEfetivo, type ModoSolicitado } from './roteamento.ts';

/**
 * Diagnóstico público da troca de host: só estados e booleanos, nunca o valor de uma variável. Não acessa banco, não
 * lê cookies e fica fora do /api/health de propósito: uma falha aqui não pode derrubar a instância. Quem confere é
 * scripts/enderecos-conferir.cjs, obrigatório depois de cada deploy com modo diferente de DESLIGADO.
 */
export type AmbienteDiagnostico = AmbienteEnderecos & {
  ENDERECOS_TOLERANCIA_ATE?: string;
  AGENDA_PUBLICA_ORIGEM?: string;
  WHATSAPP_ATENDIMENTO_MIDIA_ORIGEM?: string;
  MCP_PUBLIC_URL?: string;
};

export type EstadoTolerancia = 'AUSENTE' | 'VALIDA' | 'VENCIDA' | 'INVALIDA';
export type CoerenciaEnderecos = { convites: boolean; site: boolean; agenda: boolean; midia: boolean; mcp: boolean };

export type DiagnosticoEndereco = {
  modoSolicitado: ModoSolicitado;
  modoEfetivo: ModoEfetivo;
  codigo: CodigoEnderecos;
  origemAtiva: 'A' | 'N' | 'INDETERMINADA';
  painelNesteHost: boolean | null;
  toleranciaAtiva: boolean;
  tolerancia: EstadoTolerancia;
  kidmaisEmN: boolean;
  /** Nula sem modo válido em uso: não há origem esperada para comparar. */
  coerencia: CoerenciaEnderecos | null;
  /** Origem efetiva dos links novos de mídia do WhatsApp (F4/M1). Nula sem modo válido em uso. */
  midiaEm: 'A' | 'N' | 'INDETERMINADA' | null;
  /**
   * Origem do recurso MCP (F4/M5): A ou N pela origem de MCP_PUBLIC_URL, AUSENTE sem a variável (canal sem URL pública).
   * Valor que o próprio canal recusa (urlsMcp: query, fragmento, credenciais, fora de HTTPS) ou cujo caminho não é a rota
   * /api/mcp (barra final aceita, como no canal) é INDETERMINADA, nunca A ou N.
   * Nula sem modo válido em uso.
   */
  mcpEm: 'A' | 'N' | 'INDETERMINADA' | 'AUSENTE' | null;
  mcpRecursoSha256: string;
};

const DATA_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z$/;

export function avaliarTolerancia(valor: string | undefined, agora: number): EstadoTolerancia {
  const bruto = valor?.trim();
  if (!bruto) return 'AUSENTE';
  const instante = DATA_UTC.test(bruto) ? Date.parse(bruto) : Number.NaN;
  if (Number.isNaN(instante)) return 'INVALIDA';
  return instante > agora ? 'VALIDA' : 'VENCIDA';
}

/** Mesma leitura dos consumidores: `valor || fallback`, comparando a origem. Valor inválido ou com usuário/senha dá falso. */
function origemIgual(valor: string | undefined, esperada: string, exigeSemCaminho = false) {
  if (!valor) return false;
  try {
    const url = new URL(valor);
    // usuário:senha não muda `origin`, mas o consumidor da mídia recusa (urlPublicaArquivo): não pode parecer coerente.
    return url.origin === esperada && !url.username && !url.password && (!exigeSemCaminho || url.pathname === '/');
  } catch {
    return false;
  }
}

export function diagnosticarEndereco(host: string | null, env: AmbienteDiagnostico, agora = Date.now()): DiagnosticoEndereco {
  const cfg = avaliarConfiguracao(env);
  const codigoKidmais = codigoKidmaisEmN(env);
  const kidmaisEmN = codigoKidmais !== null;
  const tolerancia = avaliarTolerancia(env.ENDERECOS_TOLERANCIA_ATE, agora);
  const hostPedido = normalizarHost(host);
  const painelNesteHost = hostPedido && cfg.painel ? new URL(cfg.painel).hostname === hostPedido : null;
  const origemAtiva = cfg.antiga && cfg.painel === cfg.antiga ? 'A' : cfg.nova && cfg.painel === cfg.nova ? 'N' : 'INDETERMINADA';
  const admin = env.ADMIN_AUTH_ORIGIN;
  let coerencia: CoerenciaEnderecos | null = null;
  let midiaEm: DiagnosticoEndereco['midiaEm'] = null;
  let mcpEm: DiagnosticoEndereco['mcpEm'] = null;
  if (cfg.antiga && cfg.painel) {
    const a = cfg.antiga;
    const codigoDaVirada = cfg.modoEfetivo === 'ATIVA' ? codigoKidmais : null;
    const site = env.SITE_URL || admin;
    const midiaEfetiva = env.WHATSAPP_ATENDIMENTO_MIDIA_ORIGEM || admin;
    midiaEm = origemIgual(midiaEfetiva, a) ? 'A' : cfg.nova && origemIgual(midiaEfetiva, cfg.nova) ? 'N' : 'INDETERMINADA';
    const mcp = env.MCP_PUBLIC_URL;
    // Mesma leitura do canal, com a regra de produção (sem http em loopback): URL que desliga o MCP não pode parecer coerente.
    const lidoMcp = mcp ? urlsMcp({ MCP_PUBLIC_URL: mcp, NODE_ENV: 'production' })?.recurso : undefined;
    const recursoMcp = lidoMcp && new URL(lidoMcp).pathname === '/api/mcp' ? lidoMcp : undefined;
    mcpEm = !mcp ? 'AUSENTE' : !recursoMcp ? 'INDETERMINADA' : origemIgual(recursoMcp, a) ? 'A' : cfg.nova && origemIgual(recursoMcp, cfg.nova) ? 'N' : 'INDETERMINADA';
    coerencia = {
      convites: origemIgual(env.CONVITES_PUBLIC_ORIGIN || admin, cfg.painel),
      site: origemIgual(site, cfg.painel) &&
        (codigoDaVirada === null || enderecoPublicoAbsoluto(site, codigoDaVirada, '/disponibilidade') !== null),
      agenda: origemIgual(env.AGENDA_PUBLICA_ORIGEM?.trim() || admin, a, true) || codigoDaVirada !== null,
      // A, ou N só quando escrita na própria variável (F4/M1): /api nunca é redirecionado, então N serve o arquivo em
      // todos os modos. N herdado de ADMIN_AUTH_ORIGIN, com a variável ausente, segue incoerente (H25: troca sem decisão).
      midia: midiaEm === 'A' || (midiaEm === 'N' && Boolean(env.WHATSAPP_ATENDIMENTO_MIDIA_ORIGEM)),
      // A ou N (F4/M5): /api e /.well-known nunca são redirecionados, então N serve o recurso e os metadados OAuth em
      // todos os modos. Trocar a origem invalida os tokens emitidos para a outra (audience): é decisão da M5, não erro.
      mcp: mcpEm === 'AUSENTE' || mcpEm === 'A' || mcpEm === 'N',
    };
  }
  return {
    modoSolicitado: cfg.modoSolicitado,
    modoEfetivo: cfg.modoEfetivo,
    codigo: cfg.codigo,
    origemAtiva,
    painelNesteHost,
    toleranciaAtiva: tolerancia === 'VALIDA',
    tolerancia,
    kidmaisEmN,
    coerencia,
    midiaEm,
    mcpEm,
    mcpRecursoSha256: env.MCP_PUBLIC_URL ? createHash('sha256').update(env.MCP_PUBLIC_URL).digest('hex') : 'AUSENTE',
  };
}

/** Linha de log, sem valores: os mesmos campos do diagnóstico, menos o que depende do pedido. */
export function linhaDeLogDoEndereco(env: AmbienteDiagnostico, agora = Date.now()) {
  const { modoSolicitado, modoEfetivo, codigo, origemAtiva, toleranciaAtiva, tolerancia, kidmaisEmN, coerencia, midiaEm, mcpEm, mcpRecursoSha256 } = diagnosticarEndereco(null, env, agora);
  return `[Enderecos] ${JSON.stringify({ modoSolicitado, modoEfetivo, codigo, origemAtiva, toleranciaAtiva, tolerancia, kidmaisEmN, coerencia, midiaEm, mcpEm, mcpRecursoSha256 })}`;
}
