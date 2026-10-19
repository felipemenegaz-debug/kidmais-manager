/* eslint-disable @typescript-eslint/no-require-imports */
// Blocos de Shell de PRODUÇÃO do pacote de migrations de 19/10/2026 (desenho dos blocos 085/086 de staging, revisados em
// 18/10: P2-A colagem interativa, P3-1 trap preserva o código, P3-2 bind antes da guarda). O deploy de produção não tem o
// aplicador, os manifestos nem a maior parte dos SQL; o operador (Felipe) cola no Web Shell do srv-dak77m2d0e5s73b8rkkg
// (bash INTERATIVO) blocos gerados de uma árvore conferida, com sha256 e bytes conferidos antes de colar.
//
// Revisão independente de 19/10 (P3-3): a maior colagem comprovada no Web Shell do Render foi 35,9 KB. Por isso:
//   - PARTE-k-DE-N (cada uma ≤ 40 000 bytes): só TRANSPORTA uma fração dos 43 arquivos para a área de partes
//     /opt/render/project/src/.kidmais-migracoes-producao-20261019/.partes/<sha256>, com sha conferido; repetir uma parte
//     é seguro (JA_PRESENTE); conteúdo divergente para (4) sem gravar nada daquela parte;
//   - CONFERIR / APLICAR (curtos): exigem as 43 partes presentes e íntegras (senão dizem qual PARTE colar), só então
//     montam a árvore própria (/opt/render/project/src/.kidmais-migracoes-producao-20261019/<caminho>; presente igual =
//     JA_PRESENTE, diferente = para) e rodam o aplicador; APLICAR exige KIDMAIS_REGISTRO_BACKUP (definida ANTES de colar);
//   - LIMPEZA: remove só arquivos e partes cujo sha confere (divergente preservado) e as pastas vazias; nunca arquivos do
//     deploy nem o disco persistente (/opt/render/project/src/data).
// Comum a todos: `bind` desliga o bracketed paste ANTES da guarda e fora do subshell; guarda RENDER_SERVICE_ID antes de
// qualquer leitura/gravação; corpo num SUBSHELL ( … ); no fim CODIGO_SAIDA_BLOCO=<n>: 0/1/2/3 do aplicador, 4 do bloco.
// Qualquer outro código (127 = linha perdida na colagem, 130 = Ctrl-C, 143 = sinal) ou ausência de CODIGO_SAIDA_BLOCO =
// parar e ler; prompt `>` depois de colar = colagem incompleta: Ctrl-C (nunca colar por cima do `>`) e colar o MESMO bloco.
// O bloco gerado é ASCII puro. Este gerador só lê arquivos e escreve; não conecta nem executa nada.
//   node scripts/bloco-shell-migracoes-producao-20261019.cjs <PARTE-k|CONFERIR|APLICAR|RETOMAR|LIMPEZA> <rotulo-da-arvore>
//   node scripts/bloco-shell-migracoes-producao-20261019.cjs TODOS <rotulo-da-arvore> <pasta-de-saida>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const {createHash} = require('node:crypto');
const pacote = require('./migrations-producao-20261019.cjs');

const DEPLOY = '/opt/render/project/src';
const DESTINO = DEPLOY + '/.kidmais-migracoes-producao-20261019';
const SERVICO = 'srv-dak77m2d0e5s73b8rkkg';
const APLICADOR = 'scripts/migrations-producao-20261019.cjs';
const PASTA_BACKUP = DEPLOY + '/data/lancamento-venda-20261011';
const REGISTROS = ['data/migracoes-producao-20261019', 'data/lancamento-venda-20261011'];
const LIMITE_PARTE = 40000;
/** Carga útil (base64) por parte: o resto do limite fica para cabeçalho, guarda e funções. */
const CARGA_PARTE = 30000;
/** Linhas fixas por arquivo numa parte (prep, livre, inst, delimitadores). */
const SOBRA_POR_ARQUIVO = 320;
/** Aplicador, manifestos, aplicador do lançamento (+ trava de alvo dele) e todos os SQL dos dois manifestos. */
function arquivos(raiz = path.resolve(__dirname, '..')) {
  const {manifesto, sequencia} = pacote.carregar(raiz);
  return [APLICADOR, pacote.MANIFESTO, manifesto.lancamento.aplicador, manifesto.lancamento.diagnostico, manifesto.lancamento.manifesto,
    ...sequencia.flatMap(e => e.arquivos.map(a => a.arquivo))];
}
const COMANDOS = Object.freeze({CONFERIR: '--conferir', APLICAR: '--aplicar-autorizado --backup "$KIDMAIS_REGISTRO_BACKUP"',
  RETOMAR: '--retomar-autorizado "$KIDMAIS_RETOMAR_ID" --backup "$KIDMAIS_REGISTRO_BACKUP"', LIMPEZA: null});
/** Migrations que o aplicador aceita retomar (nunca 079/084). */
const RETOMAVEIS = Object.freeze(['074a', '075', '076', '077', '078', '060', '065', '080', '081', '082', '083', '085', '086']);
const sha = b => createHash('sha256').update(b).digest('hex');
/** Conteúdo LF; scripts e SQL precisam ter exatamente o hash revisado dos manifestos (carregar confere os SQL). */
function ler(raiz, arquivo) {
  const texto = fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(!texto.includes('\r'), 'CR_ISOLADO ' + arquivo);
  return Buffer.from(texto, 'utf8');
}
const seguro = s => { assert.match(s, /^[A-Za-z0-9_./-]+$/, 'CAMINHO_INSEGURO'); return s; };
/** Arquivos com conteúdo, sha e carga gzip+base64 (determinística), agrupados em partes pela ordem da lista. */
function distribuir(raiz = path.resolve(__dirname, '..')) {
  const lista = arquivos(raiz).map(a => { const b = ler(raiz, a); return {arquivo: seguro(a), sha: sha(b), b64: zlib.gzipSync(b, {level: 9}).toString('base64').match(/.{1,76}/g)}; });
  const partes = [];
  for (const x of lista) {
    const tam = x.b64.join('\n').length + SOBRA_POR_ARQUIVO;
    assert.ok(tam < CARGA_PARTE, 'ARQUIVO_MAIOR_QUE_A_PARTE ' + x.arquivo);
    if (!partes.length || partes.at(-1).carga + tam > CARGA_PARTE) partes.push({carga: 0, itens: []});
    partes.at(-1).itens.push(x); partes.at(-1).carga += tam;
  }
  lista.forEach(x => { x.parte = partes.findIndex(p => p.itens.includes(x)) + 1; });
  return {lista, partes};
}
const modos = (raiz = path.resolve(__dirname, '..')) => [...distribuir(raiz).partes.map((_, i) => `PARTE-${i + 1}`), 'CONFERIR', 'APLICAR', 'RETOMAR', 'LIMPEZA'];
const totalPartes = (raiz = path.resolve(__dirname, '..')) => distribuir(raiz).partes.length;

function cabecalho(modo, n, rotulo) {
  const nome = /^PARTE-\d+$/.test(modo) ? `${modo}-DE-${n}` : modo;
  const titulo = {
    CONFERIR: ['SOMENTE LEITURA no banco. Exige as PARTES 1..' + n + ' coladas antes (nesta mesma instancia). Monta a pasta propria (efemera)',
      'e roda --conferir (identidade, interruptores, privilegios, estado, prechecks de todas as ausentes, antecipacoes, md5 do schema).'],
    APLICAR: ['ESCRITA (DDL) EM PRODUCAO - somente com a autorizacao especifica de Felipe e o gate de prontidao do deploy VERDE.',
      'ANTES de colar, no mesmo shell: export KIDMAIS_REGISTRO_BACKUP=<registro .json do backup do P1, com menos de 24 h>.',
      'Exige as PARTES 1..' + n + '. Roda --aplicar-autorizado UMA vez. Se parar, NAO repetir: copiar a saida e seguir o roteiro.'],
    RETOMAR: ['ESCRITA (DDL) EM PRODUCAO - RETOMADA de UMA migration que parou, somente com decisao explicita de Felipe apos leitura',
      '(roteiro de recuperacao). ANTES de colar: export KIDMAIS_REGISTRO_BACKUP=<registro do P1> e export KIDMAIS_RETOMAR_ID=<id>.',
      'Exige as PARTES 1..' + n + '. O aplicador so retoma com o schema daquela migration AUSENTE e segue a sequencia ate o fim.'],
    LIMPEZA: ['Remove da pasta propria so arquivos e partes cujo sha256 confere, e as pastas vazias; nunca arquivos do deploy nem',
      'registros/marcadores do disco persistente. Nao conecta ao banco. Opcional: a pasta propria some no proximo deploy.'],
  }[modo] ?? [`TRANSPORTE ${modo}-DE-${n}: grava parte dos arquivos do pacote em .partes/ (sha256 conferido). Nao conecta ao banco.`,
    'Repetir e seguro (JA_PRESENTE). Depois de todas as partes: CONFERIR (ou APLICAR, com autorizacao).'];
  return ['#!/usr/bin/env bash',
    `# BLOCO-SHELL-MIGRACOES-PRODUCAO-20261019-${nome} - Web Shell do ${SERVICO} (kidmais-manager-production). Colar inteiro, uma vez, e Enter.`,
    ...titulo.map(t => '# ' + t),
    `# Gerado da arvore ${rotulo} por scripts/bloco-shell-migracoes-producao-20261019.cjs. Conferir sha256 e bytes antes de colar.`,
    '# Se aparecer o prompt ">" depois de colar (colagem incompleta): Ctrl-C, nunca colar por cima; depois colar o MESMO bloco.',
    '# Fim esperado: CODIGO_SAIDA_BLOCO=<n> (0/1/2/3 aplicador, 4 bloco). Outro codigo (127, 130, 143...) ou sem essa linha = parar e ler.',
    '# O bind abaixo roda ANTES da guarda e FORA do subshell: desliga o bracketed paste pelo resto desta sessao. A guarda de',
    '# RENDER_SERVICE_ID vem antes de qualquer leitura/gravacao. Corpo em subshell: opcoes, trap, umask e cwd nao vazam.',
    "bind 'set enable-bracketed-paste off' 2>/dev/null",
    `if [ "$RENDER_SERVICE_ID" != "${SERVICO}" ]; then echo "SHELL_ERRADO_NAO_E_PRODUCAO ($RENDER_SERVICE_ID): nada executado"; else`];
}

/**
 * `destino`, `deploy`, `pastaBackup` e `comando` existem para os testes locais (pastas temporárias; comando substituto
 * que só devolve um código). A CLI usa sempre as pastas de produção e o comando do aplicador do modo.
 */
function gerar({modo, rotulo, raiz = path.resolve(__dirname, '..'), destino = DESTINO, deploy = DEPLOY, comando, pastaBackup = PASTA_BACKUP}) {
  const {lista, partes} = distribuir(raiz);
  const n = partes.length;
  const parte = /^PARTE-(\d+)$/.exec(String(modo));
  assert.ok(Object.hasOwn(COMANDOS, modo) || (parte && Number(parte[1]) >= 1 && Number(parte[1]) <= n), 'MODO_DESCONHECIDO');
  assert.match(String(rotulo), /^[0-9a-f]{7,40}$/, 'ROTULO_INVALIDO');
  for (const d of [destino, deploy, pastaBackup]) assert.match(d, /^(?:[A-Za-z]:)?\/[A-Za-z0-9_./-]+$/, 'DESTINO_INVALIDO');
  const c = ['set -euo pipefail', 'umask 077'];
  if (modo === 'RETOMAR') {
    c.push('case "${KIDMAIS_RETOMAR_ID:-}" in', '  ' + RETOMAVEIS.join('|') + ') ;;',
      '  *) echo "RETOMAR_ID_INVALIDO: export KIDMAIS_RETOMAR_ID=<' + RETOMAVEIS.join('|') + '> antes de colar"; exit 4 ;;', 'esac');
  }
  if (modo === 'APLICAR' || modo === 'RETOMAR') {
    // Antes de qualquer arquivo: registro do backup presente, na pasta do P1, nome simples (o aplicador confere idade,
    // hash do dump, PITR e pacote).
    c.push('case "${KIDMAIS_REGISTRO_BACKUP:-}" in',
      '  ' + pastaBackup + '/backup-*.json) ;;',
      '  "") echo "REGISTRO_BACKUP_AUSENTE: export KIDMAIS_REGISTRO_BACKUP=<registro do P1> antes de colar"; exit 4 ;;',
      '  *) echo "REGISTRO_BACKUP_INVALIDO"; exit 4 ;;', 'esac',
      'case "${KIDMAIS_REGISTRO_BACKUP#' + pastaBackup + '/}" in *[!A-Za-z0-9._-]*) echo "REGISTRO_BACKUP_INVALIDO"; exit 4 ;; esac',
      '[ -f "$KIDMAIS_REGISTRO_BACKUP" ] || { echo "REGISTRO_BACKUP_NAO_ENCONTRADO"; exit 4; }');
  }
  c.push(`cd '${deploy}' || { echo "DEPLOY_INACESSIVEL"; exit 4; }`,
    'for f in sha256sum base64 gzip mktemp node; do command -v "$f" >/dev/null || { echo "FERRAMENTA_AUSENTE $f"; exit 4; }; done');
  if (!parte) c.push('[ -f node_modules/pg/package.json ] || { echo "DEPENDENCIA_AUSENTE node_modules/pg"; exit 4; }');
  c.push(`mkdir -p '${destino}/.partes' && cd '${destino}' || { echo "DESTINO_INACESSIVEL"; exit 4; }`, 'h() { sha256sum "$1" | cut -d" " -f1; }');
  if (parte) {
    const k = Number(parte[1]), itens = partes[k - 1].itens;
    c.push('T="$(mktemp -d)" || { echo "TEMPORARIO_FALHOU"; exit 4; }', "trap 'rm -rf -- \"$T\" || echo \"TEMPORARIO_NAO_REMOVIDO $T\"' EXIT",
      'prep() { { base64 -d | gzip -dc > "$T/$1"; } 2>/dev/null || { echo "CONTEUDO_DIVERGENTE $2"; exit 4; }; [ "$(h "$T/$1")" = "$1" ] || { echo "CONTEUDO_DIVERGENTE $2"; exit 4; }; }',
      'livre() { [ ! -e ".partes/$1" ] || [ "$(h ".partes/$1")" = "$1" ] || { echo "PARTE_EXISTE_DIFERENTE $1"; exit 4; }; }',
      'inst() { if [ -e ".partes/$1" ]; then echo "JA_PRESENTE $2"; else cp "$T/$1" ".partes/$1" || { echo "GRAVACAO_FALHOU $2"; exit 4; }; echo "TRANSPORTADO $2"; fi; }');
    for (const x of itens) c.push(`prep ${x.sha} ${x.arquivo} <<'B64'`, ...x.b64, 'B64');
    // Fase 2 só depois de TODOS os itens da parte conferidos.
    for (const x of itens) c.push(`livre ${x.sha}`);
    for (const x of itens) c.push(`inst ${x.sha} ${x.arquivo}`);
    c.push(`echo "PARTE_${k}_DE_${n}_OK ${itens.length} arquivos"`);
  } else if (modo === 'LIMPEZA') {
    c.push('limpar() { if [ ! -e "$1" ]; then echo "AUSENTE $1"; elif [ "$(h "$1")" = "$2" ]; then rm -f -- "$1" || { echo "REMOCAO_FALHOU $1"; exit 4; }; echo "REMOVIDO $1"; else echo "DIVERGENTE_PRESERVADO $1"; fi; }');
    for (const x of lista) c.push(`limpar ${x.arquivo} ${x.sha}`);
    for (const x of lista) c.push(`limpar .partes/${x.sha} ${x.sha}`);
    c.push('find . -mindepth 1 -depth -type d -empty -delete 2>/dev/null || true', `cd '${deploy}'`,
      `rmdir '${destino}' 2>/dev/null && echo "PASTA_REMOVIDA" || echo "PASTA_MANTIDA (arquivos divergentes preservados)"`, 'echo LIMPEZA_FIM');
  } else {
    const cmd = comando === undefined ? `NODE_PATH='${deploy}/node_modules' node ${APLICADOR} ${COMANDOS[modo]}` : comando;
    // Montagem só com TODAS as partes presentes e íntegras; senão diz qual parte colar e não grava nada.
    c.push('falta=0', 'tem() { [ -f ".partes/$1" ] && [ "$(h ".partes/$1")" = "$1" ] || { echo "PARTE_AUSENTE_OU_DIVERGENTE $2 (colar a PARTE-$3)"; falta=1; }; }');
    for (const x of lista) c.push(`tem ${x.sha} ${x.arquivo} ${x.parte}`);
    c.push(`[ "$falta" = 0 ] || { echo "MONTAGEM_RECUSADA: colar as partes indicadas (1..${n}) e repetir este bloco"; exit 4; }`,
      'livre() { [ ! -e "$1" ] || [ "$(h "$1")" = "$2" ] || { echo "JA_EXISTE_DIFERENTE $1"; exit 4; }; }',
      'inst() { if [ -e "$1" ]; then echo "JA_PRESENTE $1"; else { mkdir -p "$(dirname "$1")" && cp ".partes/$2" "$1"; } || { echo "GRAVACAO_FALHOU $1"; exit 4; }; echo "ESCRITO $1"; fi; }');
    for (const x of lista) c.push(`livre ${x.arquivo} ${x.sha}`);
    for (const x of lista) c.push(`inst ${x.arquivo} ${x.sha}`);
    c.push(`echo "ARQUIVOS_OK ${lista.length}"`);
    if (cmd) c.push('codigo=0', `${cmd} || codigo=$?`, `echo '=== REGISTROS (${REGISTROS.join(' e ')}) ==='`,
      ...REGISTROS.map(r => `ls -1 '${deploy}/${r}' 2>/dev/null | grep -v '\\.dump$' || echo "SEM_REGISTRO ${r}"`), 'exit "$codigo"');
  }
  const bloco = [...cabecalho(modo, n, rotulo), '(', ...c, ')', 'echo "CODIGO_SAIDA_BLOCO=$?"', 'fi'].join('\n') + '\n';
  assert.match(bloco, /^[\x09\x0a\x20-\x7e]*$/, 'BLOCO_NAO_ASCII');
  assert.ok(Buffer.byteLength(bloco) <= LIMITE_PARTE, 'BLOCO_MAIOR_QUE_40KB ' + modo);
  return bloco;
}
const nomeArquivo = (modo, n) => `BLOCO-SHELL-MIGRACOES-PRODUCAO-20261019-${/^PARTE-\d+$/.test(modo) ? `${modo}-DE-${n}` : modo}.sh`;

if (require.main === module) {
  try {
    const [modo, rotulo, saida] = process.argv.slice(2);
    if (modo === 'TODOS') {
      assert.ok(saida && !fs.existsSync(saida), 'PASTA_DE_SAIDA_INVALIDA_OU_EXISTENTE');
      fs.mkdirSync(saida, {recursive: true});
      const lista = modos(), n = totalPartes();
      for (const m of lista) {
        const bloco = gerar({modo: m, rotulo});
        fs.writeFileSync(path.join(saida, nomeArquivo(m, n)), bloco, {flag: 'wx'});
        console.log(`${sha(Buffer.from(bloco, 'utf8'))}  ${Buffer.byteLength(bloco, 'utf8')}  ${nomeArquivo(m, n)}`);
      }
    } else {
      const bloco = gerar({modo, rotulo});
      process.stdout.write(bloco);
      console.error(`${nomeArquivo(modo, totalPartes())} sha256 ${sha(Buffer.from(bloco, 'utf8'))} (${Buffer.byteLength(bloco, 'utf8')} bytes)`);
    }
  } catch (e) { console.error('RECUSADO ' + String(e?.message ?? e).slice(0, 160)); process.exitCode = 1; }
}
module.exports = {DEPLOY, DESTINO, PASTA_BACKUP, SERVICO, APLICADOR, REGISTROS, COMANDOS, RETOMAVEIS, LIMITE_PARTE, arquivos, totalPartes, distribuir, modos, gerar, nomeArquivo};
