/* eslint-disable @typescript-eslint/no-require-imports */
// B-26: entrega o conferidor G-VAZIO por colagem conferida ao Web Shell de production (D-OP-2), porque `bb65640a` não o contém.
// Mesmo desenho do B-4 (scripts/bloco-shell-entrega-grupo-a-producao.cjs): o bloco colado é um carregador mínimo e o corpo só roda se o sha256 bater.
//   ENTREGAR    grava o arquivo em .kidmais-conferidor-g-vazio (repetir é seguro; conteúdo divergente para com 4) e confere o sha. Não conecta ao banco.
//   CONFERIR    roda o arquivo entregue com a declaração colada na mesma pasta. Só leitura. Código 0/1/3 do conferidor; 4 do bloco.
//   LIMPEZA     remove só o que tem o sha certo e a declaração; divergente fica preservado. Nunca toca no deploy nem em data/.
// O gerador só lê e devolve texto; não conecta nem executa nada.
//   node scripts/bloco-shell-conferidor-g-vazio.cjs <ENTREGAR|CONFERIR|LIMPEZA> <rotulo-da-arvore>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const {createHash} = require('node:crypto');
const {ABERTURA_CARREGADOR, LINHA_TEMPORARIO, DEPLOY, SERVICO, LIMITE_PARTE} = require('./bloco-shell-entrega-grupo-a-producao.cjs');

const NOME_DESTINO = '.kidmais-conferidor-g-vazio';
const DESTINO = DEPLOY + '/' + NOME_DESTINO;
const ARQUIVO = 'conferidor-g-vazio.cjs';
const MODOS = Object.freeze(['ENTREGAR', 'CONFERIR', 'LIMPEZA']);
const sha = b => createHash('sha256').update(b).digest('hex');
const b64 = buf => zlib.gzipSync(buf, {level: 9}).toString('base64').match(/.{1,76}/g);
const fim = c => `echo "CODIGO_SAIDA_BLOCO=${c}"; exit ${c}`;

function lerConferidor(raiz = path.resolve(__dirname, '..')) {
  const texto = fs.readFileSync(path.join(raiz, 'scripts', ARQUIVO), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(!texto.includes('\r'), 'CR_ISOLADO');
  return Buffer.from(texto, 'utf8');
}

function corpo({modo, raiz}) {
  assert.ok(MODOS.includes(modo), 'MODO_INVALIDO');
  const conteudo = lerConferidor(raiz);
  const shaArq = sha(conteudo);
  const guarda = [
    'set -u', 'umask 077',
    `[ "\${RENDER_SERVICE_ID:-}" = "${SERVICO}" ] || { echo "SERVICO_DIVERGENTE"; ${fim(4)}; }`,
    `[ "$(cd ${DEPLOY} 2>/dev/null && pwd -P)" = "${DEPLOY}" ] || { echo "DEPLOY_FORA_DO_LUGAR"; ${fim(4)}; }`,
    `D=${DESTINO}`, `F="$D/${ARQUIVO}"`,
    `[ ! -L "$D" ] && [ ! -L "$F" ] || { echo "LINK_RECUSADO"; ${fim(4)}; }`,
    `confere() { [ -f "$F" ] && [ "$(sha256sum "$F" | cut -d" " -f1)" = "${shaArq}" ]; }`,
  ];
  if (modo === 'ENTREGAR') return [...guarda,
    'mkdir -p "$D" || { echo "PASTA_FALHOU"; ' + fim(4) + '; }',
    `if [ -e "$F" ]; then confere || { echo "CONTEUDO_DIVERGENTE: nada gravado"; ${fim(4)}; }; echo "JA_PRESENTE ${shaArq}"; ${fim(0)}; fi`,
    'T="$(mktemp -p "$D")" || { echo "TEMPORARIO_FALHOU"; ' + fim(4) + '; }',
    `base64 -d <<'CARGA' | gzip -dc > "$T"`, ...b64(conteudo), 'CARGA',
    `if [ "$(sha256sum "$T" | cut -d" " -f1)" != "${shaArq}" ]; then rm -f -- "$T"; echo "CARGA_DIVERGENTE: nada gravado"; ${fim(4)}; fi`,
    'mv -n -- "$T" "$F"', 'confere || { rm -f -- "$T"; echo "GRAVACAO_DIVERGENTE"; ' + fim(4) + '; }',
    `echo "ENTREGUE ${shaArq}"`, fim(0)].join('\n') + '\n';
  if (modo === 'CONFERIR') return [...guarda,
    `confere || { echo "CONFERIDOR_AUSENTE_OU_DIVERGENTE: rode ENTREGAR"; ${fim(4)}; }`,
    `[ -f "$D/declaracao.json" ] && [ ! -L "$D/declaracao.json" ] || { echo "DECLARACAO_AUSENTE"; ${fim(4)}; }`,
    'cd "$D" || { ' + fim(4) + '; }',
    `node "$F" --declaracao="$D/declaracao.json"`, 'R=$?',
    'case "$R" in 0|1|3) ;; *) R=4 ;; esac', 'echo "CODIGO_SAIDA_BLOCO=$R"', 'exit "$R"'].join('\n') + '\n';
  return [...guarda,
    `if [ -e "$F" ]; then confere && rm -f -- "$F" || echo "DIVERGENTE_PRESERVADO"; fi`,
    'rm -f -- "$D/declaracao.json"', 'rmdir -- "$D" 2>/dev/null || true', 'echo "LIMPEZA_FEITA"', fim(0)].join('\n') + '\n';
}

function gerar({modo, rotulo, raiz, alterarCorpo = x => x}) {
  assert.match(String(rotulo), /^[0-9a-f]{7,40}$/, 'ROTULO_INVALIDO');
  const texto = Buffer.from(alterarCorpo(corpo({modo, raiz})), 'utf8');
  const shaCorpo = sha(texto);
  const bloco = [`# BLOCO CONFERIDOR G-VAZIO ${modo} arvore ${rotulo}. Fim esperado: CODIGO_SAIDA_BLOCO=<n>. Sem essa linha: parar e ler.`,
    ABERTURA_CARREGADOR, 'umask 077', LINHA_TEMPORARIO, ...b64(texto), 'CORPO',
    `if [ "$(sha256sum "$C" 2>/dev/null | cut -d" " -f1)" = "${shaCorpo}" ]; then env -u BASH_ENV -u ENV bash "$C"; else echo "CORPO_DIVERGENTE: bloco incompleto ou alterado, nada executado"; echo "CODIGO_SAIDA_BLOCO=4"; exit 4; fi`,
    ')'].join('\n') + '\n';
  assert.match(bloco, /^[\x09\x0a\x20-\x7e]*$/, 'BLOCO_NAO_ASCII');
  assert.ok(Buffer.byteLength(bloco) <= LIMITE_PARTE, 'BLOCO_MAIOR_QUE_O_LIMITE');
  return bloco;
}

if (require.main === module) {
  try { const [modo, rotulo] = process.argv.slice(2); process.stdout.write(gerar({modo, rotulo})); }
  catch (e) { console.error(String(e?.message ?? e)); process.exitCode = 1; }
}
module.exports = {DESTINO, MODOS, corpo, gerar, lerConferidor};
