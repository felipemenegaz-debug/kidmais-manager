/* eslint-disable @typescript-eslint/no-require-imports */
// Blocos de Shell do B-14 — recuperação persistente de pagamentos (plano rev. 8.1, §3.8, §3.11; D-B14-1, D-B14-13), no
// desenho dos blocos de produção de 18–20/10 (colagem interativa, bind antes da guarda, corpo em subshell, código impresso).
// O operador (Felipe) cola no Web Shell do serviço (bash INTERATIVO) blocos gerados por este script, conferindo sha256 e
// bytes antes de colar. Cada bloco é ASCII puro, tem no máximo 32 KB e termina em CODIGO_SAIDA_BLOCO=<n>:
//   - ENTREGA-1..N: a árvore mínima (scripts/arvore-recuperacao-b14.cjs) em partes; cada parte decodifica e confere o sha256
//     de TODOS os seus arquivos num temporário, recusa presente-diferente e só então grava na pasta própria
//     /opt/render/project/src/.kidmais-recuperacao-b14/<árvore> (fora de scripts/ e lib/ do deploy; some no próximo deploy);
//   - ENTREGA-CONFERIR: grava o SHA256SUMS fixado, confere a árvore inteira (sha256sum -c, nenhum arquivo a mais), o runtime
//     (Node do engines, pg e zod do node_modules do serviço) e informa a equivalência de lib/ com o deploy (ARVORE_OK);
//   - CONFERIR-E0: a linha de base E0 (P0a/P0b) com o CODIGO ANTIGO no ar: so roda se RENDER_GIT_COMMIT existe e difere da
//     candidata; a equivalencia de lib/ e so informativa (revisao do incremento 5, P2). CONFERIR e RECUPERAR seguem rigorosos;
//   - FILA, DRENAGEM, CONFERIR (JANELA), RECUPERAR (JANELA, escrita), INVENTARIO, APLICAR-CASO (escrita), CONFERIR-CASO,
//     LIBERACAO: conferem a árvore (e, na JANELA, lib/ idêntica ao deploy) e rodam a entrada a partir dela, com o alvo
//     literal fixado (KIDMAIS_B14_ALVO) e a candidata fixada; os valores de cada execução vêm de variáveis KIDMAIS_B14_*
//     exportadas no shell ANTES de colar, validadas por lista de caracteres;
//   - LIMPEZA: SÓ NO ENCERRAMENTO (exige KIDMAIS_B14_ENCERRAMENTO=SIM): remove só arquivos da árvore cujo sha confere e TODOS
//     os arquivos de casos (D-B14-8); nunca o resto do disco.
// Códigos: 0/1/2/3 da entrada (tabela única §3.10); 4 = recusa do PRÓPRIO bloco (árvore, runtime, variável, destino);
// outro código (127 linha perdida, 130 Ctrl-C, 143 sinal) ou ausência da linha = parar e ler.
// Este gerador só lê arquivos e escreve os blocos; não conecta nem executa nada.
//   node scripts/bloco-shell-recuperacao-b14.cjs <staging|production> <candidata-sha40> <pasta-de-saida-inexistente>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { createHash } = require('node:crypto');
const { arvore, runtime, ENTRADA } = require('./arvore-recuperacao-b14.cjs');
const { PRODUCAO } = require('./assinatura-reconciliar.cjs');
const { STAGING } = require('./recuperacao-pagamentos-producao.cjs');

const DEPLOY = '/opt/render/project/src';
const LIMITE = 32 * 1024;
/** Carga útil máxima de uma parte da ENTREGA (o resto do bloco é cabeçalho e funções). */
const CARGA_POR_PARTE = 27 * 1024;
const AMBIENTES = Object.freeze({
    staging: Object.freeze({ servico: 'srv-daif418ae00c73e8k2gg', nome: 'kidmais-manager-staging', rotulo: 'STAGING',
        alvo: `${STAGING.database}@${STAGING.host}:${STAGING.port}` }),
    production: Object.freeze({ servico: 'srv-dak77m2d0e5s73b8rkkg', nome: 'kidmais-manager-production', rotulo: 'PRODUCAO',
        alvo: `${PRODUCAO.database}@${PRODUCAO.host}:${PRODUCAO.port}` }),
});

/**
 * Modos de operação: argumentos fixos, variáveis obrigatórias e opcionais (nome → opção da entrada), JANELA exige lib/
 * idêntica ao deploy (equivalência, §3.8) e ESCRITA marca o cabeçalho.
 */
const OPERACOES = Object.freeze({
    FILA: { fixos: ['--fila'], obrig: { URL_WEBHOOK: 'url-webhook' }, opc: {}, comum: false },
    DRENAGEM: { fixos: ['--restore', '--drenagem'], obrig: { REINICIO: 'reinicio', CONTENCAO_DESDE: 'contencao-desde' }, opc: {} },
    CONFERIR: { fixos: ['--janela', '--conferir'], obrig: { DESDE: 'desde', ATE: 'ate' }, opc: { BASE: 'base', BASE_SHA: 'base-sha', SELAR_BASE: 'selar-base' }, janela: true },
    // Linha de base E0 (P0a/P0b): mesma entrada do CONFERIR, mas com o código antigo no ar (guarda própria, equivalência informativa).
    'CONFERIR-E0': { fixos: ['--janela', '--conferir'], obrig: { DESDE: 'desde', ATE: 'ate' }, opc: { BASE: 'base', BASE_SHA: 'base-sha', SELAR_BASE: 'selar-base' }, e0: true },
    RECUPERAR: { fixos: ['--janela', '--recuperar'], obrig: { DESDE: 'desde', ATE: 'ate', BACKUP: 'backup' }, opc: {}, janela: true, escrita: true },
    INVENTARIO: { fixos: ['--restore', '--inventario'], obrig: { DESDE: 'desde', REINICIO: 'reinicio', DRENAGEM: 'drenagem' }, opc: {} },
    'APLICAR-CASO': { fixos: ['--restore'], obrig: { CASO: 'aplicar-caso', PROPOSTA: 'proposta', CASOS: 'casos', BACKUP: 'backup', RESTAURADO_EM: 'restaurado-em' }, opc: {}, escrita: true },
    'CONFERIR-CASO': { fixos: ['--restore'], obrig: { CASO: 'conferir-caso', PROPOSTA: 'proposta', CASOS: 'casos', EXECUCAO: 'execucao' }, opc: {} },
    LIBERACAO: { fixos: ['--restore', '--liberacao'], obrig: { DESDE: 'desde', REINICIO: 'reinicio', DRENAGEM: 'drenagem', DECISOES: 'decisoes', URL_WEBHOOK: 'url-webhook' },
        opc: { PROVA_CRON: 'prova-cron' } },
});
const TITULOS = Object.freeze({
    'ENTREGA-CONFERIR': ['Confere a arvore entregue inteira (SHA256SUMS fixado, nenhum arquivo a mais), o runtime (Node, pg, zod) e informa a',
        'equivalencia de lib/ com o deploy. Nao conecta ao banco. Fim esperado: ARVORE_OK.'],
    FILA: ['SOMENTE LEITURA no Asaas (GET /v3/webhooks). Nao conecta ao banco. Antes de colar: export KIDMAIS_B14_URL_WEBHOOK=<rota de producao>.'],
    DRENAGEM: ['RESTORE: prova de drenagem (sessoes anteriores ao reinicio; 2 min de amostras). Le pg_stat_activity; grava so a evidencia.',
        'Antes de colar: export KIDMAIS_B14_MIGRACOES, KIDMAIS_B14_REINICIO e KIDMAIS_B14_CONTENCAO_DESDE (ISO UTC).'],
    CONFERIR: ['JANELA --conferir: DML revertido por caso; grava so evidencias (e a base, se KIDMAIS_B14_SELAR_BASE). Exige lib/ igual ao deploy.',
        'Antes de colar: export KIDMAIS_B14_MIGRACOES, KIDMAIS_B14_DESDE, KIDMAIS_B14_ATE [KIDMAIS_B14_BASE + KIDMAIS_B14_BASE_SHA | KIDMAIS_B14_SELAR_BASE].'],
    'CONFERIR-E0': ['LINHA DE BASE E0 (P0a/P0b) com o CODIGO ANTIGO no ar: recusa se RENDER_GIT_COMMIT ausente ou igual a candidata.',
        'JANELA --conferir (DML revertido por caso); equivalencia de lib/ so informativa. Depois da promocao: usar CONFERIR, nunca este.',
        'Antes de colar: export KIDMAIS_B14_MIGRACOES, KIDMAIS_B14_DESDE, KIDMAIS_B14_ATE [KIDMAIS_B14_BASE + KIDMAIS_B14_BASE_SHA | KIDMAIS_B14_SELAR_BASE].'],
    RECUPERAR: ['ESCRITA EM PRODUCAO (JANELA --recuperar, COMMIT por caso) - somente com a autorizacao A-B14-R. Exige lib/ igual ao deploy.',
        'Antes de colar: export KIDMAIS_B14_MIGRACOES, KIDMAIS_B14_DESDE, KIDMAIS_B14_ATE e KIDMAIS_B14_BACKUP (manifesto do export).'],
    INVENTARIO: ['RESTORE --inventario: nada gravado no banco; grava o arquivo de casos (600). Web em manutencao.',
        'Antes de colar: export KIDMAIS_B14_MIGRACOES, KIDMAIS_B14_DESDE, KIDMAIS_B14_REINICIO e KIDMAIS_B14_DRENAGEM (arquivo da drenagem).'],
    'APLICAR-CASO': ['ESCRITA EM PRODUCAO (um caso aprovado) - somente com a autorizacao A-B14-O deste caso. Se parar, NAO repetir: CONFERIR-CASO.',
        'Antes de colar: export KIDMAIS_B14_MIGRACOES, KIDMAIS_B14_CASO, KIDMAIS_B14_PROPOSTA, KIDMAIS_B14_CASOS, KIDMAIS_B14_BACKUP e KIDMAIS_B14_RESTAURADO_EM.'],
    'CONFERIR-CASO': ['RESTORE --conferir-caso (COMMIT sem resposta): nada gravado. APLICADO / NAO_APLICADO / DIVERGENTE.',
        'Antes de colar: export KIDMAIS_B14_MIGRACOES, KIDMAIS_B14_CASO, KIDMAIS_B14_PROPOSTA, KIDMAIS_B14_CASOS e KIDMAIS_B14_EXECUCAO (da aplicacao).'],
    LIBERACAO: ['RESTORE --liberacao: inventario final imediatamente antes de desligar a manutencao; grava so o registro da liberacao.',
        'Antes de colar: export KIDMAIS_B14_MIGRACOES, KIDMAIS_B14_DESDE, KIDMAIS_B14_REINICIO, KIDMAIS_B14_DRENAGEM, KIDMAIS_B14_DECISOES,',
        'KIDMAIS_B14_URL_WEBHOOK [KIDMAIS_B14_PROVA_CRON com o codigo antigo no ar].'],
    LIMPEZA: ['SO NO ENCERRAMENTO do B-14: apaga TODOS os casos-*.json. Antes de colar: export KIDMAIS_B14_ENCERRAMENTO=SIM.',
        'Remove da pasta da arvore so arquivos cujo sha256 confere (divergente preservado) e os arquivos de casos (D-B14-8).',
        'Nunca outros arquivos do deploy nem as demais evidencias. Nao conecta ao banco.'],
});
const sha = (b) => createHash('sha256').update(b).digest('hex');
const absoluto = (d) => { assert.match(d, /^(?:[A-Za-z]:)?\/[A-Za-z0-9_./-]+$/, 'DESTINO_INVALIDO'); return d; };

/** Partes da ENTREGA: arquivos (gzip+base64 determinístico) agrupados até a carga por parte, na ordem da árvore. */
function partes(a) {
    const r = [];
    let atual = [], carga = 0;
    for (const x of a.arquivos) {
        const b64 = zlib.gzipSync(x.conteudo, { level: 9 }).toString('base64').match(/.{1,76}/g);
        const tamanho = b64.reduce((t, l) => t + l.length + 1, 0) + 200;
        if (atual.length && carga + tamanho > CARGA_POR_PARTE) { r.push(atual); atual = []; carga = 0; }
        atual.push({ ...x, b64 });
        carga += tamanho;
    }
    if (atual.length) r.push(atual);
    return r;
}

/** Nomes dos blocos de um conjunto: as partes da entrega e os demais. */
function nomes(n) {
    return [...Array.from({ length: n }, (_, i) => `ENTREGA-${i + 1}`), 'ENTREGA-CONFERIR', ...Object.keys(OPERACOES), 'LIMPEZA'];
}

/**
 * Gera um bloco. `deploy`, `evidencias` e `runtimeNode` existem para os testes locais (pastas temporárias, Node local); a CLI
 * usa sempre as pastas do Render e o Node do engines.
 */
function gerar({ ambiente, bloco, candidata, raiz = path.resolve(__dirname, '..'), deploy = DEPLOY, evidencias, runtimeNode }) {
    assert.ok(Object.hasOwn(AMBIENTES, ambiente), 'AMBIENTE_DESCONHECIDO');
    assert.match(String(candidata), /^[0-9a-f]{40}$/, 'CANDIDATA_INVALIDA');
    const amb = AMBIENTES[ambiente];
    const a = arvore(raiz);
    const rt = { ...runtime(raiz), ...(runtimeNode ? { node: runtimeNode } : {}) };
    for (const v of Object.values(rt)) assert.match(v, /^[0-9]+\.[0-9]+\.[0-9]+$/, 'RUNTIME_INVALIDO');
    const ps = partes(a);
    assert.ok(nomes(ps.length).includes(bloco), 'BLOCO_DESCONHECIDO');
    absoluto(deploy);
    const pasta = `${deploy}/.kidmais-recuperacao-b14`;
    const destino = `${pasta}/${a.shaArvore.slice(0, 16)}`;
    const evid = absoluto(evidencias ?? `${deploy}/data/b14`);
    const libs = a.arquivos.filter((x) => x.arquivo.startsWith('lib/'));

    const c = ['set -euo pipefail', 'umask 077', `cd '${deploy}' || { echo "DEPLOY_INACESSIVEL"; exit 4; }`,
        'for f in sha256sum base64 gzip mktemp cut find wc node; do command -v "$f" >/dev/null || { echo "FERRAMENTA_AUSENTE $f"; exit 4; }; done',
        'h() { sha256sum "$1" | cut -d" " -f1; }'];
    // Conferência da árvore entregue, comum a todos os blocos que a usam.
    const arvoreOk = [`[ -d '${destino}' ] || { echo "ARVORE_AUSENTE: colar as ENTREGA-1..${ps.length} e a ENTREGA-CONFERIR antes"; exit 4; }`,
        `cd '${destino}'`, `[ -f SHA256SUMS ] && [ "$(h SHA256SUMS)" = '${a.shaArvore}' ] || { echo "ARVORE_MANIFESTO_DIVERGENTE"; exit 4; }`,
        'sha256sum -c --quiet SHA256SUMS || { echo "ARVORE_DIVERGENTE"; exit 4; }',
        `[ "$(find . -type f ! -name SHA256SUMS | wc -l | tr -d ' ')" = '${a.arquivos.length}' ] || { echo "ARVORE_COM_ARQUIVO_A_MAIS_OU_A_MENOS"; exit 4; }`,
        `[ "$(node -v)" = 'v${rt.node}' ] || { echo "RUNTIME_NODE_DIVERGENTE $(node -v)"; exit 4; }`,
        `for p in pg:${rt.pg} zod:${rt.zod}; do n="\${p%%:*}"; v="$(node -e 'process.stdout.write(String(require(process.argv[1]).version))' '${deploy}/node_modules/'"$n"'/package.json' 2>/dev/null || true)"; [ "$v" = "\${p#*:}" ] || { echo "RUNTIME_PACOTE_DIVERGENTE $n $v"; exit 4; }; done`];
    const eq = (rigoroso) => [
        'iguais=0; diferentes=0',
        `eq() { if [ -f '${deploy}/'"$1" ] && [ "$(h '${deploy}/'"$1")" = "$2" ]; then iguais=$((iguais+1)); else diferentes=$((diferentes+1)); ${rigoroso ? 'echo "LIB_DIFERENTE_DO_DEPLOY $1"; ' : ''}fi; }`,
        ...libs.map((x) => `eq ${x.arquivo} ${x.sha}`),
        `echo "EQUIVALENCIA_LIB iguais=$iguais diferentes=$diferentes de ${libs.length}"`,
        ...(rigoroso ? ['[ "$diferentes" = 0 ] || { echo "JANELA_EXIGE_LIB_IDENTICA_AO_DEPLOY"; exit 4; }'] : [])];

    if (bloco.startsWith('ENTREGA-') && bloco !== 'ENTREGA-CONFERIR') {
        const k = Number(bloco.slice('ENTREGA-'.length));
        const lista = ps[k - 1];
        c.push(`mkdir -p '${destino}' && cd '${destino}' || { echo "DESTINO_INACESSIVEL"; exit 4; }`,
            'T="$(mktemp -d)" || { echo "TEMPORARIO_FALHOU"; exit 4; }', "trap 'rm -rf -- \"$T\" || echo \"TEMPORARIO_NAO_REMOVIDO $T\"' EXIT",
            // Fase 1: decodificar e conferir TODOS no temporário; fase 2: nenhum presente diferente; fase 3: gravar.
            'prep() { { base64 -d | gzip -dc > "$T/$1"; } 2>/dev/null || { echo "CONTEUDO_DIVERGENTE $2"; exit 4; }; [ "$(h "$T/$1")" = "$1" ] || { echo "CONTEUDO_DIVERGENTE $2"; exit 4; }; }',
            'livre() { [ ! -e "$1" ] || [ "$(h "$1")" = "$2" ] || { echo "JA_EXISTE_DIFERENTE $1"; exit 4; }; }',
            'inst() { if [ -e "$1" ]; then echo "JA_PRESENTE $1"; else { mkdir -p "$(dirname "$1")" && cp "$T/$2" "$1"; } || { echo "GRAVACAO_FALHOU $1"; exit 4; }; echo "ESCRITO $1"; fi; }');
        for (const x of lista) c.push(`prep ${x.sha} ${x.arquivo} <<'B64'`, ...x.b64, 'B64');
        for (const x of lista) c.push(`livre ${x.arquivo} ${x.sha}`);
        for (const x of lista) c.push(`inst ${x.arquivo} ${x.sha}`);
        c.push(`echo "PARTE_OK ${k}/${ps.length} arquivos=${lista.length}"`);
    }
    else if (bloco === 'ENTREGA-CONFERIR') {
        c.push(`[ -d '${destino}' ] || { echo "ARVORE_AUSENTE: colar as ENTREGA-1..${ps.length} antes"; exit 4; }`, `cd '${destino}'`,
            'S="$(mktemp)" || { echo "TEMPORARIO_FALHOU"; exit 4; }', "trap 'rm -f -- \"$S\"' EXIT",
            "cat > \"$S\" <<'SHA256SUMS_B14'", ...a.sha256sums.trimEnd().split('\n'), 'SHA256SUMS_B14',
            `[ "$(h "$S")" = '${a.shaArvore}' ] || { echo "MANIFESTO_DO_BLOCO_CORROMPIDO"; exit 4; }`,
            'if [ -e SHA256SUMS ]; then [ "$(h SHA256SUMS)" = "$(h "$S")" ] || { echo "JA_EXISTE_DIFERENTE SHA256SUMS"; exit 4; }; else cp "$S" SHA256SUMS; fi');
        c.push(...arvoreOk.slice(2), ...eq(false), `echo "ARVORE_OK ${a.shaArvore} arquivos=${a.arquivos.length} node=v${rt.node} pg=${rt.pg} zod=${rt.zod}"`);
    }
    else if (bloco === 'LIMPEZA') {
        // Revisão do incremento 5 (observação): a LIMPEZA apaga TODOS os casos-*.json; colada antes da hora destruiria os
        // arquivos de casos ainda em uso. Exige a confirmação explícita do encerramento.
        c.push('[ "${KIDMAIS_B14_ENCERRAMENTO:-}" = SIM ] || { echo "LIMPEZA_SO_NO_ENCERRAMENTO: export KIDMAIS_B14_ENCERRAMENTO=SIM antes de colar (apaga TODOS os casos-*.json)"; exit 4; }',
            `if [ -d '${destino}' ]; then`, `cd '${destino}'`,
            'limpar() { if [ ! -e "$1" ]; then echo "AUSENTE $1"; elif [ "$(h "$1")" = "$2" ]; then rm -f -- "$1" || { echo "REMOCAO_FALHOU $1"; exit 4; }; else echo "DIVERGENTE_PRESERVADO $1"; fi; }');
        for (const x of a.arquivos) c.push(`limpar ${x.arquivo} ${x.sha}`);
        c.push(`limpar SHA256SUMS ${a.shaArvore}`, 'find . -mindepth 1 -depth -type d -empty -delete 2>/dev/null || true', `cd '${deploy}'`,
            `rmdir '${destino}' 2>/dev/null && echo "ARVORE_REMOVIDA" || echo "ARVORE_MANTIDA (arquivos divergentes preservados)"`,
            `rmdir '${pasta}' 2>/dev/null || true`, 'else echo "ARVORE_AUSENTE (nada a limpar)"; fi',
            // D-B14-8: os arquivos de casos (restritos) saem no encerramento; demais evidências ficam.
            `if [ -d '${evid}' ]; then for f in '${evid}'/casos-*.json; do [ -f "$f" ] || continue; rm -f -- "$f" || { echo "REMOCAO_FALHOU casos"; exit 4; }; echo "CASOS_REMOVIDO $(basename "$f")"; done; fi`,
            'echo LIMPEZA_FIM');
    }
    else {
        const op = OPERACOES[bloco];
        // Revisão do incremento 5 (P2): a E0 roda com o código antigo, logo lib/ difere da árvore por definição; a guarda exige
        // que o deploy NÃO seja a candidata (nem desconhecido) e a equivalência fica só informativa.
        const e0 = [`[ -n "\${RENDER_GIT_COMMIT:-}" ] && [ "$RENDER_GIT_COMMIT" != '${candidata}' ] || { echo "CONFERIR_E0_SO_COM_CODIGO_ANTIGO \${RENDER_GIT_COMMIT:-ausente}: depois da promocao usar CONFERIR"; exit 4; }`,
            'echo "CODIGO_NO_AR $RENDER_GIT_COMMIT"', ...eq(false)];
        c.push(...arvoreOk, ...(op.janela ? eq(true) : op.e0 ? e0 : []), 'echo "ARVORE_CONFERIDA"',
            // Valores da execução: variáveis KIDMAIS_B14_* exportadas antes de colar, por lista de caracteres (sem espaço,
            // aspas ou metacaracteres); a entrada valida de novo cada formato.
            'arg() { local v="${!1:-}"; [ -n "$v" ] || { echo "VARIAVEL_AUSENTE $1: export $1=<valor> antes de colar"; exit 4; }; printf "%s" "$v" | grep -Eq "^[A-Za-z0-9:._,/+-]{1,200}$" || { echo "VARIAVEL_INVALIDA $1"; exit 4; }; }',
            'A=()');
        const comum = op.comum === false ? {} : { MIGRACOES: 'migracoes' };
        for (const [v, o] of Object.entries({ ...comum, ...op.obrig })) c.push(`arg KIDMAIS_B14_${v}`, `A+=("--${o}=$KIDMAIS_B14_${v}")`);
        for (const [v, o] of Object.entries(op.opc)) c.push(`if [ -n "\${KIDMAIS_B14_${v}:-}" ]; then arg KIDMAIS_B14_${v}; A+=("--${o}=$KIDMAIS_B14_${v}"); fi`);
        if (op.comum !== false) c.push(`A+=('--candidata=${candidata}')`);
        c.push(`export KIDMAIS_B14_ALVO='${amb.alvo}'`, `mkdir -p '${evid}' || { echo "EVIDENCIAS_INACESSIVEIS"; exit 4; }`,
            'codigo=0', `node ${ENTRADA} ${op.fixos.join(' ')} "\${A[@]}" '--saida=${evid}' || codigo=$?`,
            `echo '=== EVIDENCIAS (${evid}, mais recentes) ==='`, `ls -1t '${evid}' 2>/dev/null | head -12 || echo SEM_EVIDENCIAS`, 'exit "$codigo"');
    }

    const titulo = bloco.startsWith('ENTREGA-') && bloco !== 'ENTREGA-CONFERIR'
        ? [`Parte ${bloco.slice(8)}/${ps.length} da arvore minima ${a.shaArvore.slice(0, 16)}: grava so na pasta propria (efemera). Nao conecta ao banco.`]
        : TITULOS[bloco];
    const linhas = ['#!/usr/bin/env bash',
        `# BLOCO-SHELL-B14-${amb.rotulo}-${bloco} - Web Shell do ${amb.servico} (${amb.nome}). Colar inteiro, uma vez, e Enter.`,
        ...titulo.map((t) => '# ' + t),
        `# Arvore ${a.shaArvore} (${a.arquivos.length} arquivos); candidata ${candidata}. Gerado por scripts/bloco-shell-recuperacao-b14.cjs.`,
        '# Conferir sha256 e bytes deste bloco antes de colar. Prompt ">" depois de colar = colagem incompleta: Ctrl-C, nunca colar por cima.',
        '# Fim esperado: CODIGO_SAIDA_BLOCO=<n> (0/1/2/3 entrada, 4 bloco). Outro codigo (127, 130, 143...) ou sem essa linha = parar e ler.',
        '# O bind abaixo roda ANTES da guarda e FORA do subshell: desliga o bracketed paste pelo resto desta sessao. A guarda de',
        '# RENDER_SERVICE_ID vem antes de qualquer leitura/gravacao. Corpo em subshell: opcoes, trap, umask e cwd nao vazam.',
        "bind 'set enable-bracketed-paste off' 2>/dev/null",
        `if [ "$RENDER_SERVICE_ID" != "${amb.servico}" ]; then echo "SHELL_ERRADO_NAO_E_${amb.rotulo} ($RENDER_SERVICE_ID): nada executado"; else`,
        '(', ...c, ')', 'echo "CODIGO_SAIDA_BLOCO=$?"', 'fi'];
    const texto = linhas.join('\n') + '\n';
    assert.match(texto, /^[\x09\x0a\x20-\x7e]*$/, 'BLOCO_NAO_ASCII');
    assert.ok(Buffer.byteLength(texto) <= LIMITE, `BLOCO_MAIOR_QUE_32KB ${bloco} ${Buffer.byteLength(texto)}`);
    return texto;
}

/** Todos os blocos de um ambiente (para gerar e para os testes). */
function todos(o) {
    const n = partes(arvore(o.raiz ?? path.resolve(__dirname, '..'))).length;
    return nomes(n).map((bloco) => ({ bloco, texto: gerar({ ...o, bloco }) }));
}
const nomeArquivo = (ambiente, bloco) => `BLOCO-SHELL-B14-${AMBIENTES[ambiente].rotulo}-${bloco}.sh`;

if (require.main === module) {
    try {
        const [ambiente, candidata, saida] = process.argv.slice(2);
        assert.ok(saida && !fs.existsSync(saida), 'PASTA_DE_SAIDA_INVALIDA_OU_EXISTENTE');
        const lista = todos({ ambiente, candidata });
        fs.mkdirSync(saida, { recursive: true });
        for (const { bloco, texto } of lista) {
            fs.writeFileSync(path.join(saida, nomeArquivo(ambiente, bloco)), texto, { flag: 'wx' });
            console.log(`${sha(Buffer.from(texto, 'utf8'))}  ${Buffer.byteLength(texto, 'utf8')}  ${nomeArquivo(ambiente, bloco)}`);
        }
    }
    catch (e) { console.error(`RECUSADO ${String(e?.message ?? e).slice(0, 200)}`); process.exitCode = 1; }
}

module.exports = { DEPLOY, LIMITE, AMBIENTES, OPERACOES, partes, nomes, gerar, todos, nomeArquivo };
