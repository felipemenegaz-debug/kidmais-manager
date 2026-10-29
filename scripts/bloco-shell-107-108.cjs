/* eslint-disable @typescript-eslint/no-require-imports */
// Blocos de Shell da 107/108 (reparo da agenda + salões combinados, staging), no mesmo desenho dos blocos da 104/106
// (P2-A colagem interativa, P3-1 trap/código, P3-2 bind antes da guarda). Plano "E4 aplicadores 107 108 staging
// 20261029", E4-0/E4-5/E4-7.
// RUNBOOK: o bloco roda num JOB ou no SHELL do Render do serviço de staging com a MESMA árvore implantada (#267 + E4),
// ENQUANTO o web está drenado (manutenção ou escala zero) e o cron suspenso, durante as DUAS transações (D-E4). Com o web
// em escala zero não há Web Shell: usar um job do Render (one-off) do mesmo serviço e da mesma árvore. O CÓDIGO é
// publicado antes, já com o aplicador, os núcleos e os SQL na árvore — por isso o bloco NÃO transporta nem grava arquivos:
// confere o sha256 de cada arquivo implantado (aplicador, núcleos, definições, retrato, inventário, conexão, checks,
// esperados, migrations e downs) e roda o aplicador. O operador cola no shell do serviço (bash INTERATIVO):
//   - `bind` desliga o bracketed paste ANTES da guarda e fora do subshell (vale pelo resto da sessão do operador);
//   - guarda RENDER_SERVICE_ID ANTES de qualquer leitura de arquivo (outro serviço: nada do corpo executado);
//   - corpo num SUBSHELL ( … ): set -euo pipefail, umask 077, cd e exit não alteram nem encerram o shell do operador;
//   - no fim, CODIGO_SAIDA_BLOCO=<n>: 0/1/2/3 do aplicador (CONFERIDO-PASS / recusa antes de conectar / FALHA /
//     RECUSARIA); 4 = recusa do PRÓPRIO bloco, com mensagem nomeada (destino, ferramenta, arquivo, backup, drenagem).
//     Qualquer outro código (127 linha perdida, 143 sinal) ou ausência da linha = parar e ler;
//   - APLICAR exige KIDMAIS_REGISTRO_BACKUP (referência do ponto PITR comprovado; export lógico não substitui) e
//     KIDMAIS_REGISTRO_DRENAGEM (como o web e o cron foram drenados e quando) definidas no shell ANTES de colar.
// Os downs são conferidos por hash (recuperação documentada), nunca executados. O bloco gerado é ASCII puro e tem no
// máximo 32 KB. Este gerador só lê arquivos e escreve o bloco; não conecta.
//   node scripts/bloco-shell-107-108.cjs staging <CONFERIR|APLICAR> <rotulo-da-arvore>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {ARQUIVOS, RECUPERACAO} = require('./migration-107-108-comum.cjs');
const REVISADOS = Object.freeze([...ARQUIVOS, ...RECUPERACAO]);

const DESTINO = '/opt/render/project/src';
const LIMITE = 32 * 1024;
const AMBIENTES = Object.freeze({
  staging: Object.freeze({servico: 'srv-daif418ae00c73e8k2gg', nome: 'kidmais-manager-staging', aplicador: 'scripts/migration-107-108-staging.cjs',
    dependencias: Object.freeze(['scripts/migration-107-108-comum.cjs', 'scripts/migration-107-definicoes.cjs', 'scripts/migration-108-retrato.cjs',
      'scripts/migration-108-inventario.cjs', 'scripts/conexao-staging.cjs']), registro: 'data/saloes-107-108-staging', rotulo: 'STAGING'}),
});
const COMANDOS = Object.freeze({CONFERIR: '--conferir-107-108',
  APLICAR: '--aplicar-107-108-autorizado --backup "$KIDMAIS_REGISTRO_BACKUP" --drenagem "$KIDMAIS_REGISTRO_DRENAGEM"'});
const TITULOS = Object.freeze({
  CONFERIR: ['SOMENTE LEITURA: confere o sha256 do aplicador, dos nucleos, dos checks, dos retratos, das migrations e dos downs',
    'da 107/108 IMPLANTADOS e roda --conferir-107-108 (identidade, estado da 107 e da 108, privilegios, atividade nas tabelas,',
    'sessoes do banco, fase F0/F1/F2 e retrato, READ ONLY). Nada e gravado.'],
  APLICAR: ['ESCRITA (DDL) - somente com a autorizacao especifica da 107/108 neste ambiente. Antes de colar, no mesmo shell:',
    'export KIDMAIS_REGISTRO_BACKUP="<referencia e horario do ponto PITR comprovado>" (export logico NAO substitui) e',
    'export KIDMAIS_REGISTRO_DRENAGEM="<web em manutencao/escala zero e cron suspenso: como e desde quando>".',
    'Janela drenada durante as DUAS transacoes: sem web, cron, outros escritores, jobs nem DDL. Roda',
    '--aplicar-107-108-autorizado UMA vez (transacao 1 = 107 reparo da agenda; transacao 2 = 108 saloes combinados).',
    'Se algo parar, NAO repetir: copiar a saida e revisar (os marcadores impedem a repeticao e dizem, por etapa, se o',
    'COMMIT foi confirmado, desfeito ou ficou indeterminado; rodar o CONFERIR). Reversao: down da 108 ANTES do da 107,',
    'cada um com autorizacao; PROIBIDO voltar o codigo publico para versao sem o filtro E2a enquanto existir combinado.'],
});
const sha = b => createHash('sha256').update(b).digest('hex');
/** Conteúdo LF da árvore; os arquivos revisados precisam ter exatamente o hash fixado no aplicador. */
function ler(raiz, arquivo) {
  const b = Buffer.from(fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n'), 'utf8');
  const revisado = REVISADOS.find(([, a]) => a === arquivo)?.[2];
  if (revisado) assert.equal(sha(b), revisado, 'ARQUIVO_DIVERGENTE_DO_REVISADO ' + arquivo);
  return b;
}
const seguro = s => { assert.match(s, /^[A-Za-z0-9_./-]+$/, 'CAMINHO_INSEGURO'); return s; };
function arquivos(ambiente) { const a = AMBIENTES[ambiente]; return [a.aplicador, ...a.dependencias, ...REVISADOS.map(([, arquivo]) => arquivo)]; }
const REGISTRO = '^[A-Za-z0-9:._/ -]{6,120}$';

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
    'for f in sha256sum cut node grep; do command -v "$f" >/dev/null || { echo "FERRAMENTA_AUSENTE $f"; exit 4; }; done',
    'h() { sha256sum "$1" | cut -d" " -f1; }',
    'arq() { [ -f "$1" ] && [ "$(h "$1")" = "$2" ] || { echo "ARQUIVO_DIVERGENTE_OU_AUSENTE $1"; exit 4; }; }'];
  for (const arquivo of arquivos(ambiente)) c.push(`arq ${seguro(arquivo)} ${sha(ler(raiz, arquivo))}`);
  c.push('echo ARQUIVOS_CONFERIDOS');
  if (modo === 'APLICAR') c.push('B="${KIDMAIS_REGISTRO_BACKUP:-}"',
    `printf "%s" "$B" | grep -Eq "${REGISTRO}" || { echo "BACKUP_NAO_INFORMADO defina KIDMAIS_REGISTRO_BACKUP antes de colar"; exit 4; }`,
    'D="${KIDMAIS_REGISTRO_DRENAGEM:-}"',
    `printf "%s" "$D" | grep -Eq "${REGISTRO}" || { echo "DRENAGEM_NAO_INFORMADA defina KIDMAIS_REGISTRO_DRENAGEM antes de colar (web drenado e cron suspenso)"; exit 4; }`);
  c.push('codigo=0', `${cmd} || codigo=$?`, `echo '=== REGISTRO (${a.registro}) ==='`, `ls -1 ${a.registro} 2>/dev/null || echo SEM_REGISTRO`, 'exit "$codigo"');
  const linhas = ['#!/usr/bin/env bash',
    `# BLOCO-SHELL-107-108-${a.rotulo}-${modo} - job/shell do Render do ${a.servico} (${a.nome}), mesma arvore. Colar inteiro, uma vez, e Enter.`,
    ...TITULOS[modo].map(t => '# ' + t),
    `# Gerado da arvore ${rotulo} por scripts/bloco-shell-107-108.cjs. Conferir sha256 e bytes antes de colar.`,
    '# Runbook: rodar com o web drenado (manutencao ou escala zero) e o cron suspenso; com escala zero, num job do Render',
    '# do mesmo servico e da mesma arvore. O bind abaixo roda ANTES da guarda e FORA do subshell, mesmo em outro servico:',
    '# desliga o bracketed paste do readline pelo resto desta sessao. A guarda de RENDER_SERVICE_ID vem antes de qualquer',
    '# leitura de arquivo. Corpo em subshell: opcoes, umask, cwd e variaveis nao vazam. No fim sai CODIGO_SAIDA_BLOCO=<n>',
    '# (0/1/2/3 aplicador, 4 bloco); outro codigo ou ausencia da linha = parar e ler. Prompt `>` depois de colar = colagem',
    '# incompleta: Ctrl-C e colar o MESMO bloco.',
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
    console.error(`BLOCO-SHELL-107-108-${AMBIENTES[ambiente].rotulo}-${modo} sha256 ${sha(Buffer.from(bloco, 'utf8'))} (${Buffer.byteLength(bloco, 'utf8')} bytes)`);
  } catch (e) { console.error('RECUSADO ' + String(e?.message ?? e).slice(0, 160)); process.exitCode = 1; }
}
module.exports = {DESTINO, LIMITE, AMBIENTES, COMANDOS, arquivos, gerar};
