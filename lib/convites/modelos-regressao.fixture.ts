// Matriz da regressão byte a byte do svgModelo FORA da imagem própria como fundo (E-CP2, 04/11/2026).
// Os hashes em modelos-regressao-767fff4a.json foram gerados com o modelos.ts da production 767fff4a
// (comando: node --experimental-strip-types lib/convites/modelos-regressao.gerar.ts). Não regenere com o
// código novo: o objetivo é provar que topo, modelos sem arte, miniaturas e temas com foto não mudaram.
import { createHash } from 'node:crypto';
import { temas, type Conteudo } from './domain.ts';
import { modeloComFoto, svgModelo } from './modelos.ts';

const cheios = { nome: 'Ana Clara', idade: '5 anos', mensagem: 'Vem comemorar com a gente!', data: '2027-04-20', horario: '15:00', local: 'Buffet Alegria', endereco: 'Rua das Flores, 100' };
const vazios = { nome: '', idade: '', mensagem: '', data: '', horario: '', local: '', endereco: '' };
const longos = { nome: 'Maria Eduarda Aparecida de Albuquerque e Vasconcelos', idade: '10 anos', mensagem: 'Vamos comemorar juntos! '.repeat(17).slice(0, 400), data: '2027-12-31', horario: '23:59', local: 'L'.repeat(120), endereco: 'Avenida '.repeat(30).slice(0, 240) };
const cores = { fundo: '#203040', tinta: '#fafafa', destaque: '#ff8800' };

export function casosRegressao() {
  const casos: { chave: string; conteudo: Conteudo; op: Parameters<typeof svgModelo>[1] }[] = [];
  for (const tema of Object.keys(temas) as Conteudo['tema'][]) {
    for (const [nomeCampos, campos] of Object.entries({ cheios, vazios, longos })) {
      for (const comCores of [false, true]) {
        const base: Conteudo = { tema, ...campos, arteId: null, confirmarPresenca: true, visual: { modo: 'modelo', ajuste: 'conter', x: 50, y: 50, ...(comCores ? { cores } : {}) } };
        const topo: Conteudo = { ...base, visual: { ...base.visual!, posicao: 'topo' } };
        const prefixo = `${tema}|${nomeCampos}|${comCores ? 'cores' : 'tema'}`;
        casos.push({ chave: `${prefixo}|sem-arte`, conteudo: base, op: { id: 'fx' } });
        casos.push({ chave: `${prefixo}|topo`, conteudo: topo, op: { arte: '/arte.webp?a=1&b=2', id: 'fx' } });
        casos.push({ chave: `${prefixo}|miniatura`, conteudo: base, op: { id: 'fx', miniatura: true } });
        casos.push({ chave: `${prefixo}|miniatura-arte`, conteudo: base, op: { arte: '/arte.webp', id: 'fx', miniatura: true } });
        // Temas com foto não entram no fundo próprio: a foto vai para o passe-partout.
        if (modeloComFoto(tema)) casos.push({ chave: `${prefixo}|foto`, conteudo: base, op: { arte: '/foto.webp', id: 'fx' } });
      }
    }
  }
  return casos;
}

export const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
export const hashesAtuais = () => Object.fromEntries(casosRegressao().map(c => [c.chave, sha256(svgModelo(c.conteudo, c.op))]));
