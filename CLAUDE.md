# Saturam CLI - Project Guide for Claude

## Project Overview

**saturam-cli** is an AI-powered code review CLI with multi-agent architecture that reviews pull requests and posts inline comments on GitHub, Bitbucket, and GitLab. It also syncs onboarding documentation from Atlassian and Google Drive.

- **Language**: TypeScript 5.9.3
- **Runtime**: Node.js 22+
- **Package Manager**: pnpm 9.14.2
- **Architecture**: Layered with dependency injection (TypeDI)
- **Testing**: Jest with ts-jest

## Quick Start

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Link for local testing
npm link

# Run tests
pnpm test

# Type check
pnpm check
```

## Comprehensive Documentation

**📚 Full Architecture & Development Guide**: [`.claude/docs/ARCHITECTURE.md`](./.claude/docs/ARCHITECTURE.md)

This comprehensive reference covers:
- Application architecture and directory structure
- Command structure and implementation patterns
- Service layer (LLM, Config, Review, Onboarding)
- Integration services (GitHub, Bitbucket, GitLab, Jira, Confluence, Google Drive)
- Testing strategy and patterns
- Build & development workflows
- Configuration management (3-tier hierarchy)

## Key Architecture Points

### Layered Structure
```
Entry Point → CLI → Commands → Services → Integrations
```

### Multi-Agent Review (4 Phases)
1. **Phase 0**: Gather context (PR metadata, diff, ticket)
2. **Phase 1**: 2 parallel reviewers (different temperatures)
3. **Phase 2**: Auditor validates findings
4. **Phase 3**: Second audit for large PRs (>500 lines or >10 files)

### Service Layer
- **LLM Service**: Multi-provider AI orchestration (Anthropic, OpenAI, Google, AWS, etc.)
- **Config Service**: 3-tier configuration (Session → Project → Personal)
- **Review Service**: Multi-agent orchestration with artifact management
- **Onboarding Service**: Document sync with parallel fetching & normalization

### Integration Layer
- **SCM Abstraction**: Unified interface for GitHub/Bitbucket/GitLab
- **Atlassian**: Confluence (HTML→Markdown), Jira (ADF→Markdown)
- **Google Drive**: Docs, Sheets, .docx files

## Configuration

### Hierarchy (highest to lowest priority)
1. Environment variables
2. CLI flags (`--model`, `--debug`)
3. Project `.sateng` file
4. Personal `~/.config/sateng/config.json`
5. Hardcoded defaults

### Key Config Files
- `~/.config/sateng/config.json` - Personal config (API keys, defaults)
- `.sateng` - Project-level config (repo-specific defaults)
- `.sateng/onboarding.json` - Onboarding sources configuration

## Development Notes

### TypeScript Strict Mode
All code uses TypeScript strict mode with no `any` types unless unavoidable.

### Dependency Injection
Services are registered via TypeDI in `src/containers/`. All commands and services receive dependencies via constructor injection.

### Testing
- Tests mirror `src/` structure in `tests/`
- Use Jest mocks for external dependencies
- Run with `pnpm test`

### Code Style
- Format with Prettier: `pnpm format`
- Type-check: `pnpm check`
- Keep commands thin - business logic in services

## Important Files

### Entry Points
- `src/entrypoints/main.ts` - Application entry
- `bin/cli.js` - CLI wrapper

### Commands
- `src/commands/review-command.ts` - PR review
- `src/commands/init-command.ts` - Setup wizard
- `src/commands/onboard-command.ts` - Doc sync
- `src/commands/add-skill-command.ts` - Skill installer

### Core Services
- `src/services/llm-service.ts` - AI model management
- `src/services/config-service.ts` - Configuration resolution
- `src/services/review/multi-agent-review.service.ts` - Review orchestration
- `src/services/onboarding/onboard.service.ts` - Document sync

### Integrations
- `src/integrations/scm/` - SCM abstraction layer
- `src/integrations/github/` - GitHub integration
- `src/integrations/bitbucket/` - Bitbucket integration
- `src/integrations/gitlab/` - GitLab integration
- `src/integrations/confluence/` - Confluence integration
- `src/integrations/jira/` - Jira integration
- `src/integrations/google-drive/` - Google Drive integration

## Common Development Tasks

### Adding a New Command
1. Create `src/commands/your-command.ts` implementing `TypedCommand`
2. Register in `src/containers/all-commands.ts`
3. Build and test: `pnpm build && pnpm test`

### Adding a New Integration
1. Create service in `src/integrations/your-service/`
2. Implement API client methods
3. Add to DI container in `src/containers/base.ts`
4. Add tests in `tests/integrations/your-service/`

### Adding a New AI Provider
1. Add model constants to `src/constants/llm-models.ts`
2. Implement provider creation in `src/services/llm-service.ts`
3. Update `ConfigService` for provider config
4. Update `PROVIDER_MODELS` mapping

## References

- **Full Documentation**: [`.claude/docs/ARCHITECTURE.md`](./.claude/docs/ARCHITECTURE.md)
- **README**: [`README.md`](./README.md) - User-facing documentation
- **Onboarding Guide**: [`ONBOARDING.md`](./ONBOARDING.md) - Onboarding feature details
- **Contributing**: [`CONTRIBUTING.md`](./CONTRIBUTING.md) - Contribution guidelines

---

**When working on this codebase, always refer to `.claude/docs/ARCHITECTURE.md` for comprehensive technical details.**
