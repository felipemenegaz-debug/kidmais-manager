import { normalizarHost } from '../marketing/dominios/hosts.ts';

type AmbienteContagem = {
  [nome: string]: string | undefined;
  ENDERECOS_ORIGEM_ANTIGA?: string;
  ENDERECOS_ORIGEM_NOVA?: string;
  ENDERECOS_CONTAGEM?: string;
  ENDERECOS_CONTAGEM_JANELA_MIN?: string;
};

type ClasseHost = 'A' | 'N' | 'onrender' | 'outro' | 'sem_host';
type GrupoRota = 'mcp' | 'webhook' | 'api' | 'pagina';
export type ResultadoProxy = 'passar' | 'redirecionar' | 'neutra' | 'limpeza' | 'dominio';
type ChaveContagem = `${ClasseHost}.${GrupoRota}.${ResultadoProxy}`;

const LIMITE_CHAVES = 64;
const MINUTO_MS = 60_000;

function hostDaOrigem(origem: string | undefined): string | null {
  return normalizarHost(origem ? URL.parse(origem)?.hostname : undefined);
}

export function classificarHost(host: string | null | undefined, env: AmbienteContagem): ClasseHost {
  const normalizado = normalizarHost(host);
  if (!normalizado) return 'sem_host';
  if (normalizado === hostDaOrigem(env.ENDERECOS_ORIGEM_ANTIGA)) return 'A';
  if (normalizado === hostDaOrigem(env.ENDERECOS_ORIGEM_NOVA)) return 'N';
  return normalizado.endsWith('.onrender.com') ? 'onrender' : 'outro';
}

export function grupoDaRota(metodo: string, pathname: string): GrupoRota {
  // O grupo vale para todos os métodos da rota.
  void metodo;
  if (/^\/api\/mcp\/?$/.test(pathname) || pathname.startsWith('/.well-known/oauth-')) return 'mcp';
  if (!pathname.startsWith('/api/')) return 'pagina';
  return /\/webhooks?(?:\/|$)/.test(pathname) ? 'webhook' : 'api';
}

function janelaEmMs(valor: string | undefined): number {
  const texto = valor?.trim() ?? '';
  const minutos = /^\d+$/.test(texto) ? Number(texto) : 0;
  return (minutos >= 1 && minutos <= 1440 ? minutos : 15) * MINUTO_MS;
}

export function criarContagem(env: AmbienteContagem) {
  const ligada = env.ENDERECOS_CONTAGEM !== 'false';
  const janela = janelaEmMs(env.ENDERECOS_CONTAGEM_JANELA_MIN);
  const contadores = new Map<ChaveContagem, number>();
  let inicio: number | undefined;
  let total = 0;
  let excedente = 0;

  return {
    registrar(chave: ChaveContagem, agora: number): string | undefined {
      if (!ligada) return;

      let linha: string | undefined;
      if (inicio !== undefined && agora - inicio >= janela) {
        const campos = [...contadores.keys()].sort().map((chave) => `${chave}=${contadores.get(chave)}`);
        if (excedente > 0) campos.push(`excedente=${excedente}`);
        linha = `[Kidmais Enderecos] CONTAGEM inicio=${new Date(inicio).toISOString()} fim=${new Date(agora).toISOString()} total=${total} ${campos.join(' ')}`;
        contadores.clear();
        inicio = undefined;
        total = 0;
        excedente = 0;
      }

      // O pedido que fecha a janela já conta na próxima.
      inicio ??= agora;
      total += 1;
      const quantidade = contadores.get(chave);
      if (quantidade !== undefined || contadores.size < LIMITE_CHAVES) {
        contadores.set(chave, (quantidade ?? 0) + 1);
      } else {
        excedente += 1;
      }
      return linha;
    },
  };
}
