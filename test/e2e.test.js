const {strict: assert} = require('assert')
const {remote} = require('webdriverio')

async function main() {
    const browser = await remote({
        // Explicit hub: without it, WebdriverIO guesses the cloud provider
        // from the key's length and fails on anything but 32 characters.
        protocol: 'https',
        hostname: 'hub.testingbot.com',
        port: 443,
        path: '/wd/hub',
        user: (process.env.TB_KEY ?? '').trim(),
        key: (process.env.TB_SECRET ?? '').trim(),
        logLevel: 'warn',
        capabilities: {
            browserName: 'chrome',
            browserVersion: 'latest',
            platformName: 'Windows 10',
            'tb:options': {
                'tunnel-identifier': 'github-action-tunnel',
                build: `Build #${process.env.GITHUB_RUN_NUMBER ?? 'local'}`,
                name: 'testingbot-tunnel-action E2E'
            }
        }
    })

    try {
        await browser.url('http://localhost:8080')
        const body = await browser.$('body')
        assert.equal(await body.getText(), 'Hello from TestingBot!')
    } finally {
        await browser.deleteSession()
    }
}

main().then(
    () => process.exit(0),
    err => {
        console.error(err)
        process.exit(1)
    }
)
