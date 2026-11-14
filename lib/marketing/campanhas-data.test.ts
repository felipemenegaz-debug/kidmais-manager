import test from 'node:test';
import assert from 'node:assert/strict';
import { carregarModulo } from '../acessos/teste-carregador.ts';
import { CANAIS_CAMPANHA_UI } from './campanhas-ui.ts';
import { hojeSaoPaulo } from './utm.ts';

type Elemento = { type: unknown; props: Record<string, unknown> };
const jsx = (type: unknown, props: Record<string, unknown>): Elemento => ({ type, props });
const runtime = { jsx, jsxs: jsx };

test('página repassa somente data válida ao formulário', async () => {
  const pagina = carregarModulo('app/admin/marketing/campanhas/page.tsx', {
    'react/jsx-runtime': runtime,
    'components/admin/marketing/MarketingCampanhas': { default: 'campanhas', __esModule: true },
  }).default as (props: {searchParams: Promise<{data?: string | string[]}>}) => Promise<Elemento>;
  assert.equal((await pagina({searchParams:Promise.resolve({data:'2099-04-10'})})).props.dataInicial,'2099-04-10');
  for (const data of [undefined,'2099-02-29','2000-01-01',['2099-04-10']]) {
    assert.equal((await pagina({searchParams:Promise.resolve({data})})).props.dataInicial,undefined);
  }
});

test('atalho abre formulário após carregar, respeita permissão e não reabre ao cancelar/recarregar', () => {
  // Em UTC já é dia 15, mas o formulário deve começar no dia 14 em São Paulo.
  const hoje = hojeSaoPaulo(new Date('2026-11-15T01:00:00Z'));
  assert.equal(hoje, '2026-11-14');
  function montar(dataInicial?: string, editar = true) {
    const slots: unknown[] = []; let cursor = 0; let efeitos: (()=>void)[] = [];
    let dados: Record<string, unknown> | null = null;
    const react = {
      useState(inicial: unknown) { const i=cursor++; if (!(i in slots)) slots[i]=inicial; return [slots[i],(valor:unknown)=>{slots[i]=valor;}]; },
      useRef(inicial: unknown) { const i=cursor++; if (!(i in slots)) slots[i]={current:inicial}; return slots[i]; },
      useEffect(efeito: ()=>void) { efeitos.push(efeito); },
    };
    const componente = carregarModulo('components/admin/marketing/MarketingCampanhas.tsx', {
      react, 'react/jsx-runtime':runtime, 'components/admin/marketing/marketing.module.css':{},
      'lib/marketing/utm': { hojeSaoPaulo: () => hoje },
      'components/admin/marketing/comum':{useMarketing:()=>({dados,recarregar(){}}),CabecalhoMarketing:'header',EstadoCarga:'loading'},
      'components/admin/AdminPrimaryButton':{AdminPrimaryButton:'button'},
      'components/admin/marketing/AtribuicaoExplicada':{AtribuicaoExplicada:'aside'},
    }).default as (props:{dataInicial?:string})=>Elemento;
    const render = () => { cursor=0;efeitos=[];const tree=componente({dataInicial});efeitos.forEach(f=>f());return tree; };
    const carregar = () => { dados={resultados:[],campanhas:[],origens:[],sites:[],unidades:[],padraoPorCanal:Object.fromEntries(CANAIS_CAMPANHA_UI.map(c=>[c,{origem:c,utmSource:c.toLowerCase(),utmMedium:'social'}])),capacidades:editar?['MARKETING_CAMPANHAS_EDITAR']:[]};render();return render(); };
    return {render,carregar};
  }
  function buscar(no: unknown, predicado:(e:Elemento)=>boolean): Elemento | undefined {
    if (Array.isArray(no)) return no.map(n=>buscar(n,predicado)).find(Boolean);
    if (!no || typeof no!=='object' || !('props' in no)) return undefined;
    const e=no as Elemento; return predicado(e)?e:buscar(e.props.children,predicado);
  }
  const dialogo=(t:Elemento)=>buscar(t,e=>e.props.role==='dialog');
  const campo=(t:Elemento,nome:string)=>buscar(buscar(t,e=>e.type==='label' && Array.isArray(e.props.children) && e.props.children[0]===nome),e=>e.type==='input');
  const conferir=(t:Elemento,nome:string,fim:string)=>{
    assert.equal(campo(t,'Nome')?.props.value,nome);
    assert.equal(campo(t,'Início')?.props.value,hoje);
    assert.equal(campo(t,'Fim (opcional)')?.props.value,fim);
  };
  const abrirManual=(t:Elemento)=>((buscar(t,e=>e.type==='header')?.props.acao as Elemento).props.onClick as ()=>void)();
  const h=montar('2099-04-10');assert.equal(dialogo(h.render()),undefined);
  const aberto=h.carregar();assert.ok(dialogo(aberto));
  conferir(aberto,'Data livre 10/04/2099','2099-04-10');
  (campo(aberto,'Nome')?.props.onChange as (e:{target:{value:string}})=>void)({target:{value:'Minha campanha'}});
  conferir(h.render(),'Minha campanha','2099-04-10');
  const cancelar=buscar(aberto,e=>e.type==='button' && e.props.children==='Cancelar');
  (cancelar?.props.onClick as ()=>void)();
  assert.equal(dialogo(h.render()),undefined);assert.equal(dialogo(h.carregar()),undefined);
  abrirManual(h.render());
  conferir(h.render(),'','');
  const semData=montar();const lista=semData.carregar();
  assert.equal(dialogo(lista),undefined);
  abrirManual(lista);conferir(semData.render(),'','');
  assert.equal(dialogo(montar('2099-04-10',false).carregar()),undefined);
});
