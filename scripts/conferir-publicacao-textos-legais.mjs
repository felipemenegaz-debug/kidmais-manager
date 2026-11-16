// Conferência pré-publicação dos textos legais (R-5). Imprime só PASS/FAIL por item, nunca valores do ambiente.
// Uso no shell do serviço: node --experimental-strip-types scripts/conferir-publicacao-textos-legais.mjs
import { conferirPublicacao } from '../lib/cadastro/conferencia-publicacao.ts';
import { capacidadeForaDaContratacaoAtiva } from '../lib/inteligencia/flags.ts';
import { estadoWhatsappIaParaPublicacao } from '../lib/inteligencia/publicacao.ts';

const itens = conferirPublicacao(process.env, {
    capacidadeForaDaContratacaoAtiva: capacidadeForaDaContratacaoAtiva(process.env),
    whatsappIa: estadoWhatsappIaParaPublicacao(process.env),
});
for (const i of itens) console.log(`${i.ok ? 'PASS' : 'FAIL'} ${i.id}: ${i.afirmacao}`);
const falhas = itens.filter((i) => !i.ok).length;
console.log(falhas ? `REPROVADO: ${falhas} item(ns)` : 'APROVADO');
process.exit(falhas ? 1 : 0);
