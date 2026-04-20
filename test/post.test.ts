import {describe, it, beforeEach, afterEach} from 'mocha'
import {strict as assert} from 'assert'
import * as sinon from 'sinon'
import * as core from '@actions/core'
import * as container from '../src/container'
import {run} from '../src/post'

describe('post.run', () => {
    let getStateStub: sinon.SinonStub
    let getInputStub: sinon.SinonStub
    let warningStub: sinon.SinonStub
    let stopTunnelStub: sinon.SinonStub
    let uploadLogStub: sinon.SinonStub

    beforeEach(() => {
        getStateStub = sinon.stub(core, 'getState')
        getInputStub = sinon.stub(core, 'getInput')
        warningStub = sinon.stub(core, 'warning')
        sinon.stub(core, 'info')
        stopTunnelStub = sinon.stub(container, 'stopTunnel').resolves()
        uploadLogStub = sinon.stub(container, 'uploadLog').resolves()
    })

    afterEach(() => {
        sinon.restore()
    })

    it('warns and returns when no container ID is saved', async () => {
        getStateStub.withArgs('containerId').returns('')

        await run()

        assert.ok(
            warningStub.calledWith('No active TestingBot Tunnel available.')
        )
        assert.ok(stopTunnelStub.notCalled)
        assert.ok(uploadLogStub.notCalled)
    })

    it('stops the tunnel and uploads log when uploadLogFile is true', async () => {
        getStateStub.withArgs('containerId').returns('abc123')
        getInputStub.withArgs('uploadLogFile').returns('true')

        await run()

        assert.ok(stopTunnelStub.calledOnceWith('abc123'))
        assert.ok(uploadLogStub.calledOnce)
    })

    it('stops the tunnel but does not upload log when uploadLogFile is not true', async () => {
        getStateStub.withArgs('containerId').returns('abc123')
        getInputStub.withArgs('uploadLogFile').returns('false')

        await run()

        assert.ok(stopTunnelStub.calledOnceWith('abc123'))
        assert.ok(uploadLogStub.notCalled)
    })

    it('does not upload log when uploadLogFile is empty', async () => {
        getStateStub.withArgs('containerId').returns('abc123')
        getInputStub.withArgs('uploadLogFile').returns('')

        await run()

        assert.ok(stopTunnelStub.calledOnce)
        assert.ok(uploadLogStub.notCalled)
    })
})
