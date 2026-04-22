import {promises, existsSync, watch, mkdtempSync} from 'fs'
import {join} from 'path'
import {tmpdir} from 'os'
import {getInput, info, isDebug, setSecret, warning} from '@actions/core'
import {exec} from '@actions/exec'
import optionsMappingJson from './options.json'
import {DefaultArtifactClient} from '@actions/artifact'

const TMP_DIR_CONTAINER = '/tmp'
export const TMP_DIR_HOST = process.env['RUNNER_TEMP']
    ? join(process.env['RUNNER_TEMP'], '../')
    : mkdtempSync(join(tmpdir(), `tb-tunnel-action`))

type OptionMapping = {
    actionOption: string
    dockerOption: string
    required?: boolean
    flag?: boolean
}

export function buildOptions(): string[] {
    const LOG_FILE = join(TMP_DIR_CONTAINER, 'tb-tunnel.log')
    const READY_FILE = join(TMP_DIR_CONTAINER, 'tb.ready')

    // Credentials are passed to the tunnel via TESTINGBOT_KEY / TESTINGBOT_SECRET
    // environment variables (see startTunnel), not positional CLI args, so they
    // do not leak into `ps aux` or `docker inspect` command-lines.
    const params = [`--logfile=${LOG_FILE}`, `--readyfile=${READY_FILE}`]

    const optionsMapping: OptionMapping[] = optionsMappingJson

    for (const optionMapping of optionsMapping) {
        const input = getInput(optionMapping.actionOption, {
            required: optionMapping.required
        })
        if (input === '') {
            continue
        }
        if (optionMapping.flag) {
            params.push(`--${optionMapping.dockerOption}`)
        } else {
            params.push(`--${optionMapping.dockerOption}=${input}`)
        }
    }

    if (isDebug()) {
        params.push('--debug')
    }

    return params
}

export async function readyPoller(): Promise<void> {
    const readyFile = join(TMP_DIR_HOST, 'tb.ready')
    const timeoutSeconds = parseInt(getInput('readyTimeout'), 10) || 60
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            watcher.close()
            reject(
                new Error(
                    `Timeout Error: waited ${timeoutSeconds} seconds for tunnel to start.`
                )
            )
        }, timeoutSeconds * 1000)

        const watcher = watch(TMP_DIR_HOST, (eventType, fileName) => {
            if (fileName !== 'tb.ready') {
                return
            }
            clearTimeout(timeout)
            watcher.close()
            resolve()
        })

        // Check if file already exists (race: tunnel may start before watcher)
        if (existsSync(readyFile)) {
            clearTimeout(timeout)
            watcher.close()
            resolve()
        }
    })
}

async function execWithReturn(
    commandLine: string,
    args?: string[],
    extraOptions?: {env?: {[key: string]: string}}
): Promise<string> {
    let output = ''
    await exec(commandLine, args, {
        ...extraOptions,
        listeners: {
            stdout: (data: Buffer) => {
                output += data.toString()
            }
        }
    })
    return output
}

export async function stopTunnel(containerId: string): Promise<void> {
    info(`Stopping TestingBot Tunnel ${containerId}...`)
    const running =
        (
            await execWithReturn('docker', [
                'ps',
                '-q',
                '-f',
                `id=${containerId}`
            ])
        ).trim() !== ''

    if (running) {
        await exec('docker', ['container', 'stop', containerId])
    } else {
        info('TestingBot Tunnel does not appear to be running.')
    }
    info('Finished stopping TestingBot Tunnel')
}

// Exposed as an object so tests can replace the factory without needing to
// import `@actions/artifact` themselves (which runs into ESM/CJS resolution
// issues on some Node versions).
export const artifactDeps = {
    createClient: (): {
        uploadArtifact: (
            name: string,
            files: string[],
            rootDir: string
        ) => Promise<unknown>
    } => new DefaultArtifactClient()
}

export async function uploadLog(): Promise<void> {
    info('Uploading artifacts')
    const artifactClient = artifactDeps.createClient()
    const artifactName = 'testingbot-tunnel.log'

    try {
        await artifactClient.uploadArtifact(
            artifactName,
            [join(TMP_DIR_HOST, 'tb-tunnel.log')],
            TMP_DIR_HOST
        )
    } catch (err) {
        warning(err instanceof Error ? err : String(err))
    }
}

export async function startTunnel(): Promise<string> {
    const containerVersion = getInput('tbVersion')
    const containerName = `testingbot/tunnel:${containerVersion}`
    await exec('docker', ['pull', containerName])

    // Mask credentials and forward them to the container via env vars.
    // The tunnel binary reads TESTINGBOT_KEY / TESTINGBOT_SECRET when no
    // positional credentials are supplied, keeping secrets out of `ps aux`,
    // `docker inspect`, and workflow logs.
    const key = getInput('key', {required: true})
    const secret = getInput('secret', {required: true})
    setSecret(key)
    setSecret(secret)

    const baseEnv: {[key: string]: string} = {}
    for (const [envKey, envValue] of Object.entries(process.env)) {
        if (envValue !== undefined) {
            baseEnv[envKey] = envValue
        }
    }

    const containerId = (
        await execWithReturn(
            'docker',
            [
                'run',
                '--network=host',
                '--detach',
                '--rm',
                '-e',
                'TESTINGBOT_KEY',
                '-e',
                'TESTINGBOT_SECRET',
                '-v',
                `${TMP_DIR_HOST}:${TMP_DIR_CONTAINER}`,
                containerName
            ].concat(buildOptions()),
            {
                env: {
                    ...baseEnv,
                    TESTINGBOT_KEY: key,
                    TESTINGBOT_SECRET: secret
                }
            }
        )
    ).trim()

    let hasError = false
    try {
        await readyPoller()
    } catch (err) {
        hasError = true
        await stopTunnel(containerId)
        throw err
    } finally {
        // cleanup
        try {
            const log = await promises.readFile(
                join(TMP_DIR_HOST, 'tb-tunnel.log'),
                {
                    encoding: 'utf-8'
                }
            )

            ;(hasError ? warning : info)(`TestingBot Tunnel log: ${log}`)
        } catch (errLog) {
            warning(errLog instanceof Error ? errLog : String(errLog))
        }
    }

    info('TestingBot Tunnel is ready')
    return containerId
}
