/* eslint-disable @typescript-eslint/no-require-imports */
// Blocos de Shell da 099 (convites avulsos) em PRODUÇÃO, no desenho revisado dos blocos 088/089/097 (P2-A colagem
// interativa, P3-1 trap/código, P3-2 bind antes da guarda). O bloco NÃO transporta nem grava arquivos: confere o sha256
// de cada arquivo presente no destino e roda o aplicador. A 099 vem ANTES do código de Convites avulsos (E3 do plano de
// promoção): os arquivos precisam estar no destino pelo mecanismo revisado de entrega antes do código (B-4); sem eles o
// bloco recusa com código 4. O operador cola no Web Shell do serviço (bash INTERATIVO):
//   - `bind` desliga o bracketed paste ANTES da guarda e fora do subshell (vale pelo resto da sessão do operador);
//   - guarda RENDER_SERVICE_ID ANTES de qualquer leitura de arquivo (outro serviço: nada do corpo executado);
//   - corpo num SUBSHELL ( … ): set -euo pipefail, umask, cd e exit não alteram nem encerram o shell do operador;
//   - no fim, CODIGO_SAIDA_BLOCO=<n>: 0/1/2/3 do aplicador (CONFERIDO-PASS / recusa antes de conectar / FALHA /
//     RECUSARIA); 4 = recusa do PRÓPRIO bloco, com mensagem nomeada (destino, ferramenta, arquivo, backup). Qualquer
//     outro código (127 linha perdida, 143 sinal) ou ausência da linha = parar e ler;
//   - APLICAR exige KIDMAIS_REGISTRO_BACKUP definida no shell ANTES de colar (referência do dump/PITR anotado).
// O bloco gerado é ASCII puro e tem no máximo 32 KB. Este gerador só lê arquivos e escreve o bloco; não conecta.
//   node scripts/bloco-shell-099.cjs production <CONFERIR|APLICAR> <rotulo-da-arvore>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {ETAPAS} = require('./migration-099-comum.cjs');

const DESTINO = '/opt/render/project/src';
const LIMITE = 32 * 1024;
const AMBIENTES = Object.freeze({
  production: Object.freeze({servico: 'srv-dak77m2d0e5s73b8rkkg', nome: 'kidmais-manager-production', aplicador: 'scripts/migration-099-production.cjs',
    dependencias: Object.freeze(['scripts/migration-099-comum.cjs']), registro: 'data/convites-avulsos-099-producao', rotulo: 'PRODUCAO'}),
});
const COMANDOS = Object.freeze({CONFERIR: '--conferir-099', APLICAR: '--aplicar-099-autorizado --backup "$KIDMAIS_REGISTRO_BACKUP"'});
const TITULOS = Object.freeze({
  CONFERIR: ['SOMENTE LEITURA: confere o sha256 do aplicador, do nucleo e dos 4 SQL da 099 e roda --conferir-099 (identidade, estado,',
    'dono das tabelas/funcoes, precheck + vinculo/versao ou postcheck em transacao READ ONLY). Nada e gravado.'],
  APLICAR: ['ESCRITA (DDL) - E3: somente com a autorizacao especifica da migration 099 em PRODUCAO, ANTES do deploy do codigo.',
    'Antes de colar, no mesmo shell: export KIDMAIS_REGISTRO_BACKUP="<dump conferido e PITR>". Roda --aplicar-099-autorizado UMA vez',
    '(transacao unica sob trava exclusiva de convites). Se algo parar, NAO repetir: copiar a saida, rodar o CONFERIR e seguir o ENC.'],
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
function arquivos(ambiente) { const a = AMBIENTES[ambiente]; return [a.aplicador, ...a.dependencias, ...ETAPAS.map(([, arquivo]) => arquivo)]; }

/**
 * `destino` e `comando` existem para os testes locais (destino temporário; comando substituto que só devolve um código).
 * A CLI usa sempre o destino do Render e o comando do aplicador do modo.
 */
function gerar({ambiente, modo, rotulo, raiz = path.resolve(__dirname, '..'), destino = DESTINO, comando}) {
  assert.ok(Object.hasOwn(AMBIENTES, ambiente), 'AMBIENTE_DESCONHECIDO');
  assert.ok(Object.hasOwn(COMANDOS, modo), 'MODO_DESCONHECIDO');
  assert.match(String(rotulo), /^[0-9a-f]{7,40}$/, 'ROTULO_INVALIDO');
  assert.match(destino, /^(?:[A-Za-z]:)?\/[A-Za-z0-9_./-]+$/, 'DESTINO_INVALIDO');
  const a = AMBIENTES[ambiente];
  const cmd = comando === undefined ? `NODE_PATH="$PWD/node_modules" node ${a.aplicador} ${COMANDOS[modo]}` : comando;
  const c = ['set -euo pipefail', 'umask 077', `cd '${destino}' || { echo "DESTINO_INACESSIVEL"; exit 4; }`,
    'for f in sha256sum cut node; do command -v "$f" >/dev/null || { echo "FERRAMENTA_AUSENTE $f"; exit 4; }; done',
    'h() { sha256sum "$1" | cut -d" " -f1; }',
    'arq() { [ -f "$1" ] && [ "$(h "$1")" = "$2" ] || { echo "ARQUIVO_DIVERGENTE_OU_AUSENTE $1"; exit 4; }; }'];
  for (const arquivo of arquivos(ambiente)) c.push(`arq ${seguro(arquivo)} ${sha(ler(raiz, arquivo))}`);
  c.push('echo ARQUIVOS_CONFERIDOS');
  if (modo === 'APLICAR') c.push('B="${KIDMAIS_REGISTRO_BACKUP:-}"',
    'printf "%s" "$B" | grep -Eq "^[A-Za-z0-9:._/ -]{6,120}$" || { echo "BACKUP_NAO_INFORMADO defina KIDMAIS_REGISTRO_BACKUP antes de colar"; exit 4; }');
  c.push('codigo=0', `${cmd} || codigo=$?`, `echo '=== REGISTRO (${a.registro}) ==='`, `ls -1 ${a.registro} 2>/dev/null || echo SEM_REGISTRO`, 'exit "$codigo"');
  const linhas = ['#!/usr/bin/env bash',
    `# BLOCO-SHELL-099-${a.rotulo}-${modo} - Web Shell do ${a.servico} (${a.nome}). Colar inteiro, uma vez, e Enter.`,
    ...TITULOS[modo].map(t => '# ' + t),
    `# Gerado da arvore ${rotulo} por scripts/bloco-shell-099.cjs. Conferir sha256 e bytes antes de colar.`,
    '# O bind abaixo roda ANTES da guarda e FORA do subshell, mesmo em outro servico: desliga o bracketed paste do readline',
    '# pelo resto desta sessao. A guarda de RENDER_SERVICE_ID vem antes de qualquer leitura de arquivo. Corpo em subshell:',
    '# opcoes, umask, cwd e variaveis nao vazam. No fim sai CODIGO_SAIDA_BLOCO=<n> (0/1/2/3 aplicador, 4 bloco); outro codigo',
    '# ou ausencia da linha = parar e ler. Prompt `>` depois de colar = colagem incompleta: Ctrl-C e colar o MESMO bloco.',
    "bind 'set enable-bracketed-paste off' 2>/dev/null",
    `if [ "$RENDER_SERVICE_ID" != "${a.servico}" ]; then echo "SHELL_ERRADO_NAO_E_${a.rotulo} ($RENDER_SERVICE_ID): nada executado"; else`,
    '(', ...c, ')', 'echo "CODIGO_SAIDA_BLOCO=$?"', 'fi'];
  const bloco = linhas.join('\n') + '\n';
  assert.match(bloco, /^[\x09\x0a\x20-\x7e]*$/, 'BLOCO_NAO_ASCII');
  assert.ok(Buffer.byteLength(bloco, 'utf8') <= LIMITE, 'BLOCO_GRANDE_DEMAIS');
  return bloco;
}

if (require.main === module) {
  try {
    const [ambiente, modo, rotulo] = process.argv.slice(2);
    const bloco = gerar({ambiente, modo, rotulo});
    process.stdout.write(bloco);
    console.error(`BLOCO-SHELL-099-${AMBIENTES[ambiente].rotulo}-${modo} sha256 ${sha(Buffer.from(bloco, 'utf8'))} (${Buffer.byteLength(bloco, 'utf8')} bytes)`);
  } catch (e) { console.error('RECUSADO ' + String(e?.message ?? e).slice(0, 160)); process.exitCode = 1; }
}
module.exports = {DESTINO, LIMITE, AMBIENTES, COMANDOS, arquivos, gerar};
