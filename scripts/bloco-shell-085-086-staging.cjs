/* eslint-disable @typescript-eslint/no-require-imports */
// Blocos de Shell da etapa 6b (P2-1 da revisão de 9080f45; P2-A/P3-A/P3-B da revisão de b659b14): o deploy de staging
// (87bedb8) não tem o aplicador 085/086 nem os SQL; o operador cola no Web Shell do serviço (bash INTERATIVO) um bloco
// gerado de uma árvore conferida, com sha256 e tamanho em bytes conferidos antes de colar. Desenho dos blocos da 084:
//   - bracketed paste desligado e guarda RENDER_SERVICE_ID ANTES de qualquer gravação (outro shell: nada executado);
//   - todo o corpo num SUBSHELL ( … ): set -euo pipefail, umask, cd, trap e exit não alteram nem encerram o shell do
//     operador; depois do subshell, CODIGO_SAIDA_BLOCO=<n> fica impresso e legível;
//   - o corpo confere as 4 dependências implantadas e o sha dos 7 arquivos ANTES de gravar qualquer um, grava só os
//     ausentes (presente diferente → para), roda o aplicador e imprime o registro do disco persistente;
//   - códigos: 0/1/2/3 são do aplicador (PASS-CONFERIDO / recusa antes de conectar / FALHA / RECUSARIA); 4 é recusa do
//     próprio bloco (ferramenta, dependência, conteúdo ou colisão), sempre antes de gravar;
//   - LIMPEZA remove só os 7 arquivos cujo sha confere (nunca dependências nem o registro no disco persistente).
// O bloco gerado é ASCII puro. Este gerador só lê arquivos e escreve o bloco na saída; não conecta nem executa nada.
//   node scripts/bloco-shell-085-086-staging.cjs <H0|H1|LIMPEZA> <rotulo-da-arvore>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const {createHash} = require('node:crypto');
const {ETAPAS} = require('./migration-085-086-staging.cjs');

const DESTINO = '/opt/render/project/src';
const SERVICO = 'srv-daif418ae00c73e8k2gg';
const REGISTRO = 'data/atualizacao-staging-marketing-085-086';
const APLICADOR = 'scripts/migration-085-086-staging.cjs';
const ARQUIVOS = Object.freeze([APLICADOR, ...ETAPAS.map(([, arquivo]) => arquivo)]);
const DEPENDENCIAS = Object.freeze(['scripts/migration-078-staging.cjs', 'scripts/assinatura-staging-ensaio.cjs', 'scripts/assinatura-preservacao.cjs',
  'scripts/conexao-staging.cjs']);
const COMANDOS = Object.freeze({H0:'--conferir-085-086', H1:'--aplicar-085-086-autorizado', LIMPEZA:null});
const TITULOS = Object.freeze({
  H0:['SOMENTE LEITURA no banco: grava o aplicador e os 6 SQL da 085/086 na arvore implantada (arquivos novos, efemeros),',
    'confere os sha256 e roda --conferir-085-086 (estado, privilegios, pre/postcheck em transacao READ ONLY).'],
  H1:['ESCRITA (DDL) - somente com a autorizacao especifica das migrations 085/086. Grava/confere os mesmos arquivos e roda',
    '--aplicar-085-086-autorizado UMA vez. Se algo parar, NAO repetir: copiar a saida e revisar (retomada so com flag propria).'],
  LIMPEZA:['Remove da arvore implantada so os 7 arquivos gravados pelo H0/H1 cujo sha256 confere; nunca dependencias nem o',
    'registro no disco persistente. Nao conecta ao banco.'],
});
const sha = b => createHash('sha256').update(b).digest('hex');
/** Conteúdo LF da árvore; os SQL precisam ter exatamente o hash revisado do aplicador. */
function ler(raiz, arquivo) {
  const b = Buffer.from(fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n'), 'utf8');
  const revisado = ETAPAS.find(([, a]) => a === arquivo)?.[2];
  if (revisado) assert.equal(sha(b), revisado, 'ARQUIVO_DIVERGENTE_DO_REVISADO ' + arquivo);
  return b;
}
const seguro = s => { assert.match(s, /^[A-Za-z0-9_./-]+$/, 'CAMINHO_INSEGURO'); return s; };

/**
 * `destino` e `comando` existem para os testes locais (destino temporário; comando substituto que só devolve um código).
 * A CLI usa sempre o destino de staging e o comando do aplicador do modo.
 */
function gerar({modo, rotulo, raiz = path.resolve(__dirname, '..'), destino = DESTINO, comando}) {
  assert.ok(Object.hasOwn(COMANDOS, modo), 'MODO_DESCONHECIDO');
  assert.match(String(rotulo), /^[0-9a-f]{7,40}$/, 'ROTULO_INVALIDO');
  // Destino absoluto (drive opcional, só nos testes locais), sem aspas, espaços nem metacaracteres de shell.
  assert.match(destino, /^(?:[A-Za-z]:)?\/[A-Za-z0-9_./-]+$/, 'DESTINO_INVALIDO');
  const cmd = comando === undefined ? (COMANDOS[modo] && `NODE_PATH="$PWD/node_modules" node ${APLICADOR} ${COMANDOS[modo]}`) : comando;
  const c = ['set -euo pipefail', 'umask 077', `cd '${destino}'`,
    'for f in sha256sum base64 gzip mktemp node; do command -v "$f" >/dev/null || { echo "FERRAMENTA_AUSENTE $f"; exit 4; }; done',
    'h() { sha256sum "$1" | cut -d" " -f1; }',
    'dep() { [ -f "$1" ] && [ "$(h "$1")" = "$2" ] || { echo "DEPENDENCIA_DIVERGENTE $1"; exit 4; }; }'];
  for (const d of DEPENDENCIAS) c.push(`dep ${seguro(d)} ${sha(ler(raiz, d))}`);
  if (modo === 'LIMPEZA') {
    c.push('limpar() { if [ ! -e "$1" ]; then echo "AUSENTE $1"; elif [ "$(h "$1")" = "$2" ]; then rm -f -- "$1"; echo "REMOVIDO $1"; else echo "DIVERGENTE_PRESERVADO $1"; fi; }');
    for (const a of ARQUIVOS) c.push(`limpar ${seguro(a)} ${sha(ler(raiz, a))}`);
    c.push('echo LIMPEZA_FIM');
  } else {
    c.push('T="$(mktemp -d)"', "trap 'rm -rf \"$T\"' EXIT",
      'prep() { base64 -d | gzip -dc > "$T/$1"; [ "$(h "$T/$1")" = "$3" ] || { echo "CONTEUDO_DIVERGENTE $2"; exit 4; }; }',
      'livre() { [ ! -e "$1" ] || [ "$(h "$1")" = "$2" ] || { echo "JA_EXISTE_DIFERENTE $1"; exit 4; }; }',
      'inst() { if [ -e "$2" ]; then echo "JA_PRESENTE $2"; else mkdir -p "$(dirname "$2")"; cp "$T/$1" "$2"; echo "ESCRITO $2"; fi; }');
    ARQUIVOS.forEach((a, i) => {
      const b = ler(raiz, a);
      c.push(`prep ${i} ${seguro(a)} ${sha(b)} <<'B64'`, ...zlib.gzipSync(b, {level:9}).toString('base64').match(/.{1,76}/g), 'B64');
    });
    // Fase 2 só depois de TODOS conferidos: nenhuma escrita parcial por conteúdo divergente ou colisão.
    ARQUIVOS.forEach(a => c.push(`livre ${seguro(a)} ${sha(ler(raiz, a))}`));
    ARQUIVOS.forEach((a, i) => c.push(`inst ${i} ${seguro(a)}`));
    c.push('echo ARQUIVOS_OK');
    if (cmd) c.push('codigo=0', `${cmd} || codigo=$?`,
      `echo '=== REGISTRO (${REGISTRO}) ==='`, `ls -1 ${REGISTRO} 2>/dev/null || echo SEM_REGISTRO`, 'exit "$codigo"');
  }
  const linhas = ['#!/usr/bin/env bash',
    `# BLOCO-SHELL-085-086-${modo} - Web Shell do ${SERVICO} (kidmais-manager-staging). Colar inteiro, uma vez, e Enter.`,
    ...TITULOS[modo].map(t => '# ' + t),
    `# Gerado da arvore ${rotulo} por scripts/bloco-shell-085-086-staging.cjs. Conferir sha256 e bytes antes de colar.`,
    '# Corpo em subshell: o shell do operador nao muda; no fim sai CODIGO_SAIDA_BLOCO=<n> (0/1/2/3 aplicador, 4 bloco).',
    "bind 'set enable-bracketed-paste off' 2>/dev/null",
    `if [ "$RENDER_SERVICE_ID" != "${SERVICO}" ]; then echo "SHELL_ERRADO_NAO_E_STAGING ($RENDER_SERVICE_ID): nada executado"; else`,
    '(', ...c, ')', 'echo "CODIGO_SAIDA_BLOCO=$?"', 'fi'];
  const bloco = linhas.join('\n') + '\n';
  assert.match(bloco, /^[\x09\x0a\x20-\x7e]*$/, 'BLOCO_NAO_ASCII');
  return bloco;
}

if (require.main === module) {
  try {
    const [modo, rotulo] = process.argv.slice(2);
    const bloco = gerar({modo, rotulo});
    process.stdout.write(bloco);
    console.error(`BLOCO-SHELL-085-086-${modo} sha256 ${sha(Buffer.from(bloco, 'utf8'))} (${Buffer.byteLength(bloco, 'utf8')} bytes)`);
  } catch (e) { console.error('RECUSADO ' + String(e?.message ?? e).slice(0, 160)); process.exitCode = 1; }
}
module.exports = {DESTINO, SERVICO, REGISTRO, ARQUIVOS, DEPENDENCIAS, COMANDOS, gerar};
