import {getState, warning, setFailed} from '@actions/core'
import {stopTunnel, uploadLog} from './container'

async function run(): Promise<void> {
    const containerId = getState('containerId')
    if (!containerId) {
        warning('No active TestingBot Tunnel available.')
        return
    }

    await uploadLog()
    await stopTunnel(containerId)
    await uploadLog()
}

// eslint-disable-next-line github/no-then
run().catch(error => setFailed(error.message))
