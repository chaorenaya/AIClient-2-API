@echo off
chcp 65001 >nul
echo ========================================
echo   AIClient-2-API Docker 部署脚本（国内版）
echo ========================================
echo.
echo 使用阿里云镜像加速，解决网络问题
echo.

:: 检查 Docker 是否安装
docker --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Docker，请先安装 Docker Desktop
    echo 下载地址: https://www.docker.com/products/docker-desktop
    pause
    exit /b 1
)

echo [✓] Docker 已安装
echo.

:: 检查 Docker 是否运行
docker ps >nul 2>&1
if %errorlevel% neq 0 (
    echo [错误] Docker Desktop 未运行
    echo.
    echo 请执行以下步骤：
    echo 1. 启动 Docker Desktop 应用程序
    echo 2. 等待 Docker 完全启动（托盘图标不再闪烁）
    echo 3. 重新运行此脚本
    echo.
    pause
    exit /b 1
)

echo [✓] Docker 正在运行
echo.

:: 进入项目目录
cd /d "%~dp0"

echo [步骤 1/4] 构建 Docker 镜像（使用阿里云镜像）...
docker build -f Dockerfile.cn -t aiclient2api .
if %errorlevel% neq 0 (
    echo [错误] Docker 镜像构建失败
    echo.
    echo 可能的原因：
    echo 1. 网络连接问题 - 请检查网络连接
    echo 2. Docker 配置问题 - 尝试重启 Docker Desktop
    echo.
    pause
    exit /b 1
)
echo [✓] 镜像构建成功
echo.

echo [步骤 2/4] 停止并删除旧容器（如果存在）...
docker stop aiclient2api >nul 2>&1
docker rm aiclient2api >nul 2>&1
echo [✓] 清理完成
echo.

echo [步骤 3/4] 启动容器...
docker-compose -f docker-compose.cn.yml up -d
if %errorlevel% neq 0 (
    echo [错误] 容器启动失败
    pause
    exit /b 1
)
echo [✓] 容器启动成功
echo.

echo [步骤 4/4] 检查容器状态...
timeout /t 3 >nul
docker ps -a | findstr aiclient2api
echo.

echo ========================================
echo   部署完成！
echo ========================================
echo.
echo 🌐 服务地址: http://localhost:3000
echo 📖 Web UI: http://localhost:3000
echo 🔑 默认密码: admin123
echo 🔑 API Key: 123456
echo.
echo 📝 查看日志: docker logs -f aiclient2api
echo 🛑 停止服务: docker-compose -f docker-compose.cn.yml down
echo 🔄 重启服务: docker-compose -f docker-compose.cn.yml restart
echo.
echo 💡 提示：首次使用建议访问 Web UI 进行配置
echo.
pause
