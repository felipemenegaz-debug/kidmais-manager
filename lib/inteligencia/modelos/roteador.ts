import { z } from "zod";
import type { CausaModelo, IdProvedor, ModelUsage, RecusaModeloRastreio, TierModelo, Workload } from "../contratos.ts";
import type { Ambiente } from "../flags.ts";
import { barreiraTextoModelo } from "../texto-modelo.ts";
import { Circuito, chaveCircuito } from "./circuito.ts";
import { PERFIL_DEEPSEEK, PERFIL_OPENAI, criarAdaptadorOpenAICompativel } from "./openai-compativel.ts";
import { TTL_RESERVA_MS, estimarTokensEntrada, periodosDe, planejarReserva, recusaSemLimite, type OrcamentoConfigurado, type RecusaReserva, type RegistroUso } from "./orcamento.ts";
import { custoEstimado, type TabelaPrecos } from "./precos.ts";
import { ErroModelo, type AdaptadorProvedor, type Buscador, type PedidoModelo } from "./tipos.ts";

/**
 * Model Router provider-agnostic.
 *
 * workload → tier (política configurável) → provedores candidatos → timeout, retry limitado,
 * circuit breaker e fallback permitido por política. Nunca repete indefinidamente.
 * O roteador não conhece tenant além do id para orçamento/uso, não executa ferramentas e não escreve
 * dados de negócio: escritas passam pelo Human Gate, fora daqui, então timeout aqui nunca repete escrita.
 */
export const TIERS_PADRAO: Readonly<Record<Workload, TierModelo>> = {
  CLASSIFICAR_INTENCAO: "ECONOMY",
  PREENCHER_CAMPOS: "ECONOMY",
  TEXTO_CURTO: "ECONOMY",
  FAQ: "ECONOMY",
  ANALISE_ADMINISTRATIVA: "STANDARD",
  SUMARIZACAO: "STANDARD",
  EXTRACAO_CONTRATO: "STANDARD",
  REVISAO_COMPLEXA: "ADVANCED",
  // PR 6: JSON pequeno com enum fechado e validação dura; plano inválido cai na resposta honesta. ECONOMY basta.
  PLANEJAR: "ECONOMY",
  // Conversa adaptativa: saída estruturada estrita e revalidada (entendimento) e texto curto conferido (redação).
  INTERPRETAR_CONVERSA: "ECONOMY",
  REDIGIR_RESPOSTA: "ECONOMY",
};

/** Documento de cliente não muda de provedor sozinho: fallback desligado para extração. */
export const FALLBACK_PADRAO: Readonly<Record<Workload, boolean>> = {
  CLASSIFICAR_INTENCAO: true,
  PREENCHER_CAMPOS: true,
  TEXTO_CURTO: true,
  FAQ: true,
  ANALISE_ADMINISTRATIVA: true,
  SUMARIZACAO: true,
  EXTRACAO_CONTRATO: false,
  REVISAO_COMPLEXA: true,
  PLANEJAR: true,
  INTERPRETAR_CONVERSA: true,
  REDIGIR_RESPOSTA: true,
};

export type PoliticaRoteamento = {
  primario: IdProvedor | null;
  economico: IdProvedor | null;
  tiers: Readonly<Record<Workload, TierModelo>>;
  fallback: Readonly<Record<Workload, boolean>>;
  timeoutMs: number;
  tentativasExtras: number;
};

const provedorSchema = z.enum(["OPENAI", "DEEPSEEK"]);
const workloadSchema = z.enum(Object.keys(TIERS_PADRAO) as [Workload, ...Workload[]]);
// partialRecord: a política pode sobrescrever só alguns workloads.
const tiersSchema = z.partialRecord(workloadSchema, z.enum(["ECONOMY", "STANDARD", "ADVANCED"]));

function inteiro(valor: string | undefined, padrao: number, min: number, max: number) {
  const n = Number(valor);
  return Number.isInteger(n) && n >= min && n <= max ? n : padrao;
}

export function politicaDoAmbiente(env: Ambiente): PoliticaRoteamento {
  const primario = provedorSchema.safeParse(env.AI_PROVIDER_PRIMARY?.trim());
  const economico = provedorSchema.safeParse(env.AI_PROVIDER_ECONOMY?.trim());
  let tiers: Record<Workload, TierModelo> = { ...TIERS_PADRAO };
  if (env.AI_WORKLOAD_TIERS?.trim()) {
    try {
      const lido = tiersSchema.safeParse(JSON.parse(env.AI_WORKLOAD_TIERS));
      if (lido.success) tiers = { ...tiers, ...lido.data };
    } catch {
      // JSON inválido: mantém a política padrão.
    }
  }
  // Fail-closed: fallback para outro provedor só com AI_FALLBACK_ENABLED=true explícito.
  const semFallback = env.AI_FALLBACK_ENABLED !== "true";
  const fallback = Object.fromEntries(
    (Object.keys(FALLBACK_PADRAO) as Workload[]).map((w) => [w, !semFallback && FALLBACK_PADRAO[w]]),
  ) as Record<Workload, boolean>;
  return {
    primario: primario.success ? primario.data : null,
    economico: economico.success ? economico.data : null,
    tiers,
    fallback,
    timeoutMs: inteiro(env.AI_MODEL_TIMEOUT_MS, 20_000, 1_000, 120_000),
    tentativasExtras: inteiro(env.AI_MODEL_MAX_RETRIES, 1, 0, 2),
  };
}

export function criarAdaptadores(env: Ambiente, buscar: Buscador): Map<IdProvedor, AdaptadorProvedor> {
  return new Map<IdProvedor, AdaptadorProvedor>([
    ["OPENAI", criarAdaptadorOpenAICompativel(PERFIL_OPENAI, env, buscar)],
    ["DEEPSEEK", criarAdaptadorOpenAICompativel(PERFIL_DEEPSEEK, env, buscar)],
  ]);
}

/** `estabelecimentoId`: unidade COMPROVADA no Tenant Context (null/ausente ⇒ uso da empresa), só para custos/trace. */
export type AlvoRoteamento = { empresaId: string; estabelecimentoId?: string | null; capacidade: string; correlationId: string; hoje: string };

/** Alerta operacional (sem PII): o uso não pôde ser persistido. A reserva aberta continua contando. */
export type AlertaRoteador = "USO_NAO_REGISTRADO";

export type ResultadoRoteado<T> =
  | { ok: true; valor: T; usos: ModelUsage[]; provedor: IdProvedor; modelo: string; alertas?: AlertaRoteador[] }
  | { ok: false; causa: CausaModelo; usos: ModelUsage[]; alertas?: AlertaRoteador[]; recusa?: RecusaModeloRastreio };

export type DependenciasRoteador = {
  politica: PoliticaRoteamento;
  adaptadores: ReadonlyMap<IdProvedor, AdaptadorProvedor>;
  precos: TabelaPrecos | null;
  orcamento: OrcamentoConfigurado;
  registro: RegistroUso | null;
  circuito: Circuito;
  agora(): Date;
  relogio(): number;
  /** Id da reserva de orçamento (uuid). Sem ele, orçamento configurado ⇒ chamada recusada. */
  novoId?(): string;
  /** Falha ao persistir uso: nunca silenciosa. Recebe só códigos e ids. */
  alertar?(alerta: { codigo: AlertaRoteador; empresaId: string; correlationId: string }): void;
};

/** Circuito compartilhado pelo processo (o roteador é criado por pedido). */
export const circuitoGlobal = new Circuito();

export class RoteadorModelos {
  private readonly deps: DependenciasRoteador;

  constructor(deps: DependenciasRoteador) {
    this.deps = deps;
  }

  /** Há pelo menos um provedor com chave e modelo para o workload? Não chama rede. */
  disponivelPara(workload: Workload, imagens = false) {
    const tier = this.deps.politica.tiers[workload];
    return this.candidatos(workload).some((a) => a.disponivel() && a.modeloPara(tier) !== null && (!imagens || a.aceitaImagens()));
  }

  private candidatos(workload: Workload): AdaptadorProvedor[] {
    const { politica, adaptadores } = this.deps;
    const tier = politica.tiers[workload];
    const ordem: Array<IdProvedor | null> = tier === "ECONOMY" ? [politica.economico ?? politica.primario, politica.primario] : [politica.primario];
    if (politica.fallback[workload]) ordem.push("OPENAI", "DEEPSEEK");
    const vistos = new Set<IdProvedor>();
    const lista: AdaptadorProvedor[] = [];
    for (const id of ordem) {
      if (!id || vistos.has(id)) continue;
      vistos.add(id);
      const adaptador = adaptadores.get(id);
      if (adaptador) lista.push(adaptador);
    }
    // Sem fallback, só o primeiro candidato configurado conta.
    return politica.fallback[workload] ? lista : lista.slice(0, 1);
  }

  private uso(base: { alvo: AlvoRoteamento; workload: Workload; tier: TierModelo; provedor: IdProvedor; modelo: string; fallback: boolean }, parcial: Partial<ModelUsage>): ModelUsage {
    return {
      correlationId: base.alvo.correlationId,
      empresaId: base.alvo.empresaId,
      estabelecimentoId: base.alvo.estabelecimentoId ?? null,
      capacidade: base.alvo.capacidade,
      workload: base.workload,
      tier: base.tier,
      provedor: base.provedor,
      modelo: base.modelo,
      tokensEntrada: 0,
      tokensSaida: 0,
      tokensCache: null,
      duracaoMs: 0,
      custoEstimadoMicros: null,
      moeda: null,
      sucesso: false,
      erro: null,
      fallback: base.fallback,
      em: this.deps.agora().toISOString(),
      ...parcial,
    };
  }

  /**
   * Persiste o uso (e fecha a reserva, quando há). Falha aqui não derruba a resposta já obtida, mas
   * nunca é silenciosa: vira alerta operacional, e a reserva que ficou aberta continua contando no
   * orçamento (fail closed) até ser reconciliada.
   */
  private async persistir(uso: ModelUsage, reservaId: string | null, modo: "RECONCILIAR" | "LIBERAR", alertas: AlertaRoteador[]) {
    const registro = this.deps.registro;
    if (!registro) return;
    try {
      if (!reservaId) await registro.registrar(uso);
      else if (modo === "LIBERAR") await registro.liberar(reservaId, uso);
      else await registro.reconciliar(reservaId, uso);
    } catch {
      alertas.push("USO_NAO_REGISTRADO");
      const alerta = { codigo: "USO_NAO_REGISTRADO" as const, empresaId: uso.empresaId, correlationId: uso.correlationId };
      try {
        if (this.deps.alertar) this.deps.alertar(alerta);
        else console.error(`[Kidmais IA alerta] ${JSON.stringify(alerta)}`);
      } catch {
        // O alerta nunca derruba a resposta.
      }
    }
  }

  /** Reserva o teto estimado antes da chamada. Recusa ⇒ não chamar (não existe chamada sem reserva), com o motivo para o trace. */
  private async reservar(pedido: PedidoModelo<unknown>, alvo: AlvoRoteamento, adaptador: AdaptadorProvedor, modelo: string): Promise<string | { recusa: RecusaReserva; tokens: number }> {
    const orcamento = this.deps.orcamento;
    const entrada = estimarTokensEntrada(pedido, typeof orcamento === "object" ? orcamento.estimativa : undefined);
    const teto = custoEstimado(this.deps.precos, adaptador.id, modelo, { entrada, saida: pedido.maxTokensSaida, cache: null });
    const plano = planejarReserva(this.deps.orcamento, { capacidade: alvo.capacidade, hoje: alvo.hoje, moedaPreco: teto?.moeda ?? null, precoConhecido: teto !== null });
    const tokens = entrada + pedido.maxTokensSaida;
    if (plano.tipo === "RECUSAR") return { recusa: recusaSemLimite(plano.motivo), tokens };
    if (!this.deps.registro || !this.deps.novoId) return { recusa: recusaSemLimite("REGISTRO_INDISPONIVEL"), tokens };
    const id = this.deps.novoId();
    try {
      // Rotina controlada de órfãs (processo que caiu antes de reconciliar): vira ORFA e CONTINUA contando.
      await this.deps.registro.recuperarOrfas(new Date(this.deps.agora().getTime() - TTL_RESERVA_MS).toISOString(), alvo.empresaId).catch(() => 0);
      const r = await this.deps.registro.reservar({
        id, empresaId: alvo.empresaId, capacidade: alvo.capacidade, correlationId: alvo.correlationId, em: this.deps.agora().toISOString(),
        // Período fixo no momento da reserva: a reconciliação nunca o recalcula.
        periodos: periodosDe(alvo.hoje),
        tokens, custoMicros: teto?.micros ?? null, moeda: teto?.moeda ?? null, limites: plano.limites,
      });
      if (r.ok) return id;
      return { recusa: r.recusa ?? recusaSemLimite(r.motivo === "INDISPONIVEL" ? "REGISTRO_INDISPONIVEL" : "SEM_TETO"), tokens };
    } catch {
      return { recusa: recusaSemLimite("REGISTRO_ERRO"), tokens };
    }
  }

  async executar<T>(pedidoOriginal: PedidoModelo<T>, alvo: AlvoRoteamento): Promise<ResultadoRoteado<T>> {
    // Barreira de PII do roteador: TODA mensagem de usuário de qualquer chamador passa pela preparação canônica
    // (ocultos + CPF/CNPJ/e-mail/telefone/ids) antes de chegar a qualquer provedor, primário ou fallback. Única
    // exceção: EXTRACAO_CONTRATO, cujo propósito é ler o documento e que só roda com
    // AI_DOCUMENT_EXTERNAL_PROVIDER_ALLOWED=true (autorização humana explícita, desligada por padrão).
    const pedido: PedidoModelo<T> = pedidoOriginal.workload === "EXTRACAO_CONTRATO" ? pedidoOriginal : {
      ...pedidoOriginal,
      mensagens: pedidoOriginal.mensagens.map((m) => (m.papel === "user" ? { ...m, conteudo: barreiraTextoModelo(m.conteudo) } : m)),
    };
    const { politica, circuito, relogio } = this.deps;
    const tier = politica.tiers[pedido.workload];
    const usos: ModelUsage[] = [];
    const alertas: AlertaRoteador[] = [];
    const comAlertas = <R extends object>(r: R) => (alertas.length ? { ...r, alertas } : r);
    let causa: CausaModelo = "SEM_CHAVE";
    let tentouAlgum = false;
    let recusaOrcamento: { recusa: RecusaReserva; tokens: number } | null = null;

    for (const [indice, adaptador] of this.candidatos(pedido.workload).entries()) {
      const modelo = adaptador.modeloPara(tier);
      if (!adaptador.disponivel()) { if (!tentouAlgum) causa = "SEM_CHAVE"; continue; }
      if (!modelo) { if (!tentouAlgum) causa = "SEM_MODELO"; continue; }
      if ((pedido.imagens?.length || pedido.arquivos?.length) && !adaptador.aceitaImagens()) { if (!tentouAlgum) causa = "SEM_MODELO"; continue; }
      const base = { alvo, workload: pedido.workload, tier, provedor: adaptador.id, modelo, fallback: indice > 0 };
      // H2: circuito por provedor + modelo + workload (falhas do JEV não fecham o Copiloto).
      const chave = chaveCircuito(adaptador.id, modelo, pedido.workload);

      for (let tentativa = 0; tentativa <= politica.tentativasExtras; tentativa += 1) {
        if (!circuito.permite(chave, relogio())) { causa = "CIRCUITO_ABERTO"; break; }
        // RESERVA antes de cada chamada: o teto vale por tentativa, não por pedido.
        const reserva = await this.reservar(pedido as PedidoModelo<unknown>, alvo, adaptador, modelo);
        if (typeof reserva !== "string") { causa = "ORCAMENTO"; recusaOrcamento = reserva; break; }
        tentouAlgum = true;
        const inicio = relogio();
        const controle = new AbortController();
        const timer = setTimeout(() => controle.abort(), pedido.prazoMs ? Math.min(Math.max(pedido.prazoMs, 1_000), 180_000) : politica.timeoutMs);
        try {
          const bruta = await adaptador.gerar(pedido as PedidoModelo<unknown>, modelo, controle.signal, { tier });
          const duracaoMs = Math.max(0, Math.round(relogio() - inicio));
          const conhecido = bruta.tokensEntrada !== null && bruta.tokensSaida !== null;
          const custo = conhecido ? custoEstimado(this.deps.precos, adaptador.id, bruta.modelo, { entrada: bruta.tokensEntrada ?? 0, saida: bruta.tokensSaida ?? 0, cache: bruta.tokensCache }) : null;
          const medida = {
            modelo: bruta.modelo,
            tokensEntrada: bruta.tokensEntrada,
            tokensSaida: bruta.tokensSaida,
            tokensCache: bruta.tokensCache,
            duracaoMs,
            custoEstimadoMicros: custo?.micros ?? null,
            moeda: custo?.moeda ?? null,
          };
          let valor: T;
          try {
            valor = pedido.validar(bruta.texto);
          } catch {
            // Tokens foram gastos: o uso é reconciliado mesmo com saída inválida.
            const uso = this.uso(base, { ...medida, erro: "RESPOSTA_INVALIDA" });
            usos.push(uso);
            await this.persistir(uso, reserva, "RECONCILIAR", alertas);
            circuito.sucesso(chave);
            causa = "RESPOSTA_INVALIDA";
            break;
          }
          const uso = this.uso(base, { ...medida, sucesso: true });
          usos.push(uso);
          await this.persistir(uso, reserva, "RECONCILIAR", alertas);
          circuito.sucesso(chave);
          return comAlertas({ ok: true as const, valor, usos, provedor: adaptador.id, modelo: bruta.modelo });
        } catch (erro) {
          const classificado = erro instanceof ErroModelo ? erro : new ErroModelo(controle.signal.aborted ? "TIMEOUT" : "INESPERADO", false);
          const duracaoMs = Math.max(0, Math.round(relogio() - inicio));
          if (classificado.uso) {
            // H4: o provedor respondeu e informou o consumo, mas a saída é inaproveitável (ex.: raciocínio esgotou o
            // teto sem texto). Uso REAL: reconcilia com os tokens informados (null continua desconhecido) e custo
            // calculado; o provedor está saudável, então conta como sucesso para o circuito, como a saída inválida.
            const u = classificado.uso;
            const conhecido = u.tokensEntrada !== null && u.tokensSaida !== null;
            const custo = conhecido ? custoEstimado(this.deps.precos, adaptador.id, u.modelo, { entrada: u.tokensEntrada ?? 0, saida: u.tokensSaida ?? 0, cache: u.tokensCache }) : null;
            const uso = this.uso(base, {
              modelo: u.modelo, tokensEntrada: u.tokensEntrada, tokensSaida: u.tokensSaida, tokensCache: u.tokensCache, duracaoMs,
              custoEstimadoMicros: custo?.micros ?? null, moeda: custo?.moeda ?? null, erro: classificado.causa,
            });
            usos.push(uso);
            await this.persistir(uso, reserva, "RECONCILIAR", alertas);
            circuito.sucesso(chave);
            causa = classificado.causa;
            break;
          }
          // Só recusas comprovadas antes do processamento liberam a reserva (uso zero, conhecido).
          // Timeout, rede, 5xx e inesperado: o provedor pode ter consumido ⇒ USO DESCONHECIDO.
          const naoProcessado = classificado.causa === "HTTP_4XX" || classificado.causa === "SEM_CHAVE" || classificado.causa === "SEM_MODELO";
          // Uso zero conhecido com preço configurado ⇒ custo zero conhecido (não deixa o mês "desconhecido").
          // Sem preço, o custo continua null; uso desconhecido nunca vira zero.
          const custoZero = naoProcessado ? custoEstimado(this.deps.precos, adaptador.id, modelo, { entrada: 0, saida: 0, cache: null }) : null;
          const uso = this.uso(base, {
            duracaoMs,
            erro: classificado.causa,
            detalheErro: classificado.detalhe,
            tokensEntrada: naoProcessado ? 0 : null,
            tokensSaida: naoProcessado ? 0 : null,
            custoEstimadoMicros: custoZero?.micros ?? null,
            moeda: custoZero?.moeda ?? null,
          });
          usos.push(uso);
          await this.persistir(uso, reserva, naoProcessado ? "LIBERAR" : "RECONCILIAR", alertas);
          circuito.falha(chave, relogio());
          causa = classificado.causa;
          if (!classificado.tentavel) break;
        } finally {
          clearTimeout(timer);
        }
      }
    }
    // A causa final é de uma chamada que NÃO aconteceu: o trace diz por quê (motivo do orçamento, sem valores).
    // SEM_CHAVE/SEM_MODELO também podem vir de um erro do provedor depois de uma chamada: só contam sem tentativa.
    const naoChamou = causa === "ORCAMENTO" || causa === "CIRCUITO_ABERTO" || (!tentouAlgum && (causa === "SEM_CHAVE" || causa === "SEM_MODELO"));
    const recusa: RecusaModeloRastreio | undefined = naoChamou ? {
      causa, workload: pedido.workload, capacidade: alvo.capacidade,
      motivo: causa === "ORCAMENTO" ? recusaOrcamento?.recusa.motivo ?? null : null,
      escopo: causa === "ORCAMENTO" ? recusaOrcamento?.recusa.escopo ?? null : null,
      periodo: causa === "ORCAMENTO" ? recusaOrcamento?.recusa.periodo ?? null : null,
      tokensReserva: causa === "ORCAMENTO" ? recusaOrcamento?.tokens ?? null : null,
    } : undefined;
    return comAlertas({ ok: false as const, causa, usos, ...(recusa ? { recusa } : {}) });
  }
}
