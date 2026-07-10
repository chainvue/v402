# docker/

Deployment artifacts land here in Etappe 1, Layer 5 (delivery plan step 18):

- `facilitator.Dockerfile` — multi-stage build, non-root user, minimal image
- `demo-server.Dockerfile`
- `entrypoint.sh`

plus `docker-compose.yml` (facilitator + demo-server + SQLite volume) and
`docker-compose.dev.yml` at the repo root.
