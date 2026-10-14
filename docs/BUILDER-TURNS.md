# Build tasks: sources, the builder account and builder turns

## Which repository build tasks change

Build tasks have no default repository. Set one once, as the settings key `build_repo`:

- **Private repository (recommended):** `{"app": "myapp", "bundle_from": "/Users/you/code/myapp"}`.
  - The engine bundles `main` and the tags, never other local branches, from that folder on your Mac.
  - It verifies the bundle and writes it into the assistants' computer as `repos/myapp.bundle` (0600, replaced atomically).
  - The clone and every fetch come from that file. No credential or network access to GitHub is needed in the computer.
- **Public repository:** `{"app": "claudebot", "url": "https://github.com/perigeelabs2026/claudebot.git"}`.
  - A token is optional (`secrets/repo-token` in the computer).
  - A token that can push is refused at every prepare.
- `"install_scripts": true` lets `npm ci` run install scripts. Without it, checks install with `--ignore-scripts`.

The committed work comes back to your Mac in the task folder: `<task>.bundle` (`git fetch <file> <branch>`) and `<task>.patch`. Nothing is pushed.

## The builder account

The checks (installing dependencies, tests, typecheck) run as `claudebot-builder` inside the assistants' computer. That account:
- has no sudo;
- cannot read the secret store, a clone's `.git` or any other task's worktree;
- reaches the network only through the egress proxy on 127.0.0.1:18799. The proxy allows Anthropic, GitHub and npm over HTTPS; nftables refuses everything else for that uid, except DNS and the engine on the host.

The engine's own user hands one worktree to the builder and back with `/opt/claudebot/bin/claudebot-handover`.

The narrow sudo rule for the engine's user, in `/etc/sudoers.d/claudebot` (check it with `visudo -cf` first):

```
<user> ALL=(claudebot-builder) NOPASSWD: ALL
<user> ALL=(root) NOPASSWD: /opt/claudebot/bin/claudebot-handover
```

## Builder turns (off by default)

With builder turns, a build task's implement turn (the Claude process and its shell) also runs as `claudebot-builder`. It then cannot reach the team's secrets, other tasks or `main`.

The builder uses its own Claude sign-in, not the team's, so nothing it does can sign the team out.

**Risk:** the token is readable by everything the turn runs, including test files and dependencies on the branch. The egress allowlist is what keeps it from leaving the computer. Turn builder turns on only with the allowlist live (run the live check below).

To turn it on:
1. On your Mac, run `claude setup-token` and copy the token it prints.
2. Run `claudebot computer builder-token` and paste the token, then press Ctrl-D. The command reads the token from standard input only, never from the command line, and stores it as a 0400 file owned by the builder.
3. Run `limactl shell claudebot-computer /opt/claudebot/bin/builder-live-check` (as the computer's own user). Every line must say PASS:
   - an unlisted host (example.com) is refused, both directly and through the proxy;
   - npm and Anthropic are reachable through the proxy;
   - the secret store and the clones' `.git` are unreadable by the builder;
   - the token is in no log in the computer.
4. Set the settings key `builder_turns` to `true`.

**Rotation:** run `claude setup-token` again monthly, or at once on any suspicion. Install the new token with step 2. Revoke the old one at claude.ai (Settings, Claude Code). `claudebot computer builder-token --remove` deletes the token, and builder turns then fail with a plain reason until a new one is installed.

The token never appears in argv, the acpx configuration, an engine event, an artifact or a log. The wrapper (`claude-acp-as-builder`) reads it from its file and exports it only for the Claude process.
