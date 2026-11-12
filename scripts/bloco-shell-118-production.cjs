/* eslint-disable @typescript-eslint/no-require-imports */
// Blocos de Shell da 118 (cota de leitura de documentos da importação, L2) em PRODUÇÃO, no desenho do bloco de staging
// (scripts/bloco-shell-118.cjs, que fica intacto): bind antes da guarda, guarda de RENDER_SERVICE_ID antes de ler qualquer
// arquivo, corpo em subshell, sha256 de cada arquivo implantado, CODIGO_SAIDA_BLOCO=<n> no fim (0/1/2/3 do aplicador,
// 4 = recusa do próprio bloco). O bloco NÃO transporta nem grava arquivos: a árvore implantada já traz o aplicador.
// Diferenças de produção:
//   - aplicador scripts/migration-118-production.cjs; sem conexao-staging.cjs; registro data/importacao-cotas-118-producao;
//   - APLICAR exige KIDMAIS_REGISTRO_BACKUP no formato "PITR <AAAA-MM-DDTHH:MMZ> <referencia>" e confere o horário contra
//     o relógio UTC do próprio Shell: o ponto precisa estar entre 0 e 120 min ANTES de agora (na 116 e na 118 de staging o
//     texto do backup saiu com um horário errado; aqui o bloco recusa em vez de gravar o erro no marcador).
// O bloco gerado é ASCII puro e tem no máximo 32 KB. Este gerador só lê arquivos e escreve o bloco; não conecta.
//   node scripts/bloco-shell-118-production.cjs <CONFERIR|APLICAR> <rotulo-da-arvore>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {ETAPAS} = require('./migration-118-comum.cjs');

const DESTINO = '/opt/render/project/src';
const LIMITE = 32 * 1024;
const SERVICO = 'srv-dak77m2d0e5s73b8rkkg';
const APLICADOR = 'scripts/migration-118-production.cjs';
const DEPENDENCIAS = Object.freeze(['scripts/migration-118-comum.cjs', 'scripts/migration-092-094-comum.cjs']);
const REGISTRO = 'data/importacao-cotas-118-producao';
const REVISADOS = Object.freeze(ETAPAS.map(([, arquivo, hash]) => [arquivo, hash]));
/** "PITR 2026-11-20T03:10Z referencia" (referência livre, ASCII seguro, numa linha). */
const BACKUP = '^PITR 20[0-9]{2}-[01][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]Z [A-Za-z0-9:._/-][A-Za-z0-9:._/ -]{0,89}$';
const JANELA_PITR_S = 120 * 60;
const COMANDOS = Object.freeze({CONFERIR: '--conferir-118', APLICAR: '--aplicar-118-autorizado --backup "$KIDMAIS_REGISTRO_BACKUP"'});
const TITULOS = Object.freeze({
  CONFERIR: ['SOMENTE LEITURA: confere o sha256 do aplicador, dos nucleos e dos 3 SQL da 118 IMPLANTADOS e roda --conferir-118',
    '(identidade e papel, os 7 objetos da 118 no catalogo, REFERENCES em empresas e ia_documentos, precheck ou postcheck,',
    'contagem de documentos e, com a 118, de cotas e leituras por situacao; READ ONLY). Nada e gravado.',
    'Servidor (D-118-TLS): por padrao o login TEM de ser SCRAM-SHA-256-PLUS com a assinatura do servidor conferida (canal ligado);',
    'Falha CANAL_ANTES_DA_PROVA ... (ou CANAL_LIGADO_INDISPONIVEL) = parar: nenhuma senha ou prova saiu. Nao definir KIDMAIS_118_TLS_* sem decisao de Felipe.',
    'Falha CANAL_PROVA_EXPOSTA ... (qualquer motivo), login travado ou falha de conexao sem um desses prefixos = a prova pode ter saido',
    'para um impostor: parar, NAO repetir, avisar Felipe e girar a credencial do web antes de qualquer nova tentativa.',
    'Resultado: PRONTA_PARA_APLICAR / JA_APLICADA_POSTCHECK_PASS (0); RECUSARIA (3) = parar e ler o motivo.'],
  APLICAR: ['ESCRITA (DDL) EM PRODUCAO - somente com a autorizacao especifica de Felipe para a 118 em producao.',
    'Antes de colar, no mesmo shell: export KIDMAIS_REGISTRO_BACKUP="PITR <AAAA-MM-DDTHH:MMZ> <referencia>" (ponto conferido',
    'no painel do Render, entre 0 e 120 min antes de agora pelo relogio UTC deste Shell; o bloco recusa fora disso).',
    'Servidor (D-118-TLS): por padrao o login TEM de ser SCRAM-SHA-256-PLUS com a assinatura do servidor conferida (canal ligado);',
    'Falha CANAL_ANTES_DA_PROVA ... (ou CANAL_LIGADO_INDISPONIVEL) = parar: nenhuma senha ou prova saiu. Nao definir KIDMAIS_118_TLS_* sem decisao de Felipe.',
    'Falha CANAL_PROVA_EXPOSTA ... (qualquer motivo), login travado ou falha de conexao sem um desses prefixos = a prova pode ter saido',
    'para um impostor: parar, NAO repetir, avisar Felipe e girar a credencial do web antes de qualquer nova tentativa.',
    'Roda --aplicar-118-autorizado UMA vez (uma transacao: 2 tabelas da cota, 2 indices, 3 funcoes e 2 gatilhos;',
    'preservacao e postcheck antes do COMMIT; empresas e ia_documentos travadas ate o fim da transacao). Se algo parar,',
    'NAO repetir: copiar a saida e revisar (o marcador impede a repeticao e diz se o COMMIT foi confirmado, desfeito ou',
    'ficou indeterminado). Depois do COMMIT a cota passa a valer na importacao de producao.'],
});
const sha = b => createHash('sha256').update(b).digest('hex');
function ler(raiz, arquivo) {
  const b = Buffer.from(fs.readFileSync(path.join(raiz, arquivo), 'utf8').replace(/\r\n/g, '\n'), 'utf8');
  const revisado = REVISADOS.find(([a]) => a === arquivo)?.[1];
  if (revisado) assert.equal(sha(b), revisado, 'ARQUIVO_DIVERGENTE_DO_REVISADO ' + arquivo);
  return b;
}
const seguro = s => { assert.match(s, /^[A-Za-z0-9_./-]+$/, 'CAMINHO_INSEGURO'); return s; };
function arquivos() { return [APLICADOR, ...DEPENDENCIAS, ...REVISADOS.map(([arquivo]) => arquivo)]; }

/**
 * `destino`, `comando` e `agora` existem para os testes locais (destino temporário; comando substituto que só devolve um
 * código; relógio fixo em segundos UTC no lugar de `date -u +%s`). A CLI usa sempre o destino do Render, o comando do
 * aplicador do modo e o relógio do Shell.
 */
function gerar({modo, rotulo, raiz = path.resolve(__dirname, '..'), destino = DESTINO, comando, agora}) {
  assert.ok(Object.hasOwn(COMANDOS, modo), 'MODO_DESCONHECIDO');
  assert.match(String(rotulo), /^[0-9a-f]{7,40}$/, 'ROTULO_INVALIDO');
  assert.match(destino, /^(?:[A-Za-z]:)?\/[A-Za-z0-9_./-]+$/, 'DESTINO_INVALIDO');
  assert.ok(agora === undefined || Number.isSafeInteger(agora), 'AGORA_INVALIDO');
  const cmd = comando === undefined ? `NODE_PATH="$PWD/node_modules" node ${APLICADOR} ${COMANDOS[modo]}` : comando;
  const c = ['set -euo pipefail', 'umask 077', `cd '${destino}' || { echo "DESTINO_INACESSIVEL"; exit 4; }`,
    'for f in sha256sum cut node tr date grep; do command -v "$f" >/dev/null || { echo "FERRAMENTA_AUSENTE $f"; exit 4; }; done',
    'h() { sha256sum "$1" | cut -d" " -f1; }',
    'arq() { [ -f "$1" ] && [ "$(h "$1")" = "$2" ] || { echo "ARQUIVO_DIVERGENTE_OU_AUSENTE $1"; exit 4; }; }'];
  for (const arquivo of arquivos()) c.push(`arq ${seguro(arquivo)} ${sha(ler(raiz, arquivo))}`);
  c.push('echo ARQUIVOS_CONFERIDOS');
  if (modo === 'APLICAR') c.push('B="${KIDMAIS_REGISTRO_BACKUP:-}"',
    `printf "%s" "$B" | grep -Eq "${BACKUP}" && [ "$(printf "%s" "$B" | tr -d "\\r\\n")" = "$B" ] || { echo "BACKUP_NAO_INFORMADO defina KIDMAIS_REGISTRO_BACKUP=\\"PITR <AAAA-MM-DDTHH:MMZ> <referencia>\\" numa linha antes de colar"; exit 4; }`,
    agora === undefined ? 'AGORA_S="$(date -u +%s)"' : `AGORA_S=${agora}`,
    'PITR_TXT="$(printf "%s" "$B" | cut -d" " -f2)"',
    'PITR_S="$(date -u -d "$(printf "%s" "$PITR_TXT" | tr "T" " " | tr -d "Z") UTC" +%s 2>/dev/null)" || { echo "BACKUP_HORARIO_ILEGIVEL $PITR_TXT"; exit 4; }',
    'echo "HORA_DO_SHELL_UTC=$(date -u -d "@$AGORA_S" +%Y-%m-%dT%H:%MZ) PITR_ANOTADO=$PITR_TXT"',
    `D=$((AGORA_S - PITR_S)); [ "$D" -ge 0 ] && [ "$D" -le ${JANELA_PITR_S} ] || { echo "BACKUP_FORA_DA_JANELA o ponto PITR anotado precisa estar entre 0 e 120 min antes do relogio UTC deste Shell"; exit 4; }`);
  c.push('codigo=0', `${cmd} || codigo=$?`, `echo '=== REGISTRO (${REGISTRO}) ==='`, `ls -1 ${REGISTRO} 2>/dev/null || echo SEM_REGISTRO`, 'exit "$codigo"');
  const linhas = ['#!/usr/bin/env bash',
    `# BLOCO-SHELL-118-PRODUCTION-${modo} - Web Shell do ${SERVICO} (kidmais-manager-production). Colar inteiro, uma vez, e Enter.`,
    ...TITULOS[modo].map(t => '# ' + t),
    `# Gerado da arvore ${rotulo} por scripts/bloco-shell-118-production.cjs. Conferir sha256 e bytes antes de colar.`,
    '# O bind abaixo roda ANTES da guarda e FORA do subshell, mesmo em outro servico: desliga o bracketed paste do readline',
    '# pelo resto desta sessao. A guarda de RENDER_SERVICE_ID vem antes de qualquer leitura de arquivo. Corpo em subshell:',
    '# opcoes, umask, cwd e variaveis nao vazam. No fim sai CODIGO_SAIDA_BLOCO=<n> (0/1/2/3 aplicador, 4 bloco); outro codigo',
    '# ou ausencia da linha = parar e ler. Prompt `>` depois de colar = colagem incompleta: Ctrl-C e colar o MESMO bloco.',
    "bind 'set enable-bracketed-paste off' 2>/dev/null",
    `if [ "$RENDER_SERVICE_ID" != "${SERVICO}" ]; then echo "SHELL_ERRADO_NAO_E_PRODUCAO ($RENDER_SERVICE_ID): nada executado"; else`,
    '(', ...c, ')', 'echo "CODIGO_SAIDA_BLOCO=$?"', 'fi'];
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
    console.error(`BLOCO-SHELL-118-PRODUCTION-${modo} sha256 ${sha(Buffer.from(bloco, 'utf8'))} (${Buffer.byteLength(bloco, 'utf8')} bytes)`);
  } catch (e) { console.error('RECUSADO ' + String(e?.message ?? e).slice(0, 160)); process.exitCode = 1; }
}
module.exports = {DESTINO, LIMITE, SERVICO, APLICADOR, DEPENDENCIAS, REGISTRO, BACKUP, JANELA_PITR_S, COMANDOS, arquivos, gerar};
