# Signing in instead of exporting keys

```
etnpilot login anthropic      # asks for the key once, checks it, keeps it
etnpilot login openai
etnpilot login github         # browser sign-in (device flow)
etnpilot login gitlab
etnpilot auth status          # who is connected, and from where
etnpilot logout <service>
```

The web page has the same under **Accounts**.

## What "login" means for each service

| Service | How | Why |
|---|---|---|
| GitHub | Browser sign-in (OAuth device flow), or a token | GitHub supports it for tools like this one |
| GitLab | Browser sign-in (device flow, GitLab 17.9+), or a token | The access token is renewed by itself; GitLab's last two hours |
| Anthropic | The API key, entered once | The API is sold by key; other tools cannot sign in for you |
| OpenAI | The API key, entered once | The same |

ETNPilot does not imitate the sign-in of another vendor's own tool to reach
the Anthropic or OpenAI API with a subscription. It would break without
warning and is not what those services allow.

## One-time setup for the browser sign-in

The device flow needs the id of an OAuth application, because the sign-in page
names the application that asks. It is not a secret and is typed once; ETNPilot
remembers it.

- **GitHub:** github.com/settings/developers → New OAuth App, tick **Enable
  Device Flow**. Then `etnpilot login github --client-id <id>`.
- **GitLab:** Preferences → Applications, scope `api`, not confidential. Then
  `etnpilot login gitlab --client-id <id> [--host https://gitlab.example.com]`.
  The host defaults to `git.baseUrl` of the project.

Without a client id, `login` says so and offers a pasted token instead
(`--key-stdin` reads one from a pipe).

`etnpilot init` on a terminal walks through all of this: default provider, its key or sign-in, and GitLab address,
project, user name and token, stored once.

Inside a git repository, signing in to GitLab also installs `etnpilot credential` as that repository's git credential
helper for the GitLab address, so a plain `git push` uses the stored user name and token without asking. The helper only
answers for the host the login was issued for, and only over https; it never writes anything (`store` and `erase` do
nothing). Remove it with `git config --local --unset-all credential.<address>.helper`.

A self-hosted GitLab is named once with `--host`; if the project has no `git.baseUrl` yet, the login sets it in your
own settings (not the committed file) and says so, because the project needs the same address to use the login.

## Where it lives

`~/.config/etnpilot/credentials.json` (or `$XDG_CONFIG_HOME/etnpilot/`, or
`$ETNPILOT_HOME/`), mode `0600`, outside every repository. A project never holds
it, so it cannot be committed and a worktree does not copy it.

A stored login answers the same question the environment would: the secret
`anthropic.apiKey`, `openai.apiKey`, `github.token`, `gitlab.apiToken`. **A
variable set in the environment wins**; the stored login fills in when there is
none. `etnpilot logout` removes the stored one and says if the environment
still provides one.

A key is checked with one harmless request (list models, read the user) before
it is kept. A key the service refuses is not stored. If the service could not be
reached the key is kept and marked *not verified*.

## Where a stored login is sent

A stored login is handed over only for a host it was issued for, and only over https:

| Login | Hosts |
| --- | --- |
| `anthropic` | `api.anthropic.com` |
| `openai` | `api.openai.com` |
| `github` | `github.com`, `api.github.com`, `models.github.ai` |
| `gitlab` | the host you signed in to |

A project's configuration names the address each provider talks to. If a repository points a provider
at another address (a hostile one, or a proxy you set up), the stored login is **not** sent; `doctor`,
`smoke` and the provider's own error say why. To use a proxy, add it once:
`etnpilot login openai --allow-host my-proxy.example.com`.

Variables in the environment are not bound to hosts (you set them, so they are a decision) — which is one more
reason `etnpilot trust` asks before acting on a project you did not make.

## What is stored, and what is not safe about it

The file is plain JSON with mode 0600, in `~/.config/etnpilot/` (or `$XDG_CONFIG_HOME/etnpilot/`,
`$ETNPILOT_HOME/`). By default the secrets are in that file; on a desktop machine they can be kept in the system's
own store instead (next section). Anyone who can read your home directory can read it, and
an approved shell command without a sandbox can too — a run's command that *names* the file is refused
before it is shown, but a determined command line could still reach it. `etnpilot auth status` warns when the
file's permissions are too wide. On a shared machine, prefer environment variables from a secret manager.

Plugins never receive stored logins. `GitHub Models` (`github-models` provider) uses the stored GitHub token;
it needs the `models` permission, which a fine-grained personal access token can have and a browser sign-in
cannot (GitHub rejects `models:read` as an OAuth-app scope).

## Keeping the secrets in the system's store

```bash
etnpilot auth vault            # where they are now, and what this machine offers
etnpilot auth vault system     # move every stored login's secret there
etnpilot auth vault file       # and back
```

| System | Store | How the secret is handed over |
| --- | --- | --- |
| macOS | login keychain, through `security` | as an argument of that command, so other processes of the same user can see it for the moment it runs; it is not written anywhere else |
| Linux with a desktop session | Secret Service (GNOME Keyring, KWallet), through `secret-tool` | on standard input |
| Windows | data protection (DPAPI) for the current user, through PowerShell | on standard input; the file holds ciphertext only this Windows account can open |
| Termux, Linux without a session | none | the file is used |

The file keeps what is not secret (who, which host, when it expires) and a reference where the secret was. The move is
all or nothing, and the old copies are removed only after the file says where the new ones are. A credentials file copied
to another machine cannot be read there, and says so. Signing out removes the secret from the store as well. No package
is added: the system's own command-line tool does the work. **Not yet tried on a real macOS, Linux or Windows machine**;
the tests use a stand-in store and a recording stand-in for the tools, so the first real `etnpilot auth vault system`
is also the test of the commands. If it fails, nothing has moved.
