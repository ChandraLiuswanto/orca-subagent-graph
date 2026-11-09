import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { findCli, SAFE_ARG, run, killAll, running } from './cli.ts'

const posix = { skip: process.platform === 'win32' }
function script(t: { after(fn: () => void): void }, body: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orca-cli-test-'))
  const file = path.join(dir, 'orca')
  writeFileSync(file, '#!/usr/bin/env node\n' + body)
  chmodSync(file, 0o755)
  t.after(() => { killAll(); rmSync(dir, { recursive: true, force: true }) })
  return file
}

test('successful JSON resolves the result and clears tracking', posix, async (t) => {
  const cli = script(t, `console.log(JSON.stringify({ok:true,result:{x:1,args:process.argv.slice(2)}}))`)
  const result = run(cli, ['worker-list'], 2000)
  assert.equal(running(), 1)
  assert.deepEqual(await result, { x: 1, args: ['worker-list', '--json'] })
  assert.equal(running(), 0)
})

test('Orca error text is preserved', posix, async (t) => {
  const cli = script(t, `console.log('{"ok":false,"error":{"message":"nope"}}'); process.exitCode = 1`)
  await assert.rejects(run(cli, [], 2000), { message: 'nope' })
  assert.equal(running(), 0)
})

for (const [ms, seconds] of [[200, 0], [1000, 1]]) {
  test(`timeout ${ms}ms reports rounded seconds`, posix, async (t) => {
    const cli = script(t, 'setTimeout(() => {}, 5000)')
    await assert.rejects(run(cli, [], ms), { message: `timed out after ${seconds}s` })
    assert.equal(running(), 0)
  })
}

test('killAll kills every tracked child and clears tracking immediately', posix, async (t) => {
  const cli = script(t, 'setTimeout(() => {}, 5000)')
  const a = assert.rejects(run(cli, [], 5000), /timed out after 5s/)
  const b = assert.rejects(run(cli, [], 5000), /timed out after 5s/)
  assert.equal(running(), 2)
  killAll()
  assert.equal(running(), 0)
  await Promise.all([a, b])
  killAll()
  assert.equal(running(), 0)
})

test('parsed success is retained even when the process exits unsuccessfully', posix, async (t) => {
  const cli = script(t, `console.log('{"ok":true,"result":{"x":1}}'); process.exitCode = 1`)
  assert.deepEqual(await run(cli, [], 2000), { x: 1 })
})

test('missing JSON keeps the existing error message', posix, async (t) => {
  const cli = script(t, `console.log('not JSON')`)
  await assert.rejects(run(cli, [], 2000), { message: 'orca CLI returned no JSON' })
})

test('spawn errors keep their native text and clear tracking', async () => {
  await assert.rejects(run(path.join(os.tmpdir(), 'nonexistent-orca-cli-93c11', 'orca'), [], 2000), /ENOENT/)
  assert.equal(running(), 0)
})

test('cmd shim refuses unsafe arguments before spawning', async () => {
  assert.equal(SAFE_ARG.test('host:4242/path=a,b-c_d'), true)
  assert.equal(SAFE_ARG.test('host & command'), false)
  await assert.rejects(run('orca.cmd', ['bad&host'], 2000), /Refusing to pass unusual characters/)
  assert.equal(running(), 0)
})

test('findCli honors an existing override', posix, (t) => {
  const cli = script(t, '')
  assert.equal(findCli(cli), cli)
})
