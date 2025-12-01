import { API_ACTIONS, extractSystemPromptFromRequestBody, MODEL_PROTOCOL_PREFIX } from '../common.js';
import { ProviderStrategy } from '../provider-strategy.js';

/**
 * Gemini provider strategy implementation.
 */
class GeminiStrategy extends ProviderStrategy {
    extractModelAndStreamInfo(req, requestBody) {
        const requestUrl = new URL(req.url, `http://${req.headers.host}`);
        // 支持两种 URL 格式：
        // 1. /v1beta/models/{model}:generateContent (标准 Gemini 格式)
        // 2. /v1/{model}:generateContent (兼容 claude-code-router)
        const urlPatternV1Beta = new RegExp(`/v1beta/models/(.+?):(${API_ACTIONS.GENERATE_CONTENT}|${API_ACTIONS.STREAM_GENERATE_CONTENT})`);
        const urlPatternV1 = new RegExp(`/v1/(.+?):(${API_ACTIONS.GENERATE_CONTENT}|${API_ACTIONS.STREAM_GENERATE_CONTENT})`);
        
        let urlMatch = requestUrl.pathname.match(urlPatternV1Beta);
        if (!urlMatch) {
            urlMatch = requestUrl.pathname.match(urlPatternV1);
        }
        
        if (!urlMatch) {
            throw new Error(`Invalid Gemini URL format: ${requestUrl.pathname}`);
        }
        
        const [, urlmodel, action] = urlMatch;
        const model = urlmodel;
        const isStream = action === API_ACTIONS.STREAM_GENERATE_CONTENT;
        return { model, isStream };
    }

    extractResponseText(response) {
        if (response.candidates && response.candidates.length > 0) {
            const candidate = response.candidates[0];
            if (candidate.content && candidate.content.parts && candidate.content.parts.length > 0) {
                return candidate.content.parts.map(part => part.text).join('');
            }
        }
        return '';
    }

    extractPromptText(requestBody) {
        if (requestBody.contents && requestBody.contents.length > 0) {
            const lastContent = requestBody.contents[requestBody.contents.length - 1];
            if (lastContent.parts && lastContent.parts.length > 0) {
                return lastContent.parts.map(part => part.text).join('');
            }
        }
        return '';
    }

    async applySystemPromptFromFile(config, requestBody) {
        if (!config.SYSTEM_PROMPT_FILE_PATH) {
            return requestBody;
        }

        const filePromptContent = config.SYSTEM_PROMPT_CONTENT;
        if (filePromptContent === null) {
            return requestBody;
        }

        const existingSystemText = extractSystemPromptFromRequestBody(requestBody, MODEL_PROTOCOL_PREFIX.GEMINI);

        const newSystemText = config.SYSTEM_PROMPT_MODE === 'append' && existingSystemText
            ? `${existingSystemText}\n${filePromptContent}`
            : filePromptContent;

        requestBody.systemInstruction = { parts: [{ text: newSystemText }] };
        if (requestBody.system_instruction) {
            delete requestBody.system_instruction;
        }
        console.log(`[System Prompt] Applied system prompt from ${config.SYSTEM_PROMPT_FILE_PATH} in '${config.SYSTEM_PROMPT_MODE}' mode for provider 'gemini'.`);

        return requestBody;
    }

    async manageSystemPrompt(requestBody) {
        const incomingSystemText = extractSystemPromptFromRequestBody(requestBody, MODEL_PROTOCOL_PREFIX.GEMINI);
        await this._updateSystemPromptFile(incomingSystemText, MODEL_PROTOCOL_PREFIX.GEMINI);
    }
}

export { GeminiStrategy };
