const assert = require('assert')
const { remote } = require('webdriverio')

let browser
;(async () => {
    browser = await remote({
        user: process.env.TB_KEY,
        key: process.env.TB_SECRET,
        capabilities: {
            browserName: 'chrome',
            platformName: 'Windows 10',
            browserVersion: 'latest',
            'tb:options': {
                'tunnel-identifier': 'github-action-tunnel',
                build: `Build #${process.env.GITHUB_RUN_NUMBER}`
            }
        }
    })

    await browser.url('http://localhost:8080')

    const body = await browser.$('body')
    assert.equal(await body.getText(), 'Hello from TestingBot!')

    await browser.deleteSession()
})().then(
    () => process.exit(0),
    async (e) => {
        console.error(e)
        if (browser) {
            await browser.deleteSession()
        }
        process.exit(1)
    }
)