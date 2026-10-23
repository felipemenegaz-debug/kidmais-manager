/* eslint-disable @typescript-eslint/no-require-imports */
// V6 da abertura da venda (20/10/2026): PROVA DE ENTREGA DE E-MAIL EM PRODUÇÃO, equivalente ao E0 de staging
// (scripts/email-staging-lancamento.cjs). Roda no Web Shell do srv-dak77m2d0e5s73b8rkkg, a partir da pasta própria
// montada pelo bloco de Shell (scripts/bloco-shell-email-producao-20261020.cjs). Nenhum banco, cadastro ou cobrança.
//   --plano               só imprime as constantes (destinatário, registro, sha do transporte); não lê ambiente nem disco
//   --conferir            SOMENTE LEITURA: guarda, env, flags, transporte (sha), disco e registro; não grava nem envia
//   --enviar-autorizado   UM envio real pelo transporte do produto (lib/acessos/email.ts do deploy), sem retentativa
// Códigos de saída: 0 = CONFERIDO/ACEITO; 1 = recusado ANTES de gravar ou enviar (nada gravado, nada enviado);
// 2 = intenção gravada e envio falhou ou ficou incerto (NÃO repetir); 3 = registro já existe (replay recusado).
// Nunca imprime o valor de RESEND_API_KEY, cabeçalhos, corpo de resposta do provedor ou mensagens brutas de erro.
const fs = require('node:fs');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');
const {pathToFileURL} = require('node:url');

const SERVICO = 'srv-dak77m2d0e5s73b8rkkg';
const DEPLOY = '/opt/render/project/src';
const DISCO_REL = 'data';
const PASTA_REL = 'data/lancamento-email-producao-20261020';
const REGISTRO_NOME = 'teste-envio.json';
const REMETENTE = 'Kidmais Manager <nao-responda@notificacoes.kidmaisfestas.com>';
/** Destinatário FIXO: canal oficial (contato@demerzellabs.com.br). Não há parâmetro de destinatário. */
const DESTINATARIO = 'contato@demerzellabs.com.br';
const ASSUNTO = '[TESTE] Kidmais Manager: prova de e-mail de producao';
const IDEMPOTENCIA_PREFIXO = 'kidmais-email-producao-20261020/';
/** Flags da venda: devem estar desligadas (ausentes ou "false"); qualquer outro valor recusa antes de tudo (§2 do doc). */
const FLAGS_VENDA = Object.freeze(['CADASTRO_PUBLICO_ATIVO', 'ASSINATURA_PLANOS_ATIVOS', 'RECUPERACAO_SENHA_ATIVA']);
/**
 * Transporte do produto conferido por conteúdo (LF): o mesmo módulo que o app usa. email.ts da árvore 7ce0916 (production),
 * inalterado. erros.ts REVALIDADO em 23/10/2026 para a integração CPF/Fundador + textos/comprovante + arrependimento: a
 * mudança desde 883b0944… (7ce0916) é só de TIPO — novos códigos na união AcessoErroCodigo, sem efeito em execução; o
 * JavaScript emitido pelo TypeScript é idêntico nas duas versões (docs/EMAIL_PRODUCAO_20261020.md, "Revalidação de
 * 23/10/2026"). Com este hash, o utilitário recusa um deploy que ainda tenha o erros.ts antigo (produção atual).
 */
const TRANSPORTE = Object.freeze({
  'lib/acessos/email.ts': '0ff9c1388da510f5ca4f145831ee285bdd41984e670a19107f83b1152af0363b',
  'lib/acessos/erros.ts': '77ebaaf0791d82f38464869f57d94bbd494ad70bb19ad83e1be9d56da0ea3dd1',
});
const MOTIVO = /^[A-Z][A-Z0-9_]{2,60}(?: [A-Z][A-Z0-9_]{2,60})?$/;

class Recusa extends Error {
  constructor(motivo, codigo = 1) { super(motivo); this.name = 'Recusa'; this.motivo = motivo; this.codigo = codigo; }
}
const exigir = (cond, motivo, codigo = 1) => { if (!cond) throw new Recusa(motivo, codigo); };
const sha = b => createHash('sha256').update(b).digest('hex');

/** Situação de uma flag: "desligada" só se ausente, vazia ou "false" (sem distinguir caixa/espaços). */
function estadoFlag(v) {
  if (v === undefined || v.trim() === '' || v.trim().toLowerCase() === 'false') return 'desligada';
  return v.trim().toLowerCase() === 'true' ? 'ligada' : 'valor_inesperado';
}

/** Só presença, tamanho e prefixo da chave; nunca o valor. */
function resumoChave(v) {
  return {presente: typeof v === 'string' && v.length > 0, tamanho: typeof v === 'string' ? v.length : 0, prefixoRe: typeof v === 'string' && v.startsWith('re_')};
}

/** Guarda de alvo antes de tudo; depois env do e-mail e flags. Não lê disco nem rede. */
function validar(env) {
  exigir(env.RENDER_SERVICE_ID === SERVICO, 'SERVICO_RECUSADO');
  exigir(env.RENDER === 'true', 'FORA_DO_RENDER');
  exigir(env.KIDMAIS_DEPLOY_ENV === 'production', 'AMBIENTE_RECUSADO');
  exigir(env.EMAIL_PROVIDER === 'resend', 'EMAIL_PROVIDER_DIVERGENTE');
  exigir(env.EMAIL_REMETENTE === REMETENTE, 'EMAIL_REMETENTE_DIVERGENTE');
  const chave = env.RESEND_API_KEY;
  exigir(typeof chave === 'string' && chave.length > 0, 'RESEND_API_KEY_AUSENTE');
  exigir(/^re_[A-Za-z0-9_-]{8,200}$/.test(chave), 'RESEND_API_KEY_FORMATO');
  for (const k of FLAGS_VENDA) {
    const e = estadoFlag(env[k]);
    exigir(e === 'desligada', (e === 'ligada' ? 'FLAG_VENDA_LIGADA ' : 'FLAG_VENDA_VALOR_INESPERADO ') + k);
  }
  return {chave: resumoChave(chave), flags: Object.fromEntries(FLAGS_VENDA.map(k => [k, estadoFlag(env[k])]))};
}

/** Disco persistente montado (dispositivo diferente do pai) e não link; pasta do registro, se existir, não é link. */
function conferirDisco(raiz, discoFs) {
  const disco = path.posix.join(raiz, DISCO_REL);
  let d, pai;
  try { d = discoFs.lstatSync(disco); pai = discoFs.statSync(path.posix.dirname(disco)); } catch { throw new Recusa('DISCO_PERSISTENTE_AUSENTE'); }
  exigir(d.isDirectory() && !d.isSymbolicLink() && d.dev !== pai.dev, 'DISCO_PERSISTENTE_AUSENTE');
  const pasta = path.posix.join(raiz, PASTA_REL);
  let p = null;
  try { p = discoFs.lstatSync(pasta); } catch (e) { if (e?.code !== 'ENOENT') throw new Recusa('PASTA_REGISTRO_ILEGIVEL'); }
  exigir(p === null || (p.isDirectory() && !p.isSymbolicLink()), 'PASTA_REGISTRO_RECUSADA');
  return {pasta, registro: path.posix.join(pasta, REGISTRO_NOME), pastaExiste: p !== null};
}

function conferirTransporte(raiz, discoFs) {
  for (const [rel, esperado] of Object.entries(TRANSPORTE)) {
    let b;
    try { b = discoFs.readFileSync(path.posix.join(raiz, rel)); } catch { throw new Recusa('TRANSPORTE_AUSENTE ' + rel.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase()); }
    exigir(sha(b) === esperado, 'TRANSPORTE_DIVERGENTE ' + path.posix.basename(rel, '.ts').toUpperCase());
  }
}

function existe(discoFs, arquivo) {
  try { discoFs.lstatSync(arquivo); return true; } catch (e) { if (e?.code === 'ENOENT') return false; throw new Recusa('REGISTRO_ILEGIVEL'); }
}

const carregarPadrao = raiz => import(pathToFileURL(path.posix.join(raiz, 'lib/acessos/email.ts')).href);
/** Só as chaves que o transporte lê: nada mais do ambiente chega ao módulo. */
const ambienteEmail = env => ({EMAIL_PROVIDER: env.EMAIL_PROVIDER, EMAIL_REMETENTE: env.EMAIL_REMETENTE, RESEND_API_KEY: env.RESEND_API_KEY,
  NODE_ENV: env.NODE_ENV, RENDER: env.RENDER, KIDMAIS_DEPLOY_ENV: env.KIDMAIS_DEPLOY_ENV});

/** Carrega o transporte (sem efeito colateral) e confere que o PRÓPRIO produto o considera configurado. */
async function carregarTransporte(env, raiz, carregar) {
  let modulo;
  try { modulo = await (carregar ? carregar() : carregarPadrao(raiz)); } catch { throw new Recusa('TRANSPORTE_NAO_CARREGOU'); }
  exigir(typeof modulo?.criarEnviarEmail === 'function' && typeof modulo?.situacaoEmail === 'function', 'TRANSPORTE_INCOMPATIVEL');
  let s;
  try { s = modulo.situacaoEmail(ambienteEmail(env)); } catch { throw new Recusa('TRANSPORTE_INCOMPATIVEL'); }
  exigir(s?.configurado === true && s?.provedor === 'resend', 'EMAIL_NAO_CONFIGURADO_NO_PRODUTO');
  return modulo;
}

function mensagem(idempotencia) {
  return {
    para: DESTINATARIO, assunto: ASSUNTO, idempotencia,
    texto: 'Teste autorizado do transporte de e-mail do Kidmais Manager em PRODUCAO (prova V6 da abertura da venda).\n\n'
      + 'Envio unico ao canal oficial. Nenhuma conta, empresa ou cobranca foi criada. Esta mensagem nao contem link de acesso.',
    html: '<p>Teste autorizado do transporte de e-mail do Kidmais Manager em <strong>produ&ccedil;&atilde;o</strong> (prova V6 da abertura da venda).</p>'
      + '<p>Envio &uacute;nico ao canal oficial. Nenhuma conta, empresa ou cobran&ccedil;a foi criada. Esta mensagem n&atilde;o cont&eacute;m link de acesso.</p>',
  };
}

/** Situação final de uma falha do transporte: recusa HTTP do provedor = nada enviado; o resto = incerto. */
function situacaoFalha(e) {
  const m = typeof e?.message === 'string' ? e.message : '';
  if (e?.code === 'EMAIL_NAO_CONFIGURADO') return 'NAO_ENVIADO_CONFIGURACAO_NAO_REPETIR';
  if (e?.code === 'EMAIL_FALHOU' && /recusou/.test(m)) return 'RECUSADO_PROVEDOR_NADA_ENVIADO_NAO_REPETIR';
  return 'FALHA_OU_ENVIO_INCERTO_NAO_REPETIR';
}

/** Leitura sem gravação: pronto para o envio? */
async function conferir({env = process.env, raiz = DEPLOY, discoFs = fs, carregar} = {}) {
  const v = validar(env);
  conferirTransporte(raiz, discoFs);
  const d = conferirDisco(raiz, discoFs);
  exigir(!existe(discoFs, d.registro), 'REGISTRO_JA_EXISTE_REPLAY_RECUSADO', 3);
  await carregarTransporte(env, raiz, carregar);
  return {resultado: 'CONFERIDO_PRONTO_PARA_ENVIO', servico: SERVICO, commit: env.RENDER_GIT_COMMIT || null, destinatario: DESTINATARIO,
    registro: path.posix.join(PASTA_REL, REGISTRO_NOME), registroExiste: false, chave: v.chave, flags: v.flags, transporte: 'CONFERIDO'};
}

/**
 * Envio único. Ordem: guarda e env → transporte (sha) → disco → replay → carregar transporte → intenção gravada (wx 0600)
 * → UMA chamada → registro final. Qualquer recusa antes da intenção não grava nada (código 1 ou 3).
 */
async function enviar({env = process.env, raiz = DEPLOY, discoFs = fs, carregar, uuid = randomUUID, agora = () => new Date()} = {}) {
  const v = validar(env);
  conferirTransporte(raiz, discoFs);
  const d = conferirDisco(raiz, discoFs);
  exigir(!existe(discoFs, d.registro), 'REGISTRO_JA_EXISTE_REPLAY_RECUSADO', 3);
  const modulo = await carregarTransporte(env, raiz, carregar);
  try { discoFs.mkdirSync(d.pasta, {recursive: true, mode: 0o700}); } catch { throw new Recusa('PASTA_REGISTRO_FALHOU'); }
  exigir(!discoFs.lstatSync(d.pasta).isSymbolicLink(), 'PASTA_REGISTRO_RECUSADA');
  const idempotencia = IDEMPOTENCIA_PREFIXO + uuid();
  const base = {idempotencia, destinatario: DESTINATARIO, servico: SERVICO, commit: env.RENDER_GIT_COMMIT || null};
  try {
    discoFs.writeFileSync(d.registro, JSON.stringify({situacao: 'ENVIO_PREPARADO', ...base, inicio: agora().toISOString()}), {flag: 'wx', mode: 0o600});
  } catch (e) {
    throw new Recusa(e?.code === 'EEXIST' ? 'REGISTRO_JA_EXISTE_REPLAY_RECUSADO' : 'REGISTRO_NAO_GRAVADO', e?.code === 'EEXIST' ? 3 : 1);
  }
  const final = (situacao, extra = {}) => {
    try { discoFs.writeFileSync(d.registro, JSON.stringify({situacao, ...base, ...extra, em: agora().toISOString()}), {mode: 0o600}); return true; }
    catch { return false; }
  };
  let r;
  try {
    r = await modulo.criarEnviarEmail(ambienteEmail(env))(mensagem(idempotencia));
  } catch (e) {
    const situacao = situacaoFalha(e);
    const gravado = final(situacao);
    throw new Recusa(situacao + (gravado ? '' : ' REGISTRO_FINAL_NAO_GRAVADO'), 2);
  }
  const idExterno = typeof r?.idExterno === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(r.idExterno) ? r.idExterno : null;
  if (r?.provedor !== 'resend' || !idExterno) {
    const gravado = final('ACEITO_SEM_IDENTIFICADOR_NAO_REPETIR');
    throw new Recusa('ACEITO_SEM_IDENTIFICADOR_NAO_REPETIR' + (gravado ? '' : ' REGISTRO_FINAL_NAO_GRAVADO'), 2);
  }
  const gravado = final('ACEITO_PROVEDOR_ENTREGA_PENDENTE', {idExterno});
  return {resultado: 'ACEITO_PROVEDOR_ENTREGA_PENDENTE', provedor: 'resend', idExterno, destinatario: DESTINATARIO, servico: SERVICO,
    commit: base.commit, registro: path.posix.join(PASTA_REL, REGISTRO_NOME), registroFinal: gravado ? 'GRAVADO' : 'NAO_GRAVADO', chave: v.chave};
}

function plano() {
  return {resultado: 'PLANO', servico: SERVICO, destinatario: DESTINATARIO, remetente: REMETENTE, assunto: ASSUNTO,
    registro: path.posix.join(PASTA_REL, REGISTRO_NOME), flagsVenda: [...FLAGS_VENDA], transporte: {...TRANSPORTE}};
}

const MODOS = Object.freeze({'--plano': null, '--conferir': conferir, '--enviar-autorizado': enviar});

/** CLI testável: devolve o código e escreve UMA linha JSON (sem segredo, sem mensagem bruta de erro). */
async function executar(argv, opcoes = {}, escrever = l => console.log(l)) {
  if (argv.length !== 1 || !Object.hasOwn(MODOS, argv[0])) { escrever(JSON.stringify({resultado: 'RECUSADO_NADA_GRAVADO_NADA_ENVIADO', motivo: 'ARGUMENTOS_RECUSADOS'})); return 1; }
  if (argv[0] === '--plano') { escrever(JSON.stringify(plano())); return 0; }
  try {
    escrever(JSON.stringify(await MODOS[argv[0]](opcoes)));
    return 0;
  } catch (e) {
    const recusa = e instanceof Recusa;
    const motivo = recusa && MOTIVO.test(e.motivo) ? e.motivo : 'ERRO_INESPERADO';
    const codigo = recusa ? e.codigo : 2;
    const resultado = codigo === 1 ? 'RECUSADO_NADA_GRAVADO_NADA_ENVIADO' : codigo === 3 ? 'REPLAY_RECUSADO_NADA_ENVIADO' : 'ENVIO_NAO_CONCLUIDO_NAO_REPETIR';
    escrever(JSON.stringify({resultado, motivo}));
    return codigo;
  }
}

if (require.main === module) executar(process.argv.slice(2)).then(c => { process.exitCode = c; }, () => { console.log('{"resultado":"ENVIO_NAO_CONCLUIDO_NAO_REPETIR","motivo":"ERRO_INESPERADO"}'); process.exitCode = 2; });

module.exports = {SERVICO, DEPLOY, PASTA_REL, REGISTRO_NOME, REMETENTE, DESTINATARIO, ASSUNTO, FLAGS_VENDA, TRANSPORTE, Recusa,
  estadoFlag, resumoChave, validar, conferir, enviar, plano, mensagem, situacaoFalha, executar};
