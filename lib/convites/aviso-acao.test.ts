import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const aviso = readFileSync(new URL('../../components/convites/AvisoAcao.tsx', import.meta.url), 'utf8');
const editor = readFileSync(new URL('../../components/convites/ConviteEditor.tsx', import.meta.url), 'utf8');
const temporarios = [...aviso.slice(aviso.indexOf('AVISOS_TEMPORARIOS'), aviso.indexOf(']);')).matchAll(/'([^']+)'/g)].map(m => m[1]);

test('cada aviso que some sozinho existe no editor (texto alterado não vira aviso permanente sem querer)', () => {
  assert.ok(temporarios.length >= 5);
  for (const texto of temporarios) assert.ok(editor.includes(`'${texto}'`), texto);
});

test('erros, geração e avisos que pedem ação não somem sozinhos', () => {
  for (const texto of temporarios) {
    assert.doesNotMatch(texto, /Não foi possível|Gerando|verificando|Salve o rascunho|Confira/i, texto);
  }
  assert.match(aviso, /!erro && AVISOS_TEMPORARIOS\.has\(aviso\)/);
});

test('o aviso da geração não repete o anúncio do progresso', () => {
  assert.match(editor, /anunciar=\{!\(aviso === MENSAGEM_GERANDO && gerando && !dados\?\.laboratorioLocal && modoArte === 'ia'\)\}/);
  assert.match(aviso, /role=\{anunciar \? 'status' : undefined\}/);
});
