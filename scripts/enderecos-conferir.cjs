#!/usr/bin/env node
// Confere /api/endereco-atual em A e N contra o modo esperado (plano D4). Obrigatório depois de todo deploy ou reinício
// com modo diferente de DESLIGADO. Só leitura; enxerga só o ambiente do web. Código de saída 1 = reprovado.
//   node scripts/enderecos-conferir.cjs --antiga <origem> --nova <origem> --modo <MODO> --mcp-sha256 <hash|AUSENTE> [--sem-nova] [--exige-tolerancia]
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
    return erros;
}

function argumentos(argv) {
    const lidos = { semNova: argv.includes('--sem-nova'), exigeTolerancia: argv.includes('--exige-tolerancia') };
    const valor = (nome) => { const i = argv.indexOf(nome); return i >= 0 ? argv[i + 1] : undefined; };
    Object.assign(lidos, { antiga: valor('--antiga'), nova: valor('--nova'), modo: valor('--modo'), mcpSha256: valor('--mcp-sha256') });
    const httpsExato = (v) => { try { const u = new URL(v); return u.protocol === 'https:' && u.origin === v; } catch { return false; } };
    if (!httpsExato(lidos.antiga) || (!lidos.semNova && !httpsExato(lidos.nova))) throw Error('ORIGEM_INVALIDA');
    if (!Object.hasOwn(ORIGEM_ATIVA, lidos.modo ?? '')) throw Error('MODO_INVALIDO');
    if (!/^([a-f0-9]{64}|AUSENTE)$/.test(lidos.mcpSha256 ?? '')) throw Error('MCP_SHA256_INVALIDO');
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
