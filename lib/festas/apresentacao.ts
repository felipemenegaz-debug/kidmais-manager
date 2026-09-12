import { escolhasBuffet, rotulosBuffet } from './buffet.ts';

/** Retorno limitado a uma Festa interna; nunca aceita uma URL arbitrária. */
export function retornoFestaSeguro(value: string | null | undefined): string | null {
    return value && /^\/admin\/festas\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null;
}

export function linksContratoDaFesta(contratoId: string, versaoId: string, festaId: string) {
    const params = new URLSearchParams({ contratoId, versaoId });
    const retorno = retornoFestaSeguro(`/admin/festas/${festaId}`);
    if (retorno) params.set('returnTo', retorno);
    const contrato = `/admin/contratos?${params}`;
    return { contrato, pagamentos: `${contrato}#financeiro`, editar: `${contrato}#alteracoes` };
}

type Registro = Record<string, unknown>;
const registro = (value: unknown): Registro => value && typeof value === 'object' && !Array.isArray(value) ? value as Registro : {};
function texto(value: unknown): string {
    if (typeof value !== 'string') return '';
    const t = value.trim();
    return /criação explícita|^[{\[]|\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/i.test(t) ? '' : t;
}

/** Apenas apresentação de fatos existentes; ausência de contexto não prova uma transição. */
export function apresentarEventoFesta(evento: Registro) {
    const antes = registro(evento.dados_antes), depois = registro(evento.dados_depois);
    const tipo = evento.tipo;
    let titulo = 'Registro da festa atualizado';
    let detalhes: string[] = [];
    if (tipo === 'FESTA_CRIADA') titulo = 'Festa adicionada ao Manager';
    else if (tipo === 'FESTA_TAREFA' || tipo === 'FESTA_PENDENCIA') {
        const tarefa = tipo === 'FESTA_TAREFA';
        titulo = tarefa ? 'Tarefa atualizada' : 'Pendência atualizada';
        if (evento.dados_antes === null && texto(depois[tarefa ? 'titulo' : 'descricao'])) titulo = tarefa ? 'Tarefa criada' : 'Pendência registrada';
        else if (antes.estado && antes.estado !== depois.estado) {
            if (depois.estado === (tarefa ? 'CONCLUIDA' : 'RESOLVIDA')) titulo = tarefa ? 'Tarefa concluída' : 'Pendência resolvida';
            else if (depois.estado === 'NAO_SE_APLICA') titulo = tarefa ? 'Tarefa marcada como não necessária' : 'Pendência marcada como não aplicável';
        }
        detalhes = [texto(depois.titulo) || texto(depois.descricao) || texto(antes.titulo) || texto(antes.descricao)];
    } else if (tipo === 'FESTA_BUFFET') {
        titulo = 'Escolhas do buffet atualizadas';
        detalhes = escolhasBuffet.flatMap(k => {
            if (!(k in depois) || depois[k] === antes[k]) return [];
            const valor = texto(depois[k]);
            if (valor) return [`${rotulosBuffet[k]}: ${valor}`];
            return texto(antes[k]) && (depois[k] === '' || depois[k] === null) ? [`${rotulosBuffet[k]}: Não definido`] : [];
        });
    } else {
        const titulos: Record<string, string> = {
            FESTA_INVALIDAR: 'Festa removida por engano', FESTA_CANCELAR_CONTRATACAO: 'Contratação cancelada',
            FESTA_CONTAGEM: 'Quantidade de convidados registrada', FESTA_OBSERVACAO: 'Observação registrada',
            FESTA_SOLICITACAO: 'Pedido registrado', FESTA_CANCELAR_SOLICITACAO: 'Registro corrigido por engano',
            FESTA_ENCAMINHAR_SOLICITACAO: 'Pedido encaminhado para análise',
        };
        titulo = titulos[String(tipo)] ?? titulo;
        if (tipo === 'FESTA_SOLICITACAO') titulo = depois.tipo === 'HORA_EXTRA' ? 'Hora extra registrada' : depois.tipo === 'ADICIONAL' ? 'Item adicional registrado' : titulo;
        if (tipo === 'FESTA_CONTAGEM') {
            if (depois.corrige_contagem_id) titulo = 'Quantidade de convidados corrigida';
            if (Number.isInteger(depois.total_presentes)) detalhes = [`Presentes informados: ${depois.total_presentes}`];
        } else detalhes = [texto(depois.descricao) || texto(antes.descricao)];
    }
    const motivo = tipo === 'FESTA_CRIADA' ? '' : texto(evento.motivo);
    if (motivo && !detalhes.includes(motivo)) detalhes.push(`Motivo: ${motivo}`);
    const instante = typeof evento.criado_em === 'string' ? new Date(evento.criado_em) : null;
    const data = instante && Number.isFinite(instante.valueOf())
        ? `${instante.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })} às ${instante.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' })}`
        : 'Data não informada';
    const nome = texto(registro(evento.identidade_snapshot).nome);
    return { titulo, detalhes: detalhes.filter(Boolean), quando: `${data}${nome ? ` • ${nome}` : ''}` };
}
