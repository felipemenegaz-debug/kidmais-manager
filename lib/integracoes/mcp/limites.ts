import { LIMITES_MCP } from "./config.ts";
import { Vagas } from "./admissao.ts";
import { LeiturasSimultaneas } from "./corpo.ts";
import { JanelasFixas } from "./janelas.ts";

/**
 * Limites do canal por CONCESSÃO e por EMPRESA (nunca por IP informado pelo cliente): janela de 60 s e concorrência.
 * Escopo honesto: estado EM PROCESSO (por instância). Com N instâncias o teto efetivo é N × limite; isso está documentado
 * e é aceitável no piloto (allowlist de empresas). Mapas limitados sem desalojar janela vigente (JanelasFixas).
 */
export type Decisao = { ok: true; liberar: () => void } | { ok: false; motivo: "TAXA" | "CONCORRENCIA"; retryAfterS: number };

type Limites = { readonly [K in keyof typeof LIMITES_MCP]: number };

export class LimitadorMcp {
  private readonly janelas: JanelasFixas;
  private readonly ativos = new Map<string, number>();
  private readonly ativosEmpresa = new Map<string, number>();
  /** Verificações de token em curso (cada uma usa o banco): admissão ANTES de abrir conexão. */
  readonly autenticacoes: Vagas;
  /** Leituras de corpo em curso na instância (antes da vaga da concessão; o prazo garante a devolução). */
  readonly leituras: LeiturasSimultaneas;

  private readonly relogio: () => number;
  private readonly limites: Limites;

  constructor(relogio: () => number = () => Date.now(), limites: Limites = LIMITES_MCP, maxChaves = 10_000) {
    this.relogio = relogio;
    this.limites = limites;
    this.janelas = new JanelasFixas(maxChaves);
    this.leituras = new LeiturasSimultaneas(limites.leiturasCorpoSimultaneas);
    this.autenticacoes = new Vagas(limites.autenticacoesSimultaneas);
  }

  /**
   * Taxa de autenticações ANTES de tocar o banco (rodada 4, achado 1): global e, com IP confiável da borda, por origem.
   * Bearer inventado consome esta taxa; nunca abre conexão acima dela. null ⇒ admitido; número ⇒ segundos de espera.
   */
  admitirAutenticacao(origem: string | null): number | null {
    return this.janelas.admitir([
      ["auth:global", this.limites.autenticacoesPorMinuto],
      ...(origem ? [["auth:origem:" + origem, this.limites.autenticacoesPorOrigemPorMinuto] as const] : []),
    ], this.relogio());
  }

  tentar(concessaoId: string, empresaId: string): Decisao {
    const agora = this.relogio();
    // Concorrência primeiro: recusa por concorrência NÃO consome a taxa por concessão/empresa (só a admissão global de
    // autenticação, já consumida antes). Isso não fura o teto de leituras: a concessão nunca passa de 2 em curso.
    const emCurso = this.ativos.get(concessaoId) ?? 0;
    const daEmpresa = this.ativosEmpresa.get(empresaId) ?? 0;
    if (emCurso >= this.limites.concorrenciaPorConcessao || daEmpresa >= this.limites.concorrenciaPorEmpresa) return { ok: false, motivo: "CONCORRENCIA", retryAfterS: 1 };
    const espera = this.janelas.admitir([
      [`c:${concessaoId}`, this.limites.chamadasPorMinutoPorConcessao],
      [`e:${empresaId}`, this.limites.chamadasPorMinutoPorEmpresa],
    ], agora);
    if (espera !== null) return { ok: false, motivo: "TAXA", retryAfterS: espera };
    this.ativos.set(concessaoId, emCurso + 1);
    this.ativosEmpresa.set(empresaId, daEmpresa + 1);
    let liberado = false;
    return {
      ok: true,
      liberar: () => {
        if (liberado) return;
        liberado = true;
        const resto = (this.ativos.get(concessaoId) ?? 1) - 1;
        if (resto <= 0) this.ativos.delete(concessaoId);
        else this.ativos.set(concessaoId, resto);
        const restoEmpresa = (this.ativosEmpresa.get(empresaId) ?? 1) - 1;
        if (restoEmpresa <= 0) this.ativosEmpresa.delete(empresaId);
        else this.ativosEmpresa.set(empresaId, restoEmpresa);
      },
    };
  }

  tamanho() {
    return this.janelas.tamanho() + this.ativos.size + this.ativosEmpresa.size;
  }
}
