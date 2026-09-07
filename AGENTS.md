# Personal Feed contributor rules

Personal Feed is a standalone, channel-neutral service. Runtime and package code must not depend on Telegram, Cordis, DeepSeek Harness, `DSH_HOME`, host chat identifiers, host message identifiers, host session identifiers, or another host application's storage. Standard MCP connection identifiers may exist only inside the HTTP transport adapter for in-memory protocol routing; they are not business identities and must not enter application state or logs.

Keep the five MCP tool names and their closed result categories stable. Treat business-empty, needs-input, and incomplete as normal results; only authentication, invalid input, and storage faults are MCP errors. Never log user text, observed X text, full URLs, continuation tokens, MCP tokens, or model credentials.

Use the pinned `nix develop` environment. For behavior changes, add a failing test before implementation and run the smallest relevant test first. Installer tests must use temporary directories, fake processes, and loopback fixtures; never touch the real home directory, user systemd instance, browser account, model endpoint, or DSH installation.

Do not add a browser launcher, account manager, scheduler, npm publication, or remote deployment mechanism. The v1 deployment boundary is one user-level service bound to `127.0.0.1`.
