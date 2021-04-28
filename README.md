[![PR Checks](https://github.com/testingbot/testingbot-tunnel-action/actions/workflows/main.yml/badge.svg)](https://github.com/testingbot/testingbot-tunnel-action/actions/workflows/main.yml)

# TestingBot Tunnel GitHub Action

<p align="center">
  <a href="https://testingbot.com"><img alt="TestingBot Logo" src="https://testingbot.com/assets/about.png"></a>
</p>

A GitHub action to launch the [TestingBot Tunnel](https://testingbot.com/support/other/tunnel).
This will download and start the TestingBot Tunnel (Docker Image), allowing you to run tests on the TestingBot browser/device grid.

## Example

```yaml
jobs:
    test:
        runs-on: ubuntu-latest
        name: Action Test
        steps:
            # ...
            - uses: testingbot/testingbot-tunnel-action@v1
              with:
                  key: ${{ secrets.TB_KEY }}
                  secret: ${{ secrets.TB_SECRET }}
                  tunnelIdentifier: github-action-tunnel
            # ...
```

## Inputs

### `key`:

**Required** Your TestingBot API Key

### `secret`:

**Required** Your TestingBot API Secret

### `auth`:

Performs Basic Authentication for specific hosts, only works with HTTP.

### `debug`:

Enables debug messages. Will output request/response headers.

### `dns`:

Use a custom DNS server. For example: 8.8.8.8

### `doctor`:

Perform sanity/health checks to detect possible misconfiguration or problems.

### `fastFailRegexps`:

Specify domains you don't want to proxy, comma separated.

### `pac`:

Proxy autoconfiguration. Should be a http(s) URL

### `sePort`:

The local port your Selenium test should connect to. Default port is 4445

### `localProxy`:

The port to launch the local proxy on (default 8087).

### `proxy`:

Specify an upstream proxy: PROXYHOST:PROXYPORT

### `proxyCredentials`:

Username and password required to access the proxy configured with `proxy`.

### `noCache`:

Bypass TestingBot Caching Proxy running on the tunnel VM.

### `noProxy`:

Do not start a local proxy (requires user provided proxy server on port 8087)

### `tunnelIdentifier`:

Add an identifier to this tunnel connection.
In case of multiple tunnels, specify this identifier in your desired capabilities to use this specific tunnel.

## Feature requests and bug reports
Please file feature requests and bug reports as [github issues](https://github.com/testingbot/testingbot-tunnel-action/issues).