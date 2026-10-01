import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { conferirLogoSalva, prepararLogo } from './logo.ts';
import { LOGO_MAX_UPLOAD } from './logo-limites.ts';

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
