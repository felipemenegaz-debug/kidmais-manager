import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Check } from '../types'
import { areasOf, argvOf, scriptsFor } from './areas.ts'

const PANE = 'kidmais-gate'
const touched = atom({ plugin: 'kidmais-gate', key: 'touched' } as const, [])
const checks = atom({ plugin: 'kidmais-gate', key: 'checks' } as const, [])

const tailOf = (text: string) => text.trim().split('\n').slice(-6).join('\n')

async function runGate($: EngineInterface) {
  const scripts = scriptsFor(await read($, touched))
  await update($, checks, () => scripts.map((script): Check => ({ script, status: 'pending', tail: '' })))
  void $.ui.open({ id: PANE, title: 'Kidmais test gate' })

  let failed = 0
  for (const script of scripts) {
    const set = (patch: Partial<Check>) =>
      update($, checks, list => list.map(one => (one.script === script ? { ...one, ...patch } : one)))
    await set({ status: 'running' })
    try {
      const ran = await $.process.run(argvOf(script), { timeoutMs: 600_000 })
      const isOk = ran.exitCode === 0
      if (!isOk) failed += 1
      await set({ status: isOk ? 'ok' : 'fail', tail: isOk ? '' : tailOf(ran.stdout + '\n' + ran.stderr) })
    } catch (error) {
      failed += 1
      await set({ status: 'fail', tail: String(error) })
    }
  }

  const summary = failed === 0 ? `Gate verde: ${scripts.length} checks` : `Gate vermelho: ${failed}/${scripts.length} falharam`
  $.ui.status(summary)

  return summary
}

async function remember($: EngineInterface, path: string) {
  const cwd = await $.session.cwd()
  const relative = path.startsWith(cwd + '/') ? path.slice(cwd.length + 1) : path
  await update($, touched, list => (list.includes(relative) ? list : [...list, relative].slice(-500)))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'kidmais-gate',
      description: 'Roda lint, tsc, regressão V1 e os testes das áreas alteradas',
    })

    return next(e)
  })

  on('command.run', { command: 'kidmais-gate' }, async $ => {
    const summary = await runGate($)
    const list = await read($, checks)
    const failures = list
      .filter(one => one.status === 'fail')
      .map(one => `### ${one.script}\n${one.tail}`)

    return {
      text: summary,
      context: failures.length > 0 ? [`Falhas do test gate:\n\n${failures.join('\n\n')}`] : undefined,
    }
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) await remember($, e.file_path).catch(() => undefined)

    return ran
  })

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true) await remember($, e.file_path).catch(() => undefined)

    return ran
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const files = await read($, touched)
    if (e.props.hasSurvey || files.length === 0) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const areas = areasOf(files)
    const names = areas.length > 0 ? areas.map(area => area.name).join(', ') : 'geral'
    const warns = areas.flatMap(area => (area.warn ? [area.warn] : []))

    return (
      <Box flexDirection="column">
        <Box>
          <Text dimColor>
            Kidmais: {files.length} arquivo(s) alterado(s) · áreas: {names}{' '}
          </Text>
          <Button key="gate" label="Rodar gate" onPress={() => void runGate($)} />
        </Box>
        {warns.map(warn => (
          <Text color="yellow">⚠ {warn}</Text>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, checks)
    const icon = { pending: '·', running: '…', ok: '✓', fail: '✗' } as const

    return (
      <Box flexDirection="column">
        {list.length === 0 && <Text dimColor>Use /kidmais-gate para rodar o gate.</Text>}
        {list.map(one => (
          <Box flexDirection="column">
            <Text color={one.status === 'ok' ? 'green' : one.status === 'fail' ? 'red' : undefined}>
              {icon[one.status]} {one.script}
            </Text>
            {one.tail !== '' && <Text dimColor>{one.tail}</Text>}
          </Box>
        ))}
      </Box>
    )
  })
}
