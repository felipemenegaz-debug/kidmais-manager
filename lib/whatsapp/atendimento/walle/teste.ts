import type { SessaoParaTenant } from '../../../saas/provar-tenant.ts';
import { comandoDireto, hojeOperacao, pausaPedidaNaRecepcao, type ConfiguracaoAtendimento } from '../core.ts';
import { ambienteAtendimento } from '../configuracao.ts';
import { motivoSeguro } from '../motivo-falha.ts';
import { acessoAtendimento, configuracao, tem082 } from '../service.ts';
import type { PortaWallE } from '../worker.ts';
import { registroDaPausa, registroDoBloqueio } from './entendimento.ts';
import { NOME_MOTIVO, type Fonte, type ResultadoWallE } from './tipos.ts';

/**
 * Fatia 10a ("Testar o Wall-e"): o dono escreve como se fosse o cliente e vê o que o Wall-e responderia e de qual fonte
 * veio cada parte. Roda a MESMA porta da fila (montada em modo sem efeito pela composition root da IA), com a
 * configuração SALVA e as fontes reais da empresa, numa conversa nova. Nada é enviado (WhatsApp, e-mail, aviso à
 * equipe) e nada é gravado: nem mensagem, contato, conversa ou oportunidade. Com modelo, só nas condições da fila; o
 * uso do modelo fica no registro contábil e conta no teto de IA.
 *
 * O desfecho espelha o que o worker faria com o mesmo resultado (responderWallE): pedido de parar inequívoco é bloqueio
 * na recepção, antes do Wall-e; `parar` do Wall-e é bloqueio; `silencio` passa à equipe sem nada enviado; sem saída ou
 * falha, encaminhamento fixo à equipe.
 */
export type DesfechoTeste = 'RESPONDE' | 'RESPONDE_E_PASSA' | 'PASSA_EM_SILENCIO' | 'BLOQUEIA_NA_RECEPCAO' | 'BLOQUEIA' | 'FALHA';
export type RespostaTeste = { texto: string | null; anexo: { titulo: string; tipo: string } | null; fontes: string[] };
/** `mensagem`: o texto testado, para a tela mostrar a qual pergunta o resultado responde (Astra r1, P3). `reclamacaoParaEquipe`:
 * no bloqueio da recepção, a reclamação junto do pedido de parar fica na fila da equipe (registroDoBloqueio). */
export type ResultadoTeste = { desfecho: DesfechoTeste; entendidoPor: 'MODELO' | 'REGRAS' | null; respostas: RespostaTeste[]; motivos: string[]; mensagem?: string; reclamacaoParaEquipe?: boolean };

export const LIMITE_TEXTO_TESTE = 1000;
const CONFIG_PADRAO: ConfiguracaoAtendimento = { ativo: false, nome: 'Kidmais', perguntas: [], limites: { respostasPor24h: 20 } };

const dataBr = (iso: string) => /^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : iso;
/** De onde veio cada parte, em linguagem da tela (sem ids internos). */
export function rotuloFonte(f: Fonte, config: ConfiguracaoAtendimento, titulos: Map<string, string>): string {
  switch (f.tipo) {
    case 'PRONTA': return `Biblioteca: ${titulos.get(f.id) ?? 'material publicado'}`;
    case 'AGENDA': return `Agenda de ${dataBr(f.data)}`;
    case 'PACOTE': return `Pacote ${f.codigo}`;
    case 'TABELA_PRECO': return `Tabela de preços ${f.codigo}`;
    case 'CONTRATO_MODELO': return `Modelo de contrato, cláusula ${f.clausula}`;
    case 'CATALOGO_BUFFET': return `Buffet do pacote ${f.pacote}`;
    case 'CONFIGURACAO': { const p = config.perguntas.find((x) => x.id === f.perguntaId); return p ? `Resposta aprovada: “${p.pergunta}”` : 'Resposta aprovada'; }
    case 'PERIODOS_AGENDA': return 'Horários cadastrados na agenda';
    case 'LINK_CONTRATO': return 'Link protegido do contrato';
    case 'LINK_DISPONIBILIDADE': return 'Link público de disponibilidade';
    case 'ADICIONAL': return `Adicional do pacote ${f.pacote}`;
    case 'PRECO_ADICIONAL': return 'Preço do adicional na tabela';
  }
}

/** Uma linha por fonte distinta: prontas pela identidade (id e versão), as demais pelo rótulo (mesma agenda, mesmo pacote). */
function rotulosSemRepetir(fontes: Fonte[], config: ConfiguracaoAtendimento, titulos: Map<string, string>): string[] {
  const vistos = new Map<string, string>();
  for (const f of fontes) {
    const rotulo = rotuloFonte(f, config, titulos);
    const chave = f.tipo === 'PRONTA' ? `PRONTA ${f.id} ${f.versao}` : `ROTULO ${rotulo}`;
    if (!vistos.has(chave)) vistos.set(chave, rotulo);
  }
  return [...vistos.values()];
}

/** Resultado da porta → o que a tela mostra, com o mesmo desfecho do worker. */
export function resultadoDoTeste(r: ResultadoWallE, config: ConfiguracaoAtendimento): ResultadoTeste {
  const entendidoPor = r.entendidoPor ?? null;
  const motivos = (r.passagem?.motivos ?? []).map((m) => NOME_MOTIVO[m]);
  if (r.parar) return { desfecho: 'BLOQUEIA', entendidoPor, respostas: [], motivos };
  if (r.silencio && r.passagem) return { desfecho: 'PASSA_EM_SILENCIO', entendidoPor, respostas: [], motivos };
  if (!r.saidas.length) return { desfecho: 'FALHA', entendidoPor, respostas: [], motivos: [NOME_MOTIVO.FALHA] };
  // Título de cada pronta lida pela porta (texto e link vão no corpo, sem anexo) e, por garantia, o dos anexos.
  const titulos = new Map(Object.entries(r.titulosProntas ?? {}));
  for (const s of r.saidas) if (s.anexo && !titulos.has(s.anexo.prontaId)) titulos.set(s.anexo.prontaId, s.anexo.titulo);
  // Como o worker grava: com anexo, o texto da mensagem é a legenda.
  const respostas = r.saidas.slice(0, 10).map((s) => ({
    texto: s.anexo ? s.anexo.legenda : s.texto,
    anexo: s.anexo ? { titulo: s.anexo.titulo, tipo: s.anexo.tipo } : null,
    fontes: rotulosSemRepetir(s.fontes, config, titulos),
  }));
  return { desfecho: r.passagem ? 'RESPONDE_E_PASSA' : 'RESPONDE', entendidoPor, respostas, motivos };
}

export async function testarWallE(sessao: SessaoParaTenant, texto: string, porta: PortaWallE, agora = new Date()): Promise<ResultadoTeste> {
  // Mesma autorização da sugestão ao atendente; só leitura da configuração salva.
  const { empresa, config } = await acessoAtendimento(sessao, async (tx, empresaId) => {
    if (!(await tem082(tx))) throw new Error('ATENDIMENTO_RECURSO_082_INDISPONIVEL');
    return { empresa: empresaId, config: (await configuracao(tx, empresaId)) ?? CONFIG_PADRAO };
  });
  return { ...(await testarNaPorta(texto, porta, empresa, config, agora)), mensagem: texto };
}

async function testarNaPorta(texto: string, porta: PortaWallE, empresa: string, config: ConfiguracaoAtendimento, agora: Date): Promise<ResultadoTeste> {
  // Espelho da recepção (service.receberEntrada), antes do Wall-e: nenhum modelo, nenhuma fonte.
  // 1) Pedido de parar inequívoco bloqueia o contato; com reclamação junto, a reclamação fica na fila da equipe.
  if (comandoDireto(texto)?.intencao === 'PARAR') {
    const registro = registroDoBloqueio(texto, agora.toISOString());
    return registro
      ? { desfecho: 'BLOQUEIA_NA_RECEPCAO', entendidoPor: null, respostas: [], motivos: registro.motivos.map((m) => NOME_MOTIVO[m]), reclamacaoParaEquipe: true }
      : { desfecho: 'BLOQUEIA_NA_RECEPCAO', entendidoPor: null, respostas: [], motivos: [NOME_MOTIVO.BLOQUEADO_A_PEDIDO] };
  }
  // 2) Pedido de pausa (opt-out ambíguo) nunca entra na fila: a conversa vai à equipe em silêncio, com o resumo da pausa.
  if (pausaPedidaNaRecepcao(texto)) return { desfecho: 'PASSA_EM_SILENCIO', entendidoPor: null, respostas: [], motivos: registroDaPausa(texto, agora.toISOString(), {}).motivos.map((m) => NOME_MOTIVO[m]) };
  let r: ResultadoWallE;
  try {
    // Conversa nova: sem contato (nenhum cadastro procurado), sem histórico e sem memória.
    r = await porta.responder({ empresa, ambiente: ambienteAtendimento(), contato: '', texto, historico: [], contexto: {}, config, hoje: hojeOperacao(agora), agora: agora.toISOString() });
  } catch (erro) {
    console.warn('[Atendimento WhatsApp] Teste do Wall-e falhou (%s).', motivoSeguro(erro));
    return { desfecho: 'FALHA', entendidoPor: null, respostas: [], motivos: [NOME_MOTIVO.FALHA] };
  }
  return resultadoDoTeste(r, config);
}
