const { spawn } = require('node:child_process')

const DEADLINE_MS = 25 * 60 * 1000
const KILL_GRACE_MS = 10 * 1000
const processor = spawn(process.execPath, ['lib/main.js'], { stdio: 'inherit' })
const deadline = setTimeout(() => {
  processor.kill('SIGTERM')
  setTimeout(() => processor.kill('SIGKILL'), KILL_GRACE_MS).unref()
}, DEADLINE_MS)


processor.once('error', (error) => {
  clearTimeout(deadline)
  console.error('Unable to start Donations Portal processor', error)
  process.exitCode = 1
})

processor.once('exit', (code, signal) => {
  clearTimeout(deadline)
  process.exitCode = code ?? (signal === 'SIGTERM' ? 124 : 1)
})
