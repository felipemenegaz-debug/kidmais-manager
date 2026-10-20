// Guarda de rede da avaliação do Wall-e (cópia da guarda da demonstração). Sem dependências; testada só com mocks (teste-guarda-rede.mjs).
//
// Modo "regras": toda chamada de rede é recusada.
// Modo "ia": só https://api.openai.com/v1/... — URL conferida campo a campo (protocolo, host exato, porta padrão, sem
// usuário/senha, caminho /v1/). A chamada sai SEMPRE com redirect: 'error' (o fetch não segue redirecionamento, mesmo que
// quem chama peça 'follow' ou passe um Request com outro modo) e, por garantia, resposta 3xx ou marcada como
// redirecionada é recusada antes de chegar a quem chamou.
export const ERRO_DESTINO = 'REDE_PROIBIDA_NA_DEMONSTRACAO';
export const ERRO_REDIRECIONAMENTO = 'REDIRECIONAMENTO_RECUSADO';

export function urlDoAlvo(alvo) {
  if (typeof alvo === 'string') return alvo;
  if (alvo instanceof URL) return alvo.href;
  if (alvo && typeof alvo.url === 'string') return alvo.url;
  return null;
}

export function destinoPermitido(modo, texto) {
  if (modo !== 'ia' || typeof texto !== 'string') return false;
  let u;
  try { u = new URL(texto); } catch { return false; }
  return u.protocol === 'https:' && u.hostname === 'api.openai.com' && u.port === '' && !u.username && !u.password && u.pathname.startsWith('/v1/');
}

// Origem só para registro (nunca caminho, consulta ou credencial).
const origem = (texto) => { try { return new URL(texto).origin; } catch { return 'inválido'; } };

export function criarFetchProtegido(modo, fetchOriginal, avisar = () => {}) {
  if (modo !== 'regras' && modo !== 'ia') throw new Error('modo de rede inválido');
  if (typeof fetchOriginal !== 'function') throw new Error('fetch original ausente');
  return async function fetchProtegido(alvo, opcoes) {
    const url = urlDoAlvo(alvo);
    if (!destinoPermitido(modo, url)) { avisar({ evento: 'destino recusado', origem: origem(url) }); throw new Error(ERRO_DESTINO); }
    const resposta = await fetchOriginal(alvo, { ...(opcoes ?? {}), redirect: 'error' });
    if (resposta?.redirected === true || (Number(resposta?.status) >= 300 && Number(resposta?.status) < 400)) {
      avisar({ evento: 'redirecionamento recusado', origem: origem(url), status: Number(resposta?.status) || null });
      throw new Error(ERRO_REDIRECIONAMENTO);
    }
    return resposta;
  };
}
