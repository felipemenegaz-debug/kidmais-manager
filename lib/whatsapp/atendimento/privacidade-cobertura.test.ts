import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dadoSensivel } from './core.ts';

/**
 * D1 — cobertura do detector de dado sensível MEDIDA contra um corpus independente (12/10/2026): 200 mensagens sintéticas
 * escritas e rotuladas por um agente SEM acesso ao detector (dados-teste/corpus-sensivel-independente.json), em cinco
 * categorias sensíveis e uma não sensível. O detector NÃO foi ajustado a este corpus depois da medição (para ele continuar
 * independente): os números abaixo são a linha de base registrada, e o teste só impede regressão. Eles mostram LACUNAS
 * relevantes — por isso o modo IA continua bloqueado com dados reais (padrão regras; decisão R6). Aumentar a cobertura
 * exige um corpus NOVO e independente para a próxima medição, não ajustar a lista a este.
 */
type Item = { id: string; texto: string; sensivel: boolean; categoria: string };
const corpus = JSON.parse(readFileSync(new URL('./dados-teste/corpus-sensivel-independente.json', import.meta.url), 'utf8')) as { itens: Item[] };
const LINHA_DE_BASE = { sensiveisDetectados: 104, sensiveisTotal: 128, falsosPositivos: 6, naoSensiveisTotal: 72 };

test('D1: cobertura medida no corpus independente (linha de base de 12/10; só regressão é falha)', () => {
  const sens = corpus.itens.filter((i) => i.sensivel), nao = corpus.itens.filter((i) => !i.sensivel);
  assert.equal(sens.length, LINHA_DE_BASE.sensiveisTotal); assert.equal(nao.length, LINHA_DE_BASE.naoSensiveisTotal);
  const detectados = sens.filter((i) => dadoSensivel(i.texto)).length;
  const falsos = nao.filter((i) => dadoSensivel(i.texto)).length;
  const porCategoria = Object.fromEntries([...new Set(sens.map((i) => i.categoria))].map((c) => {
    const d = sens.filter((i) => i.categoria === c);
    return [c, `${d.filter((i) => dadoSensivel(i.texto)).length}/${d.length}`];
  }));
  console.log(JSON.stringify({ detectados: `${detectados}/${sens.length}`, falsosPositivos: `${falsos}/${nao.length}`, porCategoria }));
  assert.ok(detectados >= LINHA_DE_BASE.sensiveisDetectados, `cobertura caiu: ${detectados}/${sens.length}`);
  assert.ok(falsos <= LINHA_DE_BASE.falsosPositivos, `falsos positivos subiram: ${falsos}/${nao.length}`);
  assert.ok(detectados < sens.length, 'se a cobertura chegar a 100% neste corpus, medir com um corpus novo antes de concluir algo');
});
