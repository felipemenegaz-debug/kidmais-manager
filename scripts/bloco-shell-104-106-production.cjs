/* eslint-disable @typescript-eslint/no-require-imports */
// Blocos de Shell da 104/106 (hash da revisão com o salão e salão de preferência) em PRODUÇÃO, no mesmo desenho dos blocos de
// staging (scripts/bloco-shell-104-106.cjs) e do bloco de produção da 100 (scripts/bloco-shell-100.cjs): P2-A colagem
// interativa, P3-1 trap/código, P3-2 bind antes da guarda. O CÓDIGO é publicado antes, já com o aplicador e os SQL na
// árvore implantada — por isso o bloco NÃO transporta nem grava arquivos: confere o sha256 de cada arquivo implantado e
// roda o aplicador de produção. O operador cola no Web Shell do serviço (bash INTERATIVO):
//   - `bind` desliga o bracketed paste ANTES da guarda e fora do subshell (o valor de antes é restaurado no fim do bloco, aceito ou recusado);
//   - guarda RENDER_SERVICE_ID ANTES de qualquer leitura de arquivo (outro serviço: nada do corpo executado);
//   - corpo num SUBSHELL ( … ): set -euo pipefail, umask, cd e exit não alteram nem encerram o shell do operador;
//   - no fim, CODIGO_SAIDA_BLOCO=<n>: 0/1/2/3 do aplicador (CONFERIDO-PASS / recusa antes de conectar / FALHA /
//     RECUSARIA); 4 = recusa do PRÓPRIO bloco, com mensagem nomeada (destino, ferramenta, arquivo, backup). Qualquer
//     outro código (127 linha perdida, 143 sinal) ou ausência da linha (Ctrl-C pode não imprimir a linha) = parar e ler;
//   - APLICAR exige KIDMAIS_REGISTRO_BACKUP definida no shell ANTES de colar, numa linha só: a referência do ponto PITR
//     de production comprovado (export lógico não substitui o ponto de recuperação desta janela).
// O bloco gerado é ASCII puro e tem no máximo 32 KB. Este gerador só lê arquivos e escreve o bloco; não conecta.
//   node scripts/bloco-shell-104-106-production.cjs <CONFERIR|APLICAR> <rotulo-da-arvore>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {ETAPAS} = require('./migration-104-106-comum.cjs');
const REVISADOS = ETAPAS;

const DESTINO = '/opt/render/project/src';
const LIMITE = 32 * 1024;
const SERVICO = 'srv-dak77m2d0e5s73b8rkkg';
const APLICADOR = 'scripts/migration-104-106-production.cjs';
/** Sem scripts/conexao-staging.cjs: o adaptador de produção traz a própria trava de alvo, identidade e disco. */
const DEPENDENCIAS = Object.freeze(['scripts/migration-104-106-comum.cjs', 'scripts/migration-092-094-comum.cjs']);
const REGISTRO = 'data/saloes-104-106-producao';
const BACKUP = '^[A-Za-z0-9:._/ -]{6,120}$';
const COMANDOS = Object.freeze({CONFERIR: '--conferir-104-106', APLICAR: '--aplicar-104-106-autorizado --backup "$KIDMAIS_REGISTRO_BACKUP"'});
const TITULOS = Object.freeze({
  CONFERIR: ['SOMENTE LEITURA: confere o sha256 do aplicador, dos nucleos e dos 8 SQL da 104/106 IMPLANTADOS e roda --conferir-104-106',
    '(identidade, estado da 104 e da 106, privilegios, atividade nas tabelas, precheck ou integridade, READ ONLY). Nada e gravado.'],
  APLICAR: ['ESCRITA (DDL) EM PRODUCAO - somente com a autorizacao especifica da 104/106 em producao. Antes de colar, no mesmo',
    'shell: export KIDMAIS_REGISTRO_BACKUP="<referencia e horario do ponto PITR de production comprovado>" (export logico NAO',
    'substitui). Janela drenada: sem cotacao, assistente, pagamentos, revisoes, edicao de saloes nem cron em curso. Roda',
    '--aplicar-104-106-autorizado UMA vez (uma transacao por migration: 104 hash da revisao, depois 106 salao de',
    'preferencia). Se algo parar, NAO repetir:',
    'copiar a saida e revisar (o marcador impede a repeticao e diz, por migration, se o COMMIT foi confirmado, desfeito ou',
    'ficou indeterminado; rodar o CONFERIR).'],
});
const AVISO = 'PRODUCAO: somente depois do deploy do codigo com este aplicador; exige a 094, a 102 e a 093 aplicadas e nenhuma sessao com lock nas tabelas atingidas.';
const sha = b => createHash('sha256').update(b).digest('hex');
/** Conteúdo LF da árvore; os SQL precisam ter exatamente o hash revisado do aplicador. */
function ler(raiz, arquivo) {
  const b = Buffer.from(fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n'), 'utf8');
  const revisado = REVISADOS.find(([, a]) => a === arquivo)?.[2];
  if (revisado) assert.equal(sha(b), revisado, 'ARQUIVO_DIVERGENTE_DO_REVISADO ' + arquivo);
  return b;
}
const seguro = s => { assert.match(s, /^[A-Za-z0-9_./-]+$/, 'CAMINHO_INSEGURO'); return s; };
function arquivos() { return [APLICADOR, ...DEPENDENCIAS, ...REVISADOS.map(([, arquivo]) => arquivo)]; }

/**
 * `destino` e `comando` existem para os testes locais (destino temporário; comando substituto que só devolve um código).
 * A CLI usa sempre o destino do Render e o comando do aplicador do modo.
 */
// Bracketed paste do operador: o valor de antes (on/off, lido de bind -v; vazio se nao houver readline) e guardado antes do
// bind e restaurado no fim do bloco, aceito ou recusado. Sem bind ou sem shell interativo nada e guardado nem restaurado.
const KM_SALVA = '__kmbp=$(bind -v 2>/dev/null); case "$__kmbp" in *"enable-bracketed-paste on"*) __kmbp=on;; *"enable-bracketed-paste off"*) __kmbp=off;; *) __kmbp=;; esac';
const KM_RESTAURA = '{ [ -z "$__kmbp" ] || bind "set enable-bracketed-paste $__kmbp" 2>/dev/null; unset __kmbp; }';

function gerar({modo, rotulo, raiz = path.resolve(__dirname, '..'), destino = DESTINO, comando}) {
  assert.ok(Object.hasOwn(COMANDOS, modo), 'MODO_DESCONHECIDO');
  assert.match(String(rotulo), /^[0-9a-f]{7,40}$/, 'ROTULO_INVALIDO');
  assert.match(destino, /^(?:[A-Za-z]:)?\/[A-Za-z0-9_./-]+$/, 'DESTINO_INVALIDO');
  const cmd = comando === undefined ? `NODE_PATH="$PWD/node_modules" node ${APLICADOR} ${COMANDOS[modo]}` : comando;
  const c = ['set -euo pipefail', 'umask 077', `cd '${destino}' || { echo "DESTINO_INACESSIVEL"; exit 4; }`,
    'for f in sha256sum cut node grep tr; do command -v "$f" >/dev/null || { echo "FERRAMENTA_AUSENTE $f"; exit 4; }; done',
    'h() { sha256sum "$1" | cut -d" " -f1; }',
    'arq() { [ -f "$1" ] && [ "$(h "$1")" = "$2" ] || { echo "ARQUIVO_DIVERGENTE_OU_AUSENTE $1"; exit 4; }; }'];
  for (const arquivo of arquivos()) c.push(`arq ${seguro(arquivo)} ${sha(ler(raiz, arquivo))}`);
  c.push('echo ARQUIVOS_CONFERIDOS');
  if (modo === 'APLICAR') c.push('B="${KIDMAIS_REGISTRO_BACKUP:-}"',
    `printf "%s" "$B" | grep -Eq "${BACKUP}" && [ "$(printf "%s" "$B" | tr -d "\\r\\n")" = "$B" ] || { echo "BACKUP_NAO_INFORMADO defina KIDMAIS_REGISTRO_BACKUP (ponto PITR de production) numa linha antes de colar"; exit 4; }`);
  c.push('codigo=0', `${cmd} || codigo=$?`, `echo '=== REGISTRO (${REGISTRO}) ==='`, `ls -1 ${REGISTRO} 2>/dev/null || echo SEM_REGISTRO`, 'exit "$codigo"');
  const linhas = ['#!/usr/bin/env bash',
    `# BLOCO-SHELL-104-106-PRODUCTION-${modo} - Web Shell do ${SERVICO} (kidmais-manager-production). Colar inteiro, uma vez, e Enter.`,
    ...TITULOS[modo].map(t => '# ' + t), '# ' + AVISO,
    `# Gerado da arvore ${rotulo} por scripts/bloco-shell-104-106-production.cjs. Conferir sha256 e bytes antes de colar.`,
    '# O bind abaixo roda ANTES da guarda e FORA do subshell, mesmo em outro servico: desliga o bracketed paste do readline',
    '# pelo resto desta sessao. A guarda de RENDER_SERVICE_ID vem antes de qualquer leitura de arquivo. Corpo em subshell:',
    '# opcoes, umask, cwd e variaveis nao vazam. No fim sai CODIGO_SAIDA_BLOCO=<n> (0/1/2/3 aplicador, 4 bloco); outro codigo',
    '# ou ausencia da linha = parar e ler. Prompt `>` depois de colar = colagem incompleta: Ctrl-C e colar o MESMO bloco.',
    KM_SALVA,
    "bind 'set enable-bracketed-paste off' 2>/dev/null",
    `if [ "$RENDER_SERVICE_ID" != "${SERVICO}" ]; then echo "SHELL_ERRADO_NAO_E_PRODUCTION ($RENDER_SERVICE_ID): nada executado"; ${KM_RESTAURA}; else`,
    '(', ...c, ')', 'echo "CODIGO_SAIDA_BLOCO=$?"', KM_RESTAURA, 'fi'];
  const bloco = linhas.join('\n') + '\n';
  assert.match(bloco, /^[\x09\x0a\x20-\x7e]*$/, 'BLOCO_NAO_ASCII');
  assert.ok(Buffer.byteLength(bloco, 'utf8') <= LIMITE, 'BLOCO_GRANDE_DEMAIS');
  return bloco;
}

if (require.main === module) {
  try {
    const [modo, rotulo] = process.argv.slice(2);
    const bloco = gerar({modo, rotulo});
    process.stdout.write(bloco);
    console.error(`BLOCO-SHELL-104-106-PRODUCTION-${modo} sha256 ${sha(Buffer.from(bloco, 'utf8'))} (${Buffer.byteLength(bloco, 'utf8')} bytes)`);
  } catch (e) { console.error('RECUSADO ' + String(e?.message ?? e).slice(0, 160)); process.exitCode = 1; }
}
module.exports = {DESTINO, LIMITE, SERVICO, APLICADOR, DEPENDENCIAS, REGISTRO, COMANDOS, arquivos, gerar};
