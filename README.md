Dependencies:
- cargo
- pnpm

To run the agent:
```
pnpm install
pnpm --filter pixel-react... build
cd agent/app && pnpm dev
```

To verify the agent-control contract:
```
pnpm agent:e2e
pnpm agent:check
```
