/* eslint-disable @typescript-eslint/no-require-imports */
// B-26: entrega o conferidor G-VAZIO por colagem conferida ao Web Shell de production (D-OP-2), porque `bb65640a` não o contém.
// Mesmo desenho do B-4 (scripts/bloco-shell-entrega-grupo-a-producao.cjs): o bloco colado é um carregador mínimo e o corpo só roda se o sha256 bater.
//   ENTREGAR-k  D-LAN-4: o conferidor passou do limite de uma colagem, então a carga (gzip+base64) vai em N partes, coladas em qualquer ordem.
//               Cada parte grava só a sua fração em .kidmais-conferidor-g-vazio/.partes/<k>-<sha da fração> (sha conferido). A parte que
//               encontra todas as frações monta o arquivo, confere o sha256 inteiro e só então instala e apaga as frações.
//               Repetir é seguro; fração ou arquivo divergente para com 4 sem gravar. Não conecta ao banco.
//   CONFERIR    roda o arquivo entregue com a declaração colada na mesma pasta. Só leitura. Código 0/1/3 do conferidor; 4 do bloco.
//   LIMPEZA     remove só o que tem o sha certo e a declaração; divergente fica preservado. Nunca toca no deploy nem em data/.
// O gerador só lê e devolve texto; não conecta nem executa nada.
//   node scripts/bloco-shell-conferidor-g-vazio.cjs <ENTREGAR-k|CONFERIR|LIMPEZA> <rotulo-da-arvore>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const {createHash} = require('node:crypto');
const {ABERTURA_CARREGADOR, LINHA_TEMPORARIO, DEPLOY, SERVICO, LIMITE_PARTE} = require('./bloco-shell-entrega-grupo-a-producao.cjs');

const NOME_DESTINO = '.kidmais-conferidor-g-vazio';
const DESTINO = DEPLOY + '/' + NOME_DESTINO;
const ARQUIVO = 'conferidor-g-vazio.cjs';
/** Carga útil (base64) por parte; o resto do limite fica para o carregador, a guarda e a segunda codificação do corpo. */
const CARGA_PARTE = 26000;
const sha = b => createHash('sha256').update(b).digest('hex');
const b64 = buf => zlib.gzipSync(buf, {level: 9}).toString('base64').match(/.{1,76}/g);
const fim = c => `echo "CODIGO_SAIDA_BLOCO=${c}"; exit ${c}`;

function lerConferidor(raiz = path.resolve(__dirname, '..')) {
  const texto = fs.readFileSync(path.join(raiz, 'scripts', ARQUIVO), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(!texto.includes('\r'), 'CR_ISOLADO');
  return Buffer.from(texto, 'utf8');
}

/** Frações da carga (gzip+base64 do arquivo), em linhas inteiras e na ordem; cada uma com o sha256 do seu texto (com \n final). */
function fracoes(raiz) {
  const linhas = b64(lerConferidor(raiz));
  const porParte = Math.floor(CARGA_PARTE / 77);
  const lista = [];
  for (let i = 0; i < linhas.length; i += porParte) {
    const parte = linhas.slice(i, i + porParte);
    lista.push({linhas: parte, sha: sha(Buffer.from(parte.join('\n') + '\n', 'utf8'))});
  }
  return lista;
}
const modos = raiz => Object.freeze([...fracoes(raiz).map((_, i) => `ENTREGAR-${i + 1}`), 'CONFERIR', 'LIMPEZA']);
const MODOS = modos();

function corpo({modo, raiz}) {
  assert.ok(modos(raiz).includes(modo), 'MODO_INVALIDO');
  const conteudo = lerConferidor(raiz);
  const shaArq = sha(conteudo);
  const partes = fracoes(raiz);
  const nome = i => `"$P/${i + 1}-${partes[i].sha}"`;
  const todas = partes.map((_, i) => nome(i)).join(' ');
  const guarda = [
    'set -u', 'umask 077',
    `[ "\${RENDER_SERVICE_ID:-}" = "${SERVICO}" ] || { echo "SERVICO_DIVERGENTE"; ${fim(4)}; }`,
    `[ "$(cd ${DEPLOY} 2>/dev/null && pwd -P)" = "${DEPLOY}" ] || { echo "DEPLOY_FORA_DO_LUGAR"; ${fim(4)}; }`,
    `D=${DESTINO}`, `F="$D/${ARQUIVO}"`, 'P="$D/.partes"',
    `[ ! -L "$D" ] && [ ! -L "$F" ] && [ ! -L "$P" ] || { echo "LINK_RECUSADO"; ${fim(4)}; }`,
    `confere() { [ -f "$F" ] && [ "$(sha256sum "$F" | cut -d" " -f1)" = "${shaArq}" ]; }`,
    // Fração só vale se for arquivo comum com o sha do próprio nome.
    'fracao_ok() { [ -f "$1" ] && [ ! -L "$1" ] && [ "$(sha256sum "$1" | cut -d" " -f1)" = "$2" ]; }',
  ];
  const entrega = /^ENTREGAR-(\d+)$/.exec(modo);
  if (entrega) {
    const k = Number(entrega[1]), parte = partes[k - 1], meu = nome(k - 1);
    return [...guarda,
      `if [ -e "$F" ]; then confere || { echo "CONTEUDO_DIVERGENTE: nada gravado"; ${fim(4)}; }; echo "JA_PRESENTE ${shaArq}"; ${fim(0)}; fi`,
      'mkdir -p "$P" || { echo "PASTA_FALHOU"; ' + fim(4) + '; }',
      `if [ -e ${meu} ]; then fracao_ok ${meu} ${parte.sha} || { echo "FRACAO_${k}_DIVERGENTE: nada gravado"; ${fim(4)}; }; else`,
      'T="$(mktemp -p "$P")" || { echo "TEMPORARIO_FALHOU"; ' + fim(4) + '; }',
      `cat > "$T" <<'CARGA'`, ...parte.linhas, 'CARGA',
      `fracao_ok "$T" ${parte.sha} || { rm -f -- "$T"; echo "CARGA_DIVERGENTE: nada gravado"; ${fim(4)}; }`,
      `mv -n -- "$T" ${meu}; rm -f -- "$T"; fracao_ok ${meu} ${parte.sha} || { echo "GRAVACAO_DIVERGENTE"; ${fim(4)}; }`,
      'fi',
      `echo "PARTE_${k}_DE_${partes.length}_GRAVADA"`,
      // Astra r1 de código, P3: fração presente com sha errado é divergência (código 4), nunca "faltam partes".
      ...partes.map((p, i) => `if { [ -e ${nome(i)} ] || [ -L ${nome(i)} ]; } && ! fracao_ok ${nome(i)} ${p.sha}; then echo "FRACAO_${i + 1}_DIVERGENTE: nada montado"; ${fim(4)}; fi`),
      `${partes.map((p, i) => `fracao_ok ${nome(i)} ${p.sha}`).join(' && ')} || { echo "FALTAM_PARTES: cole as demais ENTREGAR-k"; ${fim(0)}; }`,
      'T="$(mktemp -p "$D")" || { echo "TEMPORARIO_FALHOU"; ' + fim(4) + '; }',
      `cat ${todas} | base64 -d | gzip -dc > "$T"`,
      `if [ "$(sha256sum "$T" | cut -d" " -f1)" != "${shaArq}" ]; then rm -f -- "$T"; echo "CARGA_DIVERGENTE: nada gravado"; ${fim(4)}; fi`,
      'mv -n -- "$T" "$F"', 'rm -f -- "$T"', 'confere || { echo "GRAVACAO_DIVERGENTE"; ' + fim(4) + '; }',
      `rm -f -- ${todas}`, 'rmdir -- "$P" 2>/dev/null || true',
      `echo "ENTREGUE ${shaArq}"`, fim(0)].join('\n') + '\n';
  }
  if (modo === 'CONFERIR') return [...guarda,
    `confere || { echo "CONFERIDOR_AUSENTE_OU_DIVERGENTE: rode ENTREGAR"; ${fim(4)}; }`,
    `[ -f "$D/declaracao.json" ] && [ ! -L "$D/declaracao.json" ] || { echo "DECLARACAO_AUSENTE"; ${fim(4)}; }`,
    'cd "$D" || { ' + fim(4) + '; }',
    `node "$F" --declaracao="$D/declaracao.json"`, 'R=$?',
    'case "$R" in 0|1|3) ;; *) R=4 ;; esac', 'echo "CODIGO_SAIDA_BLOCO=$R"', 'exit "$R"'].join('\n') + '\n';
  return [...guarda,
    `if [ -e "$F" ]; then confere && rm -f -- "$F" || echo "DIVERGENTE_PRESERVADO"; fi`,
    ...partes.map((p, i) => `if [ -e ${nome(i)} ]; then fracao_ok ${nome(i)} ${p.sha} && rm -f -- ${nome(i)} || echo "DIVERGENTE_PRESERVADO"; fi`),
    'rmdir -- "$P" 2>/dev/null || true',
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
module.exports = {DESTINO, MODOS, CARGA_PARTE, modos, fracoes, corpo, gerar, lerConferidor};
