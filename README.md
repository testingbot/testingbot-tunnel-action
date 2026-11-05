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
            - uses: testingbot/testingbot-tunnel-action@v2
              with:
                  key: ${{ secrets.TB_KEY }}
                  secret: ${{ secrets.TB_SECRET }}
                  tunnelIdentifier: github-action-tunnel
                  tbVersion: '5.1'
            # ...
```

## Inputs

All inputs except `key` and `secret` are optional. Inputs marked **5.0+** or **5.1+** need that version of the tunnel image (`tbVersion`). Older images reject them as unknown options, and the action then fails right away without retrying.

### Credentials

| Input | Description |
|---|---|
| `key` | **Required.** Your TestingBot API key. |
| `secret` | **Required.** Your TestingBot API secret. |

Credentials are passed to the container as environment variables, never as command-line arguments, and are masked in the log.

### Action behaviour

| Input | Default | Description |
|---|---|---|
| `tbVersion` | `latest` | Tag of the `testingbot/tunnel` Docker image. Pin a version (e.g. `5.1`) for reproducible builds. |
| `retryTimeout` | `10` | Minutes to keep retrying when the tunnel fails to start. Invalid options and rejected credentials are not retried. |
| `readyTimeout` | `60` | Seconds to wait for the tunnel to become ready after the container starts. The action fails sooner if the container exits. |
| `uploadLogFile` | `true` | Upload the tunnel log as an artifact in the post step. The log is also uploaded when the tunnel fails to start. |
| `logArtifactName` | `testingbot-tunnel.log` | Name of the log artifact. Artifact names must be unique per workflow run, so set a unique name in matrix jobs. If the name is taken, a unique suffix is added. |
| `doctor` | `false` | Run the tunnel's diagnostics (`--doctor`) in a separate container before starting the tunnel, and print the result. Never fails the step. |
| `extraArgs` | | Extra tunnel options, one per line (e.g. `--http-dial-timeout=10`), for options this action has no input for yet. |

### Tunnel

| Input | Description |
|---|---|
| `tunnelIdentifier` | Name for this tunnel. With several tunnels, set the same identifier in your capabilities (`tunnel-identifier`) to pick one. |
| `shared` | `true` shares the tunnel with your team. Tunnels are private by default. |
| `sePort` | Local port your Selenium tests connect to. Default `4445`. |
| `localProxy` | Port for the local proxy. Default `8087`. |
| `metricsPort` | Port for `/metrics`, `/healthz` and `/readyz`. Default `8003`. |
| `metricsAuth` | Basic auth (`user:password`) for `/metrics`. Masked, passed as an environment variable. 4.8+. |
| `bindAddress` | Interface the local listeners bind to. Default `127.0.0.1`, see [Network exposure](#network-exposure). |
| `hubPort` | Connect to port 80 on the TestingBot hub instead of 4444. |
| `web` | Directory to serve with the tunnel's built-in webserver. Relative paths are resolved against the workspace, and the directory is mounted read-only into the container. |
| `sshConnections` | Number of SSH connections to the tunnel server (1-8, default 4). **5.1+** |
| `sshHostKey` | SHA-256 fingerprint the tunnel server's SSH host key must have. **5.0+** |
| `sshHostKeyPolicy` | `require` refuses to connect when no host key fingerprint is known. **5.0+** |

### Restricting what the tunnel can reach

| Input | Description |
|---|---|
| `allowHosts` | Only these hosts, comma separated (`*.suffix` for subdomains). Everything else gets a 403. **5.0+** |
| `fastFailRegexps` | Refuse hosts matching these regular expressions, comma separated. Prefix with `!` for an exception (**5.0+**), e.g. `.*,!ok\.com`. |
| `localhostPolicy` | `deny` refuses traffic to the runner's loopback interface. **5.0+** |

### Upstream proxies and corporate networks

| Input | Description |
|---|---|
| `proxy` | Upstream proxy: `HOST:PORT`. |
| `proxyCredentials` | `user:password` for `proxy`. Masked, passed as an environment variable. 4.8+. |
| `proxyAuthScheme` | Proxy authentication scheme, e.g. `negotiate` for Kerberos/SPNEGO. **5.0+** |
| `proxyTestingbot` | Separate proxy for the tunnel's own connection to TestingBot. **5.0+** |
| `proxyTestingbotCredentials` | `user:password` for `proxyTestingbot`. Masked, passed as an environment variable. **5.0+** |
| `pacLocal` | PAC file (path or https URL) the tunnel uses to pick an upstream proxy per destination. **5.0+** |
| `pacLocalSha256` | SHA-256 the `pacLocal` document must have. Required for `http://` PAC URLs. **5.0+** |
| `pac` | PAC URL for the *remote browser* (unlike `pacLocal`, which is for the tunnel itself). |
| `cacertFile` | Extra CA certificate (PEM) to trust, e.g. for a TLS-intercepting proxy. Mounted read-only. **5.0+** |
| `dns` | Custom DNS server(s), e.g. `8.8.8.8`. |
| `noProxy` | `true`: don't start a local proxy (requires your own proxy on port 8087). |

### Traffic handling

| Input | Description |
|---|---|
| `auth` | Basic auth for specific hosts (HTTP only): `host:port:user:password`, comma separated. Masked, passed as `TESTINGBOT_AUTH`. 4.8+. |
| `extraHeaders` | JSON object of headers to add to requests, e.g. `'{"X-My-Header":"value"}'`. |
| `header` | Request header rules for plain HTTP, one per line (e.g. `X-Env: staging`, `-Cookie`). **5.0+** |
| `responseHeader` | Response header rules for plain HTTP, one per line (e.g. `-Content-Security-Policy`). **5.0+** |
| `noBump` | `true`: don't perform SSL bumping. |
| `nobumpDomains` | Skip SSL bumping only for these domains, comma separated. **5.0+** |
| `noCache` | `true`: bypass the caching proxy on the tunnel VM. |

### Logging

| Input | Description |
|---|---|
| `debug` | `true` enables debug logging. Also enabled automatically when the workflow runs with debug logging. |
| `logHttp` | Per-request logging: `none`, `url`, `headers` or `errors` (default), optionally per module, e.g. `proxy:url,forwarder:none`. **5.0+** |
| `logFormat` | `text` (default) or `json`. **5.0+** |

Boolean inputs (`debug`, `doctor`, `noBump`, `noCache`, `noProxy`, `shared`, `uploadLogFile`) accept `true` or `false`.

### Network exposure

The tunnel container runs with `--network=host`, so its listeners are on the runner itself. None of them authenticate, and the Selenium relay attaches your TestingBot credentials to everything it forwards. That's why the action binds them to `127.0.0.1` by default, even though the 5.x image itself defaults to `0.0.0.0`.

If your tests run in another container (for example a job `container:` or a service) and reach the tunnel through the host's address, set `bindAddress: 0.0.0.0`. Only do that on runners whose network you trust.

### Matrix builds

```yaml
strategy:
    matrix:
        browser: [chrome, firefox]
steps:
    - uses: testingbot/testingbot-tunnel-action@v2
      with:
          key: ${{ secrets.TB_KEY }}
          secret: ${{ secrets.TB_SECRET }}
          tunnelIdentifier: ${{ github.run_id }}-${{ matrix.browser }}
          logArtifactName: testingbot-tunnel-${{ matrix.browser }}
```

## Outputs

### `container-id`

Docker container ID of the running TestingBot Tunnel.

### `tunnel-identifier`

The tunnel identifier (echoed from the `tunnelIdentifier` input).

### `log-file`

Absolute path to the tunnel log file on the runner. Useful for piping into `actions/upload-artifact` in your own workflow:

```yaml
- uses: testingbot/testingbot-tunnel-action@v2
  id: tunnel
  with:
    key: ${{ secrets.TB_KEY }}
    secret: ${{ secrets.TB_SECRET }}

- if: always()
  uses: actions/upload-artifact@v7
  with:
    name: tunnel-log
    path: ${{ steps.tunnel.outputs.log-file }}
```

## Feature requests and bug reports
Please file feature requests and bug reports as [github issues](https://github.com/testingbot/testingbot-tunnel-action/issues).