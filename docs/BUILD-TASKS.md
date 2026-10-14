# Build tasks: sources and the builder account

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
- reaches the network only through the egress proxy on 127.0.0.1:18799. The proxy allows GitHub and npm over HTTPS (not Anthropic: checks never call Claude). nftables refuses everything else for that uid, except the computer's own DNS resolver and the engine's port on your Mac.

The engine's own user hands one worktree to the builder and back with `/opt/claudebot/bin/claudebot-handover`. It refuses, and the task fails, if a check replaced the worktree's `.git` pointer or its `.claudebot` folder. The commit names the worktree's git folder itself, with hooks and signing off, so nothing a check left behind is followed. The `npm ci` output is kept in each check's saved output.

The narrow sudo rule for the engine's user, in `/etc/sudoers.d/claudebot` (check it with `visudo -cf` first):

```
<user> ALL=(claudebot-builder) NOPASSWD: ALL
<user> ALL=(root) NOPASSWD: /opt/claudebot/bin/claudebot-handover
```

The build turn itself (Claude and its shell) runs on the team's own sign-in as the computer's main user. What stops it from writing to your repository is that it holds no push credential: the bundle source has none, and a URL token that can push is refused.

Live check: `limactl shell claudebot-computer /opt/claudebot/bin/builder-live-check` (every line PASS: example.com refused directly and through the proxy, npm reachable through it, Anthropic refused, outside DNS servers and other host ports refused, the secret store and clones' `.git` unreadable by the builder).
