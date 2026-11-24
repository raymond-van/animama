# Security

## Report a vulnerability

Report security problems privately, by either route:

- **GitHub:** use
  [private vulnerability reporting](https://github.com/raymond-van/animama/security/advisories/new)
  on this repository.
- **Email:** `security@animama.ai`.

Please do not open a public issue, pull request or discussion about a
vulnerability, and do not publish details until a fix is available.

A useful report says:

- what is affected: the desktop app's version, or the commit of a self-hosted
  server or source build, and the operating system;
- how to reproduce the problem, step by step;
- what someone could do with it, and what they would need first;
- whether you have told anyone else.

Leave out real API keys, passwords, conversations and other personal data;
use test values instead.

## What to expect

One person maintains Animama, so responses are best effort and no response
time is promised. The maintainer tells you what they could reproduce, keeps you
informed while a fix is prepared, and agrees with you when details are
published. Say whether and how you would like to be credited.

## Supported versions

Security fixes go into the current `main` branch and the next desktop release.
Only the latest published desktop release is supported: older releases receive
no backports, so update to the latest.

## Scope

In scope:

- the desktop app, including its updates and optional downloads;
- the self-hosted server and web app in this repository;
- the update and download host, `downloads.animama.ai`;
- this repository's build and release tooling.

Out of scope:

- vulnerabilities in the services Animama connects to, such as model, voice
  and search providers; report those to the provider;
- a self-hosted installation that its operator exposes beyond the computer
  without their own authentication and TLS, which is not a supported
  configuration (see [local deployment](../docs/architecture/deployment-topology.md)).

## Self-hosting on a shared computer

A self-hosted server listens only on its own computer, and its API has no
password or other credential: every request it admits acts as the
installation's owner. Any account on the same computer can therefore use it to
chat with your Animas, read your memories and spend your model keys. Run a
self-hosted server only on a computer that you alone use, or put your own
authentication in front of it. The desktop app is different: its local server
admits only the app's own windows.

## Ordinary bugs

For ordinary bugs, use the
[bug report form](https://github.com/raymond-van/animama/issues/new?template=bug.yml),
with private data removed.
