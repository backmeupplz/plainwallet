// On macOS, exercise the real Swift handler and file lock with disposable storage only.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (process.platform !== 'darwin') {
  console.log('native Swift storage check skipped (requires macOS)')
} else {
  const exec = promisify(execFile)
  const dir = await mkdtemp(join(tmpdir(), 'plainwallet-storage-'))
  try {
    // Replace only app-group location discovery; handler, flock and atomic write stay unchanged.
    const source = await readFile(new URL('./macos/Shared/Storage.swift', import.meta.url), 'utf8')
    const locate = 'FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)'
    assert.ok(source.includes(locate))
    const main = [
      'let request = try JSONSerialization.jsonObject(with: Data(CommandLine.arguments[2].utf8))',
      'let result = Storage.handle(request)',
      'print(String(data: try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), encoding: .utf8)!)',
    ].join('\n')
    await writeFile(join(dir, 'main.swift'), source.replace(locate, 'URL(string: CommandLine.arguments[1])') + '\n' + main)
    const binary = join(dir, 'storage-check')
    await exec('xcrun', ['swiftc', join(dir, 'main.swift'), '-o', binary])
    const call = async request => JSON.parse((await exec(binary, ['file://' + dir, JSON.stringify(request)])).stdout)
    const tx = (vault, mac, expected = { vault: null, mac: null }) => ({ compareAndSet: { expected, set: { vault, mac } } })
    assert.deepEqual(await call(tx('v1', 'm1')), { committed: true })
    assert.deepEqual(await call(tx('stale', 'stale')), { committed: false })
    // Two OS processes, one snapshot: exactly one can commit.
    const pair = await Promise.all([call(tx('v2', 'm2', { vault: 'v1', mac: 'm1' })), call(tx('v3', 'm3', { vault: 'v1', mac: 'm1' }))])
    assert.deepEqual(pair.map(r => r.committed).sort(), [false, true])
    const { values } = await call({ get: null })
    assert.ok((values.vault === 'v2' && values.mac === 'm2') || (values.vault === 'v3' && values.mac === 'm3'))
    await call({ set: { mac: 'new-mac', unrelated: 'keep' } })
    assert.deepEqual(await call(tx('stale', 'stale', values)), { committed: false })
    assert.ok((await call({ compareAndSet: { expected: {}, set: {} } })).error)
    assert.ok((await call({ compareAndSet: { expected: { vault: 7, mac: 'new-mac' }, set: {} } })).error)
    assert.equal((await call({ get: null })).values.unrelated, 'keep')
    console.log('native Swift compare-and-set and cross-process file lock ok')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
