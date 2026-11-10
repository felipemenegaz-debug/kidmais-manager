import { createHash } from 'node:crypto';
import { normalizarHost } from '../marketing/dominios/hosts.ts';
import { avaliarConfiguracao, type AmbienteEnderecos, type CodigoEnderecos, type ModoEfetivo, type ModoSolicitado } from './roteamento.ts';

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
  /** Nula sem modo válido em uso: não há origem esperada para comparar. */
  coerencia: CoerenciaEnderecos | null;
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

/** Mesma leitura dos consumidores: `valor || fallback`, comparando a origem. Valor inválido dá falso. */
function origemIgual(valor: string | undefined, esperada: string, exigeSemCaminho = false) {
  if (!valor) return false;
  try {
    const url = new URL(valor);
    return url.origin === esperada && (!exigeSemCaminho || url.pathname === '/');
  } catch {
    return false;
  }
}

export function diagnosticarEndereco(host: string | null, env: AmbienteDiagnostico, agora = Date.now()): DiagnosticoEndereco {
  const cfg = avaliarConfiguracao(env);
  const tolerancia = avaliarTolerancia(env.ENDERECOS_TOLERANCIA_ATE, agora);
  const hostPedido = normalizarHost(host);
  const painelNesteHost = hostPedido && cfg.painel ? new URL(cfg.painel).hostname === hostPedido : null;
  const origemAtiva = cfg.antiga && cfg.painel === cfg.antiga ? 'A' : cfg.nova && cfg.painel === cfg.nova ? 'N' : 'INDETERMINADA';
  const admin = env.ADMIN_AUTH_ORIGIN;
  let coerencia: CoerenciaEnderecos | null = null;
  if (cfg.antiga && cfg.painel) {
    const a = cfg.antiga;
    coerencia = {
      convites: origemIgual(env.CONVITES_PUBLIC_ORIGIN || admin, cfg.painel),
      site: origemIgual(env.SITE_URL || admin, cfg.painel),
      agenda: origemIgual(env.AGENDA_PUBLICA_ORIGEM?.trim() || admin, a, true),
      midia: origemIgual(env.WHATSAPP_ATENDIMENTO_MIDIA_ORIGEM || admin, a),
      mcp: !env.MCP_PUBLIC_URL || origemIgual(env.MCP_PUBLIC_URL, a),
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
    coerencia,
    mcpRecursoSha256: env.MCP_PUBLIC_URL ? createHash('sha256').update(env.MCP_PUBLIC_URL).digest('hex') : 'AUSENTE',
  };
}

/** Linha de log, sem valores: os mesmos campos do diagnóstico, menos o que depende do pedido. */
export function linhaDeLogDoEndereco(env: AmbienteDiagnostico, agora = Date.now()) {
  const { modoSolicitado, modoEfetivo, codigo, origemAtiva, toleranciaAtiva, tolerancia, coerencia, mcpRecursoSha256 } = diagnosticarEndereco(null, env, agora);
  return `[Enderecos] ${JSON.stringify({ modoSolicitado, modoEfetivo, codigo, origemAtiva, toleranciaAtiva, tolerancia, coerencia, mcpRecursoSha256 })}`;
}
