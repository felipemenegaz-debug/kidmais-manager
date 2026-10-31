/* eslint-disable @typescript-eslint/no-require-imports */
// Blocos de Shell da 092 → 093 → 094 (staging; e produção em execuções separadas 092-093 e 094), no desenho revisado dos blocos 088/089 (P2-A colagem interativa, P3-1
// trap/código, P3-2 bind antes da guarda). O CÓDIGO é publicado antes, já com o aplicador e os SQL na árvore implantada —
// por isso o bloco NÃO transporta nem grava arquivos: confere o sha256 de cada arquivo implantado e roda o aplicador.
// O operador cola no Web Shell do serviço (bash INTERATIVO):
//   - `bind` desliga o bracketed paste ANTES da guarda e fora do subshell (vale pelo resto da sessão do operador);
//   - guarda RENDER_SERVICE_ID ANTES de qualquer leitura de arquivo (outro serviço: nada do corpo executado);
//   - corpo num SUBSHELL ( … ): set -euo pipefail, umask, cd e exit não alteram nem encerram o shell do operador;
//   - no fim, CODIGO_SAIDA_BLOCO=<n>: 0/1/2/3 do aplicador (CONFERIDO-PASS / recusa antes de conectar / FALHA /
//     RECUSARIA); 4 = recusa do PRÓPRIO bloco, com mensagem nomeada (destino, ferramenta, arquivo, backup). Qualquer
//     outro código (127 linha perdida, 143 sinal) ou ausência da linha (Ctrl-C pode não imprimir a linha) = parar e ler;
//   - APLICAR exige KIDMAIS_REGISTRO_BACKUP definida no shell ANTES de colar (referência do export/PITR anotado).
// O bloco gerado é ASCII puro e tem no máximo 32 KB. Este gerador só lê arquivos e escreve o bloco; não conecta.
//   node scripts/bloco-shell-092-094.cjs staging <CONFERIR|APLICAR> <rotulo-da-arvore>
//   node scripts/bloco-shell-092-094.cjs production <CONFERIR|CONFERIR-092-093|CONFERIR-094|APLICAR-092-093|APLICAR-094> <rotulo-da-arvore>
// Produção: APLICAR-092-093 é o E3 do plano de promoção (código ANTIGO publicado) e só funciona se o aplicador e os SQL
// estiverem no destino por um mecanismo de entrega revisado (B-4); APLICAR-094 é o E6, depois do deploy do código novo.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {ETAPAS, INTEGRIDADE_094_APOS_100, INTEGRIDADE_094_APOS_108} = require('./migration-092-094-comum.cjs');
const REVISADOS = Object.freeze([...ETAPAS, INTEGRIDADE_094_APOS_100, INTEGRIDADE_094_APOS_108]);

const DESTINO = '/opt/render/project/src';
const LIMITE = 32 * 1024;
const AMBIENTES = Object.freeze({
  staging: Object.freeze({servico: 'srv-daif418ae00c73e8k2gg', nome: 'kidmais-manager-staging', aplicador: 'scripts/migration-092-094-staging.cjs',
    dependencias: Object.freeze(['scripts/migration-092-094-comum.cjs', 'scripts/migration-108-evidencias.cjs', 'scripts/migration-108-retrato.cjs', 'scripts/migration-107-definicoes.cjs', 'scripts/migration-108-inventario.cjs',
      'database/checks/20261029_108_retrato.sql', 'database/checks/20261029_108_retratos_esperados.json', 'scripts/conexao-staging.cjs']),
    registro: 'data/agenda-precos-092-094-staging', rotulo: 'STAGING',
    comandos: Object.freeze({CONFERIR: '--conferir-092-094', APLICAR: '--aplicar-092-094-autorizado --backup "$KIDMAIS_REGISTRO_BACKUP"'})}),
  production: Object.freeze({servico: 'srv-dak77m2d0e5s73b8rkkg', nome: 'kidmais-manager-production', aplicador: 'scripts/migration-092-094-production.cjs',
    // Mesmas dependências da 107/108 que staging: o núcleo confere a integridade da 094 com a prova da 108 (ad7fbee9).
    dependencias: Object.freeze(['scripts/migration-092-094-comum.cjs', 'scripts/migration-108-evidencias.cjs', 'scripts/migration-108-retrato.cjs', 'scripts/migration-107-definicoes.cjs', 'scripts/migration-108-inventario.cjs',
      'database/checks/20261029_108_retrato.sql', 'database/checks/20261029_108_retratos_esperados.json']),
    registro: 'data/agenda-precos-092-094-producao', rotulo: 'PRODUCTION',
    comandos: Object.freeze({CONFERIR: '--conferir-092-094', 'CONFERIR-092-093': '--conferir-092-093', 'CONFERIR-094': '--conferir-094', 'APLICAR-092-093': '--aplicar-092-093-autorizado --backup "$KIDMAIS_REGISTRO_BACKUP"',
      'APLICAR-094': '--aplicar-094-autorizado --backup "$KIDMAIS_REGISTRO_BACKUP"'})}),
});
/** Comandos do ambiente (staging mantém CONFERIR/APLICAR; produção só aplica por escopo). */
const COMANDOS = AMBIENTES.staging.comandos;
const TITULOS = Object.freeze({
  CONFERIR: ['SOMENTE LEITURA: confere o sha256 do aplicador, do nucleo e dos 14 SQL da 092-094 IMPLANTADOS (inclui a integridade da 094 com o corpo da 100 e da 108; prova da 108) e roda --conferir-092-094',
    '(identidade, estado de cada migration, privilegios CREATE/DONO/REFERENCES, precheck das pendentes e integridade das aplicadas, READ ONLY). Nada e gravado.'],
  APLICAR: ['ESCRITA (DDL) - somente com a autorizacao especifica da 092-094 neste ambiente. Antes de colar, no mesmo',
    'shell: export KIDMAIS_REGISTRO_BACKUP="<id e horario do export/PITR>". Roda --aplicar-092-094-autorizado UMA vez',
    '(092, 093 e 094 em sequencia, cada uma na propria transacao). Se algo parar, NAO repetir: copiar a saida e revisar',
    '(o marcador impede a repeticao e diz quais commitaram ou ficaram indeterminadas; rodar o CONFERIR).'],
  'CONFERIR-092-093': ['SOMENTE LEITURA - E3: confere o sha256 dos arquivos IMPLANTADOS e roda --conferir-092-093: plano, checks e codigo',
    'SO do escopo 092-093 (nao depende de privilegio, dependencia ou REFERENCES exclusivos da 094). Nada e gravado.'],
  'CONFERIR-094': ['SOMENTE LEITURA - E6: confere o sha256 dos arquivos IMPLANTADOS e roda --conferir-094: plano, checks e codigo do',
    'escopo 094 (exige 092 e 093 completas). Nada e gravado.'],
  'APLICAR-092-093': ['ESCRITA (DDL) - E3: somente com a autorizacao especifica do escopo 092-093 em PRODUCAO, com o codigo ANTIGO publicado.',
    'Antes de colar, no mesmo shell: export KIDMAIS_REGISTRO_BACKUP="<dump conferido e PITR>". Roda --aplicar-092-093-autorizado UMA vez',
    '(092 e 093, cada uma na propria transacao). Recusa se a 094 existir e NUNCA aplica a 094. Se algo parar, NAO repetir:',
    'copiar a saida, rodar o CONFERIR e seguir o ENC do plano.'],
  'APLICAR-094': ['ESCRITA (DDL) - E6: somente com a autorizacao especifica do escopo 094 em PRODUCAO, DEPOIS do deploy do codigo novo.',
    'Antes de colar, no mesmo shell: export KIDMAIS_REGISTRO_BACKUP="<dump conferido e PITR>". Roda --aplicar-094-autorizado UMA vez',
    '(exige 092 e 093 completas; confere as duas e instala a 094). Se algo parar, NAO repetir: copiar a saida, rodar o',
    'CONFERIR e seguir o ENC do plano.'],
});
const sha = b => createHash('sha256').update(b).digest('hex');
/** Conteúdo LF da árvore; os SQL precisam ter exatamente o hash revisado do aplicador. */
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
  assert.ok(Object.hasOwn(AMBIENTES[ambiente].comandos, modo), 'MODO_DESCONHECIDO');
  assert.match(String(rotulo), /^[0-9a-f]{7,40}$/, 'ROTULO_INVALIDO');
  assert.match(destino, /^(?:[A-Za-z]:)?\/[A-Za-z0-9_./-]+$/, 'DESTINO_INVALIDO');
  const a = AMBIENTES[ambiente];
  const cmd = comando === undefined ? `NODE_PATH="$PWD/node_modules" node ${a.aplicador} ${a.comandos[modo]}` : comando;
  const c = ['set -euo pipefail', 'umask 077', `cd '${destino}' || { echo "DESTINO_INACESSIVEL"; exit 4; }`,
    'for f in sha256sum cut node; do command -v "$f" >/dev/null || { echo "FERRAMENTA_AUSENTE $f"; exit 4; }; done',
    'h() { sha256sum "$1" | cut -d" " -f1; }',
    'arq() { [ -f "$1" ] && [ "$(h "$1")" = "$2" ] || { echo "ARQUIVO_DIVERGENTE_OU_AUSENTE $1"; exit 4; }; }'];
  for (const arquivo of arquivos(ambiente)) c.push(`arq ${seguro(arquivo)} ${sha(ler(raiz, arquivo))}`);
  c.push('echo ARQUIVOS_CONFERIDOS');
  if (modo.startsWith('APLICAR')) c.push('B="${KIDMAIS_REGISTRO_BACKUP:-}"',
    'printf "%s" "$B" | grep -Eq "^[A-Za-z0-9:._/ -]{6,120}$" || { echo "BACKUP_NAO_INFORMADO defina KIDMAIS_REGISTRO_BACKUP antes de colar"; exit 4; }');
  c.push('codigo=0', `${cmd} || codigo=$?`, `echo '=== REGISTRO (${a.registro}) ==='`, `ls -1 ${a.registro} 2>/dev/null || echo SEM_REGISTRO`, 'exit "$codigo"');
  const linhas = ['#!/usr/bin/env bash',
    `# BLOCO-SHELL-092-094-${a.rotulo}-${modo} - Web Shell do ${a.servico} (${a.nome}). Colar inteiro, uma vez, e Enter.`,
    ...TITULOS[modo].map(t => '# ' + t),
    `# Gerado da arvore ${rotulo} por scripts/bloco-shell-092-094.cjs. Conferir sha256 e bytes antes de colar.`,
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
    console.error(`BLOCO-SHELL-092-094-${AMBIENTES[ambiente].rotulo}-${modo} sha256 ${sha(Buffer.from(bloco, 'utf8'))} (${Buffer.byteLength(bloco, 'utf8')} bytes)`);
  } catch (e) { console.error('RECUSADO ' + String(e?.message ?? e).slice(0, 160)); process.exitCode = 1; }
}
module.exports = {DESTINO, LIMITE, AMBIENTES, COMANDOS, arquivos, gerar};
