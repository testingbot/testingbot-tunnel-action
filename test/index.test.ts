import {describe, it, beforeEach, afterEach} from 'mocha'
import {strict as assert} from 'assert'
import * as sinon from 'sinon'
import {toolkit} from '../src/toolkit'
import * as container from '../src/container'
import {run, retryDelays} from '../src/index'

// Fake startTunnel that reports the container as started, like the real one.
function startsContainer(id: string) {
    return async (
        _workDir: string,
        onContainerStarted?: (containerId: string) => void
    ): Promise<string> => {
        onContainerStarted?.(id)
        return id
    }
}

describe('index.run', () => {
    let getInputStub: sinon.SinonStub
    let saveStateStub: sinon.SinonStub
    let setOutputStub: sinon.SinonStub
    let startTunnelStub: sinon.SinonStub
    let runDoctorStub: sinon.SinonStub
    let assertDockerStub: sinon.SinonStub

    beforeEach(() => {
        getInputStub = sinon.stub(toolkit, 'getInput').returns('')
        getInputStub.withArgs('key').returns('test-key')
        getInputStub.withArgs('secret').returns('test-secret')
        saveStateStub = sinon.stub(toolkit, 'saveState')
        setOutputStub = sinon.stub(toolkit, 'setOutput')
        sinon.stub(toolkit, 'warning')
        startTunnelStub = sinon.stub(container, 'startTunnel')
        sinon.stub(container, 'createWorkDir').returns('/tmp/tb-tunnel-test')
        runDoctorStub = sinon.stub(container, 'runDoctor').resolves()
        assertDockerStub = sinon
            .stub(container, 'assertDockerAvailable')
            .resolves()
    })

    afterEach(() => {
        sinon.restore()
    })

    it('saves container ID and exposes outputs on first-attempt success', async () => {
        getInputStub.withArgs('retryTimeout').returns('10')
        getInputStub.withArgs('tunnelIdentifier').returns('my-tunnel')
        startTunnelStub.callsFake(startsContainer('container-abc'))

        await run()

        assert.ok(saveStateStub.calledWith('workDir', '/tmp/tb-tunnel-test'))
        assert.ok(saveStateStub.calledWith('containerId', 'container-abc'))
        assert.ok(startTunnelStub.calledOnceWith('/tmp/tb-tunnel-test'))
        assert.ok(setOutputStub.calledWith('container-id', 'container-abc'))
        assert.ok(setOutputStub.calledWith('tunnel-identifier', 'my-tunnel'))
        const logCall = setOutputStub
            .getCalls()
            .find(c => c.args[0] === 'log-file')
        assert.ok(logCall, 'log-file output should be set')
        assert.ok(
            typeof logCall.args[1] === 'string' &&
                logCall.args[1].endsWith('tb-tunnel.log')
        )
    })

    it('retries after failure and succeeds', async () => {
        getInputStub.withArgs('retryTimeout').returns('10')
        // Temporarily shrink the first retry delay so the test is fast
        const originalFirst = retryDelays[0]
        retryDelays[0] = 1

        try {
            startTunnelStub.onFirstCall().rejects(new Error('first fail'))
            startTunnelStub
                .onSecondCall()
                .callsFake(startsContainer('container-xyz'))

            await run()

            assert.ok(startTunnelStub.calledTwice)
            assert.ok(saveStateStub.calledWith('containerId', 'container-xyz'))
        } finally {
            retryDelays[0] = originalFirst
        }
    })

    it('throws timeout error when retryTimeout elapses', async () => {
        const clock = sinon.useFakeTimers()
        getInputStub.withArgs('retryTimeout').returns('10')
        startTunnelStub.rejects(new Error('always fails'))

        try {
            const promise = run()
            // Attach rejection handler immediately to avoid unhandled warning.
            const rejection = assert.rejects(promise, {
                message: 'Timed out waiting for Tunnel to start'
            })
            // Advance past the 10-minute retryTimeout (flush microtasks
            // between ticks so the retry loop progresses).
            for (let i = 0; i < 20; i++) {
                await clock.tickAsync(60 * 1000)
            }
            await rejection
        } finally {
            clock.restore()
        }
    })

    it('cuts the last wait short instead of waiting past retryTimeout', async () => {
        const clock = sinon.useFakeTimers()
        // 1 minute: the backoff reaches 47s, and the next 40s delay would
        // overshoot to 87s if it weren't capped.
        getInputStub.withArgs('retryTimeout').returns('1')
        startTunnelStub.rejects(new Error('always fails'))

        try {
            let settled = false
            const rejection = (async () => {
                await assert.rejects(run(), {
                    message: 'Timed out waiting for Tunnel to start'
                })
                settled = true
            })()
            await clock.tickAsync(61 * 1000)
            assert.ok(settled, 'should give up once retryTimeout has passed')
            await rejection
        } finally {
            clock.restore()
        }
    })

    it('fails up front on an invalid uploadLogFile', async () => {
        getInputStub.withArgs('uploadLogFile').returns('yes please')

        await assert.rejects(() => run(), {
            message: /Input "uploadLogFile" must be a boolean/
        })

        assert.ok(startTunnelStub.notCalled)
        assert.ok(!saveStateStub.calledWith('workDir', sinon.match.any))
    })

    it('defaults retryTimeout to 10 when input is empty or non-numeric', async () => {
        getInputStub.withArgs('retryTimeout').returns('not-a-number')
        startTunnelStub.callsFake(startsContainer('ok'))

        // Should not throw; just complete normally using the default.
        await run()

        assert.ok(saveStateStub.calledWith('containerId', 'ok'))
    })

    it('runs diagnostics once before starting, and survives a doctor failure', async () => {
        getInputStub.withArgs('retryTimeout').returns('10')
        runDoctorStub.rejects(new Error('doctor broke'))
        startTunnelStub.callsFake(startsContainer('container-abc'))

        await run()

        assert.ok(runDoctorStub.calledOnce)
        assert.ok(runDoctorStub.calledBefore(startTunnelStub))
        assert.ok(saveStateStub.calledWith('containerId', 'container-abc'))
    })

    it('does not retry a NonRetryableError', async () => {
        getInputStub.withArgs('retryTimeout').returns('10')
        startTunnelStub.rejects(new container.NonRetryableError('bad options'))

        await assert.rejects(() => run(), {message: 'bad options'})

        assert.ok(startTunnelStub.calledOnce)
        assert.ok(!saveStateStub.calledWith('containerId', sinon.match.any))
    })

    it('saves the container ID before the tunnel is ready', async () => {
        getInputStub.withArgs('retryTimeout').returns('10')
        // Container started, but readiness failed with a fatal error: the ID
        // must still be in state so the post step can remove the container.
        startTunnelStub.callsFake(
            async (
                _workDir: string,
                onContainerStarted: (containerId: string) => void
            ) => {
                onContainerStarted('container-starting')
                throw new container.NonRetryableError('bad options')
            }
        )

        await assert.rejects(() => run(), {message: 'bad options'})

        assert.ok(saveStateStub.calledWith('containerId', 'container-starting'))
        assert.ok(!setOutputStub.calledWith('container-id', sinon.match.any))
    })

    it('fails without retrying when Docker is not available', async () => {
        getInputStub.withArgs('retryTimeout').returns('10')
        assertDockerStub.rejects(
            new container.NonRetryableError('Docker is not available')
        )

        await assert.rejects(() => run(), {name: 'NonRetryableError'})

        assert.ok(startTunnelStub.notCalled)
        assert.ok(runDoctorStub.notCalled)
        assert.ok(!saveStateStub.calledWith('workDir', sinon.match.any))
    })

    for (const name of ['key', 'secret']) {
        it(`fails without retrying when ${name} is empty`, async () => {
            getInputStub.withArgs('retryTimeout').returns('10')
            getInputStub.withArgs(name).returns('  ')

            await assert.rejects(() => run(), {
                name: 'NonRetryableError',
                message: new RegExp(`Input required and not supplied: ${name}`)
            })

            assert.ok(startTunnelStub.notCalled)
            assert.ok(runDoctorStub.notCalled)
        })
    }
})
