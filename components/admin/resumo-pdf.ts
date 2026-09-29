import type { SecaoResumo } from './resumo-contratacao.ts';

/**
 * PDF do Resumo da Contratação, gerado no navegador a partir do MESMO objeto exibido na tela
 * (`montarResumo`). Não chama API, não persiste documento e não abre o diálogo de impressão.
 *
 * Segue a mesma técnica de `lib/contratos/documento/pdf.ts` (PDF 1.4 escrito à mão, Helvetica WinAnsi),
 * sem biblioteca nova. Não reutiliza aquele módulo diretamente porque ele depende de Buffer/node:fs
 * e o layout do contrato oficial tem hash de integridade que não deve mudar.
 */

export type ResumoParaPdf = {
  numeroVersao: number;
  classificacao: string;
  secoes: SecaoResumo[];
  parcelas: Array<{ rotulo: string; valor: string; vencimento: string; estado: string }>;
  avisoFinanceiro: string;
};

export type LogoJpeg = { bytes: Uint8Array; largura: number; altura: number };

const A4_W = 595.28;
const A4_H = 841.89;
const MX = 48;
const LARGURA = A4_W - MX * 2;
const TOPO = 720;
const BASE = 72;

/** Violeta só em títulos e acentos; slate para linhas e textos secundários; laranja só no aviso. */
const COR = {
  texto: '0.118 0.161 0.231',
  secundario: '0.278 0.333 0.412',
  linha: '0.886 0.910 0.941',
  fundoTabela: '0.973 0.980 0.988',
  violeta: '0.384 0.231 0.616',
  laranja: '0.918 0.345 0.047',
  laranjaFundo: '1.000 0.969 0.929',
  laranjaTexto: '0.604 0.204 0.071',
  teal: '0.059 0.463 0.431',
};

type Fonte = 'F1' | 'F2';

export function normalizarTextoPdf(valor: string) {
  return valor
    .replace(/[–—]/g, '-')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/…/g, '...')
    .replace(/[•·]/g, '-')
    .replace(/\s+/g, ' ')
    .normalize('NFC')
    .replace(/[^\x20-\x7E\xA0-\xFF]/gu, '?');
}

function literal(valor: string) {
  return normalizarTextoPdf(valor).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function texto(t: string, x: number, y: number, tamanho: number, fonte: Fonte = 'F1', cor = COR.texto) {
  return `BT /${fonte} ${tamanho.toFixed(2)} Tf ${cor} rg 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm (${literal(t)}) Tj ET\n`;
}

function linha(x1: number, x2: number, y: number, cor = COR.linha, largura = 0.6) {
  return `q ${cor} RG ${largura.toFixed(2)} w ${x1.toFixed(2)} ${y.toFixed(2)} m ${x2.toFixed(2)} ${y.toFixed(2)} l S Q\n`;
}

function caixa(x: number, topo: number, w: number, h: number, cor: string) {
  return `q ${cor} rg ${x.toFixed(2)} ${(topo - h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f Q\n`;
}

/** Estimativa conservadora da largura média da Helvetica: evita texto fora da página. */
function capacidade(largura: number, tamanho: number, negrito = false) {
  return Math.max(8, Math.floor(largura / (tamanho * (negrito ? 0.58 : 0.53))));
}

export function quebrar(valor: string, max: number): string[] {
  const limpo = normalizarTextoPdf(valor).trim();
  if (!limpo) return [''];
  const linhas: string[] = [];
  let atual = '';
  for (const palavra of limpo.split(' ')) {
    const candidato = atual ? `${atual} ${palavra}` : palavra;
    if (candidato.length <= max) { atual = candidato; continue; }
    if (atual) linhas.push(atual);
    let resto = palavra;
    while (resto.length > max) { linhas.push(resto.slice(0, max)); resto = resto.slice(max); }
    atual = resto;
  }
  if (atual) linhas.push(atual);
  return linhas;
}

class Paginador {
  paginas: string[] = [];
  atual = '';
  y = TOPO;

  garantir(altura: number) {
    if (this.y - altura < BASE && this.atual.trim()) this.novaPagina();
  }

  novaPagina() {
    this.paginas.push(this.atual);
    this.atual = '';
    this.y = TOPO;
  }

  fechar() {
    this.paginas.push(this.atual);
    return this.paginas;
  }
}

function paragrafo(p: Paginador, valor: string, opcoes: { tamanho?: number; cor?: string; fonte?: Fonte; recuo?: number } = {}) {
  const tamanho = opcoes.tamanho ?? 9.4;
  const entrelinha = tamanho * 1.38;
  const recuo = opcoes.recuo ?? 0;
  for (const l of quebrar(valor, capacidade(LARGURA - recuo, tamanho, opcoes.fonte === 'F2'))) {
    p.garantir(entrelinha);
    p.atual += texto(l, MX + recuo, p.y, tamanho, opcoes.fonte ?? 'F1', opcoes.cor ?? COR.texto);
    p.y -= entrelinha;
  }
}

function tituloSecao(p: Paginador, titulo: string) {
  // Não deixa o título órfão no pé da página.
  p.garantir(52);
  p.y -= 10;
  p.atual += texto(titulo, MX, p.y, 11.5, 'F2', COR.violeta);
  p.y -= 7;
  p.atual += linha(MX, A4_W - MX, p.y);
  p.y -= 15;
}

function campo(p: Paginador, rotulo: string, valor: string) {
  const colunaRotulo = 150;
  const larguraValor = LARGURA - colunaRotulo - 10;
  const tamanho = 9.4;
  const entrelinha = 12.6;
  const rotulos = quebrar(rotulo, capacidade(colunaRotulo - 8, 8.6));
  const valores = quebrar(valor, capacidade(larguraValor, tamanho));
  const total = Math.max(rotulos.length, valores.length);
  // Um campo só é partido entre páginas quando sozinho é maior que uma página.
  if (total * entrelinha < TOPO - BASE) p.garantir(total * entrelinha + 6);
  for (let i = 0; i < total; i += 1) {
    p.garantir(entrelinha);
    if (rotulos[i]) p.atual += texto(rotulos[i], MX, p.y, 8.6, 'F1', COR.secundario);
    if (valores[i]) p.atual += texto(valores[i], MX + colunaRotulo, p.y, tamanho, 'F1', COR.texto);
    p.y -= entrelinha;
  }
  p.atual += linha(MX, A4_W - MX, p.y + 5, COR.linha, 0.35);
  p.y -= 5;
}

function aviso(p: Paginador, valor: string) {
  const linhas = quebrar(valor, capacidade(LARGURA - 28, 8.8));
  const altura = linhas.length * 12 + 16;
  p.garantir(altura + 8);
  p.atual += caixa(MX, p.y, LARGURA, altura, COR.laranjaFundo);
  p.atual += caixa(MX, p.y, 3, altura, COR.laranja);
  let y = p.y - 15;
  for (const l of linhas) { p.atual += texto(l, MX + 14, y, 8.8, 'F1', COR.laranjaTexto); y -= 12; }
  p.y -= altura + 10;
}

const COLUNAS = [
  { titulo: 'Parcela', largura: 0.40 },
  { titulo: 'Valor', largura: 0.20 },
  { titulo: 'Vencimento', largura: 0.20 },
  { titulo: 'Estado', largura: 0.20 },
] as const;

function cabecalhoTabela(p: Paginador) {
  p.atual += caixa(MX, p.y + 4, LARGURA, 18, COR.fundoTabela);
  let x = MX + 6;
  for (const coluna of COLUNAS) {
    p.atual += texto(coluna.titulo.toUpperCase(), x, p.y - 8, 7.6, 'F2', COR.secundario);
    x += LARGURA * coluna.largura;
  }
  p.y -= 20;
}

function tabelaParcelas(p: Paginador, parcelas: ResumoParaPdf['parcelas']) {
  p.garantir(60);
  cabecalhoTabela(p);
  for (const parcela of parcelas) {
    const celulas = [parcela.rotulo, parcela.valor, parcela.vencimento, parcela.estado]
      .map((valor, i) => quebrar(valor, capacidade(LARGURA * COLUNAS[i].largura - 12, 9)));
    const altura = Math.max(...celulas.map((c) => c.length)) * 12 + 8;
    if (p.y - altura < BASE) { p.novaPagina(); cabecalhoTabela(p); }
    let x = MX + 6;
    celulas.forEach((linhas, i) => {
      let y = p.y - 4;
      for (const l of linhas) { p.atual += texto(l, x, y, 9, 'F1', COR.texto); y -= 12; }
      x += LARGURA * COLUNAS[i].largura;
    });
    p.y -= altura;
    p.atual += linha(MX, A4_W - MX, p.y + 6, COR.linha, 0.4);
  }
}

function montarPaginas(resumo: ResumoParaPdf) {
  const p = new Paginador();
  p.atual += texto('Resumo da Contratação', MX, p.y, 20, 'F2', COR.texto);
  p.y -= 26;
  aviso(p, 'Documento operacional e comercial. Não substitui o contrato jurídico nem seus comprovantes de assinatura.');
  for (const secao of resumo.secoes) {
    tituloSecao(p, secao.titulo);
    for (const [rotulo, valor] of secao.linhas) campo(p, rotulo, valor);
  }
  tituloSecao(p, 'Plano e cronograma financeiro');
  paragrafo(p, resumo.avisoFinanceiro, { cor: COR.secundario, tamanho: 9 });
  p.y -= 6;
  if (resumo.parcelas.length) tabelaParcelas(p, resumo.parcelas);
  else paragrafo(p, 'Nenhum cronograma aplicável disponível nesta consulta.', { cor: COR.secundario, tamanho: 9 });
  p.y -= 10;
  p.garantir(20);
  p.atual += linha(MX, A4_W - MX, p.y + 4);
  p.y -= 10;
  paragrafo(p, 'Kidmais - Resumo para consulta - Condições comerciais da versão selecionada, sem recálculo.', { cor: COR.secundario, tamanho: 8 });
  return p.fechar();
}

function cabecalho(resumo: ResumoParaPdf, logo: LogoJpeg | null) {
  let c = '';
  if (logo) {
    // Logo acima da faixa de marca (y 748): nunca cruzam, qualquer que seja a proporção da imagem.
    const proporcao = logo.altura / logo.largura;
    const h = Math.min(112 * proporcao, 50);
    const w = h / proporcao;
    c += `q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${MX} ${(808 - h).toFixed(2)} cm /Logo Do Q\n`;
  } else {
    c += texto('KIDMAIS', MX, 786, 16, 'F2', COR.violeta);
  }
  c += texto('RESUMO DA CONTRATAÇÃO', 400, 796, 8, 'F2', COR.secundario);
  c += texto(`V${resumo.numeroVersao} - ${resumo.classificacao}`.slice(0, 40), 400, 783, 8.6, 'F2', COR.violeta);
  c += `q ${COR.violeta} rg ${MX} 748 ${(LARGURA * 0.62).toFixed(2)} 2 re f Q\n`;
  c += `q ${COR.teal} rg ${(MX + LARGURA * 0.62).toFixed(2)} 748 ${(LARGURA * 0.38).toFixed(2)} 2 re f Q\n`;
  return c;
}

function rodape(pagina: number, total: number) {
  return linha(MX, A4_W - MX, 52)
    + texto('Kidmais Manager - Resumo da Contratação - documento informativo', MX, 38, 7.4, 'F1', COR.secundario)
    + texto(`Página ${pagina} de ${total}`, A4_W - MX - 62, 38, 7.4, 'F1', COR.secundario);
}

/** Bytes WinAnsi/Latin-1: todo texto já passou por normalizarTextoPdf. */
function bytesLatin1(valor: string) {
  const bytes = new Uint8Array(valor.length);
  for (let i = 0; i < valor.length; i += 1) bytes[i] = valor.charCodeAt(i) & 0xff;
  return bytes;
}

function concatenar(partes: Uint8Array[]) {
  const total = partes.reduce((n, parte) => n + parte.length, 0);
  const saida = new Uint8Array(total);
  let pos = 0;
  for (const parte of partes) { saida.set(parte, pos); pos += parte.length; }
  return saida;
}

/** Lê largura/altura do marcador SOF de um JPEG. Retorna null se não for JPEG baseline/progressivo válido. */
export function dimensoesJpeg(bytes: Uint8Array): { largura: number; altura: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marcador = bytes[i + 1];
    const tamanho = (bytes[i + 2] << 8) | bytes[i + 3];
    if (marcador >= 0xc0 && marcador <= 0xc3) {
      return { altura: (bytes[i + 5] << 8) | bytes[i + 6], largura: (bytes[i + 7] << 8) | bytes[i + 8] };
    }
    i += 2 + tamanho;
  }
  return null;
}

export function criarPdfResumo(resumo: ResumoParaPdf, logo: LogoJpeg | null = null): Uint8Array {
  const corpos = montarPaginas(resumo);
  const idLogo = logo ? 5 : null;
  const primeiraPagina = logo ? 6 : 5;
  const objetos: Array<{ id: number; bytes: Uint8Array }> = [];
  const adicionar = (id: number, corpo: string | Uint8Array[]) => {
    const conteudo = typeof corpo === 'string' ? [bytesLatin1(corpo)] : corpo;
    objetos.push({ id, bytes: concatenar([bytesLatin1(`${id} 0 obj\n`), ...conteudo, bytesLatin1('\nendobj\n')]) });
  };
  const refs = corpos.map((_, i) => `${primeiraPagina + i * 2} 0 R`).join(' ');
  adicionar(1, '<< /Type /Catalog /Pages 2 0 R >>');
  adicionar(2, `<< /Type /Pages /Kids [${refs}] /Count ${corpos.length} >>`);
  adicionar(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  adicionar(4, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  if (logo && idLogo) {
    adicionar(idLogo, [
      bytesLatin1(`<< /Type /XObject /Subtype /Image /Width ${logo.largura} /Height ${logo.altura} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${logo.bytes.length} >>\nstream\n`),
      logo.bytes,
      bytesLatin1('\nendstream'),
    ]);
  }
  corpos.forEach((corpo, i) => {
    const id = primeiraPagina + i * 2;
    const fluxo = bytesLatin1(`${cabecalho(resumo, logo)}${corpo}${rodape(i + 1, corpos.length)}`);
    const xobject = idLogo ? ` /XObject << /Logo ${idLogo} 0 R >>` : '';
    adicionar(id, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4_W} ${A4_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xobject} >> /Contents ${id + 1} 0 R >>`);
    adicionar(id + 1, [bytesLatin1(`<< /Length ${fluxo.length} >>\nstream\n`), fluxo, bytesLatin1('\nendstream')]);
  });
  objetos.sort((a, b) => a.id - b.id);
  const cabecalhoArquivo = bytesLatin1('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const partes: Uint8Array[] = [cabecalhoArquivo];
  const offsets: number[] = [];
  let pos = cabecalhoArquivo.length;
  for (const objeto of objetos) { offsets[objeto.id] = pos; partes.push(objeto.bytes); pos += objeto.bytes.length; }
  const maior = objetos[objetos.length - 1].id;
  let xref = `xref\n0 ${maior + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= maior; id += 1) xref += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  partes.push(bytesLatin1(`${xref}trailer\n<< /Size ${maior + 1} /Root 1 0 R >>\nstartxref\n${pos}\n%%EOF\n`));
  return concatenar(partes);
}

/** `Resumo_Contratacao_<cliente>_<data>.pdf`, só ASCII seguro para WhatsApp/e-mail. */
export function nomeArquivoResumo(contratante: string, dataEvento: string) {
  const cliente = contratante.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'Cliente';
  const data = /^\d{4}-\d{2}-\d{2}$/.test(dataEvento) ? dataEvento : 'sem_data';
  return `Resumo_Contratacao_${cliente}_${data}.pdf`;
}
