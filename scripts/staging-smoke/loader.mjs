import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);

/** Private module graph. No require.cache/require.extensions/global pool or process.env mutations. */
export function domainLoader(root, env, replacements = new Map()) {
  const cache = new Map();
  function load(file) {
    file = resolve(root, file);
    if (!file.endsWith('.ts')) file = existsSync(file + '.ts') ? file + '.ts' : resolve(file, 'index.ts');
    if (!file.startsWith(root + sep + 'lib' + sep)) throw new Error('NON_DOMAIN_IMPORT');
    if (replacements.has(file)) return replacements.get(file);
    if (cache.has(file)) return cache.get(file).exports;
    if (file.includes(sep + 'delivery' + sep)) throw new Error('OTP_PROVIDER_IMPORT_FORBIDDEN');
    const record = { exports: {} }; cache.set(file, record);
    const js = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }, fileName: file,
    }).outputText;
    const localRequire = id => id.startsWith('.') ? load(resolve(dirname(file), id))
      : id.startsWith('@/') ? load(resolve(root, id.slice(2))) : require(id);
    new Function('require', 'module', 'exports', '__filename', '__dirname', 'process', js)(
      localRequire, record, record.exports, file, dirname(file), Object.freeze({ env: Object.freeze({ ...env }), cwd: () => root }));
    return record.exports;
  }
  return load;
}

/** Same identity core; only the web provider-composition factory is replaced in this private CLI graph. */
export function composeIdentity(real, env, sender) {
  if (env.KIDMAIS_DEPLOY_ENV !== 'staging' || env.IDENTIDADE_OTP_PROVIDER !== 'gupshup'
    || env.GUPSHUP_OTP_ENABLED !== 'false' || env.KIDMAIS_STAGING_OTP_DISABLED !== 'SIM') throw new Error('OTP_GUARD');
  const factory = supplied => {
    if (supplied !== sender) throw new Error('FOREIGN_TRANSPORT_FORBIDDEN');
    return real.criarIdentityService({ otpPepper: env.IDENTIDADE_OTP_PEPPER, enviarOtp: sender });
  };
  return { ...real, criarIdentityServiceComAmbiente: factory };
}

export function memoryTransport() {
  let message;
  return {
    send: async payload => {
      if (message || !/^\d{6}$/.test(payload.codigo) || payload.destino !== '11900000000') throw new Error('INVALID_SYNTHETIC_DELIVERY');
      message = { validacaoId: payload.validacaoId, codigo: payload.codigo };
    },
    take: id => {
      if (!message || message.validacaoId !== id) throw new Error('OTP_NOT_CAPTURED');
      const code = message.codigo; message = undefined; return code;
    },
    clear: () => { message = undefined; },
  };
}
