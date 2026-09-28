import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { listarContratacoes } from '../fechamentos/contratacoes.ts';
import type { DbExecutor } from '../db/contracts';
const req=createRequire(import.meta.url);
function carregar(path:string,mocks:Record<string,unknown>){
    const exports:Record<string,unknown>={};
    const code=ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    new Function('require','exports',code)((n:string)=>n in mocks?mocks[n]:n==='zod'?req(n):{},exports);
    return exports;
}
class Falha extends Error {constructor(_code:string,message:string){super(message);}}
const chave='11111111-1111-4111-8111-111111111111',quando='2026-09-16T10:00:00.123456Z';
const contexto={usuarioId:'usuario-sintetico',origem:'CRM_INTERNO'};
const empresaA='aaaaaaaa-0000-4000-8000-00000000000a',empresaB='bbbbbbbb-0000-4000-8000-00000000000b';
function ambiente(){
    const cliente={id:'cliente-sintetico',status:'ATIVO',atualizadoEm:quando,empresaId:empresaA as string|null};
    const auditoria:Record<string,unknown>[]=[],historico:Record<string,unknown>[]=[],sqls:string[]=[];
    // O mock aplica o filtro de empresa como o SQL real: sem a mesma empresa, nenhuma linha.
    const tx={query:async(sql:string,v:unknown[]=[])=>{
        sqls.push(sql);
        if(sql.startsWith('SELECT status,')){assert.match(sql,/empresa_id=\$3::uuid/);return{rows:cliente.empresaId!==null&&v[2]===cliente.empresaId?[{status:cliente.status,mesma:v[1]===cliente.atualizadoEm}]:[]};}
        if(sql.startsWith('SELECT usuario_id,'))return{rows:auditoria.filter(a=>a.requestId===v[1]).map(a=>({usuario_id:a.usuarioId,justificativa:a.justificativa,dados_depois:a.dadosDepois}))};
        if(sql.startsWith('UPDATE clientes')){assert.match(sql,/empresa_id=\$4::uuid/);assert.equal(v[3],cliente.empresaId);cliente.status=String(v[1]);cliente.atualizadoEm='2026-09-16T11:00:00.654321Z';return{rows:[{quando:cliente.atualizadoEm}]};}
        throw Error('SQL não simulado: '+sql);
    }};
    const mod=carregar('lib/clientes/services/lixeira.ts',{
        '../repositories':{registrarAuditoria:async(a:Record<string,unknown>)=>{auditoria.push(a);},registrarEventoHistorico:async(a:Record<string,unknown>)=>{historico.push(a);}},
        './errors':{ClienteServiceError:Falha},
    });
    const mover=mod.moverClienteLixeira as (tx:object,e:string,id:string,p:unknown,c:object)=>Promise<{reutilizado:boolean}>;
    const executar=(p:object={},c:object=contexto,empresa:string=empresaA)=>mover(tx,empresa,cliente.id,{acao:'EXCLUIR',motivo:'Cadastro de teste',chave,atualizadoEm:quando,confirmarRemocao:true,confirmarHistorico:true,...p},c);
    return {cliente,auditoria,historico,sqls,executar,mod};
}
for(const acao of ['EXCLUIR','ARQUIVAR'])test(`${acao} mantém cliente, ID, vínculos e audita autor/data/motivo`,async()=>{
    const a=ambiente();await a.executar({acao});assert.equal(a.cliente.status,'INATIVO');assert.equal(a.cliente.id,'cliente-sintetico');
    assert.equal(a.auditoria[0].usuarioId,contexto.usuarioId);assert.equal(a.auditoria[0].justificativa,'Cadastro de teste');
    assert.equal(a.auditoria[0].acao,`CLIENTE_${acao}`);assert.deepEqual(a.auditoria[0].dadosAntes,{status:'ATIVO'});
    assert.equal((a.auditoria[0].dadosDepois as {quando:string}).quando,a.cliente.atualizadoEm);assert.equal(a.historico.length,1);
    assert(!a.sqls.some(s=>/DELETE|INSERT INTO clientes|UPDATE (contratos|festas|fechamentos|pagamentos|contrato_documentos)/.test(s)));
});
test('restaurar devolve ATIVO com mesmo ID, sem duplicar e com auditoria própria',async()=>{
    const a=ambiente();await a.executar();await a.executar({acao:'RESTAURAR',motivo:'Retorno solicitado',chave:'22222222-2222-4222-8222-222222222222',atualizadoEm:a.cliente.atualizadoEm});
    assert.equal(a.cliente.status,'ATIVO');assert.equal(a.cliente.id,'cliente-sintetico');assert.equal(a.auditoria[1].acao,'CLIENTE_RESTAURAR');
    assert.deepEqual(a.auditoria[1].dadosAntes,{status:'INATIVO'});assert.equal(a.historico.length,2);
    assert((await a.executar()).reutilizado);assert.equal(a.cliente.status,'ATIVO');assert.equal(a.auditoria.length,2);
});

test('arquivar e restaurar preserva uma contratação no CRM e altera apenas indicação de inativo', async () => {
    const a = ambiente();
    const fila = async () => listarContratacoes({ query: async (sql: string, params: unknown[]) => {
        assert.match(sql, /cl.status AS "clienteStatus"/);
        assert.doesNotMatch(sql, /cl.status\s*=/);
        assert.equal(params[1], a.cliente.id);
        return { rows: [{ id: 'fechamento-sintetico', clienteId: a.cliente.id, cliente: 'Cliente sintético', clienteStatus: a.cliente.status,
            data: '2026-09-19', inicio: '11:00', fim: '15:00', pacote: 'Pacote', convidados: 40,
            criadoEm: quando, status: 'AGUARDANDO_CONTRATO', formaPagamento: null, contratoId: null, contratoStatus: null,
            versaoId: null, edicaoEstado: null, documentoRevisado: false, valorContratual: null, temFesta: false }] };
    } } as unknown as DbExecutor, empresaA, a.cliente.id);
    const antes = await fila();
    await a.executar({ acao: 'ARQUIVAR' });
    const arquivado = await fila();
    assert.equal(arquivado.length, 1); assert.equal(arquivado[0].clienteStatus, 'INATIVO');
    await a.executar({ acao: 'RESTAURAR', motivo: 'Retorno', chave: '22222222-2222-4222-8222-222222222222', atualizadoEm: a.cliente.atualizadoEm });
    const restaurado = await fila();
    assert.deepEqual(restaurado, antes);
    assert.equal(restaurado[0].id, arquivado[0].id);
    assert.equal(restaurado[0].acao.href, arquivado[0].acao.href);
    assert(!a.sqls.some(sql => /(?:INSERT INTO|UPDATE|DELETE FROM) (?:fechamentos|festas|contratos)\b/.test(sql)));
});
test('retry não duplica auditoria; chave de outra intenção é recusada',async()=>{
    const a=ambiente();await a.executar();assert((await a.executar()).reutilizado);assert.equal(a.auditoria.length,1);
    await assert.rejects(a.executar({motivo:'Outro motivo'}),/outra intenção/);
});
for(const p of [{motivo:''},{motivo:'ab'},{confirmarRemocao:false},{confirmarHistorico:false}])test('validação recusa motivo/confirmação incompleta '+JSON.stringify(p),async()=>{
    const a=ambiente();await assert.rejects(a.executar(p));assert.equal(a.sqls.length,0);
});
test('sem usuário, versão desatualizada e cadastro mesclado são recusados',async()=>{
    const a=ambiente();await assert.rejects(a.executar({},{}),/Autenticação/);assert.equal(a.sqls.length,0);
    await assert.rejects(a.executar({atualizadoEm:'2026-09-01T10:00:00Z'}),/outra operação/);
    a.cliente.status='MESCLADO';await assert.rejects(a.executar(),/principal/);assert.equal(a.auditoria.length,0);
});
test('listagem de lixeira mascara contatos, usa INATIVO e só indica 90 dias sem purga',()=>{
    const s=readFileSync('lib/clientes/services/lixeira.ts','utf8');
    for(const text of ["c.status='INATIVO'","interval '90 days'","'Na lixeira'","'Arquivado'","right(COALESCE(c.whatsapp,c.telefone),4)","HH24:MI:SS.US"])assert(s.includes(text),text);
    assert(!/DELETE FROM|ON DELETE CASCADE/.test(s));
});
test('busca e listagem padrão retornam ativos; filtro explícito inclui inativos',async()=>{
    const empresaId='empresa-teste';
    const clientes=[{id:'ativo',status:'ATIVO',empresaId},{id:'inativo',status:'INATIVO',empresaId}];
    const mod=carregar('lib/clientes/services/cliente.service.ts',{
        '../repositories':{listarClientes:async(_e:string,o:{status:string})=>o.status==='ATIVO'?clientes.slice(0,1):clientes,
            buscarClientesPorNomeSemelhante:async()=>clientes,buscarClientesPorEmail:async()=>[]},
        './validators':{camposFaltantesParaContrato:()=>[]},
    });
    const listar=mod.listarClientesCrm as (e:string,o?:object)=>Promise<{cliente:{id:string}}[]>;
    const buscar=mod.buscarClientesCrm as (q:string,e:string,n:number,incluir?:boolean)=>Promise<{cliente:{id:string}}[]>;
    assert.deepEqual((await listar(empresaId)).map(c=>c.cliente.id),['ativo']);
    assert.equal((await listar(empresaId,{status:'CANONICOS'})).length,2);
    assert.equal((await buscar('Cliente',empresaId,20)).length,1);assert.equal((await buscar('Cliente',empresaId,20,true)).length,2);
});
test('cadastro com CPF inativo oferece restauração e nunca chama criarCliente',async()=>{
    let criacoes=0;
    const mod=carregar('lib/clientes/services/cliente.service.ts',{
        '../../db/postgres':{withTransaction:async(fn:(t:object)=>unknown)=>fn({})},
        '../repositories':{buscarClienteCanonicoPorCpf:async()=>({id:'inativo',nomeCompleto:'Cliente sintético',status:'INATIVO'}),buscarClientesPorNomeSemelhante:async()=>[],criarCliente:async()=>{criacoes++;}},
        '../repositories/normalizers':{normalizarCpf:(s:string)=>s,normalizarTelefone:()=>null},
        './validators':{validarCadastroBasicoCliente:()=>{}},'./errors':{ClienteServiceError:Falha},
    });
    const cadastrar=mod.cadastrarClienteInterno as (p:object,c:object)=>Promise<unknown>;
    await assert.rejects(cadastrar({cpf:'cpf-sintetico',nomeCompleto:'Cliente sintético',empresaId:empresaA},contexto),/restaurar/);assert.equal(criacoes,0);
});
test('contato/e-mail inativo segue detectado e bloqueia duplicação silenciosa',async()=>{
    const cliente={id:'inativo',nomeCompleto:'Cliente sintético',email:'teste@example.invalid',status:'INATIVO'};
    const mod=carregar('lib/clientes/services/cliente.service.ts',{
        '../../db/postgres':{withTransaction:async(fn:(t:object)=>unknown)=>fn({})},
        '../repositories':{buscarClienteCanonicoPorCpf:async()=>null,buscarClientesPorNomeSemelhante:async()=>[],buscarClientesPorContatoExato:async()=>[cliente],buscarClientesPorEmailExato:async()=>[cliente]},
        '../repositories/normalizers':{normalizarCpf:()=>null,normalizarTelefone:(s:string)=>s},
        './validators':{validarCadastroBasicoCliente:()=>{}},'./errors':{ClienteServiceError:Falha},
    });
    const analisar=mod.analisarCadastroCliente as (p:object,e:string)=>Promise<{possiveisDuplicidades:{status:string;motivos:string[]}[]}>;
    const payload={nomeCompleto:'Cliente sintético',telefone:'61999999999',email:cliente.email,empresaId:empresaA};
    const resultado=await analisar(payload,empresaA);assert.equal(resultado.possiveisDuplicidades[0].status,'INATIVO');
    assert.deepEqual(resultado.possiveisDuplicidades[0].motivos,['TELEFONE_IGUAL','EMAIL_IGUAL']);
    const cadastrar=mod.cadastrarClienteInterno as (p:object,c:object)=>Promise<unknown>;await assert.rejects(cadastrar(payload,contexto),/restaurar/);
});
test('consultas históricas e de duplicidade não excluem INATIVO; CPF canônico permanece único',()=>{
    const repo=readFileSync('lib/clientes/repositories/cliente.repository.ts','utf8');
    const id=repo.slice(repo.indexOf('export async function buscarClientePorId'),repo.indexOf('/** Retorna'));
    assert(!id.includes("status = 'ATIVO'"));
    const cpf=repo.slice(repo.indexOf('export async function buscarClienteCanonicoPorCpf'),repo.indexOf('export async function buscarClientesPorContatoExato'));
    assert(cpf.includes("status <> 'MESCLADO'"));assert(!cpf.includes("status = 'ATIVO'"));
    assert(readFileSync('database/migrations/20260907_002_crm_people.sql','utf8').includes("WHERE cpf IS NOT NULL AND status <> 'MESCLADO'"));
});
test('UX exige duas etapas antes da mutação e expõe restauração na ficha',()=>{
    const ui=readFileSync('components/clientes/ClienteLixeira.tsx','utf8');
    for(const text of ['Deseja realmente remover este cliente da lista ativa?','Este cliente será movido para a lixeira e poderá ser restaurado.','Continuar para segunda confirmação',"etapa!==2",'Restaurar cliente'])assert(ui.includes(text),text);
    assert(readFileSync('components/clientes/ClientesPage.tsx','utf8').includes('Incluir arquivados/excluídos'));
});
test('endpoints preservam autenticação administrativa e CSRF/Origin comum',async()=>{
    let consultas=0;
    const mod=carregar('app/api/admin/clientes/[id]/lixeira/route.ts',{
        '@/lib/http/admin-crm-api':{exigirApiAdminCrmDisponivel:async()=>{throw Error('Sem sessão');}},
        '@/lib/http/api-response':{apiErrorResponse:()=>({status:401})},
        '@/lib/db/postgres':{withTransaction:()=>{consultas++;},db:()=>{consultas++;}},
    });
    for(const method of ['GET','POST']){const handler=mod[method] as (r:object,c:object)=>Promise<{status:number}>;assert.equal((await handler({},{params:Promise.resolve({id:chave})})).status,401);}
    assert.equal(consultas,0);
    const guard=readFileSync('lib/http/admin-crm-api.ts','utf8');assert(guard.includes('verificarOrigem(request)'));assert(guard.includes("request.headers.get('x-csrf-token')"));
});

// PR-B1: lixeira escopada pelo tenant comprovado.
for(const [caso,empresaCliente] of [['de outra empresa',empresaB],['legado sem empresa',null]] as const)test(`lixeira: tenant A não arquiva/restaura cliente ${caso}`,async()=>{
    const a=ambiente();a.cliente.empresaId=empresaCliente;
    for(const acao of ['EXCLUIR','ARQUIVAR','RESTAURAR'])await assert.rejects(a.executar({acao,confirmarRemocao:true,confirmarHistorico:true}),/não encontrado/);
    assert.equal(a.cliente.status,'ATIVO');assert.equal(a.auditoria.length,0);assert.equal(a.historico.length,0);
    assert(!a.sqls.some(s=>s.startsWith('UPDATE')||s.startsWith('SELECT usuario_id,')),'nenhuma escrita nem leitura de auditoria antes da prova de empresa');
});
test('lixeira: A não lista nem consulta B — filtro de empresa na SQL, antes de ORDER BY/LIMIT',async()=>{
    const a=ambiente();const consultas:{sql:string;v:unknown[]}[]=[];
    const consultar=a.mod.consultarLixeira as (tx:object,e:string,id?:string,o?:number)=>Promise<unknown[]>;
    const tx={query:async(sql:string,v:unknown[])=>{consultas.push({sql,v});return{rows:[]};}};
    await consultar(tx,empresaA);await consultar(tx,empresaA,'cliente-b');
    for(const c of consultas){
        const where=c.sql.indexOf('c.empresa_id=$4::uuid'),order=c.sql.lastIndexOf('ORDER BY c.nome_completo'),limit=c.sql.lastIndexOf('LIMIT $2');
        assert(where>0&&where<order&&order<limit,'empresa filtrada antes de ordenar e limitar');
        assert.equal(c.v[3],empresaA);
    }
    await assert.rejects(consultar(tx,''),/Empresa administrativa/);
});
test('lixeira: rotas usam Tenant Context comprovado e não leem empresa do corpo',()=>{
    for(const f of ['app/api/admin/clientes/lixeira/route.ts','app/api/admin/clientes/[id]/lixeira/route.ts']){
        const s=readFileSync(f,'utf8');assert(s.includes('withTenantTransaction'),f);assert(s.includes('tenant.empresaComprovada'),f);
        assert(!/body\.empresaId|bruto\.empresaId/.test(s),f);
    }
});
