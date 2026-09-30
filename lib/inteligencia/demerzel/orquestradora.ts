import type { AIResponse, ContextoTela } from "../contratos.ts";
import type { Orquestrador, PassoOrquestracao, PortasOrquestracao, ResumoOrquestracao } from "../extensoes.ts";
import type { Intencao } from "../intencao.ts";
import { normalizar } from "../texto-pt.ts";
import type { JulgamentoJev, MotivoJev, TelaJev } from "../jev/v1/contrato.ts";
import { criarJuizJev, type RastroJevV1 } from "../jev/v1/juiz.ts";
import {
  LIMITES_DEMERZEL_PADRAO, LimiteDemerzel, PASSOS_COM_MODELO, VERSAO_DEMERZEL, type LimitesDemerzel, type MotivoParada, type TipoPasso,
} from "./contrato.ts";

/**
 * Demerzel V1: pipeline fixo e finito.
 *
 *   intenção por regras → julgamento JEV (modelo só se as regras não entenderam) → decisão:
 *     ação registrada ⇒ proposta sob Human Gate (nunca executa) · DENY/TELA ⇒ recusa honesta
 *     JEV FORBIDDEN ⇒ recusa explicada · instrução embutida ⇒ recusa · leitura ⇒ gateway (Policy + tenant)
 *     leitura misturada com alteração ⇒ pedir uma coisa de cada vez · sem rota ⇒ auxiliar → modelo → "ainda não"
 *
 * O JEV é consultivo: pode tornar o caminho mais restritivo, nunca menos. A Policy continua sendo a autoridade
 * (dentro das portas `ler`/`propor`), e o Human Gate a única forma de executar mutação.
 */
export type OpcoesDemerzel = {
  limites?: Partial<LimitesDemerzel>;
  registrarJev?: (rastro: RastroJevV1) => void;
};

const SUGESTOES = ["O que precisa da minha atenção hoje?", "Quais contratos estão pendentes?", "Como está a agenda de hoje?", "Quanto recebemos este mês?"];
const recusa = (mensagem: string): AIResponse => ({ tipo: "nao_suportado", mensagem, sugestoes: SUGESTOES });

const ENTIDADE_TEXTO = { festa: "festa", cliente: "cliente", contrato: "contrato" } as const;

/** Explicação humana de cada recusa do julgamento. Nunca repete o texto do pedido. */
const EXPLICACAO_PROIBIDA: ReadonlyArray<[MotivoJev, string]> = [
  ["SINAL_OUTRO_TENANT", "Eu só mostro e faço coisas da empresa em que você está agora. Para outra empresa, entre nela pelo seletor de empresa."],
  ["SINAL_OUTRO_ESTABELECIMENTO", "Eu só trabalho com os dados da unidade e da empresa em que você está agora."],
  ["SINAL_SEGREDO", "Senhas, tokens, chaves e configurações secretas nunca são mostrados pelo Kidmais."],
  ["SINAL_SQL", "O Kidmais Intelligence não executa SQL nem acessa o banco diretamente. Pergunte pelo que você quer saber."],
  ["SINAL_PERMISSAO", "Permissões e papéis só mudam em Configurações › Usuários e acessos, por quem tem essa autoridade. O Kidmais não altera acessos."],
  ["SINAL_EXCLUSAO", "Exclusão definitiva não é feita pelo Kidmais Intelligence. Use a tela correspondente, que confere todos os vínculos antes."],
  ["SINAL_DESCONTO", "Descontos seguem a política comercial e são aplicados pelas telas de Pacotes e Fechamento, não pelo Kidmais."],
  ["SINAL_CONTRATO_ASSINADO", "Contrato assinado não é alterado pelo Kidmais. Mudanças seguem o fluxo de revisão contratual, com nova assinatura."],
  ["SINAL_AUTONOMIA", "Nada é confirmado sozinho: toda ação do Kidmais passa pela sua confirmação na tela."],
];

const INJECAO: readonly MotivoJev[] = ["INSTRUCAO_IGNORADA", "ESCRITA_MISTA"];

/** Pedido de explicação (Copiloto): só então o complemento pode usar modelo. */
const PEDE_EXPLICACAO = /\b(expli\w*|entend\w*|signific\w*|por que|porque|analis\w*|interpret\w*)\b/;

function telaJev(contexto: ContextoTela | null): TelaJev {
  return contexto?.tela ?? "geral";
}

function motivosDe(j: JulgamentoJev): Set<MotivoJev> {
  return new Set([...j.intent.reasonCodes, ...j.actionSensitivity.reasonCodes, ...j.risk.reasonCodes]);
}

function resumoJulgamento(j: JulgamentoJev): Record<string, string | number> {
  return {
    intent: j.intent.classification,
    actionSensitivity: j.actionSensitivity.classification,
    humanNeed: j.humanNeed.classification,
    risk: j.risk.classification,
    contextSufficiency: j.contextSufficiency.classification,
    confiancaMinima: Math.min(j.intent.confidence, j.actionSensitivity.confidence, j.humanNeed.confidence, j.risk.confidence, j.contextSufficiency.confidence),
    origem: j.origem,
  };
}

/** Controle de uma execução: todo passo passa por aqui, e cada limite é conferido ANTES do passo. */
export class ExecucaoDemerzel {
  readonly passos: PassoOrquestracao[] = [];
  private readonly assinaturas = new Set<string>();
  private passosModelo = 0;
  private propostas = 0;
  private readonly inicio: number;
  private readonly limites: LimitesDemerzel;
  private readonly portas: PortasOrquestracao;

  constructor(limites: LimitesDemerzel, portas: PortasOrquestracao) {
    this.limites = limites;
    this.portas = portas;
    this.inicio = portas.relogio();
  }

  private restante() {
    return this.limites.prazoMs - (this.portas.relogio() - this.inicio);
  }

  custo(): number | null {
    const usos = this.portas.usosDeModelo();
    if (usos.some((u) => u.custoEstimadoMicros === null && (u.tokensEntrada !== 0 || u.tokensSaida !== 0))) return null;
    return usos.reduce((t, u) => t + (u.custoEstimadoMicros ?? 0), 0);
  }

  async passo<T>(tipo: TipoPasso, chave: string, trabalho: () => Promise<T> | T, resultadoDe: (valor: T) => string): Promise<T> {
    if (this.passos.length >= this.limites.maxPassos) throw new LimiteDemerzel("LIMITE_PASSOS");
    const assinatura = `${tipo}|${chave}`;
    if (this.assinaturas.has(assinatura)) throw new LimiteDemerzel("ACAO_DUPLICADA");
    this.assinaturas.add(assinatura);
    if (this.restante() <= 0) throw new LimiteDemerzel("LIMITE_PRAZO");
    if (PASSOS_COM_MODELO.includes(tipo)) {
      if (this.passosModelo >= this.limites.maxPassosModelo) throw new LimiteDemerzel("LIMITE_MODELO");
      if (this.limites.maxCustoMicros !== null) {
        const gasto = this.custo();
        // Preço desconhecido nunca vale zero: com teto de custo, novo gasto só com custo conhecido e abaixo do teto.
        if (gasto === null) throw new LimiteDemerzel("CUSTO_DESCONHECIDO");
        if (gasto >= this.limites.maxCustoMicros) throw new LimiteDemerzel("LIMITE_CUSTO");
      }
      this.passosModelo += 1;
    }
    if (tipo === "PROPOSTA_ACAO") {
      if (this.propostas >= this.limites.maxPropostas) throw new LimiteDemerzel("LIMITE_PROPOSTAS");
      this.propostas += 1;
    }
    const inicio = this.portas.relogio();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const PRAZO = Symbol("prazo");
    const esgotou = new Promise<typeof PRAZO>((ok) => { timer = setTimeout(() => ok(PRAZO), Math.max(1, this.restante())); });
    try {
      const valor = await Promise.race([Promise.resolve().then(trabalho), esgotou]);
      if (valor === PRAZO) {
        this.passos.push({ tipo, resultado: "PRAZO", duracaoMs: Math.max(0, Math.round(this.portas.relogio() - inicio)) });
        throw new LimiteDemerzel("LIMITE_PRAZO");
      }
      this.passos.push({ tipo, resultado: resultadoDe(valor), duracaoMs: Math.max(0, Math.round(this.portas.relogio() - inicio)) });
      return valor;
    } catch (erro) {
      if (!(erro instanceof LimiteDemerzel)) this.passos.push({ tipo, resultado: "ERRO", duracaoMs: Math.max(0, Math.round(this.portas.relogio() - inicio)) });
      throw erro;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function criarDemerzel(opcoes: OpcoesDemerzel = {}): Orquestrador {
  const limites: LimitesDemerzel = { ...LIMITES_DEMERZEL_PADRAO, ...opcoes.limites };
  return {
    async atender(entrada, portas) {
      const exec = new ExecucaoDemerzel(limites, portas);
      let julgamento: JulgamentoJev | null = null;
      let parada: MotivoParada = "NAO_SUPORTADO";
      const skills: string[] = [];
      const resumo = (): ResumoOrquestracao => ({
        versao: VERSAO_DEMERZEL,
        passos: [...exec.passos],
        parada,
        chamadasModelo: portas.usosDeModelo().length,
        custoEstimadoMicros: exec.custo(),
        julgamento: julgamento ? resumoJulgamento(julgamento) : null,
        skills: [...skills],
      });
      const { texto, contexto } = entrada;

      const terminar = (motivo: MotivoParada, resposta: AIResponse) => {
        parada = motivo;
        return resposta;
      };

      /** Leva uma intenção resolvida até a resposta, sempre pelas portas guardadas. */
      const despachar = async (intencao: Intencao, j: JulgamentoJev): Promise<AIResponse> => {
        const sensibilidade = j.actionSensitivity.classification;
        if (intencao.tipo === "revisao_humana") {
          await exec.passo("HUMANO", "", () => null, () => "ENCAMINHADO");
          return terminar("HUMANO", recusa("Esse pedido precisa de uma pessoa da equipe. Encaminhe pelo atendimento; o Kidmais não responde nem age sozinho neste caso."));
        }
        if (intencao.tipo === "precisa_contexto") {
          await exec.passo("CONTEXTO", intencao.capacidade, () => null, () => "PRECISA_CONTEXTO");
          const nome = ENTIDADE_TEXTO[intencao.entidade];
          return terminar("PRECISA_CONTEXTO", { tipo: "precisa_contexto", mensagem: `Abra a ${nome} e pergunte por ali: assim eu sei de qual ${nome} você está falando.` });
        }
        if (intencao.tipo === "acao") {
          const descricao = portas.descreverAcao(intencao.capacidade);
          if (!descricao || descricao.classe === "DENY" || descricao.origem === "TELA") {
            // A porta responde honestamente (mensagem de DENY, "começa pela tela", "ainda não"); nada é aberto.
            const r = await exec.passo("RECUSA", intencao.capacidade, () => portas.propor(intencao.capacidade, texto, intencao.origem), (v) => v.tipo);
            return terminar("RECUSA_ACAO", r);
          }
          const r = await exec.passo("PROPOSTA_ACAO", intencao.capacidade, () => portas.propor(intencao.capacidade, texto, intencao.origem), (v) => v.tipo);
          return terminar(r.tipo === "rascunho" || r.tipo === "preview" ? "PROPOSTA" : "RECUSA_ACAO", r);
        }
        if (intencao.tipo === "leitura") {
          // Consulta misturada com pedido de alteração/envio: nada é executado pela metade.
          if (sensibilidade === "CONFIRM") {
            await exec.passo("RECUSA", "PEDIDO_MISTO", () => null, () => "PEDIDO_MISTO");
            return terminar("PEDIDO_MISTO", recusa("Esse pedido mistura consulta com alteração ou envio. Peça uma coisa de cada vez: primeiro a consulta, depois a ação (que sempre pede a sua confirmação)."));
          }
          const chave = `${intencao.capacidade}:${JSON.stringify(intencao.parametros)}`;
          const r = await exec.passo("LEITURA", chave, () => portas.ler(intencao.capacidade, intencao.parametros, intencao.origem), (v) => v.tipo);
          if (r.tipo !== "resposta") return terminar("LEITURA", r);
          // Copiloto: complemento opcional da leitura já autorizada (próxima ação; explicação só se pedida).
          // Falha ou limite no complemento nunca derruba a leitura: ela sai como veio.
          const explicar = PEDE_EXPLICACAO.test(normalizar(texto));
          try {
            const completo = await exec.passo(explicar ? "COMPLEMENTO_MODELO" : "COMPLEMENTO", intencao.capacidade,
              () => portas.complementar(r, { explicar }).catch(() => r),
              (v) => (v.tipo === "resposta" && v.complemento ? (v.complemento.explicacao ? "EXPLICACAO" : "PROXIMA_ACAO") : "SEM_COMPLEMENTO"));
            return terminar("LEITURA", completo);
          } catch (erro) {
            if (!(erro instanceof LimiteDemerzel)) throw erro;
            return terminar("LEITURA", r);
          }
        }
        return terminar("NAO_SUPORTADO", recusa("Ainda não sei responder isso pelo Kidmais. Veja o que consigo fazer agora:"));
      };

      const decidir = async (): Promise<AIResponse> => {
        const regras = await exec.passo("INTENCAO_REGRAS", "", () => portas.interpretar(texto, contexto), (i) => i.tipo);

        // Julgamento JEV sempre (barato). Modelo no JEV só se as regras não entenderam o pedido.
        const porta = regras.tipo === "nenhuma" ? await portas.portaModelo() : null;
        const comModelo = porta !== null && porta.disponivel();
        const juiz = criarJuizJev({ modelo: comModelo ? porta : null, registrar: opcoes.registrarJev });
        const julgado = await exec.passo(comModelo ? "JULGAMENTO_JEV_MODELO" : "JULGAMENTO_JEV", "",
          () => juiz.julgar({ texto, tela: telaJev(contexto), temEntidade: Boolean(contexto?.entidadeId) }),
          (r) => `${r.julgamento.actionSensitivity.classification}:${r.julgamento.origem}`);
        const j = julgado.julgamento;
        julgamento = j;
        const motivos = motivosDe(j);

        // 1. Instrução embutida (ou disfarce) vence tudo: não lê, não propõe, não recusa "pela metade".
        if (INJECAO.some((m) => motivos.has(m))) {
          await exec.passo("RECUSA", "INJECAO", () => null, () => "INJECAO");
          return terminar("RECUSA_INJECAO", recusa("Não sigo instruções para ignorar regras ou mudar o meu funcionamento. Reformule o que você quer saber ou fazer."));
        }

        // 2. Ação reconhecida pelas regras e recusável (DENY/TELA/ausente) ⇒ explicação específica da própria porta.
        if (regras.tipo === "acao") {
          const descricao = portas.descreverAcao(regras.capacidade);
          if (!descricao || descricao.classe === "DENY" || descricao.origem === "TELA") return await despachar(regras, j);
        }

        // 3. Proibido pelo julgamento: recusa explicada, sem consultar nem propor nada (vale também para CONFIRM).
        if (j.actionSensitivity.classification === "FORBIDDEN") {
          const [codigo, mensagem] = EXPLICACAO_PROIBIDA.find(([m]) => motivos.has(m)) ?? ["SEM_SINAL", "Esse pedido não é feito pelo Kidmais."];
          await exec.passo("RECUSA", codigo, () => null, () => codigo);
          return terminar("RECUSA_JULGAMENTO", recusa(mensagem));
        }

        // 4. Caminho das regras: leitura (Policy + tenant no gateway) ou proposta sob Human Gate.
        if (regras.tipo !== "nenhuma") return await despachar(regras, j);

        // Sem rota pelas regras: auxiliar legado → modelo (enum fechado do catálogo) → resposta honesta.
        const auxiliar = await exec.passo("SUGESTAO_AUXILIAR", "", () => portas.sugerirRota(texto, contexto), (i) => i?.tipo ?? "NENHUMA");
        if (auxiliar) return await despachar(auxiliar, j);
        const porModelo = await exec.passo("INTENCAO_MODELO", "", () => portas.interpretarComModelo(texto, contexto), (i) => i?.tipo ?? "INDISPONIVEL");
        if (porModelo && porModelo.tipo !== "nenhuma") return await despachar(porModelo, j);

        await exec.passo("SEM_ROTA", "", () => null, () => j.actionSensitivity.classification);
        if (j.actionSensitivity.classification === "SUGGEST") {
          // Skill de sugestão (playbook): selecionada com o tenant comprovado pela porta; só forma, nunca autoridade.
          const skill = await exec.passo("SELECAO_SKILL", "SUGESTAO_TEXTO", () => portas.skill("SUGESTAO_TEXTO", null), (s) => (s ? s.nivel : "NENHUMA"));
          if (skill) skills.push(`${skill.id}@${skill.versao}#${skill.hash.slice(0, 8)}`);
          return terminar("NAO_SUPORTADO", recusa("Ainda não redijo textos pelo Kidmais. Por enquanto, consigo consultar e resumir o que está no sistema:"));
        }
        return terminar("NAO_SUPORTADO", recusa("Ainda não sei responder isso pelo Kidmais. Veja o que consigo fazer agora:"));
      };

      const registrar = () => {
        try {
          portas.registrarResumo(resumo());
        } catch {
          // O trace nunca derruba a resposta.
        }
      };
      let resposta: AIResponse;
      try {
        resposta = await decidir();
      } catch (erro) {
        if (!(erro instanceof LimiteDemerzel)) {
          // Erro de porta (Policy, tenant, domínio): segue para o tratamento seguro da conversa, com o trace.
          registrar();
          throw erro;
        }
        parada = erro.motivo;
        resposta = recusa("Não consegui concluir este pedido com segurança agora. Tente de novo com um pedido mais simples.");
      }
      registrar();
      return { resposta, resumo: resumo() };
    },
  };
}
