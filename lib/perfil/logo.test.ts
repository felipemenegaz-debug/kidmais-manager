import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { conferirLogoSalva, prepararLogo } from './logo.ts';
import { erroArquivoLogo, LOGO_MAX_UPLOAD, LOGO_MAX_PNG } from './logo-limites.ts';

test('logo PNG acima do antigo limite de 2 MB é reduzida e validada para salvar', async () => {
    const png = await sharp({ create: { width: 1755, height: 1452, channels: 4, background: '#8877cc80' } }).png().toBuffer();
    const bytes = Buffer.concat([png, Buffer.alloc(3 * 1024 * 1024)]);
    assert(bytes.length > 2 * 1024 * 1024 && bytes.length < LOGO_MAX_UPLOAD);
    assert.equal(erroArquivoLogo({ name: 'logo-vertical.png', type: 'image/png', size: bytes.length }), null);
    const logo = await prepararLogo(bytes);
    const convertido = Buffer.from(logo.slice(22), 'base64');
    assert(convertido.length <= LOGO_MAX_PNG);
    const meta = await sharp(convertido).metadata();
    assert.equal(meta.height, 512); assert.equal(meta.hasAlpha, true);
    assert.equal(await conferirLogoSalva(logo), logo);
});

test('validação da seleção distingue formato, tamanho e arquivo vazio com nome e motivo', () => {
    assert.match(erroArquivoLogo({ name: 'grande.png', type: 'image/png', size: 11 * 1024 * 1024 })!, /grande\.png tem 11 MB.*até 10 MB/);
    assert.match(erroArquivoLogo({ name: 'vetor.svg', type: 'image/svg+xml', size: 30 })!, /Formato não aceito para vetor\.svg/);
    assert.match(erroArquivoLogo({ name: 'vazio.png', type: 'image/png', size: 0 })!, /vazio\.png está vazio/);
    assert.equal(erroArquivoLogo({ name: 'limite.png', type: 'image/png', size: LOGO_MAX_UPLOAD }), null);
});

test('logo reencoda PNG/JPEG/WebP, mantém proporção e transparência, e limita dimensões',async()=>{
    for(const formato of ['png','jpeg','webp'] as const) {
        const bytes=await sharp({create:{width:2000,height:500,channels:4,background:{r:20,g:30,b:40,alpha:.5}}}).toFormat(formato).toBuffer();
        const logo=await prepararLogo(bytes);
        const meta=await sharp(Buffer.from(logo.slice(22),'base64')).metadata();
        assert.equal(meta.format,'png');assert.equal(meta.width,1024);assert.equal(meta.height,256);
        if(formato==='png') assert.equal(meta.hasAlpha,true);
        assert.equal(await conferirLogoSalva(logo),logo);
    }
});
test('logo recusa SVG, arquivos inválidos, tamanho excessivo e URLs externas',async()=>{
    for(const bytes of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'),Buffer.from('arquivo falso'),Buffer.alloc(LOGO_MAX_UPLOAD+1)])
        await assert.rejects(prepararLogo(bytes),{code:'PERFIL_LOGO_INVALIDA'});
    for(const valor of ['https://exemplo/logo.png','data:image/svg+xml;base64,PHN2Zy8+','data:image/png;base64,@@@@','data:image/png;base64,YQ=='])
        await assert.rejects(conferirLogoSalva(valor),{code:'PERFIL_LOGO_INVALIDA'});
    assert.equal(await conferirLogoSalva(null),null);
});
