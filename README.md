# Cosmic Code Marketplace

Collection of Claude Code plugins for development workflows, with shared workflow skills for Codex.

## 📦 Available Plugins

### 🔍 Analysis
Code analysis commands and skills (4 commands + 4 skills):
- Commands: `/analysis:code-quality`, `/analysis:code-improvements`, `/analysis:performance`, `/analysis:security`
- Skills: code-quality, code-improvements, performance-optimization, security-hardening
- **Auto-generates improvement tickets** in `improvements/` directory

### 🎨 Design
Design commands and skills (2 commands + 3 skills):
- Commands: `/design:ux`, `/design:documentation`
- Skills: frontend-design, ui-ux-improvements, documentation-gaps
- **Auto-generates improvement tickets** for UX and documentation

### 📊 Research
Market research commands and skills (1 command + 1 skill):
- Command: `/research:competitors`
- Skill: competitor-analysis
- User feedback mining and market gap identification

### 🗄️ Supabase Toolkit
Complete Supabase development suite (6 skills):
- Database function best practices
- Migration file generation
- Edge Function templates
- RLS policy optimization
- Realtime implementation patterns
- PostgreSQL style guide

### 🛠️ Development
Development toolkit (1 command + 2 skills):
- Command: `/development:commit`
- Skills: commit, skill-creator

**Commit Skill:**
- Conventional Commits format: `<type>(<scope>): <description>`
- Analyzes staged changes and suggests appropriate commit type
- Suggests splitting unrelated changes into atomic commits
- Supports `--no-verify` to skip pre-commit hooks

**Skill Creator:**
- Create new Claude Code skills with proper structure
- Initialize skills with templates and examples
- Validate and package skills for distribution
- Bundled scripts: `init_skill.py`, `package_skill.py`, `quick_validate.py`

### Workflow

Plan review, review integration, implementation verification, and plan status for Claude Code and Codex.
See [Workflow setup and usage](plugins/workflow/README.md) for installation on each computer and updates.

## 🚀 Installation

### 1. Add Marketplace
```bash
/plugin marketplace add cosmic-code-gmbh/cosmic-code-marketplace
```

### 2. Install Plugins
```bash
# Install specific plugins
/plugin install analysis@cosmic-code-marketplace
/plugin install design@cosmic-code-marketplace
/plugin install research@cosmic-code-marketplace
/plugin install supabase-toolkit@cosmic-code-marketplace
/plugin install development@cosmic-code-marketplace
/plugin install workflow@cosmic-code-marketplace --scope user

# Or install all
/plugin install analysis@cosmic-code-marketplace design@cosmic-code-marketplace research@cosmic-code-marketplace supabase-toolkit@cosmic-code-marketplace development@cosmic-code-marketplace workflow@cosmic-code-marketplace
```

### 3. Verify Installation
```bash
/plugin list
```

## 📖 Usage

### Automatic Skill Invocation
Skills are triggered automatically based on context:
```
"Analyze code quality issues"          → code-quality skill
"How can I improve performance?"       → performance-optimization skill
"Create a Supabase migration"          → supabase-migrations skill
"Review accessibility compliance"      → ui-ux-improvements skill
"Help me create a new skill"           → skill-creator skill
"Commit these changes"                 → commit skill
```

### Slash Commands
```bash
# Git commits (Conventional Commits format)
/development:commit              # Analyze and commit staged changes
/development:commit --no-verify  # Skip pre-commit hooks

# Analysis commands (generate tickets)
/analysis:code-quality      # Code quality analysis
/analysis:performance       # Performance optimization
/analysis:security          # Security audit

# Design commands
/design:ux                  # UI/UX analysis
/design:documentation       # Documentation gaps

# Research commands
/research:competitors       # Competitive analysis
```

## 🎫 Ticket Workflow

Commands generate individual ticket files:

```
improvements/
├── code-quality/
│   ├── 001-split-large-user-service.md
│   ├── 002-reduce-complexity-auth.md
│   └── 003-remove-duplicate-validation.md
├── performance/
│   ├── 001-replace-moment-with-date-fns.md
│   ├── 002-add-react-memo-to-list.md
│   └── 003-optimize-database-query.md
└── security/
    ├── 001-fix-sql-injection.md
    └── 002-add-rate-limiting.md
```

Each ticket contains:
- Problem description
- Affected files
- Current code
- Proposed fix
- Implementation steps

Use tickets to:
1. Review and prioritize issues
2. Track implementation progress
3. Reference as implementation tasks: `"Implement improvements/security/001-fix-sql-injection.md"`

## 🔧 Multi-Machine Setup

### Clone to another machine
```bash
# Add marketplace once
/plugin marketplace add cosmic-code-gmbh/cosmic-code-marketplace

# Install desired plugins
/plugin install analysis@cosmic-code-marketplace
```

### Project-specific plugins
Add to `.claude/settings.json`:
```json
{
  "extraKnownMarketplaces": {
    "cosmic-code-marketplace": {
      "source": {
        "source": "github",
        "repo": "cosmic-code-gmbh/cosmic-code-marketplace"
      }
    }
  },
  "enabledPlugins": {
    "analysis@cosmic-code-marketplace": true,
    "design@cosmic-code-marketplace": true,
    "research@cosmic-code-marketplace": true,
    "supabase-toolkit@cosmic-code-marketplace": true,
    "development@cosmic-code-marketplace": true
  }
}
```

## 📝 License

MIT - See [LICENSE](LICENSE) for details.

## 🤝 Contributing

Contributions welcome! Open an issue or pull request.

## 🔗 Links

- [Claude Code Documentation](https://code.claude.com/docs)
- [Plugin Development Guide](https://code.claude.com/docs/en/plugins.md)
- [Marketplace Guide](https://code.claude.com/docs/en/plugin-marketplaces.md)
