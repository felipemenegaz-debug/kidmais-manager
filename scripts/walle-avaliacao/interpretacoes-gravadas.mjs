// Reprodução SEM REDE do caminho da IA com as interpretações do modelo GRAVADAS numa avaliação real
// (interpretacoes-ia-gravadas-20261007.json): cada mensagem em que o modelo foi chamado recebe a saída do modelo
// reconstruída do resultado gravado (intenções e entidades; o trecho é o texto inteiro, porque o avaliador não grava o
// trecho), revalidada pelo código atual (revalidarEntendimento) e resolvida pelo caminho da regressão (recepção, worker,
// sinais do JEV, Wall-e). Mensagem sem interpretação gravada (o modelo não foi chamado na execução real) usa as regras.
// É uma aproximação da IA, não uma medição: serve para testar a política de combinação com as leituras reais do modelo.
import { readFileSync } from 'node:fs';

/** Vocabulário do corpus → intenção do modelo. Sinais (reclamação, pagamento, instrução) vêm das regras e da triagem. */
const DO_ROTULO = { DUVIDA_FAQ: 'DUVIDA', FORA_DO_ESCOPO: 'OUTRO' };
const SINAIS = ['RECLAMACAO', 'PAGAMENTO', 'INSTRUCAO', 'ALERGIA'];
const TURNO = { ALMOCO: 'TURNO_1', NOITE: 'TURNO_2' };
const UNIDADE = { ASA_SUL: 'u-asa-sul', AGUAS_CLARAS: 'u-aguas-claras' };

/** Rodada 36: mais de um arquivo gravado (07/10: r31 × h32 e r29 × h30; 08/10: candidata r35 × h36), um por avaliação. */
const ARQUIVOS = ['interpretacoes-ia-gravadas-20261007.json', 'interpretacoes-ia-gravadas-20261008.json', 'interpretacoes-ia-gravadas-20261009.json', 'interpretacoes-ia-gravadas-20261009-h45.json'];
export function lerGravadas() {
  const lidos = ARQUIVOS.map((a) => JSON.parse(readFileSync(new URL(`./${a}`, import.meta.url), 'utf8')));
  return { descricao: lidos.map((l) => l.descricao).join(' | '), corpora: Object.assign({}, ...lidos.map((l) => l.corpora)) };
}
/** Saída do modelo (formato SaidaModelo) reconstruída de uma linha gravada. `ajustes[id]` troca intenções específicas. */
export function saidaGravada(texto, g, ajuste = null) {
  const intencoes = ajuste ?? g.intencoes.filter((r) => !SINAIS.includes(r)).map((r) => ({ tipo: DO_ROTULO[r] ?? r, trecho: texto, perguntaId: null, tema: null }));
  const e = g.entidades ?? {};
  return { intencoes, data: e.data ?? null, turno: TURNO[e.turno] ?? null, convidados: e.convidados ?? null, pacotes: e.pacotes ?? [], unidade: UNIDADE[e.unidade] ?? null, tema: e.tema ?? null, reenviar: false, alergia: g.intencoes.includes('ALERGIA') };
}
/**
 * Simula um corpus com as interpretações gravadas. `m` são as funções do código avaliado (como na regressão);
 * `ajustes` = { id: intenções do modelo } para os casos em que o desvio dependia do trecho (h32 aa27).
 */
export async function simularGravado(m, { corpus, gravado, ajustes = {}, catalogos, config, fontes, agora, rotulos = {}, sequenciasDoCorpus, simularSequencia }) {
  const porTexto = new Map(corpus.itens.map((i) => [i.texto, i.id]));
  const linhas = [];
  for (const seq of sequenciasDoCorpus(corpus.itens)) {
    linhas.push(...await simularSequencia(m, seq, {
      catalogos, config, fontes, agora, rotulos,
      entender: (texto, contexto) => {
        const id = porTexto.get(texto);
        const g = id ? gravado.linhas[id] : null;
        if (!g || !g.chamouModelo) return m.entenderPorRegras(texto, catalogos, contexto);
        return m.revalidarEntendimento(saidaGravada(texto, g, ajustes[id] ?? null), texto, catalogos, contexto);
      },
    }));
  }
  return linhas;
}
