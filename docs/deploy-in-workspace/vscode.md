# VS Code in Kintsugi workspaces

Kintsugi includes browser-based **VS Code** in each Workspace. Open **VS Code** from the Work-view launcher to display it in a **VS Code view**. The default workspace image already contains the VS Code server and Kintsugi's default VS Code extensions.

## Add extensions permanently for a repository

To make a repository always start with additional VS Code extensions, add `.kintsugi/Dockerfile` to that repository. The file must start with Kintsugi's workspace base image:

```Dockerfile
FROM kintsugi-workspace
```

Install extensions during the image build with the bundled VS Code server CLI and Kintsugi's shared extensions directory:

```Dockerfile
FROM kintsugi-workspace
# Kintsugi image version: 1

RUN su agent -c '/opt/kintsugi/vscode-server/bin/code-server \
  --server-data-dir /.kintsugi/vscode/server-data \
  --extensions-dir /opt/kintsugi/vscode-extensions \
  --install-extension rust-lang.rust-analyzer \
  --force'
```

You can install multiple extensions in one Dockerfile:

```Dockerfile
FROM kintsugi-workspace
# Kintsugi image version: 1

RUN su agent -c '/opt/kintsugi/vscode-server/bin/code-server \
  --server-data-dir /.kintsugi/vscode/server-data \
  --extensions-dir /opt/kintsugi/vscode-extensions \
  --install-extension rust-lang.rust-analyzer \
  --force' \
 && su agent -c '/opt/kintsugi/vscode-server/bin/code-server \
  --server-data-dir /.kintsugi/vscode/server-data \
  --extensions-dir /opt/kintsugi/vscode-extensions \
  --install-extension dbaeumer.vscode-eslint \
  --force'
```

Kintsugi starts VS Code with `/opt/kintsugi/vscode-extensions`, so extensions installed there are available every time a workspace is created from that repository.

## Notes

- Repository Dockerfiles are built once per default workspace image plus `.kintsugi/Dockerfile` contents and then reused; regular source changes do not rebuild them.
- Installing extensions in `.kintsugi/Dockerfile` makes first workspace creation for that repository slower, but later workspaces reuse the built image.
- The default Kintsugi extensions are already in `/opt/kintsugi/vscode-extensions`; do not replace that directory unless you intentionally want to remove them.
