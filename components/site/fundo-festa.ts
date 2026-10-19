import { localizarEspaco, type Area, type Posicao } from './fundo-posicoes';

const formas = {
 balloon:'M50 4 C7 4 4 65 48 82 L43 89 L57 89 L52 82 C96 65 93 4 50 4 Z',
 heart:'M50 87 C38 75 4 54 5 29 C6 4 34 -1 50 22 C66 -1 94 4 95 29 C96 54 62 75 50 87 Z',
 rocket:'M50 2 C30 22 27 48 30 70 L70 70 C73 48 70 22 50 2 Z M30 42 L13 65 L13 88 L32 73 Z M70 42 L87 65 L87 88 L68 73 Z M39 76 L50 101 L61 76 Z',
 star:'M50 3 L62 34 L96 37 L70 59 L78 93 L50 75 L22 93 L30 59 L4 37 L38 34 Z',
 cake:'M14 51 L86 51 L86 91 L14 91 Z M23 30 L77 30 L77 50 L23 50 Z M29 12 L34 12 L34 29 L29 29 Z M47 6 L52 6 L52 29 L47 29 Z M65 12 L70 12 L70 29 L65 29 Z M8 93 L92 93 L92 99 L8 99 Z',
 hat:'M50 4 L89 88 Q50 105 11 88 Z M46 1 A5 5 0 1 0 56 1 A5 5 0 1 0 46 1 Z',
 gift:'M13 41 L87 41 L87 94 L13 94 Z M7 29 L93 29 L93 43 L7 43 Z M46 29 C-4 29 14 -4 37 14 L50 28 L63 14 C86 -4 104 29 54 29 Z'
} as const;
const itens: [keyof typeof formas, number, number, number][] = [
    ['balloon', .60, .12, 65], ['heart', .92, .26, 50], ['rocket', .88, .72, 66],
    ['star', .12, .56, 40], ['cake', .68, .91, 56], ['gift', .43, .78, 49],
];
const fragmento = `precision highp float;
uniform vec2 resolution;uniform float time;uniform float intensity;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),f.x),f.y);}
float fbm(vec2 p){float v=0.;float a=.5;for(int i=0;i<4;i++){v+=a*noise(p);p=mat2(.8,-.6,.6,.8)*p*2.02+vec2(13.1,7.8);a*=.5;}return v;}
void main(){vec2 uv=gl_FragCoord.xy/resolution.xy;vec2 p=(uv-.5)*vec2(resolution.x/resolution.y,1.)*2.2;float z=time*.07;
vec2 q=vec2(fbm(p+vec2(z,.3)),fbm(p+vec2(4.3,-z*.6)));float f=fbm(p+q*2.7+vec2(0.,z*.5));
vec3 col=mix(vec3(.10,.12,.35),vec3(.36,.15,.53),smoothstep(.18,.67,f));col=mix(col,vec3(.13,.39,.36),smoothstep(.45,.78,q.y+f*.15));
float ribbons=.5+.5*sin(p.x*1.6+p.y*1.2+f*7.+z);col+=vec3(.10,.05,.14)*pow(ribbons,3.);float mask=smoothstep(.08,.8,uv.x);
vec3 base=vec3(.0314,.0431,.0863);gl_FragColor=vec4(base+col*mask*intensity*.36,1.);}`;

function criarShader(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl', { alpha: false, antialias: false, powerPreference: 'low-power' });
    if (!gl) return null;
    const shaders: WebGLShader[] = [];
    let programa: WebGLProgram | null = null;
    let buffer: WebGLBuffer | null = null;
    const liberar = () => { shaders.forEach(s => gl.deleteShader(s)); gl.deleteBuffer(buffer); gl.deleteProgram(programa); };
    try {
        function compilar(tipo: number, fonte: string) {
            const shader = gl!.createShader(tipo);
            if (!shader) throw new Error('shader indisponível');
            shaders.push(shader);
            gl!.shaderSource(shader, fonte); gl!.compileShader(shader);
            if (!gl!.getShaderParameter(shader, gl!.COMPILE_STATUS)) throw new Error('shader indisponível');
            return shader;
        }
        programa = gl.createProgram();
        if (!programa) throw new Error('shader indisponível');
        gl.attachShader(programa, compilar(gl.VERTEX_SHADER, 'attribute vec2 position;void main(){gl_Position=vec4(position,0.,1.);}'));
        gl.attachShader(programa, compilar(gl.FRAGMENT_SHADER, fragmento));
        gl.linkProgram(programa);
        if (!gl.getProgramParameter(programa, gl.LINK_STATUS)) throw new Error('shader indisponível');
        gl.useProgram(programa);
        buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]), gl.STATIC_DRAW);
        const posicao = gl.getAttribLocation(programa, 'position');
        gl.enableVertexAttribArray(posicao); gl.vertexAttribPointer(posicao, 2, gl.FLOAT, false, 0, 0);
        const resolucao = gl.getUniformLocation(programa, 'resolution');
        const tempo = gl.getUniformLocation(programa, 'time');
        const intensidade = gl.getUniformLocation(programa, 'intensity');
        return {
            desenhar(t: number) {
                if (gl.isContextLost()) return;
                gl.viewport(0, 0, canvas.width, canvas.height);
                gl.uniform2f(resolucao, canvas.width, canvas.height); gl.uniform1f(tempo, t); gl.uniform1f(intensidade, .68);
                gl.drawArrays(gl.TRIANGLES, 0, 6);
            },
            liberar,
        };
    } catch { liberar(); return null; }
}

export function iniciarFundo(camada: HTMLDivElement, informarPausa: (pausado: boolean) => void) {
    const raiz = camada.parentElement!;
    const canvas = camada.querySelector<HTMLCanvasElement>('[data-elementos]')!;
    const coracoes = camada.querySelector<HTMLCanvasElement>('[data-coracoes]')!;
    const gradiente = camada.querySelector<HTMLCanvasElement>('[data-gradiente]')!;
    const contexto = canvas.getContext('2d');
    const agua = coracoes.getContext('2d');
    if (!contexto || !agua) { informarPausa(true); return null; }
    const ctx = contexto, wet = agua;
    const reduzir = matchMedia('(prefers-reduced-motion: reduce)');
    let pausado = reduzir.matches, visivel = true, encerrado = false;
    let quadro = 0, ultimo = 0, tempo = 0, largura = 0, altura = 0, atualizar = true;
    let shader = criarShader(gradiente);
    gradiente.dataset.renderer = shader ? 'webgl' : 'fallback';
    if (!shader) gradiente.style.visibility = 'hidden';
    const perderContexto = () => { shader?.liberar(); shader = null; gradiente.style.visibility = 'hidden'; gradiente.dataset.renderer = 'fallback'; };
    gradiente.addEventListener('webglcontextlost', perderContexto);
    const mascaras = Object.fromEntries(Object.entries(formas).map(([nome, fonte]) => {
        const path = new Path2D(fonte), pontos: { x: number; y: number; n: number }[] = [];
        for (let y = 0; y < 104; y += 6.3) for (let x = 0; x < 100; x += 5)
            if (ctx.isPointInPath(path, x, y)) pontos.push({ x: x - 50, y: y - 50, n: pontos.length });
        return [nome, pontos];
    }));
    let lugares: (Posicao & { nome: keyof typeof formas; tamanho: number; indice: number })[] = [];
    let gotas: { x: number; y: number; inicio: number }[] = [];
    function distribuir() {
        const base = raiz.getBoundingClientRect();
        const areas: Area[] = [];
        const adicionar = (r: DOMRect) => areas.push({ left: r.left - base.left, right: r.right - base.left, top: r.top - base.top, bottom: r.bottom - base.top });
        raiz.querySelectorAll('[data-fundo-proteger], button').forEach(el => adicionar(el.getBoundingClientRect()));
        raiz.querySelectorAll('[data-fundo-texto]').forEach(el => {
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            while (walker.nextNode()) {
                if (!walker.currentNode.textContent?.trim()) continue;
                const range = document.createRange(); range.selectNodeContents(walker.currentNode);
                Array.from(range.getClientRects()).forEach(adicionar);
            }
        });
        lugares = [];
        const mobile = largura < 700;
        itens.slice(0, mobile ? 3 : 6).forEach(([nome, x, y, tamanho], indice) => {
            const s = tamanho * (mobile ? .64 : 1);
            const lugar = localizarEspaco({ x: largura * x, y: altura * y, raio: s * .58 + 11 }, largura, altura, areas, lugares);
            if (lugar) lugares.push({ ...lugar, nome, tamanho: s, indice });
        });
        camada.dataset.elementos = String(lugares.length);
        atualizar = false;
    }
    function raios() {
        ctx.save(); ctx.globalCompositeOperation = 'screen';
        const comprimento = Math.hypot(largura, Math.min(altura, 1000)), origem = largura * .78;
        const halo = ctx.createRadialGradient(origem, 0, 0, origem, 0, 370);
        halo.addColorStop(0, 'rgba(205,190,255,.055)'); halo.addColorStop(1, 'rgba(144,120,214,0)');
        ctx.fillStyle = halo; ctx.fillRect(0, 0, largura, altura);
        [-.54, -.27, -.03, .23, .47, .73].forEach((angulo, i) => {
            ctx.save(); ctx.translate(origem, -210); ctx.rotate(angulo + Math.sin(tempo * .11 + i) * .045);
            for (let faixa = 0; faixa < 9; faixa++) {
                const w = comprimento * .09 * (1 - faixa * .085), g = ctx.createLinearGradient(0, 0, 0, comprimento);
                g.addColorStop(0, 'rgba(178,192,255,.007)'); g.addColorStop(.3, 'rgba(167,238,219,.004)'); g.addColorStop(1, 'rgba(167,238,219,0)');
                ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(w, comprimento); ctx.lineTo(-w, comprimento); ctx.closePath(); ctx.fill();
            }
            ctx.restore();
        });
        ctx.restore();
    }
    function desenhar(agora: number) {
        if (encerrado) return;
        if (atualizar) distribuir();
        shader?.desenhar(tempo);
        ctx.clearRect(0, 0, largura, altura); raios();
        const glifos = '0123456789abcxyz:+*';
        for (const { nome, x, y, tamanho, indice } of lugares) {
            const deslocamento = Math.sin(tempo * .45 + indice) * 9;
            ctx.save(); ctx.translate(x, y + deslocamento); ctx.rotate(Math.sin(tempo * .25 + indice) * .10 + (nome === 'rocket' ? .35 : 0));
            ctx.scale(tamanho / 100, tamanho / 100); ctx.font = '7px ui-monospace,Consolas,monospace'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            for (const p of mascaras[nome]) {
                const alpha = (.50 + .20 * Math.sin(p.x * .03 + tempo + indice)) * .68;
                const cor = indice % 3 === 0 ? '153,233,207' : indice % 3 === 1 ? '205,160,255' : '153,192,255';
                ctx.fillStyle = `rgba(${cor},${alpha})`; ctx.fillText(glifos[(p.n + indice * 3 + Math.floor(tempo * .8)) % glifos.length], p.x, p.y);
            }
            ctx.restore();
        }
        wet.clearRect(0, 0, largura, altura);
        gotas = gotas.filter(g => agora - g.inicio < 5800);
        camada.dataset.coracoes = String(gotas.length);
        for (const g of gotas) {
            const idade = (agora - g.inicio) / 1000, fade = (1 - idade / 5.8) ** 2 * Math.min(1, idade / .6);
            for (let anel = 0; anel < 2; anel++) {
                const decorrido = idade - anel * .38;
                if (decorrido < 0) continue;
                const r = 6 + decorrido * 44;
                wet.beginPath(); wet.moveTo(g.x, g.y - r * .27);
                wet.bezierCurveTo(g.x - r * .65, g.y - r * .92, g.x - r * 1.28, g.y + r * .02, g.x, g.y + r * .9);
                wet.bezierCurveTo(g.x + r * 1.28, g.y + r * .02, g.x + r * .65, g.y - r * .92, g.x, g.y - r * .27);
                wet.closePath(); wet.lineWidth = anel === 0 ? .85 : .65;
                wet.strokeStyle = `rgba(198,167,245,${fade * (1 - anel * .3) * .12})`; wet.stroke();
            }
        }
    }
    function loop(agora: number) {
        quadro = 0;
        if (encerrado || document.hidden || !visivel) return;
        if (agora - ultimo >= 33) { if (!pausado) tempo += Math.min((agora - ultimo) / 1000, .05); ultimo = agora; desenhar(agora); }
        if (!pausado || gotas.length) quadro = requestAnimationFrame(loop);
    }
    function iniciar() { if (!quadro && !encerrado && !document.hidden && visivel) { ultimo = performance.now(); quadro = requestAnimationFrame(loop); } }
    function sincronizar() {
        cancelAnimationFrame(quadro); quadro = 0;
        informarPausa(pausado); camada.dataset.pausado = String(pausado);
        desenhar(performance.now()); if (!pausado) iniciar();
    }
    function dimensionar() {
        if (encerrado) return;
        largura = raiz.clientWidth; altura = raiz.clientHeight;
        // Limita pixels em páginas longas de celular, sem depender do DPR do aparelho.
        const dpr = Math.min(devicePixelRatio || 1, 1.5, Math.sqrt(2_500_000 / Math.max(1, largura * altura)));
        for (const c of [canvas, coracoes]) { c.width = Math.round(largura * dpr); c.height = Math.round(altura * dpr); }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0); wet.setTransform(dpr, 0, 0, dpr, 0, 0);
        gradiente.width = Math.max(1, Math.round(largura * .5)); gradiente.height = Math.max(1, Math.round(altura * .5));
        atualizar = true; desenhar(performance.now());
    }
    function clicar(event: PointerEvent) {
        if (pausado || reduzir.matches || !event.isPrimary || event.button !== 0 || (event.target instanceof Element && event.target.closest('button,a,input,select,textarea'))) return;
        const r = raiz.getBoundingClientRect();
        gotas.push({ x: event.clientX - r.left, y: event.clientY - r.top, inicio: performance.now() }); gotas = gotas.slice(-3); iniciar();
    }
    function preferencia() { pausado = reduzir.matches; gotas = []; sincronizar(); }
    function visibilidade() { if (document.hidden) gotas = []; sincronizar(); }
    const resize = new ResizeObserver(dimensionar); resize.observe(raiz);
    const intersecao = new IntersectionObserver(([e]) => { visivel = e.isIntersecting; sincronizar(); }); intersecao.observe(raiz);
    raiz.addEventListener('pointerdown', clicar, { passive: true });
    reduzir.addEventListener('change', preferencia); document.addEventListener('visibilitychange', visibilidade);
    window.addEventListener('resize', dimensionar, { passive: true });
    void document.fonts.ready.then(() => { if (!encerrado) dimensionar(); });
    dimensionar(); sincronizar();
    return {
        alternar() { pausado = !pausado; gotas = []; sincronizar(); },
        destruir() {
            encerrado = true; cancelAnimationFrame(quadro); resize.disconnect(); intersecao.disconnect();
            raiz.removeEventListener('pointerdown', clicar); reduzir.removeEventListener('change', preferencia);
            document.removeEventListener('visibilitychange', visibilidade); window.removeEventListener('resize', dimensionar);
            gradiente.removeEventListener('webglcontextlost', perderContexto); shader?.liberar(); gotas = [];
        },
    };
}
