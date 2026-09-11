# Deployment templates

The full application needs a Node.js process, SQLite storage, and the external
services configured in `.env`. The files in this directory are intentionally
generic examples; keep real domains, certificate paths, tokens, and host
accounts outside the repository.

## Container example

Copy `docker-compose.example.yml`, set the values in an environment file, and
mount a private `data/` directory. Put TLS termination and authentication in
front of the application before exposing it to the internet.

The GitHub Pages workflow publishes the static showcase only. It does not run
the Node/SQLite API.
