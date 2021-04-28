import {promises, watch} from 'fs'
import {join} from 'path'
import {tmpdir} from 'os'
import {getInput, info, debug, isDebug, warning} from '@actions/core'
import {exec} from '@actions/exec'
import optionsMappingJson from './options.json'

const TMP_DIR_CONTAINER = '/tmp'

type OptionMapping = {
    actionOption: string
    dockerOption: string
    required?: boolean
    flag?: boolean
}

async function buildOptions(): Promise<string[]> {
    const LOG_FILE = join(TMP_DIR_CONTAINER, 'tb-tunnel.log')
    const READY_FILE = join(TMP_DIR_CONTAINER, 'tb.ready')

    const params = [
        getInput('key', {required: true}),
        getInput('secret', {required: true})
    ].concat([`--logfile=${LOG_FILE}`, `--readyfile=${READY_FILE}`])

    const optionsMapping: OptionMapping[] = optionsMappingJson

    for (const optionMapping of optionsMapping) {
        const input = getInput(optionMapping.actionOption, {
            required: optionMapping.required
        })

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

async function readyPoller(dir: string): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            watcher.close()
            reject(
                new Error(
                    'Timeout Error: waited 60 seconds for tunnel to start.'
                )
            )
        }, 60 * 1000)

        const watcher = watch(dir, (eventType, fileName) => {
            if (fileName !== 'tb.ready') {
                return
            }
            clearTimeout(timeout)
            watcher.close()
            resolve(void 0)
        })
    })
}

async function execWithReturn(
    commandLine: string,
    args?: string[]
): Promise<string> {
    let output = ''
    await exec(commandLine, args, {
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

export async function startTunnel(): Promise<string> {
    const dir = await promises.mkdtemp(join(tmpdir(), `tb-tunnel-action`))

    const containerVersion = getInput('tbVersion')
    const containerName = `testingbot/tunnel:${containerVersion}`
    await exec('docker', ['pull', containerName])

    const containerId = (
        await execWithReturn(
            'docker',
            [
                'run',
                '--network=host',
                '--detach',
                '--rm',
                '-v',
                `${dir}:${TMP_DIR_CONTAINER}`,
                containerName
            ].concat(await buildOptions())
        )
    ).trim()

    let hasError = false
    try {
        await readyPoller(dir)
    } catch (err) {
        hasError = true
        await stopTunnel(containerId)
        throw err
    } finally {
        // cleanup
        if (hasError || isDebug()) {
            try {
                const log = await promises.readFile(
                    join(dir, 'tb-tunnel.log'),
                    {
                        encoding: 'utf-8'
                    }
                )

                ;(hasError ? warning : debug)(`TestingBot Tunnel log: ${log}`)
            } catch {
                //
            }
        }
    }

    info('TestingBot Tunnel is ready')
    return containerId
}
