const {strict: assert} = require('assert')
const {remote} = require('webdriverio')

async function main() {
    const browser = await remote({
        user: process.env.TB_KEY,
        key: process.env.TB_SECRET,
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
