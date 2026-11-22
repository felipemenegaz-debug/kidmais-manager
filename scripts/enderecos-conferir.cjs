#!/usr/bin/env node
// Confere /api/endereco-atual em A e N contra o modo esperado (plano D4). Obrigatório depois de todo deploy ou reinício
// com modo diferente de DESLIGADO. Só leitura; enxerga só o ambiente do web. Código de saída 1 = reprovado.
// --midia A|N (F4/M1) exige o campo midiaEm; em DESLIGADO ele é nulo e reprova, então não use --midia nesse modo.
// --mcp A|N (F4/M5) exige o campo mcpEm, com a mesma ressalva; o hash de --mcp-sha256 continua obrigatório.
//   node scripts/enderecos-conferir.cjs --antiga <origem> --nova <origem> --modo <MODO> --mcp-sha256 <hash|AUSENTE> [--sem-nova] [--exige-tolerancia] [--midia A|N] [--mcp A|N]
const ORIGEM_ATIVA = { DESLIGADO: 'INDETERMINADA', PREPARACAO: 'A', ATIVA: 'N', REVERSAO: 'A' };

/** Lista de reprovações de uma leitura. `host` é 'A' ou 'N'. Função pura. */
function avaliar(host, leitura, esperado) {
    const erros = [];
    const exige = (ok, codigo) => { if (!ok) erros.push(`${host}:${codigo}`); };
    if (!leitura || typeof leitura !== 'object') return [`${host}:SEM_RESPOSTA_VALIDA`];
    exige(leitura.modoEfetivo === esperado.modo, 'MODO_DIVERGENTE');
    exige(leitura.codigo === 'OK', `CODIGO_${leitura.codigo}`);
    exige(leitura.origemAtiva === ORIGEM_ATIVA[esperado.modo], 'ORIGEM_ATIVA_DIVERGENTE');
    const painelEmN = esperado.modo === 'ATIVA';
    exige(leitura.painelNesteHost === (host === 'N' ? painelEmN : !painelEmN), 'PAINEL_DIVERGENTE');
    exige(leitura.tolerancia !== 'INVALIDA', 'TOLERANCIA_INVALIDA');
    if (esperado.exigeTolerancia) exige(leitura.toleranciaAtiva === true, 'TOLERANCIA_INATIVA');
    if (esperado.modo !== 'DESLIGADO') {
        const coerencia = leitura.coerencia;
        exige(Boolean(coerencia), 'COERENCIA_AUSENTE');
        for (const item of ['convites', 'site', 'agenda', 'midia', 'mcp']) if (coerencia) exige(coerencia[item] === true, `COERENCIA_${item.toUpperCase()}`);
    }
    exige(leitura.mcpRecursoSha256 === esperado.mcpSha256, 'MCP_DIVERGENTE');
    // F4/M1: só com --midia; sem ele, a coerência acima já aceita A ou N escrito na variável.
    if (esperado.midia) exige(leitura.midiaEm === esperado.midia, 'MIDIA_DIVERGENTE');
    // F4/M5: só com --mcp; sem ele, a coerência aceita A ou N e o hash já prende o valor exato.
    if (esperado.mcp) exige(leitura.mcpEm === esperado.mcp, 'MCP_ORIGEM_DIVERGENTE');
    return erros;
}

const OPCOES_COM_VALOR = ['--antiga', '--nova', '--modo', '--mcp-sha256', '--midia', '--mcp'];
const OPCOES_SEM_VALOR = ['--sem-nova', '--exige-tolerancia'];

function argumentos(argv) {
    // Opção desconhecida, repetida ou na grafia --opcao=valor reprova: ignorá-la desligaria uma conferência em silêncio.
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (OPCOES_COM_VALOR.includes(a)) {
            // Valor ausente ou que é outra opção reprova: senão `--nova --mcp=N` engoliria a opção seguinte como valor.
            if (i + 1 >= argv.length || String(argv[i + 1]).startsWith('--')) throw Error('ARGUMENTO_SEM_VALOR');
            i += 1;
        }
        else if (!OPCOES_SEM_VALOR.includes(a)) throw Error('ARGUMENTO_DESCONHECIDO');
        if (argv.indexOf(a) !== argv.lastIndexOf(a)) throw Error('ARGUMENTO_REPETIDO');
    }
    const lidos = { semNova: argv.includes('--sem-nova'), exigeTolerancia: argv.includes('--exige-tolerancia') };
    const valor = (nome) => { const i = argv.indexOf(nome); return i >= 0 ? argv[i + 1] : undefined; };
    Object.assign(lidos, { antiga: valor('--antiga'), nova: valor('--nova'), modo: valor('--modo'), mcpSha256: valor('--mcp-sha256'), midia: valor('--midia'), mcp: valor('--mcp') });
    const httpsExato = (v) => { try { const u = new URL(v); return u.protocol === 'https:' && u.origin === v; } catch { return false; } };
    if (!httpsExato(lidos.antiga) || (!lidos.semNova && !httpsExato(lidos.nova))) throw Error('ORIGEM_INVALIDA');
    if (!Object.hasOwn(ORIGEM_ATIVA, lidos.modo ?? '')) throw Error('MODO_INVALIDO');
    if (!/^([a-f0-9]{64}|AUSENTE)$/.test(lidos.mcpSha256 ?? '')) throw Error('MCP_SHA256_INVALIDO');
    if (argv.includes('--midia') && !['A', 'N'].includes(lidos.midia ?? '')) throw Error('MIDIA_INVALIDA');
    if (argv.includes('--mcp') && !['A', 'N'].includes(lidos.mcp ?? '')) throw Error('MCP_ORIGEM_INVALIDA');
    return lidos;
}

async function ler(origem, buscar) {
    try {
        const r = await buscar(`${origem}/api/endereco-atual`, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000) });
        return r.ok ? await r.json() : null;
    }
    catch {
        return null;
    }
}

async function conferir(esperado, buscar = fetch) {
    const erros = avaliar('A', await ler(esperado.antiga, buscar), esperado);
    if (!esperado.semNova) erros.push(...avaliar('N', await ler(esperado.nova, buscar), esperado));
    return erros;
}

if (require.main === module) {
    (async () => {
        const erros = await conferir(argumentos(process.argv.slice(2)));
        for (const erro of erros) console.error(`REPROVADO ${erro}`);
        if (erros.length) process.exitCode = 1;
        else console.log('APROVADO');
    })().catch((erro) => { console.error(`REPROVADO ${erro.message}`); process.exitCode = 1; });
}

module.exports = { argumentos, avaliar, conferir };
