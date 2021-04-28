# TestingBot Tunnel GitHub Action

A GitHub action to launch the [TestingBot Tunnel](https://testingbot.com/support/other/tunnel).

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