import type { AIResponse, ContextoTela, OrigemChamada, SecaoAgente, SugestaoAgente } from "../contratos.ts";
import type { PortasAgente, RegistroAgentes, SkillAplicavel } from "../extensoes.ts";
import { pareceInstrucao } from "../contexto/redacao.ts";
import { temaNavegacao, type Intencao } from "../intencao.ts";
import { normalizar } from "../texto-pt.ts";

/**
 * Agentes V1 (feature AGENTES): poucos, úteis e com plano FECHADO.
 *
 * Cada agente declara as leituras que pode fazer e as ações que pode PROPOR. Uma leitura só acontece se estiver
 * na lista do agente E no catálogo que o operador pode usar agora (papel + flags); uma proposta só sai pelo Human
 * Gate (rascunho). Nenhum agente usa modelo nesta versão: respostas, resumos e rascunhos são determinísticos,
 * com os dados das leituras e o conteúdo das skills. As portas recebidas são as CONTADAS pela orquestradora
 * (limites, duplicidade e trace valem para cada passo).
 */
export const VERSAO_AGENTES = "agentes-v1.0.0";

type Entrada = { texto: string; contexto: ContextoTela | null; regras: Intencao; motivo: string };
type Selecao = { texto: string; n: string; contexto: ContextoTela | null; julgamento: Readonly<Record<string, string | number>>; regras: Intencao };

type Agente = {
  id: string;
  nome: string;
  leituras: readonly string[];
  propostas: readonly string[];
  selecionar(s: Selecao): string | null;
  executar(e: Entrada, portas: PortasAgente): Promise<AIResponse>;
};

const ORIGEM: OrigemChamada = "INTENCAO_DETERMINISTICA";
const SUGESTOES = ["O que precisa da minha atenção hoje?", "Quais contratos estão pendentes?", "Como está a agenda de hoje?", "Quanto recebemos este mês?"];
const recusa = (mensagem: string): AIResponse => ({ tipo: "nao_suportado", mensagem, sugestoes: SUGESTOES });

/** Leitura permitida ao agente E ao operador; fora disso a seção simplesmente não existe. */
async function secao(agente: Agente, portas: PortasAgente, capacidade: string, parametros: Record<string, unknown>, titulo: string): Promise<SecaoAgente | null> {
  if (!agente.leituras.includes(capacidade)) return null;
  if (!portas.catalogo.some((c) => c.id === capacidade && c.tipo === "leitura")) return null;
  const r = await portas.ler(capacidade, parametros, ORIGEM);
  return r.tipo === "resposta" ? { titulo, dados: r.dados } : null;
}

function resposta(agente: Agente, resumo: string, secoes: SecaoAgente[], sugestao: SugestaoAgente | null = null): AIResponse {
  return { tipo: "agente", agente: { id: agente.id, nome: agente.nome }, resumo, secoes, sugestao };
}

// ---------------------------------------------------------------- Analista Operacional

const PANORAMA = /\b(panorama|visao geral|resumo (do dia|da operacao|geral)|como (esta|anda) a operacao|como estao as coisas|o que (esta|temos) (de )?pendente(s)?( hoje)?$|situacao geral)\b/;

const analista: Agente = {
  id: "analista_operacional",
  nome: "Analista Operacional",
  leituras: ["atencao_hoje", "contratos_pendentes", "agenda_do_dia"],
  propostas: [],
  selecionar: (s) => (PANORAMA.test(s.n) && (s.regras.tipo === "nenhuma" || s.regras.tipo === "leitura") ? "PANORAMA" : null),
  async executar(_e, portas) {
    const plano: Array<[string, string]> = [["atencao_hoje", "Financeiro de hoje"], ["contratos_pendentes", "Contratos aguardando assinatura"], ["agenda_do_dia", "Agenda de hoje"]];
    const secoes: SecaoAgente[] = [];
    for (const [capacidade, titulo] of plano) {
      const s = await secao(analista, portas, capacidade, {}, titulo);
      if (s) secoes.push(s);
    }
    if (!secoes.length) return recusa("O panorama da operação não está disponível para o seu acesso agora.");
    const atencao = secoes.filter((s) => s.dados.estado === "atencao").map((s) => s.titulo);
    const resumo = atencao.length
      ? `${atencao.length === 1 ? "1 área pede" : `${atencao.length} áreas pedem`} atenção (de ${secoes.length} consultadas): ${atencao.join("; ")}.`
      : `Nada pede atenção nas ${secoes.length} ${secoes.length === 1 ? "área consultada" : "áreas consultadas"}.`;
    return resposta(analista, resumo, secoes);
  },
};

// ---------------------------------------------------------------- Atendimento / Knowledge

const PACOTES = /\b((quais|que) pacotes|pacotes? (temos|disponiveis|ativos|oferecemos|existem)|o que (tem|inclui|esta incluido|vem) no pacote|como (sao|funcionam) os pacotes)\b/;
const OBJECAO = /\bcomo (eu )?(respondo|responder|lido|lidar|contorno|contornar|rebato|rebater)\b|\bo que (eu )?(digo|dizer|respondo|responder)\b/;
const RASCUNHO = /\b(redij\w*|redigir|escrev\w*|prepar\w*|rascunh\w*|elabor\w*|monte|montar)\b.*\b(mensagem|texto|follow[\s-]?up|lembrete|confirmac\w*|resposta)\b/;

/** Template da skill escolhido por palavras do pedido (determinístico). */
function escolherTemplate(n: string, skill: SkillAplicavel) {
  const porId = (id: string) => skill.conteudo.templates.find((t) => t.id === id) ?? null;
  if (/\b(lembret\w*|valor|pagament\w*|parcela\w*|em aberto|cobranc\w*)\b/.test(n)) return porId("lembrete_valor_aberto");
  if (/\b(confirm\w*|dados da festa|agenda)\b/.test(n)) return porId("confirmacao_agenda");
  return porId("follow_up_orcamento") ?? skill.conteudo.templates[0] ?? null;
}

const ROTULO_MARCADOR: Readonly<Record<string, string>> = {
  nome_cliente: "nome do cliente", nome_aniversariante: "nome do aniversariante", data_festa: "data da festa", horario_festa: "horário",
  nome_pacote: "pacote", convidados: "convidados", nome_empresa: "nome da empresa", valor_em_aberto: "valor em aberto",
  data_vencimento: "vencimento", situacao_contrato: "situação do contrato",
};

const atendimento: Agente = {
  id: "atendimento",
  nome: "Atendimento",
  leituras: ["pacotes_disponiveis", "onde_encontrar"],
  propostas: [],
  selecionar(s) {
    // Pedido explícito de rascunho vence a leitura da tela ("redija uma mensagem para este cliente").
    if (RASCUNHO.test(s.n) && (s.regras.tipo === "nenhuma" || s.regras.tipo === "leitura")) return "RASCUNHO";
    if (s.regras.tipo !== "nenhuma") return null;
    if (PACOTES.test(s.n)) return "PACOTES";
    if (OBJECAO.test(s.n) && /\b(caro|cara|pensar|preco|concorren\w*|mais barato|orcamento)\b/.test(s.n)) return "OBJECAO";
    if (s.julgamento.actionSensitivity === "SUGGEST" || RASCUNHO.test(s.n)) return "RASCUNHO";
    return null;
  },
  async executar(e, portas) {
    const n = normalizar(e.texto);
    if (e.motivo === "PACOTES") {
      const s = await secao(atendimento, portas, "pacotes_disponiveis", {}, "Pacotes ativos");
      if (!s) return recusa("A lista de pacotes não está disponível para o seu acesso agora.");
      return resposta(atendimento, s.dados.estado === "sem_dados" ? "Nenhum pacote ativo nesta empresa." : "Pacotes ativos desta empresa (preços seguem a tabela vigente).", [s]);
    }
    if (e.motivo === "OBJECAO") {
      const skill = await portas.skill("OBJECAO", null);
      const palavras = new Set(n.split(/\W+/).filter((p) => p.length >= 4));
      const objecao = skill?.conteudo.objecoes.find((o) => normalizar(o.objecao).split(/\W+/).some((p) => p.length >= 4 && palavras.has(p)))
        ?? skill?.conteudo.objecoes.find((o) => /caro/.test(normalizar(o.objecao)) && /\b(caro|cara|preco|mais barato)\b/.test(n));
      if (!skill || !objecao) return recusa("Ainda não tenho uma orientação para essa situação. A equipe comercial pode ajudar.");
      return resposta(atendimento, `Orientação para "${objecao.objecao}".`, [], {
        titulo: `Como responder: ${objecao.objecao}`, texto: objecao.resposta, fonte: `skill:${skill.id}@${skill.versao}`,
        aviso: "Sugestão de resposta para a equipe adaptar. Condições e valores são sempre os do sistema; o Kidmais não negocia.", pendentes: [],
      });
    }
    // RASCUNHO: template da skill + marcadores preenchidos pelo Core (entidade aberta); nada é enviado.
    const skill = await portas.skill("SUGESTAO_TEXTO", null);
    const template = skill ? escolherTemplate(n, skill) : null;
    if (!skill || !template) return recusa("Ainda não tenho um modelo de mensagem para esse caso.");
    const valores = template.marcadores.length ? await portas.marcadores() : {};
    const pendentes: string[] = [];
    const texto = template.texto.replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, nome: string) => {
      const valor = valores[nome];
      // Valor do Core com cara de instrução (cadastro envenenado) nunca entra no rascunho: fica pendente.
      if (valor && !pareceInstrucao(valor) && valor.length <= 120) return valor;
      if (!pendentes.includes(nome)) pendentes.push(nome);
      return `[${ROTULO_MARCADOR[nome] ?? nome}]`;
    });
    return resposta(atendimento, pendentes.length ? "Rascunho pronto; complete os campos entre colchetes antes de usar." : "Rascunho pronto para você revisar.", [], {
      titulo: template.titulo, texto, fonte: `skill:${skill.id}@${skill.versao}#${template.id}`,
      aviso: "Rascunho para você revisar e enviar pelo canal oficial. O Kidmais não envia mensagens.", pendentes: pendentes.map((p) => ROTULO_MARCADOR[p] ?? p),
    });
  },
};

// ---------------------------------------------------------------- Documentos / Contratos

const ASSINAR = /\b(assine|assinar|assina|assinem)\b/;
const VERSOES = /\bvers(ao|oes)\b|\bcompar\w*\b|\bdiferen\w*\b|\bo que mudou\b|\bmudanc\w*\b/;
const IMPORTAR = /\bimport\w*\b|\bcontrato (antigo|historico)\b/;

const documentos: Agente = {
  id: "documentos",
  nome: "Documentos e Contratos",
  leituras: ["comparar_versoes_contrato", "resumir_contrato", "onde_encontrar"],
  propostas: [],
  selecionar(s) {
    const sobreContrato = /\bcontrat\w*\b/.test(s.n) || s.contexto?.tela === "contrato";
    if (!sobreContrato) return null;
    if (ASSINAR.test(s.n) && !/\bassinad\w*|\bfalt\w* assinar|\bassinatura\w*\b/.test(s.n)) return "ASSINAR";
    if (IMPORTAR.test(s.n)) return "IMPORTAR";
    if (VERSOES.test(s.n)) return "VERSOES";
    return null;
  },
  async executar(e, portas) {
    if (e.motivo === "ASSINAR") {
      return recusa("O Kidmais não assina contratos. A assinatura é feita pelas partes no fluxo de assinatura do contrato, com as conferências de identidade de cada uma.");
    }
    if (e.motivo === "IMPORTAR") {
      const s = await secao(documentos, portas, "onde_encontrar", { tema: "importar_contrato" }, "Onde importar");
      if (!s) return recusa("A importação de contratos não está disponível para o seu acesso agora.");
      return resposta(documentos, "A importação de contrato antigo começa em Contratos › Importar contrato antigo: você envia o PDF, revisa os campos extraídos e só então confirma. Nada é gravado sem a sua confirmação.", [s]);
    }
    const id = e.contexto?.tela === "contrato" ? e.contexto.entidadeId : undefined;
    if (!id) return { tipo: "precisa_contexto", mensagem: "Abra o contrato e pergunte por ali: assim eu sei quais versões comparar." };
    const comparacao = await secao(documentos, portas, "comparar_versoes_contrato", { id }, "Comparação de versões");
    const situacao = await secao(documentos, portas, "resumir_contrato", { id }, "Situação da versão vigente");
    const secoes = [comparacao, situacao].filter((s): s is SecaoAgente => s !== null);
    if (!secoes.length) return recusa("A comparação de versões não está disponível para o seu acesso agora.");
    return resposta(documentos, comparacao && "resumo" in comparacao.dados ? comparacao.dados.resumo : "Situação do contrato.", secoes);
  },
};

// ---------------------------------------------------------------- Copiloto Administrativo

const administrativo: Agente = {
  id: "administrativo",
  nome: "Copiloto Administrativo",
  leituras: ["onde_encontrar"],
  propostas: ["criar_pacote", "editar_pacote", "ativar_pacote", "desativar_pacote"],
  selecionar(s) {
    if (s.regras.tipo === "acao") return administrativo.propostas.includes(s.regras.capacidade) ? "ADMIN" : null;
    return s.julgamento.intent === "ALTERAR_DADO" && s.regras.tipo === "nenhuma" ? "ADMIN" : null;
  },
  async executar(e, portas) {
    const regras = e.regras;
    // Ação suportada e permitida ao agente: só PROPOSTA, pelo Human Gate (o rascunho pergunta o que falta).
    if (regras.tipo === "acao" && administrativo.propostas.includes(regras.capacidade)) {
      const descricao = portas.descreverAcao(regras.capacidade);
      if (descricao?.classe === "CONFIRM") return portas.propor(regras.capacidade, e.texto, regras.origem);
    }
    // Alteração que o Kidmais ainda não prepara: indica a tela certa, sem fingir que fez.
    const tema = temaNavegacao(normalizar(e.texto));
    const s = tema ? await secao(administrativo, portas, "onde_encontrar", { tema }, "Onde fazer") : null;
    if (!s) return recusa("Essa alteração ainda não é preparada pelo Kidmais. Use a tela correspondente.");
    return resposta(administrativo, "Essa alteração ainda não é preparada pelo Kidmais; ela é feita na tela indicada, com as conferências de cada tela.", [s]);
  },
};

// ---------------------------------------------------------------- registro

/** Ordem de seleção: documentos (inclui recusa de assinatura) > administrativo > atendimento > analista. */
export const AGENTES: readonly Agente[] = Object.freeze([documentos, administrativo, atendimento, analista]);

export function criarRegistroAgentes(): RegistroAgentes {
  return {
    selecionar(entrada) {
      // Pedido que as regras já levam a revisão humana nunca vai para agente; ação reconhecida pelas regras só
      // para o agente que a declara (os demais não desviam o Human Gate de outra feature).
      if (entrada.regras.tipo === "revisao_humana") return null;
      const s: Selecao = { ...entrada, n: normalizar(entrada.texto) };
      for (const agente of AGENTES) {
        if (s.regras.tipo === "acao" && !agente.propostas.length) continue;
        const motivo = agente.selecionar(s);
        if (motivo) return { id: agente.id, motivo };
      }
      return null;
    },
    async executar(id, entrada, portas) {
      const agente = AGENTES.find((a) => a.id === id);
      if (!agente) return recusa("Esse pedido não é atendido pelo Kidmais.");
      return agente.executar(entrada, portas);
    },
  };
}
