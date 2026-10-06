import qrcode from 'qrcode-generator';
import { cnpjValido, normalizarCnpj } from '../../cadastro/cnpj.ts';

/**
 * Pix "copia e cola" / QR ESTÁTICO (BR Code, padrão EMV-MPM do Manual de Padrões para Iniciação do Pix do BCB).
 *
 * Gerado localmente a partir da chave Pix DO BUFFET: não chama banco, gateway nem API, e o dinheiro cai direto na
 * conta do buffet. Não há confirmação automática — o recebimento continua sendo registrado na baixa existente.
 * O txid (até 25 alfanuméricos) só identifica a parcela no extrato do buffet; não é garantia de unicidade no banco.
 */

export const TIPOS_CHAVE_PIX = ['CPF', 'CNPJ', 'EMAIL', 'TELEFONE', 'ALEATORIA'] as const;
export type TipoChavePix = typeof TIPOS_CHAVE_PIX[number];

export type ChavePixNormalizada = { tipo: TipoChavePix; chave: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function cpfComDv(cpf: string) {
    if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf))
        return false;
    const dv = (base: string, peso: number) => {
        let soma = 0;
        for (let i = 0; i < base.length; i += 1)
            soma += Number(base[i]) * (peso - i);
        const resto = (soma * 10) % 11;
        return resto === 10 ? 0 : resto;
    };
    return dv(cpf.slice(0, 9), 10) === Number(cpf[9]) && dv(cpf.slice(0, 10), 11) === Number(cpf[10]);
}

/** Normaliza a chave no formato do DICT; devolve null quando não é uma chave válida do tipo informado. */
export function normalizarChavePix(tipo: TipoChavePix, valor: string): ChavePixNormalizada | null {
    const bruto = String(valor ?? '').trim();
    switch (tipo) {
        case 'CPF': {
            const cpf = bruto.replace(/\D/g, '');
            return cpfComDv(cpf) ? { tipo, chave: cpf } : null;
        }
        case 'CNPJ': {
            const cnpj = normalizarCnpj(bruto);
            return cnpjValido(cnpj) ? { tipo, chave: cnpj } : null;
        }
        case 'EMAIL': {
            const email = bruto.toLowerCase();
            return email.length <= 77 && /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(email) ? { tipo, chave: email } : null;
        }
        case 'TELEFONE': {
            let digitos = bruto.replace(/\D/g, '');
            if (digitos.length === 10 || digitos.length === 11)
                digitos = '55' + digitos;
            return /^55[1-9]{2}9?\d{8}$/.test(digitos) ? { tipo, chave: '+' + digitos } : null;
        }
        case 'ALEATORIA': {
            const chave = bruto.toLowerCase();
            return UUID.test(chave) ? { tipo, chave } : null;
        }
        default:
            return null;
    }
}

/** Mostra só o necessário para a pessoa reconhecer a chave (nunca a chave inteira em listas ou auditoria). */
export function mascararChavePix(tipo: TipoChavePix, chave: string) {
    if (tipo === 'EMAIL') {
        const [usuario, dominio] = chave.split('@');
        return `${usuario.slice(0, 2)}***@${dominio ?? ''}`;
    }
    if (tipo === 'ALEATORIA')
        return `${chave.slice(0, 4)}…${chave.slice(-4)}`;
    return `${'*'.repeat(Math.max(0, chave.length - 4))}${chave.slice(-4)}`;
}

/** Texto aceito no BR Code: sem acentos, só ASCII imprimível simples, cortado no limite do campo. */
export function textoBrCode(valor: string, maximo: number) {
    return String(valor ?? '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^A-Za-z0-9 .,\-/&]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maximo)
        .trim();
}

/** txid do QR estático: até 25 caracteres [A-Za-z0-9]; "***" quando não há identificador. */
export function txidDaParcela(parcelaId: string) {
    const limpo = String(parcelaId ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    return limpo ? ('KM' + limpo).slice(0, 25) : '***';
}

function campo(id: string, valor: string) {
    if (valor.length > 99)
        throw new Error(`campo ${id} do BR Code acima de 99 caracteres`);
    return id + String(valor.length).padStart(2, '0') + valor;
}

/** CRC16/CCITT-FALSE (polinômio 0x1021, inicial 0xFFFF), exigido no campo 63. */
export function crc16(texto: string) {
    let crc = 0xffff;
    for (const byte of Buffer.from(texto, 'utf8')) {
        crc ^= byte << 8;
        for (let i = 0; i < 8; i += 1)
            crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    return crc.toString(16).toUpperCase().padStart(4, '0');
}

export type DadosBrCode = {
    chave: string;
    nomeRecebedor: string;
    cidadeRecebedor: string;
    /** Opcional: sem valor, quem paga digita o valor. */
    valorCentavos?: number | null;
    txid?: string | null;
    descricao?: string | null;
};

export function montarBrCodeEstatico(dados: DadosBrCode) {
    const nome = textoBrCode(dados.nomeRecebedor, 25);
    const cidade = textoBrCode(dados.cidadeRecebedor, 15);
    if (!dados.chave || !nome || !cidade)
        throw new Error('BR Code exige chave, nome e cidade do recebedor');
    const descricao = dados.descricao ? textoBrCode(dados.descricao, 40) : '';
    let conta = campo('00', 'br.gov.bcb.pix') + campo('01', dados.chave);
    if (descricao && conta.length + 4 + descricao.length <= 99)
        conta += campo('02', descricao);
    let valor = '';
    if (dados.valorCentavos !== undefined && dados.valorCentavos !== null) {
        if (!Number.isInteger(dados.valorCentavos) || dados.valorCentavos <= 0 || dados.valorCentavos > 999_999_999_99)
            throw new Error('valor do BR Code inválido');
        valor = campo('54', (dados.valorCentavos / 100).toFixed(2));
    }
    const txid = dados.txid && /^[A-Za-z0-9]{1,25}$/.test(dados.txid) ? dados.txid : '***';
    const semCrc = campo('00', '01')
        + campo('26', conta)
        + campo('52', '0000')
        + campo('53', '986')
        + valor
        + campo('58', 'BR')
        + campo('59', nome)
        + campo('60', cidade)
        + campo('62', campo('05', txid))
        + '6304';
    return semCrc + crc16(semCrc);
}

/** QR em SVG (correção M), gerado no servidor; o navegador só exibe a imagem. */
export function qrSvg(payload: string) {
    const qr = qrcode(0, 'M');
    qr.addData(payload, 'Byte');
    qr.make();
    return qr.createSvgTag({ cellSize: 6, margin: 4, scalable: true });
}
