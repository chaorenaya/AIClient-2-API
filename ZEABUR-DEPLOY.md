# Zeabur 部署指南

## 快速部署步骤

### 1. 准备工作

确保你有：
- Zeabur 账号
- GitHub 账号（用于连接仓库）

### 2. 部署到 Zeabur

#### 方式一：通过 GitHub 部署

1. 将代码推送到 GitHub 仓库
2. 登录 [Zeabur](https://zeabur.com)
3. 创建新项目，选择 "Deploy from GitHub"
4. 选择你的仓库
5. Zeabur 会自动检测 `Dockerfile.zeabur` 并构建

#### 方式二：通过 Zeabur CLI 部署

```bash
# 安装 Zeabur CLI
npm install -g @zeabur/cli

# 登录
zeabur login

# 部署
zeabur deploy
```

### 3. 配置环境变量

在 Zeabur 控制台中设置以下环境变量：

| 变量名 | 说明 | 示例值 |
|--------|------|--------|
| `REQUIRED_API_KEY` | API 访问密钥 | `your-secret-key` |
| `MODEL_PROVIDER` | 默认模型提供商 | `gemini-cli-oauth` |
| `GEMINI_OAUTH_CREDS_BASE64` | Gemini OAuth 凭据 (Base64) | `eyJ...` |
| `KIRO_OAUTH_CREDS_BASE64` | Kiro OAuth 凭据 (Base64) | `eyJ...` |
| `PROJECT_ID` | Google Cloud 项目 ID | `123456789` |

### 4. 获取 Base64 凭据

将你的 OAuth 凭据文件转换为 Base64：

**Windows PowerShell:**
```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("oauth_creds.json"))
```

**Linux/Mac:**
```bash
base64 -w 0 oauth_creds.json
```

### 5. 访问服务

部署完成后，Zeabur 会提供一个域名，例如：
```
https://your-app.zeabur.app
```

API 端点：
- 健康检查: `GET /health`
- OpenAI 兼容: `POST /v1/chat/completions`
- Claude 兼容: `POST /v1/messages`
- Gemini 兼容: `POST /v1beta/models/{model}:generateContent`

### 6. 端口说明

服务运行在 **8000** 端口，Zeabur 会自动处理 HTTPS 和域名映射。

## 注意事项

1. **凭据安全**: 使用 Base64 编码的凭据，不要直接暴露明文
2. **环境变量**: 敏感信息通过环境变量配置，不要提交到代码仓库
3. **日志**: Zeabur 提供日志查看功能，可在控制台查看运行日志

## 故障排除

### 服务无法启动
- 检查环境变量是否正确配置
- 查看 Zeabur 日志排查错误

### OAuth 认证失败
- 确保 Base64 凭据格式正确
- 检查凭据是否过期

### 模型调用失败
- 确认 Google Cloud 项目已启用相关 API
- 检查 PROJECT_ID 是否正确
