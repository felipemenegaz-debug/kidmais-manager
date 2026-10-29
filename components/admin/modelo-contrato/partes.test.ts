import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { carregarComponente, cssFalso } from '../teste-componente.ts';
import * as protegerSaida from './protegerSaida.ts';
import { comporContratada, erroContratada, type PerfilSede } from '../../../lib/contratos/modelo-empresa/contratada.ts';
import { diagnosticoModelo, type ConteudoModelo } from '../../../lib/contratos/modelo-empresa/conteudo.ts';
import { detectarValoresFixos } from '../../../lib/contratos/modelo-empresa/valores-fixos.ts';
import { CAMPOS_CONTRATO, CAMPOS_IDENTIFICACAO } from '../../../lib/contratos/modelo-empresa/campos.ts';

/** Partes de apresentação da revisão do modelo de contrato (plano v3): render estático, estados em texto e ícone. */
const m = carregarComponente('components/admin/modelo-contrato/partes.tsx', { './protegerSaida': protegerSaida, '../modelo-contrato.module.css': cssFalso });
const html = (nome: string, props: object) => renderToStaticMarkup(m.render(nome, props) as ReactElement);
const ROTULOS = Object.fromEntries(CAMPOS_CONTRATO.map((c) => [c.chave, c.rotulo]));

const MODELO: ConteudoModelo = {
  titulo: 'Contrato', contratada: { nome: 'Buffet do Modelo', documento: '12.345.678/0001-95', endereco: 'Rua A, 1', representante: 'Ana' },
  preambulo: [], observacoes: [], cidadeAssinatura: 'Goiânia/GO',
  clausulas: [{ titulo: 'Objeto', texto: 'Festa {{festa.pacote}} em 28/10/2026, das 17:00 às 21:00, para {{festa.convidados}} convidados.' }],
};
const PERFIL: PerfilSede = { versao: 12, razao_social: 'Buffet do Perfil Ltda', cnpj: '11222333000181', sede_cep: '74000000', sede_logradouro: 'Rua B', sede_numero: '2', sede_sem_numero: false, sede_complemento: null, sede_bairro: 'Centro', sede_cidade: 'Goiânia', sede_uf: 'GO' };

test('ContadorPublicar: "x de 7" e o motivo em texto e ícone', () => {
  assert.match(html('ContadorPublicar', { incluidos: 7, total: 7, outrosProblemas: 0, contratadaErro: false, semPerfil: false }), /✓ 7 de 7 dados da festa e do valor.*✓ Pronto para publicar\./);
  assert.match(html('ContadorPublicar', { incluidos: 5, total: 7, outrosProblemas: 0, contratadaErro: false, semPerfil: false }), /! 5 de 7.*! Faltam 2 para publicar\./);
  assert.match(html('ContadorPublicar', { incluidos: 7, total: 7, outrosProblemas: 1, contratadaErro: false, semPerfil: false }), /! Há 1 outro problema no texto\./);
  assert.match(html('ContadorPublicar', { incluidos: 7, total: 7, outrosProblemas: 0, contratadaErro: true, semPerfil: false }), /✕ Não é possível publicar: os dados da empresa não puderam ser lidos\./);
  assert.match(html('ContadorPublicar', { incluidos: 7, total: 7, outrosProblemas: 0, contratadaErro: false, semPerfil: true }), /Só quem gere a empresa pode publicar/);
});

test('BlocoIdentificacao: as 4 origens e a prévia sem perfil; perfil = dados só leitura + representante do modelo', () => {
  const base = { modelo: MODELO.contratada, rotulos: ROTULOS, identificacao: CAMPOS_IDENTIFICACAO, bloqueado: false };
  const perfil = html('BlocoIdentificacao', { ...base, contratada: comporContratada(PERFIL, MODELO) });
  assert.match(perfil, /✓ Dados do Perfil da empresa \(versão 12\)\./);
  assert.match(perfil, /Buffet do Perfil Ltda.*11\.222\.333\/0001-81.*Rua B, 2, Centro, Goiânia\/GO, CEP 74000-000/);
  assert.match(perfil, /Representante \(do modelo\)/);
  assert.doesNotMatch(perfil, /value="Buffet do Modelo"/, 'sem misturar com o bloco do modelo');
  const incompleto = html('BlocoIdentificacao', { ...base, contratada: comporContratada({ ...PERFIL, sede_cep: null }, MODELO) });
  assert.match(incompleto, /! Do modelo: o perfil está incompleto \(falta CEP da sede\)\./);
  assert.match(incompleto, /value="Buffet do Modelo"/);
  assert.match(html('BlocoIdentificacao', { ...base, contratada: comporContratada(null, MODELO) }), /! Do modelo: a empresa ainda não tem Perfil\./);
  const erro = html('BlocoIdentificacao', { ...base, contratada: erroContratada('Não foi possível ler os dados da empresa no perfil.') });
  assert.match(erro, /✕ Erro: Não foi possível ler/);
  assert.doesNotMatch(erro, /<input/, 'erro não cai no bloco do modelo');
  const semGestao = html('BlocoIdentificacao', { ...base, contratada: null });
  assert.match(semGestao, /Prévia sem os dados do perfil/);
  assert.doesNotMatch(semGestao, /Atualizar dados da empresa/);
  assert.match(perfil, /href="\/admin\/configuracoes\/perfil-empresa" target="_blank"/, 'Completar no perfil em nova aba');
  assert.match(perfil, /aria-label="Campo: Nome do contratante"/);
  assert.match(perfil, /Idade, tema e RG vazios saem como “não informado”/);
  assert.match(html('BlocoIdentificacao', { ...base, bloqueado: true, contratada: comporContratada(null, MODELO) }), /<input[^>]*disabled=""/);
});

test('PainelObrigatorios: "Incluído na Cláusula N" ou "Falta"; Trocar só com sugestão; Inserir sempre que falta', () => {
  const tela = { clausulas: MODELO.clausulas.map((c, i) => ({ id: `c${i}`, ...c })) };
  const h = html('PainelObrigatorios', { itens: diagnosticoModelo(MODELO).itens, sugestoes: detectarValoresFixos(tela.clausulas), bloqueado: false });
  assert.match(h, /✓ <strong>Pacote contratado<\/strong> — Incluído na Cláusula 1/);
  assert.match(h, /! <strong>Data da festa<\/strong> — Falta.*Trocar 28\/10\/2026 \(Cláusula 1\)/);
  assert.match(h, /! <strong>Horário de início<\/strong> — Falta.*Trocar das 17:00 às 21:00 \(Cláusula 1\)/);
  assert.match(h, /! <strong>Valor total do contrato<\/strong> — Falta<\/span><span[^>]*><button[^>]*aria-label="Inserir Valor total do contrato"/, 'sem sugestão: só Inserir');
  assert.match(h, /data-estado="falta"/);
});

test('ClausulaLeitura: campos como etiquetas e valores fixos tracejados, com nome acessível', () => {
  const clausula = { id: 'c0', ...MODELO.clausulas[0] };
  const h = html('ClausulaLeitura', { clausula, valoresFixos: detectarValoresFixos([clausula]), rotulos: ROTULOS });
  assert.match(h, /<span class="etiqueta" aria-label="Campo: Pacote contratado">Pacote contratado<\/span>/);
  assert.match(h, /<span class="tracejado" aria-label="Valor fixo: 28\/10\/2026, sugestão: Data da festa">28\/10\/2026<\/span>/);
  assert.match(h, /aria-label="Valor fixo: das 17:00 às 21:00, sugestão: Horário de início e de término"/);
  assert.match(h, /para <span class="etiqueta"[^>]*>Convidados contratados<\/span> convidados\./);
});

test('EstadoSalvamento: salvo, não salvo (com a ajuda do limite), salvando, incerto, não confirmado e falha ao conferir', () => {
  const b = { alterado: false, enviando: false, incerto: false, naoConfirmado: false, falhaConferir: false, salvoEm: '14:32' };
  assert.match(html('EstadoSalvamento', b), /✓ Salvo às 14:32/);
  assert.doesNotMatch(html('EstadoSalvamento', b), /Salve antes de sair/);
  const nao = html('EstadoSalvamento', { ...b, alterado: true });
  assert.match(nao, /● Alterações não salvas/);
  assert.ok(nao.includes(protegerSaida.AJUDA_LIMITE));
  assert.equal(protegerSaida.AJUDA_LIMITE, 'Salve antes de sair. Voltar pelo navegador, trocar de empresa, sair da conta ou a sessão expirar podem perder alterações não salvas sem a pergunta desta tela.');
  assert.match(html('EstadoSalvamento', { ...b, alterado: true, enviando: true }), /⟳ Salvando…/);
  assert.match(html('EstadoSalvamento', { ...b, alterado: true, incerto: true }), /! O salvamento não foi confirmado\. Ele pode ou não ter sido gravado, e ainda pode ser concluído\. <button[^>]*>Conferir/);
  assert.match(html('EstadoSalvamento', { ...b, alterado: true, naoConfirmado: true }), /ainda não foi confirmado no servidor/);
  assert.match(html('EstadoSalvamento', { ...b, alterado: true, falhaConferir: true }), /Tentar de novo/);
});

test('tela: captura no document, beforeunload, abas por callback, nada no navegador, AdminShell e sair.ts intocados', () => {
  const tela = readFileSync('components/admin/ModeloContrato.tsx', 'utf8');
  assert.match(tela, /document\.addEventListener\('click', aoClicar, true\)/, 'captura antes do Link');
  assert.match(tela, /window\.addEventListener\('beforeunload', aoSair\)/);
  assert.match(tela, /registrarPerguntaDasAbas\(alterado \?/);
  assert.match(tela, /<button type="button" data-sem-protecao onClick=\{voltarLista\}>Voltar à lista<\/button>/);
  assert.match(tela, /if \(alterado\) \{ setSaida\(\{ lista: true \}\); return; \}/, '"Voltar à lista" pergunta antes');
  assert.doesNotMatch(tela, /localStorage|sessionStorage|indexedDB/, 'nada guardado no navegador');
  assert.match(tela, /contratadaConferida: vista/);
  assert.match(tela, /const bloqueado = publicando \|\| conflito \|\| Boolean\(encerrado\);/);
  assert.match(tela, /Este rascunho será descartado e não poderá ser publicado\. O registro continua guardado no sistema\. Descartar\?/);
  // Inventário: as únicas navegações da tela são a pergunta (router.push) e o link do perfil em nova aba.
  assert.deepEqual(tela.match(/router\.\w+/g), ['router.push']);
  assert.deepEqual(tela.match(/<Link\b/g), null);
  const abas = readFileSync('components/admin/ImportarDocumentos.tsx', 'utf8');
  assert.match(abas, /<AbaDocumento key=\{aba\.documento\}/);
  assert.doesNotMatch(abas, /<Link\b/);
  const aba = readFileSync('components/admin/modelo-contrato/AbaDocumento.tsx', 'utf8');
  assert.match(aba, /<Link href=\{href\} data-sem-protecao onClick=\{aoClicar\}/);
  for (const f of ['components/admin/AdminShell.tsx', 'components/admin/sair.ts']) {
    try { assert.doesNotMatch(readFileSync(f, 'utf8'), /protegerSaida|registrarPerguntaDasAbas/, f); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
});

test('abas: com a tela pedindo, a aba não navega; sem pedido, segue', () => {
  let pedido = '';
  protegerSaida.registrarPerguntaDasAbas((d) => { pedido = d; return true; });
  assert.equal(protegerSaida.abaPrecisaPerguntar('/admin/configuracoes/importar-documentos?documento=tabela'), true);
  assert.equal(pedido, '/admin/configuracoes/importar-documentos?documento=tabela');
  protegerSaida.registrarPerguntaDasAbas(null);
  assert.equal(protegerSaida.abaPrecisaPerguntar('/x'), false);
});

test('ListaValoresFixos: todos os valores que continuam nas cláusulas, inclusive os elegíveis a sugestão (revisão Astra P3)', () => {
  const clausulas = [
    { id: 'c0', titulo: null, texto: 'Festa em {{festa.data}}.' },
    { id: 'c1', titulo: null, texto: 'Festa em 28/10/2026. Pagamento até 01/10/2026.' },
  ];
  const fixos = detectarValoresFixos(clausulas);
  assert.equal(fixos.filter((f) => f.sugerir).length, 1);
  const h = html('ListaValoresFixos', { valoresFixos: fixos });
  assert.match(h, /Cláusula 2: <span class="tracejado">28\/10\/2026<\/span> \(parece ser: Data da festa\)/);
  assert.match(h, /Cláusula 2: <span class="tracejado">01\/10\/2026<\/span><\/span>/);
  assert.equal(html('ListaValoresFixos', { valoresFixos: [] }), '');
});
