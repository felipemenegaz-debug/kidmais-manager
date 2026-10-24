/* eslint-disable @typescript-eslint/no-require-imports */
// Blocos de Shell da 098 (salão combinado, 23/10/2026), derivados dos da 097 no desenho revisado dos blocos 085/086
// (P2-A colagem interativa, P3-1 trap/código, P3-2 bind antes da guarda). Ordem: o CÓDIGO é publicado antes, já com o
// aplicador, o retrato e os SQL da 098 na árvore implantada — por isso o bloco NÃO transporta nem grava arquivos: confere
// o sha256 de cada arquivo implantado e roda o aplicador. Três blocos, na ordem de uso:
//   RETRATO  — somente leitura: identidade e retrato estrutural canônico (estado 094 esperado antes da 098);
//   CONFERIR — somente leitura: estado, privilégios, retrato e precheck (ou a integridade, se já aplicada);
//   APLICAR  — escrita (DDL), uma vez: retrato → precheck → 098 → postcheck → integridade → prova de preservação.
// O backup (export do banco + janela PITR no painel do Render) é feito por Felipe ANTES do APLICAR e entra como
// KIDMAIS_REGISTRO_BACKUP. O operador cola no Web Shell do serviço (bash INTERATIVO):
//   - `bind` desliga o bracketed paste ANTES da guarda e fora do subshell (vale pelo resto da sessão do operador);
//   - guarda RENDER_SERVICE_ID ANTES de qualquer leitura de arquivo (outro serviço: nada do corpo executado);
//   - corpo num SUBSHELL ( … ): set -euo pipefail, umask, cd e exit não alteram nem encerram o shell do operador;
//   - no fim, CODIGO_SAIDA_BLOCO=<n>: 0/1/2/3 do aplicador (esperado-PASS / recusa antes de iniciar a execucao / FALHA /
//     RECUSARIA ou retrato divergente); 4 = recusa do PRÓPRIO bloco, com mensagem nomeada (destino, ferramenta, arquivo,
//     backup). Qualquer outro código (127 linha perdida, 143 sinal) ou ausência da linha (Ctrl-C pode não imprimir a
//     linha) = parar e ler;
//   - APLICAR exige KIDMAIS_REGISTRO_BACKUP definida no shell ANTES de colar (referência do export/PITR anotado).
// O bloco gerado é ASCII puro e tem no máximo 32 KB. Este gerador só lê arquivos e escreve o bloco; não conecta.
//   node scripts/bloco-shell-098.cjs staging <RETRATO|CONFERIR|APLICAR> <rotulo-da-arvore>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {RETRATO, ETAPAS} = require('./migration-098-comum.cjs');

const DESTINO = '/opt/render/project/src';
const LIMITE = 32 * 1024;
const AMBIENTES = Object.freeze({
  staging: Object.freeze({servico: 'srv-daif418ae00c73e8k2gg', nome: 'kidmais-manager-staging', aplicador: 'scripts/migration-098-staging.cjs',
    dependencias: Object.freeze(['scripts/migration-098-comum.cjs', 'scripts/conexao-staging.cjs']), registro: 'data/saloes-combinados-098-staging', rotulo: 'STAGING'}),
});
const COMANDOS = Object.freeze({RETRATO: '--retrato-098', CONFERIR: '--conferir-098', APLICAR: '--aplicar-098-autorizado --backup "$KIDMAIS_REGISTRO_BACKUP"'});
const TITULOS = Object.freeze({
  RETRATO: ['SOMENTE LEITURA: confere o sha256 do aplicador, do nucleo, do retrato e dos 4 SQL da 098 IMPLANTADOS e roda',
    '--retrato-098 (identidade e retrato estrutural canonico em transacao READ ONLY). Esperado antes da 098: RETRATO_094. Nada e gravado.'],
  CONFERIR: ['SOMENTE LEITURA: confere o sha256 do aplicador, do nucleo, do retrato e dos 4 SQL da 098 IMPLANTADOS e roda --conferir-098',
    '(identidade, estado, privilegios CREATE/dono, retrato e precheck - ou a integridade, se ja aplicada - em transacao READ ONLY). Nada e gravado.'],
  APLICAR: ['ESCRITA (DDL) - somente com a autorizacao especifica da migration 098 neste ambiente. Antes de colar, no mesmo',
    'shell: export KIDMAIS_REGISTRO_BACKUP="<id e horario do export/PITR>". Roda --aplicar-098-autorizado UMA vez.',
    'Se algo parar, NAO repetir: copiar a saida e revisar (o marcador no disco persistente impede a repeticao).',
    'Qualquer codigo diferente de 0, inclusive 1: ler o registro listado no fim e rodar CONFERIR antes de decidir; nunca renomear o marcador so pelo codigo.'],
});
const sha = b => createHash('sha256').update(b).digest('hex');
const REVISADOS = Object.freeze([RETRATO, ...ETAPAS]);
/** Conteúdo LF da árvore; o retrato e os SQL precisam ter exatamente o hash revisado do aplicador. */
function ler(raiz, arquivo) {
  const b = Buffer.from(fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n'), 'utf8');
  const revisado = REVISADOS.find(([, a]) => a === arquivo)?.[2];
  if (revisado) assert.equal(sha(b), revisado, 'ARQUIVO_DIVERGENTE_DO_REVISADO ' + arquivo);
  return b;
}
const seguro = s => { assert.match(s, /^[A-Za-z0-9_./-]+$/, 'CAMINHO_INSEGURO'); return s; };
function arquivos(ambiente) { const a = AMBIENTES[ambiente]; return [a.aplicador, ...a.dependencias, ...REVISADOS.map(([, arquivo]) => arquivo)]; }

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
    `# BLOCO-SHELL-098-${a.rotulo}-${modo} - Web Shell do ${a.servico} (${a.nome}). Colar inteiro, uma vez, e Enter.`,
    ...TITULOS[modo].map(t => '# ' + t),
    `# Gerado da arvore ${rotulo} por scripts/bloco-shell-098.cjs. Conferir sha256 e bytes antes de colar.`,
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
    console.error(`BLOCO-SHELL-098-${AMBIENTES[ambiente].rotulo}-${modo} sha256 ${sha(Buffer.from(bloco, 'utf8'))} (${Buffer.byteLength(bloco, 'utf8')} bytes)`);
  } catch (e) { console.error('RECUSADO ' + String(e?.message ?? e).slice(0, 160)); process.exitCode = 1; }
}
module.exports = {DESTINO, LIMITE, AMBIENTES, COMANDOS, arquivos, gerar};
