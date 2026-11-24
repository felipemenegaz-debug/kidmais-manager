/**
 * Desconto por dia da semana na agenda pública (/disponibilidade e /b/<código>/disponibilidade), 23/11/2026.
 *
 * Módulo PURO (sem React): o calendário volta a mostrar o selo "-15%", a faixa "Economize…" e o aviso no painel, como o
 * calendário do assistente fazia antes do fluxo "convidados primeiro". Usa só `comercial.descontosEmpresa`, as mesmas
 * regras que a cotação do servidor cobra; sem o campo (agenda sem empresa no escopo), não mostra desconto nenhum.
 *
 * Nesta tela o pacote ainda não foi escolhido. Por isso o dia olha todos os pacotes nos períodos livres:
 *   - mesmo percentual em todos → "-15%";
 *   - percentuais diferentes (ou algum pacote/período sem desconto) → "até 15%".
 * O valor de cada pacote só aparece na escolha do pacote, pela cotação.
 */
import { avisoEconomize, regraDoDia, textoPercentual, type DescontosEmpresaPublicos } from "../../lib/comercial/descontos-dia.ts";
import type { DisponibilidadeDataPublica } from "../../lib/disponibilidade/services/models.ts";

export type DescontoDoDia = {
  /** Maior percentual do dia, em pontos (15 = 15%). */
  pontos: number;
  /** true quando nem todo pacote/período livre tem esse percentual. */
  ate: boolean;
  /** Texto do selo no calendário: "-15%" ou "até 15%". */
  selo: string;
  /** Título do aviso no painel. */
  titulo: string;
  /** Título da regra (ex.: "15% de desconto de segunda a quinta"); null quando há mais de um. */
  regra: string | null;
};

/** Desconto da data nos períodos que o cliente pode escolher (livres e sem bloqueio comercial). */
export function descontoDoDia(regras: DescontosEmpresaPublicos | null | undefined, dia: DisponibilidadeDataPublica | undefined): DescontoDoDia | null {
  if (!regras || !dia) return null;
  const livres = dia.periodos.filter((p) => p.status === "DISPONIVEL" && !p.motivoComercial);
  const listas = Object.values(regras);
  if (!livres.length || !listas.length) return null;

  const achados: { pontos: number; titulo: string | null }[] = [];
  for (const lista of listas) {
    for (const periodo of livres) {
      const regra = regraDoDia(lista, dia.data, periodo.configuracaoId);
      const pontos = regra ? Math.max(0, Math.min(100, regra.percentual)) : 0;
      achados.push({ pontos, titulo: regra?.titulo ?? null });
    }
  }

  const maximo = Math.max(...achados.map((a) => a.pontos));
  if (!(maximo > 0)) return null;
  const ate = achados.some((a) => a.pontos !== maximo);
  const pct = textoPercentual(maximo);
  const titulos = [...new Set(achados.filter((a) => a.pontos === maximo).map((a) => a.titulo).filter((t): t is string => !!t))];
  return {
    pontos: maximo,
    ate,
    selo: ate ? `até ${pct}%` : `-${pct}%`,
    titulo: ate ? `Até ${pct}% de desconto no pacote nesta data` : `${pct}% de desconto no pacote nesta data`,
    regra: titulos.length === 1 ? titulos[0]! : null,
  };
}

/** Frase da faixa acima do calendário ("Economize 15% escolhendo de segunda a quinta."); null sem desconto à frente. */
export function avisoDescontoAgenda(regras: DescontosEmpresaPublicos | null | undefined, hojeIso: string): string | null {
  if (!regras) return null;
  return avisoEconomize(Object.values(regras).flat(), hojeIso);
}
