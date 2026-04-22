import {getInput, saveState, setFailed, setOutput, warning} from '@actions/core'
import {join} from 'path'
import {startTunnel, TMP_DIR_HOST} from './container'

export const retryDelays = [1, 1, 1, 2, 3, 4, 5, 10, 20, 40, 60].map(
    a => a * 1000
)

export async function run(): Promise<void> {
    const retryTimeout =
        (parseInt(getInput('retryTimeout'), 10) || 10) * 1000 * 60
    const startTime = Date.now()

    for (let i = 0; ; i++) {
        try {
            const containerId = await startTunnel()
            saveState('containerId', containerId)
            setOutput('container-id', containerId)
            setOutput('tunnel-identifier', getInput('tunnelIdentifier'))
            setOutput('log-file', join(TMP_DIR_HOST, 'tb-tunnel.log'))
            return
        } catch (e) {
            if (Date.now() - startTime >= retryTimeout) {
                break
            }
            const delay = retryDelays[Math.min(retryDelays.length - 1, i)]
            const message = e instanceof Error ? e.message : String(e)
            warning(
                `Error occurred on attempt ${
                    i + 1
                } (${message}). Retrying in ${delay} ms...`
            )
            await new Promise<void>(resolve => setTimeout(resolve, delay))
        }
    }
    throw new Error('Timed out waiting for Tunnel to start')
}

/* istanbul ignore next */
if (require.main === module) {
    // eslint-disable-next-line github/no-then
    run().catch(error =>
        setFailed(error instanceof Error ? error.message : String(error))
    )
}
