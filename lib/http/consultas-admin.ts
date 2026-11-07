/**
 * POST das telas administrativas que só consultam: sem efeito de negócio que a pessoa precise conferir depois. Serve só
 * para o resultado mostrado na troca de host (plano D4, H23): consulta nunca vira "última operação". Em dúvida, o pedido
 * fica fora daqui e conta como escrita.
 */
const CONSULTAS: ReadonlyArray<{ rota: string | RegExp; campo?: 'acao' | 'capacidade'; valores?: readonly string[] }> = [
    { rota: '/api/endereco/consultar-cep' },
    { rota: '/api/admin/clientes/analisar-cadastro' },
    { rota: /^\/api\/admin\/contratos\/[^/]+\/financeiro\/cronograma\/simulacao$/ },
    { rota: /^\/api\/admin\/contratos\/[^/]+\/financeiro\/tratamentos\/[^/]+\/simulacao$/ },
    { rota: '/api/admin/configuracoes/whatsapp/demo-ativos' },
    { rota: '/api/admin/inteligencia', campo: 'capacidade', valores: ['atencao_hoje'] },
    { rota: '/api/admin/inteligencia/preparacoes', valores: ['abrir', 'situacao'] },
    { rota: '/api/admin/inteligencia/importacoes', valores: ['estado', 'ler', 'listar', 'opcoes-completas', 'simular-completa'] },
    { rota: /^\/api\/admin\/contratos\/importados\/[^/]+\/integracao$/, valores: ['simular', 'simular-financeiro'] },
    { rota: '/api/admin/configuracoes/tabelas-preco', valores: ['simular', 'simular_festa'] },
    { rota: /^\/api\/admin\/configuracoes\/modelo-contrato\/[^/]+$/, valores: ['previa'] },
    { rota: '/api/admin/marketing/automacoes', valores: ['simular'] },
    { rota: '/api/admin/atendimento', valores: ['sugerir'] },
    { rota: '/api/admin/atendimento/prontas', valores: ['rascunho'] },
    { rota: '/api/desenvolvedor/empresas', valores: ['previa'] },
];

function caminhoDe(input: RequestInfo | URL) {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let caminho = url;
    try { caminho = new URL(url, 'http://local').pathname; }
    catch { /* Endereço inválido: não casa com nenhuma rota. */ }
    return caminho.replace(/\/+$/, '');
}

function campoDoCorpo(corpo: BodyInit | null | undefined, campo: string) {
    if (typeof corpo !== 'string') return null;
    try { return (JSON.parse(corpo) as Record<string, unknown> | null)?.[campo] ?? null; }
    catch { return null; }
}

/**
 * A conversa da inteligência pode só responder ou alterar um rascunho, e o pedido não diz qual dos dois será. Só a resposta
 * diz, e só nestes tipos é certo que nada foi alterado. `nao_suportado` fica de fora: também vem depois de rascunho salvo.
 */
export function dependeDaResposta(input: RequestInfo | URL) {
    return caminhoDe(input) === '/api/admin/inteligencia/conversa';
}

const TIPOS_SO_LEITURA = new Set(['resposta', 'agente', 'precisa_contexto']);
export async function conversaSoLeu(resposta: Response) {
    if (!resposta.ok) return false;
    const corpo = await resposta.clone().json().catch(() => null) as { ok?: unknown; data?: { tipo?: unknown; proposta?: unknown } } | null;
    const dados = corpo?.ok === true ? corpo.data : null;
    return TIPOS_SO_LEITURA.has(dados?.tipo as string) || (dados?.tipo === 'navegacao' && !dados.proposta);
}

export function ehConsulta(input: RequestInfo | URL, init: RequestInit) {
    const caminho = caminhoDe(input);
    return CONSULTAS.some(({ rota, campo = 'acao', valores }) => {
        if (typeof rota === 'string' ? rota !== caminho : !rota.test(caminho)) return false;
        return !valores || valores.includes(campoDoCorpo(init.body, campo) as string);
    });
}
