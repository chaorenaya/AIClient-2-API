# AIClient-2-API Docker 部署指南

## 快速开始

### 方式一：使用部署脚本（推荐）

Windows 用户直接运行：
```cmd
deploy.bat
```

### 方式二：使用 Docker Compose

```bash
# 构建镜像
docker build -t aiclient2api .

# 启动服务
docker-compose up -d

# 查看日志
docker-compose logs -f

# 停止服务
docker-compose down
```

### 方式三：使用 Docker 命令

```bash
# 构建镜像
docker build -t aiclient2api .

# 运行容器
docker run -d \
  --name aiclient2api \
  --restart=always \
  -p 3000:3000 \
  -e ARGS="--api-key 123456 --host 0.0.0.0" \
  -v ./config.json:/app/config.json \
  -v ./logs:/app/logs \
  aiclient2api
```

## 访问服务

部署成功后，可以通过以下方式访问：

- **Web UI 管理界面**: http://localhost:3000
- **API 端点**: http://localhost:3000/v1/chat/completions
- **默认 API Key**: 123456

## 配置说明

### 基础配置

编辑 `config.json` 文件修改配置：

```json
{
    "REQUIRED_API_KEY": "123456",
    "SERVER_PORT": 3000,
    "HOST": "0.0.0.0",
    "MODEL_PROVIDER": "gemini-cli-oauth"
}
```

### OAuth 凭据配置

如果需要使用 OAuth 认证的服务（Gemini、Kiro、Qwen），需要：

1. **挂载凭据文件**：编辑 `docker-compose.yml`，取消相应的注释：

```yaml
volumes:
  # Kiro OAuth
  - ~/.aws/sso/cache:/root/.aws/sso/cache
  # Gemini OAuth
  - ~/.gemini/oauth_creds.json:/root/.gemini/oauth_creds.json
  # Qwen OAuth
  - ~/.qwen/oauth_creds.json:/root/.qwen/oauth_creds.json
```

2. **更新配置文件**：在 `config.json` 中指定凭据路径：

```json
{
    "MODEL_PROVIDER": "gemini-cli-oauth",
    "PROJECT_ID": "your-google-project-id",
    "GEMINI_OAUTH_CREDS_FILE_PATH": "/root/.gemini/oauth_creds.json"
}
```

### 使用不同的模型提供商

#### OpenAI 兼容接口

```json
{
    "MODEL_PROVIDER": "openai-custom",
    "OPENAI_API_KEY": "sk-xxx",
    "OPENAI_BASE_URL": "https://api.openai.com/v1"
}
```

#### Claude 官方 API

```json
{
    "MODEL_PROVIDER": "claude-custom",
    "CLAUDE_API_KEY": "sk-ant-xxx",
    "CLAUDE_BASE_URL": "https://api.anthropic.com"
}
```

#### Kiro Claude

```json
{
    "MODEL_PROVIDER": "claude-kiro-oauth",
    "KIRO_OAUTH_CREDS_FILE_PATH": "/root/.aws/sso/cache/kiro-auth-token.json"
}
```

## 常用命令

```bash
# 查看容器状态
docker ps

# 查看实时日志
docker logs -f aiclient2api

# 重启容器
docker restart aiclient2api

# 停止容器
docker stop aiclient2api

# 删除容器
docker rm aiclient2api

# 进入容器
docker exec -it aiclient2api sh

# 查看容器资源使用
docker stats aiclient2api
```

## 故障排查

### 容器无法启动

```bash
# 查看详细日志
docker logs aiclient2api

# 检查配置文件
docker exec -it aiclient2api cat /app/config.json
```

### 端口被占用

修改 `docker-compose.yml` 中的端口映射：
```yaml
ports:
  - "8080:3000"  # 将本地端口改为 8080
```

### OAuth 认证失败

1. 确认凭据文件路径正确
2. 检查文件权限
3. 查看容器内文件是否存在：
```bash
docker exec -it aiclient2api ls -la /root/.gemini/
```

## 更新部署

```bash
# 拉取最新代码
git pull

# 重新构建并启动
docker-compose up -d --build
```

## 安全建议

1. **修改默认 API Key**：在 `config.json` 中修改 `REQUIRED_API_KEY`
2. **使用环境变量**：敏感信息可通过环境变量传递
3. **限制访问**：生产环境建议配置反向代理和 HTTPS
4. **定期更新**：保持镜像和依赖包最新

## 性能优化

1. **日志管理**：定期清理 `./logs` 目录
2. **资源限制**：在 `docker-compose.yml` 中添加资源限制：

```yaml
deploy:
  resources:
    limits:
      cpus: '2'
      memory: 2G
```

## 支持与反馈

- 项目地址: https://github.com/chaorenaya/AIClient-2-API
- 问题反馈: https://github.com/chaorenaya/AIClient-2-API/issues
- 完整文档: https://aiproxy.justlikemaki.vip/zh/
