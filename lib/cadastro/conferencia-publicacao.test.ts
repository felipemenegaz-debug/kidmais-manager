import assert from 'node:assert/strict';
import test from 'node:test';
import { conferirPublicacao } from './conferencia-publicacao.ts';
import { modoEntendimento } from '../whatsapp/atendimento/configuracao.ts';

const BOM = {
    CONVITES_IA_ENABLED: 'true', CONVITES_IA_PROVIDER: 'openai', WHATSAPP_ATENDIMENTO_WALLE_ENTENDIMENTO: 'regras',
    WHATSAPP_ATENDIMENTO_CANAL_ENVIO: 'meta', IDENTIDADE_OTP_PROVIDER: 'whatsapp_cloud',
    SITE_RAZAO_SOCIAL: 'Demerzel Labs Ltda.', SITE_CNPJ: '69.938.612/0001-26', ASSINATURA_COMPROVANTE_EMAIL: 'true',
};
const IA_OK = { provedorOpenAi: true, tetoEmpresa: true, tetoCapacidade: true };
const DESLIGADA = { capacidadeForaDaContratacaoAtiva: false, whatsappIa: IA_OK };
const MODELO = { WHATSAPP_ATENDIMENTO_WALLE_ENTENDIMENTO: 'modelo', WHATSAPP_ATENDIMENTO_IA_AUTORIZACAO: 'R6-2026-11-03-ata12' };
const falhas = (env: Record<string, string | undefined>, ia = DESLIGADA) => conferirPublicacao(env, ia).filter((i) => !i.ok).map((i) => i.id);

test('conferência pré-publicação: configuração coerente com o texto passa', () => {
    assert.deepEqual(falhas(BOM), []);
    assert.deepEqual(falhas({ ...BOM, CONVITES_IA_ENABLED: undefined, CONVITES_IA_PROVIDER: undefined }), [], 'convites com IA desligados não dependem do provedor');
    assert.deepEqual(falhas({ ...BOM, ...MODELO }), [], 'D-OF-1: modelo com autorização, OpenAI e os dois tetos');
    assert.deepEqual(falhas({ ...BOM, WHATSAPP_ATENDIMENTO_IA_AUTORIZACAO: 'R6-2026-11-03-ata12' }), [], 'autorização sem o modo modelo: regras');
    assert.deepEqual(falhas(BOM, { ...DESLIGADA, whatsappIa: { provedorOpenAi: false, tetoEmpresa: false, tetoCapacidade: false } }), [], 'modo regras não depende da IA');
});

test('conferência pré-publicação: whatsapp-ia concorda com o modo do runtime (modoEntendimento)', () => {
    for (const autorizacao of [undefined, '', 'sim', 'R6-', 'R6-ab', ' R6-2026-11-03-ata12', 'r6-x-y-z', 'R6-2026-11-03-ata12', 'R6-abc', 'R6-' + 'a'.repeat(80), 'R6-' + 'a'.repeat(81)]) {
        const env = { ...BOM, ...MODELO, WHATSAPP_ATENDIMENTO_IA_AUTORIZACAO: autorizacao, KIDMAIS_DEPLOY_ENV: 'production' };
        const runtime = modoEntendimento(env as unknown as NodeJS.ProcessEnv).modo === 'MODELO';
        assert.equal(falhas(env).includes('whatsapp-ia'), !runtime, `autorização ${JSON.stringify(autorizacao)}`);
    }
});

test('conferência pré-publicação: cada afirmação falsa do texto reprova o item correspondente', () => {
    assert.deepEqual(falhas({ ...BOM, CONVITES_IA_PROVIDER: undefined }), ['convites-provedor'], 'provedor ausente cai no Gemini');
    assert.deepEqual(falhas({ ...BOM, CONVITES_IA_PROVIDER: 'gemini' }), ['convites-provedor']);
    assert.deepEqual(falhas({ ...BOM, WHATSAPP_ATENDIMENTO_WALLE_ENTENDIMENTO: 'modelo' }), ['whatsapp-ia'], 'modelo sem autorização');
    assert.deepEqual(falhas({ ...BOM, ...MODELO, WHATSAPP_ATENDIMENTO_IA_AUTORIZACAO: '  ' }), ['whatsapp-ia'], 'autorização em branco');
    // Astra r1 P2: o mesmo formato R6 do runtime (FORMATO_AUTORIZACAO_IA em lib/whatsapp/atendimento/configuracao.ts).
    for (const malformada of ['sim', 'true', 'R6-', 'R6-ab', ' R6-2026-11-03-ata12', 'r6-2026-11-03-ata12', 'R6--2026', 'R6-2026 11 03'])
        assert.deepEqual(falhas({ ...BOM, ...MODELO, WHATSAPP_ATENDIMENTO_IA_AUTORIZACAO: malformada }), ['whatsapp-ia'], `autorização malformada: ${JSON.stringify(malformada)}`);
    for (const falta of ['provedorOpenAi', 'tetoEmpresa', 'tetoCapacidade'] as const)
        assert.deepEqual(falhas({ ...BOM, ...MODELO }, { ...DESLIGADA, whatsappIa: { ...IA_OK, [falta]: false } }), ['whatsapp-ia'], falta);
    assert.deepEqual(falhas({ ...BOM, ASSINATURA_COMPROVANTE_EMAIL: undefined }), ['comprovante-email']);
    assert.deepEqual(falhas(BOM, { ...DESLIGADA, capacidadeForaDaContratacaoAtiva: true }), ['assistente-importacao'], 'flags lidas em lib/inteligencia/flags.ts');
    assert.deepEqual(falhas({ ...BOM, CONTRACT_IMPORT_INTEGRATION_ENABLED: 'true' }), ['importacao-integracao']);
    assert.deepEqual(falhas({ ...BOM, WHATSAPP_ATENDIMENTO_CANAL_ENVIO: undefined }), ['whatsapp-canal-meta'], 'sem a variável o código envia pela Gupshup');
    assert.deepEqual(falhas({ ...BOM, WHATSAPP_ATENDIMENTO_CANAL_ENVIO: 'gupshup' }), ['whatsapp-canal-meta']);
    assert.deepEqual(falhas({ ...BOM, IDENTIDADE_OTP_PROVIDER: 'gupshup' }), ['otp-meta']);
    assert.deepEqual(falhas({ ...BOM, IDENTIDADE_OTP_PROVIDER: undefined }), ['otp-meta']);
    assert.deepEqual(falhas({ ...BOM, GUPSHUP_OTP_ENABLED: 'true' }), ['otp-meta']);
    assert.deepEqual(falhas({ ...BOM, SITE_RAZAO_SOCIAL: 'Mary Marra Menegaz – EPP' }), ['site-responsavel']);
    assert.deepEqual(falhas({ ...BOM, SITE_CNPJ: '20.119.900/0001-60' }), ['site-responsavel']);
});

test('conferência pré-publicação: o resultado não carrega valores do ambiente', () => {
    const segredo = 'sk-valor-que-nao-pode-vazar';
    const saida = JSON.stringify(conferirPublicacao({ ...BOM, WHATSAPP_ATENDIMENTO_IA_AUTORIZACAO: segredo, CONVITES_OPENAI_API_KEY: segredo }, DESLIGADA));
    assert.ok(!saida.includes(segredo));
});
