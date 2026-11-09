import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Recorte da F1 para production (D4, H21): production ainda não tem a tela pública por empresa (/b/<código>), então
// o "Ver tela do cliente" segue global para todas as empresas, como hoje, mas o destino passa pela configuração
// validada: relativo fora de ATIVA e a origem antiga em ATIVA (ver telaDoClienteGlobal em roteamento.test.ts).
test('agenda: a API entrega o atalho da configuração validada e a tela não fixa mais /disponibilidade', () => {
  const rota = readFileSync('app/api/admin/disponibilidade/route.ts', 'utf8');
  assert.match(rota, /import \{ telaDoClienteGlobal \} from "@\/lib\/enderecos\/roteamento";/);
  assert.match(rota, /telaDoCliente: telaDoClienteGlobal\(process\.env\),/);

  const tela = readFileSync('components/admin/AdminDisponibilidade.tsx', 'utf8');
  assert.match(tela, /href=\{telaDoCliente\}>Ver tela do cliente/);
  assert.doesNotMatch(tela, /href="\/disponibilidade">Ver tela do cliente/);
  // Sem o campo (API antiga em cache, por exemplo), o comportamento é o de hoje.
  assert.match(tela, /telaDoCliente: admin\.telaDoCliente \?\? "\/disponibilidade"/);
  assert.match(tela, /useState\("\/disponibilidade"\)/);
  assert.equal(tela.match(/setTelaDoCliente\(dados\.telaDoCliente\);/g)?.length, 2, 'as duas cargas atualizam o atalho');
});
