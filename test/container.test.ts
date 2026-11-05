import {describe, it, beforeEach, afterEach} from 'mocha'
import {strict as assert} from 'assert'
import * as sinon from 'sinon'
import * as core from '@actions/core'
import * as actionsExec from '@actions/exec'
import * as fs from 'fs'
import {join} from 'path'

import {
    artifactDeps,
    buildOptions,
    buildSecretEnv,
    ContainerExitedError,
    createWorkDir,
    NonRetryableError,
    parseBooleanInput,
    pollDeps,
    readyPoller,
    stopTunnel,
    uploadLog,
    startTunnel
} from '../src/container'

type ExecOpts = {
    listeners?: {
        stdout?: (data: Buffer) => void
        stderr?: (data: Buffer) => void
    }
}
type DockerResult = {stdout?: string; stderr?: string; code?: number}
type DockerHandler = (args: string[]) => DockerResult | void

/**
 * Routes stubbed `exec('docker', [sub, ...])` calls to a handler per docker
 * sub-command (pull, run, inspect, logs, container).
 */
function fakeDocker(
    execStub: sinon.SinonStub,
    handlers: {[sub: string]: DockerHandler}
): void {
    execStub.callsFake(
        async (cmd: string, args: string[] = [], opts?: ExecOpts) => {
            const handler = handlers[args[0]]
            const result = (handler ? handler(args) : undefined) ?? {}
            if (result.stdout) {
                opts?.listeners?.stdout?.(Buffer.from(result.stdout))
            }
            if (result.stderr) {
                opts?.listeners?.stderr?.(Buffer.from(result.stderr))
            }
            return result.code ?? 0
        }
    )
}

function dockerCalls(execStub: sinon.SinonStub, sub: string): string[][] {
    return execStub
        .getCalls()
        .map(c => c.args[1] as string[])
        .filter(a => a[0] === sub)
}

describe('buildOptions', () => {
    let getInputStub: sinon.SinonStub
    let isDebugStub: sinon.SinonStub

    beforeEach(() => {
        getInputStub = sinon.stub(core, 'getInput')
        isDebugStub = sinon.stub(core, 'isDebug').returns(false)
    })

    afterEach(() => {
        sinon.restore()
    })

    it('should include logfile and readyfile but never key/secret', async () => {
        getInputStub.returns('')

        const opts = buildOptions()

        assert.ok(opts.some(o => o.startsWith('--logfile=')))
        assert.ok(opts.some(o => o.startsWith('--readyfile=')))
        // Credentials must not appear in the CLI args — they are passed via env.
        assert.ok(!opts.some(o => o === 'my-key' || o === 'my-secret'))
    })

    it('should include value-based options when set', async () => {
        getInputStub
            .withArgs('tunnelIdentifier', sinon.match.any)
            .returns('my-tunnel')
        getInputStub.withArgs('dns', sinon.match.any).returns('8.8.8.8')
        getInputStub.returns('')

        const opts = buildOptions()

        assert.ok(opts.includes('--tunnel-identifier=my-tunnel'))
        assert.ok(opts.includes('--dns=8.8.8.8'))
    })

    it('should include flag options without a value', async () => {
        getInputStub.withArgs('debug', sinon.match.any).returns('true')
        getInputStub.withArgs('noCache', sinon.match.any).returns('true')
        getInputStub.withArgs('noBump', sinon.match.any).returns('true')
        getInputStub.withArgs('shared', sinon.match.any).returns('true')
        getInputStub.returns('')

        const opts = buildOptions()

        assert.ok(opts.includes('--debug'))
        assert.ok(opts.includes('--nocache'))
        assert.ok(opts.includes('--nobump'))
        assert.ok(opts.includes('--shared'))
        // flag options should not have =value
        assert.ok(!opts.some(o => o.startsWith('--debug=')))
        assert.ok(!opts.some(o => o.startsWith('--nocache=')))
        assert.ok(!opts.some(o => o.startsWith('--nobump=')))
        assert.ok(!opts.some(o => o.startsWith('--shared=')))
    })

    it('should only contain logfile and readyfile when nothing else is set', async () => {
        getInputStub.returns('')

        const opts = buildOptions()

        assert.equal(opts.length, 2)
    })

    it('should add --debug when core.isDebug is true', async () => {
        getInputStub.returns('')
        isDebugStub.returns(true)

        const opts = buildOptions()

        assert.ok(opts.includes('--debug'))
    })

    it('should handle all option mappings', async () => {
        getInputStub.withArgs('auth', sinon.match.any).returns('user:pass')
        getInputStub.withArgs('pac', sinon.match.any).returns('http://pac.url')
        getInputStub.withArgs('sePort', sinon.match.any).returns('4446')
        getInputStub.withArgs('localProxy', sinon.match.any).returns('9090')
        getInputStub.withArgs('hubPort', sinon.match.any).returns('80')
        getInputStub.withArgs('metricsPort', sinon.match.any).returns('9003')
        getInputStub.withArgs('web', sinon.match.any).returns('/tmp/www')
        getInputStub
            .withArgs('extraHeaders', sinon.match.any)
            .returns('{"X-Foo":"bar"}')
        getInputStub
            .withArgs('proxy', sinon.match.any)
            .returns('proxy.host:8080')
        getInputStub
            .withArgs('proxyCredentials', sinon.match.any)
            .returns('u:p')
        getInputStub
            .withArgs('fastFailRegexps', sinon.match.any)
            .returns('*.example.com')
        getInputStub.returns('')

        const opts = buildOptions()

        // Credential-bearing options are passed via env, never as CLI args
        assert.ok(!opts.some(o => o.startsWith('--auth')))
        assert.ok(!opts.some(o => o.startsWith('--proxy-userpwd')))
        assert.ok(!opts.some(o => o.includes('user:pass')))
        assert.ok(!opts.some(o => o.includes('u:p')))
        assert.ok(opts.includes('--pac=http://pac.url'))
        assert.ok(opts.includes('--se-port=4446'))
        assert.ok(opts.includes('--localproxy=9090'))
        assert.ok(opts.includes('--hubport=80'))
        assert.ok(opts.includes('--metrics-port=9003'))
        assert.ok(opts.includes('--web=/tmp/www'))
        assert.ok(opts.includes('--extra-headers={"X-Foo":"bar"}'))
        assert.ok(opts.includes('--proxy=proxy.host:8080'))
        assert.ok(opts.includes('--fast-fail-regexps=*.example.com'))
    })
})

describe('buildOptions (boolean flags)', () => {
    let getInputStub: sinon.SinonStub
    let isDebugStub: sinon.SinonStub

    beforeEach(() => {
        getInputStub = sinon.stub(core, 'getInput')
        isDebugStub = sinon.stub(core, 'isDebug').returns(false)
    })

    afterEach(() => {
        sinon.restore()
    })

    it('should not add a flag when its input is "false"', async () => {
        getInputStub.withArgs('shared', sinon.match.any).returns('false')
        getInputStub.withArgs('noBump', sinon.match.any).returns('False')
        getInputStub.withArgs('debug', sinon.match.any).returns('FALSE')
        getInputStub.returns('')

        const opts = buildOptions()

        assert.ok(!opts.includes('--shared'))
        assert.ok(!opts.includes('--nobump'))
        assert.ok(!opts.includes('--debug'))
    })

    it('should reject non-boolean values for flag inputs', async () => {
        getInputStub.withArgs('shared', sinon.match.any).returns('yes')
        getInputStub.returns('')

        assert.throws(() => buildOptions(), /Input "shared" must be a boolean/)
    })

    it('should add --debug only once when both debug input and runner debug are on', async () => {
        getInputStub.withArgs('debug', sinon.match.any).returns('true')
        getInputStub.returns('')
        isDebugStub.returns(true)

        const opts = buildOptions()

        assert.equal(opts.filter(o => o === '--debug').length, 1)
    })
})

describe('parseBooleanInput', () => {
    it('treats empty input as false', () => {
        assert.equal(parseBooleanInput('x', ''), false)
        assert.equal(parseBooleanInput('x', '  '), false)
    })

    it('accepts YAML booleans', () => {
        assert.equal(parseBooleanInput('x', 'true'), true)
        assert.equal(parseBooleanInput('x', 'TRUE'), true)
        assert.equal(parseBooleanInput('x', 'false'), false)
    })
})

describe('buildSecretEnv', () => {
    let getInputStub: sinon.SinonStub
    let setSecretStub: sinon.SinonStub

    beforeEach(() => {
        getInputStub = sinon.stub(core, 'getInput')
        setSecretStub = sinon.stub(core, 'setSecret')
    })

    afterEach(() => {
        sinon.restore()
    })

    it('maps auth and proxyCredentials to env vars and masks them', async () => {
        getInputStub
            .withArgs('auth', sinon.match.any)
            .returns('host:80:user:pass')
        getInputStub
            .withArgs('proxyCredentials', sinon.match.any)
            .returns('u:p')
        getInputStub.returns('')

        const env = buildSecretEnv()

        assert.deepEqual(env, {
            TESTINGBOT_AUTH: 'host:80:user:pass',
            TESTINGBOT_PROXY_USERPWD: 'u:p'
        })
        assert.ok(setSecretStub.calledWith('host:80:user:pass'))
        assert.ok(setSecretStub.calledWith('u:p'))
    })

    it('returns nothing when no secret inputs are set', async () => {
        getInputStub.returns('')

        assert.deepEqual(buildSecretEnv(), {})
        assert.ok(setSecretStub.notCalled)
    })
})

describe('createWorkDir', () => {
    it('creates a fresh, world-writable directory per call', () => {
        const a = createWorkDir()
        const b = createWorkDir()
        try {
            assert.notEqual(a, b)
            assert.equal(fs.statSync(a).mode & 0o777, 0o777)
        } finally {
            fs.rmSync(a, {recursive: true, force: true})
            fs.rmSync(b, {recursive: true, force: true})
        }
    })
})

describe('readyPoller', () => {
    let workDir: string
    let execStub: sinon.SinonStub
    let getInputStub: sinon.SinonStub
    const originalInterval = pollDeps.intervalMs

    beforeEach(() => {
        workDir = createWorkDir()
        pollDeps.intervalMs = 20
        execStub = sinon.stub(actionsExec, 'exec')
        getInputStub = sinon.stub(core, 'getInput').returns('')
    })

    afterEach(() => {
        sinon.restore()
        pollDeps.intervalMs = originalInterval
        fs.rmSync(workDir, {recursive: true, force: true})
    })

    it('should resolve when tb.ready file is created', async () => {
        fakeDocker(execStub, {inspect: () => ({stdout: 'true 0\n'})})
        setTimeout(() => {
            fs.writeFileSync(join(workDir, 'tb.ready'), '')
        }, 100)

        await readyPoller(workDir, 'abc')
    })

    it('should resolve immediately if tb.ready already exists', async () => {
        fakeDocker(execStub, {inspect: () => ({stdout: 'true 0\n'})})
        fs.writeFileSync(join(workDir, 'tb.ready'), '')

        await readyPoller(workDir, 'abc')
    })

    it('should fail fast when the container exits before becoming ready', async () => {
        fakeDocker(execStub, {inspect: () => ({stdout: 'false 1\n'})})

        const start = Date.now()
        await assert.rejects(
            () => readyPoller(workDir, 'abc'),
            (err: unknown) =>
                err instanceof ContainerExitedError && err.exitCode === 1
        )
        assert.ok(Date.now() - start < 1000)
    })

    it('should treat a removed container as exited', async () => {
        fakeDocker(execStub, {inspect: () => ({code: 1})})

        await assert.rejects(
            () => readyPoller(workDir, 'abc'),
            (err: unknown) =>
                err instanceof ContainerExitedError &&
                err.exitCode === undefined
        )
    })

    it('should time out after readyTimeout seconds', async () => {
        getInputStub.withArgs('readyTimeout').returns('1')
        fakeDocker(execStub, {inspect: () => ({stdout: 'true 0\n'})})

        await assert.rejects(() => readyPoller(workDir, 'abc'), {
            message: 'Timeout Error: waited 1 seconds for tunnel to start.'
        })
    })
})

describe('stopTunnel', () => {
    let execStub: sinon.SinonStub
    let infoStub: sinon.SinonStub

    beforeEach(() => {
        infoStub = sinon.stub(core, 'info')
        execStub = sinon.stub(actionsExec, 'exec')
    })

    afterEach(() => {
        sinon.restore()
    })

    it('should stop and remove a running container', async () => {
        fakeDocker(execStub, {inspect: () => ({stdout: 'true 0\n'})})

        await stopTunnel('abc123')

        assert.deepEqual(dockerCalls(execStub, 'container'), [
            ['container', 'stop', 'abc123'],
            ['container', 'rm', '--force', 'abc123']
        ])
    })

    it('should not stop, but still remove, a container that is not running', async () => {
        fakeDocker(execStub, {inspect: () => ({stdout: 'false 0\n'})})

        await stopTunnel('abc123')

        assert.deepEqual(dockerCalls(execStub, 'container'), [
            ['container', 'rm', '--force', 'abc123']
        ])
        assert.ok(
            infoStub.calledWith(
                'TestingBot Tunnel does not appear to be running.'
            )
        )
    })
})

describe('uploadLog', () => {
    let uploadArtifactStub: sinon.SinonStub
    let workDir: string

    beforeEach(() => {
        sinon.stub(core, 'info')
        sinon.stub(core, 'warning')
        uploadArtifactStub = sinon.stub()
        sinon.stub(artifactDeps, 'createClient').returns({
            uploadArtifact: uploadArtifactStub
        })
        workDir = createWorkDir()
    })

    afterEach(() => {
        sinon.restore()
        fs.rmSync(workDir, {recursive: true, force: true})
    })

    it('uploads the artifact with the correct name and path', async () => {
        fs.writeFileSync(join(workDir, 'tb-tunnel.log'), 'log')
        uploadArtifactStub.resolves({id: 1, size: 0})

        await uploadLog(workDir)

        assert.ok(uploadArtifactStub.calledOnce)
        const [name, files, rootDir] = uploadArtifactStub.firstCall.args
        assert.equal(name, 'testingbot-tunnel.log')
        assert.deepEqual(files, [join(workDir, 'tb-tunnel.log')])
        assert.equal(rootDir, workDir)
    })

    it('skips the upload when there is no log file', async () => {
        await uploadLog(workDir)

        assert.ok(uploadArtifactStub.notCalled)
    })

    it('uses a custom artifact name, replacing invalid characters', async () => {
        fs.writeFileSync(join(workDir, 'tb-tunnel.log'), 'log')
        uploadArtifactStub.resolves({id: 1, size: 0})

        await uploadLog(workDir, 'tunnel: chrome/linux')

        assert.equal(
            uploadArtifactStub.firstCall.args[0],
            'tunnel- chrome-linux'
        )
    })

    it('retries under a unique name when the upload fails (e.g. name taken by another matrix job)', async () => {
        fs.writeFileSync(join(workDir, 'tb-tunnel.log'), 'log')
        const originalJob = process.env['GITHUB_JOB']
        process.env['GITHUB_JOB'] = 'e2e'
        uploadArtifactStub
            .onFirstCall()
            .rejects(new Error('an artifact with this name already exists'))
        uploadArtifactStub.onSecondCall().resolves({id: 2, size: 0})

        try {
            await uploadLog(workDir)
        } finally {
            if (originalJob === undefined) {
                delete process.env['GITHUB_JOB']
            } else {
                process.env['GITHUB_JOB'] = originalJob
            }
        }

        assert.ok(uploadArtifactStub.calledTwice)
        assert.match(
            uploadArtifactStub.secondCall.args[0],
            /^testingbot-tunnel\.log-e2e-[0-9a-f]{6}$/
        )
    })

    it('swallows errors so post-action does not fail', async () => {
        fs.writeFileSync(join(workDir, 'tb-tunnel.log'), 'log')
        uploadArtifactStub.rejects(new Error('upload failed'))

        // uploadLog catches errors internally — should not throw
        await uploadLog(workDir)
        assert.ok(uploadArtifactStub.calledTwice)
        assert.ok((core.warning as sinon.SinonStub).calledOnce)
    })
})

describe('startTunnel', () => {
    let execStub: sinon.SinonStub
    let getInputStub: sinon.SinonStub
    let warningStub: sinon.SinonStub
    let workDir: string
    const originalInterval = pollDeps.intervalMs

    beforeEach(() => {
        sinon.stub(core, 'info')
        warningStub = sinon.stub(core, 'warning')
        sinon.stub(core, 'isDebug').returns(false)
        sinon.stub(core, 'setSecret')
        getInputStub = sinon.stub(core, 'getInput')
        getInputStub.withArgs('tbVersion').returns('latest')
        getInputStub.withArgs('key', sinon.match.any).returns('my-key')
        getInputStub.withArgs('secret', sinon.match.any).returns('my-secret')
        getInputStub.returns('')

        execStub = sinon.stub(actionsExec, 'exec')
        workDir = createWorkDir()
        pollDeps.intervalMs = 20
    })

    afterEach(() => {
        sinon.restore()
        pollDeps.intervalMs = originalInterval
        fs.rmSync(workDir, {recursive: true, force: true})
    })

    function readyOnRun(id: string): {[sub: string]: DockerHandler} {
        return {
            run: () => {
                fs.writeFileSync(join(workDir, 'tb.ready'), '')
                return {stdout: `${id}\n`}
            },
            inspect: () => ({stdout: 'true 0\n'})
        }
    }

    it('should pull image, run container, and return container ID', async () => {
        fakeDocker(execStub, readyOnRun('container-id-123'))

        const containerId = await startTunnel(workDir)

        assert.equal(containerId, 'container-id-123')
        assert.deepEqual(dockerCalls(execStub, 'pull'), [
            ['pull', 'testingbot/tunnel:latest']
        ])

        // docker run args: forward creds as env vars, never inline them
        const runCall = execStub
            .getCalls()
            .find(c => (c.args[1] as string[])[0] === 'run')
        assert.ok(runCall)
        const runArgs = runCall.args[1] as string[]
        assert.ok(runArgs.includes('-e'))
        assert.ok(runArgs.includes('TESTINGBOT_KEY'))
        assert.ok(runArgs.includes('TESTINGBOT_SECRET'))
        assert.ok(!runArgs.includes('my-key'))
        assert.ok(!runArgs.includes('my-secret'))
        assert.ok(runArgs.includes(`${workDir}:/tmp`))

        // exec options should carry the env vars so docker can forward them
        const runOpts = runCall.args[2] as {env: NodeJS.ProcessEnv}
        assert.equal(runOpts.env.TESTINGBOT_KEY, 'my-key')
        assert.equal(runOpts.env.TESTINGBOT_SECRET, 'my-secret')
    })

    it('should forward auth/proxy credentials as env vars, not CLI args', async () => {
        getInputStub.withArgs('auth', sinon.match.any).returns('h:80:u:pw')
        fakeDocker(execStub, readyOnRun('container-id-789'))

        await startTunnel(workDir)

        const runCall = execStub
            .getCalls()
            .find(c => (c.args[1] as string[])[0] === 'run')
        assert.ok(runCall)
        const runArgs = runCall.args[1] as string[]
        assert.ok(runArgs.includes('TESTINGBOT_AUTH'))
        assert.ok(!runArgs.some(a => a.includes('h:80:u:pw')))
        const runOpts = runCall.args[2] as {env: NodeJS.ProcessEnv}
        assert.equal(runOpts.env.TESTINGBOT_AUTH, 'h:80:u:pw')
    })

    it('should ignore a stale ready file from a previous attempt', async () => {
        fs.writeFileSync(join(workDir, 'tb.ready'), '')
        fakeDocker(execStub, {
            run: () => ({stdout: 'container-id-1\n'}),
            inspect: () => ({stdout: 'false 1\n'})
        })

        await assert.rejects(() => startTunnel(workDir), ContainerExitedError)
    })

    it('should print the container output and remove the container on failure', async () => {
        fakeDocker(execStub, {
            run: () => ({stdout: 'container-id-2\n'}),
            inspect: () => ({stdout: 'false 1\n'}),
            logs: () => ({stderr: 'Creating a new tunnel failed\n'})
        })

        await assert.rejects(
            () => startTunnel(workDir),
            (err: unknown) =>
                err instanceof ContainerExitedError &&
                !(err instanceof NonRetryableError)
        )
        assert.ok(
            warningStub.calledWith(sinon.match('Creating a new tunnel failed'))
        )
        assert.deepEqual(dockerCalls(execStub, 'container'), [
            ['container', 'rm', '--force', 'container-id-2']
        ])
    })

    it('should only print the current attempt from the log file', async () => {
        const infoStub = core.info as sinon.SinonStub
        fs.writeFileSync(join(workDir, 'tb-tunnel.log'), 'previous attempt\n')
        fakeDocker(execStub, {
            run: () => {
                fs.appendFileSync(
                    join(workDir, 'tb-tunnel.log'),
                    'this attempt\n'
                )
                fs.writeFileSync(join(workDir, 'tb.ready'), '')
                return {stdout: 'container-id-5\n'}
            },
            inspect: () => ({stdout: 'true 0\n'})
        })

        await startTunnel(workDir)

        const logged = infoStub
            .getCalls()
            .map(c => String(c.args[0]))
            .find(m => m.startsWith('TestingBot Tunnel log:'))
        assert.equal(logged, 'TestingBot Tunnel log: this attempt\n')
    })

    it('should not retry on invalid command-line options (exit code 2)', async () => {
        fakeDocker(execStub, {
            run: () => ({stdout: 'container-id-3\n'}),
            inspect: () => ({stdout: 'false 2\n'}),
            logs: () => ({stderr: '--proxy needs a value.\n'})
        })

        await assert.rejects(() => startTunnel(workDir), NonRetryableError)
    })

    it('should not retry when credentials are rejected', async () => {
        fakeDocker(execStub, {
            run: () => ({stdout: 'container-id-4\n'}),
            inspect: () => ({stdout: 'false 1\n'}),
            logs: () => ({
                stderr: 'Could not start tunnel: Failed : HTTP error code : 401 - {"error":"401 Unauthorized. Please supply correct API key and API secret"}\n'
            })
        })

        await assert.rejects(() => startTunnel(workDir), NonRetryableError)
    })

    it('should stop the container and throw on readyPoller timeout', async () => {
        getInputStub.withArgs('readyTimeout').returns('1')
        fakeDocker(execStub, {
            run: () => ({stdout: 'container-id-456\n'}),
            inspect: () => ({stdout: 'true 0\n'})
        })

        await assert.rejects(() => startTunnel(workDir), {
            message: 'Timeout Error: waited 1 seconds for tunnel to start.'
        })
        assert.deepEqual(dockerCalls(execStub, 'container'), [
            ['container', 'stop', 'container-id-456'],
            ['container', 'rm', '--force', 'container-id-456']
        ])
    })
})
