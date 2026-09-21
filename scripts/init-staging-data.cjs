/* eslint-disable @typescript-eslint/no-require-imports -- Inicializador operacional CommonJS. */
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const CONTEUDO_INICIAL = JSON.stringify({ pacoteOverrides: [], descontos: [] }, null, 2) + '\n';

function caminhoDisponibilidade(cwd = process.cwd()) {
  return path.join(cwd, 'data', 'disponibilidade.json');
}

function validarConteudo(conteudo) {
  let config;
  try {
    config = JSON.parse(conteudo);
  } catch {
    throw new Error('data/disponibilidade.json contém JSON inválido.');
  }
  if (
    !config ||
    typeof config !== 'object' ||
    Array.isArray(config) ||
    !Array.isArray(config.pacoteOverrides) ||
    !Array.isArray(config.descontos)
  ) {
    throw new Error('data/disponibilidade.json não possui a estrutura esperada.');
  }
}

async function lerEValidar(arquivo) {
  let conteudo;
  try {
    conteudo = await fs.readFile(arquivo, 'utf8');
  } catch (error) {
    throw new Error(
      `Não foi possível ler data/disponibilidade.json: ${error instanceof Error ? error.code ?? error.name : 'erro'}.`,
    );
  }
  validarConteudo(conteudo);
}

async function inicializarDadosStaging({ env = process.env, cwd = process.cwd() } = {}) {
  if (env.KIDMAIS_DEPLOY_ENV !== 'staging') {
    throw new Error('Inicialização de data recusada: KIDMAIS_DEPLOY_ENV deve ser staging.');
  }

  const arquivo = caminhoDisponibilidade(cwd);
  const diretorio = path.dirname(arquivo);
  await fs.mkdir(diretorio, { recursive: true });

  try {
    await lerEValidar(arquivo);
    return { criado: false, arquivo };
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('ENOENT')) throw error;
  }

  const temporario = path.join(diretorio, `.disponibilidade.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporario, 'wx', 0o600);
    await handle.writeFile(CONTEUDO_INICIAL, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;

    try {
      await fs.link(temporario, arquivo);
    } catch (error) {
      if (!(error instanceof Error) || error.code !== 'EEXIST') throw error;
    }
    await lerEValidar(arquivo);
    return { criado: true, arquivo };
  } catch (error) {
    throw new Error(
      `Não foi possível inicializar data/disponibilidade.json: ${error instanceof Error ? error.code ?? error.name : 'erro'}.`,
    );
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await fs.unlink(temporario).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
  }
}

module.exports = { caminhoDisponibilidade, inicializarDadosStaging, validarConteudo };

if (require.main === module) {
  inicializarDadosStaging()
    .then(({ criado }) => {
      console.log(criado ? 'Dados persistentes de staging inicializados.' : 'Dados persistentes de staging validados.');
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : 'Falha ao inicializar dados persistentes de staging.');
      process.exitCode = 1;
    });
}
