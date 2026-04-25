# StaticVerifier

StaticVerifier is a VS Code extension that compares frontend and backend API contract JSON files and reports mismatches as diagnostics.

## What It Does

- Loads contract files from local paths/globs and GitHub URLs.
- For FE sources, can auto-discover endpoints from code using fetch-style calls.
- Compares endpoints by `METHOD + path`.
- Reports:
- missing backend endpoints
- request schema mismatches
- response schema mismatches
- backend-only endpoints
- Publishes issues to the Problems panel.
- Re-runs verification on save for tracked local contract files.

## Frontend Auto-Discovery

When a frontend source is not valid contract JSON, StaticVerifier will try to extract endpoints from code.

Currently supported patterns include:

- `fetch('/api/...', { method: 'POST' })`
- `fetchJson('/api/...')`
- `axios.get('/api/...')`, `axios.post('/api/...')`
- similar client method calls like `api.get(...)`, `client.post(...)`, `http.get(...)`, `ky.get(...)`

Response model inference:

- `as SomeResponseType` near the API call
- fallback to function return type like `Promise<LanguageSkill[]>`

## Commands

- `StaticVerifier: Open Interface`
- `StaticVerifier: Verify Contracts`
- `StaticVerifier: Configure Verification Mode`

## Contract Format

Each contract file must be JSON with an `endpoints` array:

```json
{
  "endpoints": [
    {
      "method": "GET",
      "path": "/users/{id}",
      "requestSchema": "UserRequest",
      "responseSchema": "UserResponse"
    }
  ]
}
```

`method` and `path` are required for each endpoint.

## Settings

The extension contributes these settings:

- `staticverifier.enable`
- `staticverifier.frontendContractSource`
- `staticverifier.frontendSources`
- `staticverifier.frontendContractPaths`
- `staticverifier.frontendContractGitHubUrls`
- `staticverifier.frontendContractPath` (legacy)
- `staticverifier.frontendContractGitHubUrl` (legacy)
- `staticverifier.backendContractSource`
- `staticverifier.backendSources`
- `staticverifier.backendContractPaths`
- `staticverifier.backendContractGitHubUrls`
- `staticverifier.backendContractPath` (legacy)
- `staticverifier.backendContractGitHubUrl` (legacy)

Default local globs:

- FE: `**/contracts/frontend.contract.json`
- BE: `**/contracts/backend.contract.json`

## Local Development

Install and run checks:

```bash
npm install
npm run lint
npm run check-types
npm run compile
```

Bundle for publish:

```bash
npm run package
```

Run tests:

```bash
npm test
```

## Notes

- GitHub `blob` file links are normalized to raw URLs automatically.
- GitHub contract sources support file URLs only (`github.com/.../blob/...` or `raw.githubusercontent.com/...`).
- GitHub source counting uses the GitHub API and may return `0` when the repo is private or rate-limited.
