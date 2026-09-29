import type { SessaoParaTenant, TenantComprovado } from "../../saas/provar-tenant.ts";
import type { ContextoTela } from "../contratos.ts";
import {
  ContextoRecusado, LIMITES_CONTEXTO_PADRAO, VERSAO_CONTEXTO, type BlocoDados, type ContextoAutorizado, type ContextoModelo, type DadosModelo,
  type EntidadeTela, type FinalidadeContexto, type LimitesContexto,
} from "./contrato.ts";
import { ferramentaRegistrada } from "../ferramentas.ts";
import { mencionaCrianca, redigir, temIdentificadorResidual } from "./redacao.ts";

/**
 * Context Builder V1. Toda entrada vem do servidor: sessão autenticada e Tenant Context comprovado.
 * O pedido do operador nunca escolhe empresa, estabelecimento, papel, capacidades nem entidade de outra empresa
 * (o id da tela só é usado pelas ferramentas, que o revalidam no tenant pelo domínio).
 */
const ENTIDADES: readonly EntidadeTela[] = ["festa", "cliente", "contrato"];

export function construirContextoAutorizado(entrada: {
  sessao: Pick<SessaoParaTenant, "usuario_id">;
  tenant: TenantComprovado;
  contexto: ContextoTela | null;
  capacidades: readonly string[];
}): ContextoAutorizado {
  const { sessao, tenant, contexto } = entrada;
  // A sessão e o tenant têm de ser do mesmo usuário: qualquer divergência é bug de composição ⇒ recusa.
  if (tenant.usuarioId !== sessao.usuario_id) throw new ContextoRecusado("OUTRA_EMPRESA");
  const tela = contexto?.tela ?? "geral";
  const tipo = ENTIDADES.find((e) => e === tela) ?? null;
  return Object.freeze({
    usuarioId: sessao.usuario_id,
    empresaId: tenant.empresaComprovada,
    estabelecimentoId: null,
    papel: tenant.papelAtual,
    tela,
    entidade: tipo && contexto?.entidadeId ? Object.freeze({ tipo, id: contexto.entidadeId }) : null,
    capacidades: Object.freeze([...new Set(entrada.capacidades)]),
  });
}

/** Valor de evidência que pode seguir literal: número, moeda, percentual, data, sim/não. O resto é redigido. */
function valorSeguro(valor: string) {
  const v = valor.trim();
  return /^-?[\d.,]+%?$/.test(v) || /^R\$\s?-?[\d.,]+$/.test(v) || /^\d{2}\/\d{2}\/\d{4}$/.test(v) || /^\d{4}-\d{2}-\d{2}$/.test(v) || /^(Sim|Não)$/.test(v);
}

type Parcial = { contexto: ContextoModelo; json: string };

/**
 * Monta o contexto de modelo a partir de leituras já feitas pelo gateway (Policy + Tenant Context).
 * Recusa o TODO se algum bloco for de outra empresa ou de capacidade não autorizada: isso indica erro de
 * composição, e seguir "sem aquele bloco" esconderia o problema.
 */
export function construirContextoModelo(
  autorizado: ContextoAutorizado,
  blocos: readonly BlocoDados[],
  opcoes: { finalidade: FinalidadeContexto; sensiveis?: readonly string[]; limites?: Partial<LimitesContexto> },
): Parcial {
  const limites: LimitesContexto = { ...LIMITES_CONTEXTO_PADRAO, ...opcoes.limites };
  for (const bloco of blocos) {
    if (bloco.empresaId !== autorizado.empresaId) throw new ContextoRecusado("OUTRA_EMPRESA");
    if (!autorizado.capacidades.includes(bloco.capacidade) || bloco.resposta.capacidade !== bloco.capacidade) throw new ContextoRecusado("CAPACIDADE_NAO_AUTORIZADA");
  }
  let removidos = 0;
  let redacoes = 0;
  let truncado = false;
  const red = (texto: string) => {
    const r = redigir(texto, { sensiveis: opcoes.sensiveis, maxCaracteres: limites.maxCaracteresTexto });
    redacoes += r.redacoes;
    return r.texto;
  };
  const usados = blocos.slice(0, limites.maxBlocos);
  if (blocos.length > usados.length) {
    truncado = true;
    removidos += blocos.length - usados.length;
  }
  const dados: DadosModelo[] = usados.map((bloco) => {
    const r = bloco.resposta;
    // `resumo` e `detalhe` são textos de tela (podem citar nome completo): nunca entram.
    // Leitura de UMA pessoa/entidade (ferramenta com `entidade`): nenhum texto livre vai ao modelo — só
    // evidências com valor seguro. Nome gravado em minúsculas escaparia da heurística; aqui ele nem chega.
    if (ferramentaRegistrada(bloco.capacidade)?.entidade) {
      removidos += r.fatos.length + r.itens.length;
      const evidencias = r.evidencias.filter((e) => !mencionaCrianca(e.rotulo) && valorSeguro(e.valor));
      removidos += r.evidencias.length - evidencias.length;
      return {
        capacidade: r.capacidade,
        estado: r.estado,
        fatos: [],
        evidencias: evidencias.slice(0, limites.maxEvidenciasPorBloco).map((e) => ({ rotulo: red(e.rotulo), valor: e.valor.trim(), fonte: e.fonte })),
        itens: [],
      };
    }
    const fatos = r.fatos.filter((f) => {
      if (mencionaCrianca(f.texto)) { removidos += 1; return false; }
      return true;
    });
    const evidencias = r.evidencias.filter((e) => {
      if (mencionaCrianca(e.rotulo)) { removidos += 1; return false; }
      return true;
    });
    const itens = r.itens.filter((i) => {
      if (mencionaCrianca(i.titulo) || mencionaCrianca(i.detalhe)) { removidos += 1; return false; }
      return true;
    });
    const corte = <T>(lista: T[], max: number) => {
      if (lista.length > max) { truncado = true; removidos += lista.length - max; }
      return lista.slice(0, max);
    };
    return {
      capacidade: r.capacidade,
      estado: r.estado,
      fatos: corte(fatos, limites.maxFatosPorBloco).map((f) => ({ natureza: f.natureza, texto: red(f.texto), fonte: f.fonte })),
      evidencias: corte(evidencias, limites.maxEvidenciasPorBloco).map((e) => ({ rotulo: red(e.rotulo), valor: valorSeguro(e.valor) ? e.valor.trim() : red(e.valor), fonte: e.fonte })),
      itens: corte(itens, limites.maxItensPorBloco).map((i) => ({ prioridade: i.prioridade, titulo: red(i.titulo) })),
    };
  });

  const contexto: ContextoModelo = {
    versao: VERSAO_CONTEXTO,
    finalidade: opcoes.finalidade,
    tela: autorizado.tela,
    entidade: autorizado.entidade ? { tipo: autorizado.entidade.tipo } : null,
    capacidadesPermitidas: [...autorizado.capacidades],
    dados,
    referencia: { hoje: usados[0]?.resposta.referencia.hoje ?? null },
    minimizacao: { removidos, truncado, redacoes },
  };

  // Limite de tamanho: corta do fim (itens, depois evidências, depois fatos) até caber.
  const bytes = (c: ContextoModelo) => new TextEncoder().encode(JSON.stringify(c)).length;
  const cortarUm = (c: ContextoModelo) => {
    for (const campo of ["itens", "evidencias", "fatos"] as const) {
      for (let i = c.dados.length - 1; i >= 0; i -= 1) {
        if (c.dados[i][campo].length) {
          c.dados[i][campo].pop();
          return true;
        }
      }
    }
    return false;
  };
  while (bytes(contexto) > limites.maxBytes && cortarUm(contexto)) {
    contexto.minimizacao.truncado = true;
    contexto.minimizacao.removidos += 1;
  }
  const json = JSON.stringify(contexto);
  // Última barreira: nada que pareça id, e-mail, CPF ou link passa, mesmo que um passo anterior falhe.
  if (temIdentificadorResidual(json)) throw new ContextoRecusado("IDENTIFICADOR_RESIDUAL");
  return { contexto, json };
}
