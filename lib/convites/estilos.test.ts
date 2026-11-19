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

// Etapa 3b (§8): sem "geração com logo", o texto é o de staging d1a0f6f5 byte a byte (SHA-256 calculado daquela versão).
const camposLogo = (endereco: string) => ({ nome: 'Ana', idade: '8 anos', data: '2026-10-10', horario: '17:00', local: 'Salão Kidmais', endereco, mensagem: 'Venha brincar' });
const HASH_HOJE: Record<string, string> = {
  'pedido|Asa Norte': '70ad4c287feeeae0289415b1a905dc63c6d3d482c6f912886006d068c2f4af03', 'pedido|': '240a70adfd8372d9b0be00f96920dcf01a88790aa4b6de42b6a2a74d3ab8f367',
  'cartoon3d|Asa Norte': '2eacd68d6aa2ae9be43efea8b3beaebac3ab458aa73aa8290d2f32e311596914', 'cartoon3d|': 'afb49e5e90bc62b999713ab99eb786393d3f1f3bfca9141f1a020bdd766b5f77',
  'cartoon2d|Asa Norte': 'fe5abd151d9f26bfa1d9257a5072da44ebfc4b9e5c98b0afda99f727c67ef2b6', 'cartoon2d|': 'e936eba5dba1ff7c8d7431e3cf9448da344d5debb491d5eee0bebe97b07216ef',
  'realista|Asa Norte': '0d60feff001e8f71192fba6ec94fa5547ba42cae3749176b44ff0da353b0cea6', 'realista|': 'ff783232c7afe8d16fb865b3ad6458708fd987bea61d9729344e538d5dcf6edf',
};
test('pedido sem reservarLogo: igual ao de hoje, byte a byte, nos 4 estilos, com e sem endereço', () => {
  for (const chave of Object.keys(HASH_HOJE)) {
    const [estilo, endereco] = chave.split('|') as [Estilo, string];
    for (const p of [prepararConviteCompleto('Tema fazenda verde', camposLogo(endereco), estilo), prepararConviteCompleto('Tema fazenda verde', camposLogo(endereco), estilo, {}), prepararConviteCompleto('Tema fazenda verde', camposLogo(endereco), estilo, { reservarLogo: false })])
      assert.equal(createHash('sha256').update(p.promptImagem).digest('hex'), HASH_HOJE[chave], chave);
  }
});
test('pedido com reservarLogo: sem o local nos dados e com a linha da área lisa (com e sem endereço)', () => {
  const com = prepararConviteCompleto('Tema fazenda verde', camposLogo('Asa Norte'), 'pedido', { reservarLogo: true }).promptImagem;
  const sem = prepararConviteCompleto('Tema fazenda verde', camposLogo(''), 'pedido', { reservarLogo: true }).promptImagem;
  for (const p of [com, sem]) {
    const dados = JSON.parse(p.split('Dados da festa: ')[1]!);
    assert.ok(!('local' in dados), 'sem local');
    assert.equal(dados.nome, 'Ana');
    assert.ok(!p.includes('Salão Kidmais'));
    assert.match(p, /deixe uma área retangular de cor lisa, sem texto, desenho, moldura nem enfeite, com cerca de um quarto da largura do convite e um décimo da altura, centralizada na horizontal\. Ela receberá um selo aplicado depois\. Não desenhe logotipo, selo nem marca nessa área\./);
    assert.ok(!/data:image|base64|logoDataUrl/.test(p), 'nada da logo vai ao provedor');
  }
  assert.match(com, /COMPOSIÇÃO — .*sem texto sobre o rosto\. Logo acima do endereço, deixe/);
  assert.match(sem, /COMPOSIÇÃO — .*sem texto sobre o rosto\. Logo abaixo das informações da festa, deixe/);
  // Só muda o texto: o restante é o mesmo prefixo/sufixo do pedido de hoje.
  const hoje = prepararConviteCompleto('Tema fazenda verde', camposLogo('Asa Norte'), 'pedido').promptImagem;
  assert.equal(com.split('\nTEXTOS')[0]!.replace(/ Logo acima do endereço.*$/, ''), hoje.split('\nTEXTOS')[0]);
});
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
