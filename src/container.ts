import {
    promises,
    existsSync,
    mkdtempSync,
    chmodSync,
    rmSync,
    statSync
} from 'fs'
import {join, resolve as resolvePath} from 'path'
import {tmpdir} from 'os'
import {randomBytes} from 'crypto'
import optionsMappingJson from './options.json'
import {toolkit} from './toolkit'

const TMP_DIR_CONTAINER = '/tmp'
export const LOG_FILE_NAME = 'tb-tunnel.log'
export const READY_FILE_NAME = 'tb.ready'

/**
 * Thrown for failures that retrying cannot fix (invalid options, rejected
 * credentials). The main step stops retrying when it sees one.
 */
export class NonRetryableError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'NonRetryableError'
    }
}

/**
 * Creates a fresh directory for this run's log and ready files. It is
 * mounted into the container, so it is made writable for the image's
 * non-root user (uid 1001), which need not match the runner's uid on
 * self-hosted runners.
 */
export function createWorkDir(): string {
    const base = process.env['RUNNER_TEMP'] || tmpdir()
    const dir = mkdtempSync(join(base, 'tb-tunnel-'))
    chmodSync(dir, 0o777)
    return dir
}

export function logFilePath(workDir: string): string {
    return join(workDir, LOG_FILE_NAME)
}

type OptionMapping = {
    actionOption: string
    // CLI flag name passed to the tunnel binary (without leading dashes).
    dockerOption?: string
    // Environment variable used instead of a CLI flag. Used for values that
    // carry credentials, so they stay out of `ps aux` / `docker inspect`.
    env?: string
    required?: boolean
    flag?: boolean
    // Multi-line input: every non-empty line becomes its own flag.
    multiple?: boolean
    // Value is a path on the runner; it is mounted read-only into the
    // container at the same absolute path. http(s) URLs are passed as-is.
    path?: boolean
}

const optionsMapping: OptionMapping[] = optionsMappingJson

export const DEFAULT_BIND_ADDRESS = '127.0.0.1'

/**
 * Parses a boolean action input. Empty means "not set" (false). Accepts the
 * same values as `core.getBooleanInput` (YAML 1.2 core schema booleans).
 */
export function parseBooleanInput(name: string, value: string): boolean {
    const trimmed = value.trim()
    if (trimmed === '') {
        return false
    }
    if (['true', 'True', 'TRUE'].includes(trimmed)) {
        return true
    }
    if (['false', 'False', 'FALSE'].includes(trimmed)) {
        return false
    }
    throw new TypeError(
        `Input "${name}" must be a boolean (true or false), got "${value}"`
    )
}

function inputLines(value: string): string[] {
    return value
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line !== '')
}

function isUrl(value: string): boolean {
    return /^https?:\/\//i.test(value)
}

/**
 * Resolves a path input against the workspace, so relative paths work the
 * same way they do for other actions.
 */
export function resolveHostPath(value: string): string {
    return resolvePath(process.env['GITHUB_WORKSPACE'] || process.cwd(), value)
}

function optionValues(optionMapping: OptionMapping): string[] {
    const input = toolkit.getInput(optionMapping.actionOption, {
        required: optionMapping.required
    })
    const values = optionMapping.multiple
        ? inputLines(input)
        : input === ''
          ? []
          : [input]
    return optionMapping.path
        ? values.map(v => (isUrl(v) ? v : resolveHostPath(v)))
        : values
}

/**
 * Builds the tunnel's command-line options from the action inputs.
 * `withFiles` adds the log and ready file options used for a normal run.
 */
export function buildOptions(withFiles = true): string[] {
    const LOG_FILE = join(TMP_DIR_CONTAINER, LOG_FILE_NAME)
    const READY_FILE = join(TMP_DIR_CONTAINER, READY_FILE_NAME)

    // Credentials are passed to the tunnel via TESTINGBOT_KEY / TESTINGBOT_SECRET
    // environment variables (see startTunnel), not positional CLI args, so they
    // do not leak into `ps aux` or `docker inspect` command-lines.
    const params = withFiles
        ? [`--logfile=${LOG_FILE}`, `--readyfile=${READY_FILE}`]
        : []

    for (const optionMapping of optionsMapping) {
        if (!optionMapping.dockerOption) {
            continue
        }
        if (optionMapping.flag) {
            const input = toolkit.getInput(optionMapping.actionOption, {
                required: optionMapping.required
            })
            if (parseBooleanInput(optionMapping.actionOption, input)) {
                params.push(`--${optionMapping.dockerOption}`)
            }
            continue
        }
        for (const value of optionValues(optionMapping)) {
            params.push(`--${optionMapping.dockerOption}=${value}`)
        }
    }

    if (toolkit.isDebug() && !params.includes('--debug')) {
        params.push('--debug')
    }

    // Escape hatch for tunnel options this action has no input for yet.
    params.push(...inputLines(toolkit.getInput('extraArgs')))

    return params
}

/**
 * Read-only bind mounts for inputs that point at files or directories on the
 * runner (web, pacLocal, cacertFile). They are mounted at the same absolute
 * path, so the option value works unchanged inside the container.
 */
export function buildMounts(): string[] {
    const mounts: string[] = []
    for (const optionMapping of optionsMapping) {
        if (!optionMapping.path) {
            continue
        }
        for (const value of optionValues(optionMapping)) {
            if (!isUrl(value)) {
                mounts.push('-v', `${value}:${value}:ro`)
            }
        }
    }
    return mounts
}

/**
 * Collects options that are forwarded to the tunnel as environment variables
 * (credential-bearing values). Every value is registered as a secret so it is
 * masked in the workflow log.
 */
export function buildSecretEnv(): {[key: string]: string} {
    const env: {[key: string]: string} = {}
    for (const optionMapping of optionsMapping) {
        if (!optionMapping.env) {
            continue
        }
        const input = toolkit.getInput(optionMapping.actionOption, {
            required: optionMapping.required
        })
        if (input === '') {
            continue
        }
        toolkit.setSecret(input)
        env[optionMapping.env] = input
    }
    return env
}

/**
 * Environment for `docker run`: credentials (forwarded by name, so their
 * values stay off the docker command-line) plus the listener bind address.
 *
 * The 5.x image sets TESTINGBOT_BIND_ADDRESS=0.0.0.0. Combined with
 * --network=host that would expose the unauthenticated Selenium relay (which
 * attaches the account credentials) and the local proxy to the runner's whole
 * network, so it is narrowed to loopback unless bindAddress says otherwise.
 * Passed as an env var rather than --bind-address so 4.x images, which do not
 * know the option, keep working.
 */
function containerEnv(): {args: string[]; env: {[key: string]: string}} {
    const key = toolkit.getInput('key', {required: true})
    const secret = toolkit.getInput('secret', {required: true})
    toolkit.setSecret(key)
    toolkit.setSecret(secret)

    const secretEnv: {[key: string]: string} = {
        TESTINGBOT_KEY: key,
        TESTINGBOT_SECRET: secret,
        ...buildSecretEnv()
    }
    const bindAddress =
        toolkit.getInput('bindAddress').trim() || DEFAULT_BIND_ADDRESS

    const baseEnv: {[key: string]: string} = {}
    for (const [envKey, envValue] of Object.entries(process.env)) {
        if (envValue !== undefined) {
            baseEnv[envKey] = envValue
        }
    }

    return {
        args: [
            ...Object.keys(secretEnv).flatMap(name => ['-e', name]),
            '-e',
            `TESTINGBOT_BIND_ADDRESS=${bindAddress}`
        ],
        env: {...baseEnv, ...secretEnv}
    }
}

function imageName(): string {
    return `testingbot/tunnel:${toolkit.getInput('tbVersion') || 'latest'}`
}

/**
 * Runs the tunnel's `--doctor` diagnostics in a one-off container when the
 * doctor input is set. `--doctor` checks the configuration and exits without
 * starting a tunnel, so it can't be combined with the real tunnel run.
 * Diagnostics never fail the step.
 */
export async function runDoctor(): Promise<void> {
    if (!parseBooleanInput('doctor', toolkit.getInput('doctor'))) {
        return
    }
    toolkit.info('Running TestingBot Tunnel diagnostics (--doctor)...')
    const {args, env} = containerEnv()
    const exitCode = await toolkit.exec(
        'docker',
        [
            'run',
            '--rm',
            '--network=host',
            ...args,
            ...buildMounts(),
            imageName(),
            '--doctor',
            ...buildOptions(false)
        ],
        {env, ignoreReturnCode: true}
    )
    if (exitCode !== 0) {
        toolkit.warning(
            `TestingBot Tunnel diagnostics exited with code ${exitCode}`
        )
    }
}

type ContainerState = {running: boolean; exitCode?: number}

async function execWithReturn(
    commandLine: string,
    args?: string[],
    extraOptions?: {
        env?: {[key: string]: string}
        silent?: boolean
        ignoreReturnCode?: boolean
        includeStderr?: boolean
    }
): Promise<{exitCode: number; output: string}> {
    let output = ''
    const {includeStderr, ...execOptions} = extraOptions ?? {}
    const exitCode = await toolkit.exec(commandLine, args, {
        ...execOptions,
        listeners: {
            stdout: (data: Buffer) => {
                output += data.toString()
            },
            stderr: (data: Buffer) => {
                if (includeStderr) {
                    output += data.toString()
                }
            }
        }
    })
    return {exitCode, output}
}

export async function getContainerState(
    containerId: string
): Promise<ContainerState> {
    const {exitCode, output} = await execWithReturn(
        'docker',
        [
            'inspect',
            '--format',
            '{{.State.Running}} {{.State.ExitCode}}',
            containerId
        ],
        {silent: true, ignoreReturnCode: true}
    )
    if (exitCode !== 0) {
        // Container no longer exists
        return {running: false}
    }
    const [running, code] = output.trim().split(' ')
    return {
        running: running === 'true',
        exitCode: code === undefined ? undefined : parseInt(code, 10)
    }
}

export const pollDeps = {
    intervalMs: 1000
}

/**
 * Waits until the tunnel writes its ready file. Fails early when the
 * container exits before becoming ready, instead of waiting for the full
 * timeout.
 */
export async function readyPoller(
    workDir: string,
    containerId: string
): Promise<void> {
    const readyFile = join(workDir, READY_FILE_NAME)
    const timeoutSeconds = parseInt(toolkit.getInput('readyTimeout'), 10) || 60
    const deadline = Date.now() + timeoutSeconds * 1000

    for (;;) {
        if (existsSync(readyFile)) {
            return
        }
        const state = await getContainerState(containerId)
        if (existsSync(readyFile)) {
            return
        }
        if (!state.running) {
            throw new ContainerExitedError(state.exitCode)
        }
        if (Date.now() >= deadline) {
            throw new Error(
                `Timeout Error: waited ${timeoutSeconds} seconds for tunnel to start.`
            )
        }
        await new Promise<void>(resolve =>
            setTimeout(resolve, pollDeps.intervalMs)
        )
    }
}

export class ContainerExitedError extends Error {
    constructor(readonly exitCode?: number) {
        super(
            `TestingBot Tunnel exited before becoming ready${
                exitCode === undefined ? '' : ` (exit code ${exitCode})`
            }.`
        )
        this.name = 'ContainerExitedError'
    }
}

export async function stopTunnel(containerId: string): Promise<void> {
    toolkit.info(`Stopping TestingBot Tunnel ${containerId}...`)
    const state = await getContainerState(containerId)

    if (state.running) {
        await toolkit.exec('docker', ['container', 'stop', containerId])
    } else {
        toolkit.info('TestingBot Tunnel does not appear to be running.')
    }
    // The container is not started with --rm (so its exit code and output
    // can be inspected after a failed start); remove it here.
    await toolkit.exec('docker', ['container', 'rm', '--force', containerId], {
        silent: true,
        ignoreReturnCode: true
    })
    toolkit.info('Finished stopping TestingBot Tunnel')
}

export const DEFAULT_LOG_ARTIFACT_NAME = 'testingbot-tunnel.log'

/**
 * Artifact names may not contain these characters.
 */
function sanitizeArtifactName(name: string): string {
    return name.replace(/["':<>|*?\\/\r\n]/g, '-')
}

function uniqueSuffix(): string {
    const job = process.env['GITHUB_JOB']
    const random = randomBytes(3).toString('hex')
    return job ? `${job}-${random}` : random
}

/**
 * Uploads the tunnel log as a workflow artifact. Artifact names must be
 * unique within a workflow run, so when the upload fails (for example
 * because another matrix job already uploaded an artifact with the same
 * name) it is retried once under a unique name.
 */
export async function uploadLog(
    workDir: string,
    artifactName = DEFAULT_LOG_ARTIFACT_NAME
): Promise<void> {
    const logFile = logFilePath(workDir)
    if (!existsSync(logFile)) {
        toolkit.info('No TestingBot Tunnel log file to upload.')
        return
    }
    const artifactClient = toolkit.createArtifactClient()
    const name = sanitizeArtifactName(artifactName)

    try {
        toolkit.info(`Uploading TestingBot Tunnel log as artifact "${name}"`)
        await artifactClient.uploadArtifact(name, [logFile], workDir)
        return
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        toolkit.info(`Uploading artifact "${name}" failed: ${message}`)
    }

    const fallbackName = `${name}-${uniqueSuffix()}`
    try {
        toolkit.info(`Retrying upload as artifact "${fallbackName}"`)
        await artifactClient.uploadArtifact(fallbackName, [logFile], workDir)
    } catch (err) {
        toolkit.warning(err instanceof Error ? err : String(err))
    }
}

/**
 * Patterns in the tunnel's output that mean retrying will not help.
 */
const NON_RETRYABLE_PATTERNS = [
    /HTTP error code : 401\b/,
    /401 Unauthorized/,
    /Missing required arguments API_KEY API_SECRET/
]

// Exit code 2 is the tunnel's "invalid command-line options" exit code.
const EXIT_CODE_INVALID_OPTIONS = 2

export async function startTunnel(workDir: string): Promise<string> {
    const containerName = imageName()
    await toolkit.exec('docker', ['pull', containerName])

    // Credentials are masked and forwarded to the container via env vars.
    // The tunnel binary reads TESTINGBOT_KEY / TESTINGBOT_SECRET when no
    // positional credentials are supplied, keeping secrets out of `ps aux`,
    // `docker inspect`, and workflow logs.
    const {args: envArgs, env} = containerEnv()

    // A ready file left over from a previous attempt (or a previous job on a
    // self-hosted runner) would make the tunnel look ready immediately.
    rmSync(join(workDir, READY_FILE_NAME), {force: true})
    // The log file is appended to across attempts; only print this attempt's part.
    const logOffset = existsSync(logFilePath(workDir))
        ? statSync(logFilePath(workDir)).size
        : 0

    const containerId = (
        await execWithReturn(
            'docker',
            [
                'run',
                '--network=host',
                '--detach',
                ...envArgs,
                '-v',
                `${workDir}:${TMP_DIR_CONTAINER}`,
                ...buildMounts(),
                containerName
            ].concat(buildOptions()),
            {env}
        )
    ).output.trim()

    let hasError = false
    try {
        await readyPoller(workDir, containerId)
    } catch (err) {
        hasError = true
        // The tunnel prints startup errors (invalid options, rejected
        // credentials) to the console, not to its log file.
        const {output: consoleOutput} = await execWithReturn(
            'docker',
            ['logs', containerId],
            {silent: true, ignoreReturnCode: true, includeStderr: true}
        )
        if (consoleOutput.trim() !== '') {
            toolkit.warning(`TestingBot Tunnel output:\n${consoleOutput}`)
        }
        await stopTunnel(containerId)

        if (
            err instanceof ContainerExitedError &&
            (err.exitCode === EXIT_CODE_INVALID_OPTIONS ||
                NON_RETRYABLE_PATTERNS.some(p => p.test(consoleOutput)))
        ) {
            throw new NonRetryableError(
                `${err.message} Not retrying: see the TestingBot Tunnel output above.`
            )
        }
        throw err
    } finally {
        try {
            const log = (await promises.readFile(logFilePath(workDir)))
                .subarray(logOffset)
                .toString('utf-8')

            ;(hasError ? toolkit.warning : toolkit.info)(
                `TestingBot Tunnel log: ${log}`
            )
        } catch (errLog) {
            if (hasError) {
                toolkit.warning(
                    errLog instanceof Error ? errLog : String(errLog)
                )
            }
        }
    }

    toolkit.info('TestingBot Tunnel is ready')
    return containerId
}
