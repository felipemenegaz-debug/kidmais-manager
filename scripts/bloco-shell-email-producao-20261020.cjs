/* eslint-disable @typescript-eslint/no-require-imports */
// Blocos de Shell de PRODUÇÃO da prova de entrega de e-mail (V6 da abertura da venda, 20/10/2026), no desenho dos blocos
// revisados de 18–20/10 (scripts/bloco-shell-reparo-bloqueios-producao-20261020.cjs: P2-A colagem interativa, P3-1 trap
// preserva o código, P3-2 bind antes da guarda). O operador (Felipe) cola no Web Shell do srv-dak77m2d0e5s73b8rkkg (bash
// INTERATIVO) blocos gerados de uma árvore conferida, com sha256 e bytes conferidos antes de colar. Cada bloco tem no
// máximo 32 KB, é ASCII e autossuficiente:
//   - CONFERIR (somente leitura; nada gravado no disco persistente, nada enviado) e ENVIAR (UM envio real ao destinatário
//     fixo) trazem o executor scripts/email-producao-20261020.cjs, conferem o sha256 ANTES de gravar, montam a pasta
//     própria /opt/render/project/src/.kidmais-email-producao-20261020/ (presente igual = JA_PRESENTE; diferente = para
//     com 4 sem gravar nada) e rodam o executor a partir dela. O transporte usado é o do deploy (lib/acessos/email.ts),
//     conferido por sha256 pelo próprio executor;
//   - LIMPEZA: remove só o arquivo da pasta própria cujo sha confere (divergente preservado) e as pastas vazias; nunca
//     arquivos do deploy nem o disco persistente (o registro anti-replay em data/ fica para sempre).
// Comum a todos: `bind` desliga o bracketed paste ANTES da guarda e fora do subshell; guarda RENDER_SERVICE_ID antes de
// qualquer leitura/gravação; corpo num SUBSHELL ( … ); no fim CODIGO_SAIDA_BLOCO=<n>: 0/1/2/3 do executor, 4 do bloco.
// Qualquer outro código (127 = linha perdida na colagem, 130 = Ctrl-C, 143 = sinal) ou ausência de CODIGO_SAIDA_BLOCO =
// parar e ler; prompt `>` depois de colar = colagem incompleta: Ctrl-C (nunca colar por cima do `>`) e colar o MESMO bloco.
// Este gerador só lê arquivos e escreve; não conecta nem executa nada.
//   node scripts/bloco-shell-email-producao-20261020.cjs <CONFERIR|ENVIAR|LIMPEZA> <rotulo-da-arvore>
//   node scripts/bloco-shell-email-producao-20261020.cjs TODOS <rotulo-da-arvore> <pasta-de-saida-inexistente>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const {createHash} = require('node:crypto');
const executor = require('./email-producao-20261020.cjs');

const DEPLOY = executor.DEPLOY;
const DESTINO = DEPLOY + '/.kidmais-email-producao-20261020';
const SERVICO = executor.SERVICO;
const EXECUTOR = 'scripts/email-producao-20261020.cjs';
const LIMITE = 32768;
const ARQUIVOS = Object.freeze([EXECUTOR]);
const COMANDOS = Object.freeze({CONFERIR: '--conferir', ENVIAR: '--enviar-autorizado', LIMPEZA: null});
const MODOS = Object.freeze(Object.keys(COMANDOS));
const sha = b => createHash('sha256').update(b).digest('hex');
function ler(raiz, arquivo) {
  const texto = fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(!texto.includes('\r'), 'CR_ISOLADO ' + arquivo);
  return Buffer.from(texto, 'utf8');
}
const seguro = s => { assert.match(s, /^[A-Za-z0-9_./-]+$/, 'CAMINHO_INSEGURO'); return s; };
/** Arquivos com conteúdo LF, sha e carga gzip+base64 determinística. */
function carga(raiz = path.resolve(__dirname, '..')) {
  return ARQUIVOS.map(a => {
    const b = ler(raiz, a);
    return {arquivo: seguro(a), sha: sha(b), bytes: b.length, b64: zlib.gzipSync(b, {level: 9}).toString('base64').match(/.{1,76}/g)};
  });
}

function cabecalho(modo, rotulo) {
  const titulo = {
    CONFERIR: ['SOMENTE LEITURA: guarda, env do e-mail (chave so presenca/tamanho/prefixo), flags da venda desligadas, transporte',
      'do deploy por sha256, disco persistente e ausencia do registro. Grava apenas a pasta propria (efemera). NAO ENVIA.'],
    ENVIAR: ['ENVIO REAL EM PRODUCAO - UMA mensagem a ' + executor.DESTINATARIO + ' (fixo), somente com a autorizacao especifica',
      'de Felipe e CONFERIR = CONFERIDO_PRONTO_PARA_ENVIO. Sem retentativa. Registro 0600 no disco persistente impede replay.',
      'Se parar ou o resultado for incerto, NAO repetir: copiar a saida e seguir o roteiro (docs/EMAIL_PRODUCAO_20261020.md).'],
    LIMPEZA: ['Remove da pasta propria so o arquivo cujo sha256 confere, e as pastas vazias; nunca arquivos do deploy nem o',
      'registro anti-replay do disco persistente. Nao envia nada. Opcional: a pasta propria some no proximo deploy.'],
  }[modo];
  return ['#!/usr/bin/env bash',
    `# BLOCO-SHELL-EMAIL-PRODUCAO-20261020-${modo} - Web Shell do ${SERVICO} (kidmais-manager-production). Colar inteiro, uma vez, e Enter.`,
    ...titulo.map(t => '# ' + t),
    `# Gerado da arvore ${rotulo} por scripts/bloco-shell-email-producao-20261020.cjs. Conferir sha256 e bytes antes de colar.`,
    '# Se aparecer o prompt ">" depois de colar (colagem incompleta): Ctrl-C, nunca colar por cima; depois colar o MESMO bloco.',
    '# Fim esperado: CODIGO_SAIDA_BLOCO=<n> (0/1/2/3 executor, 4 bloco). Outro codigo (127, 130, 143...) ou sem essa linha = parar e ler.',
    '# O bind abaixo roda ANTES da guarda e FORA do subshell: desliga o bracketed paste pelo resto desta sessao. A guarda de',
    '# RENDER_SERVICE_ID vem antes de qualquer leitura/gravacao. Corpo em subshell: opcoes, trap, umask e cwd nao vazam.',
    "bind 'set enable-bracketed-paste off' 2>/dev/null",
    `if [ "$RENDER_SERVICE_ID" != "${SERVICO}" ]; then echo "SHELL_ERRADO_NAO_E_PRODUCAO ($RENDER_SERVICE_ID): nada executado"; else`];
}

/**
 * `destino`, `deploy` e `comando` existem para os testes locais (pastas temporárias; comando substituto).
 * A CLI usa sempre as pastas de produção e o comando do executor do modo.
 */
function gerar({modo, rotulo, raiz = path.resolve(__dirname, '..'), destino = DESTINO, deploy = DEPLOY, comando}) {
  assert.ok(MODOS.includes(modo), 'MODO_DESCONHECIDO');
  assert.match(String(rotulo), /^[0-9a-f]{7,40}$/, 'ROTULO_INVALIDO');
  for (const d of [destino, deploy]) assert.match(d, /^(?:[A-Za-z]:)?\/[A-Za-z0-9_./-]+$/, 'DESTINO_INVALIDO');
  const lista = carga(raiz);
  const c = ['set -euo pipefail', 'umask 077',
    `cd '${deploy}' || { echo "DEPLOY_INACESSIVEL"; exit 4; }`,
    'for f in sha256sum base64 gzip mktemp node; do command -v "$f" >/dev/null || { echo "FERRAMENTA_AUSENTE $f"; exit 4; }; done',
    'h() { sha256sum "$1" | cut -d" " -f1; }'];
  if (modo === 'LIMPEZA') {
    c.push(`[ -d '${destino}' ] || { echo "PASTA_AUSENTE (nada a limpar)"; echo LIMPEZA_FIM; exit 0; }`, `cd '${destino}'`,
      'limpar() { if [ ! -e "$1" ]; then echo "AUSENTE $1"; elif [ "$(h "$1")" = "$2" ]; then rm -f -- "$1" || { echo "REMOCAO_FALHOU $1"; exit 4; }; echo "REMOVIDO $1"; else echo "DIVERGENTE_PRESERVADO $1"; fi; }');
    for (const x of lista) c.push(`limpar ${x.arquivo} ${x.sha}`);
    c.push('find . -mindepth 1 -depth -type d -empty -delete 2>/dev/null || true', `cd '${deploy}'`,
      `rmdir '${destino}' 2>/dev/null && echo "PASTA_REMOVIDA" || echo "PASTA_MANTIDA (arquivos divergentes preservados)"`, 'echo LIMPEZA_FIM');
  } else {
    const cmd = comando === undefined ? `node --experimental-strip-types ${EXECUTOR} ${COMANDOS[modo]}` : comando;
    c.push(`mkdir -p '${destino}' && cd '${destino}' || { echo "DESTINO_INACESSIVEL"; exit 4; }`,
      'T="$(mktemp -d)" || { echo "TEMPORARIO_FALHOU"; exit 4; }', "trap 'rm -rf -- \"$T\" || echo \"TEMPORARIO_NAO_REMOVIDO $T\"' EXIT",
      // Fase 1: decodificar e conferir no temporário; fase 2: nenhum presente diferente; fase 3: gravar.
      'prep() { { base64 -d | gzip -dc > "$T/$1"; } 2>/dev/null || { echo "CONTEUDO_DIVERGENTE $2"; exit 4; }; [ "$(h "$T/$1")" = "$1" ] || { echo "CONTEUDO_DIVERGENTE $2"; exit 4; }; }',
      'livre() { [ ! -e "$1" ] || [ "$(h "$1")" = "$2" ] || { echo "JA_EXISTE_DIFERENTE $1"; exit 4; }; }',
      'inst() { if [ -e "$1" ]; then echo "JA_PRESENTE $1"; else { mkdir -p "$(dirname "$1")" && cp "$T/$2" "$1"; } || { echo "GRAVACAO_FALHOU $1"; exit 4; }; echo "ESCRITO $1"; fi; }');
    for (const x of lista) c.push(`prep ${x.sha} ${x.arquivo} <<'B64'`, ...x.b64, 'B64');
    for (const x of lista) c.push(`livre ${x.arquivo} ${x.sha}`);
    for (const x of lista) c.push(`inst ${x.arquivo} ${x.sha}`);
    c.push(`echo "ARQUIVOS_OK ${lista.length}"`, 'codigo=0', `${cmd} || codigo=$?`,
      `echo '=== REGISTRO (${executor.PASTA_REL}) ==='`,
      `ls -l '${deploy}/${executor.PASTA_REL}' 2>/dev/null || echo "SEM_REGISTRO ${executor.PASTA_REL}"`, 'exit "$codigo"');
  }
  const bloco = [...cabecalho(modo, rotulo), '(', ...c, ')', 'echo "CODIGO_SAIDA_BLOCO=$?"', 'fi'].join('\n') + '\n';
  assert.match(bloco, /^[\x09\x0a\x20-\x7e]*$/, 'BLOCO_NAO_ASCII');
  assert.ok(Buffer.byteLength(bloco) <= LIMITE, 'BLOCO_MAIOR_QUE_32KB ' + modo + ' ' + Buffer.byteLength(bloco));
  return bloco;
}
const nomeArquivo = modo => `BLOCO-SHELL-EMAIL-PRODUCAO-20261020-${modo}.sh`;

if (require.main === module) {
  try {
    const [modo, rotulo, saida] = process.argv.slice(2);
    if (modo === 'TODOS') {
      assert.ok(saida && !fs.existsSync(saida), 'PASTA_DE_SAIDA_INVALIDA_OU_EXISTENTE');
      fs.mkdirSync(saida, {recursive: true});
      for (const m of MODOS) {
        const bloco = gerar({modo: m, rotulo});
        fs.writeFileSync(path.join(saida, nomeArquivo(m)), bloco, {flag: 'wx'});
        console.log(`${sha(Buffer.from(bloco, 'utf8'))}  ${Buffer.byteLength(bloco, 'utf8')}  ${nomeArquivo(m)}`);
      }
    } else {
      const bloco = gerar({modo, rotulo});
      process.stdout.write(bloco);
      console.error(`${nomeArquivo(modo)} sha256 ${sha(Buffer.from(bloco, 'utf8'))} (${Buffer.byteLength(bloco, 'utf8')} bytes)`);
    }
  } catch (e) { console.error('RECUSADO ' + String(e?.message ?? e).slice(0, 160)); process.exitCode = 1; }
}
module.exports = {DEPLOY, DESTINO, SERVICO, EXECUTOR, ARQUIVOS, COMANDOS, MODOS, LIMITE, carga, gerar, nomeArquivo};
