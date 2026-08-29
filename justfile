set windows-shell := ["powershell.exe", "-NoLogo", "-Command"]

check:
    pnpm check

test:
    pnpm test

lint:
    pnpm lint

typecheck:
    pnpm typecheck

build:
    pnpm build
