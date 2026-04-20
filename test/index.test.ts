import {describe, it, beforeEach, afterEach} from 'mocha'
import {strict as assert} from 'assert'
import * as sinon from 'sinon'
import * as core from '@actions/core'
import * as container from '../src/container'
import {run, retryDelays} from '../src/index'

describe('index.run', () => {
    let getInputStub: sinon.SinonStub
    let saveStateStub: sinon.SinonStub
    let startTunnelStub: sinon.SinonStub

    beforeEach(() => {
        getInputStub = sinon.stub(core, 'getInput')
        saveStateStub = sinon.stub(core, 'saveState')
        sinon.stub(core, 'warning')
        startTunnelStub = sinon.stub(container, 'startTunnel')
    })

    afterEach(() => {
        sinon.restore()
    })

    it('saves container ID on first-attempt success', async () => {
        getInputStub.withArgs('retryTimeout').returns('10')
        startTunnelStub.resolves('container-abc')

        await run()

        assert.ok(saveStateStub.calledOnceWith('containerId', 'container-abc'))
        assert.ok(startTunnelStub.calledOnce)
    })

    it('retries after failure and succeeds', async () => {
        getInputStub.withArgs('retryTimeout').returns('10')
        // Temporarily shrink the first retry delay so the test is fast
        const originalFirst = retryDelays[0]
        retryDelays[0] = 1

        try {
            startTunnelStub.onFirstCall().rejects(new Error('first fail'))
            startTunnelStub.onSecondCall().resolves('container-xyz')

            await run()

            assert.ok(startTunnelStub.calledTwice)
            assert.ok(
                saveStateStub.calledOnceWith('containerId', 'container-xyz')
            )
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

    it('defaults retryTimeout to 10 when input is empty or non-numeric', async () => {
        getInputStub.withArgs('retryTimeout').returns('not-a-number')
        startTunnelStub.resolves('ok')

        // Should not throw; just complete normally using the default.
        await run()

        assert.ok(saveStateStub.calledOnce)
    })
})
