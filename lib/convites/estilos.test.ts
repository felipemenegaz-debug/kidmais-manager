import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { adicionarReferenciaEstilo, ESTILOS, idadeInfantil, orientacaoFoto, pastaReferencias, prepararConviteCompleto, referenciasEstilo, type Estilo } from './estilos.ts';

const MARCAS = { cartoon3d: /CARICATURA CARTOON 3D/, cartoon2d: /DESENHO CARTOON 2D/, realista: /FOTOGRAFIA REALISTA/ } as const;
const TEMA_CIENCIA = /laborat|jaleco|frasco|béquer|tubo de ensaio|microscópio|ciência|cientista|livros?\b/i;
const campos = (idade = '8 anos') => ({ nome: 'Ana', idade, data: '2026-10-10', horario: '17:00', local: 'Kidmais', endereco: 'Asa Norte', mensagem: 'Venha brincar' });
const lerSimulado = async (arquivo: string) => Buffer.from(`ref:${path.basename(arquivo)}`);
async function montar(estilo: Estilo, foto?: Buffer, idade?: string) {
  const p = prepararConviteCompleto('Tema fazenda, verde e amarelo, com um cavalo', campos(idade), estilo);
  return adicionarReferenciaEstilo(foto ? { ...p, foto, promptImagem: p.promptImagem + orientacaoFoto(estilo) } : p, undefined, lerSimulado);
}

test('estilos: cada estilo recebe somente as próprias instruções, com e sem foto; dados oficiais preservados', async () => {
  for (const estilo of Object.keys(MARCAS) as (keyof typeof MARCAS)[]) for (const foto of [undefined, Buffer.from('foto')]) {
    const { promptImagem } = await montar(estilo, foto, '41 anos');
    for (const [outro, marca] of Object.entries(MARCAS)) (outro === estilo ? assert.match : assert.doesNotMatch)(promptImagem, marca, `${estilo}/${outro}`);
    assert.match(promptImagem, /PEDIDO VISUAL — Tema fazenda, verde e amarelo, com um cavalo/);
    assert.match(promptImagem, /"nome":"Ana","idade":"41 anos","data":"10\/10\/2026","horario":"17:00","local":"Kidmais","endereco":"Asa Norte","mensagem":"Venha brincar"/);
    assert.equal(/REFERÊNCIA — Imagem 1/.test(promptImagem), !!foto);
  }
  assert.deepEqual(ESTILOS, ['pedido', 'cartoon3d', 'cartoon2d', 'realista']);
  assert.throws(() => prepararConviteCompleto('Tema fazenda', campos(), 'inventado' as Estilo), /Estilo inválido/);
});

test('estilos: conflito de nome/idade entre pedido e dados da festa é recusado antes da IA', () => {
  assert.throws(() => prepararConviteCompleto('aniversário da Maria 9 anos', { ...campos('10 anos'), nome: 'Mariana' }), /divergem/);
  assert.equal(prepararConviteCompleto('Tema fazenda verde', campos()).campos.data, '2026-10-10');
});

test('estilos: com foto, imagem 1 = identidade e imagem 2 = referência aprovada do próprio estilo; sem foto, nenhuma referência', async () => {
  const foto = Buffer.from('foto');
  for (const [estilo, id] of [['cartoon3d', 'cartoon3d-aprovado-v2'], ['cartoon2d', 'cartoon2d-aprovado-v1'], ['realista', 'realista-aprovado-v1']] as const) {
    const p = await montar(estilo, foto);
    assert.equal(p.referenciaEstiloId, id);
    assert.deepEqual(p.referenciaEstilo, Buffer.from(`ref:${id}.webp`));
    assert.match(p.promptImagem, /^DIREÇÃO DE ARTE — .*imagem 1.*imagem 2/);
    assert.equal((await montar(estilo)).referenciaEstilo, undefined);
  }
  assert.equal((await montar('pedido', foto)).referenciaEstilo, undefined);
  // Referência de outro estilo ou com caminho é recusada antes de qualquer leitura.
  let lidas = 0;
  const base = { ...prepararConviteCompleto('Tema fazenda verde', campos(), 'realista'), foto };
  await assert.rejects(adicionarReferenciaEstilo(base, { realista: referenciasEstilo.cartoon3d }, async () => { lidas++; return Buffer.alloc(0); }), /Referência de estilo inválida/);
  await assert.rejects(adicionarReferenciaEstilo(base, { realista: { id: 'realista-x', arquivo: '../realista-x.webp' } }, async () => { lidas++; return Buffer.alloc(0); }), /Referência de estilo inválida/);
  assert.equal(lidas, 0);
});

test('estilos: assets de referência existem no servidor, são distintos e lidos pelo leitor real', async () => {
  const hashes = new Set<string>();
  for (const [estilo, ref] of Object.entries(referenciasEstilo)) {
    const bytes = await readFile(path.join(pastaReferencias(), ref.arquivo));
    hashes.add(createHash('sha256').update(bytes).digest('hex'));
    const meta = await sharp(bytes).metadata();
    assert.equal(meta.format, 'webp'); assert.equal(meta.width, 667); assert.equal(meta.height, 1000);
    const p = await adicionarReferenciaEstilo({ ...prepararConviteCompleto('Tema fazenda verde', campos(), estilo as Estilo), foto: Buffer.from('f') });
    assert.deepEqual(p.referenciaEstilo, bytes);
  }
  assert.equal(hashes.size, 3);
});

test('estilos: referências com tema ciência nunca tornam seus elementos obrigatórios', async () => {
  for (const estilo of ESTILOS) {
    const { promptImagem } = await montar(estilo, Buffer.from('foto'));
    assert.doesNotMatch(promptImagem.replace(/O tema da imagem 2 e seus elementos \([^)]*\) não fazem parte do novo convite, salvo se o pedido abaixo os solicitar\./g, ''), TEMA_CIENCIA, estilo);
  }
  const real = await montar('realista', Buffer.from('foto'));
  for (const r of [/Iluminação suave de retrato, com fonte ampla e difusa e preenchimento frontal/, /sem manchas acinzentadas/, /Rosto, mãos e objetos segurados com nitidez compatível/, /desfoque suave apenas nos planos secundários/, /cinco dedos definidos e contato convincente/]) assert.match(real.promptImagem, r);
});

test('estilos: idade infantil só pelo campo oficial explícito, abaixo de 13 anos', () => {
  for (const idade of ['6', '6 anos', ' 6 Anos ', '1 ano', '12 anos', '6 meses', '1 mês', '18 meses']) assert.equal(idadeInfantil(idade), true, idade);
  for (const idade of ['13 anos', '41 anos', '', '0', '10/10/2026', '2026', 'Aniversário de 6 anos', '6 a 7 anos', '6 anos e meio', 'seis anos', '156 meses', undefined, 6]) assert.equal(idadeInfantil(idade), false, String(idade));
});

test('estilos: Cartoon 3D infantil usa uma única proporção de 20–30%; adulto mantém 50%; 2D e Realista intactos', async () => {
  for (const idade of ['6 anos', '6 meses']) {
    const { promptImagem } = await montar('cartoon3d', Buffer.from('foto'), idade);
    assert.match(promptImagem, /20–30% maior/); assert.doesNotMatch(promptImagem, /50% maior/);
    assert.equal(promptImagem.match(/cabeça aproximadamente/g)?.length, 1);
    assert.match(promptImagem, /sem aparência de bebê nem de boneco de cabeça gigante/);
    assert.match(promptImagem, /prevalece sobre a imagem 2\./);
    for (const r of [/olhos muito grandes/, /ALINHAMENTO DO OLHAR/, /sorriso amplo/, /mechas esculpidas/]) assert.match(promptImagem, r);
  }
  for (const idade of ['41 anos', '13 anos', '', '6 a 7 anos']) {
    const { promptImagem } = await montar('cartoon3d', Buffer.from('foto'), idade);
    assert.match(promptImagem, /50% maior/); assert.doesNotMatch(promptImagem, /20–30% maior|PROPORÇÃO INFANTIL|prevalece sobre a imagem 2/);
  }
  for (const estilo of ['cartoon2d', 'realista', 'pedido'] as const) {
    const crianca = (await montar(estilo, Buffer.from('foto'), '6 anos')).promptImagem.replaceAll('"6 anos"', '"X"');
    assert.equal(crianca, (await montar(estilo, Buffer.from('foto'), '41 anos')).promptImagem.replaceAll('"41 anos"', '"X"'), estilo);
  }
});
