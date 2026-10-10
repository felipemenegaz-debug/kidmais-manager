import sharp from 'sharp';
import { ConviteError, exigir } from './domain.ts';

export const MODELO = 'gemini-nano-banana-2.1';
export function iaConfigurada() {
  return process.env.CONVITES_IA_ENABLED === 'true' && !!process.env.CONVITES_GEMINI_API_KEY
    && Number(process.env.CONVITES_IA_TETO_DIARIO_MICROUSD) >= 300000;
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

type Bloco = { type?: string; data?: string; mime_type?: string };
type Resposta = { status?: string; output_image?: Bloco; steps?: { type?: string; content?: Bloco[] }[]; usage?: Record<string, unknown> };
export class FalhaProvedorImagem extends Error {
  readonly diagnostico: string;
  constructor(diagnostico: string) { super('Falha no provedor de imagem.'); this.diagnostico = diagnostico; }
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
export async function gerarImagem(prompt: string, refs: Buffer[], enviar: typeof fetch = fetch) {
  exigir(iaConfigurada(), 'IA indisponível.', 503);
  const input = [{ type: 'text', text: `Crie uma arte vertical de convite de festa. Deixe nome, data, horário e endereço fora da arte: serão aplicados pelo editor. Siga este pedido visual: ${prompt}` },
    ...refs.map(b => ({ type: 'image', mime_type: 'image/webp', data: b.toString('base64') }))];
  const r = await enviar('https://generativelanguage.googleapis.com/v1beta/interactions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.CONVITES_GEMINI_API_KEY! },
    body: JSON.stringify({ model: MODELO, input, store: false, response_format: { type: 'image', aspect_ratio: '3:4', image_size: '1K' }, generation_config: { max_output_tokens: 4096 } }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!r.ok) throw new FalhaProvedorImagem(`http_${r.status}`);
  // Não persiste prompt nem corpo de erro do provedor, que podem conter dados pessoais.
  let body: Resposta;
  try { body = await r.json() as Resposta; }
  catch { throw new FalhaProvedorImagem('resposta_json_invalida'); }
  return { imagem: await normalizarImagem(extrairImagem(body)), uso: body.usage ?? {} };
}

