# AIClient-2-API Configuration Guide

## Current Issue

Error 400: Kiro OAuth credentials file not found or invalid.

## Quick Fix Solutions

### Solution 1: Use Gemini (Free & Recommended)

Edit `config.json`:

```json
{
  "REQUIRED_API_KEY": "123456",
  "SERVER_PORT": 3000,
  "HOST": "0.0.0.0",
  "MODEL_PROVIDER": "gemini-cli-oauth",
  "PROJECT_ID": "your-google-cloud-project-id",
  "GEMINI_OAUTH_CREDS_FILE_PATH": null,
  "KIRO_OAUTH_CREDS_FILE_PATH": null,
  "PROVIDER_POOLS_FILE_PATH": null
}
```

Then restart:
```cmd
docker-compose -f docker-compose.cn.yml restart
```

### Solution 2: Use OpenAI

Edit `config.json`:

```json
{
  "REQUIRED_API_KEY": "123456",
  "SERVER_PORT": 3000,
  "HOST": "0.0.0.0",
  "MODEL_PROVIDER": "openai-custom",
  "OPENAI_API_KEY": "sk-your-api-key",
  "OPENAI_BASE_URL": "https://api.openai.com/v1",
  "KIRO_OAUTH_CREDS_FILE_PATH": null,
  "PROVIDER_POOLS_FILE_PATH": null
}
```

Then restart:
```cmd
docker-compose -f docker-compose.cn.yml restart
```

### Solution 3: Fix Kiro Configuration

1. Copy Kiro credentials:
```cmd
mkdir configs\kiro
copy "%USERPROFILE%\.aws\sso\cache\kiro-auth-token.json" configs\kiro\
```

2. Edit `docker-compose.cn.yml`, add volume:
```yaml
volumes:
  - ./configs/kiro:/app/configs/kiro
```

3. Edit `config.json`:
```json
{
  "MODEL_PROVIDER": "claude-kiro-oauth",
  "KIRO_OAUTH_CREDS_FILE_PATH": "/app/configs/kiro/kiro-auth-token.json",
  "PROVIDER_POOLS_FILE_PATH": null
}
```

4. Restart:
```cmd
docker-compose -f docker-compose.cn.yml down
docker-compose -f docker-compose.cn.yml up -d
```

## Recommended: Use Gemini (Free)

Easiest and free option - just need Google Cloud project ID!

---

## Kiro Request Size Optimization

If you encounter "stream has been aborted" errors with Kiro, it's usually due to request size exceeding limits. Add these settings to `config.json`:

```json
{
  "KIRO_MAX_TOOLS": 12,
  "KIRO_MAX_HISTORY": 15,
  "KIRO_MAX_REQUEST_SIZE": 100000,
  "KIRO_MAX_MESSAGE_LENGTH": 8000,
  "KIRO_DISABLE_TOOLS": false
}
```

### Configuration Options

| Option | Default | Description |
|--------|---------|-------------|
| `KIRO_MAX_TOOLS` | 12 | Maximum number of tools to include |
| `KIRO_MAX_HISTORY` | 15 | Maximum conversation history messages |
| `KIRO_MAX_REQUEST_SIZE` | 100000 | Max request body size in bytes (100KB) |
| `KIRO_MAX_MESSAGE_LENGTH` | 8000 | Max characters per message |
| `KIRO_DISABLE_TOOLS` | false | Set to true to disable all tools |

### For Claude Code Compatibility

If using with Claude Code and experiencing issues, try more aggressive settings:

```json
{
  "KIRO_MAX_TOOLS": 10,
  "KIRO_MAX_HISTORY": 10,
  "KIRO_MAX_REQUEST_SIZE": 80000,
  "KIRO_MAX_MESSAGE_LENGTH": 5000
}
```
