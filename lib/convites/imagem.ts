import sharp from 'sharp';
import { ConviteError, exigir } from './domain.ts';

export const MODELO = 'gemini-nano-banana-2.1';
export const MODELO_OPENAI = 'gpt-image-2.5-flare';
export function provedorImagem(env: NodeJS.ProcessEnv = process.env) { return env.CONVITES_IA_PROVIDER ?? 'gemini'; }
export function modeloImagem(env: NodeJS.ProcessEnv = process.env) { return provedorImagem(env) === 'openai' ? MODELO_OPENAI : MODELO; }
export function iaConfigurada(env: NodeJS.ProcessEnv = process.env) {
  const provedor = provedorImagem(env);
  const chave = provedor === 'openai' ? env.CONVITES_OPENAI_API_KEY ?? env.OPENAI_API_KEY : env.CONVITES_GEMINI_API_KEY;
  return ['gemini', 'openai'].includes(provedor) && env.CONVITES_IA_ENABLED === 'true' && !!chave?.trim()
    && Number(env.CONVITES_IA_TETO_DIARIO_MICROUSD) >= 300000;
}
export async function normalizarImagem(data: string): Promise<Buffer> {
  exigir(data.length <= 7_000_000, 'Envie uma imagem de até 5 MB.', 413);
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(data);
  exigir(m, 'Use PNG, JPEG ou WebP.', 400);
  const bytes = Buffer.from(m[2], 'base64');
  exigir(bytes.length <= 5_000_000, 'Envie uma imagem de até 5 MB.', 413);
  try {
    const image = sharp(bytes, { limitInputPixels: 20_000_000, animated: false });
    const meta = await image.metadata();
    exigir(['png', 'jpeg', 'webp'].includes(meta.format ?? '') && (meta.pages ?? 1) === 1, 'Imagem inválida.', 400);
    const result = await image.rotate().resize({ width: 1400, height: 1400, fit: 'inside', withoutEnlargement: true }).webp({ quality: 85 }).toBuffer();
    exigir(result.length <= 1_500_000, 'Imagem muito grande. Reduza a resolução.', 413);
    return result;
  } catch { throw new ConviteError('Não foi possível ler a imagem. Use um PNG, JPEG ou WebP válido.', 400); }
}

// Saída completa mantém resolução e proporção; referências continuam com limites de upload.
async function normalizarConvitePNG(data: string): Promise<Buffer> {
  exigir(data.length <= 22_000_000 && /^[A-Za-z0-9+/=]+$/.test(data), 'Saída de imagem inválida.', 400);
  const bytes = Buffer.from(data, 'base64');
  exigir(bytes.length <= 16_000_000, 'Saída de imagem muito grande.', 413);
  try {
    const image = sharp(bytes, { limitInputPixels: 20_000_000, animated: false });
    const meta = await image.metadata();
    exigir(['png', 'jpeg', 'webp'].includes(meta.format ?? '') && (meta.pages ?? 1) === 1, 'Imagem inválida.', 400);
    return await image.rotate().png().toBuffer();
  } catch { throw new FalhaProvedorImagem('resposta_imagem_invalida'); }
}

type Bloco = { type?: string; data?: string; mime_type?: string };
type Resposta = { status?: string; output_image?: Bloco; steps?: { type?: string; content?: Bloco[] }[]; usage?: Record<string, unknown> };
export class FalhaProvedorImagem extends Error {
  readonly diagnostico: string;
  readonly detalhes?: { requestId?: string; etapa?: string; categorias?: string[] };
  constructor(diagnostico: string, detalhes?: FalhaProvedorImagem['detalhes']) { super('Falha no provedor de imagem.'); this.diagnostico = diagnostico; this.detalhes = detalhes; }
}
export function extrairImagem(resposta: Resposta) {
  const imagemDireta = resposta.output_image ? { ...resposta.output_image, type: resposta.output_image.type ?? 'image' } : undefined;
  const imagemValida = (b: Bloco) => b.type === 'image' && b.data && ['image/png', 'image/jpeg', 'image/webp'].includes(b.mime_type ?? '');
  const diretaValida = imagemDireta && imagemValida(imagemDireta) ? [imagemDireta] : [];
  const imagens = diretaValida.length ? diretaValida
    : (resposta.steps?.filter(s => s.type === 'model_output').flatMap(s => s.content ?? []).filter(imagemValida) ?? []);
  if (imagens.length !== 1) throw new FalhaProvedorImagem('resposta_sem_imagem_unica');
  return `data:${imagens[0].mime_type};base64,${imagens[0].data}`;
}
export async function gerarImagem(prompt: string, refs: Buffer[], enviar: typeof fetch = fetch, env: NodeJS.ProcessEnv = process.env) {
  exigir(iaConfigurada(env), 'IA indisponível.', 503);
  if (provedorImagem(env) === 'openai') return gerarImagemOpenAI(prompt, refs, enviar, env);
  const input = [{ type: 'text', text: `Crie uma arte vertical de convite de festa. Deixe nome, data, horário e endereço fora da arte: serão aplicados pelo editor. Siga este pedido visual: ${prompt}` },
    ...refs.map(b => ({ type: 'image', mime_type: 'image/webp', data: b.toString('base64') }))];
  const r = await enviar('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.CONVITES_GEMINI_API_KEY! },
    body: JSON.stringify({ model: MODELO, input, store: false, response_format: { type: 'image', aspect_ratio: '3:4', image_size: '1K' }, generation_config: { max_output_tokens: 4096 } }),
    redirect: 'error', signal: AbortSignal.timeout(120_000),
  });
  if (!r.ok) throw new FalhaProvedorImagem(`http_${r.status}`);
  // Não persiste prompt nem corpo de erro do provedor, que podem conter dados pessoais.
  let body: Resposta;
  try { body = await r.json() as Resposta; }
  catch { throw new FalhaProvedorImagem('resposta_json_invalida'); }
  return { imagem: await normalizarImagem(extrairImagem(body)), uso: body.usage ?? {} };
}

// Convite completo (arte + textos) só com OpenAI configurado no servidor; nunca troca de provedor.
export const MODELO_COMPLETO = 'gpt-image-2.5-sunburst';
export const QUALIDADE_COMPLETO = 'xhigh';
export function completoDisponivel(env: NodeJS.ProcessEnv = process.env) { return provedorImagem(env) === 'openai' && iaConfigurada(env); }

// A coluna convite_artes.imagem aceita até 1,5 MB: WebP nas dimensões originais, sem recorte nem redução.
export async function armazenarConviteCompleto(png: Buffer) {
  for (const quality of [92, 85, 78]) {
    const webp = await sharp(png, { limitInputPixels: 20_000_000 }).webp({ quality, effort: 5 }).toBuffer();
    if (webp.length <= 1_500_000) return webp;
  }
  throw new FalhaProvedorImagem('resposta_imagem_grande');
}

// Bytes da imagem de uma resposta 2xx, com as mesmas regras de extração dos adaptadores, para guardá-los antes do
// processamento local. Não guarda o corpo inteiro (pode repetir o pedido); resposta fora do formato devolve null.
export function imagemDaResposta(url: string, corpo: unknown): Buffer | null {
  try {
    if (url.startsWith('https://api.openai.com/')) {
      const r = corpo as { data?: { b64_json?: unknown }[] };
      const b64 = Array.isArray(r?.data) && r.data.length === 1 ? r.data[0]?.b64_json : undefined;
      if (typeof b64 !== 'string' || !b64.length || b64.length > 22_000_000 || !/^[A-Za-z0-9+/=]+$/.test(b64)) return null;
      return Buffer.from(b64, 'base64');
    }
    const dataUrl = extrairImagem(corpo as Resposta);
    return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
  } catch { return null; }
}
// Reprocessa uma imagem já recebida e guardada (recuperação sem nova chamada): mesmo caminho da geração original.
export async function processarImagemRecebida(bytes: Buffer, completo: boolean) {
  const b64 = bytes.toString('base64');
  return completo ? armazenarConviteCompleto(await normalizarConvitePNG(b64)) : normalizarImagem(`data:image/webp;base64,${b64}`);
}

// Modelo, resolução e qualidade definidos pelo servidor; sem fallback/retry pago.
export async function gerarConviteCompletoOpenAI(prompt: string, enviar: typeof fetch, env: NodeJS.ProcessEnv, qualidade = QUALIDADE_COMPLETO, refs: Buffer[] = []) {
  exigir(completoDisponivel(env), 'O convite completo ainda não está disponível neste ambiente.', 503);
  exigir(['high', 'xhigh', 'max'].includes(qualidade), 'Qualidade inválida.', 400);
  exigir(refs.length <= 2, 'Use no máximo duas referências.', 400);
  return gerarImagemOpenAI(prompt, refs, enviar, env, true, qualidade);
}
async function gerarImagemOpenAI(prompt: string, refs: Buffer[], enviar: typeof fetch, env: NodeJS.ProcessEnv, completo = false, qualidade = 'high') {
  const descricao = completo ? prompt : `Crie uma ilustração vertical para um convite infantil, com composição profissional e espaço para os textos aplicados pelo editor. Não inclua letras, nomes, números, idade, data, horário, endereço ou telefone, nem invente dados da festa. Para temas de filmes e personagens, use uma ilustração cartoon original inspirada no tema, sem logotipos. Pedido visual: ${prompt}`;
  const parametros = { model: completo ? MODELO_COMPLETO : MODELO_OPENAI, prompt: descricao, n: 1, size: completo ? '1024x1536' : '768x1024', quality: completo ? qualidade : 'medium', output_format: completo ? 'png' : 'webp', ...(completo ? { background: 'opaque' } : {}) };
  const headers: Record<string, string> = { Authorization: `Bearer ${env.CONVITES_OPENAI_API_KEY ?? env.OPENAI_API_KEY}` };
  let body: string | FormData;
  if (refs.length) {
    const form = new FormData();
    for (const [k, v] of Object.entries(parametros)) form.set(k, String(v));
    for (const [n, b] of refs.entries()) form.append('image[]', new Blob([new Uint8Array(b)], { type: 'image/webp' }), `referencia-${n}.webp`);
    body = form;
  } else { headers['Content-Type'] = 'application/json'; body = JSON.stringify(parametros); }
  let r: Response;
  try {
    r = await enviar(`https://api.openai.com/v1/images/${refs.length ? 'edits' : 'generations'}`, {
      method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(120_000),
    });
  } catch { throw new FalhaProvedorImagem('rede_ou_timeout'); }
  if (!r.ok) {
    // Nunca guardar a mensagem livre: ela pode repetir prompt, foto ou dados pessoais.
    let diagnostico = `http_${r.status}`;
    const detalhes: NonNullable<FalhaProvedorImagem['detalhes']> = {};
    const requestId = r.headers.get('x-request-id');
    if (requestId && /^req_[a-zA-Z0-9_-]{1,128}$/.test(requestId)) detalhes.requestId = requestId;
    try {
      const body = await r.json();
      const codigo = body?.error?.code;
      if (codigo === 'moderation_blocked') {
        const moderation = body?.error?.moderation_details;
        if (['input', 'output', 'unknown'].includes(moderation?.moderation_stage)) detalhes.etapa = moderation.moderation_stage;
        const categorias = ['harassment', 'hate', 'self-harm', 'sexual', 'violence', 'illicit', 'other'];
        if (Array.isArray(moderation?.categories)) detalhes.categorias = [...new Set(moderation.categories.filter((c: unknown): c is string => typeof c === 'string' && categorias.includes(c)))].slice(0, categorias.length) as string[];
      }
      if (['moderation_blocked', 'insufficient_quota', 'invalid_api_key', 'model_not_found'].includes(codigo)) diagnostico += `_${codigo}`;
      else if (body?.error?.type === 'invalid_request_error') {
        diagnostico += '_pedido_invalido';
        if (['image', 'image[]', 'prompt', 'model', 'quality', 'size', 'output_format'].includes(body.error.param)) diagnostico += `_${body.error.param}`;
      }
    } catch { /* HTTP continua disponível mesmo sem JSON válido. */ }
    throw new FalhaProvedorImagem(diagnostico, Object.keys(detalhes).length ? detalhes : undefined);
  }
  let resposta: { data?: { b64_json?: string }[]; usage?: Record<string, unknown> };
  try { resposta = await r.json(); } catch { throw new FalhaProvedorImagem('resposta_json_invalida'); }
  if (!Array.isArray(resposta.data) || resposta.data.length !== 1 || typeof resposta.data[0]?.b64_json !== 'string') throw new FalhaProvedorImagem('resposta_sem_imagem_unica');
  return { imagem: completo ? await normalizarConvitePNG(resposta.data[0].b64_json) : await normalizarImagem(`data:image/webp;base64,${resposta.data[0].b64_json}`), uso: resposta.usage ?? {} };
}
