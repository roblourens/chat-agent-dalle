'use strict';

import * as vscode from 'vscode';
import OpenAI from 'openai';
import axios from 'axios';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import * as https from 'https';
import sharp from 'sharp';
import { GitExtension } from './git';

export function activate(extContext: vscode.ExtensionContext) {

	const agent = vscode.chat.createChatAgent('dall-e', async (request, context, progress, token) => {
		if (request.slashCommand?.name === 'affirmation') {
			return handleAffirmation(extContext, request, context, progress, token);
		} else if (request.slashCommand?.name === 'flowchart') {
			return handleCodeFlowVisualization(extContext, request, context, progress, token);
		} else if (request.slashCommand?.name === 'render') {
			return handleRender(extContext, request, context, progress, token);
		}

		let imageGenPrompt = request.prompt || 'A photo of a bicyclist in Seattle carrying a laptop and writing code while simultaneously riding a bike.';

		const reg = /(^|\s)\[(#)([\w_\-]+)(:[\w_\-\.]+)?\]\(values:([\w_\-]+)(:[\w_\-\.]+)?\)/ig;
		imageGenPrompt = imageGenPrompt.replace(reg, '');
		if (request.variables['git']) {
			const git = request.variables['git'][0];
			let fullBranchName = git.value.match(/Current Branch name: (.*)/i)![1];
			const branchName = fullBranchName.split('/')[1] || fullBranchName;
			const access = await vscode.chat.requestChatAccess('copilot');
			const promptRequest = access.makeRequest([
				{ role: vscode.ChatMessageRole.System, content: 'You write creative prompts for an AI image generator. The user will give a short phrase, and you must generate a prompt for DALL-E based on that phrase. Don\'t forget to include the art style for the image. For example, it could be an oil painting, a photograph, a cartoon, a charcoal drawing, or something else. Reply with the prompt and no other text.' },
				{ role: vscode.ChatMessageRole.User, content: branchName },
			], {}, token);

			let prompt = '';
			for await (const chunk of promptRequest.response) {
				prompt += chunk;
			}

			imageGenPrompt = prompt;

			progress.report({ content: `**Branch name**: ${fullBranchName}\n\n` });
			progress.report({ content: `**Prompt**: ${imageGenPrompt}\n\n` });
		}

		const { smallFilePath, resultUrl } = await getAiImage(extContext, imageGenPrompt);
		const content = `Here ya go:
		
![image](file://${smallFilePath})

[Full size](${resultUrl})

Have a great day!`;
		progress.report({ content });

		return {};
	});

	agent.description = 'Use Dall-E';
	agent.fullName = 'Dall-E';
	agent.slashCommandProvider = {
		provideSlashCommands(token) {
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

async function handleAffirmation(extContext: vscode.ExtensionContext, request: vscode.ChatAgentRequest, context: vscode.ChatAgentContext, progress: vscode.Progress<vscode.ChatAgentProgress>, token: vscode.CancellationToken): Promise<vscode.ChatAgentResult2> {
	const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
	const diff = await gitExtension?.exports.getAPI(1).repositories[0].diff();
	console.log(diff);

	const access = await vscode.chat.requestChatAccess('copilot');
	const promptRequest = diff ?
		access.makeRequest([
			{ role: vscode.ChatMessageRole.System, content: 'Here is a user\'s git diff. Please write a very short one-sentence compliment about the added lines of code. MUST be fewer than 10 words, but it should focus on one part of the code in detail. It should be over-the-top complimentary and use exclamation marks! Do not use emoji.' },
			{ role: vscode.ChatMessageRole.User, content: diff },
		], {}, token) :
		access.makeRequest([
			{ role: vscode.ChatMessageRole.System, content: 'Write a motivational message for a programmer. It should be over-the-top complimentary and use exclamation marks! And tell them that they are good at what they do. Less than 10 words.' },
		], {}, token);

	let prompt = '';
	for await (const chunk of promptRequest.response) {
		prompt += chunk;
	}

	const imageGenPrompt = `A motivational image for a programmer. It should contain a cute happy animal. Art style: cartoon. It should say: "${prompt}"`;
	const { smallFilePath, resultUrl } = await getAiImage(extContext, imageGenPrompt);
	const content = `![image](file://${smallFilePath})

[Full size](${resultUrl})

${prompt}`;
	progress.report({ content });

	return {};
};

async function handleCodeFlowVisualization(extContext: vscode.ExtensionContext, request: vscode.ChatAgentRequest, context: vscode.ChatAgentContext, progress: vscode.Progress<vscode.ChatAgentProgress>, token: vscode.CancellationToken): Promise<vscode.ChatAgentResult2> {
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
	progress.report({ content });

	return {};
};

async function handleRender(extContext: vscode.ExtensionContext, request: vscode.ChatAgentRequest, context: vscode.ChatAgentContext, progress: vscode.Progress<vscode.ChatAgentProgress>, token: vscode.CancellationToken): Promise<vscode.ChatAgentResult2> {
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
	progress.report({ content });

	return {};
};

async function getAiImage(extContext: vscode.ExtensionContext, imageGenPrompt: string): Promise<{ smallFilePath: string; resultUrl: string; }> {
	const key = await getUserAiKey(extContext);
	if (!key) {
		throw new Error('Missing OpenAI API key');
	}

	const openai = new OpenAI({ apiKey: key });
	const imageGen = await openai.images.generate({
		prompt: imageGenPrompt,
		model: "dall-e-3",
		n: 1,
		size: '1024x1024',
		quality: "standard",
	});
	const resultUrl = imageGen.data[0].url!;
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

const keyName = 'openai.aiKey';
async function getUserAiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
	const storedKey = await context.secrets.get(keyName);
	if (storedKey) {
		return storedKey;
	} else {
		const newKey = await vscode.window.showInputBox({ placeHolder: 'Enter your OpenAI API key', prompt: 'You can create an API key [here](https://platform.openai.com/api-keys)' });
		if (newKey) {
			context.secrets.store(keyName, newKey);
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