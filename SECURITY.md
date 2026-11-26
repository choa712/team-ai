# Security

TeamAI handles OAuth access and refresh tokens. Treat `~/.config/teamai` as sensitive.

- Credentials are stored separately from configuration with mode `0600`.
- An explicit `teamai codex-app bind` writes only the generated local relay bearer token (never OAuth tokens) to Codex's mode-`0600` config and records no copy of the rest of that file.
- Proxy listeners bind to loopback by default and require a random bearer token.
- Inbound authorization, cookies, API keys, and proxy authorization headers are never forwarded upstream.
- Request bodies are capped at 32 MiB and Codex proxy paths are allowlisted.
- Logs and state files must never contain OAuth tokens.

Do not expose the proxy ports to a network. Report vulnerabilities privately to the repository owner before opening a public issue.
