/* eslint-disable @typescript-eslint/no-require-imports */
// Blocos de Shell da etapa 6b (P2-1 da revisão de 9080f45): o deploy de staging (87bedb8) não tem o aplicador 085/086
// nem os SQL; como na 084, o operador cola no Web Shell do serviço um bloco gerado de uma árvore conferida, com sha
// do bloco verificado antes de colar. O bloco:
//   1. confere as 4 dependências já implantadas (sha idêntico ao desta árvore) — sem isso, para sem escrever;
//   2. decodifica e confere o sha de TODOS os 7 arquivos num diretório temporário antes de gravar qualquer um;
//   3. grava só arquivos ausentes; arquivo presente com o mesmo sha é aceito; presente e diferente → para;
//   4. H0: roda a conferência só leitura (--conferir-085-086); H1: a aplicação (--aplicar-085-086-autorizado);
//      LIMPEZA: remove só os 7 arquivos cujo sha confere (nunca dependências, nunca o registro no disco persistente).
// Este gerador só lê arquivos e escreve o bloco na saída; não conecta, não executa o bloco.
//   node scripts/bloco-shell-085-086-staging.cjs <H0|H1|LIMPEZA> <rotulo-da-arvore>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const {createHash} = require('node:crypto');
const {ETAPAS} = require('./migration-085-086-staging.cjs');

const DESTINO = '/opt/render/project/src';
const APLICADOR = 'scripts/migration-085-086-staging.cjs';
const ARQUIVOS = Object.freeze([APLICADOR, ...ETAPAS.map(([, arquivo]) => arquivo)]);
const DEPENDENCIAS = Object.freeze(['scripts/migration-078-staging.cjs', 'scripts/assinatura-staging-ensaio.cjs', 'scripts/assinatura-preservacao.cjs',
  'scripts/conexao-staging.cjs']);
const COMANDOS = Object.freeze({H0:'--conferir-085-086', H1:'--aplicar-085-086-autorizado', LIMPEZA:null});
const sha = b => createHash('sha256').update(b).digest('hex');
/** Conteúdo LF da árvore; os SQL precisam ter exatamente o hash revisado do aplicador. */
function ler(raiz, arquivo) {
  const b = Buffer.from(fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n'), 'utf8');
  const revisado = ETAPAS.find(([, a]) => a === arquivo)?.[2];
  if (revisado) assert.equal(sha(b), revisado, 'ARQUIVO_DIVERGENTE_DO_REVISADO ' + arquivo);
  return b;
}
const seguro = s => { assert.match(s, /^[A-Za-z0-9_./-]+$/, 'CAMINHO_INSEGURO'); return s; };

function gerar({modo, rotulo, raiz = path.resolve(__dirname, '..'), destino = DESTINO, executarComando = true}) {
  assert.ok(Object.hasOwn(COMANDOS, modo), 'MODO_DESCONHECIDO');
  assert.match(String(rotulo), /^[0-9a-f]{7,40}$/, 'ROTULO_INVALIDO');
  // Destino absoluto (drive opcional, só nos testes locais), sem aspas, espaços nem metacaracteres de shell.
  assert.match(destino, /^(?:[A-Za-z]:)?\/[A-Za-z0-9_./-]+$/, 'DESTINO_INVALIDO');
  const linhas = ['#!/usr/bin/env bash', `# BLOCO-SHELL-085-086-${modo} — gerado da árvore ${rotulo} por scripts/bloco-shell-085-086-staging.cjs.`,
    '# Conferir o sha256 deste bloco antes de colar. Não contém segredos nem lê variáveis de ambiente.', 'set -euo pipefail', 'umask 077',
    `cd '${destino}'`, 'for c in sha256sum base64 gzip node; do command -v "$c" >/dev/null || { echo "FERRAMENTA_AUSENTE $c"; exit 3; }; done',
    'h() { sha256sum "$1" | cut -d" " -f1; }',
    'dep() { [ -f "$1" ] && [ "$(h "$1")" = "$2" ] || { echo "DEPENDENCIA_DIVERGENTE $1"; exit 3; }; }'];
  for (const d of DEPENDENCIAS) linhas.push(`dep ${seguro(d)} ${sha(ler(raiz, d))}`);
  if (modo === 'LIMPEZA') {
    linhas.push('limpar() { if [ ! -e "$1" ]; then echo "AUSENTE $1"; elif [ "$(h "$1")" = "$2" ]; then rm -f -- "$1"; echo "REMOVIDO $1"; else echo "DIVERGENTE_PRESERVADO $1"; fi; }');
    for (const a of ARQUIVOS) linhas.push(`limpar ${seguro(a)} ${sha(ler(raiz, a))}`);
    linhas.push('echo LIMPEZA_FIM');
    return linhas.join('\n') + '\n';
  }
  linhas.push('T="$(mktemp -d)"', "trap 'rm -rf \"$T\"' EXIT",
    'prep() { base64 -d | gzip -dc > "$T/$1"; [ "$(h "$T/$1")" = "$3" ] || { echo "CONTEUDO_DIVERGENTE $2"; exit 3; }; }',
    'livre() { [ ! -e "$1" ] || [ "$(h "$1")" = "$2" ] || { echo "JA_EXISTE_DIFERENTE $1"; exit 3; }; }',
    'inst() { if [ -e "$2" ]; then echo "JA_PRESENTE $2"; else mkdir -p "$(dirname "$2")"; cp "$T/$1" "$2"; echo "ESCRITO $2"; fi; }');
  ARQUIVOS.forEach((a, i) => {
    const b = ler(raiz, a);
    linhas.push(`prep ${i} ${seguro(a)} ${sha(b)} <<'B64'`, ...zlib.gzipSync(b, {level:9}).toString('base64').match(/.{1,76}/g), 'B64');
  });
  // Fase 2 só depois de TODOS conferidos: nenhuma escrita parcial por conteúdo divergente.
  ARQUIVOS.forEach(a => linhas.push(`livre ${seguro(a)} ${sha(ler(raiz, a))}`));
  ARQUIVOS.forEach((a, i) => linhas.push(`inst ${i} ${seguro(a)}`));
  linhas.push('echo ARQUIVOS_OK');
  if (executarComando && COMANDOS[modo]) linhas.push(`node ${APLICADOR} ${COMANDOS[modo]}`);
  return linhas.join('\n') + '\n';
}

if (require.main === module) {
  try {
    const [modo, rotulo] = process.argv.slice(2);
    const bloco = gerar({modo, rotulo});
    process.stdout.write(bloco);
    console.error(`BLOCO-SHELL-085-086-${modo} sha256 ${sha(Buffer.from(bloco, 'utf8'))} (${bloco.length} bytes)`);
  } catch (e) { console.error('RECUSADO ' + String(e?.message ?? e).slice(0, 160)); process.exitCode = 1; }
}
module.exports = {DESTINO, ARQUIVOS, DEPENDENCIAS, COMANDOS, gerar};
