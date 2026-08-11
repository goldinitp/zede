const TERMINAL_ENV: Record<string, string> = {
  CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '1',
  TERM: 'xterm-256color',
  COLORTERM: 'truecolor',
  TERM_PROGRAM: 'Zede',
  CLICOLOR: '1'
}

const HOST_ONLY_ENV = new Set([
  'NO_COLOR',
  'FORCE_COLOR',
  'CURSOR_AGENT',
  'CURSOR_CONVERSATION_ID',
  'AGENT_TRANSCRIPTS',
  '__CURSOR_SANDBOX_ENV_RESTORE'
])

/** Build a clean interactive-terminal environment even when Zede was launched
 * from an IDE or agent process that disables color for its own subprocesses. */
export function terminalEnvironment(host: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(host)) {
    if (value !== undefined && !HOST_ONLY_ENV.has(key)) env[key] = value
  }
  return { ...env, ...TERMINAL_ENV }
}
