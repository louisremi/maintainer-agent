# Setting up maintainer-agent with an LLM

Everything maintainer-agent needs is in three files, so an LLM (or a person
following this page) can prepare a deployment. The only step left to a human
is installing the GitHub App, because GitHub requires a person to confirm it.

Give the assistant this page, [settings.md](settings.md) and
[settings.example.yml](settings.example.yml).

## 1. Collect

- **Public URL** that GitHub can reach over HTTPS (reverse proxy, Cloudflare
  Tunnel, Tailscale Funnel…), and whether `/admin` should be hidden there
  (`server.public_paths_only_via_host`).
- **Model endpoints**: OpenAI-compatible base URLs reachable from Docker
  containers, the served model ids, and API keys if any. Which one is the
  default; whether some repositories or jobs (answer, fix, review) should use
  another.
- **Repositories** (`host/owner/name`) and, per repository, anything that
  differs from the defaults: fixes on or off, `fix.trigger`, step limits,
  egress hosts needed by the build (package registries), checks to run,
  protected paths.
- **Accounts** that may use the server (`server.allowed_accounts`).
- **Host paths** for the config folder and the data folder.

## 2. Write

`docker-compose.yml` (adapt from [compose.example.yaml](../compose.example.yaml)):

```yaml
services:
  server:
    image: louisremi/maintainer-agent-server:v0.3.0
    restart: unless-stopped
    ports: ["3000:3000"]
    environment:
      DATA_DIR: /srv/maintainer-agent
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./config:/config
      - /srv/maintainer-agent:/srv/maintainer-agent   # same path on both sides
```

`config/settings.yml`: start from the example, keep `version: 1` and the
`$schema` line, list the repositories, and write secrets as placeholders
(`api_key: "{MA_LLM_API_KEY}"`, `admin_token: "{MA_ADMIN_TOKEN}"`). Leave
`connections` empty: the app registration fills it in.

`config/secrets.yaml` (mode 600), with real values:

```yaml
MA_ADMIN_TOKEN: <32 random characters>
MA_LLM_API_KEY: <the model key, if any>
```

and `MA_SECRETS_KEY` (16+ characters) in the container environment or as a
Docker secret.

## 3. Check

```bash
docker run --rm -v ./config:/config louisremi/maintainer-agent-server:v0.3.0 validate-config
```

Fix every reported problem (they come with line and column) until it prints
`valid`. Then `docker compose up -d`.

## 4. Hand over to the human

1. Open `/admin` (user: anything, password: `MA_ADMIN_TOKEN`), click **Create
   the app on GitHub**, confirm on GitHub. The server records the app in
   `settings.yml` and restarts.
2. Install the app on the repositories listed in `settings.yml`.
3. Optional: upload the app's logo, as the reminder on `/admin` explains.
