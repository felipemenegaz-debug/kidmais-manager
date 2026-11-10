import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import type { DbExecutor } from '../db/contracts.ts';
import { MARCA_CONTRATO_NEUTRA, marcaDoContratoPublico } from './marca-contrato.ts';

const CONTRATO = '11111111-1111-4111-8111-111111111111';
const EMPRESA = '22222222-2222-4222-8222-222222222222';

function executor(codigo: string | null, nome = 'Buffet Fictício', opcoes: { semEmpresa?: boolean; falha?: boolean } = {}): DbExecutor {
  return {
    async query<Row extends object>(sql: string) {
      if (opcoes.falha) throw new Error('falha de leitura');
      const r = (rows: object[]) => ({ rows: rows as Row[], rowCount: rows.length });
      if (sql.includes('FROM public.contratos')) return r(opcoes.semEmpresa ? [] : [{ e: EMPRESA }]);
      if (sql.includes('SELECT codigo')) return r(codigo ? [{ codigo }] : []);
      if (sql.includes('SELECT nome FROM public.empresas')) return r([{ nome }]);
      if (sql.includes('to_regclass')) return r([{ empresas: null, concessoes: null }]);
      throw new Error(`consulta inesperada: ${sql.slice(0, 60)}`);
    },
  };
}

test('outra empresa: próprio nome, nunca a marca da Kidmais', async () => {
  assert.deepEqual(await marcaDoContratoPublico(executor('buffet-ficticio'), CONTRATO), { kidmais: false, nome: 'Buffet Fictício' });
});

test('Kidmais: mantém a marca com a prova positiva do código', async () => {
  assert.deepEqual(await marcaDoContratoPublico(executor('kidmais', 'Kidmais Festas'), CONTRATO), { kidmais: true, nome: 'Kidmais Festas' });
});

test('id inválido, contrato inexistente, empresa ausente e falha de leitura: neutro e iguais', async () => {
  assert.deepEqual(await marcaDoContratoPublico(executor('kidmais'), 'nao-e-uuid'), MARCA_CONTRATO_NEUTRA);
  assert.deepEqual(await marcaDoContratoPublico(executor('kidmais', 'x', { semEmpresa: true }), CONTRATO), MARCA_CONTRATO_NEUTRA);
  assert.deepEqual(await marcaDoContratoPublico(executor(null), CONTRATO), MARCA_CONTRATO_NEUTRA);
  assert.deepEqual(await marcaDoContratoPublico(executor('kidmais', 'x', { falha: true }), CONTRATO), MARCA_CONTRATO_NEUTRA);
});

test('página pública: sem banco e sem marca antes da prova; a marca vem do contexto provado', () => {
  const pagina = readFileSync('app/contrato/[contratoId]/page.tsx', 'utf8');
  assert.doesNotMatch(pagina, /db\/postgres|marcaDoContratoPublico|marca=/);
  const tela = readFileSync('components/contrato/ContratoPublico.tsx', 'utf8');
  assert.match(tela, /const marca: MarcaContrato = contexto\?\.marca \?\? \{ kidmais: false, nome: null \};/);
  assert.match(tela, /import type \{ MarcaContrato \} from "@\/lib\/contratos\/marca-contrato";/, 'componente de cliente só importa o tipo');
});

test('comprovante: a parte interna KIDMAIS sai como BUFFET no PDF, sem mudar a persistência', () => {
  const servico = readFileSync('lib/contratos/services/administrativo.service.ts', 'utf8');
  assert.match(servico, /Parte: \$\{input\.parte === 'KIDMAIS'[^?}]*\? 'BUFFET' : input\.parte\}/);
  assert.match(servico, /parte: 'KIDMAIS', identidade/);
});

// Só o nome de marca condicionado e o nome do componente/arquivo de logo podem citar a Kidmais nestas telas.
const PERMITIDAS = [
  /marca\.kidmais \?/, /kidmais: boolean/, /ASSINADA_KIDMAIS/, /=== ['"]KIDMAIS['"]/, /\['KIDMAIS', 'CLIENTE'\]/,
  /kidmais-logo/, /alt="Kidmais"/, /KidmaisBrand/, /ContextoKidmais/, /Modelo da empresa e modelo oficial da Kidmais: sem aviso/,
  /codigo === ['"]kidmais['"]/, /marca\?\.kidmais/, /PerguntarKidmais/, /contexto\?\.marca \?\? \{ kidmais: false/,
];
for (const arquivo of ['components/contrato/ContratoPublico.tsx', 'components/admin/ContratoAdmin.tsx', 'components/admin/contrato-tela.ts', 'components/admin/ResumoContratacao.tsx', 'components/admin/RevisaoComercial.tsx', 'lib/fechamentos/contratacoes.ts', 'lib/contratos/assinatura-papel.ts']) {
  test(`sem Kidmais fixa para outra empresa: ${arquivo}`, () => {
    const soltas = readFileSync(arquivo, 'utf8').split(/\r?\n/).flatMap((linha, i) =>
      /kidmais/i.test(linha) && !PERMITIDAS.some((p) => p.test(linha)) ? [`${i + 1}: ${linha.trim().slice(0, 160)}`] : []);
    assert.deepEqual(soltas, []);
  });
}
