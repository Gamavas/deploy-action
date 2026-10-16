# Deploy to Gamavas Edge

Deploys a built web game to [Gamavas Edge](https://gamavas.fun/edge). Pushes go live at
`your-game.gamavas.xyz`; pull requests get their own preview link.

1. On your project's page at [gamavas.fun/host](https://gamavas.fun/host), make a **deploy token**.
2. In your GitHub repository: **Settings → Secrets and variables → Actions → New repository
   secret**, name it `GAMAVAS_DEPLOY_TOKEN` and paste the token.
3. Add a step after your build:

```yaml
name: Deploy
on:
  push:
    branches: [main]
  pull_request:

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # Build your game here (skip if the built files are committed), e.g.
      # - run: npm ci && npm run build
      - uses: gamavas/deploy-action@v1
        with:
          token: ${{ secrets.GAMAVAS_DEPLOY_TOKEN }}
          dir: dist # the folder with index.html in it
```

| Input | Default | |
| --- | --- | --- |
| `token` | (required) | The project's deploy token. Keep it in a secret. |
| `dir` | `.` | The folder that contains `index.html`. |
| `production` | `auto` | `auto`: pushes go live, pull requests are previews. Or `true` / `false`. |

Outputs: `url` (where the game is now), `preview-url` (this deploy's own address), `live`.

## From a terminal or other CI

Node 20 or newer, no install:

```bash
GAMAVAS_DEPLOY_TOKEN=gvd_… node index.mjs --dir dist            # goes live
GAMAVAS_DEPLOY_TOKEN=gvd_… node index.mjs --dir dist --preview  # preview only
```

Only files Gamavas doesn't already have are uploaded, so redeploys are quick.
