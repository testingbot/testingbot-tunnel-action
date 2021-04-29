import {getState, warning, setFailed, getInput} from '@actions/core'
import {stopTunnel, uploadLog} from './container'

async function run(): Promise<void> {
    const containerId = getState('containerId')
    if (!containerId) {
        warning('No active TestingBot Tunnel available.')
        return
    }

    await stopTunnel(containerId)
    if (getInput('uploadLogFile') === 'true') {
        await uploadLog()
    }
}

// eslint-disable-next-line github/no-then
run().catch(error => setFailed(error.message))
