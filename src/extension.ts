'use strict';

import * as vscode from 'vscode';
import OpenAI from 'openai';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import * as https from 'https';
import sharp from 'sharp';
import { GitExtension } from './git';
const { OpenAIClient, AzureKeyCredential } = require("@azure/openai");

const LANGUAGE_MODEL_ID = 'copilot-gpt-4';

export function activate(extContext: vscode.ExtensionContext) {

	const agent = vscode.chat.createChatParticipant('dall-e', async (request, context, stream, token) => {
		if (request. command === 'affirmation') {
			return handleAffirmation(extContext, request, context, stream, token);
		} else if (request.command === 'flowchart') {
			return handleCodeFlowVisualization(extContext, request, context, stream, token);
		} else if (request.command === 'render') {
			return handleRender(extContext, request, context, stream, token);
		}

		let imageGenPrompt = request.prompt || 'A photo of a bicyclist in Seattle carrying a laptop and writing code while simultaneously riding a bike.';

		const reg = /(^|\s)\[(#)([\w_\-]+)(:[\w_\-\.]+)?\]\(values:([\w_\-]+)(:[\w_\-\.]+)?\)/ig;
		imageGenPrompt = imageGenPrompt.replace(reg, '');
		const git = request.variables.find(v => v.name === 'git');
		const value = git?.values[0].value;
		if (git && typeof value === 'string') {
			let fullBranchName = value.match(/Current Branch name: (.*)/i)![1];
			const branchName = fullBranchName.split('/')[1] || fullBranchName;
			const access = await vscode.lm.requestLanguageModelAccess(LANGUAGE_MODEL_ID);
			const promptRequest = access.makeChatRequest([
				new vscode.LanguageModelSystemMessage('You write creative prompts for an AI image generator. The user will give a short phrase, and you must generate a prompt for DALL-E based on that phrase. Don\'t forget to include the art style for the image. For example, it could be an oil painting, a photograph, a cartoon, a charcoal drawing, or something else. Reply with the prompt and no other text.'),
				new vscode.LanguageModelUserMessage(branchName),
			], {}, token);

			let prompt = '';
			for await (const chunk of promptRequest.stream) {
				prompt += chunk;
			}

			imageGenPrompt = prompt;

			stream.markdown(`**Branch name**: ${fullBranchName}\n\n`);
			stream.markdown(`**Prompt**: ${imageGenPrompt}\n\n`);
		}

		const { smallFilePath, resultUrl } = await getAiImage(extContext, imageGenPrompt);
		const content = `Here ya go:
		
![image](file://${smallFilePath})

[Full size](${resultUrl})

Have a great day!`;
		stream.markdown(content);

		return {};
	});

	agent.description = 'Use Dall-E';
	agent.fullName = 'Dall-E';
	agent.commandProvider = {
		provideCommands(token) {
			return [
				{ name: 'affirmation', description: 'Sometimes we need a context-aware affirmation from a happy cute animal!' },
				{ name: 'flow', description: 'Visualize the code flow based for the current code' },
				{ name: 'render', description: 'Preview the current code as website rendering' },
			];
		},
	};
	agent.iconPath = new vscode.ThemeIcon('sparkle');

	extContext.subscriptions.push(agent);
}

export function deactivate() {
}

async function handleAffirmation(extContext: vscode.ExtensionContext, request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<vscode.ChatResult> {
	const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
	const diff = await gitExtension?.exports.getAPI(1).repositories[0].diff();
	console.log(diff);

	const access = await vscode.lm.requestLanguageModelAccess(LANGUAGE_MODEL_ID);
	const promptRequest = diff ?
		access.makeChatRequest([
			new vscode.LanguageModelSystemMessage('Here is a user\'s git diff. Please write a very short one-sentence compliment about the added lines of code. MUST be fewer than 10 words, but it should focus on one part of the code in detail. It should be over-the-top complimentary and use exclamation marks! Do not use emoji.'),
			new vscode.LanguageModelUserMessage(diff)
		], {}, token) :
		access.makeChatRequest([
			new vscode.LanguageModelSystemMessage('Write a motivational message for a programmer. It should be over-the-top complimentary and use exclamation marks! And tell them that they are good at what they do. Less than 10 words.')
		], {}, token);

	let prompt = '';
	for await (const chunk of promptRequest.stream) {
		prompt += chunk;
	}

	const imageGenPrompt = `A motivational image for a programmer. It should contain a cute happy animal. Art style: cartoon. It should say: "${prompt}"`;
	const { smallFilePath, resultUrl } = await getAiImage(extContext, imageGenPrompt);
	const content = `![image](file://${smallFilePath})

[Full size](${resultUrl})

${prompt}`;
	
	stream.markdown(content);

	return {};
};

async function handleCodeFlowVisualization(extContext: vscode.ExtensionContext, request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<vscode.ChatResult> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		return {};
	}

	const selection = editor.selection;
	if (selection.isEmpty) {
		return {};
	}

	const document = editor.document;
	const text = document.getText(selection);

	const imageGenPrompt = `Generate a whiteboard-style flowchart that visually represents the following piece of code. The flowchart should clearly illustrate the logic and flow of the code, including decision points, loops, and function calls. Use standard flowchart symbols: rectangles for operations or assignments, diamonds for decision points, ovals for start and end points, and arrows to show the flow direction. Label each symbol with brief descriptions corresponding to the code. The code consists of a simple 'if-else' statement, a 'for' loop, and a function call. Ensure the flowchart is neatly organized, easy to read, and accurately reflects the sequence and conditions in the code. Use a clean, professional style suitable for a technical presentation.
	
	# Code:
	\`\`\`
	${text}
	\`\`\``;
	const { smallFilePath, resultUrl } = await getAiImage(extContext, imageGenPrompt);
	const content = `![image](file://${smallFilePath})

[Full size](${resultUrl})`;
	stream.markdown(content);

	return {};
};

async function handleRender(extContext: vscode.ExtensionContext, request: vscode.ChatRequest, context: vscode.ChatContext, stream: vscode.ChatResponseStream, token: vscode.CancellationToken): Promise<vscode.ChatResult> {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		return {};
	}

	const selection = editor.selection;
	if (selection.isEmpty) {
		return {};
	}

	const document = editor.document;
	const text = document.getText(selection);

	const imageGenPrompt = `Generate a high-resolution image of a website preview, based on the provided code. The image should display a realistic rendering of what the website would look like, including layout, colors, and typography. Emphasize accuracy in translating the code into a visual representation.
	
	# Code:
	\`\`\`
	${text}
	\`\`\``;
	const { smallFilePath, resultUrl } = await getAiImage(extContext, imageGenPrompt);
	const content = `![image](file://${smallFilePath})

[Full size](${resultUrl})`;
	stream.markdown(content);

	return {};
};

async function getAiImage(extContext: vscode.ExtensionContext, imageGenPrompt: string): Promise<{ smallFilePath: string; resultUrl: string; }> {
	const azureEndpoint = getAzureEndpoint();
	const key = azureEndpoint ? await getAzureOpenAIKey(extContext) : await getOpenAIKey(extContext);
	if (!key) {
		throw new Error('Missing OpenAI API key');
	}

	const openai = azureEndpoint ? new OpenAIClient(azureEndpoint, new AzureKeyCredential(key)) : new OpenAI({ apiKey: key });
	let resultUrl = '';
	if (azureEndpoint && openai instanceof OpenAIClient) {
		const imageResponse = await openai.getImages(getAzureDeploymentName(),imageGenPrompt, {
			n: 1,
			size: '1024x1024',
		});
		resultUrl = (imageResponse.data[0] as any).url!;
	} else if (openai instanceof OpenAI) {
		const imageGen = await openai.images.generate({
			prompt: imageGenPrompt,
			model: "dall-e-3",
			n: 1,
			size: '1024x1024',
			quality: "standard",
		});
		resultUrl = imageGen.data[0].url!;
	}

	console.log(resultUrl);

	const randomFileName = crypto.randomBytes(20).toString('hex');
	const tempFileWithoutExtension = path.join(os.tmpdir(), 'chat-agent-dalle', `${randomFileName}`);
	const tmpFilePath = tempFileWithoutExtension + '.png';
	console.log(tmpFilePath);

	await downloadFile(resultUrl!, tmpFilePath);

	const smallFilePath = tempFileWithoutExtension + '-small.png';
	const inputBuffer = await fs.promises.readFile(tmpFilePath);
	await sharp(inputBuffer)
		.resize({ width: 400 })
		.toFile(smallFilePath);

	return { smallFilePath, resultUrl };
}

function getAzureEndpoint() {
	return vscode.workspace.getConfiguration('roblourens.chat-agent-dalle').get<string>('azureEndpoint');
}

function getAzureDeploymentName() {
	return vscode.workspace.getConfiguration('roblourens.chat-agent-dalle').get<string>('deploymentName');
}

const openAIKeyName = 'openai.aiKey';
const azureOpenAIKeyName = 'azure.openai.aiKey';
async function getAzureOpenAIKey(context: vscode.ExtensionContext): Promise<string | undefined> {
	const storedKey = await context.secrets.get(azureOpenAIKeyName);
	if (storedKey) {
		return storedKey;
	} else {
		const newKey = await vscode.window.showInputBox({ placeHolder: 'Enter your Azure OpenAI API key', prompt: 'This can be found in your Azure portal' });
		if (newKey) {
			context.secrets.store(openAIKeyName, newKey);
			return newKey;
		} else {
			return;
		}
	}
}


async function getOpenAIKey(context: vscode.ExtensionContext): Promise<string | undefined> {
	const storedKey = await context.secrets.get(openAIKeyName);
	if (storedKey) {
		return storedKey;
	} else {
		const newKey = await vscode.window.showInputBox({ placeHolder: 'Enter your OpenAI API key', prompt: 'You can create an API key [here](https://platform.openai.com/api-keys)' });
		if (newKey) {
			context.secrets.store(openAIKeyName, newKey);
			return newKey;
		} else {
			return;
		}
	}
}

async function downloadFile(url: string, destPath: string, headers?: Record<string, string>): Promise<void> {
	await fs.promises.mkdir(path.dirname(destPath), { recursive: true });

	return new Promise((resolve, reject) => {
		https.get(url, { headers }, (response) => {
			if (response.headers.location) {
				console.log(`Following redirect to ${response.headers.location}`);
				return downloadFile(response.headers.location, destPath).then(resolve, reject);
			}

			if (response.statusCode === 404) {
				return reject(new Error(`File not found: ${url}`));
			}

			const file = fs.createWriteStream(destPath);
			response.pipe(file);
			file.on('finish', () => {
				file.close();
				resolve();
			});
			file.on('error', (err) => {
				file.close();
				reject(err);
			});
		}).on('error', (err) => {
			fs.unlink(destPath, () => reject(err));
		});
	});
}