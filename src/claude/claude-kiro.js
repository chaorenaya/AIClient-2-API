import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { getProviderModels } from '../provider-models.js';

const KIRO_CONSTANTS = {
    REFRESH_URL: 'https://prod.{{region}}.auth.desktop.kiro.dev/refreshToken',
    REFRESH_IDC_URL: 'https://oidc.{{region}}.amazonaws.com/token',
    BASE_URL: 'https://codewhisperer.{{region}}.amazonaws.com/generateAssistantResponse',
    AMAZON_Q_URL: 'https://codewhisperer.{{region}}.amazonaws.com/SendMessageStreaming',
    DEFAULT_MODEL_NAME: 'claude-opus-4-5',
    USER_AGENT: 'KiroIDE',
    CONTENT_TYPE_JSON: 'application/json',
    ACCEPT_JSON: 'application/json',
    AUTH_METHOD_SOCIAL: 'social',
    CHAT_TRIGGER_TYPE_MANUAL: 'MANUAL',
    ORIGIN_AI_EDITOR: 'AI_EDITOR',
};

// 从 provider-models.js 获取支持的模型列表
const KIRO_MODELS = getProviderModels('claude-kiro-oauth');

// 完整的模型映射表
const FULL_MODEL_MAPPING = {
    "claude-opus-4-5":"claude-opus-4.5",
    "claude-sonnet-4-5": "CLAUDE_SONNET_4_5_20250929_V1_0",
    "claude-sonnet-4-5-20250929": "CLAUDE_SONNET_4_5_20250929_V1_0",
    "claude-sonnet-4-20250514": "CLAUDE_SONNET_4_20250514_V1_0",
    "claude-3-7-sonnet-20250219": "CLAUDE_3_7_SONNET_20250219_V1_0",
    "amazonq-claude-sonnet-4-20250514": "CLAUDE_SONNET_4_20250514_V1_0",
    "amazonq-claude-3-7-sonnet-20250219": "CLAUDE_3_7_SONNET_20250219_V1_0"
};

// 只保留 KIRO_MODELS 中存在的模型映射
const MODEL_MAPPING = Object.fromEntries(
    Object.entries(FULL_MODEL_MAPPING).filter(([key]) => KIRO_MODELS.includes(key))
);

const KIRO_AUTH_TOKEN_FILE = "kiro-auth-token.json";

/**
 * Kiro API Service - Node.js implementation based on the Python ki2api
 * Provides OpenAI-compatible API for Claude Sonnet 4 via Kiro/CodeWhisperer
 */

async function getMacAddressSha256() {
    const networkInterfaces = os.networkInterfaces();
    let macAddress = '';

    for (const interfaceName in networkInterfaces) {
        const networkInterface = networkInterfaces[interfaceName];
        for (const iface of networkInterface) {
            if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
                macAddress = iface.mac;
                break;
            }
        }
        if (macAddress) break;
    }

    if (!macAddress) {
        console.warn("无法获取MAC地址，将使用默认值。");
        macAddress = '00:00:00:00:00:00'; // Fallback if no MAC address is found
    }

    const sha256Hash = crypto.createHash('sha256').update(macAddress).digest('hex');
    return sha256Hash;
}

// Helper functions for tool calls
function findMatchingBracket(text, startPos) {
    if (!text || startPos >= text.length || text[startPos] !== '[') {
        return -1;
    }

    let bracketCount = 1;
    let inString = false;
    let escapeNext = false;

    for (let i = startPos + 1; i < text.length; i++) {
        const char = text[i];

        if (escapeNext) {
            escapeNext = false;
            continue;
        }

        if (char === '\\' && inString) {
            escapeNext = true;
            continue;
        }

        if (char === '"' && !escapeNext) {
            inString = !inString;
            continue;
        }

        if (!inString) {
            if (char === '[') {
                bracketCount++;
            } else if (char === ']') {
                bracketCount--;
                if (bracketCount === 0) {
                    return i;
                }
            }
        }
    }
    return -1;
}

function parseSingleToolCall(toolCallText) {
    const namePattern = /\[Called\s+(\w+)\s+with\s+args:/i;
    const nameMatch = toolCallText.match(namePattern);

    if (!nameMatch) {
        return null;
    }

    const functionName = nameMatch[1].trim();
    const argsStartMarker = "with args:";
    const argsStartPos = toolCallText.toLowerCase().indexOf(argsStartMarker.toLowerCase());

    if (argsStartPos === -1) {
        return null;
    }

    const argsStart = argsStartPos + argsStartMarker.length;
    const argsEnd = toolCallText.lastIndexOf(']');

    if (argsEnd <= argsStart) {
        return null;
    }

    const jsonCandidate = toolCallText.substring(argsStart, argsEnd).trim();

    try {
        // Simple repair for common issues like trailing commas or unquoted keys
        let repairedJson = jsonCandidate;
        // Remove trailing comma before closing brace/bracket
        repairedJson = repairedJson.replace(/,\s*([}\]])/g, '$1');
        // Add quotes to unquoted keys (basic attempt)
        repairedJson = repairedJson.replace(/([{,]\s*)([a-zA-Z0-9_]+?)\s*:/g, '$1"$2":');
        // Ensure string values are properly quoted if they contain special characters and are not already quoted
        repairedJson = repairedJson.replace(/:\s*([a-zA-Z0-9_]+)(?=[,\}\]])/g, ':"$1"');


        const argumentsObj = JSON.parse(repairedJson);

        if (typeof argumentsObj !== 'object' || argumentsObj === null) {
            return null;
        }

        const toolCallId = `call_${uuidv4().replace(/-/g, '').substring(0, 8)}`;
        return {
            id: toolCallId,
            type: "function",
            function: {
                name: functionName,
                arguments: JSON.stringify(argumentsObj)
            }
        };
    } catch (e) {
        console.error(`Failed to parse tool call arguments: ${e.message}`, jsonCandidate);
        return null;
    }
}

function parseBracketToolCalls(responseText) {
    if (!responseText || !responseText.includes("[Called")) {
        return null;
    }

    const toolCalls = [];
    const callPositions = [];
    let start = 0;
    while (true) {
        const pos = responseText.indexOf("[Called", start);
        if (pos === -1) {
            break;
        }
        callPositions.push(pos);
        start = pos + 1;
    }

    for (let i = 0; i < callPositions.length; i++) {
        const startPos = callPositions[i];
        let endSearchLimit;
        if (i + 1 < callPositions.length) {
            endSearchLimit = callPositions[i + 1];
        } else {
            endSearchLimit = responseText.length;
        }

        const segment = responseText.substring(startPos, endSearchLimit);
        const bracketEnd = findMatchingBracket(segment, 0);

        let toolCallText;
        if (bracketEnd !== -1) {
            toolCallText = segment.substring(0, bracketEnd + 1);
        } else {
            // Fallback: if no matching bracket, try to find the last ']' in the segment
            const lastBracket = segment.lastIndexOf(']');
            if (lastBracket !== -1) {
                toolCallText = segment.substring(0, lastBracket + 1);
            } else {
                continue; // Skip this one if no closing bracket found
            }
        }
        
        const parsedCall = parseSingleToolCall(toolCallText);
        if (parsedCall) {
            toolCalls.push(parsedCall);
        }
    }
    return toolCalls.length > 0 ? toolCalls : null;
}

function deduplicateToolCalls(toolCalls) {
    const seen = new Set();
    const uniqueToolCalls = [];

    for (const tc of toolCalls) {
        const key = `${tc.function.name}-${tc.function.arguments}`;
        if (!seen.has(key)) {
            seen.add(key);
            uniqueToolCalls.push(tc);
        } else {
            console.log(`Skipping duplicate tool call: ${tc.function.name}`);
        }
    }
    return uniqueToolCalls;
}

export class KiroApiService {
    constructor(config = {}) {
        this.isInitialized = false;
        this.config = config;
        this.credPath = config.KIRO_OAUTH_CREDS_DIR_PATH || path.join(os.homedir(), ".aws", "sso", "cache");
        this.credsBase64 = config.KIRO_OAUTH_CREDS_BASE64;
        this.useSystemProxy = config?.USE_SYSTEM_PROXY_KIRO ?? false;
        console.log(`[Kiro] System proxy ${this.useSystemProxy ? 'enabled' : 'disabled'}`);
        // this.accessToken = config.KIRO_ACCESS_TOKEN;
        // this.refreshToken = config.KIRO_REFRESH_TOKEN;
        // this.clientId = config.KIRO_CLIENT_ID;
        // this.clientSecret = config.KIRO_CLIENT_SECRET;
        // this.authMethod = KIRO_CONSTANTS.AUTH_METHOD_SOCIAL;
        // this.refreshUrl = KIRO_CONSTANTS.REFRESH_URL;
        // this.refreshIDCUrl = KIRO_CONSTANTS.REFRESH_IDC_URL;
        // this.baseUrl = KIRO_CONSTANTS.BASE_URL;
        // this.amazonQUrl = KIRO_CONSTANTS.AMAZON_Q_URL;

        // Add kiro-oauth-creds-base64 and kiro-oauth-creds-file to config
        if (config.KIRO_OAUTH_CREDS_BASE64) {
            try {
                const decodedCreds = Buffer.from(config.KIRO_OAUTH_CREDS_BASE64, 'base64').toString('utf8');
                const parsedCreds = JSON.parse(decodedCreds);
                // Store parsedCreds to be merged in initializeAuth
                this.base64Creds = parsedCreds;
                console.info('[Kiro] Successfully decoded Base64 credentials in constructor.');
            } catch (error) {
                console.error(`[Kiro] Failed to parse Base64 credentials in constructor: ${error.message}`);
            }
        } else if (config.KIRO_OAUTH_CREDS_FILE_PATH) {
            this.credsFilePath = config.KIRO_OAUTH_CREDS_FILE_PATH;
        }

        this.modelName = KIRO_CONSTANTS.DEFAULT_MODEL_NAME;
        this.axiosInstance = null; // Initialize later in async method
    }
 
    async initialize() {
        if (this.isInitialized) return;
        console.log('[Kiro] Initializing Kiro API Service...');
        await this.initializeAuth();
        const macSha256 = await getMacAddressSha256();
        const requestTimeout = this.config.KIRO_REQUEST_TIMEOUT || KIRO_CONSTANTS.AXIOS_TIMEOUT;
        console.log(`[Kiro] Request timeout: ${requestTimeout}ms`);
        const axiosConfig = {
            timeout: requestTimeout,
            headers: {
                'Content-Type': KIRO_CONSTANTS.CONTENT_TYPE_JSON,
                'x-amz-user-agent': `aws-sdk-js/1.0.7 KiroIDE-0.1.25-${macSha256}`,
                'user-agent': `aws-sdk-js/1.0.7 ua/2.1 os/win32#10.0.26100 lang/js md/nodejs#20.16.0 api/codewhispererstreaming#1.0.7 m/E KiroIDE-0.1.25-${macSha256}`,
                'amz-sdk-request': 'attempt=1; max=1',
                'x-amzn-kiro-agent-mode': 'vibe',
                'Accept': KIRO_CONSTANTS.ACCEPT_JSON,
            },
        };
        
        // 根据 useSystemProxy 配置代理设置
        if (!this.useSystemProxy) {
            axiosConfig.proxy = false;
        }
        
        this.axiosInstance = axios.create(axiosConfig);
        this.isInitialized = true;
    }

async initializeAuth(forceRefresh = false) {
    if (this.accessToken && !forceRefresh) {
        console.debug('[Kiro Auth] Access token already available and not forced refresh.');
        return;
    }

    // Helper to load credentials from a file
    const loadCredentialsFromFile = async (filePath) => {
        try {
            const fileContent = await fs.readFile(filePath, 'utf8');
            return JSON.parse(fileContent);
        } catch (error) {
            if (error.code === 'ENOENT') {
                console.debug(`[Kiro Auth] Credential file not found: ${filePath}`);
            } else if (error instanceof SyntaxError) {
                console.warn(`[Kiro Auth] Failed to parse JSON from ${filePath}: ${error.message}`);
            } else {
                console.warn(`[Kiro Auth] Failed to read credential file ${filePath}: ${error.message}`);
            }
            return null;
        }
    };

    // Helper to save credentials to a file
    const saveCredentialsToFile = async (filePath, newData) => {
        try {
            let existingData = {};
            try {
                const fileContent = await fs.readFile(filePath, 'utf8');
                existingData = JSON.parse(fileContent);
            } catch (readError) {
                if (readError.code === 'ENOENT') {
                    console.debug(`[Kiro Auth] Token file not found, creating new one: ${filePath}`);
                } else {
                    console.warn(`[Kiro Auth] Could not read existing token file ${filePath}: ${readError.message}`);
                }
            }
            const mergedData = { ...existingData, ...newData };
            await fs.writeFile(filePath, JSON.stringify(mergedData, null, 2), 'utf8');
            console.info(`[Kiro Auth] Updated token file: ${filePath}`);
        } catch (error) {
            console.error(`[Kiro Auth] Failed to write token to file ${filePath}: ${error.message}`);
        }
    };

    try {
        let mergedCredentials = {};

        // Priority 1: Load from Base64 credentials if available
        if (this.base64Creds) {
            Object.assign(mergedCredentials, this.base64Creds);
            console.info('[Kiro Auth] Successfully loaded credentials from Base64 (constructor).');
            // Clear base64Creds after use to prevent re-processing
            this.base64Creds = null;
        }

        // Priority 2 & 3 合并: 从指定文件路径或目录加载凭证
        // 读取指定的 credPath 文件以及目录下的其他 JSON 文件(排除当前文件)
        const targetFilePath = this.credsFilePath || path.join(this.credPath, KIRO_AUTH_TOKEN_FILE);
        const dirPath = path.dirname(targetFilePath);
        const targetFileName = path.basename(targetFilePath);
        
        console.debug(`[Kiro Auth] Attempting to load credentials from directory: ${dirPath}`);
        
        try {
            // 首先尝试读取目标文件
            const targetCredentials = await loadCredentialsFromFile(targetFilePath);
            if (targetCredentials) {
                Object.assign(mergedCredentials, targetCredentials);
                console.info(`[Kiro Auth] Successfully loaded OAuth credentials from ${targetFilePath}`);
            }
            
            // 然后读取目录下的其他 JSON 文件(排除目标文件本身)
            const files = await fs.readdir(dirPath);
            for (const file of files) {
                if (file.endsWith('.json') && file !== targetFileName) {
                    const filePath = path.join(dirPath, file);
                    const credentials = await loadCredentialsFromFile(filePath);
                    if (credentials) {
                        // 保留已有的 expiresAt,避免被覆盖
                        credentials.expiresAt = mergedCredentials.expiresAt;
                        Object.assign(mergedCredentials, credentials);
                        console.debug(`[Kiro Auth] Loaded Client credentials from ${file}`);
                    }
                }
            }
        } catch (error) {
            console.warn(`[Kiro Auth] Error loading credentials from directory ${dirPath}: ${error.message}`);
        }

        // console.log('[Kiro Auth] Merged credentials:', mergedCredentials);
        // Apply loaded credentials, prioritizing existing values if they are not null/undefined
        this.accessToken = this.accessToken || mergedCredentials.accessToken;
        this.refreshToken = this.refreshToken || mergedCredentials.refreshToken;
        this.clientId = this.clientId || mergedCredentials.clientId;
        this.clientSecret = this.clientSecret || mergedCredentials.clientSecret;
        this.authMethod = this.authMethod || mergedCredentials.authMethod;
        this.expiresAt = this.expiresAt || mergedCredentials.expiresAt;
        this.profileArn = this.profileArn || mergedCredentials.profileArn;
        this.region = this.region || mergedCredentials.region;

        // Ensure region is set before using it in URLs
        if (!this.region) {
            console.warn('[Kiro Auth] Region not found in credentials. Using default region us-east-1 for URLs.');
            this.region = 'us-east-1'; // Set default region
        }

        this.refreshUrl = KIRO_CONSTANTS.REFRESH_URL.replace("{{region}}", this.region);
        this.refreshIDCUrl = KIRO_CONSTANTS.REFRESH_IDC_URL.replace("{{region}}", this.region);
        this.baseUrl = KIRO_CONSTANTS.BASE_URL.replace("{{region}}", this.region);
        this.amazonQUrl = KIRO_CONSTANTS.AMAZON_Q_URL.replace("{{region}}", this.region);
    } catch (error) {
        console.warn(`[Kiro Auth] Error during credential loading: ${error.message}`);
    }

    // Refresh token if forced or if access token is missing but refresh token is available
    if (forceRefresh || (!this.accessToken && this.refreshToken)) {
        if (!this.refreshToken) {
            throw new Error('No refresh token available to refresh access token.');
        }
        try {
            const requestBody = {
                refreshToken: this.refreshToken,
            };

            let refreshUrl = this.refreshUrl;
            if (this.authMethod !== KIRO_CONSTANTS.AUTH_METHOD_SOCIAL) {
                refreshUrl = this.refreshIDCUrl;
                requestBody.clientId = this.clientId;
                requestBody.clientSecret = this.clientSecret;
                requestBody.grantType = 'refresh_token';
            }
            const response = await this.axiosInstance.post(refreshUrl, requestBody);
            console.log('[Kiro Auth] Token refresh response: ok');

            if (response.data && response.data.accessToken) {
                this.accessToken = response.data.accessToken;
                this.refreshToken = response.data.refreshToken;
                this.profileArn = response.data.profileArn;
                const expiresIn = response.data.expiresIn;
                const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
                this.expiresAt = expiresAt;
                console.info('[Kiro Auth] Access token refreshed successfully');

                // Update the token file - use specified path if configured, otherwise use default
                const tokenFilePath = this.credsFilePath || path.join(this.credPath, KIRO_AUTH_TOKEN_FILE);
                const updatedTokenData = {
                    accessToken: this.accessToken,
                    refreshToken: this.refreshToken,
                    expiresAt: expiresAt,
                };
                if(this.profileArn){
                    updatedTokenData.profileArn = this.profileArn;
                }
                await saveCredentialsToFile(tokenFilePath, updatedTokenData);
            } else {
                throw new Error('Invalid refresh response: Missing accessToken');
            }
        } catch (error) {
            console.error('[Kiro Auth] Token refresh failed:', error.message);
            throw new Error(`Token refresh failed: ${error.message}`);
        }
    }

    if (!this.accessToken) {
        throw new Error('No access token available after initialization and refresh attempts.');
    }
}

    /**
     * Extract text content from OpenAI message format
     */
    getContentText(message) {
        if(message==null){
            return "";
        }
        if (Array.isArray(message) ) {
            return message
                .filter(part => part.type === 'text' && part.text)
                .map(part => part.text)
                .join('');
        } else if (typeof message.content === 'string') {
            return message.content;
        } else if (Array.isArray(message.content) ) {
            return message.content
                .filter(part => part.type === 'text' && part.text)
                .map(part => part.text)
                .join('');
        } 
        return String(message.content || message);
    }

    /**
     * Build CodeWhisperer request from OpenAI messages
     */
    buildCodewhispererRequest(messages, model, tools = null, inSystemPrompt = null) {
        const conversationId = uuidv4();
        
        let systemPrompt = this.getContentText(inSystemPrompt);
        let processedMessages = messages;

        if (processedMessages.length === 0) {
            throw new Error('No user messages found');
        }

        const codewhispererModel = MODEL_MAPPING[model] || MODEL_MAPPING[this.modelName];
        
        // Kiro API 对请求大小有限制 (约 200KB)
        // 配置项: KIRO_MAX_TOOLS (默认 12), KIRO_DISABLE_TOOLS (默认 false), KIRO_MAX_HISTORY (默认 15)
        // KIRO_MAX_REQUEST_SIZE (默认 100000 bytes), KIRO_MAX_MESSAGE_LENGTH (默认 8000 chars)
        const maxTools = this.config.KIRO_MAX_TOOLS || 12;
        const disableTools = this.config.KIRO_DISABLE_TOOLS || false;
        const maxHistory = this.config.KIRO_MAX_HISTORY || 15;
        const maxRequestSize = this.config.KIRO_MAX_REQUEST_SIZE || 100000; // 100KB
        const maxMessageLength = this.config.KIRO_MAX_MESSAGE_LENGTH || 8000; // 每条消息最大字符数
        
        // 辅助函数：清理系统提示标签（这些标签可能导致 Kiro API 拒绝请求）
        const cleanSystemTags = (text) => {
            if (!text || typeof text !== 'string') return text;
            // 移除 <system-reminder>...</system-reminder> 标签及其内容
            return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, '')
                       .replace(/\[Request interrupted by user\]/gi, '')
                       .trim();
        };
        
        // 辅助函数：截断消息内容
        const truncateContent = (content, maxLen) => {
            if (!content) return content;
            if (typeof content === 'string') {
                let cleaned = cleanSystemTags(content);
                if (cleaned.length > maxLen) {
                    return cleaned.substring(0, maxLen) + '\n...[内容已截断]';
                }
                return cleaned;
            }
            if (Array.isArray(content)) {
                return content.map(part => {
                    if (part.type === 'text' && part.text) {
                        let cleaned = cleanSystemTags(part.text);
                        if (cleaned.length > maxLen) {
                            return { ...part, text: cleaned.substring(0, maxLen) + '\n...[内容已截断]' };
                        }
                        return { ...part, text: cleaned };
                    }
                    return part;
                });
            }
            return content;
        };
        
        // 限制历史消息数量，保留最近的消息
        if (processedMessages.length > maxHistory) {
            const originalLength = processedMessages.length;
            // 保留最后 maxHistory 条消息
            processedMessages = processedMessages.slice(-maxHistory);
            console.log(`[Kiro] History truncated: ${originalLength} -> ${processedMessages.length} (max: ${maxHistory})`);
        }
        
        // 截断每条消息的内容长度
        processedMessages = processedMessages.map(msg => ({
            ...msg,
            content: truncateContent(msg.content, maxMessageLength)
        }));
        
        // 核心工具白名单 - 只保留 Claude Code 必需的工具
        const coreTools = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch', 'AskUserQuestion'];
        
        let toolsContext = {};
        if (!disableTools && tools && Array.isArray(tools) && tools.length > 0) {
            // 优先保留核心工具，然后按描述长度过滤
            let filteredTools = tools
                .filter(tool => {
                    // 优先保留核心工具
                    if (coreTools.includes(tool.name)) {
                        return true;
                    }
                    // 跳过描述超过 1000 字符的非核心工具
                    const descLength = (tool.description || '').length;
                    if (descLength > 1000) {
                        console.log(`[Kiro] Skipping tool "${tool.name}" due to long description (${descLength} chars)`);
                        return false;
                    }
                    return true;
                })
                .slice(0, maxTools);
            
            if (filteredTools.length < tools.length) {
                console.log(`[Kiro] Tools filtered: ${tools.length} -> ${filteredTools.length} (max: ${maxTools})`);
            }
            
            if (filteredTools.length > 0) {
                toolsContext = {
                    tools: filteredTools.map(tool => ({
                        toolSpecification: {
                            name: tool.name,
                            description: (tool.description || '').substring(0, 300), // 更激进地截断描述到300字符
                            inputSchema: { json: tool.input_schema || {} }
                        }
                    }))
                };
            }
        } else if (disableTools && tools && tools.length > 0) {
            console.log(`[Kiro] Tools disabled by config (KIRO_DISABLE_TOOLS=true), skipping ${tools.length} tools`);
        }

        const history = [];
        let startIndex = 0;

        // Handle system prompt
        if (systemPrompt) {
            // If the first message is a user message, prepend system prompt to it
            if (processedMessages[0].role === 'user') {
                let firstUserContent = this.getContentText(processedMessages[0]);
                history.push({
                    userInputMessage: {
                        content: `${systemPrompt}\n\n${firstUserContent}`,
                        modelId: codewhispererModel,
                        origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR,
                    }
                });
                startIndex = 1; // Start processing from the second message
            } else {
                // If the first message is not a user message, or if there's no initial user message,
                // add system prompt as a standalone user message.
                history.push({
                    userInputMessage: {
                        content: systemPrompt,
                        modelId: codewhispererModel,
                        origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR,
                    }
                });
            }
        }

        // Add remaining user/assistant messages to history
        for (let i = startIndex; i < processedMessages.length - 1; i++) {
            const message = processedMessages[i];
            if (message.role === 'user') {
                let userInputMessage = {
                    content: '',
                    modelId: codewhispererModel,
                    origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR,
                    userInputMessageContext: {}
                };
                if (Array.isArray(message.content)) {
                    userInputMessage.images = []; // Initialize images array
                    for (const part of message.content) {
                        if (part.type === 'text') {
                            userInputMessage.content += cleanSystemTags(part.text);
                        } else if (part.type === 'tool_result') {
                            if (!userInputMessage.userInputMessageContext.toolResults) {
                                userInputMessage.userInputMessageContext.toolResults = [];
                            }
                            // 清理并截断工具结果
                            let toolResultText = cleanSystemTags(this.getContentText(part.content));
                            if (toolResultText.length > maxMessageLength) {
                                toolResultText = toolResultText.substring(0, maxMessageLength) + '\n...[工具结果已截断]';
                            }
                            userInputMessage.userInputMessageContext.toolResults.push({
                                content: [{ text: toolResultText }],
                                status: 'success',
                                toolUseId: part.tool_use_id
                            });
                        } else if (part.type === 'image') {
                            userInputMessage.images.push({
                                format: part.source.media_type.split('/')[1],
                                source: {
                                    bytes: part.source.data
                                }
                            });
                        }
                    }
                } else {
                    userInputMessage.content = cleanSystemTags(this.getContentText(message));
                }
                history.push({ userInputMessage });
            } else if (message.role === 'assistant') {
                let assistantResponseMessage = {
                    content: '',
                    toolUses: []
                };
                if (Array.isArray(message.content)) {
                    for (const part of message.content) {
                        if (part.type === 'text') {
                            assistantResponseMessage.content += part.text;
                        } else if (part.type === 'tool_use') {
                            assistantResponseMessage.toolUses.push({
                                input: part.input,
                                name: part.name,
                                toolUseId: part.id
                            });
                        }
                    }
                } else {
                    assistantResponseMessage.content = this.getContentText(message);
                }
                history.push({ assistantResponseMessage });
            }
        }

        // Build current message
        const currentMessage = processedMessages[processedMessages.length - 1];
        let currentContent = '';
        let currentToolResults = [];
        let currentToolUses = [];
        let currentImages = [];

        if (Array.isArray(currentMessage.content)) {
            for (const part of currentMessage.content) {
                if (part.type === 'text') {
                    currentContent += cleanSystemTags(part.text);
                } else if (part.type === 'tool_result') {
                    // 清理 tool_result 内容中的系统标签
                    let toolResultText = cleanSystemTags(this.getContentText(part.content));
                    // 截断过长的工具结果
                    if (toolResultText.length > maxMessageLength) {
                        toolResultText = toolResultText.substring(0, maxMessageLength) + '\n...[工具结果已截断]';
                    }
                    currentToolResults.push({
                        content: [{ text: toolResultText }],
                        status: 'success',
                        toolUseId: part.tool_use_id
                    });
                } else if (part.type === 'tool_use') {
                    currentToolUses.push({
                        input: part.input,
                        name: part.name,
                        toolUseId: part.id
                    });
                } else if (part.type === 'image') {
                    currentImages.push({
                        format: part.source.media_type.split('/')[1],
                        source: {
                            bytes: part.source.data
                        }
                    });
                }
            }
        } else {
            currentContent = this.getContentText(currentMessage);
        }

        if (!currentContent && currentToolResults.length === 0 && currentToolUses.length === 0) {
            currentContent = 'Continue';
        }

        const request = {
            conversationState: {
                chatTriggerType: KIRO_CONSTANTS.CHAT_TRIGGER_TYPE_MANUAL,
                conversationId: conversationId,
                currentMessage: {}, // Will be populated based on the last message's role
                history: history
            }
        };

        if (currentMessage.role === 'user') {
            const userInputMessage = {
                content: currentContent,
                modelId: codewhispererModel,
                origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR,
                userInputMessageContext: {}
            };
            // 只添加非空的字段，避免 null 值
            if (currentImages && currentImages.length > 0) {
                userInputMessage.images = currentImages;
            }
            if (currentToolResults.length > 0) {
                userInputMessage.userInputMessageContext.toolResults = currentToolResults;
            }
            if (Object.keys(toolsContext).length > 0 && toolsContext.tools) {
                userInputMessage.userInputMessageContext.tools = toolsContext.tools;
            }
            // 如果 userInputMessageContext 为空对象，移除它
            if (Object.keys(userInputMessage.userInputMessageContext).length === 0) {
                delete userInputMessage.userInputMessageContext;
            }
            request.conversationState.currentMessage.userInputMessage = userInputMessage;
        } else if (currentMessage.role === 'assistant') {
            // Kiro API 要求 currentMessage 必须是 userInputMessage
            // 如果最后一条消息是 assistant，将其加入 history，然后创建一个 "Continue" 用户消息
            console.log('[Kiro] Last message is assistant role, converting to user message with "Continue"');
            history.push({
                assistantResponseMessage: {
                    content: currentContent,
                    toolUses: currentToolUses.length > 0 ? currentToolUses : []
                }
            });
            // 更新 history
            request.conversationState.history = history;
            // 创建一个 "Continue" 用户消息作为 currentMessage
            const continueMessage = {
                content: 'Continue',
                modelId: codewhispererModel,
                origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
            };
            // 只添加非空的 tools
            if (Object.keys(toolsContext).length > 0 && toolsContext.tools) {
                continueMessage.userInputMessageContext = {
                    tools: toolsContext.tools
                };
            }
            request.conversationState.currentMessage.userInputMessage = continueMessage;
        }

        if (this.authMethod === KIRO_CONSTANTS.AUTH_METHOD_SOCIAL) {
            request.profileArn = this.profileArn;
        }
        
        // 检查请求大小，如果超过限制则进一步截断
        let requestJson = JSON.stringify(request);
        if (requestJson.length > maxRequestSize) {
            console.warn(`[Kiro] Request size (${requestJson.length} bytes) exceeds limit (${maxRequestSize}), applying aggressive truncation...`);
            
            // 策略1: 进一步减少历史消息
            while (request.conversationState.history.length > 5 && requestJson.length > maxRequestSize) {
                request.conversationState.history.shift(); // 移除最早的消息
                requestJson = JSON.stringify(request);
                console.log(`[Kiro] Reduced history to ${request.conversationState.history.length} messages, size: ${requestJson.length} bytes`);
            }
            
            // 策略2: 截断历史消息中的长内容
            if (requestJson.length > maxRequestSize) {
                const shorterMaxLen = 2000; // 更短的截断长度
                request.conversationState.history = request.conversationState.history.map(item => {
                    if (item.userInputMessage && item.userInputMessage.content) {
                        const content = item.userInputMessage.content;
                        if (typeof content === 'string' && content.length > shorterMaxLen) {
                            item.userInputMessage.content = content.substring(0, shorterMaxLen) + '\n...[已截断]';
                        }
                    }
                    if (item.assistantResponseMessage && item.assistantResponseMessage.content) {
                        const content = item.assistantResponseMessage.content;
                        if (typeof content === 'string' && content.length > shorterMaxLen) {
                            item.assistantResponseMessage.content = content.substring(0, shorterMaxLen) + '\n...[已截断]';
                        }
                    }
                    return item;
                });
                requestJson = JSON.stringify(request);
                console.log(`[Kiro] After content truncation, size: ${requestJson.length} bytes`);
            }
            
            // 策略3: 移除工具定义
            if (requestJson.length > maxRequestSize && request.conversationState.currentMessage?.userInputMessage?.userInputMessageContext?.tools) {
                console.log(`[Kiro] Removing tools to reduce request size`);
                request.conversationState.currentMessage.userInputMessage.userInputMessageContext.tools = null;
                requestJson = JSON.stringify(request);
                console.log(`[Kiro] After removing tools, size: ${requestJson.length} bytes`);
            }
            
            // 策略4: 最后手段 - 只保留最近3条消息
            if (requestJson.length > maxRequestSize && request.conversationState.history.length > 3) {
                console.warn(`[Kiro] Emergency truncation: keeping only last 3 messages`);
                request.conversationState.history = request.conversationState.history.slice(-3);
                requestJson = JSON.stringify(request);
                console.log(`[Kiro] Final size: ${requestJson.length} bytes`);
            }
        }
        
        return request;
    }

    parseEventStreamChunk(rawData) {
        const rawStr = Buffer.isBuffer(rawData) ? rawData.toString('utf8') : String(rawData);
        let fullContent = '';
        const toolCalls = [];
        let currentToolCallDict = null;
        // console.log(`rawStr=${rawStr}`);

        // 改进的 SSE 事件解析：匹配 :message-typeevent 后面的 JSON 数据
        // 使用更精确的正则来匹配 SSE 格式的事件
        const sseEventRegex = /:message-typeevent(\{[^]*?(?=:event-type|$))/g;
        const legacyEventRegex = /event(\{.*?(?=event\{|$))/gs;
        
        // 首先尝试使用 SSE 格式解析
        let matches = [...rawStr.matchAll(sseEventRegex)];
        
        // 如果 SSE 格式没有匹配到，回退到旧的格式
        if (matches.length === 0) {
            matches = [...rawStr.matchAll(legacyEventRegex)];
        }

        for (const match of matches) {
            const potentialJsonBlock = match[1];
            if (!potentialJsonBlock || potentialJsonBlock.trim().length === 0) {
                continue;
            }

            // 尝试找到完整的 JSON 对象
            let searchPos = 0;
            while ((searchPos = potentialJsonBlock.indexOf('}', searchPos + 1)) !== -1) {
                const jsonCandidate = potentialJsonBlock.substring(0, searchPos + 1).trim();
                try {
                    const eventData = JSON.parse(jsonCandidate);

                    // 优先处理结构化工具调用事件
                    if (eventData.name && eventData.toolUseId) {
                        if (!currentToolCallDict) {
                            currentToolCallDict = {
                                id: eventData.toolUseId,
                                type: "function",
                                function: {
                                    name: eventData.name,
                                    arguments: ""
                                }
                            };
                        }
                        if (eventData.input) {
                            currentToolCallDict.function.arguments += eventData.input;
                        }
                        if (eventData.stop) {
                            try {
                                const args = JSON.parse(currentToolCallDict.function.arguments);
                                currentToolCallDict.function.arguments = JSON.stringify(args);
                            } catch (e) {
                                console.warn(`[Kiro] Tool call arguments not valid JSON: ${currentToolCallDict.function.arguments}`);
                            }
                            toolCalls.push(currentToolCallDict);
                            currentToolCallDict = null;
                        }
                    } else if (!eventData.followupPrompt && eventData.content) {
                        // 处理内容，移除转义字符
                        let decodedContent = eventData.content;
                        // 处理常见的转义序列
                        decodedContent = decodedContent.replace(/(?<!\\)\\n/g, '\n');
                        // decodedContent = decodedContent.replace(/(?<!\\)\\t/g, '\t');
                        // decodedContent = decodedContent.replace(/\\"/g, '"');
                        // decodedContent = decodedContent.replace(/\\\\/g, '\\');
                        fullContent += decodedContent;
                    }
                    break;
                } catch (e) {
                    // JSON 解析失败，继续寻找下一个可能的结束位置
                    continue;
                }
            }
        }
        
        // 如果还有未完成的工具调用，添加到列表中
        if (currentToolCallDict) {
            toolCalls.push(currentToolCallDict);
        }

        // 检查解析后文本中的 bracket 格式工具调用
        const bracketToolCalls = parseBracketToolCalls(fullContent);
        if (bracketToolCalls) {
            toolCalls.push(...bracketToolCalls);
            // 从响应文本中移除工具调用文本
            for (const tc of bracketToolCalls) {
                const funcName = tc.function.name;
                const escapedName = funcName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const pattern = new RegExp(`\\[Called\\s+${escapedName}\\s+with\\s+args:\\s*\\{[^}]*(?:\\{[^}]*\\}[^}]*)*\\}\\]`, 'gs');
                fullContent = fullContent.replace(pattern, '');
            }
            fullContent = fullContent.replace(/\s+/g, ' ').trim();
        }

        const uniqueToolCalls = deduplicateToolCalls(toolCalls);
        return { content: fullContent || '', toolCalls: uniqueToolCalls };
    }
 

    async callApi(method, model, body, isRetry = false, retryCount = 0) {
        if (!this.isInitialized) await this.initialize();
        const maxRetries = this.config.REQUEST_MAX_RETRIES || 3;
        const baseDelay = this.config.REQUEST_BASE_DELAY || 1000; // 1 second base delay

        const requestData = this.buildCodewhispererRequest(body.messages, model, body.tools, body.system);
        
        // 调试日志：打印请求大小和关键信息
        const requestJson = JSON.stringify(requestData);
        console.log(`[Kiro] Request size: ${requestJson.length} bytes`);
        console.log(`[Kiro] Request has tools: ${requestData.conversationState?.currentMessage?.userInputMessage?.userInputMessageContext?.tools ? 'yes' : 'no'}`);
        console.log(`[Kiro] History length: ${requestData.conversationState?.history?.length || 0}`);
        
        // 打印请求结构用于调试
        const currentMsg = requestData.conversationState?.currentMessage;
        if (currentMsg?.userInputMessage) {
            const uim = currentMsg.userInputMessage;
            console.log(`[Kiro] CurrentMessage: content=${(uim.content || '').substring(0, 100)}..., modelId=${uim.modelId}, origin=${uim.origin}`);
            console.log(`[Kiro] CurrentMessage context: toolResults=${uim.userInputMessageContext?.toolResults?.length || 0}, tools=${uim.userInputMessageContext?.tools?.length || 0}`);
            // 打印 toolResults 详情用于调试
            if (uim.userInputMessageContext?.toolResults) {
                uim.userInputMessageContext.toolResults.forEach((tr, i) => {
                    console.log(`[Kiro] ToolResult[${i}]: toolUseId=${tr.toolUseId}, status=${tr.status}, contentLen=${JSON.stringify(tr.content).length}`);
                });
            }
            if (uim.images) {
                console.log(`[Kiro] CurrentMessage images: ${uim.images.length}`);
            }
        }
        
        // 如果请求过大，打印警告
        if (requestJson.length > 50000) {
            console.warn(`[Kiro] WARNING: Request size (${requestJson.length} bytes) exceeds 50KB, may cause 400 error`);
        }
        
        // 将请求保存到文件用于调试
        try {
            const debugPath = `logs/kiro_request_${Date.now()}.json`;
            await fs.writeFile(debugPath, JSON.stringify(requestData, null, 2));
            console.log(`[Kiro] Request saved to ${debugPath} for debugging`);
        } catch (e) {
            console.log(`[Kiro] Failed to save debug request: ${e.message}`);
        }

        try {
            const token = this.accessToken; // Use the already initialized token
            const headers = {
                'Authorization': `Bearer ${token}`,
                'amz-sdk-invocation-id': `${uuidv4()}`,
            };

            // 当 model 以 kiro-amazonq 开头时，使用 amazonQUrl，否则使用 baseUrl
            const requestUrl = model.startsWith('amazonq') ? this.amazonQUrl : this.baseUrl;
            const response = await this.axiosInstance.post(requestUrl, requestData, { headers });
            return response;
        } catch (error) {
            // 打印详细的错误响应
            if (error.response) {
                console.error(`[Kiro] Error response status: ${error.response.status}`);
                console.error(`[Kiro] Error response data: ${JSON.stringify(error.response.data || 'no data')}`);
            }
            if (error.response?.status === 403 && !isRetry) {
                console.log('[Kiro] Received 403. Attempting token refresh and retrying...');
                try {
                    await this.initializeAuth(true); // Force refresh token
                    return this.callApi(method, model, body, true, retryCount);
                } catch (refreshError) {
                    console.error('[Kiro] Token refresh failed during 403 retry:', refreshError.message);
                    throw refreshError;
                }
            }

            // Handle 429 (Too Many Requests) with exponential backoff
            if (error.response?.status === 429 && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                console.log(`[Kiro] Received 429 (Too Many Requests). Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.callApi(method, model, body, isRetry, retryCount + 1);
            }

            // Handle other retryable errors (5xx server errors)
            if (error.response?.status >= 500 && error.response?.status < 600 && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                console.log(`[Kiro] Received ${error.response.status} server error. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.callApi(method, model, body, isRetry, retryCount + 1);
            }
            
            // Handle network errors (stream aborted, connection reset, etc.)
            const isNetworkError = error.code === 'ECONNRESET' || 
                                   error.code === 'ETIMEDOUT' ||
                                   error.code === 'ECONNABORTED' ||
                                   error.message?.includes('stream has been aborted') ||
                                   error.message?.includes('socket hang up');
            if (isNetworkError && retryCount < maxRetries) {
                const delay = baseDelay * Math.pow(2, retryCount);
                console.log(`[Kiro] Network error: ${error.message}. Retrying in ${delay}ms... (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.callApi(method, model, body, isRetry, retryCount + 1);
            }

            console.error('[Kiro] API call failed:', error.message);
            throw error;
        }
    }

    _processApiResponse(response) {
        const rawResponseText = Buffer.isBuffer(response.data) ? response.data.toString('utf8') : String(response.data);
        //console.log(`[Kiro] Raw response length: ${rawResponseText.length}`);
        if (rawResponseText.includes("[Called")) {
            console.log("[Kiro] Raw response contains [Called marker.");
        }

        // 1. Parse structured events and bracket calls from parsed content
        const parsedFromEvents = this.parseEventStreamChunk(rawResponseText);
        let fullResponseText = parsedFromEvents.content;
        let allToolCalls = [...parsedFromEvents.toolCalls]; // clone
        //console.log(`[Kiro] Found ${allToolCalls.length} tool calls from event stream parsing.`);

        // 2. Crucial fix from Python example: Parse bracket tool calls from the original raw response
        const rawBracketToolCalls = parseBracketToolCalls(rawResponseText);
        if (rawBracketToolCalls) {
            //console.log(`[Kiro] Found ${rawBracketToolCalls.length} bracket tool calls in raw response.`);
            allToolCalls.push(...rawBracketToolCalls);
        }

        // 3. Deduplicate all collected tool calls
        const uniqueToolCalls = deduplicateToolCalls(allToolCalls);
        //console.log(`[Kiro] Total unique tool calls after deduplication: ${uniqueToolCalls.length}`);

        // 4. Clean up response text by removing all tool call syntax from the final text.
        // The text from parseEventStreamChunk is already partially cleaned.
        // We re-clean here with all unique tool calls to be certain.
        if (uniqueToolCalls.length > 0) {
            for (const tc of uniqueToolCalls) {
                const funcName = tc.function.name;
                const escapedName = funcName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const pattern = new RegExp(`\\[Called\\s+${escapedName}\\s+with\\s+args:\\s*\\{[^}]*(?:\\{[^}]*\\}[^}]*)*\\}\\]`, 'gs');
                fullResponseText = fullResponseText.replace(pattern, '');
            }
            fullResponseText = fullResponseText.replace(/\s+/g, ' ').trim();
        }
        
        //console.log(`[Kiro] Final response text after tool call cleanup: ${fullResponseText}`);
        //console.log(`[Kiro] Final tool calls after deduplication: ${JSON.stringify(uniqueToolCalls)}`);
        return { responseText: fullResponseText, toolCalls: uniqueToolCalls };
    }

    async generateContent(model, requestBody) {
        if (!this.isInitialized) await this.initialize();
        
        // 检查 token 是否即将过期,如果是则先刷新
        if (this.isExpiryDateNear()) {
            console.log('[Kiro] Token is near expiry, refreshing before generateContent request...');
            await this.initializeAuth(true);
        }
        
        const finalModel = MODEL_MAPPING[model] ? model : this.modelName;
        console.log(`[Kiro] Calling generateContent with model: ${finalModel}`);
        const response = await this.callApi('', finalModel, requestBody);

        try {
            const { responseText, toolCalls } = this._processApiResponse(response);
            return this.buildClaudeResponse(responseText, false, 'assistant', model, toolCalls);
        } catch (error) {
            console.error('[Kiro] Error in generateContent:', error);
            throw new Error(`Error processing response: ${error.message}`);
        }
    }

    //kiro提供的接口没有流式返回
    async streamApi(method, model, body, isRetry = false, retryCount = 0) {
        try {
            // 直接调用并返回Promise，最终解析为response
            return await this.callApi(method, model, body, isRetry, retryCount);
        } catch (error) {
            console.error('[Kiro] Error calling API:', error);
            throw error; // 向上抛出错误
        }
    }

    // 重构2: generateContentStream 调用新的普通async函数
    async * generateContentStream(model, requestBody) {
        if (!this.isInitialized) await this.initialize();
        
        // 检查 token 是否即将过期,如果是则先刷新
        if (this.isExpiryDateNear()) {
            console.log('[Kiro] Token is near expiry, refreshing before generateContentStream request...');
            await this.initializeAuth(true);
        }
        
        const finalModel = MODEL_MAPPING[model] ? model : this.modelName;
        console.log(`[Kiro] Calling generateContentStream with model: ${finalModel}`);
        
        try {
            const response = await this.streamApi('', finalModel, requestBody);
            const { responseText, toolCalls } = this._processApiResponse(response);

            // Pass both responseText and toolCalls to buildClaudeResponse
            // buildClaudeResponse will handle the logic of combining them into a single stream
            for (const chunkJson of this.buildClaudeResponse(responseText, true, 'assistant', model, toolCalls)) {
                yield chunkJson;
            }
        } catch (error) {
            console.error('[Kiro] Error in streaming generation:', error);
            throw new Error(`Error processing response: ${error.message}`);
            // For Claude, we yield an array of events for streaming error
            // Ensure error message is passed as content, not toolCalls
            // for (const chunkJson of this.buildClaudeResponse(`Error: ${error.message}`, true, 'assistant', model, null)) {
            //     yield chunkJson;
            // }
        }
    }

    /**
     * Build Claude compatible response object
     */
    buildClaudeResponse(content, isStream = false, role = 'assistant', model, toolCalls = null) {
        const messageId = `${uuidv4()}`;
        // Helper to estimate tokens (simple heuristic)
        const estimateTokens = (text) => Math.ceil((text || '').length / 4);

        if (isStream) {
            // Kiro API is "pseudo-streaming", so we'll send a few events to simulate
            // a full Claude stream, but the content/tool_calls will be sent in one go.
            const events = [];

            // 1. message_start event
            events.push({
                type: "message_start",
                message: {
                    id: messageId,
                    type: "message",
                    role: role,
                    model: model,
                    usage: {
                        input_tokens: 0, // Kiro API doesn't provide this
                        output_tokens: 0 // Will be updated in message_delta
                    },
                    content: [] // Content will be streamed via content_block_delta
                }
            });
 
            let totalOutputTokens = 0;
            let stopReason = "end_turn";

            if (content) {
                // If there are tool calls AND content, the content block index should be after tool calls
                const contentBlockIndex = (toolCalls && toolCalls.length > 0) ? toolCalls.length : 0;

                // 2. content_block_start for text
                events.push({
                    type: "content_block_start",
                    index: contentBlockIndex,
                    content_block: {
                        type: "text",
                        text: "" // Initial empty text
                    }
                });
                // 3. content_block_delta for text
                events.push({
                    type: "content_block_delta",
                    index: contentBlockIndex,
                    delta: {
                        type: "text_delta",
                        text: content
                    }
                });
                // 4. content_block_stop
                events.push({
                    type: "content_block_stop",
                    index: contentBlockIndex
                });
                totalOutputTokens += estimateTokens(content);
                // If there are tool calls, the stop reason remains "tool_use".
                // If only content, it's "end_turn".
                if (!toolCalls || toolCalls.length === 0) {
                    stopReason = "end_turn";
                }
            }

            if (toolCalls && toolCalls.length > 0) {
                toolCalls.forEach((tc, index) => {
                    let inputObject;
                    try {
                        // Arguments should be a stringified JSON object.
                        inputObject = tc.function.arguments;
                    } catch (e) {
                        console.warn(`[Kiro] Invalid JSON for tool call arguments. Wrapping in raw_arguments. Error: ${e.message}`, tc.function.arguments);
                        // If parsing fails, wrap the raw string in an object as a fallback,
                        // since Claude's `input` field expects an object.
                        inputObject = { "raw_arguments": tc.function.arguments };
                    }
                    // 2. content_block_start for each tool_use
                    events.push({
                        type: "content_block_start",
                        index: index,
                        content_block: {
                            type: "tool_use",
                            id: tc.id,
                            name: tc.function.name,
                            input: {} // input is streamed via input_json_delta
                        }
                    });
                    
                    // 3. content_block_delta for each tool_use
                    // Since Kiro is not truly streaming, we send the full arguments as one delta.
                    events.push({
                        type: "content_block_delta",
                        index: index,
                        delta: {
                            type: "input_json_delta",
                            partial_json: inputObject
                        }
                    });
 
                    // 4. content_block_stop for each tool_use
                    events.push({
                        type: "content_block_stop",
                        index: index
                    });
                    totalOutputTokens += estimateTokens(JSON.stringify(inputObject));
                });
                stopReason = "tool_use"; // If there are tool calls, the stop reason is tool_use
            }

            // 5. message_delta with appropriate stop reason
            events.push({
                type: "message_delta",
                delta: {
                    stop_reason: stopReason,
                    stop_sequence: null,
                },
                usage: { output_tokens: totalOutputTokens }
            });

            // 6. message_stop event
            events.push({
                type: "message_stop"
            });

            return events; // Return an array of events for streaming
        } else {
            // Non-streaming response (full message object)
            const contentArray = [];
            let stopReason = "end_turn";
            let outputTokens = 0;

            if (toolCalls && toolCalls.length > 0) {
                for (const tc of toolCalls) {
                    let inputObject;
                    try {
                        // Arguments should be a stringified JSON object.
                        inputObject = tc.function.arguments;
                    } catch (e) {
                        console.warn(`[Kiro] Invalid JSON for tool call arguments. Wrapping in raw_arguments. Error: ${e.message}`, tc.function.arguments);
                        // If parsing fails, wrap the raw string in an object as a fallback,
                        // since Claude's `input` field expects an object.
                        inputObject = { "raw_arguments": tc.function.arguments };
                    }
                    contentArray.push({
                        type: "tool_use",
                        id: tc.id,
                        name: tc.function.name,
                        input: inputObject
                    });
                    outputTokens += estimateTokens(tc.function.arguments);
                }
                stopReason = "tool_use"; // Set stop_reason to "tool_use" when toolCalls exist
            } else if (content) {
                contentArray.push({
                    type: "text",
                    text: content
                });
                outputTokens += estimateTokens(content);
            }

            return {
                id: messageId,
                type: "message",
                role: role,
                model: model,
                stop_reason: stopReason,
                stop_sequence: null,
                usage: {
                    input_tokens: 0, // Kiro API doesn't provide this
                    output_tokens: outputTokens
                },
                content: contentArray
            };
        }
    }

    /**
     * List available models
     */
    async listModels() {
        const models = KIRO_MODELS.map(id => ({
            name: id
        }));
        
        return { models: models };
    }

    /**
     * Checks if the given expiresAt timestamp is within 10 minutes from now.
     * @returns {boolean} - True if expiresAt is less than 10 minutes from now, false otherwise.
     */
    isExpiryDateNear() {
        try {
            const expirationTime = new Date(this.expiresAt);
            const currentTime = new Date();
            const cronNearMinutesInMillis = (this.config.CRON_NEAR_MINUTES || 10) * 60 * 1000;
            const thresholdTime = new Date(currentTime.getTime() + cronNearMinutesInMillis);
            console.log(`[Kiro] Expiry date: ${expirationTime.getTime()}, Current time: ${currentTime.getTime()}, ${this.config.CRON_NEAR_MINUTES || 10} minutes from now: ${thresholdTime.getTime()}`);
            return expirationTime.getTime() <= thresholdTime.getTime();
        } catch (error) {
            console.error(`[Kiro] Error checking expiry date: ${this.expiresAt}, Error: ${error.message}`);
            return false; // Treat as expired if parsing fails
        }
    }
}
