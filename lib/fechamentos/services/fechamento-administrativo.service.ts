import { z } from 'zod';
import { consultarSessao, authError, type SessaoAdmin } from '../../autenticacao/service';
import { withTransaction } from '../../db/postgres';
import type { DbExecutor } from '../../db/contracts';
import { buscarClienteCanonicoPorId, buscarClientePorId, listarAniversariantesDoCliente, listarResponsaveisDoCliente,
    registrarAuditoria, registrarEventoHistorico } from '../../clientes/repositories';
import { executarNoTenant, type TenantComprovado } from '../../saas/provar-tenant';
import { validarCadastroBasicoCliente, camposFaltantesParaContrato } from '../../clientes/services/validators';
import { revalidarHorarioSelecionado } from '../../disponibilidade/services';
import { buscarPacoteAtivoPorCodigo } from '../../comercial/repositories';
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

export async function obterContextoFechamentoAdministrativo(id: string, contexto: Contexto) {
    return withTransaction(async tx => {
        const sessao = await consultarSessao(contexto.token, tx);
        return executarNoTenant(tx, sessao, contexto.empresaSolicitada, (t, tenant) => {
            exigirPapelFechamento(papelNestaEmpresa(sessao, tenant));
            return carregarCliente(id, tenant.empresaComprovada, t, false);
        });
    });
}

export async function criarFechamentoAdministrativo(id: string, raw: unknown, contexto: Contexto) {
    return withTransaction(async tx => {
        const sessao = await consultarSessao(contexto.token, tx, true);
        return executarNoTenant(tx, sessao, contexto.empresaSolicitada, (t, tenant) => {
            exigirPapelFechamento(papelNestaEmpresa(sessao, tenant));
            return criarNoTenant(id, raw, contexto, sessao, tenant.empresaComprovada, t);
        });
    });
}

async function criarNoTenant(id: string, raw: unknown, contexto: Contexto, sessao: SessaoAdmin, empresaId: string, tx: DbExecutor) {
        const input = fechamentoAdministrativoSchema.parse(raw);
        const { cliente, aniversariantes, responsaveis } = await carregarCliente(id, empresaId, tx, true);
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
        const pacote = await buscarPacoteAtivoPorCodigo(PACOTE_CODIGO_BANCO[input.pacote], tx);
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
        return { fechamentoId: resultado.fechamento.id, status: resultado.fechamento.status, clienteId: cliente.id };
}
