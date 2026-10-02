/* eslint-disable */
// Gerado por scripts/gerar-pdf-worker.cjs; editar os fontes TypeScript.
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LIMITES = void 0;
exports.lerToUnicode = lerToUnicode;
exports.textoDoConteudo = textoDoConteudo;
exports.extrairTextoPdf = extrairTextoPdf;
exports.temTextoNativo = temTextoNativo;
const node_zlib_1 = require("node:zlib");
exports.LIMITES = {
    objetos: 20_000,
    paginas: 60,
    bytesPorStream: 8 * 1024 * 1024,
    bytesTotal: 32 * 1024 * 1024,
    /** Um bfrange nunca expande mais que isto (a especificação limita ao último byte: 256). */
    amplitudeRange: 256,
    /** Entradas totais de um CMap. */
    entradasCmap: 65_536,
    /** Código de origem cabe em 4 bytes; destino em até 16 unidades UTF-16. */
    digitosCodigo: 8,
    digitosDestino: 64,
    trabalhoPadrao: 60_000_000,
    prazoPadraoMs: 4_000,
    /** Bytes de um CMap analisados; o resto é ignorado com aviso. */
    bytesCmap: 4 * 1024 * 1024,
    /** Tokens léxicos e blocos begin…end de um CMap. */
    tokensCmap: 400_000,
    blocosCmap: 1_024,
    /** Dígitos hex de um token (código ou destino). Maior ⇒ token inválido. */
    digitosToken: 128,
    /** Itens de um array de destinos de bfrange. */
    itensArray: 256,
    /** Um dicionário de objeto nunca é analisado além disto: nenhuma regex roda sobre texto maior. */
    bytesDicionario: 64 * 1024,
};
class Interrupcao extends Error {
    motivo;
    constructor(motivo) {
        super(motivo);
        this.motivo = motivo;
    }
}
/** Orçamento de trabalho + prazo + cancelamento, conferidos a cada unidade gasta. */
class Trabalho {
    restante;
    prazo;
    sinal;
    agora;
    desdeUltimaChecagem = 0;
    constructor(opcoes) {
        this.agora = opcoes.agora ?? (() => performance.now());
        this.restante = opcoes.limiteTrabalho ?? exports.LIMITES.trabalhoPadrao;
        this.prazo = this.agora() + (opcoes.prazoMs ?? exports.LIMITES.prazoPadraoMs);
        this.sinal = opcoes.sinal;
    }
    gastar(unidades) {
        this.restante -= unidades;
        if (this.restante < 0)
            throw new Interrupcao("LIMITE_TRABALHO");
        this.desdeUltimaChecagem += unidades;
        if (this.desdeUltimaChecagem >= 16_384) {
            this.desdeUltimaChecagem = 0;
            if (this.sinal?.aborted)
                throw new Interrupcao("CANCELADO");
            if (this.agora() > this.prazo)
                throw new Interrupcao("PRAZO");
        }
    }
}
class Leitor {
    objetos = new Map();
    avisos = [];
    trabalho;
    bytesDescomprimidos = 0;
    constructor(trabalho) {
        this.trabalho = trabalho;
    }
    descomprimir(dados, dicionario) {
        const filtro = dicionario.match(/\/Filter\s{0,64}(\[[^\]]{0,1024}\]|\/[A-Za-z0-9]{1,64})/)?.[1] ?? "";
        const filtros = filtro.match(/\/[A-Za-z0-9]{1,64}/g) ?? [];
        if (filtros.length === 0)
            return dados;
        if (filtros.length !== 1 || filtros[0] !== "/FlateDecode")
            return null;
        if (/\/Predictor\s{1,64}([2-9]|1\d)/.test(dicionario))
            return null;
        const restante = exports.LIMITES.bytesTotal - this.bytesDescomprimidos;
        if (restante <= 0) {
            this.avisos.push("LIMITE_TOTAL");
            return null;
        }
        try {
            const saida = (0, node_zlib_1.inflateSync)(dados, { maxOutputLength: Math.min(exports.LIMITES.bytesPorStream, restante) });
            this.bytesDescomprimidos += saida.length;
            this.trabalho.gastar(saida.length);
            return new Uint8Array(saida);
        }
        catch (erro) {
            if (erro instanceof Interrupcao)
                throw erro;
            this.avisos.push("STREAM_INVALIDO");
            return null;
        }
    }
}
const latin1 = (bytes) => Buffer.from(bytes).toString("latin1");
/** Todas as posições de uma palavra-chave, em uma passada (linear). */
function posicoes(texto, palavra, trabalho) {
    const lista = [];
    let i = texto.indexOf(palavra);
    while (i >= 0) {
        lista.push(i);
        trabalho.gastar(1);
        i = texto.indexOf(palavra, i + palavra.length);
    }
    return lista;
}
/** Primeira posição ≥ alvo (busca binária): evita `indexOf` repetido, que seria quadrático. */
function proxima(lista, alvo) {
    let baixo = 0;
    let alto = lista.length;
    while (baixo < alto) {
        const meio = (baixo + alto) >>> 1;
        if (lista[meio] < alvo)
            baixo = meio + 1;
        else
            alto = meio;
    }
    return baixo < lista.length ? lista[baixo] : -1;
}
/**
 * Dicionários legítimos têm poucos KB. Nenhuma expressão regular roda sobre um dicionário maior que
 * `LIMITES.bytesDicionario` (o excesso é descartado com aviso), e todo quantificador tem teto.
 */
function limitarDicionario(texto, inicio, fim, leitor) {
    if (fim - inicio > exports.LIMITES.bytesDicionario) {
        leitor.avisos.push("DICIONARIO_GRANDE");
        return texto.slice(inicio, inicio + exports.LIMITES.bytesDicionario);
    }
    return texto.slice(inicio, fim);
}
/** Varredura "n g obj ... endobj", pulando o conteúdo binário de cada stream. */
function lerObjetos(bytes, leitor) {
    const texto = latin1(bytes);
    leitor.trabalho.gastar(texto.length);
    const fins = posicoes(texto, "endobj", leitor.trabalho);
    const inicioStreams = posicoes(texto, "stream", leitor.trabalho).filter((p) => texto.slice(p - 3, p) !== "end");
    const finsStream = posicoes(texto, "endstream", leitor.trabalho);
    const cabecalho = /(\d{1,9})\s{1,64}(\d{1,5})\s{1,64}obj\b/g;
    let achado;
    while ((achado = cabecalho.exec(texto))) {
        leitor.trabalho.gastar(1);
        if (leitor.objetos.size >= exports.LIMITES.objetos) {
            leitor.avisos.push("LIMITE_OBJETOS");
            break;
        }
        const num = Number(achado[1]);
        const inicio = achado.index + achado[0].length;
        const fimObj = proxima(fins, inicio);
        if (fimObj < 0)
            break;
        const posStream = proxima(inicioStreams, inicio);
        if (posStream >= 0 && posStream < fimObj) {
            let dados = posStream + "stream".length;
            if (texto[dados] === "\r")
                dados += 1;
            if (texto[dados] === "\n")
                dados += 1;
            const fimStream = proxima(finsStream, dados);
            if (fimStream < 0)
                break;
            let fimDados = fimStream;
            if (texto[fimDados - 1] === "\n")
                fimDados -= 1;
            if (texto[fimDados - 1] === "\r")
                fimDados -= 1;
            leitor.objetos.set(num, { dicionario: limitarDicionario(texto, inicio, posStream, leitor), stream: bytes.subarray(dados, Math.max(dados, fimDados)) });
            const depois = proxima(fins, fimStream);
            cabecalho.lastIndex = depois < 0 ? texto.length : depois + 6;
        }
        else {
            leitor.objetos.set(num, { dicionario: limitarDicionario(texto, inicio, fimObj, leitor), stream: null });
            cabecalho.lastIndex = fimObj + 6;
        }
    }
}
/** Objetos comprimidos dentro de /ObjStm. */
function lerObjectStreams(leitor) {
    for (const objeto of [...leitor.objetos.values()]) {
        if (!objeto.stream || !/\/Type\s*\/ObjStm\b/.test(objeto.dicionario))
            continue;
        const n = Number(objeto.dicionario.match(/\/N\s{1,64}(\d{1,6})/)?.[1]);
        const primeiro = Number(objeto.dicionario.match(/\/First\s{1,64}(\d{1,9})/)?.[1]);
        const dados = leitor.descomprimir(objeto.stream, objeto.dicionario);
        if (!dados || !Number.isSafeInteger(n) || !Number.isSafeInteger(primeiro))
            continue;
        const texto = latin1(dados);
        const pares = texto.slice(0, primeiro).trim().split(/\s+/).map(Number);
        for (let i = 0; i < n && i * 2 + 1 < pares.length; i += 1) {
            leitor.trabalho.gastar(1);
            if (leitor.objetos.size >= exports.LIMITES.objetos) {
                leitor.avisos.push("LIMITE_OBJETOS");
                return;
            }
            const num = pares[i * 2];
            const inicio = primeiro + pares[i * 2 + 1];
            const fim = i + 1 < n ? primeiro + pares[(i + 1) * 2 + 1] : texto.length;
            if (!Number.isSafeInteger(num) || !Number.isSafeInteger(inicio) || !Number.isSafeInteger(fim) || inicio < 0 || fim < inicio)
                continue;
            if (!leitor.objetos.has(num) || leitor.objetos.get(num).stream === null) {
                leitor.objetos.set(num, { dicionario: limitarDicionario(texto, inicio, fim, leitor), stream: null });
            }
        }
    }
}
function referencia(texto, chave) {
    const achado = texto.match(new RegExp(`/${chave}\\s{1,64}(\\d{1,9})\\s{1,64}\\d{1,9}\\s{1,64}R`));
    return achado ? { num: Number(achado[1]) } : null;
}
function referencias(texto) {
    return [...texto.matchAll(/(\d{1,9})\s{1,64}\d{1,9}\s{1,64}R/g)].map((m) => Number(m[1]));
}
/** Conteúdo de `/Chave << ... >>` com dicionários aninhados. */
function subdicionario(texto, chave) {
    const inicio = texto.search(new RegExp(`/${chave}\\s{0,64}<<`));
    if (inicio < 0)
        return null;
    const i = texto.indexOf("<<", inicio);
    let profundidade = 0;
    for (let j = i; j < texto.length - 1; j += 1) {
        if (texto[j] === "<" && texto[j + 1] === "<") {
            profundidade += 1;
            j += 1;
            continue;
        }
        if (texto[j] === ">" && texto[j + 1] === ">") {
            profundidade -= 1;
            if (profundidade === 0)
                return texto.slice(i + 2, j);
            j += 1;
        }
    }
    return null;
}
/**
 * Destino do CMap em UTF-16BE. Devolve as unidades de código, ou null quando o destino não é
 * representável (vazio, ímpar, longo demais ou com surrogate inválido). Nunca lança.
 */
function unidadesUtf16(hex) {
    if (hex.length === 0 || hex.length > exports.LIMITES.digitosDestino)
        return null;
    if (hex.length <= 2)
        return [parseInt(hex, 16)];
    if (hex.length % 4 !== 0)
        return null;
    const unidades = [];
    for (let i = 0; i < hex.length; i += 4)
        unidades.push(parseInt(hex.slice(i, i + 4), 16));
    for (let i = 0; i < unidades.length; i += 1) {
        const u = unidades[i];
        if (u >= 0xd800 && u <= 0xdbff) {
            const baixo = unidades[i + 1];
            if (baixo === undefined || baixo < 0xdc00 || baixo > 0xdfff)
                return null;
            i += 1;
        }
        else if (u >= 0xdc00 && u <= 0xdfff)
            return null;
    }
    return unidades;
}
function codigoSeguro(hex) {
    if (hex.length === 0 || hex.length > exports.LIMITES.digitosCodigo)
        return null;
    const n = parseInt(hex, 16);
    return Number.isSafeInteger(n) ? n : null;
}
/**
 * CMap /ToUnicode: bfchar e bfrange (forma inicial e forma de array).
 * Intervalo inválido (fora de inteiro seguro, descendente, amplo demais) ou destino Unicode inválido
 * é descartado e anotado em `avisos`; nada aqui lança nem itera sem limite.
 */
function lerToUnicode(cmap, avisos = [], trabalho = new Trabalho({})) {
    const mapa = new Map();
    const definir = (codigo, destino) => {
        if (mapa.size >= exports.LIMITES.entradasCmap) {
            avisos.push("CMAP_GRANDE");
            return false;
        }
        mapa.set(codigo, destino);
        return true;
    };
    const bfchar = (origem, destino) => {
        const codigo = origem.valido ? codigoSeguro(origem.digitos) : null;
        const unidades = destino.valido ? unidadesUtf16(destino.digitos) : null;
        if (codigo === null || unidades === null) {
            avisos.push("CMAP_INVALIDO");
            return true;
        }
        return definir(codigo, String.fromCharCode(...unidades));
    };
    const bfrange = (a, b, destino) => {
        const inicio = a.valido ? codigoSeguro(a.digitos) : null;
        const fim = b.valido ? codigoSeguro(b.digitos) : null;
        if (inicio === null || fim === null || fim < inicio || fim - inicio + 1 > exports.LIMITES.amplitudeRange) {
            avisos.push("CMAP_RANGE_INVALIDO");
            return true;
        }
        if (Array.isArray(destino)) {
            for (const [k, d] of destino.slice(0, fim - inicio + 1).entries()) {
                trabalho.gastar(1);
                const unidades = d.valido ? unidadesUtf16(d.digitos) : null;
                if (unidades === null) {
                    avisos.push("CMAP_INVALIDO");
                    continue;
                }
                if (!definir(inicio + k, String.fromCharCode(...unidades)))
                    return false;
            }
            return true;
        }
        const base = destino.valido ? unidadesUtf16(destino.digitos) : null;
        if (base === null) {
            avisos.push("CMAP_INVALIDO");
            return true;
        }
        // A especificação incrementa a última unidade do destino.
        for (let passo = 0; passo <= fim - inicio; passo += 1) {
            trabalho.gastar(1);
            const ultima = base[base.length - 1] + passo;
            if (ultima > 0xffff || (ultima >= 0xd800 && ultima <= 0xdfff && base.length === 1)) {
                avisos.push("CMAP_INVALIDO");
                break;
            }
            if (!definir(inicio + passo, String.fromCharCode(...base.slice(0, -1), ultima)))
                return false;
        }
        return true;
    };
    // Máquina de estados sobre os tokens: NENHUM → (beginbfchar) BFCHAR / (beginbfrange) BFRANGE → (end…) NENHUM.
    // Bloco sem fechamento termina no próximo begin (com aviso) ou no fim: nunca há releitura do texto.
    let modo = "NENHUM";
    let pendentes = [];
    let blocos = 0;
    const lexer = new LexerCmap(cmap, trabalho, avisos);
    for (let token = lexer.proximo(); token; token = lexer.proximo()) {
        if (token.tipo === "palavra") {
            if (token.valor === "beginbfchar" || token.valor === "beginbfrange") {
                if (modo !== "NENHUM")
                    avisos.push("CMAP_BLOCO_SEM_FIM");
                blocos += 1;
                if (blocos > exports.LIMITES.blocosCmap) {
                    avisos.push("CMAP_GRANDE");
                    break;
                }
                modo = token.valor === "beginbfchar" ? "BFCHAR" : "BFRANGE";
                pendentes = [];
            }
            else if (token.valor === "endbfchar" || token.valor === "endbfrange") {
                if (pendentes.length)
                    avisos.push("CMAP_INVALIDO");
                modo = "NENHUM";
                pendentes = [];
            }
            continue;
        }
        if (modo === "NENHUM")
            continue;
        pendentes.push(token.tipo === "hex" ? token.hex : token.itens);
        if (modo === "BFCHAR" && pendentes.length === 2) {
            const [origem, destino] = pendentes;
            pendentes = [];
            if (Array.isArray(origem) || Array.isArray(destino)) {
                avisos.push("CMAP_INVALIDO");
                continue;
            }
            if (!bfchar(origem, destino))
                return mapa;
        }
        else if (modo === "BFRANGE" && pendentes.length === 3) {
            const [a, b, destino] = pendentes;
            pendentes = [];
            if (Array.isArray(a) || Array.isArray(b)) {
                avisos.push("CMAP_RANGE_INVALIDO");
                continue;
            }
            if (!bfrange(a, b, destino))
                return mapa;
        }
    }
    if (modo !== "NENHUM")
        avisos.push("CMAP_BLOCO_SEM_FIM");
    return mapa;
}
/**
 * Léxico linear do CMap: cada caractere é lido uma vez e contado no orçamento (prazo e cancelamento
 * valem durante a leitura). Não há expressão regular. Tetos: bytes analisados, tokens, dígitos por
 * token e itens por array; acima deles o token é inválido ou a leitura para, com aviso.
 */
class LexerCmap {
    i = 0;
    tokens = 0;
    fim;
    texto;
    trabalho;
    avisos;
    constructor(texto, trabalho, avisos) {
        this.texto = texto;
        this.trabalho = trabalho;
        this.avisos = avisos;
        this.fim = Math.min(texto.length, exports.LIMITES.bytesCmap);
        if (texto.length > exports.LIMITES.bytesCmap)
            avisos.push("CMAP_TRUNCADO");
    }
    avancar() {
        this.trabalho.gastar(1);
        this.i += 1;
    }
    hex() {
        // Posição atual: "<". Lê até ">" (ou o fim), sem voltar.
        this.avancar();
        let digitos = "";
        let valido = true;
        while (this.i < this.fim && this.texto[this.i] !== ">") {
            const c = this.texto[this.i];
            if (/[0-9a-fA-F]/.test(c)) {
                if (digitos.length < exports.LIMITES.digitosToken)
                    digitos += c;
                else
                    valido = false;
            }
            else if (c !== " " && c !== "\n" && c !== "\r" && c !== "\t" && c !== "\f") {
                valido = false;
            }
            this.avancar();
        }
        if (this.i >= this.fim)
            valido = false;
        else
            this.avancar();
        return { digitos, valido };
    }
    proximo() {
        while (this.i < this.fim) {
            if (++this.tokens > exports.LIMITES.tokensCmap) {
                this.avisos.push("CMAP_GRANDE");
                return null;
            }
            const c = this.texto[this.i];
            if (c === "<") {
                if (this.texto[this.i + 1] === "<") {
                    this.avancar();
                    this.avancar();
                    continue;
                }
                return { tipo: "hex", hex: this.hex() };
            }
            if (c === "[") {
                this.avancar();
                const itens = [];
                while (this.i < this.fim && this.texto[this.i] !== "]") {
                    if (this.texto[this.i] === "<" && this.texto[this.i + 1] !== "<") {
                        const h = this.hex();
                        if (itens.length < exports.LIMITES.itensArray)
                            itens.push(h);
                    }
                    else {
                        this.avancar();
                    }
                }
                if (this.i < this.fim)
                    this.avancar();
                return { tipo: "array", itens };
            }
            if (c === "%") {
                while (this.i < this.fim && this.texto[this.i] !== "\n" && this.texto[this.i] !== "\r")
                    this.avancar();
                continue;
            }
            if ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z")) {
                let palavra = "";
                while (this.i < this.fim) {
                    const l = this.texto[this.i];
                    if (!((l >= "a" && l <= "z") || (l >= "A" && l <= "Z")))
                        break;
                    if (palavra.length < 32)
                        palavra += l;
                    this.avancar();
                }
                return { tipo: "palavra", valor: palavra };
            }
            this.avancar();
        }
        return null;
    }
}
function carregarFonte(leitor, dicionarioFonte) {
    const composta = /\/Subtype\s*\/Type0\b/.test(dicionarioFonte);
    const ref = referencia(dicionarioFonte, "ToUnicode");
    const cmapObj = ref ? leitor.objetos.get(ref.num) : undefined;
    const dados = cmapObj?.stream ? leitor.descomprimir(cmapObj.stream, cmapObj.dicionario) : null;
    const mapa = dados ? lerToUnicode(latin1(dados), leitor.avisos, leitor.trabalho) : null;
    const doisBytes = composta || (mapa !== null && [...mapa.keys()].some((k) => k > 0xff));
    return { mapa, bytesPorCodigo: doisBytes ? 2 : 1 };
}
function fontesDaPagina(leitor, recursos, cache) {
    const fontes = new Map();
    let dicionario = subdicionario(recursos, "Font");
    const ref = dicionario === null ? referencia(recursos, "Font") : null;
    if (ref)
        dicionario = leitor.objetos.get(ref.num)?.dicionario ?? null;
    if (!dicionario)
        return fontes;
    for (const par of dicionario.matchAll(/\/([A-Za-z0-9_.+-]{1,127})\s{1,64}(\d{1,9})\s{1,64}\d{1,9}\s{1,64}R/g)) {
        const num = Number(par[2]);
        // Mesma fonte em várias páginas: CMap lido uma vez só.
        if (!cache.has(num)) {
            const objeto = leitor.objetos.get(num);
            if (objeto)
                cache.set(num, carregarFonte(leitor, objeto.dicionario));
        }
        const fonte = cache.get(num);
        if (fonte)
            fontes.set(par[1], fonte);
    }
    return fontes;
}
function lerStringLiteral(t, i, trabalho) {
    const bytes = [];
    let profundidade = 1;
    let j = i + 1;
    while (j < t.length && profundidade > 0) {
        trabalho.gastar(1);
        const c = t[j];
        if (c === "\\") {
            const n = t[j + 1];
            const escapes = { n: 10, r: 13, t: 9, b: 8, f: 12, "(": 40, ")": 41, "\\": 92 };
            if (n in escapes) {
                bytes.push(escapes[n]);
                j += 2;
                continue;
            }
            if (n >= "0" && n <= "7") {
                const octal = t.slice(j + 1, j + 4).match(/^[0-7]{1,3}/)[0];
                bytes.push(parseInt(octal, 8) & 0xff);
                j += 1 + octal.length;
                continue;
            }
            if (n === "\r" || n === "\n") {
                j += n === "\r" && t[j + 2] === "\n" ? 3 : 2;
                continue;
            }
            j += 2;
            continue;
        }
        if (c === "(")
            profundidade += 1;
        if (c === ")") {
            profundidade -= 1;
            if (profundidade === 0)
                break;
        }
        bytes.push(c.charCodeAt(0) & 0xff);
        j += 1;
    }
    return { bytes, fim: j + 1 };
}
function tokenizar(t, trabalho) {
    const tokens = [];
    const pilha = [tokens];
    let i = 0;
    const topo = () => pilha[pilha.length - 1];
    while (i < t.length) {
        trabalho.gastar(1);
        const c = t[i];
        if (/\s/.test(c)) {
            i += 1;
            continue;
        }
        if (c === "%") {
            while (i < t.length && t[i] !== "\n" && t[i] !== "\r") {
                i += 1;
                trabalho.gastar(1);
            }
            continue;
        }
        if (c === "(") {
            const s = lerStringLiteral(t, i, trabalho);
            topo().push({ tipo: "string", bytes: s.bytes });
            i = s.fim;
            continue;
        }
        if (c === "<" && t[i + 1] === "<") {
            i += 2;
            continue;
        }
        if (c === ">" && t[i + 1] === ">") {
            i += 2;
            continue;
        }
        if (c === "<") {
            const fim = t.indexOf(">", i);
            const hex = t.slice(i + 1, fim < 0 ? t.length : fim).replace(/\s/g, "");
            trabalho.gastar(hex.length);
            const par = hex.length % 2 ? `${hex}0` : hex;
            const bytes = [];
            for (let k = 0; k < par.length; k += 2)
                bytes.push(parseInt(par.slice(k, k + 2), 16) || 0);
            topo().push({ tipo: "string", bytes });
            i = fim < 0 ? t.length : fim + 1;
            continue;
        }
        // Aninhamento de arrays limitado: sem pilha ilimitada.
        if (c === "[") {
            const itens = [];
            topo().push({ tipo: "array", itens });
            if (pilha.length < 64)
                pilha.push(itens);
            i += 1;
            continue;
        }
        if (c === "]") {
            if (pilha.length > 1)
                pilha.pop();
            i += 1;
            continue;
        }
        if (c === "/") {
            const m = t.slice(i + 1, i + 128).match(/^[^\s/[\]()<>{}%]*/)[0];
            topo().push({ tipo: "nome", valor: m });
            i += 1 + m.length;
            continue;
        }
        const numero = t.slice(i, i + 32).match(/^[+-]?(\d+\.?\d*|\.\d+)/);
        if (numero) {
            topo().push({ tipo: "numero", valor: Number(numero[0]) });
            i += numero[0].length;
            continue;
        }
        const op = t.slice(i, i + 16).match(/^[A-Za-z'"*]+/);
        if (op) {
            topo().push({ tipo: "operador", valor: op[0] });
            i += op[0].length;
            continue;
        }
        i += 1;
    }
    return tokens;
}
function decodificar(bytes, fonte) {
    if (!fonte)
        return String.fromCharCode(...bytes);
    if (fonte.bytesPorCodigo === 2) {
        if (!fonte.mapa)
            return "";
        let saida = "";
        for (let i = 0; i + 1 < bytes.length; i += 2)
            saida += fonte.mapa.get((bytes[i] << 8) | bytes[i + 1]) ?? "";
        return saida;
    }
    return bytes.map((b) => fonte.mapa?.get(b) ?? String.fromCharCode(b)).join("");
}
function textoDoConteudo(conteudo, fontes, trabalho = new Trabalho({})) {
    const linhas = [];
    let atual = "";
    let fonte;
    let yAtual = null;
    const quebrar = () => { if (atual.trim())
        linhas.push(atual.replace(/\s+/g, " ").trim()); atual = ""; };
    const operandos = [];
    for (const token of tokenizar(conteudo, trabalho)) {
        trabalho.gastar(1);
        if (token.tipo !== "operador") {
            operandos.push(token);
            continue;
        }
        const op = token.valor;
        const num = (k) => { const t = operandos[operandos.length - k]; return t?.tipo === "numero" ? t.valor : 0; };
        if (op === "Tf") {
            const nome = operandos.find((t) => t.tipo === "nome");
            fonte = nome ? fontes.get(nome.valor) : undefined;
        }
        else if (op === "Td" || op === "TD") {
            if (num(1) !== 0)
                quebrar();
            else if (num(2) > 0 && atual && !atual.endsWith(" "))
                atual += " ";
        }
        else if (op === "Tm") {
            const y = num(1);
            if (yAtual !== null && Math.abs(y - yAtual) > 0.5)
                quebrar();
            else if (atual && !atual.endsWith(" "))
                atual += " ";
            yAtual = y;
        }
        else if (op === "T*" || op === "ET") {
            quebrar();
        }
        else if (op === "Tj" || op === "'" || op === "\"") {
            if (op !== "Tj")
                quebrar();
            const s = [...operandos].reverse().find((t) => t.tipo === "string");
            if (s) {
                trabalho.gastar(s.bytes.length);
                atual += decodificar(s.bytes, fonte);
            }
        }
        else if (op === "TJ") {
            const arr = [...operandos].reverse().find((t) => t.tipo === "array");
            for (const item of arr?.itens ?? []) {
                trabalho.gastar(1);
                if (item.tipo === "string")
                    atual += decodificar(item.bytes, fonte);
                else if (item.tipo === "numero" && item.valor < -200 && !atual.endsWith(" "))
                    atual += " ";
            }
        }
        operandos.length = 0;
    }
    quebrar();
    return linhas.join("\n");
}
// ---------------------------------------------------------------- árvore de páginas
function paginasEmOrdem(leitor) {
    const catalogo = [...leitor.objetos.values()].find((o) => /\/Type\s*\/Catalog\b/.test(o.dicionario));
    const raiz = catalogo ? referencia(catalogo.dicionario, "Pages") : null;
    const paginas = [];
    const visitados = new Set();
    const visitar = (num, recursosHerdados, profundidade) => {
        leitor.trabalho.gastar(1);
        if (visitados.has(num) || profundidade > 32 || paginas.length >= exports.LIMITES.paginas)
            return;
        visitados.add(num);
        const objeto = leitor.objetos.get(num);
        if (!objeto)
            return;
        const proprios = subdicionario(objeto.dicionario, "Resources")
            ?? (() => { const r = referencia(objeto.dicionario, "Resources"); return r ? leitor.objetos.get(r.num)?.dicionario ?? null : null; })();
        const recursos = proprios ?? recursosHerdados;
        if (/\/Type\s*\/Page\b/.test(objeto.dicionario)) {
            paginas.push({ objeto, recursos });
            return;
        }
        const kids = objeto.dicionario.match(/\/Kids\s{0,64}\[([^\]]{0,16384})\]/)?.[1] ?? "";
        for (const filho of referencias(kids))
            visitar(filho, recursos, profundidade + 1);
    };
    if (raiz)
        visitar(raiz.num, "", 0);
    if (paginas.length === 0) {
        // Sem árvore legível: páginas na ordem dos objetos.
        for (const objeto of leitor.objetos.values()) {
            if (/\/Type\s*\/Page\b/.test(objeto.dicionario) && paginas.length < exports.LIMITES.paginas)
                paginas.push({ objeto, recursos: objeto.dicionario });
        }
    }
    if (paginas.length >= exports.LIMITES.paginas)
        leitor.avisos.push("LIMITE_PAGINAS");
    return paginas;
}
function conteudoDaPagina(leitor, pagina) {
    const valor = pagina.dicionario.match(/\/Contents\s{0,64}(\[[^\]]{0,16384}\]|\d{1,9}\s{1,64}\d{1,9}\s{1,64}R)/)?.[1] ?? "";
    return referencias(valor).map((num) => {
        const objeto = leitor.objetos.get(num);
        const dados = objeto?.stream ? leitor.descomprimir(objeto.stream, objeto.dicionario) : null;
        return dados ? latin1(dados) : "";
    }).join("\n");
}
/**
 * Nunca lança por conteúdo do arquivo. Interrompida (orçamento, prazo ou cancelamento), devolve as
 * páginas lidas até ali e `interrompido` preenchido: a importação trata como "precisa revisão".
 */
function extrairTextoPdf(bytes, opcoes = {}) {
    const leitor = new Leitor(new Trabalho(opcoes));
    const paginas = [];
    try {
        lerObjetos(bytes, leitor);
        lerObjectStreams(leitor);
        const cache = new Map();
        for (const { objeto, recursos } of paginasEmOrdem(leitor)) {
            paginas.push(textoDoConteudo(conteudoDaPagina(leitor, objeto), fontesDaPagina(leitor, recursos, cache), leitor.trabalho));
        }
        return { paginas, avisos: [...new Set(leitor.avisos)], interrompido: null };
    }
    catch (erro) {
        if (erro instanceof Interrupcao) {
            return { paginas, avisos: [...new Set([...leitor.avisos, erro.motivo])], interrompido: erro.motivo };
        }
        // Qualquer outra falha de leitura (estrutura corrompida) também é controlada.
        return { paginas, avisos: [...new Set([...leitor.avisos, "PDF_INVALIDO"])], interrompido: null };
    }
}
/** Há texto nativo suficiente para extrair campos sem visão/OCR? Interrompida nunca conta como completa. */
function temTextoNativo(texto) {
    return texto.interrompido === null && texto.paginas.join(" ").replace(/\s+/g, "").length >= 80;
}
const node_worker_threads_1 = require("node:worker_threads");
/**
 * Entrada do Worker de extração de PDF. Roda isolada do event loop do servidor: se um PDF hostil
 * escapar dos limites do parser, quem chama encerra este Worker (`terminate`) no prazo.
 */
const dados = node_worker_threads_1.workerData;
node_worker_threads_1.parentPort?.postMessage(extrairTextoPdf(new Uint8Array(dados.bytes), dados.opcoes));
