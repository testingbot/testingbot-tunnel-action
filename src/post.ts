import {getState, warning, setFailed, getInput} from '@actions/core'
import {
    DEFAULT_LOG_ARTIFACT_NAME,
    parseBooleanInput,
    stopTunnel,
    uploadLog
} from './container'

export async function run(): Promise<void> {
    const containerId = getState('containerId')
    const workDir = getState('workDir')

    try {
        if (containerId) {
            await stopTunnel(containerId)
        } else {
            warning('No active TestingBot Tunnel available.')
        }
    } finally {
        // Upload even when the tunnel never started (no container ID) or
        // stopping it failed: that is when the log is most useful.
        const uploadInput = getInput('uploadLogFile')
        const shouldUpload =
            uploadInput.trim() === '' ||
            parseBooleanInput('uploadLogFile', uploadInput)
        if (workDir && shouldUpload) {
            await uploadLog(
                workDir,
                getInput('logArtifactName') || DEFAULT_LOG_ARTIFACT_NAME
            )
        }
    }
}

/* istanbul ignore next */
if (require.main === module) {
    // eslint-disable-next-line github/no-then
    run().catch(error =>
        setFailed(error instanceof Error ? error.message : String(error))
    )
}
