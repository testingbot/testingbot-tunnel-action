import {getState, warning, setFailed} from '@actions/core'
import {stopTunnel} from './container'

async function run(): Promise<void> {
    const containerId = getState('containerId')
    if (!containerId) {
        warning('No active TestingBot Tunnel available.')
        return
    }

    await stopTunnel(containerId)
}

// eslint-disable-next-line github/no-then
run().catch(error => setFailed(error.message))
