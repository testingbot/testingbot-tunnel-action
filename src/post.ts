import {
    DEFAULT_LOG_ARTIFACT_NAME,
    parseBooleanInput,
    stopTunnel,
    uploadLog
} from './container'
import {toolkit} from './toolkit'

/**
 * Whether to upload the tunnel log. An invalid value is reported as a
 * warning instead of thrown: the main step already fails on it, and a throw
 * here would hide an error from stopping the tunnel.
 */
function shouldUploadLog(): boolean {
    const value = toolkit.getInput('uploadLogFile')
    if (value.trim() === '') {
        return true
    }
    try {
        return parseBooleanInput('uploadLogFile', value)
    } catch (e) {
        toolkit.warning(
            `${e instanceof Error ? e.message : String(e)}. Not uploading the TestingBot Tunnel log.`
        )
        return false
    }
}

export async function run(): Promise<void> {
    const containerId = toolkit.getState('containerId')
    const workDir = toolkit.getState('workDir')
    const shouldUpload = shouldUploadLog()

    try {
        if (containerId) {
            await stopTunnel(containerId)
        } else {
            toolkit.warning('No active TestingBot Tunnel available.')
        }
    } finally {
        // Upload even when the tunnel never started (no container ID) or
        // stopping it failed: that is when the log is most useful.
        if (workDir && shouldUpload) {
            await uploadLog(
                workDir,
                toolkit.getInput('logArtifactName') || DEFAULT_LOG_ARTIFACT_NAME
            )
        }
    }
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
