import { z } from 'zod';
import { consultarSessao, authError, type SessaoAdmin } from '../../autenticacao/service';
import { withTransaction } from '../../db/postgres';
import type { DbExecutor } from '../../db/contracts';
import { buscarClienteCanonicoPorId, buscarClientePorId, listarAniversariantesDoCliente, listarResponsaveisDoCliente,
    registrarAuditoria, registrarEventoHistorico } from '../../clientes/repositories';
import { executarNoTenant, type TenantComprovado } from '../../saas/provar-tenant';
import { validarCadastroBasicoCliente, camposFaltantesParaContrato } from '../../clientes/services/validators';
import { revalidarHorarioSelecionado } from '../../disponibilidade/services';
import { buscarPacoteVigenteDaEmpresaPorCodigo } from '../../comercial/repositories';
import { pacoteIdContratavelV1 } from '../../comercial/pacotes-v1';
import { PACOTE_CODIGO_BANCO, FORMA_PAGAMENTO_BANCO, moedaParaNumeroServidor, traduzirAdicionais } from '../comercial-input';
import { erroConvidadosFechamento } from '../convidados';
import { fechamentoAdministrativoSchema } from '../administrativo-schema';
import { criarFechamentoComercial } from './fechamento.service';
import { FechamentoServiceError } from './errors';

type Contexto = { token: string; requestId: string; userAgent: string | null; empresaSolicitada?: string | null };
export function exigirPapelFechamento(papel: string) {
    if (!['ADMINISTRATIVO', 'REPRESENTANTE_AUTORIZADO'].includes(papel)) {
        throw authError('Papel não autorizado para iniciar Fechamento.', 403);
    }
}

/**
 * Cliente no tenant comprovado da sessão. Cliente de outra empresa, ou legado sem empresa,
 * responde como inexistente: esta rota não contorna o GET/PATCH principal do cliente.
 */
async function carregarCliente(id: string, empresaId: string, tx: DbExecutor, escrita: boolean) {
    const seletor = z.string().uuid().parse(id).toLowerCase();
    // Mesma ordem de lock da edição cadastral. Releitura no POST evita usar o GET como autorização.
    if (escrita) await tx.query('SELECT id FROM clientes WHERE id=$1 AND empresa_id=$2::uuid FOR UPDATE', [seletor, empresaId]);
    const original = await buscarClientePorId(seletor, tx);
    const cliente = await buscarClienteCanonicoPorId(seletor, tx);
    if (!original || !cliente || original.empresaId === null || original.empresaId !== empresaId
        || cliente.empresaId === null || cliente.empresaId !== empresaId) {
        throw new FechamentoServiceError('DADOS_INVALIDOS', 'Cliente não encontrado.', 404);
    }
    if (escrita && cliente.id !== seletor) {
        throw new FechamentoServiceError('DADOS_INVALIDOS', 'Cadastro mesclado. Abra e confira o cliente principal antes de concluir.', 409);
    }
    if (cliente.status !== 'ATIVO') throw new FechamentoServiceError('DADOS_INVALIDOS', 'O cliente precisa estar ativo.', 409);
    validarCadastroBasicoCliente(cliente);
    const faltantes = camposFaltantesParaContrato(cliente);
    if (faltantes.length) throw new FechamentoServiceError('CADASTRO_INCOMPLETO', 'Complete o cadastro no CRM antes de iniciar o Fechamento.', 409, { campos: faltantes });
    const aniversariantes = (await listarAniversariantesDoCliente(cliente.id, {}, tx)).filter(a => a.ativo);
    const responsaveis = (await listarResponsaveisDoCliente(cliente.id, {}, tx)).filter(r => r.ativo);
    return { cliente, aniversariantes, responsaveis, redirecionadoDe: cliente.id !== seletor ? seletor : null };
}

/**
 * Papel NESTA empresa: o da membership comprovada (UX/056), nunca o papel global da identidade. No estágio sem o
 * Tenant Context do UX (FECHAMENTO sozinho), o papel da sessão, como na base.
 */
function papelNestaEmpresa(sessao: SessaoAdmin, tenant: TenantComprovado): string {
    let papel: string = sessao.papel;
    papel = tenant.papelAtual; // @pr:UX
    return papel;
}

/**
 * Leitura para PREPARAR um Fechamento (Kidmais), sem gravar e sem lançar por cadastro incompleto: as mesmas regras de
 * `carregarCliente` (cliente da empresa comprovada, ativo, canônico) devolvidas como dados — o que falta vira lista.
 * Outra empresa, legado sem empresa ou inexistente ⇒ null (mesma resposta).
 */
export async function clienteParaPreparacao(id: string, empresaId: string, tx: DbExecutor) {
    const seletor = z.string().uuid().parse(id).toLowerCase();
    const original = await buscarClientePorId(seletor, tx);
    const cliente = await buscarClienteCanonicoPorId(seletor, tx);
    if (!original || !cliente || original.empresaId !== empresaId || cliente.empresaId !== empresaId || cliente.id !== seletor) return null;
    const aniversariantes = (await listarAniversariantesDoCliente(cliente.id, {}, tx)).filter(a => a.ativo);
    return {
        nome: cliente.nomeCompleto,
        ativo: cliente.status === 'ATIVO',
        camposFaltantes: camposFaltantesParaContrato(cliente).map(c => c.label),
        aniversariantes: aniversariantes.map(a => ({ id: a.id, nome: a.nome })),
    };
}

/** Escopo comprovado (empresa, usuário, cliente) para leituras/vínculos de uma preparação externa (ex.: Kidmais). */
export type EscopoPreparacao = { empresaId: string; usuarioId: string; clienteId: string };
export type ResultadoFechamentoAdministrativo = { fechamentoId: string; status: string; clienteId: string };
/**
 * Preparação externa vinculada ao envio OFICIAL: `validar` antes da criação e `concluir` depois, na mesma transação
 * (qualquer falha desfaz tudo). `repetido` ⇒ a preparação já virou este Fechamento: devolve-o, sem criar outro.
 */
export type VinculoPreparacaoFechamento = {
    validar(tx: DbExecutor, ctx: EscopoPreparacao & { input: { pacote: string; convidadosPagantes: number; dataFesta: string; horarioBase: string } }): Promise<{ repetido: ResultadoFechamentoAdministrativo | null }>;
    concluir(tx: DbExecutor, resultado: ResultadoFechamentoAdministrativo): Promise<void>;
};

export async function obterContextoFechamentoAdministrativo<P = never>(id: string, contexto: Contexto, preparacao?: (tx: DbExecutor, escopo: EscopoPreparacao) => Promise<P>) {
    return withTransaction(async tx => {
        const sessao = await consultarSessao(contexto.token, tx);
        return executarNoTenant(tx, sessao, contexto.empresaSolicitada, async (t, tenant) => {
            exigirPapelFechamento(papelNestaEmpresa(sessao, tenant));
            const base: Awaited<ReturnType<typeof carregarCliente>> & { preparacao?: P } = await carregarCliente(id, tenant.empresaComprovada, t, false);
            // Só LEITURA da preparação, no mesmo Tenant Context: abrir a revisão nunca grava nada.
            if (preparacao) base.preparacao = await preparacao(t, { empresaId: tenant.empresaComprovada, usuarioId: sessao.usuario_id, clienteId: base.cliente.id });
            return base;
        });
    });
}

export async function criarFechamentoAdministrativo(id: string, raw: unknown, contexto: Contexto, vinculo?: VinculoPreparacaoFechamento) {
    return withTransaction(async tx => {
        const sessao = await consultarSessao(contexto.token, tx, true);
        return executarNoTenant(tx, sessao, contexto.empresaSolicitada, (t, tenant) => {
            exigirPapelFechamento(papelNestaEmpresa(sessao, tenant));
            return criarNoTenant(id, raw, contexto, sessao, tenant.empresaComprovada, t, vinculo);
        });
    });
}

async function criarNoTenant(id: string, raw: unknown, contexto: Contexto, sessao: SessaoAdmin, empresaId: string, tx: DbExecutor, vinculo?: VinculoPreparacaoFechamento): Promise<ResultadoFechamentoAdministrativo> {
        const input = fechamentoAdministrativoSchema.parse(raw);
        const { cliente, aniversariantes, responsaveis } = await carregarCliente(id, empresaId, tx, true);
        // Preparação vinculada (Kidmais): conferida e travada AQUI; reenvio da mesma preparação devolve o já criado.
        if (vinculo) {
            const conferido = await vinculo.validar(tx, { empresaId, usuarioId: sessao.usuario_id, clienteId: cliente.id,
                input: { pacote: input.pacote, convidadosPagantes: input.convidadosPagantes, dataFesta: input.dataFesta, horarioBase: input.horarioBase } });
            if (conferido.repetido) return conferido.repetido;
        }
        // Evita alteração concorrente dos vínculos entre a conferência e a gravação.
        await tx.query('SELECT id FROM aniversariantes WHERE id=$1 FOR UPDATE', [input.aniversarianteId]);
        const atualizados = (await listarAniversariantesDoCliente(cliente.id, {}, tx));
        const aniversariante = atualizados.find(a => a.id === input.aniversarianteId && a.ativo && a.clienteId === cliente.id);
        if (!aniversariantes.some(a => a.id === input.aniversarianteId) || !aniversariante) {
            throw new FechamentoServiceError('ANIVERSARIANTE_INVALIDO', 'Selecione um aniversariante ativo deste cliente.', 409);
        }
        if (input.responsavelAdicionalId) {
            await tx.query('SELECT id FROM responsaveis_adicionais WHERE id=$1 FOR UPDATE', [input.responsavelAdicionalId]);
            const atuais = await listarResponsaveisDoCliente(cliente.id, {}, tx);
            if (!responsaveis.some(r => r.id === input.responsavelAdicionalId) || !atuais.some(r => r.id === input.responsavelAdicionalId && r.ativo && r.clienteId === cliente.id)) {
                throw new FechamentoServiceError('DADOS_INVALIDOS', 'Selecione um responsável ativo deste cliente.', 409);
            }
        }
        if (!pacoteIdContratavelV1(input.pacote)) throw new FechamentoServiceError('PACOTE_FORA_ESCOPO_V1', 'Pacote fora do escopo V1.', 409);
        if (input.pacote === 'pizza_party_scienza') throw new FechamentoServiceError('DADOS_INVALIDOS', 'O Pizza Party está sob consulta. Confirme com a equipe antes de continuar.', 409);
        // Pacote da empresa COMPROVADA (Tenant Context), nunca do catálogo público sem tenant (que continua recusado).
        const pacote = await buscarPacoteVigenteDaEmpresaPorCodigo(empresaId, PACOTE_CODIGO_BANCO[input.pacote], tx);
        if (!pacote) throw new FechamentoServiceError('DADOS_INVALIDOS', 'Pacote não disponível.', 404);
        const erroConvidados = erroConvidadosFechamento(input.convidadosPagantes, {
            id: input.pacote, nome: pacote.nome, minPagantes: pacote.convidadosMinimos ?? 1, maxPagantes: pacote.convidadosMaximos ?? 150,
        });
        if (erroConvidados) throw new FechamentoServiceError('DADOS_INVALIDOS', erroConvidados);
        const horario = await revalidarHorarioSelecionado({ data: input.dataFesta,
            codigoPeriodo: input.horarioBase === 'almoco' ? 'TURNO_1' : 'TURNO_2',
            inicio: input.horarioInicio, fim: input.horarioFim, ajusteMinutos: Number(input.ajusteHorario) }, tx);
        const valorProposto = moedaParaNumeroServidor(input.valorCombinado);
        if (valorProposto === null) throw new FechamentoServiceError('VALOR_PROPOSTO_INVALIDO', 'Informe um valor combinado válido.');
        const adicionais = traduzirAdicionais(input.adicionaisSelecionados, input.adicionaisQuantidades);
        if (!adicionais.ok) throw new FechamentoServiceError('DADOS_INVALIDOS', adicionais.erro, 409);
        const resultado = await criarFechamentoComercial({
            clienteId: cliente.id, aniversarianteId: aniversariante.id,
            responsavelAdicionalId: input.responsavelAdicionalId,
            origemFechamento: 'ATENDIMENTO_KIDMAIS', iniciadoPorUsuarioId: sessao.usuario_id, usuarioResponsavelId: sessao.usuario_id,
            dataEvento: input.dataFesta, horarioInicio: horario.candidato.inicio, horarioFim: horario.candidato.fim,
            configuracaoAgendaId: horario.periodo.configuracaoId, pacoteId: pacote.id,
            convidados: input.convidadosPagantes, valorProposto,
            adicionais: adicionais.itens,
            idadeAniversarianteEvento: input.idadeAniversariante === '' ? null : input.idadeAniversariante,
            temaFesta: input.temaFesta, alteracoesPacote: input.alteracoesPacote,
            observacoesCliente: input.observacoesCliente, observacoesEquipe: input.observacoesEquipe,
            formaPagamentoPretendida: FORMA_PAGAMENTO_BANCO[input.formaPagamento], condicaoPixPretendida: input.condicaoPixPretendida,
            buffetStatus: input.buffetDefinicao === 'agora' ? 'DEFINIDO' : 'PENDENTE',
            buffetSalgados: input.buffetSalgados, buffetBebidas: input.buffetBebidas, buffetDoces: input.buffetDoces,
            buffetBolo: input.buffetBolo, buffetOutros: input.buffetOutros, buffetLembrancinha: input.buffetLembrancinha,
            buffetEmpratado: input.buffetEmpratado, buffetBombom: input.buffetBombom,
        }, tx);
        const evento = { clienteId: cliente.id, usuarioId: sessao.usuario_id,
            entidadeTipo: 'FECHAMENTO', entidadeId: resultado.fechamento.id, origem: 'ATENDIMENTO_KIDMAIS' };
        await registrarEventoHistorico({ ...evento, clienteOrigemId: cliente.id, tipoEvento: 'FECHAMENTO_CRIADO',
            detalhe: 'Fechamento criado pela equipe autenticada.', metadata: { requestId: contexto.requestId, aniversarianteId: aniversariante.id } }, tx);
        await registrarAuditoria({ ...evento, atorTipo: 'USUARIO', acao: 'FECHAMENTO_CRIADO', requestId: contexto.requestId,
            userAgent: contexto.userAgent, dadosDepois: { status: resultado.fechamento.status, aniversarianteId: aniversariante.id } }, tx);
        const saida = { fechamentoId: resultado.fechamento.id, status: resultado.fechamento.status, clienteId: cliente.id };
        if (vinculo) await vinculo.concluir(tx, saida);
        return saida;
}
