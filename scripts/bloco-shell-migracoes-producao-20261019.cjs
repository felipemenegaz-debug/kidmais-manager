/* eslint-disable @typescript-eslint/no-require-imports */
// Blocos de Shell de PRODUÇÃO do pacote de migrations de 19/10/2026 (desenho dos blocos 085/086 de staging, revisados em
// 18/10: P2-A colagem interativa, P3-1 trap preserva o código, P3-2 bind antes da guarda). O deploy de produção não tem o
// aplicador, os manifestos nem a maior parte dos SQL; o operador (Felipe) cola no Web Shell do srv-dak77m2d0e5s73b8rkkg
// (bash INTERATIVO) um bloco gerado de uma árvore conferida, com sha256 e bytes conferidos antes de colar.
//   - Os arquivos vão para uma pasta PRÓPRIA dentro da árvore implantada (/opt/render/project/src/.kidmais-migracoes-
//     producao-20261019), nunca por cima de arquivos do deploy: nada do deploy é sobrescrito nem removido; `pg` vem do
//     node_modules implantado (dependência conferida por presença).
//   - `bind` desliga o bracketed paste ANTES da guarda e fora do subshell (vale pelo resto da sessão do operador);
//   - guarda RENDER_SERVICE_ID ANTES de qualquer leitura/gravação; corpo num SUBSHELL ( … ): set -euo pipefail, umask, cd,
//     trap e exit não alteram o shell do operador; no fim CODIGO_SAIDA_BLOCO=<n>;
//   - todos os arquivos conferidos (sha256) ANTES de gravar qualquer um; presente igual = JA_PRESENTE; presente diferente =
//     para (4) sem gravar nada;
//   - códigos: 0/1/2/3 do aplicador (CONFERIDO-PASS / recusa antes de conectar / FALHA / RECUSARIA); 4 = recusa ou falha
//     do PRÓPRIO bloco, com mensagem nomeada;
//   - APLICAR exige o registro do backup do P1 em KIDMAIS_REGISTRO_BACKUP (variável do shell do operador, definida ANTES
//     de colar; o bloco não muda) e o confere no formato antes de gravar qualquer arquivo; o aplicador confere o resto;
//   - LIMPEZA remove só os arquivos da pasta própria cujo sha confere (divergente preservado), depois as pastas vazias;
//     nunca o registro/marcadores no disco persistente (/opt/render/project/src/data).
// O bloco gerado é ASCII puro. Este gerador só lê arquivos e escreve o bloco na saída; não conecta nem executa nada.
//   node scripts/bloco-shell-migracoes-producao-20261019.cjs <CONFERIR|APLICAR|LIMPEZA> <rotulo-da-arvore>
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
/** Aplicador, manifestos, aplicador do lançamento (+ trava de alvo dele) e todos os SQL dos dois manifestos. */
function arquivos(raiz = path.resolve(__dirname, '..')) {
  const {manifesto, sequencia} = pacote.carregar(raiz);
  return [APLICADOR, pacote.MANIFESTO, manifesto.lancamento.aplicador, manifesto.lancamento.diagnostico, manifesto.lancamento.manifesto,
    ...sequencia.flatMap(e => e.arquivos.map(a => a.arquivo))];
}
const COMANDOS = Object.freeze({CONFERIR: '--conferir', APLICAR: '--aplicar-autorizado --backup "$KIDMAIS_REGISTRO_BACKUP"', LIMPEZA: null});
const TITULOS = Object.freeze({
  CONFERIR: ['SOMENTE LEITURA no banco: grava o aplicador, os manifestos e os SQL numa pasta propria (efemera) da arvore implantada,',
    'confere os sha256 e roda --conferir (identidade, interruptores, privilegios, estado de cada migration, checks READ ONLY).'],
  APLICAR: ['ESCRITA (DDL) EM PRODUCAO - somente com a autorizacao especifica de Felipe para estas migrations. ANTES de colar, no mesmo',
    'shell: export KIDMAIS_REGISTRO_BACKUP=<registro .json do backup do P1, com menos de 24 h>. Roda --aplicar-autorizado UMA vez',
    '(074a-078 pelo aplicador do lancamento; 060, 065, 080-083, 085, 086 por este pacote). Se parar, NAO repetir: copiar a saida.'],
  LIMPEZA: ['Remove da pasta propria so os arquivos gravados pelo CONFERIR/APLICAR cujo sha256 confere, e as pastas vazias; nunca',
    'arquivos do deploy nem registros/marcadores do disco persistente. Nao conecta ao banco.'],
});
const sha = b => createHash('sha256').update(b).digest('hex');
/** Conteúdo LF; scripts e SQL precisam ter exatamente o hash revisado dos manifestos (carregar confere os SQL). */
function ler(raiz, arquivo) {
  const texto = fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n');
  assert.ok(!texto.includes('\r'), 'CR_ISOLADO ' + arquivo);
  return Buffer.from(texto, 'utf8');
}
const seguro = s => { assert.match(s, /^[A-Za-z0-9_./-]+$/, 'CAMINHO_INSEGURO'); return s; };

/**
 * `destino`, `deploy`, `pastaBackup` e `comando` existem para os testes locais (pastas temporárias; comando substituto
 * que só devolve um código). A CLI usa sempre as pastas de produção e o comando do aplicador do modo.
 */
function gerar({modo, rotulo, raiz = path.resolve(__dirname, '..'), destino = DESTINO, deploy = DEPLOY, comando, pastaBackup = PASTA_BACKUP}) {
  assert.ok(Object.hasOwn(COMANDOS, modo), 'MODO_DESCONHECIDO');
  assert.match(String(rotulo), /^[0-9a-f]{7,40}$/, 'ROTULO_INVALIDO');
  for (const d of [destino, deploy, pastaBackup]) assert.match(d, /^(?:[A-Za-z]:)?\/[A-Za-z0-9_./-]+$/, 'DESTINO_INVALIDO');
  const lista = arquivos(raiz);
  const cmd = comando === undefined ? (COMANDOS[modo] && `NODE_PATH='${deploy}/node_modules' node ${APLICADOR} ${COMANDOS[modo]}`) : comando;
  const c = ['set -euo pipefail', 'umask 077'];
  if (modo === 'APLICAR') {
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
    'for f in sha256sum base64 gzip mktemp node; do command -v "$f" >/dev/null || { echo "FERRAMENTA_AUSENTE $f"; exit 4; }; done',
    '[ -f node_modules/pg/package.json ] || { echo "DEPENDENCIA_AUSENTE node_modules/pg"; exit 4; }',
    `mkdir -p '${destino}' && cd '${destino}' || { echo "DESTINO_INACESSIVEL"; exit 4; }`,
    'h() { sha256sum "$1" | cut -d" " -f1; }');
  if (modo === 'LIMPEZA') {
    c.push('limpar() { if [ ! -e "$1" ]; then echo "AUSENTE $1"; elif [ "$(h "$1")" = "$2" ]; then rm -f -- "$1" || { echo "REMOCAO_FALHOU $1"; exit 4; }; echo "REMOVIDO $1"; else echo "DIVERGENTE_PRESERVADO $1"; fi; }');
    for (const a of lista) c.push(`limpar ${seguro(a)} ${sha(ler(raiz, a))}`);
    // Pastas vazias da própria pasta (nunca fora dela); a pasta própria some se ficar vazia.
    c.push('find . -mindepth 1 -depth -type d -empty -delete 2>/dev/null || true', `cd '${deploy}'`,
      `rmdir '${destino}' 2>/dev/null && echo "PASTA_REMOVIDA" || echo "PASTA_MANTIDA (arquivos divergentes preservados)"`, 'echo LIMPEZA_FIM');
  } else {
    c.push('T="$(mktemp -d)" || { echo "TEMPORARIO_FALHOU"; exit 4; }', "trap 'rm -rf -- \"$T\" || echo \"TEMPORARIO_NAO_REMOVIDO $T\"' EXIT",
      'prep() { { base64 -d | gzip -dc > "$T/$1"; } 2>/dev/null || { echo "CONTEUDO_DIVERGENTE $2"; exit 4; }; [ "$(h "$T/$1")" = "$3" ] || { echo "CONTEUDO_DIVERGENTE $2"; exit 4; }; }',
      'livre() { [ ! -e "$1" ] || [ "$(h "$1")" = "$2" ] || { echo "JA_EXISTE_DIFERENTE $1"; exit 4; }; }',
      'inst() { if [ -e "$2" ]; then echo "JA_PRESENTE $2"; else { mkdir -p "$(dirname "$2")" && cp "$T/$1" "$2"; } || { echo "GRAVACAO_FALHOU $2"; exit 4; }; echo "ESCRITO $2"; fi; }');
    lista.forEach((a, i) => {
      const b = ler(raiz, a);
      c.push(`prep ${i} ${seguro(a)} ${sha(b)} <<'B64'`, ...zlib.gzipSync(b, {level: 9}).toString('base64').match(/.{1,76}/g), 'B64');
    });
    // Fase 2 só depois de TODOS conferidos: nenhuma escrita parcial por conteúdo divergente ou colisão.
    lista.forEach(a => c.push(`livre ${seguro(a)} ${sha(ler(raiz, a))}`));
    lista.forEach((a, i) => c.push(`inst ${i} ${seguro(a)}`));
    c.push(`echo "ARQUIVOS_OK ${lista.length}"`);
    if (cmd) c.push('codigo=0', `${cmd} || codigo=$?`, `echo '=== REGISTROS (${REGISTROS.join(' e ')}) ==='`,
      ...REGISTROS.map(r => `ls -1 '${deploy}/${r}' 2>/dev/null | grep -v '\\.dump$' || echo "SEM_REGISTRO ${r}"`), 'exit "$codigo"');
  }
  const linhas = ['#!/usr/bin/env bash',
    `# BLOCO-SHELL-MIGRACOES-PRODUCAO-20261019-${modo} - Web Shell do ${SERVICO} (kidmais-manager-production). Colar inteiro, uma vez, e Enter.`,
    ...TITULOS[modo].map(t => '# ' + t),
    `# Gerado da arvore ${rotulo} por scripts/bloco-shell-migracoes-producao-20261019.cjs. Conferir sha256 e bytes antes de colar.`,
    '# O bind abaixo roda ANTES da guarda e FORA do subshell, mesmo em outro servico: desliga o bracketed paste do readline',
    '# pelo resto desta sessao. Nao muda esta colagem (ja recebida); nas seguintes, texto multilinha roda linha a linha.',
    '# A guarda de RENDER_SERVICE_ID vem antes de qualquer leitura/gravacao de arquivo. Corpo em subshell: opcoes, trap,',
    '# umask, cwd e variaveis do corpo nao vazam (o bind e a excecao). No fim sai CODIGO_SAIDA_BLOCO=<n> (0/1/2/3',
    '# aplicador, 4 bloco); TEMPORARIO_NAO_REMOVIDO <caminho> e so aviso: o codigo continua o principal.',
    "bind 'set enable-bracketed-paste off' 2>/dev/null",
    `if [ "$RENDER_SERVICE_ID" != "${SERVICO}" ]; then echo "SHELL_ERRADO_NAO_E_PRODUCAO ($RENDER_SERVICE_ID): nada executado"; else`,
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
    console.error(`BLOCO-SHELL-MIGRACOES-PRODUCAO-20261019-${modo} sha256 ${sha(Buffer.from(bloco, 'utf8'))} (${Buffer.byteLength(bloco, 'utf8')} bytes)`);
  } catch (e) { console.error('RECUSADO ' + String(e?.message ?? e).slice(0, 160)); process.exitCode = 1; }
}
module.exports = {DEPLOY, DESTINO, PASTA_BACKUP, SERVICO, APLICADOR, REGISTROS, COMANDOS, arquivos, gerar};
