import * as core from '@actions/core'
import * as actionsExec from '@actions/exec'
import {DefaultArtifactClient} from '@actions/artifact'

export type ArtifactClient = {
    uploadArtifact: (
        name: string,
        files: string[],
        rootDir: string
    ) => Promise<unknown>
}

/**
 * Single indirection for everything used from the GitHub Actions toolkit.
 *
 * The `@actions/*` packages are ESM-only, and ESM module namespaces are
 * read-only, so tests can't stub their exports directly. Routing calls
 * through this mutable object lets tests replace them with sinon.
 */
export const toolkit = {
    getInput: core.getInput,
    getState: core.getState,
    saveState: core.saveState,
    setOutput: core.setOutput,
    setFailed: core.setFailed,
    setSecret: core.setSecret,
    isDebug: core.isDebug,
    info: core.info,
    warning: core.warning,
    exec: actionsExec.exec,
    createArtifactClient: (): ArtifactClient => new DefaultArtifactClient()
}
