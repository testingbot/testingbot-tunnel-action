import {describe, it, beforeEach, afterEach} from 'mocha'
import {strict as assert} from 'assert'
import * as sinon from 'sinon'
import {toolkit} from '../src/toolkit'
import * as container from '../src/container'
import {run} from '../src/post'

describe('post.run', () => {
    let getStateStub: sinon.SinonStub
    let getInputStub: sinon.SinonStub
    let warningStub: sinon.SinonStub
    let stopTunnelStub: sinon.SinonStub
    let uploadLogStub: sinon.SinonStub

    beforeEach(() => {
        getStateStub = sinon.stub(toolkit, 'getState')
        getStateStub.withArgs('workDir').returns('/tmp/tb-tunnel-test')
        getStateStub.returns('')
        getInputStub = sinon.stub(toolkit, 'getInput').returns('')
        warningStub = sinon.stub(toolkit, 'warning')
        sinon.stub(toolkit, 'info')
        stopTunnelStub = sinon.stub(container, 'stopTunnel').resolves()
        uploadLogStub = sinon.stub(container, 'uploadLog').resolves()
    })

    afterEach(() => {
        sinon.restore()
    })

    it('still uploads the log when no container ID was saved (tunnel failed to start)', async () => {
        getInputStub.withArgs('uploadLogFile').returns('true')

        await run()

        assert.ok(
            warningStub.calledWith('No active TestingBot Tunnel available.')
        )
        assert.ok(stopTunnelStub.notCalled)
        assert.ok(
            uploadLogStub.calledOnceWith(
                '/tmp/tb-tunnel-test',
                'testingbot-tunnel.log'
            )
        )
    })

    it('does nothing when the main step never created a work dir', async () => {
        getStateStub.withArgs('workDir').returns('')
        getInputStub.withArgs('uploadLogFile').returns('true')

        await run()

        assert.ok(stopTunnelStub.notCalled)
        assert.ok(uploadLogStub.notCalled)
    })

    it('stops the tunnel and uploads log when uploadLogFile is true', async () => {
        getStateStub.withArgs('containerId').returns('abc123')
        getInputStub.withArgs('uploadLogFile').returns('true')

        await run()

        assert.ok(stopTunnelStub.calledOnceWith('abc123'))
        assert.ok(uploadLogStub.calledOnceWith('/tmp/tb-tunnel-test'))
    })

    it('passes a custom logArtifactName to uploadLog', async () => {
        getStateStub.withArgs('containerId').returns('abc123')
        getInputStub.withArgs('uploadLogFile').returns('true')
        getInputStub.withArgs('logArtifactName').returns('tunnel-log-chrome')

        await run()

        assert.ok(
            uploadLogStub.calledOnceWith(
                '/tmp/tb-tunnel-test',
                'tunnel-log-chrome'
            )
        )
    })

    it('stops the tunnel but does not upload log when uploadLogFile is false', async () => {
        getStateStub.withArgs('containerId').returns('abc123')
        getInputStub.withArgs('uploadLogFile').returns('false')

        await run()

        assert.ok(stopTunnelStub.calledOnceWith('abc123'))
        assert.ok(uploadLogStub.notCalled)
    })

    it('uploads the log even when stopping the tunnel fails', async () => {
        getStateStub.withArgs('containerId').returns('abc123')
        getInputStub.withArgs('uploadLogFile').returns('true')
        stopTunnelStub.rejects(new Error('docker died'))

        await assert.rejects(() => run(), {message: 'docker died'})

        assert.ok(uploadLogStub.calledOnce)
    })
})
