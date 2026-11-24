import { redirect } from 'next/navigation';

// A pré-reserva passou para dentro da Agenda (23/11/2026, pedido de Felipe: a pré-reserva bloqueia a agenda).
export default function Page() { redirect('/admin/configuracoes/agenda#pre-reserva'); }
