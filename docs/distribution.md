# Distribution and releases

Agent Space is maintained in the `ShiidoTech/agent-space` fork. The fork has its own VS Code extension identity and must never be published as the upstream `paql4711.agent-space` extension.

## Distribution model

The ShiidoTech fork uses the extension identity:

```text
ShiidoTech.agent-space
```

The repository is:

```text
https://github.com/ShiidoTech/agent-space
```

The immediate distribution path is **VSIX-first**. Marketplace publishing is supported by the repository tooling, but is intentionally gated and should only be enabled after the `ShiidoTech` Visual Studio Marketplace publisher is owned/configured with a valid token.

This keeps development independent from the upstream publisher while retaining a clear path to normal Marketplace auto-updates later.

## Important: merging is not installing

Merging a pull request into `main` only updates the GitHub repository. It does not change an extension already installed in VS Code.

There are two update paths:

### VSIX installation

Build the package:

```bash
bun run package
```

Then install/update it with VS Code:

```bash
code --install-extension ./agent-space-<version>.vsix --force
```

VS Code disables automatic updates by default for extensions installed from a VSIX. A new GitHub merge therefore requires building/installing a newer VSIX when using this distribution path.

Because `ShiidoTech.agent-space` and `paql4711.agent-space` are distinct extension IDs but contribute the same Agent Space commands/settings, uninstall or disable the upstream extension before enabling the fork. Running both at once is unsupported.

### Marketplace installation

Once `ShiidoTech.agent-space` is published to the Visual Studio Marketplace, VS Code can discover and install published updates according to the user's extension auto-update settings.

Marketplace publishing is deliberately guarded:

```bash
AGENT_SPACE_ALLOW_MARKETPLACE_PUBLISH=1 bun run deploy
```

`deploy.sh` refuses to publish unless all of the following are true:

- `package.json` declares publisher `ShiidoTech`;
- repository metadata points to `ShiidoTech/agent-space`;
- `AGENT_SPACE_ALLOW_MARKETPLACE_PUBLISH=1` is explicitly set;
- `VSCE_KEY` is available in the shell environment or local `.env`.

A token with access to the upstream publisher is not enough to bypass these checks accidentally.

## Existing-user storage migration

Changing the publisher changes VS Code's global storage directory for the extension. On the first run under the ShiidoTech extension identity, Agent Space checks for the legacy `paql4711.agent-space` global-storage directory.

If the new storage directory is still empty, Agent Space copies the complete legacy storage tree into the new location. This preserves registered projects, preferences, features, agents and service metadata.

If the new identity has already written any storage, migration does nothing. Existing data is never overwritten.

## Preparing a release

From a clean `main`:

```bash
bun run release:patch
# or release:minor / release:major
```

The release script:

1. requires `main` outside CI;
2. runs Biome, typecheck and tests;
3. bumps the version;
4. updates the changelog;
5. builds a VSIX;
6. commits and tags the release.

It does **not** publish automatically. Push the release commit/tag, then either distribute the VSIX or intentionally run the guarded Marketplace publish command.

## Upstream relationship

Generic improvements may still be contributed back to `paql4711/agent-space`, but the ShiidoTech distribution has its own release identity and must not depend on upstream publishing credentials or release cadence.
