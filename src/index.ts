import {
    createWorkDir,
    logFilePath,
    NonRetryableError,
    runDoctor,
    startTunnel
} from './container'
import {toolkit} from './toolkit'

export const retryDelays = [1, 1, 1, 2, 3, 4, 5, 10, 20, 40, 60].map(
    a => a * 1000
)

export async function run(): Promise<void> {
    const retryTimeout =
        (parseInt(toolkit.getInput('retryTimeout'), 10) || 10) * 1000 * 60
    const startTime = Date.now()

    const workDir = createWorkDir()
    // Saved up front so the post step can find the log even if startup fails.
    toolkit.saveState('workDir', workDir)

    try {
        await runDoctor()
    } catch (e) {
        toolkit.warning(
            `TestingBot Tunnel diagnostics failed: ${
                e instanceof Error ? e.message : String(e)
            }`
        )
    }

    for (let i = 0; ; i++) {
        try {
            const containerId = await startTunnel(workDir)
            toolkit.saveState('containerId', containerId)
            toolkit.setOutput('container-id', containerId)
            toolkit.setOutput(
                'tunnel-identifier',
                toolkit.getInput('tunnelIdentifier')
            )
            toolkit.setOutput('log-file', logFilePath(workDir))
            return
        } catch (e) {
            if (e instanceof NonRetryableError) {
                throw e
            }
            if (Date.now() - startTime >= retryTimeout) {
                break
            }
            const delay = retryDelays[Math.min(retryDelays.length - 1, i)]
            const message = e instanceof Error ? e.message : String(e)
            toolkit.warning(
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
        toolkit.setFailed(
            error instanceof Error ? error.message : String(error)
        )
    )
}
