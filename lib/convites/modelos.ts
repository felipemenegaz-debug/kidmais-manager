import type { Conteudo } from './domain.ts';
import { temaVisual } from './visual.ts';

export const modelosComFoto = ['foto_arco', 'foto_aquarela', 'foto_degrade'] as const;
export const modelosBiblioteca = ['planetas', 'arco', 'ondulada', 'aquarela', 'degrade', 'geometrica', ...modelosComFoto] as const;
export function modeloComFoto(tema: Conteudo['tema']) {
  return (modelosComFoto as readonly string[]).includes(tema);
}
export const basesNeutras = ['arco', 'ondulada', 'aquarela', 'degrade', 'geometrica'] as const;
export function baseNeutra(tema: Conteudo['tema']) {
  return (basesNeutras as readonly string[]).includes(tema);
}
export const planetasModelo = ['azul', 'rosa', 'laranja'].map(nome => `/convites/modelos/planeta-${nome}.webp`);
export function modeloBiblioteca(tema: Conteudo['tema']) {
  return (modelosBiblioteca as readonly string[]).includes(tema);
}
const xml = (v: string) => v.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);

// Medidas conservadoras e determinísticas: a mesma composição no DOM e na exportação.
const unidades = (s: string) => Array.from(s).reduce((n, c) => n + (/\s/.test(c) ? .3 : /[ilI.,:!'|]/.test(c) ? .3 : /[MW@%]/.test(c) ? .95 : /[A-ZÁÀÂÃÉÊÍÓÔÕÚÇ]/.test(c) ? .7 : .56), 0);
export function comporTexto(valor: string, largura: number, altura: number, tamanho: number) {
  let linhas: string[] = [];
  for (; tamanho >= 10; tamanho--) {
    linhas = [''];
    for (const palavra of valor.trim().split(/\s+/)) {
      let ultima = linhas.length - 1;
      if (linhas[ultima] && unidades(`${linhas[ultima]} ${palavra}`) * tamanho > largura) { linhas.push(''); ultima++; }
      for (const letra of `${linhas[ultima] ? ' ' : ''}${palavra}`) {
        if (unidades(linhas[ultima] + letra) * tamanho > largura) { linhas.push(''); ultima++; }
        linhas[ultima] += letra;
      }
    }
    if (linhas.length * tamanho * 1.25 <= altura) break;
  }
  return { linhas, tamanho, altura: linhas.length * tamanho * 1.25 };
}

/** SVG sem scripts/foreignObject. Todos os dados e URLs interpolados são escapados. */
export function svgModelo(c: Conteudo, op: { arte?: string; planetas?: string[]; id?: string; miniatura?: boolean } = {}) {
  const tema = temaVisual(c), id = (op.id ?? 'modelo').replace(/[^a-zA-Z0-9_-]/g, '');
  const ondulada = c.tema === 'ondulada', planetas = c.tema === 'planetas';
  const comFoto = modeloComFoto(c.tema);
  const fundo = xml(tema.fundo), tinta = xml(tema.tinta), destaque = xml(tema.destaque);
  const imagem = (src: string, x: number, y: number, w: number, h: number) => `<image href="${xml(src)}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="xMidYMid meet"/>`;
  const texto = (s: string, y: number, h: number, size: number, serif = false, bold = false, width = 740) => {
    const bloco = comporTexto(s, width, h, size);
    return `<g fill="${tinta}" font-family="${serif ? 'Georgia, serif' : 'Arial, sans-serif'}" font-size="${bloco.tamanho}" font-weight="${bold ? 700 : 400}" text-anchor="middle">${bloco.linhas.map((l, n) => `<text x="540" y="${y + (h - bloco.altura) / 2 + bloco.tamanho + n * bloco.tamanho * 1.25}" textLength="${Math.max(1, unidades(l) * bloco.tamanho)}" lengthAdjust="spacingAndGlyphs">${xml(l)}</text>`).join('')}</g>`;
  };
  const arco = 'M100 1630 V485 C100 20 980 20 980 485 V1630 Q980 1710 900 1710 H180 Q100 1710 100 1630Z';
  const ondas = 'M180 115 Q225 65 280 110 Q335 60 390 105 Q450 55 505 100 Q560 55 620 105 Q680 60 735 110 Q800 65 850 115 Q950 105 950 205 Q1010 255 965 315';
  let molduraOndulada = ondas;
  for (let y = 315; y < 1515; y += 150) molduraOndulada += ` Q1020 ${y + 75} 965 ${y + 150}`;
  molduraOndulada += ' Q1000 1705 860 1690 Q800 1745 740 1695 Q680 1745 620 1695 Q560 1745 500 1695 Q440 1745 380 1695 Q320 1745 260 1695 Q200 1745 140 1690 Q70 1670 115 1515';
  for (let y = 1515; y > 315; y -= 150) molduraOndulada += ` Q60 ${y - 75} 115 ${y - 150}`;
  molduraOndulada += ' Q55 235 115 205 Q100 105 180 115Z';
  const estrela = (x: number, y: number, r: number) => `<path d="M${x} ${y-r} Q${x+2} ${y-2} ${x+r} ${y} Q${x+2} ${y+2} ${x} ${y+r} Q${x-2} ${y+2} ${x-r} ${y} Q${x-2} ${y-2} ${x} ${y-r}Z" fill="${destaque}"/>`;
  const textura = `<defs><filter id="${id}-papel"><feTurbulence type="fractalNoise" baseFrequency=".65" numOctaves="3" seed="8"/><feColorMatrix type="saturate" values="0"/></filter><filter id="${id}-agua"><feTurbulence type="fractalNoise" baseFrequency=".016" numOctaves="3" seed="6"/><feDisplacementMap in="SourceGraphic" scale="65"/></filter></defs>`;
  let borda = ondulada
    ? `<rect width="1080" height="1800" fill="${destaque}" opacity=".16"/><path d="${molduraOndulada}" fill="${fundo}" stroke="${destaque}" stroke-width="45" opacity=".35" filter="url(#${id}-agua)"/><path d="${molduraOndulada}" fill="${fundo}" stroke="${destaque}" stroke-width="3"/><path d="${molduraOndulada}" fill="none" stroke="${destaque}" stroke-width="2" transform="translate(18 27) scale(.966 .97)"/>`
    : `<path d="${arco}" fill="none" stroke="${destaque}" stroke-width="3"/><path d="${arco}" fill="none" stroke="${destaque}" stroke-width="2" transform="translate(15 20) scale(.972 .978)"/>`;
  if (c.tema === 'aquarela' || c.tema === 'foto_aquarela') {
    borda = `<defs><filter id="${id}-lavagem" x="-30%" y="-30%" width="160%" height="160%"><feTurbulence type="fractalNoise" baseFrequency=".009" numOctaves="3" seed="12" result="ruido"/><feDisplacementMap in="SourceGraphic" in2="ruido" scale="85"/><feGaussianBlur stdDeviation="18"/></filter></defs>
      <g filter="url(#${id}-lavagem)" fill="${destaque}"><ellipse cx="55" cy="180" rx="320" ry="240" opacity=".24"/><ellipse cx="960" cy="45" rx="300" ry="220" opacity=".16"/><ellipse cx="1040" cy="1500" rx="240" ry="375" opacity=".24"/><ellipse cx="80" cy="1780" rx="410" ry="230" opacity=".19"/></g>
      <rect x="98" y="98" width="884" height="1604" rx="95" fill="${fundo}" fill-opacity=".55" stroke="${destaque}" stroke-opacity=".65" stroke-width="2"/>`;
  } else if (c.tema === 'degrade' || c.tema === 'foto_degrade') {
    borda = `<defs><linearGradient id="${id}-degrade" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${destaque}" stop-opacity=".45"/><stop offset=".48" stop-color="${fundo}" stop-opacity="0"/><stop offset="1" stop-color="${destaque}" stop-opacity=".3"/></linearGradient><radialGradient id="${id}-luz"><stop stop-color="${fundo}" stop-opacity=".95"/><stop offset="1" stop-color="${fundo}" stop-opacity="0"/></radialGradient></defs>
      <rect width="1080" height="1800" fill="url(#${id}-degrade)"/><ellipse cx="730" cy="420" rx="600" ry="650" fill="url(#${id}-luz)"/><rect x="85" y="85" width="910" height="1630" rx="210" fill="none" stroke="${destaque}" stroke-opacity=".55" stroke-width="2"/>`;
  } else if (c.tema === 'geometrica') {
    const geometric = 'M175 95 H905 L985 175 V1625 L905 1705 H175 L95 1625 V175Z';
    borda = `<path d="${geometric}" fill="none" stroke="${destaque}" stroke-width="3"/><path d="${geometric}" fill="none" stroke="${destaque}" stroke-width="1.5" transform="translate(18 28) scale(.967 .968)"/>
      <g fill="${fundo}" stroke="${destaque}" stroke-width="2"><path d="M540 65 L570 95 L540 125 L510 95Z"/><path d="M540 1675 L570 1705 L540 1735 L510 1705Z"/></g>`;
  }
  const sprites = op.planetas ?? planetasModelo;
  const decoracao = planetas ? `${imagem(sprites[0], 795, 90, 295, 295)}${imagem(sprites[1], -145, 930, 340, 340)}${imagem(sprites[2], 850, 1460, 340, 340)}${[[95,110,25],[930,680,15],[90,1380,22],[780,1750,12]].map(([x,y,r])=>estrela(x,y,r)).join('')}<path d="M35 365 Q0 170 255 55 M795 1760 Q1070 1790 1050 1450" fill="none" stroke="${destaque}" stroke-dasharray="3 12" stroke-width="2"/>` : '';
  let conteudo = '';
  if (!op.miniatura || comFoto) {
    const data = c.data ? new Date(`${c.data}T12:00:00`).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long' }) : 'Data da festa';
    if (comFoto) {
      // Foto inteira em um passe-partout: sem recortar rostos ou exigir controles extras.
      const quadro = 'M240 310 H840 Q880 310 880 350 V750 Q880 790 840 790 H240 Q200 790 200 750 V350 Q200 310 240 310Z';
      const retrato = op.arte ? imagem(op.arte, 220, 330, 640, 440)
        : `<g fill="${destaque}" opacity=".45"><circle cx="540" cy="410" r="70"/><path d="M370 660 V615 A170 135 0 0 1 710 615 V660Z"/></g>${texto('Sua foto aqui', 690, 55, 26)}`;
      conteudo = `<path d="${quadro}" fill="${fundo}" stroke="${destaque}" stroke-width="3"/>${retrato}
        ${texto('VAMOS CELEBRAR', 835, 55, 27)}
        ${texto(c.nome || 'Nome do aniversariante', 920, 155, 110, true, true)}
        ${texto(c.idade || 'Um dia muito especial', 1090, 65, 48, true)}
        <path d="M390 1180 H690" stroke="${destaque}" stroke-width="2"/>
        ${texto(c.mensagem, 1205, 155, 33, true)}
        ${texto(`${data} · ${c.horario || '00:00'}`, 1390, 75, 34, false, true)}
        ${texto(c.local || 'Local da festa', 1480, 90, 36, true, false, 660)}
        ${texto(c.endereco || 'Endereço do evento', 1590, 85, 28, false, false, 640)}`;
    } else conteudo = `${op.arte ? imagem(op.arte, 350, 180, 380, 280) : ''}
      ${texto(planetas ? 'UMA AVENTURA ESPACIAL' : 'VAMOS CELEBRAR', op.arte ? 475 : 360, 85, 30)}
      ${texto(c.nome || 'Nome do aniversariante', 575, 295, 166, true, true)}
      ${texto(c.idade || 'Um dia muito especial', 885, 90, 65, true)}
      <path d="M330 1015 H750" stroke="${destaque}" stroke-width="2"/>
      ${texto(c.mensagem, 1060, 250, 35, true)}
      ${texto(`${data} · ${c.horario || '00:00'}`, 1340, 90, 36, false, true)}
      ${texto(c.local || 'Local da festa', 1455, 95, 38, true, false, 660)}
      ${texto(c.endereco || 'Endereço do evento', 1570, 95, 29, false, false, 640)}`;
  }
  const descricao = op.miniatura ? tema.nome : [`Convite de ${c.nome || 'aniversário'}`, c.idade, c.mensagem, c.data, c.horario, c.local, c.endereco].filter(Boolean).join('. ');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1800" width="1080" height="1800" role="img" aria-label="${xml(descricao)}">${textura}<rect width="1080" height="1800" fill="${fundo}"/>${borda}<rect width="1080" height="1800" filter="url(#${id}-papel)" opacity=".065"/>${decoracao}${conteudo}</svg>`;
}
