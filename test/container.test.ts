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
    readyPoller,
    stopTunnel,
    uploadLog,
    startTunnel,
    TMP_DIR_HOST
} from '../src/container'

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
        getInputStub.returns('')

        const opts = buildOptions()

        assert.ok(opts.includes('--debug'))
        assert.ok(opts.includes('--no-cache'))
        // flag options should not have =value
        assert.ok(!opts.some(o => o.startsWith('--debug=')))
        assert.ok(!opts.some(o => o.startsWith('--no-cache=')))
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

        assert.ok(opts.includes('--auth=user:pass'))
        assert.ok(opts.includes('--pac=http://pac.url'))
        assert.ok(opts.includes('--se-port=4446'))
        assert.ok(opts.includes('--localproxy=9090'))
        assert.ok(opts.includes('--proxy=proxy.host:8080'))
        assert.ok(opts.includes('--proxy-userpwd=u:p'))
        assert.ok(opts.includes('--fast-fail-regexps=*.example.com'))
    })
})

describe('readyPoller', () => {
    afterEach(() => {
        // Clean up the ready file if it was created
        const readyFile = join(TMP_DIR_HOST, 'tb.ready')
        try {
            fs.unlinkSync(readyFile)
        } catch {
            // ignore
        }
    })

    it('should resolve when tb.ready file is created', async () => {
        // Write the file after a short delay
        setTimeout(() => {
            fs.writeFileSync(join(TMP_DIR_HOST, 'tb.ready'), '')
        }, 100)

        await readyPoller()
    })

    it('should resolve immediately if tb.ready already exists', async () => {
        fs.writeFileSync(join(TMP_DIR_HOST, 'tb.ready'), '')

        await readyPoller()
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

    it('should stop a running container', async () => {
        // First exec call is `docker ps` — simulate returning the container ID
        execStub
            .onFirstCall()
            .callsFake(
                async (
                    cmd: string,
                    args?: string[],
                    opts?: {listeners?: {stdout?: (data: Buffer) => void}}
                ) => {
                    if (opts?.listeners?.stdout) {
                        opts.listeners.stdout(Buffer.from('abc123\n'))
                    }
                    return 0
                }
            )
        // Second exec call is `docker container stop`
        execStub.onSecondCall().resolves(0)

        await stopTunnel('abc123')

        assert.ok(execStub.calledTwice)
        assert.deepEqual(execStub.secondCall.args[0], 'docker')
        assert.deepEqual(execStub.secondCall.args[1], [
            'container',
            'stop',
            'abc123'
        ])
    })

    it('should not stop if container is not running', async () => {
        execStub
            .onFirstCall()
            .callsFake(
                async (
                    cmd: string,
                    args?: string[],
                    opts?: {listeners?: {stdout?: (data: Buffer) => void}}
                ) => {
                    if (opts?.listeners?.stdout) {
                        opts.listeners.stdout(Buffer.from(''))
                    }
                    return 0
                }
            )

        await stopTunnel('abc123')

        assert.ok(execStub.calledOnce)
        assert.ok(
            infoStub.calledWith(
                'TestingBot Tunnel does not appear to be running.'
            )
        )
    })
})

describe('uploadLog', () => {
    let uploadArtifactStub: sinon.SinonStub

    beforeEach(() => {
        sinon.stub(core, 'info')
        sinon.stub(core, 'warning')
        uploadArtifactStub = sinon.stub()
        sinon.stub(artifactDeps, 'createClient').returns({
            uploadArtifact: uploadArtifactStub
        })
    })

    afterEach(() => {
        sinon.restore()
    })

    it('uploads the artifact with the correct name and path', async () => {
        uploadArtifactStub.resolves({id: 1, size: 0})

        await uploadLog()

        assert.ok(uploadArtifactStub.calledOnce)
        const [name, files, rootDir] = uploadArtifactStub.firstCall.args
        assert.equal(name, 'testingbot-tunnel.log')
        assert.equal(files.length, 1)
        assert.ok(files[0].endsWith('tb-tunnel.log'))
        assert.equal(rootDir, TMP_DIR_HOST)
    })

    it('swallows errors so post-action does not fail', async () => {
        uploadArtifactStub.rejects(new Error('upload failed'))

        // uploadLog catches errors internally — should not throw
        await uploadLog()
    })
})

describe('startTunnel', () => {
    let execStub: sinon.SinonStub
    let getInputStub: sinon.SinonStub

    beforeEach(() => {
        sinon.stub(core, 'info')
        sinon.stub(core, 'warning')
        sinon.stub(core, 'isDebug').returns(false)
        sinon.stub(core, 'setSecret')
        getInputStub = sinon.stub(core, 'getInput')
        getInputStub.withArgs('tbVersion').returns('latest')
        getInputStub.withArgs('key', sinon.match.any).returns('my-key')
        getInputStub.withArgs('secret', sinon.match.any).returns('my-secret')
        getInputStub.returns('')

        execStub = sinon.stub(actionsExec, 'exec')

        // Clean up ready file before each test
        try {
            fs.unlinkSync(join(TMP_DIR_HOST, 'tb.ready'))
        } catch {
            // ignore
        }
    })

    afterEach(() => {
        sinon.restore()
        try {
            fs.unlinkSync(join(TMP_DIR_HOST, 'tb.ready'))
        } catch {
            // ignore
        }
    })

    it('should pull image, run container, and return container ID', async () => {
        // docker pull
        execStub.onFirstCall().resolves(0)
        // docker run — return container ID via stdout
        execStub
            .onSecondCall()
            .callsFake(
                async (
                    cmd: string,
                    args?: string[],
                    opts?: {listeners?: {stdout?: (data: Buffer) => void}}
                ) => {
                    if (opts?.listeners?.stdout) {
                        opts.listeners.stdout(Buffer.from('container-id-123\n'))
                    }
                    // Simulate tunnel becoming ready
                    fs.writeFileSync(join(TMP_DIR_HOST, 'tb.ready'), '')
                    return 0
                }
            )

        const containerId = await startTunnel()

        assert.equal(containerId, 'container-id-123')
        assert.ok(
            execStub.firstCall.args[1]?.includes('testingbot/tunnel:latest')
        )

        // docker run args: forward creds as env vars, never inline them
        const runArgs = execStub.secondCall.args[1] as string[]
        assert.ok(runArgs.includes('-e'))
        assert.ok(runArgs.includes('TESTINGBOT_KEY'))
        assert.ok(runArgs.includes('TESTINGBOT_SECRET'))
        assert.ok(!runArgs.includes('my-key'))
        assert.ok(!runArgs.includes('my-secret'))

        // exec options should carry the env vars so docker can forward them
        const runOpts = execStub.secondCall.args[2] as {
            env: NodeJS.ProcessEnv
        }
        assert.equal(runOpts.env.TESTINGBOT_KEY, 'my-key')
        assert.equal(runOpts.env.TESTINGBOT_SECRET, 'my-secret')
    })

    it('should stop container and throw on readyPoller timeout @slow', async () => {
        // docker pull
        execStub.onFirstCall().resolves(0)
        // docker run
        execStub
            .onSecondCall()
            .callsFake(
                async (
                    cmd: string,
                    args?: string[],
                    opts?: {listeners?: {stdout?: (data: Buffer) => void}}
                ) => {
                    if (opts?.listeners?.stdout) {
                        opts.listeners.stdout(Buffer.from('container-id-456\n'))
                    }
                    // Don't create the ready file — will trigger timeout
                    return 0
                }
            )
        // docker ps (from stopTunnel)
        execStub
            .onCall(2)
            .callsFake(
                async (
                    cmd: string,
                    args?: string[],
                    opts?: {listeners?: {stdout?: (data: Buffer) => void}}
                ) => {
                    if (opts?.listeners?.stdout) {
                        opts.listeners.stdout(Buffer.from('container-id-456\n'))
                    }
                    return 0
                }
            )
        // docker container stop
        execStub.onCall(3).resolves(0)

        await assert.rejects(() => startTunnel(), {
            message: 'Timeout Error: waited 60 seconds for tunnel to start.'
        })
    }).timeout(70000)
})
