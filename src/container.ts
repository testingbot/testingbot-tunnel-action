import {promises, watch} from 'fs'
import {join} from 'path'
import {tmpdir} from 'os'
import {getInput, info, debug, isDebug, warning} from '@actions/core'
import {exec} from '@actions/exec'

async function buildOptions(dir: string): Promise<string[]> {
    const LOG_FILE = join(dir, 'tb-tunnel.log')
    const READY_FILE = join(dir, 'tb.ready')

    const params = [
        getInput('TB_KEY', {required: true}),
        getInput('TB_SECRET', {required: true})
    ]

    params.concat([`--logfile=${LOG_FILE}`, `--readyfile=${READY_FILE}`])

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

        const watcher = watch(dir, (eventType, filename) => {
            if (filename !== 'tb.ready') {
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
            ['run', '--network=host', '--detach', '--rm', containerName].concat(
                await buildOptions(dir)
            )
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
