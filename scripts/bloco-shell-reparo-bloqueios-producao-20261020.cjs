/* eslint-disable @typescript-eslint/no-require-imports */
// Blocos de Shell de PRODUÇÃO do reparo dos cinco bloqueios globais da Kidmais (20/10/2026), no desenho revisado dos
// blocos de 18–19/10 (P2-A colagem interativa, P3-1 trap preserva o código, P3-2 bind antes da guarda). O operador
// (Felipe) cola no Web Shell do srv-dak77m2d0e5s73b8rkkg (bash INTERATIVO) blocos gerados de uma árvore conferida, com
// sha256 e bytes conferidos antes de colar. Cada bloco tem no máximo 32 KB e é autossuficiente:
//   - CONFERIR (somente leitura no banco), APLICAR (escrita: exige KIDMAIS_REGISTRO_BACKUP definida ANTES de colar) e
//     RETOMAR (escrita, só depois de falha sem gravação e decisão de Felipe): trazem os 4 arquivos do executor (executor,
//     SQL revisado, aplicador do lançamento com conferirBackup e a trava de alvo dele), conferem o sha256 de cada um ANTES
//     de gravar, montam a pasta própria /opt/render/project/src/.kidmais-reparo-bloqueios-20261020/<caminho> (presente
//     igual = JA_PRESENTE; diferente = para com 4 sem gravar nada) e rodam o executor a partir dela;
//   - LIMPEZA: remove só os arquivos da pasta própria cujo sha confere (divergente preservado) e as pastas vazias; nunca
//     arquivos do deploy (scripts/ etc.) nem o disco persistente (/opt/render/project/src/data).
// Comum a todos: `bind` desliga o bracketed paste ANTES da guarda e fora do subshell; guarda RENDER_SERVICE_ID antes de
// qualquer leitura/gravação; corpo num SUBSHELL ( … ); no fim CODIGO_SAIDA_BLOCO=<n>: 0/1/2/3 do executor, 4 do bloco.
// Qualquer outro código (127 = linha perdida na colagem, 130 = Ctrl-C, 143 = sinal) ou ausência de CODIGO_SAIDA_BLOCO =
// parar e ler; prompt `>` depois de colar = colagem incompleta: Ctrl-C (nunca colar por cima do `>`) e colar o MESMO bloco.
// O bloco gerado é ASCII puro. Este gerador só lê arquivos e escreve; não conecta nem executa nada.
//   node scripts/bloco-shell-reparo-bloqueios-producao-20261020.cjs <CONFERIR|APLICAR|RETOMAR|LIMPEZA> <rotulo-da-arvore>
//   node scripts/bloco-shell-reparo-bloqueios-producao-20261020.cjs TODOS <rotulo-da-arvore> <pasta-de-saida-inexistente>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const {createHash} = require('node:crypto');
const executor = require('./reparo-bloqueios-producao-20261020.cjs');

const DEPLOY = '/opt/render/project/src';
const DESTINO = DEPLOY + '/.kidmais-reparo-bloqueios-20261020';
const SERVICO = executor.ALVO.servico;
const EXECUTOR = 'scripts/reparo-bloqueios-producao-20261020.cjs';
const PASTA_BACKUP = DEPLOY + '/data/lancamento-venda-20261011';
const REGISTROS = ['data/reparo-bloqueios-producao-20261020', 'data/lancamento-venda-20261011'];
const LIMITE = 32768;
/** O executor e tudo que ele carrega: o SQL revisado e o aplicador do lançamento (conferirBackup) com a trava de alvo dele. */
const ARQUIVOS = Object.freeze([EXECUTOR, executor.SQL_ARQUIVO, 'scripts/migrations-lancamento-production.cjs', 'scripts/diagnostico-lancamento-production.cjs']);
/** sha256 (LF) fixados: o executor confere o SQL; os dois do lançamento são os do manifesto de 19/10 (aplicadorSha256/diagnosticoSha256). */
const SHA_FIXOS = Object.freeze({
  [executor.SQL_ARQUIVO]: executor.SQL_SHA256,
  'scripts/migrations-lancamento-production.cjs': '33bb4ab6caa4cd2ecbb4401340631f31ad799af7f08d85e3b6975cdd63560070',
  'scripts/diagnostico-lancamento-production.cjs': '6606c08e58d01c633e6b55d65683156585f069f2d4c5d96ccfee80f2b7d5615a',
});
const COMANDOS = Object.freeze({CONFERIR: '--conferir', APLICAR: '--aplicar-autorizado --backup "$KIDMAIS_REGISTRO_BACKUP"',
  RETOMAR: '--retomar-autorizado --backup "$KIDMAIS_REGISTRO_BACKUP"', LIMPEZA: null});
const MODOS = Object.freeze(Object.keys(COMANDOS));
const sha = b => createHash('sha256').update(b).digest('hex');
function ler(raiz, arquivo) {
  const texto = fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(!texto.includes('\r'), 'CR_ISOLADO ' + arquivo);
  return Buffer.from(texto, 'utf8');
}
const seguro = s => { assert.match(s, /^[A-Za-z0-9_./-]+$/, 'CAMINHO_INSEGURO'); return s; };
/** Arquivos com conteúdo LF, sha (conferido com os fixados) e carga gzip+base64 determinística. */
function carga(raiz = path.resolve(__dirname, '..')) {
  return ARQUIVOS.map(a => {
    const b = ler(raiz, a), h = sha(b);
    if (SHA_FIXOS[a]) assert.equal(h, SHA_FIXOS[a], 'SHA_DIVERGENTE ' + a);
    return {arquivo: seguro(a), sha: h, bytes: b.length, b64: zlib.gzipSync(b, {level: 9}).toString('base64').match(/.{1,76}/g)};
  });
}

function cabecalho(modo, rotulo) {
  const titulo = {
    CONFERIR: ['SOMENTE LEITURA no banco. Grava apenas a pasta propria (efemera; some no proximo deploy) e roda --conferir:',
      'identidade, flags, schema e gatilhos, privilegios, os cinco bloqueios, conflitos, marcadores. Nao grava no banco.'],
    APLICAR: ['ESCRITA EM PRODUCAO (5 bloqueios + 5 resolucoes) - somente com a autorizacao especifica de Felipe e CONFERIR = CONFERIDO.',
      'ANTES de colar, no mesmo shell: export KIDMAIS_REGISTRO_BACKUP=<registro .json do backup do P1, com menos de 24 h>.',
      'Roda --aplicar-autorizado UMA vez. Se parar, NAO repetir: copiar a saida, rodar CONFERIR e seguir o roteiro.'],
    RETOMAR: ['ESCRITA EM PRODUCAO - RETOMADA depois de uma falha SEM gravacao (marcador FALHA_NADA_GRAVADO), somente com decisao',
      'explicita de Felipe apos ler a saida. ANTES de colar: export KIDMAIS_REGISTRO_BACKUP=<registro do P1, < 24 h>.',
      'O executor so retoma com os cinco bloqueios INTACTOS e nunca depois de COMMIT_CONFIRMADO.'],
    LIMPEZA: ['Remove da pasta propria so arquivos cujo sha256 confere, e as pastas vazias; nunca arquivos do deploy nem',
      'registros/marcadores do disco persistente. Nao conecta ao banco. Opcional: a pasta propria some no proximo deploy.'],
  }[modo];
  return ['#!/usr/bin/env bash',
    `# BLOCO-SHELL-REPARO-BLOQUEIOS-PRODUCAO-20261020-${modo} - Web Shell do ${SERVICO} (kidmais-manager-production). Colar inteiro, uma vez, e Enter.`,
    ...titulo.map(t => '# ' + t),
    `# Gerado da arvore ${rotulo} por scripts/bloco-shell-reparo-bloqueios-producao-20261020.cjs. Conferir sha256 e bytes antes de colar.`,
    '# Se aparecer o prompt ">" depois de colar (colagem incompleta): Ctrl-C, nunca colar por cima; depois colar o MESMO bloco.',
    '# Fim esperado: CODIGO_SAIDA_BLOCO=<n> (0/1/2/3 executor, 4 bloco). Outro codigo (127, 130, 143...) ou sem essa linha = parar e ler.',
    '# O bind abaixo roda ANTES da guarda e FORA do subshell: desliga o bracketed paste pelo resto desta sessao. A guarda de',
    '# RENDER_SERVICE_ID vem antes de qualquer leitura/gravacao. Corpo em subshell: opcoes, trap, umask e cwd nao vazam.',
    "bind 'set enable-bracketed-paste off' 2>/dev/null",
    `if [ "$RENDER_SERVICE_ID" != "${SERVICO}" ]; then echo "SHELL_ERRADO_NAO_E_PRODUCAO ($RENDER_SERVICE_ID): nada executado"; else`];
}

/**
 * `destino`, `deploy`, `pastaBackup` e `comando` existem para os testes locais (pastas temporárias; comando substituto).
 * A CLI usa sempre as pastas de produção e o comando do executor do modo.
 */
function gerar({modo, rotulo, raiz = path.resolve(__dirname, '..'), destino = DESTINO, deploy = DEPLOY, comando, pastaBackup = PASTA_BACKUP}) {
  assert.ok(MODOS.includes(modo), 'MODO_DESCONHECIDO');
  assert.match(String(rotulo), /^[0-9a-f]{7,40}$/, 'ROTULO_INVALIDO');
  for (const d of [destino, deploy, pastaBackup]) assert.match(d, /^(?:[A-Za-z]:)?\/[A-Za-z0-9_./-]+$/, 'DESTINO_INVALIDO');
  const lista = carga(raiz);
  const c = ['set -euo pipefail', 'umask 077'];
  if (modo === 'APLICAR' || modo === 'RETOMAR') {
    // Antes de qualquer arquivo: registro do backup presente, na pasta do P1, nome simples (o executor confere idade,
    // hash do dump, PITR e pacote pelo conferirBackup do lançamento).
    c.push('case "${KIDMAIS_REGISTRO_BACKUP:-}" in',
      '  ' + pastaBackup + '/backup-*.json) ;;',
      '  "") echo "REGISTRO_BACKUP_AUSENTE: export KIDMAIS_REGISTRO_BACKUP=<registro do P1> antes de colar"; exit 4 ;;',
      '  *) echo "REGISTRO_BACKUP_INVALIDO"; exit 4 ;;', 'esac',
      'case "${KIDMAIS_REGISTRO_BACKUP#' + pastaBackup + '/}" in *[!A-Za-z0-9._-]*) echo "REGISTRO_BACKUP_INVALIDO"; exit 4 ;; esac',
      '[ -f "$KIDMAIS_REGISTRO_BACKUP" ] || { echo "REGISTRO_BACKUP_NAO_ENCONTRADO"; exit 4; }');
  }
  c.push(`cd '${deploy}' || { echo "DEPLOY_INACESSIVEL"; exit 4; }`,
    'for f in sha256sum base64 gzip mktemp node; do command -v "$f" >/dev/null || { echo "FERRAMENTA_AUSENTE $f"; exit 4; }; done',
    'h() { sha256sum "$1" | cut -d" " -f1; }');
  if (modo === 'LIMPEZA') {
    c.push(`[ -d '${destino}' ] || { echo "PASTA_AUSENTE (nada a limpar)"; echo LIMPEZA_FIM; exit 0; }`, `cd '${destino}'`,
      'limpar() { if [ ! -e "$1" ]; then echo "AUSENTE $1"; elif [ "$(h "$1")" = "$2" ]; then rm -f -- "$1" || { echo "REMOCAO_FALHOU $1"; exit 4; }; echo "REMOVIDO $1"; else echo "DIVERGENTE_PRESERVADO $1"; fi; }');
    for (const x of lista) c.push(`limpar ${x.arquivo} ${x.sha}`);
    c.push('find . -mindepth 1 -depth -type d -empty -delete 2>/dev/null || true', `cd '${deploy}'`,
      `rmdir '${destino}' 2>/dev/null && echo "PASTA_REMOVIDA" || echo "PASTA_MANTIDA (arquivos divergentes preservados)"`, 'echo LIMPEZA_FIM');
  } else {
    const cmd = comando === undefined ? `NODE_PATH='${deploy}/node_modules' node ${EXECUTOR} ${COMANDOS[modo]}` : comando;
    c.push('[ -f node_modules/pg/package.json ] || { echo "DEPENDENCIA_AUSENTE node_modules/pg"; exit 4; }',
      `mkdir -p '${destino}' && cd '${destino}' || { echo "DESTINO_INACESSIVEL"; exit 4; }`,
      'T="$(mktemp -d)" || { echo "TEMPORARIO_FALHOU"; exit 4; }', "trap 'rm -rf -- \"$T\" || echo \"TEMPORARIO_NAO_REMOVIDO $T\"' EXIT",
      // Fase 1: decodificar e conferir TODOS no temporário; fase 2: nenhum presente diferente; fase 3: gravar.
      'prep() { { base64 -d | gzip -dc > "$T/$1"; } 2>/dev/null || { echo "CONTEUDO_DIVERGENTE $2"; exit 4; }; [ "$(h "$T/$1")" = "$1" ] || { echo "CONTEUDO_DIVERGENTE $2"; exit 4; }; }',
      'livre() { [ ! -e "$1" ] || [ "$(h "$1")" = "$2" ] || { echo "JA_EXISTE_DIFERENTE $1"; exit 4; }; }',
      'inst() { if [ -e "$1" ]; then echo "JA_PRESENTE $1"; else { mkdir -p "$(dirname "$1")" && cp "$T/$2" "$1"; } || { echo "GRAVACAO_FALHOU $1"; exit 4; }; echo "ESCRITO $1"; fi; }');
    for (const x of lista) c.push(`prep ${x.sha} ${x.arquivo} <<'B64'`, ...x.b64, 'B64');
    for (const x of lista) c.push(`livre ${x.arquivo} ${x.sha}`);
    for (const x of lista) c.push(`inst ${x.arquivo} ${x.sha}`);
    c.push(`echo "ARQUIVOS_OK ${lista.length}"`);
    if (cmd) c.push('codigo=0', `${cmd} || codigo=$?`, `echo '=== REGISTROS (${REGISTROS.join(' e ')}) ==='`,
      ...REGISTROS.map(r => `ls -1 '${deploy}/${r}' 2>/dev/null | grep -v '\\.dump$' || echo "SEM_REGISTRO ${r}"`), 'exit "$codigo"');
  }
  const bloco = [...cabecalho(modo, rotulo), '(', ...c, ')', 'echo "CODIGO_SAIDA_BLOCO=$?"', 'fi'].join('\n') + '\n';
  assert.match(bloco, /^[\x09\x0a\x20-\x7e]*$/, 'BLOCO_NAO_ASCII');
  assert.ok(Buffer.byteLength(bloco) <= LIMITE, 'BLOCO_MAIOR_QUE_32KB ' + modo + ' ' + Buffer.byteLength(bloco));
  return bloco;
}
const nomeArquivo = modo => `BLOCO-SHELL-REPARO-BLOQUEIOS-PRODUCAO-20261020-${modo}.sh`;

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
module.exports = {DEPLOY, DESTINO, PASTA_BACKUP, SERVICO, EXECUTOR, REGISTROS, ARQUIVOS, SHA_FIXOS, COMANDOS, MODOS, LIMITE, carga, gerar, nomeArquivo};
